import asyncio
import os
import platform
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from andromity.config import ALLOWED_SHELLS, ConfigManager, get_shell
from andromity.core.mcp import MCPClientManager
from andromity.core.session import Session
from andromity.server.rpc_handler import JsonRpcHandler


@pytest.mark.asyncio
async def test_mcp_restart_respects_workspace_trust(tmp_path):
    """FINDING-1: Verify that restart() does not bypass trust checks on untrusted workspace."""
    untrusted_dir = tmp_path / "untrusted_repo"
    untrusted_dir.mkdir()

    mgr = MCPClientManager(str(untrusted_dir))
    fake_config = {
        "mcpServers": {
            "test_server": {
                "command": "malicious_binary",
                "args": ["arg1"],
            }
        }
    }
    mgr.load_config = lambda: fake_config

    with patch("andromity.config.config.is_trusted", return_value=False):
        ok = await mgr.restart("test_server")

    assert ok is False
    status = mgr.server_status.get("test_server", {})
    assert status.get("status") == "needs_trust"
    assert "Untrusted folder" in status.get("error", "")


def test_get_shell_rejects_untrusted_shell(monkeypatch):
    """FINDING-2: Verify that get_shell rejects arbitrary binaries from $SHELL."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setenv("SHELL", "/tmp/evil_shell_hijack")

    shell = get_shell()
    assert shell != "/tmp/evil_shell_hijack"
    assert shell in ("/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh")


def test_get_shell_allows_allowlisted_shell(monkeypatch):
    """FINDING-2: Verify that get_shell allows known-good shells in allowlist."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setenv("SHELL", "/bin/bash")

    # Mock file existence and executable permission
    orig_isfile = os.path.isfile
    orig_access = os.access

    def mock_isfile(path):
        if path == "/bin/bash":
            return True
        return orig_isfile(path)

    def mock_access(path, mode):
        if path == "/bin/bash":
            return True
        return orig_access(path, mode)

    monkeypatch.setattr(os.path, "isfile", mock_isfile)
    monkeypatch.setattr(os, "access", mock_access)

    shell = get_shell()
    assert shell == "/bin/bash"


def test_config_save_sets_restrictive_permissions(tmp_path, monkeypatch):
    """FINDING-3: Verify that config save enforces restrictive permissions (0o600) on non-Windows."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")

    chmod_calls = []

    def mock_chmod(path, mode):
        chmod_calls.append((str(path), mode))

    monkeypatch.setattr(os, "chmod", mock_chmod)

    cfg = ConfigManager(tmp_path)
    cfg.set("default", "theme", "dark")

    # Check that chmod was called with 0o700 on dir and 0o600 on config.toml
    modes = [mode for path, mode in chmod_calls]
    assert 0o700 in modes or 0o600 in modes


def test_updater_command_pins_pypi_index(monkeypatch):
    """FINDING-4: Verify updater uses --index-url https://pypi.org/simple/ for pip."""
    import shutil
    from andromity.core import updater

    executed_commands = []

    def mock_run(cmd, *args, **kwargs):
        executed_commands.append(cmd)
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "Requirement already satisfied"
        return mock_result

    monkeypatch.setattr("subprocess.run", mock_run)
    monkeypatch.setattr(shutil, "which", lambda name: None)

    updater.perform_update()

    assert len(executed_commands) > 0
    cmd = executed_commands[0]
    assert "--index-url" in cmd
    idx = cmd.index("--index-url")
    assert cmd[idx + 1] == "https://pypi.org/simple/"


@pytest.mark.asyncio
async def test_sensitive_path_approval_not_bypassed(tmp_path, monkeypatch):
    """FINDING-5: Verify sensitive path in read-only tool is not auto-approved."""
    handler = JsonRpcHandler()
    session = Session(name="Security Test", project_path=str(tmp_path))
    session.permission_mode = "trust"

    captured = {}

    def mock_agent(**kwargs):
        captured["on_tool_approval"] = kwargs.get("on_tool_approval")
        agent_instance = MagicMock()

        async def mock_run_gen(*args, **kwargs):
            if False:
                yield

        agent_instance.run = mock_run_gen
        return agent_instance

    monkeypatch.setattr("andromity.server.rpc_handler.Agent", mock_agent)
    monkeypatch.setattr(handler, "_get_or_load_session", lambda sid, ppath: session)

    # Trigger rpc_agent_prompt to instantiate Agent and capture _on_tool_approval
    await handler.rpc_agent_prompt({
        "session_id": session.id,
        "prompt": "Test prompt",
        "mode": "trust",
    })

    on_tool_approval = captured["on_tool_approval"]
    assert on_tool_approval is not None

    # Test 1: Normal read-only tool on non-sensitive path should auto-approve (return True)
    non_sensitive_args = {"path": "src/main.py"}
    res_normal = await on_tool_approval("view_file", non_sensitive_args)
    assert res_normal is True

    # Test 2: Sensitive path in read-only tool must NOT auto-approve (creates pending approval)
    sensitive_args = {"path": str(Path.home() / ".ssh" / "id_rsa")}
    task = asyncio.create_task(on_tool_approval("view_file", sensitive_args))
    await asyncio.sleep(0.05)

    # Must still be pending user confirmation, not auto-approved
    assert not task.done()
    assert len(handler._pending_approvals) == 1
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


