"""Provider-agnostic token usage normalization.

LiteLLM normally exposes OpenAI-shaped usage, but providers use different
names for cache and reasoning fields. Keep the normalization in one place so
session accounting and the UI use the same numbers.
"""
from typing import Any, Dict


def _get(value: Any, *names: str, default: int = 0) -> int:
    for name in names:
        if isinstance(value, dict):
            candidate = value.get(name)
        else:
            candidate = getattr(value, name, None)
        if candidate is not None:
            try:
                return int(candidate)
            except (TypeError, ValueError):
                continue
    return default


def normalize_usage(raw: Any, source: str = "provider") -> Dict[str, Any]:
    """Return stable usage fields from OpenAI, Anthropic, Gemini, or LiteLLM.

    ``total_tokens`` is retained as the provider's total when supplied. This
    matters for thinking/tool-use tokens that may not equal input + output.
    """
    if not raw:
        return {}

    prompt_details = raw.get("prompt_tokens_details", {}) if isinstance(raw, dict) else getattr(raw, "prompt_tokens_details", {})
    completion_details = raw.get("completion_tokens_details", {}) if isinstance(raw, dict) else getattr(raw, "completion_tokens_details", {})

    prompt = _get(raw, "prompt_tokens", "input_tokens", "promptTokenCount")
    completion = _get(raw, "completion_tokens", "output_tokens", "candidatesTokenCount", "responseTokenCount")
    cached = _get(
        raw, "cached_tokens", "cache_read_input_tokens", "input_cached_tokens",
        "cachedContentTokenCount", default=_get(prompt_details, "cached_tokens")
    )
    reasoning = _get(
        raw, "reasoning_tokens", "thoughts_token_count", "thoughtsTokenCount",
        default=_get(completion_details, "reasoning_tokens")
    )
    total = _get(raw, "total_tokens", "totalTokenCount")
    if not total:
        total = prompt + completion + reasoning

    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "cached_tokens": cached,
        "reasoning_tokens": reasoning,
        "usage_source": source,
    }
