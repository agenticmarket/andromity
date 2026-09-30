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
