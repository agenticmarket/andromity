import json
from typing import AsyncGenerator, List, Dict, Any, Optional

import litellm
from litellm import acompletion
from andromity.config import config
from andromity.core.debug_log import get_logger
from andromity.core.events import (
    StreamEvent, TextDelta, ThinkingDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done
)

log = get_logger("provider")


async def stream_completion(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    provider_name: Optional[str] = None,
) -> AsyncGenerator[StreamEvent, None]:
    if provider_name is None:
        provider_name = config.get("default", "provider", "anthropic")
    model = config.get("default", "model", "claude-sonnet-4-6")
    provider_cfg = config.get_provider_config(provider_name)

    if provider_name == "google":
        # LiteLLM routes Google AI Studio Gemini API via the 'gemini/' prefix
        litellm_model = f"gemini/{model}" if not model.startswith("gemini/") else model
        base_url = provider_cfg.get("base_url") if provider_cfg else None
    elif provider_name == "ollama":
        # LiteLLM routes Ollama chat endpoint via 'ollama_chat/' or 'ollama/'
        litellm_model = f"ollama_chat/{model}" if not (model.startswith("ollama/") or model.startswith("ollama_chat/")) else model
        base_url = (provider_cfg.get("base_url") if provider_cfg else None) or "http://localhost:11434"
    elif provider_name == "nvidia":
        # Route natively via litellm's nvidia_nim provider (handles auth and endpoints automatically)
        litellm_model = f"nvidia_nim/{model}" if not model.startswith("nvidia_nim/") else model
        base_url = (provider_cfg.get("base_url") if provider_cfg else None)
    elif provider_cfg and provider_cfg.get("type") and provider_cfg.get("type") != provider_name:
        litellm_model = f"{provider_cfg.get('type')}/{model}"
        base_url = provider_cfg.get("base_url")
    elif provider_name == "openrouter":
        litellm_model = f"openrouter/{model}" if not model.startswith("openrouter/") else model
        base_url = provider_cfg.get("base_url") if provider_cfg else None
    else:
        litellm_model = f"{provider_name}/{model}" if not model.startswith(f"{provider_name}/") else model
        base_url = provider_cfg.get("base_url") if provider_cfg else None

    api_key = config.get_api_key(provider_name)

    kwargs: Dict[str, Any] = {"model": litellm_model, "messages": messages, "stream": True}
    if tools:
        kwargs["tools"] = tools
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["api_base"] = base_url

    log.info("stream_completion start: provider=%s model=%s litellm_model=%s",
             provider_name, model, litellm_model)

    try:
        response_stream = await acompletion(**kwargs)
    except Exception as e:
        log.error("acompletion initial error: %s", e, exc_info=True)
        yield TextDelta(text=f"\n[Error communicating with provider: {e}]\n")
        yield Done()
        return

    current_tool_id = None
    usage = None
    in_thinking = False

    try:
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
            elif getattr(delta, "content", None) or getattr(delta, "thinking", None) or getattr(delta, "reasoning_content", None):
                if getattr(delta, "thinking", None):
                    yield ThinkingDelta(text=delta.thinking)
                if getattr(delta, "reasoning_content", None):
                    yield ThinkingDelta(text=delta.reasoning_content)
                if getattr(delta, "content", None) and not current_tool_id:
                    text = delta.content
                    if "<think>" in text:
                        in_thinking = True
                        text = text.replace("<think>", "")
                    if "</think>" in text:
                        in_thinking = False
                        parts = text.split("</think>")
                        if parts[0]:
                            yield ThinkingDelta(text=parts[0])
                        if len(parts) > 1 and parts[1]:
                            yield TextDelta(text=parts[1])
                        continue
                    
                    if in_thinking:
                        yield ThinkingDelta(text=text)
                    else:
                        yield TextDelta(text=text)

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

    except litellm.RateLimitError as e:
        yield _handle_rate_limit(e)
    except Exception as e:
        msg = str(e)
        if "429" in msg or "quota" in msg.lower() or "ratelimit" in msg.lower():
            log.warning("Mid-stream rate limit (429): %s", e)
            yield _handle_rate_limit(e)
        else:
            log.error("Mid-stream error (%s): %s", type(e).__name__, e, exc_info=True)
            err_type = type(e).__name__
            yield TextDelta(text=f"\n[Stream error ({err_type})] {e}\n")

    yield Done(usage=usage)

def _handle_rate_limit(e: Exception) -> TextDelta:
    msg = str(e)
    retry_hint = ""
    if "retry in" in msg.lower():
        import re
        m = re.search(r"retry in ([\d.]+)s", msg, re.IGNORECASE)
        if m:
            retry_hint = f" Retry in ~{int(float(m.group(1)))}s."
    return TextDelta(text=(
        f"\n[Rate limit reached] The provider returned HTTP 429 (quota exceeded).{retry_hint}\n"
        f"• Switch model: /model\n"
        f"• Or wait and retry.\n"
    ))
