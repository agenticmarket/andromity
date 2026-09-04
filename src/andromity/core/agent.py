import json
import sys
import time
from typing import AsyncGenerator, Dict, Any, Optional, Callable

from andromity.core.provider import stream_completion
from andromity.core.session import Session
from andromity.core.profiles import get_system_prompt, filter_tools_for_profile
from andromity.core.tools import CORE_TOOLS, ToolRegistry, execute_tool, register_session
from andromity.core.events import (
    StreamEvent, TextDelta, ThinkingDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done, ToolResult, PlanApprovalRequired, PlanUpdated
)
from andromity.core.debug_log import get_logger
from andromity.config import config

log = get_logger("agent")


def _estimate_tokens(messages: list) -> int:
    """Estimate token count for messages including thinking and tool calls.

    Old code only counted ``content`` → severely undercounts when
    reasoning_effort=high/xhigh/max stores huge ``thinking`` blocks
    or when many tool calls are in history (tool args bloat).
    We count content + thinking + tool_calls args + tool result content.
    Uses len//4 heuristic (same as elsewhere) but covers all fields.
    """
    total = 0
    for m in messages:
        if not isinstance(m, dict):
            continue
        # content: str or list[content_parts] (vision)
        c = m.get("content")
        if isinstance(c, str):
            total += len(c) // 4
        elif isinstance(c, list):
            for part in c:
                if isinstance(part, dict):
                    total += len(str(part.get("text", ""))) // 4
                    # image_url parts are not text → ignore token-wise
                else:
                    total += len(str(part)) // 4
        elif c is not None:
            total += len(str(c)) // 4
        # thinking / reasoning stored separately by agent.run
        for key in ("thinking", "reasoning", "reasoning_content"):
            v = m.get(key)
            if isinstance(v, str) and v:
                total += len(v) // 4
        # tool_calls (assistant side)
        for tc in (m.get("tool_calls") or []):
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            if isinstance(fn, dict):
                total += len(str(fn.get("name", ""))) // 4
                total += len(str(fn.get("arguments", ""))) // 4
        # tool result name + tool_call_id are tiny, counted for completeness
        if m.get("tool_call_id"):
            total += 2  # rough
    return total


