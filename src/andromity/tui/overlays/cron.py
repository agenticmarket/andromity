"""Cron Manager Overlay — browse, add, run, enable/disable, remove cron jobs + rich run history.

A focused modal with keyboard-first navigation:
    Jobs tab:
        ↑/↓ or j/k   move selection          Enter   toggle enable/disable
        R            run job now             H       view run history
        D or Delete  remove (confirm twice)  N       quick-add a job
        /            focus the filter box    Esc     close
    History tab:
        ↑/↓ or j/k   move run selection      Tab     toggle list / detail focus
        PageUp/Down  scroll output/detail    c       copy output to clipboard
        C / Ctrl+C   copy full run log       v / Ent open fullscreen log viewer
        O or S       open / load session     R       rerun job now
        D / Delete   delete run              H / Esc back to Jobs tab

Creating a job takes one line: type `every 30m: run pytest and report` into
Quick add and press Enter. The add form (with templates and a live schedule
preview) covers the full options.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, Input, Collapsible
from textual import events, on

from andromity.core.cron import CronJob, CronRun, CronScheduler, parse_interval_seconds
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


class CronRunLogModal(ModalScreen):
    """Fullscreen modal for inspecting, searching, and copying long cron run outputs."""

    DEFAULT_CSS = """\
CronRunLogModal {
    align: center middle;
    background: $background 40%;
}
#run-log-dialog {
    width: 94%; height: 92%;
    border: solid $accent-darken-1;
    background: $surface;
}
#run-log-title-bar {
    height: 1;
    background: $accent-darken-2;
    padding: 0 1;
}
#run-log-title { width: 1fr; color: $text; text-style: bold; }
#run-log-actions {
    height: 3;
    padding: 0 1;
    border-bottom: solid $surface-lighten-1;
    align: left middle;
}
#run-log-actions Button {
    height: 1 !important; min-width: 10 !important;
    border: none !important; background: $surface-lighten-1 !important;
    color: $text-muted !important; margin-right: 1; padding: 0 1 !important;
}
#run-log-actions Button:hover {
    background: $surface-lighten-2 !important; color: $text !important;
}
#run-log-actions #btn-modal-copy-out:hover {
    background: $accent !important; color: $background !important;
}
#run-log-filter { margin: 1 1 0 1; }
#run-log-content {
    height: 1fr;
    padding: 1 2;
    overflow-y: auto;
}
.log-line { margin-bottom: 0; }
"""

    def __init__(self, run: CronRun, **kwargs):
        super().__init__(**kwargs)
        self._run = run
        self._filter_text: str = ""

    def compose(self) -> ComposeResult:
        with Vertical(id="run-log-dialog"):
            with Horizontal(id="run-log-title-bar"):
                yield Static(f"⏱ Run Log — {self._run.job_name} ({self._run.id})", id="run-log-title")
            with Horizontal(id="run-log-actions"):
                yield Button("📋 Copy Output (c)", id="btn-modal-copy-out")
                yield Button("📋 Copy Full Log (C)", id="btn-modal-copy-full")
                yield Button("Close (Esc)", id="btn-modal-close")
            yield Input(placeholder="Search / filter log output…", id="run-log-filter")
            yield VerticalScroll(id="run-log-content")

    def on_mount(self):
        self._render_content()

    def _render_content(self):
        content = self.query_one("#run-log-content", VerticalScroll)
        content.remove_children()

        status_color = {"running": "cyan", "success": "green", "failed": "red", "timeout": "yellow", "interrupted": "dim red"}.get(self._run.status, "dim")
        dur = f"{self._run.duration_ms / 1000:.1f}s" if self._run.duration_ms else "N/A"

        header_text = (
            f"[bold]Run ID:[/] {escape(self._run.id)}  "
            f"[bold]Status:[/] [{status_color}]{self._run.status}[/]  "
            f"[bold]Duration:[/] {dur}\n"
            f"[dim]Started: {self._run.started_at[:19]}  "
            f"Finished: {self._run.finished_at[:19] if self._run.finished_at else 'running…'}  "
            f"Model: {escape(self._run.model)}[/]"
        )
        content.mount(Static(header_text))
        content.mount(Static("─" * 60, classes="dim"))

        if self._run.error:
            content.mount(Static(f"[red bold]Error:[/] {escape(self._run.error)}"))
            content.mount(Static("─" * 60, classes="dim"))

        full_output = self._run.output or self._run.output_preview or "(No text output)"
        lines = full_output.splitlines()
        if self._filter_text:
            lines = [line for line in lines if self._filter_text in line.lower()]

        content.mount(Static(f"[bold accent]Output ({len(lines)} lines):[/]"))
        for line in lines:
            content.mount(Static(f"  {escape(line)}", classes="log-line"))

        if self._run.tool_executions:
            content.mount(Static(""))
            content.mount(Static("─" * 60, classes="dim"))
            content.mount(Static(f"[bold accent]Tool Executions ({len(self._run.tool_executions)}):[/]"))
            for te in self._run.tool_executions:
                name = te.get("tool_name", "tool")
                dur_ms = te.get("duration_ms", 0)
                status = te.get("status", "ok")
                args = json.dumps(te.get("args", {}))
                res = str(te.get("result", ""))[:300]
                color = "green" if status == "ok" else "red"
                content.mount(Static(f"  [{color}]•[/] [bold]{name}[/] [dim]({dur_ms}ms)[/]"))
                content.mount(Static(f"    [dim]args:[/] {escape(args)}"))
                if res:
                    content.mount(Static(f"    [dim]result:[/] {escape(res)}"))

    @on(Input.Changed, "#run-log-filter")
    def on_filter_changed(self, event: Input.Changed):
        self._filter_text = event.value.strip().lower()
        self._render_content()

    def _copy_output(self):
        text = self._run.output or self._run.output_preview or ""
        if text:
            try:
                self.app.copy_to_clipboard(text)
                self.notify("✓ Output copied to clipboard", timeout=3)
            except Exception as e:
                self.notify(f"Copy failed: {e}", severity="error", timeout=4)
        else:
            self.notify("No output to copy", severity="warning", timeout=3)

    def _copy_full_log(self):
        parts = [
            f"# Cron Run: {self._run.job_name} ({self._run.id})",
            f"- Status: {self._run.status}",
            f"- Duration: {self._run.duration_ms / 1000:.1f}s" if self._run.duration_ms else "- Duration: N/A",
            f"- Started: {self._run.started_at}",
            f"- Finished: {self._run.finished_at or 'N/A'}",
            f"- Model: {self._run.model}",
            f"- Prompt: {self._run.prompt}",
        ]
        if self._run.error:
            parts.append(f"\n## Error\n```\n{self._run.error}\n```")
        if self._run.tools_used:
            parts.append(f"\n## Tools Used\n" + ", ".join(self._run.tools_used))
        if self._run.files_modified:
            parts.append(f"\n## Files Modified\n" + "\n".join(f"- {f}" for f in self._run.files_modified))
        output = self._run.output or self._run.output_preview or ""
        if output:
            parts.append(f"\n## Output\n```\n{output}\n```")
        log_text = "\n".join(parts)
        try:
            self.app.copy_to_clipboard(log_text)
            self.notify("✓ Full run log copied to clipboard", timeout=3)
        except Exception as e:
            self.notify(f"Copy failed: {e}", severity="error", timeout=4)

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "btn-modal-close":
            self.dismiss()
        elif event.button.id == "btn-modal-copy-out":
            self._copy_output()
        elif event.button.id == "btn-modal-copy-full":
            self._copy_full_log()

    def on_key(self, event):
        if event.key == "escape":
            event.stop()
            self.dismiss()
        elif not isinstance(self.focused, Input):
            if event.key == "c":
                self._copy_output()
            elif event.key == "C":
                self._copy_full_log()


class CronManagerOverlay(ModalScreen):
    """Full-screen modal for managing cron jobs with run history."""

    DEFAULT_CSS = """\
