import json
from typing import AsyncGenerator, List, Dict, Any, Optional

from litellm import acompletion
from andromity.config import config
from andromity.core.events import (
    StreamEvent, TextDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done
)


async def stream_completion(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    provider_name: Optional[str] = None,
) -> AsyncGenerator[StreamEvent, None]:
    if provider_name is None:
        provider_name = config.get("default", "provider", "anthropic")
    model = config.get("default", "model", "claude-sonnet-4-20240514")
    provider_cfg = config.get_provider_config(provider_name)

    if provider_cfg and provider_cfg.get("type") and provider_cfg.get("type") != provider_name:
        litellm_model = f"{provider_cfg.get('type')}/{model}"
    else:
        litellm_model = f"{provider_name}/{model}"

    api_key = config.get_api_key(provider_name)
    base_url = provider_cfg.get("base_url") if provider_cfg else None

    kwargs: Dict[str, Any] = {"model": litellm_model, "messages": messages, "stream": True}
    if tools:
        kwargs["tools"] = tools
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["api_base"] = base_url

    try:
        response_stream = await acompletion(**kwargs)
    except Exception as e:
        yield TextDelta(text=f"\n[Error communicating with provider: {e}]\n")
        yield Done()
        return

    current_tool_id = None
    usage = None

    async for chunk in response_stream:
        if not chunk.choices:
            if hasattr(chunk, "usage") and chunk.usage:
                usage = {
                    "prompt_tokens": getattr(chunk.usage, "prompt_tokens", 0) or 0,
                    "completion_tokens": getattr(chunk.usage, "completion_tokens", 0) or 0,
                    "total_tokens": getattr(chunk.usage, "total_tokens", 0) or 0,
                }
            continue

        delta = chunk.choices[0].delta

        if getattr(delta, "tool_calls", None):
            for tool_call in delta.tool_calls:
                if tool_call.id:
                    if current_tool_id:
                        yield ToolCallEnd(tool_id=current_tool_id)
                    current_tool_id = tool_call.id
                    yield ToolCallStart(tool_name=tool_call.function.name, tool_id=current_tool_id)
                if tool_call.function and getattr(tool_call.function, "arguments", None):
                    yield ToolCallDelta(tool_id=current_tool_id, args_json_chunk=tool_call.function.arguments)
        elif getattr(delta, "content", None):
            yield TextDelta(text=delta.content)

        finish_reason = chunk.choices[0].finish_reason
        if finish_reason:
            if current_tool_id:
                yield ToolCallEnd(tool_id=current_tool_id)
                current_tool_id = None

        if hasattr(chunk, "usage") and chunk.usage:
            usage = {
                "prompt_tokens": getattr(chunk.usage, "prompt_tokens", 0) or 0,
                "completion_tokens": getattr(chunk.usage, "completion_tokens", 0) or 0,
                "total_tokens": getattr(chunk.usage, "total_tokens", 0) or 0,
            }

    yield Done(usage=usage)
