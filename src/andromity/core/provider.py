import asyncio
import errno
import ipaddress
import json
import os
import re
import socket
import ssl
from pathlib import Path
from typing import AsyncGenerator, List, Dict, Any, Optional, Tuple
from urllib.parse import urlsplit

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
    """True for localhost and loopback addresses such as 127.0.0.1 and ::1."""
    if not base_url:
        return False
    try:
        host = (urlsplit(base_url if "//" in base_url else f"//{base_url}").hostname or "").lower()
    except ValueError:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


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
    apply_reasoning_to_request(provider_name, model, reasoning_effort, kwargs, capability)

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
                msg = str(e).lower()[:_MESSAGE_LIMIT]
                status = _http_status(_exception_chain(e))
                text_counts = status is None or status < 500
                is_daily_quota = text_counts and (
                    "daily_limit_reached" in msg
                    or "quota_exceeded" in msg
                    or "free trial requests" in msg
                    or "daily limit" in msg
                    or "upgrade_url" in msg
                    or "sign in with github" in msg
                )
                is_auth_error = (
                    isinstance(e, (litellm.AuthenticationError, litellm.PermissionDeniedError))
                    or (status is None and (has_status_code(msg, "401") or has_status_code(msg, "403")))
                    or text_counts and any(k in msg for k in (
                        "missing credentials", "please pass an `api_key`", "please pass an api_key",
                        "invalid api key", "invalid_api_key", "unauthorized", "forbidden",
                        "no api key", "missing api key"
                    ))
                )
                is_bad_request = (
                    isinstance(e, (litellm.BadRequestError, litellm.NotFoundError, litellm.ContextWindowExceededError, litellm.UnsupportedParamsError))
                    or _is_final_client_error(status)
                    or text_counts and any(k in msg for k in (
                        "context_length_exceeded", "maximum context length", "model not found", "does not exist"
                    ))
                )

                gateway_refused = provider_name == GATEWAY_PROVIDER and gateway_error(e, "quota_exceeded") is not None
                if (is_daily_quota or is_auth_error or is_bad_request or gateway_refused
                        or gateway_model_unavailable(e) or gateway_wait_is_long(e)):
                    log.info("Non-retryable provider error: %s (HTTP %s).", type(e).__name__, getattr(e, "status_code", "unknown"))
                    for event in _error_events(e, provider_name, model, has_images):
                        yield event
                    return

                is_429 = has_status_code(msg, "429") or "rate limit" in msg or "ratelimit" in msg or "quota" in msg
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
                    log.error("Provider call failed after %d attempts: %s (HTTP %s).", total_attempts, type(e).__name__, getattr(e, "status_code", "unknown"))
                    for event in _error_events(e, provider_name, model, has_images):
                        yield event
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

            msg = str(e).lower()[:_MESSAGE_LIMIT]
            status = _http_status(_exception_chain(e))
            is_non_retryable = (
                isinstance(e, (
                    litellm.AuthenticationError,
                    litellm.PermissionDeniedError,
                    litellm.BadRequestError,
                    litellm.NotFoundError,
                    litellm.ContextWindowExceededError,
                    litellm.UnsupportedParamsError,
                ))
                or _is_final_client_error(status)
                or (status is None and (has_status_code(msg, "401") or has_status_code(msg, "403")))
                or ((status is None or status < 500) and any(k in msg for k in (
                    "missing credentials", "please pass an `api_key`", "please pass an api_key",
                    "invalid api key", "invalid_api_key", "unauthorized", "forbidden",
                    "no api key", "missing api key",
                    "daily_limit_reached", "quota_exceeded", "free trial requests", "daily limit",
                    "context_length_exceeded", "maximum context length", "model not found"
                )))
                or (provider_name == GATEWAY_PROVIDER and gateway_error(e, "quota_exceeded") is not None)
            )

            # If stalled or failed BEFORE emitting any tokens, retry with backoff ONLY for transient errors
            if not has_emitted_content and not is_non_retryable and attempt < len(STREAM_BACKOFF_DELAYS):
                wait_s = STREAM_BACKOFF_DELAYS[attempt]
                log.warning(
                    "Upstream stalled or failed before emitting tokens (%s). Retrying in %.0fs (attempt %d/%d)...",
                    type(e).__name__, wait_s, attempt + 1, total_attempts
                )
                await asyncio.sleep(wait_s)
                continue

            log.error("Provider stream error: %s (HTTP %s).", type(e).__name__, getattr(e, "status_code", "unknown"))
            for event in _error_events(e, provider_name, model, has_images, usage):
                yield event
            return


def _is_final_client_error(status: Optional[int]) -> bool:
    """A 4xx other than 408 and 429 gets the same answer when the request is sent again."""
    return status is not None and 400 <= status <= 499 and status not in (408, 429)


def _error_events(e: Exception, provider_name: str, model: str, has_images: bool,
                  usage: Optional[Dict[str, Any]] = None) -> List[StreamEvent]:
    """The card for a failed call and the Done event that ends the turn with its error type."""
    info = classify_error_info(e, provider=provider_name, model=model, has_images=has_images)
    if isinstance(e, ProviderStalledError):
        text = _format_stall_text(provider_display_name(provider_name), model, e.timeout)
    else:
        text = format_error_for_client(info)
    return [TextDelta(text=text), Done(usage=usage, outcome="error", error_type=info["type"], error_detail=info["detail"])]


