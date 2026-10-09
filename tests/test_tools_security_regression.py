import os
import pytest
from pathlib import Path

from andromity.config import config
from andromity.core.tools import (
    _assert_safe_read_path,
    get_clean_subprocess_env,
    requires_workspace_trust,
    execute_tool,
)


def test_assert_safe_read_path_blocks_sensitive_files_inside_workspace(tmp_path, monkeypatch):
    """Reading .env or credentials inside project root must raise PermissionError."""
    config.set_trusted(str(tmp_path))
    monkeypatch.chdir(tmp_path)

    # 1. Normal source file is allowed
    normal_file = tmp_path / "hello.py"
    normal_file.write_text("print('hello')", encoding="utf-8")
    assert _assert_safe_read_path(normal_file) == normal_file.resolve()

    # 2. .env file inside workspace must be blocked
    env_file = tmp_path / ".env"
    env_file.write_text("SECRET_KEY=123", encoding="utf-8")
    with pytest.raises(PermissionError) as exc_info:
        _assert_safe_read_path(env_file)
    assert "matches sensitive system/credential targets" in str(exc_info.value)

    # 3. .env.production file inside workspace must be blocked
    env_prod = tmp_path / ".env.production"
    env_prod.write_text("SECRET_KEY=123", encoding="utf-8")
    with pytest.raises(PermissionError) as exc_info:
        _assert_safe_read_path(env_prod)
    assert "matches sensitive system/credential targets" in str(exc_info.value)

    # 4. SSH key inside workspace must be blocked
    key_file = tmp_path / "id_rsa"
    key_file.write_text("private key", encoding="utf-8")
    with pytest.raises(PermissionError) as exc_info:
        _assert_safe_read_path(key_file)
    assert "matches sensitive system/credential targets" in str(exc_info.value)


def test_clean_subprocess_env_scrubs_sensitive_provider_keys(monkeypatch):
    """Provider API keys in os.environ must be stripped from child subprocess env."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret-key-123")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret-456")
    monkeypatch.setenv("GEMINI_API_KEY", "ai-secret-789")
    monkeypatch.setenv("SAFE_VAR", "visible_to_child")

    cleaned = get_clean_subprocess_env()

    assert "OPENAI_API_KEY" not in cleaned
    assert "ANTHROPIC_API_KEY" not in cleaned
    assert "GEMINI_API_KEY" not in cleaned
    assert cleaned.get("SAFE_VAR") == "visible_to_child"

    # Explicit extra_env allowed
    explicit = get_clean_subprocess_env(extra_env={"OPENAI_API_KEY": "custom-override"})
    assert explicit.get("OPENAI_API_KEY") == "custom-override"


def test_requires_workspace_trust_gates_fs_and_command_tools():
    """Execution and filesystem manipulation tools must strictly require workspace trust."""
    assert requires_workspace_trust("shell_exec") is True
    assert requires_workspace_trust("run_background_process") is True
    assert requires_workspace_trust("write_file") is True
    assert requires_workspace_trust("edit_file") is True
    assert requires_workspace_trust("read_file") is True
    assert requires_workspace_trust("list_dir") is True
    assert requires_workspace_trust("grep_search") is True

    # Read-only coordination and answering stay available in untrusted folders
    assert requires_workspace_trust("list_tools") is False
    assert requires_workspace_trust("ask_questions") is False
    assert requires_workspace_trust("session_list") is False
    assert requires_workspace_trust("session_read_messages") is False
    assert requires_workspace_trust("session_answer_question") is False
    assert requires_workspace_trust("shared_state_get") is False


def test_requires_workspace_trust_gates_tools_that_can_wake_or_steer_sessions():
    """An untrusted session must not be able to drive a trusted one through the bus."""
    for name in ("session_send_message", "session_ask_question", "session_broadcast",
                 "session_watch", "shared_state_set", "write_handoff"):
        assert requires_workspace_trust(name) is True, name


def test_execute_tool_has_valid_docstring():
    """execute_tool docstring must be properly recognized on the function object."""
    assert execute_tool.__doc__ is not None
    assert "Execute any tool" in execute_tool.__doc__
