"""Independent adversarial tests for server/main.py dispatch and rpc_handler.py MCP/config changes.

  E1. UNQUEUED_METHODS bypass of the dispatch semaphore (_dispatch_limited), unit and over a real TCP socket
  E2. mcp.list / mcp.list_servers no longer await MCP startup (start_mcp_soon)
  E3. RpcRefusal handling in handle_request
  E4. config.get allowed_commands / allowed_domains

Written to break the new behaviour, not to pass. No network beyond a loopback socket; MCP start is faked.
"""
import asyncio
import functools
import gc
import json
import logging
import socket
import time
from pathlib import Path

import pytest

from andromity.config import config as app_config
from andromity.core.mcp import MCPClientManager
from andromity.server import main as server_main
from andromity.server.main import UNQUEUED_METHODS, _dispatch_limited
from andromity.server.protocol import INTERNAL_ERROR, JsonRpcRequest, RpcRefusal
from andromity.server.rpc_handler import JsonRpcHandler

SPEC_UNQUEUED = {
    "session.create", "session.get", "session.list", "config.status", "trust.status", "trust.set",
    "agent.prompt", "agent.cancel", "agent.approve_tool", "agent.reject_tool", "agent.answer_question",
}


def bounded(seconds: float = 30.0):
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            return await asyncio.wait_for(fn(*args, **kwargs), seconds)
        return wrapper
    return deco


async def settle(rounds=5):
    for _ in range(rounds):
        await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# E1. dispatch
# ---------------------------------------------------------------------------

def test_e1_unqueued_methods_match_the_documented_set():
    assert set(UNQUEUED_METHODS) == SPEC_UNQUEUED
    assert isinstance(UNQUEUED_METHODS, frozenset)


@pytest.mark.parametrize("method", sorted(SPEC_UNQUEUED))
def test_e1_every_unqueued_method_has_a_handler(method):
    assert callable(getattr(JsonRpcHandler, "rpc_" + method.replace(".", "_"), None)), method


class Recorder:
    def __init__(self, hold=None):
        self.started, self.finished = [], []
        self.hold = hold

    async def __call__(self, msg):
        self.started.append(msg.get("method"))
        if self.hold is not None and msg.get("method") not in UNQUEUED_METHODS:
            await self.hold.wait()
        self.finished.append(msg.get("method"))


@bounded()
async def test_e1_session_create_answers_while_every_slot_is_taken_and_others_still_queue():
    semaphore, release = asyncio.Semaphore(16), asyncio.Event()
    run = Recorder(hold=release)
    slow = [asyncio.create_task(_dispatch_limited(semaphore, {"method": "git.status", "id": i}, run)) for i in range(16)]
    await settle()
    assert len(run.started) == 16 and semaphore._value == 0
    queued = [asyncio.create_task(_dispatch_limited(semaphore, {"method": "git.log", "id": 100 + i}, run)) for i in range(5)]
    started = time.perf_counter()
    await asyncio.wait_for(_dispatch_limited(semaphore, {"method": "session.create", "id": "q"}, run), 1.0)
    assert time.perf_counter() - started < 0.5
    await settle()
    assert run.started.count("git.log") == 0, "non-exempt requests must keep queueing behind a full semaphore"
    assert not any(t.done() for t in slow + queued)
    release.set()
    await asyncio.gather(*slow, *queued)
    assert semaphore._value == 16, "slots leaked or over-released"
    assert run.started.count("git.log") == 5


@bounded()
async def test_e1_flood_of_exempt_requests_neither_takes_nor_releases_a_slot():
    semaphore, release = asyncio.Semaphore(16), asyncio.Event()
    run = Recorder(hold=release)
    slow = [asyncio.create_task(_dispatch_limited(semaphore, {"method": "git.status"}, run)) for _ in range(16)]
    await settle()
    exempt = [asyncio.create_task(_dispatch_limited(semaphore, {"method": m}, run))
              for m in sorted(SPEC_UNQUEUED) * 20]
    await asyncio.wait_for(asyncio.gather(*exempt), 3.0)
    assert semaphore._value == 0, "an exempt request released a slot it never took"
    release.set()
    await asyncio.gather(*slow)
    assert semaphore._value == 16


