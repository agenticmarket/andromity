from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widget import Widget
from textual.widgets import Static, Label, Markdown, Collapsible
from rich.markup import escape
from textual.markup import MarkupError
from andromity.tui.markup_utils import safe_markup, safe_update
import time

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


import re

class ToolIndicator(Widget):
    DEFAULT_CSS = """\
ToolIndicator { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
ToolIndicator Collapsible { border: none; padding: 0; background: transparent; }
"""
    def __init__(self, tool_name: str = "", **kwargs):
        super().__init__(**kwargs)
        self.tool_name = tool_name
        self._args_json = ""
        self._done = False
        self._dots = 0
        self._timer = None

    def compose(self) -> ComposeResult:
        with Collapsible(title=f"  [dim]>[/dim] {escape(self.tool_name)} [yellow]Running...[/yellow]", collapsed=True, id="tool-col"):
            yield Static("", id="tool-args", classes="dim")

    def on_mount(self):
        self._timer = self.set_interval(0.5, self._tick)

    def append_args(self, args_chunk: str):
        self._args_json += args_chunk
        try:
            safe_update(self.query_one("#tool-args"), escape(self._args_json))
        except Exception:
            pass

    def _tick(self):
        if not self._done:
            self._dots += 1
            self._update_title()

    def _update_title(self):
        summary = ""
        m = re.search(r'"(path|command|DirectoryPath|query|Url|AbsolutePath)"\s*:\s*"([^"]+)"', self._args_json)
        if m:
            val = m.group(2)
            if len(val) > 35:
                val = val[:15] + "..." + val[-15:]
            summary = f" ({val})"
        
        status = "[yellow]Running...[/yellow]" if not self._done else "[green]Done[/green]"
        if not self._done:
            dots = "." * (self._dots % 4)
            status = f"[yellow]Running{dots}[/yellow]"
            
        try:
            col = self.query_one("#tool-col", Collapsible)
            col.title = f"  [dim]>[/dim] {escape(self.tool_name)}{escape(summary)} {status}"
        except Exception:
            pass

    def mark_done(self):
        self._done = True
        if self._timer:
            self._timer.stop()
        self._update_title()


class ThinkingBubble(Widget):
    DEFAULT_CSS = """\
ThinkingBubble { width: 1fr; height: auto; padding: 0 1; }
ThinkingBubble Collapsible { border: none; padding: 0; background: transparent; }
"""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._text = ""
        self._start_time = time.time()
        self._done = False
        self._timer = None
        self._md_timer = None
        self._pending = False

    def compose(self) -> ComposeResult:
        with Collapsible(title="💭 Thinking (0s)", collapsed=True, id="think-col"):
            yield Static("", id="think-md", classes="dim italic")

    def on_mount(self):
        self._timer = self.set_interval(1.0, self._tick_time)
        self._md_timer = self.set_interval(0.1, self._flush)

    def _tick_time(self):
        if not self._done:
            elapsed = int(time.time() - self._start_time)
            col = self.query_one("#think-col", Collapsible)
            col.title = f"💭 Thinking ({elapsed}s)"

    def _flush(self):
        if self._pending:
            self._pending = False
            try:
                st = self.query_one("#think-md", Static)
                st.update(escape(self._text))
            except Exception:
                pass

    def append(self, text: str):
        self._text += text
        self._pending = True

    def stop_timer(self):
        self._done = True
        if self._timer:
            self._timer.stop()
        if self._md_timer:
            self._md_timer.stop()
        self._flush()  # Final flush
        elapsed = int(time.time() - self._start_time)
        col = self.query_one("#think-col", Collapsible)
        col.title = f"💭 Thinking ({elapsed}s) ▼"

class StreamingMessage(Widget):
    DEFAULT_CSS = """\
StreamingMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
"""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._text = ""
        self._pending = False
        self._timer = None

    def compose(self) -> ComposeResult:
        yield Static("[bold green]Andromity:[/bold green]", id="assistant-header")
        yield Markdown(" ", id="md-view")

    def on_mount(self):
        self._timer = self.set_interval(0.1, self._flush)

    def _flush(self):
        if self._pending:
            self._pending = False
            try:
                md = self.query_one("#md-view")
                md.update(self._text if self._text.strip() else " ")
            except MarkupError:
                md.update(escape(self._text) if self._text.strip() else " ")
            except Exception:
                pass

    def append(self, text: str):
        self._text += text
        self._pending = True

    def finish(self):
        if self._timer:
            self._timer.stop()
        self._pending = True
        self._flush()


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

    def start_thinking_message(self):
        self._thinking = ThinkingBubble()
        self._append_widget(self._thinking)

    def append_thinking(self, text: str):
        if hasattr(self, "_thinking") and getattr(self, "_thinking", None):
            self._thinking.append(text)

    def stop_thinking_message(self):
        if hasattr(self, "_thinking") and getattr(self, "_thinking", None):
            self._thinking.stop_timer()
            self._thinking = None

    def start_assistant_message(self):
        self._streaming = StreamingMessage()
        self._append_widget(self._streaming)

    def append_text(self, text: str):
        if self._streaming:
            self._streaming.append(text)

    def end_assistant_message(self):
        if self._streaming:
            self._streaming.finish()
            self._messages.append({"role": "assistant", "content": self._streaming._text})
            self._streaming = None

    def show_tool_start(self, tool_name: str):
        self._append_widget(ToolIndicator(tool_name))

    def append_tool_args(self, args_chunk: str):
        try:
            indicators = self.query(ToolIndicator)
            if indicators:
                indicators.last().append_args(args_chunk)
        except Exception:
            pass

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
