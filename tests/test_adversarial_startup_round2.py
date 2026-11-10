"""Independent adversarial tests for the round-2 startup changes in server/main.py and rpc_handler.py.

Written to break the new behaviour, not to pass:
  S1. _LineWriter: ordering, blocked / failing streams, close semantics
  S2. _LoopWatchdog: one report per stall, recovery report, stop(), no locals in the logged stack
  S3. _dispatch_limited: slow-request log, truncation, log injection, exempt methods, slot accounting
  S4. rpc_config_list_models: differential against the committed implementation, event-loop lag
  S5. the real stdio server in a subprocess: replies, slow-reading client, EOF

Constants are shrunk by monkeypatching so everything runs in seconds. No network (air-gap is forced for the
subprocess), temporary config directories only.
"""
import ast
import asyncio
import functools
import json
import logging
import os
import queue
import subprocess
import sys
import textwrap
import threading
import time
import types
from pathlib import Path
from typing import Any, Dict, List

import pytest

from andromity.server import main as server_main
from andromity.server import rpc_handler as rpc
from andromity.server.main import (
    UNQUEUED_METHODS,
    _dispatch_limited,
    _LineWriter,
    _LoopWatchdog,
)

REPO = Path(__file__).resolve().parents[1]
LOGGER = "andromity.server"


def bounded(seconds: float = 30.0):
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            return await asyncio.wait_for(fn(*args, **kwargs), seconds)
        return wrapper
    return deco


def messages(caplog, needle: str = "") -> List[str]:
    return [r.getMessage() for r in caplog.records if r.name == LOGGER and needle in r.getMessage()]


# ---------------------------------------------------------------------------
# S1. _LineWriter
# ---------------------------------------------------------------------------

class RecordingStream:
    def __init__(self):
        self.chunks: List[str] = []
        self.flushes = 0

    def write(self, text):
        self.chunks.append(text)

    def flush(self):
        self.flushes += 1


class ScriptedStream(RecordingStream):
    """Raises the scripted exception for the first writes, then behaves."""

    def __init__(self, failures):
        super().__init__()
        self.failures = list(failures)

    def write(self, text):
        if self.failures:
            raise self.failures.pop(0)
        super().write(text)