@bounded()
async def test_e1_exempt_check_is_exact_so_lookalike_names_still_queue():
    semaphore = asyncio.Semaphore(1)
    release = asyncio.Event()
    run = Recorder(hold=release)
    holder = asyncio.create_task(_dispatch_limited(semaphore, {"method": "git.status"}, run))
    await settle()
    lookalikes = ["Session.create", " session.create", "session.create ", "session.create\n", "session.createX",
                  "session.", "agent.run", "agent.cancelAll"]
    tasks = [asyncio.create_task(_dispatch_limited(semaphore, {"method": m}, run)) for m in lookalikes]
    await settle()
    assert not any(t.done() for t in tasks)
    release.set()
    await asyncio.gather(holder, *tasks)


@pytest.mark.parametrize("message", [
    {}, {"method": None}, {"method": 5}, {"method": 1.5}, {"method": True}, {"method": ""},
    {"method": ["session.create"]}, {"method": {"a": 1}}, {"method": [[]]}, {"method": [{"a": []}]},
    {"id": 1}, {"method": "x" * 100000},
])
@bounded()
async def test_e1_non_string_or_missing_method_never_crashes_dispatch(message):
    semaphore = asyncio.Semaphore(2)
    seen = []

    async def run(msg):
        seen.append(msg)

    await _dispatch_limited(semaphore, message, run)
    assert seen == [message], "the request must still reach the handler, which answers or logs the error"
    assert semaphore._value == 2


@bounded()
async def test_e1_failure_in_a_queued_request_releases_its_slot():
    semaphore = asyncio.Semaphore(1)

    async def boom(msg):
        raise RuntimeError("handler exploded")

    with pytest.raises(RuntimeError):
        await _dispatch_limited(semaphore, {"method": "git.status"}, boom)
    assert semaphore._value == 1


@bounded()
async def test_e1_cancelling_a_queued_request_does_not_leak_a_slot():
    semaphore, release = asyncio.Semaphore(1), asyncio.Event()
    run = Recorder(hold=release)
    holder = asyncio.create_task(_dispatch_limited(semaphore, {"method": "git.status"}, run))
    await settle()
    waiting = [asyncio.create_task(_dispatch_limited(semaphore, {"method": "git.log"}, run)) for _ in range(5)]
    await settle()
    for task in waiting:
        task.cancel()
    await asyncio.gather(*waiting, return_exceptions=True)
    release.set()
    await holder
    assert semaphore._value == 1


@bounded()
async def test_e1_cancelling_a_running_exempt_request_is_not_swallowed():
    semaphore = asyncio.Semaphore(1)

    async def forever(msg):
        await asyncio.Event().wait()

    task = asyncio.create_task(_dispatch_limited(semaphore, {"method": "agent.cancel"}, forever))
    await settle()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert semaphore._value == 1


class RawClient:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.replies = {}
        self.task = asyncio.create_task(self._pump())

    async def _pump(self):
        try:
            while True:
                line = await self.reader.readline()
                if not line:
                    return
                msg = json.loads(line)
                if "id" in msg:
                    self.replies[msg["id"]] = (time.perf_counter(), msg)
        except (asyncio.CancelledError, ConnectionError):
            pass

    def send(self, msg):
        self.writer.write((json.dumps(msg) + "\n").encode())

    async def wait_for(self, request_id, timeout):
        deadline = time.perf_counter() + timeout
        while request_id not in self.replies:
            if time.perf_counter() > deadline:
                raise AssertionError(f"no reply to {request_id} within {timeout}s")
            await asyncio.sleep(0.01)
        return self.replies[request_id][1]

    async def close(self):
        self.task.cancel()
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except Exception:
            pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@bounded(60)
