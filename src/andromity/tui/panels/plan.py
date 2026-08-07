"""PlanPanel — right column showing plan reference + todo checklist."""
import re
from pathlib import Path
from rich.markup import escape
from textual.app import ComposeResult
from textual.containers import VerticalScroll, Horizontal
from textual.widget import Widget
from textual.widgets import Static, Button, Input

from andromity.core.planner import Plan
from andromity.core.todo import TodoList


class PlanPanel(Widget):
    """Right column: plan reference + live todo checklist."""

    DEFAULT_CSS = """\
PlanPanel {
    height: 1fr;
    overflow-y: auto;
    padding: 0;
    display: none;
}
#plan-header {
    padding: 0 1;
    height: 3;
    background: $surface-darken-1;
    border-bottom: solid $accent-darken-2;
}
#plan-title { width: 1fr; }
#btn-close-plan { width: 3; margin: 0; min-width: 3; }
#plan-progress { padding: 0 1; height: 1; }
#plan-steps { height: 1fr; overflow-y: auto; padding: 1; }
#plan-actions { dock: bottom; height: 3; padding: 0 1; background: $surface-darken-1; display: none; }
#plan-actions.visible { display: block; }
#plan-actions Button { margin: 0 1; }
#plan-reject-input {
    dock: bottom; height: 3; display: none;
    border-top: solid $error;
}
#plan-reject-input.visible { display: block; }
"""

    def __init__(self, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._project_path = project_path
        self._plan: Plan | None = None
        self._todo_list: TodoList | None = None

    def compose(self) -> ComposeResult:
        with Horizontal(id="plan-header"):
            yield Static("[bold dim]No Plan[/]", id="plan-title")
            yield Button("X", variant="default", id="btn-close-plan")
        yield Static(" ", id="plan-progress")
        yield VerticalScroll(id="plan-steps")
        with Horizontal(id="plan-actions"):
            yield Button("Approve", variant="success", id="plan-approve")
            yield Button("Reject", variant="error", id="plan-reject")
        yield Input(placeholder="Why reject? Agent will revise...", id="plan-reject-input")

    def load_plan(self, plan: Plan):
        self._plan = plan
        self._todo_list = TodoList.load(self._project_path)
        self._refresh_ui()

    def ensure_visible(self):
        """Show the plan panel if todos exist, even without a plan."""
        if not self._plan:
            self._plan = Plan(title="Work", project_path=self._project_path)
        self._todo_list = TodoList.load(self._project_path)
        if self._todo_list.items:
            self.display = True
            self._refresh_ui()

    def clear_plan(self):
        self._plan = None
        self._todo_list = None
        self._refresh_ui()

    def refresh_plan(self):
        self._todo_list = TodoList.load(self._project_path)
        self._refresh_ui()

    def refresh_todos(self):
        self._todo_list = TodoList.load(self._project_path)
        if self._todo_list.items and not self._plan:
            self._plan = Plan(title="Work", project_path=self._project_path)
        self._refresh_ui()

    def _refresh_ui(self):
        if not self._plan:
            self.display = False
            return
        self.display = True
        try:
            self._render_header()
            self._render_steps()
            self._render_actions()
        except Exception:
            pass

    def _render_header(self):
        title_widget = self.query_one("#plan-title", Static)
        progress = self.query_one("#plan-progress", Static)
        if not self._plan:
            title_widget.update("[bold dim]No Plan[/]")
            progress.update(" ")
            return

        plan_title = escape(self._plan.title[:30] + ("..." if len(self._plan.title) > 30 else ""))
        title_widget.update(f"[bold]{plan_title}[/]")

        if self._todo_list and self._todo_list.items:
            done, total = self._todo_list.progress()
            pct = int(done / total * 100) if total > 0 else 0
            bar_width = 16
            filled = int(bar_width * done / total) if total > 0 else 0
            bar = "█" * filled + "░" * (bar_width - filled)
            color = "green" if pct == 100 else "yellow" if pct > 50 else "cyan"
            progress.update(f" [{color}]{bar}[/] {done}/{total} todos")
        else:
            progress.update(" ")

    def _render_steps(self):
        steps_area = self.query_one("#plan-steps", VerticalScroll)
        for child in list(steps_area.children):
            child.remove()

        # Show plan description if available
        if self._plan and self._plan.description:
            steps_area.mount(Static(f"[dim]{escape(self._plan.description)}[/]"))
            steps_area.mount(Static(" "))

        # Show todo checklist
        if self._todo_list and self._todo_list.items:
            for item in self._todo_list.items:
                icon = item.icon
                color = item.color
                text = escape(item.title)
                line = f" [{color}]{icon}[/] [{color}]{item.id}.[/] {text}"
                steps_area.mount(Static(line))
        elif self._plan and self._plan.steps:
            # Fallback: show plan steps as reference
            steps_area.mount(Static("[dim]Reference steps:[/]"))
            for step in self._plan.steps:
                steps_area.mount(Static(f" [dim]{step.index}.[/] {escape(step.text)}"))
        else:
            steps_area.mount(Static("[dim]No steps defined.[/]"))

    def _render_actions(self):
        actions = self.query_one("#plan-actions", Horizontal)
        if not self._plan:
            actions.remove_class("visible")
            return
        if not self._todo_list or not self._todo_list.items:
            actions.add_class("visible")
        else:
            actions.remove_class("visible")

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id
        if btn_id == "btn-close-plan":
            self.display = False
        elif btn_id == "plan-approve":
            if self._plan:
                self._refresh_ui()
                try:
                    self.app._on_plan_approved(self._plan)
                except Exception:
                    pass
        elif btn_id == "plan-reject":
            reject_input = self.query_one("#plan-reject-input", Input)
            reject_input.add_class("visible")
            reject_input.focus()

    def on_input_submitted(self, event: Input.Submitted):
        if event.input.id == "plan-reject-input":
            feedback = event.value.strip()
            event.input.remove_class("visible")
            event.input.clear()
            if self._plan:
                self._refresh_ui()
                try:
                    self.app._on_plan_rejected(self._plan, feedback)
                    self.app.focus_input()
                except Exception:
                    pass
