"""Tests for live session status tracking and lifecycle transitions."""
import tempfile
from pathlib import Path
import pytest
from andromity.core.db import get_conn, init_schema, set_custom_db_path
from andromity.core.session import Session


@pytest.fixture(autouse=True)
def isolated_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_file = Path(tmpdir) / "status_test.db"
        set_custom_db_path(db_file)
        init_schema()
        yield db_file
        set_custom_db_path(None)


def test_session_default_status_is_idle():
    s = Session(name="status-check", project_path="/tmp/test_status")
    assert s.status == "idle"
    s.save()

    conn = get_conn()
    row = conn.execute("SELECT status FROM sessions WHERE id = ?", (s.id,)).fetchone()
    assert row["status"] == "idle"


def test_session_status_transitions():
    s = Session(name="status-trans", project_path="/tmp/test_status")
    s.save()

    s.set_status("running")
    assert s.status == "running"
    conn = get_conn()
    assert conn.execute("SELECT status FROM sessions WHERE id = ?", (s.id,)).fetchone()["status"] == "running"

    s.set_status("approval_required")
    assert s.status == "approval_required"
    assert conn.execute("SELECT status FROM sessions WHERE id = ?", (s.id,)).fetchone()["status"] == "approval_required"

    s.set_status("idle")
    assert s.status == "idle"
    assert conn.execute("SELECT status FROM sessions WHERE id = ?", (s.id,)).fetchone()["status"] == "idle"


def test_session_message_compaction_syncs_to_db():
    s = Session(name="compact-test", project_path="/tmp/test_status")
    s.add_message("system", content="You are an assistant")
    for i in range(20):
        s.add_message("user" if i % 2 == 0 else "assistant", content=f"Msg {i}")
    s.save()

    assert len(s.messages) == 21
    conn = get_conn()
    count = conn.execute("SELECT COUNT(*) as c FROM session_messages WHERE session_id = ?", (s.id,)).fetchone()["c"]
    assert count == 21

    # Compact messages
    removed = s.compact_messages("Summary of first 10 messages", keep_last_n=6)
    assert removed > 0

    # Verify session_messages table in SQLite matches the compacted state
    count_after = conn.execute("SELECT COUNT(*) as c FROM session_messages WHERE session_id = ?", (s.id,)).fetchone()["c"]
    assert count_after == len(s.messages)
