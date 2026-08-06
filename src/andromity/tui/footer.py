from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import Static, Input
from textual.reactive import reactive
from textual.message import Message


class ContextPanel(Widget):
    DEFAULT_CSS = """\
ContextPanel {
    width: 22; min-width: 18;
    border-left: solid $accent-darken-2;
    padding: 1 1;
}
#ctx-title { height: 3; }
"""
    tokens: reactive(int) = reactive(0)
    cost: reactive(float) = reactive(0.0)
    profile: reactive(str) = reactive("builder")

    def compose(self) -> ComposeResult:
        yield Static("[bold]Context[/]", id="ctx-title")
        yield Static("", id="ctx-tokens")
        yield Static("", id="ctx-cost")
        yield Static("", id="ctx-profile")
        yield Static("", id="ctx-lsp")

    def update_context(self, tokens: int = 0, cost: float = 0.0, profile: str = "builder", model: str = ""):
        self.tokens = tokens
        self.cost = cost
        self.profile = profile
        try:
            self.query_one("#ctx-tokens").update(f"{tokens:,} tokens")
            self.query_one("#ctx-cost").update(f"${cost:.4f} spent")
            self.query_one("#ctx-profile").update(f"Profile: {profile}")
            self.query_one("#ctx-lsp").update("LSPs are disabled")
        except Exception:
            pass


class StatusBar(Widget):
    DEFAULT_CSS = """\
StatusBar {
    height: 1; background: $surface-darken-1; padding: 0 1;
}
"""
    tokens: reactive(int) = reactive(0)
    cost: reactive(float) = reactive(0.0)
    profile: reactive(str) = reactive("builder")

    def compose(self) -> ComposeResult:
        yield Static(self._render_status(), id="status-text")

    def _render_status(self) -> str:
        return (
            f" {self.profile} "
            f" | {self.tokens:,} tokens "
            f" | ${self.cost:.4f} "
            f" | /help"
        )

    def update_status(self, tokens: int = 0, cost: float = 0.0, profile: str = "builder", model: str = ""):
        self.tokens = tokens
        self.cost = cost
        self.profile = profile
        try:
            self.query_one("#status-text").update(self._render_status())
        except Exception:
            pass


class InputBar(Widget):
    """Input bar that lives inside the center panel."""
    DEFAULT_CSS = """\
InputBar {
    height: 3; dock: bottom;
    padding: 0 1;
}
#input-field {
    width: 1fr;
    height: 3;
}
"""
    def compose(self) -> ComposeResult:
        yield Input(placeholder="Ask me anything... (Enter to send, /help for commands)", id="input-field")

    def on_input_submitted(self, event: Input.Submitted):
        text = event.value.strip()
        if text:
            self.post_message(self.Submitted(text))
            event.input.value = ""

    def clear_input(self):
        self.query_one("#input-field").value = ""

    class Submitted(Message):
        def __init__(self, text: str):
            super().__init__()
            self.text = text
