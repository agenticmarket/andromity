"""Independent adversarial tests for Changes Review's Turn mode in the engine: git.turn_changes / git.turn_file_diff.

What one turn changed must come from its own before/after snapshots (not the whole uncommitted diff), each file's
"now" must be right after hand edits, later turns, commits, amends and branch switches, the user's index and refs must
be untouched, and the diff RPC must only serve that turn's files for trusted folders. Every repository is a fresh
`git init` under pytest's tmp_path with the user's git config ignored.
"""
import asyncio
import hashlib
import subprocess
from pathlib import Path

import pytest

from andromity.config import config
from andromity.core.git_ops import create_pre_edit_snapshot, ensure_git_tracking, get_repo
from andromity.core.git_review import revert_file
from andromity.core.receipt import close_turn_record, start_turn_record
from andromity.core.session import Session
from andromity.core.turn_changes import TurnChangesUnavailable, turn_changes, turn_file_diff, turn_revert_file
from andromity.server.rpc_handler import JsonRpcHandler


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=60)
    if check and result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


def index_digest(root):
    path = Path(root) / ".git" / "index"
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def refs(root):
    return git(root, "for-each-ref", "--format=%(refname) %(objectname)")


@pytest.fixture
def project(tmp_path, monkeypatch):
    cfg = tmp_path / "gitconfig"
    cfg.write_text("[user]\n\tname = Ada\n\temail = ada@example.invalid\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    (root / "src" / "a.py").write_bytes(b"line1\nline2\nline3\nline4\nline5\n")
    (root / "src" / "b.py").write_bytes(b"b\n")
    (root / "docs").mkdir()
    (root / "docs" / "guide.md").write_bytes(b"guide\n")
    (root / ".gitignore").write_bytes(b"*.log\n")
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "initial")
    config.set_trusted(str(root))
    return root


def run_turn(session, root, edit):
    p = Path(root)
    ensure_git_tracking(p)
    record = start_turn_record(session, create_pre_edit_snapshot(p))
    session.add_message("user", "change something")
    edit()
    session.add_message("assistant", "Done.")
    record.update(close_turn_record(session))
    record["after_hash"] = create_pre_edit_snapshot(p)
    session.save()
    return record


def rewrite(path, old, new):
    path.write_bytes(path.read_bytes().replace(old, new))


def files_of(session, index, root):
    return {f["path"]: f for f in turn_changes(session, index, get_repo(root))["files"]}


def test_only_the_turns_own_lines_and_files_appear_and_now_tracks_later_edits(project):
    session = Session(name="t", project_path=str(project))
    a = project / "src" / "a.py"
    rewrite(a, b"line1", b"line1 HAND EDIT BEFORE")
    (project / "docs" / "guide.md").write_bytes(b"guide edited by hand\n")
    run_turn(session, project, lambda: rewrite(a, b"line4", b"line4 TURN EDIT"))
    files = files_of(session, 0, project)
    assert list(files) == ["src/a.py"], "files the turn didn't touch are listed"
    assert files["src/a.py"]["now"] == "uncommitted"
    assert (files["src/a.py"]["additions"], files["src/a.py"]["deletions"]) == (1, 1)
    diff = turn_file_diff(session, 0, "src/a.py", get_repo(project))["diff"]
    assert "+line4 TURN EDIT" in diff and "HAND EDIT BEFORE" not in diff.split("@@", 2)[-1].replace(" line1 HAND EDIT BEFORE", "")
    rewrite(a, b"line5", b"line5 HAND EDIT AFTER")
    assert files_of(session, 0, project)["src/a.py"]["now"] == "changed"
    assert "HAND EDIT AFTER" not in turn_file_diff(session, 0, "src/a.py", get_repo(project))["diff"]


def test_commit_amend_and_branch_switch(project):
    session = Session(name="t", project_path=str(project))
    b = project / "src" / "b.py"
    run_turn(session, project, lambda: b.write_bytes(b"b turn\n"))
    git(project, "commit", "-qam", "turn work")
    assert files_of(session, 0, project)["src/b.py"]["now"] == "committed"
    git(project, "commit", "-q", "--amend", "-m", "reworded")
    assert files_of(session, 0, project)["src/b.py"]["now"] == "committed"
    b.write_bytes(b"b turn\nmore\n")
    git(project, "commit", "-q", "-a", "--amend", "--no-edit")
    assert files_of(session, 0, project)["src/b.py"]["now"] == "changed"
    git(project, "checkout", "-q", "-b", "other", "HEAD~1")
    assert files_of(session, 0, project)["src/b.py"]["now"] == "changed"
    assert "+b turn" in turn_file_diff(session, 0, "src/b.py", get_repo(project))["diff"], "the turn's diff outlives a branch switch"


