import asyncio
import json
from pathlib import Path
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


STREAM_BACKOFF_DELAYS = [5.0, 10.0, 20.0]


async def stream_completion(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    provider_name: Optional[str] = None,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    first_token_timeout: Optional[float] = None,
    turn_id: Optional[str] = None,
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
    elif provider_name == "opencode":
        # OpenCode Zen inference gateway — OpenAI-compatible, requires User-Agent header
        litellm_model = f"openai/{model}" if not model.startswith("openai/") else model
        base_url = (provider_cfg.get("base_url") if provider_cfg else None) or "https://opencode.ai/inference/openai/v1"
    elif provider_name == "andromity":
        clean_model = model or "auto"
        litellm_model = f"openai/{clean_model}"
        base_url = (provider_cfg.get("base_url") if provider_cfg else None) or "https://gateway.agenticmarket.dev/v1"
    else:
        litellm_model = f"{provider_name}/{model}" if not model.startswith(f"{provider_name}/") else model
        base_url = provider_cfg.get("base_url") if provider_cfg else None

    api_key = config.get_api_key(provider_name)
    if provider_name == "andromity" and not api_key:
        api_key = "anonymous_trial"
    if provider_name == "opencode" and not api_key:
        # Auto-read token from OpenCode's local auth store (set by `opencode auth login`)
        try:
            import json as _json
            _auth_path = Path.home() / ".local" / "share" / "opencode" / "auth.json"
            _auth = _json.loads(_auth_path.read_text(encoding="utf-8"))
            api_key = _auth.get("opencode", {}).get("key") or _auth.get("openrouter", {}).get("key")
        except Exception:
            pass

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

    if provider_name == "andromity":
        andromity_headers = {
            "User-Agent": "Andromity",
            "x-andromity-client-id": config.get("user", "anonymous_id", "local_client"),
            "x-andromity-version": "0.2.12",
        }
        if turn_id:
            andromity_headers["x-andromity-turn-id"] = turn_id
        kwargs["extra_headers"] = andromity_headers

    # OpenRouter: send app identity headers so the dashboard shows "Andromity"
    # instead of "litellm". See https://openrouter.ai/docs#provider-routing
    if provider_name == "openrouter":
        kwargs["extra_headers"] = {
            "User-Agent": "Andromity",
            "HTTP-Referer": "https://andromity.agenticmarket.dev",
            "X-Title": "Andromity",
            "X-OpenRouter-Title": "Andromity",
            "X-OpenRouter-Categories": "cli-agent",
        }
        # Enable provider fallbacks so overloaded endpoints do not stall in queue
        kwargs.setdefault("extra_body", {})
        kwargs["extra_body"].setdefault("provider", {})
        kwargs["extra_body"]["provider"]["allow_fallbacks"] = True

    # OpenCode Zen: Cloudflare requires User-Agent matching the official client
    if provider_name == "opencode":
        kwargs["extra_headers"] = {"User-Agent": "opencode/1.0.0"}

    log.info("stream_completion start: provider=%s model=%s litellm_model=%s",
             provider_name, model, litellm_model)

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

    # Upstream retry with backoff for stalls, rate limits, and transient drops
    STREAM_BACKOFF_DELAYS = [5.0, 10.0, 20.0]
    total_attempts = len(STREAM_BACKOFF_DELAYS) + 1

    if first_token_timeout is None:
        first_token_timeout = (
            600.0 if (provider_name == "ollama" or _is_local_base_url(base_url)) else 60.0
        )

    for attempt in range(total_attempts):
        has_emitted_content = False
        open_tools: dict[int, str] = {}
        usage = None
        in_thinking = False
        response_stream = None

        try:
            # 1. Start acompletion stream
            try:
                response_stream = await acompletion(**kwargs)
            except Exception as e:
                msg = str(e).lower()
                is_daily_quota = (
                    "daily_limit_reached" in msg
                    or "quota_exceeded" in msg
                    or "free trial requests" in msg
                    or "daily limit" in msg
                    or "upgrade_url" in msg
                    or "sign in with github" in msg
                )
                if is_daily_quota:
                    log.info("Daily quota reached upstream. Failing fast without retries.")
                    yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
                    yield Done()
                    return

                is_429 = "429" in msg or "rate limit" in msg or "ratelimit" in msg or "quota" in msg
                if attempt < len(STREAM_BACKOFF_DELAYS):
                    wait_s = STREAM_BACKOFF_DELAYS[attempt]
                    if is_429:
                        import re
                        m = re.search(r"retry in ([\d.]+)s", msg)
                        if m:
                            try:
                                wait_s = min(max(float(m.group(1)), 1.0), 30.0)
                            except Exception:
                                pass
                    log.warning(
                        "Upstream call error (%s). Retrying in %.1fs (attempt %d/%d)...",
                        type(e).__name__, wait_s, attempt + 1, total_attempts
                    )
                    await asyncio.sleep(wait_s)
                    continue
                else:
                    log.error("acompletion initial error after %d attempts: %s", total_attempts, e, exc_info=True)
                    yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
                    yield Done()
                    return

            # 2. Watchdog: guard against upstream queue stall
            response_stream = _first_token_guard(response_stream, first_token_timeout)

            # 3. Stream chunks
            async for chunk in response_stream:
                if not chunk.choices:
                    if hasattr(chunk, "usage") and chunk.usage:
                        from andromity.core.usage import normalize_usage
                        usage = normalize_usage(chunk.usage)
                    continue

                delta = chunk.choices[0].delta

                if getattr(delta, "tool_calls", None):
                    has_emitted_content = True
                    for tool_call in delta.tool_calls:
                        idx = getattr(tool_call, "index", 0) or 0
                        if tool_call.id:
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
                            has_emitted_content = True
                            yield ThinkingDelta(text=val)
                            break

                    if getattr(delta, "content", None) and not open_tools:
                        text = delta.content
                        has_emitted_content = True
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

            # Successful stream completion!
            yield Done(usage=usage)
            return

        except asyncio.CancelledError:
            log.info("stream_completion cancelled by user — closing provider stream")
            if response_stream:
                try:
                    if hasattr(response_stream, 'aclose'):
                        await response_stream.aclose()
                    elif hasattr(response_stream, 'close'):
                        response_stream.close()
                except Exception:
                    pass
            for tid in list(open_tools.values()):
                try:
                    yield ToolCallEnd(tool_id=tid)
                except Exception:
                    pass
            raise
        except (ProviderStalledError, litellm.RateLimitError, Exception) as e:
            if response_stream:
                try:
                    if hasattr(response_stream, 'aclose'):
                        await response_stream.aclose()
                    elif hasattr(response_stream, 'close'):
                        response_stream.close()
                except Exception:
                    pass

            # If stalled or failed BEFORE emitting any tokens, retry with backoff!
            if not has_emitted_content and attempt < len(STREAM_BACKOFF_DELAYS):
                wait_s = STREAM_BACKOFF_DELAYS[attempt]
                log.warning(
                    "Upstream stalled or failed before emitting tokens (%s: %s). Retrying in %.0fs (attempt %d/%d)...",
                    type(e).__name__, e, wait_s, attempt + 1, total_attempts
                )
                await asyncio.sleep(wait_s)
                continue

            log.error("Provider stream error (%s): %s", type(e).__name__, e, exc_info=True)
            if isinstance(e, ProviderStalledError):
                yield TextDelta(text=_format_stall_text(provider_name, model, e.timeout))
            else:
                yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
            yield Done(usage=usage)
            return


def classify_error_info(
    e: Exception,
    provider: str = "",
    model: str = "",
    has_images: bool = False,
) -> dict:
    import html
    import re
    from datetime import datetime, timezone, timedelta

    msg = str(e) or type(e).__name__
    low = msg.lower()
    err_cls = type(e).__name__

    disp_model = model or "the selected model"
    disp_prov = (provider or "AI provider").capitalize()

    is_vision = (
        has_images
        or any(k in low for k in ("image", "vision", "multimodal", "modality", "does not support image"))
    ) and any(k in low for k in ("image", "vision", "multimodal", "modality", "support", "400", "payload"))

    is_rate = (
        "429" in msg
        or "rate limit" in low
        or "ratelimit" in low
        or "quota" in low
        or "daily_limit" in low
        or "daily limit" in low
        or "free trial" in low
    )
    is_upstream = any(k in low for k in (
        "midstreamfallbackerror", "serviceunavailable", "service_unavailable", "service unavailable",
        "503", "502", "500", "504", "bad gateway", "gateway timeout",
        "upstream error", "apiconnectionerror", "connection reset", "broken pipe"
    ))
    is_context = any(k in low for k in ("context length", "maximum context", "token limit", "context_length_exceeded", "prompt is too long"))
    is_auth = any(k in low for k in ("401", "403", "unauthorized", "invalid api key", "authentication error", "invalid_api_key", "forbidden"))
    is_ollama_off = ("connection refused" in low or "failed to connect" in low) and ("11434" in low or provider == "ollama")
    is_stall = "stalled" in low or "watchdog" in low or "first token" in low

    icon_retry = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>'
    icon_model = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>'
    icon_compact = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>'
    icon_plus = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>'
    icon_settings = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'
    icon_account = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>'

    timer_text = ""
    timer_html = ""

    if is_vision:
        err_type = "vision_unsupported"
        badge = "IMAGE NOT SUPPORTED"
        title = "Model Does Not Support Images"
        desc_text = (
            f"The model '{disp_model}' does not support image inputs. "
            "Switch to a vision-capable model (e.g. Claude 3.7 Sonnet, GPT-4o, Gemini 2.0 Flash) or retry with text only."
        )
        desc_html = (
            f"The model <strong>{html.escape(disp_model)}</strong> does not support image inputs. "
            "Switch to a vision-capable model (e.g. Claude 3.7 Sonnet, GPT-4o, Gemini 2.0 Flash) or retry with text only."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="retry-without-image" title="Retry prompt with image removed">'
            f'{icon_retry}Retry without Image</button>'
            f'<button class="btn-error-secondary" data-action="switch-model-flyout" title="Choose a vision-capable model">'
            f'{icon_model}Switch Model</button>'
        )
        actions_tui = [
            "Retry prompt without image attachments",
            "Press Ctrl+M to switch to a vision model (e.g. Claude 3.7 Sonnet, GPT-4o)",
        ]
    elif is_upstream:
        err_type = "provider_unavailable"
        badge = "SERVICE DISRUPTED"
        title = "Upstream Service Interruption"
        desc_text = (
            f"The upstream provider ({disp_prov}) experienced a temporary service disruption or mid-stream disconnect. "
            "This is usually transient—retry to continue."
        )
        desc_html = (
            f"The upstream provider ({html.escape(disp_prov)}) experienced a temporary service disruption or mid-stream disconnect. "
            "This is usually transient—click Retry to continue."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="retry-turn" title="Retry this turn immediately">'
            f'{icon_retry}Retry Turn</button>'
            f'<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to another provider/model">'
            f'{icon_model}Switch Model</button>'
        )
        actions_tui = [
            "Type /retry to re-send this turn",
            "Press Ctrl+M to switch to another provider or model",
        ]
    elif is_rate:
        is_daily_quota = (
            "daily_limit_reached" in low
            or "quota_exceeded" in low
            or "free trial requests" in low
            or "daily limit" in low
            or "upgrade_url" in low
            or "sign in with github" in low
        )
        if is_daily_quota:
            now = datetime.now(timezone.utc)
            tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            secs = int((tomorrow - now).total_seconds())
            h = max(0, secs // 3600)
            m = max(0, (secs % 3600) // 60)
            timer_text = f"Quota resets in {h}h {m}m (00:00 UTC)"
            timer_html = (
                f'<div style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-family:var(--font-mono,monospace);color:#10b981;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.22);padding:3px 9px;border-radius:4px;margin-top:8px;">'
                f'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>'
                f'{timer_text}'
                f'</div>'
            )
            err_type = "quota_exceeded"
            badge = "QUOTA LIMIT"
            title = "Daily Limit Reached"
            is_authed = bool(config.get_api_key("andromity") or config.get("default", "user_email", "") or config.get("user", "token", ""))
            if is_authed:
                desc_text = (
                    "You have reached your daily gateway limit. "
                    "Add your BYOK key in Settings for unlimited requests, or adjust your quota in the panel."
                )
                desc_html = (
                    f"<div>{desc_text}</div>"
                    f"{timer_html}"
                )
                actions_html = (
                    f'<button class="btn-error-retry" data-action="open-settings" title="Configure BYOK">'
                    f'{icon_settings}Open Settings</button>'
                    f'<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to an alternate model">'
                    f'{icon_model}Switch Model</button>'
                )
                actions_tui = [
                    "Press Ctrl+P -> Settings to configure BYOK for unlimited usage",
                    "Press Ctrl+M to switch model",
                ]
            else:
                desc_text = (
                    "You have reached your daily free trial limit. "
                    "Sign in with your AgenticMarket account to activate your account, or add a BYOK key in Settings."
                )
                desc_html = (
                    f"<div>{desc_text}</div>"
                    f"{timer_html}"
                )
                actions_html = (
                    f'<button class="btn-error-retry" data-action="open-account-login" title="Sign in with AgenticMarket">'
                    f'{icon_account}Sign In</button>'
                    f'<button class="btn-error-secondary" data-action="open-settings" title="Configure BYOK">'
                    f'{icon_settings}Open Settings</button>'
                )
                actions_tui = [
                    "Run 'andromity auth login' or sign in via Hub",
                    "Press Ctrl+P -> Settings to configure BYOK for unlimited usage",
                ]
        else:
            err_type = "rate_limit"
            badge = "RATE LIMIT"
            title = "Rate Limit / Quota Reached"
            retry_hint = ""
            m = re.search(r"retry in ([\d.]+)s", msg, re.IGNORECASE)
            if m:
                retry_hint = f" (wait ~{int(float(m.group(1)))}s)"
            desc_text = (
                f"The provider ({disp_prov}) returned HTTP 429 rate limit or quota exceeded{retry_hint}. "
                "Please wait a moment and retry."
            )
            desc_html = (
                f"The provider ({html.escape(disp_prov)}) returned HTTP 429 rate limit or quota exceeded{retry_hint}. "
                "Please wait a moment and click Retry."
            )
            actions_html = (
                f'<button class="btn-error-retry" data-action="retry-turn" title="Retry after waiting">'
                f'{icon_retry}Retry Turn</button>'
                f'<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to an alternate model">'
                f'{icon_model}Switch Model</button>'
            )
            actions_tui = [
                "Wait a moment and type /retry",
                "Press Ctrl+M to switch model",
            ]
    elif is_context:
        err_type = "context_exceeded"
        badge = "CONTEXT LIMIT"
        title = "Context Window Limit Reached"
        desc_text = (
            f"This conversation has reached the context limit for '{disp_model}'. "
            "Compact the conversation to preserve key details, or start a fresh session."
        )
        desc_html = (
            f"This conversation has reached the context limit for <strong>{html.escape(disp_model)}</strong>. "
            "Compact the conversation to preserve key details, or start a fresh session."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="trigger-compact" title="Compact previous context">'
            f'{icon_compact}Compact Context</button>'
            f'<button class="btn-error-secondary" data-action="new-session" title="Start a new session">'
            f'{icon_plus}New Session</button>'
        )
        actions_tui = [
            "Type /compact to summarize context",
            "Press Ctrl+N to start a fresh session",
        ]
    elif is_auth:
        err_type = "auth_error"
        badge = "AUTHENTICATION"
        title = "Authentication Error"
        desc_text = (
            f"Invalid or missing API key for {disp_prov}. "
            "Please configure your API key in Settings."
        )
        desc_html = (
            f"Invalid or missing API key for <strong>{html.escape(disp_prov)}</strong>. "
            "Please configure your API key in Settings."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="open-settings" title="Open Settings to enter API key">'
            f'{icon_settings}Open Settings</button>'
        )
        actions_tui = [
            f"Press Ctrl+P -> Settings to configure key for {disp_prov}",
        ]
    elif is_ollama_off:
        err_type = "ollama_offline"
        badge = "OFFLINE"
        title = "Local Ollama Not Running"
        desc_text = (
            "Could not connect to local Ollama on port 11434. "
            "Ensure the Ollama service is active ('ollama serve')."
        )
        desc_html = (
            "Could not connect to local Ollama on port 11434. "
            "Ensure the Ollama service is active (<code>ollama serve</code>)."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="retry-turn" title="Retry connection">'
            f'{icon_retry}Retry Turn</button>'
        )
        actions_tui = [
            "Run 'ollama serve' in terminal, then type /retry",
        ]
    elif is_stall:
        err_type = "timeout"
        badge = "TIMED OUT"
        title = "Provider Connection Timed Out"
        desc_text = (
            f"{disp_prov}/{disp_model} sent no response within the timeout period. "
            "The server may be overloaded. Retry to try again."
        )
        desc_html = (
            f"{html.escape(disp_prov)}/{html.escape(disp_model)} sent no response within the timeout period. "
            "The server may be overloaded. Click Retry to try again."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="retry-turn" title="Retry this turn">'
            f'{icon_retry}Retry Turn</button>'
            f'<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to another model">'
            f'{icon_model}Switch Model</button>'
        )
        actions_tui = [
            "Type /retry to re-send this turn",
            "Press Ctrl+M to switch to another model",
        ]
    else:
        err_type = "generic"
        badge = "ERROR"
        title = f"Turn Interrupted ({err_cls})"
        first_line = msg.splitlines()[0] if msg else err_cls
        if len(first_line) > 140:
            first_line = first_line[:137] + "..."
        desc_text = (
            f"An error interrupted communication with {disp_prov}: {first_line}. "
            "Retry to re-send this turn."
        )
        desc_html = (
            f"An error interrupted communication with <strong>{html.escape(disp_prov)}</strong>: {html.escape(first_line)}. "
            "Click Retry to re-send this turn."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="retry-turn" title="Retry this turn">'
            f'{icon_retry}Retry Turn</button>'
        )
        actions_tui = [
            "Type /retry to re-send this turn",
        ]

    clean_msg = re.sub(r'\bof \d+ (?:requests|turns)\b', '', msg)
    raw_preview = clean_msg[:500] + ("..." if len(clean_msg) > 500 else "")

    return {
        "type": err_type,
        "badge": badge,
        "title": title,
        "desc_text": desc_text,
        "desc_html": desc_html,
        "timer_text": timer_text,
        "timer_html": timer_html,
        "actions_html": actions_html,
        "actions_tui": actions_tui,
        "raw_preview": raw_preview,
        "err_cls": err_cls,
    }


def format_error_html(info: dict) -> str:
    """Format classified error as an interactive HTML card for webviews (e.g. VS Code extension)."""
    import html
    icon_alert = '<span class="error-header-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>'

    details_block = ""
    if info["type"] != "quota_exceeded" and info.get("raw_preview"):
        raw_esc = html.escape(info["raw_preview"])
        details_block = (
            f'  <details class="error-details">\n'
            f'    <summary>Technical Details ({info["err_cls"]})</summary>\n'
            f'    <pre class="error-code"><code>{raw_esc}</code></pre>\n'
            f'  </details>\n'
        )

    return (
        f'\n<div class="andromity-error-card" data-error-type="{info["type"]}" data-retryable="true">\n'
        f'  <div class="error-card-header">\n'
        f'    <div class="error-header-left">\n'
        f'      {icon_alert}\n'
        f'      <span class="error-badge">{info["badge"]}</span>\n'
        f'      <span class="error-title">{info["title"]}</span>\n'
        f'    </div>\n'
        f'  </div>\n'
        f'  <div class="error-card-body">{info["desc_html"]}</div>\n'
        f'{details_block}'
        f'  <div class="error-card-actions">\n'
        f'    {info["actions_html"]}\n'
        f'  </div>\n'
        f'</div>\n'
    )


def format_error_terminal(info: dict) -> str:
    """Format classified error as clean, beautiful Markdown blockquotes for terminal TUI and CLI.

    Zero HTML tags, zero raw <button> or <svg> elements.
    """
    badge = info["badge"]
    title = info["title"]
    desc = info["desc_text"]
    timer = info.get("timer_text", "")
    actions = info.get("actions_tui", [])
    raw_preview = info.get("raw_preview", "")
    err_cls = info.get("err_cls", "")
    err_type = info.get("type", "")

    lines = [
        f"> **[{badge}] {title}**",
        ">",
        f"> {desc}",
    ]
    if timer:
        lines.extend([
            ">",
            f"> ⏱ **{timer}**",
        ])
    if actions:
        lines.extend([
            ">",
            "> **Actions:**",
        ])
        for act in actions:
            lines.append(f"> • {act}")

    if err_type != "quota_exceeded" and raw_preview:
        clean_prev = raw_preview.replace("\n", " ")[:200]
        lines.extend([
            ">",
            f"> *Details ({err_cls}): {clean_prev}*",
        ])

    return "\n" + "\n".join(lines) + "\n"


def classify_and_format_error(
    e: Exception,
    provider: str = "",
    model: str = "",
    has_images: bool = False,
    output_format: str = "auto",
) -> str:
    """Classify an LLM/gateway error and format it for the appropriate frontend.

    - Under VS Code server (ANDROMITY_CLIENT="server") or pytest: outputs HTML card.
    - Under TUI or CLI: outputs clean, tag-free terminal Markdown.
    """
    import os

    info = classify_error_info(e, provider=provider, model=model, has_images=has_images)

    if output_format == "html":
        return format_error_html(info)
    if output_format in ("terminal", "text", "markdown", "cli"):
        return format_error_terminal(info)

    # Auto-detection:
    # VS Code daemon or pytest expects HTML cards
    if os.environ.get("ANDROMITY_CLIENT") == "server" or os.environ.get("PYTEST_CURRENT_TEST"):
        return format_error_html(info)

    # TUI, CLI, and standalone callers receive terminal markdown
    return format_error_terminal(info)


def _format_error_text(e: Exception) -> str:
    return classify_and_format_error(e)


def _handle_rate_limit(e: Exception) -> TextDelta:
    return TextDelta(text=classify_and_format_error(e))


