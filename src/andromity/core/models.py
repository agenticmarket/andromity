"""Model catalog - available models per provider with descriptions."""
from pathlib import Path

MODEL_CATALOG = {
    "anthropic": {
        "name": "Anthropic",
        "requires_env": "ANTHROPIC_API_KEY",
        "models": [
            {"id": "claude-opus-5", "name": "Claude Opus 5", "desc": "Best for complex agentic coding & enterprise work", "context": "1M", "pricing": "$5/$25 per MTok"},
            {"id": "claude-sonnet-5", "name": "Claude Sonnet 5", "desc": "Best balance of speed & intelligence", "context": "1M", "pricing": "$3/$15 per MTok"},
            {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "desc": "Fastest, near-frontier intelligence", "context": "200K", "pricing": "$0.80/$4 per MTok"},
            {"id": "claude-opus-4-6", "name": "Claude Opus 4.6", "desc": "Previous gen flagship (still excellent)", "context": "1M", "pricing": "$5/$25 per MTok"},
            {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "desc": "Previous gen balanced (fast + capable)", "context": "1M", "pricing": "$3/$15 per MTok"},
        ],
    },
    "openai": {
        "name": "OpenAI",
        "requires_env": "OPENAI_API_KEY",
        "models": [
            {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "desc": "Most capable, best for complex tasks", "context": "128K", "pricing": "$10/$30 per MTok"},
            {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra", "desc": "Balanced performance & cost", "context": "128K", "pricing": "$2.50/$10 per MTok"},
            {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna", "desc": "Fastest & most affordable", "context": "128K", "pricing": "$0.50/$2 per MTok"},
            {"id": "gpt-5.4", "name": "GPT-5.4", "desc": "Previous gen flagship", "context": "128K", "pricing": "$5/$15 per MTok"},
            {"id": "gpt-5.4-mini", "name": "GPT-5.4 Mini", "desc": "Fast & cost-effective", "context": "128K", "pricing": "$0.40/$1.20 per MTok"},
            {"id": "gpt-4.1", "name": "GPT-4.1", "desc": "Solid general purpose", "context": "1M", "pricing": "$2/$8 per MTok"},
            {"id": "o3", "name": "o3", "desc": "Reasoning model", "context": "200K", "pricing": "$2/$8 per MTok"},
            {"id": "o4-mini", "name": "o4-mini", "desc": "Fast reasoning", "context": "200K", "pricing": "$1.10/$4.40 per MTok"},
        ],
    },
    "google": {
        "name": "Google (Gemini)",
        "requires_env": "GEMINI_API_KEY",
        "models": [
            {"id": "gemini-3.1-pro", "name": "Gemini 3.1 Pro", "desc": "Most intelligent, best for complex tasks", "context": "1M", "pricing": "$1.25/$5 per MTok"},
            {"id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash", "desc": "Frontier perf at fraction of cost", "context": "1M", "pricing": "$0.075/$0.30 per MTok"},
            {"id": "gemini-3.5-flash", "name": "Gemini 3.5 Flash", "desc": "Fast & efficient", "context": "1M", "pricing": "$0.075/$0.30 per MTok"},
            {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "desc": "Previous gen pro (still strong)", "context": "1M", "pricing": "$1.25/$5 per MTok"},
            {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "desc": "Previous gen flash (fast & cheap)", "context": "1M", "pricing": "$0.15/$0.60 per MTok"},
        ],
    },
    "ollama": {
        "name": "Ollama (Local)",
        "requires_env": None,
        "base_url": "http://localhost:11434",
        "models": [
            {"id": "llama3.1", "name": "Llama 3.1", "desc": "Best all-round (8B/70B/405B)", "context": "128K", "sizes": ["8b", "70b", "405b"]},
            {"id": "llama3.3", "name": "Llama 3.3", "desc": "Near-frontier 70B", "context": "128K", "sizes": ["70b"]},
            {"id": "qwen2.5", "name": "Qwen 2.5", "desc": "Multilingual, wide size range", "context": "128K", "sizes": ["0.5b", "1.5b", "3b", "7b", "14b", "32b", "72b"]},
            {"id": "qwen2.5-coder", "name": "Qwen 2.5 Coder", "desc": "Best for coding tasks", "context": "128K", "sizes": ["1.5b", "7b", "14b", "32b"]},
            {"id": "gemma3", "name": "Gemma 3", "desc": "Vision + text (Google)", "context": "128K", "sizes": ["1b", "4b", "12b", "27b"]},
            {"id": "mistral", "name": "Mistral", "desc": "Fast & reliable classic", "context": "32K", "sizes": ["7b"]},
            {"id": "phi4", "name": "Phi-4", "desc": "Reasoning in small model (14B)", "context": "16K", "sizes": ["14b"]},
            {"id": "deepseek-r1", "name": "DeepSeek-R1", "desc": "Step-by-step reasoning", "context": "128K", "sizes": ["1.5b", "7b", "8b", "14b", "32b", "70b"]},
            {"id": "codellama", "name": "Code Llama", "desc": "Code generation specialist", "context": "16K", "sizes": ["7b", "13b", "34b", "70b"]},
            {"id": "llava", "name": "LLaVA", "desc": "Vision - image understanding", "context": "4K", "sizes": ["7b", "13b", "34b"]},
        ],
    },
    "deepseek": {
        "name": "DeepSeek",
        "requires_env": "DEEPSEEK_API_KEY",
        "models": [
            {"id": "deepseek-chat", "name": "DeepSeek V3", "desc": "General purpose, excellent value", "context": "128K", "pricing": "$0.27/$1.10 per MTok"},
            {"id": "deepseek-reasoner", "name": "DeepSeek R1", "desc": "Reasoning model", "context": "128K", "pricing": "$0.55/$2.19 per MTok"},
        ],
    },
    "groq": {
        "name": "Groq (Fast Inference)",
        "requires_env": "GROQ_API_KEY",
        "models": [
            {"id": "llama-3.3-70b-versatile", "name": "Llama 3.3 70B", "desc": "Near-frontier, ultra-fast on Groq", "context": "128K", "pricing": "Free tier available"},
            {"id": "llama-3.1-8b-instant", "name": "Llama 3.1 8B", "desc": "Fastest, good for simple tasks", "context": "128K", "pricing": "Free tier available"},
            {"id": "mixtral-8x7b-32768", "name": "Mixtral 8x7B", "desc": "Mixture of experts", "context": "32K", "pricing": "Free tier available"},
        ],
    },
    "openrouter": {
        "name": "OpenRouter (All Models)",
        "requires_env": "OPENROUTER_API_KEY",
        "models": [
            {"id": "anthropic/claude-3.7-sonnet", "name": "Claude 3.7 Sonnet", "desc": "Latest Sonnet with hybrid reasoning", "context": "200K", "pricing": "OpenRouter pricing"},
            {"id": "openai/gpt-4o", "name": "GPT-4o", "desc": "Flagship OpenAI model", "context": "128K", "pricing": "OpenRouter pricing"},
            {"id": "deepseek/deepseek-r1", "name": "DeepSeek R1", "desc": "Open-weight reasoning model", "context": "128K", "pricing": "OpenRouter pricing"},
            {"id": "google/gemini-2.0-flash-001", "name": "Gemini 2.0 Flash", "desc": "Ultra fast Google model", "context": "1M", "pricing": "OpenRouter pricing"},
            {"id": "meta-llama/llama-3.3-70b-instruct", "name": "Llama 3.3 70B", "desc": "Meta open flagship", "context": "128K", "pricing": "OpenRouter pricing"},
        ],
    },
    "nvidia": {
        "name": "NVIDIA NIM (Cloud API)",
        "requires_env": "NVIDIA_API_KEY",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "models": [
            {"id": "nvidia/llama-3.1-nemotron-70b-instruct", "name": "Llama 3.1 Nemotron 70B", "desc": "NVIDIA high-accuracy aligned flagship", "context": "128K", "pricing": "NVIDIA NIM API / Free credits"},
            {"id": "meta/llama-3.3-70b-instruct", "name": "Llama 3.3 70B", "desc": "Meta flagship open model on NVIDIA NIM", "context": "128K", "pricing": "NVIDIA NIM API"},
            {"id": "meta/llama-3.1-405b-instruct", "name": "Llama 3.1 405B", "desc": "Frontier open-weights 405B model", "context": "128K", "pricing": "NVIDIA NIM API"},
            {"id": "deepseek-ai/deepseek-r1", "name": "DeepSeek R1", "desc": "NVIDIA-accelerated reasoning model", "context": "128K", "pricing": "NVIDIA NIM API"},
            {"id": "qwen/qwen2.5-coder-32b-instruct", "name": "Qwen 2.5 Coder 32B", "desc": "Specialized coding LLM on NVIDIA hardware", "context": "128K", "pricing": "NVIDIA NIM API"},
            {"id": "mistralai/mistral-large-2-instruct", "name": "Mistral Large 2", "desc": "123B flagship multilingual & coding model", "context": "128K", "pricing": "NVIDIA NIM API"},
            {"id": "google/gemma-3-27b-it", "name": "Gemma 3 27B IT", "desc": "Google's latest 27B multimodal reasoning model", "context": "32K", "pricing": "NVIDIA NIM API"},
            {"id": "microsoft/phi-4", "name": "Phi 4", "desc": "Microsoft's 14B highly capable small model", "context": "16K", "pricing": "NVIDIA NIM API"},
        ],
    },
}


def get_provider_list():
    """Get list of available providers."""
    return [
        {"key": k, "name": v["name"], "requires_env": v.get("requires_env")}
        for k, v in MODEL_CATALOG.items()
    ]


def get_models_for_provider(provider_key: str):
    """Get available models for a provider."""
    provider = MODEL_CATALOG.get(provider_key, {})
    return provider.get("models", [])


def get_provider_display_name(provider_key: str):
    """Get display name for a provider."""
    provider = MODEL_CATALOG.get(provider_key, {})
    return provider.get("name", provider_key)


_CTX_SIZE_MAP = {
    "4K": 4_096, "8K": 8_192, "16K": 16_384, "32K": 32_768,
    "64K": 65_536, "128K": 131_072, "200K": 200_000, "1M": 1_048_576, "Local": 0,
}


def _get_context_cache_path() -> Path:
    from andromity.config import get_config_dir
    return get_config_dir() / "model_context_cache.json"

def get_context_limit_for_model(provider_key: str, model_id: str) -> int:
    """Return context window size in tokens for a given provider + model.
    Checks live cache first, then falls back to catalog and Ollama live query.
    Returns 32768 if unknown.
    """
    # 1. Check live cache from recent API fetches
    cache_path = _get_context_cache_path()
    if cache_path.exists():
        try:
            import json
            with open(cache_path, "r", encoding="utf-8") as f:
                cache = json.load(f)
            cached_ctx = cache.get(provider_key, {}).get(model_id)
            if cached_ctx:
                return cached_ctx
        except Exception:
            pass

    # 2. Check hardcoded catalog
    provider = MODEL_CATALOG.get(provider_key, {})
    for m in provider.get("models", []):
        if m["id"] == model_id:
            ctx_str = m.get("context", "")
            # Try direct number string (e.g. "131072")
            try:
                return int(ctx_str)
            except (ValueError, TypeError):
                pass
            # Parse shorthand (e.g. "128K", "1M")
            return _CTX_SIZE_MAP.get(ctx_str.strip(), 32768)
    # Unknown model — try Ollama live query
    if provider_key == "ollama":
        return get_ollama_num_ctx(model_id)
    # Unknown cloud model — assume 128K (safe minimum for modern cloud models)
    return 131072


def get_ollama_num_ctx(model: str, base_url: str = "http://localhost:11434") -> int:
    """Query Ollama /api/show to get actual num_ctx for the running model."""
    import urllib.request, json
    try:
        data = json.dumps({"name": model}).encode()
        req = urllib.request.Request(
            f"{base_url.rstrip('/')}/api/show",
            data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            result = json.loads(resp.read())
        
        ctx = (
            result.get("model_info", {}).get("llama.context_length")
            or result.get("model_info", {}).get("qwen2.context_length")
            or result.get("model_info", {}).get("mistral.context_length")
        )
        if not ctx:
            params = result.get("parameters", "")
            for line in params.split("\n"):
                if "num_ctx" in line:
                    try:
                        ctx = int(line.split()[1])
                        break
                    except (ValueError, IndexError):
                        pass
        return int(ctx) if ctx else 131072  # 128K default if Ollama doesn't report ctx
    except Exception:
        return 32768


def fetch_live_models_sync(provider_key: str, api_key: str = None, base_url: str = None) -> list[dict]:
    """Fetch live models from provider API. Returns list of model dicts or empty list on failure.
    Caches the context windows to disk for future use.
    """
    import json
    import urllib.request
    import urllib.error

    def _get(url: str, headers: dict, timeout: float = 4.0) -> dict | None:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Andromity/1.0", **headers})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None

    # ── Ollama (local daemon) ──────────────────────────────────────────────────
    if provider_key == "ollama":
        url = (base_url or "http://localhost:11434").rstrip("/") + "/api/tags"
        data = _get(url, {}, timeout=2.5)
        if not data:
            return []
        models = []
        for item in data.get("models", []):
            name = item.get("name", "")
            size_bytes = item.get("size", 0)
            size_gb = f"{size_bytes / (1024**3):.1f}GB" if size_bytes else ""
            num_ctx = get_ollama_num_ctx(name, base_url or "http://localhost:11434")
            models.append({
                "id": name,
                "name": name,
                "desc": f"Locally installed ({size_gb})" if size_gb else "Locally installed",
                "context": f"{num_ctx // 1024}K" if num_ctx else "Local",
            })
        return models

    # ── Anthropic ──────────────────────────────────────────────────────────────
    elif provider_key == "anthropic" and api_key:
        data = _get(
            "https://api.anthropic.com/v1/models",
            {"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        )
        if not data:
            return []
        models = []
        for item in sorted(data.get("data", []), key=lambda x: x.get("created_at", ""), reverse=True):
            m_id = item.get("id", "")
            m_name = item.get("display_name", m_id)
            models.append({
                "id": m_id,
                "name": m_name,
                "desc": "Anthropic model",
                "context": "200K+",
            })
        return models

    # ── OpenAI ────────────────────────────────────────────────────────────────
    elif provider_key == "openai" and api_key:
        data = _get(
            "https://api.openai.com/v1/models",
            {"Authorization": f"Bearer {api_key}"},
        )
        if not data:
            return []
        # Only keep chat-capable models; exclude embedding, tts, whisper, dall-e etc.
        CHAT_PREFIXES = ("gpt-4", "gpt-5", "o1", "o3", "o4", "chatgpt")
        models = []
        for item in sorted(data.get("data", []), key=lambda x: x.get("created", 0), reverse=True):
            m_id = item.get("id", "")
            if any(m_id.startswith(p) for p in CHAT_PREFIXES):
                models.append({
                    "id": m_id,
                    "name": m_id,
                    "desc": "OpenAI chat model",
                    "context": "Auto",
                })
        return models

    # ── Google (Gemini) ───────────────────────────────────────────────────────
    elif provider_key == "google" and api_key:
        data = _get(
            f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}",
            {},
        )
        if not data:
            return []
        models = []
        for item in data.get("models", []):
            methods = item.get("supportedGenerationMethods", [])
            if "generateContent" not in methods:
                continue  # skip embedding-only, TTS, etc.
            name_full = item.get("name", "")  # e.g. "models/gemini-2.5-pro"
            m_id = name_full.replace("models/", "")
            m_name = item.get("displayName", m_id)
            in_tokens = item.get("inputTokenLimit", 0)
            ctx = f"{in_tokens // 1000}K" if in_tokens >= 1000 else str(in_tokens)
            models.append({
                "id": m_id,
                "name": m_name,
                "desc": item.get("description", "")[:60] if item.get("description") else "Google Gemini model",
                "context": ctx,
            })
        return models

    # ── Groq ──────────────────────────────────────────────────────────────────
    elif provider_key == "groq" and api_key:
        data = _get(
            "https://api.groq.com/openai/v1/models",
            {"Authorization": f"Bearer {api_key}"},
        )
        if not data:
            return []
        models = []
        for item in data.get("data", []):
            if not item.get("active", True):
                continue  # skip decommissioned
            m_id = item.get("id", "")
            ctx = item.get("context_window", 0)
            ctx_str = f"{ctx // 1000}K" if ctx >= 1000 else str(ctx)
            models.append({
                "id": m_id,
                "name": m_id,
                "desc": "Groq ultra-fast inference",
                "context": ctx_str,
            })
        return models

    # ── DeepSeek ──────────────────────────────────────────────────────────────
    elif provider_key == "deepseek" and api_key:
        data = _get(
            "https://api.deepseek.com/models",
            {"Authorization": f"Bearer {api_key}"},
        )
        if not data:
            return []
        models = []
        for item in data.get("data", []):
            m_id = item.get("id", "")
            models.append({
                "id": m_id,
                "name": m_id,
                "desc": "DeepSeek model",
                "context": "128K",
            })
        return models

    # ── OpenRouter ────────────────────────────────────────────────────────────
    elif provider_key == "openrouter":
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        data = _get("https://openrouter.ai/api/v1/models", headers)
        if not data:
            return []
        models = []
        for item in data.get("data", [])[:80]:  # cap at 80 to keep list manageable
            m_id = item.get("id", "")
            m_name = item.get("name", m_id)
            ctx = item.get("context_length", 0)
            ctx_str = f"{ctx // 1000}K" if isinstance(ctx, int) and ctx >= 1000 else str(ctx)
            desc = (item.get("description", "")[:55] + "…") if item.get("description") else ""
            models.append({
                "id": m_id,
                "name": m_name,
                "desc": desc,
                "context": ctx_str,
            })
        return models

    # ── NVIDIA NIM ────────────────────────────────────────────────────────────
    elif provider_key == "nvidia" and api_key:
        data = _get(
            "https://integrate.api.nvidia.com/v1/models",
            {"Authorization": f"Bearer {api_key}"},
        )
        if not data:
            return []
        models = [{"id": "google/gemma-2-2b-it", "name": "Gemma 2 2B IT", "desc": "NVIDIA NIM accelerated model", "context": "128K"}]
        for item in data.get("data", []):
            m_id = item.get("id", "")
            # Filter for text/chat/instruct models, skipping embeddings
            if "embed" in m_id.lower() or "rerank" in m_id.lower():
                continue
            models.append({
                "id": m_id,
                "name": m_id.split("/")[-1] if "/" in m_id else m_id,
                "desc": "NVIDIA NIM accelerated model",
                "context": "128K",
            })
        return _cache_and_return(provider_key, models)

    return _cache_and_return(provider_key, [])

def _cache_and_return(provider_key: str, models: list[dict]) -> list[dict]:
    """Save context limits to cache before returning the models."""
    if not models:
        return models
    try:
        import json
        cache_path = _get_context_cache_path()
        cache = {}
        if cache_path.exists():
            with open(cache_path, "r", encoding="utf-8") as f:
                cache = json.load(f)
                
        if provider_key not in cache:
            cache[provider_key] = {}
            
        for m in models:
            ctx_str = m.get("context", "")
            if not ctx_str or ctx_str == "Local" or ctx_str == "Auto" or ctx_str == "Unknown":
                continue
            # Parse shorthand (e.g. "128K")
            try:
                if ctx_str in _CTX_SIZE_MAP:
                    cache[provider_key][m["id"]] = _CTX_SIZE_MAP[ctx_str]
                else:
                    # e.g. "128K" to 131072 if strictly parsing numbers, but _CTX_SIZE_MAP handles most
                    pass
            except Exception:
                pass
                
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2)
    except Exception:
        pass
    return models
