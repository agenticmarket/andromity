"""Undo confirmation modal overlay."""
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Static, Button
from andromity.tui.markup_utils import escape_textual as escape


class UndoConfirmOverlay(ModalScreen[bool]):
    """Shown when /undo is requested to verify before rolling back files and messages."""
    DEFAULT_CSS = """\
UndoConfirmOverlay {
    align: center middle;
    background: $background 30%;
}
#undo-dialog {
    width: 90%; max-width: 66;
    height: auto; max-height: 24;
    border: solid $warning;
    background: $surface;
    padding: 0;
}
#undo-title {
    padding: 0 1;
    height: 1;
    background: $warning-darken-2;
    color: $text;
    text-style: bold;
}
#undo-body {
    height: auto;
    padding: 1 2;
}
#undo-prompt-box {
    background: $surface-darken-1;
    border-left: tall $warning;
    padding: 0 1;
    margin: 1 0;
    height: 4;
    overflow-y: auto;
}
#undo-info {
    color: $text-muted;
    height: auto;
    margin-bottom: 1;
}
#undo-footer {
    height: 3;
    padding: 0 1;
    background: $surface-darken-2;
    border-top: solid $surface-lighten-1;
    align: right middle;
}
#undo-footer Button {
    height: 1;
    min-width: 16;
    margin: 0 1;
    padding: 0 2;
    border: none;
}
#undo-cancel {
    background: $surface-lighten-1;
    color: $text-muted;
}
#undo-cancel:hover, #undo-cancel:focus {
    background: $surface-lighten-2;
    color: $text;
}
#undo-confirm {
    background: $warning;
    color: $background;
    text-style: bold;
}
#undo-confirm:hover, #undo-confirm:focus {
    background: $warning-lighten-1;
    color: $background;
}
"""

    def __init__(self, prompt: str = "", **kwargs):
        super().__init__(**kwargs)
        self._prompt = prompt
        self._dismissed = False

    def compose(self) -> ComposeResult:
        with Vertical(id="undo-dialog"):
            yield Static(" ↩ Confirm Undo Turn ", id="undo-title")
            with Vertical(id="undo-body"):
                yield Static("Are you sure you want to undo the last prompt turn?", id="undo-heading")
                with Vertical(id="undo-prompt-box"):
                    yield Static("", id="undo-prompt-text")
                yield Static(
                    "• [green]Files reverted[/]: All edits/creations from this turn restored.\n"
                    "• [green]Context rolled back[/]: Chat & LLM context restored cleanly.\n"
                    "• [green]Prompt restored[/]: The prompt will be loaded back into your input box.",
                    id="undo-info"
                )
            with Horizontal(id="undo-footer"):
                yield Button("Cancel (Esc)", id="undo-cancel")
                yield Button("Undo Turn (Enter)", id="undo-confirm")

    def on_mount(self):
        if self._prompt:
            short = self._prompt.strip()
            try:
                self.query_one("#undo-prompt-text", Static).update(
                    f"[bold cyan]Prompt:[/] {escape(short)}"
                )
            except Exception:
                pass

    def on_button_pressed(self, event: Button.Pressed):
        if self._dismissed:
            event.stop()
            return
        if event.button.id == "undo-confirm":
            self._dismissed = True
            event.button.disabled = True
            self.dismiss(True)
        elif event.button.id == "undo-cancel":
            self._dismissed = True
            event.button.disabled = True
            self.dismiss(False)

    def on_key(self, event):
        if self._dismissed:
            event.stop()
            return
        if event.key == "escape":
            # Never let a modal's Esc bubble to the app (it cancels streaming).
            event.stop()
            self._dismissed = True
            self.dismiss(False)
        elif event.key == "enter":
            event.stop()
            self._dismissed = True
            self.dismiss(True)
