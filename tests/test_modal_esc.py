"""Regression: a modal's Esc must close the modal but never bubble to the
app's global escape binding (which cancels the streaming AI response)."""
import asyncio
import tempfile

import andromity.tui.overlays.skills as sk_mod
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Static


class StubManager:
    def __init__(self, *a, **k):
        pass

    def browse(self, source_id=None):
        return []

    def installed(self):
        return []

    def installed_names(self):
        return set()


sk_mod.SkillsManager = StubManager


def _make_app():
    class T(App):
        BINDINGS = [Binding("escape", "escape_pressed", show=False)]

        def __init__(self):
            super().__init__()
            self.app_escapes = 0

        def compose(self) -> ComposeResult:
            yield Static("host")

        def action_escape_pressed(self):
            self.app_escapes += 1

    return T


def test_skills_modal_escape_does_not_reach_app():
    from andromity.tui.overlays.skills import SkillsScreen

    async def _run():
        app = _make_app()()
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause()
            app.push_screen(SkillsScreen(tempfile.mkdtemp()))
            for _ in range(10):
                await pilot.pause()

            # Esc dismisses the modal without touching the app's counter
            await pilot.press("escape")
            for _ in range(6):
                await pilot.pause()
            assert len(app.screen_stack) == 1, "modal should be dismissed"
            assert app.app_escapes == 0, "modal Esc must not reach the app binding"

            # Esc on the base screen still works normally
            await pilot.press("escape")
            await pilot.pause()
            assert app.app_escapes == 1

    asyncio.run(_run())


def test_cron_modal_escape_does_not_reach_app():
    from andromity.core.cron import CronScheduler
    from andromity.tui.overlays.cron import CronManagerOverlay

    async def _run():
        proj = tempfile.mkdtemp()
        sched = CronScheduler(proj, on_trigger=lambda c: None)
        app = _make_app()()
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause()
            app.push_screen(CronManagerOverlay(sched, proj))
            for _ in range(10):
                await pilot.pause()
            await pilot.press("escape")
            for _ in range(6):
                await pilot.pause()
            assert len(app.screen_stack) == 1
            assert app.app_escapes == 0

    asyncio.run(_run())
