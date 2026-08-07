"""Plan model — reads/writes .andromity/plan.md as a reference document."""
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class PlanStep:
    index: int
    text: str


@dataclass
class Plan:
    title: str = "Untitled Plan"
    description: str = ""
    steps: List[PlanStep] = field(default_factory=list)
    project_path: str = ""

    @property
    def plan_path(self) -> Path:
        andromity_dir = Path(self.project_path) / ".andromity"
        andromity_dir.mkdir(parents=True, exist_ok=True)
        return andromity_dir / "plan.md"

    def save(self):
        lines = [
            f"# Plan: {self.title}",
            f"",
        ]
        if self.description:
            lines += [self.description, ""]
        lines.append("## Steps")
        lines.append("")
        for step in self.steps:
            lines.append(f"- {step.index}. {step.text}")
        lines.append("")
        with open(self.plan_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

    @classmethod
    def clear(cls, project_path: str):
        path = Path(project_path) / ".andromity" / "plan.md"
        if path.exists():
            path.unlink()

    @classmethod
    def load(cls, project_path: str) -> Optional["Plan"]:
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

        for line in lines:
            m = re.match(r"^#\s+Plan:\s*(.+)", line)
            if m:
                plan.title = m.group(1).strip()
                break

        step_pattern = re.compile(r"^-\s+(\d+)\.\s+(.+)")
        for line in lines:
            m = step_pattern.match(line)
            if m:
                plan.steps.append(PlanStep(index=int(m.group(1)), text=m.group(2).strip()))

        return plan

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "description": self.description,
            "steps": [{"index": s.index, "text": s.text} for s in self.steps],
        }

    @classmethod
    def from_dict(cls, data: dict, project_path: str = "") -> "Plan":
        plan = cls(
            title=data.get("title", "Untitled Plan"),
            description=data.get("description", ""),
            project_path=project_path,
        )
        for s in data.get("steps", []):
            plan.steps.append(PlanStep(index=s.get("index", 0), text=s.get("text", "")))
        return plan
