import copy
import json
import os
import uuid
import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional
import sqlite3
import re

from andromity.config import get_config_dir


def _validate_session_id(session_id: str) -> str:
    """Validate and sanitize session_id to prevent directory traversal."""
    if not session_id or not isinstance(session_id, str):
        raise ValueError("session_id must be a non-empty string")
    clean_id = session_id.strip()
    # Allow alphanumeric characters, hyphens, and underscores (1 to 64 chars)
    if not re.fullmatch(r"[a-zA-Z0-9_\-]{1,64}", clean_id):
        raise ValueError(f"Invalid session_id format: {session_id!r}")
    return clean_id


def normalize_project_path(project_path: Optional[str] = None) -> str:
    """Normalize project path across operating systems and casing (Windows drive letters)."""
    p = Path(project_path or Path.cwd()).resolve()
    s = str(p)
    if os.name == "nt" and len(s) >= 2 and s[1] == ":":
        s = s[0].upper() + s[1:]
    return s


class Session:
    def __init__(
        self,
        name: str = "new-session",
        project_path: Optional[str] = None,
        session_id: Optional[str] = None,
        id: Optional[str] = None,
    ):
        actual_id = session_id or id
        self.id = _validate_session_id(actual_id) if actual_id else str(uuid.uuid4())
        self.name = name
        self.status = "idle"  # 'idle' | 'running' | 'approval_required' | 'compacting' | 'error' | 'cancelled'
        self.project_path = normalize_project_path(project_path)
        self.project_hash = hashlib.sha256(self.project_path.encode()).hexdigest()[:16]
        self.parent_session = None
        self.branch_point = None
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.updated_at = self.created_at
        self.messages: List[Dict[str, Any]] = []
        self.token_total = 0
        # Latest request input size, used for context-window decisions. This
        # is intentionally separate from token_total, which is cumulative
        # billed usage across the session.
        self.context_tokens = 0
        self.cost_usd = 0.0
        self.usage_breakdown: Dict[str, int] = {
            "prompt_tokens": 0, "completion_tokens": 0,
            "cached_tokens": 0, "reasoning_tokens": 0,
        }
        self.cost_source = "unpriced"
        self.plan: Optional[Dict[str, Any]] = None  # session-scoped plan
        self.compacted_history: List[Dict[str, Any]] = []  # old messages preserved for chat UI after compaction
        from andromity.config import config
        self.provider = config.get("default", "provider", "")
        self.model = config.get("default", "model", "")
        sessions_root = get_config_dir() / "sessions"
        sessions_root.mkdir(parents=True, exist_ok=True)
        sessions_root = sessions_root.resolve()
        self.storage_dir = sessions_root / self.project_hash
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.storage_dir = self.storage_dir.resolve()
        self.file_path = self.storage_dir / f"{self.id}.json"
        self._save_timer: Optional[threading.Timer] = None
        self._save_lock = threading.RLock()
        self._dirty = False

    def set_status(self, status: str):
        """Update live lifecycle status of this session."""
        self.status = status
        self._save_to_db()

    def _mark_dirty(self, delay: float = 1.5):
        """Schedule a debounced write to avoid synchronous disk thrashing on rapid appends."""
        with getattr(self, "_save_lock", None) or threading.RLock():
            if not hasattr(self, "_save_lock"):
                self._save_lock = threading.RLock()
            self._dirty = True
            if getattr(self, "_save_timer", None) is not None:
                try:
                    self._save_timer.cancel()
                except Exception:
                    pass
            t = threading.Timer(delay, self._flush_save)
            t.daemon = True
            self._save_timer = t
            t.start()

    def _flush_save(self):
        with getattr(self, "_save_lock", None) or threading.RLock():
            if getattr(self, "_dirty", False):
                self._dirty = False
                self._save_timer = None
                # Snapshot under lock, then serialize+write outside the lock
                # so the main thread (and Textual event loop) are never blocked.
                self._save_snapshot()

    def flush(self):
        """Immediately write any pending debounced save to disk."""
        with getattr(self, "_save_lock", None) or threading.RLock():
            if getattr(self, "_save_timer", None) is not None:
                try:
                    self._save_timer.cancel()
                except Exception:
                    pass
                self._save_timer = None
            if getattr(self, "_dirty", False):
                self._dirty = False
                self.save()

    def add_message(self, role: str, content: Optional[str] = None,
                    tool_calls: Optional[List[Dict]] = None,
                    name: Optional[str] = None, tool_call_id: Optional[str] = None,
                    thinking: Optional[str] = None):
        msg: Dict[str, Any] = {"role": role, "ts": datetime.now(timezone.utc).isoformat()}
        if content is not None:
            msg["content"] = content
        if tool_calls is not None:
            msg["tool_calls"] = tool_calls
        if thinking is not None:
            msg["thinking"] = thinking
        if name is not None:
            msg["name"] = name
        if tool_call_id is not None:
            msg["tool_call_id"] = tool_call_id
        self.messages.append(msg)
        if not self.file_path.exists():
            self.save()
        else:
            self._mark_dirty()

    def update_usage(self, usage: Dict[str, int], model: str = ""):
        from andromity.core.pricing import calculate_cost
        from andromity.core.usage import normalize_usage
        usage = normalize_usage(usage, usage.get("usage_source", "provider"))
        self.token_total += usage.get("total_tokens", 0)
        self.context_tokens = usage.get("prompt_tokens", 0)
        for key in self.usage_breakdown:
            self.usage_breakdown[key] += usage.get(key, 0)
        if model and "/" in model:
            provider, mdl = model.split("/", 1)
            self.provider = provider
            self.model = mdl
        provider = self.provider
        mdl = self.model
        result = calculate_cost(usage, provider, mdl)
        self.cost_usd += result.usd
        self.cost_source = result.source if self.cost_source in ("unpriced", result.source) else "mixed"
        self._mark_dirty()

    def to_dict(self, snapshot: bool = False) -> Dict[str, Any]:
        """Return a serializable dict of the session."""
        msgs = copy.deepcopy(self.messages) if snapshot else self.messages
        return {
            "id": self.id, "name": self.name, "project": self.project_hash,
            "project_path": self.project_path,
            "status": getattr(self, "status", "idle"),
            "parent_session": self.parent_session, "branch_point": self.branch_point,
            "created_at": self.created_at, "updated_at": self.updated_at, "messages": msgs,
            "token_total": self.token_total, "cost_usd": self.cost_usd,
            "context_tokens": self.context_tokens,
            "usage_breakdown": dict(self.usage_breakdown), "cost_source": self.cost_source,
            "provider": getattr(self, "provider", ""),
            "model": getattr(self, "model", ""),
            "plan": copy.deepcopy(self.plan) if snapshot and self.plan else self.plan,
            "compacted_history": self.compacted_history if not snapshot else copy.deepcopy(self.compacted_history),
        }

    def compact_messages(self, new_summary: str, keep_last_n: int = 10) -> int:
        """Replace older messages with a summary to free up context.
        Returns the number of messages removed.
        """
        if len(self.messages) <= keep_last_n + 1:
            return 0
            
        system_msg = self.messages[0]
        compacted_away = self.messages[1:-keep_last_n]
        recent_msgs = self.messages[-keep_last_n:]
        
        # Preserve compacted messages for chat UI history replay
        if not hasattr(self, "compacted_history") or self.compacted_history is None:
            self.compacted_history = []
        self.compacted_history.extend(compacted_away)

        summary_msg = {
            "role": "user",
            "content": f"[Conversation summary of earlier turns]:\n{new_summary}"
        }
        ack_msg = {
            "role": "assistant",
            "content": "Understood. I have the context of our earlier discussion and will continue from here."
        }
        
        removed_count = len(compacted_away)
        self.messages = [system_msg, summary_msg, ack_msg] + recent_msgs
        self.context_tokens = 0  # Force recalculation of the next prompt size
        self.save()
        return removed_count

    # ── Plan helpers (session-scoped) ────────────────────────────────────────

    def save_plan(self, plan_dict: Dict[str, Any]):
        """Store plan in session and persist."""
        self.plan = plan_dict
        self.save()

    def load_plan_obj(self):
        """Return a Plan object from session data, or None."""
        if not self.plan:
            return None
        from andromity.core.planner import Plan
        return Plan.from_dict(self.plan, self.project_path)

    def clear_plan(self):
        """Remove plan from session and persist."""
        self.plan = None
        self.save()

    def _save_to_db(self):
        """Persist session and messages into SQLite database."""
        try:
            from andromity.core.db import get_conn, init_schema, j, transaction
            init_schema()
            conn = get_conn()
            with transaction(conn):
                # 1. Upsert session row
                conn.execute("""
                    INSERT INTO sessions (
                        id, project_hash, project_path, name, status,
                        provider, model, token_total, context_tokens,
                        cost_usd, cost_source, usage_breakdown, plan,
                        compacted_history, parent_session, branch_point,
                        sync_dirty, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        project_hash = excluded.project_hash,
                        project_path = excluded.project_path,
                        name = excluded.name,
                        status = excluded.status,
                        provider = excluded.provider,
                        model = excluded.model,
                        token_total = excluded.token_total,
                        context_tokens = excluded.context_tokens,
                        cost_usd = excluded.cost_usd,
                        cost_source = excluded.cost_source,
                        usage_breakdown = excluded.usage_breakdown,
                        plan = excluded.plan,
                        compacted_history = excluded.compacted_history,
                        parent_session = excluded.parent_session,
                        branch_point = excluded.branch_point,
                        sync_dirty = 1,
                        updated_at = excluded.updated_at
                """, (
                    self.id, self.project_hash, self.project_path, self.name, getattr(self, "status", "idle"),
                    getattr(self, "provider", ""), getattr(self, "model", ""),
                    self.token_total, self.context_tokens, self.cost_usd, self.cost_source,
                    j(self.usage_breakdown), j(self.plan) if self.plan else None,
                    j(self.compacted_history), self.parent_session, self.branch_point,
                    self.created_at, self.updated_at
                ))

                # 2. Sync messages (insert or replace message sequence)
                count_row = conn.execute(
                    "SELECT COUNT(*) as c FROM session_messages WHERE session_id = ?", (self.id,)
                ).fetchone()
                db_count = count_row["c"] if count_row else 0

                if db_count > len(self.messages):
                    conn.execute("DELETE FROM session_messages WHERE session_id = ?", (self.id,))
                    start_idx = 0
                else:
                    start_idx = db_count

                if start_idx < len(self.messages):
                    rows_to_insert = [
                        (
                            self.id,
                            seq,
                            m.get("role", "user"),
                            m.get("content"),
                            j(m["tool_calls"]) if "tool_calls" in m else None,
                            m.get("thinking"),
                            m.get("name"),
                            m.get("tool_call_id"),
                            m.get("ts", self.updated_at)
                        )
                        for seq, m in enumerate(self.messages[start_idx:], start=start_idx)
                    ]
                    conn.executemany("""
                        INSERT OR REPLACE INTO session_messages (
                            session_id, seq, role, content, tool_calls,
                            thinking, name, tool_call_id, ts
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, rows_to_insert)
        except Exception:
            pass

    def _save_snapshot(self):
        """Snapshot state under lock, then persist to DB and JSON."""
        self.updated_at = datetime.now(timezone.utc).isoformat()
        self._save_to_db()
        data = self.to_dict(snapshot=True)
        self._write_json(data)

    def save(self):
        """Immediate, synchronous save."""
        with getattr(self, "_save_lock", None) or threading.Lock():
            if getattr(self, "_save_timer", None) is not None:
                try:
                    self._save_timer.cancel()
                except Exception:
                    pass
                self._save_timer = None
            self._dirty = False
        self.updated_at = datetime.now(timezone.utc).isoformat()
        self._save_to_db()
        data = self.to_dict(snapshot=True)
        self._write_json(data)

    def _write_json(self, data: Dict[str, Any]):
        """Atomic write: serialize to a temp file, then os.replace()."""
        num_msgs = len(data.get("messages", []))
        indent = 2 if num_msgs <= 50 else None
        separators = None if indent else (",", ":")
        tmp_path = self.file_path.with_suffix(".tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=indent, separators=separators)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            os.replace(str(tmp_path), str(self.file_path))
        except OSError:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
            with open(self.file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=indent, separators=separators)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass

    def rename(self, name: str):
        """Rename this session and persist."""
        self.name = name
        self.save()

    @staticmethod
    def auto_name_from_message(text: str) -> str:
        """Generate a session name from the first user message."""
        cleaned = text.strip().replace("\n", " ").replace("\r", "")
        if len(cleaned) > 55:
            cleaned = cleaned[:52] + "..."
        return cleaned or "New Session"

    @classmethod
    def _from_db_row(cls, row: sqlite3.Row, conn: Optional[sqlite3.Connection] = None) -> "Session":
        from andromity.core.db import get_conn, uj
        c = conn or get_conn()
        session = cls.__new__(cls)
        keys = row.keys() if hasattr(row, "keys") else []
        session.id = row["id"]
        session.name = row["name"]
        session.status = row["status"] if "status" in keys else "idle"
        session.project_hash = row["project_hash"]
        session.project_path = row["project_path"]
        session.parent_session = row["parent_session"]
        session.branch_point = row["branch_point"]
        session.created_at = row["created_at"]
        session.updated_at = row["updated_at"]
        session.provider = row["provider"]
        session.model = row["model"]
        session.token_total = row["token_total"]
        session.context_tokens = row["context_tokens"]
        session.cost_usd = row["cost_usd"]
        session.cost_source = row["cost_source"]
        session.usage_breakdown = uj(row["usage_breakdown"], {
            "prompt_tokens": 0, "completion_tokens": 0,
            "cached_tokens": 0, "reasoning_tokens": 0,
        })
        session.plan = uj(row["plan"], None) if row["plan"] else None
        session.compacted_history = uj(row["compacted_history"], []) if "compacted_history" in keys else []

        # Load messages
        msg_rows = c.execute(
            "SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC", (session.id,)
        ).fetchall()
        msgs = []
        for mr in msg_rows:
            mr_keys = mr.keys() if hasattr(mr, "keys") else []
            m: Dict[str, Any] = {"role": mr["role"], "ts": mr["ts"]}
            if mr["content"] is not None:
                m["content"] = mr["content"]
            if "tool_calls" in mr_keys and mr["tool_calls"]:
                m["tool_calls"] = uj(mr["tool_calls"], [])
            if "thinking" in mr_keys and mr["thinking"] is not None:
                m["thinking"] = mr["thinking"]
            if "name" in mr_keys and mr["name"] is not None:
                m["name"] = mr["name"]
            if "tool_call_id" in mr_keys and mr["tool_call_id"] is not None:
                m["tool_call_id"] = mr["tool_call_id"]
            msgs.append(m)
        session.messages = msgs

        # Path setup for JSON compatibility
        sessions_root = get_config_dir() / "sessions"
        session.storage_dir = sessions_root / session.project_hash
        session.file_path = session.storage_dir / f"{session.id}.json"
        session._save_timer = None
        session._save_lock = threading.RLock()
        session._dirty = False
        return session

    @classmethod
    def load(cls, file_path: Any) -> "Session":
        fp = Path(file_path)
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        session = cls.__new__(cls)
        session.id = data["id"]
        session.name = data["name"]
        session.status = data.get("status", "idle")
        session.project_hash = data["project"]
        session.project_path = data.get("project_path", "")
        session.parent_session = data.get("parent_session")
        session.branch_point = data.get("branch_point")
        session.created_at = data["created_at"]
        session.updated_at = data.get("updated_at", session.created_at)
        session.messages = data["messages"]
        session.token_total = data.get("token_total", 0)
        session.context_tokens = data.get("context_tokens", 0)
        if session.context_tokens == 0 and session.messages:
            try:
                from andromity.core.agent import _estimate_tokens
                session.context_tokens = _estimate_tokens(session.messages)
            except Exception:
                session.context_tokens = sum(
                    len(str(m.get("content", ""))) // 4 + len(str(m.get("thinking", ""))) // 4
                    for m in session.messages
                )
        session.cost_usd = data.get("cost_usd", 0.0)
        session.usage_breakdown = data.get("usage_breakdown", {
            "prompt_tokens": 0, "completion_tokens": 0,
            "cached_tokens": 0, "reasoning_tokens": 0,
        })
        session.cost_source = data.get("cost_source", "unpriced")
        session.provider = data.get("provider", "")
        session.model = data.get("model", "")
        session.plan = data.get("plan")
        session.compacted_history = data.get("compacted_history", [])
        session.storage_dir = fp.parent
        session.file_path = fp
        session._save_timer = None
        session._save_lock = threading.RLock()
        session._dirty = False
        return session

    @classmethod
    def list_sessions(cls, project_path: Optional[str] = None, limit: int = 100) -> List["Session"]:
        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()

        norm_path = normalize_project_path(project_path)
        primary_hash = hashlib.sha256(norm_path.encode()).hexdigest()[:16]

        hashes_to_check = {primary_hash}
        if project_path:
            raw_s = str(project_path)
            hashes_to_check.add(hashlib.sha256(raw_s.encode()).hexdigest()[:16])
            hashes_to_check.add(hashlib.sha256(raw_s.lower().encode()).hexdigest()[:16])
            hashes_to_check.add(hashlib.sha256(Path(project_path).resolve().as_posix().encode()).hexdigest()[:16])

        # 1. Query SQLite
        placeholders = ",".join("?" * len(hashes_to_check))
        rows = conn.execute(f"""
            SELECT * FROM sessions 
            WHERE project_hash IN ({placeholders})
            ORDER BY updated_at DESC
            LIMIT ?
        """, list(hashes_to_check) + [limit]).fetchall()

        if rows:
            return [cls._from_db_row(r, conn) for r in rows]

        # 2. Fallback & Auto-Migration from JSON files (for existing installs)
        sessions_root = get_config_dir() / "sessions"
        if not sessions_root.exists():
            return []

        session_files = []
        seen_ids = set()

        for h in hashes_to_check:
            p_dir = sessions_root / h
            if p_dir.exists() and p_dir.is_dir():
                for f in p_dir.glob("*.json"):
                    stem = f.stem
                    if stem not in seen_ids:
                        seen_ids.add(stem)
                        session_files.append(f)

        session_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        sessions = []
        for f in session_files[:limit]:
            try:
                s = cls.load(f)
                s._save_to_db()  # Auto-migrate to SQLite
                sessions.append(s)
            except Exception:
                continue

        sessions.sort(key=lambda s: getattr(s, "updated_at", s.created_at), reverse=True)
        return sessions

    @classmethod
    def load_by_id(cls, session_id: str, project_path: Optional[str] = None) -> Optional["Session"]:
        try:
            valid_id = _validate_session_id(session_id)
        except ValueError:
            return None

        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()

        # 1. Check SQLite
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (valid_id,)).fetchone()
        if row:
            return cls._from_db_row(row, conn)

        # 2. Check JSON fallback (existing/old session files)
        norm_path = normalize_project_path(project_path)
        primary_hash = hashlib.sha256(norm_path.encode()).hexdigest()[:16]

        hashes_to_check = [primary_hash]
        if project_path:
            raw_s = str(project_path)
            for h in [
                hashlib.sha256(raw_s.encode()).hexdigest()[:16],
                hashlib.sha256(raw_s.lower().encode()).hexdigest()[:16],
                hashlib.sha256(Path(project_path).resolve().as_posix().encode()).hexdigest()[:16],
            ]:
                if h not in hashes_to_check:
                    hashes_to_check.append(h)

        sessions_dir = (get_config_dir() / "sessions").resolve()
        for h in hashes_to_check:
            candidate = (sessions_dir / h / f"{valid_id}.json").resolve()
            if candidate.is_relative_to(sessions_dir) and candidate.exists():
                try:
                    s = cls.load(candidate)
                    s._save_to_db()  # Auto-migrate to SQLite
                    return s
                except Exception:
                    pass

        # Fallback: scan all project subdirectories under sessions
        if sessions_dir.exists():
            for p_dir in sessions_dir.iterdir():
                if p_dir.is_dir():
                    candidate = (p_dir / f"{valid_id}.json").resolve()
                    if candidate.is_relative_to(sessions_dir) and candidate.exists():
                        try:
                            s = cls.load(candidate)
                            s._save_to_db()  # Auto-migrate to SQLite
                            return s
                        except Exception:
                            pass
        return None


def get_all_sessions(project_path: Optional[str] = None) -> List[Session]:
    return Session.list_sessions(project_path, limit=100)