def extract_clean_error_message(err_or_text: Any) -> str:
    """Extract a user-friendly error message from raw LiteLLM/provider exception strings.
    Strips raw python exception prefixes, extracts JSON error messages, and removes internal IDs."""
    import json
    import re

    raw = (str(err_or_text) if err_or_text is not None else "")[:_MESSAGE_LIMIT]
    if not raw:
        return ""
    if re.search(r"<(?:!doctype\s+html|html\b|head\b|body\b)", raw, re.IGNORECASE):
        return "The endpoint returned a web page instead of an API response. Check the provider base URL."

    # 1. Look for embedded JSON error payload (e.g. {"error": {"message": "..."}}), from the first "{"
    # to the last "}". Index slicing keeps this linear on long messages with unbalanced braces.
    json_start, json_end = raw.find("{"), raw.rfind("}")
    if 0 <= json_start < json_end:
        try:
            data = json.loads(raw[json_start:json_end + 1])
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
    json_start, json_end = cleaned.find("{"), cleaned.rfind("}")
    if 0 <= json_start < json_end:
        cleaned = (cleaned[:json_start] + cleaned[json_end + 1:]).strip()
    cleaned = re.sub(r'["\']user_id["\']\s*:\s*["\'][^"\']+["\']', '', cleaned, flags=re.IGNORECASE).strip()

    # 4. Strip leftover punctuation
    cleaned = cleaned.lstrip('- :').strip()

    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    if lines:
        return lines[0]
    return raw.strip()


GATEWAY_PROVIDER = "andromity"
ERROR_SOURCES = ("gateway", "provider", "local", "network")
ERROR_KINDS = ("4xx", "429", "5xx", "timeout", "conn", "other")

# Cards whose explanation is complete without the underlying error text. Only the gateway's typed
# errors produce them, and the gateway writes its messages for users.
QUIET_ERROR_TYPES = {
    "quota_exceeded", "service_busy", "service_unavailable", "model_unavailable",
    "sign_in_invalid", "gateway_auth_error", "access_denied",
}

_LOCAL_PROVIDERS = frozenset({"ollama", "lmstudio", "llamacpp"})
_PROVIDER_NAMES = {"lmstudio": "LM Studio", "llamacpp": "llama.cpp", "opencode": "OpenCode", "vllm": "vLLM"}
_IDENTIFIER = re.compile(r"[a-z0-9_]{1,64}")
_HTML_PAGE = re.compile(r"<(?:!doctype\s+html|html\b|head\b|body\b)", re.IGNORECASE)
_EXCEPTION_PREFIX = re.compile(r"^(?:litellm\.)?\w+(?:Error|Exception)\s*[-:]\s*|^Message:\s*", re.IGNORECASE)
_SSL_CONTEXT_NOTE = re.compile(r" ?ssl:(?:<[^>]{0,200}>|\S{1,200})")
_DETAIL_LIMIT = 400
_MESSAGE_LIMIT = 20000
_PLACEHOLDER_KEYS = frozenset({"anonymous_trial", "not-required"})

_TIMEOUT_ERRORS = frozenset({
    "Timeout", "APITimeoutError", "ReadTimeout", "WriteTimeout", "PoolTimeout", "TimeoutException",
    "TimeoutError", "SocketTimeoutError", "ServerTimeoutError", "ProviderStalledError",
})
_HTTPX_NETWORK_ERRORS = frozenset({
    "ConnectError", "ConnectTimeout", "ReadError", "WriteError", "CloseError", "RemoteProtocolError",
    "NetworkError", "ProxyError", "UnsupportedProtocol",
})
_AIOHTTP_NETWORK_ERRORS = frozenset({
    "ServerDisconnectedError", "ClientOSError", "ClientConnectionResetError", "ClientProxyConnectionError",
    "ClientSSLError",
})

_NETWORK_PHRASES = (
    "connection error", "connection refused", "connection reset", "connection aborted", "failed to connect",
    "cannot connect to host", "could not connect", "unable to connect", "actively refused",
    "refused the network connection", "name or service not known", "nodename nor servname",
    "getaddrinfo failed", "name resolution", "network is unreachable", "no route to host", "broken pipe",
    "remote end closed connection", "server disconnected", "certificate verify failed", "ssl handshake",
)
_AUTH_PHRASES = (
    "unauthorized", "invalid api key", "invalid_api_key", "incorrect api key", "api key not valid",
    "api_key_invalid", "invalid x-api-key", "authentication error", "authenticationerror",
    "permission denied", "permissiondenied", "forbidden",
)
_MISSING_KEY_PHRASES = (
    "missing credentials", "please pass an `api_key`", "please pass an api_key", "no api key", "missing api key",
)
_CREDIT_PHRASES = (
    "insufficient_quota", "insufficient quota", "insufficient credit", "insufficient balance",
    "insufficient funds", "requires more credits", "credit balance is too low", "out of credits",
    "payment required",
)
_RATE_PHRASES = (
    "rate limit", "ratelimit", "rate_limit", "too many requests", "resource_exhausted",
    "resource has been exhausted", "quota", "throttl", "daily limit", "daily_limit",
)
_DAILY_PHRASES = ("per day", "per-day", "perday", "daily", "(rpd)", "(tpd)")
_CONTEXT_PHRASES = (
    "context length", "maximum context", "token limit", "context_length_exceeded", "prompt is too long",
    "context window", "contextwindowexceeded",
)
_NOT_FOUND_PHRASES = ("notfound", "not found", "no endpoints found", "model_not_found", "does not exist")
_OUTAGE_PHRASES = (
    "service unavailable", "serviceunavailable", "service_unavailable", "bad gateway", "badgateway",
    "gateway timeout", "overloaded", "upstream error", "internal server error", "temporarily unavailable",
)
_OUTAGE_TYPES = frozenset({"overloaded_error", "server_error", "api_error", "service_unavailable"})
_RATE_CODES = frozenset({
    "rate_limit", "rate_limit_error", "rate_limit_exceeded", "resource_exhausted", "quota_exceeded",
    "too_many_requests", "daily_limit_reached",
})
_CREDIT_CODES = frozenset({"insufficient_quota", "insufficient_credits", "insufficient_balance", "payment_required"})
_STALL_PHRASES = ("stalled", "watchdog", "first token", "timed out")
_GATEWAY_QUOTA_PHRASES = (
    "daily_limit_reached", "quota_exceeded", "free trial requests", "daily limit", "upgrade_url",
    "sign in with github",
)
_SIGN_IN_PHRASES = ("sign in", "sign-in", "signin", "log in", "login", "authentication token", "expired")
_GATEWAY_CONTEXT_CODES = ("prompt_too_large", "payload_too_large", "context_length_exceeded")

