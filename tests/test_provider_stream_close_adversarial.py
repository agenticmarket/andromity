import asyncio
import contextvars
import functools
import gc
import inspect
import random
import time
import types
from contextlib import aclosing
from unittest.mock import patch

import litellm
import pytest

import andromity.core.provider as provider_mod
import andromity.core.reasoning as reasoning_mod
from andromity.core.agent import Agent
from andromity.core.events import (
    Done, TextDelta, ThinkingDelta, ToolCallDelta, ToolCallEnd, ToolCallStart,
)
from andromity.core.provider import ProviderStalledError, _first_token_guard
from andromity.core.session import Session

HANG = object()


def bounded(seconds: float = 10.0):
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            return await asyncio.wait_for(fn(*args, **kwargs), seconds)
        return wrapper
    return deco


class Chunk:
    def __init__(self, n):
        self.n = n

    def __repr__(self):
        return f"Chunk({self.n})"


class Ledger:
    def __init__(self):
        self.opened = 0
        self.closed = 0
        self.timeline = []
        self.streams = []

    @property
    def open(self):
        return self.opened - self.closed


class _Stream:
    def __init__(self, ledger, steps=(), *, name=None, close_delay=0.0, close_raises=None,
                 close_hangs=False, close_swallows_cancel=False):
        self.ledger = ledger
        self.name = name or f"s{len(ledger.streams)}"
        self.steps = list(steps)
        self.close_delay = close_delay
        self.close_raises = close_raises
        self.close_hangs = close_hangs
        self.close_swallows_cancel = close_swallows_cancel
        self.close_calls = 0
        self.close_finished = 0
        self.close_interrupted = 0
        self.anext_calls = 0
        self.reads_after_close = 0
        self.reading = False
        self.is_closed = False
        ledger.opened += 1
        ledger.streams.append(self)
        ledger.timeline.append(("open", self.name))

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.is_closed:
            self.reads_after_close += 1
            raise StopAsyncIteration
        self.anext_calls += 1
        self.reading = True
        try:
            if not self.steps:
                raise StopAsyncIteration
            step = self.steps.pop(0)
            if step is HANG:
                await asyncio.Event().wait()
            if isinstance(step, tuple) and step and step[0] == "sleep":
                await asyncio.sleep(step[1])
                step = step[2]
            if isinstance(step, asyncio.Future):
                step = await step
            if isinstance(step, BaseException):
                raise step
            self.ledger.timeline.append(("chunk", self.name))
            return step
        finally:
            self.reading = False

    def _mark_closed(self):
        self.close_calls += 1
        self.ledger.timeline.append(("close", self.name))
        if not self.is_closed:
            self.is_closed = True
            self.ledger.closed += 1

    async def _close(self):
        self._mark_closed()
        if self.close_hangs:
            await asyncio.Event().wait()
        if self.close_delay:
            if self.close_swallows_cancel:
                try:
                    await asyncio.sleep(self.close_delay)
                except BaseException:
                    self.close_interrupted += 1
                    return
            else:
                await asyncio.sleep(self.close_delay)
        self.close_finished += 1
        if self.close_raises is not None:
            raise self.close_raises


class AcloseStream(_Stream):
    async def aclose(self):
        await self._close()


class SyncCloseStream(_Stream):
    def close(self):
        self._mark_closed()


class AsyncCloseStream(_Stream):
    async def close(self):
        await self._close()


class BareStream(_Stream):
    pass


class SyncAcloseStream(_Stream):
    def aclose(self):
        self._mark_closed()


async def settle(rounds: int = 20):
    for _ in range(rounds):
        await asyncio.sleep(0)


def stray_tasks(baseline):
    return {t for t in asyncio.all_tasks()
            if t is not asyncio.current_task() and t not in baseline and not t.done()}


async def assert_clean(ledger, baseline):
    await settle()
    assert stray_tasks(baseline) == set(), "a task is still pending"
    assert ledger.open == 0, f"{ledger.open} stream(s) left open"
    for s in ledger.streams:
        assert s.close_calls == 1, f"{s.name} closed {s.close_calls} times"
        assert not s.reading, f"{s.name} still has a read in flight"
        assert s.reads_after_close == 0, f"{s.name} was read after close"


async def drain(agen, out=None):
    async for c in agen:
        if out is not None:
            out.append(c)


async def take_then_break(agen, n):
    got = []
    async for c in agen:
        got.append(c)
        if len(got) >= n:
            break
    return got


async def wait_until(predicate, limit=3.0):
    deadline = time.monotonic() + limit
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition never became true")
        await asyncio.sleep(0.002)


async def finishes_within(task, seconds):
    done, _ = await asyncio.wait({task}, timeout=seconds)
    return bool(done)


async def reap(task):
    if not task.done():
        task.cancel()
        await asyncio.wait({task}, timeout=3)
    if task.done() and not task.cancelled():
        task.exception()


def chunks(n):
    return [Chunk(i) for i in range(n)]


# ---------- watchdog: healthy pass-through ----------

@bounded()
async def test_healthy_stream_passes_identical_chunks_in_order_and_closes_once():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    sent = chunks(6)
    s = AcloseStream(ledger, list(sent))
    got = []
    await drain(_first_token_guard(s, 1.0, 1.0), got)
    assert got == sent
    assert all(a is b for a, b in zip(got, sent))
    await assert_clean(ledger, baseline)


@bounded()
async def test_first_chunk_reaches_consumer_while_stream_is_still_open():
    ledger = Ledger()
    first = Chunk(0)
    s = AcloseStream(ledger, [first, HANG])
    g = _first_token_guard(s, 1.0, 30.0)
    got = await asyncio.wait_for(g.__anext__(), 0.5)
    assert got is first
    assert s.anext_calls == 1, "watchdog read ahead of its consumer"
    await g.aclose()
    assert s.close_calls == 1


@bounded()
async def test_watchdog_never_reads_ahead_of_its_consumer():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(5))
    g = _first_token_guard(s, 1.0, 1.0)
    for k in range(5):
        c = await g.__anext__()
        assert c.n == k
        assert s.anext_calls == k + 1
        await asyncio.sleep(0.01)
        assert s.anext_calls == k + 1
    await g.aclose()
    assert s.close_calls == 1


@bounded()
async def test_watchdog_adds_no_latency_to_spaced_chunks():
    delay = 0.05
    trials = []
    for _ in range(3):
        ledger = Ledger()
        direct = AcloseStream(ledger, [("sleep", delay, Chunk(i)) for i in range(6)])
        t0 = time.perf_counter()
        async for _ in direct:
            pass
        direct_s = time.perf_counter() - t0
        guarded = AcloseStream(ledger, [("sleep", delay, Chunk(i)) for i in range(6)])
        arrivals = []
        t0 = time.perf_counter()
        async for _ in _first_token_guard(guarded, 1.0, 1.0):
            arrivals.append(time.perf_counter() - t0)
        guarded_s = time.perf_counter() - t0
        gaps = [b - a for a, b in zip([0.0] + arrivals, arrivals)]
        trials.append((guarded_s - direct_s, max(gaps)))
    best_overhead = min(t[0] for t in trials)
    best_gap = min(t[1] for t in trials)
    assert best_overhead < 0.1, trials
    assert best_gap < delay + 0.1, trials


# ---------- watchdog: consumer closes or abandons ----------

@pytest.mark.parametrize("n", [1, 2, 3, 5])
@bounded()
async def test_consumer_close_after_n_chunks_closes_stream_before_returning(n):
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(8))
    g = _first_token_guard(s, 1.0, 1.0)
    for _ in range(n):
        await g.__anext__()
    await g.aclose()
    assert s.close_calls == 1, "stream not closed by the time aclose() returned"
    await assert_clean(ledger, baseline)


@bounded()
async def test_closing_an_unstarted_watchdog_closes_the_stream_it_was_given():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(3))
    g = _first_token_guard(s, 1.0, 1.0)
    await g.aclose()
    await settle()
    assert s.close_calls == 1, "watchdog closed after zero chunks left its stream open"


@bounded()
async def test_consumer_break_then_drop_closes_stream_soon_after():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(8))
    got = await take_then_break(_first_token_guard(s, 1.0, 1.0), 2)
    assert [c.n for c in got] == [0, 1]
    await assert_clean(ledger, baseline)


@pytest.mark.xfail(strict=True, reason="Python never closes an async generator a consumer breaks out of "
                                       "while it still holds a reference; only aclose() or GC does")
@bounded()
async def test_consumer_break_while_holding_reference_closes_stream():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(8))
    g = _first_token_guard(s, 1.0, 1.0)
    async for _ in g:
        break
    await asyncio.sleep(0.1)
    assert s.close_calls == 1
    await g.aclose()


@bounded()
async def test_consumer_exception_inside_aclosing_closes_stream_before_it_escapes():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(5))
    with pytest.raises(ValueError):
        async with aclosing(_first_token_guard(s, 1.0, 1.0)) as g:
            async for c in g:
                if c.n == 2:
                    raise ValueError("consumer bug")
    assert s.close_calls == 1


@bounded()
async def test_consumer_exception_in_plain_loop_closes_stream_once_unwound():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(5))

    async def consumer():
        async for c in _first_token_guard(s, 1.0, 1.0):
            if c.n == 1:
                raise ValueError("consumer bug")

    try:
        await consumer()
    except ValueError:
        pass
    await assert_clean(ledger, baseline)


