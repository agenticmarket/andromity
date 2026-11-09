"""Independent adversarial tests for per-turn file stats (turn_file_stats / public_file_stats / receipt_turns) and
pull request provenance (pr_provenance.provenance and the pr.provenance RPC).

Every repository is a fresh `git init` under pytest's tmp_path with the user's git config ignored. Turns are made
with the engine's own snapshot and turn-record functions, the same way rpc_handler does at the end of a turn.
"""
import asyncio
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from andromity.config import config
from andromity.core import pr_provenance as prov_mod
from andromity.core.git_ops import create_pre_edit_snapshot, ensure_clean_project_andromity, ensure_git_tracking, get_repo
from andromity.core.pr_provenance import ProvenanceUnavailable, provenance
from andromity.core.receipt import close_turn_record, receipt_turns, start_turn_record
from andromity.core.session import Session
from andromity.core.turn_changes import public_file_stats, turn_file_stats
from andromity.server.rpc_handler import JsonRpcHandler


def git(cwd, *args, check=True, input=None):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=60, input=input)
    if check and result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


@pytest.fixture
def gitenv(tmp_path, monkeypatch):
    cfg = tmp_path / "gitconfig"
    cfg.write_text("[user]\n\tname = Ada\n\temail = ada@example.invalid\n[core]\n\tautocrlf = false\n\tsymlinks = true\n"
                   "[init]\n\tdefaultBranch = main\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    return cfg


@pytest.fixture
def repo_root(tmp_path, gitenv):
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    (root / "src" / "a.py").write_bytes(b"a1\na2\na3\n")
    (root / "src" / "b.py").write_bytes(b"b1\n")
    (root / "old.txt").write_bytes(b"keep me\nsame content\n")
    (root / "gone.txt").write_bytes(b"to delete\n")
    git(root, "init", "-q", "-b", "main")
    ensure_clean_project_andromity(str(root))  # the engine adds .andromity/ to .gitignore; part of the base
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    git(root, "checkout", "-q", "-b", "feature")
    config.set_trusted(str(root))
    return root


def new_session(project, name="chat"):
    return Session(name=name, project_path=str(project))


def run_turn(session, edit, project=None):
    """A turn the way the engine records one: snapshot, edit, close, after snapshot, file_stats."""
    p = Path(project or session.project_path)
    ensure_git_tracking(p)
    record = start_turn_record(session, create_pre_edit_snapshot(p))
    session.add_message("user", "change something")
    edit()
    session.add_message("assistant", "Done.")
    record.update(close_turn_record(session))
    record["after_hash"] = create_pre_edit_snapshot(p)
    assert record["after_hash"], "after snapshot failed"
    record["file_stats"] = turn_file_stats(get_repo(p), record, str(p))
    return record


def commit_all(root, message="work"):
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", message, "--allow-empty")


def rows_by_path(result):
    return {row["path"]: row for row in result["files"]}


# ── per-turn file stats ──────────────────────────────────────────────────────────────────────────────────────────

def test_turn_stats_are_the_turns_own_counts_for_new_modified_deleted_and_binary(repo_root):
    session = new_session(repo_root)
    (repo_root / "src" / "a.py").write_bytes(b"hand edit before the turn\n")  # not this turn's change

    def edit():
        (repo_root / "src" / "b.py").write_bytes(b"b1\nb2\nb3\n")
        (repo_root / "new.py").write_bytes(b"n1\nn2\n")
        (repo_root / "gone.txt").unlink()
        (repo_root / "img.bin").write_bytes(bytes(range(256)) * 4)

    record = run_turn(session, edit)
    stats = {row["path"]: row for row in record["file_stats"]}
    assert "src/a.py" not in stats, "a hand edit made before the turn was counted as the turn's"
    assert (stats["src/b.py"]["additions"], stats["src/b.py"]["deletions"], stats["src/b.py"]["status"]) == (2, 0, "M")
    assert (stats["new.py"]["additions"], stats["new.py"]["status"], stats["new.py"]["before_blob"]) == (2, "A", None)
    assert stats["gone.txt"]["status"] == "D" and stats["gone.txt"]["after_blob"] is None
    assert stats["img.bin"]["binary"] is True and stats["img.bin"]["additions"] is None
    public = public_file_stats(record["file_stats"])
    assert all(set(row) == {"path", "status", "additions", "deletions", "binary"} for row in public), "blob ids leak to the client"


def test_turn_stats_in_a_subfolder_workspace_are_relative_to_the_workspace_and_skip_outside_files(repo_root):
    project = repo_root / "src"
    session = new_session(project)

    def edit():
        (project / "a.py").write_bytes(b"a1\nchanged\na3\n")
        (repo_root / "old.txt").write_bytes(b"outside the workspace\n")

    record = run_turn(session, edit, project)
    assert [row["path"] for row in record["file_stats"]] == ["a.py"]


def test_turn_stats_keep_a_symlink_under_its_own_name(repo_root):
    # A symbolic link the turn creates is a change to the link's path, not to its target, and a link whose target is
    # outside the workspace is still a change inside it.
    session = new_session(repo_root)

    def edit():
        try:
            os.symlink("old.txt", repo_root / "alias.txt")
        except OSError:
            pytest.skip("symlinks unavailable")

    record = run_turn(session, edit)
    paths = [row["path"] for row in record["file_stats"]]
    assert paths == ["alias.txt"], f"the link was recorded as {paths}"


def test_turn_stats_keep_a_symlink_pointing_outside_a_subfolder_workspace(repo_root):
    project = repo_root / "src"
    session = new_session(project)

    def edit():
        try:
            os.symlink("../old.txt", project / "shared.txt")
        except OSError:
            pytest.skip("symlinks unavailable")

    record = run_turn(session, edit, project)
    assert [row["path"] for row in record["file_stats"]] == ["shared.txt"], "a link the turn made was dropped from its counts"


def test_turn_stats_with_crlf_and_autocrlf(repo_root):
    git(repo_root, "config", "core.autocrlf", "true")
    session = new_session(repo_root)
    record = run_turn(session, lambda: (repo_root / "win.txt").write_bytes(b"one\r\ntwo\r\nthree\r\n"))
    stats = {row["path"]: row for row in record["file_stats"]}
    assert stats["win.txt"]["additions"] == 3
    commit_all(repo_root)
    result = provenance(get_repo(repo_root), "main", [session])
    assert rows_by_path(result)["win.txt"]["coverage"] == "covered"


def test_receipt_turns_carry_each_turns_own_stats_and_none_for_old_records(repo_root):
    session = new_session(repo_root)
    first = run_turn(session, lambda: (repo_root / "src" / "b.py").write_bytes(b"b1\nb2\n"))
    second = run_turn(session, lambda: (repo_root / "src" / "b.py").write_bytes(b"b1\nb2\nb3\nb4\n"))
    old = run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"x\n"))
    del old["file_stats"]
    turns = {t["turn_index"]: t for t in receipt_turns(session)}
    assert turns[first["turn_index"]]["file_stats"] == [{"path": "src/b.py", "status": "M", "additions": 1, "deletions": 0, "binary": False}]
    assert turns[second["turn_index"]]["file_stats"][0]["additions"] == 2
    assert "file_stats" not in turns[old["turn_index"]]


