"""One-time import of legacy session snapshots into SQLite."""
import threading
from datetime import datetime, timezone

from andromity.core.debug_log import get_logger

log = get_logger("session_migration")
_IMPORT_LOCK = threading.RLock()
_MIGRATION_NAME = "session-json-to-sqlite-v2"


def migrate_legacy_sessions() -> int:
    """Import once per database, preserving existing rows and source files."""
    from andromity.core.db import get_conn, init_schema, j, transaction, uj
    from andromity.core.session import Session, get_config_dir

    init_schema()
    conn = get_conn()
    if conn.execute(
        "SELECT 1 FROM storage_migrations WHERE name = ?", (_MIGRATION_NAME,)
    ).fetchone():
        return 0
    imported = 0
    with _IMPORT_LOCK, transaction(conn):
        if conn.execute(
            "SELECT 1 FROM storage_migrations WHERE name = ?", (_MIGRATION_NAME,)
        ).fetchone():
            return 0
        root = (get_config_dir() / "sessions").resolve()
        if root.exists():
            for directory in root.iterdir():
                if not directory.is_dir() or not directory.resolve().is_relative_to(root):
                    continue
                for path in directory.glob("*.json"):
                    if not path.resolve().is_relative_to(root):
                        continue
                    try:
                        session = Session.load(path)
                    except (OSError, ValueError, KeyError, TypeError, AttributeError):
                        log.warning("Skipped an unreadable legacy session snapshot; the original file was preserved.")
                        continue
                    row = conn.execute(
                        "SELECT session_metadata, updated_at FROM sessions WHERE id = ?",
                        (session.id,),
                    ).fetchone()
                    if row is None:
                        session._save_to_db()
                        imported += 1
                    elif not uj(row["session_metadata"], {}) and row["updated_at"] == session.updated_at:
                        conn.execute(
                            "UPDATE sessions SET session_metadata = ? WHERE id = ?",
                            (j(session._session_metadata()), session.id),
                        )
        conn.execute(
            "INSERT INTO storage_migrations (name, completed_at) VALUES (?, ?)",
            (_MIGRATION_NAME, datetime.now(timezone.utc).isoformat()),
        )
    return imported
