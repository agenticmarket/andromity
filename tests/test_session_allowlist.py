import os
import shutil
import tempfile
import pytest
from pathlib import Path

from andromity.core.db import set_custom_db_path, close_conn
from andromity.core.session import Session
from andromity.core.git_ops import ensure_clean_project_andromity, ensure_gitignore_entry


@pytest.fixture(autouse=True)
def isolate_db(tmp_path):
    db_file = tmp_path / "test_allowlist.db"
    set_custom_db_path(db_file)
    yield db_file
    close_conn()


def test_session_allow_command_and_domain(tmp_path):
    session = Session(name="allowlist-test", project_path=str(tmp_path))
    assert session.allowed_commands == []
    assert session.allowed_domains == []

    session.allow_command("npm test")
    session.allow_command("pytest")
    session.allow_domain("api.github.com")

    assert session.is_command_allowed("npm test")
    assert session.is_command_allowed("npm test -- -v")
    assert session.is_command_allowed("pytest tests/test_db.py")
    assert not session.is_command_allowed("rm -rf /")

    assert session.is_domain_allowed("https://api.github.com/repos")
    assert not session.is_domain_allowed("https://malicious.com")

    # Verify SQLite persistence
    loaded = Session.load_by_id(session.id)
    assert loaded is not None
    assert "npm test" in loaded.allowed_commands
    assert "pytest" in loaded.allowed_commands
    assert "api.github.com" in loaded.allowed_domains


def test_clean_project_andromity_gitignore(tmp_path):
    project_dir = tmp_path / "test_proj"
    project_dir.mkdir(parents=True, exist_ok=True)
    andromity_dir = project_dir / ".andromity"
    andromity_dir.mkdir(parents=True, exist_ok=True)

    ensure_clean_project_andromity(str(project_dir))

    # Project root .gitignore must contain .andromity/
    root_gi = project_dir / ".gitignore"
    assert root_gi.exists()
    content = root_gi.read_text(encoding="utf-8")
    assert ".andromity/" in content

    # Internal .andromity/.gitignore must exist
    internal_gi = andromity_dir / ".gitignore"
    assert internal_gi.exists()
    internal_content = internal_gi.read_text(encoding="utf-8")
    assert "cron_runs/" in internal_content
    assert "*.tmp" in internal_content