_SVG = (
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
    'stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;">{}</svg>'
)
_ICON_RETRY = _SVG.format('<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/>')
_ICONS = {
    "retry-turn": _ICON_RETRY,
    "retry-without-image": _ICON_RETRY,
    "switch-model-flyout": _SVG.format('<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>'),
    "trigger-compact": _SVG.format(
        '<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline>'
        '<line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line>'),
    "new-session": _SVG.format(
        '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>'),
    "open-settings": _SVG.format(
        '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 '
        '2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 '
        '19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 '
        '0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06'
        '.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 '
        '0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 '
        '0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>'),
    "open-account-login": _SVG.format(
        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>'),
    "use-without-sign-in": _SVG.format(
        '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline>'
        '<line x1="21" y1="12" x2="9" y2="12"></line>'),
}

_RETRY = ("retry-turn", "Retry Turn", "Retry this turn")
_SWITCH = ("switch-model-flyout", "Switch Model", "Choose another model")
_OWN_KEY = ("open-settings", "Use Your Own Key", "Use your own API key")
_CHECK_KEY = ("open-settings", "Check API Key", "Open API keys in Settings")
_SIGN_IN = ("open-account-login", "Sign In", "Sign in with AgenticMarket")
_TUI_RETRY = "Type /retry to re-send this turn"
_TUI_SWITCH = "Press Ctrl+L to switch model"
_TUI_OWN_KEY = "Press Ctrl+E and add your own API key to skip shared limits"


def _actions_html(*buttons: Tuple[str, str, str]) -> str:
    """Card buttons as (data-action, label, tooltip); the first one is the primary button."""
    import html
    return "".join(
        f'<button class="{"btn-error-retry" if index == 0 else "btn-error-secondary"}" data-action="{action}" '
        f'title="{html.escape(tooltip)}">{_ICONS[action]}{html.escape(label)}</button>'
        for index, (action, label, tooltip) in enumerate(buttons)
    )


def _sentence(text: str) -> str:
    return text[:1].upper() + text[1:]


def _provider_key(provider: str) -> str:
    return re.sub(r"[\s._-]+", "", (provider or "").strip().lower())


def _saved_connection(provider: str) -> Dict[str, Any]:
    try:
        saved = config.get_provider_config(provider)
    except Exception:
        return {}
    return saved if isinstance(saved, dict) else {}


def provider_display_name(provider: str) -> str:
    """How cards name a provider: the connection's own name, the preset's label, or its ID in title case."""
    provider = (provider or "").strip()
    if not provider:
        return "the provider"
    if provider.lower() == GATEWAY_PROVIDER:
        return "Andromity Cloud"
    label = str(_saved_connection(provider).get("display_name") or "").strip()
    if not label or label.lower() == provider.lower():
        from andromity.core.connections import PRESETS
        preset = PRESETS.get(provider.lower())
        label = preset[0] if preset else _PROVIDER_NAMES.get(_provider_key(provider), "")
    label = re.sub(r"\s*\([^)]*\)\s*$", "", label).strip()
    if not label:
        label = " ".join(part[:1].upper() + part[1:] for part in re.split(r"[\s_-]+", provider) if part)
    return label[:48]


def _is_local_provider(provider: str) -> bool:
    if _provider_key(provider) in _LOCAL_PROVIDERS:
        return True
    return _is_local_base_url(str(_saved_connection(provider).get("base_url") or ""))


def _server_address(provider: str) -> str:
    base_url = str(_saved_connection(provider).get("base_url") or "")
    if not base_url and _provider_key(provider) == "ollama":
        base_url = "http://localhost:11434"
    try:
        parts = urlsplit(base_url)
        host, port = parts.hostname, parts.port
    except ValueError:
        return ""
    if not host:
        return ""
    host = f"[{host}]" if ":" in host else host
    return f"{host}:{port}" if port else host


def _exception_chain(e: BaseException, limit: int = 8) -> List[BaseException]:
    """The error and the errors it was raised from, outermost first."""
    chain: List[BaseException] = []
    current: Optional[BaseException] = e
    while current is not None and len(chain) < limit and not any(current is seen for seen in chain):
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _as_status(value: Any) -> Optional[int]:
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 100 <= value <= 599 else None


def _http_status(chain: List[BaseException]) -> Optional[int]:
    """The status of the provider's reply, or None when no reply arrived.

    LiteLLM reports connection failures and its own internal errors as 500, and client read timeouts
    as 408, so those two count only when the reply itself is in the chain.
    """
    for exc in chain:
        bases = {cls.__name__ for cls in type(exc).__mro__}
        from_litellm = (type(exc).__module__ or "").startswith("litellm")
        if "HTTPStatusError" in bases or ("APIStatusError" in bases and not from_litellm):
            status = _as_status(getattr(exc, "status_code", None)) or _as_status(
                getattr(getattr(exc, "response", None), "status_code", None))
            if status:
                return status
    status = _as_status(getattr(chain[0], "status_code", None))
    if status in (408, 500) and (type(chain[0]).__module__ or "").startswith("litellm"):
        return None
    return status


def _response_headers(chain: List[BaseException]) -> Dict[str, str]:
    for exc in chain:
        for raw in (getattr(exc, "litellm_response_headers", None),
                    getattr(getattr(exc, "response", None), "headers", None)):
            try:
                headers = {str(k).lower(): str(v) for k, v in dict(raw or {}).items()}
            except (TypeError, ValueError):
                continue
            if headers:
                return headers
    return {}


def _json_error_in_text(text: str) -> Dict[str, Any]:
    """The first JSON error object written into an error message, or an empty dict."""
    decoder = json.JSONDecoder()
    text = text[:20000]
    start = text.find("{")
    for _attempt in range(16):
        if start == -1:
            break
        try:
            data, _end = decoder.raw_decode(text, start)
        except ValueError:
            data = None
        if isinstance(data, dict):
            error = data.get("error")
            if isinstance(error, dict):
                return error
            if isinstance(error, str) and error.strip():
                return {"message": error.strip()}
            if any(key in data for key in ("message", "type", "code", "detail")):
                return data
        start = text.find("{", start + 1)
    return {}


def _chain_body(chain: List[BaseException]) -> Dict[str, Any]:
    """The parsed error body an HTTP client kept on the exception, which LiteLLM's message leaves out."""
    for exc in chain:
        body = getattr(exc, "body", None)
        if isinstance(body, dict) and body:
            inner = body.get("error")
            return inner if isinstance(inner, dict) else body
    return {}


def _error_facts(e: BaseException) -> Dict[str, Any]:
    chain = _exception_chain(e)
    text = (str(e) or type(e).__name__)[:_MESSAGE_LIMIT]
    text_body = _json_error_in_text(text)
    return {
        "chain": chain,
        "text": text,
        "text_body": text_body,
        "body": text_body or _chain_body(chain),
        "headers": _response_headers(chain),
        "status": _http_status(chain),
    }


def _is_network_failure(chain: List[BaseException]) -> bool:
    """The request never got a reply: refused, reset, DNS, TLS or a dropped connection."""
    for exc in chain:
        if isinstance(exc, (ConnectionError, socket.gaierror, ssl.SSLError)):
            return True
        if isinstance(exc, OSError) and exc.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH):
            return True
        name = type(exc).__name__
        module = type(exc).__module__ or ""
        if module.startswith(("httpx", "httpcore")) and name in _HTTPX_NETWORK_ERRORS:
            return True
        if module.startswith("aiohttp") and (name.startswith("ClientConnector") or name in _AIOHTTP_NETWORK_ERRORS):
            return True
        if module.startswith("openai") and name == "APIConnectionError":
            return True
    return False


