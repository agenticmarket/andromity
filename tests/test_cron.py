"""Tests for the cron scheduler and the cron manager modal."""
import asyncio
import tempfile

import pytest

from andromity.core.cron import CronScheduler, parse_interval_seconds


# ── Scheduler ──────────────────────────────────────────────────────────────

def test_parse_interval_seconds():
    assert parse_interval_seconds("every 30m") == 1800
    assert parse_interval_seconds("every 2h") == 7200
    assert parse_interval_seconds("every 1d") == 86400
    with pytest.raises(ValueError):
        parse_interval_seconds("every 30s")  # min 1 minute
    with pytest.raises(ValueError):
        parse_interval_seconds("daily")


def test_run_now_triggers_immediately():
    proj = tempfile.mkdtemp()
    triggered = []
    sched = CronScheduler(proj, on_trigger=lambda c: triggered.append(c.id))
    job = sched.add(name="Job", prompt="do it", schedule="every 30m",
                    provider="ollama", model="m", mode="trust")
    ok = sched.run_now(job.id)
    assert ok is True
    assert triggered == [job.id]
    # Unknown id -> False
    assert sched.run_now("nope") is False


# ── Modal (headless Textual) ───────────────────────────────────────────────

def test_modal_renders_rows_and_keyboard_toggle():
    async def _run():
        from textual.app import App, ComposeResult
        from textual.widgets import Static

        from andromity.tui.overlays.cron import CronManagerOverlay

        class T(App):
            def compose(self) -> ComposeResult:
                yield Static("host")

        proj = tempfile.mkdtemp()
        sched = CronScheduler(proj, on_trigger=lambda c: None)
        job = sched.add(name="Run Tests", prompt="run pytest", schedule="every 30m",
                        provider="ollama", model="m", mode="trust")

        app = T()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app._cron_scheduler = sched
            app._cron_running_jobs = set()
            app.push_screen(CronManagerOverlay(sched, proj))
            for _ in range(10):
                await pilot.pause()

            modal = app.screen
            # One job row rendered
            assert len(modal.query(".cron-row")) == 1
            # Actions start disabled until a job is selected
            assert modal.query_one("#btn-cron-toggle").disabled is True

            # Arrow down selects the first job, Enter toggles it off
            await pilot.press("down")
            await pilot.pause()
            assert modal._selected_id == job.id
            assert modal.query_one("#btn-cron-toggle").disabled is False
            await pilot.press("enter")
            await pilot.pause()
            assert sched.list()[0].enabled is False

            # Esc closes the modal
            await pilot.press("escape")
            for _ in range(3):
                await pilot.pause()
            assert len(app.screen_stack) == 1

    asyncio.run(_run())


def test_modal_add_form_validation_shows_inline_error():
    async def _run():
        from textual.app import App, ComposeResult
        from textual.widgets import Static

        from andromity.tui.overlays.cron import CronManagerOverlay

        class T(App):
            def compose(self) -> ComposeResult:
                yield Static("host")

        proj = tempfile.mkdtemp()
        sched = CronScheduler(proj, on_trigger=lambda c: None)

        app = T()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.push_screen(CronManagerOverlay(sched, proj))
            for _ in range(10):
                await pilot.pause()

            modal = app.screen
            # Bad schedule -> inline error, no job created
            modal.query_one("#cf-name").value = "Bad"
            modal.query_one("#cf-prompt").value = "do something"
            modal.query_one("#cf-schedule").value = "daily"
            await pilot.pause()
            modal.query_one("#cf-add").press()
            for _ in range(5):
                await pilot.pause()
            assert "⚠" in modal.query_one("#cf-error").content
            assert len(sched.list()) == 0

    asyncio.run(_run())


def test_quick_add_creates_job_from_one_line():
    async def _run():
        from textual.app import App, ComposeResult
        from textual.widgets import Static

        from andromity.tui.overlays.cron import CronManagerOverlay

        class T(App):
            def compose(self) -> ComposeResult:
                yield Static("host")
            def refresh_cron_status(self):
                pass

        proj = tempfile.mkdtemp()
        sched = CronScheduler(proj, on_trigger=lambda c: None)

        app = T()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.push_screen(CronManagerOverlay(sched, proj))
            for _ in range(10):
                await pilot.pause()
            modal = app.screen
            qa = modal.query_one("#cf-quickadd")
            qa.focus()
            qa.value = "every 30m: run pytest and report"
            await pilot.pause()
            await pilot.press("enter")
            for _ in range(5):
                await pilot.pause()

            jobs = sched.list()
            assert len(jobs) == 1
            assert jobs[0].prompt == "run pytest and report"
            assert jobs[0].name.startswith("run pytest")
            assert qa.value == ""

            # Invalid one-liner -> inline error, nothing created
            qa.value = "no colon here"
            await pilot.pause()
            await pilot.press("enter")
            for _ in range(5):
                await pilot.pause()
            assert "⚠" in modal.query_one("#cf-quick-error").content
            assert len(sched.list()) == 1

    asyncio.run(_run())


