"""Part 1 — GuardFall bypass classes against Andromity's command guard.

Each case is run three ways: straight at the guard, and through the terminal
app's approval gate in SAFE, TRUST and FULL. A bypass is any case that reaches
``allow``: the command runs and nobody was asked.
"""
import pytest

from andromity.core.security import (
    is_command_allowlisted,
    is_execution_control_path,
    is_sensitive_path,
)

from .cases import ALL_CASES, BENIGN, CLASS_E_RUNNERS, Case
from .harness import ALLOW, ASK, DEFAULT_ALLOWED_COMMANDS, decide, link_dir, project_session

RUNNER_ALLOWED = [
    "bash", "python", "node", "env", "xargs", "sudo", "find", "ssh", "sqlite3", "docker",
]


def _allowlist_for(case: Case) -> list:
    if case in CLASS_E_RUNNERS:
        return DEFAULT_ALLOWED_COMMANDS + RUNNER_ALLOWED
    return DEFAULT_ALLOWED_COMMANDS


@pytest.mark.parametrize("case", ALL_CASES, ids=lambda c: f"{c.cls}-{c.name}")
def test_bypass_never_auto_approves(case):
    assert is_command_allowlisted(case.command, _allowlist_for(case)) is False, (
        f"GuardFall class {case.cls} bypass: {case.command!r} auto-approved ({case.why})"
    )


@pytest.mark.parametrize("command", BENIGN)
def test_everyday_commands_still_run_unattended(command):
    assert is_command_allowlisted(command, DEFAULT_ALLOWED_COMMANDS) is True, (
        f"{command!r} now needs approval: the guard has moved the cost onto the user"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ALL_CASES, ids=lambda c: f"{c.cls}-{c.name}")
async def test_bypass_reaches_a_person_in_trust_mode(case, tmp_path):
    verdict = await decide(
        "trust", "shell_exec", {"command": case.command},
        project_path=str(tmp_path), allowed_commands=_allowlist_for(case),
    )
    assert verdict == ASK, f"class {case.cls} {case.name!r} returned {verdict} in TRUST mode"


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ALL_CASES[:8], ids=lambda c: f"{c.cls}-{c.name}")
async def test_safe_mode_asks_about_every_command(case, tmp_path):
    verdict = await decide(
        "safe", "shell_exec", {"command": case.command},
        project_path=str(tmp_path), allowed_commands=_allowlist_for(case),
    )
    assert verdict == ASK


@pytest.mark.asyncio
async def test_full_mode_runs_commands_as_documented(tmp_path):
    """FULL is the documented hands-off mode. The suite records that, it does not pretend otherwise."""
    verdict = await decide(
        "full", "shell_exec", {"command": "cat .env"}, project_path=str(tmp_path)
    )
    assert verdict == ALLOW


@pytest.mark.asyncio
async def test_untrusted_folder_outranks_full_mode(tmp_path):
    verdict = await decide(
        "full", "shell_exec", {"command": "git status"},
        project_path=str(tmp_path), trusted=False,
    )
    assert verdict != ALLOW


def test_guard_decision_does_not_depend_on_the_operating_system(monkeypatch):
    """The same command must decide the same way on Windows and on Linux.

    The old guard chose its tokenizer from ``os.name``, so a quoted word that a
    POSIX install sent to a person was auto-approved on Windows.
    """
    import os

    commands = [c.command for c in ALL_CASES] + BENIGN
    on_nt = {}
    monkeypatch.setattr(os, "name", "nt")
    for command in commands:
        on_nt[command] = is_command_allowlisted(command, DEFAULT_ALLOWED_COMMANDS + RUNNER_ALLOWED)
    monkeypatch.setattr(os, "name", "posix")
    for command in commands:
        assert is_command_allowlisted(command, DEFAULT_ALLOWED_COMMANDS + RUNNER_ALLOWED) == on_nt[command], (
            f"{command!r} decides differently depending on the operating system"
        )


@pytest.mark.parametrize("command", [
    "cat .env",
    "cat .env.production",
    "cat config.toml",
    "cat src/credentials.py",
    "cat .git/config",
    "dir C:\\Users\\me\\.ssh\\id_rsa",
    "cat /etc/shadow",
    "cat /proc/self/environ",
])
def test_sensitive_targets_never_auto_approve(command):
    assert is_command_allowlisted(command, DEFAULT_ALLOWED_COMMANDS) is False


def test_command_arguments_are_resolved_against_the_workspace(tmp_path):
    """A junction or symlink argument is judged by where it lands, not by its name."""
    project = tmp_path / "project"
    project.mkdir()
    outside = tmp_path / "home" / ".ssh"
    outside.mkdir(parents=True)
    (outside / "id_rsa").write_text("PRIVATE KEY", encoding="utf-8")

    if not link_dir(project / "vendor", outside):
        pytest.skip("this platform does not allow creating directory links in tests")

    assert is_command_allowlisted("cat vendor/id_rsa", DEFAULT_ALLOWED_COMMANDS, str(project)) is False
    assert is_command_allowlisted("cat vendor/notes.md", DEFAULT_ALLOWED_COMMANDS, str(project)) is False


def test_files_an_allowlisted_runner_executes_need_approval_to_write():
    """The other half of the loop: a silent write must not turn `pytest` into anything.

    TRUST writes files without asking and runs allowlisted commands without asking.
    If the agent could write the files those commands execute, the two together
    would run arbitrary code with nobody in the loop.
    """
    for path in (
        "tests/conftest.py", "conftest.py", "Makefile", "makefile", "justfile",
        "noxfile.py", "tox.ini", "setup.py", ".pre-commit-config.yaml",
        "Taskfile.yml", "Dockerfile", ".github/workflows/ci.yml",
    ):
        assert is_execution_control_path(path) is True, f"{path} can be written with nobody asked"

    for path in ("src/app.py", "README.md", "tests/test_app.py", "docs/guide.md"):
        assert is_execution_control_path(path) is False, f"{path} now needs approval for no reason"


@pytest.mark.asyncio
async def test_trust_mode_asks_before_writing_a_file_pytest_will_run(tmp_path):
    verdict = await decide(
        "trust", "write_file", {"path": "tests/conftest.py", "content": "import os"},
        project_path=str(tmp_path),
    )
    assert verdict == ASK


@pytest.mark.asyncio
async def test_trust_mode_writes_ordinary_source_without_asking(tmp_path):
    verdict = await decide(
        "trust", "write_file", {"path": "src/app.py", "content": "print(1)"},
        project_path=str(tmp_path),
    )
    assert verdict == ALLOW


def test_sensitive_path_precision_holds(tmp_path):
    with project_session(tmp_path):
        assert is_sensitive_path("src/tokenizer.py") is False
        assert is_sensitive_path("src/token_counter.py") is False
        assert is_sensitive_path(".env") is True
        assert is_sensitive_path("secrets.py") is True
        assert is_sensitive_path(".aws/credentials") is True
