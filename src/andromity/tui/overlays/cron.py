"""Cron Manager Overlay — browse, add, enable/disable, remove cron jobs + run history."""
from datetime import datetime, timezone
from rich.markup import escape
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, Input
from textual import events, on

from andromity.core.cron import CronJob, CronScheduler, CronRun, parse_interval_seconds


class CronManagerOverlay(ModalScreen):
    """Full-screen overlay for managing cron jobs with run history."""

    DEFAULT_CSS = """\
CronManagerOverlay {
    align: center middle;
    background: $background 20%;
}
#cron-dialog {
    width: 90; height: 42;
    border: solid $accent; background: $surface;
}
#cron-title { padding: 0 1; height: 1; background: $accent-darken-2; color: $text; text-style: bold; }
#cron-tabs { height: 3; padding: 0 1; }
#cron-tabs Button { margin: 0 1; }
.hidden { display: none; }
#cron-tab-jobs, #cron-tab-history { height: 1fr; }
#cron-body { height: 1fr; }
#cron-list-pane { width: 1fr; height: 1fr; border-right: solid $accent-darken-2; }
#cron-form-pane { width: 36; height: 1fr; padding: 1; }
#cron-list-scroll { height: 1fr; overflow-y: auto; padding: 1; }
.cron-row { padding: 1; border-bottom: solid $accent-darken-3; background: $surface; }
.cron-row:hover { background: $surface-lighten-1; }
.cron-row.selected { background: $accent-darken-2; border-left: thick solid $primary; padding-left: 0; }
.cron-row.enabled { border: solid $accent-darken-1; }
.cron-row.failed  { border: solid $error; }
#cron-footer { dock: bottom; height: 3; padding: 0 1; }
#cron-footer Button { margin: 0 1; }
#cron-form-pane Label { height: 1; margin-bottom: 0; color: $text-muted; }
#cron-form-pane Input { margin-bottom: 1; }
.form-label { height: 1; color: $text-muted; margin: 0 0 0 0; }
/* History tab */
#history-pane { height: 1fr; }
#history-job-label { padding: 0 1; height: 3; background: $surface-darken-1; }
#history-run-list { height: 1fr; overflow-y: auto; padding: 1; }
#history-detail { width: 45; height: 1fr; border-left: solid $accent-darken-2; padding: 1; overflow-y: auto; }
.history-row { padding: 1; border-bottom: solid $accent-darken-3; background: $surface; }
.history-row:hover { background: $surface-lighten-1; }
.history-row.selected { background: $accent-darken-2; }
#history-empty { padding: 2; }
"""

    def __init__(self, scheduler: CronScheduler, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._scheduler = scheduler
        self._project_path = project_path
        self._selected_id: str | None = None
        self._selected_run_id: str | None = None
        self._active_tab = "jobs"  # "jobs" | "history"
        self._history_job_id: str | None = None
        self._refresh_guard: bool = False  # prevents concurrent _refresh_list calls

    def compose(self) -> ComposeResult:
        with Vertical(id="cron-dialog"):
            yield Static(" ⏱  Cron Manager", id="cron-title")
            with Horizontal(id="cron-tabs"):
                yield Button("Jobs", variant="primary", id="tab-jobs")
                yield Button("History", variant="default", id="tab-history")
            # ── Jobs tab ──
            with Vertical(id="cron-tab-jobs"):
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
                        yield Static("Timeout (seconds, 0=unlimited):", classes="form-label")
                        yield Input(placeholder="600", id="cf-timeout", value="600")
                        yield Button("+ Add Cron", variant="primary", id="btn-cron-add")
            # ── History tab ──
            with Vertical(id="cron-tab-history", classes="hidden"):
                yield Static("[dim]Select a cron job, then click History →[/]", id="history-job-label")
                with Horizontal(id="history-pane"):
                    yield VerticalScroll(id="history-run-list")
                    yield VerticalScroll(id="history-detail")
            with Horizontal(id="cron-footer"):
                yield Button("Close", variant="default", id="btn-cron-close")
                yield Button("Enable/Disable", variant="warning", id="btn-cron-toggle", disabled=True)
                yield Button("Remove", variant="error", id="btn-cron-remove", disabled=True)
                yield Button("View History", variant="primary", id="btn-cron-history", disabled=True)


    def on_mount(self):
        self._refresh_list()

    # ── Tab switching ──────────────────────────────────────────────────────

    def _switch_tab(self, tab: str):
        self._active_tab = tab
        jobs_tab = self.query_one("#cron-tab-jobs")
        history_tab = self.query_one("#cron-tab-history")
        btn_jobs = self.query_one("#tab-jobs")
        btn_history = self.query_one("#tab-history")

        if tab == "jobs":
            jobs_tab.remove_class("hidden")
            history_tab.add_class("hidden")
            btn_jobs.variant = "primary"
            btn_history.variant = "default"
        else:
            jobs_tab.add_class("hidden")
            history_tab.remove_class("hidden")
            btn_jobs.variant = "default"
            btn_history.variant = "primary"
            self._refresh_history()

    # ── Jobs tab ───────────────────────────────────────────────────────────

    def _refresh_list(self):
        # Guard against concurrent calls — Textual DOM ops are async under the hood
        if self._refresh_guard:
            return
        self._refresh_guard = True
        try:
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
                if cron.id == self._selected_id:
                    row_class += " selected"

                # Store cron ID in widget.name — no DOM id needed, eliminates DuplicateIds
                row = Static(
                    f"[{enabled_color} bold]{escape(cron.name)}[/]  "
                    f"[dim]{escape(cron.schedule)}[/]  "
                    f"[{status_color}]{status_icon}[/] "
                    f"[dim]next: {next_run}[/]\n"
                    f"[dim]{escape(cron.prompt[:45])}{'…' if len(cron.prompt) > 45 else ''}[/]\n"
                    f"[dim]model: {escape(cron.model)}  mode: {escape(cron.mode)}  runs: {cron.run_count}  fails: {cron.fail_count}[/]",
                    classes=row_class,
                    name=cron.id,  # ← identity stored here, NOT in id=
                )
                scroll.mount(row)
        finally:
            self._refresh_guard = False

    @on(events.Click, ".cron-row")
    def on_row_click(self, event: events.Click):
        try:
            widget = event.widget
            if not widget or not widget.name:
                return
            self._selected_id = widget.name  # read from .name, not .id
            for row in self.query(".cron-row"):
                if row.name == self._selected_id:
                    row.add_class("selected")
                else:
                    row.remove_class("selected")
            self._set_selected_buttons(True)
        except Exception:
            self._selected_id = None
            self._set_selected_buttons(False)

    # ── History tab ────────────────────────────────────────────────────────

    def _refresh_history(self):
        label = self.query_one("#history-job-label", Static)
        run_list = self.query_one("#history-run-list", VerticalScroll)
        detail = self.query_one("#history-detail", VerticalScroll)
        run_list.remove_children()
        detail.remove_children()

        if not self._selected_id:
            label.update("[dim]Select a cron job first, then click 'View History'[/]")
            return

        cron = next((c for c in self._scheduler.list() if c.id == self._selected_id), None)
        if not cron:
            label.update("[dim]Job not found.[/]")
            return

        self._history_job_id = cron.id
        label.update(f"[bold]{escape(cron.name)}[/] [dim]— Run History ({cron.run_count} runs, {cron.fail_count} fails)[/]")

        runs = self._scheduler.list_runs(cron.id, limit=30)
        if not runs:
            run_list.mount(Static("[dim]  No runs yet.[/]", id="history-empty"))
            return

        for run in runs:
            status_icon = {"running": "⟳", "success": "✓", "failed": "✗"}.get(run.status, "?")
            status_color = {"running": "yellow", "success": "green", "failed": "red"}.get(run.status, "dim")

            dur = ""
            if run.duration_ms:
                secs = run.duration_ms / 1000
                dur = f"{secs:.1f}s" if secs < 60 else f"{int(secs//60)}m {int(secs%60)}s"

            try:
                started = datetime.fromisoformat(run.started_at)
                delta = datetime.now(timezone.utc) - started
                mins = int(delta.total_seconds() / 60)
                if mins < 1:
                    time_ago = "just now"
                elif mins < 60:
                    time_ago = f"{mins}m ago"
                elif mins < 1440:
                    time_ago = f"{mins // 60}h ago"
                else:
                    time_ago = f"{mins // 1440}d ago"
            except Exception:
                time_ago = run.started_at[:16]

            tools = ", ".join(run.tools_used[:3]) if run.tools_used else "none"

            # Store run ID in widget.name — no DOM id
            row = Static(
                f"[{status_color}]{status_icon}[/] [bold]{escape(run.job_name)}[/]  "
                f"[dim]{time_ago}[/]  [dim]{dur}[/]\n"
                f"[dim]{escape(run.prompt[:50])}{'…' if len(run.prompt) > 50 else ''}[/]\n"
                f"[dim]tools: {escape(tools)}  model: {escape(run.model)}[/]",
                classes="history-row",
                name=run.id,  # ← identity in .name, not .id
            )
            run_list.mount(row)

    @on(events.Click, ".history-row")
    def on_history_row_click(self, event: events.Click):
        widget = event.widget
        if not widget or not widget.name:
            return
        run_id = widget.name  # read from .name
        self._selected_run_id = run_id
        for row in self.query(".history-row"):
            if row.name == run_id:
                row.add_class("selected")
            else:
                row.remove_class("selected")
        self._show_run_detail(run_id)

    def _show_run_detail(self, run_id: str):
        detail = self.query_one("#history-detail", VerticalScroll)
        detail.remove_children()

        if not self._history_job_id:
            return
        run = self._scheduler.get_run(self._history_job_id, run_id)
        if not run:
            detail.mount(Static("[dim]Run not found.[/]"))
            return

        status_color = {"running": "yellow", "success": "green", "failed": "red"}.get(run.status, "dim")
        dur = f"{run.duration_ms / 1000:.1f}s" if run.duration_ms else "N/A"

        detail.mount(Static(f"[bold]Run: {escape(run.id)}[/]"))
        detail.mount(Static(f"Status: [{status_color}]{run.status}[/]  Duration: {dur}"))
        detail.mount(Static(f"Started: {run.started_at[:19]}"))
        if run.finished_at:
            detail.mount(Static(f"Finished: {run.finished_at[:19]}"))
        detail.mount(Static(f"Model: {escape(run.model)}"))
        detail.mount(Static(""))

        if run.error:
            detail.mount(Static(f"[red]Error:[/] {escape(run.error)}"))
            detail.mount(Static(""))

        if run.tools_used:
            detail.mount(Static(f"[bold]Tools used:[/] {escape(', '.join(run.tools_used))}"))
        if run.files_modified:
            detail.mount(Static(f"[bold]Files modified:[/] {escape(', '.join(run.files_modified))}"))
        detail.mount(Static(""))

        if run.output_preview:
            detail.mount(Static("[bold]Output preview:[/]"))
            for line in run.output_preview.splitlines()[:20]:
                detail.mount(Static(f"  {escape(line)}"))
            if len(run.output_preview.splitlines()) > 20:
                detail.mount(Static(f"  [dim]... ({len(run.output_preview.splitlines())} total lines)[/]"))

        if run.messages:
            detail.mount(Static(""))
            detail.mount(Static(f"[bold]Messages:[/] {len(run.messages)}"))
            for msg in run.messages[-5:]:
                role = msg.get("role", "?")
                content = msg.get("content", "")
                if content:
                    preview = content[:100] + ("…" if len(content) > 100 else "")
                    detail.mount(Static(f"  [{role}] {escape(preview)}"))

    # ── Button handlers ────────────────────────────────────────────────────

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id

        try:
            if btn_id == "btn-cron-close":
                self.dismiss()

            elif btn_id == "tab-jobs":
                self._switch_tab("jobs")

            elif btn_id == "tab-history":
                self._switch_tab("history")

            elif btn_id == "btn-cron-add":
                self._try_add_cron()

            elif btn_id == "btn-cron-toggle":
                if self._selected_id:
                    # Check if this job is currently running — block toggle if so
                    try:
                        running_jobs = getattr(self.app, "_cron_running_jobs", set())
                        if self._selected_id in running_jobs:
                            name = next((c.name for c in self._scheduler.list() if c.id == self._selected_id), "this job")
                            try:
                                panel = self.app.query_one("CronStatusPanel")
                                panel.push_notification(f"[yellow]⚠ Cron '{escape(name)}' is currently running — wait for it to finish.[/]")
                            except Exception:
                                pass
                            return
                    except Exception:
                        pass
                    enabled = self._scheduler.toggle(self._selected_id)
                    if enabled is None:
                        self._selected_id = None
                        self._set_selected_buttons(False)
                    self._refresh_list()
                    try:
                        name = next((c.name for c in self._scheduler.list() if c.id == self._selected_id), "unknown")
                        state = "enabled" if enabled else "disabled"
                        panel = self.app.query_one("CronStatusPanel")
                        panel.push_notification(f"[dim]Cron '{name}' {state}.[/]")
                        self.app.refresh_cron_status()
                    except Exception:
                        pass

            elif btn_id == "btn-cron-remove":
                if self._selected_id:
                    try:
                        name = next((c.name for c in self._scheduler.list() if c.id == self._selected_id), "unknown")
                    except Exception:
                        name = "unknown"
                    self._scheduler.remove(self._selected_id)
                    self._selected_id = None
                    self._set_selected_buttons(False)
                    self._refresh_list()
                    try:
                        panel = self.app.query_one("CronStatusPanel")
                        panel.push_notification(f"[dim]Cron '{name}' removed.[/]")
                        self.app.refresh_cron_status()
                    except Exception:
                        pass

            elif btn_id == "btn-cron-history":
                if self._selected_id:
                    self._switch_tab("history")

        except Exception as e:
            self._selected_id = None
            self._set_selected_buttons(False)
            self._refresh_list()

    def _try_add_cron(self):
        from andromity.config import config
        name = self.query_one("#cf-name", Input).value.strip()
        prompt = self.query_one("#cf-prompt", Input).value.strip()
        schedule = self.query_one("#cf-schedule", Input).value.strip()
        mode = self.query_one("#cf-mode", Input).value.strip().lower() or "trust"
        allowed_raw = self.query_one("#cf-allowed", Input).value.strip()
        on_failure = self.query_one("#cf-onfail", Input).value.strip().lower() or "notify"
        try:
            timeout_seconds = int(self.query_one("#cf-timeout", Input).value.strip() or "600")
            timeout_seconds = max(0, timeout_seconds)
        except ValueError:
            timeout_seconds = 600

        try:
            panel = self.app.query_one("CronStatusPanel")
        except Exception:
            panel = None

        if not name or not prompt or not schedule:
            if panel: panel.push_notification("[red]Cron: Name, prompt, and schedule are required.[/]")
            return

        try:
            parse_interval_seconds(schedule)
        except ValueError as e:
            if panel: panel.push_notification(f"[red]Cron schedule error:[/] {e}")
            return

        if mode not in ("safe", "trust", "yolo"):
            if panel: panel.push_notification("[red]Cron mode must be safe, trust, or yolo.[/]")
            return

        allowed = [c.strip() for c in allowed_raw.split(",") if c.strip()]
        provider = config.get("default", "provider", "")
        model = config.get("default", "model", "")

        job = self._scheduler.add(
            name=name, prompt=prompt, schedule=schedule,
            provider=provider, model=model,
            mode=mode, allowed_commands=allowed, on_failure=on_failure,
            timeout_seconds=timeout_seconds,
        )

        for field_id in ("#cf-name", "#cf-prompt", "#cf-schedule", "#cf-allowed"):
            self.query_one(field_id, Input).clear()

        self._refresh_list()
        try:
            self.app.refresh_cron_status()
            if panel:
                panel.push_notification(
                    f"[green]✓ Cron added:[/] [bold]{escape(name)}[/] — {schedule}\n"
                    f"[dim]Provider: {provider}/{model}  mode: {mode}  on_failure: {on_failure}[/]"
                )
        except Exception:
            pass

    def _set_selected_buttons(self, enabled: bool):
        self.query_one("#btn-cron-toggle", Button).disabled = not enabled
        self.query_one("#btn-cron-remove", Button).disabled = not enabled
        self.query_one("#btn-cron-history", Button).disabled = not enabled

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss()
