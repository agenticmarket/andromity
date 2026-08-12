"""Tests for tools."""
import os
import pytest
import tempfile
from pathlib import Path
from unittest.mock import patch
from andromity.core.tools import (
    read_file,
    write_file,
    edit_file,
    list_dir,
    shell_exec,
    execute_tool,
    list_tools,
    write_plan,
    update_plan_step,
    ToolRegistry,
    CORE_TOOLS,
)
from andromity.core.todo import TodoList


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
        content = read_file(path, start_line=2, end_line=3)
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


def test_read_file_symbols_only(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "module.py")
        code = """\"\"\"Module documentation docstring.\"\"\"
import os

class DatabaseClient:
    \"\"\"Client for DB operations.\"\"\"
    def __init__(self, host: str):
        self.host = host

    def connect(self) -> bool:
        return True

def standalone_helper(x: int) -> int:
    return x * 2
"""
        write_file(path, code)
        res = read_file(path, symbols_only=True)
        assert "Symbol Outline" in res
        assert "class DatabaseClient" in res
        assert "def __init__" in res
        assert "def connect" in res
        assert "def standalone_helper" in res
        assert "Client for DB operations" in res


def test_edit_file_whitespace_tolerant(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "code.py")
        original = "def foo():\n    x = 1\n    return x\n"
        write_file(path, original)

        # Agent sends with 2 spaces instead of 4
        old_str = "def foo():\n  x = 1\n  return x"
        new_str = "def foo():\n  x = 42\n  return x"
        res = edit_file(path, old_str, new_str)
        assert "Successfully" in res
        assert "x = 42" in read_file(path)


def test_edit_file_line_bounded(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "duplicate.txt")
        original = "header\nitem = 1\nmiddle\nitem = 1\nfooter\n"
        write_file(path, original)

        # Replace only the second occurrence using start_line/end_line
        res = edit_file(path, "item = 1", "item = 99", start_line=3, end_line=5)
        assert "Successfully" in res
        content = read_file(path)
        assert "item = 1" in content  # first occurrence intact
        assert "item = 99" in content  # second occurrence replaced


def test_edit_file_duplicate_error(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "ambiguous.txt")
        original = "repeat\nrepeat\n"
        write_file(path, original)

        res = edit_file(path, "repeat", "replaced")
        assert "matches 2 times" in res
        assert "lines: [1, 2]" in res


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


def test_path_traversal_blocked_for_grep_search(monkeypatch):
    from andromity.core.tools import grep_search
    with tempfile.TemporaryDirectory() as project_dir:
        _trusted(monkeypatch, project_dir)
        outside_dir = os.path.abspath(os.path.join(project_dir, ".."))
        result = grep_search("query", path=outside_dir)
        assert "Access denied" in result and "outside the project directory" in result


def test_path_traversal_blocked_for_find_files(monkeypatch):
    from andromity.core.tools import find_files
    with tempfile.TemporaryDirectory() as project_dir:
        _trusted(monkeypatch, project_dir)
        outside_dir = os.path.abspath(os.path.join(project_dir, ".."))
        result = find_files("*.py", path=outside_dir)
        assert "Access denied" in result and "outside the project directory" in result


def test_read_file_range_edge_cases(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        path = os.path.join(tmpdir, "sample.txt")
        write_file(path, "line 1\nline 2\nline 3\n")
        
        # start > total_lines
        res = read_file(path, start_line=10, end_line=12)
        assert "Error: start line 10 exceeds total lines" in res
        
        # start > end
        res2 = read_file(path, start_line=3, end_line=1)
        assert "Error: start line 3 is greater than end line 1" in res2

        # Empty file
        empty_path = os.path.join(tmpdir, "empty.txt")
        write_file(empty_path, "")
        assert "is empty" in read_file(empty_path)


def test_list_dir_show_hidden(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        _trusted(monkeypatch, tmpdir)
        (Path(tmpdir) / "visible.py").touch()
        (Path(tmpdir) / "node_modules").mkdir()
        (Path(tmpdir) / ".venv").mkdir()

        # By default hidden/excluded dirs should not be shown
        default_res = list_dir(tmpdir)
        assert "visible.py" in default_res
        assert "node_modules" not in default_res
        assert ".venv" not in default_res

        # With show_hidden=True
        hidden_res = list_dir(tmpdir, show_hidden=True)
        assert "visible.py" in hidden_res
        assert "node_modules" in hidden_res
        assert ".venv" in hidden_res


def test_core_tools_structure():
    tool_names = [t["function"]["name"] for t in CORE_TOOLS]
    assert "read_file" in tool_names
    assert "grep_search" in tool_names
    assert "find_files" in tool_names
    assert "write_file" in tool_names
    assert "edit_file" in tool_names
    assert "list_dir" in tool_names
    assert "shell_exec" in tool_names
    assert "write_plan" in tool_names
    assert "list_tools" in tool_names


def test_tool_registry_and_list_tools():
    registry = ToolRegistry()
    ToolRegistry._instance = registry
    registry.register_deferred(
        name="fetch_url",
        description="Fetch documentation web page",
        parameters={"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
        category="web",
    )

    catalog = registry.get_deferred_prompt_catalog()
    assert "<available-deferred-tools>" in catalog
    assert "fetch_url" in catalog

    # Search for tool
    search_res = list_tools(search="fetch web documentation", include_description=True)
    assert "Found 1 deferred tool" in search_res
    assert "fetch_url" in search_res
    assert "parameters" in search_res.lower()
    
    # Test offset and limit
    res_paginated = list_tools(limit=1, offset=0, include_description=False)
    assert "fetch_url" in res_paginated
    assert "Description:" not in res_paginated

def test_write_plan_syncs_todo(tmp_path):
    plan_data = {
        "title": "Refactor Database Module",
        "steps": [
            "Create database interface",
            "Implement sqlite adapter",
        ]
    }
    with patch("andromity.core.tools._get_project_root", return_value=tmp_path):
        res = write_plan(**plan_data)
        assert "Refactor Database Module" in res
        assert "2 steps" in res

        # Verify TodoList was synced automatically (steps → todos)
        todo_list = TodoList.load(str(tmp_path))
        assert len(todo_list.items) == 2
        assert todo_list.items[0].title == "Create database interface"
        assert todo_list.items[1].title == "Implement sqlite adapter"


def test_write_plan_dict_steps_syncs_todo(tmp_path):
    """Steps provided as dicts with text/status are handled correctly."""
    plan_data = {
        "title": "Auth Refactor",
        "steps": [
            {"text": "Create interface", "status": "in_progress"},
            {"text": "Add tests", "status": "pending"},
        ]
    }
    with patch("andromity.core.tools._get_project_root", return_value=tmp_path):
        res = write_plan(**plan_data)
        assert "Auth Refactor" in res
        todo_list = TodoList.load(str(tmp_path))
        assert len(todo_list.items) == 2
        assert todo_list.items[0].title == "Create interface"
        assert todo_list.items[0].status == "active"   # in_progress → active
        assert todo_list.items[1].status == "pending"


def test_write_plan_no_steps_in_plan_dict(tmp_path):
    """Plan dict must NOT contain a 'steps' key — todos are the steps."""
    with patch("andromity.core.tools._get_project_root", return_value=tmp_path):
        write_plan(title="Clean arch", steps=["Do A", "Do B"])
        from andromity.core.planner import Plan
        p = Plan.load(str(tmp_path))
        assert p is not None
        assert p.title == "Clean arch"
        assert not hasattr(p, "steps") or not p.to_dict().get("steps"), \
            "Plan dict should not have a steps key — use TodoList instead"


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
