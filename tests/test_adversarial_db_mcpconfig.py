"""Independent adversarial tests for
  F. db.init_schema skipping its DDL when the database file and its PRAGMA schema_version are unchanged
  G. mcp.read_mcp_servers / MCPClientManager.load_config

Written to break the new behaviour, not to pass. Temp dirs only; Path.home is redirected so the real
~/.andromity/mcp.json is never read.
"""
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

from andromity.core import db as dbmod
from andromity.core import mcp as mcpmod
from andromity.core.db import close_conn, get_conn, init_schema, set_custom_db_path
from andromity.core.mcp import MCPClientManager, read_mcp_servers

SRC = str(Path(__file__).resolve().parents[1] / "src")
REQUIRED_TABLES = {"sessions", "session_messages", "session_events", "cron_jobs", "cron_runs",
                   "mcp_server_status", "schema_version", "storage_migrations"}


def tables(conn):
    return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def ddl_statements(conn, action):
    seen = []
    conn.set_trace_callback(seen.append)
    try:
        action()
    finally:
        conn.set_trace_callback(None)
    return [s for s in seen if s.lstrip().upper().startswith(("CREATE", "ALTER", "INSERT", "DROP"))]


@pytest.fixture
def db_path(tmp_path):
    path = tmp_path / "adv.db"
    set_custom_db_path(path)
    yield path
    set_custom_db_path(None)
    close_conn()


# ---------------------------------------------------------------------------
# F. db.init_schema
# ---------------------------------------------------------------------------

def test_f_second_init_runs_no_ddl_and_first_does(db_path):
    conn = get_conn()
    assert ddl_statements(conn, init_schema), "first init must create the schema"
    assert REQUIRED_TABLES <= tables(conn)
    assert ddl_statements(conn, init_schema) == []
    assert ddl_statements(conn, init_schema) == []


def test_f_skip_is_much_cheaper_than_a_full_init(db_path):
    init_schema()
    started = time.perf_counter()
    for _ in range(500):
        init_schema()
    per_call = (time.perf_counter() - started) / 500
    assert per_call < 0.002, f"{per_call * 1000:.2f} ms per skipped init"


@pytest.mark.parametrize("damage", [
    "DROP TABLE cron_runs",
    "DROP TABLE mcp_server_status",
    "DROP TABLE session_events",
    "DROP TABLE storage_migrations",
    "DROP INDEX idx_sessions_status",
    "ALTER TABLE sessions DROP COLUMN session_metadata",
    "ALTER TABLE cron_jobs DROP COLUMN lease_owner",
    "ALTER TABLE session_messages DROP COLUMN turn_key",
    "ALTER TABLE cron_runs DROP COLUMN blocked_tools",
])
def test_f_schema_damage_by_another_connection_is_repaired(db_path, damage):
    init_schema()
    other = sqlite3.connect(str(db_path), timeout=10, isolation_level=None)
    try:
        other.execute("PRAGMA foreign_keys = OFF")
        other.execute(damage)
    finally:
        other.close()
    init_schema()
    conn = get_conn()
    assert REQUIRED_TABLES <= tables(conn)
    assert "session_metadata" in columns(conn, "sessions")
    assert "lease_owner" in columns(conn, "cron_jobs")
    assert "turn_key" in columns(conn, "session_messages")
    assert "blocked_tools" in columns(conn, "cron_runs")
    assert conn.execute("SELECT name FROM sqlite_master WHERE name='idx_sessions_status'").fetchone()


def test_f_schema_damage_by_another_process_is_repaired(db_path):
    init_schema()
    script = textwrap.dedent("""
        import sqlite3, sys
        c = sqlite3.connect(sys.argv[1], isolation_level=None)
        c.execute("DROP TABLE cron_runs")
        c.execute("ALTER TABLE sessions DROP COLUMN session_metadata")
        c.close()
    """)
    subprocess.run([sys.executable, "-I", "-c", script, str(db_path)], check=True, timeout=30)
    init_schema()
    conn = get_conn()
    assert "cron_runs" in tables(conn) and "session_metadata" in columns(conn, "sessions")


