"""PlanPanel — always-visible right column showing task plan with live checkboxes."""
from rich.markup import escape
from textual.app import ComposeResult
from textual.containers import VerticalScroll, Horizontal
from textual.widget import Widget
from textual.widgets import Static, Button, Input

from andromity.core.planner import Plan


class PlanPanel(Widget):
    """Persistent right column that shows the current plan/task checklist."""

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
#plan-steps { height: 1fr; overflow-y: auto; padding: 1; }
#plan-progress { padding: 0 1; height: 1; }
#plan-actions { dock: bottom; height: 3; padding: 0 1; background: $surface-darken-1; display: none; }
#plan-actions.visible { display: block; }
#plan-actions Button { margin: 0 1; }
#plan-reject-input {
    dock: bottom; height: 3; display: none;
    border-top: solid $error;
}
#plan-reject-input.visible { display: block; }
.step-pending { color: $text-muted; }
.step-active  { color: $warning; text-style: bold; }
.step-done    { color: $success; }
.step-failed  { color: $error; text-style: bold; }
.step-skipped { color: $text-muted; text-style: italic; }
"""

    def __init__(self, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._project_path = project_path
        self._plan: Plan | None = None

    def compose(self) -> ComposeResult:
        yield Static("[bold dim]📋  No Plan[/]", id="plan-header")
        yield Static(" ", id="plan-progress")  # space avoids Textual render crash with empty string
        yield VerticalScroll(id="plan-steps")
        with Horizontal(id="plan-actions"):
            yield Button("✓ Approve", variant="success", id="plan-approve")
            yield Button("✗ Reject", variant="error", id="plan-reject")
        yield Input(placeholder="Why reject? Agent will revise...", id="plan-reject-input")

    # ── Public API ────────────────────────────────────────────────────────

    def load_plan(self, plan: Plan):
        self._plan = plan
        self._refresh_ui()

    def clear_plan(self):
        self._plan = None
        self._refresh_ui()

    def refresh_plan(self):
        """Re-read plan from disk and refresh display."""
        if self._project_path:
            p = Plan.load(self._project_path)
            if p:
                self._plan = p
        self._refresh_ui()

    # ── Rendering ─────────────────────────────────────────────────────────

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
        header = self.query_one("#plan-header", Static)
        progress = self.query_one("#plan-progress", Static)
        if not self._plan:
            header.update("[bold dim]📋  No Plan[/]")
            progress.update(" ")  # must not be empty
            return

        status_badge = {
            "pending_approval": "[yellow bold]⏳ Awaiting Approval[/]",
            "approved":         "[green]✓ Approved[/]",
            "executing":        "[yellow bold]⟳ Executing...[/]",
            "complete":         "[green bold]✓ Complete[/]",
            "failed":           "[red bold]✗ Failed[/]",
            "rejected":         "[red]✗ Rejected[/]",
        }.get(self._plan.status, self._plan.status)

        title = escape(self._plan.title[:30] + ("…" if len(self._plan.title) > 30 else ""))
        header.update(f"[bold]📋 {title}[/]  {status_badge}")

        done, total = self._plan.progress()
        if total > 0:
            pct = int(done / total * 100)
            bar_width = 16
            filled = int(bar_width * done / total)
            bar = "█" * filled + "░" * (bar_width - filled)
            color = "green" if pct == 100 else "yellow" if pct > 50 else "cyan"
            progress.update(f" [{color}]{bar}[/] {done}/{total}")
        else:
            progress.update(" ")

    def _render_steps(self):
        steps_area = self.query_one("#plan-steps", VerticalScroll)
        steps_area.remove_children()

        if not self._plan or not self._plan.steps:
            steps_area.mount(Static("[dim]  No steps defined.[/]"))
            return

        for step in self._plan.steps:
            icon_map = {
                "pending": ("○", "dim"),
                "active":  ("⟳", "yellow bold"),
                "done":    ("✓", "green"),
                "failed":  ("✗", "red bold"),
                "skipped": ("–", "dim"),
            }
            icon, color = icon_map.get(step.status, ("○", "dim"))
            text = escape(step.text)
            line = f" [{color}]{icon}[/] [{color}]{step.index}.[/] {text}"
            steps_area.mount(Static(line))

    def _render_actions(self):
        actions = self.query_one("#plan-actions", Horizontal)

        if not self._plan:
            actions.remove_class("visible")
            return

        # Show approve/reject only when awaiting approval
        if self._plan.status == "pending_approval":
            actions.add_class("visible")
        else:
            actions.remove_class("visible")

    # ── Events ────────────────────────────────────────────────────────────

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id

        if btn_id == "plan-approve":
            if self._plan:
                self._plan.approve()
                self._render()
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
                self._plan.reject()
                self._refresh_ui()
                try:
                    self.app._on_plan_rejected(self._plan, feedback)
                    self.app.focus_input()
                except Exception:
                    pass
