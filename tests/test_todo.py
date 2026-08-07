"""Tests for todo model."""
import tempfile
from pathlib import Path
from andromity.core.todo import TodoItem, TodoList


def test_todo_item_properties():
    item = TodoItem(id="t1", title="Test", status="pending")
    assert item.checkbox == "[ ]"
    assert item.icon == "○"
    assert item.color == "dim"

    item.status = "done"
    assert item.checkbox == "[x]"
    assert item.icon == "✓"
    assert item.color == "green"


def test_todo_list_add():
    with tempfile.TemporaryDirectory() as tmpdir:
        todo_list = TodoList(project_path=tmpdir)
        item1 = todo_list.add("First task")
        assert item1.id == "t1"
        assert item1.title == "First task"
        assert item1.status == "pending"

        item2 = todo_list.add("Second task")
        assert item2.id == "t2"

        assert len(todo_list.items) == 2


def test_todo_list_update():
    with tempfile.TemporaryDirectory() as tmpdir:
        todo_list = TodoList(project_path=tmpdir)
        todo_list.add("Task one")
        todo_list.add("Task two")

        item = todo_list.update("t1", "done")
        assert item is not None
        assert item.status == "done"

        item = todo_list.update("t99", "done")
        assert item is None  # not found


def test_todo_list_progress():
    with tempfile.TemporaryDirectory() as tmpdir:
        todo_list = TodoList(project_path=tmpdir)
        todo_list.add("Task one")
        todo_list.add("Task two")
        todo_list.add("Task three")

        done, total = todo_list.progress()
        assert done == 0
        assert total == 3

        todo_list.update("t1", "done")
        todo_list.update("t2", "skipped")
        done, total = todo_list.progress()
        assert done == 2
        assert total == 3


def test_todo_list_persistence():
    with tempfile.TemporaryDirectory() as tmpdir:
        todo_list = TodoList(project_path=tmpdir)
        todo_list.add("Persistent task")
        todo_list.update("t1", "active")

        # Reload from file
        loaded = TodoList.load(tmpdir)
        assert len(loaded.items) == 1
        assert loaded.items[0].id == "t1"
        assert loaded.items[0].title == "Persistent task"
        assert loaded.items[0].status == "active"


def test_todo_list_file_format():
    with tempfile.TemporaryDirectory() as tmpdir:
        todo_list = TodoList(project_path=tmpdir)
        todo_list.add("Build auth")
        todo_list.add("Write tests")
        todo_list.update("t1", "done")

        content = (Path(tmpdir) / ".andromity" / "todos.md").read_text()
        assert "- [x] t1. Build auth" in content
        assert "- [ ] t2. Write tests" in content


def test_todo_list_next_pending():
    with tempfile.TemporaryDirectory() as tmpdir:
        todo_list = TodoList(project_path=tmpdir)
        todo_list.add("First")
        todo_list.add("Second")
        todo_list.update("t1", "done")

        next_item = todo_list.next_pending()
        assert next_item is not None
        assert next_item.id == "t2"