def test_f_file_deleted_and_recreated_at_the_same_path_gets_its_schema(db_path):
    init_schema()
    close_conn()
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(str(db_path) + suffix)
        except FileNotFoundError:
            pass
    fresh = sqlite3.connect(str(db_path))
    fresh.execute("CREATE TABLE unrelated(x)")
    fresh.commit()
    fresh.close()
    init_schema()
    assert REQUIRED_TABLES <= tables(get_conn())


def test_f_file_deleted_and_not_recreated_is_created_again(db_path):
    init_schema()
    close_conn()
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(str(db_path) + suffix)
        except FileNotFoundError:
            pass
    init_schema()
    assert REQUIRED_TABLES <= tables(get_conn())


@pytest.mark.xfail(strict=True, reason='Theoretical: needs the live database file overwritten in place with the same inode and schema cookie.')
def test_f_database_restored_in_place_with_an_equal_schema_version_still_gets_its_tables(db_path, tmp_path):
    """A backup restored over the live file keeps its inode when copied in place. If the restored database
    happens to carry the same schema_version cookie, the skip trusts it. Build exactly that database: same
    cookie, but none of the application tables."""
    init_schema()
    conn = get_conn()
    version = int(conn.execute("PRAGMA schema_version").fetchone()[0])
    impostor = tmp_path / "impostor.db"
    other = sqlite3.connect(str(impostor), isolation_level=None)
    other.execute("CREATE TABLE filler(x)")
    other.execute(f"PRAGMA schema_version = {version}")
    assert int(other.execute("PRAGMA schema_version").fetchone()[0]) == version
    other.close()
    close_conn()
    for suffix in ("-wal", "-shm"):
        try:
            os.remove(str(db_path) + suffix)
        except FileNotFoundError:
            pass
    inode_before = os.stat(db_path).st_ino
    with open(impostor, "rb") as src, open(db_path, "r+b") as dst:
        dst.truncate(0)
        shutil.copyfileobj(src, dst)
    assert os.stat(db_path).st_ino == inode_before, "test needs an in-place replacement"
    init_schema()
    assert REQUIRED_TABLES <= tables(get_conn()), "restored database was left without its tables"


def test_f_an_init_that_fails_is_not_remembered(db_path):
    conn = get_conn()
    conn.execute("PRAGMA query_only = ON")
    with pytest.raises(sqlite3.OperationalError):
        init_schema()
    assert dbmod._SCHEMA_READY == {}
    conn.execute("PRAGMA query_only = OFF")
    init_schema()
    assert REQUIRED_TABLES <= tables(get_conn())


@pytest.mark.xfail(strict=True, reason='Theoretical: needs another writer to change the schema inside the init lock window.')
def test_f_schema_change_between_ddl_and_recording_is_not_baked_into_the_remembered_version(db_path, monkeypatch):
    """Theoretical: another writer changes the schema after our DDL finished but before the version is read for
    the skip record. The record must not claim a schema it never checked."""
    real = dbmod._schema_version
    calls = {"n": 0}

    def sneaky(conn):
        calls["n"] += 1
        if calls["n"] == 2:
            other = sqlite3.connect(str(db_path), isolation_level=None, timeout=10)
            other.execute("DROP TABLE cron_runs")
            other.close()
        return real(conn)

    monkeypatch.setattr(dbmod, "_schema_version", sneaky)
    init_schema()
    monkeypatch.setattr(dbmod, "_schema_version", real)
    init_schema()
    assert "cron_runs" in tables(get_conn())


