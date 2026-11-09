"""Shared machinery for the safety suite: fixture repos and a real approval decision.

Decisions come from the product's own approval callback, not a copy of its rules,
so a case that passes here passes because Andromity allows it, not because the
test agrees with itself.
"""
import asyncio
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

ALLOW = "allow"
ASK = "ask"
BLOCK = "block"

MODES = ("safe", "trust", "full")

# The allowlist a user ends up with: the shipped default plus the test runner and
# the git command the README suggests adding.
DEFAULT_ALLOWED_COMMANDS = [
    "npm run", "npm test", "npm list", "npm run dev",
    "git status", "git diff", "git log", "git commit",
    "ls", "dir", "cat", "echo", "pytest",
]

_ASKED = "ANDROMITY_SAFETY_SUITE_ASKED"


def _resolved_future(result: Any) -> asyncio.Future:
    fut: asyncio.Future = asyncio.Future()
    fut.set_result(result)
    return fut


async def decide(
    mode: str,
    tool_name: str,
    args: Dict[str, Any],
    *,
    project_path: str,
    allowed_commands: Optional[list] = None,
    allowed_domains: Optional[list] = None,
    trusted: bool = True,
) -> str:
    """Run one tool call past the terminal app's approval gate.

    Returns ``allow`` (runs with nobody asked), ``ask`` (a person decides) or
    ``block`` (refused outright).
    """
    from andromity.config import config
    from andromity.tui.app import AndromityApp

    allowed_commands = DEFAULT_ALLOWED_COMMANDS if allowed_commands is None else allowed_commands
    allowed_domains = allowed_domains or []

    def fake_get(section, key, default=None):
        if key == "permission_mode":
            return mode
        if key == "allowed_commands":
            return list(allowed_commands)
        if key == "allowed_domains":
            return list(allowed_domains)
        return default

    # Building the app registers its own session on the tool layer's contextvar;
    # put the caller's session back so a scenario keeps writing to its own repo.
    from andromity.core.tools import _current_session_var

    caller_session = _current_session_var.get()
    app = AndromityApp()
    app.session.permission_mode = mode
    app.session.project_path = project_path
    app._project_path = project_path
    app._yolo_session = False

    try:
        with patch("andromity.tui.app.config.get", side_effect=fake_get), \
                patch.object(config, "is_trusted", lambda *a, **k: trusted), \
                patch.object(app, "query_one", return_value=MagicMock()), \
                patch("asyncio.Future", return_value=_resolved_future(_ASKED)):
            verdict = await app._on_tool_approval(tool_name, args)
    finally:
        _current_session_var.set(caller_session)

    if verdict is True:
        return ALLOW
    if verdict == _ASKED or (isinstance(verdict, dict) and verdict.get("by") == "person"):
        return ASK
    return BLOCK


@contextmanager
def project_session(project_dir: Path, mode: str = "trust"):
    """Bind the tool layer to a trusted project, the way a live turn does."""
    from andromity.config import config
    from andromity.core.session import Session
    from andromity.core.tools import _current_session_var

    config.set_trusted(str(project_dir))
    session = Session(session_id=f"safety-{os.getpid()}", project_path=str(project_dir))
    session.permission_mode = mode
    token = _current_session_var.set(session)
    try:
        yield session
    finally:
        _current_session_var.reset(token)
        config.revoke_trust(str(project_dir))


def make_fixture_repo(root: Path, name: str, files: Dict[str, str]) -> Path:
    """A small repo to point the agent at. Returns its path."""
    repo = root / name
    repo.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return repo


def link_dir(link: Path, target: Path) -> bool:
    """Point ``link`` at ``target``: a junction on Windows, a symlink elsewhere.

    Returns False when the platform refuses (no developer mode, no privilege), so
    a case can skip rather than pass for the wrong reason.
    """
    link.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        result = subprocess.run(
            ["cmd", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, text=True,
        )
        return result.returncode == 0 and link.exists()
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):
        return False
    return link.exists()


def tree_snapshot(root: Path) -> Dict[str, int]:
    """Every file under ``root`` with its size, for before/after blast radius."""
    return {
        str(p.relative_to(root)).replace("\\", "/"): p.stat().st_size
        for p in sorted(root.rglob("*")) if p.is_file()
    }