def test_s1_lines_from_many_threads_and_tasks_stay_whole_and_in_producer_order():
    stream = RecordingStream()
    writer = _LineWriter(stream)
    producers, per = 8, 400

    def produce(pid):
        for i in range(per):
            writer.write(f"{pid}:{i}\n")

    threads = [threading.Thread(target=produce, args=(pid,)) for pid in range(producers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    writer.close()

    assert len(stream.chunks) == producers * per
    seen: Dict[int, List[int]] = {}
    for chunk in stream.chunks:
        assert chunk.count("\n") == 1 and chunk.endswith("\n"), "a line was split or merged"
        pid, i = chunk.strip().split(":")
        seen.setdefault(int(pid), []).append(int(i))
    for pid, order in seen.items():
        assert order == list(range(per)), f"producer {pid} was reordered"


@bounded()
async def test_s1_event_loop_stays_responsive_while_the_stream_blocks_and_nothing_is_lost():
    gate = threading.Event()

    class Blocking(RecordingStream):
        def write(self, text):
            gate.wait(20)
            super().write(text)

    stream = Blocking()
    writer = _LineWriter(stream)
    gaps: List[float] = []

    async def ticker():
        last = time.monotonic()
        while True:
            await asyncio.sleep(0.01)
            now = time.monotonic()
            gaps.append(now - last)
            last = now

    tick = asyncio.create_task(ticker())
    started = time.monotonic()
    for i in range(2000):
        writer.write(f"line {i}\n")
    enqueue_time = time.monotonic() - started
    await asyncio.sleep(0.4)
    gate.set()
    tick.cancel()
    writer.close(timeout=10)

    assert enqueue_time < 0.5, f"write() blocked the caller for {enqueue_time:.2f}s"
    assert max(gaps) < 0.25, f"the loop lagged {max(gaps):.2f}s while the stream was blocked"
    assert stream.chunks == [f"line {i}\n" for i in range(2000)]


@pytest.mark.parametrize("error", [OSError("broken pipe"), ValueError("I/O operation on closed file"),
                                   BrokenPipeError(32, "pipe closed"), UnicodeEncodeError("ascii", "x", 0, 1, "bad")])
def test_s1_expected_write_errors_are_dropped_at_debug_and_the_thread_recovers(error, caplog):
    stream = ScriptedStream([error, error])
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        writer = _LineWriter(stream)
        for i in range(5):
            writer.write(f"{i}\n")
        writer.close()
    assert stream.chunks == ["2\n", "3\n", "4\n"]
    drops = [r for r in caplog.records if "Could not write a reply" in r.getMessage()]
    assert len(drops) == 2 and all(r.levelno == logging.DEBUG for r in drops)


def test_s1_flush_failure_after_a_successful_write_does_not_kill_the_thread():
    class FlakyFlush(RecordingStream):
        def flush(self):
            self.flushes += 1
            if self.flushes == 1:
                raise OSError("flush failed")

    stream = FlakyFlush()
    writer = _LineWriter(stream)
    for i in range(4):
        writer.write(f"{i}\n")
    writer.close()
    assert stream.chunks == ["0\n", "1\n", "2\n", "3\n"]


@pytest.mark.parametrize("error", [RuntimeError("unexpected"), AttributeError("'NoneType' object has no attribute 'write'"),
                                   TypeError("write() argument must be str")])
def test_s1_an_unexpected_stream_error_must_not_silently_end_all_replies(error):
    """Replies are the only way the client learns anything. One odd exception must not stop every later reply."""
    stream = ScriptedStream([error])
    writer = _LineWriter(stream)
    writer.write("first\n")
    time.sleep(0.3)
    writer.write("second\n")
    writer.close()
    assert "second\n" in stream.chunks, "the writer thread died on the first unexpected error; every later reply is lost"


def test_s1_close_twice_and_write_after_close_do_not_raise_or_hang():
    stream = RecordingStream()
    writer = _LineWriter(stream)
    writer.write("a\n")
    writer.close()
    started = time.monotonic()
    writer.close()
    writer.write("late\n")
    writer.close()
    assert time.monotonic() - started < 1.0
    assert stream.chunks == ["a\n"]
    assert not writer._thread.is_alive()


def test_s1_close_with_a_stream_that_never_returns_gives_up_after_the_join_timeout():
    release = threading.Event()

    class Stuck(RecordingStream):
        def write(self, text):
            release.wait(30)

    writer = _LineWriter(Stuck())
    for i in range(10):
        writer.write(f"{i}\n")
    started = time.monotonic()
    writer.close()
    elapsed = time.monotonic() - started
    release.set()
    writer._thread.join(5)
    assert 1.5 <= elapsed < 3.5, f"close() took {elapsed:.2f}s"
    assert not writer._thread.is_alive()


def test_s1_close_with_a_deep_queue_flushes_everything_that_the_stream_can_take_in_time():
    stream = RecordingStream()
    writer = _LineWriter(stream)
    for i in range(50000):
        writer.write(f"{i}\n")
    writer.close()
    assert len(stream.chunks) == 50000
    assert stream.chunks[0] == "0\n" and stream.chunks[-1] == "49999\n"


def test_s1_the_writer_thread_is_a_daemon_so_a_stuck_stream_cannot_hold_the_process_open():
    writer = _LineWriter(RecordingStream())
    try:
        assert writer._thread.daemon
    finally:
        writer.close()


# ---------------------------------------------------------------------------
# S2. _LoopWatchdog
# ---------------------------------------------------------------------------

@pytest.fixture
def fast_watchdog(monkeypatch):
    monkeypatch.setattr(server_main, "LOOP_HEARTBEAT_S", 0.05)
    monkeypatch.setattr(server_main, "LOOP_STALL_LOG_S", 0.3)


def block_the_loop_for_test(seconds: float) -> None:
    secret_value = "".join(["sk-", "live-", "abc123-SECRET"])
    time.sleep(seconds)
    assert secret_value


def watchdog_threads() -> List[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == "andromity-loop-watchdog" and t.is_alive()]


@bounded()
async def test_s2_one_stall_is_reported_once_with_the_blocking_frame_and_once_on_recovery(fast_watchdog, caplog):
    wd = _LoopWatchdog()
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        wd.start()
        await asyncio.sleep(0.2)
        block_the_loop_for_test(1.2)
        await asyncio.sleep(0.6)
        wd.stop()
        wd._thread.join(3)

    blocked = messages(caplog, "blocked for")
    again = messages(caplog, "running again")
    assert len(blocked) == 1, blocked
    assert len(again) == 1, again
    assert "block_the_loop_for_test" in blocked[0] and "time.sleep" in blocked[0]
    order = [r.getMessage() for r in caplog.records if r.name == LOGGER and ("blocked for" in r.getMessage() or "running again" in r.getMessage())]
    assert "blocked for" in order[0] and "running again" in order[1]


@bounded()
async def test_s2_the_logged_stack_has_source_lines_but_never_runtime_values(fast_watchdog, caplog):
    wd = _LoopWatchdog()
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        wd.start()
        await asyncio.sleep(0.2)
        block_the_loop_for_test(0.9)
        await asyncio.sleep(0.4)
        wd.stop()
    text = "\n".join(messages(caplog))
    assert "sk-live-abc123-SECRET" not in text
    assert "secret_value" in text or "time.sleep" in text, "expected the source lines of the blocking frames"
    for line in text.splitlines():
        assert not line.lstrip().startswith(("locals", "f_locals")), line


@bounded()
async def test_s2_two_stalls_in_a_row_are_two_reports_each(fast_watchdog, caplog):
    wd = _LoopWatchdog()
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        wd.start()
        await asyncio.sleep(0.2)
        block_the_loop_for_test(0.9)
        await asyncio.sleep(0.5)
        block_the_loop_for_test(0.9)
        await asyncio.sleep(0.5)
        wd.stop()
    events = [("B" if "blocked for" in m else "R") for m in messages(caplog) if "blocked for" in m or "running again" in m]
    assert events == ["B", "R", "B", "R"], events


@bounded()
async def test_s2_a_short_stall_and_a_busy_but_yielding_loop_produce_no_report(fast_watchdog, caplog):
    wd = _LoopWatchdog()
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        wd.start()
        await asyncio.sleep(0.2)
        block_the_loop_for_test(0.15)
        tasks = [asyncio.create_task(asyncio.sleep(0)) for _ in range(2000)]
        for _ in range(100):
            await asyncio.sleep(0)
        await asyncio.gather(*tasks)
        await asyncio.sleep(0.4)
        wd.stop()
    assert messages(caplog, "blocked for") == []
    assert messages(caplog, "running again") == []


@bounded()
async def test_s2_cpu_work_in_another_thread_is_not_reported_as_a_loop_stall(fast_watchdog, caplog):
    wd = _LoopWatchdog()
    done = threading.Event()

    def burn():
        end = time.monotonic() + 1.2
        n = 0
        while time.monotonic() < end:
            n += 1
        done.set()

    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        wd.start()
        threading.Thread(target=burn, daemon=True).start()
        while not done.is_set():
            await asyncio.sleep(0.02)
        wd.stop()
    assert messages(caplog, "blocked for") == [], "GIL contention from a worker thread was reported as a stalled loop"


@bounded()
async def test_s2_a_stall_that_is_still_running_when_stop_is_called_logs_one_report_and_no_recovery(fast_watchdog, caplog):
    wd = _LoopWatchdog()
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        wd.start()
        await asyncio.sleep(0.2)
        block_the_loop_for_test(1.0)
        wd.stop()
        wd._thread.join(3)
        await asyncio.sleep(0.4)
    assert len(messages(caplog, "blocked for")) == 1
    assert messages(caplog, "running again") == []
    assert not wd._thread.is_alive()


@bounded()
async def test_s2_no_further_reports_after_stop_even_if_the_loop_stalls_again(fast_watchdog, caplog):
    wd = _LoopWatchdog()
    wd.start()
    await asyncio.sleep(0.2)
    wd.stop()
    wd._thread.join(3)
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        block_the_loop_for_test(0.8)
        await asyncio.sleep(0.3)
    assert messages(caplog, "blocked for") == []


@bounded()
async def test_s2_stop_cancels_the_heartbeat_task_and_the_thread_exits(fast_watchdog):
    before = len(watchdog_threads())
    wd = _LoopWatchdog()
    wd.start()
    await asyncio.sleep(0.15)
    wd.stop()
    wd._thread.join(3)
    for _ in range(5):
        await asyncio.sleep(0.02)
    assert wd._task.done()
    assert not wd._thread.is_alive()
    assert len(watchdog_threads()) == before


def test_s2_stop_before_start_and_stop_twice_are_harmless():
    wd = _LoopWatchdog()
    wd.stop()
    wd.stop()
    assert not wd._thread.is_alive()


@bounded()
async def test_s2_start_stop_cycles_do_not_leak_threads_or_tasks(fast_watchdog):
    before = len(watchdog_threads())
    tasks_before = len(asyncio.all_tasks())
    for _ in range(25):
        wd = _LoopWatchdog()
        wd.start()
        await asyncio.sleep(0.01)
        wd.stop()
        wd._thread.join(3)
    await asyncio.sleep(0.1)
    assert len(watchdog_threads()) == before
    assert len(asyncio.all_tasks()) == tasks_before


@bounded()
async def test_s2_a_stall_before_start_is_not_reported_as_a_stall_of_the_running_loop(fast_watchdog, caplog):
    """The daemon builds the watchdog first, then spends seconds in init_schema() before start()."""
    wd = _LoopWatchdog()
    block_the_loop_for_test(0.8)
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        wd.start()
        await asyncio.sleep(0.5)
        wd.stop()
    assert messages(caplog, "blocked for") == [], "time spent before start() was reported as a blocked loop"


@bounded()
async def test_s2_the_watcher_survives_a_loop_thread_that_no_longer_exists(fast_watchdog, caplog):
    holder: Dict[str, Any] = {}

    def build():
        holder["wd"] = _LoopWatchdog()

    t = threading.Thread(target=build)
    t.start()
    t.join()
    wd = holder["wd"]
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        wd.start()
        await asyncio.sleep(0.2)
        block_the_loop_for_test(0.8)
        await asyncio.sleep(0.4)
        alive = wd._thread.is_alive()
        wd.stop()
    assert alive, "the watcher thread died instead of logging '(no stack)'"


# ---------------------------------------------------------------------------
# S3. _dispatch_limited
# ---------------------------------------------------------------------------

@pytest.fixture
def slow_requests(monkeypatch):
    monkeypatch.setattr(server_main, "SLOW_REQUEST_LOG_S", 0.2)


def sleeper(duration):
    async def run(msg):
        await asyncio.sleep(duration)
    return run


@bounded()
async def test_s3_a_slow_request_logs_method_total_and_wait(slow_requests, caplog):
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        await _dispatch_limited(asyncio.Semaphore(4), {"method": "git.status", "id": 1}, sleeper(0.35))
    logged = messages(caplog, "RPC git.status took")
    assert len(logged) == 1
    assert "0.0s of it waiting for a free slot" in logged[0]
    record = next(r for r in caplog.records if "RPC git.status took" in r.getMessage())
    assert record.levelno == logging.INFO


@bounded()
async def test_s3_a_fast_request_logs_nothing(slow_requests, caplog):
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        await _dispatch_limited(asyncio.Semaphore(4), {"method": "git.status"}, sleeper(0.0))
    assert messages(caplog, "RPC ") == []


@bounded()
async def test_s3_time_spent_waiting_for_a_slot_is_reported_separately(slow_requests, caplog):
    semaphore = asyncio.Semaphore(1)
    release = asyncio.Event()

    async def holder(msg):
        await release.wait()

    first = asyncio.create_task(_dispatch_limited(semaphore, {"method": "held"}, holder))
    await asyncio.sleep(0.05)
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        second = asyncio.create_task(_dispatch_limited(semaphore, {"method": "queued"}, sleeper(0.05)))
        await asyncio.sleep(0.4)
        release.set()
        await asyncio.gather(first, second)
    line = messages(caplog, "RPC queued took")
    assert len(line) == 1
    took, waited = [float(x) for x in __import__("re").findall(r"(\d+\.\d)s", line[0])[:2]]
    assert waited >= 0.3 and took >= waited, line


@bounded()
async def test_s3_method_names_are_cut_to_80_characters(slow_requests, caplog):
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        await _dispatch_limited(asyncio.Semaphore(4), {"method": "m" * 500}, sleeper(0.3))
    logged = messages(caplog, "RPC ")
    assert len(logged) == 1
    assert "m" * 80 in logged[0] and "m" * 81 not in logged[0]


@pytest.mark.parametrize("method", [None, 7, 1.5, ["a"], {"a": 1}, b"bytes", True])
@bounded()
async def test_s3_non_string_methods_are_logged_as_a_question_mark_and_never_raise(method, slow_requests, caplog):
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        await _dispatch_limited(asyncio.Semaphore(4), {"method": method}, sleeper(0.3))
    logged = messages(caplog, "RPC ")
    assert len(logged) == 1 and logged[0].startswith("RPC ? took")


@bounded()
async def test_s3_missing_method_key_is_logged_as_a_question_mark(slow_requests, caplog):
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        await _dispatch_limited(asyncio.Semaphore(4), {"id": 1}, sleeper(0.3))
    assert messages(caplog, "RPC ? took")


@pytest.mark.parametrize("method", ["x\nWARNING andromity.server: forged line", "a\r\nb", "tab\there\x1b[31mred"])
@bounded()
async def test_s3_a_method_name_cannot_forge_log_lines(method, slow_requests, caplog):
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        await _dispatch_limited(asyncio.Semaphore(4), {"method": method}, sleeper(0.3))
    logged = messages(caplog, "RPC ")
    assert len(logged) == 1
    assert "\n" not in logged[0] and "\r" not in logged[0] and "\x1b" not in logged[0], repr(logged[0])


@bounded()
async def test_s3_exempt_methods_skip_the_semaphore_and_report_no_wait(slow_requests, caplog):
    semaphore = asyncio.Semaphore(0)
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        await asyncio.wait_for(_dispatch_limited(semaphore, {"method": "session.get"}, sleeper(0.3)), 5)
    logged = messages(caplog, "RPC session.get took")
    assert len(logged) == 1 and "0.0s of it waiting" in logged[0]
    assert semaphore._value == 0


@pytest.mark.parametrize("method", sorted(UNQUEUED_METHODS))
@bounded()
async def test_s3_every_exempt_method_runs_while_all_slots_are_taken(method):
    semaphore = asyncio.Semaphore(0)
    ran = []

    async def run(msg):
        ran.append(msg["method"])

    await asyncio.wait_for(_dispatch_limited(semaphore, {"method": method}, run), 2)
    assert ran == [method]


@bounded()
async def test_s3_a_failing_request_releases_its_slot_and_the_error_still_reaches_the_caller(slow_requests):
    semaphore = asyncio.Semaphore(2)

    async def boom(msg):
        await asyncio.sleep(0.01)
        raise RuntimeError("handler failed")

    with pytest.raises(RuntimeError):
        await _dispatch_limited(semaphore, {"method": "x"}, boom)
    assert semaphore._value == 2


@bounded()
async def test_s3_a_cancelled_wait_for_a_slot_does_not_leak_or_log(slow_requests, caplog):
    semaphore = asyncio.Semaphore(1)
    release = asyncio.Event()

    async def holder(msg):
        await release.wait()

    first = asyncio.create_task(_dispatch_limited(semaphore, {"method": "held"}, holder))
    await asyncio.sleep(0.05)
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        waiting = asyncio.create_task(_dispatch_limited(semaphore, {"method": "waiting"}, sleeper(0)))
        await asyncio.sleep(0.3)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        release.set()
        await first
    assert semaphore._value == 1
    assert messages(caplog, "RPC waiting") == []


@bounded()
async def test_s3_a_huge_method_name_is_cheap_to_log(slow_requests, caplog):
    started = time.monotonic()
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        await _dispatch_limited(asyncio.Semaphore(4), {"method": "z" * (8 * 1024 * 1024)}, sleeper(0.25))
    assert time.monotonic() - started < 3
    assert all(len(m) < 400 for m in messages(caplog, "RPC "))


# ---------------------------------------------------------------------------
# S4. rpc_config_list_models
# ---------------------------------------------------------------------------

def _old_list_models():
    """The committed implementation, evaluated against the live rpc_handler module namespace."""
    source = subprocess.run(["git", "show", "135ef98^:src/andromity/server/rpc_handler.py"], cwd=REPO, capture_output=True,
                            text=True, encoding="utf-8", check=True).stdout
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "rpc_config_list_models":
            text = textwrap.dedent(ast.get_source_segment(source, node))
            local: Dict[str, Any] = {}
            exec(compile(text, "<old rpc_config_list_models>", "exec"), rpc.__dict__, local)
            return local["rpc_config_list_models"]
    raise AssertionError("old rpc_config_list_models not found")


OLD_LIST_MODELS = _old_list_models()


class ModelWorld:
    """Deterministic stand-ins for the live model cache, the Ollama probe and discovery."""

    def __init__(self, monkeypatch, cache=None, ollama=None, pinned=None, ollama_error=None, keys=None):
        self.cache = dict(cache or {})
        self.ollama = ollama
        self.ollama_error = ollama_error
        self.fetches: List[Any] = []
        monkeypatch.setattr(rpc, "get_cached_live_models", lambda p=None: list(self.cache.get(p, [])) if p else [])

        def fetch(provider, api_key=None, base_url=None, **kwargs):
            self.fetches.append(provider)
            if provider == "ollama":
                if self.ollama_error:
                    raise self.ollama_error
                return list(self.ollama or [])
            return []

        monkeypatch.setattr(rpc, "fetch_live_models_sync", fetch)
        monkeypatch.setattr(rpc.config, "get_pinned_models", lambda: list(pinned or []))
        if keys is not None:
            monkeypatch.setattr(rpc.config, "get_api_key", lambda p: keys.get(p))


def run_new(params=None):
    return asyncio.run(rpc.JsonRpcHandler().rpc_config_list_models(params))


def run_old(params=None):
    return asyncio.run(OLD_LIST_MODELS(rpc.JsonRpcHandler(), params))


def normalised(rows):
    return json.loads(json.dumps(rows, sort_keys=True))


def live_row(i, **extra):
    row = {"id": f"model-{i}", "name": f"Model {i}", "desc": "d", "context": "128K", "pricing": "$1", "tags": ["x"]}
    row.update(extra)
    return row


SCENARIOS = {
    "catalog only": dict(),
    "live cache with and without context_limit": dict(cache={
        "openai": [live_row(1, context_limit=999), live_row(2)],
        "anthropic": [live_row(3, context_limit=0), live_row(4, context_limit=None), live_row(5, context_limit=2048)],
    }),
    "free routes": dict(cache={"openrouter": [live_row(1, id="a/b:free"), live_row(2, id="A/B:FREE", is_free=False),
                                              live_row(3, is_free=True)]}),
    "pinned flags": dict(
        cache={"openai": [live_row(1), live_row(2)]},
        pinned=[{"id": "model-1", "provider": "openai"}, {"id": "model-2"}, {"id": "model-1", "provider": "other"},
                {"id": "gpt-4o", "provider": "openai"}]),
    "ollama with models": dict(ollama=[live_row(1, id="llama3.2:3b", context_limit=8192), live_row(2, id="qwen:7b")]),
    "ollama without models is skipped": dict(ollama=[]),
    "ollama probe fails": dict(ollama_error=RuntimeError("connection refused")),
    "ollama probe returns None": dict(ollama=None),
    "keys set": dict(keys={"openai": "sk-test", "anthropic": "k"}),
    "model without optional fields": dict(cache={"openai": [{"id": "bare"}]}),
    "unicode and odd ids": dict(cache={"openai": [live_row(1, id="ünï/çødé:free"), live_row(2, id="x" * 300)]}),
}


@pytest.mark.parametrize("name", sorted(SCENARIOS))
@pytest.mark.parametrize("params", [None, {}, {"discover": False}, {"provider": "openai"}, {"provider": "ollama"},
                                    {"provider": "openrouter"}, {"provider": "no-such-provider"}],
                         ids=["none", "empty", "nodiscover", "openai", "ollama", "openrouter", "unknown"])
def test_s4_new_rows_equal_the_committed_implementation(name, params, monkeypatch):
    world = ModelWorld(monkeypatch, **SCENARIOS[name])
    new = normalised(run_new(params))
    new_fetches, world.fetches = list(world.fetches), []
    old = normalised(run_old(params))
    assert old == new
    awaited = lambda fetches: sorted(f for f in fetches if f != "openrouter")
    assert awaited(world.fetches) == awaited(new_fetches), "the two versions probe different providers"


def test_s4_the_baseline_is_not_vacuous(monkeypatch):
    ModelWorld(monkeypatch, cache={"openai": [live_row(1, context_limit=999)]}, ollama=[live_row(9, id="llama3")])
    rows = run_new({})
    assert len(rows) > 20
    assert {r["source"] for r in rows} == {"live", "catalog"}
    assert any(r["provider"] == "ollama" for r in rows)
    assert next(r for r in rows if r["id"] == "model-1")["context_limit"] == 999


def test_s4_openrouter_background_cache_fallback_matches(monkeypatch):
    cache = {"openrouter": [live_row(1), live_row(2, id="x/y:free")]}
    ModelWorld(monkeypatch, cache=cache)
    assert normalised(run_new({"provider": "openrouter"})) == normalised(run_old({"provider": "openrouter"}))
    rows = run_new({"provider": "openrouter"})
    assert [r["source"] for r in rows] == ["live", "live"]


def test_s4_one_malformed_cached_row_must_not_blank_every_provider(monkeypatch, caplog):
    """A cache row without an id used to cost only the providers after it. It must not cost all of them."""
    cache = {"openai": [live_row(1), {"name": "no id"}]}
    ModelWorld(monkeypatch, cache=cache)
    old = run_old({})
    new = run_new({})
    assert len(old) > 0, "the baseline should keep the providers listed before the bad row"
    assert len(new) >= len(old), f"old returned {len(old)} rows, new returned {len(new)}"


def test_s4_a_failing_catalog_provider_does_not_hide_the_providers_before_it(monkeypatch):
    ModelWorld(monkeypatch)
    real = rpc.get_context_limit_for_model

    def flaky_after(n):
        calls = {"n": 0}

        def flaky(provider, model_id):
            calls["n"] += 1
            if calls["n"] == n:
                raise RuntimeError("context lookup blew up")
            return real(provider, model_id)
        return flaky

    monkeypatch.setattr(rpc, "get_context_limit_for_model", flaky_after(15))
    old = run_old({})
    monkeypatch.setattr(rpc, "get_context_limit_for_model", flaky_after(15))
    new = run_new({})
    assert len(old) >= 10, "the baseline should keep the rows built before the failing lookup"
    assert len(new) >= len(old), f"old returned {len(old)} rows, new returned {len(new)}"


def test_s4_rows_are_built_off_the_event_loop_thread(monkeypatch):
    ModelWorld(monkeypatch)
    loop_thread = threading.get_ident()
    seen = set()
    real = rpc.get_context_limit_for_model

    def spy(provider, model_id):
        seen.add(threading.get_ident())
        return real(provider, model_id)

    monkeypatch.setattr(rpc, "get_context_limit_for_model", spy)
    run_new({"provider": "openai"})
    assert seen and loop_thread not in seen


def lag_while(coro_factory, rows=40000):
    async def main():
        gaps: List[float] = []
        stop = asyncio.Event()

        async def ticker():
            last = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.005)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        tick = asyncio.create_task(ticker())
        await asyncio.sleep(0.05)
        started = time.monotonic()
        result = await coro_factory()
        duration = time.monotonic() - started
        stop.set()
        await tick
        return max(gaps), duration, result

    return asyncio.run(main())


def test_s4_a_huge_catalog_does_not_stall_the_event_loop(monkeypatch):
    big = [live_row(i, id=f"vendor/model-{i}", context_limit=4096 + i) for i in range(40000)]
    ModelWorld(monkeypatch, cache={"openrouter": big})
    handler = rpc.JsonRpcHandler()
    worst, duration, rows = lag_while(lambda: handler.rpc_config_list_models({"provider": "openrouter", "discover": False}))
    assert len(rows) == 40000
    assert duration > 0.3, f"the build took only {duration:.2f}s, so this does not measure anything"
    assert worst < 0.25, f"the loop stalled {worst:.2f}s while rows were built ({duration:.2f}s total)"


def test_s4_the_same_catalog_stalls_the_committed_implementation(monkeypatch):
    """Sensitivity check for the test above: the old code must show the stall that the new code removes."""
    big = [live_row(i, id=f"vendor/model-{i}", context_limit=4096 + i) for i in range(40000)]
    ModelWorld(monkeypatch, cache={"openrouter": big})
    handler = rpc.JsonRpcHandler()
    worst, duration, rows = lag_while(lambda: OLD_LIST_MODELS(handler, {"provider": "openrouter", "discover": False}))
    assert len(rows) == 40000
    assert worst > 0.25, f"old code lag was only {worst:.2f}s; the lag measurement is not sensitive enough"


def test_s4_concurrent_calls_return_independent_equal_results(monkeypatch):
    ModelWorld(monkeypatch, cache={"openai": [live_row(i) for i in range(50)]})
    handler = rpc.JsonRpcHandler()

    async def main():
        return await asyncio.gather(*[handler.rpc_config_list_models({}) for _ in range(12)])

    results = asyncio.run(main())
    first = normalised(results[0])
    assert all(normalised(r) == first for r in results)
    assert all(a is not b for a in results for b in results if a is not b)


def test_s4_pinned_list_is_read_once_on_the_loop_before_the_thread_starts(monkeypatch):
    ModelWorld(monkeypatch)
    calls = []
    real = rpc.config.get_pinned_models

    def spy():
        calls.append(threading.get_ident())
        return real()

    monkeypatch.setattr(rpc.config, "get_pinned_models", spy)
    run_new({"provider": "openai"})
    assert len(calls) == 1 and calls[0] == threading.get_ident()


def test_s4_a_hanging_ollama_probe_still_times_out_and_the_rest_is_returned(monkeypatch):
    ModelWorld(monkeypatch)
    release = threading.Event()

    def hang(provider, api_key=None, base_url=None, **kwargs):
        if provider == "ollama":
            release.wait(10)
        return []

    monkeypatch.setattr(rpc, "fetch_live_models_sync", hang)

    async def timed():
        started = time.monotonic()
        rows = await rpc.JsonRpcHandler().rpc_config_list_models({})
        elapsed = time.monotonic() - started
        release.set()
        return elapsed, rows

    try:
        elapsed, rows = asyncio.run(timed())
    finally:
        release.set()
    assert elapsed < 5, f"took {elapsed:.1f}s"
    assert len(rows) > 20 and not any(r["provider"] == "ollama" for r in rows)


# ---------------------------------------------------------------------------
# S5. the real stdio server
# ---------------------------------------------------------------------------

class Engine:
    def __init__(self, tmp_path: Path, src: Path = None, extra_env=None):
        src = src or Path(os.environ.get("ANDROMITY_ROUND2_SRC", REPO / "src"))
        home = tmp_path / "home"
        cfg = tmp_path / "cfg"
        ws = tmp_path / "workspace"
        for d in (home, cfg, ws, tmp_path / "appdata", tmp_path / "localappdata"):
            d.mkdir(parents=True, exist_ok=True)
        self.cfg = cfg
        self.workspace = ws
        env = dict(os.environ)
        env.update({
            "HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(tmp_path / "appdata"),
            "LOCALAPPDATA": str(tmp_path / "localappdata"), "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"), "ANDROMITY_CONFIG_DIR": str(cfg),
            "PYTHONPATH": str(src), "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
            "ANDROMITY_CLIENT": "vscode", "DO_NOT_TRACK": "1", "ANDROMITY_NO_TELEMETRY": "1", "ANDROMITY_AIRGAP": "1",
        })
        env.update(extra_env or {})
        self.started = time.monotonic()
        self.proc = subprocess.Popen([sys.executable, "-P", "-m", "andromity.server", "--stdio"], cwd=str(ws), env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        self.replies: "queue.Queue[Any]" = queue.Queue()
        self.stdout_lines: List[bytes] = []
        self.stderr_lines: List[str] = []
        self.first_stderr_at = None
        self._next = 1
        self.reading_enabled = threading.Event()
        self.reading_enabled.set()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self):
        for raw in iter(self.proc.stdout.readline, b""):
            self.reading_enabled.wait()
            self.stdout_lines.append(raw)
            try:
                self.replies.put(json.loads(raw))
            except ValueError:
                self.replies.put({"_garbage": raw})

    def _read_stderr(self):
        for raw in iter(self.proc.stderr.readline, b""):
            if self.first_stderr_at is None:
                self.first_stderr_at = time.monotonic() - self.started
            self.stderr_lines.append(raw.decode("utf-8", "replace").rstrip())

    def send(self, method: str, params=None) -> int:
        rid = self._next
        self._next += 1
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n").encode())
        self.proc.stdin.flush()
        return rid

    def wait_reply(self, rid: int, timeout: float = 60.0):
        deadline = time.monotonic() + timeout
        stash = []
        try:
            while time.monotonic() < deadline:
                try:
                    msg = self.replies.get(timeout=0.2)
                except queue.Empty:
                    continue
                if msg.get("id") == rid:
                    return msg
                stash.append(msg)
            raise AssertionError(f"no reply to {rid} in {timeout}s; stderr tail: {self.stderr_lines[-8:]}")
        finally:
            for m in stash:
                self.replies.put(m)

    def stderr_text(self) -> str:
        return "\n".join(self.stderr_lines)

    def close(self):
        try:
            if self.proc.poll() is None:
                self.proc.kill()
            self.proc.wait(timeout=10)
        except Exception:
            pass
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except Exception:
                pass


