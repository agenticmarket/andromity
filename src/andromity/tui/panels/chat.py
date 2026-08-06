from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widget import Widget
from textual.widgets import Static, Label, Markdown
from rich.markup import escape
from textual.markup import MarkupError
from andromity.tui.markup_utils import safe_markup, safe_update

class ChatMessage(Widget):
    DEFAULT_CSS = """\
ChatMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
"""
    def __init__(self, role: str, content: str = "", **kwargs):
        super().__init__(**kwargs)
        self.role = role
        self._content = content

    def compose(self) -> ComposeResult:
        if self.role == "user":
            yield Static(f"[bold cyan]You:[/bold cyan] {escape(self._content)}")
        elif self.role == "assistant":
            yield Static("[bold green]Andromity:[/bold green]", id="assistant-header")
            if self._content.strip():
                yield Markdown(self._content)
            else:
                yield Static("")
        elif self.role == "system":
            yield Static(f"[dim italic]{escape(self._content)}[/dim italic]")
        elif self.role == "system-markup":
            # Pre-validate markup — bad tags fall back to plain escaped text
            yield Static(safe_markup(self._content))
        elif self.role == "tool":
            yield Static(f"[dim][tool: {escape(self._content)}][/dim]")


class ToolIndicator(Widget):
    DEFAULT_CSS = """\
ToolIndicator { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
"""
    def __init__(self, tool_name: str = "", **kwargs):
        super().__init__(**kwargs)
        self.tool_name = tool_name
        self._done = False
        self._dots = 0
        self._timer = None

    def compose(self) -> ComposeResult:
        yield Static(f"  [dim]>[/dim] {escape(self.tool_name)} [yellow]Running...[/yellow]", id="tool-status")

    def on_mount(self):
        self._timer = self.set_interval(0.5, self._tick)

    def _tick(self):
        if not self._done:
            self._dots = (self._dots + 1) % 4
            dots = "." * self._dots
            safe_update(self.query_one("#tool-status"), f"  [dim]>[/dim] {escape(self.tool_name)} [yellow]Running{dots}[/yellow]")

    def mark_done(self):
        self._done = True
        if self._timer:
            self._timer.stop()
        safe_update(self.query_one("#tool-status"), f"  [dim]>[/dim] {escape(self.tool_name)} [green]Done[/green]")


class StreamingMessage(Widget):
    DEFAULT_CSS = """\
StreamingMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
"""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._text = ""

    def compose(self) -> ComposeResult:
        yield Static("[bold green]Andromity:[/bold green]", id="assistant-header")
        yield Markdown(self._text if self._text.strip() else " ", id="md-view")

    def append(self, text: str):
        self._text += text
        try:
            md = self.query_one("#md-view")
            md.update(self._text if self._text.strip() else " ")
        except MarkupError:
            md.update(escape(self._text) if self._text.strip() else " ")
        except Exception:
            pass


class ChatPanel(VerticalScroll):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._streaming = None
        self._messages = []

    def compose(self) -> ComposeResult:
        yield Static("[dim]Andromity TUI - Type a message or /help[/]", id="welcome")

    def add_user_message(self, text: str):
        self._messages.append({"role": "user", "content": text})
        self._append_widget(ChatMessage("user", text))

    def add_system_message(self, text: str, markup: bool = True):
        """Add a system/info message. markup=True allows Rich markup tags."""
        self._messages.append({"role": "system", "content": text})
        if markup:
            self._append_widget(ChatMessage("system-markup", text))
        else:
            self._append_widget(ChatMessage("system", text))

    def start_assistant_message(self):
        self._streaming = StreamingMessage()
        self._append_widget(self._streaming)

    def append_text(self, text: str):
        if self._streaming:
            self._streaming.append(text)

    def end_assistant_message(self):
        if self._streaming:
            self._messages.append({"role": "assistant", "content": self._streaming._text})
            self._streaming = None

    def show_tool_start(self, tool_name: str):
        self._append_widget(ToolIndicator(tool_name))

    def show_tool_end(self):
        try:
            indicators = self.query(ToolIndicator)
            if indicators:
                indicators.last().mark_done()
        except Exception:
            pass

    def clear(self):
        self._messages.clear()
        self._streaming = None
        self.remove_children()
        self.mount(Static("[dim]Chat cleared.[/]", id="welcome"))

    def load_history(self, messages: list):
        """Replay a session's message history into the chat panel visually."""
        self.clear()
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "") or ""
            if not content:
                continue
            if role == "user":
                self._append_widget(ChatMessage("user", content))
            elif role == "assistant":
                self._append_widget(ChatMessage("assistant", content))

    def _append_widget(self, widget: Widget):
        try:
            self.query_one("#welcome").remove()
        except Exception:
            pass
        self.mount(widget)
        self.scroll_end()
