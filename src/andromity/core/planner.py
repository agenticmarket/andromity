"""Plan model — reads/writes .andromity/plan.md with checkbox tracking."""
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class PlanStep:
    index: int
    text: str
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
class Plan:
    title: str = "Untitled Plan"
    description: str = ""
    steps: List[PlanStep] = field(default_factory=list)
    status: str = "pending_approval"  # "pending_approval" | "approved" | "executing" | "complete" | "failed" | "rejected"
    project_path: str = ""

    # ── Persistence ──────────────────────────────────────────────────────────

    @property
    def plan_path(self) -> Path:
        andromity_dir = Path(self.project_path) / ".andromity"
        andromity_dir.mkdir(parents=True, exist_ok=True)
        return andromity_dir / "plan.md"

    def save(self):
        """Write the plan to .andromity/plan.md in a structured markdown format."""
        lines = [
            f"# Plan: {self.title}",
            f"",
            f"<!-- status: {self.status} -->",
            f"",
        ]
        if self.description:
            lines += [self.description, ""]

        lines.append("## Steps")
        lines.append("")
        for step in self.steps:
            lines.append(f"- {step.checkbox} {step.index}. {step.text}")
        lines.append("")

        with open(self.plan_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

    @classmethod
    def clear(cls, project_path: str):
        """Delete the plan file from disk."""
        path = Path(project_path) / ".andromity" / "plan.md"
        if path.exists():
            path.unlink()

    @classmethod
    def load(cls, project_path: str) -> Optional["Plan"]:
        """Load a plan from .andromity/plan.md if it exists."""
        path = Path(project_path) / ".andromity" / "plan.md"
        if not path.exists():
            return None
        try:
            return cls._parse(path.read_text(encoding="utf-8"), project_path)
        except Exception:
            return None

    @classmethod
    def _parse(cls, text: str, project_path: str) -> "Plan":
        plan = cls(project_path=project_path)
        lines = text.splitlines()

        # Title
        for line in lines:
            m = re.match(r"^#\s+Plan:\s*(.+)", line)
            if m:
                plan.title = m.group(1).strip()
                break

        # Status
        for line in lines:
            m = re.search(r"<!--\s*status:\s*(\w+)\s*-->", line)
            if m:
                plan.status = m.group(1)
                break

        # Steps
        step_pattern = re.compile(r"^-\s+(\[[ x/!\-]\])\s+(\d+)\.\s+(.+)")
        status_map = {"[ ]": "pending", "[x]": "done", "[/]": "active", "[!]": "failed", "[-]": "skipped"}
        for line in lines:
            m = step_pattern.match(line)
            if m:
                checkbox, idx, text = m.group(1), int(m.group(2)), m.group(3).strip()
                plan.steps.append(PlanStep(index=idx, text=text, status=status_map.get(checkbox, "pending")))

        return plan

    # ── State helpers ─────────────────────────────────────────────────────────

    def approve(self):
        self.status = "approved"
        self.save()

    def reject(self):
        self.status = "rejected"
        self.save()

    def start(self):
        self.status = "executing"
        self.save()

    def set_step_status(self, index: int, status: str):
        for step in self.steps:
            if step.index == index:
                step.status = status
                break
        # Auto-complete the plan when all steps done
        if status in ("done", "failed") and all(s.status in ("done", "failed", "skipped") for s in self.steps):
            self.status = "complete" if all(s.status != "failed" for s in self.steps) else "failed"
        self.save()

    def current_step(self) -> Optional[PlanStep]:
        for step in self.steps:
            if step.status == "active":
                return step
        return next((s for s in self.steps if s.status == "pending"), None)

    def progress(self) -> tuple[int, int]:
        done = sum(1 for s in self.steps if s.status in ("done", "skipped"))
        return done, len(self.steps)

    # ── JSON serialization (for session storage) ─────────────────────────────

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "description": self.description,
            "status": self.status,
            "steps": [
                {"index": s.index, "text": s.text, "status": s.status}
                for s in self.steps
            ],
        }

    @classmethod
    def from_dict(cls, data: dict, project_path: str = "") -> "Plan":
        plan = cls(
            title=data.get("title", "Untitled Plan"),
            description=data.get("description", ""),
            status=data.get("status", "pending_approval"),
            project_path=project_path,
        )
        for s in data.get("steps", []):
            plan.steps.append(PlanStep(
                index=s.get("index", 0),
                text=s.get("text", ""),
                status=s.get("status", "pending"),
            ))
        return plan
