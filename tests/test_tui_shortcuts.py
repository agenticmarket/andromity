"""The footer advertises these shortcuts, and the chat input has focus almost all the time."""
import asyncio

import pytest

from andromity.tui.app import AndromityApp


async def _settle(pilot, n=10):
    for _ in range(n):
        await pilot.pause()


@pytest.mark.parametrize("key,action,screen", [
    ("ctrl+e", "action_toggle_settings", "SettingsScreen"),
    ("ctrl+u", "action_toggle_profile", "ProfilePickerOverlay"),
    ("ctrl+d", "action_toggle_diff", None),
    ("ctrl+o", "action_toggle_sessions", "SessionBrowserOverlay"),
    ("ctrl+l", "action_toggle_model", "ModelPickerScreen"),
])
def test_footer_shortcuts_work_while_typing(key, action, screen):
    async def run():
        app = AndromityApp()
        async with app.run_test(size=(120, 35)) as pilot:
            await _settle(pilot)
            while len(app.screen_stack) > 1:
                await pilot.press("escape")
                await _settle(pilot, 3)
            assert type(app.focused).__name__ == "ChatInput"
            calls = []
            original = getattr(app, action)
            setattr(app, action, lambda *a, **k: (calls.append(action), original(*a, **k)))
            await pilot.press(key)
            await _settle(pilot, 5)
            assert calls == [action]
            if screen:
                assert type(app.screen).__name__ == screen

    asyncio.run(run())


def test_chat_input_keeps_ordinary_editing_keys():
    async def run():
        app = AndromityApp()
        async with app.run_test(size=(120, 35)) as pilot:
            await _settle(pilot)
            while len(app.screen_stack) > 1:
                await pilot.press("escape")
                await _settle(pilot, 3)
            for ch in "abc":
                await pilot.press(ch)
            await pilot.press("home")
            await pilot.press("x")
            await _settle(pilot, 3)
            assert app.focused.text == "xabc"

    asyncio.run(run())


@pytest.mark.parametrize("source,cost,shown", [
    ("unpriced", 0.0, "cost unknown"),
    ("unpriced", 0.012, "?$0.0120"),
    ("free", 0.0, "$0.00 (free)"),
    ("estimate", 0.5, "~$0.5000"),
    ("", 0.25, "$0.2500"),
])
def test_status_bar_says_when_a_model_has_no_price(source, cost, shown):
    from andromity.tui.footer import StatusBar
    bar = StatusBar()
    bar.cost_source = source
    bar.cost = cost
    assert shown in bar._seg_cost()
