"""Provider connection metadata and common LiteLLM request routing."""
import logging
import re
import time
from typing import Any, Optional
from urllib.parse import urlsplit

from andromity.config import config
from andromity.core import network_policy
from andromity.core.airgap_guard import is_loopback_host


PRESETS = {
    "andromity": ("Andromity Auto", "https://agenticmarket.dev"),
    "openrouter": ("OpenRouter", "https://openrouter.ai/keys"),
    "anthropic": ("Anthropic", "https://console.anthropic.com/settings/keys"),
    "openai": ("OpenAI", "https://platform.openai.com/api-keys"),
    "google": ("Google Gemini", "https://aistudio.google.com/app/apikey"),
    "deepseek": ("DeepSeek", "https://platform.deepseek.com/api_keys"),
    "groq": ("Groq", "https://console.groq.com/keys"),
    "nvidia": ("NVIDIA NIM", "https://build.nvidia.com/"),
    "ollama": ("Ollama (Local)", "https://ollama.com"),
}
KEYLESS_PRESETS = frozenset({"andromity", "ollama"})


def portal_url(provider: str) -> str:
    return PRESETS.get(provider, ("", ""))[1]


def _is_loopback(url: str) -> bool:
    try:
        host = urlsplit(url).hostname if url else None
    except ValueError:
        return False
    return bool(host) and is_loopback_host(host)


def key_required(provider: str, saved: Optional[dict] = None) -> bool:
    """A built-in cloud connection that cannot work without its own API key."""
    if provider not in PRESETS or provider in KEYLESS_PRESETS:
        return False
    if saved is None:
        saved = config.get_provider_config(provider) or {}
    return not _is_loopback(_effective_base_url(provider, saved))


def normalize_base_url(base_url: str, adapter: str) -> str:
    """Accept a pasted Chat Completions endpoint as an OpenAI base URL."""
    base_url = base_url.strip().rstrip("/")
    parsed = urlsplit(base_url)
    if adapter == "openai" and not parsed.query and not parsed.fragment and parsed.path.endswith("/chat/completions"):
        return base_url[:-len("/chat/completions")]
    return base_url


def validate_base_url(base_url: str, adapter: str) -> str:
    base_url = base_url.strip().rstrip("/")
    parsed = urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise ValueError("Enter an HTTP or HTTPS base URL without embedded credentials, query parameters, or fragments.")
    return normalize_base_url(base_url, adapter)


def validate_connection(values: dict[str, Any]) -> dict[str, str]:
    connection_id = str(values.get("id") or values.get("name") or "").strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", connection_id):
        raise ValueError("Use a connection ID with letters, numbers, hyphens, or underscores.")
    adapter = str(values.get("type") or "openai").strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9_]*", adapter):
        raise ValueError("Enter a LiteLLM provider type, such as openai, anthropic, or azure.")
    base_url = str(values.get("base_url") or "").strip().rstrip("/")
    if base_url:
        base_url = validate_base_url(base_url, adapter)
    if connection_id not in PRESETS and adapter == "openai" and not base_url:
        raise ValueError("An OpenAI-compatible connection requires a base URL.")
    model = str(values.get("model") or "").strip()
    if connection_id not in PRESETS and not model:
        raise ValueError("Enter the model ID provided by your endpoint.")
    return {"name": connection_id, "display_name": str(values.get("display_name") or connection_id).strip(),
            "type": adapter, "base_url": base_url, "model": model,
            "api_version": str(values.get("api_version") or "").strip()}


def provider_info() -> list[dict[str, Any]]:
    configured = {p["name"]: p for p in config.list_providers() if p.get("name")}
    result = []
    for name in dict.fromkeys([*PRESETS, *configured]):
        saved = configured.get(name, {})
        label, portal = PRESETS.get(name, (name, ""))
        result.append({
            "id": name, "name": saved.get("display_name") or label,
            "type": saved.get("type") or name,
            "base_url": saved.get("base_url", ""), "model": saved.get("model", ""),
            "api_version": saved.get("api_version", ""), "custom": name not in PRESETS,
            "has_key": bool(config.get_api_key(name)) or name in KEYLESS_PRESETS,
            "key_required": key_required(name, saved),
            "portal": portal,
            "airgap_blocked": not network_policy.url_allowed(_effective_base_url(name, saved)),
        })
    return result


_DEFAULT_BASE_URLS = {
    "ollama": "http://localhost:11434", "andromity": "https://gateway.agenticmarket.dev/v1",
    "opencode": "https://opencode.ai/inference/openai/v1",
}


def _effective_base_url(provider: str, saved: dict) -> str:
    """The endpoint a connection talks to; empty means the provider's own cloud API."""
    return saved.get("base_url") or _DEFAULT_BASE_URLS.get(provider, "")


def provider_request(provider: str, model: str) -> dict[str, Any]:
    """Resolve a named connection without borrowing another connection's key."""
    saved = config.get_provider_config(provider) or {}
    adapter = saved.get("type") or provider
    adapter = {"google": "gemini", "nvidia": "nvidia_nim", "ollama": "ollama_chat",
               "andromity": "openai", "opencode": "openai"}.get(adapter, adapter)
    model = (model or saved.get("model") or ("auto" if provider == "andromity" else "")).lstrip("~")
    if not model:
        raise ValueError("Choose a model for this connection.")
    prefix = adapter + "/"
    routed_model = model if model.startswith(prefix) or (adapter == "ollama_chat" and model.startswith("ollama/")) else prefix + model
    base_url = _effective_base_url(provider, saved)
    network_policy.require_url(
        base_url, f"the {provider} connection",
        "Choose a local model (for example Ollama), or add your model server to the air-gap allowed hosts.")
    key = config.get_api_key(provider)
    if provider == "andromity" and not key:
        key = "anonymous_trial"
    if provider == "opencode" and not key:
        raise ValueError("Add your OpenCode API key to use this connection.")
    if adapter == "openai" and provider not in ("openai", "andromity") and not key:
        # LiteLLM otherwise reads OPENAI_API_KEY even for an unrelated endpoint.
        key = "not-required"
    request: dict[str, Any] = {"model": routed_model}
    if key:
        request["api_key"] = key
    if base_url:
        request["api_base"] = normalize_base_url(base_url, adapter)
    if saved.get("api_version"):
        request["api_version"] = saved["api_version"]
    if provider == "opencode":
        request["extra_headers"] = {"User-Agent": "Andromity"}
    return request


