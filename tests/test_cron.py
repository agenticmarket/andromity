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
