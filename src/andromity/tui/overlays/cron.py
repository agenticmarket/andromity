"""Cron Manager Overlay — browse, add, enable/disable, and remove cron jobs."""
from rich.markup import escape
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widget import Widget
from textual.widgets import Static, Button, Input, Select

from andromity.core.cron import CronJob, CronScheduler, parse_interval_seconds


class CronManagerOverlay(Widget):
    """Full-screen overlay for managing cron jobs."""

    DEFAULT_CSS = """\
CronManagerOverlay {
    width: 80; height: 38;
    border: solid $accent; background: $surface;
    layer: overlay;
    align: center middle;
}
#cron-title { padding: 0 1; height: 1; background: $accent-darken-2; color: $text; text-style: bold; }
#cron-body { height: 1fr; }
#cron-list-pane { width: 1fr; height: 1fr; border-right: solid $accent-darken-2; }
#cron-form-pane { width: 36; height: 1fr; padding: 1; }
#cron-list-scroll { height: 1fr; overflow-y: auto; padding: 1; }
.cron-row { height: 4; margin: 0 0 1 0; padding: 0 1; border: solid $surface-lighten-1; }
.cron-row.enabled { border: solid $accent-darken-1; }
.cron-row.failed  { border: solid $error; }
#cron-footer { dock: bottom; height: 3; padding: 0 1; }
#cron-footer Button { margin: 0 1; }
#cron-form-pane Label { height: 1; margin-bottom: 0; color: $text-muted; }
#cron-form-pane Input { margin-bottom: 1; }
.form-label { height: 1; color: $text-muted; margin: 0 0 0 0; }
"""

    def __init__(self, scheduler: CronScheduler, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._scheduler = scheduler
        self._project_path = project_path
        self._selected_id: str | None = None

    def compose(self) -> ComposeResult:
        yield Static(" ⏱  Cron Manager", id="cron-title")
        with Horizontal(id="cron-body"):
            with Vertical(id="cron-list-pane"):
                yield VerticalScroll(id="cron-list-scroll")
            with VerticalScroll(id="cron-form-pane"):
                yield Static("[bold]Add New Cron[/]\n", classes="form-label")
                yield Static("Name:", classes="form-label")
                yield Input(placeholder="e.g. Run Tests", id="cf-name")
                yield Static("Prompt:", classes="form-label")
                yield Input(placeholder="e.g. run pytest and report", id="cf-prompt")
                yield Static("Schedule:", classes="form-label")
                yield Input(placeholder="every 30m / every 2h / every 1d", id="cf-schedule")
                yield Static("Mode:", classes="form-label")
                yield Input(placeholder="safe / trust / yolo", id="cf-mode", value="trust")
                yield Static("Allowed cmds (comma-sep):", classes="form-label")
                yield Input(placeholder="pytest, git status", id="cf-allowed")
                yield Static("On failure:", classes="form-label")
                yield Input(placeholder="notify / disable / retry", id="cf-onfail", value="notify")
                yield Button("+ Add Cron", variant="primary", id="btn-cron-add")
        with Horizontal(id="cron-footer"):
            yield Button("Close", variant="default", id="btn-cron-close")
            yield Button("Enable/Disable", variant="warning", id="btn-cron-toggle", disabled=True)
            yield Button("Remove", variant="error", id="btn-cron-remove", disabled=True)

    def on_mount(self):
        self._refresh_list()

    def _refresh_list(self):
        scroll = self.query_one("#cron-list-scroll", VerticalScroll)
        scroll.remove_children()

        crons = self._scheduler.list()
        if not crons:
            scroll.mount(Static("[dim]  No cron jobs yet. Add one →[/]"))
            return

        for cron in crons:
            enabled_color = "green" if cron.enabled else "dim"
            status_icon = {"never": "○", "success": "✓", "failed": "✗"}.get(cron.last_status, "○")
            status_color = {"never": "dim", "success": "green", "failed": "red"}.get(cron.last_status, "dim")

            next_run = cron.next_run_in() if cron.enabled else "disabled"
            row_class = "cron-row failed" if cron.last_status == "failed" else ("cron-row enabled" if cron.enabled else "cron-row")

            row = Static(
                f"[{enabled_color} bold]{escape(cron.name)}[/]  "
                f"[dim]{escape(cron.schedule)}[/]  "
                f"[{status_color}]{status_icon}[/] "
                f"[dim]next: {next_run}[/]\n"
                f"[dim]{escape(cron.prompt[:45])}{'…' if len(cron.prompt) > 45 else ''}[/]\n"
                f"[dim]model: {escape(cron.model)}  mode: {escape(cron.mode)}  runs: {cron.run_count}  fails: {cron.fail_count}[/]",
                classes=row_class,
                id=f"cron-row-{cron.id}",
            )
            scroll.mount(row)

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id

        if btn_id == "btn-cron-close":
            self.remove_class("visible")

        elif btn_id == "btn-cron-add":
            self._try_add_cron()

        elif btn_id == "btn-cron-toggle":
            if self._selected_id:
                enabled = self._scheduler.toggle(self._selected_id)
                self._refresh_list()
                chat = self.app.query_one("ChatPanel")
                name = next((c.name for c in self._scheduler.list() if c.id == self._selected_id), self._selected_id)
                state = "enabled" if enabled else "disabled"
                chat.add_system_message(f"[dim]Cron '{name}' {state}.[/]")

        elif btn_id == "btn-cron-remove":
            if self._selected_id:
                name = next((c.name for c in self._scheduler.list() if c.id == self._selected_id), self._selected_id)
                self._scheduler.remove(self._selected_id)
                self._selected_id = None
                self._set_selected_buttons(False)
                self._refresh_list()
                chat = self.app.query_one("ChatPanel")
                chat.add_system_message(f"[dim]Cron '{name}' removed.[/]")

    def _try_add_cron(self):
        from andromity.config import config
        name = self.query_one("#cf-name", Input).value.strip()
        prompt = self.query_one("#cf-prompt", Input).value.strip()
        schedule = self.query_one("#cf-schedule", Input).value.strip()
        mode = self.query_one("#cf-mode", Input).value.strip().lower() or "trust"
        allowed_raw = self.query_one("#cf-allowed", Input).value.strip()
        on_failure = self.query_one("#cf-onfail", Input).value.strip().lower() or "notify"

        chat = self.app.query_one("ChatPanel")

        if not name or not prompt or not schedule:
            chat.add_system_message("[red]Cron: Name, prompt, and schedule are required.[/]")
            return

        try:
            parse_interval_seconds(schedule)
        except ValueError as e:
            chat.add_system_message(f"[red]Cron schedule error:[/] {e}")
            return

        if mode not in ("safe", "trust", "yolo"):
            chat.add_system_message("[red]Cron mode must be safe, trust, or yolo.[/]")
            return

        allowed = [c.strip() for c in allowed_raw.split(",") if c.strip()]
        provider = config.get("default", "provider", "")
        model = config.get("default", "model", "")

        job = self._scheduler.add(
            name=name, prompt=prompt, schedule=schedule,
            provider=provider, model=model,
            mode=mode, allowed_commands=allowed, on_failure=on_failure,
        )

        # Clear form
        for field_id in ("#cf-name", "#cf-prompt", "#cf-schedule", "#cf-allowed"):
            self.query_one(field_id, Input).clear()

        self._refresh_list()
        chat.add_system_message(
            f"[green]✓ Cron added:[/] [bold]{escape(name)}[/] — {schedule}\n"
            f"[dim]Provider: {provider}/{model}  mode: {mode}  on_failure: {on_failure}[/]"
        )

    def _set_selected_buttons(self, enabled: bool):
        self.query_one("#btn-cron-toggle", Button).disabled = not enabled
        self.query_one("#btn-cron-remove", Button).disabled = not enabled
