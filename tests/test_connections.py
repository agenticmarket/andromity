import pytest

from andromity.core import connections


def test_custom_provider_uses_its_endpoint_and_credential(monkeypatch):
    monkeypatch.setattr(connections.config, "get_provider_config", lambda provider: {
        "type": "openai", "model": "coding-model", "base_url": "http://localhost:8000/v1",
    })
    monkeypatch.setattr(connections.config, "get_api_key", lambda provider: "own-key" if provider == "custom" else "unrelated-key")
    request = connections.provider_request("custom", "")
    assert request == {"model": "openai/coding-model", "api_base": "http://localhost:8000/v1", "api_key": "own-key"}
    monkeypatch.setattr(connections.config, "get_api_key", lambda provider: None)
    assert connections.provider_request("custom", "coding-model")["api_key"] == "not-required"


@pytest.mark.parametrize("url", ["file:///tmp/server", "https://user:secret@example.com/v1", "https://example.com/v1?api_key=secret"])
def test_custom_connection_rejects_secrets_embedded_in_endpoint(url):
    with pytest.raises(ValueError, match="HTTP or HTTPS"):
        connections.validate_connection({"id": "custom", "model": "model", "base_url": url})


def test_provider_metadata_never_exposes_api_keys(monkeypatch):
    monkeypatch.setattr(connections.config, "list_providers", lambda: [{"name": "custom", "type": "openai", "api_key": "secret"}])
    monkeypatch.setattr(connections.config, "get_api_key", lambda provider: "secret")
    metadata = connections.provider_info()
    assert next(p for p in metadata if p["id"] == "custom")["has_key"] is True
    assert all("api_key" not in p for p in metadata)


@pytest.mark.parametrize("url,expected", [
    ("https://tokenharbor.ai/v1/chat/completions/", "https://tokenharbor.ai/v1"),
    ("https://example.com/proxy/v1/chat/completions", "https://example.com/proxy/v1"),
    ("http://localhost:8000/chat/completions", "http://localhost:8000"),
    ("https://example.com/custom-api/", "https://example.com/custom-api"),
])
def test_pasted_endpoint_is_normalized_on_save_and_existing_requests(monkeypatch, url, expected):
    saved = connections.validate_connection({"id": "custom", "model": "deepseek-v4.1-flash:free", "base_url": url})
    assert saved["base_url"] == expected
    monkeypatch.setattr(connections.config, "get_provider_config", lambda provider: {**saved, "base_url": url})
    monkeypatch.setattr(connections.config, "get_api_key", lambda provider: "own-key")
    request = connections.provider_request("custom", "")
    assert request["api_base"] == expected
    assert request["model"] == "openai/deepseek-v4.1-flash:free"


def test_other_adapter_endpoint_is_preserved():
    url = "https://example.com/custom/chat/completions"
    saved = connections.validate_connection({"id": "custom", "type": "azure", "model": "deployment", "base_url": url})
    assert saved["base_url"] == url


def immediate(coroutine):
    """Run mocks that never suspend without opening a Windows event-loop socket."""
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    finally:
        coroutine.close()
    raise AssertionError("Coroutine unexpectedly suspended")


@pytest.mark.parametrize("error_type,hint", [
    ("endpoint_not_found", "API base URL"), ("auth_error", "401/403"),
    ("model_not_found", "exact model ID"), ("rate_limit", "allowance"),
    ("timeout", "timed out"),
])
def test_connection_probe_preserves_actionable_failure(monkeypatch, caplog, error_type, hint):
    from andromity.core import provider
    from andromity.core.events import Done, TextDelta

    async def failed_stream(*args, **kwargs):
        yield TextDelta(text="<div>Provider error card with private details</div>")
        yield Done(outcome="error", error_type=error_type)

    monkeypatch.setattr(provider, "stream_completion", failed_stream)
    monkeypatch.setattr(connections.config, "get_provider_config", lambda name: {"model": "custom-model"})
    result = immediate(connections.test_connection("custom"))
    assert result["success"] is False
    assert result["error_type"] == error_type
    assert hint in result["message"]
    assert "private details" not in str(result) + caplog.text
    assert error_type in caplog.text


@pytest.mark.parametrize("terminal,success", [(True, True), (False, False)])
def test_connection_probe_requires_completed_stream(monkeypatch, terminal, success):
    from andromity.core import provider
    from andromity.core.events import Done, TextDelta

    async def stream(*args, **kwargs):
        yield TextDelta(text="OK")
        if terminal:
            yield Done()

    monkeypatch.setattr(provider, "stream_completion", stream)
    monkeypatch.setattr(connections.config, "get_provider_config", lambda name: {"model": "custom-model"})
    assert immediate(connections.test_connection("custom"))["success"] is success


def test_real_stream_html_404_reaches_connection_test_without_body_dump(monkeypatch, caplog):
    import litellm
    from andromity.core import provider

    async def to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    async def fail(**kwargs):
        assert kwargs["api_base"] == "https://tokenharbor.ai/v1"
        raise litellm.NotFoundError(message="<!DOCTYPE html><html><body>404 private-page-marker</body></html>",
                                   model="custom-model", llm_provider="openai")

    monkeypatch.setattr(litellm, "acompletion", fail)
    monkeypatch.setattr(provider.asyncio, "to_thread", to_thread)
    monkeypatch.setattr(connections.config, "get_provider_config", lambda name: {
        "type": "openai", "model": "custom-model", "base_url": "https://tokenharbor.ai/v1/chat/completions",
    })
    monkeypatch.setattr(connections.config, "get_api_key", lambda name: "own-key")
    result = immediate(connections.test_connection("custom"))
    assert result["error_type"] == "endpoint_not_found"
    assert "private-page-marker" not in str(result) + caplog.text
