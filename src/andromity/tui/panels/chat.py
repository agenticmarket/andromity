from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widget import Widget
from textual.widgets import Static, Label


class ChatMessage(Widget):
    DEFAULT_CSS = """\
ChatMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
"""
    def __init__(self, role: str, content: str = "", **kwargs):
        super().__init__(**kwargs)
        self.role = role
        self._content = content

    def compose(self) -> ComposeResult:
        from rich.markup import escape
        if self.role == "user":
            yield Label(f"[bold cyan]You:[/] {escape(self._content)}")
        elif self.role == "assistant":
            yield Label(f"[bold green]Andromity:[/] {escape(self._content)}")
        elif self.role == "system":
            yield Label(f"[dim italic]{escape(self._content)}[/]")
        elif self.role == "tool":
            yield Label(f"[dim][tool: {escape(self._content)}][/]")


class ToolIndicator(Widget):
    DEFAULT_CSS = """\
ToolIndicator { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
"""
    def __init__(self, tool_name: str = "", **kwargs):
        super().__init__(**kwargs)
        self.tool_name = tool_name
        self._done = False

    def compose(self) -> ComposeResult:
        from rich.markup import escape
        status = "[green]Done[/]" if self._done else "[yellow]Running...[/]"
        yield Label(f"  [dim]>[/] {escape(self.tool_name)} {status}")

    def mark_done(self):
        self._done = True
        self.refresh()


class StreamingMessage(Widget):
    DEFAULT_CSS = """\
StreamingMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
"""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._text = ""

    def compose(self) -> ComposeResult:
        from rich.markup import escape
        yield Label(f"[bold green]Andromity:[/] {escape(self._text)}")

    def append(self, text: str):
        self._text += text
        try:
            from rich.markup import escape
            self.query_one(Label).update(f"[bold green]Andromity:[/] {escape(self._text)}")
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

    def add_system_message(self, text: str):
        self._messages.append({"role": "system", "content": text})
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

    def _append_widget(self, widget: Widget):
        try:
            self.query_one("#welcome").remove()
        except Exception:
            pass
        self.mount(widget)
        self.scroll_end()
