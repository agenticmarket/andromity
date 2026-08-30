"""Model pricing resolution.

LiteLLM is the primary pricing catalog. The local model catalog is only a
temporary numeric fallback for models LiteLLM does not know yet.
"""
from dataclasses import dataclass
import re
from typing import Any


@dataclass(frozen=True)
class CostResult:
    usd: float
    source: str


def _model_candidates(provider: str, model: str) -> list[str]:
    model = (model or "").strip()
    provider = (provider or "").strip()
    candidates = [model]
    provider_aliases = {
        "google": "gemini",
        "nvidia": "nvidia_nim",
    }
    alias = provider_aliases.get(provider, provider)
    if alias and model:
        candidates.append(f"{alias}/{model}")
    if provider and model:
        candidates.append(f"{provider}/{model}")
    # OpenRouter and NVIDIA model IDs already contain a vendor prefix.
    if "/" in model:
        candidates.append(model.split("/", 1)[-1])
    return list(dict.fromkeys(candidates))


def _catalog_fallback(provider: str, model: str) -> tuple[float, float] | None:
    try:
        from andromity.core.models import MODEL_CATALOG
        for item in MODEL_CATALOG.get(provider, {}).get("models", []):
            if item.get("id") != model:
                continue
            match = re.search(r"\$([0-9.]+)\s*/\s*\$([0-9.]+)", item.get("pricing", ""))
            if match:
                return float(match.group(1)), float(match.group(2))
    except Exception:
        pass
    return None


from pathlib import Path


def _get_pricing_cache_path() -> Path:
    from andromity.config import get_config_dir
    return get_config_dir() / "model_pricing_cache.json"


def _pricing_cache_lookup(provider: str, model: str) -> dict | None:
    cache_path = _get_pricing_cache_path()
    if not cache_path.exists() and (provider == "openrouter" or "/" in model):
        try:
            import threading
            from andromity.core.models import fetch_live_models_sync
            from andromity.config import config
            threading.Thread(
                target=fetch_live_models_sync,
                args=("openrouter",),
                kwargs={"api_key": config.get_api_key("openrouter")},
                daemon=True,
            ).start()
        except Exception:
            pass

    if not cache_path.exists():
        return None

    try:
        import json
        with open(cache_path, "r", encoding="utf-8") as f:
            cache = json.load(f)

        candidates = _model_candidates(provider, model)
        p_data = cache.get(provider, {})
        for cand in candidates:
            if cand in p_data:
                return p_data[cand]

        if "openrouter" in cache:
            for cand in candidates:
                if cand in cache["openrouter"]:
                    return cache["openrouter"][cand]
    except Exception:
        pass
    return None


def calculate_cost(usage: dict[str, Any], provider: str, model: str) -> CostResult:
    """Calculate cost without claiming accuracy for unpriced models."""
    p_lower = (provider or "").strip().lower()
    m_lower = (model or "").strip().lower()

    # Free models (OpenRouter ":free" suffix, e.g. "dots-studio/dots-3-note-preview:free")
    # and local providers (ollama, local) genuinely cost nothing — always $0.00
    if ":free" in m_lower or p_lower in ("ollama", "local"):
        return CostResult(0.0, "free")

    prompt = int(usage.get("prompt_tokens", 0) or 0)
    completion = int(usage.get("completion_tokens", 0) or 0)
    cached = int(usage.get("cached_tokens", 0) or 0)

    try:
        import litellm
        for candidate in _model_candidates(provider, model):
            try:
                kwargs = {
                    "model": candidate,
                    "prompt_tokens": prompt,
                    "completion_tokens": completion,
                }
                if cached:
                    kwargs["cache_read_input_tokens"] = cached
                try:
                    result = litellm.cost_per_token(**kwargs)
                except TypeError:
                    # Older LiteLLM versions do not accept cache details.
                    # Keep the base model price rather than losing all cost.
                    result = litellm.cost_per_token(
                        model=candidate,
                        prompt_tokens=prompt,
                        completion_tokens=completion,
                    )
                if result is not None:
                    source = "litellm_estimate" if usage.get("usage_source") == "estimate" else "litellm"
                    return CostResult(float(sum(result)), source)
            except Exception:
                continue
    except Exception:
        pass

    # 2. Check live API pricing cache (e.g. OpenRouter live API rates)
    cached_rates = _pricing_cache_lookup(provider, model)
    if cached_rates:
        p_rate = float(cached_rates.get("prompt", 0) or 0)
        c_rate = float(cached_rates.get("completion", 0) or 0)
        k_rate = float(cached_rates.get("cached", 0) or p_rate)
        if p_rate > 0 or c_rate > 0:
            if cached and cached > 0:
                cost = max(0, prompt - cached) * p_rate + cached * k_rate + completion * c_rate
            else:
                cost = prompt * p_rate + completion * c_rate
            source = "openrouter_api" if provider == "openrouter" else "api_pricing"
            return CostResult(cost, source)

    rates = _catalog_fallback(provider, model)
    if rates:
        input_rate, output_rate = rates
        # Cached pricing varies by provider. Do not invent a discount; the
        # catalog fallback is explicitly marked as an estimate.
        source = "catalog_estimate"
        if usage.get("usage_source") == "estimate":
            source = "usage_and_catalog_estimate"
        return CostResult((prompt * input_rate + completion * output_rate) / 1_000_000, source)

    # Free models (OpenRouter ":free" suffix, e.g. "z-ai/glm-5.2:free")
    # genuinely cost nothing — the UI shows a clean $0.00 with no prefix.
    if ":free" in (model or "").lower():
        return CostResult(0.0, "free")

    # No model at all — nothing to price; the UI shows "?$0.0000".
    if not (model or "").strip() and not (provider or "").strip():
        return CostResult(0.0, "unpriced")

    # Paid model with no pricing data anywhere: report zero cost but mark it
    # as an unknown estimate so the UI shows "~$0.0000" instead of "?$0.0000".
    return CostResult(0.0, "unknown_estimate")
