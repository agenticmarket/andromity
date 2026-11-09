"""Adversarial tests for the agent's telemetry hooks: session duration, early close, sticky errors, isolation."""
import asyncio
import threading
import urllib.request

import pytest

import andromity.telemetry as telemetry_module
from andromity.core.agent import Agent
from andromity.core.events import Done, TextDelta
from andromity.core.session import Session

TEXT_ONLY = {"provider": "deepseek", "model": "deepseek-chat"}
USAGE = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
TIMEOUT = 15


def reply(text="Done."):
    return [TextDelta(text=text), Done(usage=USAGE)]


def provider_error():
    return [TextDelta(text="[RATE LIMIT] slow down"), Done(usage=None, outcome="error", error_type="rate_limit")]


async def explode():
    raise RuntimeError("provider exploded")
    yield


async def stall():
    yield TextDelta(text="partial")
    await asyncio.sleep(30)
    yield Done(usage=USAGE)


def script(monkeypatch, *steps):
    """Each request gets the next step: a list of events or an async generator function."""
    requests = []

    async def stream(messages, **kwargs):
        requests.append(len(messages))
        step = steps[len(requests) - 1] if len(requests) <= len(steps) else reply()
        if callable(step):
            async for event in step():
                yield event
            return
        for event in step:
            yield event

    monkeypatch.setattr("andromity.core.agent.stream_completion", stream)
    return requests


async def consume(generator, stop=None):
    events = []
    try:
        async for event in generator:
            events.append(event)
            if stop is not None and stop(event):
                break
    finally:
        await generator.aclose()
    return events


@pytest.fixture
def session(tmp_path):
    s = Session(name="telemetry adversarial", project_path=str(tmp_path))
    s.add_message("system", "You are Andromity.")
    return s


@pytest.fixture
def seen(monkeypatch):
    record = {"tasks": [], "session_end": [], "session_update": [], "features": []}
    monkeypatch.setattr(telemetry_module, "send_task_event",
                        lambda event, sid, run_id, **kw: record["tasks"].append((event, kw.get("outcome"), run_id)))
    monkeypatch.setattr(telemetry_module, "send_session_end", lambda sid=None, **kw: record["session_end"].append(kw))
    monkeypatch.setattr(telemetry_module, "send_session_update",
                        lambda sid, **kw: record["session_update"].append(kw))
    monkeypatch.setattr(telemetry_module, "send_session_start", lambda *a, **kw: None)
    monkeypatch.setattr(telemetry_module, "send_feature_used", lambda feature, **kw: record["features"].append(feature))
    return record


def finished(record):
    return [(outcome, run_id) for event, outcome, run_id in record["tasks"] if event == "task_finished"]


def started(record):
    return [run_id for event, _, run_id in record["tasks"] if event == "task_started"]


# ── duration_seconds counts from the session's first request ─────────────────

async def test_session_duration_counts_from_the_first_request(session, monkeypatch, seen):
    script(monkeypatch, reply("one"), reply("two"), reply("three"))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    await asyncio.wait_for(consume(agent.run("first")), TIMEOUT)
    await asyncio.sleep(1.3)
    await asyncio.wait_for(consume(agent.run("second")), TIMEOUT)
    assert seen["session_end"][-1]["duration_sec"] >= 1.3
    assert seen["session_update"][-1]["duration_sec"] >= 1.3
    replacement = Agent(session, auto_approve=True, **TEXT_ONLY)
    await asyncio.wait_for(consume(replacement.run("third")), TIMEOUT)
    assert seen["session_end"][-1]["duration_sec"] >= 1.3


# ── task_finished when the consumer closes run() early ───────────────────────

async def test_task_finished_is_sent_when_the_consumer_closes_run_early(session, monkeypatch, seen):
    script(monkeypatch, stall)
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    await asyncio.wait_for(consume(agent.run("hi"), stop=lambda e: isinstance(e, TextDelta)), TIMEOUT)
    assert finished(seen) == [("cancelled", started(seen)[0])]


async def test_completed_outcome_is_kept_when_closed_right_after_done(session, monkeypatch, seen):
    script(monkeypatch, reply("all done"))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    await asyncio.wait_for(consume(agent.run("hi"), stop=lambda e: isinstance(e, Done)), TIMEOUT)
    assert [outcome for outcome, _ in finished(seen)] == ["completed"]


