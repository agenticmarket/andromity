import pytest
from andromity.server.rpc_handler import JsonRpcHandler


@pytest.mark.asyncio
@pytest.mark.parametrize("installed", [[], [{"id": "qwen2.5-coder:3b", "name": "qwen2.5-coder:3b", "context_limit": 8192}]])
async def test_ollama_model_list_uses_live_installation_not_catalog(monkeypatch, installed):
    from andromity.server import rpc_handler as rpc
    monkeypatch.setattr(rpc.config, "get_provider_config", lambda provider: {"base_url": "http://localhost:11434"})
    monkeypatch.setattr(rpc.config, "get_pinned_models", lambda: [])
    monkeypatch.setattr(rpc, "get_cached_live_models", lambda provider: [{"id": "not-installed"}])
    monkeypatch.setattr(rpc, "fetch_live_models_sync", lambda *args, **kwargs: installed)
    result = await JsonRpcHandler().rpc_config_list_models({"provider": "ollama"})
    assert [model["id"] for model in result] == [model["id"] for model in installed]


@pytest.mark.asyncio
async def test_ollama_probe_failure_does_not_restore_cached_catalog(monkeypatch):
    from andromity.server import rpc_handler as rpc
    monkeypatch.setattr(rpc.config, "get_provider_config", lambda provider: {})
    monkeypatch.setattr(rpc.config, "get_pinned_models", lambda: [])
    monkeypatch.setattr(rpc, "get_cached_live_models", lambda provider: [{"id": "not-installed"}])
    def unavailable(*args, **kwargs):
        raise ConnectionError("Ollama unavailable")
    monkeypatch.setattr(rpc, "fetch_live_models_sync", unavailable)
    assert await JsonRpcHandler().rpc_config_list_models({"provider": "ollama"}) == []
