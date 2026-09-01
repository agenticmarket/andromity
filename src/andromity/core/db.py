"""andromity.core.db — SQLite database engine with WAL mode and connection pooling."""
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Generator, List, Optional

from andromity.config import get_config_dir

_local = threading.local()
_CUSTOM_DB_PATH: Optional[Path] = None
_INIT_LOCK = threading.Lock()
_SCHEMA_INITIALIZED = False


def set_custom_db_path(path: Optional[Path]) -> None:
    """Override database path (used in unit tests)."""
    global _CUSTOM_DB_PATH, _SCHEMA_INITIALIZED
    _CUSTOM_DB_PATH = path
    _SCHEMA_INITIALIZED = False
    close_conn()


def close_conn() -> None:
    """Close the current thread's database connection if open."""
    if hasattr(_local, "conn") and _local.conn is not None:
        try:
            _local.conn.close()
        except Exception:
            pass
        _local.conn = None


def get_db_path() -> Path:
    """Return the absolute path to andromity.db."""
    if _CUSTOM_DB_PATH is not None:
        return _CUSTOM_DB_PATH
    import andromity.config
    config_dir = andromity.config.get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir / "andromity.db"


def get_conn() -> sqlite3.Connection:
    """Return a thread-local SQLite connection with WAL mode and row factory."""
    db_path = get_db_path()
    current_path = getattr(_local, "conn_path", None)
    if not hasattr(_local, "conn") or _local.conn is None or current_path != db_path:
        close_conn()
        if str(db_path) != ":memory:":
            db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(
            str(db_path),
            timeout=5.0,
            check_same_thread=False,
            isolation_level=None,  # Autocommit mode; explicit BEGIN/COMMIT via transaction()
        )
        conn.row_factory = sqlite3.Row
        
        # High performance & safety PRAGMAs
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA cache_size = -32000;")  # 32MB page cache
        conn.execute("PRAGMA temp_store = MEMORY;")
        _local.conn = conn
        _local.conn_path = db_path
    return _local.conn


def init_schema() -> None:
    """Execute DDL schema to ensure all tables and indexes exist."""
    global _SCHEMA_INITIALIZED
    with _INIT_LOCK:
        conn = get_conn()
        schema_path = Path(__file__).parent / "schema.sql"
        if schema_path.exists():
            schema_sql = schema_path.read_text(encoding="utf-8")
        else:
            # Fallback embedded schema if bundled without separate .sql file
            schema_sql = """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, project_hash TEXT NOT NULL, project_path TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT 'new-session', status TEXT NOT NULL DEFAULT 'idle',
                provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
                token_total INTEGER NOT NULL DEFAULT 0, context_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0.0, cost_source TEXT NOT NULL DEFAULT 'unpriced',
                usage_breakdown TEXT NOT NULL DEFAULT '{}', plan TEXT, compacted_history TEXT NOT NULL DEFAULT '[]',
                parent_session TEXT, branch_point TEXT, sync_dirty INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_hash, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
            CREATE TABLE IF NOT EXISTS session_messages (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT,
                thinking TEXT, name TEXT, tool_call_id TEXT, ts TEXT NOT NULL,
                PRIMARY KEY (session_id, seq)
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON session_messages(session_id, seq ASC);
            CREATE TABLE IF NOT EXISTS session_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
                ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS cron_jobs (
                id TEXT PRIMARY KEY, project_path TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
                schedule TEXT NOT NULL DEFAULT 'every 1h', interval_seconds INTEGER NOT NULL DEFAULT 3600,
                provider TEXT NOT NULL DEFAULT 'anthropic', model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
                mode TEXT NOT NULL DEFAULT 'trust', allowed_commands TEXT NOT NULL DEFAULT '[]',
                on_failure TEXT NOT NULL DEFAULT 'retry', retry_delay_seconds INTEGER NOT NULL DEFAULT 0,
                timeout_seconds INTEGER NOT NULL DEFAULT 600, enabled INTEGER NOT NULL DEFAULT 1,
                last_run TEXT, last_status TEXT NOT NULL DEFAULT 'never', last_error TEXT,
                run_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cron_jobs_project ON cron_jobs(project_path);
            CREATE TABLE IF NOT EXISTS cron_runs (
                id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
                job_name TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
                duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'running',
                prompt TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
                session_id TEXT, output TEXT NOT NULL DEFAULT '', output_preview TEXT NOT NULL DEFAULT '',
                tools_used TEXT NOT NULL DEFAULT '[]', files_modified TEXT NOT NULL DEFAULT '[]',
                tool_executions TEXT NOT NULL DEFAULT '[]', error TEXT, error_traceback TEXT, cost_usd REAL NOT NULL DEFAULT 0.0
            );
            CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at DESC);
            CREATE TABLE IF NOT EXISTS mcp_server_status (
                name TEXT NOT NULL, project_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown',
                tools_count INTEGER NOT NULL DEFAULT 0, error TEXT, error_detail TEXT, updated_at TEXT NOT NULL,
                started_at TEXT, PRIMARY KEY (name, project_path)
            );
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            INSERT OR IGNORE INTO schema_version(version) VALUES (1);
            """
        conn.executescript(schema_sql)
        _SCHEMA_INITIALIZED = True


@contextmanager
def transaction(conn: Optional[sqlite3.Connection] = None) -> Generator[sqlite3.Connection, None, None]:
    """Execute operations inside an explicit BEGIN IMMEDIATE / COMMIT transaction block."""
    connection = conn or get_conn()
    connection.execute("BEGIN IMMEDIATE;")
    try:
        yield connection
        connection.execute("COMMIT;")
    except Exception:
        connection.execute("ROLLBACK;")
        raise


def j(value: Any) -> str:
    """Serialize value to compact JSON string."""
    if value is None:
        return ""
    try:
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    except Exception:
        return "{}"


def uj(text: Optional[str], default: Any = None) -> Any:
    """Deserialize JSON string with fallback default."""
    if not text:
        return default if default is not None else {}
    try:
        return json.loads(text)
    except Exception:
        return default if default is not None else {}
