"""The provider stream behind the first-token watchdog must be closed exactly once however the
read ends, or its HTTP connection stays checked out until garbage collection finds it."""
import asyncio
import gc
from types import SimpleNamespace

import litellm
import pytest

import andromity.core.provider as provider_mod
from andromity.core.events import Done, TextDelta
from andromity.core.provider import ProviderStalledError, _first_token_guard


class ProviderStream:
    """Stands in for a LiteLLM stream: a plain async iterator with aclose(), not a generator."""

    def __init__(self, *steps, close_error=None):
        self.steps = list(steps)
        self.closes = 0
        self.reading = 0
        self.close_error = close_error
        self.release = asyncio.Event()

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.reading += 1
        try:
            if not self.steps:
                raise StopAsyncIteration
            step = self.steps.pop(0)
            if step == "hang":
                await asyncio.Event().wait()
            if step == "gate":
                await self.release.wait()
                step = self.steps.pop(0)
            if isinstance(step, BaseException):
                raise step
            return step
        finally:
            self.reading -= 1

    async def aclose(self):
        self.closes += 1
        if self.close_error:
            raise self.close_error


async def _other_tasks():
    for _ in range(3):
        await asyncio.sleep(0)
    return [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]


async def _cancel(task):
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_closing_the_guard_after_its_first_chunk_closes_the_stream():
    stream = ProviderStream("a", "b", "c")
    guard = _first_token_guard(stream, 1.0, 1.0)

    assert await guard.__anext__() == "a"
    await guard.aclose()

    assert stream.closes == 1
    assert stream.reading == 0


async def test_breaking_mid_stream_then_closing_closes_the_stream_once():
    stream = ProviderStream("a", "b", "c", "d")
    guard = _first_token_guard(stream, 1.0, 1.0)

    seen = []
    async for chunk in guard:
        seen.append(chunk)
        if chunk == "b":
            break
    await guard.aclose()
    await guard.aclose()

    assert seen == ["a", "b"]
    assert stream.closes == 1


async def test_a_dropped_guard_closes_the_stream_when_collected():
    stream = ProviderStream("a", "b", "c")
    guard = _first_token_guard(stream, 1.0, 1.0)
    async for _ in guard:
        break

    del guard
    gc.collect()
    await _other_tasks()

    assert stream.closes == 1


async def test_cancelling_while_waiting_for_the_first_chunk_closes_the_stream():
    stream = ProviderStream("hang")
    guard = _first_token_guard(stream, 5.0, 5.0)
    task = asyncio.ensure_future(guard.__anext__())
    await asyncio.sleep(0.05)

    await _cancel(task)

    assert stream.closes == 1
    assert stream.reading == 0
    assert await _other_tasks() == []


async def test_cancelling_while_waiting_for_a_later_chunk_closes_the_stream():
    stream = ProviderStream("a", "hang")
    guard = _first_token_guard(stream, 5.0, 5.0)
    received = []

    async def consume():
        async for chunk in guard:
            received.append(chunk)

    task = asyncio.ensure_future(consume())
    await asyncio.sleep(0.05)
    await _cancel(task)

    assert received == ["a"]
    assert stream.closes == 1
    assert stream.reading == 0
    assert await _other_tasks() == []


async def test_first_token_timeout_closes_the_stream_once():
    stream = ProviderStream("hang")

    with pytest.raises(ProviderStalledError) as stalled:
        async for _ in _first_token_guard(stream, 0.05, 5.0):
            pass

    assert stalled.value.timeout == 0.05
    assert stream.closes == 1
    assert stream.reading == 0
    assert await _other_tasks() == []


async def test_idle_timeout_closes_the_stream_once():
    stream = ProviderStream("a", "hang")
    received = []

    with pytest.raises(ProviderStalledError) as stalled:
        async for chunk in _first_token_guard(stream, 5.0, 0.05):
            received.append(chunk)

    assert received == ["a"]
    assert stalled.value.timeout == 0.05
    assert stream.closes == 1
    assert stream.reading == 0


async def test_a_stream_that_ends_is_passed_through_and_closed_once():
    stream = ProviderStream("a", "b", "c")

    received = [chunk async for chunk in _first_token_guard(stream, 1.0, 1.0)]

    assert received == ["a", "b", "c"]
    assert stream.closes == 1


async def test_an_empty_stream_ends_without_chunks_and_is_closed():
    stream = ProviderStream()

    assert [chunk async for chunk in _first_token_guard(stream, 1.0, 1.0)] == []
    assert stream.closes == 1