def test_a_later_turn_on_the_same_file(project):
    session = Session(name="t", project_path=str(project))
    a = project / "src" / "a.py"
    run_turn(session, project, lambda: rewrite(a, b"line2", b"line2 TURN1"))
    run_turn(session, project, lambda: rewrite(a, b"line3", b"line3 TURN2"))
    assert files_of(session, 0, project)["src/a.py"]["now"] == "changed"
    assert files_of(session, 1, project)["src/a.py"]["now"] == "uncommitted"
    d1 = turn_file_diff(session, 0, "src/a.py", get_repo(project))["diff"]
    d2 = turn_file_diff(session, 1, "src/a.py", get_repo(project))["diff"]
    assert "+line2 TURN1" in d1 and "TURN2" not in d1
    assert "+line3 TURN2" in d2 and "+line2 TURN1" not in d2


def test_discarding_from_the_turn_view_keeps_work_from_before_the_turn(project):
    # Retargeted after e2d7a40: the Turn view's action is now "Undo turn change" (git.turn_revert_file), not All
    # mode's Discard (revert_file, which by design discards every change in the file).
    session = Session(name="t", project_path=str(project))
    a = project / "src" / "a.py"
    rewrite(a, b"line1", b"line1 MY UNCOMMITTED WORK")
    run_turn(session, project, lambda: rewrite(a, b"line4", b"line4 TURN EDIT"))
    assert files_of(session, 0, project)["src/a.py"]["now"] == "uncommitted"
    assert turn_revert_file(session, 0, "src/a.py", get_repo(project))["action"] == "restored"
    content = a.read_bytes()
    assert b"TURN EDIT" not in content
    assert b"MY UNCOMMITTED WORK" in content, "Discard in the Turn view threw away the user's own uncommitted work from before the turn"


def test_renames_deletes_binary_large_untracked_and_ignored(project):
    session = Session(name="t", project_path=str(project))

    def edit():
        (project / "src" / "b.py").rename(project / "src" / "b_renamed.py")
        (project / "docs" / "guide.md").unlink()
        (project / "logo.png").write_bytes(bytes(range(256)) * 4)
        (project / "big.txt").write_bytes(b"x" * 100 + b"\n" * 1 + (b"y" * 80 + b"\n") * 30_000)
        (project / "new.py").write_bytes(b"new\n")
        (project / "debug.log").write_bytes(b"ignored\n")

    run_turn(session, project, edit)
    files = files_of(session, 0, project)
    assert {p: f["status"] for p, f in files.items()} == {
        "src/b.py": "D", "src/b_renamed.py": "A", "docs/guide.md": "D", "logo.png": "A", "big.txt": "A", "new.py": "A"}
    assert files["logo.png"]["binary"] is True
    repo = get_repo(project)
    assert turn_file_diff(session, 0, "logo.png", repo)["notice"].startswith("Binary")
    big = turn_file_diff(session, 0, "big.txt", repo)
    assert big["diff"] == "" and "too large" in big["notice"]
    assert "-guide" in turn_file_diff(session, 0, "docs/guide.md", repo)["diff"]
    assert all(f["now"] == "uncommitted" for f in files.values())


def test_project_in_a_subfolder_shows_only_that_folder(project):
    sub = project / "src"
    session = Session(name="t", project_path=str(sub))
    config.set_trusted(str(sub))

    def edit():
        (sub / "a.py").write_bytes(b"changed\n")
        (project / "docs" / "guide.md").write_bytes(b"outside the project\n")

    run_turn(session, sub, edit)
    files = files_of(session, 0, project)
    assert list(files) == ["src/a.py"], "a file outside the project folder is listed"
    with pytest.raises(TurnChangesUnavailable):
        turn_file_diff(session, 0, "docs/guide.md", get_repo(project))


def test_crlf_files_show_only_the_changed_line(project):
    (project / "win.txt").write_bytes(b"one\r\ntwo\r\nthree\r\n")
    git(project, "add", "win.txt")
    git(project, "commit", "-qm", "crlf")
    session = Session(name="t", project_path=str(project))
    run_turn(session, project, lambda: (project / "win.txt").write_bytes(b"one\r\nTWO\r\nthree\r\n"))
    f = files_of(session, 0, project)["win.txt"]
    assert (f["additions"], f["deletions"]) == (1, 1)
    assert f["now"] == "uncommitted"


