"""Adversarial checks for Stop: the turn, every sub-agent the session started, their commands, and the title call.

Everything runs offline: model streams, the title call and sub-agent work are faked, and name lookups for
anything but the local machine fail.
"""
import asyncio
import concurrent.futures
import json
import os
import socket
import sys
import threading
import time
from types import SimpleNamespace

import pytest

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

from andromity.config import config
from andromity.core import tools
from andromity.core.events import Done, TextDelta, ToolCallDelta, ToolCallEnd, ToolCallStart
from andromity.core.session import Session
from andromity.core.subagent import SubAgent, SubAgentResult
from andromity.core.subagent_orchestrator import SubAgentOrchestrator
from andromity.server import rpc_handler as rpc_mod
from andromity.server.rpc_handler import JsonRpcHandler

USAGE = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
_LOCAL_HOSTS = {None, "", "localhost", "127.0.0.1", "::1"}


# ── Offline guards and fakes ────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    real = socket.getaddrinfo

    def guarded(host, *args, **kwargs):
        name = host.decode() if isinstance(host, bytes) else host
        if name not in _LOCAL_HOSTS and not str(name).startswith("127."):
            raise OSError(f"network is disabled in this test: {name}")
        return real(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", guarded)
    monkeypatch.setenv("DO_NOT_TRACK", "1")
    monkeypatch.setenv("ANDROMITY_NO_TELEMETRY", "1")


class FakeTitleModel:
    def __init__(self):
        self.calls = []
        self.mode = "reply"
        self.content = "Generated title"
        self.cancelled = 0

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.mode == "hang":
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                self.cancelled += 1
                raise
        if self.mode == "raise":
            raise RuntimeError("provider down")
        if self.mode == "no_choices":
            return SimpleNamespace(choices=[])
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=self.content))])


@pytest.fixture(autouse=True)
def title_model(monkeypatch):
    import litellm
    fake = FakeTitleModel()
    monkeypatch.setattr(litellm, "acompletion", fake)
    return fake


@pytest.fixture(autouse=True)
def _no_snapshots(monkeypatch):
    monkeypatch.setattr(rpc_mod, "ensure_git_tracking", lambda path: None)
    monkeypatch.setattr(rpc_mod, "create_pre_edit_snapshot", lambda path: None)


@pytest.fixture(autouse=True)
def _kill_leftover_commands():
    yield
    with tools._fg_lock:
        owners = list(tools._fg_processes)
    for owner in owners:
        tools.stop_session_commands(owner)


class Script:
    """A fake model. Each call plays the next step; calls past the end hang until cancelled.
    A step is a list of events, or of zero-argument coroutine functions awaited in place."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.calls = 0
        self.tasks = []
        self.cancelled = 0
        self.seen = []

    async def __call__(self, messages, tools=None, **kwargs):
        self.calls += 1
        self.seen.append(list(messages))
        self.tasks.append(asyncio.current_task())
        idx = self.calls - 1
        step = self.steps[idx] if idx < len(self.steps) else "hang"
        try:
            if step == "hang":
                await asyncio.sleep(3600)
                return
            for item in step:
                if callable(item):
                    await item()
                else:
                    yield item
        except asyncio.CancelledError:
            self.cancelled += 1
            raise


def call(name, args, tid):
    return [ToolCallStart(tool_name=name, tool_id=tid), ToolCallDelta(tool_id=tid, args_json_chunk=json.dumps(args)),
            ToolCallEnd(tool_id=tid), Done(usage=USAGE)]


def text(value):
    return [TextDelta(text=value), Done(usage=USAGE)]


def spawn(task="work", wait=False, tid="sp1"):
    return call("spawn_subagent", {"role": "general", "task": task, "wait": wait, "tools": ["shell_exec"]}, tid)


def _run_python(script) -> str:
    shell = tools.get_shell().lower()
    if "powershell" in shell or "pwsh" in shell:
        return f"& '{sys.executable}' '{script}'"
    if shell.endswith("cmd") or shell.endswith("cmd.exe"):
        return f'"{sys.executable}" "{script}"'
    return f"'{sys.executable}' '{script}'"


def sleeper(tmp_path, name, seconds):
    script = tmp_path / f"{name}.py"
    started = tmp_path / f"{name}.started"
    finished = tmp_path / f"{name}.finished"
    script.write_text(
        f"import time\nopen(r'{started}', 'w').write(str(time.time()))\ntime.sleep({seconds})\n"
        f"open(r'{finished}', 'w').write('x')\n",
        encoding="utf-8",
    )
    return _run_python(script), started, finished


class Notes(list):
    def __bool__(self):
        return True

    def __call__(self, notification):
        self.append((notification.method, notification.params))

    def of(self, method, sid=None):
        return sum(1 for m, p in self if m == method and (sid is None or (p or {}).get("session_id") == sid))


async def until(predicate, timeout=10.0, step=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(step)
    return bool(predicate())


def running(handler, sid):
    task = handler._running_tasks.get(sid)
    return task is not None and not task.done()


@pytest.fixture
def project(tmp_path, monkeypatch):
    proj = tmp_path / "proj"
    proj.mkdir()
    config.set_trusted(str(proj))
    monkeypatch.setattr(tools, "_get_project_root", lambda: proj)
    return proj


@pytest.fixture
def models(monkeypatch):
    holder = SimpleNamespace(main=Script([]), sub=Script([]))

    async def main_stream(messages, tools=None, **kwargs):
        async for event in holder.main(messages, tools, **kwargs):
            yield event

    async def sub_stream(messages, tools=None, **kwargs):
        async for event in holder.sub(messages, tools, **kwargs):
            yield event

    monkeypatch.setattr("andromity.core.agent.stream_completion", main_stream)
    monkeypatch.setattr("andromity.core.subagent.stream_completion", sub_stream)
    return holder


async def prompt(handler, sid, proj, mode="full", text_="go"):
    return await handler.rpc_agent_prompt({
        "prompt": text_, "session_id": sid, "project_path": str(proj), "mode": mode,
        "provider": "openai", "model": "gpt-4o-mini",
    })


async def cancel(handler, sid, timeout=15.0):
    return await asyncio.wait_for(handler.rpc_agent_cancel({"session_id": sid}), timeout)


def live_title_tasks(handler):
    """Title tasks the handler still tracks, whether it keeps one task or a set per session."""
    tracked = []
    for entry in (getattr(handler, "_title_tasks", None) or {}).values():
        tracked.extend(entry if isinstance(entry, (set, list, tuple)) else [entry])
    return [t for t in tracked if not t.done()]


async def shutdown(handler):
    """Cancel whatever a test left running so nothing outlives it."""
    for task in list(handler._running_tasks.values()) + live_title_tasks(handler):
        if not task.done():
            task.cancel()
    for session in list(handler._active_sessions.values()):
        for orch in [getattr(session, "_orchestrator", None), *(getattr(session, "_earlier_orchestrators", None) or [])]:
            if isinstance(orch, SubAgentOrchestrator):
                orch.kill_all("test_cleanup")
    with tools._fg_lock:
        owners = list(tools._fg_processes)
    for owner in owners:
        tools.stop_session_commands(owner)
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.wait(pending, timeout=10)


def sub_owners(main_sid):
    with tools._fg_lock:
        return [o for o, procs in tools._fg_processes.items() if o != main_sid and procs]


# ── Claim 1: Stop cancels the turn before stopping its commands ────────────

async def test_no_model_request_after_stop_while_a_command_runs(project, models):
    cmd, started, finished = sleeper(project, "main", 30)
    models.main = Script([call("shell_exec", {"command": cmd, "timeout": 120}, "c1"), text("after the command")])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-cmd-1"
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: started.exists() and tools._fg_processes.get(sid), 20)
        res = await cancel(handler, sid)
        assert res["cancelled"] is True
        assert await until(lambda: not running(handler, sid), 15)
        await asyncio.sleep(0.5)
        assert models.main.calls == 1, "a model request went out after Stop"
        assert not finished.exists()
        assert notes.of("agent/cancelled", sid) == 1
        assert notes.of("agent/done", sid) == 0
    finally:
        await shutdown(handler)


@pytest.mark.parametrize("attempt", range(3))
async def test_no_model_request_after_stop_repeated(project, models, attempt):
    cmd, started, _ = sleeper(project, f"rep{attempt}", 30)
    models.main = Script([call("shell_exec", {"command": cmd, "timeout": 120}, "c1"), text("next")])
    handler = JsonRpcHandler(send_notification=Notes())
    sid = f"stop-rep-{attempt}"
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: tools._fg_processes.get(sid), 20)
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 15)
        await asyncio.sleep(0.3)
        assert models.main.calls == 1
    finally:
        await shutdown(handler)


async def test_stop_twice_quickly_cancels_once_and_cleans_up(project, models):
    models.main = Script(["hang"])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-twice"
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: models.main.calls == 1)
        first, second = await asyncio.wait_for(asyncio.gather(
            handler.rpc_agent_cancel({"session_id": sid}), handler.rpc_agent_cancel({"session_id": sid})), 15)
        assert first["success"] and second["success"]
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.2)
        assert notes.of("agent/cancelled", sid) == 1
        assert sid not in handler._active_agents
        assert handler._active_sessions[sid].status == "cancelled"
        assert models.main.calls == 1
    finally:
        await shutdown(handler)


async def test_second_stop_during_turn_cleanup_does_not_skip_cleanup(project, models, monkeypatch):
    """The turn's own cleanup (closing snapshot, dropping the agent) must survive a second Stop."""
    snaps = []

    def slow_snapshot(path):
        snaps.append(time.monotonic())
        if len(snaps) >= 2:
            time.sleep(1.0)
        return f"hash{len(snaps)}"

    monkeypatch.setattr(rpc_mod, "create_pre_edit_snapshot", slow_snapshot)
    models.main = Script(["hang"])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-cleanup"
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: models.main.calls == 1)
        await cancel(handler, sid)
        assert await until(lambda: len(snaps) >= 2, 5), "the turn's closing snapshot never started"
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(1.2)
        session = handler._active_sessions[sid]
        assert sid not in handler._active_agents, "the stopped turn's agent was left registered"
        record = session.undo_stack[-1]
        assert record.get("after_hash"), "the turn's checkpoint was left without its closing snapshot"
        assert notes.of("agent/cancelled", sid) == 1
    finally:
        await shutdown(handler)