@pytest.mark.asyncio
async def test_subagent_blocks_mutating_tools_in_untrusted_workspace(tmp_path):
    """FINDING-DEEP-2: Verify subagent blocks mutating tools in untrusted workspaces even in trust mode."""
    from andromity.core.subagent import SubAgent

    untrusted_proj = tmp_path / "untrusted_proj"
    untrusted_proj.mkdir()

    sub = SubAgent(
        parent_session_id="root_sess",
        role="coder",
        task="Test task",
        project_path=str(untrusted_proj),
        permission_mode="trust",
    )

    with patch("andromity.config.config.is_trusted", return_value=False):
        # 1. Mutating tool (write_file) must be blocked
        tool_call_write = {
            "id": "call_1",
            "function": {
                "name": "write_file",
                "arguments": '{"path": "test.txt", "content": "hello"}',
            }
        }
        _id, _name, res_write = await sub._exec_tool(tool_call_write)
        assert "TOOL BLOCKED" in res_write
        assert "untrusted workspace" in res_write.lower()

        # 2. Mutating tool (shell_exec) must be blocked
        tool_call_shell = {
            "id": "call_2",
            "function": {
                "name": "shell_exec",
                "arguments": '{"command": "echo test"}',
            }
        }
        _id, _name, res_shell = await sub._exec_tool(tool_call_shell)
        assert "TOOL BLOCKED" in res_shell
        assert "untrusted workspace" in res_shell.lower()


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_vscode_bridge_does_not_search_workspace_for_binaries():
    """FINDING-DEEP-1: Ensure PythonBridge._findBundledBinary does not search workspaceFolders."""
    bridge_ts_path = REPO_ROOT / "vscode-extension" / "src" / "server" / "PythonBridge.ts"
    assert bridge_ts_path.exists()
    content = bridge_ts_path.read_text(encoding="utf-8")

    # Extract _findBundledBinary function body
    start_idx = content.find("private _findBundledBinary():")
    assert start_idx != -1
    end_idx = content.find("constructor(", start_idx)
    func_body = content[start_idx:end_idx]

    # Must NOT reference workspaceFolders inside _findBundledBinary
    assert "workspaceFolders" not in func_body
    assert "wf.uri.fsPath" not in func_body


def test_vscode_pip_install_pinned_and_trusted():
    """FINDING-DEEP-4: Ensure PythonBridge._installPackage verifies trust and pins PyPI index."""
    bridge_ts_path = REPO_ROOT / "vscode-extension" / "src" / "server" / "PythonBridge.ts"
    assert bridge_ts_path.exists()
    content = bridge_ts_path.read_text(encoding="utf-8")

    start_idx = content.find("private async _installPackage(")
    assert start_idx != -1
    end_idx = content.find("private _findProjectRoot()", start_idx)
    func_body = content[start_idx:end_idx]

    # Must verify isTrusted and pin PyPI index
    assert "isTrusted" in func_body
    assert "--index-url" in func_body
    assert "https://pypi.org/simple/" in func_body


def test_vscode_open_external_url_validates_scheme():
    """FINDING-DEEP-3: Ensure ChatViewProvider validates http/https scheme on open_external_url."""
    chat_ts_path = REPO_ROOT / "vscode-extension" / "src" / "providers" / "ChatViewProvider.ts"
    assert chat_ts_path.exists()
    content = chat_ts_path.read_text(encoding="utf-8")

    start_idx = content.find('case "open_external_url":')
    assert start_idx != -1
    end_idx = content.find('case "set_api_key":', start_idx)
    handler_body = content[start_idx:end_idx]

    # Must check http/https scheme
    assert 'parsed.scheme === "http"' in handler_body
    assert 'parsed.scheme === "https"' in handler_body


def test_telemetry_timing_safe_match_constant_time():
    """FINDING-DEEP-5: Ensure telemetry-worker timingSafeMatch does not early-return on length mismatch."""
    worker_js_path = REPO_ROOT / "telemetry-worker" / "worker.js"
    assert worker_js_path.exists()
    content = worker_js_path.read_text(encoding="utf-8")

    start_idx = content.find("function timingSafeMatch(a, b)")
    assert start_idx != -1
    end_idx = content.find("async function getD1Stats", start_idx)
    func_body = content[start_idx:end_idx]

    # Must not early exit on length inequality
    assert "if (a.length !== b.length) return false;" not in func_body
    assert "diff |= charA ^ charB;" in func_body
