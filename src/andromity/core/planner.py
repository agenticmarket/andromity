"""Plan model — stored in OS config storage by session ID."""
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


def get_plans_dir(project_path: str = "") -> Path:
    from andromity.config import get_config_dir
    base = get_config_dir() / "plans"
    if project_path:
        p_hash = hashlib.sha256(str(Path(project_path).resolve()).encode()).hexdigest()[:16]
        base = base / p_hash
    base.mkdir(parents=True, exist_ok=True)
    return base


@dataclass
class Plan:
    title: str = "Untitled Plan"
    description: str = ""
    body: str = ""
    questions: List[str] = field(default_factory=list)
    status: str = "pending"
    project_path: str = ""
    session_id: str = ""
    steps: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def plan_path(self) -> Path:
        filename = f"{self.session_id}.json" if self.session_id else "plan.json"
        return get_plans_dir(self.project_path) / filename

    def save(self) -> None:
        if not self.project_path:
            raise ValueError("project_path must be set before saving a Plan")
        path = self.plan_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")

    @classmethod
    def clear(cls, project_path: str, session_id: str = "") -> None:
        if not project_path:
            return
        filename = f"{session_id}.json" if session_id else "plan.json"
        path = get_plans_dir(project_path) / filename
        if path.exists():
            path.unlink(missing_ok=True)
        legacy = Path(project_path).resolve() / ".andromity" / "plan.json"
        if legacy.exists():
            legacy.unlink(missing_ok=True)

    @classmethod
    def load(cls, project_path: str, session_id: str = "") -> Optional["Plan"]:
        if not project_path:
            return None
        filename = f"{session_id}.json" if session_id else "plan.json"
        path = get_plans_dir(project_path) / filename
        if not path.exists():
            legacy = Path(project_path).resolve() / ".andromity" / "plan.json"
            if legacy.exists():
                path = legacy
            else:
                return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return cls.from_dict(data, project_path)
        except Exception:
            return None

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "description": self.description,
            "body": self.body,
            "status": self.status,
            "questions": self.questions,
            "project_path": self.project_path,
            "session_id": self.session_id,
        }

    def to_enriched_dict(self) -> dict:
        d = self.to_dict()
        todos = list(self.steps) if self.steps else []
        if not todos:
            from andromity.core.todo import TodoList
            p_path = self.project_path
            if not p_path:
                try:
                    from andromity.core.tools import _get_project_root
                    p_path = str(_get_project_root())
                except Exception:
                    p_path = str(Path.cwd())
            if p_path:
                try:
                    tlist = TodoList.load(p_path, session_id=self.session_id)
                    if tlist and tlist.items:
                        todos = [
                            {"id": item.id, "title": item.title, "status": item.status}
                            for item in tlist.items
                        ]
                except Exception:
                    todos = []
        d["steps"] = todos
        d["todos"] = todos
        return d

    @classmethod
    def from_dict(cls, data: dict, project_path: str = "") -> "Plan":
        steps = data.get("steps") or data.get("todos") or []
        return cls(
            title=data.get("title", "Untitled Plan"),
            description=data.get("description", ""),
            body=data.get("body", ""),
            status=data.get("status", "pending"),
            questions=data.get("questions", []),
            project_path=project_path or data.get("project_path", ""),
            session_id=data.get("session_id", ""),
            steps=steps,
        )
