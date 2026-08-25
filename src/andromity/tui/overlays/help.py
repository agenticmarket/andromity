"""Help overlay — clickable command list & shortcuts.

Replaces the wall of text /help used to dump into the chat. Commands are
interactive: click one (or ↑/↓ + Enter) to run it.
"""
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Static

from andromity.tui.command_palette import COMMAND_DESCRIPTIONS

SHORTCUTS = [
    ("Ctrl+L", "Switch model / provider"),
    ("Ctrl+J", "Switch profile"),
    ("Ctrl+O", "Browse sessions"),
    ("Ctrl+B", "Toggle file tree"),
    ("Ctrl+R", "Toggle context panel"),
    ("Ctrl+D", "Toggle diff viewer"),
    ("Ctrl+E", "Open settings"),
    ("Alt+N", "New line in input"),
    ("↑ / ↓", "Prompt history (empty input)"),
    ("Tab", "Insert highlighted command without running"),
    ("Esc", "Close dialog"),
    ("Esc ×2", "Interrupt the AI response"),
]


class HelpScreen(ModalScreen):
    DEFAULT_CSS = """\
HelpScreen {
    align: center middle;
    background: $background 20%;
}
#help-dialog {
    width: 90%; max-width: 82;
    height: 85%; max-height: 34; min-height: 20;
    border: solid $accent-darken-2; background: $surface;
}
#help-title { padding: 0 1; height: 1; background: $accent-darken-3; color: $text; text-style: bold; }
#help-body { height: 1fr; overflow-y: auto; padding: 0 2; }
#help-section { height: 1; text-style: bold; margin: 1 0 0 0; }
.help-cmd-row { height: 1; }
.help-cmd-row.hl { color: $accent; text-style: bold; }
.help-cmd-row:hover { color: $accent; }
.help-shortcut { height: 1; }
#help-hint { height: 1; padding: 0 1; color: $text-muted; }
#help-footer { dock: bottom; height: 3; padding: 0 1; }
#help-footer Button { margin: 0 1; }
"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._commands: list[tuple[str, str]] = list(COMMAND_DESCRIPTIONS.items())
        self._selected: int = 0

    def compose(self) -> ComposeResult:
        with Vertical(id="help-dialog"):
            yield Static(" 📖 Help — Commands & Shortcuts ", id="help-title")
            with VerticalScroll(id="help-body"):
                yield Static("Commands  [dim](click to run)[/dim]", id="help-section")
                for i, (cmd, desc) in enumerate(self._commands):
                    yield Static(
                        f"  [bold cyan]{cmd}[/]  [dim]{desc}[/]",
                        id=f"help-cmd-{i}",
                        classes="help-cmd-row",
                    )
                yield Static("Shortcuts", id="help-section-keys")
                for key, desc in SHORTCUTS:
                    yield Static(f"  [bold yellow]{key}[/]  [dim]{desc}[/]", classes="help-shortcut")
                yield Static("\n[dim]✦  Not all commands are listed here. Discovery is part of the experience.[/dim]", id="help-lore-hint")
            yield Static("[dim]↑↓ navigate · Enter run · click a command to run it · Esc close[/dim]", id="help-hint")
            with Horizontal(id="help-footer"):
                yield Button("Close", variant="primary", id="help-close")

    def on_mount(self):
        self._set_selected(0)
        try:
            self.focus()
        except Exception:
            pass

    def _set_selected(self, idx: int):
        self._selected = max(0, min(idx, len(self._commands) - 1))
        try:
            for i in range(len(self._commands)):
                row = self.query_one(f"#help-cmd-{i}", Static)
                if i == self._selected:
                    row.add_class("hl")
                else:
                    row.remove_class("hl")
            self.query_one(f"#help-cmd-{self._selected}", Static).scroll_visible()
        except Exception:
            pass

    def _run_command(self, cmd: str):
        try:
            self.dismiss()
            self.app.call_after_refresh(lambda: self.app._handle_command(cmd))
        except Exception:
            pass

    def _run_selected(self):
        if 0 <= self._selected < len(self._commands):
            self._run_command(self._commands[self._selected][0])

    def on_click(self, event):
        control = getattr(event, "control", None)
        wid = getattr(control, "id", "") or ""
        if wid.startswith("help-cmd-"):
            try:
                idx = int(wid.rsplit("-", 1)[1])
                if 0 <= idx < len(self._commands):
                    self._run_command(self._commands[idx][0])
            except Exception:
                pass

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "help-close":
            self.dismiss()

    def on_key(self, event):
        if event.key == "escape":
            event.stop()
            self.dismiss()
        elif event.key == "up":
            event.stop()
            self._set_selected(self._selected - 1)
        elif event.key == "down":
            event.stop()
            self._set_selected(self._selected + 1)
        elif event.key == "enter":
            event.stop()
            self._run_selected()
