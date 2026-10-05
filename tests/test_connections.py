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