async def test_e1_over_a_real_tcp_socket_quick_calls_are_answered_while_slow_calls_hold_every_slot(monkeypatch, tmp_path):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    release = asyncio.Event()

    async def rpc_zz_slow(self, params):
        await release.wait()
        return {"slow": True}

    monkeypatch.setattr(JsonRpcHandler, "rpc_zz_slow", rpc_zz_slow, raising=False)

    async def fake_start_all(self):
        return None

    monkeypatch.setattr(MCPClientManager, "start_all", fake_start_all)
    port = free_port()
    server = asyncio.create_task(server_main.start_tcp_server("127.0.0.1", port))
    client = None
    try:
        for _ in range(100):
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                break
            except OSError:
                await asyncio.sleep(0.05)
        else:
            raise AssertionError("server did not start")
        client = RawClient(reader, writer)
        token = server_main._get_or_create_daemon_token()
        client.send({"jsonrpc": "2.0", "id": "auth", "auth": token})
        assert (await client.wait_for("auth", 5))["result"] == {"authenticated": True}
        for i in range(20):
            client.send({"jsonrpc": "2.0", "id": f"slow{i}", "method": "zz.slow", "params": {}})
        await asyncio.sleep(0.3)
        started = time.perf_counter()
        client.send({"jsonrpc": "2.0", "id": "quick", "method": "config.status", "params": {}})
        reply = await client.wait_for("quick", 3)
        assert "result" in reply and time.perf_counter() - started < 2.0
        client.send({"jsonrpc": "2.0", "id": "trust", "method": "trust.status", "params": {}})
        assert "result" in await client.wait_for("trust", 3)
        client.send({"jsonrpc": "2.0", "id": "queued", "method": "config.get_ollama_host", "params": {}})
        await asyncio.sleep(0.5)
        assert "queued" not in client.replies, "a non-exempt request overtook a full semaphore"
        client.send({"jsonrpc": "2.0", "id": "bad", "method": ["config.status"], "params": {}})
        client.send({"jsonrpc": "2.0", "id": "after-bad", "method": "config.status", "params": {}})
        assert "result" in await client.wait_for("after-bad", 3), "a malformed method name broke the connection"
        release.set()
        for i in range(20):
            assert (await client.wait_for(f"slow{i}", 5))["result"] == {"slow": True}
    finally:
        release.set()
        if client:
            await client.close()
        server.cancel()
        await asyncio.gather(server, return_exceptions=True)


@bounded()
async def test_e1_unhashable_method_in_a_real_request_does_not_leave_an_unretrieved_task_exception():
    loop = asyncio.get_running_loop()
    errors = []
    loop.set_exception_handler(lambda _loop, ctx: errors.append(ctx))
    semaphore = asyncio.Semaphore(2)
    handler = JsonRpcHandler(send_notification=lambda n: None)
    sent = []

    async def run(msg):
        try:
            response = await handler.handle_request(JsonRpcRequest.from_dict(msg))
            sent.append(response)
        except Exception:
            logging.getLogger("andromity.server").exception("Error processing RPC request")

    task = asyncio.create_task(_dispatch_limited(semaphore, {"id": 1, "method": ["session.create"]}, run))
    await asyncio.gather(task, return_exceptions=True)
    del task
    gc.collect()
    await asyncio.sleep(0.05)
    gc.collect()
    assert errors == [], errors


# ---------------------------------------------------------------------------
# E2. mcp.list
# ---------------------------------------------------------------------------

@pytest.fixture
def mcp_env(tmp_path, monkeypatch):
    from andromity.core import tools
    monkeypatch.setattr(tools, "_mcp_manager", None, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))

    def project(name, servers):
        root = tmp_path / name
        (root / ".andromity").mkdir(parents=True)
        (root / ".andromity" / "mcp.json").write_text(json.dumps({"mcpServers": servers}), encoding="utf-8")
        return str(root)

    class Env:
        pass

    env = Env()
    env.project = project
    env.starts, env.stops = [], []
    env.gate = None
    env.error = None
    env.tmp = tmp_path

    async def start_all(mgr):
        env.starts.append(mgr.project_path)
        if env.gate is not None:
            await env.gate.wait()
        if env.error is not None:
            raise env.error
        for name in mgr.load_config()["mcpServers"]:
            mgr.server_status[name] = {"status": "running", "tools": 2, "error": None}

    async def stop_all(mgr):
        env.stops.append(mgr.project_path)
        mgr.server_status.clear()

    monkeypatch.setattr(MCPClientManager, "start_all", start_all)
    monkeypatch.setattr(MCPClientManager, "stop_all", stop_all)
    env.a = project("proj_a", {"alpha": {"command": "echo"}, "beta": {"url": "http://127.0.0.1:9/mcp"},
                               "gamma": {"command": "x", "disabled": True}})
    env.b = project("proj_b", {"delta": {"command": "echo"}})
    return env


