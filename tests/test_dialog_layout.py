import asyncio
import os
from types import SimpleNamespace

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Static

from andromity.config import config
from andromity.core.cron import CronRun, CronScheduler
from andromity.tui.overlays.batch_review import BatchReviewOverlay
from andromity.tui.overlays.connection import ProviderConnectionScreen
from andromity.tui.overlays.cron import CronManagerOverlay, CronRunLogModal
from andromity.tui.overlays.help import HelpScreen
from andromity.tui.overlays.model import ModelPickerScreen
from andromity.tui.overlays.profile import ProfilePickerOverlay
from andromity.tui.overlays.session import SessionBrowserOverlay
from andromity.tui.overlays.settings import SettingsScreen
from andromity.tui.overlays.skills import SkillsScreen
from andromity.tui.overlays.trust import TrustPromptOverlay
from andromity.tui.overlays.undo import UndoConfirmOverlay


class DialogHost(App):
    TITLE = "Andromity"

    def __init__(self, project_path):
        super().__init__()
        self._project_path = str(project_path)
        self.agent = SimpleNamespace(profile="builder", dry_run=False)

    def _apply_profile(self, profile):
        self.agent.profile = profile

    def compose(self) -> ComposeResult:
        yield Static("")


@pytest.fixture
def dialog_factory(tmp_path, monkeypatch):
    async def browse(screen):
        screen._set_status("No skills available.")

    monkeypatch.setattr(SkillsScreen, "_browse_worker", browse)
    monkeypatch.setattr(ModelPickerScreen, "_fetch_live_models_worker", lambda *args: None)
    monkeypatch.setattr(config, "get_api_key", lambda *args: "")
    config.set("default", "provider", "")
    file = tmp_path / "example.py"
    file.write_text("print('Example')\n", encoding="utf-8")
    scheduler = CronScheduler(str(tmp_path), on_trigger=lambda job: None)
    run = CronRun(
        id="run-example", job_id="job-example", job_name="Run tests",
        started_at="2026-10-22T10:00:00+00:00", status="success",
        output="Collected tests\nAll checks passed", duration_ms=2500,
    )
    return {
        "model": lambda: ModelPickerScreen(),
        "profile": lambda: ProfilePickerOverlay(),
        "settings": lambda: SettingsScreen(project_path=str(tmp_path)),
        "sessions": lambda: SessionBrowserOverlay("", str(tmp_path)),
        "help": lambda: HelpScreen(),
        "skills": lambda: SkillsScreen(str(tmp_path)),
        "cron": lambda: CronManagerOverlay(scheduler, str(tmp_path)),
        "run-log": lambda: CronRunLogModal(run),
        "connection": lambda: ProviderConnectionScreen(),
        "trust": lambda: TrustPromptOverlay(str(tmp_path)),
        "undo": lambda: UndoConfirmOverlay("Update the session recovery tests."),
        "batch-review": lambda: BatchReviewOverlay(str(tmp_path), None, [file]),
    }


@pytest.mark.parametrize("theme", ["textual-dark", "textual-light"])
@pytest.mark.parametrize("size", [(80, 24), (80, 30)])
@pytest.mark.parametrize("kind,footer", [
    ("model", "mp-footer"), ("profile", "pp-footer"),
    ("settings", "settings-footer"), ("sessions", "sb-footer"),
    ("help", "help-footer"), ("skills", "sk-footer"),
    ("cron", "cron-footer"), ("run-log", "run-log-actions"),
    ("connection", "connection-actions"), ("trust", "tp-footer"),
    ("undo", "undo-footer"), ("batch-review", "batch-footer"),
])
def test_dialog_actions_remain_visible_and_reachable(dialog_factory, tmp_path, kind, footer, theme, size):
    async def scenario():
        app = DialogHost(tmp_path)
        app.theme = theme
        async with app.run_test(size=size) as pilot:
            screen = dialog_factory[kind]()
            app.push_screen(screen)
            await pilot.pause()
            await pilot.pause()
            snapshot_dir = os.environ.get("DIALOG_SNAPSHOT_DIR")
            if snapshot_dir:
                app.save_screenshot(
                    filename=f"dialog-{kind}-{size[0]}x{size[1]}-{theme}.svg", path=snapshot_dir,
                )
            panel = screen.query_one(f"#{footer}").parent
            assert panel.region.y >= 0, (kind, panel.region)
            assert panel.region.bottom <= size[1], (kind, panel.region)
            for button in screen.query(f"#{footer} Button"):
                if not button.display:
                    continue
                region = button.region
                assert region.width > 0, (kind, button.id, region)
                assert 0 <= region.x < region.right <= size[0], (kind, button.id, region)
                assert 0 <= region.y < region.bottom <= size[1], (kind, button.id, region)
                widget, _ = screen.get_widget_at(*region.center)
                assert widget is button, (kind, button.id, widget.id)
            app.pop_screen()
            await pilot.pause()
            assert app.screen is not screen

    asyncio.run(scenario())


def test_history_actions_fit_without_overlapping(dialog_factory, tmp_path):
    async def scenario():
        app = DialogHost(tmp_path)
        async with app.run_test(size=(80, 24)) as pilot:
            screen = dialog_factory["cron"]()
            app.push_screen(screen)
            await pilot.pause()
            await pilot.click("#tab-history")
            await pilot.pause()
            for button in screen.query("#cron-footer Button"):
                if not button.display:
                    continue
                widget, _ = screen.get_widget_at(*button.region.center)
                assert widget is button, (button.id, widget.id)
                assert button.region.right <= 80
                assert button.region.bottom <= 24
            snapshot_dir = os.environ.get("DIALOG_SNAPSHOT_DIR")
            if snapshot_dir:
                app.save_screenshot(filename="dialog-cron-history.svg", path=snapshot_dir)

    asyncio.run(scenario())


@pytest.mark.parametrize("apply", [True, False])
def test_profile_keyboard_choice_requires_apply(dialog_factory, tmp_path, monkeypatch, apply):
    monkeypatch.setattr("andromity.telemetry.send_feature_used", lambda *args: None)

    async def scenario():
        app = DialogHost(tmp_path)
        async with app.run_test(size=(80, 24)) as pilot:
            screen = dialog_factory["profile"]()
            app.push_screen(screen)
            await pilot.pause()
            assert screen.query_one("#pp-radioset").has_focus
            await pilot.press("down", "space")
            await pilot.click("#pp-apply" if apply else "#pp-cancel")
            assert app.agent.profile == ("coder" if apply else "builder")

    asyncio.run(scenario())