def test_reading_turn_changes_never_touches_the_index_refs_or_head(project):
    session = Session(name="t", project_path=str(project))
    run_turn(session, project, lambda: rewrite(project / "src" / "a.py", b"line2", b"line2 TURN"))
    (project / "src" / "b.py").write_bytes(b"staged by me\n")
    git(project, "add", "src/b.py")
    (project / "untracked.txt").write_bytes(b"u\n")
    before = (index_digest(project), refs(project), git(project, "status", "--porcelain"), git(project, "reflog", "--format=%gs", "HEAD"))
    repo = get_repo(project)
    for _ in range(3):
        turn_changes(session, 0, repo)
        turn_file_diff(session, 0, "src/a.py", repo)
    after = (index_digest(project), refs(project), git(project, "status", "--porcelain"), git(project, "reflog", "--format=%gs", "HEAD"))
    assert after == before
    assert not (project / ".git" / "index.lock").exists()


def test_the_diff_is_served_only_for_this_turns_files(project):
    session = Session(name="t", project_path=str(project))
    run_turn(session, project, lambda: rewrite(project / "src" / "a.py", b"line2", b"line2 T1"))
    run_turn(session, project, lambda: (project / "src" / "b.py").write_bytes(b"b T2\n"))
    repo = get_repo(project)
    for path in ["src/b.py", "../proj/src/a.py", "src/../src/a.py", str(project / "src" / "a.py"), "src/*.py", ":(glob)**", "src/a.py\0x",
                 "SRC/A.PY", "", "a" * 5000, 5, None]:
        with pytest.raises(TurnChangesUnavailable):
            turn_file_diff(session, 0, path, repo)
    for index in [7, -1]:
        with pytest.raises(TurnChangesUnavailable):
            turn_changes(session, index, repo)


@pytest.fixture
def handler_with(project, monkeypatch):
    handler = JsonRpcHandler()
    handler.notify = lambda *a, **k: None
    session = Session(name="t", project_path=str(project))
    run_turn(session, project, lambda: rewrite(project / "src" / "a.py", b"line2", b"line2 T1"))
    handler._active_sessions[session.id] = session
    return handler, session


@pytest.mark.asyncio
async def test_rpc_refuses_hostile_ids_indexes_and_untrusted_folders(handler_with, tmp_path):
    handler, session = handler_with
    ok = await handler.rpc_git_turn_changes({"session_id": session.id, "turn_index": 0})
    assert ok["success"] and [f["path"] for f in ok["files"]] == ["src/a.py"]
    for params in [{"session_id": "../../x", "turn_index": 0}, {"session_id": "", "turn_index": 0}, {"session_id": 5, "turn_index": 0},
                   {"session_id": session.id, "turn_index": True}, {"session_id": session.id, "turn_index": "0"},
                   {"session_id": session.id, "turn_index": -1}, {"session_id": session.id, "turn_index": 10 ** 30},
                   {"session_id": session.id}, {"session_id": "a" * 10_000, "turn_index": 0}]:
        result = await handler.rpc_git_turn_changes(params)
        assert result["success"] is False and isinstance(result["error"], str), params
        diff = await handler.rpc_git_turn_file_diff({**params, "path": "src/a.py"})
        assert diff["success"] is False and diff["diff"] == "", params
    untrusted = tmp_path / "untrusted"
    untrusted.mkdir()
    git(untrusted, "init", "-q", "-b", "main")
    other = Session(name="u", project_path=str(untrusted))
    other.undo_stack = list(session.undo_stack)
    handler._active_sessions[other.id] = other
    result = await handler.rpc_git_turn_file_diff({"session_id": other.id, "turn_index": 0, "path": "src/a.py"})
    assert result["success"] is False and "Trust" in result["notice"]


@pytest.mark.asyncio
async def test_rpc_serves_only_the_sessions_own_project_whatever_project_path_the_client_sends(handler_with, tmp_path):
    handler, session = handler_with
    result = await handler.rpc_git_turn_changes({"session_id": session.id, "turn_index": 0, "project_path": str(tmp_path / "elsewhere")})
    assert result["success"] and [f["path"] for f in result["files"]] == ["src/a.py"]