def make_handler():
    notes = []
    return JsonRpcHandler(send_notification=lambda n: notes.append(n)), notes


def start_tasks():
    return [t for t in asyncio.all_tasks() if "_start_mcp_and_report" in repr(t.get_coro()) and not t.done()]


async def drain_start(handler):
    task = next(iter(list(handler._mcp_start_tasks.values())), None)
    if task is not None:
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)


@pytest.mark.parametrize("method", ["rpc_mcp_list", "rpc_mcp_list_servers"])
@bounded()
async def test_e2_list_returns_at_once_while_start_all_hangs(mcp_env, method):
    mcp_env.gate = asyncio.Event()
    handler, notes = make_handler()
    started = time.perf_counter()
    result = await asyncio.wait_for(getattr(handler, method)({"project_path": mcp_env.a}), 1.0)
    assert time.perf_counter() - started < 0.5
    assert [r["name"] for r in result] == ["alpha", "beta", "gamma"]
    assert {r["status"] for r in result if not r.get("disabled")} == {"starting"}
    await settle()
    assert mcp_env.starts == [str(Path(mcp_env.a).resolve())]
    assert notes == [], "nothing finished yet, so no status notification"
    mcp_env.gate.set()
    await drain_start(handler)


@bounded()
async def test_e2_many_concurrent_lists_start_mcp_exactly_once_then_notify_each_server(mcp_env):
    mcp_env.gate = asyncio.Event()
    handler, notes = make_handler()
    results = await asyncio.wait_for(
        asyncio.gather(*(handler.rpc_mcp_list({"project_path": mcp_env.a}) for _ in range(60))), 3.0)
    assert all({r["status"] for r in res if not r.get("disabled")} == {"starting"} for res in results)
    await settle()
    assert len(mcp_env.starts) == 1
    assert len(start_tasks()) == 1
    mcp_env.gate.set()
    await drain_start(handler)
    assert len(mcp_env.starts) == 1
    statuses = {n.params["name"]: n.params["status"]["status"] for n in notes if n.method == "mcp/statusChanged"}
    assert statuses == {"alpha": "running", "beta": "running", "gamma": "running"}
    after = await handler.rpc_mcp_list({"project_path": mcp_env.a})
    assert {r["status"] for r in after if not r.get("disabled")} == {"running"}
    assert len(mcp_env.starts) == 1, "a list after a successful start must not start again"


@bounded()
async def test_e2_notifications_are_independent_copies_of_the_status(mcp_env):
    handler, notes = make_handler()
    await handler.rpc_mcp_list({"project_path": mcp_env.a})
    await drain_start(handler)
    note = next(n for n in notes if n.method == "mcp/statusChanged")
    note.params["status"]["status"] = "tampered"
    assert handler._mcp_manager.server_status[note.params["name"]]["status"] == "running"


@pytest.mark.xfail(strict=True, reason='Product decision: a failed background MCP start is retried after 30 s, so polling mcp.list cannot restart MCP on every call.')
@bounded()
async def test_e2_start_all_raising_leaves_no_unhandled_exception_and_a_later_list_retries(mcp_env):
    loop = asyncio.get_running_loop()
    errors = []
    loop.set_exception_handler(lambda _loop, ctx: errors.append(ctx))
    mcp_env.error = RuntimeError("boom")
    handler, notes = make_handler()
    first = await handler.rpc_mcp_list({"project_path": mcp_env.a})
    assert {r["status"] for r in first if not r.get("disabled")} == {"starting"}
    await drain_start(handler)
    task = next(iter(list(handler._mcp_start_tasks.values())), None)
    assert task.done() and not task.cancelled() and task.exception() is None
    assert not handler._mcp_started and notes == []
    mcp_env.error = None
    await handler.rpc_mcp_list({"project_path": mcp_env.a})
    await drain_start(handler)
    assert len(mcp_env.starts) == 2 and handler._mcp_started
    del task
    gc.collect()
    await asyncio.sleep(0.05)
    gc.collect()
    assert errors == [], errors


