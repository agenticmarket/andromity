import asyncio
import json
from typing import AsyncGenerator, List, Dict, Any, Optional

from andromity.config import config
from andromity.core.debug_log import get_logger
from andromity.core.events import (
    StreamEvent, TextDelta, ThinkingDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done
)

log = get_logger("provider")


class ProviderStalledError(Exception):
    """Raised by the first-token watchdog when a provider sends no chunk at all
    within the watchdog window (upstream queued/overloaded; keep-alive comments
    defeat the client read timeout, so nothing else aborts the request)."""

    def __init__(self, timeout: float):
        super().__init__(f"no first token within {timeout:.0f}s")
        self.timeout = timeout


def _format_stall_text(provider_name: str, model: str, timeout: float) -> str:
    return (
        f"\n**[Provider stalled]** {provider_name}/{model} sent nothing within {timeout:.0f}s "
        "(upstream queued or overloaded).\n"
        "• Try again — queued requests usually clear quickly.\n"
        "• Or switch model with /model.\n"
    )


def _is_local_base_url(base_url: Optional[str]) -> bool:
    if not base_url:
        return False
    b = base_url.lower()
    return "localhost" in b or "127.0.0.1" in b or "[::1]" in b


async def _first_token_guard(stream: Any, timeout: float, idle_chunk_timeout: float = 60.0):
    """Pass stream chunks through unchanged, raising ProviderStalledError if the first chunk
    or any subsequent chunk stalls for longer than timeout / idle_chunk_timeout seconds."""
    aiter = stream.__aiter__()
    try:
        first = await asyncio.wait_for(aiter.__anext__(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            aclose = getattr(stream, "aclose", None)
            if aclose:
                await aclose()
        except Exception:
            pass
        raise ProviderStalledError(timeout)
    except StopAsyncIteration:
        return
    yield first
    while True:
        try:
            chunk = await asyncio.wait_for(aiter.__anext__(), timeout=idle_chunk_timeout)
        except asyncio.TimeoutError:
            try:
                aclose = getattr(stream, "aclose", None)
                if aclose:
                    await aclose()
            except Exception:
                pass
            raise ProviderStalledError(idle_chunk_timeout)
        except StopAsyncIteration:
            break
        yield chunk


def _ensure_litellm_stub():
    """Ensure litellm price file exists in frozen PyInstaller environments so import never throws FileNotFoundError."""
    try:
        import sys, os
        candidates = []
        if getattr(sys, "frozen", False):
            mei = getattr(sys, "_MEIPASS", None)
            if mei:
                candidates.append(os.path.join(mei, "litellm"))
        temp_dir = os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp"
        if os.path.exists(temp_dir):
            for entry in os.listdir(temp_dir):
                if entry.startswith("_MEI"):
                    candidates.append(os.path.join(temp_dir, entry, "litellm"))
        for d in candidates:
            try:
                target = os.path.join(d, "model_prices_and_context_window_backup.json")
                if not os.path.exists(target):
                    os.makedirs(d, exist_ok=True)
                    with open(target, "w", encoding="utf-8") as f:
                        f.write("{}")
            except Exception:
                pass
    except Exception:
        pass

_ensure_litellm_stub()


async def stream_completion(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    provider_name: Optional[str] = None,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    first_token_timeout: Optional[float] = None,
) -> AsyncGenerator[StreamEvent, None]:
    # Lazy-import litellm — it has a heavy import chain (~2-4s), so we defer
    # it until the first actual AI call rather than paying the cost at startup.
    _ensure_litellm_stub()
    import litellm
    from litellm import acompletion
    litellm.drop_params = True
    litellm.suppress_debug_info = True



    if provider_name is None:
        provider_name = config.get("default", "provider", "anthropic")
    if model is None:
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
        clean_model = model.lstrip("~") if model else model
        litellm_model = f"openrouter/{clean_model}" if not clean_model.startswith("openrouter/") else clean_model
        base_url = provider_cfg.get("base_url") if provider_cfg else None
    else:
        litellm_model = f"{provider_name}/{model}" if not model.startswith(f"{provider_name}/") else model
        base_url = provider_cfg.get("base_url") if provider_cfg else None

    api_key = config.get_api_key(provider_name)

    kwargs: Dict[str, Any] = {
        "model": litellm_model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "timeout": 90,
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
        # Enable provider fallbacks so overloaded endpoints do not stall in queue
        kwargs.setdefault("extra_body", {})
        kwargs["extra_body"].setdefault("provider", {})
        kwargs["extra_body"]["provider"]["allow_fallbacks"] = True

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

    # ── First-token watchdog (see _first_token_guard) ────────────────────────
    # Cloud gateways (e.g. OpenRouter) send SSE keep-alive comments while an
    # upstream is queued/overloaded; those bytes reset the client read timeout,
    # so `timeout=90` never fires and the stream can stay silent forever. Abort
    # unless the first chunk arrives in time. Local Ollama servers may take
    # minutes to cold-load a model, so they get a generous window.
    if first_token_timeout is None:
        first_token_timeout = (
            600.0 if (provider_name == "ollama" or _is_local_base_url(base_url)) else 60.0
        )
    log.info("stream_completion first-token watchdog: %.0fs (provider=%s model=%s)",
             first_token_timeout, provider_name, model)
    response_stream = _first_token_guard(response_stream, first_token_timeout)

    # Map tool_call index → tool_id for interleaved parallel tool call streams
    open_tools: dict[int, str] = {}
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
                    idx = getattr(tool_call, "index", 0) or 0
                    if tool_call.id:
                        # New tool call starting at this index
                        if idx in open_tools:
                            yield ToolCallEnd(tool_id=open_tools[idx])
                        open_tools[idx] = tool_call.id
                        yield ToolCallStart(tool_name=tool_call.function.name, tool_id=tool_call.id)
                    if tool_call.function and getattr(tool_call.function, "arguments", None):
                        current_id = open_tools.get(idx)
                        if current_id:
                            yield ToolCallDelta(tool_id=current_id, args_json_chunk=tool_call.function.arguments)
            elif any(getattr(delta, attr, None) for attr in ["content", "thinking", "reasoning_content", "reasoning", "thought"]):
                for attr in ["thinking", "reasoning_content", "reasoning", "thought"]:
                    val = getattr(delta, attr, None)
                    if val:
                        yield ThinkingDelta(text=val)
                        break
                
                if getattr(delta, "content", None) and not open_tools:
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
                for tid in list(open_tools.values()):
                    yield ToolCallEnd(tool_id=tid)
                open_tools.clear()

            if hasattr(chunk, "usage") and chunk.usage:
                from andromity.core.usage import normalize_usage
                usage = normalize_usage(chunk.usage)

    except asyncio.CancelledError:
        log.info("stream_completion cancelled by user — closing provider stream")
        try:
            # Attempt graceful close of litellm stream (closes httpx / aiohttp)
            if hasattr(response_stream, 'aclose'):
                await response_stream.aclose()
            elif hasattr(response_stream, 'close'):
                response_stream.close()
        except Exception:
            pass
        # Clean up any open tool spans before exit
        for tid in list(open_tools.values()):
            try:
                yield ToolCallEnd(tool_id=tid)
            except Exception:
                pass
        raise
    except ProviderStalledError as e:
        log.error("Provider stalled: %s (provider=%s model=%s)", e, provider_name, model)
        yield TextDelta(text=_format_stall_text(provider_name, model, e.timeout))
        yield Done(usage=usage)
        return
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
    finally:
        # Always ensure Done is emitted even on cancel? No — caller handles CancelledError
        # Only emit Done on normal/error paths; CancelledError already re-raised above.
        pass

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