# ---------- watchdog: cancellation ----------

@bounded()
async def test_cancel_while_waiting_for_first_chunk_propagates_and_closes():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, [HANG])
    t = asyncio.create_task(drain(_first_token_guard(s, 30.0, 30.0)))
    await wait_until(lambda: s.reading)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled(), "CancelledError was swallowed"
    await assert_clean(ledger, baseline)


@bounded()
async def test_cancel_between_chunks_propagates_and_closes():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, [Chunk(0), Chunk(1), HANG])
    got = []
    t = asyncio.create_task(drain(_first_token_guard(s, 30.0, 30.0), got))
    await wait_until(lambda: len(got) == 2 and s.reading)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled(), "CancelledError was swallowed"
    await assert_clean(ledger, baseline)


@bounded()
async def test_cancel_and_chunk_arrival_in_the_same_loop_turn():
    for _ in range(20):
        baseline = set(asyncio.all_tasks())
        ledger = Ledger()
        fut = asyncio.get_running_loop().create_future()
        s = AcloseStream(ledger, [Chunk(0), fut, Chunk(2)])
        got = []
        t = asyncio.create_task(drain(_first_token_guard(s, 30.0, 30.0), got))
        await wait_until(lambda: len(got) == 1 and s.reading)
        fut.set_result(Chunk(1))
        t.cancel()
        await asyncio.wait({t}, timeout=2)
        assert t.cancelled(), "CancelledError was swallowed"
        assert [c.n for c in got] in ([0], [0, 1])
        await assert_clean(ledger, baseline)


@bounded()
async def test_external_cancel_coinciding_with_first_token_deadline_stays_a_cancel():
    loop = asyncio.get_running_loop()
    for _ in range(10):
        baseline = set(asyncio.all_tasks())
        ledger = Ledger()
        s = AcloseStream(ledger, [HANG])
        t = asyncio.create_task(drain(_first_token_guard(s, 0.05, 30.0)))
        await wait_until(lambda: s.reading)
        loop.call_at(loop.time() + 0.05, t.cancel)
        await asyncio.wait({t}, timeout=2)
        assert t.done()
        assert t.cancelled() or isinstance(t.exception(), ProviderStalledError)
        await assert_clean(ledger, baseline)


@bounded()
async def test_cancel_during_stream_close_propagates_and_never_closes_twice():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(4), close_delay=1.0)
    g = _first_token_guard(s, 1.0, 1.0)
    await g.__anext__()
    t = asyncio.create_task(g.aclose())
    await wait_until(lambda: s.close_calls == 1)
    t0 = time.perf_counter()
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled(), "cancel during close was swallowed"
    assert time.perf_counter() - t0 < 0.15
    await g.aclose()
    assert s.close_calls == 1
    await wait_until(lambda: s.close_finished == 1, limit=3.0)
    await assert_clean(ledger, baseline)


# ---------- watchdog: timeouts and errors ----------

@bounded()
async def test_first_token_timeout_raises_unchanged_stall_and_closes():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, [HANG])
    t0 = time.perf_counter()
    with pytest.raises(ProviderStalledError) as info:
        await drain(_first_token_guard(s, 0.1, 30.0))
    elapsed = time.perf_counter() - t0
    assert 0.05 <= elapsed < 1.5, elapsed
    assert str(info.value) == "no first token within 0s"
    assert info.value.timeout == 0.1
    assert isinstance(info.value.__context__, TimeoutError)
    await assert_clean(ledger, baseline)


@bounded()
async def test_idle_timeout_raises_stall_with_idle_value_and_closes():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, [Chunk(0), Chunk(1), HANG])
    got = []
    with pytest.raises(ProviderStalledError) as info:
        await drain(_first_token_guard(s, 30.0, 0.6), got)
    assert [c.n for c in got] == [0, 1]
    assert info.value.timeout == 0.6
    assert str(info.value) == "no first token within 1s"
    await assert_clean(ledger, baseline)


@pytest.mark.parametrize("position", [0, 2])
@bounded()
async def test_provider_error_propagates_unchanged_and_closes(position):
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    boom = ConnectionResetError("peer reset")
    s = AcloseStream(ledger, chunks(position) + [boom, Chunk(99)])
    with pytest.raises(ConnectionResetError) as info:
        await drain(_first_token_guard(s, 1.0, 1.0))
    assert info.value is boom
    await assert_clean(ledger, baseline)


@bounded()
async def test_provider_timeout_error_is_still_reported_as_stall():
    ledger = Ledger()
    s = AcloseStream(ledger, [TimeoutError("read timed out")])
    with pytest.raises(ProviderStalledError):
        await drain(_first_token_guard(s, 7.0, 1.0))
    assert s.close_calls == 1


@bounded()
async def test_empty_stream_ends_and_closes_once():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, [])
    got = []
    await drain(_first_token_guard(s, 1.0, 1.0), got)
    assert got == []
    await assert_clean(ledger, baseline)


@pytest.mark.parametrize("raw_error", [None, RuntimeError("close failed"), OSError("socket gone")])
@bounded()
async def test_double_close_closes_stream_once(raw_error):
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(3), close_raises=raw_error)
    g = _first_token_guard(s, 1.0, 1.0)
    await g.__anext__()
    await g.aclose()
    await g.aclose()
    assert s.close_calls == 1
    s2 = AcloseStream(ledger, chunks(2), close_raises=raw_error)
    g2 = _first_token_guard(s2, 1.0, 1.0)
    await drain(g2)
    await g2.aclose()
    assert s2.close_calls == 1
    s3 = AcloseStream(ledger, [HANG], close_raises=raw_error)
    g3 = _first_token_guard(s3, 0.05, 1.0)
    with pytest.raises(ProviderStalledError):
        await drain(g3)
    await g3.aclose()
    assert s3.close_calls == 1


# ---------- watchdog: zero and tiny timeouts ----------

@pytest.mark.parametrize("timeout", [0, -1.0])
@bounded()
async def test_zero_first_token_timeout_stalls_and_closes_once(timeout):
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(2))
    with pytest.raises(ProviderStalledError):
        await drain(_first_token_guard(s, timeout, 1.0))
    await assert_clean(ledger, baseline)


@bounded()
async def test_zero_idle_timeout_on_async_generator_stream_finalizes_it_once():
    finalized = []

    async def gen():
        try:
            for i in range(3):
                yield Chunk(i)
        finally:
            finalized.append(1)

    g = gen()
    got = []
    with pytest.raises(ProviderStalledError):
        await drain(_first_token_guard(g, 1.0, 0), got)
    await settle()
    assert [c.n for c in got] == [0]
    assert finalized == [1]
    assert inspect.getasyncgenstate(g) == inspect.AGEN_CLOSED


@bounded(20)
async def test_tiny_timeouts_repeatedly_leave_nothing_behind():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    for i in range(100):
        s = AcloseStream(ledger, [HANG] if i % 2 else [Chunk(0), HANG])
        with pytest.raises(ProviderStalledError):
            await drain(_first_token_guard(s, 1e-6 if i % 2 else 1.0, 1e-6))
    await assert_clean(ledger, baseline)


@bounded(20)
async def test_first_chunk_landing_exactly_at_the_deadline_delivers_or_stalls_cleanly():
    loop = asyncio.get_running_loop()
    for _ in range(30):
        baseline = set(asyncio.all_tasks())
        ledger = Ledger()
        fut = loop.create_future()
        s = AcloseStream(ledger, [fut, Chunk(1), Chunk(2)])
        timeout = 0.02
        loop.call_at(loop.time() + timeout, lambda f=fut: f.done() or f.set_result(Chunk(0)))
        got = []
        try:
            await drain(_first_token_guard(s, timeout, 1.0), got)
            assert [c.n for c in got] == [0, 1, 2]
        except ProviderStalledError:
            assert got == []
        await assert_clean(ledger, baseline)


# ---------- watchdog: streams with unusual close methods ----------

@pytest.mark.parametrize("scenario", ["end", "stall", "provider_error", "consumer_close", "cancel"])
@bounded()
async def test_stream_close_raising_never_masks_the_outcome(scenario):
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    close_error = RuntimeError("close blew up")
    boom = ConnectionError("provider failed")
    steps = {
        "end": chunks(2),
        "stall": [Chunk(0), HANG],
        "provider_error": [Chunk(0), boom],
        "consumer_close": chunks(4),
        "cancel": [Chunk(0), HANG],
    }[scenario]
    s = AcloseStream(ledger, steps, close_raises=close_error)
    g = _first_token_guard(s, 1.0, 0.05)
    if scenario == "end":
        await drain(g)
    elif scenario == "stall":
        with pytest.raises(ProviderStalledError):
            await drain(g)
    elif scenario == "provider_error":
        with pytest.raises(ConnectionError) as info:
            await drain(g)
        assert info.value is boom
    elif scenario == "consumer_close":
        await g.__anext__()
        await g.aclose()
    else:
        g = _first_token_guard(s, 1.0, 30.0)
        got = []
        t = asyncio.create_task(drain(g, got))
        await wait_until(lambda: len(got) == 1 and s.reading)
        t.cancel()
        await asyncio.wait({t}, timeout=2)
        assert t.cancelled()
    await assert_clean(ledger, baseline)


