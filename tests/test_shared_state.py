import pytest
from pathlib import Path
from andromity.core.shared_state import SharedStateBoard


@pytest.fixture
def board(tmp_path):
    SharedStateBoard.reset_instances()
    storage = tmp_path / "test_shared_state.json"
    return SharedStateBoard(storage_path=storage)


def test_shared_state_set_and_get(board):
    board.set("auth.endpoints", ["/login", "/refresh"], author_session="auth-session")
    board.set("auth.jwt_secret_set", True, author_session="auth-session")
    board.set("ui.theme", "dark", author_session="ui-session")

    assert board.get("auth.endpoints") == ["/login", "/refresh"]
    assert board.get("auth.jwt_secret_set") is True
    assert board.get("ui.theme") == "dark"
    assert board.get("nonexistent") is None


def test_shared_state_prefix_and_snapshot(board):
    board.set("db.host", "localhost")
    board.set("db.port", 5432)
    board.set("db.name", "app_dev")
    board.set("api.rate_limit", 100)

    db_snap = board.snapshot(prefix="db.")
    assert len(db_snap) == 3
    assert db_snap["db.host"] == "localhost"
    assert "api.rate_limit" not in db_snap

    keys = board.list_keys(prefix="db.")
    assert keys == ["db.host", "db.name", "db.port"]


def test_shared_state_watchers(board):
    changes = []
    board.watch("auth.*", lambda k, old, new: changes.append((k, old, new)))

    board.set("auth.status", "in_progress")
    board.set("auth.status", "complete")
    board.set("ui.status", "in_progress")  # should not trigger auth.* watcher

    assert len(changes) == 2
    assert changes[0] == ("auth.status", None, "in_progress")
    assert changes[1] == ("auth.status", "in_progress", "complete")


def test_shared_state_persistence(tmp_path):
    storage = tmp_path / "persistent_board.json"
    board1 = SharedStateBoard(storage_path=storage)
    board1.set("project.name", "SuperApp")
    board1.set("project.version", "2.0.0")

    # Load in fresh instance pointing to same file
    board2 = SharedStateBoard(storage_path=storage)
    assert board2.get("project.name") == "SuperApp"
    assert board2.get("project.version") == "2.0.0"