# ── provenance: coverage ────────────────────────────────────────────────────────────────────────────────────────

def test_a_chain_across_turns_in_two_chats_is_covered(repo_root):
    one, two = new_session(repo_root, "one"), new_session(repo_root, "two")
    run_turn(one, lambda: (repo_root / "src" / "a.py").write_bytes(b"a1\nA2\na3\n"))
    run_turn(two, lambda: (repo_root / "src" / "a.py").write_bytes(b"a1\nA2\na3\na4\n"))
    commit_all(repo_root)
    result = provenance(get_repo(repo_root), "main", [two, one])
    row = rows_by_path(result)["src/a.py"]
    assert row["coverage"] == "covered"
    assert {(t["session_id"]) for t in row["turns"]} == {one.id, two.id}


def test_a_hand_edit_between_two_turns_is_not_covered(repo_root):
    session = new_session(repo_root)
    run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"a1\nA2\na3\n"))
    (repo_root / "src" / "a.py").write_bytes(b"a1\nA2\na3\nhand\n")
    run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"a1\nA2\na3\nhand\nturn\n"))
    commit_all(repo_root)
    row = rows_by_path(provenance(get_repo(repo_root), "main", [session]))["src/a.py"]
    assert row["coverage"] == "partial"


def test_a_hand_edit_after_the_last_turn_is_edited(repo_root):
    session = new_session(repo_root)
    run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"a1\nA2\na3\n"))
    (repo_root / "src" / "a.py").write_bytes(b"a1\nA2\na3\nby hand\n")
    commit_all(repo_root)
    row = rows_by_path(provenance(get_repo(repo_root), "main", [session]))["src/a.py"]
    assert row["coverage"] == "edited"