@pytest.fixture
def engine(tmp_path):
    made: List[Engine] = []

    def make(**kwargs):
        e = Engine(tmp_path, **kwargs)
        made.append(e)
        return e

    yield make
    for e in made:
        e.close()


def test_s5_replies_arrive_for_every_request_and_stdout_stays_pure_json(engine):
    e = engine()
    ids = [e.send("config.status") for _ in range(5)] + [e.send("trust.status", {"project_path": str(e.workspace)})]
    ids += [e.send("config.list_providers"), e.send("no.such.method"), e.send("session.list", {"project_path": str(e.workspace)})]
    replies = {rid: e.wait_reply(rid, 90) for rid in ids}
    assert all("result" in replies[i] for i in ids[:7])
    assert replies[ids[7]]["error"]["code"] == -32601
    assert not [line for line in e.stdout_lines if not line.startswith(b"{")], "stdout carried non-JSON output"
    assert all(b"\n" == line[-1:] for line in e.stdout_lines)


def test_s5_malformed_and_oversized_json_lines_get_parse_errors_without_killing_the_server(engine):
    e = engine()
    first = e.send("config.status")
    e.wait_reply(first, 90)
    e.proc.stdin.write(b"{not json}\n\n   \n[1,2,3]\n\"str\"\n")
    e.proc.stdin.flush()
    parse = e.wait_reply(None, 10)
    assert parse["error"]["code"] == -32700
    after = e.send("config.status")
    assert "result" in e.wait_reply(after, 30)


