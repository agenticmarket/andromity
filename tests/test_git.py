"""Tests for Git operations and file diff utilities."""
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from git import Repo
from andromity.core.git_ops import get_repo, get_file_diff


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