def test_f_memory_databases_get_their_schema_on_every_thread():
    set_custom_db_path(Path(":memory:"))
    results, errors = {}, []

    def work(index):
        try:
            init_schema()
            init_schema()
            conn = get_conn()
            results[index] = REQUIRED_TABLES <= tables(conn)
            conn.execute("INSERT INTO schema_version(version) VALUES (?)", (100 + index,))
            close_conn(cancel_timers=False)
        except BaseException as exc:  # pragma: no cover
            errors.append(repr(exc))

    try:
        for round_number in range(4):
            threads = [threading.Thread(target=work, args=(round_number * 10 + i,)) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        assert not errors, errors
        assert len(results) == 24 and all(results.values())
    finally:
        set_custom_db_path(None)


def test_f_memory_database_reconnected_after_close_gets_a_fresh_schema():
    set_custom_db_path(Path(":memory:"))
    try:
        for _ in range(30):
            init_schema()
            assert REQUIRED_TABLES <= tables(get_conn())
            close_conn(cancel_timers=False)
    finally:
        set_custom_db_path(None)


def test_f_switching_databases_back_and_forth_keeps_both_complete(tmp_path):
    first, second = tmp_path / "one.db", tmp_path / "two.db"
    try:
        for _ in range(3):
            for path in (first, second, first):
                set_custom_db_path(path)
                init_schema()
                init_schema()
                assert REQUIRED_TABLES <= tables(get_conn())
        set_custom_db_path(first)
        get_conn().execute("DROP TABLE cron_runs")
        set_custom_db_path(second)
        init_schema()
        set_custom_db_path(first)
        init_schema()
        assert "cron_runs" in tables(get_conn())
    finally:
        set_custom_db_path(None)


def test_f_one_initialised_database_does_not_vouch_for_another_with_the_same_version(tmp_path):
    first, second = tmp_path / "one.db", tmp_path / "two.db"
    try:
        set_custom_db_path(first)
        init_schema()
        version = int(get_conn().execute("PRAGMA schema_version").fetchone()[0])
        close_conn()
        other = sqlite3.connect(str(second), isolation_level=None)
        other.execute("CREATE TABLE only_this(x)")
        other.execute(f"PRAGMA schema_version = {version}")
        other.close()
        dbmod._CUSTOM_DB_PATH = second
        init_schema()
        assert REQUIRED_TABLES <= tables(get_conn())
    finally:
        set_custom_db_path(None)


def test_f_concurrent_first_init_from_many_threads_on_one_file(db_path):
    errors, barrier = [], threading.Barrier(12)

    def work():
        try:
            barrier.wait(10)
            for _ in range(15):
                init_schema()
                assert REQUIRED_TABLES <= tables(get_conn())
            close_conn(cancel_timers=False)
        except BaseException as exc:  # pragma: no cover
            errors.append(repr(exc))

    threads = [threading.Thread(target=work) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert not errors, errors[:3]


def test_f_concurrent_init_while_another_thread_alters_the_schema(db_path):
    init_schema()
    errors, stop = [], threading.Event()

    def reader():
        try:
            while not stop.is_set():
                init_schema()
                conn = get_conn()
                conn.execute("SELECT COUNT(*) FROM sessions").fetchone()
        except BaseException as exc:  # pragma: no cover
            errors.append(repr(exc))

    def vandal():
        try:
            other = sqlite3.connect(str(db_path), isolation_level=None, timeout=10)
            for _ in range(40):
                try:
                    other.execute("ALTER TABLE cron_runs DROP COLUMN blocked_tools")
                except sqlite3.OperationalError:
                    pass
                time.sleep(0.005)
            other.close()
        except BaseException as exc:  # pragma: no cover
            errors.append(repr(exc))

    threads = [threading.Thread(target=reader) for _ in range(4)]
    for t in threads:
        t.start()
    v = threading.Thread(target=vandal)
    v.start()
    v.join(30)
    stop.set()
    for t in threads:
        t.join(30)
    assert not errors, errors[:3]
    init_schema()
    assert "blocked_tools" in columns(get_conn(), "cron_runs")


def test_f_legacy_schema_without_new_columns_is_upgraded_and_data_survives(db_path):
    legacy = sqlite3.connect(str(db_path), isolation_level=None)
    legacy.executescript("""
        CREATE TABLE sessions (id TEXT PRIMARY KEY, project_hash TEXT NOT NULL, project_path TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'new-session', status TEXT NOT NULL DEFAULT 'idle',
            provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
            token_total INTEGER NOT NULL DEFAULT 0, context_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0.0, cost_source TEXT NOT NULL DEFAULT 'unpriced',
            usage_breakdown TEXT NOT NULL DEFAULT '{}', plan TEXT, parent_session TEXT, branch_point TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE session_messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
            content TEXT, tool_calls TEXT, thinking TEXT, name TEXT, tool_call_id TEXT, ts TEXT NOT NULL,
            PRIMARY KEY (session_id, seq));
        CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, name TEXT NOT NULL,
            prompt TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE cron_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, job_name TEXT NOT NULL,
            started_at TEXT NOT NULL);
        INSERT INTO sessions(id, project_hash, project_path, created_at, updated_at)
            VALUES ('s1', 'h', '/p', '2020-01-01', '2020-01-01');
        INSERT INTO session_messages(session_id, seq, role, content, ts) VALUES ('s1', 0, 'user', 'kept', 't');
    """)
    legacy.close()
    init_schema()
    conn = get_conn()
    assert REQUIRED_TABLES <= tables(conn)
    for column in ("session_metadata", "allowed_commands", "allowed_domains", "undo_stack"):
        assert column in columns(conn, "sessions"), column
    for column in ("images", "duration", "turn_id", "steering", "turn_key", "model"):
        assert column in columns(conn, "session_messages"), column
    assert "lease_owner" in columns(conn, "cron_jobs") and "blocked_tools" in columns(conn, "cron_runs")
    assert conn.execute("SELECT content FROM session_messages WHERE session_id='s1'").fetchone()[0] == "kept"
    assert ddl_statements(conn, init_schema) == []


def test_f_init_inside_an_open_transaction_is_untouched(db_path):
    init_schema()
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DROP TABLE cron_runs")
        init_schema()
        assert conn.in_transaction, "init_schema must not commit a caller's transaction"
    finally:
        conn.execute("ROLLBACK")
    assert "cron_runs" in tables(conn)


def test_f_dropped_table_in_the_same_connection_is_recreated(db_path):
    init_schema()
    get_conn().execute("DROP TABLE mcp_server_status")
    init_schema()
    assert "mcp_server_status" in tables(get_conn())


# ---------------------------------------------------------------------------
# G. read_mcp_servers / load_config
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _fresh_reported_errors():
    mcpmod._REPORTED_CONFIG_ERRORS.clear()
    yield
    mcpmod._REPORTED_CONFIG_ERRORS.clear()


def write(path: Path, data, encoding="utf-8"):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data, encoding=encoding)
    return path


def warnings_for(caplog):
    return [r for r in caplog.records if r.name == "andromity.core.mcp" and r.levelno >= logging.WARNING]


@pytest.mark.parametrize("text", ["", " ", "\n", "\r\n\r\n", "\t \n  "])
def test_g_empty_or_whitespace_file_declares_nothing_and_is_silent(tmp_path, caplog, text):
    path = write(tmp_path / "mcp.json", text)
    with caplog.at_level(logging.DEBUG, logger="andromity.core.mcp"):
        assert read_mcp_servers(path) == {}
        assert read_mcp_servers(path) == {}
    assert not [r for r in caplog.records if r.name == "andromity.core.mcp"]


def test_g_invalid_json_warns_once_per_version_then_drops_to_debug(tmp_path, caplog):
    path = write(tmp_path / "mcp.json", "{not json")
    with caplog.at_level(logging.DEBUG, logger="andromity.core.mcp"):
        for _ in range(6):
            assert read_mcp_servers(path) == {}
        assert len(warnings_for(caplog)) == 1
        assert len([r for r in caplog.records if r.levelno == logging.DEBUG]) == 5
        write(path, "{still not json, longer")
        assert read_mcp_servers(path) == {}
        assert len(warnings_for(caplog)) == 2


def test_g_two_different_broken_files_each_warn(tmp_path, caplog):
    first, second = write(tmp_path / "a" / "mcp.json", "{x"), write(tmp_path / "b" / "mcp.json", "{x")
    with caplog.at_level(logging.WARNING, logger="andromity.core.mcp"):
        read_mcp_servers(first)
        read_mcp_servers(second)
        read_mcp_servers(first)
    assert len(warnings_for(caplog)) == 2


def test_g_repairing_the_file_returns_its_servers(tmp_path):
    path = write(tmp_path / "mcp.json", "{broken")
    assert read_mcp_servers(path) == {}
    write(path, json.dumps({"mcpServers": {"a": {"command": "x"}}}))
    assert read_mcp_servers(path) == {"a": {"command": "x"}}


@pytest.mark.parametrize("document", [
    "[]", "[1,2]", '"text"', "5", "null", "true", '{"mcpServers": []}', '{"mcpServers": "x"}',
    '{"mcpServers": 5}', '{"servers": []}', '{"servers": "x"}', '{"mcpServers": null, "servers": null}', "{}",
    '{"mcpServers": {}}', '{"other": {"a": {"command": "x"}}}',
])
def test_g_unusable_shapes_yield_nothing_without_warning(tmp_path, caplog, document):
    path = write(tmp_path / "mcp.json", document)
    with caplog.at_level(logging.DEBUG, logger="andromity.core.mcp"):
        assert read_mcp_servers(path) == {}
    assert not warnings_for(caplog)


def test_g_non_dict_server_entries_are_dropped_and_dict_entries_kept(tmp_path):
    entries = {"ok": {"command": "x"}, "none": None, "list": [], "str": "cmd", "num": 3, "true": True,
               "empty": {}, "nested": {"command": {"deep": [1, 2]}}}
    path = write(tmp_path / "mcp.json", json.dumps({"mcpServers": entries}))
    assert read_mcp_servers(path) == {"ok": {"command": "x"}, "empty": {}, "nested": {"command": {"deep": [1, 2]}}}


def test_g_mcp_servers_key_wins_over_servers_unless_empty(tmp_path):
    path = write(tmp_path / "a.json", json.dumps({"mcpServers": {"a": {"command": "1"}}, "servers": {"b": {"command": "2"}}}))
    assert list(read_mcp_servers(path)) == ["a"]
    path = write(tmp_path / "b.json", json.dumps({"mcpServers": {}, "servers": {"b": {"command": "2"}}}))
    assert list(read_mcp_servers(path)) == ["b"]


def test_g_missing_file_and_directory_and_broken_symlink(tmp_path, caplog):
    assert read_mcp_servers(tmp_path / "nope.json") == {}
    directory = tmp_path / "dir.json"
    directory.mkdir()
    assert read_mcp_servers(directory) == {}
    link = tmp_path / "link.json"
    try:
        link.symlink_to(tmp_path / "missing-target.json")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks need privileges on this platform")
    assert read_mcp_servers(link) == {}
    assert not warnings_for(caplog)


def test_g_symlink_to_a_valid_file_is_followed(tmp_path):
    target = write(tmp_path / "real.json", json.dumps({"mcpServers": {"a": {"command": "x"}}}))
    link = tmp_path / "link.json"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks need privileges on this platform")
    assert read_mcp_servers(link) == {"a": {"command": "x"}}


@pytest.mark.parametrize("failing", ["read_text", "stat", "is_file"])
def test_g_os_errors_yield_nothing(tmp_path, monkeypatch, failing):
    path = write(tmp_path / "mcp.json", json.dumps({"mcpServers": {"a": {"command": "x"}}}))

    def deny(self, *args, **kwargs):
        raise PermissionError(13, "denied")

    monkeypatch.setattr(Path, failing, deny)
    assert read_mcp_servers(path) == {}


def test_g_file_removed_between_checks_is_not_an_error(tmp_path, monkeypatch):
    path = write(tmp_path / "mcp.json", json.dumps({"mcpServers": {"a": {"command": "x"}}}))
    real_stat = Path.stat

    def vanishing(self, *args, **kwargs):
        if self == path:
            os.remove(path)
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", vanishing)
    assert read_mcp_servers(path) == {}


def test_g_file_replaced_between_stat_and_read_returns_one_consistent_version(tmp_path, monkeypatch):
    path = write(tmp_path / "mcp.json", "{broken")
    real_read = Path.read_text

    def swapped(self, *args, **kwargs):
        if self == path:
            path.write_text(json.dumps({"mcpServers": {"new": {"command": "x"}}}), encoding="utf-8")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", swapped)
    assert read_mcp_servers(path) == {"new": {"command": "x"}}


def test_g_utf8_bom_file_is_read(tmp_path):
    """Windows editors (older Notepad, PowerShell 5 Out-File -Encoding utf8) write a UTF-8 BOM."""
    path = write(tmp_path / "mcp.json", b"\xef\xbb\xbf" + json.dumps({"mcpServers": {"a": {"command": "x"}}}).encode())
    assert read_mcp_servers(path) == {"a": {"command": "x"}}


def test_g_bom_only_file_counts_as_empty_and_is_silent(tmp_path, caplog):
    path = write(tmp_path / "mcp.json", b"\xef\xbb\xbf")
    with caplog.at_level(logging.DEBUG, logger="andromity.core.mcp"):
        assert read_mcp_servers(path) == {}
    assert not warnings_for(caplog)


@pytest.mark.parametrize("encoding", ["utf-16", "utf-16-le", "utf-16-be", "cp1252", "latin-1"])
def test_g_non_utf8_file_does_not_raise(tmp_path, encoding):
    """PowerShell 5 `>` redirection writes UTF-16 LE with a BOM; cp1252 happens with pasted smart quotes.
    dev logged a warning and carried on."""
    body = json.dumps({"mcpServers": {"café": {"command": "x"}}}, ensure_ascii=False)
    path = write(tmp_path / "mcp.json", body.encode(encoding))
    result = read_mcp_servers(path)
    assert isinstance(result, dict)


def test_g_non_utf8_file_does_not_break_load_config(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    project = tmp_path / "proj"
    write(project / ".andromity" / "mcp.json", '{"mcpServers": {"a": {"command": "x"}}}'.encode("utf-16"))
    write(project / ".vscode" / "mcp.json", json.dumps({"mcpServers": {"fallback": {"command": "y"}}}))
    config = MCPClientManager(str(project)).load_config()
    assert config["mcpServers"] == {"fallback": {"command": "y"}}


@pytest.mark.parametrize("depth", [2000, 100_000])
def test_g_deeply_nested_json_does_not_raise(tmp_path, depth):
    path = write(tmp_path / "mcp.json", "[" * depth + "]" * depth)
    assert read_mcp_servers(path) == {}
    path = write(tmp_path / "mcp2.json", '{"mcpServers": {"a": ' + "[" * depth + "]" * depth + "}}")
    assert read_mcp_servers(path) == {}


def test_g_deeply_nested_json_does_not_break_load_config(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    project = tmp_path / "proj"
    write(project / ".andromity" / "mcp.json", "[" * 100_000)
    write(project / ".vscode" / "mcp.json", json.dumps({"mcpServers": {"fallback": {"command": "y"}}}))
    assert MCPClientManager(str(project)).load_config()["mcpServers"] == {"fallback": {"command": "y"}}


def test_g_huge_file_is_read_in_reasonable_time(tmp_path):
    servers = {f"s{i}": {"command": "x", "args": ["a"] * 10} for i in range(60_000)}
    path = write(tmp_path / "mcp.json", json.dumps({"mcpServers": servers}))
    assert path.stat().st_size > 5_000_000
    started = time.perf_counter()
    result = read_mcp_servers(path)
    assert len(result) == 60_000 and time.perf_counter() - started < 10


def test_g_huge_whitespace_file_is_empty(tmp_path, caplog):
    path = write(tmp_path / "mcp.json", " " * 20_000_000)
    with caplog.at_level(logging.DEBUG, logger="andromity.core.mcp"):
        assert read_mcp_servers(path) == {}
    assert not warnings_for(caplog)


def test_g_unusual_but_valid_json_values(tmp_path):
    path = write(tmp_path / "mcp.json",
                 '{"mcpServers": {"a": {"command": NaN, "n": Infinity}, "b": {"command": "x", "command": "dup"}}}')
    result = read_mcp_servers(path)
    assert set(result) == {"a", "b"} and result["b"] == {"command": "dup"}


@pytest.fixture
def layered(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    project = tmp_path / "proj"
    paths = {
        "home": home / ".andromity" / "mcp.json",
        "gemini": home / ".gemini" / "config" / "mcp_config.json",
        "project": project / ".andromity" / "mcp.json",
        "vscode": project / ".vscode" / "mcp.json",
    }
    return project, paths


def test_g_load_config_merges_first_file_wins(layered):
    project, paths = layered
    write(paths["home"], json.dumps({"mcpServers": {"shared": {"command": "home"}, "h": {"command": "h"}}}))
    write(paths["gemini"], json.dumps({"mcpServers": {"shared": {"command": "gemini"}, "g": {"command": "g"}}}))
    write(paths["project"], json.dumps({"servers": {"shared": {"command": "project"}, "p": {"command": "p"}}}))
    write(paths["vscode"], json.dumps({"servers": {"shared": {"command": "vscode"}, "v": {"command": "v"}}}))
    merged = MCPClientManager(str(project)).load_config()["mcpServers"]
    assert merged["shared"] == {"command": "home"}
    assert list(merged) == ["shared", "h", "g", "p", "v"]


def test_g_a_broken_or_empty_layer_does_not_hide_later_layers(layered, caplog):
    project, paths = layered
    write(paths["home"], "")
    write(paths["gemini"], "{broken")
    write(paths["project"], "[]")
    write(paths["vscode"], json.dumps({"servers": {"v": {"command": "v"}}}))
    with caplog.at_level(logging.WARNING, logger="andromity.core.mcp"):
        merged = MCPClientManager(str(project)).load_config()["mcpServers"]
        MCPClientManager(str(project)).load_config()
    assert merged == {"v": {"command": "v"}}
    assert len(warnings_for(caplog)) == 1


def test_g_a_non_dict_entry_in_an_earlier_layer_does_not_shadow_a_later_dict(layered):
    project, paths = layered
    write(paths["home"], json.dumps({"mcpServers": {"a": "oops", "b": None}}))
    write(paths["project"], json.dumps({"mcpServers": {"a": {"command": "real"}, "b": {"command": "b"}}}))
    assert MCPClientManager(str(project)).load_config()["mcpServers"] == {"a": {"command": "real"}, "b": {"command": "b"}}


def test_g_load_config_never_raises_for_any_layer_content(layered):
    project, paths = layered
    hostile = [b"", b"\x00\x00\x00", b"\xff\xfe", b"{" * 5000, b"\xef\xbb\xbf{}", "é".encode("cp1252"),
               b'{"mcpServers": {"a": 1}}', b"[" * 100_000]
    for layer, content in zip(paths.values(), hostile):
        write(layer, content)
    result = MCPClientManager(str(project)).load_config()
    assert set(result) == {"mcpServers"} and isinstance(result["mcpServers"], dict)


@pytest.mark.asyncio
async def test_g_mcp_list_still_shows_valid_layers_when_one_layer_is_not_utf8(layered):
    from andromity.server.rpc_handler import JsonRpcHandler
    project, paths = layered
    write(paths["project"], '{"mcpServers": {"a": {"command": "x"}}}'.encode("utf-16"))
    write(paths["vscode"], json.dumps({"servers": {"fallback": {"command": "y"}}}))
    handler = JsonRpcHandler(send_notification=lambda n: None)
    handler._mcp_manager = None
    from andromity.core import tools
    tools._mcp_manager = None
    try:
        result = await handler.rpc_mcp_list({"project_path": str(project)})
        task = next(iter(list(handler._mcp_start_tasks.values())), None)
        if task is not None:
            task.cancel()
            await __import__("asyncio").gather(task, return_exceptions=True)
    finally:
        tools._mcp_manager = None
    assert [r["name"] for r in result] == ["fallback"]