async def test_stop_racing_normal_turn_end(project, models, monkeypatch):
    """Stop pressed just after the answer finished: the client must not get both done and cancelled."""
    snaps = []

    def slow_snapshot(path):
        snaps.append(time.monotonic())
        if len(snaps) >= 2:
            time.sleep(0.8)
        return f"hash{len(snaps)}"

    monkeypatch.setattr(rpc_mod, "create_pre_edit_snapshot", slow_snapshot)
    models.main = Script([text("all done")])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-race-end"
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: len(snaps) >= 2, 10)
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.2)
        done, cancelled = notes.of("agent/done", sid), notes.of("agent/cancelled", sid)
        assert done + cancelled == 1, f"agent/done={done} agent/cancelled={cancelled} for one turn"
        assert models.main.calls == 1
    finally:
        await shutdown(handler)


@pytest.mark.xfail(strict=True, reason="older gap: Stop during receipt sealing after agent/done")
async def test_stop_after_done_was_sent_does_not_also_report_cancelled(project, models, monkeypatch):
    """Stop pressed while the finished turn seals its receipt (after agent/done went out)."""
    sealing = threading.Event()

    def slow_seal(session, checkpoint):
        sealing.set()
        time.sleep(0.8)
        return None

    monkeypatch.setattr(rpc_mod, "create_pre_edit_snapshot", lambda path: "hash")
    monkeypatch.setattr(rpc_mod, "seal_receipt", slow_seal)
    monkeypatch.setattr("andromity.core.git_ops.checkpoint_changed_files", lambda *a, **k: [])
    models.main = Script([text("all done")])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-race-seal"
    try:
        await prompt(handler, sid, project)
        assert await until(sealing.is_set, 10), "the receipt was never sealed"
        assert notes.of("agent/done", sid) == 1
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(1.0)
        cancelled = notes.of("agent/cancelled", sid)
        status = handler._active_sessions[sid].status
        assert cancelled == 0 and status != "cancelled", \
            f"turn already reported done, then agent/cancelled={cancelled} and status={status!r}"
    finally:
        await shutdown(handler)


# ── Claim 2: Stop reaches sub-agents from this turn and earlier turns ──────

async def _turn_with_background_subagent(handler, sid, project, models, cmd, started):
    models.main = Script([spawn(), text("spawned"), text("second turn")])
    models.sub = Script([call("shell_exec", {"command": cmd, "timeout": 120}, "s1"), text("sub done")])
    await prompt(handler, sid, project)
    assert await until(lambda: not running(handler, sid), 20), "turn 1 did not end"
    assert await until(lambda: sub_owners(sid) and started.exists(), 20), "the background sub-agent's command never started"


async def test_stop_with_no_turn_running_ends_earlier_turns_subagents_and_commands(project, models):
    cmd, started, finished = sleeper(project, "sub", 30)
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-earlier-idle"
    try:
        await _turn_with_background_subagent(handler, sid, project, models, cmd, started)
        await prompt(handler, sid, project, text_="turn two")
        assert await until(lambda: not running(handler, sid), 20), "turn 2 did not end"
        assert sub_owners(sid), "the sub-agent should still be running before Stop"
        sub_calls = models.sub.calls
        res = await cancel(handler, sid)
        assert res["cancelled"] is False
        assert await until(lambda: not sub_owners(sid), 8), "the earlier turn's sub-agent command kept running"
        assert await until(lambda: all(t.done() for t in models.sub.tasks), 8), "the sub-agent task kept running"
        await asyncio.sleep(0.5)
        assert models.sub.calls == sub_calls, "the sub-agent sent a model request after Stop"
        assert not finished.exists()
    finally:
        await shutdown(handler)


async def test_stop_during_a_later_turn_ends_earlier_turns_subagents(project, models):
    cmd, started, finished = sleeper(project, "sub2", 30)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-earlier-busy"
    try:
        await _turn_with_background_subagent(handler, sid, project, models, cmd, started)
        models.main = Script(["hang"])
        await prompt(handler, sid, project, text_="turn two")
        assert await until(lambda: models.main.calls == 1)
        sub_calls = models.sub.calls
        res = await cancel(handler, sid)
        assert res["cancelled"] is True
        assert await until(lambda: not sub_owners(sid), 8)
        assert await until(lambda: all(t.done() for t in models.sub.tasks), 8)
        await asyncio.sleep(0.3)
        assert models.sub.calls == sub_calls
    finally:
        await shutdown(handler)


async def test_stop_for_unknown_session_and_missing_id(project):
    handler = JsonRpcHandler(send_notification=Notes())
    res = await cancel(handler, "never-seen-session")
    assert res == {"success": True, "session_id": "never-seen-session", "cancelled": False}
    assert "never-seen-session" not in handler._active_sessions
    for bad in (None, ""):
        with pytest.raises(ValueError):
            await handler.rpc_agent_cancel({"session_id": bad})


async def test_deleted_session_does_not_leave_background_subagent_unstoppable(project, models):
    """A session deleted while its background sub-agent runs: the sub-agent must not run on, unreachable."""
    cmd, started, finished = sleeper(project, "orphan", 30)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-deleted"
    try:
        await _turn_with_background_subagent(handler, sid, project, models, cmd, started)
        deleted = await handler.rpc_session_delete({"session_id": sid})
        assert deleted["success"]
        await cancel(handler, sid)
        assert await until(lambda: all(t.done() for t in models.sub.tasks), 5), \
            "a deleted session's background sub-agent keeps running and Stop cannot reach it"
    finally:
        await shutdown(handler)