@bounded()
async def test_stream_with_only_sync_close_is_closed():
    ledger = Ledger()
    s = SyncCloseStream(ledger, chunks(4))
    g = _first_token_guard(s, 1.0, 1.0)
    await g.__anext__()
    await g.aclose()
    await settle()
    assert s.close_calls == 1, "a stream exposing only close() is never closed"


@bounded()
async def test_stream_with_only_async_close_is_closed():
    ledger = Ledger()
    s = AsyncCloseStream(ledger, [Chunk(0), HANG])
    with pytest.raises(ProviderStalledError):
        await drain(_first_token_guard(s, 1.0, 0.05))
    await settle()
    assert s.close_calls == 1, "a stream exposing only async close() is never closed"


@bounded()
async def test_stream_without_any_close_streams_and_ends_cleanly():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = BareStream(ledger, chunks(3))
    got = []
    await drain(_first_token_guard(s, 1.0, 1.0), got)
    assert [c.n for c in got] == [0, 1, 2]
    s2 = BareStream(ledger, [HANG])
    with pytest.raises(ProviderStalledError):
        await drain(_first_token_guard(s2, 0.05, 1.0))
    await settle()
    assert stray_tasks(baseline) == set()


@bounded()
async def test_stream_with_sync_aclose_method_is_called_once_without_error():
    ledger = Ledger()
    s = SyncAcloseStream(ledger, chunks(2))
    got = []
    await drain(_first_token_guard(s, 1.0, 1.0), got)
    assert len(got) == 2
    assert s.close_calls == 1


@bounded()
async def test_iterator_handed_out_by_aiter_is_closed_with_the_watchdog():
    finalized = []
    closes = []

    class GenBackedStream:
        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            try:
                for i in range(5):
                    yield Chunk(i)
            finally:
                finalized.append(1)

        async def close(self):
            closes.append(1)

    g = _first_token_guard(GenBackedStream(), 1.0, 1.0)
    await g.__anext__()
    await g.aclose()
    assert finalized or closes, "neither the stream nor the iterator it handed out was closed"


@bounded()
async def test_consumer_close_returns_promptly_when_stream_close_hangs():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(4), close_hangs=True)
    g = _first_token_guard(s, 1.0, 1.0)
    await g.__anext__()
    t = asyncio.create_task(g.aclose())
    try:
        assert await finishes_within(t, 1.0), "closing the watchdog hangs forever on a stuck stream close"
    finally:
        await reap(t)


@bounded()
async def test_first_token_timeout_fires_promptly_when_stream_close_hangs():
    ledger = Ledger()
    s = AcloseStream(ledger, [HANG], close_hangs=True)
    t = asyncio.create_task(drain(_first_token_guard(s, 0.1, 1.0)))
    try:
        assert await finishes_within(t, 1.5), "stall error never surfaces while the stream close hangs"
        assert isinstance(t.exception(), ProviderStalledError)
    finally:
        await reap(t)


@bounded()
async def test_cancelled_watchdog_ends_promptly_when_stream_close_hangs():
    ledger = Ledger()
    s = AcloseStream(ledger, [HANG], close_hangs=True)
    t = asyncio.create_task(drain(_first_token_guard(s, 30.0, 30.0)))
    await wait_until(lambda: s.reading)
    t.cancel()
    try:
        assert await finishes_within(t, 1.0), "a cancelled turn never ends while the stream close hangs"
        assert t.cancelled()
    finally:
        await reap(t)


@bounded()
async def test_cancel_landing_during_stream_close_at_normal_end_is_not_swallowed():
    ledger = Ledger()
    s = AcloseStream(ledger, [Chunk(0)], close_delay=0.3, close_swallows_cancel=True)
    progress = []

    async def turn():
        await drain(_first_token_guard(s, 1.0, 1.0))
        progress.append("ran code after the stream")
        await asyncio.sleep(2)
        progress.append("finished")

    t = asyncio.create_task(turn())
    await wait_until(lambda: s.close_calls == 1 or progress)
    t.cancel()
    await asyncio.wait({t}, timeout=5)
    assert t.cancelled(), f"cancel swallowed, the turn kept going: {progress}"


# ---------- watchdog: sync iterators wrapped as async ----------

@bounded()
async def test_sync_iterator_with_future_based_anext():
    loop = asyncio.get_running_loop()

    class FutureIter:
        def __init__(self, items):
            self.it = iter(items)
            self.closed = 0

        def __aiter__(self):
            return self

        def __anext__(self):
            fut = loop.create_future()
            try:
                fut.set_result(next(self.it))
            except StopIteration:
                fut.set_exception(StopAsyncIteration())
            return fut

        async def aclose(self):
            self.closed += 1

    src = FutureIter(chunks(4))
    got = []
    await drain(_first_token_guard(src, 1.0, 1.0), got)
    assert [c.n for c in got] == [0, 1, 2, 3]
    assert src.closed == 1


@bounded()
async def test_sync_generator_read_in_a_thread_is_closed_once():
    end = object()
    state = {"finally": 0}

    def produce():
        try:
            for i in range(6):
                yield Chunk(i)
        finally:
            state["finally"] += 1

    class ThreadIter:
        def __init__(self):
            self.gen = produce()
            self.closes = 0

        def __aiter__(self):
            return self

        async def __anext__(self):
            item = await asyncio.to_thread(next, self.gen, end)
            if item is end:
                raise StopAsyncIteration
            return item

        async def aclose(self):
            self.closes += 1
            self.gen.close()

    src = ThreadIter()
    got = await take_then_break(_first_token_guard(src, 2.0, 2.0), 3)
    assert [c.n for c in got] == [0, 1, 2]
    await settle()
    assert src.closes == 1
    assert state["finally"] == 1


# ---------- watchdog: volume ----------

async def _guard_scenario(kind, ledger, rnd):
    if kind == "healthy":
        s = AcloseStream(ledger, chunks(3))
        await drain(_first_token_guard(s, 1.0, 1.0))
    elif kind == "consumer_close":
        s = AcloseStream(ledger, chunks(5))
        g = _first_token_guard(s, 1.0, 1.0)
        for _ in range(rnd.randint(1, 4)):
            await g.__anext__()
        await g.aclose()
    elif kind == "break_drop":
        s = AcloseStream(ledger, chunks(5))
        await take_then_break(_first_token_guard(s, 1.0, 1.0), rnd.randint(1, 4))
    elif kind in ("cancel_first", "cancel_between"):
        s = AcloseStream(ledger, [HANG] if kind == "cancel_first" else [Chunk(0), HANG])
        t = asyncio.create_task(drain(_first_token_guard(s, 30.0, 30.0)))
        await wait_until(lambda: s.reading and (kind == "cancel_first" or s.anext_calls == 2))
        t.cancel()
        await asyncio.wait({t}, timeout=2)
        assert t.cancelled()
    elif kind == "stall_first":
        s = AcloseStream(ledger, [HANG])
        with pytest.raises(ProviderStalledError):
            await drain(_first_token_guard(s, 0.005, 1.0))
    elif kind == "stall_idle":
        s = AcloseStream(ledger, [Chunk(0), HANG])
        with pytest.raises(ProviderStalledError):
            await drain(_first_token_guard(s, 1.0, 0.005))
    elif kind == "provider_error":
        s = AcloseStream(ledger, [Chunk(0), RuntimeError("boom")])
        with pytest.raises(RuntimeError):
            await drain(_first_token_guard(s, 1.0, 1.0))
    elif kind == "empty":
        s = AcloseStream(ledger, [])
        await drain(_first_token_guard(s, 1.0, 1.0))
    elif kind == "close_raises":
        s = AcloseStream(ledger, chunks(2), close_raises=RuntimeError("close failed"))
        await drain(_first_token_guard(s, 1.0, 1.0))


_GUARD_KINDS = ["healthy", "consumer_close", "break_drop", "cancel_first", "cancel_between",
                "stall_first", "stall_idle", "provider_error", "empty", "close_raises"]


@bounded(60)
async def test_two_hundred_sequential_runs_leave_no_tasks_or_open_streams():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    rnd = random.Random(7)
    for i in range(200):
        await _guard_scenario(_GUARD_KINDS[i % len(_GUARD_KINDS)], ledger, rnd)
    assert len(ledger.streams) == 200
    await assert_clean(ledger, baseline)


@bounded(60)
async def test_two_hundred_concurrent_streams_each_close_once():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    rnd = random.Random(11)
    kinds = [rnd.choice(_GUARD_KINDS) for _ in range(200)]
    results = await asyncio.gather(*(_guard_scenario(k, ledger, rnd) for k in kinds), return_exceptions=True)
    failures = [(k, r) for k, r in zip(kinds, results) if isinstance(r, BaseException)]
    assert failures == []
    assert len(ledger.streams) == 200
    await assert_clean(ledger, baseline)


@bounded()
async def test_garbage_collected_watchdog_with_failing_close_reports_nothing_to_the_loop():
    loop = asyncio.get_running_loop()
    seen = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, ctx: seen.append(ctx))
    try:
        ledger = Ledger()
        s = AcloseStream(ledger, chunks(4), close_raises=RuntimeError("close failed"))
        await take_then_break(_first_token_guard(s, 1.0, 1.0), 1)
        await settle()
        assert s.close_calls == 1
        assert seen == []
    finally:
        loop.set_exception_handler(previous)