def test_a_turns_change_reverted_by_hand_is_not_in_the_pull_request(repo_root):
    session = new_session(repo_root)
    run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"turn\n"))
    (repo_root / "src" / "a.py").write_bytes(b"a1\na2\na3\n")
    (repo_root / "src" / "b.py").write_bytes(b"b by hand\n")
    commit_all(repo_root)
    result = provenance(get_repo(repo_root), "main", [session])
    assert set(rows_by_path(result)) == {"src/b.py"}
    assert result["totals"] == {"files": 1, "covered": 0, "partial": 0, "edited": 0}
    assert result["turns"] == []


def test_deleted_renamed_and_binary_files_made_by_a_turn_are_covered(repo_root):
    session = new_session(repo_root)

    def edit():
        (repo_root / "gone.txt").unlink()
        (repo_root / "old.txt").rename(repo_root / "renamed.txt")
        (repo_root / "img.bin").write_bytes(bytes(range(256)) * 4)

    run_turn(session, edit)
    commit_all(repo_root)
    rows = rows_by_path(provenance(get_repo(repo_root), "main", [session]))
    assert rows["gone.txt"]["coverage"] == "covered"
    assert rows["renamed.txt"]["old_path"] == "old.txt" and rows["renamed.txt"]["coverage"] == "covered"
    assert rows["img.bin"]["binary"] is True and rows["img.bin"]["coverage"] == "covered"


def test_a_valid_chain_is_found_when_a_newer_chat_left_the_same_contents_from_a_hand_edit(repo_root):
    # Chat one went base -> X. Later the file was edited by hand to H and chat two went H -> X (same contents).
    # The file as pushed (X) was produced from the base version by chat one's turn: there is an unbroken chain.
    one, two = new_session(repo_root, "one"), new_session(repo_root, "two")
    run_turn(one, lambda: (repo_root / "src" / "a.py").write_bytes(b"X\n"))
    (repo_root / "src" / "a.py").write_bytes(b"H by hand\n")
    run_turn(two, lambda: (repo_root / "src" / "a.py").write_bytes(b"X\n"))
    commit_all(repo_root)
    row = rows_by_path(provenance(get_repo(repo_root), "main", [two, one]))["src/a.py"]
    assert row["coverage"] == "covered", f"greedy newest-first matching gave {row['coverage']} though turn one made X from the base"


def test_an_undone_turn_takes_no_part(repo_root):
    session = new_session(repo_root)
    record = run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"turn\n"))
    session.undo_stack.remove(record)
    commit_all(repo_root)
    row = rows_by_path(provenance(get_repo(repo_root), "main", [session]))["src/a.py"]
    assert row["coverage"] == "none" and row["turns"] == []


def test_a_turn_that_changed_more_than_300_files_covers_all_of_them(repo_root):
    session = new_session(repo_root)

    def edit():
        bulk = repo_root / "bulk"
        bulk.mkdir()
        for i in range(310):
            (bulk / f"f{i:03}.txt").write_bytes(f"{i}\n".encode())

    run_turn(session, edit)
    commit_all(repo_root)
    result = provenance(get_repo(repo_root), "main", [session])
    assert result["totals"]["files"] == 310
    assert result["totals"]["covered"] == 310, f"only {result['totals']['covered']} of 310 files one turn made are covered"


def test_records_without_file_stats_are_backfilled_and_gone_snapshots_skipped(repo_root):
    session = new_session(repo_root)
    record = run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"turn\n"))
    del record["file_stats"]
    session.undo_stack.append({"turn_index": 99, "snapshot_hash": "1" * 40, "after_hash": "2" * 40, "turn_key": "k"})
    commit_all(repo_root)
    row = rows_by_path(provenance(get_repo(repo_root), "main", [session]))["src/a.py"]
    assert row["coverage"] == "covered"


def test_hostile_records_are_ignored(repo_root):
    session = new_session(repo_root)
    run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"turn\n"))
    session.undo_stack += [
        "junk", {"turn_index": True, "snapshot_hash": "1" * 40, "after_hash": "2" * 40},
        {"turn_index": 5, "snapshot_hash": "1" * 40, "after_hash": "2" * 40, "file_stats": [None, 3, {"path": 7}, {"path": "../../etc/passwd"}]},
    ]
    commit_all(repo_root)
    result = provenance(get_repo(repo_root), "main", [session])
    assert rows_by_path(result)["src/a.py"]["coverage"] == "covered"


def test_a_session_in_a_subfolder_workspace_matches_repository_paths(repo_root):
    project = repo_root / "src"
    session = new_session(project)
    run_turn(session, lambda: (project / "a.py").write_bytes(b"sub\n"), project)
    commit_all(repo_root)
    row = rows_by_path(provenance(get_repo(repo_root), "main", [session]))["src/a.py"]
    assert row["coverage"] == "covered"


# ── provenance: listing the pull request's files ────────────────────────────────────────────────────────────────

