"""Tests for tools."""
import os
import tempfile
from pathlib import Path
from unittest.mock import patch
from andromity.core.tools import read_file, write_file, edit_file, list_dir, shell_exec, execute_tool


# Helper: patch trust so write/edit tests work without a real trusted path
def _trusted(monkeypatch):
    monkeypatch.setattr("andromity.core.tools._is_trusted", lambda: True)


def test_read_file_nonexistent():
    assert "Error" in read_file("/nonexistent/file.txt")


def test_write_and_read_file(monkeypatch):
    _trusted(monkeypatch)
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        assert "Successfully" in write_file(path, "hello world")
        assert read_file(path) == "hello world"


def test_edit_file(monkeypatch):
    _trusted(monkeypatch)
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        write_file(path, "foo bar baz")
        assert "Successfully" in edit_file(path, "bar", "qux")
        assert read_file(path) == "foo qux baz"


def test_edit_file_not_found(monkeypatch):
    _trusted(monkeypatch)
    assert "Error" in edit_file("/nonexistent/file.txt", "a", "b")


def test_edit_file_old_str_not_found(monkeypatch):
    _trusted(monkeypatch)
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        write_file(path, "hello world")
        result = edit_file(path, "nonexistent", " replacement")
        assert "Error" in result and "not found" in result


def test_read_file_with_lines(monkeypatch):
    _trusted(monkeypatch)
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        write_file(path, "line1\nline2\nline3\nline4\n")
        content = read_file(path, start=2, end=3)
        assert "line2" in content and "line3" in content
        assert "line1" not in content and "line4" not in content


def test_list_dir():
    with tempfile.TemporaryDirectory() as tmpdir:
        Path(os.path.join(tmpdir, "file.txt")).touch()
        Path(os.path.join(tmpdir, "subdir")).mkdir()
        result = list_dir(tmpdir)
        assert "file.txt" in result and "subdir" in result


def test_list_dir_nonexistent():
    assert "Error" in list_dir("/nonexistent/dir")


def test_execute_tool_dispatch(monkeypatch):
    _trusted(monkeypatch)
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        assert "Successfully" in execute_tool("write_file", {"path": path, "content": "test"})
        assert execute_tool("read_file", {"path": path}) == "test"


def test_execute_tool_unknown():
    assert "Error" in execute_tool("unknown_tool", {})


# ─── Trust guard tests ────────────────────────────────────────────────────────

def test_write_blocked_when_untrusted():
    """write_file should return an error message when the folder is not trusted."""
    with patch("andromity.core.tools._is_trusted", return_value=False):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "blocked.txt")
            result = write_file(path, "data")
            assert "not trusted" in result.lower()
            assert not Path(path).exists()


def test_edit_blocked_when_untrusted():
    """edit_file should return an error message when the folder is not trusted."""
    with patch("andromity.core.tools._is_trusted", return_value=False):
        with tempfile.TemporaryDirectory() as tmpdir:
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

