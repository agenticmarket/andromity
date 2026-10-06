from pathlib import Path

import pytest
from git import Repo

from andromity.core.git_ops import (
    create_pre_edit_snapshot, restore_snapshot, rollback_recorded_turns, status_entries,
)
from andromity.core.git_review import file_diff, numstat, show_file, revert_file


def immediate(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    finally:
        coroutine.close()
    raise AssertionError("Mocked RPC unexpectedly suspended")


@pytest.fixture
def repo(tmp_path):
    repository = Repo.init(tmp_path)
    with repository.config_writer() as writer:
        writer.set_value("user", "name", "Test")
        writer.set_value("user", "email", "test@example.com")
    (tmp_path / "file.txt").write_text("one\ntwo\n", encoding="utf-8")
    repository.index.add(["file.txt"])
    repository.index.commit("baseline")
    yield repository
    repository.close()


def test_head_preview_and_counts_include_staged_and_unstaged(repo):
    file = Path(repo.working_tree_dir) / "file.txt"
    file.write_text("staged\ntwo\n", encoding="utf-8")
    repo.index.add(["file.txt"])
    file.write_text("staged\nworking\n", encoding="utf-8")
    assert show_file(repo, "file.txt", "HEAD").splitlines() == ["one", "two"]
    assert "staged" in show_file(repo, "file.txt", "INDEX")
    diff = file_diff(repo, "file.txt")["diff"]
    assert "-one" in diff and "-two" in diff and "+working" in diff
    assert numstat(repo)["file.txt"] == {"additions": 2, "deletions": 2, "binary": False}


def test_zero_terminated_paths_handle_unicode_spaces_and_arrow(repo):
    root = Path(repo.working_tree_dir)
    name = "notes → café result.txt"
    (root / name).write_text("a\nb", encoding="utf-8")
    assert any(e["path"] == name and e["status"] == "U" for e in status_entries(repo))
    assert numstat(repo)[name]["additions"] == 2
    assert len(file_diff(repo, name)["diff"].split("\n+")) == 4


def test_snapshot_restore_preserves_head_index_and_unrelated_file(repo):
    root = Path(repo.working_tree_dir)
    file = root / "file.txt"
    file.write_text("user staging\n", encoding="utf-8")
    repo.index.add(["file.txt"])
    file.write_text("user working\n", encoding="utf-8")
    index_before = (Path(repo.git_dir) / "index").read_bytes()
    head_before = repo.head.commit.hexsha
    before = create_pre_edit_snapshot(repo)
    file.write_text("agent change\n", encoding="utf-8")
    after = create_pre_edit_snapshot(repo)
    (root / "later-notes.txt").write_text("keep me", encoding="utf-8")
    assert rollback_recorded_turns(repo, [{"snapshot_hash": before, "after_hash": after}])
    assert file.read_text() == "user working\n"
    assert (root / "later-notes.txt").read_text() == "keep me"
    assert (Path(repo.git_dir) / "index").read_bytes() == index_before
    assert repo.head.commit.hexsha == head_before


def test_rollback_refuses_later_edits_and_incomplete_checkpoint(repo):
    root = Path(repo.working_tree_dir)
    before = create_pre_edit_snapshot(repo)
    (root / "file.txt").write_text("agent change\n", encoding="utf-8")
    after = create_pre_edit_snapshot(repo)
    (root / "file.txt").write_text("user change afterwards\n", encoding="utf-8")
    assert not rollback_recorded_turns(repo, [{"snapshot_hash": before, "after_hash": after}])
    assert not rollback_recorded_turns(repo, [{"snapshot_hash": before}])
    assert (root / "file.txt").read_text() == "user change afterwards\n"


def test_rollback_deletes_only_recorded_new_files(repo):
    root = Path(repo.working_tree_dir)
    before = create_pre_edit_snapshot(repo)
    (root / "new.txt").write_text("agent", encoding="utf-8")
    after = create_pre_edit_snapshot(repo)
    (root / "unrelated.txt").write_text("user", encoding="utf-8")
    assert rollback_recorded_turns(repo, [{"snapshot_hash": before, "after_hash": after}])
    assert not (root / "new.txt").exists()
    assert (root / "unrelated.txt").exists()


def test_checkpoint_review_finds_changes_made_without_file_tools(repo):
    from andromity.core.git_ops import checkpoint_changed_files
    root = Path(repo.working_tree_dir)
    before = create_pre_edit_snapshot(repo)
    (root / "shell-created.txt").write_text("created outside file tools\n", encoding="utf-8")
    (root / "file.txt").unlink()
    after = create_pre_edit_snapshot(repo)
    assert set(checkpoint_changed_files(repo, {"snapshot_hash": before, "after_hash": after}, str(root))) == {"file.txt", "shell-created.txt"}


@pytest.mark.parametrize("path", ["../outside.txt", ".git/config", ".", ""])
def test_revert_rejects_traversal_metadata_and_directories(repo, path):
    with pytest.raises(ValueError):
        revert_file(repo, path)


def test_deleted_file_restores_and_new_staged_file_is_removed(repo):
    root = Path(repo.working_tree_dir)
    (root / "file.txt").unlink()
    assert any(e["status"] == "D" for e in status_entries(repo))
    assert revert_file(repo, "file.txt")["success"]
    assert (root / "file.txt").read_text() == "one\ntwo\n"
    (root / "staged.txt").write_text("new", encoding="utf-8")
    repo.index.add(["staged.txt"])
    assert revert_file(repo, "staged.txt")["action"] == "deleted"
    assert not (root / "staged.txt").exists()
    assert "staged.txt" not in repo.git.ls_files()


def test_binary_and_empty_files_have_notices_not_fake_diff_lines(repo):
    root = Path(repo.working_tree_dir)
    (root / "binary").write_bytes(b"\0hello")
    (root / "empty").write_bytes(b"")
    assert "Binary" in file_diff(repo, "binary")["notice"]
    assert numstat(repo)["binary"]["binary"]
    assert file_diff(repo, "empty")["notice"] == "Empty new file."
    assert numstat(repo)["empty"]["additions"] == 0


def test_rpc_undo_preserves_conversation_on_conflict_and_restores_recorded_turn(repo, monkeypatch):
    from andromity.config import config
    from andromity.core.session import Session
    from andromity.server.rpc_handler import JsonRpcHandler

    root = Path(repo.working_tree_dir)
    session = Session(project_path=str(root))
    handler = JsonRpcHandler()
    handler._active_sessions[session.id] = session
    before = create_pre_edit_snapshot(repo)
    session.add_message("user", "Edit file")
    (root / "file.txt").write_text("agent\n", encoding="utf-8")
    session.add_message("assistant", "Done")
    after = create_pre_edit_snapshot(repo)
    session.undo_stack = [{"snapshot_hash": before, "after_hash": after, "turn_index": 0}]
    monkeypatch.setattr(config, "is_trusted", lambda path: True)

    async def in_thread(function, *args):
        return function(*args)

    monkeypatch.setattr("andromity.server.rpc_handler.asyncio.to_thread", in_thread)
    monkeypatch.setattr("andromity.core.git_ops.run_restoration", in_thread)
    (root / "file.txt").write_text("later user edit\n", encoding="utf-8")
    result = immediate(handler.rpc_session_undo({"session_id": session.id}))
    assert result["success"] is False
    assert len(session.messages) == 2 and len(session.undo_stack) == 1
    (root / "file.txt").write_text("agent\n", encoding="utf-8")
    result = immediate(handler.rpc_session_undo({"session_id": session.id}))
    assert result["success"] is True
    assert session.messages == [] and session.undo_stack == []
    assert (root / "file.txt").read_text() == "one\ntwo\n"


def test_rpc_revert_blocks_untrusted_workspaces_and_active_runs(repo, monkeypatch):
    from types import SimpleNamespace
    from andromity.config import config
    from andromity.server.rpc_handler import JsonRpcHandler

    root = str(repo.working_tree_dir)
    handler = JsonRpcHandler()
    monkeypatch.setattr(config, "is_trusted", lambda path: False)
    with pytest.raises(ValueError, match="Trust"):
        immediate(handler.rpc_git_revert_file({"project_path": root, "path": "file.txt"}))
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    handler._active_sessions["another"] = SimpleNamespace(project_path=root)
    handler._running_tasks["another"] = SimpleNamespace(done=lambda: False)
    with pytest.raises(ValueError, match="finish before reverting"):
        immediate(handler.rpc_git_revert_file({"project_path": root, "path": "file.txt"}))
    handler._running_tasks.clear()
    handler._git_mutating_roots.add(str(Path(root).resolve()))
    with pytest.raises(ValueError, match="restoration is in progress"):
        immediate(handler.rpc_git_revert_file({"project_path": root, "path": "file.txt"}))
    handler._active_sessions["new"] = SimpleNamespace(id="new", project_path=root)
    with pytest.raises(ValueError, match="restoration to finish"):
        immediate(handler.rpc_agent_prompt({"session_id": "new", "prompt": "Start"}))


def test_subfolder_checkpoint_does_not_capture_outer_worktree_changes(repo):
    root = Path(repo.working_tree_dir)
    workspace = root / "package"
    workspace.mkdir()
    (workspace / "code.txt").write_text("baseline\n", encoding="utf-8")
    repo.index.add(["package/code.txt"])
    repo.index.commit("package")
    (root / "file.txt").write_text("outer user edit\n", encoding="utf-8")
    before = create_pre_edit_snapshot(workspace)
    (workspace / "code.txt").write_text("agent\n", encoding="utf-8")
    after = create_pre_edit_snapshot(workspace)
    assert rollback_recorded_turns(repo, [{"snapshot_hash": before, "after_hash": after}], str(workspace))
    assert (workspace / "code.txt").read_text() == "baseline\n"
    assert (root / "file.txt").read_text() == "outer user edit\n"


def test_revert_treats_brackets_as_filename_not_git_pattern(repo):
    root = Path(repo.working_tree_dir)
    for name in ("file[1].txt", "file1.txt"):
        (root / name).write_text("baseline\n", encoding="utf-8")
    repo.index.add(["file[1].txt", "file1.txt"])
    repo.index.commit("literal paths")
    for name in ("file[1].txt", "file1.txt"):
        (root / name).write_text("edited\n", encoding="utf-8")
    assert revert_file(repo, "file[1].txt")["success"]
    assert (root / "file[1].txt").read_text() == "baseline\n"
    assert (root / "file1.txt").read_text() == "edited\n"


def test_unborn_repository_uses_empty_head_not_staged_index(tmp_path):
    repository = Repo.init(tmp_path)
    try:
        file = tmp_path / "new.txt"
        file.write_text("staged\n", encoding="utf-8")
        repository.index.add(["new.txt"])
        file.write_text("working\n", encoding="utf-8")
        assert show_file(repository, "new.txt", "HEAD") == ""
        assert "staged" in show_file(repository, "new.txt", "INDEX")
        assert "+working" in file_diff(repository, "new.txt")["diff"]
        assert numstat(repository)["new.txt"]["additions"] == 1
    finally:
        repository.close()


def test_cancelled_restoration_waits_for_worker_completion(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from andromity.core.git_ops import run_restoration

    complete = False
    calls = 0
    worker = SimpleNamespace(done=lambda: complete, cancelled=lambda: False, exception=lambda: None)

    def start(coroutine):
        coroutine.close()
        return worker

    async def shield(task):
        nonlocal calls, complete
        calls += 1
        if calls == 1:
            raise asyncio.CancelledError
        complete = True
        return True

    monkeypatch.setattr(asyncio, "create_task", start)
    monkeypatch.setattr(asyncio, "shield", shield)
    with pytest.raises(asyncio.CancelledError):
        immediate(run_restoration(lambda: True))
    assert complete and calls == 2
