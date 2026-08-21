"""Tests for context-window shorthand parsing and the model cache writer."""
import json
import tempfile
from pathlib import Path

from andromity.core.models import _parse_ctx_shorthand, _cache_and_return, _get_context_cache_path


def test_parse_plain_number():
    assert _parse_ctx_shorthand("131072") == 131072


def test_parse_known_shorthand():
    assert _parse_ctx_shorthand("128K") == 131072
    assert _parse_ctx_shorthand("1M") == 1_048_576


def test_parse_arbitrary_numeric_shorthand():
    """Non-catalog values like '262K' / '1048K' must parse, not be skipped."""
    assert _parse_ctx_shorthand("262K") == 262_000
    assert _parse_ctx_shorthand("1048K") == 1_048_000
    assert _parse_ctx_shorthand("1.5M") == 1_500_000
    assert _parse_ctx_shorthand("4G") == 4_000_000_000


def test_parse_invalid_returns_none():
    assert _parse_ctx_shorthand("") is None
    assert _parse_ctx_shorthand("Local") is None
    assert _parse_ctx_shorthand("Auto") is None
    assert _parse_ctx_shorthand("nonsense") is None
    assert _parse_ctx_shorthand(None) is None


def test_cache_and_return_parses_arbitrary_shorthand(tmp_path, monkeypatch):
    from andromity.config import get_config_dir
    monkeypatch.setattr("andromity.core.models._get_context_cache_path",
                        lambda: tmp_path / "model_context_cache.json")

    models = [
        {"id": "gemma-4-31b-it", "context": "262K"},
        {"id": "nemotron-lightning", "context": "131072"},
        {"id": "local-model", "context": "Local"},
    ]
    out = _cache_and_return("google", models)
    assert out == models

    cache = json.loads((tmp_path / "model_context_cache.json").read_text(encoding="utf-8"))
    assert cache["google"]["gemma-4-31b-it"] == 262_000
    assert cache["google"]["nemotron-lightning"] == 131_072
    assert "local-model" not in cache["google"]