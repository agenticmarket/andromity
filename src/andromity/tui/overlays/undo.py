"""Undo confirmation modal overlay."""
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Static, Button
from rich.markup import escape


class UndoConfirmOverlay(ModalScreen[bool]):
    """Shown when /undo is requested to verify before rolling back files and messages."""
    DEFAULT_CSS = """\
UndoConfirmOverlay {
    align: center middle;
    background: $background 20%;
}
#undo-dialog {
    width: 66; height: 21;
    border: solid $warning; background: $surface;
    padding: 0;
}
#undo-title { padding: 0 1; height: 1; background: $warning-darken-2; color: $text; text-style: bold; }
#undo-body { height: 1fr; padding: 1 2; }
#undo-prompt-box {
    background: $surface-darken-1;
    border-left: tall $warning;
    padding: 0 1;
    margin: 1 0;
    height: 4;
    overflow-y: auto;
}
#undo-info { color: $text-muted; height: auto; }
#undo-footer { dock: bottom; height: 3; padding: 0 1; }
#undo-footer Button { margin: 0 1; }
"""

    def __init__(self, prompt: str = "", **kwargs):
        super().__init__(**kwargs)
        self._prompt = prompt

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
                yield Button("Cancel (Esc)", variant="default", id="undo-cancel")
                yield Button("Undo Turn (Enter)", variant="warning", id="undo-confirm")

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
        if event.button.id == "undo-confirm":
            self.dismiss(True)
        elif event.button.id == "undo-cancel":
            self.dismiss(False)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(False)
        elif event.key == "enter":
            self.dismiss(True)