async def test_stop_while_subagent_is_being_spawned(project, models):
    """Stop lands in the same loop pass as the spawn: the new sub-agent must never send a request."""
    gate = asyncio.Event()

    async def hold():
        await gate.wait()

    models.main = Script([[hold, *spawn(wait=True)], "hang"])
    models.sub = Script([text("should never run")])
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-spawning"
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: models.main.calls == 1)
        gate.set()
        await asyncio.sleep(0)
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.3)
        assert models.sub.calls == 0, "a sub-agent spawned as Stop landed still called the model"
    finally:
        await shutdown(handler)


@pytest.mark.parametrize("wait", [True, False])
async def test_stop_landing_inside_spawn(project, models, monkeypatch, wait):
    """Stop is requested from inside SubAgent creation, so it runs before the new sub-agent's first step."""
    handler = JsonRpcHandler(send_notification=Notes())
    sid = f"stop-inside-spawn-{wait}"
    stops = []
    real_init = SubAgent.__init__

    def init_then_stop(self, *args, **kwargs):
        real_init(self, *args, **kwargs)
        stops.append(asyncio.ensure_future(handler.rpc_agent_cancel({"session_id": sid})))

    monkeypatch.setattr(SubAgent, "__init__", init_then_stop)
    models.main = Script([spawn(wait=wait), text("after spawn")])
    models.sub = Script([text("should never run")])
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: stops, 10)
        await asyncio.wait_for(stops[0], 15)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.3)
        assert models.sub.calls == 0, "a sub-agent spawned as Stop landed still called the model"
        assert models.main.calls == 1, "the turn called the model again after Stop"
    finally:
        await shutdown(handler)


async def test_subagent_finishing_exactly_as_stop_lands(project, monkeypatch):
    session = Session(name="finish-race", project_path=str(project))
    orch = SubAgentOrchestrator(parent_session_id=session.id, project_path=str(project), permission_mode="full")
    session._orchestrator = orch

    async def finish(self):
        self.status = "completed"
        return SubAgentResult(agent_id=self.id, role=self.role, status="completed", summary="ok")

    monkeypatch.setattr(SubAgent, "execute", finish)
    res = await orch.spawn(role="general", task="t", wait=False)
    task = orch._tasks[res.agent_id]
    await asyncio.wait_for(asyncio.shield(task), 5)
    handler = JsonRpcHandler(send_notification=Notes())
    handler._active_sessions[session.id] = session
    out = await cancel(handler, session.id)
    assert out["success"]
    assert orch.get_status(res.agent_id)["status"] == "completed"
    assert task.result().status == "completed"


# ── Claim 3: stopping commands does not depend on the default executor ─────

async def test_stop_works_when_default_executor_is_full(project):
    loop = asyncio.get_running_loop()
    small = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(small)
    release = threading.Event()
    blocker = loop.run_in_executor(None, release.wait, 30)
    cmd, started, finished = sleeper(project, "busy", 30)
    session = Session(name="busy", project_path=str(project))
    out = {}

    def run():
        token = tools._current_session_var.set(session)
        try:
            out["result"] = tools.shell_exec(cmd, timeout=120)
        finally:
            tools._current_session_var.reset(token)

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    handler = JsonRpcHandler(send_notification=Notes())
    try:
        assert await until(lambda: tools._fg_processes.get(session.id), 15)
        t0 = time.monotonic()
        await asyncio.wait_for(handler.rpc_agent_cancel({"session_id": session.id}), 8)
        worker.join(10)
        assert not worker.is_alive()
        assert time.monotonic() - t0 < 8
        assert out["result"].startswith("Stopped")
    finally:
        release.set()
        tools.stop_session_commands(session.id)
        worker.join(10)
        await asyncio.wait_for(blocker, 10)


@pytest.mark.xfail(strict=True, reason="fixed by the command-scope change on another branch")
def test_stop_kills_a_program_that_is_no_longer_in_the_commands_process_tree(project):
    """Stop kills a command by its parent-id tree. A program that joins late (the shell still starting it) or
    whose parent already exited is outside that tree and outlives Stop. The parent-exited case is the
    deterministic form of the start race."""
    base = getattr(sys, "_base_executable", None) or sys.executable
    started, finished = project / "orphan.started", project / "orphan.finished"
    grandchild = project / "grandchild.py"
    grandchild.write_text(
        f"import time\nopen(r'{started}', 'w').write('x')\ntime.sleep(3)\nopen(r'{finished}', 'w').write('x')\n",
        encoding="utf-8")
    middle = project / "middle.py"
    middle.write_text(f"import subprocess\nsubprocess.Popen([r'{base}', r'{grandchild}'])\n", encoding="utf-8")
    parent = project / "parent.py"
    parent.write_text(f"import subprocess, time\nsubprocess.run([r'{base}', r'{middle}'])\ntime.sleep(30)\n",
                      encoding="utf-8")
    session = Session(name="orphan", project_path=str(project))
    out = {}

    def run():
        token = tools._current_session_var.set(session)
        try:
            out["r"] = tools.shell_exec(_run_python(parent), timeout=60)
        finally:
            tools._current_session_var.reset(token)

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and not started.exists():
        time.sleep(0.02)
    assert started.exists(), "the command never started its program"
    t0 = time.monotonic()
    tools.stop_session_commands(session.id)
    worker.join(10)
    took = time.monotonic() - t0
    time.sleep(max(0.0, 3.5 - took))
    assert not finished.exists() and took < 1.5, \
        f"the program outlived Stop, and Stop waited {took:.1f}s for it to exit on its own"


@pytest.mark.xfail(strict=True, reason="older gap: a shell_exec queued behind a full default executor starts after Stop")
async def test_queued_command_does_not_start_after_stop(project, models):
    """With every default-executor thread busy, a turn's command waits for a thread. After Stop it must not start."""
    loop = asyncio.get_running_loop()
    gate = asyncio.Event()

    async def hold():
        await gate.wait()

    cmd, started, finished = sleeper(project, "queued", 4)
    models.main = Script([[hold, *call("shell_exec", {"command": cmd, "timeout": 60}, "q1")], text("after")])
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-queued"
    release = threading.Event()
    blocker = None
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: models.main.calls == 1)
        loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=1))
        blocker = loop.run_in_executor(None, release.wait, 30)
        gate.set()
        await asyncio.sleep(0.5)
        assert not started.exists()
        await cancel(handler, sid)
        release.set()
        await until(lambda: started.exists() or not running(handler, sid), 20)
        assert not started.exists(), "a command started after Stop"
        assert await until(lambda: not running(handler, sid), 8)
        assert models.main.calls == 1
    finally:
        release.set()
        if blocker is not None:
            await asyncio.wait_for(blocker, 10)
        await shutdown(handler)


# ── Claim 4: the session-title call is bounded and stoppable ───────────────

async def test_title_call_is_bounded(project, title_model):
    handler = JsonRpcHandler(send_notification=Notes())
    session = Session(name="Short title", project_path=str(project))
    await asyncio.wait_for(handler._generate_ai_session_name(session, "fix the build", "openai", "gpt-4o-mini"), 10)
    assert title_model.calls, "no title request was made"
    kwargs = title_model.calls[0]
    assert kwargs.get("max_tokens") == 256
    assert kwargs.get("timeout") == 20
    assert session.name == "Generated title"


async def test_title_call_hanging_past_its_timeout_gives_up(project, title_model, monkeypatch):
    from andromity.core import connections
    monkeypatch.setattr(connections, "TITLE_TIMEOUT_SECONDS", 0.2, raising=False)
    title_model.mode = "hang"
    handler = JsonRpcHandler(send_notification=Notes())
    session = Session(name="Short title", project_path=str(project))
    await asyncio.wait_for(handler._generate_ai_session_name(session, "fix it", "openai", "gpt-4o-mini"), 8)
    assert session.name == "Short title"
    assert title_model.cancelled == 1