def probe_model_for(provider: str) -> str:
    """A model that belongs to this connection: its own model, else one from its live list or catalog."""
    from andromity.core.models import get_cached_live_models, get_models_for_provider

    saved = config.get_provider_config(provider) or {}
    own = saved.get("model")
    if isinstance(own, str) and own.strip():
        return own.strip()

    def ids(models: list) -> list[str]:
        return [m["id"] for m in models if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"].strip()]

    live = ids(get_cached_live_models(provider))
    catalog = ids(get_models_for_provider(provider))
    if live:
        available = set(live)
        return next((m for m in catalog if m in available), live[0])
    if catalog:
        return catalog[0]
    return "auto" if provider == "andromity" else ""


def _probe_detail(detail: Optional[str], provider: str, limit: int = 160) -> str:
    """Redacts the saved key before shortening, so a cut can never leave part of it behind."""
    from andromity.core.provider import redact_credentials
    text = redact_credentials(" ".join(str(detail or "").split()), (config.get_api_key(provider),))
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _probe_error_type(error_type: str, status: Optional[int]) -> str:
    """A real HTTP status decides first; provider text can quote unrelated numbers such as a 500 RPM limit."""
    if status in (401, 403):
        return "auth_error"
    if status == 429:
        return error_type if error_type == "quota_exceeded" else "rate_limit"
    if status == 404:
        return error_type if error_type == "endpoint_not_found" else "model_not_found"
    return error_type


async def test_connection(provider: str, model: str = "") -> dict[str, Any]:
    """An explicit, short streaming probe; no workspace content is sent.

    Built-in providers get a single attempt so a rate limit is reported rather than waited out.
    """
    from andromity.core.provider import classify_error_info, http_status, short_error_detail, stream_completion
    from andromity.core.events import Done, TextDelta
    preset = provider in PRESETS
    if preset and key_required(provider) and not config.get_api_key(provider):
        return connection_failure("no_key")
    model = model or probe_model_for(provider)
    if not model:
        return connection_failure("no_model")
    chunks: list[str] = []
    finished = False
    started = time.monotonic()
    try:
        async for event in stream_completion(
            [{"role": "user", "content": "Reply with OK."}], provider_name=provider,
            model=model, first_token_timeout=15, retry=not preset,
        ):
            if isinstance(event, TextDelta):
                chunks.append(event.text)
            elif isinstance(event, Done):
                if event.outcome != "success":
                    return connection_failure(_probe_error_type(event.error_type or "generic", event.error_status),
                                              _probe_detail(event.error_detail, provider), model)
                finished = True
    except Exception as exc:
        key = config.get_api_key(provider)
        return connection_failure(_probe_error_type(classify_error_info(exc, provider=provider, model=model)["type"], http_status(exc)),
                                  _probe_detail(short_error_detail(exc, limit=1000, secrets=(key,)), provider), model)
    if not finished:
        return connection_failure("incomplete_stream", model=model)
    if not chunks:
        return connection_failure("empty_response", model=model)
    return {"success": True, "message": "Connection ready.", "model": model,
            "latency_ms": max(1, round((time.monotonic() - started) * 1000))}


_FAILURE_MESSAGES = {
    "endpoint_not_found": "HTTP 404: the endpoint returned a web page. Use the API base URL (for example, https://your-provider/v1), without /chat/completions.",
    "model_not_found": "HTTP 404: the API endpoint or model was not found. Check the base URL and exact model ID from your provider.",
    "auth_error": "HTTP 401/403: authentication or access denied. Check the API key and provider account permissions.",
    "rate_limit": "The provider's rate limit or quota was reached. Check your allowance and retry later.",
    "quota_exceeded": "The provider's quota was reached. Check your allowance or billing settings.",
    "provider_unavailable": "The provider is unavailable. Check its service status and retry.",
    "timeout": "Connection timed out. Check that the endpoint is reachable and retry.",
    "ollama_offline": "Ollama is offline. Start Ollama and check the local endpoint.",
    "incomplete_stream": "The provider closed the stream before completing the response. Retry or check its streaming support.",
    "empty_response": "The provider returned no text. Check the model ID.",
    "no_key": "Add an API key for this provider first.",
    "no_model": "Choose a model for this connection.",
    "airgap": "Air-gap mode blocks this provider. Choose a local model or allow its host.",
}


def connection_failure(error_type: str, detail: str = "", model: str = "") -> dict[str, Any]:
    logging.getLogger("andromity.provider").warning("Connection test failed: %s", error_type)
    message = _FAILURE_MESSAGES.get(error_type) or (
        f"Connection failed: {detail}" if detail
        else "Connection failed. Check the endpoint, credentials, model ID, and provider type.")
    result: dict[str, Any] = {"success": False, "error_type": error_type, "message": message}
    if detail:
        result["detail"] = detail
    if model:
        result["model"] = model
    return result
