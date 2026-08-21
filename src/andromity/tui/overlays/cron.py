"""Cron Manager Overlay — browse, add, run, enable/disable, remove cron jobs + run history.

A focused modal with keyboard-first navigation:
    ↑/↓ or j/k   move selection          Enter   toggle enable/disable
    R            run job now             H       view run history
    D or Delete  remove (confirm twice)  N       quick-add a job
    /            focus the filter box    Esc     close (or back to Jobs)

Creating a job takes one line: type `every 30m: run pytest and report` into
Quick add and press Enter. The add form (with templates and a live schedule
preview) covers the full options.
"""
from datetime import datetime, timezone

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, Input, Collapsible
from textual import events, on

from andromity.core.cron import CronJob, CronScheduler, parse_interval_seconds
from andromity.tui.markup_utils import escape_textual as escape


def parse_quick_add(text: str) -> tuple[str, str]:
    """Parse 'every 30m: run pytest and report' -> (schedule, prompt)."""
    text = text.strip()
    if ":" not in text:
        raise ValueError("Use 'schedule: prompt' — e.g. every 30m: run pytest")
    schedule, prompt = text.split(":", 1)
    schedule = schedule.strip().lower()
    prompt = prompt.strip()
    if not prompt:
        raise ValueError("Prompt is empty after the ':'")
    parse_interval_seconds(schedule)  # raises with a clear message if invalid
    return schedule, prompt


# Ready-made recipes — click to fill the add form.
TEMPLATES = {
    "tpl-tests":   {"name": "Run Tests",     "prompt": "Run the project test suite and report any failures or regressions.", "schedule": "every 30m", "mode": "trust"},
    "tpl-backup":  {"name": "Daily Backup",  "prompt": "Back up the project files and verify the backup completed.", "schedule": "every 1d", "mode": "safe"},
    "tpl-summary": {"name": "Daily Summary", "prompt": "Summarize what changed in this repository today.", "schedule": "every 1d", "mode": "safe"},
    "tpl-todo":    {"name": "Watch TODO",    "prompt": "Scan for new TODO/FIXME comments and report them.", "schedule": "every 1h", "mode": "safe"},
}