@bounded()
async def test_e2_a_failed_background_start_is_not_reported_as_starting_forever(mcp_env):
    """start_all itself raised (for example the config could not be read): nothing is starting any more, so
    the list must stop saying 'starting' and say what is wrong."""
    mcp_env.error = RuntimeError("config unreadable")
    handler, _ = make_handler()
    await handler.rpc_mcp_list({"project_path": mcp_env.a})
    await drain_start(handler)
    later = await handler.rpc_mcp_list({"project_path": mcp_env.a})
    assert {r["status"] for r in later} != {"starting"}, "failed start keeps reporting 'starting' on every poll"


@bounded()
async def test_e2_failed_start_does_not_loop_a_new_start_on_every_poll(mcp_env):
    mcp_env.error = RuntimeError("config unreadable")
    handler, _ = make_handler()
    for _ in range(10):
        await handler.rpc_mcp_list({"project_path": mcp_env.a})
        await drain_start(handler)
    assert len(mcp_env.starts) <= 3, f"{len(mcp_env.starts)} start attempts for 10 polls of a failing config"


@bounded()
async def test_e2_project_switch_while_a_start_is_in_flight_ends_on_the_new_project(mcp_env):
    mcp_env.gate = asyncio.Event()
    handler, notes = make_handler()
    first = await handler.rpc_mcp_list({"project_path": mcp_env.a})
    second = await handler.rpc_mcp_list({"project_path": mcp_env.b})
    assert [r["name"] for r in first] == ["alpha", "beta", "gamma"] and [r["name"] for r in second] == ["delta"]
    assert {r["status"] for r in second} == {"starting"}
    mcp_env.gate.set()
    for _ in range(50):
        if not start_tasks():
            break
        await asyncio.sleep(0.02)
    assert not start_tasks()
    final = await handler.rpc_mcp_list({"project_path": mcp_env.b})
    assert [(r["name"], r["status"]) for r in final] == [("delta", "running")]
    assert str(Path(handler._mcp_manager.project_path).resolve()) == str(Path(mcp_env.b).resolve())


@bounded()
async def test_e2_alternating_projects_do_not_pile_up_start_tasks(mcp_env):
    """One in-flight task per resolved project path: alternating A/B while the first start is slow must not
    create a new queued task for every call."""
    mcp_env.gate = asyncio.Event()
    handler, _ = make_handler()
    for i in range(10):
        await handler.rpc_mcp_list({"project_path": mcp_env.a if i % 2 == 0 else mcp_env.b})
    await settle()
    pending = len(start_tasks())
    mcp_env.gate.set()
    for _ in range(100):
        if not start_tasks():
            break
        await asyncio.sleep(0.02)
    assert pending <= 2, f"{pending} start tasks queued for 2 projects"
    assert len(mcp_env.starts) <= 4, f"{len(mcp_env.starts)} start_all calls for 2 projects"


@bounded()
async def test_e2_project_path_spellings_share_one_in_flight_start(mcp_env, monkeypatch):
    mcp_env.gate = asyncio.Event()
    handler, _ = make_handler()
    base = Path(mcp_env.a)
    spellings = [str(base), str(base) + "/", str(base / "sub" / ".."), str(base).replace("\\", "/"),
                 str(base / ".")]
    tasks = {id(handler.start_mcp_soon(s)) for s in spellings}
    assert len(tasks) == 1
    await settle()
    assert len(mcp_env.starts) == 1
    mcp_env.gate.set()
    await drain_start(handler)


@bounded()
async def test_e2_no_project_path_and_cwd_share_one_start(mcp_env, monkeypatch):
    monkeypatch.chdir(mcp_env.a)
    mcp_env.gate = asyncio.Event()
    handler, _ = make_handler()
    first = handler.start_mcp_soon()
    second = handler.start_mcp_soon(mcp_env.a)
    third = handler.start_mcp_soon(".")
    assert first is second is third
    mcp_env.gate.set()
    await drain_start(handler)


