from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import Static, Input
from textual.reactive import reactive
from textual.message import Message
from rich.markup import escape
from andromity.tui.markup_utils import safe_update

_SPINNER_FRAMES = "⣾⣽⣻⢿⡿⣟⣯⣷"


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
        yield Static("", id="ctx-model")
        yield Static("", id="ctx-lsp")

    def update_context(self, tokens: int = 0, cost: float = 0.0, profile: str = "builder", model: str = "", ctx_limit: int = 0):
        self.tokens = tokens
        self.cost = cost
        self.profile = profile
        try:
            safe_update(self.query_one("#ctx-tokens"), f"{tokens:,} tokens")
            safe_update(self.query_one("#ctx-cost"), f"${cost:.4f} spent")
            safe_update(self.query_one("#ctx-profile"), f"Profile: {escape(profile)}")
            short_model = model.split("/")[-1] if "/" in model else model
            safe_update(self.query_one("#ctx-model"), f"[dim]{escape(short_model or '\u2014')}[/dim]")
            # Context window usage bar
            if ctx_limit > 0 and tokens > 0:
                pct = min(tokens / ctx_limit * 100, 100.0)
                bar_width = 10
                filled = int(bar_width * pct / 100)
                bar = "\u2588" * filled + "\u2591" * (bar_width - filled)
                color = "green" if pct < 70 else ("yellow" if pct < 90 else "red")
                ctx_k = ctx_limit // 1000
                safe_update(self.query_one("#ctx-lsp"),
                    f"[{color}]{bar}[/{color}] [{color}]{pct:.1f}%[/{color}]\n"
                    f"[dim]{tokens:,} / {ctx_k}K ctx[/dim]"
                )
            else:
                safe_update(self.query_one("#ctx-lsp"), "[dim]context: \u2014[/dim]")
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

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._model: str = ""
        self._provider: str = ""
        self._streaming: bool = False
        self._spinner_idx: int = 0
        self._spinner_timer = None
        self._ctx_limit: int = 0  # max context window for current model

    def compose(self) -> ComposeResult:
        yield Static(self._render_status(), id="status-text")

    def _render_status(self) -> str:
        model_part = ""
        if self._provider and self._model:
            model_part = f" [bold cyan]{escape(self._provider)}[/bold cyan] [white]{escape(self._model)}[/white] |"
        elif self._model:
            model_part = f" [white]{escape(self._model)}[/white] |"
        else:
            model_part = " [red]no model[/red] |"

        stream_part = ""
        if self._streaming:
            frame = _SPINNER_FRAMES[self._spinner_idx % len(_SPINNER_FRAMES)]
            stream_part = f" [green]{frame} streaming…[/green] |"

        # Context window usage
        tok = self.tokens
        ctx_part = ""
        if self._ctx_limit > 0 and tok > 0:
            pct = min(tok / self._ctx_limit * 100, 100.0)
            ctx_k = self._ctx_limit // 1000
            color = "green" if pct < 70 else ("yellow" if pct < 90 else "red")
            ctx_part = f" [{color}]{tok:,}/{ctx_k}K[/{color}] [{color}]({pct:.0f}%)[/{color}] |"
        else:
            ctx_part = f" {tok:,} tok |"

        return (
            f"{stream_part}"
            f"{model_part}"
            f" {escape(self.profile)} |"
            f"{ctx_part}"
            f" ${self.cost:.4f}"
            f"  [dim]/help[/dim]"
        )

    def _refresh_text(self):
        try:
            safe_update(self.query_one("#status-text"), self._render_status())
        except Exception:
            pass

    def update_status(self, tokens: int = 0, cost: float = 0.0, profile: str = "builder", model: str = "", ctx_limit: int = 0):
        self.tokens = tokens
        self.cost = cost
        self.profile = profile
        self._ctx_limit = ctx_limit
        if "/" in model:
            self._provider, self._model = model.split("/", 1)
        else:
            self._provider = ""
            self._model = model
        self._refresh_text()

    def set_streaming(self, on: bool):
        """Call with on=True when agent starts streaming, on=False when done."""
        self._streaming = on
        if on:
            self._spinner_idx = 0
            self._tick_spinner()
        else:
            if self._spinner_timer is not None:
                try:
                    self._spinner_timer.stop()
                except Exception:
                    pass
                self._spinner_timer = None
            self._refresh_text()

    def _tick_spinner(self):
        self._spinner_idx = (self._spinner_idx + 1) % len(_SPINNER_FRAMES)
        self._refresh_text()
        if self._streaming:
            self._spinner_timer = self.set_timer(0.12, self._tick_spinner)


class InputBar(Widget):
    """Input bar that lives inside the center panel."""
    DEFAULT_CSS = """\
InputBar {
    height: auto; min-height: 3; dock: bottom;
    padding: 0 1;
}
#input-field {
    width: 1fr;
    height: auto;
    min-height: 1;
    
}
"""
    def compose(self) -> ComposeResult:
        yield Input(placeholder="Ask me anything… (Enter to send, /help for commands)", id="input-field")

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
