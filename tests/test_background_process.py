import asyncio
import os
import sys
import time
from pathlib import Path
import pytest

from andromity.core import tools as tools_mod
from andromity.server.rpc_handler import JsonRpcHandler
from andromity.server.protocol import JsonRpcRequest


@pytest.fixture(autouse=True)
def cleanup_bg_processes():
    """Ensure any background processes created during test are cleaned up."""
    yield
    with tools_mod._bg_lock:
        keys = list(tools_mod._bg_processes.keys())
    for k in keys:
        pid = k[1] if isinstance(k, tuple) else k
        try:
            tools_mod.shell_kill(pid)
        except Exception:
            pass


def test_shell_bg_starts_and_fires_callbacks(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: tmp_path.resolve())

    started_events = []
    exited_events = []

    def on_started(info):
        started_events.append(info)

    def on_exited(info):
        exited_events.append(info)

    tools_mod.register_process_started_callback(on_started)
    tools_mod.register_process_exited_callback(on_exited)

    try:
        # Launch a background process
        res = tools_mod.shell_bg("echo bg_test_output", process_id="test_bg_1")
        assert "Background process started with id 'test_bg_1'" in res

        # Verify start callback fired
        assert len(started_events) == 1
        assert started_events[0]["process_id"] == "test_bg_1"
        assert started_events[0]["command"] == "echo bg_test_output"
        assert "pid" in started_events[0]

        # Wait briefly for process to exit
        for _ in range(50):
            if len(exited_events) > 0:
                break
            time.sleep(0.1)

        assert len(exited_events) == 1
        assert exited_events[0]["process_id"] == "test_bg_1"
        assert exited_events[0]["exit_code"] == 0
        assert exited_events[0]["duration"] >= 0.0
    finally:
        tools_mod.unregister_process_started_callback(on_started)
        tools_mod.unregister_process_exited_callback(on_exited)


def test_shell_kill_terminates_and_fires_exit(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: tmp_path.resolve())

    exited_events = []

    def on_exited(info):
        exited_events.append(info)

    tools_mod.register_process_exited_callback(on_exited)

    try:
        # Start a sleeping command
        sleep_cmd = "ping 127.0.0.1 -n 10" if sys.platform == "win32" else "sleep 10"
        tools_mod.shell_bg(sleep_cmd, process_id="test_sleep_kill")

        # Kill the process
        kill_res = tools_mod.shell_kill("test_sleep_kill")
        assert "terminated" in kill_res.lower()

        # Wait briefly for exit notification
        for _ in range(20):
            if len(exited_events) > 0:
                break
            time.sleep(0.1)

        assert len(exited_events) >= 1
        assert exited_events[0]["process_id"] == "test_sleep_kill"
    finally:
        tools_mod.unregister_process_exited_callback(on_exited)


@pytest.mark.asyncio
async def test_rpc_process_list_and_kill(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: tmp_path.resolve())

    notifications = []
    handler = JsonRpcHandler(send_notification=lambda n: notifications.append(n))
    handler.PROCESS_NOTICE_DELAY = 0

    sleep_cmd = "ping 127.0.0.1 -n 10" if sys.platform == "win32" else "sleep 10"
    tools_mod.shell_bg(sleep_cmd, process_id="rpc_test_proc")

    # Call rpc_process_list
    list_res = await handler.handle_request(JsonRpcRequest(
        id=1,
        method="process/list",
        params={"project_path": str(tmp_path.resolve())},
    ))
    assert list_res is not None
    assert list_res.error is None
    procs = list_res.result["processes"]
    assert any(p["process_id"] == "rpc_test_proc" for p in procs)

    # Call rpc_process_kill
    kill_res = await handler.handle_request(JsonRpcRequest(
        id=2,
        method="process/kill",
        params={"process_id": "rpc_test_proc"},
    ))
    assert kill_res is not None
    assert kill_res.error is None
    assert kill_res.result["status"] == "ok"