# ---------- stream_completion ----------

def text_chunk(text, finish=None):
    delta = types.SimpleNamespace(content=text, tool_calls=None, thinking=None, reasoning_content=None,
                                  reasoning=None, thought=None)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(delta=delta, finish_reason=finish)], usage=None)


def tool_chunk(tool_id, name, args):
    call = types.SimpleNamespace(index=0, id=tool_id, function=types.SimpleNamespace(name=name, arguments=args))
    delta = types.SimpleNamespace(content=None, tool_calls=[call], thinking=None, reasoning_content=None,
                                  reasoning=None, thought=None)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(delta=delta, finish_reason=None)], usage=None)


MESSAGES = [{"role": "user", "content": "hi"}]


@pytest.fixture
def sc(monkeypatch):
    monkeypatch.setattr(provider_mod.config, "get", lambda *a, **k: a[-1] if len(a) >= 3 else None)
    monkeypatch.setattr(provider_mod.config, "get_provider_config", lambda name: None)
    monkeypatch.setattr(provider_mod.config, "get_api_key", lambda name: "sk-test")
    monkeypatch.setattr(reasoning_mod, "discover_model_reasoning_capability",
                        lambda provider, model: types.SimpleNamespace(supported_efforts=[]))
    monkeypatch.setattr(reasoning_mod, "apply_reasoning_to_request", lambda *a, **k: None)
    monkeypatch.setattr(provider_mod, "STREAM_BACKOFF_DELAYS", [0.0, 0.0, 0.0])
    env = types.SimpleNamespace(ledger=Ledger(), pending=[], calls=0, extra_calls=0)

    async def fake_acompletion(**kwargs):
        env.calls += 1
        env.ledger.timeline.append(("acompletion", env.calls))
        if not env.pending:
            env.extra_calls += 1
            raise AssertionError("unexpected extra attempt")
        return env.pending.pop(0)

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    return env


def texts(events):
    return "".join(e.text for e in events if isinstance(e, TextDelta))


async def run_turn(events, **kwargs):
    async for ev in provider_mod.stream_completion(MESSAGES, **kwargs):
        events.append(ev)


def index_of(timeline, entry):
    return timeline.index(entry)


@bounded()
async def test_turn_that_ends_normally_closes_stream_once(sc):
    baseline = set(asyncio.all_tasks())
    s = AcloseStream(sc.ledger, [text_chunk("Hello"), text_chunk(" world", finish="stop")])
    sc.pending.append(s)
    events = []
    await run_turn(events)
    assert texts(events) == "Hello world"
    assert isinstance(events[-1], Done) and events[-1].outcome == "success"
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_consumer_closing_turn_closes_stream_before_aclose_returns(sc):
    baseline = set(asyncio.all_tasks())
    s = AcloseStream(sc.ledger, [text_chunk("a"), text_chunk("b"), HANG])
    sc.pending.append(s)
    agen = provider_mod.stream_completion(MESSAGES)
    async for ev in agen:
        if isinstance(ev, TextDelta):
            break
    await agen.aclose()
    assert s.close_calls == 1, "stream still open after the turn was closed"
    assert sc.calls == 1
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_consumer_closing_turn_while_error_card_is_pending_closes_once(sc):
    baseline = set(asyncio.all_tasks())
    s = AcloseStream(sc.ledger, [text_chunk("a"), RuntimeError("mid-stream reset")])
    sc.pending.append(s)
    agen = provider_mod.stream_completion(MESSAGES)
    seen = 0
    async for ev in agen:
        if isinstance(ev, TextDelta):
            seen += 1
            if seen == 2:
                break
    await agen.aclose()
    assert sc.calls == 1
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_consumer_breaking_and_dropping_turn_closes_stream(sc):
    baseline = set(asyncio.all_tasks())
    s = AcloseStream(sc.ledger, [text_chunk("a"), text_chunk("b"), HANG])
    sc.pending.append(s)

    async def consumer():
        async for ev in provider_mod.stream_completion(MESSAGES):
            if isinstance(ev, TextDelta):
                break

    await consumer()
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_consumer_raising_inside_turn_loop_closes_stream_once_unwound(sc):
    baseline = set(asyncio.all_tasks())
    s = AcloseStream(sc.ledger, [text_chunk("a"), text_chunk("b"), HANG])
    sc.pending.append(s)

    async def consumer():
        async for ev in provider_mod.stream_completion(MESSAGES):
            if isinstance(ev, TextDelta):
                raise ValueError("UI crashed")

    try:
        await consumer()
    except ValueError:
        pass
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_cancel_waiting_for_first_chunk_propagates_without_retry(sc):
    baseline = set(asyncio.all_tasks())
    s = AcloseStream(sc.ledger, [HANG])
    sc.pending.append(s)
    t = asyncio.create_task(run_turn([]))
    await wait_until(lambda: s.reading)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled(), "a cancelled turn did not raise CancelledError"
    await asyncio.sleep(0.05)
    assert sc.calls == 1, "cancellation triggered a retry"
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_cancel_with_open_tool_call_propagates_and_closes(sc):
    baseline = set(asyncio.all_tasks())
    s = AcloseStream(sc.ledger, [tool_chunk("call_1", "read_file", '{"p":'), HANG])
    sc.pending.append(s)
    events = []
    t = asyncio.create_task(run_turn(events))
    await wait_until(lambda: s.anext_calls == 2 and s.reading)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled(), "a cancelled turn did not raise CancelledError"
    assert any(isinstance(e, ToolCallEnd) for e in events)
    assert sc.calls == 1
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_stall_retry_closes_first_stream_before_second_attempt(sc):
    baseline = set(asyncio.all_tasks())
    s1 = AcloseStream(sc.ledger, [HANG], name="s1")
    s2 = AcloseStream(sc.ledger, [text_chunk("fresh"), text_chunk("!", finish="stop")], name="s2")
    sc.pending.extend([s1, s2])
    events = []
    await run_turn(events, first_token_timeout=0.1)
    assert sc.calls == 2
    assert texts(events) == "fresh!"
    tl = sc.ledger.timeline
    assert index_of(tl, ("close", "s1")) < index_of(tl, ("acompletion", 2))
    assert s1.anext_calls == 1 and s2.anext_calls >= 2
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_provider_error_before_content_retries_on_a_fresh_stream(sc):
    baseline = set(asyncio.all_tasks())
    s1 = AcloseStream(sc.ledger, [ConnectionResetError("upstream reset")], name="s1")
    s2 = AcloseStream(sc.ledger, [text_chunk("ok", finish="stop")], name="s2")
    sc.pending.extend([s1, s2])
    events = []
    await run_turn(events)
    assert texts(events) == "ok"
    tl = sc.ledger.timeline
    assert index_of(tl, ("close", "s1")) < index_of(tl, ("acompletion", 2))
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_every_attempt_failing_closes_each_stream_before_the_next(sc):
    baseline = set(asyncio.all_tasks())
    streams = [AcloseStream(sc.ledger, [HANG], name=f"a{i}") for i in range(4)]
    sc.pending.extend(streams)
    events = []
    await run_turn(events, first_token_timeout=0.05)
    assert sc.calls == 4 and sc.extra_calls == 0
    assert isinstance(events[-1], Done) and events[-1].outcome == "error"
    tl = sc.ledger.timeline
    for i in range(3):
        assert index_of(tl, ("close", f"a{i}")) < index_of(tl, ("acompletion", i + 2))
    for s in streams:
        assert s.anext_calls == 1
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_error_after_content_does_not_retry_and_closes(sc):
    baseline = set(asyncio.all_tasks())
    s = AcloseStream(sc.ledger, [text_chunk("partial"), ConnectionResetError("reset")])
    sc.pending.append(s)
    events = []
    await run_turn(events)
    assert sc.calls == 1
    assert isinstance(events[-1], Done) and events[-1].outcome == "error"
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_idle_stall_after_content_closes_without_retry(sc, monkeypatch):
    baseline = set(asyncio.all_tasks())
    monkeypatch.setattr(provider_mod._first_token_guard, "__defaults__", (0.1,))
    s = AcloseStream(sc.ledger, [text_chunk("partial"), HANG])
    sc.pending.append(s)
    events = []
    await run_turn(events, first_token_timeout=5.0)
    assert sc.calls == 1
    assert isinstance(events[-1], Done) and events[-1].outcome == "error"
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_cancel_during_retry_backoff_propagates_with_first_stream_closed(sc, monkeypatch):
    baseline = set(asyncio.all_tasks())
    monkeypatch.setattr(provider_mod, "STREAM_BACKOFF_DELAYS", [5.0, 5.0, 5.0])
    s1 = AcloseStream(sc.ledger, [HANG], name="s1")
    sc.pending.append(s1)
    t = asyncio.create_task(run_turn([], first_token_timeout=0.05))
    await wait_until(lambda: s1.close_calls == 1)
    await asyncio.sleep(0.05)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled()
    assert sc.calls == 1
    await assert_clean(sc.ledger, baseline)


@bounded()
async def test_cancelled_turn_ends_promptly_when_stream_close_hangs(sc):
    s = AcloseStream(sc.ledger, [HANG], close_hangs=True)
    sc.pending.append(s)
    t = asyncio.create_task(run_turn([]))
    await wait_until(lambda: s.reading)
    t.cancel()
    try:
        assert await finishes_within(t, 1.0), "a cancelled turn never ends while the stream close hangs"
        assert t.cancelled()
    finally:
        await reap(t)