class CronManagerOverlay(ModalScreen):
    """Full-screen modal for managing cron jobs with run history."""

    DEFAULT_CSS = """\
CronManagerOverlay {
    align: center middle;
    background: $background 20%;
}
#cron-dialog {
    width: 94%; height: 92%;
    border: solid $accent-darken-2; background: $surface;
}
#cron-title-bar { height: 1; background: $accent-darken-2; }
#cron-title { width: 1fr; height: 1; padding: 0 1; color: $text; text-style: bold; }
#cron-title-count { height: 1; padding: 0 1; color: $text-muted; }
#cron-tabs { height: 3; padding: 0 1; align: left middle; }
#cron-tabs Button {
    height: 3; padding: 0 2; margin: 0 1 0 0;
    border: none; border-bottom: tall $surface-darken-3;
    background: transparent; color: $text-muted;
}
#cron-tabs Button:hover { color: $text; }
#cron-tabs Button.active { color: $text; text-style: bold; border-bottom: tall $accent; }
#cron-hint { width: 1fr; height: 1; color: $text-muted; content-align: right middle; }
.hidden { display: none; }
#cron-tab-jobs, #cron-tab-history { height: 1fr; }
#cron-body { height: 1fr; }
#cron-list-pane { width: 1fr; height: 1fr; border-right: solid $accent-darken-2; }
#cron-form-pane { width: 48; height: 1fr; padding: 1 2; }
#cf-quickadd { margin: 1 1 0 1; border: tall $accent-darken-1; }
#cf-quick-error { height: 1; margin: 0 1; color: $error; }
#cf-search { margin: 1 1 0 1; }
#cron-list-scroll { height: 1fr; overflow-y: auto; padding: 1; }
.cron-row { padding: 1; border-left: tall $surface-darken-3; border-bottom: solid $accent-darken-3; }
.cron-row:hover { background: $surface-lighten-1; }
.cron-row.running { border-left: tall $warning; }
.cron-row.failed  { border-left: tall $error; }
.cron-row.selected { background: $accent-darken-2; border-left: tall $primary; }
#cron-footer { dock: bottom; height: 1; padding: 0 1; background: $surface-darken-1; }
#cron-footer Button {
    height: 1 !important; width: auto !important; min-width: 0 !important;
    border: none !important; background: transparent !important;
    color: $text-muted !important; text-style: none !important;
    padding: 0 1 !important; margin: 0 !important;
}
#cron-footer Button:hover { color: $text !important; }
#cron-footer Button:focus { color: $text !important; text-style: bold; }
#cron-footer Button:disabled { color: $surface-darken-3 !important; }
#cron-footer #btn-cron-toggle:hover { color: $warning !important; }
#cron-footer #btn-cron-run:hover { color: $success !important; }
#cron-footer #btn-cron-history:hover { color: $accent !important; }
#cron-footer #btn-cron-remove:hover { color: $error !important; }
.form-header { height: 2; content-align: left middle; text-style: bold; }
#cron-form-pane Label { height: 1; color: $text-muted; }
#cron-form-pane Input { margin-bottom: 1; }
#cron-form-pane Collapsible { border: none; padding: 0; margin: 0 0 1 0; }
#cf-schedule-hint { height: 1; margin: 0 0 1 0; }
#cf-templates Button {
    height: 1; width: 100%; border: none; background: transparent;
    padding: 0; color: $text-muted; margin: 0;
}
#cf-templates Button:hover { color: $accent; }
#cf-error { height: auto; min-height: 1; color: $error; }
#cf-add { margin: 1 0; }
/* History tab */
#history-pane { height: 1fr; }
#history-job-label { padding: 0 1; height: 3; background: $surface-darken-1; }
#history-run-list { height: 1fr; overflow-y: auto; padding: 1; }
#history-detail { width: 52; height: 1fr; border-left: solid $accent-darken-2; padding: 1; overflow-y: auto; }
.history-row { padding: 1; border-left: tall $surface-darken-3; border-bottom: solid $accent-darken-3; }
.history-row:hover { background: $surface-lighten-1; }
.history-row.selected { background: $accent-darken-2; border-left: tall $primary; }
#history-empty { padding: 2; }
"""

    def __init__(self, scheduler: CronScheduler, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._scheduler = scheduler
        self._project_path = project_path
        self._selected_id: str | None = None
        self._row_ids: list[str] = []
        self._selected_run_id: str | None = None
        self._run_row_ids: list[str] = []
        self._active_tab = "jobs"  # "jobs" | "history"
        self._history_job_id: str | None = None
        self._filter: str = ""
        self._pending_delete_id: str | None = None
        self._refresh_guard: bool = False  # prevents concurrent _refresh_list calls

    # ── Compose ────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        with Vertical(id="cron-dialog"):
            with Horizontal(id="cron-title-bar"):
                yield Static("⏱ Cron Manager", id="cron-title")
                yield Static("", id="cron-title-count")
            with Horizontal(id="cron-tabs"):
                yield Button("Jobs", id="tab-jobs", classes="active")
                yield Button("History", id="tab-history")
                yield Static("", id="cron-hint")
            # ── Jobs tab ──
            with Vertical(id="cron-tab-jobs"):
                with Horizontal(id="cron-body"):
                    with Vertical(id="cron-list-pane"):
                        yield Input(placeholder="Quick add — every 30m: run pytest and report", id="cf-quickadd")
                        yield Static("", id="cf-quick-error")
                        yield Input(placeholder="Filter jobs…", id="cf-search")
                        yield VerticalScroll(id="cron-list-scroll")
                    with VerticalScroll(id="cron-form-pane"):
                        yield Static("＋ Add Cron", classes="form-header")
                        with Collapsible(title="Templates — click to fill the form", collapsed=True, id="cf-templates"):
                            yield Button("Run tests (every 30m)", id="tpl-tests")
                            yield Button("Daily backup (every 1d)", id="tpl-backup")
                            yield Button("Daily summary (every 1d)", id="tpl-summary")
                            yield Button("Watch TODO (every 1h)", id="tpl-todo")
                        yield Static("Name:", id="lbl-name")
                        yield Input(placeholder="e.g. Run Tests", id="cf-name")
                        yield Static("Prompt:", id="lbl-prompt")
                        yield Input(placeholder="e.g. run pytest and report", id="cf-prompt")
                        yield Static("Schedule:", id="lbl-schedule")
                        yield Input(placeholder="every 30m / every 2h / every 1d", id="cf-schedule")
                        yield Static("", id="cf-schedule-hint")
                        yield Static("Mode:", id="lbl-mode")
                        yield Input(placeholder="safe / trust / yolo", id="cf-mode", value="trust")
                        with Collapsible(title="Advanced — allowed cmds · on failure · timeout", collapsed=True, id="cf-advanced"):
                            yield Static("Allowed cmds (comma-sep):", id="lbl-allowed")
                            yield Input(placeholder="pytest, git status", id="cf-allowed")
                            yield Static("On failure:", id="lbl-onfail")
                            yield Input(placeholder="notify / disable / retry", id="cf-onfail", value="notify")
                            yield Static("Timeout (seconds, 0=unlimited):", id="lbl-timeout")
                            yield Input(placeholder="600", id="cf-timeout", value="600")
                        yield Button("＋ Add Cron", variant="primary", id="cf-add")
                        yield Static("", id="cf-error")
            # ── History tab ──
            with Vertical(id="cron-tab-history", classes="hidden"):
                yield Static("[dim]Select a cron job, then press H →[/]", id="history-job-label")
                with Horizontal(id="history-pane"):
                    yield VerticalScroll(id="history-run-list")
                    yield VerticalScroll(id="history-detail")
            with Horizontal(id="cron-footer"):
                yield Button("Close", id="btn-cron-close")
                yield Button("Enable/Disable", id="btn-cron-toggle", disabled=True)
                yield Button("▶ Run Now", id="btn-cron-run", disabled=True)
                yield Button("History", id="btn-cron-history", disabled=True)
                yield Button("Remove", id="btn-cron-remove", disabled=True)

    def on_mount(self):
        self._update_title()
        self._update_hint()
        self._refresh_list()
        # Tab order starts at the quick-add box, not the tab switcher (tabs are
        # switched with H/click anyway).
        for tid in ("#tab-jobs", "#tab-history"):
            try:
                self.query_one(tid).can_focus = False
            except Exception:
                pass
        # No jobs yet → land on the Name field so the first action is natural;
        # otherwise keyboard-first: blur so ↑/↓ work immediately.
        if not self._scheduler.list():
            self.call_after_refresh(self._focus_name_field)
        else:
            self.call_after_refresh(self._enter_keyboard_mode)

    def _enter_keyboard_mode(self):
        try:
            self.set_focus(None)
        except Exception:
            pass

    # ── Small helpers ──────────────────────────────────────────────────────

    def _running_ids(self) -> set:
        try:
            return set(getattr(self.app, "_cron_running_jobs", set()))
        except Exception:
            return set()

    def _update_title(self):
        try:
            crons = self._scheduler.list()
            enabled = sum(1 for c in crons if c.enabled)
            running = len(self._running_ids() & {c.id for c in crons})
            parts = [f"{len(crons)} job{'s' if len(crons) != 1 else ''}", f"{enabled} enabled"]
            if running:
                parts.append(f"{running} running")
            self.query_one("#cron-title-count", Static).update(" · ".join(parts))
        except Exception:
            pass

    def _update_hint(self):
        try:
            hint = self.query_one("#cron-hint", Static)
            if self._active_tab == "history":
                hint.update("↑/↓ select run · H jobs · Esc close")
            else:
                hint.update("↑/↓ move · Enter toggle · R run · H history · D remove · N add")
        except Exception:
            pass

    def _set_selected_buttons(self, enabled: bool):
        self.query_one("#btn-cron-toggle", Button).disabled = not enabled
        self.query_one("#btn-cron-run", Button).disabled = not enabled
        self.query_one("#btn-cron-remove", Button).disabled = not enabled
        self.query_one("#btn-cron-history", Button).disabled = not enabled

    def _sync_remove_button(self):
        btn = self.query_one("#btn-cron-remove", Button)
        btn.label = "⚠ Confirm Remove" if self._pending_delete_id else "Remove"

    def _clear_pending_delete(self):
        if self._pending_delete_id:
            self._pending_delete_id = None
            self._sync_remove_button()

    # ── Tab switching ──────────────────────────────────────────────────────

    def _switch_tab(self, tab: str):
        self._active_tab = tab
        self.query_one("#cron-tab-jobs").set_class(tab != "jobs", "hidden")
        self.query_one("#cron-tab-history").set_class(tab != "history", "hidden")
        self.query_one("#tab-jobs").set_class(tab == "jobs", "active")
        self.query_one("#tab-history").set_class(tab == "history", "active")
        if tab == "history":
            self._refresh_history()
        self._update_hint()
        self._enter_keyboard_mode()

    # ── Jobs tab ───────────────────────────────────────────────────────────

    def _refresh_list(self):
        # Guard against concurrent calls — Textual DOM ops are async under the hood
        if self._refresh_guard:
            return
        self._refresh_guard = True
        try:
            scroll = self.query_one("#cron-list-scroll", VerticalScroll)
            scroll.remove_children()

            crons = [c for c in self._scheduler.list()
                     if not self._filter or self._filter in c.name.lower() or self._filter in c.prompt.lower()]
            self._row_ids = [c.id for c in crons]

            if not crons:
                scroll.mount(Static("[dim]  No cron jobs" +
                                    (" match your filter." if self._filter else " yet — add one with the form on the right.") + "[/]"))
                return

            running_ids = self._running_ids()
            for cron in crons:
                scroll.mount(self._render_row(cron, running_ids))
            self._update_title()
        finally:
            self._refresh_guard = False

    def _render_row(self, cron: CronJob, running_ids: set) -> Static:
        running = cron.id in running_ids
        name_color = "green" if cron.enabled else "dim"
        status_icon = {"never": "○", "success": "✓", "failed": "✗", "timeout": "✗"}.get(cron.last_status, "○")
        status_color = {"never": "dim", "success": "green", "failed": "red", "timeout": "red"}.get(cron.last_status, "dim")

        if running:
            head = (f"[yellow]⟳[/] [{name_color} bold]{escape(cron.name)}[/]  "
                    f"[dim]{escape(cron.schedule)}[/]  [yellow]running…[/]")
        else:
            next_run = cron.next_run_in() if cron.enabled else "disabled"
            head = (f"[{status_color}]{status_icon}[/] [{name_color} bold]{escape(cron.name)}[/]  "
                    f"[dim]{escape(cron.schedule)}[/]  [dim]next: {next_run}[/]")

        prompt_line = f"[dim]{escape(cron.prompt[:45])}{'…' if len(cron.prompt) > 45 else ''}[/]"

        meta = f"[dim]{cron.run_count} runs · {cron.fail_count} fails · {escape(cron.mode)} mode[/]"
        recent = self._scheduler.list_runs(cron.id, limit=6)
        if recent:
            dot_map = {"running": ("⟳", "yellow"), "success": ("✓", "green"), "failed": ("✗", "red")}
            dots = " ".join(f"[{c}]{s}[/{c}]" for s, c in (dot_map.get(r.status, ("○", "dim")) for r in recent))
            meta += f" · {dots}"
        if cron.last_error and not running:
            meta += f"\n[red]last error:[/] {escape(cron.last_error[:60])}"

        classes = ["cron-row"]
        if cron.id == self._selected_id:
            classes.append("selected")
        if running:
            classes.append("running")
        elif cron.last_status in ("failed", "timeout"):
            classes.append("failed")

        return Static(f"{head}\n{prompt_line}\n{meta}", classes=" ".join(classes), name=cron.id)

    def _select_row(self, job_id: str):
        self._selected_id = job_id
        for row in self.query(".cron-row"):
            if row.name == job_id:
                row.add_class("selected")
                try:
                    row.scroll_visible()
                except Exception:
                    pass
            else:
                row.remove_class("selected")
        self._set_selected_buttons(True)
        self._clear_pending_delete()

    def _move_selection(self, delta: int):
        if self._active_tab == "history":
            self._move_run_selection(delta)
            return
        ids = self._row_ids
        if not ids:
            return
        if self._selected_id not in ids:
            self._select_row(ids[0] if delta > 0 else ids[-1])
            return
        idx = ids.index(self._selected_id)
        new_idx = max(0, min(len(ids) - 1, idx + delta))
        if new_idx != idx:
            self._select_row(ids[new_idx])

    @on(events.Click, ".cron-row")
    def on_row_click(self, event: events.Click):
        try:
            widget = event.widget
            if not widget or not widget.name:
                return
            self._select_row(widget.name)
            self._enter_keyboard_mode()
        except Exception:
            self._selected_id = None
            self._set_selected_buttons(False)

    @on(Input.Changed, "#cf-search")
    def on_search_changed(self, event: Input.Changed):
        self._filter = event.value.strip().lower()
        if self._selected_id not in self._row_ids:
            self._selected_id = None
            self._set_selected_buttons(False)
        self._refresh_list()

    # ── Quick add ──────────────────────────────────────────────────────────

    @on(Input.Submitted, "#cf-quickadd")
    def on_quickadd_submitted(self):
        self._try_quick_add()

    @on(Input.Changed, "#cf-quickadd")
    def on_quickadd_changed(self):
        self.query_one("#cf-quick-error", Static).update("")

    def _try_quick_add(self):
        raw = self.query_one("#cf-quickadd", Input).value
        try:
            schedule, prompt = parse_quick_add(raw)
        except ValueError as e:
            self.query_one("#cf-quick-error", Static).update(f"[red]⚠ {escape(str(e))}[/]")
            return
        from andromity.config import config
        name = prompt[:24] + ("…" if len(prompt) > 24 else "")
        provider = config.get("default", "provider", "")
        model = config.get("default", "model", "")
        job = self._scheduler.add(
            name=name, prompt=prompt, schedule=schedule,
            provider=provider, model=model, mode="trust",
        )
        self.query_one("#cf-quickadd", Input).value = ""
        self.query_one("#cf-quick-error", Static).update("")
        self._refresh_list()
        self._update_title()
        self._select_row(job.id)
        self.notify(f"✓ Cron added: {escape(name)} — {schedule}", timeout=3)
        try:
            self.app.refresh_cron_status()
        except Exception:
            pass

    # ── Live schedule preview ──────────────────────────────────────────────

    @on(Input.Changed, "#cf-schedule")
    def on_schedule_changed(self, event: Input.Changed):
        value = event.value.strip().lower()
        hint = self.query_one("#cf-schedule-hint", Static)
        if not value:
            hint.update("")
            return
        try:
            secs = parse_interval_seconds(value)
            if secs < 3600:
                human = f"{secs // 60}m"
            elif secs < 86400:
                human = f"{secs // 3600}h"
            else:
                human = f"{secs // 86400}d"
            hint.update(f"[green]✓ runs every ~{human}[/]")
        except ValueError as e:
            hint.update(f"[red]⚠ {escape(str(e))}[/]")

    # ── History tab ────────────────────────────────────────────────────────

    def _refresh_history(self):
        label = self.query_one("#history-job-label", Static)
        run_list = self.query_one("#history-run-list", VerticalScroll)
        detail = self.query_one("#history-detail", VerticalScroll)
        run_list.remove_children()
        detail.remove_children()

        if not self._selected_id:
            label.update("[dim]Select a cron job first, then press H[/]")
            return

        cron = next((c for c in self._scheduler.list() if c.id == self._selected_id), None)
        if not cron:
            label.update("[dim]Job not found.[/]")
            return

        self._history_job_id = cron.id
        label.update(f"[bold]{escape(cron.name)}[/] [dim]— Run History ({cron.run_count} runs, {cron.fail_count} fails)[/]")

        runs = self._scheduler.list_runs(cron.id, limit=30)
        self._run_row_ids = [r.id for r in runs]
        if not runs:
            run_list.mount(Static("[dim]  No runs yet.[/]", id="history-empty"))
            return

        for run in runs:
            status_icon = {"running": "⟳", "success": "✓", "failed": "✗"}.get(run.status, "?")
            status_color = {"running": "yellow", "success": "green", "failed": "red"}.get(run.status, "dim")

            dur = ""
            if run.duration_ms:
                secs = run.duration_ms / 1000
                dur = f"{secs:.1f}s" if secs < 60 else f"{int(secs // 60)}m {int(secs % 60)}s"

            time_ago = self._time_ago(run.started_at)
            tools = ", ".join(run.tools_used[:3]) if run.tools_used else "none"

            classes = "history-row" + (" selected" if run.id == self._selected_run_id else "")
            row = Static(
                f"[{status_color}]{status_icon}[/] [bold]{escape(run.job_name)}[/]  "
                f"[dim]{time_ago}[/]  [dim]{dur}[/]\n"
                f"[dim]{escape(run.prompt[:50])}{'…' if len(run.prompt) > 50 else ''}[/]\n"
                f"[dim]tools: {escape(tools)}  model: {escape(run.model)}[/]",
                classes=classes,
                name=run.id,
            )
            run_list.mount(row)

    @staticmethod
    def _time_ago(iso: str) -> str:
        try:
            started = datetime.fromisoformat(iso)
            delta = datetime.now(timezone.utc) - started
            mins = int(delta.total_seconds() / 60)
            if mins < 1:
                return "just now"
            if mins < 60:
                return f"{mins}m ago"
            if mins < 1440:
                return f"{mins // 60}h ago"
            return f"{mins // 1440}d ago"
        except Exception:
            return iso[:16]

    def _select_run(self, run_id: str):
        self._selected_run_id = run_id
        for row in self.query(".history-row"):
            if row.name == run_id:
                row.add_class("selected")
                try:
                    row.scroll_visible()
                except Exception:
                    pass
            else:
                row.remove_class("selected")
        self._show_run_detail(run_id)

    def _move_run_selection(self, delta: int):
        ids = self._run_row_ids
        if not ids:
            return
        if self._selected_run_id not in ids:
            self._select_run(ids[0] if delta > 0 else ids[-1])
            return
        idx = ids.index(self._selected_run_id)
        new_idx = max(0, min(len(ids) - 1, idx + delta))
        if new_idx != idx:
            self._select_run(ids[new_idx])

    @on(events.Click, ".history-row")
    def on_history_row_click(self, event: events.Click):
        widget = event.widget
        if not widget or not widget.name:
            return
        self._select_run(widget.name)
        self._enter_keyboard_mode()

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

    # ── Actions ────────────────────────────────────────────────────────────

    def _toggle_selected(self):
        if not self._selected_id:
            return
        if self._selected_id in self._running_ids():
            self.notify("This cron is currently running — wait for it to finish.", severity="warning", timeout=4)
            return
        enabled = self._scheduler.toggle(self._selected_id)
        if enabled is None:
            self._selected_id = None
            self._set_selected_buttons(False)
            self._refresh_list()
            return
        name = next((c.name for c in self._scheduler.list() if c.id == self._selected_id), "job")
        self.notify(f"Cron '{name}' {'enabled' if enabled else 'disabled'}.", timeout=3)
        self._refresh_list()
        self._update_title()
        try:
            self.app.refresh_cron_status()
        except Exception:
            pass

    def _run_selected(self):
        if not self._selected_id:
            return
        if self._selected_id in self._running_ids():
            self.notify("This cron is already running — wait for it to finish.", severity="warning", timeout=4)
            return
        cron = next((c for c in self._scheduler.list() if c.id == self._selected_id), None)
        if cron is None:
            return
        ok = self._scheduler.run_now(cron.id)
        if ok:
            self.notify(f"⏱ Triggered '{cron.name}' manually.", timeout=3)
        else:
            self.notify(f"Could not trigger '{cron.name}'.", severity="error", timeout=4)
        self._refresh_list()
        try:
            self.app.refresh_cron_status()
        except Exception:
            pass

    def _remove_selected(self):
        if not self._selected_id:
            return
        if self._selected_id in self._running_ids():
            self.notify("This cron is currently running — wait for it to finish.", severity="warning", timeout=4)
            return
        if self._pending_delete_id != self._selected_id:
            # First press arms the delete; second press confirms.
            self._pending_delete_id = self._selected_id
            self._sync_remove_button()
            self.notify("Press Delete/Remove again to confirm.", severity="warning", timeout=4)
            return
        name = next((c.name for c in self._scheduler.list() if c.id == self._selected_id), "job")
        self._scheduler.remove(self._selected_id)
        self._pending_delete_id = None
        self._selected_id = None
        self._set_selected_buttons(False)
        self._refresh_list()
        self._sync_remove_button()
        self.notify(f"Cron '{name}' removed.", timeout=3)
        try:
            self.app.refresh_cron_status()
        except Exception:
            pass

    def _focus_search(self):
        try:
            self.query_one("#cf-search", Input).focus()
        except Exception:
            pass

    def _focus_quick_add(self):
        try:
            self.query_one("#cf-quickadd", Input).focus()
        except Exception:
            pass

    def _focus_name_field(self):
        try:
            self.query_one("#cf-name", Input).focus()
        except Exception:
            pass

    def _apply_template(self, tpl_id: str):
        t = TEMPLATES.get(tpl_id)
        if not t:
            return
        self.query_one("#cf-name", Input).value = t["name"]
        self.query_one("#cf-prompt", Input).value = t["prompt"]
        self.query_one("#cf-schedule", Input).value = t["schedule"]
        self.query_one("#cf-mode", Input).value = t["mode"]
        try:
            self.query_one("#cf-advanced", Collapsible).collapsed = False
        except Exception:
            pass
        self.notify(f"Template '{t['name']}' filled — tweak, then press ＋ Add Cron.", timeout=3)

    # ── Add form ───────────────────────────────────────────────────────────

    def _form_error(self, msg: str):
        self.query_one("#cf-error", Static).update(f"[red]⚠ {escape(msg)}[/]")

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

        if not name or not prompt or not schedule:
            self._form_error("Name, prompt, and schedule are required.")
            return
        try:
            parse_interval_seconds(schedule)
        except ValueError as e:
            self._form_error(str(e))
            return
        if mode not in ("safe", "trust", "yolo"):
            self._form_error("Mode must be safe, trust, or yolo.")
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
        self._form_error("")

        self._refresh_list()
        self._update_title()
        self._select_row(job.id)
        self.notify(f"✓ Cron added: {name} — {schedule}", timeout=3)
        try:
            self.app.refresh_cron_status()
        except Exception:
            pass

    # ── Buttons ────────────────────────────────────────────────────────────

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id
        try:
            if btn_id == "btn-cron-close":
                self.dismiss()
            elif btn_id == "tab-jobs":
                self._switch_tab("jobs")
            elif btn_id == "tab-history":
                self._switch_tab("history")
            elif btn_id == "cf-add":
                self._try_add_cron()
            elif btn_id in TEMPLATES:
                self._apply_template(btn_id)
            elif btn_id == "btn-cron-toggle":
                self._toggle_selected()
            elif btn_id == "btn-cron-run":
                self._run_selected()
            elif btn_id == "btn-cron-remove":
                self._remove_selected()
            elif btn_id == "btn-cron-history":
                if self._selected_id:
                    self._switch_tab("history")
        except Exception as e:
            self._selected_id = None
            self._set_selected_buttons(False)
            self._refresh_list()

    # ── Keyboard ───────────────────────────────────────────────────────────

    def on_key(self, event):
        key = event.key
        focused = self.focused
        typing = isinstance(focused, Input)

        if key == "escape":
            # Consume the key so it never reaches the app's global escape
            # binding (which cancels the streaming AI response on 2 presses).
            event.stop()
            if self._pending_delete_id:
                self._clear_pending_delete()
            elif self._active_tab == "history":
                self._switch_tab("jobs")
            else:
                self.dismiss()
            return

        if key in ("up", "down"):
            self._move_selection(-1 if key == "up" else 1)
            return

        if key == "enter":
            # Let focused buttons activate themselves. In text inputs, only the
            # search box "submits" — it's a filter, so Enter acts on the row.
            if isinstance(focused, Button):
                return
            if typing and getattr(focused, "id", None) != "cf-search":
                return
            self._toggle_selected()
            return

        # Text-typing keys — never hijack while the user is in an input.
        if typing:
            return

        if key in ("home", "end"):
            # Jump to the first / last job or run.
            if self._active_tab == "history":
                if self._run_row_ids:
                    self._select_run(self._run_row_ids[0] if key == "home" else self._run_row_ids[-1])
            elif self._row_ids:
                self._select_row(self._row_ids[0] if key == "home" else self._row_ids[-1])
            return

        if key in ("j", "k"):
            self._move_selection(-1 if key == "k" else 1)
        elif key == "r":
            self._run_selected()
        elif key == "h":
            if self._selected_id:
                self._switch_tab("history" if self._active_tab == "jobs" else "jobs")
        elif key in ("d", "delete"):
            self._remove_selected()
        elif key == "n":
            self._focus_quick_add()
        elif key == "slash":
            self._focus_search()