@pytest.mark.parametrize("mode, content", [("reply", ""), ("reply", None), ("reply", "   "), ("raise", None),
                                           ("no_choices", None), ("reply", '""')])
async def test_title_failure_or_empty_reply_keeps_short_title(project, title_model, mode, content):
    title_model.mode, title_model.content = mode, content
    handler = JsonRpcHandler(send_notification=Notes())
    session = Session(name="Short title", project_path=str(project))
    await asyncio.wait_for(handler._generate_ai_session_name(session, "fix it", "openai", "gpt-4o-mini"), 8)
    assert session.name == "Short title"


async def test_stop_cancels_title_call_during_turn(project, models, title_model):
    title_model.mode = "hang"
    models.main = Script(["hang"])
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-title-busy"
    try:
        await prompt(handler, sid, project, text_="please refactor the parser")
        assert await until(lambda: title_model.calls and models.main.calls == 1, 10)
        await cancel(handler, sid)
        assert await until(lambda: title_model.cancelled == 1, 5), "the title request kept running after Stop"
        assert not live_title_tasks(handler)
    finally:
        await shutdown(handler)


async def test_stop_cancels_every_title_call_of_the_session(project, models, title_model):
    """A first prompt starting with "Session " still looks like a default name, so the next prompt starts a
    second title call while the first is still waiting."""
    title_model.mode = "hang"
    models.main = Script([text("one"), text("two")])
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-title-twice"
    try:
        for n in (1, 2):
            await prompt(handler, sid, project, text_="Session cleanup please")
            assert await until(lambda: not running(handler, sid) and len(title_model.calls) >= n, 10)
        if len(title_model.calls) < 2:
            pytest.skip("the second prompt did not start another title call")
        await cancel(handler, sid)
        assert await until(lambda: title_model.cancelled == 2, 3), \
            f"{2 - title_model.cancelled} title request(s) kept running after Stop"
    finally:
        await shutdown(handler)


async def test_stop_after_turn_end_cancels_title_call(project, models, title_model):
    title_model.mode = "hang"
    models.main = Script([text("quick answer")])
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-title-idle"
    try:
        await prompt(handler, sid, project, text_="explain the parser")
        assert await until(lambda: not running(handler, sid) and title_model.calls, 10)
        await cancel(handler, sid)
        assert await until(lambda: title_model.cancelled == 1, 5)
    finally:
        await shutdown(handler)


# ── Claim 5: TUI double-Esc ────────────────────────────────────────────────

class _Widget:
    def is_open(self):
        return False

    def add_system_message(self, *_a, **_k):
        pass

    def clear_input(self):
        pass

    def query_one(self, *_a, **_k):
        return self

    def focus(self):
        pass

    def show_hint(self, *_a, **_k):
        pass

    def push_notification(self, *_a, **_k):
        pass


class _Task:
    def __init__(self, log):
        self.log = log

    def done(self):
        return False

    def cancel(self):
        self.log.append("cancel")


async def _session_with_running_subagent(project, monkeypatch, earlier=True):
    session = Session(name="tui", project_path=str(project))

    async def hang(self):
        await asyncio.sleep(3600)

    monkeypatch.setattr(SubAgent, "execute", hang)
    orch = SubAgentOrchestrator(parent_session_id=session.id, project_path=str(project), permission_mode="full")
    res = await orch.spawn(role="general", task="t", wait=False)
    await asyncio.sleep(0)
    if earlier:
        session._earlier_orchestrators = [orch]
        session._orchestrator = SubAgentOrchestrator(parent_session_id=session.id, project_path=str(project))
    else:
        session._orchestrator = orch
    return session, orch, res.agent_id


def _fake_tui(session, task):
    return SimpleNamespace(screen_stack=[object()], _esc_count=1, _esc_time=time.time(), _is_streaming=True,
                           session=session, _current_task=task, query_one=lambda *a, **k: _Widget())


async def test_tui_double_esc_cancels_first_then_stops_subagents_and_their_commands(project, monkeypatch):
    from andromity.tui.app import AndromityApp
    log = []
    session, orch, aid = await _session_with_running_subagent(project, monkeypatch)
    sub_sid = orch.get_agent(aid).session.id
    monkeypatch.setattr(tools, "stop_session_commands", lambda sid: log.append(("stop", sid)) or 0)
    AndromityApp.action_escape_pressed(_fake_tui(session, _Task(log)))
    assert log and log[0] == "cancel", f"Esc must cancel the task before anything else: {log}"
    assert await until(lambda: ("stop", session.id) in log and ("stop", sub_sid) in log, 5), log
    await asyncio.sleep(0.05)
    assert orch._tasks[aid].done()


async def test_tui_double_esc_does_not_block_on_slow_command_stops(project, monkeypatch):
    from andromity.tui.app import AndromityApp
    stopped = []

    def slow_stop(sid):
        time.sleep(1.5)
        stopped.append(sid)
        return 1

    session, orch, aid = await _session_with_running_subagent(project, monkeypatch)
    monkeypatch.setattr(tools, "stop_session_commands", slow_stop)
    t0 = time.monotonic()
    AndromityApp.action_escape_pressed(_fake_tui(session, _Task([])))
    assert time.monotonic() - t0 < 0.5, "double-Esc blocked the terminal while commands were stopped"
    assert await until(lambda: len(stopped) == 2, 8), stopped


@pytest.mark.xfail(strict=True, reason="design choice: VS Code can stop background sub-agents")
async def test_tui_double_esc_when_idle_still_stops_background_subagents(project, monkeypatch):
    from andromity.tui.app import AndromityApp
    session, orch, aid = await _session_with_running_subagent(project, monkeypatch, earlier=False)
    monkeypatch.setattr(tools, "stop_session_commands", lambda sid: 0)
    try:
        AndromityApp.action_escape_pressed(_fake_tui(session, None))
        await asyncio.sleep(0.05)
        assert orch._tasks[aid].done(), "double-Esc with no turn running leaves background sub-agents running"
    finally:
        orch.kill_all("test_cleanup")
        await asyncio.wait([orch._tasks[aid]], timeout=5)


# ── Claim 6: no growth, and await_subagents waits only for this turn ──────

async def test_hundred_turns_with_background_subagents_do_not_grow(project, models, monkeypatch):
    finished = []

    async def quick(self):
        await asyncio.sleep(0)
        finished.append(self.id)
        return SubAgentResult(agent_id=self.id, role=self.role, status="completed", summary="ok")

    monkeypatch.setattr(SubAgent, "execute", quick)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-hundred"
    steps = []
    for i in range(100):
        steps += [spawn(tid=f"sp{i}"), text(f"turn {i}")]
    models.main = Script(steps)
    callbacks_before = len(tools._SUBAGENT_PROGRESS_CALLBACKS)
    try:
        for i in range(100):
            await prompt(handler, sid, project, text_=f"turn {i}")
            assert await until(lambda: not running(handler, sid), 20), f"turn {i} did not end"
            await until(lambda: len(finished) >= i + 1, 5)
        session = handler._active_sessions[sid]
        assert len(finished) == 100
        assert len(getattr(session, "_earlier_orchestrators", None) or []) <= 1
        assert len(handler._active_agents) == 0
        assert not live_title_tasks(handler)
        assert len(tools._SUBAGENT_PROGRESS_CALLBACKS) == callbacks_before
    finally:
        await shutdown(handler)