@bounded()
async def test_cancel_landing_during_close_at_turn_end_is_not_swallowed(sc):
    s = AcloseStream(sc.ledger, [text_chunk("done", finish="stop")], close_delay=0.3, close_swallows_cancel=True)
    sc.pending.append(s)
    progress = []

    async def agent_turn():
        await run_turn([])
        progress.append("ran tools after the reply")
        await asyncio.sleep(2)
        progress.append("finished")

    t = asyncio.create_task(agent_turn())
    await wait_until(lambda: s.close_calls == 1 or progress)
    t.cancel()
    await asyncio.wait({t}, timeout=5)
    assert t.cancelled(), f"cancel swallowed, the turn kept going: {progress}"


async def _turn_scenario(kind, sc, rnd):
    ledger = sc.ledger
    if kind == "healthy":
        sc.pending.append(AcloseStream(ledger, [text_chunk("x", finish="stop")]))
        await run_turn([])
    elif kind == "consumer_close":
        sc.pending.append(AcloseStream(ledger, [text_chunk("a"), text_chunk("b"), HANG]))
        agen = provider_mod.stream_completion(MESSAGES)
        async for ev in agen:
            if isinstance(ev, TextDelta):
                break
        await agen.aclose()
    elif kind == "cancel":
        s = AcloseStream(ledger, [text_chunk("a"), HANG] if rnd.random() < 0.5 else [HANG])
        sc.pending.append(s)
        t = asyncio.create_task(run_turn([]))
        await wait_until(lambda: s.reading)
        t.cancel()
        await asyncio.wait({t}, timeout=2)
        assert t.cancelled()
    elif kind == "stall_retry":
        sc.pending.extend([AcloseStream(ledger, [HANG]), AcloseStream(ledger, [text_chunk("y", finish="stop")])])
        events = []
        await run_turn(events, first_token_timeout=0.005)
        assert texts(events) == "y"
    elif kind == "error_after_content":
        sc.pending.append(AcloseStream(ledger, [text_chunk("p"), RuntimeError("reset")]))
        await run_turn([])


@bounded(90)
async def test_two_hundred_turns_leave_no_tasks_or_open_streams(sc):
    baseline = set(asyncio.all_tasks())
    rnd = random.Random(3)
    kinds = ["healthy", "consumer_close", "cancel", "stall_retry", "error_after_content"]
    for i in range(200):
        await _turn_scenario(kinds[i % len(kinds)], sc, rnd)
    assert sc.pending == [] and sc.extra_calls == 0
    await assert_clean(sc.ledger, baseline)


# ---------- bounded close: abandonment ----------

class StuckCloseStream(_Stream):
    def __init__(self, ledger, steps=(), *, referenced=True, give_up_after=3.0, **kwargs):
        super().__init__(ledger, steps, **kwargs)
        self.referenced = referenced
        self.released = False
        self.deadline = time.monotonic() + give_up_after

    def _done(self):
        return self.released or time.monotonic() >= self.deadline

    async def aclose(self):
        self._mark_closed()
        loop = asyncio.get_running_loop()
        while not self._done():
            try:
                if self.referenced:
                    await asyncio.sleep(0.05)
                else:
                    await loop.create_future()
            except asyncio.CancelledError:
                if self._done():
                    raise
        self.close_finished += 1


async def _rescue(stream, task, after):
    await asyncio.sleep(after)
    stream.released = True
    task.cancel()


class capture_loop_errors:
    def __enter__(self):
        self.loop = asyncio.get_running_loop()
        self.previous = self.loop.get_exception_handler()
        self.messages = []
        self.loop.set_exception_handler(lambda _loop, ctx: self.messages.append(str(ctx.get("message"))))
        return self.messages

    def __exit__(self, *exc):
        self.loop.set_exception_handler(self.previous)


@bounded()
async def test_abandoned_hanging_close_returns_within_bound_and_leaves_nothing(monkeypatch):
    monkeypatch.setattr(provider_mod, "ABANDONED_CLOSE_LIMIT", 1.0, raising=False)
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_hangs=True)
    with capture_loop_errors() as errors:
        t0 = time.perf_counter()
        await drain(_first_token_guard(s, 1.0, 1.0))
        elapsed = time.perf_counter() - t0
        await asyncio.sleep(0.8)
        await settle()
        gc.collect()
        await settle()
    assert 0.3 <= elapsed < 1.0, elapsed
    assert stray_tasks(baseline) == set()
    assert errors == []


@bounded()
async def test_abandoned_close_that_ignores_cancel_is_not_destroyed_while_pending():
    ledger = Ledger()
    s = StuckCloseStream(ledger, chunks(1), referenced=False)
    rescue = asyncio.create_task(_rescue(s, asyncio.current_task(), 4.0))
    try:
        with capture_loop_errors() as errors:
            await drain(_first_token_guard(s, 1.0, 1.0))
            await settle()
            gc.collect()
            await settle()
        assert not any("destroyed but it is pending" in m for m in errors), errors
    finally:
        s.released = True
        rescue.cancel()


@pytest.mark.xfail(strict=True, reason="a close that ignores cancellation cannot be stopped; its task outlives the turn")
@bounded()
async def test_abandoned_close_that_ignores_cancel_leaves_no_task_behind():
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = StuckCloseStream(ledger, chunks(1), referenced=True)
    rescue = asyncio.create_task(_rescue(s, asyncio.current_task(), 4.0))
    baseline.add(rescue)
    try:
        await drain(_first_token_guard(s, 1.0, 1.0))
        await asyncio.sleep(0.3)
        assert stray_tasks(baseline) == set()
    finally:
        s.released = True
        rescue.cancel()
        await asyncio.sleep(0.15)


@bounded()
async def test_close_slower_than_the_bound_does_not_hold_the_turn():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_delay=0.8)
    t0 = time.perf_counter()
    await drain(_first_token_guard(s, 1.0, 1.0))
    assert time.perf_counter() - t0 < 0.75


@bounded()
async def test_close_slower_than_the_bound_is_abandoned_not_cut_short():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_delay=0.8)
    await drain(_first_token_guard(s, 1.0, 1.0))
    await asyncio.sleep(0.7)
    assert s.close_finished == 1, "the abandoned close was cancelled at the bound and never finished"


# ---------- bounded close: Stop at every point ----------

@bounded()
async def test_stop_during_stream_close_returns_promptly():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_delay=0.3)
    t = asyncio.create_task(drain(_first_token_guard(s, 1.0, 1.0)))
    await wait_until(lambda: s.close_calls == 1)
    t0 = time.perf_counter()
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled(), "Stop during the close was swallowed"
    assert time.perf_counter() - t0 < 0.15


@bounded()
async def test_stop_during_stream_close_interrupts_only_the_wait():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_delay=0.25)
    t = asyncio.create_task(drain(_first_token_guard(s, 1.0, 1.0)))
    await wait_until(lambda: s.close_calls == 1)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    await asyncio.sleep(0.45)
    assert s.close_finished == 1, "Stop cancelled the stream close itself, not only the wait for it"


@bounded()
async def test_cancel_during_read_lets_close_finish_before_propagating():
    ledger = Ledger()
    s = AcloseStream(ledger, [Chunk(0), HANG], close_delay=0.1)
    finished_at_end = []

    async def turn():
        try:
            await drain(_first_token_guard(s, 30.0, 30.0))
        finally:
            finished_at_end.append(s.close_finished)

    t = asyncio.create_task(turn())
    await wait_until(lambda: s.anext_calls == 2 and s.reading)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled()
    assert finished_at_end == [1]


@bounded()
async def test_second_cancel_during_close_after_first_cancel_propagates_promptly():
    ledger = Ledger()
    s = AcloseStream(ledger, [HANG], close_delay=1.0)
    t = asyncio.create_task(drain(_first_token_guard(s, 30.0, 30.0)))
    await wait_until(lambda: s.reading)
    t.cancel()
    await wait_until(lambda: s.close_calls == 1)
    t0 = time.perf_counter()
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled()
    assert time.perf_counter() - t0 < 0.15


@bounded()
async def test_cancel_issued_from_inside_the_close_reaches_the_turn():
    holder = {}

    class CancellingClose(_Stream):
        def close(self):
            self._mark_closed()
            holder["task"].cancel()

    for _ in range(10):
        ledger = Ledger()
        s = CancellingClose(ledger, chunks(2))
        t = asyncio.create_task(drain(_first_token_guard(s, 1.0, 1.0)))
        holder["task"] = t
        await asyncio.wait({t}, timeout=2)
        assert t.cancelled(), "a cancel landing as the close finished was lost"
        assert s.close_calls == 1


@bounded()
async def test_cancel_just_after_abandonment_propagates():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_hangs=True)
    progress = []

    async def turn():
        await drain(_first_token_guard(s, 1.0, 1.0))
        progress.append("stream done")
        await asyncio.sleep(2)

    t = asyncio.create_task(turn())
    await wait_until(lambda: progress)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled()


@bounded()
async def test_cancel_while_closing_an_unstarted_guard_propagates_promptly():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(2), close_delay=1.0)
    g = _first_token_guard(s, 1.0, 1.0)
    t = asyncio.create_task(g.aclose())
    await wait_until(lambda: s.close_calls == 1)
    t0 = time.perf_counter()
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled()
    assert time.perf_counter() - t0 < 0.15
    await g.aclose()
    assert s.close_calls == 1