@pytest.mark.asyncio
async def test_rpc_process_exit_auto_wake(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: tmp_path.resolve())

    notifications = []
    handler = JsonRpcHandler(send_notification=lambda n: notifications.append(n))
    handler.PROCESS_NOTICE_DELAY = 0

    # Mock _handle_auto_awake
    auto_wake_calls = []
    async def mock_auto_awake(**kwargs):
        auto_wake_calls.append(kwargs)

    monkeypatch.setattr(handler, "_handle_auto_awake", mock_auto_awake)

    # Simulate exit notification
    handler._handle_process_exit_threadsafe({
        "process_id": "proc_auto_wake",
        "pid": 9999,
        "command": "npm run build",
        "exit_code": 0,
        "duration": 5.2,
        "session_id": "sess-xyz",
        "project_path": str(tmp_path),
    })

    # Wait for task to schedule
    await asyncio.sleep(0.05)

    assert len(auto_wake_calls) == 1
    call = auto_wake_calls[0]
    assert call["target_session_id"] == "sess-xyz"
    assert call["trigger_type"] == "process_exit"
    assert "npm run build" in call["prompt_content"]
    assert "exit code 0" in call["prompt_content"]

    # Verify notification was sent
    exit_notifs = [n for n in notifications if n.method == "process/exited"]
    assert len(exit_notifs) == 1
    assert exit_notifs[0].params["process_id"] == "proc_auto_wake"


@pytest.mark.asyncio
async def test_shell_kill_cross_project_and_async_notification(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "_is_trusted", lambda: True)
    proj_a = tmp_path / "projA"
    proj_a.mkdir(parents=True, exist_ok=True)
    proj_b = tmp_path / "projB"
    proj_b.mkdir(parents=True, exist_ok=True)

    # Background process started with project_path A
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: proj_a)

    received_notifications = []

    async def async_send_notif(notif):
        await asyncio.sleep(0.01)
        received_notifications.append(notif)

    handler = JsonRpcHandler(send_notification=async_send_notif)

    handler.PROCESS_NOTICE_DELAY = 0

    sleep_cmd = "ping 127.0.0.1 -n 15" if sys.platform == "win32" else "sleep 15"
    start_res = tools_mod.shell_bg(sleep_cmd, process_id="bg_cross_test")
    assert "Background process started" in start_res

    # Now change inferred project root to B (simulating RPC caller having different or no context)
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: proj_b)

    # Killing by process_id must succeed even when proj_key doesn't match
    kill_res = await handler.handle_request(JsonRpcRequest(
        id=99,
        method="process/kill",
        params={"process_id": "bg_cross_test"},
    ))
    assert kill_res is not None
    assert kill_res.error is None
    assert "terminated" in kill_res.result["message"].lower()

    # Wait for async notifications to flush
    for _ in range(30):
        if any(n.method == "process/exited" for n in received_notifications):
            break
        await asyncio.sleep(0.1)

    exited = [n for n in received_notifications if n.method == "process/exited"]
    assert len(exited) >= 1
    assert exited[0].params["process_id"] == "bg_cross_test"


@pytest.mark.asyncio
async def test_user_stopped_process_notifies_ai(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: tmp_path.resolve())

    handler = JsonRpcHandler(send_notification=lambda n: None)

    handler.PROCESS_NOTICE_DELAY = 0

    auto_wake_calls = []
    async def mock_auto_awake(**kwargs):
        auto_wake_calls.append(kwargs)

    monkeypatch.setattr(handler, "_handle_auto_awake", mock_auto_awake)

    sleep_cmd = "ping 127.0.0.1 -n 20" if sys.platform == "win32" else "sleep 20"
    start_res = tools_mod.shell_bg(sleep_cmd, process_id="user_kill_test")
    assert "Background process started" in start_res

    # Associate session_id
    full_key = (tools_mod._bg_project_key(), "user_kill_test")
    with tools_mod._bg_lock:
        if full_key in tools_mod._bg_processes:
            tools_mod._bg_processes[full_key]["session_id"] = "sess-user-kill"

    # User clicks stop -> triggers process/kill
    kill_res = await handler.handle_request(JsonRpcRequest(
        id=101,
        method="process/kill",
        params={"process_id": "user_kill_test"},
    ))
    assert kill_res is not None
    assert kill_res.result["status"] == "ok"

    # Allow async auto-wake dispatch
    await asyncio.sleep(0.1)

    assert len(auto_wake_calls) == 1
    call = auto_wake_calls[0]
    assert call["target_session_id"] == "sess-user-kill"
    assert "[User Action]: Background process 'user_kill_test'" in call["prompt_content"]
    assert "was manually stopped by the user" in call["prompt_content"]



