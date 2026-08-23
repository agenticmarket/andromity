import json
import uuid
import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional

from andromity.config import get_config_dir


class Session:
    def __init__(self, name: str = "new-session", project_path: Optional[str] = None):
        self.id = str(uuid.uuid4())
        self.name = name
        self.project_path = project_path or str(Path.cwd())
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
        from andromity.config import config
        self.provider = config.get("default", "provider", "")
        self.model = config.get("default", "model", "")
        self.storage_dir = get_config_dir() / "sessions" / self.project_hash
        self.storage_dir.mkdir(parents=True, exist_ok=True)
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
                self.save()

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

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "project": self.project_hash,
            "project_path": self.project_path,
            "parent_session": self.parent_session, "branch_point": self.branch_point,
            "created_at": self.created_at, "updated_at": self.updated_at, "messages": self.messages,
            "token_total": self.token_total, "cost_usd": self.cost_usd,
            "context_tokens": self.context_tokens,
            "usage_breakdown": self.usage_breakdown, "cost_source": self.cost_source,
            "provider": getattr(self, "provider", ""),
            "model": getattr(self, "model", ""),
            "plan": self.plan,
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
        recent_msgs = self.messages[-keep_last_n:]
        
        # Check if the last compacted block is already there, if so, we can just replace it.
        # But building a new message array is cleaner.
        summary_msg = {
            "role": "system",
            "content": f"PREVIOUS MEMORY SUMMARY: {new_summary}"
        }
        
        removed_count = len(self.messages) - 1 - keep_last_n
        self.messages = [system_msg, summary_msg] + recent_msgs
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

    def save(self):
        with getattr(self, "_save_lock", None) or threading.Lock():
            if getattr(self, "_save_timer", None) is not None:
                try:
                    self._save_timer.cancel()
                except Exception:
                    pass
                self._save_timer = None
            self._dirty = False
        self.updated_at = datetime.now(timezone.utc).isoformat()
        with open(self.file_path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=2)

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
    def load(cls, file_path: Path) -> "Session":
        with open(file_path, "r", encoding="utf-8") as f:
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
        session.storage_dir = file_path.parent
        session.file_path = file_path
        session._save_timer = None
        session._save_lock = threading.Lock()
        session._dirty = False
        return session

    @classmethod
    def list_sessions(cls, project_path: Optional[str] = None, limit: int = 20) -> List["Session"]:
        pp = project_path or str(Path.cwd())
        project_hash = hashlib.sha256(pp.encode()).hexdigest()[:16]
        sessions_dir = get_config_dir() / "sessions" / project_hash
        if not sessions_dir.exists():
            return []
            
        # Get all files and sort by modification time (newest first)
        # This avoids parsing hundreds of JSON files just to find the top 20.
        session_files = list(sessions_dir.glob("*.json"))
        session_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        
        sessions = []
        for f in session_files[:limit]:
            try:
                sessions.append(cls.load(f))
            except Exception:
                continue
                
        # Final sort in case JSON updated_at differs slightly from mtime
        sessions.sort(key=lambda s: getattr(s, "updated_at", s.created_at), reverse=True)
        return sessions