@bounded()
async def test_guard_read_cancelled_before_it_starts_still_closes_stream():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(2))
    g = _first_token_guard(s, 1.0, 1.0)
    read = asyncio.ensure_future(g.__anext__())
    read.cancel()
    await asyncio.wait({read}, timeout=2)
    await g.aclose()
    await settle()
    assert s.close_calls == 1, "a read cancelled before it ran left the stream open after aclose()"


class _SplitIter:
    def __init__(self, owner):
        self.owner = owner
        self.n = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.n >= 2:
            raise StopAsyncIteration
        self.n += 1
        return Chunk(self.n)

    async def aclose(self):
        self.owner.iter_closes += 1
        if self.owner.iter_close_hangs:
            await asyncio.Event().wait()
        if self.owner.iter_close_delay:
            await asyncio.sleep(self.owner.iter_close_delay)


class _SplitStream:
    def __init__(self, iter_close_hangs=False, iter_close_delay=0.0):
        self.iter_close_hangs = iter_close_hangs
        self.iter_close_delay = iter_close_delay
        self.iter_closes = 0
        self.stream_closes = 0

    def __aiter__(self):
        return _SplitIter(self)

    async def aclose(self):
        self.stream_closes += 1


@bounded()
async def test_stream_is_closed_even_when_its_iterator_close_hangs():
    s = _SplitStream(iter_close_hangs=True)
    await drain(_first_token_guard(s, 1.0, 1.0))
    await settle()
    assert s.iter_closes == 1
    assert s.stream_closes == 1, "a stuck iterator close kept the stream's own close from running"


@bounded()
async def test_stream_is_closed_even_when_stop_lands_during_its_iterator_close():
    s = _SplitStream(iter_close_delay=0.3)
    t = asyncio.create_task(drain(_first_token_guard(s, 1.0, 1.0)))
    await wait_until(lambda: s.iter_closes == 1)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    await asyncio.sleep(0.5)
    assert s.stream_closes == 1, "Stop during the iterator close skipped the stream's own close"


CORRELATION = contextvars.ContextVar("correlation", default=None)


class CorrelatedStream(AcloseStream):
    async def __anext__(self):
        CORRELATION.set("call-1")
        return await super().__anext__()

    async def aclose(self):
        await super().aclose()
        CORRELATION.set(None)


@bounded()
async def test_stream_close_restores_context_in_the_consuming_task():
    ledger = Ledger()
    s = CorrelatedStream(ledger, chunks(3))
    g = _first_token_guard(s, 1.0, 1.0)
    await g.__anext__()
    assert CORRELATION.get() == "call-1"
    await g.aclose()
    assert s.close_calls == 1
    assert CORRELATION.get() is None, "the stream's close ran in another context; its restore never reached the turn"


@bounded()
async def test_none_idle_timeout_means_no_idle_limit():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(3))
    got = []
    await drain(_first_token_guard(s, 1.0, None), got)
    assert len(got) == 3


@bounded()
async def test_chunk_and_cancel_arriving_together_never_drop_the_cancel():
    loop = asyncio.get_running_loop()
    for i in range(30):
        ledger = Ledger()
        fut = loop.create_future()
        s = AcloseStream(ledger, [fut, Chunk(1)])
        got = []
        t = asyncio.create_task(drain(_first_token_guard(s, 30.0 if i % 2 else 0.05, 30.0), got))
        await wait_until(lambda: s.reading)
        if i % 2:
            fut.set_result(Chunk(0))
            t.cancel()
        else:
            loop.call_at(loop.time() + 0.05, lambda f=fut: f.done() or f.set_result(Chunk(0)))
            loop.call_at(loop.time() + 0.05, t.cancel)
        await asyncio.wait({t}, timeout=2)
        assert t.done()
        assert t.cancelled() or isinstance(t.exception(), ProviderStalledError), "cancel was dropped"


# ---------- stream_completion with the bounded close ----------

@bounded()
async def test_cancel_during_failed_attempt_close_does_not_retry(sc):
    s1 = AcloseStream(sc.ledger, [HANG], name="s1", close_delay=0.3)
    sc.pending.append(AcloseStream(sc.ledger, [text_chunk("never")], name="s2"))
    sc.pending.insert(0, s1)
    t = asyncio.create_task(run_turn([], first_token_timeout=0.05))
    await wait_until(lambda: s1.close_calls == 1)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled()
    await asyncio.sleep(0.1)
    assert sc.calls == 1, "a Stop during the failed attempt's close still started a retry"


@bounded()
async def test_stop_while_consumer_closes_turn_propagates_promptly(sc):
    s = AcloseStream(sc.ledger, [text_chunk("a"), HANG], close_delay=0.4)
    sc.pending.append(s)

    async def consumer():
        agen = provider_mod.stream_completion(MESSAGES)
        async for ev in agen:
            if isinstance(ev, TextDelta):
                break
        await agen.aclose()

    t = asyncio.create_task(consumer())
    await wait_until(lambda: s.close_calls == 1)
    t0 = time.perf_counter()
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled()
    assert time.perf_counter() - t0 < 0.15


@bounded()
async def test_closing_turn_is_bounded_when_stream_close_hangs(sc):
    s = AcloseStream(sc.ledger, [text_chunk("a"), HANG], close_hangs=True)
    sc.pending.append(s)
    agen = provider_mod.stream_completion(MESSAGES)
    async for ev in agen:
        if isinstance(ev, TextDelta):
            break
    t0 = time.perf_counter()
    await agen.aclose()
    assert time.perf_counter() - t0 < 1.0


@bounded()
async def test_stalled_attempt_with_hanging_close_still_retries_within_bound(sc):
    s1 = AcloseStream(sc.ledger, [HANG], name="s1", close_hangs=True)
    s2 = AcloseStream(sc.ledger, [text_chunk("ok", finish="stop")], name="s2")
    sc.pending.extend([s1, s2])
    events = []
    t0 = time.perf_counter()
    await run_turn(events, first_token_timeout=0.05)
    assert texts(events) == "ok"
    assert time.perf_counter() - t0 < 1.5


# ---------- agent loops with aclosing ----------

def _project(events):
    keep = (TextDelta, ThinkingDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done)
    out = []
    for e in events:
        name = type(e).__name__
        if isinstance(e, keep):
            out.append((name, getattr(e, "text", None), getattr(e, "tool_id", None),
                        getattr(e, "tool_name", None), getattr(e, "args_json_chunk", None),
                        getattr(e, "outcome", None)))
        else:
            out.append((name,))
    return out


def _messages(session):
    return [(m.get("role"), m.get("content") if m.get("role") != "system" else "<system>",
             [(c["id"], c["function"]["name"], c["function"]["arguments"]) for c in m.get("tool_calls") or []],
             m.get("tool_call_id")) for m in session.messages]


AGENT_TOOL_TURN_EVENTS = [('LLMCallStart',), ('TextDelta', 'Let me look. ', None, None, None, None), ('ToolCallStart', None, 'tc_a', 'list_dir', None, None), ('ToolCallDelta', None, 'tc_a', None, '{"path":', None), ('ToolCallDelta', None, 'tc_a', None, '"."}', None), ('ToolCallEnd', None, 'tc_a', None, None, None), ('LLMCallEnd',), ('ToolResult',), ('LLMCallStart',), ('ThinkingDelta', 'hmm', None, None, None, None), ('TextDelta', 'Done.', None, None, None, None), ('LLMCallEnd',), ('Done', None, None, None, None, 'success')]
AGENT_TOOL_TURN_MESSAGES = [('system', '<system>', [], None), ('user', 'list files', [], None), ('assistant', 'Let me look. ', [('tc_a', 'list_dir', '{"path":"."}')], None), ('tool', '[DRY RUN] Would execute list_dir({\n  "path": "."\n})', [], 'tc_a'), ('assistant', 'Done.', [], None)]
AGENT_ERROR_TURN_EVENTS = [('LLMCallStart',), ('TextDelta', 'partial ', None, None, None, None), ('TextDelta', '<div class="andromity-error-card">x</div>', None, None, None, None), ('LLMCallEnd',), ('Done', None, None, None, None, 'error')]
AGENT_UNCLOSED_TOOL_EVENTS = [('LLMCallStart',), ('ToolCallStart', None, 'tc_u', 'list_dir', None, None), ('ToolCallDelta', None, 'tc_u', None, '{"path":"."}', None), ('LLMCallEnd',), ('ToolResult',), ('LLMCallStart',), ('TextDelta', 'ok', None, None, None, None), ('LLMCallEnd',), ('Done', None, None, None, None, 'success')]


def _scripted(scripts, closed):
    calls = {"n": 0}

    async def mock_stream(messages, tools=None, **kwargs):
        calls["n"] += 1
        n = calls["n"]
        try:
            for ev in scripts[n - 1]:
                if ev is HANG:
                    await asyncio.Event().wait()
                yield ev
        finally:
            closed.append(n)

    return mock_stream, calls


