"""Command palette behaviors:

- typing a `/command` prefix opens the palette
- clicking a command runs it (previously a no-op)
- Enter with the palette open runs the highlighted command
- the option list never steals focus from the input
"""
import asyncio

from textual import on
from textual.app import App, ComposeResult
from textual.widgets import TextArea

from andromity.tui.command_palette import CommandPalette
from andromity.tui.footer import ChatInput, InputBar


class PaletteHost(App):
    def __init__(self):
        super().__init__()
        self.runs: list[str] = []
        self.focus_calls = 0

    def compose(self) -> ComposeResult:
        yield CommandPalette(id="command-palette")
        yield ChatInput(id="input-field", placeholder="Ask…")

    def _process_message(self, cmd: str):
        self.runs.append(cmd)

    def focus_input(self):
        self.focus_calls += 1

    @on(TextArea.Changed, "#input-field")
    def on_input_changed(self, event: TextArea.Changed):
        text = event.text_area.text
        palette = self.query_one("#command-palette", CommandPalette)
        if text.startswith("/") and " " not in text[1:] and "/" not in text[1:]:
            palette.show_commands(text[1:])
        else:
            palette.hide_commands()

    @on(InputBar.Submitted)
    def on_input_submitted(self, event: InputBar.Submitted):
        self._process_message(event.text)


async def _settle(pilot, n=10):
    for _ in range(n):
        await pilot.pause()


def _boot():
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _ctx():
        async with PaletteHost().run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            yield pilot

    return _ctx


def test_typing_slash_opens_palette_and_click_runs_command():
    async def _run():
        async with _boot()() as pilot:
            app = pilot.app
            inp = app.query_one("#input-field")
            inp.text = "/mo"
            await _settle(pilot)
            palette = app.query_one("#command-palette", CommandPalette)
            assert palette.is_open(), "palette should open for /mo"
            # /model is the only match for "mo"
            await pilot.click("#cp-list", offset=(6, 0))
            await _settle(pilot)
            assert app.runs == ["/model"], app.runs
            assert not palette.is_open(), "palette should close after click"
            assert app.focus_calls == 1, "input should be refocused after click"

    asyncio.run(_run())


def test_enter_runs_highlighted_command():
    async def _run():
        async with _boot()() as pilot:
            app = pilot.app
            inp = app.query_one("#input-field")
            inp.text = "/mo"
            await _settle(pilot)
            await pilot.press("enter")
            await _settle(pilot)
            assert app.runs == ["/model"], app.runs

    asyncio.run(_run())


def test_option_list_does_not_take_focus():
    async def _run():
        async with _boot()() as pilot:
            app = pilot.app
            ol = app.query_one("#cp-list")
            assert ol.can_focus is False, "option list must not steal focus"
            inp = app.query_one("#input-field")
            inp.text = "/mo"
            await _settle(pilot)
            await pilot.click("#cp-list", offset=(6, 0))
            await _settle(pilot)
            # Focus must have returned to the input (or never left it)
            assert app.focused is not None

    asyncio.run(_run())


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
