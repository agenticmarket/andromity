import asyncio

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Input, OptionList, Static

import andromity.tui.overlays.model as model_picker


MODELS = [
    {"id": "model-one", "name": "Compact Model", "context": "128K"},
    {"id": "model-two", "name": "Reasoning Model", "desc": "Detailed reasoning"},
]


class PickerHost(App):
    def compose(self) -> ComposeResult:
        yield Static("Editor")


@pytest.fixture
def picker_config(monkeypatch):
    values = {"provider": "", "model": "model-one"}
    saved = []

    class Config:
        @staticmethod
        def get(section, key, default=None):
            return values.get(key, default)

        @staticmethod
        def set(section, key, value):
            values[key] = value
            saved.append((key, value))

        @staticmethod
        def get_api_key(provider):
            return "test-key"

    monkeypatch.setattr(model_picker, "config", Config)
    monkeypatch.setattr(model_picker, "provider_catalog", lambda: {
        "example": {"name": "Example Provider", "models": MODELS},
    })
    monkeypatch.setattr(model_picker, "get_cached_live_models", lambda provider: [])
    monkeypatch.setattr(model_picker, "fetch_live_models_sync", lambda *args, **kwargs: MODELS)
    return values, saved


async def open_picker(app, pilot):
    screen = model_picker.ModelPickerScreen()
    app.push_screen(screen)
    await pilot.pause()
    return screen


@pytest.mark.parametrize("select_key", ["enter", "space"])
def test_keyboard_selection_is_explicit_and_apply_saves_it(picker_config, select_key):
    async def scenario():
        app = PickerHost()
        async with app.run_test(size=(100, 35)) as pilot:
            screen = await open_picker(app, pilot)
            await pilot.press(select_key)
            await pilot.pause()
            models = screen.query_one("#mp-models", OptionList)
            assert screen._step == 2
            assert models.has_focus
            assert models.highlighted == 0
            assert "✓" in models.get_option_at_index(0).prompt.plain
            assert screen._selected_model_idx == -1

            await pilot.press("down")
            assert "model-two" in str(screen.query_one("#mp-model-desc", Static).content)
            assert screen._selected_model_idx == -1
            assert not picker_config[1]

            await pilot.press(select_key)
            assert screen._selected_model_idx == 1
            await pilot.click("#mp-apply")
            assert picker_config[0] == {"provider": "example", "model": "model-two"}
            assert app.screen is not screen

    asyncio.run(scenario())


def test_custom_model_takes_priority_over_list_selection(picker_config):
    async def scenario():
        app = PickerHost()
        async with app.run_test(size=(80, 28)) as pilot:
            screen = await open_picker(app, pilot)
            await pilot.press("enter", "down", "enter")
            screen.query_one("#mp-custom-model", Input).value = " custom/model-id "
            await pilot.click("#mp-apply")
            assert picker_config[0]["model"] == "custom/model-id"

    asyncio.run(scenario())


@pytest.mark.parametrize("action", ["cancel", "escape"])
def test_cancel_does_not_save_pending_selection(picker_config, action):
    async def scenario():
        app = PickerHost()
        async with app.run_test(size=(80, 28)) as pilot:
            screen = await open_picker(app, pilot)
            await pilot.press("enter", "down", "enter")
            assert screen._selected_model_idx == 1
            if action == "cancel":
                await pilot.click("#mp-cancel")
            else:
                await pilot.press("escape")
            assert app.screen is not screen
            assert not picker_config[1]

    asyncio.run(scenario())


def test_live_refresh_keeps_selected_model_identity(picker_config):
    async def scenario():
        app = PickerHost()
        async with app.run_test(size=(80, 28)) as pilot:
            screen = await open_picker(app, pilot)
            await pilot.press("enter", "down", "enter")
            screen._on_live_models_received("example", list(reversed(MODELS)))
            await pilot.pause()
            assert screen.query_one("#mp-models", OptionList).highlighted == 0
            await pilot.click("#mp-apply")
            assert picker_config[0]["model"] == "model-two"

    asyncio.run(scenario())


def test_live_refresh_does_not_interrupt_custom_model_entry(picker_config):
    async def scenario():
        app = PickerHost()
        async with app.run_test(size=(80, 28)) as pilot:
            screen = await open_picker(app, pilot)
            await pilot.press("enter")
            custom = screen.query_one("#mp-custom-model", Input)
            custom.focus()
            await pilot.press("m", "y", "-", "i", "d")
            screen._on_live_models_received("example", list(reversed(MODELS)))
            await pilot.pause()
            assert custom.has_focus
            assert custom.value == "my-id"

    asyncio.run(scenario())


@pytest.mark.parametrize("size", [(80, 24), (60, 20)])
def test_key_entry_and_error_hint_keep_actions_reachable(picker_config, monkeypatch, size):
    monkeypatch.setattr(model_picker, "provider_catalog", lambda: {
        "example": {"name": "Example Provider", "models": MODELS, "requires_env": "EXAMPLE_KEY"},
    })
    monkeypatch.setattr(model_picker.config, "get_api_key", lambda *args: "")

    async def scenario():
        app = PickerHost()
        async with app.run_test(size=size) as pilot:
            screen = await open_picker(app, pilot)
            await pilot.press("enter")
            await pilot.pause()
            assert screen.query_one("#mp-key-input", Input).has_focus
            await pilot.click("#mp-connect")
            await pilot.pause()
            assert screen.query_one("#mp-key-hint").has_class("visible")
            assert await pilot.click("#mp-cancel")
            assert app.screen is not screen

    asyncio.run(scenario())


@pytest.mark.parametrize("size", [(100, 35), (80, 24), (60, 20)])
def test_long_catalog_scrolls_without_hiding_controls(picker_config, size):
    async def scenario():
        app = PickerHost()
        async with app.run_test(size=size) as pilot:
            screen = await open_picker(app, pilot)
            await pilot.press("enter")
            catalog = [
                {"id": f"model-{index}-long-identifier", "name": f"Model {index} with a longer display name"}
                for index in range(40)
            ]
            screen._on_live_models_received("example", catalog)
            await pilot.pause()
            await pilot.press("end", "enter")
            assert screen._selected_model_idx == 39
            models = screen.query_one("#mp-models", OptionList)
            assert models.scroll_y > 0
            for selector in ("#mp-custom-model", "#mp-back", "#mp-cancel", "#mp-apply"):
                control = screen.query_one(selector)
                assert control.region.bottom <= size[1], (selector, control.region)
                assert control.region.right <= size[0], (selector, control.region)
            await pilot.click("#mp-apply")
            assert picker_config[0]["model"] == catalog[-1]["id"]

    asyncio.run(scenario())
