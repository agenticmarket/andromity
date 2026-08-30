import copy
import json
import os
import uuid
import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional

from andromity.config import get_config_dir


import re


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
        """Return a serializable dict of the session.

        When *snapshot=True* the messages list (and nested dicts) are
        deep-copied so the returned dict is safe to serialize on a
        background thread without racing the main event loop.
        """
        msgs = copy.deepcopy(self.messages) if snapshot else self.messages
        return {
            "id": self.id, "name": self.name, "project": self.project_hash,
            "project_path": self.project_path,
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
            
        # The system prompt is at index 0. We want to keep it.
        # We also want to keep the last `keep_last_n` messages.
        # Everything in between is compacted.
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

    def _save_snapshot(self):
        """Snapshot state under lock, then serialize + atomic-write outside it.

        This is the preferred save path from background timer threads:
        the deep-copy runs under the GIL in ~1-2ms, but the heavy
        json.dumps() and file I/O happen entirely outside any lock so
        the Textual event loop is never starved.
        """
        self.updated_at = datetime.now(timezone.utc).isoformat()
        data = self.to_dict(snapshot=True)
        self._write_json(data)

    def save(self):
        """Immediate, synchronous save (used for first-write, plan save, etc.)."""
        with getattr(self, "_save_lock", None) or threading.Lock():
            if getattr(self, "_save_timer", None) is not None:
                try:
                    self._save_timer.cancel()
                except Exception:
                    pass
                self._save_timer = None
            self._dirty = False
        self.updated_at = datetime.now(timezone.utc).isoformat()
        data = self.to_dict(snapshot=True)
        self._write_json(data)

    def _write_json(self, data: Dict[str, Any]):
        """Atomic write: serialize to a temp file, then os.replace().

        Uses compact JSON (no indent) for sessions with >50 messages
        to cut serialization time from seconds to milliseconds for
        large sessions, preventing GIL starvation that freezes the UI.
        """
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
            # Fallback: direct write if os.replace fails (e.g. cross-device)
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
    def load(cls, file_path: Any) -> "Session":
        fp = Path(file_path)
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        session = cls.__new__(cls)
        session.id = data["id"]
        session.name = data["name"]
        session.project_hash = data["project"]
        session.project_path = data.get("project_path", "")
        session.parent_session = data.get("parent_session")
        session.branch_point = data.get("branch_point")
        session.created_at = data["created_at"]
        session.updated_at = data.get("updated_at", session.created_at)
        session.messages = data["messages"]
        session.token_total = data.get("token_total", 0)
        session.context_tokens = data.get("context_tokens", 0)
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
        norm_path = normalize_project_path(project_path)
        primary_hash = hashlib.sha256(norm_path.encode()).hexdigest()[:16]

        hashes_to_check = {primary_hash}
        if project_path:
            raw_s = str(project_path)
            hashes_to_check.add(hashlib.sha256(raw_s.encode()).hexdigest()[:16])
            hashes_to_check.add(hashlib.sha256(raw_s.lower().encode()).hexdigest()[:16])
            hashes_to_check.add(hashlib.sha256(Path(project_path).resolve().as_posix().encode()).hexdigest()[:16])

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

        # Sort by modification time (newest first)
        session_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)

        sessions = []
        for f in session_files[:limit]:
            try:
                sessions.append(cls.load(f))
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
                    return cls.load(candidate)
                except Exception:
                    pass

        # Fallback: scan all project subdirectories under sessions
        if sessions_dir.exists():
            for p_dir in sessions_dir.iterdir():
                if p_dir.is_dir():
                    candidate = (p_dir / f"{valid_id}.json").resolve()
                    if candidate.is_relative_to(sessions_dir) and candidate.exists():
                        try:
                            return cls.load(candidate)
                        except Exception:
                            pass
        return None


def get_all_sessions(project_path: Optional[str] = None) -> List[Session]:
    return Session.list_sessions(project_path, limit=100)
