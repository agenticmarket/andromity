"""Tests for context-window shorthand parsing and the model cache writer."""
import json
import tempfile
import pytest
from pathlib import Path

from andromity.core.models import _parse_ctx_shorthand, _cache_and_return, _get_context_cache_path


def immediate(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    finally:
        coroutine.close()
    raise AssertionError("Coroutine unexpectedly suspended")


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


@pytest.mark.parametrize("item,free", [
    ({"id": "deepseek-v4.1-flash:free"}, True),
    ({"id": "paid"}, False),
    ({"id": "paid", "pricing": {}}, False),
    ({"id": "paid", "pricing": {"prompt": "0"}}, False),
    ({"id": "paid", "pricing": {"prompt": "0", "completion": "0.001"}}, False),
    ({"id": "zero", "pricing": {"prompt": "0", "completion": "0"}}, True),
    ({"id": "declared", "is_free": True}, True),
    ({"id": "invalid", "pricing": {"prompt": "NaN", "completion": "0"}}, False),
])
def test_custom_model_free_classification_requires_evidence(item, free):
    from andromity.core.models import normalize_endpoint_model
    result = normalize_endpoint_model(item, "custom")
    assert result["is_free"] is free
    assert ("free" in result["tags"]) is free
    assert result["id"] == item["id"]


def test_custom_discovery_uses_connection_url_and_key_and_preserves_metadata(monkeypatch):
    import io
    import urllib.request
    from andromity.core import models

    monkeypatch.setattr(models, "_cache_and_return", lambda provider, items: items)
    monkeypatch.setattr("andromity.config.config.get_provider_config", lambda provider: {
        "type": "openai", "base_url": "https://tokenharbor.ai/v1/chat/completions",
    })
    monkeypatch.setattr("andromity.config.config.get_api_key", lambda provider: "connection-key")
    payload = {"data": [
        {"id": "deepseek-v4.1-flash:free", "context_length": 262144, "supported_parameters": ["reasoning_effort"], "reasoning": {"supported": True}},
        {"id": "paid"}, {"id": "paid"}, {"id": 123}, "bad-row", {},
    ]}
    def request(req, timeout):
        assert req.full_url == "https://tokenharbor.ai/v1/models"
        assert req.get_header("Authorization") == "Bearer connection-key"
        return io.BytesIO(json.dumps(payload).encode())
    monkeypatch.setattr(urllib.request, "urlopen", request)
    result = models.fetch_live_models_sync("custom")
    assert [m["id"] for m in result] == ["deepseek-v4.1-flash:free", "paid"]
    assert result[0]["context_limit"] == 262144
    assert result[0]["supported_parameters"] == ["reasoning_effort"]
    assert result[0]["reasoning"] == {"supported": True}
    assert result[1]["pricing"] == "Pricing unavailable"
    assert "connection-key" not in json.dumps(result)


def test_discovery_failure_keeps_cache_and_does_not_log_credentials(monkeypatch, caplog):
    import urllib.request
    from urllib.error import HTTPError
    from andromity.core import models

    monkeypatch.setattr("andromity.config.config.get_provider_config", lambda provider: {"type": "openai"})
    monkeypatch.setattr(models, "_cache_and_return", lambda *args: pytest.fail("Must retain cached models on failure"))
    def fail(*args, **kwargs):
        raise HTTPError("https://example.com/v1/models", 401, "private-key-and-body", {}, None)
    monkeypatch.setattr(urllib.request, "urlopen", fail)
    assert models.fetch_live_models_sync("custom", "private-key-and-body", "https://example.com/v1") == []
    assert "401" in caplog.text
    assert "private-key-and-body" not in caplog.text


@pytest.mark.parametrize("adapter,header,cursor", [("openai", "Authorization", "after"), ("anthropic", "X-api-key", "after_id")])
def test_custom_discovery_follows_pages_on_its_own_endpoint(monkeypatch, adapter, header, cursor):
    import io
    import urllib.request
    from andromity.core import models
    urls = []
    monkeypatch.setattr(models, "_cache_and_return", lambda provider, items: items)
    monkeypatch.setattr("andromity.config.config.get_provider_config", lambda provider: {"type": adapter})
    def request(req, timeout):
        urls.append(req.full_url)
        assert req.get_header(header) == ("Bearer key" if adapter == "openai" else "key")
        if len(urls) == 1:
            page = {"data": [{"id": "vendor/one:free"}], "has_more": True, "next": "https://unrelated.example.com/models"}
        else:
            page = {"data": [{"id": "vendor/two", "display_name": "Model Two", "max_input_tokens": 200000}], "has_more": False}
        return io.BytesIO(json.dumps(page).encode())
    monkeypatch.setattr(urllib.request, "urlopen", request)
    base = "https://connector.example.com/v1" if adapter == "openai" else "https://connector.example.com"
    result = models.fetch_live_models_sync("custom", "key", base)
    assert [m["id"] for m in result] == ["vendor/one:free", "vendor/two"]
    assert result[1]["name"] == "Model Two"
    assert result[1]["context_limit"] == 200000
    assert urls == ["https://connector.example.com/v1/models", "https://connector.example.com/v1/models?" + cursor + "=vendor%2Fone%3Afree"]


def test_unsupported_custom_catalog_does_not_send_credentials_to_adapter_default(monkeypatch):
    import urllib.request
    from andromity.core import models
    monkeypatch.setattr("andromity.config.config.get_provider_config", lambda provider: {"type": "google"})
    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: pytest.fail("Custom key must not be sent to Google"))
    assert models.fetch_live_models_sync("custom", "custom-key", "https://connector.example.com/v1") == []


