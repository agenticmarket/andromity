"""Model catalog - available models per provider with descriptions."""

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