CronManagerOverlay {
    align: center middle;
    background: $background 30%;
}
#cron-dialog {
    width: 94%; height: 92%;
    border: solid $accent-darken-2;
    background: $surface;
}
#cron-title-bar {
    height: 1;
    background: $accent-darken-2;
}
#cron-title { width: 1fr; height: 1; padding: 0 1; color: $text; text-style: bold; }
#cron-title-count { height: 1; padding: 0 1; color: $text-muted; }
#cron-tabs { height: 3; padding: 0 1; align: left middle; border-bottom: solid $surface-lighten-1; }
#cron-tabs Button {
    height: 2; padding: 0 2; margin: 0 1 0 0;
    border: none;
    background: transparent; color: $text-muted;
}
#cron-tabs Button:hover { color: $text; }
#cron-tabs Button.active { color: $accent; text-style: bold; border-bottom: solid $accent; }
#cron-hint { width: 1fr; height: 1; color: $text-muted; content-align: right middle; }
.hidden { display: none; }
#cron-tab-jobs, #cron-tab-history { height: 1fr; }
#cron-body { height: 1fr; }
#cron-list-pane { width: 1fr; height: 1fr; border-right: solid $surface-lighten-1; }
#cron-form-pane { width: 48; height: 1fr; padding: 1 2; }
#cf-quickadd { margin: 1 1 0 1; border: tall $accent-darken-1; }
#cf-quick-error { height: 1; margin: 0 1; color: $error; }
#cf-search { margin: 1 1 0 1; }
#cron-list-scroll { height: 1fr; overflow-y: auto; padding: 1; }
.cron-row { padding: 1; border-left: tall $surface-darken-3; border-bottom: solid $surface-lighten-1; }
.cron-row:hover { background: $surface-lighten-1; }
.cron-row.running { border-left: tall $warning; }
.cron-row.failed  { border-left: tall $error; }
.cron-row.selected { background: $surface-lighten-1; border-left: tall $accent; }
#cron-footer {
    dock: bottom;
    height: 3;
    padding: 0 1;
    background: $surface-darken-2;
    border-top: solid $surface-lighten-1;
    align: left middle;
}
#cron-footer Button {
    height: 1 !important; width: auto !important; min-width: 10 !important;
    border: none !important; background: $surface-lighten-1 !important;
    color: $text-muted !important; text-style: none !important;
    padding: 0 1 !important; margin: 0 1 0 0 !important;
}
#cron-footer Button:hover {
    background: $surface-lighten-2 !important;
    color: $text !important;
}
#cron-footer Button:focus {
    background: $surface-lighten-2 !important;
    color: $text !important;
    text-style: bold !important;
}
#cron-footer Button:disabled {
    background: transparent !important;
    color: $text-muted 40% !important;
}
#cron-footer #btn-cron-run:enabled:hover, #cron-footer #btn-hist-run-now:enabled:hover {
    background: $success !important;
    color: $background !important;
}
#cron-footer #btn-cron-remove:enabled:hover, #cron-footer #btn-hist-delete-run:enabled:hover {
    background: $error !important;
    color: $text !important;
}
#cron-footer #btn-hist-copy-out:enabled:hover, #cron-footer #btn-hist-copy-log:enabled:hover {
    background: $accent !important;
    color: $background !important;
}
.form-header { height: 2; content-align: left middle; text-style: bold; color: $accent; }
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
#cf-add {
    height: 1;
    min-width: 14;
    margin: 1 0;
    padding: 0 2;
    border: none;
    background: $accent;
    color: $background;
    text-style: bold;
}
#cf-add:hover, #cf-add:focus {
    background: $accent-lighten-1;
    color: $background;
}
/* History tab */
#history-pane { height: 1fr; }
#history-job-label { padding: 0 1; height: 3; background: $surface-darken-1; }
#history-run-list { width: 38; height: 1fr; border-right: solid $surface-lighten-1; overflow-y: auto; padding: 1; }
#history-detail { width: 1fr; height: 1fr; padding: 1 2; overflow-y: auto; }
.history-row { padding: 1; border-left: tall $surface-darken-3; border-bottom: solid $surface-lighten-1; }
.history-row:hover { background: $surface-lighten-1; }
.history-row.selected { background: $surface-lighten-1; border-left: tall $accent; }
.detail-card { background: $surface-darken-1; padding: 1; margin: 0 0 1 0; border: solid $surface-lighten-1; }
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
        self._pending_delete_run_id: str | None = None
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
                        yield Button("＋ Add Cron", id="cf-add")
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
                # History-specific buttons (toggled based on active tab)
                yield Button("Jobs (H)", id="btn-hist-back", classes="hidden")
                yield Button("📋 Copy Output", id="btn-hist-copy-out", classes="hidden")
                yield Button("📋 Copy Log", id="btn-hist-copy-log", classes="hidden")
                yield Button("🔍 Full View", id="btn-hist-full-view", classes="hidden")
                yield Button("💬 Open Session", id="btn-hist-open-session", classes="hidden")
                yield Button("▶ Run Now", id="btn-hist-run-now", classes="hidden")
                yield Button("Delete Run", id="btn-hist-delete-run", classes="hidden")

    def on_mount(self):
        self._update_title()
        self._update_hint()
        self._refresh_list()
        for tid in ("#tab-jobs", "#tab-history"):
            try:
                self.query_one(tid).can_focus = False
            except Exception:
                pass
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
                hint.update("↑/↓ select run · Tab toggle list/detail · PgUp/Dn scroll · c copy · v full view · H jobs")
            else:
                hint.update("↑/↓ move · Enter toggle · R run · H history · D remove · N add · Esc close")
        except Exception:
            pass

    def _set_selected_buttons(self, enabled: bool):
        for btn_id in ("#btn-cron-toggle", "#btn-cron-run", "#btn-cron-remove", "#btn-cron-history"):
            try:
                self.query_one(btn_id, Button).disabled = not enabled
            except Exception:
                pass

    def _sync_remove_button(self):
        try:
            btn = self.query_one("#btn-cron-remove", Button)
            btn.label = "⚠ Confirm Remove" if self._pending_delete_id else "Remove"
        except Exception:
            pass

    def _sync_delete_run_button(self):
        try:
            btn = self.query_one("#btn-hist-delete-run", Button)
            btn.label = "⚠ Confirm Delete" if self._pending_delete_run_id else "Delete Run"
        except Exception:
            pass

    def _clear_pending_delete(self):
        if self._pending_delete_id:
            self._pending_delete_id = None
            self._sync_remove_button()
        if self._pending_delete_run_id:
            self._pending_delete_run_id = None
            self._sync_delete_run_button()

    def _sync_footer_buttons(self):
        is_jobs = (self._active_tab == "jobs")
        for j_id in ("#btn-cron-toggle", "#btn-cron-run", "#btn-cron-remove", "#btn-cron-history"):
            try:
                self.query_one(j_id).set_class(not is_jobs, "hidden")
            except Exception:
                pass
        for h_id in ("#btn-hist-back", "#btn-hist-copy-out", "#btn-hist-copy-log", "#btn-hist-full-view",
                     "#btn-hist-open-session", "#btn-hist-run-now", "#btn-hist-delete-run"):
            try:
                self.query_one(h_id).set_class(is_jobs, "hidden")
            except Exception:
                pass

    # ── Tab switching ──────────────────────────────────────────────────────

    def _switch_tab(self, tab: str):
        self._active_tab = tab
        self.query_one("#cron-tab-jobs").set_class(tab != "jobs", "hidden")
        self.query_one("#cron-tab-history").set_class(tab != "history", "hidden")
        self.query_one("#tab-jobs").set_class(tab == "jobs", "active")
        self.query_one("#tab-history").set_class(tab == "history", "active")
        self._sync_footer_buttons()
        if tab == "history":
            self._refresh_history()
        self._update_hint()
        self._enter_keyboard_mode()

    # ── Jobs tab ───────────────────────────────────────────────────────────

    def _refresh_list(self):
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
        status_icon = {"never": "○", "success": "✓", "failed": "✗", "timeout": "⏱", "interrupted": "⚡"}.get(cron.last_status, "○")
        status_color = {"never": "dim", "success": "green", "failed": "red", "timeout": "yellow", "interrupted": "dim red"}.get(cron.last_status, "dim")

        if running:
            head = (f"[cyan]⟳[/] [{name_color} bold]{escape(cron.name)}[/]  "
                    f"[dim]{escape(cron.schedule)}[/]  [cyan]running…[/]")
        else:
            next_run = cron.next_run_in() if cron.enabled else "disabled"
            head = (f"[{status_color}]{status_icon}[/] [{name_color} bold]{escape(cron.name)}[/]  "
                    f"[dim]{escape(cron.schedule)}[/]  [dim]next: {next_run}[/]")

        prompt_line = f"[dim]{escape(cron.prompt[:45])}{'…' if len(cron.prompt) > 45 else ''}[/]"

        meta = f"[dim]{cron.run_count} runs · {cron.fail_count} fails · {escape(cron.mode)} mode[/]"
        recent = self._scheduler.list_runs(cron.id, limit=6)
        if recent:
            dot_map = {"running": ("⟳", "cyan"), "success": ("✓", "green"), "failed": ("✗", "red"), "timeout": ("⏱", "yellow"), "interrupted": ("⚡", "dim")}
            dots = " ".join(f"[{c}]{s}[/{c}]" for s, c in (dot_map.get(r.status, ("○", "dim")) for r in recent))
            meta += f" · {dots}"
        if cron.last_error and not running:
            meta += f"\n[red]last error:[/] {escape(cron.last_error[:60])}"

        classes = ["cron-row"]
        if cron.id == self._selected_id:
            classes.append("selected")
        if running:
            classes.append("running")
        elif cron.last_status in ("failed", "timeout", "interrupted"):
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

        runs = self._scheduler.list_runs(cron.id, limit=50)
        self._run_row_ids = [r.id for r in runs]
        if not runs:
            run_list.mount(Static("[dim]  No runs recorded yet.[/]", id="history-empty"))
            detail.mount(Static("[dim]  Execute this cron with ▶ Run Now to record history.[/]"))
            return

        for run in runs:
            status_icon = {"running": "⟳", "success": "✓", "failed": "✗", "timeout": "⏱", "interrupted": "⚡"}.get(run.status, "?")
            status_color = {"running": "cyan", "success": "green", "failed": "red", "timeout": "yellow", "interrupted": "dim red"}.get(run.status, "dim")

            dur = ""
            if run.duration_ms:
                secs = run.duration_ms / 1000
                dur = f"{secs:.1f}s" if secs < 60 else f"{int(secs // 60)}m {int(secs % 60)}s"

            time_ago = self._time_ago(run.started_at)
            tools = ", ".join(run.tools_used[:2]) if run.tools_used else "none"

            classes = "history-row" + (" selected" if run.id == self._selected_run_id else "")
            row = Static(
                f"[{status_color}]{status_icon}[/] [bold]{escape(run.job_name)}[/]  "
                f"[dim]{time_ago}[/]  [dim]{dur}[/]\n"
                f"[dim]{escape(run.prompt[:40])}{'…' if len(run.prompt) > 40 else ''}[/]\n"
                f"[dim]tools: {escape(tools)}[/]",
                classes=classes,
                name=run.id,
            )
            run_list.mount(row)

        # Auto-select the first run if none selected
        if not self._selected_run_id or self._selected_run_id not in self._run_row_ids:
            self._select_run(self._run_row_ids[0])
        else:
            self._show_run_detail(self._selected_run_id)

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
        self._clear_pending_delete()
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

        status_color = {"running": "cyan", "success": "green", "failed": "red", "timeout": "yellow", "interrupted": "dim red"}.get(run.status, "dim")
        dur = f"{run.duration_ms / 1000:.1f}s" if run.duration_ms else "N/A"
        time_ago = self._time_ago(run.started_at)

        # ── Header Card ──
        header_lines = [
            f"[bold text]Run ID:[/] [bold]{escape(run.id)}[/]  [bold]Status:[/] [{status_color} bold]{run.status.upper()}[/]  [bold]Duration:[/] {dur} ({time_ago})",
            f"[dim]Started: {run.started_at[:19]}  Finished: {run.finished_at[:19] if run.finished_at else 'running…'}  Model: {escape(run.model)}[/]",
        ]
        if run.session_id:
            header_lines.append(f"[dim]Session ID: {escape(run.session_id)}[/]")
        detail.mount(Static("\n".join(header_lines), classes="detail-card"))

        # ── Error Card (if any) ──
        if run.error:
            err_lines = [f"[red bold]⚠ Error / Exception:[/] {escape(run.error)}"]
            if run.error_traceback:
                err_lines.append(f"[dim]{escape(run.error_traceback)}[/]")
            detail.mount(Static("\n".join(err_lines), classes="detail-card"))

        # ── Prompt Card ──
        detail.mount(Static(f"[bold accent]Prompt:[/] {escape(run.prompt)}", classes="detail-card"))

        # ── Output Card (Full text) ──
        full_output = run.output or run.output_preview
        out_lines = []
        if full_output:
            out_lines.append(f"[bold accent]Output:[/] [dim]({len(full_output.splitlines())} lines, {len(full_output)} chars)[/]")
            for line in full_output.splitlines():
                out_lines.append(f"  {escape(line)}")
        else:
            out_lines.append("[dim](No textual output recorded)[/]")
        detail.mount(Static("\n".join(out_lines), classes="detail-card"))

        # ── Tool Executions Card ──
        if run.tool_executions:
            te_lines = [f"[bold accent]Tool Executions ({len(run.tool_executions)}):[/]"]
            for te in run.tool_executions:
                tname = te.get("tool_name", "tool")
                tdur = te.get("duration_ms", 0)
                tstatus = te.get("status", "ok")
                targs = json.dumps(te.get("args", {}))
                tres = str(te.get("result", ""))
                color = "green" if tstatus == "ok" else "red"
                te_lines.append(f"  [{color}]•[/] [bold]{escape(tname)}[/] [dim]({tdur}ms)[/]")
                te_lines.append(f"    [dim]args:[/] {escape(targs[:120])}{'…' if len(targs) > 120 else ''}")
                if tres:
                    te_lines.append(f"    [dim]result:[/] {escape(tres[:250])}{'…' if len(tres) > 250 else ''}")
            detail.mount(Static("\n".join(te_lines), classes="detail-card"))
        elif run.tools_used:
            detail.mount(Static(f"[bold]Tools used:[/] {escape(', '.join(run.tools_used))}", classes="detail-card"))

        # ── Files Modified Card ──
        if run.files_modified:
            fm_lines = [f"[bold green]Files Modified ({len(run.files_modified)}):[/]"]
            for f in run.files_modified:
                fm_lines.append(f"  • [cyan]{escape(f)}[/]")
            detail.mount(Static("\n".join(fm_lines), classes="detail-card"))

        # ── Conversation Messages Card ──
        if run.messages:
            msg_lines = [f"[bold accent]Conversation Turns ({len(run.messages)} messages):[/]"]
            for msg in run.messages[-8:]:
                role = msg.get("role", "?")
                content = msg.get("content", "")
                if content:
                    preview = str(content)[:140] + ("…" if len(str(content)) > 140 else "")
                    msg_lines.append(f"  [{role}] {escape(preview)}")
            detail.mount(Static("\n".join(msg_lines), classes="detail-card"))

    # ── Clipboard & Session Actions ──

    def _copy_run_output(self):
        if not self._history_job_id or not self._selected_run_id:
            self.notify("No run selected.", severity="warning", timeout=3)
            return
        run = self._scheduler.get_run(self._history_job_id, self._selected_run_id)
        if not run:
            return
        text = run.output or run.output_preview or ""
        if text:
            try:
                self.app.copy_to_clipboard(text)
                self.notify("✓ Output copied to clipboard", timeout=3)
            except Exception as e:
                self.notify(f"Copy failed: {e}", severity="error", timeout=4)
        else:
            self.notify("No output text to copy.", severity="warning", timeout=3)

    def _copy_full_run_log(self):
        if not self._history_job_id or not self._selected_run_id:
            self.notify("No run selected.", severity="warning", timeout=3)
            return
        run = self._scheduler.get_run(self._history_job_id, self._selected_run_id)
        if not run:
            return
        parts = [
            f"# Cron Run: {run.job_name} ({run.id})",
            f"- Status: {run.status}",
            f"- Duration: {run.duration_ms / 1000:.1f}s" if run.duration_ms else "- Duration: N/A",
            f"- Started: {run.started_at}",
            f"- Finished: {run.finished_at or 'N/A'}",
            f"- Model: {run.model}",
            f"- Prompt: {run.prompt}",
        ]
        if run.error:
            parts.append(f"\n## Error\n```\n{run.error}\n```")
        if run.tools_used:
            parts.append(f"\n## Tools Used\n" + ", ".join(run.tools_used))
        if run.files_modified:
            parts.append(f"\n## Files Modified\n" + "\n".join(f"- {f}" for f in run.files_modified))
        output = run.output or run.output_preview or ""
        if output:
            parts.append(f"\n## Output\n```\n{output}\n```")
        log_text = "\n".join(parts)
        try:
            self.app.copy_to_clipboard(log_text)
            self.notify("✓ Full run log copied to clipboard", timeout=3)
        except Exception as e:
            self.notify(f"Copy failed: {e}", severity="error", timeout=4)

    def _open_fullscreen_log(self):
        if not self._history_job_id or not self._selected_run_id:
            return
        run = self._scheduler.get_run(self._history_job_id, self._selected_run_id)
        if not run:
            return
        self.app.push_screen(CronRunLogModal(run))

    def _open_run_session(self):
        if not self._history_job_id or not self._selected_run_id:
            return
        run = self._scheduler.get_run(self._history_job_id, self._selected_run_id)
        if not run:
            return
        from andromity.core.session import Session
        session_to_load = None
        if run.session_id:
            session_to_load = Session.load_by_id(run.session_id, self._project_path)
        if not session_to_load and run.messages:
            session_to_load = Session(name=f"cron: {run.job_name} ({run.id})", project_path=self._project_path)
            session_to_load.messages = list(run.messages)
            session_to_load.save()

        if session_to_load:
            self.dismiss()
            try:
                self.app.run_worker(self.app._load_session(session_to_load))
            except Exception:
                pass
        else:
            self.notify("No session messages available for this run.", severity="warning", timeout=3)

    def _delete_selected_run(self):
        if not self._history_job_id or not self._selected_run_id:
            return
        if self._pending_delete_run_id != self._selected_run_id:
            self._pending_delete_run_id = self._selected_run_id
            self._sync_delete_run_button()
            self.notify("Press Delete Run again to confirm.", severity="warning", timeout=4)
            return
        self._scheduler.delete_run(self._history_job_id, self._selected_run_id)
        self._pending_delete_run_id = None
        self._selected_run_id = None
        self._sync_delete_run_button()
        self.notify("Run record deleted.", timeout=3)
        self._refresh_history()

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
        job_id = self._history_job_id if self._active_tab == "history" else self._selected_id
        if not job_id:
            return
        if job_id in self._running_ids():
            self.notify("This cron is already running — wait for it to finish.", severity="warning", timeout=4)
            return
        cron = next((c for c in self._scheduler.list() if c.id == job_id), None)
        if cron is None:
            return
        ok = self._scheduler.run_now(cron.id)
        if ok:
            self.notify(f"⏱ Triggered '{cron.name}' manually.", timeout=3)
        else:
            self.notify(f"Could not trigger '{cron.name}'.", severity="error", timeout=4)
        if self._active_tab == "history":
            self._refresh_history()
        else:
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
            elif btn_id == "tab-jobs" or btn_id == "btn-hist-back":
                self._switch_tab("jobs")
            elif btn_id == "tab-history":
                self._switch_tab("history")
            elif btn_id == "cf-add":
                self._try_add_cron()
            elif btn_id in TEMPLATES:
                self._apply_template(btn_id)
            elif btn_id == "btn-cron-toggle":
                self._toggle_selected()
            elif btn_id in ("btn-cron-run", "btn-hist-run-now"):
                self._run_selected()
            elif btn_id == "btn-cron-remove":
                self._remove_selected()
            elif btn_id == "btn-cron-history":
                if self._selected_id:
                    self._switch_tab("history")
            elif btn_id == "btn-hist-copy-out":
                self._copy_run_output()
            elif btn_id == "btn-hist-copy-log":
                self._copy_full_run_log()
            elif btn_id == "btn-hist-full-view":
                self._open_fullscreen_log()
            elif btn_id == "btn-hist-open-session":
                self._open_run_session()
            elif btn_id == "btn-hist-delete-run":
                self._delete_selected_run()
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
            event.stop()
            if self._pending_delete_id or self._pending_delete_run_id:
                self._clear_pending_delete()
            elif self._active_tab == "history":
                self._switch_tab("jobs")
            else:
                self.dismiss()
            return

        if key == "tab":
            if self._active_tab == "history" and not typing:
                detail = self.query_one("#history-detail", VerticalScroll)
                run_list = self.query_one("#history-run-list", VerticalScroll)
                if focused == detail:
                    run_list.focus()
                else:
                    detail.focus()
                event.stop()
                return

        if key in ("up", "down"):
            if self._active_tab == "history" and focused == self.query_one("#history-detail"):
                return
            self._move_selection(-1 if key == "up" else 1)
            return

        if key in ("pageup", "pagedown"):
            try:
                detail = self.query_one("#history-detail", VerticalScroll)
                if key == "pageup":
                    detail.scroll_page_up()
                else:
                    detail.scroll_page_down()
                event.stop()
                return
            except Exception:
                pass

        if key == "enter":
            if isinstance(focused, Button):
                return
            if typing and getattr(focused, "id", None) != "cf-search":
                return
            if self._active_tab == "history":
                self._open_fullscreen_log()
            else:
                self._toggle_selected()
            return

        if typing:
            return

        if key in ("home", "end"):
            if self._active_tab == "history":
                if self._run_row_ids:
                    self._select_run(self._run_row_ids[0] if key == "home" else self._run_row_ids[-1])
            elif self._row_ids:
                self._select_row(self._row_ids[0] if key == "home" else self._row_ids[-1])
            return

        if key in ("j", "k"):
            self._move_selection(-1 if key == "k" else 1)
        elif key in ("u", "d") and self._active_tab == "history":
            try:
                detail = self.query_one("#history-detail", VerticalScroll)
                if key == "u":
                    detail.scroll_page_up()
                else:
                    detail.scroll_page_down()
            except Exception:
                pass
        elif key == "c" and self._active_tab == "history":
            self._copy_run_output()
        elif key == "C" and self._active_tab == "history":
            self._copy_full_run_log()
        elif key == "v" and self._active_tab == "history":
            self._open_fullscreen_log()
        elif key in ("o", "s") and self._active_tab == "history":
            self._open_run_session()
        elif key == "r":
            self._run_selected()
        elif key == "h":
            if self._active_tab == "history":
                self._switch_tab("jobs")
            elif self._selected_id:
                self._switch_tab("history")
        elif key in ("d", "delete"):
            if self._active_tab == "history":
                self._delete_selected_run()
            else:
                self._remove_selected()
        elif key == "n":
            self._focus_quick_add()
        elif key == "slash":
            self._focus_search()
