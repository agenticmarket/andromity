"""Adversarial penetration tests for LLM security boundaries and skill access."""
import sys
import tempfile
from pathlib import Path
import pytest

from andromity.core.session import Session
from andromity.core.tools import (
    read_file,
    write_file,
    edit_file,
    edit_file_multi,
    _current_session_var,
)
from andromity.core.skills import get_approved_skill_roots, attach_skill_mentions, SkillsManager


@pytest.fixture
def test_env(tmp_path):
    project_dir = tmp_path / "my_project"
    project_dir.mkdir()
    (project_dir / "app.py").write_text("print('hello world')", encoding="utf-8")

    skills_dir = tmp_path / "global_skills"
    skills_dir.mkdir()
    skill_folder = skills_dir / "super-skill"
    skill_folder.mkdir()
    (skill_folder / "SKILL.md").write_text(
        "---\nname: super-skill\ndescription: Test skill\n---\n# Instructions\nExecute unit test.",
        encoding="utf-8",
    )

    from andromity.config import config
    config.set_trusted(str(project_dir))

    session = Session(session_id="test-session-sec", project_path=str(project_dir))
    token = _current_session_var.set(session)

    yield {
        "project_dir": project_dir,
        "skills_dir": skills_dir,
        "skill_md": skill_folder / "SKILL.md",
        "session": session,
    }

    _current_session_var.reset(token)
    config.revoke_trust(str(project_dir))


# ── Adversarial Attack Vectors (LLM Trying to Breach System) ─────────────────


def test_adversarial_ssh_key_exfiltration(test_env):
    attacks = [
        "~/.ssh/id_rsa",
        "~/.ssh/id_ed25519",
        "~/.ssh/known_hosts",
        "~/.ssh/authorized_keys",
        "~/.ssh/config",
        "/root/.ssh/id_rsa",
    ]
    for path in attacks:
        res = read_file(path)
        assert "Access denied" in res or "Error reading file" in res
        assert "matches sensitive" in res or "outside the project" in res


def test_adversarial_cloud_credentials_exfiltration(test_env):
    attacks = [
        "~/.aws/credentials",
        "~/.aws/config",
        "/home/user/.aws/credentials",
    ]
    for path in attacks:
        res = read_file(path)
        assert "Access denied" in res or "Error reading file" in res
        assert "matches sensitive" in res or "outside the project" in res


def test_adversarial_os_database_exfiltration(test_env):
    attacks = [
        "/etc/passwd",
        "/etc/shadow",
        "~/.bash_history",
        "~/.zsh_history",
    ]
    if sys.platform == "win32":
        attacks.extend([
            "C:/Windows/System32/config/SAM",
            "C:/Windows/System32/drivers/etc/hosts",
        ])
    for path in attacks:
        res = read_file(path)
        assert "Access denied" in res or "Error reading file" in res or "does not exist" in res
        assert "matches sensitive" in res or "outside the project" in res or "does not exist" in res


def test_adversarial_path_traversal_attempts(test_env):
    attacks = [
        "../../../../../../../../etc/passwd",
        "../../../../../../../../Windows/System32/config/SAM",
        "../../.ssh/id_rsa",
        "app.py/../../.ssh/id_rsa",
    ]
    for path in attacks:
        res = read_file(path)
        assert "Access denied" in res or "Error reading file" in res


def test_adversarial_unauthorized_external_file_read(test_env, tmp_path):
    random_external = tmp_path / "unauthorized_secret.txt"
    random_external.write_text("CONFIDENTIAL DATA", encoding="utf-8")

    res = read_file(str(random_external))
    assert "Access denied" in res
    assert "outside the project directory" in res
    assert "CONFIDENTIAL DATA" not in res


def test_adversarial_write_outside_workspace_blocked(test_env):
    skill_file = test_env["skill_md"]
    res = write_file(str(skill_file), "MALICIOUS OVERWRITE")
    assert "Access denied" in res
    assert "Modifying or deleting files outside" in res
    assert "Execute unit test." in skill_file.read_text(encoding="utf-8")


def test_adversarial_replace_outside_workspace_blocked(test_env):
    skill_file = test_env["skill_md"]
    res = edit_file(str(skill_file), "Execute unit test.", "HACKED")
    assert "Access denied" in res
    assert "Modifying or deleting files outside" in res


def test_adversarial_edit_multi_outside_workspace_blocked(test_env):
    skill_file = test_env["skill_md"]
    res = edit_file_multi(str(skill_file), [{"old_str": "Execute unit test.", "new_str": "HACKED"}])
    assert "Access denied" in res
    assert "Modifying or deleting files outside" in res
    assert skill_file.exists()


# ── Legitimate Skill & Attached File Operations ──────────────────────────────


def test_legitimate_skill_file_read(test_env, monkeypatch):
    monkeypatch.setattr(
        "andromity.core.skills.get_approved_skill_roots",
        lambda project_path=None: [test_env["skills_dir"]],
    )
    res = read_file(str(test_env["skill_md"]))
    assert "Execute unit test." in res
    assert "super-skill" in res
    assert "Error" not in res


def test_legitimate_session_attached_file_read(test_env, tmp_path):
    attached_doc = tmp_path / "user_attached_doc.md"
    attached_doc.write_text("# Project API Spec\nEndpoint: /api/v1/data", encoding="utf-8")

    session = test_env["session"]
    session.allow_external_file(attached_doc)

    res = read_file(str(attached_doc))
    assert "Project API Spec" in res
    assert "Endpoint: /api/v1/data" in res
    assert "Error" not in res


def test_legitimate_workspace_read_write(test_env):
    app_file = test_env["project_dir"] / "app.py"
    r = read_file(str(app_file))
    assert "print('hello world')" in r

    w = write_file(str(test_env["project_dir"] / "new_module.py"), "x = 42")
    assert "Successfully wrote" in w
    assert (test_env["project_dir"] / "new_module.py").read_text(encoding="utf-8") == "x = 42"