async def test_running_background_subagents_are_all_kept_and_all_stopped(project, models, monkeypatch):
    async def hang(self):
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            return SubAgentResult(agent_id=self.id, role=self.role, status="killed", summary="")

    monkeypatch.setattr(SubAgent, "execute", hang)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-twenty"
    steps = []
    for i in range(20):
        steps += [spawn(tid=f"sp{i}"), text(f"turn {i}")]
    models.main = Script(steps + [text("after stop")])
    try:
        for i in range(20):
            await prompt(handler, sid, project, text_=f"turn {i}")
            assert await until(lambda: not running(handler, sid), 20)
        session = handler._active_sessions[sid]
        from andromity.core.subagent_orchestrator import session_orchestrators
        orchs = session_orchestrators(session)
        tasks = [t for o in orchs for t in o._tasks.values()]
        assert len(tasks) == 20
        await cancel(handler, sid)
        assert await until(lambda: all(t.done() for t in tasks), 5)
        await prompt(handler, sid, project, text_="after stop")
        assert await until(lambda: not running(handler, sid), 20)
        assert len(session._earlier_orchestrators) == 0
    finally:
        await shutdown(handler)


async def test_await_subagents_waits_only_for_this_turn(project, monkeypatch):
    from andromity.core.agent import Agent
    release = asyncio.Event()

    async def run(self):
        if self.task == "slow":
            await release.wait()
        return SubAgentResult(agent_id=self.id, role=self.role, status="completed", summary=self.task)

    monkeypatch.setattr(SubAgent, "execute", run)
    session = Session(name="await", project_path=str(project))
    first = Agent(session=session, provider="openai", model="gpt-4o-mini")
    await first.orchestrator.spawn(role="general", task="slow", wait=False)
    second = Agent(session=session, provider="openai", model="gpt-4o-mini")
    await second.orchestrator.spawn(role="general", task="fast", wait=False)
    try:
        results = await asyncio.wait_for(second.await_subagents(), 3)
        assert [r.summary for r in results] == ["fast"]
    finally:
        release.set()
        await asyncio.wait_for(first.await_subagents(), 5)


async def test_kill_subagents_reaches_an_agents_own_orchestrator_after_session_moved_on(project, monkeypatch):
    """An Agent's kill_subagents must still reach sub-agents in its own orchestrator."""
    from andromity.core.agent import Agent

    async def hang(self):
        await asyncio.sleep(3600)

    monkeypatch.setattr(SubAgent, "execute", hang)
    session = Session(name="own", project_path=str(project))
    agent = Agent(session=session, provider="openai", model="gpt-4o-mini")
    Agent(session=session, provider="openai", model="gpt-4o-mini")
    res = await agent.spawn_subagent(role="general", task="t", wait=False)
    task = agent.orchestrator._tasks[res.agent_id]
    try:
        agent.kill_subagents("cancelled")
        await asyncio.sleep(0.05)
        assert task.done(), "kill_subagents missed a sub-agent in the agent's own orchestrator"
    finally:
        agent.orchestrator.kill_all("test_cleanup")
        await asyncio.wait([task], timeout=5)


# ── Permission mode, cron, pending interactions ────────────────────────────

async def test_new_subagents_use_the_new_permission_mode(project, models, monkeypatch):
    modes = []

    async def record(self):
        modes.append(self.permission_mode)
        if len(modes) == 1:
            await asyncio.sleep(3600)
        return SubAgentResult(agent_id=self.id, role=self.role, status="completed", summary="ok")

    monkeypatch.setattr(SubAgent, "execute", record)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-modes"
    models.main = Script([spawn(tid="a"), text("one"), spawn(tid="b"), text("two"), spawn(tid="c"), text("three")])
    try:
        for mode in ("full", "trust", "yolo"):
            await prompt(handler, sid, project, mode=mode)
            assert await until(lambda: not running(handler, sid), 20)
            await asyncio.sleep(0.05)
        assert modes == ["full", "trust", "yolo"]
    finally:
        await shutdown(handler)


async def test_stop_on_a_cron_run_ends_its_background_subagents(tmp_path, models, monkeypatch):
    proj = tmp_path / "cronproj"
    proj.mkdir()
    config.set_trusted(str(proj))
    monkeypatch.setattr(tools, "_get_project_root", lambda: proj)
    models.main = Script([spawn(tid="cs"), "hang"])
    models.sub = Script(["hang"])
    handler = JsonRpcHandler(send_notification=Notes())
    sched = handler._get_or_create_cron_scheduler(str(proj.resolve()))
    job = sched.add(name="Nightly", prompt="do it", schedule="every 1h", provider="openai", model="gpt-4o-mini",
                    mode="yolo")
    run = asyncio.create_task(handler._execute_cron_job(str(proj.resolve()), sched.claim(job.id)))
    try:
        assert await until(lambda: models.sub.calls == 1 and models.main.calls == 2, 20)
        cron_sid = next(iter(handler._cron_live_sessions))
        res = await cancel(handler, cron_sid)
        assert res["cancelled"] is True
        await asyncio.wait_for(asyncio.wait([run]), 10)
        assert await until(lambda: all(t.done() for t in models.sub.tasks), 5), \
            "Stop on a scheduled run left its background sub-agent running"
    finally:
        for t in models.sub.tasks:
            t.cancel()
        if not run.done():
            run.cancel()
        sched.stop()
        await shutdown(handler)


async def test_stop_resolves_pending_approval_and_never_runs_the_command(project, models):
    cmd, started, _ = sleeper(project, "approval", 5)
    models.main = Script([call("shell_exec", {"command": cmd}, "a1"), text("after")])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-approval"
    try:
        await prompt(handler, sid, project, mode="safe")
        assert await until(lambda: notes.of("agent/toolApprovalRequired", sid) == 1, 10)
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.5)
        assert not handler._pending_approvals
        assert notes.of("agent/interactionResolved", sid) == 1
        assert notes.of("agent/cancelled", sid) == 1
        assert not started.exists()
        assert models.main.calls == 1
    finally:
        await shutdown(handler)


async def test_stop_resolves_pending_question(project, models):
    models.main = Script([call("ask_questions", {"questions": [{"question": "Which?", "options": ["a", "b"]}]}, "q1"),
                          text("after")])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-question"
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: notes.of("agent/askQuestions", sid) == 1, 10)
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.3)
        assert not handler._pending_questions
        assert notes.of("agent/interactionResolved", sid) == 1
        assert notes.of("agent/cancelled", sid) == 1
        assert models.main.calls == 1
    finally:
        await shutdown(handler)


@pytest.mark.parametrize("race", [True, False], ids=["same-pass-as-timeout", "control-before-timeout"])
async def test_stop_in_the_same_loop_pass_as_a_stall_timeout_is_not_lost(project, monkeypatch, title_model, race):
    """The provider's stall guard is asyncio.wait_for, which cancels the turn task itself and then uncancels it.
    A Stop handled in that window sees task.cancelling() == 1, skips task.cancel(), and the stall becomes a retry."""
    from andromity.core import provider

    loop = asyncio.get_running_loop()
    handler = JsonRpcHandler(send_notification=Notes())
    sid = f"stop-stall-race-{race}"
    stream_calls = []
    stop_tasks = []
    real_guard = provider._first_token_guard

    class NeverStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            if len(stream_calls) == 1:
                base = loop.time()
                if race:
                    loop.call_at(base + 0.25, lambda: time.sleep(0.15))
                loop.call_at(base + (0.32 if race else 0.1), lambda: stop_tasks.append(asyncio.Task(
                    handler.rpc_agent_cancel({"session_id": sid}), loop=loop, eager_start=True)))
            await loop.create_future()

    async def fake_acompletion(**kwargs):
        if kwargs.get("stream"):
            stream_calls.append(kwargs)
            return NeverStream()
        return await title_model(**kwargs)

    import litellm
    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    monkeypatch.setattr(provider, "_first_token_guard", lambda stream, timeout, *a: real_guard(stream, 0.3))
    monkeypatch.setattr(provider, "STREAM_BACKOFF_DELAYS", [0.05, 0.05, 0.05])
    try:
        await prompt(handler, sid, project)
        assert await until(lambda: stop_tasks, 10), "the Stop was never sent"
        await asyncio.wait_for(stop_tasks[0], 10)
        await asyncio.sleep(1.0)
        assert len(stream_calls) == 1 and not running(handler, sid), \
            f"Stop was lost: {len(stream_calls)} model requests, turn still running={running(handler, sid)}"
    finally:
        await shutdown(handler)