@bounded(30)
async def test_agent_tool_then_text_turn_is_unchanged(tmp_path):
    session = Session(name="t", project_path=str(tmp_path))
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)
    closed = []
    mock_stream, calls = _scripted([
        [TextDelta(text="Let me look. "), ToolCallStart(tool_name="list_dir", tool_id="tc_a"),
         ToolCallDelta(tool_id="tc_a", args_json_chunk='{"path":'), ToolCallDelta(tool_id="tc_a", args_json_chunk='"."}'),
         ToolCallEnd(tool_id="tc_a"), Done(usage={"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14})],
        [ThinkingDelta(text="hmm"), TextDelta(text="Done."),
         Done(usage={"prompt_tokens": 20, "completion_tokens": 2, "total_tokens": 22})],
    ], closed)
    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        events = [e async for e in agent.run("list files")]
    assert calls["n"] == 2 and closed == [1, 2]
    assert _project(events) == AGENT_TOOL_TURN_EVENTS
    assert _messages(session) == AGENT_TOOL_TURN_MESSAGES


@bounded(30)
async def test_agent_error_turn_is_unchanged(tmp_path):
    session = Session(name="t", project_path=str(tmp_path))
    agent = Agent(session, profile="builder", auto_approve=True)
    closed = []
    mock_stream, calls = _scripted([
        [TextDelta(text="partial "), TextDelta(text='<div class="andromity-error-card">x</div>'),
         Done(outcome="error", error_type="provider_overloaded")],
    ], closed)
    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        events = [e async for e in agent.run("hello")]
    assert calls["n"] == 1 and closed == [1]
    assert _project(events) == AGENT_ERROR_TURN_EVENTS


@bounded(30)
async def test_agent_unclosed_tool_call_is_flushed_as_before(tmp_path):
    session = Session(name="t", project_path=str(tmp_path))
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)
    closed = []
    mock_stream, calls = _scripted([
        [ToolCallStart(tool_name="list_dir", tool_id="tc_u"), ToolCallDelta(tool_id="tc_u", args_json_chunk='{"path":"."}'),
         Done()],
        [TextDelta(text="ok"), Done()],
    ], closed)
    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        events = [e async for e in agent.run("go")]
    assert calls["n"] == 2 and closed == [1, 2]
    assert _project(events) == AGENT_UNCLOSED_TOOL_EVENTS


@bounded(30)
async def test_agent_inner_loop_stopping_early_closes_stream_immediately(tmp_path):
    session = Session(name="t", project_path=str(tmp_path))
    agent = Agent(session, profile="builder", auto_approve=True)
    closed = []
    mock_stream, _ = _scripted([[TextDelta(text="a"), TextDelta(text="b"), HANG]], closed)
    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        agen = agent._run("hi", None, None)
        async for ev in agen:
            if isinstance(ev, TextDelta):
                break
        await agen.aclose()
        assert closed == [1], "the provider stream outlived the closed turn loop"


@bounded(30)
async def test_agent_run_consumer_stopping_early_closes_stream_immediately(tmp_path):
    session = Session(name="t", project_path=str(tmp_path))
    agent = Agent(session, profile="builder", auto_approve=True)
    closed = []
    mock_stream, _ = _scripted([[TextDelta(text="a"), TextDelta(text="b"), HANG]], closed)
    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        agen = agent.run("hi")
        async for ev in agen:
            if isinstance(ev, TextDelta):
                break
        await agen.aclose()
        immediately = list(closed)
        await settle()
    assert immediately == [1], f"agent.run() closed, provider stream still open (closed later by GC: {closed})"


@bounded(30)
async def test_agent_cancelled_turn_closes_stream_and_propagates(tmp_path):
    session = Session(name="t", project_path=str(tmp_path))
    agent = Agent(session, profile="builder", auto_approve=True)
    closed = []
    mock_stream, _ = _scripted([[TextDelta(text="a"), HANG]], closed)
    seen = []

    async def consumer():
        async for ev in agent.run("hi"):
            seen.append(ev)

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        t = asyncio.create_task(consumer())
        await wait_until(lambda: any(isinstance(e, TextDelta) for e in seen))
        await asyncio.sleep(0.02)
        t.cancel()
        await asyncio.wait({t}, timeout=5)
    assert t.cancelled()
    assert closed == [1]


# ---------- closes left running after the wait ----------

def closing_tasks():
    loop = asyncio.get_running_loop()
    return {task for task in getattr(provider_mod, "_closing_tasks", set()) if task.get_loop() is loop}


@bounded()
async def test_abandoned_close_finishing_late_completes_and_is_released():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_delay=0.8)
    with capture_loop_errors() as errors:
        t0 = time.perf_counter()
        await drain(_first_token_guard(s, 1.0, 1.0))
        assert time.perf_counter() - t0 < 0.75
        assert s.close_finished == 0
        await wait_until(lambda: s.close_finished == 1, limit=2.0)
        await settle()
    assert closing_tasks() == set()
    assert errors == []


@bounded()
async def test_abandoned_close_failing_late_reports_nothing_to_the_loop():
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_delay=0.7, close_raises=RuntimeError("socket reset late"))
    with capture_loop_errors() as errors:
        await drain(_first_token_guard(s, 1.0, 1.0))
        await wait_until(lambda: s.close_finished == 1, limit=2.0)
        await settle()
        gc.collect()
        await settle()
    assert closing_tasks() == set()
    assert errors == []


@bounded()
async def test_abandoned_close_changing_context_late_keeps_its_changes_to_itself():
    ledger = Ledger()
    s = CorrelatedStream(ledger, chunks(2), close_delay=0.8)
    g = _first_token_guard(s, 1.0, 1.0)
    await g.__anext__()
    assert CORRELATION.get() == "call-1"
    await g.aclose()
    assert CORRELATION.get() == "call-1"
    await wait_until(lambda: s.close_finished == 1, limit=2.0)
    await settle()
    assert CORRELATION.get() == "call-1"


@bounded()
async def test_close_finishing_in_time_with_context_change_reaches_the_turn():
    ledger = Ledger()
    s = CorrelatedStream(ledger, chunks(2), close_delay=0.1)
    g = _first_token_guard(s, 1.0, 1.0)
    await g.__anext__()
    await g.aclose()
    assert CORRELATION.get() is None


TOKEN_VAR = contextvars.ContextVar("token_var", default="outer")


class TokenResetStream(AcloseStream):
    async def __anext__(self):
        if not hasattr(self, "token"):
            self.token = TOKEN_VAR.set("inner")
        return await super().__anext__()

    async def aclose(self):
        await super().aclose()
        TOKEN_VAR.reset(self.token)


@pytest.mark.xfail(strict=True, reason="the close runs in its own task so a Stop cannot cut it short; a "
                                       "ContextVar.reset(token) with a token from the turn's context cannot work "
                                       "across that boundary (LiteLLM restores with plain set(), which is carried back)")
@bounded()
async def test_close_that_resets_a_context_token_restores_the_turn():
    ledger = Ledger()
    s = TokenResetStream(ledger, chunks(3))
    g = _first_token_guard(s, 1.0, 1.0)
    await g.__anext__()
    assert TOKEN_VAR.get() == "inner"
    await g.aclose()
    assert TOKEN_VAR.get() == "outer", "a close that resets its own token no longer restores the turn"


ITER_VAR = contextvars.ContextVar("iter_var", default=None)
STREAM_VAR = contextvars.ContextVar("stream_var", default=None)


class _CtxSplitIter(_SplitIter):
    async def aclose(self):
        await super().aclose()
        ITER_VAR.set("iterator closed")


class _CtxSplitStream(_SplitStream):
    def __aiter__(self):
        return _CtxSplitIter(self)

    async def aclose(self):
        await super().aclose()
        STREAM_VAR.set("stream closed")


@bounded()
async def test_both_closes_finishing_in_time_both_reach_the_turn():
    s = _CtxSplitStream()
    await drain(_first_token_guard(s, 1.0, 1.0))
    assert (s.iter_closes, s.stream_closes) == (1, 1)
    assert (ITER_VAR.get(), STREAM_VAR.get()) == ("iterator closed", "stream closed")


@bounded()
async def test_one_close_left_running_keeps_both_changes_out_of_the_turn():
    s = _CtxSplitStream(iter_close_delay=0.8)
    await drain(_first_token_guard(s, 1.0, 1.0))
    assert s.stream_closes == 1
    assert (ITER_VAR.get(), STREAM_VAR.get()) == (None, None)
    await asyncio.sleep(0.5)
    assert (ITER_VAR.get(), STREAM_VAR.get()) == (None, None)


@bounded()
async def test_close_still_running_at_the_limit_is_cancelled(monkeypatch):
    monkeypatch.setattr(provider_mod, "ABANDONED_CLOSE_LIMIT", 0.8, raising=False)
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    s = AcloseStream(ledger, chunks(1), close_delay=5.0)
    with capture_loop_errors() as errors:
        await drain(_first_token_guard(s, 1.0, 1.0))
        assert closing_tasks() != set()
        await asyncio.sleep(0.6)
        await settle()
        gc.collect()
        await settle()
    assert s.close_finished == 0
    assert closing_tasks() == set()
    assert stray_tasks(baseline) == set()
    assert errors == []


