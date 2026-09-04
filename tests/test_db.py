"""Unit tests for andromity.core.db SQLite engine."""
import concurrent.futures
import tempfile
from pathlib import Path
import pytest
from andromity.core.db import (
    close_conn,
    get_conn,
    get_db_path,
    init_schema,
    j,
    set_custom_db_path,
    transaction,
    uj,
)


@pytest.fixture(autouse=True)
def isolated_db(tmp_path):
    db_file = tmp_path / "test_andromity.db"
    set_custom_db_path(db_file)
    init_schema()
    yield db_file
    set_custom_db_path(None)
    close_conn()



def test_init_schema_creates_tables():
    conn = get_conn()
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    table_names = {r["name"] for r in tables}
    assert "sessions" in table_names
    assert "session_messages" in table_names
    assert "session_events" in table_names
    assert "cron_jobs" in table_names
    assert "cron_runs" in table_names
    assert "mcp_server_status" in table_names
    assert "schema_version" in table_names


def test_wal_mode_enabled():
    conn = get_conn()
    row = conn.execute("PRAGMA journal_mode;").fetchone()
    assert row[0].lower() == "wal"


def test_transaction_commit():
    conn = get_conn()
    with transaction(conn):
        conn.execute("""
            INSERT INTO sessions (
                id, project_hash, project_path, name, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, ("s1", "h1", "/proj", "test", "idle", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))

    row = conn.execute("SELECT * FROM sessions WHERE id = 's1'").fetchone()
    assert row is not None
    assert row["name"] == "test"
    assert row["status"] == "idle"


def test_transaction_rollback_on_error():
    conn = get_conn()
    with pytest.raises(RuntimeError):
        with transaction(conn):
            conn.execute("""
                INSERT INTO sessions (
                    id, project_hash, project_path, name, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, ("s_fail", "h1", "/proj", "test_fail", "idle", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
            raise RuntimeError("Force Rollback")

    row = conn.execute("SELECT * FROM sessions WHERE id = 's_fail'").fetchone()
    assert row is None


def test_concurrent_writers_stress():
    """Verify that multiple threads writing concurrently do not trigger database lock errors (WAL mode + busy_timeout)."""
    from andromity.core.db import close_conn

    def write_session(i: int):
        conn = get_conn()
        with transaction(conn):
            conn.execute("""
                INSERT INTO sessions (
                    id, project_hash, project_path, name, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (f"thread_sess_{i}", f"hash_{i % 3}", f"/proj_{i % 3}", f"Session {i}", "idle", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
        close_conn()
        return i

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(write_session, range(30)))

    assert len(results) == 30
    conn = get_conn()
    count = conn.execute("SELECT COUNT(*) as c FROM sessions").fetchone()["c"]
    assert count == 30
    close_conn()


def test_json_helpers():
    data = {"a": 1, "b": [1, 2, "3"], "c": True}
    serialized = j(data)
    assert isinstance(serialized, str)
    deserialized = uj(serialized)
    assert deserialized == data
    assert uj(None, default={"fallback": 1}) == {"fallback": 1}
    assert uj("invalid json", default=[]) == []