def test_schedule_preview_validates_live():
    async def _run():
        from textual.app import App, ComposeResult
        from textual.widgets import Static

        from andromity.tui.overlays.cron import CronManagerOverlay

        class T(App):
            def compose(self) -> ComposeResult:
                yield Static("host")

        proj = tempfile.mkdtemp()
        sched = CronScheduler(proj, on_trigger=lambda c: None)

        app = T()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.push_screen(CronManagerOverlay(sched, proj))
            for _ in range(10):
                await pilot.pause()
            modal = app.screen
            hint = modal.query_one("#cf-schedule-hint")

            modal.query_one("#cf-schedule").value = "daily"
            await pilot.pause()
            assert "⚠" in hint.content

            modal.query_one("#cf-schedule").value = "every 30m"
            await pilot.pause()
            assert "✓" in hint.content and "30m" in hint.content

            modal.query_one("#cf-schedule").value = ""
            await pilot.pause()
            assert hint.content.strip() == ""

    asyncio.run(_run())


def test_template_fills_form():
    async def _run():
        from textual.app import App, ComposeResult
        from textual.widgets import Static

        from andromity.tui.overlays.cron import CronManagerOverlay

        class T(App):
            def compose(self) -> ComposeResult:
                yield Static("host")

        proj = tempfile.mkdtemp()
        sched = CronScheduler(proj, on_trigger=lambda c: None)

        app = T()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.push_screen(CronManagerOverlay(sched, proj))
            for _ in range(10):
                await pilot.pause()
            modal = app.screen

            modal.query_one("#tpl-tests").press()
            await pilot.pause()
            assert modal.query_one("#cf-name").value == "Run Tests"
            assert modal.query_one("#cf-schedule").value == "every 30m"
            assert modal.query_one("#cf-mode").value == "trust"
            assert modal.query_one("#cf-prompt").value

    asyncio.run(_run())


def test_cron_run_store_full_telemetry_and_sanitization():
    proj = tempfile.mkdtemp()
    sched = CronScheduler(proj, on_trigger=lambda c: None)
    job = sched.add(name="Linter", prompt="run ruff check", schedule="every 1h",
                    provider="anthropic", model="claude-sonnet-4-6")

    # Start run
    run = sched.start_run(job.id, job.prompt, f"{job.provider}/{job.model}", session_id="test-sess-123")
    assert run is not None
    assert run.job_id == job.id
    assert run.session_id == "test-sess-123"

    # Populate full telemetry
    run.output = "All 42 checks passed successfully in 0.45s.\nFile: src/main.py clean."
    run.tools_used = ["shell_exec"]
    run.files_modified = ["src/main.py"]
    run.tool_executions = [{
        "tool_name": "shell_exec",
        "args": {"command": "ruff check"},
        "result": "All checks passed.",
        "duration_ms": 450,
        "status": "ok",
    }]
    sched.mark_result(job.id, success=True, run=run)

    # Reload from store
    runs = sched.list_runs(job.id)
    assert len(runs) == 1
    loaded = runs[0]
    assert loaded.output == run.output
    assert loaded.status == "success"
    assert len(loaded.tool_executions) == 1
    assert loaded.tool_executions[0]["tool_name"] == "shell_exec"
    assert loaded.files_modified == ["src/main.py"]

    # Test sanitization of stale running runs
    stale_run = sched.start_run(job.id, job.prompt, "test-model")
    assert stale_run.status == "running"
    # Create new scheduler on same project path -> auto-sanitizes
    new_sched = CronScheduler(proj, on_trigger=lambda c: None)
    reloaded_stale = new_sched.get_run(job.id, stale_run.id)
    assert reloaded_stale is not None
    assert reloaded_stale.status == "interrupted"


def test_modal_history_view_and_full_view_modal():
    async def _run():
        from textual.app import App, ComposeResult
        from textual.widgets import Static

        from andromity.tui.overlays.cron import CronManagerOverlay, CronRunLogModal

        class T(App):
            def compose(self) -> ComposeResult:
                yield Static("host")

        proj = tempfile.mkdtemp()
        sched = CronScheduler(proj, on_trigger=lambda c: None)
        job = sched.add(name="Test Job", prompt="run tests", schedule="every 30m",
                        provider="ollama", model="m", mode="trust")
        run = sched.start_run(job.id, job.prompt, "ollama/m")
        run.output = "Pytest results:\n310 passed, 0 failures\nRuntime: 12.4s"
        run.tool_executions = [{"tool_name": "shell_exec", "args": {"command": "pytest"}, "result": "310 passed", "duration_ms": 12400, "status": "ok"}]
        sched.mark_result(job.id, success=True, run=run)

        app = T()
        async with app.run_test(size=(140, 45)) as pilot:
            await pilot.pause()
            app._cron_scheduler = sched
            app._cron_running_jobs = set()
            app.push_screen(CronManagerOverlay(sched, proj))
            for _ in range(10):
                await pilot.pause()

            modal = app.screen
            # Select job
            await pilot.press("down")
            await pilot.pause()

            # Switch to History tab
            await pilot.press("h")
            for _ in range(10):
                await pilot.pause()

            assert modal._active_tab == "history"
            assert len(modal.query(".history-row")) == 1

            # Detail pane should display output
            detail = modal.query_one("#history-detail")
            assert len(detail.children) > 0

            # Press 'v' to open fullscreen log modal
            await pilot.press("v")
            for _ in range(10):
                await pilot.pause()

            assert isinstance(app.screen, CronRunLogModal)
            log_modal = app.screen
            statics = list(log_modal.query("#run-log-content Static"))
            assert len(statics) > 0
            assert any("310 passed" in str(getattr(s, "content", getattr(s, "renderable", ""))) for s in statics)

            # Close log modal with Esc
            await pilot.press("escape")
            for _ in range(5):
                await pilot.pause()
            assert isinstance(app.screen, CronManagerOverlay)

    asyncio.run(_run())