def test_s5_the_first_stderr_byte_comes_before_the_daemon_can_answer_anything(engine):
    """The extension starts request timeouts on the first stdout/stderr byte. Measure how early that is."""
    e = engine()
    rid = e.send("config.status")
    reply_at = None
    e.wait_reply(rid, 90)
    reply_at = time.monotonic() - e.started
    assert e.first_stderr_at is not None
    gap = reply_at - e.first_stderr_at
    print(f"first stderr byte at {e.first_stderr_at:.2f}s, first reply at {reply_at:.2f}s, gap {gap:.2f}s")
    assert gap < 2.0, f"first output at {e.first_stderr_at:.2f}s but the first reply only at {reply_at:.2f}s"


def test_s5_a_client_that_does_not_read_stdout_cannot_freeze_the_daemon(engine):
    e = engine()
    ready = e.send("config.status")
    e.wait_reply(ready, 90)

    e.reading_enabled.clear()
    marker_dir = e.workspace / "marker-project"
    marker_dir.mkdir()
    flood = [e.send("config.list_models", {"discover": False}) for _ in range(6)]
    time.sleep(1.0)
    trust = e.send("trust.set", {"project_path": str(marker_dir)})

    config_toml = e.cfg / "config.toml"
    deadline = time.monotonic() + 20
    applied = False
    while time.monotonic() < deadline:
        try:
            if "marker-project" in config_toml.read_text(encoding="utf-8", errors="replace"):
                applied = True
                break
        except OSError:
            pass
        time.sleep(0.25)

    e.reading_enabled.set()
    got = {rid: e.wait_reply(rid, 60) for rid in flood + [trust]}
    assert applied, "a later request was not even processed while the client was not reading stdout"
    assert all("result" in r for r in got.values())
    flood_bytes = sum(len(line) for line in e.stdout_lines if json.loads(line).get("id") in flood)
    assert flood_bytes > 100 * 1024, f"the flood was only {flood_bytes} bytes; it did not fill the pipe, so the test measured nothing"
    assert "blocked for" not in e.stderr_text()


