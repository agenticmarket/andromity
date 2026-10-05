"""Provider connection metadata and common LiteLLM request routing."""
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from andromity.config import config


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


def validate_connection(values: dict[str, Any]) -> dict[str, str]:
    connection_id = str(values.get("id") or values.get("name") or "").strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", connection_id):
        raise ValueError("Use a connection ID with letters, numbers, hyphens, or underscores.")
    adapter = str(values.get("type") or "openai").strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9_]*", adapter):
        raise ValueError("Enter a LiteLLM provider type, such as openai, anthropic, or azure.")
    base_url = str(values.get("base_url") or "").strip().rstrip("/")
    if base_url:
        parsed = urlsplit(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
            raise ValueError("Enter an HTTP or HTTPS base URL without embedded credentials, query parameters, or fragments.")
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
            "has_key": bool(config.get_api_key(name)) or name in ("andromity", "ollama"),
            "portal": portal,
        })
    return result


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
    base_url = saved.get("base_url") or {
        "ollama": "http://localhost:11434", "andromity": "https://gateway.agenticmarket.dev/v1",
        "opencode": "https://opencode.ai/inference/openai/v1",
    }.get(provider)
    key = config.get_api_key(provider)
    if provider == "andromity" and not key:
        key = "anonymous_trial"
    if provider == "opencode" and not key:
        try:
            auth = json.loads((Path.home() / ".local/share/opencode/auth.json").read_text(encoding="utf-8"))
            key = auth.get("opencode", {}).get("key") or auth.get("openrouter", {}).get("key")
        except (OSError, ValueError, TypeError):
            pass
    if adapter == "openai" and provider not in ("openai", "andromity", "opencode") and not key:
        # LiteLLM otherwise reads OPENAI_API_KEY even for an unrelated endpoint.
        key = "not-required"
    request: dict[str, Any] = {"model": routed_model}
    if key:
        request["api_key"] = key
    if base_url:
        request["api_base"] = base_url
    if saved.get("api_version"):
        request["api_version"] = saved["api_version"]
    if provider == "opencode":
        request["extra_headers"] = {"User-Agent": "Andromity"}
    return request


async def test_connection(provider: str, model: str = "") -> dict[str, Any]:
    """An explicit, short streaming probe; no workspace content is sent."""
    from andromity.core.provider import stream_completion
    from andromity.core.events import Done, TextDelta
    chunks = []
    async for event in stream_completion(
        [{"role": "user", "content": "Reply with OK."}], provider_name=provider,
        model=model or (config.get_provider_config(provider) or {}).get("model"), first_token_timeout=15,
    ):
        if isinstance(event, TextDelta):
            chunks.append(event.text)
        elif isinstance(event, Done):
            if event.outcome != "success":
                return {"success": False, "message": "Connection failed. Check the endpoint, credentials, model ID, and provider type."}
    return {"success": bool(chunks), "message": "Connection ready." if chunks else "The provider returned no text. Check the model ID."}
