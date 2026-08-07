"""Tests for tools."""
import os
import tempfile
from pathlib import Path
from unittest.mock import patch
from andromity.core.tools import read_file, write_file, edit_file, list_dir, shell_exec, execute_tool


# Helper: patch trust so write/edit tests work without a real trusted path
def _trusted(monkeypatch, root=None):
    monkeypatch.setattr("andromity.core.tools._is_trusted", lambda: True)
    if root:
        monkeypatch.setattr("andromity.core.tools._get_project_root", lambda: Path(root).resolve())


def test_read_file_nonexistent(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        assert "Error" in read_file(os.path.join(tmpdir, "nonexistent.txt"))


def test_write_and_read_file(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "test.txt")
        assert "Successfully" in write_file(path, "hello world")
        assert "hello world" in read_file(path)


def test_edit_file(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "test.txt")
        write_file(path, "foo bar baz")
        assert "Successfully" in edit_file(path, "bar", "qux")
        assert "foo qux baz" in read_file(path)


def test_edit_file_not_found(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        assert "Error" in edit_file(os.path.join(tmpdir, "nonexistent.txt"), "a", "b")


def test_edit_file_old_str_not_found(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "test.txt")
        write_file(path, "hello world")
        result = edit_file(path, "nonexistent", " replacement")
        assert "Error" in result and "not found" in result


def test_read_file_with_lines(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "test.txt")
        write_file(path, "line1\nline2\nline3\nline4\n")
        content = read_file(path, start=2, end=3)
        assert "2: line2" in content and "3: line3" in content
        assert "line1" not in content and "line4" not in content


def test_read_file_large_bounded(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "large.txt")
        lines = [f"line {i}" for i in range(1, 600)]
        write_file(path, "\n".join(lines))
        content = read_file(path, max_lines=50)
        assert "Showing lines 1 to 50" in content
        assert "1: line 1" in content
        assert "50: line 50" in content
        assert "line 51" not in content


def test_list_dir(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        Path(os.path.join(tmpdir, "file.txt")).touch()
        Path(os.path.join(tmpdir, "subdir")).mkdir()
        result = list_dir(tmpdir)
        assert "file.txt" in result and "subdir" in result


def test_list_dir_nonexistent(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        assert "Error" in list_dir(os.path.join(tmpdir, "nonexistent_dir"))


def test_execute_tool_dispatch(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "test.txt")
        assert "Successfully" in execute_tool("write_file", {"path": path, "content": "test"})
        assert "test" in execute_tool("read_file", {"path": path})
        grep_res = execute_tool("grep_search", {"query": "test", "path": tmpdir})
        assert "test.txt" in grep_res
        find_res = execute_tool("find_files", {"pattern": "*.txt", "path": tmpdir})
        assert "test.txt" in find_res


def test_execute_tool_unknown():
    assert "Error" in execute_tool("unknown_tool", {})


# ─── Path traversal guard tests ───────────────────────────────────────────────

def test_path_traversal_blocked_for_read(monkeypatch):
    with tempfile.TemporaryDirectory() as project_dir:
        _trusted(monkeypatch, project_dir)
        outside_file = os.path.abspath(os.path.join(project_dir, "..", "outside.txt"))
        result = read_file(outside_file)
        assert "Access denied" in result and "outside the project directory" in result


def test_path_traversal_blocked_for_write(monkeypatch):
    with tempfile.TemporaryDirectory() as project_dir:
        _trusted(monkeypatch, project_dir)
        outside_file = os.path.abspath(os.path.join(project_dir, "..", "outside.txt"))
        result = write_file(outside_file, "malicious content")
        assert "Access denied" in result and "outside the project directory" in result


def test_path_traversal_blocked_for_edit(monkeypatch):
    with tempfile.TemporaryDirectory() as project_dir:
        _trusted(monkeypatch, project_dir)
        outside_file = os.path.abspath(os.path.join(project_dir, "..", "outside.txt"))
        result = edit_file(outside_file, "old", "new")
        assert "Access denied" in result and "outside the project directory" in result


def test_path_traversal_blocked_for_list_dir(monkeypatch):
    with tempfile.TemporaryDirectory() as project_dir:
        _trusted(monkeypatch, project_dir)
        outside_dir = os.path.abspath(os.path.join(project_dir, ".."))
        result = list_dir(outside_dir)
        assert "Access denied" in result and "outside the project directory" in result


# ─── Trust guard tests ────────────────────────────────────────────────────────

def test_write_blocked_when_untrusted(monkeypatch):
    """write_file should return an error message when the folder is not trusted."""
    with tempfile.TemporaryDirectory() as tmpdir:
        monkeypatch.setattr("andromity.core.tools._is_trusted", lambda: False)
        monkeypatch.setattr("andromity.core.tools._get_project_root", lambda: Path(tmpdir).resolve())
        path = os.path.join(tmpdir, "blocked.txt")
        result = write_file(path, "data")
        assert "not trusted" in result.lower()
        assert not Path(path).exists()


def test_edit_blocked_when_untrusted(monkeypatch):
    """edit_file should return an error message when the folder is not trusted."""
    with tempfile.TemporaryDirectory() as tmpdir:
        monkeypatch.setattr("andromity.core.tools._is_trusted", lambda: False)
        monkeypatch.setattr("andromity.core.tools._get_project_root", lambda: Path(tmpdir).resolve())
        path = os.path.join(tmpdir, "test.txt")
        Path(path).write_text("original")
        result = edit_file(path, "original", "changed")
        assert "not trusted" in result.lower()
        assert Path(path).read_text() == "original"  # file unchanged


def test_shell_blocked_when_untrusted():
    """shell_exec should return an error message when the folder is not trusted."""
    with patch("andromity.core.tools._is_trusted", return_value=False):
        result = shell_exec("echo hello")
        assert "not trusted" in result.lower()