def _identifier(value: Any) -> Optional[str]:
    text = value.strip().lower() if isinstance(value, str) else ""
    return text if _IDENTIFIER.fullmatch(text) else None


def _gateway_details(e: BaseException, facts: Dict[str, Any]) -> Dict[str, Any]:
    """What the gateway said about a failed request: its typed headers first, then its JSON body."""
    headers, body = facts["headers"], facts["body"]
    message = body.get("message") if isinstance(body.get("message"), str) else ""
    retry_after = None
    header_wait = headers.get("retry-after", "").strip()
    body_wait = body.get("retry_after")
    if header_wait.isdigit():
        retry_after = int(header_wait)
    elif isinstance(body_wait, (int, float)) and not isinstance(body_wait, bool) and body_wait > 0:
        retry_after = int(body_wait)
    return {
        "type": _identifier(headers.get("x-andromity-error-type")) or _identifier(body.get("type")),
        "code": _identifier(body.get("code")),
        "action": _identifier(headers.get("x-andromity-error-action")) or _identifier(body.get("action")),
        "retry_after": retry_after,
        "message": message.strip() or extract_clean_error_message(e),
    }


def gateway_error(e: Exception, *types: str) -> Optional[Dict[str, Any]]:
    """The structured error the Andromity gateway sent, when its type is one of `types`.

    LiteLLM keeps only the message text and the response headers of a failed call, so the type,
    action and wait come from the gateway's headers, then from its JSON body when that is reachable.
    """
    facts = _error_facts(e)
    if facts["text_body"].get("type") in types:
        return dict(facts["text_body"])
    details = _gateway_details(e, facts)
    if details["type"] not in types:
        return None
    error: Dict[str, Any] = {"type": details["type"], "message": details["message"]}
    if details["action"]:
        error["action"] = details["action"]
    if details["retry_after"] is not None:
        error["retry_after"] = details["retry_after"]
    return error


def gateway_model_unavailable(e: Exception, provider: str = GATEWAY_PROVIDER) -> Optional[Dict[str, Any]]:
    return gateway_error(e, "model_unavailable") if provider == GATEWAY_PROVIDER else None


def gateway_capacity_error(e: Exception, provider: str = "") -> Optional[Dict[str, Any]]:
    """Shared capacity is exhausted or unavailable. The gateway writes these messages for users."""
    if provider != GATEWAY_PROVIDER:
        return None
    error = gateway_error(e, "service_busy", "service_unavailable")
    if error is None or not isinstance(error.get("message"), str) or not error["message"].strip():
        return None
    return error


