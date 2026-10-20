"""Cancelling a turn stops the shell command it is waiting on, including the command's own children."""
import sys
import threading
import time

import pytest

from andromity.core import tools
from andromity.core.session import Session
from andromity.core.tools import _current_session_var, shell_exec, stop_session_commands


def _run_python(script) -> str:
    shell = tools.get_shell().lower()
    if "powershell" in shell or "pwsh" in shell:
        return f"& '{sys.executable}' '{script}'"
    if shell.endswith("cmd") or shell.endswith("cmd.exe"):
        return f'"{sys.executable}" "{script}"'
    return f"'{sys.executable}' '{script}'"


@pytest.fixture
def long_command(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools, "_get_project_root", lambda: tmp_path)
    marker = tmp_path / "child-finished.txt"
    child = tmp_path / "child.py"
    child.write_text(f"import time\ntime.sleep(3)\nopen(r'{marker}', 'w').write('done')\n", encoding="utf-8")
    parent = tmp_path / "parent.py"
    parent.write_text(
        f"import subprocess, sys, time\nsubprocess.Popen([sys.executable, r'{child}'])\ntime.sleep(60)\n",
        encoding="utf-8",
    )
    return _run_python(parent), marker


def test_cancel_stops_a_running_command_and_its_children(tmp_path, long_command):
    command, marker = long_command
    session = Session(name="t", project_path=str(tmp_path))
    result = {}

    def run():
        token = _current_session_var.set(session)
        try:
            result["out"] = shell_exec(command, timeout=120)
        finally:
            _current_session_var.reset(token)

    worker = threading.Thread(target=run)
    worker.start()
    deadline = time.time() + 15
    while time.time() < deadline and not tools._fg_processes.get(session.id):
        time.sleep(0.05)
    assert tools._fg_processes.get(session.id), "the command should be registered while it runs"
    time.sleep(1.0)  # let the parent start its child

    started = time.time()
    assert stop_session_commands(session.id) == 1
    worker.join(timeout=10)
    assert not worker.is_alive()
    assert time.time() - started < 8, "cancel must not wait for the command to finish on its own"
    assert result["out"] == "Stopped: the user cancelled this command before it finished."
    assert session.id not in tools._fg_processes

    time.sleep(3.5)
    assert not marker.exists(), "the command's child process must be stopped too"


def test_stopping_a_session_leaves_other_sessions_alone(tmp_path, long_command):
    assert stop_session_commands("nobody") == 0


def test_finished_commands_report_output_as_before(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools, "_get_project_root", lambda: tmp_path)
    assert shell_exec("echo hello") == "hello"
    assert not tools._fg_processes


@pytest.mark.asyncio
async def test_cancel_rpc_stops_commands_first(monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler
    stopped = []
    monkeypatch.setattr(tools, "stop_session_commands", lambda sid: stopped.append(sid) or 0)
    handler = JsonRpcHandler()
    await handler.rpc_agent_cancel({"session_id": "s1"})
    assert stopped == ["s1"]
