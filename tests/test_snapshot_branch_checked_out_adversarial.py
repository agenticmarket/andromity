"""Independent adversarial tests: working while `andromity-snapshots` (the undo-snapshot branch) is checked out.

The checked-out branch must never move, the user's index and work must be untouched, undo must restore from the
snapshots taken there (also after switching away), receipts must still seal, and nothing may switch branches.
Every repository here is a fresh `git init` under pytest's tmp_path; the user's git config is ignored.
"""
import hashlib
import subprocess
from pathlib import Path

import pytest

from andromity.core.git_ops import (
    CHECKED_OUT_SNAPSHOT_REF, SNAPSHOT_BRANCH, create_pre_edit_snapshot, ensure_git_tracking, get_repo,
    list_snapshots, rollback_recorded_turns,
)
from andromity.core.receipt import build_receipt, close_turn_record, seal_receipt, start_turn_record
from andromity.core.session import Session

BRANCH_REF = f"refs/heads/{SNAPSHOT_BRANCH}"


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=60)
    if check and result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


def rev(cwd, ref):
    return git(cwd, "rev-parse", "-q", "--verify", ref, check=False) or None


def index_digest(cwd):
    index = Path(git(cwd, "rev-parse", "--git-path", "index"))
    path = index if index.is_absolute() else Path(cwd) / index
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def head_reflog(cwd):
    return git(cwd, "reflog", "show", "--format=%gs", "HEAD", check=False).splitlines()