async def test_task_cancelled_by_task_cancel_reports_cancelled(session, monkeypatch, seen):
    script(monkeypatch, stall)
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    got_text = asyncio.Event()

    async def drive():
        async for event in agent.run("hi"):
            if isinstance(event, TextDelta):
                got_text.set()

    task = asyncio.create_task(drive())
    await asyncio.wait_for(got_text.wait(), TIMEOUT)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [outcome for outcome, _ in finished(seen)] == ["cancelled"]


# ── had_error stays 1 for the rest of the session ────────────────────────────

async def test_had_error_stays_set_after_a_provider_error(session, monkeypatch, seen):
    script(monkeypatch, provider_error(), reply("fine now"))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    await asyncio.wait_for(consume(agent.run("first")), TIMEOUT)
    await asyncio.wait_for(consume(agent.run("second")), TIMEOUT)
    assert seen["session_end"][-1]["had_error"]
    replacement = Agent(session, auto_approve=True, **TEXT_ONLY)
    await asyncio.wait_for(consume(replacement.run("third")), TIMEOUT)
    assert seen["session_end"][-1]["had_error"]


async def test_had_error_stays_set_after_a_request_that_raised(session, monkeypatch, seen):
    script(monkeypatch, explode, reply("fine now"))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    with pytest.raises(RuntimeError):
        await asyncio.wait_for(consume(agent.run("first")), TIMEOUT)
    assert [outcome for outcome, _ in finished(seen)] == ["failed"]
    await asyncio.wait_for(consume(agent.run("second")), TIMEOUT)
    assert seen["session_end"], "no session_end after the second request"
    assert seen["session_end"][-1]["had_error"], "a failed request did not mark the session as having an error"


async def test_had_error_stays_set_when_closed_right_after_the_error(session, monkeypatch, seen):
    script(monkeypatch, provider_error(), reply("fine now"))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    await asyncio.wait_for(
        consume(agent.run("first"), stop=lambda e: isinstance(e, Done) and e.outcome == "error"), TIMEOUT)
    assert [outcome for outcome, _ in finished(seen)] == ["failed"]
    await asyncio.wait_for(consume(agent.run("second")), TIMEOUT)
    assert seen["session_end"][-1]["had_error"], "a failed request did not mark the session as having an error"


# ── a telemetry failure never breaks run() ───────────────────────────────────

def _join_legacy_threads(timeout=10.0):
    import time
    deadline = time.monotonic() + timeout
    for thread in threading.enumerate():
        if thread.name.endswith("(_post)"):
            thread.join(max(0.0, deadline - time.monotonic()))


@pytest.mark.parametrize("broken", ["_post", "_get_or_create_user_id", "_detect_client"])
async def test_internal_telemetry_failure_never_breaks_run(session, monkeypatch, broken):
    if hasattr(telemetry_module, "_suppressed"):
        monkeypatch.setattr(telemetry_module, "_suppressed", lambda: False)
    else:
        monkeypatch.setattr(telemetry_module, "_should_send_telemetry", lambda: True)
    monkeypatch.setattr(telemetry_module, "_PING_ENDPOINT", "http://127.0.0.1:9/ping")
    monkeypatch.setattr(telemetry_module, "_EVENT_ENDPOINT", "http://127.0.0.1:9/event")
    monkeypatch.setattr(telemetry_module, "_tracked_sessions", set())

    def refuse(*args, **kwargs):
        raise OSError("network disabled in tests")

    def fail(*args, **kwargs):
        raise RuntimeError("telemetry broke")

    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    monkeypatch.setattr(telemetry_module, broken, fail)
    script(monkeypatch, reply("still works"))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    try:
        events = await asyncio.wait_for(consume(agent.run("hi")), TIMEOUT)
    finally:
        _join_legacy_threads()
    assert any(isinstance(e, Done) and e.outcome == "success" for e in events)


async def test_run_survives_a_raising_task_event_hook(session, monkeypatch, seen):
    def broken(*args, **kwargs):
        raise RuntimeError("telemetry hook failed")

    monkeypatch.setattr(telemetry_module, "send_task_event", broken)
    script(monkeypatch, reply("still works"))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    events = await asyncio.wait_for(consume(agent.run("hi")), TIMEOUT)
    assert any(isinstance(e, Done) and e.outcome == "success" for e in events)
