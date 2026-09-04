"""Tests for Git operations and file diff utilities."""
import sys
import tempfile
from pathlib import Path

import pytest
from git import Repo

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from andromity.core.git_ops import get_repo, get_file_diff
from andromity.server.rpc_handler import JsonRpcHandler


def test_get_repo_invalid_path():
    # A path that doesn't exist can never be a repo.
    with tempfile.TemporaryDirectory() as tmpdir:
        missing = Path(tmpdir) / "does-not-exist"
        assert get_repo(missing) is None


def test_get_repo_enclosing_repo():
    """get_repo walks up to the enclosing repo, e.g. $HOME is a git repo or
    the project is a subfolder of a monorepo. A bare dir inside one must
    resolve to that enclosing repo, never crash or return a random repo."""
    with tempfile.TemporaryDirectory() as tmpdir:
        repo = get_repo(Path(tmpdir))
        if repo is not None:
            root = Path(repo.working_tree_dir).resolve()
            assert Path(tmpdir).resolve().is_relative_to(root)
            repo.close()


def test_get_repo_valid():
    with tempfile.TemporaryDirectory() as tmpdir:
        r = Repo.init(tmpdir)
        repo = get_repo(Path(tmpdir))
        assert repo is not None
        assert Path(repo.working_tree_dir) == Path(tmpdir)
        repo.close()
        r.close()


def test_get_file_diff_untracked():
    with tempfile.TemporaryDirectory() as tmpdir:
        r = Repo.init(tmpdir)
        test_file = Path(tmpdir) / "hello.py"
        test_file.write_text("print('hello world')\n", encoding="utf-8")
        diff = get_file_diff(r, "hello.py")
        assert "+print('hello world')" in diff
        r.close()


def test_get_file_diff_modified():
    with tempfile.TemporaryDirectory() as tmpdir:
        r = Repo.init(tmpdir)
        with r.config_writer() as writer:
            writer.set_value("user", "name", "Test")
            writer.set_value("user", "email", "test@example.com")
        
        test_file = Path(tmpdir) / "app.py"
        test_file.write_text("x = 1\n", encoding="utf-8")
        r.index.add(["app.py"])
        r.index.commit("Initial commit")

        # Now modify
        test_file.write_text("x = 2\n", encoding="utf-8")
        diff = get_file_diff(r, "app.py")
        assert "-x = 1" in diff
        assert "+x = 2" in diff
        r.close()


def test_snapshot_restore_deletes_untracked_files():
    """Verify that restoring a snapshot removes files created during the turn."""
    from andromity.core.git_ops import create_pre_edit_snapshot, restore_snapshot
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        repo = Repo.init(tmp)
        with repo.config_writer() as writer:
            writer.set_value("user", "name", "Test")
            writer.set_value("user", "email", "test@example.com")
        f1 = tmp / "f1.txt"
        f1.write_text("initial f1", encoding="utf-8")
        repo.git.add("-A")
        repo.index.commit("initial commit")

        # Snapshot before turn
        snap = create_pre_edit_snapshot(repo)
        assert snap is not None

        # Turn creations and modifications
        f1.write_text("modified f1", encoding="utf-8")
        j1 = tmp / "joke1.txt"
        j1.write_text("new untracked file", encoding="utf-8")
        sub = tmp / "sub"
        sub.mkdir()
        j2 = sub / "joke2.txt"
        j2.write_text("nested untracked file", encoding="utf-8")

        assert j1.exists()
        assert j2.exists()

        # Restore snapshot
        ok = restore_snapshot(repo, snap)
        assert ok is True
        assert f1.read_text(encoding="utf-8") == "initial f1"
        assert not j1.exists()
        assert not j2.exists()
        assert not sub.exists()

        repo.close()


def test_user_untracked_file_preserved_on_rollback():
    """Verify that untracked files created by the user BEFORE the turn are preserved on rollback."""
    from andromity.core.git_ops import create_pre_edit_snapshot, restore_snapshot
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        repo = Repo.init(tmp)
        with repo.config_writer() as writer:
            writer.set_value("user", "name", "Test")
            writer.set_value("user", "email", "test@example.com")
        f1 = tmp / "tracked.txt"
        f1.write_text("tracked baseline", encoding="utf-8")
        repo.git.add("-A")
        repo.index.commit("initial commit")

        # User manually creates an untracked file BEFORE interacting with AI
        user_notes = tmp / "my_notes.txt"
        user_notes.write_text("do not delete my notes", encoding="utf-8")

        # AI turn starts: snapshot is taken
        snap = create_pre_edit_snapshot(repo)
        assert snap is not None

        # AI creates a new file during the turn
        ai_joke = tmp / "joke1.txt"
        ai_joke.write_text("ai generated content", encoding="utf-8")

        # Rollback turn
        ok = restore_snapshot(repo, snap)
        assert ok is True

        # The user's untracked file must remain completely safe and intact
        assert user_notes.exists(), "User untracked file was deleted!"
        assert user_notes.read_text(encoding="utf-8") == "do not delete my notes"

        # The AI's file must be removed
        assert not ai_joke.exists(), "AI generated file should have been deleted"

        repo.close()


@pytest.mark.asyncio
async def test_rpc_staged_file_diff_and_show():
    """Verify that when a user stages a new file without committing to HEAD,
    rpc_git_show_file returns the staged index content and diff compares against it."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        repo = Repo.init(tmp)
        with repo.config_writer() as writer:
            writer.set_value("user", "name", "Test")
            writer.set_value("user", "email", "test@example.com")

        # User creates a new file and stages it
        sample = tmp / "sample_java.java"
        initial_content = (
            "public class SampleJava {\n"
            "    public static void main(String[] args) {\n"
            "        System.out.println(\"Hello from Java!\");\n"
            "    }\n"
            "}\n"
        )
        sample.write_text(initial_content, encoding="utf-8")
        repo.git.add("sample_java.java")

        # Now AI makes edits in working tree (not yet staged/committed)
        edited_content = (
            "public class SampleJava {\n"
            "    public static void main(String[] args) {\n"
            "        int result = 0;\n"
            "        for (int i = 1; i <= 10; i++) {\n"
            "            result += i;\n"
            "        }\n"
            "        System.out.println(\"Hello from Java! Sum = \" + result);\n"
            "    }\n"
            "}\n"
        )
        sample.write_text(edited_content, encoding="utf-8")

        handler = JsonRpcHandler()

        # 1. rpc_git_show_file should return the staged content from index, NOT empty string
        show_res = await handler.rpc_git_show_file({
            "project_path": str(tmp),
            "path": str(sample),
            "ref": "HEAD"
        })
        assert show_res["content"].strip() == initial_content.strip(), f"Expected staged content, got: {show_res['content']}"

        # 2. rpc_git_diff_numstat should report the diff against index (+5 -1)
        numstat_res = await handler.rpc_git_diff_numstat({"project_path": str(tmp)})
        assert "sample_java.java" in numstat_res["files"]
        stats = numstat_res["files"]["sample_java.java"]
        assert stats["additions"] == 5
        assert stats["deletions"] == 1

        # 3. rpc_git_file_diff should return the working tree diff vs index
        diff_res = await handler.rpc_git_file_diff({
            "project_path": str(tmp),
            "path": str(sample),
        })
        assert "+        int result = 0;" in diff_res["diff"]
        assert "-        System.out.println(\"Hello from Java!\");" in diff_res["diff"]

        repo.close()