def test_editing_connection_invalidates_only_its_catalog(tmp_path, monkeypatch):
    from andromity.core import models
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps({"custom": [{"id": "old"}], "other": [{"id": "keep"}]}))
    monkeypatch.setattr(models, "_get_live_catalog_cache_path", lambda: path)
    models.invalidate_model_catalog("custom")
    assert models.get_cached_live_models("custom") == []
    assert models.get_cached_live_models("other") == [{"id": "keep"}]


@pytest.mark.parametrize("refresh", [False, True])
def test_rpc_catalog_discovers_custom_models_and_classifies_free_routes(monkeypatch, refresh):
    from andromity.server import rpc_handler as rpc
    cache = {}
    calls = []
    def fetch(provider, **kwargs):
        calls.append(provider)
        cache[provider] = [{"id": "model:free", "name": "Free model", "is_free": True, "tags": ["free"]}]
        return cache[provider]
    async def to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)
    async def wait_for(awaitable, timeout):
        return await awaitable
    async def gather(*awaitables):
        return [await result for result in awaitables]
    monkeypatch.setattr(rpc.asyncio, "to_thread", to_thread)
    monkeypatch.setattr(rpc.asyncio, "wait_for", wait_for)
    monkeypatch.setattr(rpc.asyncio, "gather", gather)
    monkeypatch.setattr(rpc, "fetch_live_models_sync", fetch)
    monkeypatch.setattr(rpc, "get_cached_live_models", lambda provider: cache.get(provider, []))
    monkeypatch.setattr(rpc.config, "get_provider_config", lambda provider: {"type": "openai", "base_url": "https://example.com/v1"})
    monkeypatch.setattr(rpc.config, "get_api_key", lambda provider: "key")
    monkeypatch.setattr(rpc.config, "get_pinned_models", lambda: [])
    result = immediate(rpc.JsonRpcHandler.rpc_config_list_models(object(), {"provider": "custom", "refresh": refresh}))
    assert calls == ["custom"]
    assert result[0]["provider"] == "custom"
    assert result[0]["is_free"] is True
    result = immediate(rpc.JsonRpcHandler.rpc_config_list_models(object(), {"provider": "custom"}))
    assert calls == ["custom"]


def test_rpc_manual_model_remains_free_when_discovery_is_unavailable(monkeypatch):
    from andromity.server import rpc_handler as rpc
    async def to_thread(*args, **kwargs):
        return []
    async def wait_for(awaitable, timeout):
        return await awaitable
    async def gather(*awaitables):
        return [await result for result in awaitables]
    monkeypatch.setattr(rpc.asyncio, "to_thread", to_thread)
    monkeypatch.setattr(rpc.asyncio, "wait_for", wait_for)
    monkeypatch.setattr(rpc.asyncio, "gather", gather)
    monkeypatch.setattr(rpc, "get_cached_live_models", lambda provider: [])
    monkeypatch.setattr(rpc.config, "get_provider_config", lambda provider: {"type": "openai", "base_url": "https://example.com/v1"})
    monkeypatch.setattr(rpc.config, "get_pinned_models", lambda: [])
    monkeypatch.setattr("andromity.core.models.get_models_for_provider", lambda provider: [{"id": "model:free"}])
    result = immediate(rpc.JsonRpcHandler.rpc_config_list_models(object(), {"provider": "custom"}))
    assert result[0]["id"] == "model:free"
    assert result[0]["is_free"] is True
