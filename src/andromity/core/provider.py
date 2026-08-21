import json
from typing import AsyncGenerator, List, Dict, Any, Optional

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
    reasoning_effort: Optional[str] = None,
) -> AsyncGenerator[StreamEvent, None]:
    # Lazy-import litellm — it has a heavy import chain (~2-4s), so we defer
    # it until the first actual AI call rather than paying the cost at startup.
    import litellm
    from litellm import acompletion

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
        from andromity.core.models import get_ollama_num_ctx
        _num_ctx = get_ollama_num_ctx(model, base_url)
        log.info("Ollama num_ctx=%d for model=%s", _num_ctx, model)
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

    kwargs: Dict[str, Any] = {
        "model": litellm_model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True}
    }
    if tools:
        kwargs["tools"] = tools
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["api_base"] = base_url
    if provider_name == "ollama" and "_num_ctx" in locals():
        kwargs["num_ctx"] = locals()["_num_ctx"]

    # OpenRouter: send app identity headers so the dashboard shows "Andromity"
    # instead of "litellm". See https://openrouter.ai/docs#provider-routing
    if provider_name == "openrouter":
        kwargs["extra_headers"] = {
            "User-Agent": "Andromity",
            "HTTP-Referer": "https://github.com/agenticmarket/andromity",
            "X-Title": "Andromity",
            "X-OpenRouter-Title": "Andromity",
            "X-OpenRouter-Categories": "cli-agent",
        }

    log.info("stream_completion start: provider=%s model=%s litellm_model=%s",
             provider_name, model, litellm_model)

    try:
        if "z-ai/" in model or "glm-" in model:
            kwargs.setdefault("extra_body", {})
            kwargs["extra_body"]["chat_template_kwargs"] = {
                "enable_thinking": True,
                "clear_thinking": False
            }

        # Inject reasoning effort when set
        if reasoning_effort and reasoning_effort != "off":
            if provider_name == "openrouter":
                kwargs.setdefault("extra_body", {})
                kwargs["extra_body"]["reasoning"] = {"effort": reasoning_effort, "exclude": False}
            else:
                # OpenAI o-series and compatible providers
                kwargs["reasoning_effort"] = reasoning_effort

        response_stream = await acompletion(**kwargs)
    except Exception as e:
        log.error("acompletion initial error: %s", e, exc_info=True)
        yield TextDelta(text=_format_error_text(e))
        yield Done()
        return

    current_tool_id = None
    usage = None
    in_thinking = False

    try:
        async for chunk in response_stream:
            if not chunk.choices:
                if hasattr(chunk, "usage") and chunk.usage:
                    from andromity.core.usage import normalize_usage
                    usage = normalize_usage(chunk.usage)
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
            elif any(getattr(delta, attr, None) for attr in ["content", "thinking", "reasoning_content", "reasoning", "thought"]):
                for attr in ["thinking", "reasoning_content", "reasoning", "thought"]:
                    val = getattr(delta, attr, None)
                    if val:
                        yield ThinkingDelta(text=val)
                        break
                
                if getattr(delta, "content", None) and not current_tool_id:
                    text = delta.content
                    # Handle <think>...</think> tag boundaries across chunks
                    while text:
                        if "<think>" in text:
                            in_thinking = True
                            text = text.split("<think>", 1)[1]
                            continue
                        if "</think>" in text:
                            in_thinking = False
                            parts = text.split("</think>", 1)
                            if parts[0]:
                                yield ThinkingDelta(text=parts[0])
                            text = parts[1] if len(parts) > 1 else ""
                            continue
                        if in_thinking:
                            yield ThinkingDelta(text=text)
                        else:
                            yield TextDelta(text=text)
                        break

            finish_reason = chunk.choices[0].finish_reason
            if finish_reason:
                if current_tool_id:
                    yield ToolCallEnd(tool_id=current_tool_id)
                    current_tool_id = None

            if hasattr(chunk, "usage") and chunk.usage:
                from andromity.core.usage import normalize_usage
                usage = normalize_usage(chunk.usage)

    except litellm.RateLimitError as e:
        yield _handle_rate_limit(e)
    except Exception as e:
        msg = str(e)
        if "429" in msg or "quota" in msg.lower() or "ratelimit" in msg.lower():
            log.warning("Mid-stream rate limit (429): %s", e)
            yield _handle_rate_limit(e)
        else:
            log.error("Mid-stream error (%s): %s", type(e).__name__, e, exc_info=True)
            yield TextDelta(text=_format_error_text(e))

    yield Done(usage=usage)

def _format_error_text(e: Exception) -> str:
    """Turn an arbitrary provider exception into a short, human-readable line.
    Never dumps the raw exception (which can be a huge nested JSON blob)."""
    msg = str(e)
    low = msg.lower()
    if "429" in msg or "rate limit" in low or "ratelimit" in low or "quota" in low:
        return _handle_rate_limit(e).text
    first_line = msg.splitlines()[0] if msg else type(e).__name__
    if len(first_line) > 160:
        first_line = first_line[:157] + "..."
    return f"\n[Error: {type(e).__name__}] {first_line}\n"


def _handle_rate_limit(e: Exception) -> TextDelta:
    import re
    msg = str(e)
    retry_hint = ""
    if "retry in" in msg.lower():
        m = re.search(r"retry in ([\d.]+)s", msg, re.IGNORECASE)
        if m:
            retry_hint = f" Retry in ~{int(float(m.group(1)))}s."
    return TextDelta(text=(
        f"\n[Rate limit reached] The provider returned HTTP 429 (quota exceeded).{retry_hint}\n"
        f"• Switch model: /model\n"
        f"• Or wait and retry.\n"
    ))
