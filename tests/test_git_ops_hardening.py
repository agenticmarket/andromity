"""Snapshots and Undo must never run programs configured in the repository or user git config."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from andromity.core.git_ops import (
    UnsafeGitConfig,
    create_pre_edit_snapshot,
    get_repo,
    restore_file_snapshot,
    safe_git_command,
)


def _git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=root, check=check, capture_output=True, text=True)


@pytest.fixture(autouse=True)
def isolated_git_config(tmp_path, monkeypatch):
    empty = tmp_path / "empty.gitconfig"
    empty.write_text("")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")


@pytest.fixture
def repo_dir(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "a.txt").write_text("one\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    return root


def _marker_program(tmp_path: Path, marker: Path, passthrough: bool = True) -> str:
    script = tmp_path / f"make_{marker.name}.py"
    body = f"import pathlib, sys\npathlib.Path({str(marker)!r}).write_text('ran')\n"
    if passthrough:
        body += "sys.stdout.write(sys.stdin.read())\n"
    script.write_text(body)
    return f'"{Path(sys.executable).as_posix()}" "{script.as_posix()}"'


def test_a_repo_configured_clean_filter_never_runs(repo_dir, tmp_path):
    marker = tmp_path / "clean-ran"
    _git(repo_dir, "config", "filter.trap.clean", _marker_program(tmp_path, marker))
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=trap\n")
    (repo_dir / "a.txt").write_text("two\n")

    _git(repo_dir, "add", "-A")
    assert marker.exists(), "the trap must fire for a plain git add, otherwise this test proves nothing"
    _git(repo_dir, "reset", "-q")
    marker.unlink(missing_ok=True)

    snapshot = create_pre_edit_snapshot(repo_dir)
    assert snapshot and not marker.exists()
    assert _git(repo_dir, "show", f"{snapshot}:a.txt").stdout.replace("\r", "") == "two\n"


def test_a_repo_configured_process_filter_never_runs(repo_dir, tmp_path):
    marker = tmp_path / "process-ran"
    _git(repo_dir, "config", "filter.trap.process", _marker_program(tmp_path, marker, passthrough=False))
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=trap\n")
    (repo_dir / "a.txt").write_text("three\n")

    snapshot = create_pre_edit_snapshot(repo_dir)
    assert snapshot and not marker.exists()


@pytest.mark.skipif(shutil.which("sh") is None and sys.platform != "win32", reason="hooks need a shell")
@pytest.mark.parametrize("hook", ["post-index-change", "reference-transaction"])
def test_planted_git_hooks_never_run_during_a_snapshot(repo_dir, tmp_path, hook):
    marker = tmp_path / f"{hook}-ran"
    hook_file = repo_dir / ".git" / "hooks" / hook
    hook_file.write_text(f"#!/bin/sh\necho ran > '{marker.as_posix()}'\n")
    hook_file.chmod(0o755)

    if hook == "reference-transaction":
        _git(repo_dir, "update-ref", "refs/heads/probe", "HEAD")
    else:
        (repo_dir / "a.txt").write_text("probe\n")
        _git(repo_dir, "add", "a.txt")
    if not marker.exists():
        pytest.skip("this git build does not run the hook, so the test proves nothing here")
    marker.unlink()

    (repo_dir / "a.txt").write_text("four\n")
    assert create_pre_edit_snapshot(repo_dir) and not marker.exists()


def test_fsmonitor_never_runs_during_a_snapshot(repo_dir, tmp_path):
    marker = tmp_path / "fsmonitor-ran"
    _git(repo_dir, "config", "core.fsmonitor", _marker_program(tmp_path, marker, passthrough=False))
    _git(repo_dir, "status", check=False)
    assert marker.exists(), "the trap must fire for a plain git status, otherwise this test proves nothing"
    marker.unlink()

    (repo_dir / "a.txt").write_text("five\n")
    assert create_pre_edit_snapshot(repo_dir) and not marker.exists()


def test_undo_never_runs_a_repo_configured_smudge_filter(repo_dir, tmp_path):
    before = create_pre_edit_snapshot(repo_dir)
    (repo_dir / "a.txt").write_text("changed\n")
    marker = tmp_path / "smudge-ran"
    _git(repo_dir, "config", "filter.trap.smudge", _marker_program(tmp_path, marker))
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=trap\n")

    assert restore_file_snapshot(get_repo(repo_dir), before, "a.txt")
    assert not marker.exists()
    assert (repo_dir / "a.txt").read_text().replace("\r", "") == "one\n"


def test_a_filter_name_that_cannot_be_disabled_stops_the_snapshot(repo_dir, tmp_path):
    marker = tmp_path / "odd-ran"
    config = repo_dir / ".git" / "config"
    config.write_text(config.read_text() + f'[filter "odd=name"]\n\tclean = {_marker_program(tmp_path, marker)}\n')
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=odd=name\n")
    (repo_dir / "a.txt").write_text("six\n")

    with pytest.raises(UnsafeGitConfig):
        safe_git_command(get_repo(repo_dir))
    assert create_pre_edit_snapshot(repo_dir) is None
    assert not marker.exists()


def test_the_standard_git_lfs_filter_keeps_working(repo_dir):
    if shutil.which("git-lfs") is None:
        pytest.skip("git-lfs is not installed")
    _git(repo_dir, "lfs", "install", "--local")
    (repo_dir / ".gitattributes").write_text("*.bin filter=lfs diff=lfs merge=lfs -text\n")
    (repo_dir / "big.bin").write_bytes(b"\x00binary payload\x00" * 100)

    command = safe_git_command(get_repo(repo_dir))
    assert not any(part.startswith("filter.lfs.") for part in command)
    snapshot = create_pre_edit_snapshot(repo_dir)
    assert _git(repo_dir, "show", f"{snapshot}:big.bin").stdout.startswith("version https://git-lfs")


@pytest.mark.parametrize("program", ["clean", "process"])
def test_a_tampered_lfs_driver_is_disabled_like_any_other(repo_dir, tmp_path, program):
    marker = tmp_path / "fake-lfs-ran"
    _git(repo_dir, "config", f"filter.lfs.{program}", _marker_program(tmp_path, marker, passthrough=False))
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=lfs\n")
    (repo_dir / "a.txt").write_text("seven\n")
    _git(repo_dir, "add", "-A", check=False)
    assert marker.exists(), "the tampered driver must fire for git add, otherwise this test proves nothing"
    _git(repo_dir, "reset", "-q", check=False)
    marker.unlink(missing_ok=True)

    assert create_pre_edit_snapshot(repo_dir) and not marker.exists()


def test_filter_names_keep_their_case(repo_dir, tmp_path):
    marker = tmp_path / "mixed-case-ran"
    _git(repo_dir, "config", "filter.TrapCase.clean", _marker_program(tmp_path, marker))
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=TrapCase\n")
    (repo_dir / "a.txt").write_text("thirteen\n")
    _git(repo_dir, "add", "-A")
    assert marker.exists(), "the mixed-case filter must fire for git add, otherwise this test proves nothing"
    _git(repo_dir, "reset", "-q")
    marker.unlink(missing_ok=True)

    assert create_pre_edit_snapshot(repo_dir) and not marker.exists()


def _shell_marker(tmp_path: Path, marker: Path) -> Path:
    script = tmp_path / f"{marker.name}.sh"
    script.write_text(f"#!/bin/sh\necho ran > '{marker.as_posix()}'\nexit 1\n")
    script.chmod(0o755)
    return script


def _trap_everything(repo_dir: Path, tmp_path: Path, marker: Path) -> None:
    program = _marker_program(tmp_path, marker)
    _git(repo_dir, "config", "filter.trap.clean", program)
    _git(repo_dir, "config", "filter.trap.smudge", program)
    _git(repo_dir, "config", "diff.trap.textconv", program)
    _git(repo_dir, "config", "core.fsmonitor", _marker_program(tmp_path, marker, passthrough=False))
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=trap diff=trap\n")


def test_changes_review_and_file_panels_never_run_repo_programs(repo_dir, tmp_path):
    from andromity.core.git_ops import get_file_diff, get_git_status, status_entries
    from andromity.core.git_review import file_diff, numstat, show_file

    marker = tmp_path / "review-ran"
    _trap_everything(repo_dir, tmp_path, marker)
    (repo_dir / "a.txt").write_text("changed\n")
    (repo_dir / "new.txt").write_text("new\n")
    _git(repo_dir, "diff", "HEAD", check=False)
    assert marker.exists(), "plain git diff must fire the trap, otherwise this test proves nothing"
    marker.unlink()

    repo = get_repo(repo_dir)
    assert {e["path"] for e in status_entries(repo)} == {"a.txt", "new.txt"}
    assert get_git_status(repo) == {"a.txt": "M", "new.txt": "U"}
    assert "+changed" in get_file_diff(repo, "a.txt")
    assert "+changed" in file_diff(repo, "a.txt")["diff"]
    assert numstat(repo)["a.txt"] == {"additions": 1, "deletions": 1, "binary": False}
    assert show_file(repo, "a.txt", "INDEX").strip() == "one"
    assert not marker.exists()


def test_discard_refuses_a_file_whose_filter_was_disabled(repo_dir, tmp_path):
    from andromity.core.git_review import revert_file

    marker = tmp_path / "discard-ran"
    _git(repo_dir, "config", "filter.trap.smudge", _marker_program(tmp_path, marker))
    (repo_dir / ".git" / "info" / "attributes").write_text("a.txt filter=trap\n")
    (repo_dir / "a.txt").write_text("changed\n")

    with pytest.raises(ValueError, match="trap"):
        revert_file(get_repo(repo_dir), "a.txt")
    assert not marker.exists()
    assert (repo_dir / "a.txt").read_text() == "changed\n"


def test_discard_still_works_for_files_without_a_disabled_filter(repo_dir, tmp_path):
    from andromity.core.git_review import revert_file

    marker = tmp_path / "discard-other-ran"
    _git(repo_dir, "config", "filter.trap.smudge", _marker_program(tmp_path, marker))
    (repo_dir / ".git" / "info" / "attributes").write_text("*.bin filter=trap\n")
    hook = repo_dir / ".git" / "hooks" / "post-index-change"
    hook.write_text(f"#!/bin/sh\necho ran > '{marker.as_posix()}'\n")
    hook.chmod(0o755)
    (repo_dir / "a.txt").write_text("changed\n")
    (repo_dir / "added.txt").write_text("added\n")
    _git(repo_dir, "add", "added.txt")
    marker.unlink(missing_ok=True)

    repo = get_repo(repo_dir)
    assert revert_file(repo, "a.txt")["action"] == "checkout"
    assert revert_file(repo, "added.txt")["action"] == "deleted"
    assert (repo_dir / "a.txt").read_text().replace("\r", "") == "one\n"
    assert not (repo_dir / "added.txt").exists()
    assert not marker.exists()


def test_filters_defined_in_an_included_worktree_file_are_disabled(repo_dir, tmp_path):
    marker = tmp_path / "include-ran"
    shared = repo_dir / "shared.gitconfig"
    shared.write_text(f'[filter "trap"]\n\tclean = {_marker_program(tmp_path, marker)}\n')
    _git(repo_dir, "config", "include.path", "../shared.gitconfig")
    (repo_dir / ".gitattributes").write_text("*.txt filter=trap\n")
    (repo_dir / "a.txt").write_text("eight\n")
    _git(repo_dir, "add", "-A")
    assert marker.exists(), "the included filter must fire for git add, otherwise this test proves nothing"
    _git(repo_dir, "reset", "-q")
    marker.unlink(missing_ok=True)

    assert create_pre_edit_snapshot(repo_dir) and not marker.exists()


def test_the_deprecated_section_syntax_is_disabled_too(repo_dir, tmp_path):
    marker = tmp_path / "old-syntax-ran"
    config = repo_dir / ".git" / "config"
    config.write_text(config.read_text() + f"[filter.Trap]\n\tclean = {_marker_program(tmp_path, marker)}\n")
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=trap\n")
    (repo_dir / "a.txt").write_text("nine\n")
    _git(repo_dir, "add", "-A")
    assert marker.exists(), "git must honour the old syntax, otherwise this test proves nothing"
    _git(repo_dir, "reset", "-q")
    marker.unlink(missing_ok=True)

    assert create_pre_edit_snapshot(repo_dir) and not marker.exists()


def test_an_empty_filter_name_stops_the_snapshot(repo_dir, tmp_path):
    marker = tmp_path / "empty-name-ran"
    config = repo_dir / ".git" / "config"
    config.write_text(config.read_text() + f'[filter ""]\n\tclean = {_marker_program(tmp_path, marker)}\n')
    (repo_dir / "a.txt").write_text("ten\n")
    with pytest.raises(UnsafeGitConfig):
        safe_git_command(get_repo(repo_dir))
    assert create_pre_edit_snapshot(repo_dir) is None and not marker.exists()


def test_code_search_never_runs_fsmonitor(repo_dir, tmp_path, monkeypatch):
    from andromity.core import search

    marker = tmp_path / "grep-ran"
    _git(repo_dir, "config", "core.fsmonitor", _marker_program(tmp_path, marker, passthrough=False))
    _git(repo_dir, "grep", "-n", "-I", "--untracked", "-i", "-e", "one", "--", ".", check=False)
    if not marker.exists():
        pytest.skip("git grep --untracked does not query fsmonitor on this git build")
    marker.unlink()

    monkeypatch.setattr(search, "find_ripgrep_path", lambda: None)
    assert "a.txt" in search.grep_search("one", str(repo_dir))
    assert not marker.exists()


def test_snapshots_never_sign_with_a_configured_gpg_program(repo_dir, tmp_path):
    marker = tmp_path / "gpg-ran"
    _git(repo_dir, "config", "commit.gpgSign", "true")
    _git(repo_dir, "config", "gpg.program", _shell_marker(tmp_path, marker).as_posix())
    _git(repo_dir, "commit", "--allow-empty", "-qm", "probe", check=False)
    if not marker.exists():
        pytest.skip("this git build did not run the gpg program, so the test proves nothing here")
    marker.unlink()

    (repo_dir / "a.txt").write_text("eleven\n")
    assert create_pre_edit_snapshot(repo_dir) and not marker.exists()


def _full_diff_over_rpc(repo_dir: Path) -> str:
    import asyncio
    from andromity.config import config
    from andromity.server.rpc_handler import JsonRpcHandler

    config.set_trusted(str(repo_dir))
    return asyncio.run(JsonRpcHandler().rpc_git_diff({"project_path": str(repo_dir)}))["diff"]


@pytest.mark.parametrize("trap", ["textconv", "clean", "fsmonitor"])
def test_view_all_changes_never_runs_repo_programs(repo_dir, tmp_path, trap):
    marker = tmp_path / f"{trap}-ran"
    if trap == "textconv":
        _git(repo_dir, "config", "diff.trap.textconv", _marker_program(tmp_path, marker, passthrough=False))
        (repo_dir / ".git" / "info" / "attributes").write_text("* diff=trap\n")
    elif trap == "clean":
        _git(repo_dir, "config", "filter.trap.clean", _marker_program(tmp_path, marker))
        (repo_dir / ".git" / "info" / "attributes").write_text("* filter=trap\n")
    else:
        _git(repo_dir, "config", "core.fsmonitor", _marker_program(tmp_path, marker, passthrough=False))
    (repo_dir / "a.txt").write_text("two\n")
    _git(repo_dir, "diff", "--no-ext-diff", "--no-renames", "HEAD", check=False)
    if not marker.exists():
        pytest.skip(f"plain git diff does not run {trap} on this git build")
    marker.unlink()

    assert "+two" in _full_diff_over_rpc(repo_dir)
    assert not marker.exists()


def test_view_all_changes_refuses_a_filter_it_cannot_switch_off(repo_dir, tmp_path):
    marker = tmp_path / "odd-ran"
    config = repo_dir / ".git" / "config"
    config.write_text(config.read_text() + f'[filter "odd=name"]\n\tclean = {_marker_program(tmp_path, marker)}\n')
    (repo_dir / ".git" / "info" / "attributes").write_text("* filter=odd=name\n")
    (repo_dir / "a.txt").write_text("two\n")
    with pytest.raises(ValueError, match="can't safely switch off"):
        _full_diff_over_rpc(repo_dir)
    assert not marker.exists()


def test_a_new_repository_baseline_never_runs_global_programs(tmp_path, monkeypatch):
    import git as gitmodule
    from andromity.core.git_ops import ensure_git_tracking

    marker = tmp_path / "global-ran"
    global_config = tmp_path / "global.gitconfig"
    attributes = tmp_path / "global.attributes"
    attributes.write_text("* filter=gtrap\n")
    global_config.write_text("")
    for key, value in (("filter.gtrap.clean", _marker_program(tmp_path, marker)),
                       ("core.attributesFile", attributes.as_posix()),
                       ("user.email", "t@example.com"), ("user.name", "t")):
        _git(tmp_path, "config", "--file", str(global_config), key, value)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    probe = tmp_path / "probe"
    probe.mkdir()
    _git(probe, "init", "-q")
    (probe / "a.txt").write_text("hello\n")
    _git(probe, "add", "-A", check=False)
    assert marker.exists(), "plain git add must fire the global filter, otherwise this test proves nothing"
    marker.unlink()

    class NoParentRepository(gitmodule.Repo):
        def __new__(cls, *args, **kwargs):
            if kwargs.get("search_parent_directories"):
                raise gitmodule.InvalidGitRepositoryError("a folder with no repository above it")
            return super().__new__(cls)

    monkeypatch.setattr(gitmodule, "Repo", NoParentRepository)
    project = tmp_path / "fresh-project"
    project.mkdir()
    (project / "a.txt").write_text("hello\n")
    repo, created = ensure_git_tracking(project)
    assert created and repo.head.is_valid()
    assert not marker.exists()


def test_submodule_filters_never_run(repo_dir, tmp_path):
    from andromity.core.git_ops import status_entries

    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "-q")
    _git(upstream, "config", "user.email", "t@example.com")
    _git(upstream, "config", "user.name", "t")
    (upstream / "inner.txt").write_bytes(b"inner\n")
    _git(upstream, "add", "-A")
    _git(upstream, "commit", "-qm", "inner")
    _git(repo_dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream.as_posix(), "sub")
    _git(repo_dir, "commit", "-qm", "add sub")

    marker = tmp_path / "submodule-ran"
    sub_git = Path(_git(repo_dir / "sub", "rev-parse", "--absolute-git-dir").stdout.strip())
    _git(repo_dir / "sub", "config", "filter.subtrap.clean", _marker_program(tmp_path, marker))
    (sub_git / "info").mkdir(exist_ok=True)
    (sub_git / "info" / "attributes").write_text("* filter=subtrap\n")
    (repo_dir / "sub" / "inner.txt").write_bytes(b"INNER\n")
    _git(repo_dir, "status", "--porcelain", check=False)
    if not marker.exists():
        pytest.skip("git status did not check the submodule here, so the test proves nothing")
    marker.unlink()

    repo = get_repo(repo_dir)
    status_entries(repo)
    (repo_dir / "a.txt").write_text("twelve\n")
    assert create_pre_edit_snapshot(repo_dir)
    assert not marker.exists()
