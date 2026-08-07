"""Todo model — reads/writes .andromity/todos.md with checkbox tracking."""
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class TodoItem:
    id: str
    title: str
    status: str = "pending"  # "pending" | "active" | "done" | "failed" | "skipped"

    @property
    def checkbox(self) -> str:
        return {"pending": "[ ]", "active": "[/]", "done": "[x]", "failed": "[!]", "skipped": "[-]"}[self.status]

    @property
    def icon(self) -> str:
        return {"pending": "○", "active": "⟳", "done": "✓", "failed": "✗", "skipped": "–"}[self.status]

    @property
    def color(self) -> str:
        return {"pending": "dim", "active": "yellow bold", "done": "green", "failed": "red bold", "skipped": "dim"}[self.status]


@dataclass
class TodoList:
    items: List[TodoItem] = field(default_factory=list)
    project_path: str = ""

    @property
    def todo_path(self) -> Path:
        andromity_dir = Path(self.project_path) / ".andromity"
        andromity_dir.mkdir(parents=True, exist_ok=True)
        return andromity_dir / "todos.md"

    def save(self):
        lines = ["# Todos", ""]
        for item in self.items:
            lines.append(f"- {item.checkbox} {item.id}. {item.title}")
        lines.append("")
        with open(self.todo_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

    @classmethod
    def load(cls, project_path: str) -> "TodoList":
        path = Path(project_path) / ".andromity" / "todos.md"
        if not path.exists():
            return cls(project_path=project_path)
        try:
            return cls._parse(path.read_text(encoding="utf-8"), project_path)
        except Exception:
            return cls(project_path=project_path)

    @classmethod
    def _parse(cls, text: str, project_path: str) -> "TodoList":
        todo_list = cls(project_path=project_path)
        pattern = re.compile(r"^-\s+(\[[ x/!\-]\])\s+(t\d+)\.\s+(.+)")
        status_map = {"[ ]": "pending", "[x]": "done", "[/]": "active", "[!]": "failed", "[-]": "skipped"}
        for line in text.splitlines():
            m = pattern.match(line)
            if m:
                checkbox, todo_id, title = m.group(1), m.group(2), m.group(3).strip()
                todo_list.items.append(TodoItem(id=todo_id, title=title, status=status_map.get(checkbox, "pending")))
        return todo_list

    def add(self, title: str) -> TodoItem:
        existing_ids = {item.id for item in self.items}
        idx = 1
        while f"t{idx}" in existing_ids:
            idx += 1
        item = TodoItem(id=f"t{idx}", title=title, status="pending")
        self.items.append(item)
        self.save()
        return item

    def update(self, todo_id: str, status: str) -> Optional[TodoItem]:
        for item in self.items:
            if item.id == todo_id:
                item.status = status
                self.save()
                return item
        return None

    def get(self, todo_id: str) -> Optional[TodoItem]:
        for item in self.items:
            if item.id == todo_id:
                return item
        return None

    def progress(self) -> tuple[int, int]:
        done = sum(1 for item in self.items if item.status in ("done", "skipped"))
        return done, len(self.items)

    def next_pending(self) -> Optional[TodoItem]:
        return next((item for item in self.items if item.status == "pending"), None)