def _commit_tree_with(root, path, content):
    """Adds one file to HEAD through the index only (names Windows can't hold on disk)."""
    blob = git(root, "hash-object", "-w", "--stdin", input=content)
    git(root, "-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", f"100644,{blob},{path}")
    git(root, "commit", "-q", "-m", "plumbing")
    return blob


def test_line_counts_of_a_file_whose_name_holds_a_tab(repo_root):
    _commit_tree_with(repo_root, "notes\tdraft.txt", "one\ntwo\n")
    rows = rows_by_path(provenance(get_repo(repo_root), "main", []))
    row = rows["notes\tdraft.txt"]
    assert (row["additions"], row["deletions"], row["binary"]) == (2, 0, False), f"a text file was reported as {row}"


def test_exactly_max_files_is_not_reported_as_truncated(repo_root, monkeypatch):
    monkeypatch.setattr(prov_mod, "MAX_FILES", 3)
    for name in ("x1", "x2", "x3"):
        (repo_root / name).write_bytes(b"x\n")
    commit_all(repo_root)
    result = provenance(get_repo(repo_root), "main", [])
    assert len(result["files"]) == 3
    assert result["truncated"] is False, "a list that wasn't cut says it stops at the limit"


@pytest.mark.parametrize("ref", ["--upload-pack=calc", "-main", "main..HEAD", "main...HEAD", "ma in", "main\n", "", "main@{0}",
                                 "HEAD~1", "main^", ":/text", "x" * 300, None, 7])
def test_bad_base_refs_are_refused(repo_root, ref):
    with pytest.raises(ProvenanceUnavailable):
        provenance(get_repo(repo_root), ref, [])


@pytest.mark.parametrize("branch", ["release+1", "user@feature", "fix#12"])
def test_valid_branch_names_are_accepted(repo_root, branch):
    git(repo_root, "branch", branch, "main")
    try:
        provenance(get_repo(repo_root), branch, [])
    except ProvenanceUnavailable as exc:
        pytest.fail(f"{branch!r} is a valid git branch name but was refused: {exc}")


def test_unrelated_history_has_no_merge_base(repo_root):
    git(repo_root, "checkout", "-q", "--orphan", "lonely")
    git(repo_root, "commit", "-q", "-m", "orphan", "--allow-empty")
    with pytest.raises(ProvenanceUnavailable):
        provenance(get_repo(repo_root), "main", [])


def test_unknown_base_branch(repo_root):
    with pytest.raises(ProvenanceUnavailable):
        provenance(get_repo(repo_root), "does-not-exist", [])


# ── the RPC ─────────────────────────────────────────────────────────────────────────────────────────────────────

def _rpc(handler, **params):
    return asyncio.run(handler.rpc_pr_provenance(params))


def test_rpc_refuses_an_untrusted_folder(tmp_path, gitenv):
    root = tmp_path / "untrusted"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    (root / "a").write_text("a")
    commit_all(root)
    result = _rpc(JsonRpcHandler(), project_path=str(root), base_ref="main")
    assert result["success"] is False


def test_rpc_uses_stored_chats_of_this_folder_only(repo_root, tmp_path):
    session = new_session(repo_root, "here")
    run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"turn here\n"))
    session.save()
    # A clone of the same repository in another folder: identical blobs, different project.
    other = tmp_path / "clone"
    git(tmp_path, "clone", "-q", str(repo_root), str(other))
    config.set_trusted(str(other))
    elsewhere = new_session(other, "elsewhere")
    run_turn(elsewhere, lambda: (other / "src" / "b.py").write_bytes(b"turn elsewhere\n"))
    elsewhere.save()
    (repo_root / "src" / "b.py").write_bytes(b"turn elsewhere\n")
    commit_all(repo_root)
    handler = JsonRpcHandler()
    result = _rpc(handler, project_path=str(repo_root), base_ref="main")
    assert result["success"] is True, result
    rows = rows_by_path(result)
    assert rows["src/a.py"]["coverage"] == "covered"
    assert rows["src/b.py"]["coverage"] == "none", "a chat from another folder was used"


def test_rpc_prefers_the_live_session_over_its_stored_copy(repo_root):
    session = new_session(repo_root, "live")
    session.save()
    run_turn(session, lambda: (repo_root / "src" / "a.py").write_bytes(b"live turn\n"))  # not saved yet
    commit_all(repo_root)
    handler = JsonRpcHandler()
    handler._active_sessions[session.id] = session
    result = _rpc(handler, project_path=str(repo_root), base_ref="main")
    assert rows_by_path(result)["src/a.py"]["coverage"] == "covered"
