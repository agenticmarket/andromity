"""Tests for Git operations and file diff utilities."""
import tempfile
from pathlib import Path
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
