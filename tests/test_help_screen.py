"""The /help overlay: clickable commands, keyboard navigation, Esc to close."""
import asyncio

from textual.app import App

from andromity.tui.overlays.help import HelpScreen


class HelpHost(App):
    def __init__(self):
        super().__init__()
        self.handled: list[str] = []

    def _handle_command(self, cmd: str):
        self.handled.append(cmd)


async def _settle(pilot, n=12):
    for _ in range(n):
        await pilot.pause()


async def _open_help(pilot):
    pilot.app.push_screen(HelpScreen())
    await _settle(pilot)


def test_help_opens_and_esc_closes():
    async def _run():
        async with HelpHost().run_test(size=(110, 34)) as pilot:
            app = pilot.app
            await _open_help(pilot)
            assert isinstance(app.screen, HelpScreen)
            await pilot.press("escape")
            await _settle(pilot)
            assert len(app.screen_stack) == 1

    asyncio.run(_run())


def test_click_command_runs_it():
    async def _run():
        async with HelpHost().run_test(size=(110, 34)) as pilot:
            app = pilot.app
            await _open_help(pilot)
            # Row 0 is /help, row 1 is /model
            await pilot.click("#help-cmd-1")
            await _settle(pilot)
            assert app.handled == ["/model"], app.handled
            assert len(app.screen_stack) == 1, "help should dismiss after running"

    asyncio.run(_run())


def test_keyboard_navigation_and_enter():
    async def _run():
        async with HelpHost().run_test(size=(110, 34)) as pilot:
            app = pilot.app
            await _open_help(pilot)
            await pilot.press("down")  # /help -> /model
            await pilot.press("enter")
            await _settle(pilot)
            assert app.handled == ["/model"], app.handled
            assert len(app.screen_stack) == 1

    asyncio.run(_run())


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
