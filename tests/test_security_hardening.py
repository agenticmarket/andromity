import asyncio
import pytest
from unittest.mock import patch, MagicMock
from andromity.core.security import is_command_allowlisted, is_sensitive_path
from andromity.core.cron import CronJob
from andromity.core.subagent import SubAgent
from andromity.core.events import Done, ToolCallStart, ToolCallEnd
from andromity.server.rpc_handler import JsonRpcHandler


def test_command_allowlist_metacharacters():
    allowed = ["git status", "git diff", "dir", "ls", "pytest", "npm test"]

    assert is_command_allowlisted("git status; rm -rf /", allowed) is False
    assert is_command_allowlisted("git status && calc.exe", allowed) is False
    assert is_command_allowlisted("git status | rm -rf /", allowed) is False
    assert is_command_allowlisted("git status\nrm -rf /", allowed) is False
    assert is_command_allowlisted("dir\r\ncalc.exe", allowed) is False
    assert is_command_allowlisted("echo %PATH%", ["echo"]) is False
    assert is_command_allowlisted("echo ^& calc", ["echo"]) is False
    assert is_command_allowlisted("git status `calc`", allowed) is False
    assert is_command_allowlisted("git status $(calc)", allowed) is False
    assert is_command_allowlisted("git status > out.txt", allowed) is False
    assert is_command_allowlisted("git status < in.txt", allowed) is False
    assert is_command_allowlisted("git status\0hidden", allowed) is False


def test_command_allowlist_allowed_cases():
    allowed = ["git status", "git diff", "dir", "ls", "pytest", "npm test"]

    assert is_command_allowlisted("git status", allowed) is True
    assert is_command_allowlisted("git status -s", allowed) is True
    assert is_command_allowlisted("git diff HEAD~1", allowed) is True
    assert is_command_allowlisted("pytest tests/test_security_hardening.py", allowed) is True
    assert is_command_allowlisted("npm test", allowed) is True


def test_command_allowlist_blocks_sensitive_file_targets():
    allowed = ["cat", "dir", "git diff", "echo"]

    assert is_command_allowlisted("cat .env", allowed) is False
    assert is_command_allowlisted("cat .env.production", allowed) is False
    assert is_command_allowlisted("cat /etc/passwd", allowed) is False
    assert is_command_allowlisted("cat /etc/shadow", allowed) is False
    assert is_command_allowlisted("dir C:\\Users\\me\\.ssh\\id_rsa", allowed) is False
    assert is_command_allowlisted("cat src/tokenizer.py", allowed) is True


def test_sensitive_path_precision():
    assert is_sensitive_path("src/tokenizer.py") is False
    assert is_sensitive_path("src/token_counter.py") is False
    assert is_sensitive_path("src/tokens.json") is True
    assert is_sensitive_path(".env") is True
    assert is_sensitive_path(".env.local") is True
    assert is_sensitive_path(".env.staging") is True
    assert is_sensitive_path("id_rsa") is True
    assert is_sensitive_path("id_ed25519") is True
    assert is_sensitive_path(".ssh/id_rsa.pub") is True
    assert is_sensitive_path(".git/config") is True
    assert is_sensitive_path("config.toml") is True
    assert is_sensitive_path("/etc/shadow") is True
    assert is_sensitive_path("/etc/passwd") is True
    assert is_sensitive_path("/proc/self/environ") is True
    assert is_sensitive_path("api_credentials.json") is True
    assert is_sensitive_path("user_password.txt") is True


@pytest.mark.asyncio
async def test_subagent_safe_mode_blocks_shell_bg_and_kill(tmp_path):
    subagent = SubAgent(
        parent_session_id="parent-test",
        role="coder",
        task="Test background process execution",
        project_path=str(tmp_path),
        permission_mode="safe",
    )

    async def mock_tool_stream(*args, **kwargs):
        yield ToolCallStart(tool_id="call_bg", tool_name="shell_bg")
        yield ToolCallEnd(tool_id="call_bg")
        yield Done()

    with patch("andromity.core.subagent.stream_completion", side_effect=mock_tool_stream):
        await subagent.execute()

    tool_msgs = [m for m in subagent.session.messages if m.get("role") == "tool"]
    assert len(tool_msgs) > 0
    assert "TOOL BLOCKED" in tool_msgs[0].get("content", "")
    assert "SAFE mode" in tool_msgs[0].get("content", "")


@pytest.mark.asyncio
async def test_subagent_trust_mode_validates_shell_allowlist(tmp_path):
    subagent = SubAgent(
        parent_session_id="parent-trust",
        role="coder",
        task="Run dangerous shell command in trust mode",
        project_path=str(tmp_path),
        permission_mode="trust",
    )

    async def mock_tool_stream(*args, **kwargs):
        yield ToolCallStart(tool_id="call_exec", tool_name="shell_exec")
        yield ToolCallEnd(tool_id="call_exec")
        yield Done()

    with patch("json.loads", return_value={"command": "rm -rf /"}):
        with patch("andromity.core.subagent.stream_completion", side_effect=mock_tool_stream):
            await subagent.execute()

    tool_msgs = [m for m in subagent.session.messages if m.get("role") == "tool"]
    assert len(tool_msgs) > 0
    assert "TOOL BLOCKED" in tool_msgs[0].get("content", "")


@pytest.mark.asyncio
async def test_cron_approval_rejects_chained_commands():
    job = CronJob(
        id="cron1",
        name="Security Audit Cron",
        prompt="run check",
        mode="trust",
        allowed_commands=["git status"],
    )

    handler = JsonRpcHandler()
    cron_approval = handler._make_cron_approval(job)

    assert await cron_approval("shell_exec", {"command": "git status"}) is True
    assert await cron_approval("shell_exec", {"command": "git status; rm -rf /"}) is False
    assert await cron_approval("shell_exec", {"command": "git status\ncalc.exe"}) is False
    assert await cron_approval("read_file", {"path": ".env"}) is False
    assert await cron_approval("read_file", {"path": "src/tokenizer.py"}) is True
