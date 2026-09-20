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


def sanitize_messages_for_api(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sanitize and repair a chat message sequence to ensure full compliance with
    OpenAI / OpenRouter API requirements.

    1. Strips non-standard keys (e.g. 'thinking', 'duration', 'images', 'turn_id').
    2. Ensures every 'tool' message directly follows the 'assistant' message that called it.
    3. Drops orphaned 'tool' messages that have no preceding assistant tool_calls.
    4. Re-orders tool responses if displaced, and synthesizes tool responses for any
       unfulfilled tool_calls (e.g. if a turn was cancelled mid-execution).
    5. Ensures assistant message content is not None when tool_calls is absent.
    """
    if not messages:
        return []

    allowed_keys = {"role", "content", "tool_calls", "tool_call_id", "name"}
    cleaned: List[Dict[str, Any]] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        c = {k: v for k, v in m.items() if k in allowed_keys}
        if "role" not in c:
            continue
        cleaned.append(c)

    sanitized: List[Dict[str, Any]] = []
    i = 0
    n = len(cleaned)

    while i < n:
        msg = cleaned[i]
        role = msg.get("role")

        if role == "assistant":
            tcalls = msg.get("tool_calls")
            if not tcalls:
                if msg.get("content") is None:
                    msg["content"] = ""
                sanitized.append(msg)
                i += 1
            else:
                call_ids = [
                    tc.get("id")
                    for tc in tcalls
                    if isinstance(tc, dict) and tc.get("id")
                ]
                sanitized.append(msg)
                i += 1

                found_tools: Dict[str, Dict[str, Any]] = {}

                # Check contiguous following tool messages
                while i < n and cleaned[i].get("role") == "tool":
                    tid = cleaned[i].get("tool_call_id")
                    if tid in call_ids and tid not in found_tools:
                        found_tools[tid] = cleaned[i]
                    else:
                        log.warning("Dropping orphaned or duplicate tool message (id=%s)", tid)
                    i += 1

                # Search small window ahead in case tool responses were displaced
                remaining_cids = [cid for cid in call_ids if cid not in found_tools]
                for cid in remaining_cids:
                    for j in range(i, min(i + 10, len(cleaned))):
                        if cleaned[j].get("role") == "tool" and cleaned[j].get("tool_call_id") == cid:
                            found_tools[cid] = cleaned.pop(j)
                            n -= 1
                            break

                for cid in call_ids:
                    if cid in found_tools:
                        sanitized.append(found_tools[cid])
                    else:
                        log.warning("Synthesizing missing tool response for call_id=%s", cid)
                        sanitized.append({
                            "role": "tool",
                            "tool_call_id": cid,
                            "content": "[Tool execution cancelled or interrupted]",
                        })

        elif role == "tool":
            log.warning("Dropping orphaned tool message (id=%s) not preceded by assistant tool_calls", msg.get("tool_call_id"))
            i += 1

        else:
            sanitized.append(msg)
            i += 1

    return sanitized


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
    has_images = any(
        isinstance(m.get("content"), list) and any(
            isinstance(p, dict) and p.get("type") in ("image_url", "image")
            for p in m.get("content", [])
        )
        for m in (messages or [])
    )

    sanitized_messages = sanitize_messages_for_api(messages)

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

    kwargs = {
        "model": litellm_model,
        "messages": sanitized_messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["api_base"] = base_url
    if tools:
        kwargs["tools"] = tools

    # Custom kwargs per provider
    if provider_name == "ollama" and _num_ctx:
        kwargs.setdefault("options", {})["num_ctx"] = _num_ctx

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

        max_retries = 3
        for attempt in range(max_retries + 1):
            try:
                response_stream = await acompletion(**kwargs)
                break
            except Exception as e:
                msg = str(e).lower()
                is_429 = "429" in msg or "rate limit" in msg or "ratelimit" in msg or "quota" in msg
                is_transient_5xx = any(code in msg for code in ("500", "502", "503", "504", "serviceunavailable", "service_unavailable", "service unavailable", "bad gateway", "gateway timeout", "internal server error"))
                is_conn_error = any(term in msg for term in ("connection error", "connection reset", "connection refused", "apiconnectionerror", "timeout", "timed out"))
                if (is_429 or is_transient_5xx or is_conn_error) and attempt < max_retries:
                    import re, random
                    if is_429:
                        wait_s = 2.0 * (attempt + 1)
                        m = re.search(r"retry in ([\d.]+)s", msg)
                        if m:
                            try:
                                wait_s = min(max(float(m.group(1)), 1.0), 8.0)
                            except Exception:
                                pass
                        log.warning("Rate limit on initial call, retrying in %.1fs (attempt %d/%d)...", wait_s, attempt + 1, max_retries)
                    else:
                        wait_s = (1.5 * (2 ** attempt)) + random.uniform(0.1, 0.5)
                        log.warning("Transient upstream error (%s), retrying in %.1fs (attempt %d/%d)...", type(e).__name__, wait_s, attempt + 1, max_retries)
                    await asyncio.sleep(wait_s)
                    continue
                raise
    except Exception as e:
        log.error("acompletion initial error: %s", e, exc_info=True)
        yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
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
        yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
    except Exception as e:
        log.error("Mid-stream error (%s): %s", type(e).__name__, e, exc_info=True)
        yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
    finally:
        # Always ensure Done is emitted even on cancel? No — caller handles CancelledError
        # Only emit Done on normal/error paths; CancelledError already re-raised above.
        pass

    yield Done(usage=usage)


def classify_and_format_error(
    e: Exception,
    provider: str = "",
    model: str = "",
    has_images: bool = False,
) -> str:
    import html
    import re

    msg = str(e) or type(e).__name__
    low = msg.lower()
    err_cls = type(e).__name__

    disp_model = model or "the selected model"
    disp_prov = (provider or "AI provider").capitalize()

    is_vision = (
        has_images
        or any(k in low for k in ("image", "vision", "multimodal", "modality", "does not support image"))
    ) and any(k in low for k in ("image", "vision", "multimodal", "modality", "support", "400", "payload"))

    is_rate = "429" in msg or "rate limit" in low or "ratelimit" in low or "quota" in low
    is_upstream = any(k in low for k in (
        "midstreamfallbackerror", "serviceunavailable", "service_unavailable", "service unavailable",
        "503", "502", "500", "504", "bad gateway", "gateway timeout",
        "upstream error", "apiconnectionerror", "connection reset", "broken pipe"
    ))
    is_context = any(k in low for k in ("context length", "maximum context", "token limit", "context_length_exceeded", "prompt is too long"))
    is_auth = any(k in low for k in ("401", "403", "unauthorized", "invalid api key", "authentication error", "invalid_api_key", "forbidden"))
    is_ollama_off = ("connection refused" in low or "failed to connect" in low) and ("11434" in low or provider == "ollama")
    is_stall = "stalled" in low or "watchdog" in low or "first token" in low

    if is_vision:
        err_type = "vision_unsupported"
        badge = "IMAGE NOT SUPPORTED"
        title = "Model Does Not Support Images"
        desc = (
            f"The model <strong>{html.escape(disp_model)}</strong> does not support image inputs. "
            "Switch to a vision-capable model (e.g. Claude 3.7 Sonnet, GPT-4o, Gemini 2.0 Flash) or retry with text only."
        )
        actions = (
            '<button class="btn-error-retry" data-action="retry-without-image" title="Retry prompt with image removed">'
            '🔄 Retry without Image</button>'
            '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Choose a vision-capable model">'
            '⚙️ Switch Model</button>'
        )
    elif is_upstream:
        err_type = "provider_unavailable"
        badge = "SERVICE DISRUPTED"
        title = "Upstream Service Interruption"
        desc = (
            f"The upstream provider ({html.escape(disp_prov)}) experienced a temporary service disruption or mid-stream disconnect. "
            "This is usually transient—click Retry to continue."
        )
        actions = (
            '<button class="btn-error-retry" data-action="retry-turn" title="Retry this turn immediately">'
            '🔄 Retry Turn</button>'
            '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to another provider/model">'
            '⚙️ Switch Model</button>'
        )
    elif is_rate:
        err_type = "rate_limit"
        badge = "RATE LIMIT"
        title = "Rate Limit / Quota Reached"
        retry_hint = ""
        m = re.search(r"retry in ([\d.]+)s", msg, re.IGNORECASE)
        if m:
            retry_hint = f" (wait ~{int(float(m.group(1)))}s)"
        desc = (
            f"The provider ({html.escape(disp_prov)}) returned HTTP 429 rate limit or quota exceeded{retry_hint}. "
            "Please wait a moment and click Retry."
        )
        actions = (
            '<button class="btn-error-retry" data-action="retry-turn" title="Retry after waiting">'
            '🔄 Retry Turn</button>'
            '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to an alternate model">'
            '⚙️ Switch Model</button>'
        )
    elif is_context:
        err_type = "context_exceeded"
        badge = "CONTEXT LIMIT"
        title = "Context Window Limit Reached"
        desc = (
            f"This conversation has reached the context limit for <strong>{html.escape(disp_model)}</strong>. "
            "Compact the conversation to preserve key details, or start a fresh session."
        )
        actions = (
            '<button class="btn-error-retry" data-action="trigger-compact" title="Compact previous context">'
            '🗜️ Compact Context</button>'
            '<button class="btn-error-secondary" data-action="new-session" title="Start a new session">'
            '➕ New Session</button>'
        )
    elif is_auth:
        err_type = "auth_error"
        badge = "AUTHENTICATION"
        title = "Authentication Error"
        desc = (
            f"Invalid or missing API key for <strong>{html.escape(disp_prov)}</strong>. "
            "Please configure your API key in Settings."
        )
        actions = (
            '<button class="btn-error-retry" data-action="open-settings" title="Open Settings to enter API key">'
            '⚙️ Open Settings</button>'
        )
    elif is_ollama_off:
        err_type = "ollama_offline"
        badge = "OFFLINE"
        title = "Local Ollama Not Running"
        desc = (
            "Could not connect to local Ollama on port 11434. "
            "Ensure the Ollama service is active (<code>ollama serve</code>)."
        )
        actions = (
            '<button class="btn-error-retry" data-action="retry-turn" title="Retry connection">'
            '🔄 Retry Turn</button>'
        )
    elif is_stall:
        err_type = "timeout"
        badge = "TIMED OUT"
        title = "Provider Connection Timed Out"
        desc = (
            f"{html.escape(disp_prov)}/{html.escape(disp_model)} sent no response within the timeout period. "
            "The server may be overloaded. Click Retry to try again."
        )
        actions = (
            '<button class="btn-error-retry" data-action="retry-turn" title="Retry this turn">'
            '🔄 Retry Turn</button>'
            '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to another model">'
            '⚙️ Switch Model</button>'
        )
    else:
        err_type = "generic"
        badge = "ERROR"
        title = f"Turn Interrupted ({err_cls})"
        first_line = msg.splitlines()[0] if msg else err_cls
        if len(first_line) > 140:
            first_line = first_line[:137] + "..."
        desc = (
            f"An error interrupted communication with <strong>{html.escape(disp_prov)}</strong>: {html.escape(first_line)}. "
            "Click Retry to re-send this turn."
        )
        actions = (
            '<button class="btn-error-retry" data-action="retry-turn" title="Retry this turn">'
            '🔄 Retry Turn</button>'
        )

    raw_preview = html.escape(msg[:500] + ("..." if len(msg) > 500 else ""))

    return (
        f'\n<div class="andromity-error-card" data-error-type="{err_type}" data-retryable="true">\n'
        f'  <div class="error-card-header">\n'
        f'    <div class="error-header-left">\n'
        f'      <span class="error-badge">{badge}</span>\n'
        f'      <span class="error-title">{title}</span>\n'
        f'    </div>\n'
        f'  </div>\n'
        f'  <div class="error-card-body">{desc}</div>\n'
        f'  <details class="error-details">\n'
        f'    <summary>Technical Details ({err_cls})</summary>\n'
        f'    <pre class="error-code"><code>{raw_preview}</code></pre>\n'
        f'  </details>\n'
        f'  <div class="error-card-actions">\n'
        f'    {actions}\n'
        f'  </div>\n'
        f'</div>\n'
    )


def _format_error_text(e: Exception) -> str:
    return classify_and_format_error(e)


def _handle_rate_limit(e: Exception) -> TextDelta:
    return TextDelta(text=classify_and_format_error(e))

