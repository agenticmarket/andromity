"""First-token watchdog: a provider that accepts the request but never sends a
chunk (queued/overloaded upstream) must end the turn with a clear error + Done
instead of hanging forever."""
import asyncio

import litellm
import pytest

import andromity.core.provider as provider_mod


def _patch_config(monkeypatch):
    monkeypatch.setattr(
        provider_mod.config, "get", lambda *args, **kwargs: args[-1] if len(args) >= 3 else None
    )
    monkeypatch.setattr(provider_mod.config, "get_provider_config", lambda name: None)
    monkeypatch.setattr(provider_mod.config, "get_api_key", lambda name: "sk-test")


@pytest.mark.asyncio
async def test_stalled_provider_ends_turn_with_error_and_done(monkeypatch):
    _patch_config(monkeypatch)

    async def stalled_stream(**kwargs):
        async def _gen():
            # Simulates an upstream that accepted the request but never sends
            # anything — exactly the OpenRouter queue/keep-alive stall.
            await asyncio.sleep(30)
            yield None  # pragma: no cover
        return _gen()

    monkeypatch.setattr(litellm, "acompletion", stalled_stream)

    events = []
    async for ev in provider_mod.stream_completion(
        [{"role": "user", "content": "hi"}], first_token_timeout=0.2
    ):
        events.append(ev)
        if len(events) > 10:
            break

    texts = "".join(getattr(e, "text", "") for e in events)
    assert "stalled" in texts.lower(), f"expected stall message, got: {texts!r}"
    assert any(type(e).__name__ == "Done" for e in events), "turn must end with Done"


@pytest.mark.asyncio
async def test_healthy_provider_streams_normally(monkeypatch):
    _patch_config(monkeypatch)

    async def healthy_stream(**kwargs):
        async def _gen():
            for piece in ["Hello", " ", "world"]:
                chunk = type("C", (), {})()
                delta = type("D", (), {})()
                delta.content = piece
                delta.tool_calls = None
                delta.thinking = None
                delta.reasoning_content = None
                delta.reasoning = None
                delta.thought = None
                chunk.choices = [type("Ch", (), {})()]
                chunk.choices[0].delta = delta
                chunk.choices[0].finish_reason = None
                chunk.usage = None
                yield chunk
        return _gen()

    monkeypatch.setattr(litellm, "acompletion", healthy_stream)

    events = []
    async for ev in provider_mod.stream_completion([{"role": "user", "content": "hi"}]):
        events.append(ev)

    texts = "".join(getattr(e, "text", "") for e in events if type(e).__name__ == "TextDelta")
    assert "Hello world" == texts
    assert any(type(e).__name__ == "Done" for e in events), "turn must end with Done"