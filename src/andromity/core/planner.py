"""Plan model — stored as JSON in <project>/.andromity/plan.json (never exposed to the AI as a file path)."""
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class Plan:
    title: str = "Untitled Plan"
    description: str = ""
    body: str = ""           # full markdown document written by the AI (optional)
    questions: List[str] = field(default_factory=list)
    status: str = "pending"   # pending | approved | rejected
    project_path: str = ""

    # ── Persistence ──────────────────────────────────────────────────────────

    @property
    def _dir(self) -> Path:
        """Resolved .andromity dir inside the project. Raises if project_path is empty."""
        if not self.project_path:
            raise ValueError("project_path must be set before saving a Plan")
        d = Path(self.project_path).resolve() / ".andromity"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def save(self) -> None:
        path = self._dir / "plan.json"
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        # Ensure .andromity/ is gitignored so we never pollute the user's repo
        try:
            from andromity.core.git_ops import ensure_gitignore_entry
            ensure_gitignore_entry(self.project_path, ".andromity/")
        except Exception:
            pass

    @classmethod
    def clear(cls, project_path: str) -> None:
        path = Path(project_path).resolve() / ".andromity" / "plan.json"
        if path.exists():
            path.unlink()

    @classmethod
    def load(cls, project_path: str) -> Optional["Plan"]:
        if not project_path:
            return None
        path = Path(project_path).resolve() / ".andromity" / "plan.json"
        if not path.exists():
            # Backwards-compat: also try old plan.md
            md_path = Path(project_path).resolve() / ".andromity" / "plan.md"
            if not md_path.exists():
                return None
            # Silently skip old format — it will be overwritten next write_plan call
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return cls.from_dict(data, project_path)
        except Exception:
            return None

    # ── Serialisation ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "description": self.description,
            "body": self.body,
            "status": self.status,
            "questions": self.questions,
            "project_path": self.project_path,
        }

    def to_enriched_dict(self) -> dict:
        d = self.to_dict()
        from andromity.core.todo import TodoList
        todos = []
        p_path = self.project_path
        if not p_path:
            try:
                from andromity.core.tools import _get_project_root
                p_path = str(_get_project_root())
            except Exception:
                p_path = str(Path.cwd())
        if p_path:
            try:
                tlist = TodoList.load(p_path)
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
        return cls(
            title=data.get("title", "Untitled Plan"),
            description=data.get("description", ""),
            body=data.get("body", ""),
            status=data.get("status", "pending"),
            questions=data.get("questions", []),
            project_path=project_path or data.get("project_path", ""),
        )
