import asyncio
import pytest
import litellm
import andromity.core.provider as provider_mod

@pytest.mark.asyncio
async def test_andromity_provider_routing(monkeypatch):
    captured_kwargs = {}

    async def mock_acompletion(**kwargs):
        nonlocal captured_kwargs
        captured_kwargs = kwargs
        async def _gen():
            chunk = type("C", (), {})()
            delta = type("D", (), {})()
            delta.content = "OK from Andromity Gateway"
            delta.tool_calls = None
            delta.thinking = None
            delta.reasoning_content = None
            delta.reasoning = None
            chunk.choices = [type("Choice", (), {"delta": delta, "finish_reason": "stop"})()]
            chunk.usage = None
            yield chunk
        return _gen()

    monkeypatch.setattr(litellm, "acompletion", mock_acompletion)
    monkeypatch.setattr(provider_mod.config, "get_api_key", lambda name: None)
    monkeypatch.setattr(provider_mod.config, "get_provider_config", lambda name: None)

    events = []
    async for ev in provider_mod.stream_completion(
        [{"role": "user", "content": "ping"}],
        provider_name="andromity",
        model="auto",
    ):
        events.append(ev)

    assert captured_kwargs.get("model") == "openai/auto"
    assert "andromity-gateway" in captured_kwargs.get("api_base", "") or "gateway.agenticmarket.dev" in captured_kwargs.get("api_base", "")
    assert captured_kwargs.get("api_key") == "anonymous_trial"
    assert "x-andromity-client-id" in captured_kwargs.get("extra_headers", {})
    assert "x-andromity-version" in captured_kwargs.get("extra_headers", {})

    text = "".join(getattr(e, "text", "") for e in events)
    assert "OK from Andromity Gateway" in text
    assert any(type(e).__name__ == "Done" for e in events)


@pytest.mark.asyncio
async def test_openrouter_requests_use_the_same_app_identity_as_the_gateway(monkeypatch):
    """OpenRouter groups apps by HTTP-Referer; BYOK traffic must land in the gateway's app."""
    import pathlib
    import re
    import litellm
    from andromity.core import provider as provider_mod

    captured = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)

        async def _gen():
            chunk = type("C", (), {})()
            delta = type("D", (), {})()
            delta.content = "ok"
            delta.tool_calls = None
            delta.thinking = None
            delta.reasoning_content = None
            delta.reasoning = None
            chunk.choices = [type("Choice", (), {"delta": delta, "finish_reason": "stop"})()]
            chunk.usage = None
            yield chunk
        return _gen()

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    monkeypatch.setattr(provider_mod.config, "get_api_key", lambda name: "sk-or-test")
    monkeypatch.setattr(provider_mod.config, "get_provider_config", lambda name: None)
    async for _ in provider_mod.stream_completion([{"role": "user", "content": "hi"}], provider_name="openrouter", model="x/y:free"):
        pass

    headers = captured["extra_headers"]
    assert headers["HTTP-Referer"] == "https://andromity.agenticmarket.dev"
    assert headers["X-Title"] == headers["X-OpenRouter-Title"] == "Andromity"
    assert headers["X-OpenRouter-Categories"]

    gateway = pathlib.Path(__file__).resolve().parents[1] / "gateway-worker" / "src" / "fallbackRouter.ts"
    if gateway.exists():
        block = re.search(r"OPENROUTER_APP_HEADERS[^{]*\{(.*?)\}", gateway.read_text(encoding="utf-8"), re.S).group(1)
        assert "'HTTP-Referer': 'https://andromity.agenticmarket.dev'" in block
        assert "'X-Title': 'Andromity'" in block
