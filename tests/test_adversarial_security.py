"""Adversarial penetration tests for LLM security boundaries and skill access."""
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
        "C:/Windows/System32/config/SAM",
        "C:/Windows/System32/drivers/etc/hosts",
        "~/.bash_history",
        "~/.zsh_history",
    ]
    for path in attacks:
        res = read_file(path)
        assert "Access denied" in res or "Error reading file" in res
        assert "matches sensitive" in res or "outside the project" in res


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