def test_s5_eof_on_stdin_ends_the_process_quickly_and_cleanly(engine):
    e = engine()
    rid = e.send("config.status")
    e.wait_reply(rid, 90)
    t0 = time.monotonic()
    e.proc.stdin.close()
    code = e.proc.wait(timeout=20)
    elapsed = time.monotonic() - t0
    time.sleep(0.3)
    assert code == 0, e.stderr_text()[-800:]
    assert elapsed < 8, f"exit took {elapsed:.1f}s"
    assert "EOF received on stdin" in e.stderr_text()
    assert "Traceback" not in e.stderr_text()


def test_s5_replies_written_just_before_eof_are_flushed(engine):
    e = engine()
    first = e.send("config.status")
    e.wait_reply(first, 90)
    ids = [e.send("config.status") for _ in range(30)]
    e.proc.stdin.close()
    e.proc.wait(timeout=30)
    time.sleep(0.5)
    got = set()
    while True:
        try:
            msg = e.replies.get_nowait()
        except queue.Empty:
            break
        got.add(msg.get("id"))
    assert got == set(ids), f"missing replies for {sorted(set(ids) - got)}"


def test_s5_eof_while_the_client_still_does_not_read_does_not_hang_the_daemon(engine):
    e = engine()
    rid = e.send("config.status")
    e.wait_reply(rid, 90)
    e.reading_enabled.clear()
    for _ in range(6):
        e.send("config.list_models", {"discover": False})
    time.sleep(1.0)
    e.proc.stdin.close()
    try:
        e.proc.wait(timeout=15)
        exited = True
    except subprocess.TimeoutExpired:
        exited = False
    finally:
        e.reading_enabled.set()
    assert exited, "the daemon is stuck at exit while its stdout is not being read"