# ── Round 2: lowering earlier sub-agents' permission mode ──────────────────

def _tool_results(messages):
    return [str(m.get("content")) for m in messages if m.get("role") == "tool"]


async def _gated_background_command(handler, sid, project, models, cmd, first_mode):
    """Turn 1 spawns a background sub-agent whose shell_exec waits on a gate; returns the gate."""
    gate = asyncio.Event()

    async def hold():
        await gate.wait()

    models.main = Script([spawn(), text("spawned"), text("second turn")])
    models.sub = Script([[hold, *call("shell_exec", {"command": cmd, "timeout": 60}, "m1")], text("sub done")])
    await prompt(handler, sid, project, mode=first_mode)
    if first_mode == "safe":
        notes = handler.send_notification
        assert await until(lambda: notes.of("agent/toolApprovalRequired", sid) == 1, 10)
        approval = next(p for m, p in notes if m == "agent/toolApprovalRequired" and p["session_id"] == sid)
        await handler.rpc_agent_approve_tool({"approval_id": approval["approval_id"], "session_id": sid})
    assert await until(lambda: not running(handler, sid) and models.sub.calls == 1, 20)
    return gate


@pytest.mark.parametrize("first, second, blocked", [
    ("yolo", "safe", True), ("full", "safe", True), ("safe", "yolo", True), ("safe", "full", True),
    ("yolo", "full", False),
])
async def test_later_turn_mode_applies_to_running_background_subagent(project, models, first, second, blocked):
    cmd, started, finished = sleeper(project, f"mode-{first}-{second}", 3)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = f"mode-{first}-{second}"
    try:
        gate = await _gated_background_command(handler, sid, project, models, cmd, first)
        await prompt(handler, sid, project, mode=second, text_="turn two")
        assert await until(lambda: not running(handler, sid), 20)
        gate.set()
        assert await until(lambda: models.sub.calls == 2, 20), "the sub-agent never reported its command"
        result = _tool_results(models.sub.seen[1])[-1]
        if blocked:
            assert "BLOCKED" in result and not started.exists(), f"{first} -> {second}: command ran: {result[:200]}"
        else:
            assert "BLOCKED" not in result, f"{first} -> {second}: command was blocked: {result[:200]}"
    finally:
        await shutdown(handler)


async def test_trust_turn_holds_earlier_yolo_subagent_to_the_allowlist(project, models):
    cmd, started, _ = sleeper(project, "mode-trust", 3)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "mode-yolo-trust"
    try:
        gate = await _gated_background_command(handler, sid, project, models, cmd, "yolo")
        await prompt(handler, sid, project, mode="trust", text_="turn two")
        assert await until(lambda: not running(handler, sid), 20)
        gate.set()
        assert await until(lambda: models.sub.calls == 2, 20)
        result = _tool_results(models.sub.seen[1])[-1]
        assert "BLOCKED" in result and not started.exists(), result[:200]
    finally:
        await shutdown(handler)


async def test_mode_switch_between_turns_reaches_running_background_subagent(project, models):
    """VS Code switches mode with config.set; a running YOLO sub-agent must not keep YOLO until the next prompt."""
    cmd, started, _ = sleeper(project, "mode-config", 3)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "mode-config-set"
    try:
        gate = await _gated_background_command(handler, sid, project, models, cmd, "yolo")
        await handler.rpc_config_set({"section": "default", "key": "permission_mode", "value": "safe"})
        gate.set()
        assert await until(lambda: models.sub.calls == 2, 20)
        result = _tool_results(models.sub.seen[1])[-1]
        assert "BLOCKED" in result and not started.exists(), \
            f"after switching to SAFE, the earlier YOLO sub-agent still ran its command: {result[:120]}"
    finally:
        await shutdown(handler)


def _tui_stub(session, agent, streaming=False):
    """An app stub carrying what the TUI's /mode command touches; the command handlers are the real ones."""
    from types import MethodType
    from andromity.tui.app import AndromityApp
    stub = SimpleNamespace(session=session, agent=agent, _yolo_session=False, _is_streaming=streaming,
                           _pending_mode_change=False, query_one=lambda *a, **k: _Widget(),
                           _update_status=lambda: None)
    for name in ("_handle_command", "_apply_mode_change", "_mode_for_subagents"):
        setattr(stub, name, MethodType(getattr(AndromityApp, name), stub))
    return stub


@pytest.mark.parametrize("start, command, running_after, new_after", [
    ("full", "/mode safe", "safe", "safe"),
    ("yolo", "/mode trust", "trust", "trust"),
    ("safe", "/mode full", "safe", "full"),
    ("safe", "/mode yolo", "safe", "yolo"),
])
async def test_tui_mode_command_reaches_running_and_new_subagents(project, monkeypatch, start, command,
                                                                  running_after, new_after):
    from andromity.core.agent import Agent

    async def hang(self):
        await asyncio.sleep(3600)

    monkeypatch.setattr(SubAgent, "execute", hang)
    config.set("default", "permission_mode", start)
    session = Session(name="tui-mode", project_path=str(project))
    agent = Agent(session=session, provider="openai", model="gpt-4o-mini")
    assert session._orchestrator is agent.orchestrator
    stub = _tui_stub(session, agent)
    token = tools._current_session_var.set(session)
    try:
        first = json.loads(await tools.spawn_subagent_async(role="general", task="before", wait=False))
        stub._handle_command(command)
        second = json.loads(await tools.spawn_subagent_async(role="general", task="after", wait=False))
        orch = session._orchestrator
        modes = {"running": orch.get_agent(first["agent_id"]).permission_mode,
                 "new": orch.get_agent(second["agent_id"]).permission_mode}
        assert modes == {"running": running_after, "new": new_after}, f"{start} then {command}: {modes}"
    finally:
        tools._current_session_var.reset(token)
        session._orchestrator.kill_all("test_cleanup")
        await asyncio.wait(list(session._orchestrator._tasks.values()), timeout=5)


async def test_auto_wake_turn_does_not_lower_running_subagents(project, models):
    cmd, started, _ = sleeper(project, "wake-mode", 3)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "mode-auto-wake"
    try:
        gate = await _gated_background_command(handler, sid, project, models, cmd, "yolo")
        session = handler._active_sessions[sid]
        await handler._start_wake_turn(session, "a message from another session")
        assert await until(lambda: not running(handler, sid), 20)
        assert session.permission_mode == "yolo"
        gate.set()
        assert await until(lambda: models.sub.calls == 2, 20)
        result = _tool_results(models.sub.seen[1])[-1]
        assert "BLOCKED" not in result, f"an auto-wake turn lowered the user's sub-agent: {result[:120]}"
    finally:
        await shutdown(handler)


@pytest.mark.parametrize("raw, stored", [(" YOLO ", "yolo"), ("Trust", "trust"), ("plan", "safe"), (None, "safe")])
async def test_config_set_stores_a_normalized_mode(project, raw, stored):
    handler = JsonRpcHandler(send_notification=Notes())
    await handler.rpc_config_set({"section": "default", "key": "permission_mode", "value": raw})
    assert config.get("default", "permission_mode") == stored


async def test_subagent_given_an_unknown_mode_is_held_to_safe(project):
    """Defense in depth: a sub-agent built with a mode no gate recognises must not run writes unchecked."""
    sub = SubAgent(parent_session_id="p", role="general", task="t", project_path=str(project),
                   permission_mode="plan", tools_override=["write_file"])
    target = project / "unknown-mode.txt"
    _, _, result = await asyncio.wait_for(sub._exec_tool({
        "id": "w1", "function": {"name": "write_file", "arguments": json.dumps({"path": str(target), "content": "x"})},
    }), 10)
    assert "BLOCKED" in result and not target.exists(), f"mode 'plan' let a sub-agent write: {result[:120]}"