@pytest.mark.parametrize("params", [None, {}, {"project_path": None}, {"project_path": ""}, {"project_path": 5},
                                    {"project_path": ["x"]}, {"project_path": "bad\x00path"}, {"project_path": {"a": 1}}])
@bounded()
async def test_e2_odd_params_return_a_list_and_leave_no_dangling_failure(mcp_env, params):
    loop = asyncio.get_running_loop()
    errors = []
    loop.set_exception_handler(lambda _loop, ctx: errors.append(ctx))
    handler, _ = make_handler()
    result = await asyncio.wait_for(handler.rpc_mcp_list(params), 3.0)
    assert isinstance(result, list)
    await settle(20)
    for task in start_tasks():
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
    gc.collect()
    await asyncio.sleep(0.02)
    assert errors == [], errors


@bounded()
async def test_e2_a_throwing_notification_sink_does_not_end_the_background_task_with_an_exception(mcp_env):
    """Nobody awaits the background start task, so an exception escaping it is only ever reported by asyncio as
    'Task exception was never retrieved'."""
    def broken_sink(notification):
        raise BrokenPipeError("client went away")

    handler = JsonRpcHandler(send_notification=broken_sink)
    await handler.rpc_mcp_list({"project_path": mcp_env.a})
    task = next(iter(list(handler._mcp_start_tasks.values())), None)
    await asyncio.wait({task}, timeout=5)
    assert task.done()
    assert task.cancelled() or task.exception() is None, repr(task.exception())


@bounded()
async def test_e2_disabled_server_is_not_reported_as_starting(mcp_env):
    mcp_env.gate = asyncio.Event()
    handler, _ = make_handler()
    result = await handler.rpc_mcp_list({"project_path": mcp_env.a})
    gamma = next(r for r in result if r["name"] == "gamma")
    assert gamma["disabled"] is True
    assert gamma["status"] != "starting", "a disabled server will never start, so it must not show a spinner"
    mcp_env.gate.set()
    await drain_start(handler)


@bounded()
async def test_e2_hung_start_does_not_delay_unrelated_calls_on_the_same_handler(mcp_env):
    mcp_env.gate = asyncio.Event()
    handler, _ = make_handler()
    await handler.rpc_mcp_list({"project_path": mcp_env.a})
    started = time.perf_counter()
    for _ in range(20):
        await asyncio.wait_for(handler.rpc_mcp_list({"project_path": mcp_env.a}), 0.5)
        await asyncio.wait_for(handler.rpc_config_status({}), 0.5)
    assert time.perf_counter() - started < 2.0
    mcp_env.gate.set()
    await drain_start(handler)


@bounded()
async def test_e2_cancelled_handler_task_while_start_in_flight_does_not_raise_into_callers(mcp_env):
    mcp_env.gate = asyncio.Event()
    handler, _ = make_handler()
    await handler.rpc_mcp_list({"project_path": mcp_env.a})
    task = next(iter(list(handler._mcp_start_tasks.values())), None)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    again = await handler.rpc_mcp_list({"project_path": mcp_env.a})
    assert {r["status"] for r in again if not r.get("disabled")} == {"starting"}
    mcp_env.gate.set()
    await drain_start(handler)
    assert handler._mcp_started


# ---------------------------------------------------------------------------
# E3. RpcRefusal
# ---------------------------------------------------------------------------

def test_e3_rpc_refusal_is_still_a_value_error():
    assert issubclass(RpcRefusal, ValueError)
    try:
        raise RpcRefusal("nope")
    except ValueError as exc:
        assert str(exc) == "nope" and isinstance(exc, RpcRefusal)


@bounded()
async def test_e3_untrusted_git_review_returns_internal_error_with_the_message_and_logs_no_traceback(caplog, tmp_path):
    handler = JsonRpcHandler(send_notification=lambda n: None)
    request = JsonRpcRequest(id=7, method="git.status", params={"project_path": str(tmp_path)})
    with caplog.at_level(logging.DEBUG):
        response = await handler.handle_request(request)
    assert response.error["code"] == INTERNAL_ERROR
    assert response.error["message"] == "Trust this workspace before reviewing or reverting files."
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR], [r.getMessage() for r in caplog.records]
    assert not [r for r in caplog.records if r.exc_info], "a refusal must not log a traceback"
    assert any("declined" in r.getMessage() for r in caplog.records if r.levelno == logging.DEBUG)


