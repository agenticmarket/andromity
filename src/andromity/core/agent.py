import json
from typing import AsyncGenerator, Dict, Any, Optional, Callable

from andromity.core.provider import stream_completion
from andromity.core.session import Session
from andromity.core.profiles import get_system_prompt, filter_tools_for_profile
from andromity.core.tools import CORE_TOOLS, execute_tool, register_session
from andromity.core.events import (
    StreamEvent, TextDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done, ToolResult
)
from andromity.config import config


class Agent:
    def __init__(self, session: Session, profile: str = None, dry_run: bool = False,
                 auto_approve: bool = False, on_tool_approval: Optional[Callable] = None):
        self.session = session
        self.profile = profile or config.get("default", "profile", "builder")
        self.dry_run = dry_run
        self.auto_approve = auto_approve
        self.on_tool_approval = on_tool_approval
        self.allowed_tools = filter_tools_for_profile(CORE_TOOLS, self.profile)
        # Register session so plan tools can store plan in it
        register_session(session)
        sys_prompt = get_system_prompt(self.profile)
        if not self.session.messages:
            self.session.add_message("system", sys_prompt)
        elif self.session.messages[0]["role"] == "system":
            self.session.messages[0]["content"] = sys_prompt
            self.session.save()

    async def _compact_context(self) -> AsyncGenerator[StreamEvent, None]:
        from andromity.core.models import get_context_limit_for_model
        provider = config.get("default", "provider", "")
        model = config.get("default", "model", "")
        
        limit = get_context_limit_for_model(provider, model)
        if limit <= 0:
            limit = 32768
            
        current_tokens = sum(len(str(m.get("content", ""))) // 4 for m in self.session.messages)
        threshold = int(limit * 0.8)
        
        if current_tokens > threshold and len(self.session.messages) > 12:
            yield TextDelta(text="\n[dim italic]Context window near limit. Compacting memory...[/]\n")
            
            keep_last_n = 10
            msgs_to_summarize = self.session.messages[1:-keep_last_n]
            
            summary_prompt = (
                "Summarize the following conversation history. Focus on decisions made, "
                "files created, and the overarching goal. Combine this with the previous "
                "summary if one exists:\n\n"
            )
            for m in msgs_to_summarize:
                role = m.get("role", "unknown")
                content = str(m.get("content", ""))
                if len(content) > 500:
                    content = content[:500] + " ...[truncated]"
                summary_prompt += f"{role.upper()}: {content}\n\n"
                
            summary_msgs = [{"role": "user", "content": summary_prompt}]
            
            new_summary = ""
            async for event in stream_completion(summary_msgs, tools=[]):
                if isinstance(event, TextDelta):
                    new_summary += event.text
            
            removed = self.session.compact_messages(new_summary, keep_last_n=keep_last_n)
            yield TextDelta(text=f"[dim italic]Compacted {removed} messages into memory.[/]\n")

    async def run(self, user_input: str) -> AsyncGenerator[StreamEvent, None]:
        self.session.add_message("user", content=user_input)
        
        async for event in self._compact_context():
            yield event

        while True:
            current_tool_id = None
            current_tool_name = None
            current_tool_args_str = ""
            tool_calls_to_execute = []
            assistant_content = ""
            last_usage = None

            async for event in stream_completion(self.session.messages, tools=self.allowed_tools):
                yield event
                if isinstance(event, TextDelta):
                    assistant_content += event.text
                elif isinstance(event, ToolCallStart):
                    current_tool_id = event.tool_id
                    current_tool_name = event.tool_name
                    current_tool_args_str = ""
                elif isinstance(event, ToolCallDelta):
                    if event.tool_id == current_tool_id:
                        current_tool_args_str += event.args_json_chunk
                elif isinstance(event, ToolCallEnd):
                    if current_tool_id == event.tool_id:
                        tool_calls_to_execute.append({
                            "id": current_tool_id, "type": "function",
                            "function": {"name": current_tool_name, "arguments": current_tool_args_str},
                        })
                        current_tool_id = None
                elif isinstance(event, Done):
                    last_usage = event.usage

            if last_usage:
                from andromity.config import config
                m = f"{config.get('default', 'provider', 'ollama')}/{config.get('default', 'model', '')}"
                self.session.update_usage(last_usage, model=m)
            else:
                prompt_tokens = sum(len(str(m.get("content", ""))) // 4 for m in self.session.messages)
                completion_tokens = len(assistant_content) // 4
                self.session.update_usage({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens
                })

            self.session.add_message(
                "assistant",
                content=assistant_content if assistant_content else None,
                tool_calls=tool_calls_to_execute if tool_calls_to_execute else None,
            )

            if not assistant_content and not tool_calls_to_execute:
                # Model returned nothing — context may be truncated
                warning = (
                    "\n[dim][No response from model][/] Context may have exceeded the model's "
                    "window. Try [bold cyan]/new[/] for a fresh session, or switch model with "
                    "[bold cyan]Ctrl+M[/].\n"
                )
                yield TextDelta(text=warning)
                break

            if not tool_calls_to_execute:
                break

            for tool_call in tool_calls_to_execute:
                tool_name = tool_call["function"]["name"]
                try:
                    args = json.loads(tool_call["function"]["arguments"])
                except json.JSONDecodeError:
                    args = {}

                if not self.auto_approve and self.on_tool_approval:
                    import asyncio
                    is_approved = await self.on_tool_approval(tool_name, args) if asyncio.iscoroutinefunction(self.on_tool_approval) else self.on_tool_approval(tool_name, args)
                    if not is_approved:
                        result = (
                            f"TOOL REJECTED BY USER: '{tool_name}' was explicitly declined.\n"
                            f"Do NOT retry this tool call.\n"
                            f"Acknowledge the rejection, then ask the user how they would like to proceed."
                        )
                        self.session.add_message("tool", content=result, name=tool_name, tool_call_id=tool_call["id"])
                        yield ToolResult(tool_id=tool_call["id"], result="[Rejected by User]")
                        continue

                if self.dry_run:
                    result = f"[DRY RUN] Would execute {tool_name}({json.dumps(args, indent=2)})"
                else:
                    try:
                        result = execute_tool(tool_name, args)
                    except Exception as e:
                        result = f"Error executing {tool_name}: {e}"

                self.session.add_message("tool", content=str(result), name=tool_name, tool_call_id=tool_call["id"])
                yield ToolResult(tool_id=tool_call["id"], result=str(result))