async def test_stop_sent_right_after_the_prompt(project, models):
    """Prompt and Stop handled back to back, before the turn's task has run a step (two requests read together)."""
    models.main = Script(["hang"])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-right-after-prompt"
    try:
        await prompt(handler, sid, project)
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.3)
        problems = []
        if notes.of("agent/cancelled", sid) != 1:
            problems.append(f"agent/cancelled sent {notes.of('agent/cancelled', sid)} times")
        if sid in handler._active_agents:
            problems.append("the stopped turn's agent was left in _active_agents")
        if handler._active_sessions[sid].status != "cancelled":
            problems.append(f"session status is {handler._active_sessions[sid].status!r}")
        assert not problems, "; ".join(problems)
    finally:
        await shutdown(handler)


async def test_mode_with_stray_whitespace_is_not_treated_as_full(project, models):
    """A client sending "safe " must not get commands run without approval."""
    cmd, started, _ = sleeper(project, "ws-mode", 3)
    models.main = Script([call("shell_exec", {"command": cmd}, "w1"), text("after")])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "mode-whitespace"
    try:
        await prompt(handler, sid, project, mode="safe ")
        await until(lambda: notes.of("agent/toolApprovalRequired", sid) or started.exists(), 15)
        assert notes.of("agent/toolApprovalRequired", sid) == 1 and not started.exists(), \
            "mode 'safe ' ran a shell command without asking"
    finally:
        await shutdown(handler)


# ── Round 2: cron runs, title bookkeeping, TUI title call ──────────────────

async def _start_cron(handler, tmp_path, monkeypatch, timeout_seconds=600):
    proj = tmp_path / "cronproj"
    proj.mkdir()
    config.set_trusted(str(proj))
    monkeypatch.setattr(tools, "_get_project_root", lambda: proj)
    sched = handler._get_or_create_cron_scheduler(str(proj.resolve()))
    job = sched.add(name="Nightly", prompt="do it", schedule="every 1h", provider="openai", model="gpt-4o-mini",
                    mode="yolo", timeout_seconds=timeout_seconds)
    run = asyncio.create_task(handler._execute_cron_job(str(proj.resolve()), sched.claim(job.id)))
    return sched, run


async def test_cron_run_that_ends_leaves_no_unreachable_subagents(tmp_path, models, monkeypatch):
    """A cron run that finishes while its background sub-agent runs: nothing can reach that sub-agent later."""
    models.main = Script([spawn(tid="cr"), text("cron done")])
    models.sub = Script(["hang"])
    handler = JsonRpcHandler(send_notification=Notes())
    sched, run = await _start_cron(handler, tmp_path, monkeypatch)
    try:
        await asyncio.wait_for(asyncio.wait([run]), 20)
        assert await until(lambda: models.sub.calls == 1, 10)
        cron_sid = run.result()["session_id"]
        await cancel(handler, cron_sid)
        assert await until(lambda: all(t.done() for t in models.sub.tasks), 5), \
            "the finished cron run's background sub-agent keeps running and Stop cannot reach it"
    finally:
        for t in models.sub.tasks:
            t.cancel()
        sched.stop()
        await shutdown(handler)


async def test_cron_run_that_times_out_stops_its_background_subagents(tmp_path, models, monkeypatch):
    models.main = Script([spawn(tid="ct"), "hang"])
    models.sub = Script(["hang"])
    handler = JsonRpcHandler(send_notification=Notes())
    sched, run = await _start_cron(handler, tmp_path, monkeypatch, timeout_seconds=2)
    try:
        await asyncio.wait_for(asyncio.wait([run]), 20)
        assert run.result()["status"] == "timeout", run.result()
        assert await until(lambda: models.sub.tasks and all(t.done() for t in models.sub.tasks), 5), \
            "a cron run that hit its time limit left its background sub-agent running"
    finally:
        for t in models.sub.tasks:
            t.cancel()
        sched.stop()
        await shutdown(handler)


async def test_title_bookkeeping_does_not_grow_with_sessions(project, models, title_model):
    handler = JsonRpcHandler(send_notification=Notes())
    models.main = Script([text(f"answer {i}") for i in range(20)])
    try:
        for i in range(20):
            sid = f"title-grow-{i}"
            await prompt(handler, sid, project, text_=f"question {i}")
            assert await until(lambda: not running(handler, sid), 10)
        assert await until(lambda: not live_title_tasks(handler), 5)
        assert len(handler._title_tasks) <= 1, f"{len(handler._title_tasks)} per-session title entries kept"
    finally:
        await shutdown(handler)


async def test_tui_title_call_is_bounded(project, title_model):
    from andromity.tui.app import AndromityApp
    config.set("default", "provider", "openai")
    config.set("default", "model", "gpt-4o-mini")
    fake = SimpleNamespace(session=Session(name="Short title", project_path=str(project)), _update_status=lambda: None)
    await asyncio.wait_for(AndromityApp._generate_ai_session_name(fake, "fix the build"), 10)
    assert title_model.calls, "the TUI made no title request"
    kwargs = title_model.calls[0]
    assert (kwargs.get("max_tokens"), kwargs.get("timeout")) == (256, 20), \
        f"TUI title call: max_tokens={kwargs.get('max_tokens')} timeout={kwargs.get('timeout')}"


# ── Round 4: Stop before the turn's first step, TUI /mode while streaming, TUI cron ──

async def test_prompt_then_two_stops_dispatched_together(project, models):
    """Three requests read in one batch: each gets its own task, created in arrival order."""
    models.main = Script(["hang"])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-batch-two"
    try:
        p = asyncio.ensure_future(prompt(handler, sid, project))
        s1 = asyncio.ensure_future(handler.rpc_agent_cancel({"session_id": sid}))
        s2 = asyncio.ensure_future(handler.rpc_agent_cancel({"session_id": sid}))
        results = await asyncio.wait_for(asyncio.gather(p, s1, s2), 15)
        assert results[1]["cancelled"] and results[2]["cancelled"]
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.3)
        assert models.main.calls == 0
        assert notes.of("agent/cancelled", sid) == 1
        assert sid not in handler._active_agents
        assert handler._active_sessions[sid].status == "cancelled"
    finally:
        await shutdown(handler)


async def test_stop_dispatched_before_the_prompt_leaves_the_new_turn_running(project, models):
    models.main = Script(["hang"])
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-before-prompt"
    try:
        s = asyncio.ensure_future(handler.rpc_agent_cancel({"session_id": sid}))
        p = asyncio.ensure_future(prompt(handler, sid, project))
        res, _ = await asyncio.wait_for(asyncio.gather(s, p), 15)
        assert res["cancelled"] is False
        assert await until(lambda: models.main.calls == 1, 10)
        assert running(handler, sid) and notes.of("agent/cancelled", sid) == 0
    finally:
        await shutdown(handler)


async def test_stop_right_after_prompt_in_an_untrusted_folder_calls_no_provider(tmp_path, monkeypatch, title_model):
    """Same race through the real stream_completion: count calls into the provider client."""
    import litellm
    proj = tmp_path / "untrusted-real"
    proj.mkdir()
    monkeypatch.setattr(tools, "_get_project_root", lambda: proj)
    provider_calls = []

    class NeverStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            await asyncio.get_running_loop().create_future()

    async def fake_acompletion(**kwargs):
        if kwargs.get("stream"):
            provider_calls.append(kwargs)
            return NeverStream()
        return await title_model(**kwargs)

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    handler = JsonRpcHandler(send_notification=Notes())
    sid = "stop-untrusted-real"
    try:
        await prompt(handler, sid, proj)
        await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.3)
        assert not provider_calls, "the provider client was called after Stop"
    finally:
        await shutdown(handler)


