"""Undo confirmation modal overlay."""
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import Static, Button
from rich.markup import escape


class UndoConfirmOverlay(Widget):
    """Shown when /undo is requested to verify before rolling back files and messages."""
    DEFAULT_CSS = """\
UndoConfirmOverlay {
    width: 66; height: 21;
    border: solid $warning; background: $surface;
    align: center middle;
    display: none;
}
UndoConfirmOverlay.visible {
    display: block;
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

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._prompt: str = ""

    def compose(self) -> ComposeResult:
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

    def show_prompt(self, prompt: str):
        self._prompt = prompt
        try:
            pt = self.query_one("#undo-prompt-text", Static)
            short = prompt.strip()
            pt.update(f"[bold cyan]Prompt:[/] {escape(short)}")
        except Exception:
            pass

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "undo-confirm":
            self.remove_class("visible")
            try:
                self.app._perform_confirmed_undo()
            except Exception:
                pass
        elif event.button.id == "undo-cancel":
            self.remove_class("visible")
            try:
                self.app.focus_input()
            except Exception:
                pass