# ---------------------------------------------------------------------------
# S6. start_stdio_server in-process, with fake stdin and stdout
# ---------------------------------------------------------------------------

class FakeStdin:
    def __init__(self):
        self.q: "queue.Queue[str]" = queue.Queue()

    def feed(self, obj) -> None:
        self.q.put(json.dumps(obj) + "\n")

    def feed_raw(self, text: str) -> None:
        self.q.put(text)

    def eof(self) -> None:
        self.q.put("")

    def readline(self, limit: int = -1) -> str:
        return self.q.get()


class FakeStdout(RecordingStream):
    def __init__(self):
        super().__init__()
        self.lock = threading.Lock()

    def write(self, text):
        with self.lock:
            self.chunks.append(text)

    def replies(self) -> List[dict]:
        with self.lock:
            return [json.loads(c) for c in self.chunks]


@pytest.fixture
def stdio(monkeypatch):
    stdin, stdout = FakeStdin(), FakeStdout()

    def install():
        monkeypatch.setattr(sys, "stdin", stdin)
        monkeypatch.setattr(sys, "stdout", stdout)

    monkeypatch.setattr(server_main, "_start_prewarm", lambda: None)
    monkeypatch.setattr(rpc.JsonRpcHandler, "start_mcp_soon", lambda self: None)
    import andromity.telemetry as telemetry
    monkeypatch.setattr(telemetry, "send_feature_used", lambda *a, **k: None)
    monkeypatch.setattr(server_main, "LOOP_HEARTBEAT_S", 0.05)
    monkeypatch.setattr(server_main, "LOOP_STALL_LOG_S", 0.3)
    return types.SimpleNamespace(stdin=stdin, stdout=stdout, install=install)


