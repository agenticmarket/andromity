import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict, List, Optional

from andromity.config import config
from andromity.core.debug_log import get_logger
from andromity.core.events import (
    Done, StreamEvent, SubAgentDone, SubAgentFailed, SubAgentKilled,
    SubAgentProgress, SubAgentSpawned, TextDelta, ThinkingDelta,
    ToolCallDelta, ToolCallEnd, ToolCallStart, ToolResult
)
from andromity.core.provider import stream_completion
from andromity.core.session import Session
from andromity.core.subagent_config import SubAgentConfigManager, SubAgentRoleConfig
from andromity.core.tools import CORE_TOOLS, execute_tool_async

log = get_logger("subagent")


@dataclass
class SubAgentResult:
    agent_id: str
    role: str
    status: str  # "completed" | "failed" | "killed" | "timeout"
    summary: str
    tokens_used: Dict[str, int] = field(default_factory=dict)
    cost_usd: float = 0.0
    duration_ms: float = 0.0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "role": self.role,
            "status": self.status,
            "summary": self.summary,
            "tokens_used": self.tokens_used,
            "cost_usd": self.cost_usd,
            "duration_ms": self.duration_ms,
            "error": self.error,
        }


class SubAgent:
    """An autonomous, scoped sub-agent spawned for a specific sub-task."""

    def __init__(
        self,
        parent_session_id: str,
        role: str,
        task: str,
        project_path: Optional[str] = None,
        model_override: Optional[str] = None,
        provider_override: Optional[str] = None,
        tools_override: Optional[List[str]] = None,
        timeout: Optional[float] = None,
        depth: int = 1,
        agent_id: Optional[str] = None,
        progress_callback: Optional[Any] = None,
        context_snapshot: Optional[Any] = None,
    ):
        self.parent_session_id = parent_session_id
        self.role = role.lower().strip()
        self.task = task
        self.project_path = project_path
        self.depth = depth
        self.progress_callback = progress_callback
        self.context_snapshot = context_snapshot
        self.created_at = time.time()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        
        # Generate clean, traceable ID: sub_<parent_8>_<role>_<millis>
        clean_parent = (parent_session_id if parent_session_id else "root")[:8]
        ts_suffix = int(time.time() * 1000) % 1000000
        self.id = agent_id or f"sub_{clean_parent}_{self.role}_{ts_suffix}"

        # Resolve role configuration
        self.role_cfg: SubAgentRoleConfig = SubAgentConfigManager.get_role_config(self.role)
        
        # Resolve provider and model (override > role config > system default)
        self.provider = provider_override or self.role_cfg.provider or config.get("default", "provider", "anthropic")
        self.model = model_override or self.role_cfg.model or config.get("default", "model", "claude-sonnet-4-6")
        self.timeout = timeout if timeout is not None else SubAgentConfigManager.get_default_timeout()
        self.max_tokens_budget = SubAgentConfigManager.get_result_max_tokens()

        # Resolve toolset (scoped to role tools, preventing infinite subagent forks unless authorized)
        tool_names = set(tools_override or self.role_cfg.tools)
        # Never allow subagents to spawn further subagents if depth exceeds limit
        if self.depth >= SubAgentConfigManager.get_max_depth():
            tool_names.discard("spawn_subagent")

        self.allowed_tools = [
            t for t in CORE_TOOLS
            if t["function"]["name"] in tool_names
        ]

        # Transient isolated session
        self.session = Session(
            name=f"subagent-{self.role}-{self.id}",
            project_path=self.project_path
        )
        self.session.parent_session = parent_session_id

        # Initialize system prompt
        sys_prompt = self.role_cfg.system_prompt or (
            f"You are a specialized sub-agent with role '{self.role}'.\n"
            "Complete your assigned task directly. Be concise and thorough. Output a structured final summary."
        )
        if self.context_snapshot:
            if isinstance(self.context_snapshot, (dict, list)):
                ctx_str = json.dumps(self.context_snapshot, indent=2)
            else:
                ctx_str = str(self.context_snapshot)
            sys_prompt += f"\n\n[RELEVANT CONTEXT SNAPSHOT]\n{ctx_str}\n"

        sys_prompt += (
            f"\n\n[TASK INSTRUCTION]\n{self.task}\n"
            f"\n[OUTPUT REQUIREMENT] After completing all tool calls, you MUST write your final summary as "
            f"plain prose TEXT in your last message — NOT as a tool call. "
            f"Do not end your turn with a tool call. Your response MUST contain actual text."
        )
        self.session.add_message("system", sys_prompt)

        self.status = "pending"
        self._killed = False
        self._task_handle: Optional[asyncio.Task] = None

    def _notify_progress(
        self,
        event_type: str = "progress",
        detail: Optional[str] = None,
        delta_text: Optional[str] = None,
        tool_name: Optional[str] = None,
        tool_args: Optional[str] = None,
        tool_result: Optional[str] = None,
    ):
        """Emit live SubAgentProgress event to the registered callback."""
        if not self.progress_callback:
            return
        try:
            evt = SubAgentProgress(
                agent_id=self.id,
                role=self.role,
                status=self.status,
                event_type=event_type,
                delta_text=delta_text,
                tool_name=tool_name,
                tool_args=tool_args,
                tool_result=tool_result,
                detail=detail,
            )
            if asyncio.iscoroutinefunction(self.progress_callback):
                asyncio.create_task(self.progress_callback(evt))
            else:
                self.progress_callback(evt)
        except Exception:
            pass

    async def execute(self) -> SubAgentResult:
        """Run the sub-agent and return a structured SubAgentResult."""
        self.started_at = time.time()
        self.status = "running"
        self._notify_progress(event_type="text", detail=f"Started subagent [{self.role}] with model {self.model}")
        events_accum: List[StreamEvent] = []
        final_summary = ""
        error_msg = None

        try:
            # Enforce hard timeout
            await asyncio.wait_for(self._run_internal(events_accum), timeout=self.timeout)

            if self._killed:
                self.status = "killed"
                final_summary = f"[SubAgent Killed] Agent {self.id} was terminated."
            else:
                self.status = "completed"
                final_summary = self._extract_final_result()
        except asyncio.TimeoutError:
            self.status = "timeout"
            error_msg = f"SubAgent timed out after {self.timeout}s"
            final_summary = f"[SubAgent Timeout] Timed out after {self.timeout}s."
            log.warning("SubAgent %s timed out after %ss", self.id, self.timeout)
        except asyncio.CancelledError:
            self.status = "killed"
            error_msg = "Execution was cancelled"
            final_summary = f"[SubAgent Cancelled] SubAgent {self.id} was cancelled."
        except Exception as e:
            self.status = "failed"
            error_msg = str(e)
            final_summary = f"[SubAgent Error] {type(e).__name__}: {e}"
            log.error("SubAgent %s error: %s", self.id, e, exc_info=True)
        finally:
            self.finished_at = time.time()
            duration_ms = (self.finished_at - self.started_at) * 1000.0

        compressed_summary = self._compress_summary(final_summary)

        tokens_data = {"total_tokens": self.session.token_total}
        tokens_data.update(self.session.usage_breakdown)

        return SubAgentResult(
            agent_id=self.id,
            role=self.role,
            status=self.status,
            summary=compressed_summary,
            tokens_used=tokens_data,
            cost_usd=self.session.cost_usd,
            duration_ms=duration_ms,
            error=error_msg,
        )


    async def run_stream(self) -> AsyncGenerator[StreamEvent, None]:
        """Stream events as the sub-agent executes."""
        self.started_at = time.time()
        self.status = "running"
        yield SubAgentSpawned(
            agent_id=self.id,
            role=self.role,
            model=self.model,
            provider=self.provider,
            task=self.task,
        )

        res = await self.execute()
        if res.status == "completed":
            yield SubAgentDone(
                agent_id=self.id,
                role=self.role,
                result=res.summary,
                token_usage=res.tokens_used,
                duration_ms=res.duration_ms,
            )
        elif res.status == "killed":
            yield SubAgentKilled(agent_id=self.id, role=self.role, reason="cancelled")
        else:
            yield SubAgentFailed(
                agent_id=self.id,
                role=self.role,
                error=res.error or res.summary,
                duration_ms=res.duration_ms,
            )

    async def _run_internal(self, events_accum: List[StreamEvent], max_turns: int = 15):
        """Multi-turn tool-calling loop for the sub-agent."""
        # Task is already in the system prompt — only add a short user trigger
        # with efficiency hints so the model doesn't recursively explore every subdir.
        self.session.add_message(
            "user",
            content=(
                "Begin the task. Efficiency rules:\n"
                "1. For directory tasks: list the ROOT once, then at most 2-3 key subdirs. Read key files (README, package.json, config). Stop exploring when you have enough.\n"
                "2. Do NOT call list_dir on every subdirectory you find — summarize from what you have.\n"
                "3. After tool calls, write your final summary as plain text prose."
            ),
        )

        for turn in range(max_turns):
            if self._killed:
                break

            current_tool_id = None
            current_tool_name = None
            current_tool_args_str = ""
            tool_calls_to_execute = []
            assistant_content = ""
            last_usage = None

            stream_kwargs: Dict[str, Any] = {
                "tools": self.allowed_tools if self.allowed_tools else None,
                "provider_name": self.provider,
                "model": self.model,
            }

            msgs = [
                {k: v for k, v in m.items() if k in ("role", "content", "tool_calls", "name", "tool_call_id")}
                for m in self.session.messages
            ]

            async for event in stream_completion(msgs, **stream_kwargs):
                events_accum.append(event)
                if isinstance(event, ThinkingDelta):
                    self._notify_progress(event_type="thinking", delta_text=event.text)
                elif isinstance(event, TextDelta):
                    assistant_content += event.text
                elif isinstance(event, ToolCallStart):
                    current_tool_id = event.tool_id
                    current_tool_name = event.tool_name
                    current_tool_args_str = ""
                    # Do NOT emit here — wait for ToolCallEnd so args are available
                elif isinstance(event, ToolCallDelta):
                    if event.tool_id == current_tool_id:
                        current_tool_args_str += event.args_json_chunk
                elif isinstance(event, ToolCallEnd):
                    if current_tool_id == event.tool_id:
                        tool_calls_to_execute.append({
                            "id": current_tool_id,
                            "type": "function",
                            "function": {"name": current_tool_name, "arguments": current_tool_args_str},
                        })
                        # Emit once with full args — this is the single display entry
                        self._notify_progress(
                            event_type="tool_call",
                            tool_name=current_tool_name,
                            tool_args=current_tool_args_str,
                        )
                        current_tool_id = None
                elif isinstance(event, Done):
                    last_usage = event.usage


            model_id = f"{self.provider}/{self.model}"
            if last_usage:
                self.session.update_usage(last_usage, model=model_id)
            else:
                prompt_tokens = sum(len(str(m.get("content", ""))) // 4 for m in self.session.messages)
                completion_tokens = len(assistant_content) // 4
                self.session.update_usage({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                    "usage_source": "estimate",
                }, model=model_id)

            self.session.add_message(
                "assistant",
                content=assistant_content if assistant_content else None,
                tool_calls=tool_calls_to_execute if tool_calls_to_execute else None,
            )

            if not tool_calls_to_execute:
                # Finished execution (model produced final text response)
                self._notify_progress(event_type="text", detail="Task execution finished.")
                break

            # After the last tool round, append a reminder to produce a text summary
            # so the model doesn't silently stop after its last tool call.
            if turn == max_turns - 2:  # second-to-last turn
                self.session.add_message(
                    "user",
                    content="You have used the available tools. NOW write your final summary as plain text prose "
                            "in your response — no more tool calls. Be concise and factual."
                )

            # Execute tool calls concurrently
            async def _exec_tool(tc: dict) -> tuple[str, str, str]:
                fn = tc.get("function", {})
                tname = fn.get("name", "")
                tcall_id = tc.get("id", "")
                try:
                    targs = json.loads(fn.get("arguments", "{}"))
                except Exception:
                    targs = {}
                try:
                    res_str = await execute_tool_async(tname, targs)
                except Exception as ex:
                    res_str = f"Error: Tool {tname} failed: {ex}"
                self._notify_progress(
                    event_type="tool_result",
                    tool_name=tname,
                    tool_result=res_str[:200],
                    detail=f"completed {tname}",
                )
                return tcall_id, tname, res_str

            tasks = [_exec_tool(tc) for tc in tool_calls_to_execute]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for item in results:
                if isinstance(item, Exception):
                    continue
                tcall_id, tname, res_str = item
                self.session.add_message("tool", content=res_str, name=tname, tool_call_id=tcall_id)


    def _extract_final_result(self) -> str:
        """Extract the most relevant final content from assistant messages."""
        # 1. Best case: last assistant message with prose text
        for msg in reversed(self.session.messages):
            if msg.get("role") == "assistant" and msg.get("content"):
                content = str(msg["content"]).strip()
                if content:
                    return content

        # 2. Fallback: concatenate all non-trivial assistant texts
        texts = []
        for msg in self.session.messages:
            if msg.get("role") == "assistant" and msg.get("content"):
                c = str(msg["content"]).strip()
                if c:
                    texts.append(c)
        if texts:
            return "\n\n".join(texts)

        # 3. Last-resort: pull the last tool result so something is returned
        for msg in reversed(self.session.messages):
            if msg.get("role") == "tool" and msg.get("content"):
                return f"[No prose summary produced. Last tool output:]\n{str(msg['content'])[:1500]}"

        return "Task completed with no text output."

    def _compress_summary(self, text: str) -> str:
        """Ensure the summary does not exceed the target token budget."""
        # Fast character heuristic: ~4 chars per token
        char_limit = self.max_tokens_budget * 4
        if len(text) <= char_limit:
            return text
        truncated = text[:char_limit].rsplit("\n", 1)[0]
        return truncated + f"\n\n*[Result condensed to {self.max_tokens_budget} tokens]*"

    def kill(self, reason: str = "cancelled"):
        """Terminate the sub-agent."""
        self._killed = True
        self.status = "killed"
        if self._task_handle and not self._task_handle.done():
            self._task_handle.cancel()