@bounded()
async def test_e3_refusal_and_value_error_produce_identical_responses(monkeypatch):
    async def rpc_zz_refuse(self, params):
        raise RpcRefusal("Trust this workspace before reviewing or reverting files.")

    async def rpc_zz_value(self, params):
        raise ValueError("Trust this workspace before reviewing or reverting files.")

    monkeypatch.setattr(JsonRpcHandler, "rpc_zz_refuse", rpc_zz_refuse, raising=False)
    monkeypatch.setattr(JsonRpcHandler, "rpc_zz_value", rpc_zz_value, raising=False)
    handler = JsonRpcHandler(send_notification=lambda n: None)
    refused = await handler.handle_request(JsonRpcRequest(id=1, method="zz.refuse", params={}))
    plain = await handler.handle_request(JsonRpcRequest(id=1, method="zz.value", params={}))
    assert refused.to_dict() == plain.to_dict()


@bounded()
async def test_e3_a_plain_value_error_is_still_logged_as_an_error_with_traceback(monkeypatch, caplog):
    async def rpc_zz_value(self, params):
        raise ValueError("real bug")

    monkeypatch.setattr(JsonRpcHandler, "rpc_zz_value", rpc_zz_value, raising=False)
    handler = JsonRpcHandler(send_notification=lambda n: None)
    with caplog.at_level(logging.DEBUG):
        response = await handler.handle_request(JsonRpcRequest(id=1, method="zz.value", params={}))
    assert response.error["code"] == INTERNAL_ERROR
    assert [r for r in caplog.records if r.levelno == logging.ERROR and r.exc_info]


@bounded()
async def test_e3_refusal_as_a_notification_returns_nothing_and_stays_quiet(monkeypatch, caplog):
    async def rpc_zz_refuse(self, params):
        raise RpcRefusal("declined")

    monkeypatch.setattr(JsonRpcHandler, "rpc_zz_refuse", rpc_zz_refuse, raising=False)
    handler = JsonRpcHandler(send_notification=lambda n: None)
    with caplog.at_level(logging.DEBUG):
        assert await handler.handle_request(JsonRpcRequest(id=None, method="zz.refuse", params={})) is None
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


@bounded()
async def test_e3_other_review_refusals_are_refusals_too(tmp_path, caplog):
    handler = JsonRpcHandler(send_notification=lambda n: None)
    app_config.set_trusted(str(tmp_path))
    from git import Repo
    repo = Repo.init(tmp_path)
    handler._git_mutating_roots.add(str(Path(repo.working_tree_dir).resolve()))
    with pytest.raises(RpcRefusal) as info:
        handler._review_repo({"project_path": str(tmp_path)}, mutate=True)
    assert "restoration is in progress" in str(info.value)
    assert isinstance(info.value, ValueError)


@bounded()
async def test_e3_refusal_text_is_not_a_path_leak_channel(monkeypatch):
    """handle_request scrubs messages that contain user paths for ordinary errors. The refusal branch returns
    str(e) verbatim, so every refusal message must stay free of local paths."""
    handler = JsonRpcHandler(send_notification=lambda n: None)
    texts = []
    for params, mutate in (({"project_path": "C:\\Users\\someone\\proj"}, False),):
        with pytest.raises(RpcRefusal) as info:
            handler._review_repo(params, mutate=mutate)
        texts.append(str(info.value))
    for text in texts:
        assert "Users" not in text and "\\" not in text and "/home/" not in text


# ---------------------------------------------------------------------------
# E4. config.get allowed_commands / allowed_domains
# ---------------------------------------------------------------------------

@pytest.fixture
def config_get(monkeypatch):
    import andromity.core.reasoning as reasoning_mod
    from andromity.core.effort import ReasoningCapability, ReasoningMode
    monkeypatch.setattr(reasoning_mod, "discover_model_reasoning_capability",
                        lambda provider, model: ReasoningCapability(ReasoningMode.NONE))
    handler = JsonRpcHandler(send_notification=lambda n: None)

    async def call(params=None):
        return await asyncio.wait_for(handler.rpc_config_get(params), 10)

    return call