def our_threads() -> List[str]:
    return [t.name for t in threading.enumerate() if t.name in ("andromity-stdout", "andromity-loop-watchdog") and t.is_alive()]


async def wait_for(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.02)
    return False


@bounded(60)
async def test_s6_replies_come_back_and_both_helper_threads_are_gone_after_eof(stdio):
    stdio.install()
    before = set(our_threads())
    server = asyncio.create_task(server_main.start_stdio_server())
    for i in range(1, 21):
        stdio.stdin.feed({"jsonrpc": "2.0", "id": i, "method": "config.status", "params": {}})
    assert await wait_for(lambda: len(stdio.stdout.chunks) >= 20)
    assert {r["id"] for r in stdio.stdout.replies()} == set(range(1, 21))
    assert set(our_threads()) - before == {"andromity-stdout", "andromity-loop-watchdog"}
    stdio.stdin.eof()
    await asyncio.wait_for(server, 15)
    assert await wait_for(lambda: not (set(our_threads()) - before), 5), our_threads()


@bounded(60)
async def test_s6_a_handler_that_blocks_the_loop_is_named_in_the_log(stdio, caplog, monkeypatch):
    stdio.install()
    async def rpc_test_block(self, params=None):
        time.sleep(1.0)
        return {"ok": True}

    monkeypatch.setattr(rpc.JsonRpcHandler, "rpc_test_block", rpc_test_block, raising=False)
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        server = asyncio.create_task(server_main.start_stdio_server())
        await asyncio.sleep(0.3)
        stdio.stdin.feed({"jsonrpc": "2.0", "id": 1, "method": "test.block", "params": {}})
        assert await wait_for(lambda: any(r.get("id") == 1 for r in stdio.stdout.replies()), 20)
        await asyncio.sleep(0.4)
        stdio.stdin.eof()
        await asyncio.wait_for(server, 15)
    blocked = messages(caplog, "blocked for")
    assert len(blocked) == 1, blocked
    assert "rpc_test_block" in blocked[0] and "time.sleep" in blocked[0]
    assert len(messages(caplog, "running again")) == 1


