from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import Static, Input, TextArea
from textual.reactive import reactive
from textual.message import Message
from textual.binding import Binding
from rich.markup import escape
from andromity.tui.markup_utils import safe_update

_SPINNER_FRAMES = "⣾⣽⣻⢿⡿⣟⣯⣷"


class ContextPanel(Widget):
    DEFAULT_CSS = """\
ContextPanel {
    padding: 1 1;
}
#ctx-title { height: 3; }
"""
    tokens: reactive(int) = reactive(0)
    cost: reactive(float) = reactive(0.0)
    profile: reactive(str) = reactive("builder")

    def compose(self) -> ComposeResult:
        yield Static("[bold]Context[/]", id="ctx-title")
        yield Static("", id="ctx-session")
        yield Static("[dim]──────────[/]", id="ctx-sep")
        yield Static("", id="ctx-tokens")
        yield Static("", id="ctx-cost")
        yield Static("", id="ctx-profile")
        yield Static("", id="ctx-model")
        yield Static("", id="ctx-lsp")

    def update_context(self, tokens: int = 0, cost: float = 0.0, profile: str = "builder", model: str = "", ctx_limit: int = 0, estimated: bool = False, session_name: str = ""):
        self.tokens = tokens
        self.cost = cost
        self.profile = profile
        try:
            if session_name:
                short_sess = session_name if len(session_name) <= 15 else session_name[:12] + "..."
                safe_update(self.query_one("#ctx-session"), f"Session:\n[bold cyan]{escape(short_sess)}[/]")
            tok_prefix = "~" if estimated else ""
            safe_update(self.query_one("#ctx-tokens"), f"{tok_prefix}{tokens:,} tokens")
            safe_update(self.query_one("#ctx-cost"), f"${cost:.4f} spent")
            safe_update(self.query_one("#ctx-profile"), f"Profile: {escape(profile)}")
            short_model = model.split("/")[-1] if "/" in model else model
            safe_update(self.query_one("#ctx-model"), f"[dim]{escape(short_model or '\u2014')}[/dim]")
            # Context window usage bar
            if ctx_limit > 0:
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


class AppFooter(Widget):
    DEFAULT_CSS = """\
AppFooter {
    height: 1; background: $surface-darken-1; padding: 0 1;
    layout: horizontal;
}
#footer-left { width: auto; content-align: left middle; }
#footer-right { width: 1fr; content-align: right middle; }
"""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.cwd = ""

    def compose(self) -> ComposeResult:
        yield Static("", id="footer-left")
        yield Static("", id="footer-right")

    def on_mount(self):
        self.set_interval(1.0, self._refresh_text)

    def _refresh_text(self):
        try:
            import datetime
            now = datetime.datetime.now().strftime("%I:%M %p")
            version = "v0.1.0"
            cwd_part = f" [bold magenta]{escape(self.cwd)}[/]" if self.cwd else ""
            left_text = f" [bold]Andromity {version}[/] |{cwd_part}"
            right_text = f"{now} "
            safe_update(self.query_one("#footer-left"), left_text)
            safe_update(self.query_one("#footer-right"), right_text)
        except Exception:
            pass

    def update_footer(self, cwd: str = ""):
        self.cwd = cwd
        self._refresh_text()


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
        self._ctx_limit: int = 0
        self._estimated: bool = False

    def compose(self) -> ComposeResult:
        yield Static("", id="status-text")

    def _render_status(self) -> str:
        model_part = ""
        if self._provider and self._model:
            model_part = f" [bold cyan]{escape(self._provider)}[/] [white]{escape(self._model)}[/] |"
        elif self._model:
            model_part = f" [white]{escape(self._model)}[/] |"
        else:
            model_part = " [red]no model[/] |"

        stream_part = ""
        if self._streaming:
            frame = _SPINNER_FRAMES[self._spinner_idx % len(_SPINNER_FRAMES)]
            stream_part = f" [green]{frame} streaming…[/] |"

        tok = self.tokens
        ctx_part = ""
        tok_str = f"~{tok:,}" if self._estimated else f"{tok:,}"
        if self._ctx_limit > 0:
            pct = min(tok / self._ctx_limit * 100, 100.0)
            ctx_k = self._ctx_limit // 1000
            color = "green" if pct < 70 else ("yellow" if pct < 90 else "red")
            ctx_part = f" [{color}]{tok_str}/{ctx_k}K[/{color}] [{color}]({pct:.0f}%)[/{color}] |"
        else:
            ctx_part = f" {tok_str} tok |"

        sess_part = ""
        if hasattr(self, "session_name") and self.session_name:
            short_sess = self.session_name if len(self.session_name) <= 15 else self.session_name[:12] + "..."
            sess_part = f" [bold cyan]{escape(short_sess)}[/] |"

        perm_mode = getattr(self, "permission_mode", "safe")
        perm_colors = {"safe": "green", "trust": "yellow", "yolo": "red"}
        pcolor = perm_colors.get(perm_mode, "white")
        perm_part = f" [{pcolor}]\\[{perm_mode.upper()}\\][/{pcolor}] |"

        return (
            f"{stream_part}"
            f"{sess_part}"
            f"{model_part}"
            f" {escape(self.profile)} |"
            f"{perm_part}"
            f"{ctx_part}"
            f" ${self.cost:.4f}"
            f"  [dim]/help[/dim]"
        )

    def _refresh_text(self):
        try:
            safe_update(self.query_one("#status-text"), self._render_status())
        except Exception:
            pass

    def update_status(self, tokens: int = 0, cost: float = 0.0, profile: str = "builder", model: str = "", ctx_limit: int = 0, estimated: bool = False, session_name: str = "", permission_mode: str = "safe"):
        self.tokens = tokens
        self.cost = cost
        self.profile = profile
        self.session_name = session_name
        self.permission_mode = permission_mode
        self._ctx_limit = ctx_limit
        self._estimated = estimated
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


class ChatInput(TextArea):
    BINDINGS = [
        Binding("enter", "submit", "Send", priority=True),
        Binding("shift+enter", "newline", "New Line", priority=True),
    ]

    def action_submit(self):
        text = self.text.strip()
        if text:
            self.post_message(InputBar.Submitted(text))
            self.text = ""

    def action_newline(self):
        self.insert("\n")


class InputBar(Widget):
    """Input bar that lives inside the center panel."""
    DEFAULT_CSS = """\
InputBar {
    height: auto; min-height: 4; max-height: 15; dock: bottom;
    padding: 0 1;
    layers: base placeholder;
}
#input-field {
    width: 1fr;
    height: auto;
    min-height: 3;
    max-height: 14;
    border: none;
    background: $surface;
    layer: base;
}
#input-placeholder {
    position: absolute;
    offset: 2 1;
    color: $text-muted;
    layer: placeholder;
}
"""
    def compose(self) -> ComposeResult:
        yield ChatInput(id="input-field")
        yield Static("Ask me anything… (Enter to send, /help for commands)", id="input-placeholder")

    def on_mount(self):
        self._update_placeholder()

    def on_text_area_changed(self, event: TextArea.Changed):
        self._update_placeholder()

    def _update_placeholder(self):
        try:
            ta = self.query_one("#input-field", TextArea)
            ph = self.query_one("#input-placeholder")
            if ta.text:
                ph.display = False
            else:
                ph.display = True
        except Exception:
            pass

    def on_click(self, event):
        # Focus input if clicking anywhere in the bar (like the placeholder)
        self.app.focus_input()

    def clear_input(self):
        self.query_one("#input-field").text = ""

    class Submitted(Message):
        def __init__(self, text: str):
            super().__init__()
            self.text = text