class Agent:
    def __init__(self, session: Session, profile: str = None, dry_run: bool = False,
                 auto_approve: bool = False, on_tool_approval: Optional[Callable] = None,
                 on_questions: Optional[Callable] = None, ctx_limit: int = 0,
                 reasoning_effort: Optional[str] = None,
                 provider: Optional[str] = None, model: Optional[str] = None):
        self.session = session
        self.profile = profile or config.get("default", "profile", "builder")
        self.dry_run = dry_run
        self.auto_approve = auto_approve
        self.on_tool_approval = on_tool_approval
        self.on_questions = on_questions
        self.ctx_limit = ctx_limit
        self.reasoning_effort = reasoning_effort if reasoning_effort is not None else config.get("default", "reasoning_effort", "medium")
        self.provider = provider
        self.model = model
        self.allowed_tools = filter_tools_for_profile(CORE_TOOLS, self.profile)
        self._empty_retried = False
        # Set when the current turn carries pasted images (see run()).
        self._turn_image_parts = None
        # Coarse tool-usage counters for session_end telemetry (no args stored)
        self._tool_usage_counts: Dict[str, int] = {"bash": 0, "file": 0, "web": 0}
        # Session wall-clock start time for duration telemetry
        self._session_start_time: float = time.time()
        # Turn counter for telemetry (incremented per user message)
        self._turn_count: int = 0
        # Register session so plan tools can store plan in it
        register_session(session)
        
        # Initialize SubAgent orchestrator and SessionBus registration
        from andromity.core.subagent_orchestrator import SubAgentOrchestrator
        from andromity.core.session_bus import SessionBus

        self.orchestrator = SubAgentOrchestrator(
            parent_session_id=self.session.id,
            project_path=self.session.project_path,
            permission_mode=getattr(self.session, "permission_mode", None) or config.get("default", "permission_mode", "safe"),
        )
        self.session._orchestrator = self.orchestrator

        try:
            SessionBus.get_instance().register(
                session_id=self.session.id,
                name=self.session.name,
                project_path=self.session.project_path,
                capabilities=[self.profile],
            )
        except Exception:
            pass

        sys_prompt = get_system_prompt(self.profile)

        deferred_catalog = ToolRegistry.get_instance().get_deferred_prompt_catalog()
        if deferred_catalog:
            sys_prompt += "\n\n" + deferred_catalog

        try:
            from andromity.core.skills import SkillsManager
            skills_block = SkillsManager(self.session.project_path).prompt_block()
            if skills_block:
                sys_prompt += "\n\n" + skills_block
        except Exception:
            pass

        if not self.session.messages:
            self.session.add_message("system", sys_prompt)
        elif self.session.messages[0]["role"] == "system":
            self.session.messages[0]["content"] = sys_prompt
            self.session.save()

    def _messages_for_api(self) -> list:
        """Session messages to send to the provider this turn.

        When the current turn has pasted images, the plain-text user message
        stored in the session is swapped for the OpenAI-style content-parts
        list (text + image_url data URIs) on the fly — so session history and
        replay stay clean and compact.
        """
        msgs = [
            {k: v for k, v in m.items() if k in ("role", "content", "tool_calls", "name", "tool_call_id", "thinking")}
            for m in self.session.messages
        ]
        if not self._turn_image_parts:
            return msgs
        # The most recent user message is the one just added for this turn.
        for i in range(len(msgs) - 1, -1, -1):
            if msgs[i].get("role") == "user" and isinstance(msgs[i].get("content"), str):
                msgs[i]["content"] = self._turn_image_parts
                break
        return msgs

    def _model_supports_vision(self) -> bool:
        """Best-effort check that the active model accepts images.

        LiteLLM's supports_vision() is unreliable for routed/aggregator and
        local providers — it reports False for many OpenRouter vision models
        (e.g. dots-3-note supports images but supports_vision() says no). So
        we only hard-block direct, well-known providers (OpenAI, Anthropic,
        Gemini, …) when they explicitly report no vision; everything else is
        allowed through and the provider itself returns a clear error if the
        model truly rejects images.
        """
        provider = self.provider or config.get("default", "provider", "")
        model = self.model or config.get("default", "model", "")
        litellm_model = f"{provider}/{model}" if model and "/" not in model else model
        if not litellm_model:
            return True
        cfg = config.get_provider_config(provider) or {}
        routed_or_local = provider in ("openrouter", "ollama", "nvidia") \
            or (cfg.get("type") and cfg.get("type") != provider)
        if routed_or_local:
            return True
        try:
            import litellm
            return litellm.supports_vision(litellm_model) is not False
        except Exception:
            return True

    async def _compact_context(self, force: bool = False) -> AsyncGenerator[StreamEvent, None]:
        limit = self.ctx_limit
        msg_count = len(self.session.messages)

        # ── Decide whether compaction is needed ──────────────────────────
        compact_reason = ""

        if force:
            compact_reason = "manual compaction requested"
        elif limit > 0:
            current_tokens = getattr(self.session, "context_tokens", 0)
            if current_tokens <= 0:
                current_tokens = _estimate_tokens(self.session.messages)
            if current_tokens > limit * 0.80:
                limit_k = f"{limit / 1000:.0f}K" if limit < 1_000_000 else f"{limit / 1_000_000:.1f}M"
                pct = min(current_tokens / limit * 100, 100.0)
                compact_reason = f"context limit reached (~{pct:.0f}% of {limit_k} tokens)"

        if not compact_reason and msg_count > 1000:
            compact_reason = f"message count ceiling reached ({msg_count:,} messages)"

        if not compact_reason:
            return

        old_count = len(self.session.messages)
        non_system = [m for m in self.session.messages if m.get("role") != "system"]
        if force and len(non_system) > 2 and len(non_system) <= 6:
            keep_turns = non_system[-2:]
            to_compact = non_system[:-2]
        else:
            keep_turns = non_system[-6:] if len(non_system) > 6 else []
            to_compact = non_system[:-6] if len(non_system) > 6 else non_system

        if not to_compact:
            yield TextDelta(text="*[Context compaction skipped — not enough history to compact]*\n\n")
            return

        yield TextDelta(text=f"\n*[Context compacting — {compact_reason}]*\n\n")

        lines = []
        for m in to_compact:
            if not m or not isinstance(m, dict):
                continue
            role = m.get("role", "unknown") or "unknown"
            content = m.get("content", "") or ""
            if content:
                lines.append(f"{role.upper()}: {str(content)[:300]}")
            for tc in (m.get("tool_calls") or []):
                if not tc or not isinstance(tc, dict):
                    continue
                fn = tc.get("function") or {}
                if isinstance(fn, dict):
                    fn_name = fn.get("name") or "unknown"
                    fn_args = str(fn.get("arguments") or "")[:100]
                    lines.append(f"TOOL CALL: {fn_name}({fn_args})")
        transcript_snippet = "\n".join(lines)[:20000]

        system_msg = self.session.messages[0] if (self.session.messages and isinstance(self.session.messages[0], dict) and self.session.messages[0].get("role") == "system") else None
        summary_prompt = [
            {"role": "system", "content": "You are a concise summarizer. Produce a dense summary of the conversation so far, preserving key facts, user goals, and current progress."},
            {"role": "user", "content": f"Summarize this conversation snippet concisely for context preservation:\n\n{transcript_snippet}"}
        ]

        summary_text = ""
        compaction_kwargs = {}
        if self.provider:
            compaction_kwargs["provider_name"] = self.provider
        if self.model:
            compaction_kwargs["model"] = self.model

        try:
            async for event in stream_completion(summary_prompt, **compaction_kwargs):
                if isinstance(event, TextDelta):
                    summary_text += event.text
        except Exception as e:
            log.warning("Compaction summary stream failed: %s", e)
            yield TextDelta(text=f"*[Context compaction failed: {e}]*\n\n")
            return

        if not summary_text.strip():
            yield TextDelta(text="*[Context compaction skipped — summary generation returned empty]*\n\n")
            return

        preserved_history = [m for m in self.session.messages if m.get("role") != "system"]
        if not hasattr(self.session, "compacted_history"):
            self.session.compacted_history = []
        self.session.compacted_history.extend(preserved_history)

        new_messages = []
        if system_msg:
            new_messages.append(system_msg)
        new_messages.append({
            "role": "user",
            "content": f"[Previous context summary ({old_count} messages compacted)]:\n{summary_text.strip()}",
        })
        new_messages.append({
            "role": "assistant",
            "content": "Understood. I have the context from our previous conversation and will continue from here.",
        })
        new_messages.extend(keep_turns)

        self.session.messages = new_messages
        self.session.context_tokens = 0
        self.session.save()
        yield TextDelta(text=f"*Context compacted successfully ({old_count} → {len(new_messages)} messages).*\n\n")

    async def run(self, user_input: str, images: list = None, image_uris: list = None) -> AsyncGenerator[StreamEvent, None]:
        """Run one user turn.

        Accepts either raw ``images`` (paths/PIL objects — will be encoded)
        or pre-encoded ``image_uris`` (data: URIs — used as-is).
        """
        self._turn_image_parts = None
        _uris: list | None = None
        if image_uris:          # already-encoded URIs from the TUI paste path
            _uris = image_uris
        elif images:            # raw files/PIL — encode now
            from andromity.core.images import image_to_data_uri
            _uris = [image_to_data_uri(img) for img in images]

        if _uris:
            if not self._model_supports_vision():
                model_name = self.model or config.get("default", "model", "the current model")
                yield TextDelta(text=f"\n[Image not sent] {model_name} does not support images. Switch to a vision model (e.g. claude-sonnet-4-6, gpt-4o, gemini-2.5-flash) with /model.\n")
                yield Done()
                return
            self._turn_image_parts = [
                {"type": "text", "text": user_input},
                *({"type": "image_url", "image_url": {"url": uri}} for uri in _uris),
            ]

        turn_start_time = time.time()
        thumb_uris = None
        if _uris:
            from andromity.core.images import save_and_thumbnail_image
            thumb_uris = [
                save_and_thumbnail_image(u, storage_dir=getattr(self.session, "storage_dir", None))
                for u in _uris
            ]
        self.session.add_message("user", content=user_input, images=thumb_uris)
        self._turn_count += 1

        if not getattr(self.session, "_telemetry_sent", False):
            self.session._telemetry_sent = True
            try:
                from andromity.telemetry import send_session_start
                _prov = self.provider or config.get("default", "provider", "")
                _mod  = self.model  or config.get("default", "model", "")
                send_session_start(
                    self.session.id,
                    provider=_prov,
                    model=_mod,
                    reasoning_effort=getattr(self, "reasoning_effort", None),
                    mcp_tools_count=len(self.allowed_tools or []),
                )
            except Exception:
                pass
        
        async for event in self._compact_context():
            yield event

        while True:
            pending_tool_calls: Dict[str, Dict[str, str]] = {}
            tool_calls_to_execute = []
            assistant_content = ""
            assistant_thinking = ""
            last_usage = None

            stream_kwargs: Dict[str, Any] = {"tools": self.allowed_tools}
            if self.provider:
                stream_kwargs["provider_name"] = self.provider
            if self.model:
                stream_kwargs["model"] = self.model
            if self.reasoning_effort and self.reasoning_effort != "off":
                stream_kwargs["reasoning_effort"] = self.reasoning_effort

            async for event in stream_completion(
                self._messages_for_api(),
                **stream_kwargs,
            ):
                if isinstance(event, Done):
                    last_usage = event.usage
                else:
                    yield event
                if isinstance(event, TextDelta):
                    assistant_content += event.text
                elif isinstance(event, ThinkingDelta):
                    assistant_thinking += event.text
                elif isinstance(event, ToolCallStart):
                    pending_tool_calls[event.tool_id] = {
                        "name": event.tool_name,
                        "args": "",
                    }
                elif isinstance(event, ToolCallDelta):
                    if event.tool_id in pending_tool_calls:
                        pending_tool_calls[event.tool_id]["args"] += event.args_json_chunk
                elif isinstance(event, ToolCallEnd):
                    if event.tool_id in pending_tool_calls:
                        call_info = pending_tool_calls.pop(event.tool_id)
                        tool_calls_to_execute.append({
                            "id": event.tool_id, "type": "function",
                            "function": {"name": call_info["name"], "arguments": call_info["args"]},
                        })

            # Flush any unclosed tool calls in case provider ended stream before ToolCallEnd
            for tid, call_info in list(pending_tool_calls.items()):
                tool_calls_to_execute.append({
                    "id": tid, "type": "function",
                    "function": {"name": call_info["name"], "arguments": call_info["args"]},
                })
            pending_tool_calls.clear()

            if not tool_calls_to_execute and ("<atem:invoke" in assistant_content or "<atem:function_calls>" in assistant_content):
                import re, uuid
                matches = re.finditer(r'<atem:invoke\s+name="([^"]+)">([\s\S]*?)</atem:invoke>', assistant_content)
                for m in matches:
                    fn_name = m.group(1)
                    body = m.group(2)
                    args = {}
                    for param_match in re.finditer(r'<atem:parameter\s+name="([^"]+)">([\s\S]*?)</atem:parameter>', body):
                        p_name = param_match.group(1)
                        p_val = param_match.group(2).strip()
                        args[p_name] = p_val
                    call_id = f"call_{uuid.uuid4().hex[:8]}"
                    tool_calls_to_execute.append({
                        "id": call_id,
                        "type": "function",
                        "function": {"name": fn_name, "arguments": json.dumps(args)},
                    })
                # Strip out the atem XML tags so raw XML does not leak into the chat
                assistant_content = re.sub(r'<atem:function_calls>[\s\S]*?</atem:function_calls>', '', assistant_content).strip()
                assistant_content = re.sub(r'<atem:invoke[\s\S]*?</atem:invoke>', '', assistant_content).strip()
                assistant_content = re.sub(r'</?atem:[^>]+>', '', assistant_content).strip()

            current_p = self.provider or config.get('default', 'provider', 'ollama')
            current_m = self.model or config.get('default', 'model', '')
            model_id = f"{current_p}/{current_m}"
            if last_usage:
                self.session.update_usage(last_usage, model=model_id)
            else:
                prompt_tokens = _estimate_tokens(self.session.messages)
                completion_tokens = len(assistant_content) // 4 + len(assistant_thinking) // 4
                self.session.update_usage({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                    "usage_source": "estimate",
                }, model=model_id)

            turn_duration = round(time.time() - turn_start_time, 2)
            self.session.add_message(
                "assistant",
                content=assistant_content if assistant_content else None,
                tool_calls=tool_calls_to_execute if tool_calls_to_execute else None,
                thinking=assistant_thinking if assistant_thinking else None,
                duration=turn_duration,
            )

            if not assistant_content and not tool_calls_to_execute:
                # Model returned nothing — retry once before giving up
                if not getattr(self, '_empty_retried', False):
                    self._empty_retried = True
                    yield TextDelta(text="\n*Model returned empty, retrying...*\n\n")
                    continue
                self._empty_retried = False
                from andromity.core.models import get_context_limit_for_model
                provider = config.get("default", "provider", "")
                model = config.get("default", "model", "")
                limit = self.ctx_limit or get_context_limit_for_model(provider, model)
                current_tokens = _estimate_tokens(self.session.messages)
                if limit > 0 and current_tokens > limit * 0.9:
                    warning = (
                        f"\n**[No response from model]** Context full ({current_tokens:,}/{limit:,} tokens). "
                        "Try `/new` for a fresh session, or switch model with **Ctrl+L**.\n"
                    )
                else:
                    warning = (
                        "\n**[No response from model]** The model returned an empty response. "
                        "Try rephrasing your message or switch model with **Ctrl+L**.\n"
                    )
                yield TextDelta(text=warning)
                yield Done(usage=last_usage)
                self._fire_session_end(had_error=True)
                break

            self._empty_retried = False

            if not tool_calls_to_execute:
                yield Done(usage=last_usage)
                self._fire_session_end()
                break

            # ── ask_questions: user answers in an inline panel; the answers become the
            # tool result. Pauses the loop exactly like plan review, but via an
            # async callback so no future juggling is needed downstream.
            ask_calls = [tc for tc in tool_calls_to_execute
                         if isinstance(tc, dict) and ((tc.get("function") or {}).get("name") in ("ask_questions", "ask_question"))]
            other_calls = [tc for tc in tool_calls_to_execute if tc not in ask_calls]

            for tc in ask_calls:
                fn_dict = tc.get("function") or {} if isinstance(tc, dict) else {}
                tool_name = fn_dict.get("name", "ask_questions")
                try:
                    qargs = json.loads(fn_dict.get("arguments") or "{}")
                except json.JSONDecodeError:
                    qargs = {}
                questions = qargs.get("questions") or qargs.get("question") or qargs or []
                # Defensive: if the entire args dict leaked in as "questions", wrap it
                if isinstance(questions, dict):
                    questions = [questions]
                import logging
                _log = logging.getLogger("andromity")
                _log.info("ask_questions: got %d question(s), on_questions=%s",
                          len(questions) if isinstance(questions, list) else -1,
                          "SET" if self.on_questions else "NONE")
                result = ""
                if questions and self.on_questions:
                    try:
                        result = await self.on_questions(questions)
                    except Exception as e:
                        _log.warning("on_questions callback error: %s", e, exc_info=True)
                        result = "The user did not answer the questions. Proceed with reasonable assumptions."
                else:
                    _log.warning("ask_questions skipped: questions=%s, on_questions=%s",
                                 bool(questions), bool(self.on_questions))
                    result = "(No interactive UI available — proceed with reasonable assumptions.)"
                self.session.add_message(
                    "tool", content=result, name=tool_name, tool_call_id=tc["id"],
                )
                # Mark the UI indicator done so the tool doesn't stay "running"
                # forever after the user answers.
                yield ToolResult(tool_id=tc["id"], result=result)

            # ── Phase 1: approvals — kept sequential (each one can show an
            # interactive prompt in the UI; a single approval future can't be
            # shared across concurrent prompts).
            prepared: list[tuple[dict, str, dict]] = []  # (tool_call, name, args)
            final_results: dict[str, str] = {}  # call_id → result/rejection for ALL calls
            for tool_call in other_calls:
                tool_name = tool_call["function"]["name"]
                try:
                    args = json.loads(tool_call["function"]["arguments"])
                except json.JSONDecodeError:
                    args = {}

                if not self.auto_approve and self.on_tool_approval:
                    import inspect
                    is_approved = await self.on_tool_approval(tool_name, args) if inspect.iscoroutinefunction(self.on_tool_approval) else self.on_tool_approval(tool_name, args)
                    if not is_approved:
                        rejection = (
                            f"TOOL REJECTED BY USER: '{tool_name}' was explicitly declined.\n"
                            f"Do NOT retry this tool call.\n"
                            f"Acknowledge the rejection, then ask the user how they would like to proceed."
                        )
                        final_results[tool_call["id"]] = rejection
                        yield ToolResult(tool_id=tool_call["id"], result="[Rejected by User]")
                        continue
                prepared.append((tool_call, tool_name, args))

            # ── Phase 2: run all accepted calls CONCURRENTLY. Results are
            # yielded as each call finishes so the UI can mark that tool's
            # indicator done immediately; subagent progress events are also
            # yielded live to the UI as they occur.
            if prepared:
                import asyncio
                from andromity.core.tools import register_subagent_progress_callback, unregister_subagent_progress_callback

                async def _execute(prep: tuple[dict, str, dict]) -> tuple[str, str]:
                    tool_call, tool_name, args = prep
                    # Categorise tool for telemetry — counts only, no args stored
                    _BASH_TOOLS = {"run_terminal_cmd", "run_command", "execute_command", "bash"}
                    _WEB_TOOLS  = {"web_search", "read_url", "browser", "search_web", "read_url_content"}
                    _FILE_TOOLS = {"read_file", "write_file", "edit_file", "view_file",
                                   "write_to_file", "replace_file_content", "multi_replace_file_content",
                                   "list_dir", "grep_search"}
                    if tool_name in _BASH_TOOLS:
                        self._tool_usage_counts["bash"] += 1
                    elif tool_name in _WEB_TOOLS:
                        self._tool_usage_counts["web"] += 1
                    elif tool_name in _FILE_TOOLS:
                        self._tool_usage_counts["file"] += 1
                    if self.dry_run:
                        return tool_call["id"], f"[DRY RUN] Would execute {tool_name}({json.dumps(args, indent=2)})"
                    try:
                        from andromity.core.tools import execute_tool_async
                        result = await execute_tool_async(tool_name, args, tool_id=tool_call.get("id"))
                    except Exception as e:
                        result = f"Error executing {tool_name}: {e}"
                    return tool_call["id"], str(result)


                progress_queue: asyncio.Queue = asyncio.Queue()

                def _on_subagent_prog(evt):
                    progress_queue.put_nowait(evt)

                register_subagent_progress_callback(_on_subagent_prog)
                tasks = [asyncio.create_task(_execute(prep)) for prep in prepared]
                pending_tasks = set(tasks)

                try:
                    while pending_tasks:
                        queue_task = asyncio.create_task(progress_queue.get())
                        done, _ = await asyncio.wait(
                            pending_tasks | {queue_task},
                            return_when=asyncio.FIRST_COMPLETED
                        )
                        if queue_task in done:
                            prog_evt = queue_task.result()
                            yield prog_evt
                        else:
                            queue_task.cancel()

                        for t in done:
                            if t in pending_tasks:
                                pending_tasks.remove(t)
                                call_id, result = t.result()
                                final_results[call_id] = result
                                yield ToolResult(tool_id=call_id, result=result)

                        # Flush any backlog in progress queue
                        while not progress_queue.empty():
                            yield progress_queue.get_nowait()
                except asyncio.CancelledError:
                    self.kill_subagents("turn_cancelled")
                    for t in pending_tasks:
                        if not t.done():
                            t.cancel()
                    raise
                finally:
                    unregister_subagent_progress_callback(_on_subagent_prog)


            # ── Phase 3: record tool messages into session context in the
            # original tool-call order (models expect results in call order).
            for tool_call in other_calls:
                if tool_call["id"] in final_results:
                    self.session.add_message(
                        "tool",
                        content=final_results[tool_call["id"]],
                        name=tool_call["function"]["name"],
                        tool_call_id=tool_call["id"],
                    )

            # ── Phase 4: plan updates and approvals
            for tool_call, tool_name, args in prepared:
                if tool_name in ("write_plan", "update_plan_step"):
                    plan = self.session.load_plan_obj()
                    if not plan and getattr(self.session, "project_path", None):
                        from andromity.core.planner import Plan
                        plan = Plan.load(self.session.project_path)
                    if plan:
                        yield PlanUpdated(plan=plan)
                        if tool_name == "write_plan" and plan.status == "pending":
                            yield PlanApprovalRequired(plan=plan)

    def _fire_session_end(self, had_error: bool = False) -> None:
        """Fire send_session_end once per agent lifetime (idempotent)."""
        if getattr(self, "_session_end_sent", False):
            return
        self._session_end_sent = True
        try:
            from andromity.telemetry import send_session_end
            _prov = self.provider or config.get("default", "provider", "")
            _mod  = self.model  or config.get("default", "model", "")
            send_session_end(
                self.session.id,
                provider=_prov,
                model=_mod,
                turn_count=self._turn_count,
                had_error=had_error,
                duration_sec=time.time() - self._session_start_time,
                tool_counts=dict(self._tool_usage_counts),
            )
        except Exception:
            pass

    async def spawn_subagent(
        self,
        role: str,
        task: str,
        model_override: Optional[str] = None,
        provider_override: Optional[str] = None,
        tools_override: Optional[list] = None,
        timeout: Optional[float] = None,
        wait: bool = True,
    ):
        """Spawn a subagent managed by this agent's orchestrator."""
        return await self.orchestrator.spawn(
            role=role,
            task=task,
            model_override=model_override,
            provider_override=provider_override,
            tools_override=tools_override,
            timeout=timeout,
            wait=wait,
        )

    def kill_subagents(self, reason: str = "agent_cancelled"):
        """Terminate all active subagents spawned by this agent."""
        if hasattr(self, "orchestrator") and self.orchestrator:
            self.orchestrator.kill_all(reason=reason)

    async def await_subagents(self):
        """Wait for all active subagents to finish and return their results."""
        if hasattr(self, "orchestrator") and self.orchestrator:
            return await self.orchestrator.await_all()
        return []