@bounded()
async def test_close_ignoring_the_limit_cancel_is_released_once_it_ends(monkeypatch):
    monkeypatch.setattr(provider_mod, "ABANDONED_CLOSE_LIMIT", 0.7, raising=False)
    ledger = Ledger()
    s = StuckCloseStream(ledger, chunks(1), referenced=False, give_up_after=5.0)
    rescue = asyncio.create_task(_rescue(s, asyncio.current_task(), 6.0))
    try:
        with capture_loop_errors() as errors:
            await drain(_first_token_guard(s, 1.0, 1.0))
            await asyncio.sleep(0.5)
            gc.collect()
            await settle()
            assert len(closing_tasks()) == 1
            assert errors == []
            s.released = True
            for task in closing_tasks():
                task.cancel()
            await settle()
        assert closing_tasks() == set()
        assert errors == []
    finally:
        s.released = True
        rescue.cancel()


@bounded(30)
async def test_two_hundred_abandoned_closes_are_all_released(monkeypatch):
    monkeypatch.setattr(provider_mod, "ABANDONED_CLOSE_LIMIT", 3.5, raising=False)
    baseline = set(asyncio.all_tasks())
    ledger = Ledger()
    streams = []
    for i in range(200):
        if i % 2:
            streams.append(AcloseStream(ledger, chunks(1), close_hangs=True))
        else:
            streams.append(AcloseStream(ledger, chunks(1), close_delay=2.5))
    with capture_loop_errors() as errors:
        t0 = time.perf_counter()
        await asyncio.gather(*(drain(_first_token_guard(s, 1.0, 1.0)) for s in streams))
        assert time.perf_counter() - t0 < 2.5
        still_closing = closing_tasks()
        assert len(still_closing) >= 100
        assert len(still_closing) == sum(1 for s in streams if s.close_finished == 0)
        await wait_until(lambda: not closing_tasks(), limit=8.0)
        await settle()
        gc.collect()
        await settle()
    assert sum(s.close_finished for s in streams) == 100
    assert stray_tasks(baseline) == set()
    assert errors == []


@bounded(30)
async def test_closes_finishing_in_time_never_accumulate_references():
    ledger = Ledger()
    for _ in range(300):
        s = AcloseStream(ledger, chunks(1), close_delay=0.0)
        await drain(_first_token_guard(s, 1.0, 1.0))
        assert closing_tasks() == set()
    assert ledger.open == 0


@bounded()
async def test_no_first_token_limit_lets_a_provider_timeout_through_as_its_own_error():
    ledger = Ledger()
    s = AcloseStream(ledger, [TimeoutError("read timed out")])
    with pytest.raises((TimeoutError, ProviderStalledError)) as info:
        await drain(_first_token_guard(s, None, None))
    assert not isinstance(info.value, TypeError)
    assert s.close_calls == 1


# ---------- caller loops: CLI, RPC and TUI ----------

class FakeAgent:
    def __init__(self, events, hang=False):
        self.events = events
        self.hang = hang
        self.closed = []

    async def run(self, prompt, **kwargs):
        try:
            for ev in self.events:
                yield ev
            if self.hang:
                await asyncio.Event().wait()
        finally:
            self.closed.append(prompt)


@bounded()
async def test_cli_loop_prints_the_same_output(capsys):
    from andromity.cli import _stream_cli_events
    from andromity.core.events import ToolResult
    agent = FakeAgent([
        TextDelta(text="Hello "), ToolCallStart(tool_name="read_file", tool_id="c1"),
        ToolCallDelta(tool_id="c1", args_json_chunk='{"path": "a.py", "n": 3}'), ToolCallEnd(tool_id="c1"),
        ToolResult(tool_id="c1", result="Error executing read_file: nope\nmore", duration_ms=12.4, success=False, ts=0.0),
        TextDelta(text="bye"), Done(),
    ])
    pending = {}
    await _stream_cli_events(agent, "p", pending)
    out = capsys.readouterr().out
    assert out == ('Hello \n[Tool: read_file(path="a.py", n=3)] -> [Failed, 12ms - Error executing read_file: nope] bye')
    assert agent.closed == ["p"]


@bounded()
async def test_cli_loop_failing_to_print_closes_the_turn_before_the_error_escapes(monkeypatch):
    from andromity.cli import _stream_cli_events
    agent = FakeAgent([TextDelta(text="a"), TextDelta(text="b")], hang=True)

    def broken_print(*args, **kwargs):
        raise BrokenPipeError("stdout closed")

    monkeypatch.setattr("builtins.print", broken_print)
    with pytest.raises(BrokenPipeError):
        await _stream_cli_events(agent, "p", {})
    assert agent.closed == ["p"], "the turn stayed open after the CLI loop failed"


@bounded()
async def test_cli_loop_cancelled_closes_the_turn(monkeypatch):
    from andromity.cli import _stream_cli_events
    agent = FakeAgent([TextDelta(text="a")], hang=True)
    monkeypatch.setattr("builtins.print", lambda *a, **k: None)
    t = asyncio.create_task(_stream_cli_events(agent, "p", {}))
    await asyncio.sleep(0.05)
    t.cancel()
    await asyncio.wait({t}, timeout=2)
    assert t.cancelled()
    assert agent.closed == ["p"]


async def _rpc_turn(tmp_path, scripts, stop_after=None, session_id="adv-sess"):
    from andromity.server.protocol import JsonRpcRequest
    from andromity.server.rpc_handler import JsonRpcHandler
    notes = []

    async def on_notify(n):
        notes.append((n.method, n.params))

    handler = JsonRpcHandler(send_notification=on_notify)
    closed = []
    mock_stream, calls = _scripted(scripts, closed)
    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        resp = await handler.handle_request(JsonRpcRequest(id=1, method="agent.prompt", params={
            "prompt": "hi", "session_id": session_id, "project_path": str(tmp_path), "mode": "safe"}))
        assert resp.error is None, resp.error
        if stop_after:
            await wait_until(lambda: any(m == stop_after for m, _ in notes), limit=10)
            stop_resp = await handler.handle_request(JsonRpcRequest(id=2, method="agent.cancel",
                                                                    params={"session_id": session_id}))
            assert stop_resp.error is None, stop_resp.error
        await wait_until(lambda: any(m in ("agent/done", "agent/cancelled", "agent/error") for m, _ in notes), limit=10)
        task = handler._running_tasks.get(session_id)
        if task is not None:
            await asyncio.wait({task}, timeout=5)
    return [m for m, _ in notes], closed, calls


RPC_TOOL_TURN = ['agent/started', 'agent/thinkingDelta', 'agent/toolStart', 'agent/toolDelta', 'agent/toolEnd',
                 'agent/toolResult', 'agent/textDelta', 'agent/done']
RPC_ERROR_TURN = ['agent/started', 'agent/textDelta', 'agent/queueChanged', 'agent/done']
RPC_STOP_TURN = ['agent/started', 'agent/textDelta', 'agent/queueChanged', 'agent/queueChanged', 'agent/cancelled']


def _agent_methods(methods):
    return [m for m in methods if m.startswith("agent/")]


@bounded(30)
async def test_rpc_turn_with_tool_and_text_notifies_as_before(tmp_path):
    methods, closed, calls = await _rpc_turn(tmp_path, [
        [ThinkingDelta(text="t"), ToolCallStart(tool_name="list_dir", tool_id="call_1"),
         ToolCallDelta(tool_id="call_1", args_json_chunk='{"path": "."}'), ToolCallEnd(tool_id="call_1"), Done()],
        [TextDelta(text="Here"), Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})],
    ])
    assert calls["n"] == 2 and closed == [1, 2]
    assert _agent_methods(methods) == RPC_TOOL_TURN


@bounded(30)
async def test_rpc_error_turn_notifies_as_before(tmp_path):
    methods, closed, _ = await _rpc_turn(tmp_path, [
        [TextDelta(text='<div class="andromity-error-card">x</div>'), Done(outcome="error", error_type="provider_overloaded")],
    ])
    assert closed == [1]
    assert _agent_methods(methods) == RPC_ERROR_TURN


@bounded(30)
async def test_rpc_stop_mid_stream_closes_stream_and_reports_cancelled(tmp_path):
    methods, closed, _ = await _rpc_turn(tmp_path, [[TextDelta(text="partial"), HANG]], stop_after="agent/textDelta")
    assert closed == [1]
    assert "agent/cancelled" in methods and "agent/error" not in methods
    assert _agent_methods(methods) == RPC_STOP_TURN


def test_tui_stop_mid_stream_closes_stream_and_ends_the_turn(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    closed = []
    mock_stream, _ = _scripted([[TextDelta(text="partial"), HANG]], closed)

    async def run():
        from andromity.tui.app import AndromityApp
        app = AndromityApp()
        async with app.run_test(size=(120, 35)) as pilot:
            await pilot.pause()
            while len(app.screen_stack) > 1:
                await pilot.press("escape")
                await pilot.pause()
            with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
                app.run_worker(app._stream_agent("hi"), exclusive=False)
                for _ in range(500):
                    if app._current_task is not None and app._is_streaming and closed == [] and \
                            getattr(app, "_current_task", None) is not None:
                        break
                    await pilot.pause(0.01)
                await pilot.pause(0.2)
                assert app._is_streaming
                app._current_task.cancel()
                for _ in range(500):
                    if not app._is_streaming:
                        break
                    await pilot.pause(0.01)
                assert not app._is_streaming, "the TUI turn never ended after Stop"
                assert closed == [1]

    asyncio.run(asyncio.wait_for(run(), 60))
