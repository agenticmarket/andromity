import asyncio
import json
import os
import re
from pathlib import Path
from typing import AsyncGenerator, List, Dict, Any, Iterable, Optional

from andromity.config import config
from andromity.core.debug_log import get_logger
from andromity.core.events import (
    StreamEvent, TextDelta, ThinkingDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done
)

log = get_logger("provider")

# OpenRouter groups requests into one app by HTTP-Referer. These must match the
# gateway (gateway-worker OPENROUTER_APP_HEADERS) so BYOK and gateway traffic share one app.
OPENROUTER_APP_HEADERS = {
    "HTTP-Referer": "https://andromity.agenticmarket.dev",
    "X-Title": "Andromity",
    "X-OpenRouter-Title": "Andromity",
}


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
    5. Drops assistant messages with neither text nor tool_calls. Sent last they read as a
       prefill, which newer Anthropic models reject; anywhere else providers reject empty content.
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
                content = msg.get("content")
                is_empty = content is None or (isinstance(content, str) and not content.strip()) or content == []
                if is_empty:
                    i += 1
                    continue
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
    retry: bool = True,
    max_tokens: Optional[int] = None,
    least_reasoning: bool = False,
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
    from andromity.core.connections import provider_request
    resolved = provider_request(provider_name, model)
    litellm_model = resolved["model"]
    base_url = resolved.get("api_base")
    _num_ctx = 0
    if litellm_model.startswith(("ollama/", "ollama_chat/")):
        from andromity.core.models import get_ollama_num_ctx
        _num_ctx = get_ollama_num_ctx(model, base_url or "http://localhost:11434")
    kwargs = {
        **resolved,
        "messages": sanitized_messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if tools:
        kwargs["tools"] = tools

    # Custom kwargs per provider
    if _num_ctx:
        kwargs.setdefault("options", {})["num_ctx"] = _num_ctx

    if provider_name == "andromity":
        from andromity.core.client_identity import gateway_client_id
        try:
            from andromity import __version__ as _pkg_ver
        except Exception:
            _pkg_ver = "0.2.15"
        andromity_headers = {
            "User-Agent": "Andromity",
            "x-andromity-client-id": gateway_client_id(),
            "x-andromity-version": _pkg_ver,
        }
        if turn_id:
            andromity_headers["x-andromity-turn-id"] = turn_id
        kwargs["extra_headers"] = andromity_headers

    # OpenRouter: send app identity headers so the dashboard shows "Andromity"
    # instead of "litellm". See https://openrouter.ai/docs#provider-routing
    if provider_name == "openrouter":
        client_env = (os.environ.get("ANDROMITY_CLIENT") or "").lower()
        is_vscode = client_env in ("server", "vscode") or bool(os.environ.get("VSCODE_PID"))
        categories = "ide-extension,cli-agent" if is_vscode else "cli-agent,ide-extension"

        kwargs["extra_headers"] = {
            "User-Agent": "Andromity",
            **OPENROUTER_APP_HEADERS,
            "X-OpenRouter-Categories": categories,
        }
        # Enable provider fallbacks so overloaded endpoints do not stall in queue
        kwargs.setdefault("extra_body", {})
        kwargs["extra_body"].setdefault("provider", {})
        kwargs["extra_body"]["provider"]["allow_fallbacks"] = True

    if provider_name == "opencode":
        kwargs["extra_headers"] = {"User-Agent": "Andromity"}

    log.info("stream_completion start: provider=%s model=%s litellm_model=%s",
             provider_name, model, litellm_model)

    from andromity.core.reasoning import (
        apply_reasoning_to_request, discover_model_reasoning_capability,
    )
    capability = await asyncio.to_thread(discover_model_reasoning_capability, provider_name, model)
    if least_reasoning:
        efforts = getattr(capability, "supported_efforts", None) or []
        reasoning_effort = next((e for e in ("off", "none", "minimal", "low") if e in efforts), "auto")
    apply_reasoning_to_request(provider_name, model, reasoning_effort, kwargs, capability)
    if max_tokens:
        kwargs.setdefault("max_tokens", int(max_tokens))

    # Upstream retry with backoff for stalls, rate limits, and transient drops
    backoff = list(STREAM_BACKOFF_DELAYS) if retry else []
    total_attempts = len(backoff) + 1

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
                is_auth_error = (
                    isinstance(e, (litellm.AuthenticationError, litellm.PermissionDeniedError))
                    or has_status_code(msg, "401") or has_status_code(msg, "403")
                    or any(k in msg for k in (
                        "missing credentials", "please pass an `api_key`", "please pass an api_key",
                        "invalid api key", "invalid_api_key", "unauthorized", "forbidden",
                        "no api key", "missing api key"
                    ))
                )
                is_bad_request = (
                    isinstance(e, (litellm.BadRequestError, litellm.NotFoundError, litellm.ContextWindowExceededError, litellm.UnsupportedParamsError))
                    or any(k in msg for k in (
                        "context_length_exceeded", "maximum context length", "model not found", "does not exist"
                    ))
                )

                if is_daily_quota or is_auth_error or is_bad_request or gateway_model_unavailable(e) or gateway_wait_is_long(e):
                    log.info("Non-retryable provider error: %s (HTTP %s).", type(e).__name__, getattr(e, "status_code", "unknown"))
                    yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
                    yield Done(outcome="error", error_type=classify_error_info(e, provider=provider_name, model=model, has_images=has_images)["type"],
                               error_detail=short_error_detail(e, secrets=(resolved.get("api_key"),)), error_status=http_status(e))
                    return

                is_429 = has_status_code(msg, "429") or "rate limit" in msg or "ratelimit" in msg or "quota" in msg
                if attempt < len(backoff):
                    wait_s = backoff[attempt]
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
                    log.error("Provider call failed after %d attempts: %s (HTTP %s).", total_attempts, type(e).__name__, getattr(e, "status_code", "unknown"))
                    yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
                    yield Done(outcome="error", error_type=classify_error_info(e, provider=provider_name, model=model, has_images=has_images)["type"],
                               error_detail=short_error_detail(e, secrets=(resolved.get("api_key"),)), error_status=http_status(e))
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

            msg = str(e).lower()
            is_non_retryable = (
                isinstance(e, (
                    litellm.AuthenticationError,
                    litellm.PermissionDeniedError,
                    litellm.BadRequestError,
                    litellm.NotFoundError,
                    litellm.ContextWindowExceededError,
                    litellm.UnsupportedParamsError,
                ))
                or any(k in msg for k in (
                    "missing credentials", "please pass an `api_key`", "please pass an api_key",
                    "invalid api key", "invalid_api_key", "unauthorized", "401", "forbidden", "403",
                    "no api key", "missing api key",
                    "daily_limit_reached", "quota_exceeded", "free trial requests", "daily limit",
                    "context_length_exceeded", "maximum context length", "model not found"
                ))
            )

            # If stalled or failed BEFORE emitting any tokens, retry with backoff ONLY for transient errors
            if not has_emitted_content and not is_non_retryable and attempt < len(backoff):
                wait_s = backoff[attempt]
                log.warning(
                    "Upstream stalled or failed before emitting tokens (%s). Retrying in %.0fs (attempt %d/%d)...",
                    type(e).__name__, wait_s, attempt + 1, total_attempts
                )
                await asyncio.sleep(wait_s)
                continue

            log.error("Provider stream error: %s (HTTP %s).", type(e).__name__, getattr(e, "status_code", "unknown"))
            if isinstance(e, ProviderStalledError):
                yield TextDelta(text=_format_stall_text(provider_name, model, e.timeout))
            else:
                yield TextDelta(text=classify_and_format_error(e, provider=provider_name, model=model, has_images=has_images))
            yield Done(usage=usage, outcome="error", error_type=classify_error_info(e, provider=provider_name, model=model, has_images=has_images)["type"],
                       error_detail=None if isinstance(e, ProviderStalledError) else short_error_detail(e, secrets=(resolved.get("api_key"),)),
                       error_status=http_status(e))
            return


def extract_clean_error_message(err_or_text: Any) -> str:
    """Extract a user-friendly error message from raw LiteLLM/provider exception strings.
    Strips raw python exception prefixes, extracts JSON error messages, and removes internal IDs."""
    import json
    import re

    raw = str(err_or_text) if err_or_text is not None else ""
    if not raw:
        return ""
    if re.search(r"<(?:!doctype\s+html|html\b|head\b|body\b)", raw, re.IGNORECASE):
        return "The endpoint returned a web page instead of an API response. Check the provider base URL."

    # 1. Look for embedded JSON error payload (e.g. {"error": {"message": "..."}})
    json_match = re.search(r'(\{[\s\S]*\})', raw)
    if json_match:
        try:
            data = json.loads(json_match.group(1))
            if isinstance(data, dict):
                err_val = data.get("error")
                if isinstance(err_val, dict) and err_val.get("message"):
                    return str(err_val["message"]).strip()
                elif isinstance(err_val, str) and err_val.strip():
                    return err_val.strip()
                elif data.get("message") and isinstance(data["message"], str):
                    return data["message"].strip()
                elif data.get("detail") and isinstance(data["detail"], str):
                    return data["detail"].strip()
        except Exception:
            pass

    # 2. Strip leading LiteLLM / Provider exception boilerplate
    cleaned = raw.strip()
    cleaned = re.sub(r'^(?:litellm\.)?\w*(?:Error|Exception):\s*', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'^(?:litellm\.)?\w*(?:Error|Exception):\s*', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'^\w+Exception\s*[-:]\s*', '', cleaned, flags=re.IGNORECASE)

    # 3. Strip trailing raw JSON or user_id dumps
    cleaned = re.sub(r'\{[\s\S]*\}', '', cleaned).strip()
    cleaned = re.sub(r'["\']user_id["\']\s*:\s*["\'][^"\']+["\']', '', cleaned, flags=re.IGNORECASE).strip()

    # 4. Strip leftover punctuation
    cleaned = cleaned.lstrip('- :').strip()

    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    if lines:
        return lines[0]
    return raw.strip()


_CREDENTIAL_TEXT = re.compile(
    r"\bbearer\s+\S+"
    r"|\b(?:api[_-]?key|access[_-]?token|key|token|secret|password)=[^\s&\"',;]+"
    r"|\b(?:sk|pk|rk|gsk|xai|nvapi)[-_][A-Za-z0-9_\-]{8,}"
    r"|\bAIza[0-9A-Za-z_\-]{20,}"
    r"|\beyJ[A-Za-z0-9_\-]{10,}(?:\.[A-Za-z0-9_\-]+){1,2}"
    r"|\b(?=[A-Za-z_]*\d)[A-Za-z0-9_]{24,}\b"
    r"|\*{3,}[A-Za-z0-9]{2,8}",
    re.IGNORECASE,
)
# No square brackets: the terminal app reads them as markup.
REDACTED = "•••"


def redact_credentials(text: str, secrets: Iterable[Optional[str]] = ()) -> str:
    """Remove the given secrets, any token that starts like one of them, and credential-like tokens."""
    text = text or ""
    for secret in secrets:
        if not isinstance(secret, str) or len(secret) < 6:
            continue
        if len(secret) >= 8:
            text = re.sub(re.escape(secret[:8]) + r"\S*", REDACTED, text)
        else:
            text = text.replace(secret, REDACTED)
    return _CREDENTIAL_TEXT.sub(REDACTED, text)


def short_error_detail(e: BaseException, limit: int = 160, secrets: Iterable[Optional[str]] = ()) -> str:
    """One line of the provider's own error text, without markup or credentials. Redacts before it truncates."""
    text = redact_credentials(" ".join(extract_clean_error_message(e).split()), secrets)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def http_status(e: BaseException) -> Optional[int]:
    """The HTTP status a provider answered with, when the error carries one."""
    status = getattr(e, "status_code", None)
    return status if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599 else None


def gateway_error(e: Exception, *types: str) -> Optional[Dict[str, Any]]:
    """The structured error the Andromity gateway sends, when its type is one of `types`.

    LiteLLM keeps only the message text and the response headers of a failed call, so the type,
    action and wait come from the gateway's headers; a raw JSON body is read when one is present.
    """
    match = re.search(r'(\{[\s\S]*\})', str(e) or "")
    if match:
        try:
            error = json.loads(match.group(1)).get("error")
        except (ValueError, AttributeError):
            error = None
        if isinstance(error, dict) and error.get("type") in types:
            return error
    raw_headers = getattr(e, "litellm_response_headers", None) or getattr(getattr(e, "response", None), "headers", None)
    try:
        headers = {str(k).lower(): str(v) for k, v in dict(raw_headers or {}).items()}
    except (TypeError, ValueError):
        return None
    error_type = headers.get("x-andromity-error-type")
    if error_type not in types:
        return None
    error = {"type": error_type, "message": extract_clean_error_message(e)}
    if headers.get("x-andromity-error-action"):
        error["action"] = headers["x-andromity-error-action"]
    if headers.get("retry-after", "").strip().isdigit():
        error["retry_after"] = int(headers["retry-after"].strip())
    return error


def gateway_model_unavailable(e: Exception) -> Optional[Dict[str, Any]]:
    return gateway_error(e, "model_unavailable")


def gateway_capacity_error(e: Exception, provider: str = "") -> Optional[Dict[str, Any]]:
    """Shared capacity is exhausted or unavailable. The gateway writes these messages for users."""
    error = gateway_error(e, "service_busy")
    if error is None and provider == "andromity":
        error = gateway_error(e, "service_unavailable")
    if error is None or not isinstance(error.get("message"), str) or not error["message"].strip():
        return None
    return error


def gateway_wait_is_long(e: Exception) -> bool:
    """Retrying in a few seconds cannot help when the gateway says capacity returns much later."""
    error = gateway_error(e, "service_busy")
    if not error:
        return False
    wait = error.get("retry_after")
    return error.get("action") == "switch_model" or (isinstance(wait, (int, float)) and wait > 60)


def _timer_badge_html(text: str) -> str:
    import html
    return (
        '<div class="error-card-timer" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-family:var(--font-mono,monospace);color:#10b981;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.22);padding:3px 9px;border-radius:4px;margin-top:8px;">'
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>'
        f'{html.escape(text)}'
        '</div>'
    )


# Cards whose explanation is complete without the underlying exception text.
QUIET_ERROR_TYPES = {"quota_exceeded", "service_busy", "service_unavailable"}


def has_status_code(text: str, code: str) -> bool:
    """An HTTP status as a whole number; request IDs and timestamps often contain "404" or "500"."""
    return re.search(rf"(?<!\d){re.escape(code)}(?!\d)", text or "") is not None


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
    clean_msg = extract_clean_error_message(e)
    is_html = bool(re.search(r"<(?:!doctype\s+html|html\b|head\b|body\b)", msg, re.IGNORECASE))

    def has_code(*codes: str) -> bool:
        return any(has_status_code(msg, code) for code in codes)

    disp_model = model or "the selected model"
    disp_prov = (provider or "AI provider").capitalize()

    is_vision = (
        has_images
        or any(k in low for k in ("image", "vision", "multimodal", "modality", "does not support image"))
    ) and (any(k in low for k in ("image", "vision", "multimodal", "modality", "support", "payload")) or has_code("400"))

    is_not_found = (
        getattr(e, "status_code", None) == 404
        or err_cls == "NotFoundError"
        or "notfound" in low
        or "not found" in low
        or "no endpoints found" in low
        or "model_not_found" in low
        or "does not exist" in low
        or (has_code("404") and ("model" in low or "endpoint" in low or "not found" in low))
    )

    is_rate = (
        getattr(e, "status_code", None) == 429
        or has_code("429")
        or "rate limit" in low
        or "ratelimit" in low
        or "quota" in low
        or "daily_limit" in low
        or "daily limit" in low
        or "free trial" in low
    )
    is_upstream = getattr(e, "status_code", None) in (500, 502, 503, 504) or has_code("500", "502", "503", "504") or any(k in low for k in (
        "midstreamfallbackerror", "serviceunavailable", "service_unavailable", "service unavailable",
        "bad gateway", "gateway timeout",
        "upstream error", "apiconnectionerror", "connection reset", "broken pipe"
    ))
    is_context = any(k in low for k in ("context length", "maximum context", "token limit", "context_length_exceeded", "prompt is too long", "context window"))
    is_auth = getattr(e, "status_code", None) in (401, 403) or err_cls in ("AuthenticationError", "PermissionDeniedError") or has_code("401", "403") or any(k in low for k in (
        "unauthorized", "invalid api key", "authentication error",
        "invalid_api_key", "forbidden", "missing credentials", "please pass an `api_key`",
        "please pass an api_key", "no api key", "missing api key"
    ))
    is_ollama_off = ("connection refused" in low or "failed to connect" in low) and ("11434" in low or provider == "ollama")
    is_stall = err_cls in ("TimeoutError", "Timeout", "ProviderStalledError") or any(k in low for k in ("stalled", "watchdog", "first token", "timed out"))

    icon_retry = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>'
    icon_model = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>'
    icon_compact = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>'
    icon_plus = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>'
    icon_settings = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'
    icon_account = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>'

    timer_text = ""
    timer_html = ""

    from andromity.core.network_policy import AirgapBlockedError, AirgapFeatureOff
    is_airgap = isinstance(e, (AirgapFeatureOff, AirgapBlockedError)) or "air-gap mode" in low
    unavailable = gateway_model_unavailable(e)
    capacity = gateway_capacity_error(e, provider)

    if is_airgap:
        err_type = "airgap"
        badge = "AIR-GAP MODE"
        title = "Blocked by Air-gap Mode"
        desc_text = clean_msg if "air-gap mode" in clean_msg.lower() else msg
        desc_html = html.escape(desc_text)
        actions_html = (
            f'<button class="btn-error-retry" data-action="open-model-hub" title="Pick a model that runs on this machine">'
            f'{icon_settings}Choose a local model</button>'
        )
        actions_tui = ["Press Ctrl+L and choose a local model, such as one served by Ollama"]
    elif unavailable:
        needs_sign_in = unavailable.get("action") == "sign_in"
        err_type = "model_unavailable"
        badge = "SIGN IN REQUIRED" if needs_sign_in else "MODEL UNAVAILABLE"
        title = "Sign in to use this model" if needs_sign_in else "Model Not Available"
        desc_text = clean_msg or "This model isn't available right now. Switch to another model."
        desc_html = html.escape(desc_text)
        switch_class = "btn-error-secondary" if needs_sign_in else "btn-error-retry"
        actions_html = (
            (
                f'<button class="btn-error-retry" data-action="open-account-login" title="Sign in with AgenticMarket">'
                f'{icon_account}Sign In</button>'
                if needs_sign_in else ""
            )
            + f'<button class="{switch_class}" data-action="switch-model-flyout" title="Choose another model">'
            f'{icon_model}Switch Model</button>'
        )
        actions_tui = (
            ["Sign in with AgenticMarket from the Andromity VS Code extension"] if needs_sign_in else []
        ) + ["Press Ctrl+L to switch model"]
    elif capacity:
        busy = capacity.get("type") == "service_busy"
        err_type = "service_busy" if busy else "service_unavailable"
        badge = "HIGH DEMAND" if busy else "UNAVAILABLE"
        title = "Andromity is busy right now" if busy else "Shared models are unavailable"
        desc_text = capacity["message"].strip()
        wait = capacity.get("retry_after")
        if isinstance(wait, (int, float)) and not isinstance(wait, bool) and 0 < wait <= 86400:
            if wait <= 90:
                timer_text = "Expected back in about a minute"
            else:
                back_at = datetime.now().astimezone() + timedelta(seconds=float(wait))
                timer_text = f"Expected back around {back_at.strftime('%H:%M')} your time"
            timer_html = _timer_badge_html(timer_text)
        desc_html = f"<div>{html.escape(desc_text)}</div>{timer_html}"
        retry_first = capacity.get("action") == "retry"
        retry_btn = (
            f'<button class="{"btn-error-retry" if retry_first else "btn-error-secondary"}" data-action="retry-turn" title="Try this turn again">'
            f'{icon_retry}Retry Turn</button>'
        )
        switch_btn = (
            f'<button class="{"btn-error-secondary" if retry_first else "btn-error-retry"}" data-action="switch-model-flyout" title="Choose another model">'
            f'{icon_model}Switch Model</button>'
        )
        own_key_btn = (
            f'<button class="btn-error-secondary" data-action="open-settings" title="Use your own API key">'
            f'{icon_settings}Use Your Own Key</button>'
        )
        actions_html = (retry_btn + switch_btn if retry_first else switch_btn + retry_btn) + own_key_btn
        actions_tui = (
            ["Wait a minute and type /retry", "Press Ctrl+L to switch model"] if retry_first
            else ["Press Ctrl+L to switch model", "Wait and type /retry later"]
        ) + ["Press Ctrl+E and add your own API key to skip shared limits"]
    elif is_html and is_not_found:
        err_type = "endpoint_not_found"
        badge = "INVALID ENDPOINT"
        title = "API Endpoint Not Found"
        desc_text = "The provider returned an HTML 404 page. Check the base URL in Settings; OpenAI-compatible connections use the API root (for example, https://your-provider/v1), without /chat/completions."
        desc_html = html.escape(desc_text)
        actions_html = (
            f'<button class="btn-error-retry" data-action="open-settings" title="Correct the provider base URL">'
            f'{icon_settings}Open Settings</button>'
        )
        actions_tui = ["Open Settings and correct the provider base URL"]
    elif is_vision:
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
            "Press Ctrl+L or type /model to switch to a vision model (e.g. Claude 3.7 Sonnet, GPT-4o)",
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
            "Press Ctrl+L to switch to another provider or model",
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
            timer_html = _timer_badge_html(timer_text)
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
                    "Press Ctrl+E to open Settings and add a BYOK key for unlimited usage",
                    "Press Ctrl+L to switch model",
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
                    f'<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to an alternate model">'
                    f'{icon_model}Switch Model</button>'
                )
                actions_tui = [
                    "Sign in with AgenticMarket from the Andromity VS Code extension",
                    "Press Ctrl+E to open Settings and add a BYOK key for unlimited usage",
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
                "Press Ctrl+L to switch model",
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
            f"Press Ctrl+E to open Settings and add a key for {disp_prov}",
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
            "Press Ctrl+L to switch to another model",
        ]
    elif is_not_found:
        err_type = "model_not_found"
        badge = "NOT FOUND"
        title = "Model Not Available"
        clean_detail = clean_msg or f"No endpoints found for {disp_model}."
        desc_text = (
            f"{disp_prov}: {clean_detail} Please switch to another model."
        )
        desc_html = (
            f"<strong>{html.escape(disp_prov)}</strong>: {html.escape(clean_detail)} Please switch to another model."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="switch-model-flyout" title="Switch to another model">'
            f'{icon_model}Switch Model</button>'
            f'<button class="btn-error-secondary" data-action="retry-turn" title="Retry this turn">'
            f'{icon_retry}Retry Turn</button>'
        )
        actions_tui = [
            "Press Ctrl+L to switch to another model",
            "Type /retry to re-send this turn",
        ]
    else:
        err_type = "generic"
        badge = "ERROR"
        title = "Turn Interrupted"
        user_err_msg = clean_msg or (msg.splitlines()[0] if msg else err_cls)
        if len(user_err_msg) > 180:
            user_err_msg = user_err_msg[:177] + "..."
        desc_text = (
            f"{disp_prov}: {user_err_msg}. Retry to re-send this turn."
        )
        desc_html = (
            f"<strong>{html.escape(disp_prov)}</strong>: {html.escape(user_err_msg)}. "
            "Click Retry to re-send this turn."
        )
        actions_html = (
            f'<button class="btn-error-retry" data-action="retry-turn" title="Retry this turn">'
            f'{icon_retry}Retry Turn</button>'
            f'<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to another model">'
            f'{icon_model}Switch Model</button>'
        )
        actions_tui = [
            "Press Ctrl+L to switch to another model",
        ]

    clean_msg_raw = re.sub(r'\bof \d+ (?:requests|turns)\b', '', msg)
    raw_preview = clean_msg_raw[:500] + ("..." if len(clean_msg_raw) > 500 else "")
    if is_html:
        raw_preview = "HTML response received instead of an API response."

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
    if info["type"] not in QUIET_ERROR_TYPES and info.get("raw_preview"):
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

    if err_type not in QUIET_ERROR_TYPES and raw_preview:
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
    info = classify_error_info(e, provider=provider, model=model, has_images=has_images)

    if output_format == "html":
        return format_error_html(info)
    if output_format in ("terminal", "text", "markdown", "cli"):
        return format_error_terminal(info)

    # Auto-detection:
    # VS Code daemon (ANDROMITY_CLIENT in "server", "vscode") or pytest expects HTML cards
    client_env = (os.environ.get("ANDROMITY_CLIENT") or "").lower()
    if client_env in ("server", "vscode") or os.environ.get("PYTEST_CURRENT_TEST"):
        return format_error_html(info)

    # TUI, CLI, and standalone callers receive terminal markdown
    return format_error_terminal(info)


def _format_error_text(e: Exception) -> str:
    return classify_and_format_error(e)


def _handle_rate_limit(e: Exception) -> TextDelta:
    return TextDelta(text=classify_and_format_error(e))


