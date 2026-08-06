"""Tests for tools."""
import os
import tempfile
from pathlib import Path
from andromity.core.tools import read_file, write_file, edit_file, list_dir, execute_tool


def test_read_file_nonexistent():
    assert "Error" in read_file("/nonexistent/file.txt")


def test_write_and_read_file():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        assert "Successfully" in write_file(path, "hello world")
        assert read_file(path) == "hello world"


def test_edit_file():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        write_file(path, "foo bar baz")
        assert "Successfully" in edit_file(path, "bar", "qux")
        assert read_file(path) == "foo qux baz"


def test_edit_file_not_found():
    assert "Error" in edit_file("/nonexistent/file.txt", "a", "b")


def test_edit_file_old_str_not_found():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        write_file(path, "hello world")
        result = edit_file(path, "nonexistent", " replacement")
        assert "Error" in result and "not found" in result


def test_read_file_with_lines():
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


def test_execute_tool_dispatch():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.txt")
        assert "Successfully" in execute_tool("write_file", {"path": path, "content": "test"})
        assert execute_tool("read_file", {"path": path}) == "test"


def test_execute_tool_unknown():
    assert "Error" in execute_tool("unknown_tool", {})