def gateway_wait_is_long(e: Exception, provider: str = GATEWAY_PROVIDER) -> bool:
    """Retrying in a few seconds cannot help when the gateway says capacity returns much later."""
    error = gateway_error(e, "service_busy") if provider == GATEWAY_PROVIDER else None
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


def has_status_code(text: str, code: str) -> bool:
    """An HTTP status as a standalone number; request IDs and timestamps often contain "404" or "500"."""
    return re.search(rf"(?<![\w.-]){re.escape(code)}(?![\w-])", (text or "")[:_MESSAGE_LIMIT]) is not None


def redact_error_text(text: str, provider: str = "") -> str:
    """Error text with known key shapes, sign-in tokens and the connection's own key removed."""
    from andromity.telemetry import redact_secrets
    text = redact_secrets((text or "")[:_MESSAGE_LIMIT])
    try:
        key = config.get_api_key(provider) if provider and provider != GATEWAY_PROVIDER else None
    except Exception:
        key = None
    if isinstance(key, str) and len(key.strip()) >= 12 and key not in _PLACEHOLDER_KEYS:
        key = key.strip()
        text = text.replace(key, "[redacted]")
        text = re.sub(re.escape(key[:10]) + r"[^\s\"'<>]*", "[redacted]", text)
    return text


def _strip_exception_prefixes(text: str) -> str:
    text = (text or "").strip()
    for _attempt in range(8):
        stripped = _EXCEPTION_PREFIX.sub("", text, count=1).strip()
        if stripped == text:
            break
        text = stripped
    return text


def _retry_seconds(text: str, headers: Dict[str, str]) -> Optional[float]:
    seconds: Optional[float] = None
    header_wait = headers.get("retry-after", "").strip()
    if re.fullmatch(r"\d{1,6}(?:\.\d+)?", header_wait):
        seconds = float(header_wait)
    else:
        match = re.search(r"(?:retry|try again) in (\d{1,6}(?:\.\d+)?)\s*s\b", text, re.IGNORECASE)
        if match:
            seconds = float(match.group(1))
    return seconds if seconds and 0 < seconds <= 86400 else None


def _wait_phrase(seconds: float) -> str:
    if seconds < 120:
        return f"~{int(seconds)}s"
    if seconds < 7200:
        return f"~{round(seconds / 60)} min"
    return f"~{round(seconds / 3600)} h"


def _error_kind(status: Optional[int], network: bool, timed_out: bool) -> str:
    if network:
        return "conn"
    if timed_out:
        return "timeout"
    if status == 429:
        return "429"
    if status and 400 <= status <= 499:
        return "4xx"
    if status and 500 <= status <= 599:
        return "5xx"
    return "other"