def set_default(**values):
    app_config._config_cache.setdefault("default", {})
    if not isinstance(app_config._config_cache["default"], dict):
        app_config._config_cache["default"] = {}
    app_config._config_cache["default"].update(values)


@bounded()
async def test_e4_strings_only_from_the_default_section(config_get):
    set_default(allowed_commands=["git status", "ls", 5, None, "", ["x"], {"a": 1}, True, 1.5, b"bytes", "npm test"],
                allowed_domains=["example.com", None, 3, "", "docs.python.org"])
    result = await config_get()
    assert result["allowed_commands"] == ["git status", "ls", "npm test"]
    assert result["allowed_domains"] == ["example.com", "docs.python.org"]


@pytest.mark.parametrize("value", ["ls", "ls,git", {"a": "b"}, 5, 1.5, None, True, (("a", "b")), {"x"}])
@bounded()
async def test_e4_non_list_values_become_empty_lists(config_get, value):
    set_default(allowed_commands=value, allowed_domains=value)
    result = await config_get()
    assert result["allowed_commands"] == [] and result["allowed_domains"] == []


@bounded()
async def test_e4_missing_and_malformed_sections_are_empty(config_get):
    app_config._config_cache.pop("default", None)
    result = await config_get()
    assert result["allowed_commands"] == [] and result["allowed_domains"] == []
    app_config._config_cache["default"] = "not a table"
    result = await config_get()
    assert result["allowed_commands"] == [] and result["allowed_domains"] == []


@bounded()
async def test_e4_huge_lists_are_returned_quickly_and_serialize(config_get):
    big = [f"cmd-{i}" for i in range(200_000)] + [None] * 1000
    set_default(allowed_commands=big, allowed_domains=big)
    started = time.perf_counter()
    result = await config_get()
    elapsed = time.perf_counter() - started
    assert len(result["allowed_commands"]) == 200_000
    assert elapsed < 3.0
    json.dumps({"a": result["allowed_commands"]})


@bounded()
async def test_e4_result_lists_are_copies(config_get):
    set_default(allowed_commands=["a"], allowed_domains=["d"])
    result = await config_get()
    result["allowed_commands"].append("tampered")
    result["allowed_domains"].clear()
    assert app_config.get("default", "allowed_commands") == ["a"]
    assert app_config.get("default", "allowed_domains") == ["d"]


@bounded()
async def test_e4_no_provider_secret_appears_anywhere_in_the_result(config_get, monkeypatch):
    secret = "sk-ant-api03-SUPERSECRETVALUE"
    app_config._config_cache["providers"] = [
        {"name": "anthropic", "api_key": secret},
        {"name": "custom", "type": "openai", "base_url": "https://user:hunter2@llm.example/v1", "api_key": "$MY_ENV_KEY"},
        {"name": "x", "api_key": "plain-key-12345", "headers": {"Authorization": "Bearer tok-999"}},
    ]
    set_default(allowed_commands=["git status"], allowed_domains=["example.com"], api_key="top-level-secret-1")
    monkeypatch.setenv("MY_ENV_KEY", "env-secret-777")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-anthropic-888")
    result = await config_get({"project_path": str(Path.cwd())})
    blob = json.dumps(result, default=str)
    for needle in (secret, "hunter2", "plain-key-12345", "tok-999", "env-secret-777", "env-anthropic-888",
                   "top-level-secret-1", "$MY_ENV_KEY"):
        assert needle not in blob, needle


@bounded()
async def test_e4_existing_fields_are_unchanged(config_get):
    result = await config_get()
    for key in ("config", "capabilities", "default_provider", "default_model", "default_profile", "available_profiles",
                "available_reasoning_efforts", "model_reasoning_capability", "permission_mode", "reasoning_effort",
                "user_name", "user_email", "max_subagents", "auto_compact", "max_file_size_kb", "sound_done",
                "sound_attention", "next_step_suggestions", "telemetry", "airgap", "include_co_author",
                "include_assisted_by", "is_trusted", "pinned_models"):
        assert key in result, key
    assert result["config"] == {}