def test_shell_bg_reports_a_command_that_fails_at_once(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: tmp_path.resolve())
    exited_events = []
    tools_mod.register_process_exited_callback(exited_events.append)
    try:
        # Valid in bash, sh and PowerShell alike.
        res = tools_mod.shell_bg("echo boom; exit 3", process_id="fails_fast")
        assert "Background process started with id 'fails_fast'" in res
        assert "with code 3" in res
        assert "nothing is running" in res
        assert "boom" in res
        assert len(exited_events) == 1
        assert exited_events[0]["exit_code"] == 3
        assert exited_events[0]["reported_to_agent"] is True
    finally:
        tools_mod.unregister_process_exited_callback(exited_events.append)


def test_shell_bg_still_running_after_startup_watch(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools_mod, "_get_project_root", lambda: tmp_path.resolve())
    monkeypatch.setattr(tools_mod, "_BG_STARTUP_WATCH_SECONDS", 0.3)
    sleep_cmd = "Start-Sleep -Seconds 30" if sys.platform == "win32" else "sleep 30"
    res = tools_mod.shell_bg(sleep_cmd, process_id="keeps_running")
    assert "Background process started with id 'keeps_running'" in res
    assert "exited" not in res
    with tools_mod._bg_lock:
        entry = next(v for k, v in tools_mod._bg_processes.items() if k[1] == "keeps_running")
    assert entry["startup_watch"] is False


async def test_rpc_skips_auto_wake_for_exit_already_in_tool_result(tmp_path, monkeypatch):
    notifications = []
    handler = JsonRpcHandler(send_notification=lambda n: notifications.append(n))
    handler.PROCESS_NOTICE_DELAY = 0
    auto_wake_calls = []

    async def mock_auto_awake(**kwargs):
        auto_wake_calls.append(kwargs)

    monkeypatch.setattr(handler, "_handle_auto_awake", mock_auto_awake)
    handler._handle_process_exit_threadsafe({
        "process_id": "fails_fast",
        "pid": 1,
        "command": "bad syntax",
        "exit_code": 1,
        "duration": 1.4,
        "session_id": "sess-reported",
        "project_path": str(tmp_path),
        "reported_to_agent": True,
    })
    await asyncio.sleep(0.05)
    assert auto_wake_calls == []
    assert [n.params["process_id"] for n in notifications if n.method == "process/exited"] == ["fails_fast"]


async def test_process_exits_at_once_reach_the_agent_as_one_message(monkeypatch):
    handler = JsonRpcHandler(send_notification=lambda n: None)
    handler.PROCESS_NOTICE_DELAY = 0.05
    wakes = []

    async def fake_wake(**kwargs):
        wakes.append(kwargs)

    monkeypatch.setattr(handler, "_handle_auto_awake", fake_wake)
    handler._user_killed_processes.update({("sess-many", "a"), ("sess-many", "b")})
    for pid in ("a", "b", "c"):
        handler._handle_process_exit_threadsafe({"process_id": pid, "command": f"loop {pid}", "exit_code": 1, "session_id": "sess-many"})
    await asyncio.sleep(0.2)
    assert len(wakes) == 1
    content = wakes[0]["prompt_content"]
    assert "Background process 'a'" in content and "Background process 'b'" in content and "Process 'c'" in content
    assert content.count("was manually stopped by the user") == 2


async def test_process_exit_during_a_running_turn_is_steered_into_it(monkeypatch):
    handler = JsonRpcHandler(send_notification=lambda n: None)
    handler.PROCESS_NOTICE_DELAY = 0

    class Session:
        id = "sess-busy"
        project_path = "."
        permission_mode = "full"
        profile = "builder"
        provider = ""
        model = ""

    running = asyncio.get_running_loop().create_future()
    handler._running_tasks["sess-busy"] = running
    monkeypatch.setattr(handler, "_get_or_load_session", lambda sid, path=None: Session())
    submitted, wakes = [], []

    async def fake_submit(params):
        submitted.append(params)
        return {}

    async def fake_wake(**kwargs):
        wakes.append(kwargs)

    monkeypatch.setattr(handler, "rpc_agent_submit", fake_submit)
    monkeypatch.setattr(handler, "_handle_auto_awake", fake_wake)
    handler._user_killed_processes.add(("sess-busy", "dev"))
    handler._handle_process_exit_threadsafe({"process_id": "dev", "command": "npm run dev", "exit_code": 1, "session_id": "sess-busy"})
    await asyncio.sleep(0.05)
    running.cancel()
    assert wakes == []
    assert len(submitted) == 1
    assert submitted[0]["delivery"] == "steer"
    assert "was manually stopped by the user" in submitted[0]["prompt"]
    # A turn nobody typed never runs above TRUST.
    assert submitted[0]["mode"] == "trust"