def classify_error_info(
    e: Exception,
    provider: str = "",
    model: str = "",
    has_images: bool = False,
) -> dict:
    """Choose the card for a failed model call.

    For the built-in gateway the card follows the gateway's typed error, and only gateway cards talk
    about its limits and sign-in. Any other provider gets a card that names it, says in plain words
    what went wrong and shows the provider's own message, with secrets removed, as the details.
    """
    import html
    from datetime import datetime, timezone, timedelta
    from andromity.core.network_policy import AirgapBlockedError, AirgapFeatureOff

    facts = _error_facts(e)
    chain = facts["chain"]
    body = facts["body"]
    msg = facts["text"]
    low = msg.lower()
    status = facts["status"]
    names = {type(exc).__name__ for exc in chain}
    err_cls = type(e).__name__
    clean_msg = extract_clean_error_message(e)
    is_html = bool(_HTML_PAGE.search(msg))
    provider_id = (provider or "").strip().lower()
    gateway = provider_id == GATEWAY_PROVIDER
    local = not gateway and _is_local_provider(provider_id)
    name = provider_display_name(provider_id)
    name_html = html.escape(name)
    disp_model = model or "the selected model"

    def has_code(*codes: str) -> bool:
        return any(has_status_code(msg, code) for code in codes)

    def mentions(phrases: Tuple[str, ...]) -> bool:
        return any(phrase in low for phrase in phrases)

    is_vision = (
        has_images
        or any(k in low for k in ("image", "vision", "multimodal", "modality", "does not support image"))
    ) and (any(k in low for k in ("image", "vision", "multimodal", "modality", "support", "payload")) or has_code("400"))

    network = _is_network_failure(chain) or (status is None and mentions(_NETWORK_PHRASES))
    server_error = status is not None and status >= 500
    timed_out = not network and not server_error and (
        status == 408 or bool(names & _TIMEOUT_ERRORS) or mentions(_STALL_PHRASES))
    no_status = status is None
    client_error = status is not None and 400 <= status <= 499
    body_codes = (_identifier(body.get("type")), _identifier(body.get("code")))
    is_not_found = not server_error and (
        status == 404 or "NotFoundError" in names or mentions(_NOT_FOUND_PHRASES)
        or (no_status and has_code("404") and ("model" in low or "endpoint" in low))
    )
    is_auth = status in (401, 403) or (no_status and (
        bool(names & {"AuthenticationError", "PermissionDeniedError"}) or has_code("401", "403")
        or mentions(_AUTH_PHRASES) or mentions(_MISSING_KEY_PHRASES)
    )) or (status == 400 and (mentions(_AUTH_PHRASES) or mentions(_MISSING_KEY_PHRASES)))
    is_credits = not gateway and (
        status == 402 or bool(set(body_codes) & _CREDIT_CODES)
        or ((no_status or client_error) and mentions(_CREDIT_PHRASES))
    )
    is_rate = status == 429 or bool(set(body_codes) & _RATE_CODES) or (no_status and (
        "RateLimitError" in names or has_code("429") or mentions(_RATE_PHRASES)))
    is_context = not server_error and (mentions(_CONTEXT_PHRASES) or "ContextWindowExceededError" in names)
    is_outage = (status is not None and 500 <= status <= 504) or ((status is None or server_error) and (
        _identifier(body.get("type")) in _OUTAGE_TYPES
        or bool(names & {"ServiceUnavailableError", "BadGatewayError"}) or mentions(_OUTAGE_PHRASES)))

    body_message = body.get("message") if isinstance(body.get("message"), str) else ""
    if not body_message and isinstance(body.get("detail"), str):
        body_message = body["detail"]
    detail_text = body_message.strip() or _strip_exception_prefixes(clean_msg)
    if not detail_text:
        detail_text = msg.strip().splitlines()[0] if msg.strip() else err_cls
    detail_text = _SSL_CONTEXT_NOTE.sub("", re.sub(r"\bof \d+ (?:requests|turns)\b", "", detail_text[:4000]))
    detail_text = redact_error_text(detail_text, provider_id).strip()

    timer_text = ""
    timer_html = ""
    action: Optional[str] = None
    gateway_card: Optional[str] = None
    g_type: Optional[str] = None
    g_message = ""
    g_wait: Optional[int] = None
    is_airgap = isinstance(e, (AirgapFeatureOff, AirgapBlockedError)) or "air-gap mode" in low

    if gateway and not is_airgap:
        details = _gateway_details(e, facts)
        g_type, g_code = details["type"], details["code"]
        g_message, g_wait, action = details["message"], details["retry_after"], details["action"]
        if g_type in ("model_unavailable", "service_busy", "quota_exceeded", "access_denied"):
            gateway_card = g_type
        elif g_type == "service_unavailable":
            gateway_card = "trouble"
        elif g_type == "authentication_error":
            gateway_card = "gateway_auth" if g_code == "invalid_key" else "sign_in"
        elif not network:
            if g_type == "invalid_request_error" and g_code in _GATEWAY_CONTEXT_CODES:
                is_context = True
            elif server_error:
                gateway_card = "trouble"
            elif is_auth:
                if mentions(_SIGN_IN_PHRASES):
                    gateway_card = "sign_in"
                elif status == 403 and "blocked" in low:
                    gateway_card = "access_denied"
                else:
                    gateway_card = "gateway_auth"
            elif g_type is None and mentions(_GATEWAY_QUOTA_PHRASES) and (is_rate or status in (None, 429)):
                gateway_card = "quota_exceeded"
            elif is_outage:
                gateway_card = "trouble"
    typed_message = g_message.strip() if g_type and not is_html else ""

    if is_airgap:
        err_type = "airgap"
        badge = "AIR-GAP MODE"
        title = "Blocked by Air-gap Mode"
        desc_text = clean_msg if "air-gap mode" in clean_msg.lower() else msg
        desc_html = html.escape(desc_text)
        actions_html = (
            f'<button class="btn-error-retry" data-action="open-model-hub" title="Pick a model that runs on this machine">'
            f'{_ICONS["open-settings"]}Choose a local model</button>'
        )
        actions_tui = ["Press Ctrl+L and choose a local model, such as one served by Ollama"]
    elif gateway_card == "model_unavailable":
        needs_sign_in = action == "sign_in"
        err_type = "model_unavailable"
        badge = "SIGN IN REQUIRED" if needs_sign_in else "MODEL UNAVAILABLE"
        title = "Sign in to use this model" if needs_sign_in else "Model Not Available"
        desc_text = typed_message or "This model isn't available right now. Switch to another model."
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(*((_SIGN_IN, _SWITCH) if needs_sign_in else (_SWITCH,)))
        actions_tui = (
            ["Sign in with AgenticMarket from the Andromity VS Code extension"] if needs_sign_in else []
        ) + [_TUI_SWITCH]
    elif gateway_card in ("service_busy", "trouble"):
        busy = gateway_card == "service_busy"
        err_type = "service_busy" if busy else "service_unavailable"
        badge = "HIGH DEMAND" if busy else "UNAVAILABLE"
        title = "Andromity is busy right now" if busy else "Andromity Cloud is having trouble right now"
        desc_text = typed_message or "Try again in a moment."
        if isinstance(g_wait, int) and 0 < g_wait <= 86400:
            if g_wait <= 90:
                timer_text = "Expected back in about a minute"
            else:
                back_at = datetime.now().astimezone() + timedelta(seconds=float(g_wait))
                timer_text = f"Expected back around {back_at.strftime('%H:%M')} your time"
            timer_html = _timer_badge_html(timer_text)
        desc_html = f"<div>{html.escape(desc_text)}</div>{timer_html}"
        retry_first = action == "retry" if busy else action != "switch_model"
        actions_html = _actions_html(*((_RETRY, _SWITCH) if retry_first else (_SWITCH, _RETRY)), _OWN_KEY)
        actions_tui = (
            ["Wait a minute and type /retry", _TUI_SWITCH] if retry_first
            else [_TUI_SWITCH, "Wait and type /retry later"]
        ) + [_TUI_OWN_KEY]
    elif gateway_card == "quota_exceeded":
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
            actions_html = _actions_html(
                ("open-settings", "Open Settings", "Configure BYOK"),
                ("switch-model-flyout", "Switch Model", "Switch to an alternate model"),
            )
            actions_tui = [
                "Press Ctrl+E to open Settings and add a BYOK key for unlimited usage",
                _TUI_SWITCH,
            ]
        else:
            desc_text = (
                "You have reached your daily free trial limit. "
                "Sign in with your AgenticMarket account to activate your account, or add a BYOK key in Settings."
            )
            actions_html = _actions_html(
                _SIGN_IN,
                ("open-settings", "Open Settings", "Configure BYOK"),
                ("switch-model-flyout", "Switch Model", "Switch to an alternate model"),
            )
            actions_tui = [
                "Sign in with AgenticMarket from the Andromity VS Code extension",
                "Press Ctrl+E to open Settings and add a BYOK key for unlimited usage",
            ]
        desc_html = f"<div>{desc_text}</div>{timer_html}"
    elif gateway_card == "sign_in":
        err_type = "sign_in_invalid"
        badge = "SIGN IN REQUIRED"
        title = "Your Andromity sign-in isn't valid anymore"
        desc_text = "Sign in again, or keep using Andromity without signing in."
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(
            ("open-account-login", "Sign in again", "Sign in with AgenticMarket again"),
            ("use-without-sign-in", "Use without signing in", "Sign out and retry this turn without an account"),
        )
        actions_tui = [
            "Sign in again from the Andromity VS Code extension",
            "Or sign out there to keep using Andromity without an account, then type /retry",
        ]
    elif gateway_card == "gateway_auth":
        err_type = "gateway_auth_error"
        badge = "UNAVAILABLE"
        title = "Andromity Cloud couldn't verify this request"
        desc_text = "This is a problem on Andromity's side, not with your account or API key. Try again later."
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(_RETRY, _OWN_KEY)
        actions_tui = ["Try again later with /retry", _TUI_OWN_KEY]
    elif gateway_card == "access_denied":
        err_type = "access_denied"
        badge = "ACCESS DENIED"
        title = "Andromity Cloud blocked this request"
        desc_text = typed_message or "Requests from this network are blocked. Use your own API key or a local model instead."
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(_OWN_KEY, _SWITCH)
        actions_tui = ["Press Ctrl+E and add your own API key", "Press Ctrl+L to choose a local model"]
    elif is_html and is_not_found:
        err_type = "endpoint_not_found"
        badge = "INVALID ENDPOINT"
        title = "API Endpoint Not Found"
        desc_text = "The provider returned an HTML 404 page. Check the base URL in Settings; OpenAI-compatible connections use the API root (for example, https://your-provider/v1), without /chat/completions."
        desc_html = html.escape(desc_text)
        actions_html = (
            f'<button class="btn-error-retry" data-action="open-settings" title="Correct the provider base URL">'
            f'{_ICONS["open-settings"]}Open Settings</button>'
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
            f'{_ICON_RETRY}Retry without Image</button>'
            f'<button class="btn-error-secondary" data-action="switch-model-flyout" title="Choose a vision-capable model">'
            f'{_ICONS["switch-model-flyout"]}Switch Model</button>'
        )
        actions_tui = [
            "Retry prompt without image attachments",
            "Press Ctrl+L to switch to a vision model (e.g. Claude 3.7 Sonnet, GPT-4o)",
        ]
    elif network and local:
        err_type = "ollama_offline"
        badge = "OFFLINE"
        address = _server_address(provider_id)
        where = f" at {address}" if address else ""
        if _provider_key(provider_id) == "ollama":
            title = "Local Ollama Not Running"
            desc_text = f"Could not connect to local Ollama{where}. Make sure the Ollama service is running ('ollama serve')."
            desc_html = (
                f"Could not connect to local Ollama{html.escape(where)}. "
                "Make sure the Ollama service is running (<code>ollama serve</code>)."
            )
            actions_tui = ["Run 'ollama serve' in a terminal, then type /retry", _TUI_SWITCH]
        else:
            title = f"{name} isn't running"
            desc_text = f"Could not connect to {name}{where}. Start the local model server, then retry."
            desc_html = f"Could not connect to <strong>{name_html}</strong>{html.escape(where)}. Start the local model server, then retry."
            actions_tui = [f"Start {name}, then type /retry", _TUI_SWITCH]
        actions_html = _actions_html(_RETRY, _SWITCH)
    elif network:
        err_type = "network_error"
        badge = "CONNECTION"
        title = f"Couldn't reach {name}"
        checks = "your internet connection, VPN or proxy"
        if not gateway and _saved_connection(provider_id).get("base_url"):
            checks += ", and the connection's base URL in Settings"
        desc_text = f"Couldn't connect to {name}. Check {checks}, then retry."
        desc_html = f"Couldn't connect to <strong>{name_html}</strong>. Check {html.escape(checks)}, then retry."
        actions_html = _actions_html(_RETRY, _SWITCH)
        actions_tui = ["Check your connection, then type /retry", _TUI_SWITCH]
    elif is_auth:
        err_type = "auth_error"
        badge = "AUTHENTICATION"
        if mentions(_MISSING_KEY_PHRASES):
            title = f"No API key for {name}"
            desc_text = f"Add your API key for {name} under API keys in Settings."
        elif status == 403 or "PermissionDeniedError" in names:
            title = f"Request refused by {name}"
            desc_text = _sentence(
                f"{name} refused this request. Your key may not have access to {disp_model}. "
                "Check the key under API keys in Settings, or pick another model."
            )
        else:
            title = f"API key rejected by {name}"
            desc_text = _sentence(
                f"{name} didn't accept your API key. Check it under API keys in Settings; "
                "it may be mistyped, revoked or expired."
            )
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(_CHECK_KEY, _SWITCH)
        actions_tui = [f"Press Ctrl+E and check your API key for {name} under API keys", _TUI_SWITCH]
    elif is_credits:
        err_type = "insufficient_credits"
        badge = "CREDITS"
        title = f"Out of credits at {name}"
        desc_text = _sentence(
            f"{name} says your account doesn't have enough credits for this request. "
            "Add credits there, or pick another model."
        )
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(_SWITCH, _RETRY)
        actions_tui = [_TUI_SWITCH, f"Add credits at {name}, then type /retry"]
    elif is_rate:
        err_type = "rate_limit"
        badge = "RATE LIMIT"
        wait = g_wait or _retry_seconds(msg, facts["headers"])
        retry_hint = f" (wait {_wait_phrase(wait)})" if wait else ""
        if not gateway and mentions(_DAILY_PHRASES):
            title = f"Daily limit reached at {name}"
            desc_text = _sentence(
                f"{name} won't take more requests from your key until its daily limit resets{retry_hint}. "
                "Wait for the reset, add credits or upgrade your plan there, or pick another model."
            )
            actions_html = _actions_html(_SWITCH, _RETRY)
            actions_tui = [_TUI_SWITCH, "Type /retry once the limit resets"]
        else:
            title = f"Rate limit at {name}"
            desc_text = _sentence(
                f"{name} is limiting requests right now{retry_hint}. Wait a moment and retry, or pick another model."
            )
            actions_html = _actions_html(_RETRY, _SWITCH)
            actions_tui = ["Wait a moment and type /retry", _TUI_SWITCH]
        desc_html = html.escape(desc_text)
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
        actions_html = _actions_html(
            ("trigger-compact", "Compact Context", "Compact previous context"),
            ("new-session", "New Session", "Start a new session"),
        )
        actions_tui = [
            "Type /compact to summarize context",
            "Press Ctrl+N to start a fresh session",
        ]
    elif is_not_found:
        err_type = "model_not_found"
        badge = "NOT FOUND"
        title = "Model Not Available" if gateway else f"Model not found at {name}"
        model_label = f"'{model}'" if model else "this model"
        if local:
            desc_text = f"{name} doesn't have {model_label}. Download or load it there, or pick another model."
        elif gateway:
            desc_text = f"{name} doesn't offer {model_label}. Pick another model."
        else:
            desc_text = _sentence(f"{name} doesn't offer {model_label}, or your key can't use it. Pick another model.")
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(_SWITCH, _RETRY)
        actions_tui = [_TUI_SWITCH, _TUI_RETRY]
    elif timed_out:
        err_type = "timeout"
        badge = "TIMED OUT"
        title = f"Timed out waiting for {name}"
        desc_text = _sentence(
            f"{name} sent no response for {disp_model} in time. It may be overloaded. Retry, or pick another model."
        )
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(_RETRY, _SWITCH)
        actions_tui = [_TUI_RETRY, "Press Ctrl+L to switch to another model"]
    elif is_outage:
        err_type = "provider_unavailable"
        badge = "SERVICE DISRUPTED"
        title = f"Service disruption at {name}"
        code = f" (HTTP {status})" if server_error else ""
        desc_text = _sentence(
            f"{name} had a problem on its side{code}. This usually clears up quickly. "
            "Retry in a moment, or pick another model."
        )
        desc_html = html.escape(desc_text)
        actions_html = _actions_html(_RETRY, _SWITCH)
        actions_tui = [_TUI_RETRY, "Press Ctrl+L to switch to another provider or model"]
    else:
        err_type = "generic"
        badge = "ERROR"
        title = "Turn Interrupted"
        user_err_msg = detail_text or err_cls
        if len(user_err_msg) > 180:
            user_err_msg = user_err_msg[:177] + "..."
        user_err_msg = user_err_msg.rstrip(". ")
        desc_text = f"{_sentence(name)}: {user_err_msg}. Retry to re-send this turn."
        desc_html = (
            f"<strong>{html.escape(_sentence(name))}</strong>: {html.escape(user_err_msg)}. "
            "Click Retry to re-send this turn."
        )
        actions_html = _actions_html(_RETRY, _SWITCH)
        actions_tui = [_TUI_SWITCH]

    if is_html:
        raw_preview = "HTML response received instead of an API response."
    else:
        raw_preview = detail_text[:_DETAIL_LIMIT] + ("..." if len(detail_text) > _DETAIL_LIMIT else "")

    if network:
        source = "local" if local else "network"
    else:
        source = "gateway" if gateway else "local" if local else "provider"
    kind = _error_kind(status, network, timed_out)

    return {
        "type": err_type,
        "badge": badge,
        "title": title,
        "desc_text": redact_error_text(desc_text, provider_id),
        "desc_html": redact_error_text(desc_html, provider_id),
        "timer_text": timer_text,
        "timer_html": timer_html,
        "actions_html": actions_html,
        "actions_tui": actions_tui,
        "raw_preview": raw_preview,
        "err_cls": err_cls,
        "action": action,
        "source": source,
        "kind": kind,
        "detail": f"{source}_{kind}",
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

    action = _identifier(info.get("action"))
    action_attr = f' data-error-action="{action}"' if action else ""
    return (
        f'\n<div class="andromity-error-card" data-error-type="{info["type"]}"{action_attr} data-retryable="true">\n'
        f'  <div class="error-card-header">\n'
        f'    <div class="error-header-left">\n'
        f'      {icon_alert}\n'
        f'      <span class="error-badge">{html.escape(info["badge"], quote=False)}</span>\n'
        f'      <span class="error-title">{html.escape(info["title"], quote=False)}</span>\n'
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
    return format_error_for_client(info, output_format)


def format_error_for_client(info: dict, output_format: str = "auto") -> str:
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


