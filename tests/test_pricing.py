"""Tests for cost calculation fallbacks: free models, unknown estimates, unpriced."""
import pytest

from andromity.core.pricing import CostResult, calculate_cost


def _usage(prompt=1000, completion=500, cached=0):
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "cached_tokens": cached,
    }


def test_catalog_pricing_still_works():
    result = calculate_cost(_usage(), "anthropic", "claude-sonnet-5")
    # Known models resolve to a real per-token rate (LiteLLM or catalog fallback)
    assert result.usd > 0
    assert result.source in ("litellm", "catalog_estimate", "usage_and_catalog_estimate")


def test_free_model_returns_free_source():
    """OpenRouter ':free' models cost nothing and must not be marked '?'."""
    result = calculate_cost(_usage(), "openrouter", "z-ai/glm-5.2:free")
    assert result.source == "free"
    assert result.usd == 0.0


def test_free_detection_is_case_insensitive():
    result = calculate_cost(_usage(), "openrouter", "vendor/model:Free")
    assert result.source == "free"


def test_unknown_paid_model_is_estimate_not_unpriced():
    """Paid model with no pricing data anywhere -> '~' (estimate), never '?'."""
    result = calculate_cost(_usage(), "openrouter", "vendor/paid-model-v9")
    assert result.source == "unknown_estimate"
    assert result.usd == 0.0


def test_no_model_stays_unpriced():
    result = calculate_cost(_usage(), "", "")
    assert result.source == "unpriced"