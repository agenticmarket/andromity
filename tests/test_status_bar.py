"""The status bar above the input box is clickable:

- provider/model segment  -> opens the model picker (like Ctrl+L)
- profile segment         -> opens the profile picker (like Ctrl+J)
- permission-mode segment -> cycles safe -> trust -> full
"""
import asyncio
import tempfile

import pytest
from textual.app import App, ComposeResult

from andromity.config import config
from andromity.tui.footer import StatusBar, AppFooter


@pytest.fixture(autouse=True)
def _isolated_config(tmp_path, monkeypatch):
    """Point the global config at a temp dir so tests never touch the real one."""
    cfg_dir = tmp_path / "cfg"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "config_dir", cfg_dir)
    monkeypatch.setattr(config, "config_path", cfg_dir / "config.toml")
    config._config_cache = {}
    config._load()
    yield


class HostApp(App):
    """Minimal host that records the actions the status bar should trigger."""

    def __init__(self):
        super().__init__()
        self.model_opened = 0
        self.profile_opened = 0
        self.mode_changes = 0
        self._yolo_session = False
        self._is_streaming = False
        self._pending_mode_change = False

    def compose(self) -> ComposeResult:
        yield StatusBar()
        yield AppFooter()

    def action_toggle_model(self):
        self.model_opened += 1

    def action_toggle_profile(self):
        self.profile_opened += 1

    def _apply_mode_change(self):
        self.mode_changes += 1


async def _settle(pilot, n=10):
    for _ in range(n):
        await pilot.pause()


def test_status_bar_renders_clickable_segments():
    async def _run():
        async with HostApp().run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            app = pilot.app
            sb = app.query_one(StatusBar)
            sb.update_status(
                tokens=500,
                cost=0.0,
                profile="builder",
                model="nvidia/nemotron-3.5-lightning-30b-a3b",
                ctx_limit=131072,
                permission_mode="safe",
            )
            await _settle(pilot)
            segs = [w.id for w in sb.query("Static")]
            for expected in ("seg-model", "seg-effort", "seg-perm"):
                assert expected in segs, segs
            # Segments must stay inside the visible screen (no horizontal overflow)
            for w in sb.query("Static"):
                assert w.region.x + w.region.width <= app.size.width, (w.id, w.region)

    asyncio.run(_run())


def test_click_model_segment_opens_model_picker():
    async def _run():
        async with HostApp().run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            app = pilot.app
            await pilot.click("#seg-model")
            await _settle(pilot)
            assert app.model_opened == 1

    asyncio.run(_run())


def test_click_effort_segment_cycles_effort():
    async def _run():
        async with HostApp().run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            app = pilot.app
            sb = app.query_one(StatusBar)
            initial = sb._effort
            await pilot.click("#seg-effort")
            await _settle(pilot)
            assert sb._effort != initial
            # Cycle through remaining states to return to initial
            for _ in range(len(StatusBar._EFFORT_LEVELS) - 1):
                await pilot.click("#seg-effort")
                await _settle(pilot)
            assert sb._effort == initial

    asyncio.run(_run())


def test_click_footer_profile_opens_profile_picker():
    async def _run():
        async with HostApp().run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            app = pilot.app
            await pilot.click("#footer-profile")
            await _settle(pilot)
            assert app.profile_opened == 1

    asyncio.run(_run())


def test_click_hint_segment_opens_help():
    """The /help hint at the right end of the bar opens the Help overlay."""
    async def _run():
        async with HostApp().run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            app = pilot.app
            await pilot.click("#seg-hint")
            await _settle(pilot)
            assert "HelpScreen" in type(app.screen).__name__, type(app.screen).__name__
            await pilot.press("escape")
            await _settle(pilot)
            assert len(app.screen_stack) == 1

    asyncio.run(_run())


def test_click_perm_segment_cycles_mode():
    async def _run():
        async with HostApp().run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            app = pilot.app
            order = ["safe", "trust", "full"]
            before = config.get("default", "permission_mode", "safe")
            assert before in order
            await pilot.click("#seg-perm")
            await _settle(pilot)
            after = config.get("default", "permission_mode", "safe")
            assert after == order[(order.index(before) + 1) % len(order)], (before, after)
            assert app.mode_changes == 1

    asyncio.run(_run())


def test_perm_segment_has_no_stray_backslash():
    """Regression: '\\[FULL\\]' rendered a literal backslash — Textual only
    needs the opening bracket escaped; '\\]' shows as backslash + bracket."""
    async def _run():
        async with HostApp().run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            sb = pilot.app.query_one(StatusBar)
            for mode in ("safe", "trust", "full"):
                seg = sb._seg_perm()
                assert "\\]" not in seg, (mode, seg)
                assert "\\[" in seg, (mode, seg)

    asyncio.run(_run())


def test_context_panel_does_not_duplicate_status_bar_metrics():
    """Cost/profile rows were removed from ContextPanel — status bar and footer
    own those numbers. Only session/model/MCP/fill-bar remain."""
    async def _run():
        from andromity.tui.footer import ContextPanel

        class CtxHost(App):
            def compose(self) -> ComposeResult:
                yield ContextPanel()

        async with CtxHost().run_test(size=(60, 20)) as pilot:
            await _settle(pilot)
            panel = pilot.app.query_one(ContextPanel)
            panel.update_context(
                tokens=9000, cost=0.1234, profile="builder",
                model="openai/gpt-4o-mini", ctx_limit=128000,
                session_name="my-session",
            )
            await _settle(pilot)
            ids = [w.id for w in panel.query("Static")]
            assert "ctx-cost" not in ids, ids
            assert "ctx-profile" not in ids, ids
            texts = []
            for w in panel.query("Static"):
                try:
                    texts.append(str(w.visual))
                except Exception:
                    texts.append(str(getattr(w, "_content", "")))
            joined = "\n".join(texts)
            assert "$0.1234" not in joined, "cost must not appear in context panel"
            assert "Profile:" not in joined
            assert "my-session" in joined

    asyncio.run(_run())


if __name__ == "__main__":
    import os

    old = os.getcwd()
    os.chdir(tempfile.mkdtemp())
    try:
        pytest.main([__file__, "-v"])
    finally:
        os.chdir(old)