@pytest.mark.parametrize("steps", [(ConnectionError("dropped"),), ("a", ConnectionError("dropped"))])
async def test_a_provider_error_propagates_and_closes_the_stream(steps):
    stream = ProviderStream(*steps)

    with pytest.raises(ConnectionError, match="dropped"):
        async for _ in _first_token_guard(stream, 1.0, 1.0):
            pass

    assert stream.closes == 1


async def test_a_failing_close_does_not_hide_why_the_stream_ended():
    stream = ProviderStream("hang", close_error=RuntimeError("close failed"))

    with pytest.raises(ProviderStalledError):
        async for _ in _first_token_guard(stream, 0.05, 5.0):
            pass

    healthy = ProviderStream("a", close_error=RuntimeError("close failed"))
    assert [chunk async for chunk in _first_token_guard(healthy, 1.0, 1.0)] == ["a"]
    assert stream.closes == healthy.closes == 1


async def test_each_chunk_reaches_the_consumer_before_the_next_one_arrives():
    stream = ProviderStream("a", "gate", "b")
    guard = _first_token_guard(stream, 1.0, 1.0)

    assert await guard.__anext__() == "a"
    pending = asyncio.ensure_future(guard.__anext__())
    await asyncio.sleep(0.05)
    assert not pending.done()
    stream.release.set()

    assert await pending == "b"
    await guard.aclose()


def _patch_config(monkeypatch):
    monkeypatch.setattr(
        provider_mod.config, "get", lambda *args, **kwargs: args[-1] if len(args) >= 3 else None
    )
    monkeypatch.setattr(provider_mod.config, "get_provider_config", lambda name: None)
    monkeypatch.setattr(provider_mod.config, "get_api_key", lambda name: "sk-test")


def _text_chunk(text):
    delta = SimpleNamespace(content=text, tool_calls=None, thinking=None, reasoning_content=None,
                            reasoning=None, thought=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=None)], usage=None)


def _serve(monkeypatch, *streams):
    calls = []
    queue = list(streams)

    async def acompletion(**kwargs):
        calls.append([s.closes for s in streams])
        return queue.pop(0)

    _patch_config(monkeypatch)
    monkeypatch.setattr(litellm, "acompletion", acompletion)
    return calls


def _turn(retry=False):
    return provider_mod.stream_completion([{"role": "user", "content": "hi"}], retry=retry)


async def test_closing_the_turn_after_a_token_closes_the_provider_stream_before_returning(monkeypatch):
    stream = ProviderStream(_text_chunk("Hel"), _text_chunk("lo"), "hang")
    _serve(monkeypatch, stream)
    turn = _turn()

    async for event in turn:
        if isinstance(event, TextDelta):
            break
    await turn.aclose()

    assert stream.closes == 1
    assert stream.reading == 0


async def test_cancelling_the_turn_while_it_waits_for_a_chunk_closes_the_provider_stream(monkeypatch):
    stream = ProviderStream(_text_chunk("Hel"), "hang")
    _serve(monkeypatch, stream)
    texts = []
    got_text = asyncio.Event()

    async def run_turn():
        async for event in _turn():
            if isinstance(event, TextDelta):
                texts.append(event.text)
                got_text.set()

    task = asyncio.ensure_future(run_turn())
    await asyncio.wait_for(got_text.wait(), timeout=5)
    await asyncio.sleep(0.05)
    await _cancel(task)

    assert texts == ["Hel"]
    assert stream.closes == 1
    assert stream.reading == 0
    assert await _other_tasks() == []


async def test_a_failed_attempt_is_closed_before_the_retry_starts(monkeypatch):
    failed = ProviderStream(ConnectionError("connection dropped"))
    healthy = ProviderStream(_text_chunk("ok"))
    calls = _serve(monkeypatch, failed, healthy)
    monkeypatch.setattr(provider_mod, "STREAM_BACKOFF_DELAYS", [0.0])

    events = [event async for event in _turn(retry=True)]

    assert calls == [[0, 0], [1, 0]]
    assert "".join(e.text for e in events if isinstance(e, TextDelta)) == "ok"
    assert isinstance(events[-1], Done) and events[-1].outcome == "success"
    assert failed.closes == healthy.closes == 1


async def test_a_stalled_turn_closes_its_provider_stream_once(monkeypatch):
    stream = ProviderStream("hang")
    _serve(monkeypatch, stream)

    events = [event async for event in provider_mod.stream_completion(
        [{"role": "user", "content": "hi"}], first_token_timeout=0.05, retry=False)]

    assert isinstance(events[-1], Done) and events[-1].outcome == "error"
    assert stream.closes == 1
