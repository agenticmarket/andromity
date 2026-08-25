"""Model picker inline API-key entry: visibility rules, save flow, failure hints.

Regression guard for the first-run dead-end where a cloud provider without an
API key offered only a static catalog and CLI-only fix instructions.
"""
import asyncio

import andromity.tui.overlays.model as mm
from textual.app import App, ComposeResult
from textual.widgets import Static


class _Host(App):
    def compose(self) -> ComposeResult:
        yield Static("host")


def _make_config_cls(saved: dict, seeded_keys: dict | None = None):
    """Minimal config double covering the surface ModelPickerScreen touches."""

    class _Cfg:
        api_keys: dict = dict(seeded_keys or {})

        @classmethod
        def get(cls, section, key, default=None):
            return ""

        @classmethod
        def get_api_key(cls, provider):
            return cls.api_keys.get(provider)

        @classmethod
        def set_api_key(cls, provider, key):
            cls.api_keys[provider] = key
            saved[provider] = key

    return _Cfg


def _patch(monkeypatch, fetch_result=None, seeded_keys=None):
    saved: dict = {}
    cfg_cls = _make_config_cls(saved, seeded_keys)
    monkeypatch.setattr(mm, "fetch_live_models_sync",
                        lambda *a, **k: list(fetch_result or []))
    monkeypatch.setattr(mm, "config", cfg_cls)
    return saved


async def _mounted_screen(size=(100, 32)):
    """Context-manager friendly host app; push_screen + pauses done by caller."""
    return _Host()


def test_key_row_visibility_rules(monkeypatch):
    """Cloud+no-key shows the entry row; ollama and keyed providers hide it."""

    async def _scenario(provider_key: str, has_key: bool, expect_visible: bool):
        seeded = {provider_key: "sk-existing"} if has_key else {}
        fetch = [{"id": "live-1", "name": "Live One"}] if has_key else []
        _patch(monkeypatch, fetch_result=fetch, seeded_keys=seeded)

        app = _Host()
        async with app.run_test(size=(100, 32)) as pilot:
            screen = mm.ModelPickerScreen()
            app.push_screen(screen)
            await pilot.pause()
            await pilot.pause()

            screen._show_step2(provider_key)
            await pilot.pause()

            key_row = screen.query_one("#mp-key-row")
            assert key_row.has_class("visible") == expect_visible, (
                f"{provider_key} has_key={has_key}: expected visible={expect_visible}"
            )
            if has_key:
                assert screen._current_models, "live fetch should populate models"

    asyncio.run(_scenario("anthropic", False, True))
    asyncio.run(_scenario("ollama", False, False))
    asyncio.run(_scenario("openai", True, False))


def test_connect_saves_key_and_triggers_fetch(monkeypatch):
    """Paste + Connect persists via set_api_key, hides the row, fetches live models."""

    async def _scenario():
        _patch(monkeypatch, fetch_result=[{"id": "live-1", "name": "Live One"}])

        app = _Host()
        async with app.run_test(size=(100, 32)) as pilot:
            screen = mm.ModelPickerScreen()
            app.push_screen(screen)
            await pilot.pause()
            await pilot.pause()
            screen._show_step2("anthropic")
            await pilot.pause()
            assert screen.query_one("#mp-key-row").has_class("visible")

            key_input = screen.query_one("#mp-key-input")
            key_input.value = "sk-test-123"
            screen._connect_key()
            for _ in range(8):
                await pilot.pause()

            assert mm.config.api_keys.get("anthropic") == "sk-test-123", \
                "key must persist through config.set_api_key"
            assert not screen.query_one("#mp-key-row").has_class("visible")
            assert any(m["id"] == "live-1" for m in screen._current_models), \
                "live models should replace the catalog"

    asyncio.run(_scenario())


def test_connect_empty_key_is_noop_with_hint(monkeypatch):
    """Connect with empty field saves nothing and surfaces a hint line."""

    async def _scenario():
        _patch(monkeypatch, fetch_result=[])

        app = _Host()
        async with app.run_test(size=(100, 32)) as pilot:
            screen = mm.ModelPickerScreen()
            app.push_screen(screen)
            await pilot.pause()
            await pilot.pause()
            screen._show_step2("anthropic")
            await pilot.pause()

            screen.query_one("#mp-key-input").value = "   "
            screen._connect_key()
            await pilot.pause()

            assert not mm.config.api_keys, "empty key must not be persisted"
            assert screen.query_one("#mp-key-row").has_class("visible")
            assert screen.query_one("#mp-key-hint").has_class("visible")

    asyncio.run(_scenario())


def test_failed_fetch_after_connect_restores_key_row(monkeypatch):
    """If live fetch fails right after connecting, re-show the entry for correction."""

    async def _scenario():
        _patch(monkeypatch, fetch_result=[])

        app = _Host()
        async with app.run_test(size=(100, 32)) as pilot:
            screen = mm.ModelPickerScreen()
            app.push_screen(screen)
            await pilot.pause()
            await pilot.pause()
            screen._selected_provider = "anthropic"
            screen._step = 2
            screen._key_just_connected = True

            screen._on_live_models_received("anthropic", [])
            await pilot.pause()

            assert screen.query_one("#mp-key-row").has_class("visible")
            assert screen.query_one("#mp-key-input").value == ""
            assert not screen._key_just_connected, "flag consumed after one use"

    asyncio.run(_scenario())


def test_enter_in_key_field_connects(monkeypatch):
    """Input.Submitted on the key field triggers the same connect flow."""

    async def _scenario():
        calls = []
        _patch(monkeypatch, fetch_result=[{"id": "live-1", "name": "Live One"}])

        app = _Host()
        async with app.run_test(size=(100, 32)) as pilot:
            screen = mm.ModelPickerScreen()
            app.push_screen(screen)
            await pilot.pause()
            await pilot.pause()
            screen._show_step2("anthropic")
            await pilot.pause()

            # Simulate Enter pressed inside the key input
            from textual.widgets import Input
            event = Input.Submitted(screen.query_one("#mp-key-input", Input),
                                    value="sk-enter-key")
            event.input.value = "sk-enter-key"
            screen.on_input_submitted(event)
            for _ in range(6):
                await pilot.pause()

            assert mm.config.api_keys.get("anthropic") == "sk-enter-key"

    asyncio.run(_scenario())
