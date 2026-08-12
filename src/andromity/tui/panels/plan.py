"""PlanPanel — minimal right-column todo progress tracker.

Plan content (title, description, questions, approve/reject) is shown
in the DiffPanel (file viewer).  This widget only shows the live todo
checklist so the user can track progress at a glance.

IMPORTANT: Never define _render() here — it is a Textual internal that
must return a Visual object.  Use _paint_todos() instead.
"""
from rich.markup import escape
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widget import Widget
from textual.widgets import Static

from andromity.core.todo import TodoList

# Braille spinner frames — fast, lightweight, visually distinct from static icons
_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
_SPINNER_INTERVAL = 0.25  # seconds between frames (purely cosmetic — 4fps vs 10fps is invisible)


class PlanPanel(Widget):
    """Right column: live todo checklist only."""

    DEFAULT_CSS = """\
PlanPanel {
    height: 1fr;
    overflow-y: auto;
    padding: 0;
    display: none;
}
#pp-header   { padding: 0 1; height: 1; color: $text-muted; text-style: italic; }
#pp-progress { padding: 0 1; height: 1; }
#pp-todos    { height: 1fr; overflow-y: auto; padding: 0 1 1 1; }
"""

    def __init__(self, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._project_path = project_path
        self._todo_list: TodoList | None = None
        self._title: str = ""
        self._spin_frame: int = 0
        self._spin_timer = None

    def compose(self) -> ComposeResult:
        yield Static("", id="pp-header")
        yield Static("", id="pp-progress")
        # Single Static that we update() in-place — avoids async mount/remove
        yield Static("", id="pp-todos-body")

    # ── Public API ────────────────────────────────────────────────────────────

    def on_mount(self) -> None:
        """Start the spinner tick timer as soon as the widget is mounted."""
        self._spin_timer = self.set_interval(_SPINNER_INTERVAL, self._tick_spinner)

    def _tick_spinner(self) -> None:
        """Advance one spinner frame. Only repaints when there are active items."""
        if self._todo_list and any(i.status == "active" for i in self._todo_list.items):
            self._spin_frame = (self._spin_frame + 1) % len(_SPINNER_FRAMES)
            self._paint_todos()

    def load_plan(self, plan) -> None:
        """Called when a new plan is written by the agent."""
        self._title = getattr(plan, "title", "")
        self._todo_list = TodoList.load(self._project_path)
        self._paint_todos()

    def refresh_plan(self) -> None:
        self._todo_list = TodoList.load(self._project_path)
        self._paint_todos()

    def refresh_todos(self) -> None:
        self._todo_list = TodoList.load(self._project_path)
        if not self._title and self._todo_list and self._todo_list.items:
            self._title = "Work"
        self._paint_todos()

    def ensure_visible(self) -> None:
        self._todo_list = TodoList.load(self._project_path)
        if self._todo_list and self._todo_list.items:
            if not self._title:
                self._title = "Work"
            self.display = True
            self._paint_todos()

    def clear_plan(self) -> None:
        self._title = ""
        self._todo_list = None
        self._paint_todos()

    # ── Internal ──────────────────────────────────────────────────────────────
    # NOTE: Do NOT name any method _render() — that shadows Widget._render()
    # which Textual calls internally expecting a Visual object back.

    def _paint_todos(self) -> None:
        """Update all child Static widgets in-place using .update() — fully synchronous, render-safe."""
        has_todos = bool(self._todo_list and self._todo_list.items)
        if not has_todos and not self._title:
            self.display = False
            return
        self.display = True

        # Guard: if widget is not yet mounted, query_one will throw
        if not self.is_attached:
            return

        try:
            # ── Header ──
            header_markup = f"[dim]{escape(self._title)}[/dim]" if self._title else ""
            self.query_one("#pp-header", Static).update(header_markup)

            # ── Progress bar ──
            if self._todo_list and self._todo_list.items:
                done, total = self._todo_list.progress()
                pct = int(done / total * 100) if total else 0
                bw = 14
                filled = int(bw * done / total) if total else 0
                bar = "█" * filled + "░" * (bw - filled)
                color = "green" if pct == 100 else "yellow" if pct > 50 else "cyan"
                self.query_one("#pp-progress", Static).update(
                    f" [{color}]{bar}[/] {done}/{total}"
                )
            else:
                self.query_one("#pp-progress", Static).update("")

            # ── Todo list — all in one Static, updated in-place ──
            if self._todo_list and self._todo_list.items:
                row_parts = []
                for item in self._todo_list.items:
                    if item.status == "active":
                        # Live spinner frame in yellow bold
                        spin = _SPINNER_FRAMES[self._spin_frame % len(_SPINNER_FRAMES)]
                        row_parts.append(f" [yellow bold]{spin}[/] [yellow bold]{escape(item.title)}[/]")
                    elif item.status == "done":
                        # Entire line green — task complete
                        row_parts.append(f" [green]✓ {escape(item.title)}[/]")
                    elif item.status == "failed":
                        row_parts.append(f" [red bold]✗ {escape(item.title)}[/]")
                    elif item.status == "skipped":
                        row_parts.append(f" [dim]– {escape(item.title)}[/]")
                    else:  # pending
                        row_parts.append(f" [dim]○ {escape(item.title)}[/]")
                lines = "\n".join(row_parts)
            else:
                lines = "[dim]No todos yet.[/dim]"
            self.query_one("#pp-todos-body", Static).update(lines)

        except Exception:
            # Widget may not be fully composed yet (e.g. during startup) — safe to skip
            pass
