"""Regression coverage for SQLite-only session storage and legacy import."""
import json
import sqlite3
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from andromity.core.db import close_conn, get_conn, init_schema, set_custom_db_path, transaction
from andromity.core.session import Session, SessionPersistenceError
from andromity.core.session_migration import migrate_legacy_sessions
from andromity.core.usage_tracker import UsageTracker


@pytest.fixture
def storage(tmp_path, monkeypatch):
    monkeypatch.setattr("andromity.core.session.get_config_dir", lambda: tmp_path)
    set_custom_db_path(tmp_path / "sessions.db")
    init_schema()
    yield tmp_path
    close_conn()


def legacy_file(storage, session):
    session.file_path.parent.mkdir(parents=True, exist_ok=True)
    session.file_path.write_text(json.dumps(session.to_dict()), encoding="utf-8")
    return session.file_path


def immediate(coroutine):
    """Drive handlers with no asynchronous I/O without creating an event loop."""
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    finally:
        coroutine.close()
    raise AssertionError("Handler unexpectedly required asynchronous I/O")


def test_save_flush_and_restart_without_json(storage):
    session = Session(project_path=str(storage))
    session.add_message("user", "hello")
    session.add_message("assistant", "answer")
    session.flush()
    assert not (storage / "sessions").exists()
    close_conn()
    loaded = Session.load_by_id(session.id)
    assert [message["content"] for message in loaded.messages] == ["hello", "answer"]


def test_metadata_survives_restart(storage):
    session = Session(project_path=str(storage))
    session.permission_mode = "trust"
    session.profile = "researcher"
    session.consecutive_auto_wakes = 3
    session.collaborators = ["peer"]
    session.plan = {"title": "Review"}
    session.undo_stack = [{"snapshot_hash": "abc", "turn_index": 0}]
    session.set_status("watching", {"target_session": "peer", "reason": "waiting"})
    close_conn()
    loaded = Session.load_by_id(session.id)
    assert loaded._session_metadata() == session._session_metadata()
    assert loaded.status == "watching"
    assert loaded.plan == session.plan
    assert loaded.undo_stack == session.undo_stack
    loaded.set_status("idle")
    assert Session.load_by_id(session.id).watching_for is None


def test_message_edits_and_truncation_persist(storage):
    session = Session(project_path=str(storage))
    session.add_message("user", "prompt", images=["image"])
    session.add_message("assistant", "old answer")
    session.save()
    session.messages[0].pop("images")
    session.messages[1]["content"] = "new answer"
    session.save()
    loaded = Session.load_by_id(session.id)
    assert "images" not in loaded.messages[0]
    assert loaded.messages[1]["content"] == "new answer"
    session.messages = [{"role": "assistant", "content": "summary"}]
    session.save()
    loaded = Session.load_by_id(session.id)
    assert len(loaded.messages) == 1
    assert loaded.messages[0]["content"] == "summary"


def test_renaming_list_summary_preserves_messages(storage):
    session = Session(project_path=str(storage))
    session.add_message("user", "Keep this history")
    summary = Session.list_sessions(str(storage))[0]
    assert not summary._messages_loaded
    summary.rename("Renamed")
    loaded = Session.load_by_id(session.id)
    assert loaded.name == "Renamed"
    assert loaded.messages[0]["content"] == "Keep this history"


def test_import_once_preserves_sources_and_never_resurrects(storage, monkeypatch):
    session = Session(project_path=str(storage))
    session.messages = [{"role": "user", "content": "legacy"}]
    snapshot = legacy_file(storage, session)
    original = snapshot.read_bytes()
    assert migrate_legacy_sessions() == 1
    assert Session.load_by_id(session.id).messages[0]["content"] == "legacy"
    assert snapshot.read_bytes() == original
    Session.delete_by_id(session.id)
    monkeypatch.setattr(Path, "glob", Mock(side_effect=AssertionError("Legacy files must not be rescanned")))
    assert migrate_legacy_sessions() == 0
    assert Session.load_by_id(session.id) is None
    assert Session.list_sessions(str(storage)) == []
    assert UsageTracker().get_summary(project_path=str(storage)).total_sessions == 0


def test_import_does_not_replace_newer_sqlite_history(storage):
    session = Session(project_path=str(storage))
    snapshot = legacy_file(storage, session)
    session.add_message("user", "newer")
    session.rename("Newer SQLite name")
    assert migrate_legacy_sessions() == 0
    loaded = Session.load_by_id(session.id)
    assert loaded.name == "Newer SQLite name"
    assert loaded.messages[0]["content"] == "newer"
    assert snapshot.exists()


def test_import_backfills_matching_legacy_metadata(storage):
    session = Session(project_path=str(storage))
    session.permission_mode = "trust"
    session.profile = "researcher"
    session.save()
    legacy_file(storage, session)
    get_conn().execute("UPDATE sessions SET session_metadata = '{}' WHERE id = ?", (session.id,))
    assert migrate_legacy_sessions() == 0
    assert Session.load_by_id(session.id).profile == "researcher"
    assert Session.load_by_id(session.id).permission_mode == "trust"


def test_corrupt_legacy_file_is_preserved(storage):
    directory = storage / "sessions" / "old"
    directory.mkdir(parents=True)
    path = directory / "broken.json"
    path.write_text("{broken", encoding="utf-8")
    assert migrate_legacy_sessions() == 0
    assert path.read_text(encoding="utf-8") == "{broken"