def test_an_undone_turn_says_so(project):
    session = Session(name="t", project_path=str(project))
    run_turn(session, project, lambda: rewrite(project / "src" / "a.py", b"line2", b"line2 T1"))
    session.rollback_to_turn(0)
    with pytest.raises(TurnChangesUnavailable, match="undone"):
        turn_changes(session, 0, get_repo(project))


# ── Attacks on turn_revert_file ("Undo turn change", commit e2d7a40) ──────────

def _undo(session, index, path, root):
    return turn_revert_file(session, index, path, get_repo(root))


def test_undo_refuses_after_a_later_edit_and_changes_nothing(project):
    session = Session(name="t", project_path=str(project))
    a = project / "src" / "a.py"
    run_turn(session, project, lambda: rewrite(a, b"line2", b"line2 TURN"))
    rewrite(a, b"line5", b"line5 LATER WORK")
    before = a.read_bytes()
    with pytest.raises(TurnChangesUnavailable, match="changed after the turn"):
        _undo(session, 0, "src/a.py", project)
    assert a.read_bytes() == before


def test_undo_of_an_earlier_turn_never_drops_a_later_turns_work(project):
    session = Session(name="t", project_path=str(project))
    a = project / "src" / "a.py"
    run_turn(session, project, lambda: rewrite(a, b"line2", b"line2 TURN1"))
    run_turn(session, project, lambda: rewrite(a, b"line3", b"line3 TURN2"))
    with pytest.raises(TurnChangesUnavailable):
        _undo(session, 0, "src/a.py", project)
    assert _undo(session, 1, "src/a.py", project)["action"] == "restored"
    assert b"TURN1" in a.read_bytes() and b"TURN2" not in a.read_bytes()


def test_undo_never_touches_the_index_refs_or_head(project):
    session = Session(name="t", project_path=str(project))
    a = project / "src" / "a.py"
    run_turn(session, project, lambda: rewrite(a, b"line2", b"line2 TURN"))
    git(project, "add", "src/a.py")
    (project / "src" / "b.py").write_bytes(b"staged other\n")
    git(project, "add", "src/b.py")
    snapshot = (index_digest(project), refs(project), git(project, "reflog", "--format=%gs", "HEAD"))
    _undo(session, 0, "src/a.py", project)
    assert (index_digest(project), refs(project), git(project, "reflog", "--format=%gs", "HEAD")) == snapshot
    assert git(project, "diff", "--cached", "--name-only").splitlines() == ["src/a.py", "src/b.py"], "the staged turn change was unstaged"
    assert b"TURN" not in a.read_bytes()


def test_undo_of_a_rename_and_a_delete_and_an_added_file(project):
    session = Session(name="t", project_path=str(project))

    def edit():
        (project / "src" / "b.py").rename(project / "src" / "b_new.py")
        (project / "docs" / "guide.md").unlink()
        (project / "src" / "added.py").write_bytes(b"new\n")

    run_turn(session, project, edit)
    assert _undo(session, 0, "src/b_new.py", project)["action"] == "removed"
    assert _undo(session, 0, "src/b.py", project)["action"] == "restored"
    assert (project / "src" / "b.py").read_bytes() == b"b\n"
    assert _undo(session, 0, "docs/guide.md", project)["action"] == "restored"
    assert _undo(session, 0, "src/added.py", project)["action"] == "removed"
    assert not (project / "src" / "added.py").exists()
    # .gitignore gets ".andromity/" from session storage, not from the undo.
    assert [line for line in git(project, "status", "--porcelain").splitlines() if not line.endswith(".gitignore")] == []


def test_a_deleted_file_recreated_by_the_user_is_not_overwritten(project):
    session = Session(name="t", project_path=str(project))
    guide = project / "docs" / "guide.md"
    run_turn(session, project, lambda: guide.unlink())
    guide.write_bytes(b"my new guide\n")
    with pytest.raises(TurnChangesUnavailable):
        _undo(session, 0, "docs/guide.md", project)
    assert guide.read_bytes() == b"my new guide\n"


def test_an_added_file_the_user_then_edited_or_replaced_with_a_folder_is_kept(project):
    session = Session(name="t", project_path=str(project))
    added = project / "src" / "added.py"
    run_turn(session, project, lambda: added.write_bytes(b"new\n"))
    added.write_bytes(b"new\nmine\n")
    with pytest.raises(TurnChangesUnavailable):
        _undo(session, 0, "src/added.py", project)
    added.unlink()
    added.mkdir()
    (added / "keep.txt").write_bytes(b"keep\n")
    with pytest.raises(TurnChangesUnavailable):
        _undo(session, 0, "src/added.py", project)
    assert (added / "keep.txt").exists()