async def test_stop_right_after_a_prompt_whose_turn_fails_at_once(project, monkeypatch):
    from andromity.core.agent import Agent

    async def broken_run(self, *args, **kwargs):
        raise RuntimeError("provider misconfigured")
        yield  # pragma: no cover

    monkeypatch.setattr(Agent, "run", broken_run)
    notes = Notes()
    handler = JsonRpcHandler(send_notification=notes)
    sid = "stop-fails-at-once"
    try:
        await prompt(handler, sid, project)
        res = await cancel(handler, sid)
        assert await until(lambda: not running(handler, sid), 10)
        await asyncio.sleep(0.2)
        outcome = (notes.of("agent/error", sid), notes.of("agent/cancelled", sid))
        assert sum(outcome) == 1, f"agent/error={outcome[0]} agent/cancelled={outcome[1]}"
        assert sid not in handler._active_agents
        assert res["success"]
    finally:
        await shutdown(handler)


@pytest.mark.parametrize("check", ["provider_call", "extra_step"])
@pytest.mark.parametrize("kind", ["cron", "turn"])
async def test_stop_gives_a_started_run_no_extra_step(tmp_path, models, monkeypatch, kind, check, title_model):
    """Stop arrives in the loop pass where a tool result wakes the run. The run must not call the provider again.
    The second model call goes through the real stream_completion; provider-client calls are counted."""
    import litellm
    from andromity.core import provider
    loop = asyncio.get_running_loop()
    handler = JsonRpcHandler(send_notification=Notes())
    release = asyncio.Event()
    entered = asyncio.Event()
    stop_tasks = []
    target = {}
    provider_calls = []
    entries = []

    class NeverStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            await loop.create_future()

    async def fake_acompletion(**kwargs):
        if kwargs.get("stream"):
            provider_calls.append(kwargs)
            return NeverStream()
        return await title_model(**kwargs)

    class Hybrid:
        calls = 0

        async def __call__(self, messages, tools=None, **kwargs):
            entries.append(stop_tasks[:] != [])
            type(self).calls += 1
            if type(self).calls == 1:
                for event in call("list_dir", {"path": "."}, "l1"):
                    yield event
                return
            async for event in provider.stream_completion(messages, tools, **kwargs):
                yield event

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)

    async def fake_exec(name, args, tool_id=None, timeout=None):
        entered.set()
        await release.wait()

        def stop_now():
            stop_tasks.append(asyncio.Task(handler.rpc_agent_cancel({"session_id": target["sid"]}),
                                           loop=loop, eager_start=True))

        loop.call_soon(lambda: loop.call_soon(stop_now))
        return "a.txt"

    monkeypatch.setattr(tools, "execute_tool_async", fake_exec)
    models.main = Hybrid()
    sched = run = None
    try:
        if kind == "cron":
            sched, run = await _start_cron(handler, tmp_path, monkeypatch)
            assert await until(entered.is_set, 20)
            target["sid"] = next(iter(handler._cron_live_sessions))
        else:
            proj = tmp_path / "turnproj"
            proj.mkdir()
            config.set_trusted(str(proj))
            monkeypatch.setattr(tools, "_get_project_root", lambda: proj)
            target["sid"] = "stop-extra-step"
            await prompt(handler, target["sid"], proj, mode="yolo")
            assert await until(entered.is_set, 20)
        release.set()
        assert await until(lambda: stop_tasks, 10)
        await asyncio.wait_for(stop_tasks[0], 10)
        await asyncio.sleep(0.3)
        if check == "provider_call":
            assert not provider_calls, f"{kind}: the run called the provider again while Stop was being handled"
        else:
            assert entries == [False], \
                f"{kind}: the run re-entered stream_completion after Stop was requested (entries: {entries})"
    finally:
        if run is not None and not run.done():
            run.cancel()
        if sched is not None:
            sched.stop()
        await shutdown(handler)


async def _tui_session_with_subagent(project, monkeypatch, start):
    from andromity.core.agent import Agent

    async def hang(self):
        await asyncio.sleep(3600)

    monkeypatch.setattr(SubAgent, "execute", hang)
    config.set("default", "permission_mode", start)
    session = Session(name="tui-stream", project_path=str(project))
    agent = Agent(session=session, provider="openai", model="gpt-4o-mini")
    token = tools._current_session_var.set(session)
    first = json.loads(await tools.spawn_subagent_async(role="general", task="before", wait=False))
    return session, agent, token, first["agent_id"]


async def _spawn_mode(session):
    res = json.loads(await tools.spawn_subagent_async(role="general", task="new", wait=False))
    return session._orchestrator.get_agent(res["agent_id"]).permission_mode


@pytest.mark.parametrize("start, command, during, after", [
    ("full", "/mode safe", ("safe", "safe", "safe"), ("safe", "safe")),
    ("safe", "/mode full", ("safe", "safe", "safe"), ("safe", "full")),
    ("trust", "/mode yolo", ("trust", "trust", "trust"), ("trust", "yolo")),
])
async def test_tui_mode_command_while_streaming(project, monkeypatch, start, command, during, after):
    """(session, running sub-agent, new sub-agent) while the response streams; (running, new) once it ends."""
    session, agent, token, first = await _tui_session_with_subagent(project, monkeypatch, start)
    stub = _tui_stub(session, agent, streaming=True)
    try:
        stub._handle_command(command)
        orch = session._orchestrator
        seen_during = (session.permission_mode, orch.get_agent(first).permission_mode, await _spawn_mode(session))
        stub._is_streaming = False
        if stub._pending_mode_change:
            stub._pending_mode_change = False
            stub._apply_mode_change()
        seen_after = (orch.get_agent(first).permission_mode, await _spawn_mode(session))
        assert (seen_during, seen_after) == (during, after), \
            f"{start} then {command} while streaming: during={seen_during} after={seen_after}"
    finally:
        tools._current_session_var.reset(token)
        session._orchestrator.kill_all("test_cleanup")
        await asyncio.wait(list(session._orchestrator._tasks.values()), timeout=5)


def _tui_cron_stub(project, agent):
    from types import MethodType
    from andromity.core.cron import CronScheduler
    from andromity.tui.app import AndromityApp
    workers = []
    stub = SimpleNamespace(
        _project_path=str(project), agent=agent, _cron_running_jobs=set(),
        _cron_scheduler=CronScheduler(str(project), on_trigger=lambda job: None),
        query_one=lambda *a, **k: _Widget(), refresh_cron_status=lambda: None, notify=lambda *a, **k: None,
        _get_ctx_limit=lambda: 0, run_worker=lambda coro, exclusive=False: workers.append(asyncio.ensure_future(coro)),
    )
    for name in ("_run_cron_job", "_make_cron_approval", "_end_subagents"):
        setattr(stub, name, MethodType(getattr(AndromityApp, name), stub))
    return stub, workers


@pytest.mark.parametrize("ending", ["finishes", "times_out"])
async def test_tui_cron_run_ends_its_background_subagents(project, models, monkeypatch, ending):
    from andromity.core.agent import Agent

    async def sub_running():
        await until(lambda: models.sub.calls >= 1, 10)

    second = [sub_running, *text("cron done")] if ending == "finishes" else "hang"
    models.main = Script([spawn(tid="tc"), second])
    models.sub = Script(["hang"])
    session = Session(name="tui-main", project_path=str(project))
    stub, workers = _tui_cron_stub(project, Agent(session=session, provider="openai", model="gpt-4o-mini"))
    job = stub._cron_scheduler.add(name="Nightly", prompt="do it", schedule="every 1h", provider="openai",
                                   model="gpt-4o-mini", mode="yolo", timeout_seconds=2 if ending == "times_out" else 600)
    try:
        stub._run_cron_job(job)
        assert workers, "the cron run never started"
        await asyncio.wait_for(asyncio.wait(workers), 20)
        assert models.sub.calls == 1, "the cron run's sub-agent never started"
        assert await until(lambda: all(t.done() for t in models.sub.tasks), 5), \
            f"a TUI cron run that {ending} left its background sub-agent running"
    finally:
        for t in models.sub.tasks:
            t.cancel()
        stub._cron_scheduler.stop()