# ── Adversarial Tests for 3-Gate Enforcement Hierarchy ─────────────────────────


@pytest.mark.asyncio
async def test_adversarial_planner_profile_blocks_write_file_turn(test_env, monkeypatch):
    """Planner profile must strictly block file mutations even if auto_approve is True."""
    from andromity.core.agent import Agent
    from andromity.core.events import ToolCallStart, ToolCallDelta, ToolCallEnd, Done, TextDelta, ToolResult

    session = test_env["session"]
    agent = Agent(session=session, profile="planner", auto_approve=True)

    target_file = test_env["project_dir"] / "malicious.py"

    call_count = 0

    async def mock_planner_injection_stream(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolCallStart(tool_name="write_file", tool_id="call_inj")
            yield ToolCallDelta(tool_id="call_inj", args_json_chunk=f'{{"path": "{target_file.as_posix()}", "content": "evil"}}')
            yield ToolCallEnd(tool_id="call_inj")
            yield Done()
        else:
            yield TextDelta(text="Understood, I am a planner and cannot write files.")
            yield Done()

    monkeypatch.setattr("andromity.core.agent.stream_completion", mock_planner_injection_stream)

    events = [e async for e in agent.run("Plan the architecture")]
    tool_results = [e for e in events if isinstance(e, ToolResult) and e.tool_id == "call_inj"]

    assert len(tool_results) == 1
    assert tool_results[0].success is False
    assert "Blocked: planner profile" in tool_results[0].result
    assert not target_file.exists(), "Planner must never create or write files to disk!"


@pytest.mark.asyncio
async def test_adversarial_reviewer_profile_blocks_shell_exec_turn(test_env, monkeypatch):
    """Reviewer profile must strictly block shell execution even if auto_approve is True."""
    from andromity.core.agent import Agent
    from andromity.core.events import ToolCallStart, ToolCallDelta, ToolCallEnd, Done, TextDelta, ToolResult

    session = test_env["session"]
    agent = Agent(session=session, profile="reviewer", auto_approve=True)

    call_count = 0

    async def mock_reviewer_injection_stream(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolCallStart(tool_name="shell_exec", tool_id="call_sh")
            yield ToolCallDelta(tool_id="call_sh", args_json_chunk='{"command": "echo pwned"}')
            yield ToolCallEnd(tool_id="call_sh")
            yield Done()
        else:
            yield TextDelta(text="Understood, I am a reviewer and cannot execute commands.")
            yield Done()

    monkeypatch.setattr("andromity.core.agent.stream_completion", mock_reviewer_injection_stream)

    events = [e async for e in agent.run("Review the security")]
    tool_results = [e for e in events if isinstance(e, ToolResult) and e.tool_id == "call_sh"]

    assert len(tool_results) == 1
    assert tool_results[0].success is False
    assert "Blocked: reviewer profile" in tool_results[0].result


@pytest.mark.asyncio
async def test_adversarial_untrusted_folder_blocks_in_full_mode_turn(tmp_path, monkeypatch):
    """Untrusted workspace folder unconditionally blocks mutating tools in FULL mode."""
    from andromity.core.agent import Agent
    from andromity.core.events import ToolCallStart, ToolCallDelta, ToolCallEnd, Done, TextDelta, ToolResult
    from andromity.config import config

    untrusted_dir = tmp_path / "untrusted_repo"
    untrusted_dir.mkdir()
    config.revoke_trust(str(untrusted_dir))
    assert not config.is_trusted(str(untrusted_dir))

    session = Session(session_id="untrusted-sess", project_path=str(untrusted_dir))
    agent = Agent(session=session, profile="builder", auto_approve=True)

    target_file = untrusted_dir / "exploit.py"
    call_count = 0

    async def mock_untrusted_stream(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolCallStart(tool_name="write_file", tool_id="call_untrusted")
            yield ToolCallDelta(tool_id="call_untrusted", args_json_chunk=f'{{"path": "{target_file.as_posix()}", "content": "blocked"}}')
            yield ToolCallEnd(tool_id="call_untrusted")
            yield Done()
        else:
            yield TextDelta(text="Workspace is untrusted.")
            yield Done()

    monkeypatch.setattr("andromity.core.agent.stream_completion", mock_untrusted_stream)

    events = [e async for e in agent.run("Write exploit in untrusted folder")]
    tool_results = [e for e in events if isinstance(e, ToolResult) and e.tool_id == "call_untrusted"]

    assert len(tool_results) == 1
    assert tool_results[0].success is False
    assert "Untrusted Workspace" in tool_results[0].result
    assert not target_file.exists(), "Untrusted workspace must never allow writes even in FULL mode!"


@pytest.mark.asyncio
async def test_adversarial_cron_empty_trusted_projects_blocked(tmp_path):
    """Cron execution in an untrusted workspace must be blocked even when trusted_projects is empty."""
    from andromity.core.cron import CronJob
    from andromity.server.rpc_handler import JsonRpcHandler
    from andromity.config import config

    untrusted_dir = tmp_path / "cron_untrusted"
    untrusted_dir.mkdir()
    config.set("trust", "trusted_projects", [])
    assert not config.is_trusted(str(untrusted_dir))

    job = CronJob(
        id="cron_untrusted_job",
        name="Untrusted Cron",
        prompt="run scheduled task",
        mode="yolo",
        project_path=str(untrusted_dir),
    )

    handler = JsonRpcHandler()
    res = await handler._execute_cron_job(str(untrusted_dir), job, is_manual=True)

    assert res["status"] == "failed"
    assert "Workspace folder is untrusted" in res["error"]