def test_undo_with_autocrlf_matches_the_file_as_the_turn_left_it(project):
    git(project, "config", "core.autocrlf", "true")
    session = Session(name="t", project_path=str(project))
    a = project / "src" / "a.py"
    run_turn(session, project, lambda: a.write_bytes(b"line1\r\nline2 TURN\r\nline3\r\nline4\r\nline5\r\n"))
    assert _undo(session, 0, "src/a.py", project)["action"] == "restored"
    assert b"TURN" not in a.read_bytes()


def test_a_file_with_a_git_filter_is_refused(project):
    (project / ".gitattributes").write_bytes(b"*.secret filter=crypt\n")
    git(project, "config", "filter.crypt.clean", "cat")
    git(project, "config", "filter.crypt.smudge", "cat")
    git(project, "add", ".gitattributes")
    git(project, "commit", "-qm", "attrs")
    session = Session(name="t", project_path=str(project))
    run_turn(session, project, lambda: (project / "x.secret").write_bytes(b"turn\n"))
    if "x.secret" not in files_of(session, 0, project):
        pytest.skip("snapshots skip files with filters")
    with pytest.raises((TurnChangesUnavailable, ValueError)):
        _undo(session, 0, "x.secret", project)
    assert (project / "x.secret").exists()


def test_undo_paths_must_be_this_turns_files(project):
    session = Session(name="t", project_path=str(project))
    run_turn(session, project, lambda: rewrite(project / "src" / "a.py", b"line2", b"line2 TURN"))
    (project / "src" / "b.py").write_bytes(b"mine\n")
    for path in ["src/b.py", "src/../src/a.py", "./src/a.py", str(project / "src" / "a.py"), "SRC/A.PY", "src/*.py", ":(glob)**",
                 "src", "", None, 5, "src/a.py\0"]:
        with pytest.raises(TurnChangesUnavailable):
            _undo(session, 0, path, project)
    assert (project / "src" / "b.py").read_bytes() == b"mine\n"
    session.rollback_to_turn(0)
    with pytest.raises(TurnChangesUnavailable):
        _undo(session, 0, "src/a.py", project)


def test_undo_in_a_linked_worktree_acts_on_that_worktree_only(project, tmp_path):
    other = tmp_path / "wt"
    git(project, "worktree", "add", "-q", "-b", "wt", str(other))
    config.set_trusted(str(other))
    session = Session(name="t", project_path=str(other))
    run_turn(session, other, lambda: rewrite(other / "src" / "a.py", b"line2", b"line2 TURN"))
    main_before = (project / "src" / "a.py").read_bytes()
    assert _undo(session, 0, "src/a.py", other)["action"] == "restored"
    assert b"TURN" not in (other / "src" / "a.py").read_bytes()
    assert (project / "src" / "a.py").read_bytes() == main_before


@pytest.mark.asyncio
async def test_undo_rpc_refuses_during_a_running_turn_untrusted_and_hostile_input(handler_with, project):
    handler, session = handler_with
    blocker = asyncio.get_running_loop().create_future()
    other = Session(name="running", project_path=str(project))
    handler._active_sessions[other.id] = other
    handler._running_tasks[other.id] = asyncio.ensure_future(blocker)
    try:
        result = await handler.rpc_git_turn_revert_file({"session_id": session.id, "turn_index": 0, "path": "src/a.py"})
        assert result["success"] is False, "undid a file while another turn runs in the same repository"
        assert b"T1" in (project / "src" / "a.py").read_bytes()
    finally:
        blocker.cancel()
        handler._running_tasks.pop(other.id, None)
    for params in [{"session_id": "../x", "turn_index": 0, "path": "src/a.py"}, {"session_id": session.id, "turn_index": True, "path": "src/a.py"},
                   {"session_id": session.id, "turn_index": 0, "path": "../../etc/passwd"}, {"session_id": session.id, "turn_index": 0}]:
        result = await handler.rpc_git_turn_revert_file(params)
        assert result["success"] is False and isinstance(result["error"], str), params
    ok = await handler.rpc_git_turn_revert_file({"session_id": session.id, "turn_index": 0, "path": "src/a.py"})
    assert ok == {"success": True, "action": "restored", "path": "src/a.py"}