@pytest.fixture
def project(tmp_path, monkeypatch):
    config = tmp_path / "gitconfig"
    config.write_text("[user]\n\tname = Ada\n\temail = ada@example.invalid\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(config))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    root = tmp_path / "proj"
    (root / "orders").mkdir(parents=True)
    git(root, "init", "-q", "-b", "main")
    (root / "orders" / "totals.py").write_bytes(b"def total(x):\n    return x\n")
    (root / "README.md").write_bytes(b"# orders\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "initial")
    return root


def on_snapshot_branch(root):
    """The founder's state: an earlier snapshot made the branch, then the branch got checked out and worked on."""
    assert create_pre_edit_snapshot(root)
    git(root, "checkout", "-q", SNAPSHOT_BRANCH)
    (root / "README.md").write_bytes(b"# orders\nuser's own uncommitted work\n")
    (root / "staged.txt").write_bytes(b"staged by the user\n")
    git(root, "add", "staged.txt")


def run_turn(session, root, edit):
    p = Path(root)
    ensure_git_tracking(p)
    record = start_turn_record(session, create_pre_edit_snapshot(p))
    session.add_message("user", "make a change")
    edit()
    session.add_message("assistant", "Done.")
    record.update(close_turn_record(session))
    record["after_hash"] = create_pre_edit_snapshot(p)
    session.save()
    return record


def test_checked_out_snapshot_branch_never_moves_and_index_and_work_are_untouched(project):
    on_snapshot_branch(project)
    tip, index, status, reflog = rev(project, BRANCH_REF), index_digest(project), git(project, "status", "--porcelain"), head_reflog(project)
    hashes = [create_pre_edit_snapshot(project) for _ in range(3)]
    assert all(hashes)
    assert rev(project, BRANCH_REF) == tip, "the checked-out branch moved"
    assert git(project, "symbolic-ref", "HEAD") == BRANCH_REF
    assert index_digest(project) == index, "the user's staging area changed"
    assert git(project, "status", "--porcelain") == status
    assert head_reflog(project) == reflog, "something switched or moved HEAD"
    assert rev(project, CHECKED_OUT_SNAPSHOT_REF) == hashes[-1]
    assert git(project, "rev-parse", f"{hashes[0]}^") == tip
    assert git(project, "show", f"{hashes[0]}:README.md").endswith("user's own uncommitted work"), "the snapshot holds the work"
    assert [s["hash"] for s in list_snapshots(get_repo(project))][:3] == list(reversed(hashes))


def test_turn_on_the_branch_seals_its_receipt_and_undo_restores_without_touching_the_branch(project):
    on_snapshot_branch(project)
    session = Session(name="t", project_path=str(project))
    tip, index = rev(project, BRANCH_REF), index_digest(project)
    target = project / "orders" / "totals.py"
    record = run_turn(session, project, lambda: target.write_bytes(b"def total(x):\n    return round(x, 2)\n"))
    receipt = seal_receipt(session, record)
    assert receipt is not None, "no receipt while on the snapshot branch"
    assert [f["path"] for f in receipt["files_changed"]] == ["orders/totals.py"]
    assert record.get("receipt_hash")
    assert build_receipt(session, record["turn_index"])["sealed"]["matches"] is True
    assert rev(project, BRANCH_REF) == tip
    assert rollback_recorded_turns(get_repo(project), session.turn_records_from(0), str(project)) is True
    assert target.read_bytes() == b"def total(x):\n    return x\n"
    assert (project / "README.md").read_bytes().endswith(b"user's own uncommitted work\n"), "undo touched a file the turn didn't change"
    assert rev(project, BRANCH_REF) == tip
    assert git(project, "symbolic-ref", "HEAD") == BRANCH_REF
    assert index_digest(project) == index


def test_undo_of_a_turn_made_on_the_branch_still_works_after_switching_away(project):
    on_snapshot_branch(project)
    session = Session(name="t", project_path=str(project))
    record = run_turn(session, project, lambda: (project / "new_module.py").write_bytes(b"x = 1\n"))
    git(project, "reset", "-q", "--", "staged.txt")
    git(project, "checkout", "-q", "main")
    main_tip, branch_tip = rev(project, "refs/heads/main"), rev(project, BRANCH_REF)
    after_switch = create_pre_edit_snapshot(project)
    assert rev(project, BRANCH_REF) == after_switch, "off the branch, snapshots go back to the snapshot branch"
    assert rev(project, "refs/heads/main") == main_tip
    assert git(project, "rev-parse", f"{after_switch}^") == branch_tip
    assert rollback_recorded_turns(get_repo(project), [record], str(project)) is True
    assert not (project / "new_module.py").exists()
    assert git(project, "symbolic-ref", "HEAD") == "refs/heads/main"
    assert rev(project, "refs/heads/main") == main_tip


def test_detached_head_snapshots_normally_and_stays_detached(project):
    create_pre_edit_snapshot(project)
    git(project, "checkout", "-q", "--detach")
    head = rev(project, "HEAD")
    snap = create_pre_edit_snapshot(project)
    assert rev(project, BRANCH_REF) == snap
    assert rev(project, "HEAD") == head
    assert git(project, "symbolic-ref", "-q", "HEAD", check=False) == ""
    assert rev(project, CHECKED_OUT_SNAPSHOT_REF) is None


def test_detached_at_the_snapshot_branch_commit_is_not_treated_as_the_branch(project):
    create_pre_edit_snapshot(project)
    git(project, "checkout", "-q", "--detach", SNAPSHOT_BRANCH)
    head = rev(project, "HEAD")
    create_pre_edit_snapshot(project)
    assert rev(project, "HEAD") == head


@pytest.mark.parametrize("name", ["andromity-snapshots2", "andromity-snapshots-old", "my-andromity-snapshots"])
def test_lookalike_branch_names_are_not_moved(project, name):
    create_pre_edit_snapshot(project)
    git(project, "checkout", "-q", "-b", name)
    tip = rev(project, f"refs/heads/{name}")
    snap = create_pre_edit_snapshot(project)
    assert rev(project, f"refs/heads/{name}") == tip
    assert rev(project, BRANCH_REF) == snap
    assert git(project, "symbolic-ref", "HEAD") == f"refs/heads/{name}"


def test_a_differently_cased_branch_checked_out_never_moves(project):
    # On Windows and macOS loose refs are files on a case-insensitive file system, so refs/heads/andromity-snapshots
    # and refs/heads/Andromity-Snapshots are the same file.
    git(project, "checkout", "-q", "-b", "Andromity-Snapshots")
    (project / "work.txt").write_bytes(b"user work\n")
    git(project, "add", "work.txt")
    git(project, "commit", "-q", "-m", "user commit")
    tip = rev(project, "HEAD")
    create_pre_edit_snapshot(project)
    create_pre_edit_snapshot(project)
    assert rev(project, "HEAD") == tip, "the checked-out Andromity-Snapshots branch moved: user work was committed into a snapshot"
    assert git(project, "symbolic-ref", "HEAD") == "refs/heads/Andromity-Snapshots"


def test_the_snapshot_branch_checked_out_under_another_case_never_moves(project):
    # `git checkout Andromity-Snapshots` on a case-insensitive file system opens the existing loose ref file, and HEAD
    # then names refs/heads/Andromity-Snapshots: the same branch, so the founder's bug must not come back.
    create_pre_edit_snapshot(project)
    switched = subprocess.run(["git", "checkout", "-q", "Andromity-Snapshots"], cwd=project, capture_output=True, text=True)
    if switched.returncode != 0:
        pytest.skip("case-sensitive file system: Andromity-Snapshots is a different, missing branch")
    tip = rev(project, "HEAD")
    (project / "README.md").write_bytes(b"# orders\nuser work\n")
    create_pre_edit_snapshot(project)
    assert rev(project, "HEAD") == tip, "the checked-out snapshot branch moved (checked out as Andromity-Snapshots)"


def test_the_snapshot_branch_checked_out_in_another_worktree_never_moves(project, tmp_path):
    create_pre_edit_snapshot(project)
    other = tmp_path / "other-worktree"
    git(project, "worktree", "add", "-q", str(other), SNAPSHOT_BRANCH)
    tip = rev(other, "HEAD")
    (project / "README.md").write_bytes(b"# orders\nchanged in the main worktree\n")
    create_pre_edit_snapshot(project)
    assert rev(other, "HEAD") == tip, "the branch checked out in the other worktree moved under it"
    assert git(other, "status", "--porcelain") == "", "the other worktree now shows phantom changes"


def test_a_linked_worktree_on_the_branch_uses_the_private_ref(project, tmp_path):
    create_pre_edit_snapshot(project)
    git(project, "checkout", "-q", "-b", "elsewhere")
    other = tmp_path / "wt"
    git(project, "worktree", "add", "-q", str(other), SNAPSHOT_BRANCH)
    (other / "README.md").write_bytes(b"# orders\nedit in the linked worktree\n")
    tip = rev(other, "HEAD")
    snap = create_pre_edit_snapshot(other)
    assert snap
    assert rev(other, "HEAD") == tip
    assert rev(other, CHECKED_OUT_SNAPSHOT_REF) == snap
    assert [s["hash"] for s in list_snapshots(get_repo(other))][0] == snap
