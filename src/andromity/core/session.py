import json
import uuid
import hashlib
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
        self.messages: List[Dict[str, Any]] = []
        self.token_total = 0
        self.cost_usd = 0.0
        self.storage_dir = get_config_dir() / "sessions" / self.project_hash
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.file_path = self.storage_dir / f"{self.id}.json"

    def add_message(self, role: str, content: Optional[str] = None,
                    tool_calls: Optional[List[Dict]] = None,
                    name: Optional[str] = None, tool_call_id: Optional[str] = None):
        msg: Dict[str, Any] = {"role": role}
        if content is not None:
            msg["content"] = content
        if tool_calls is not None:
            msg["tool_calls"] = tool_calls
        if name is not None:
            msg["name"] = name
        if tool_call_id is not None:
            msg["tool_call_id"] = tool_call_id
        self.messages.append(msg)
        self.save()

    def update_usage(self, usage: Dict[str, int]):
        self.token_total += usage.get("total_tokens", 0)
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        self.cost_usd += (prompt_tokens * 3.0 + completion_tokens * 15.0) / 1_000_000
        self.save()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "project": self.project_hash,
            "project_path": self.project_path,
            "parent_session": self.parent_session, "branch_point": self.branch_point,
            "created_at": self.created_at, "messages": self.messages,
            "token_total": self.token_total, "cost_usd": self.cost_usd,
        }

    def save(self):
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
        session.project_path = data.get("project_path", str(Path.cwd()))
        session.parent_session = data["parent_session"]
        session.branch_point = data["branch_point"]
        session.created_at = data["created_at"]
        session.messages = data["messages"]
        session.token_total = data.get("token_total", 0)
        session.cost_usd = data.get("cost_usd", 0.0)
        session.storage_dir = file_path.parent
        session.file_path = file_path
        return session

    @classmethod
    def list_sessions(cls, project_path: Optional[str] = None) -> List["Session"]:
        pp = project_path or str(Path.cwd())
        project_hash = hashlib.sha256(pp.encode()).hexdigest()[:16]
        sessions_dir = get_config_dir() / "sessions" / project_hash
        if not sessions_dir.exists():
            return []
        sessions = []
        for f in sessions_dir.glob("*.json"):
            try:
                sessions.append(cls.load(f))
            except Exception:
                continue
        sessions.sort(key=lambda s: s.created_at, reverse=True)
        return sessions