def test_import_failure_rolls_back_rows_and_completion_marker(storage, monkeypatch):
    sessions = [Session(project_path=str(storage)) for _ in range(2)]
    for session in sessions:
        legacy_file(storage, session)
    original_save = Session._save_to_db
    calls = []

    def fail_second(session):
        calls.append(session.id)
        if len(calls) == 2:
            raise SessionPersistenceError("Could not save chat history.")
        original_save(session)

    monkeypatch.setattr(Session, "_save_to_db", fail_second)
    with pytest.raises(SessionPersistenceError):
        migrate_legacy_sessions()
    assert get_conn().execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    assert get_conn().execute("SELECT COUNT(*) FROM storage_migrations").fetchone()[0] == 0
    monkeypatch.setattr(Session, "_save_to_db", original_save)
    assert migrate_legacy_sessions() == 2


def test_save_failure_keeps_pending_changes(storage, monkeypatch):
    session = Session(project_path=str(storage))
    session.save()
    session.messages.append({"role": "user", "content": "unsaved"})
    monkeypatch.setattr("andromity.core.db.get_conn", Mock(side_effect=sqlite3.OperationalError("disk full")))
    with pytest.raises(SessionPersistenceError, match="Could not save chat history"):
        session.save()
    assert session._dirty
    session._flush_save()
    assert session._dirty


def test_deletion_cascades_and_stale_instance_cannot_resurrect(storage):
    session = Session(project_path=str(storage))
    session.add_message("user", "delete")
    get_conn().execute("INSERT INTO session_events(session_id, seq, type, payload) VALUES (?, 0, 'message', '{}')", (session.id,))
    session.delete()
    assert get_conn().execute("SELECT COUNT(*) FROM session_messages").fetchone()[0] == 0
    assert get_conn().execute("SELECT COUNT(*) FROM session_events").fetchone()[0] == 0
    with pytest.raises(SessionPersistenceError, match="deleted"):
        session.save()


def test_background_connection_does_not_cancel_pending_saves(storage, monkeypatch):
    cancel = Mock()
    monkeypatch.setattr(Session, "cancel_all_timers", cancel)
    errors = []

    def connect():
        try:
            get_conn()
            close_conn(cancel_timers=False)
        except Exception as error:
            errors.append(error)

    thread = threading.Thread(target=connect)
    thread.start()
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert not errors
    cancel.assert_not_called()


def test_schema_initialization_preserves_open_transaction(storage):
    with pytest.raises(RuntimeError):
        with transaction(get_conn()):
            Session(project_path=str(storage)).save()
            raise RuntimeError("rollback")
    assert get_conn().execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


def test_existing_sqlite_schema_upgrade_preserves_history(storage):
    session = Session(project_path=str(storage))
    session.add_message("user", "existing SQLite history")
    get_conn().execute("ALTER TABLE sessions DROP COLUMN session_metadata")
    init_schema()
    loaded = Session.load_by_id(session.id)
    assert loaded.messages[0]["content"] == "existing SQLite history"
    assert loaded.permission_mode == "safe"
    loaded.rename("Still writable after upgrade")
    assert Session.load_by_id(session.id).name == "Still writable after upgrade"


def test_rpc_delete_rejects_running_chat_and_reports_storage_failure(storage, monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler

    session = Session(project_path=str(storage))
    session.save()
    handler = JsonRpcHandler()
    handler._active_sessions[session.id] = session
    handler._running_tasks[session.id] = SimpleNamespace(done=lambda: False)
    assert immediate(handler.rpc_session_delete({"session_id": session.id}))["success"] is False
    assert Session.load_by_id(session.id) is not None
    handler._running_tasks.clear()
    with monkeypatch.context() as patch:
        patch.setattr(Session, "delete", Mock(side_effect=SessionPersistenceError("Could not delete this chat.")))
        with pytest.raises(SessionPersistenceError):
            immediate(handler.rpc_session_delete({"session_id": session.id}))
        assert session.id in handler._active_sessions
    session._mark_dirty(delay=60)
    timer = session._save_timer
    assert immediate(handler.rpc_session_delete({"session_id": session.id}))["success"] is True
    assert timer.finished.is_set()
    assert Session.load_by_id(session.id) is None
    with pytest.raises(ValueError):
        immediate(handler.rpc_session_delete({"session_id": "../invalid"}))


def test_tui_opens_full_history_and_deletes_from_sqlite(storage):
    from andromity.tui.overlays.session import SessionBrowserOverlay

    session = Session(project_path=str(storage))
    session.add_message("user", "full history")
    opened = []
    screen = SimpleNamespace(
        _sessions=Session.list_sessions(str(storage)), _selected_idx=0,
        _current_id="other", query_one=lambda *args: SimpleNamespace(cursor_row=0),
        dismiss=Mock(), notify=Mock(), _load_sessions=Mock(),
        app=SimpleNamespace(_load_session=lambda loaded: opened.append(loaded), run_worker=Mock()),
    )
    SessionBrowserOverlay._open_selected(screen)
    assert opened[0].messages[0]["content"] == "full history"
    SessionBrowserOverlay._delete_selected(screen)
    assert Session.load_by_id(session.id) is None
    screen._load_sessions.assert_called_once_with(keep_cursor=True)