@bounded(60)
async def test_s6_a_slow_request_is_logged_once_with_its_method(stdio, caplog, monkeypatch):
    stdio.install()
    monkeypatch.setattr(server_main, "SLOW_REQUEST_LOG_S", 0.2)

    async def rpc_test_slow(self, params=None):
        await asyncio.sleep(0.4)
        return {"ok": True}

    monkeypatch.setattr(rpc.JsonRpcHandler, "rpc_test_slow", rpc_test_slow, raising=False)
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        server = asyncio.create_task(server_main.start_stdio_server())
        stdio.stdin.feed({"jsonrpc": "2.0", "id": 1, "method": "test.slow", "params": {}})
        stdio.stdin.feed({"jsonrpc": "2.0", "id": 2, "method": "config.status", "params": {}})
        assert await wait_for(lambda: {r.get("id") for r in stdio.stdout.replies()} >= {1, 2}, 20)
        stdio.stdin.eof()
        await asyncio.wait_for(server, 15)
    assert len(messages(caplog, "RPC test.slow took")) == 1
    assert messages(caplog, "RPC config.status") == []


@bounded(60)
async def test_s6_a_stuck_stdout_does_not_keep_the_server_from_returning_after_eof(stdio, monkeypatch):
    stdio.install()
    release = threading.Event()

    class Stuck(FakeStdout):
        def write(self, text):
            release.wait(30)
            super().write(text)

    monkeypatch.setattr(sys, "stdout", Stuck())
    server = asyncio.create_task(server_main.start_stdio_server())
    stdio.stdin.feed({"jsonrpc": "2.0", "id": 1, "method": "config.status", "params": {}})
    await asyncio.sleep(0.5)
    stdio.stdin.eof()
    started = time.monotonic()
    try:
        await asyncio.wait_for(server, 15)
    finally:
        release.set()
    assert time.monotonic() - started < 6


@bounded(60)
async def test_s6_the_event_loop_keeps_serving_while_stdout_is_stuck(stdio, monkeypatch):
    stdio.install()
    release = threading.Event()

    class Stuck(FakeStdout):
        def write(self, text):
            release.wait(30)
            super().write(text)

    stuck = Stuck()
    monkeypatch.setattr(sys, "stdout", stuck)
    ran = []

    async def rpc_test_mark(self, params=None):
        ran.append(params.get("n"))
        return {"n": params.get("n")}

    monkeypatch.setattr(rpc.JsonRpcHandler, "rpc_test_mark", rpc_test_mark, raising=False)
    server = asyncio.create_task(server_main.start_stdio_server())
    try:
        for n in range(50):
            stdio.stdin.feed({"jsonrpc": "2.0", "id": n + 1, "method": "test.mark", "params": {"n": n}})
        assert await wait_for(lambda: len(ran) == 50, 10), f"only {len(ran)} requests were handled while stdout was stuck"
    finally:
        release.set()
        stdio.stdin.eof()
        await asyncio.wait_for(server, 15)
    assert sorted(r["id"] for r in stuck.replies()) == list(range(1, 51))


@bounded(60)
async def test_s6_notifications_and_replies_keep_the_order_they_were_produced_in(stdio, monkeypatch):
    stdio.install()
    async def rpc_test_chatty(self, params=None):
        for i in range(30):
            self.notify("test/progress", {"i": i})
            await asyncio.sleep(0)
        return {"done": True}

    monkeypatch.setattr(rpc.JsonRpcHandler, "rpc_test_chatty", rpc_test_chatty, raising=False)
    server = asyncio.create_task(server_main.start_stdio_server())
    stdio.stdin.feed({"jsonrpc": "2.0", "id": 1, "method": "test.chatty", "params": {}})
    assert await wait_for(lambda: any(r.get("id") == 1 for r in stdio.stdout.replies()), 20)
    stdio.stdin.eof()
    await asyncio.wait_for(server, 15)
    replies = stdio.stdout.replies()
    seq = [r["params"]["i"] for r in replies if r.get("method") == "test/progress"]
    assert seq == list(range(30)), "notifications arrived reordered or were dropped"
    last_note = max(i for i, r in enumerate(replies) if r.get("method") == "test/progress")
    reply_at = next(i for i, r in enumerate(replies) if r.get("id") == 1)
    assert reply_at > last_note


@bounded(60)
async def test_s6_garbage_input_gets_a_parse_error_and_the_server_keeps_serving(stdio):
    stdio.install()
    server = asyncio.create_task(server_main.start_stdio_server())
    stdio.stdin.feed_raw("{broken\n")
    stdio.stdin.feed_raw("\n")
    stdio.stdin.feed_raw("[1]\n")
    stdio.stdin.feed({"jsonrpc": "2.0", "id": 5, "method": "config.status", "params": {}})
    assert await wait_for(lambda: any(r.get("id") == 5 for r in stdio.stdout.replies()), 20)
    stdio.stdin.eof()
    await asyncio.wait_for(server, 15)
    assert any(r.get("error", {}).get("code") == -32700 for r in stdio.stdout.replies())
