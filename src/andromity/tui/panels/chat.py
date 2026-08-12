from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widget import Widget
from textual.widgets import Static, Label, Markdown, Collapsible
from rich.markup import escape
from textual.markup import MarkupError
from andromity.tui.markup_utils import safe_markup, safe_update
import re
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


class QueuedMessageBadge(Widget):
    """Shown in chat when a message is queued during streaming."""
    DEFAULT_CSS = """\
QueuedMessageBadge {
    width: 1fr; height: auto; min-height: 1;
    padding: 0 1; margin: 0;
    border-left: tall $warning-darken-1;
    background: #1a1800;
}
"""
    def __init__(self, prompt: str, queue_pos: int, **kwargs):
        super().__init__(**kwargs)
        self._prompt = prompt
        self._queue_pos = queue_pos

    def compose(self) -> ComposeResult:
        short = self._prompt[:50] + ("\u2026" if len(self._prompt) > 50 else "")
        yield Static(
            f"[yellow bold]⏳ Queued #{self._queue_pos}:[/] [dim]{escape(short)}[/]"
            f"  [dim italic](will send after current response)[/]"
        )



class ToolIndicator(Widget):
    DEFAULT_CSS = """\
ToolIndicator { width: 1fr; height: auto; min-height: 1; padding: 0 1; margin: 0; }
ToolIndicator Collapsible { border: none; padding: 0; background: transparent; }
#tool-args { margin: 0 0 0 3; }
#tool-result { margin: 0 0 0 3; }
"""
    _SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    
    def __init__(self, tool_name: str = "", tool_id: str = "", **kwargs):
        super().__init__(**kwargs)
        self.tool_name = tool_name
        self.tool_id = tool_id
        self._args_json = ""
        self._done = False
        self._spinner_frame = 0
        self._start_time = time.time()
        self._timer = None

    def compose(self) -> ComposeResult:
        with Collapsible(title=f"[dim]{escape(self.tool_name)} running...[/dim]", collapsed=True, id="tool-col"):
            yield Static("", id="tool-args", classes="dim")
            yield Static("", id="tool-result")

    def on_mount(self):
        # 250ms (was 100ms) — spinner is cosmetic, 4fps is indistinguishable from 10fps
        self._timer = self.set_interval(0.25, self._tick)

    def append_args(self, args_chunk: str):
        self._args_json += args_chunk
        try:
            disp = self._args_json
            if len(disp) > 200:
                disp = disp[:200] + "..."
            safe_update(self.query_one("#tool-args"), f"Args: {escape(disp)}")
        except Exception:
            pass

    def append_result(self, result: str):
        self.mark_done()
        try:
            res_str = result
            if len(res_str) > 2000:
                res_str = res_str[:1000] + "\n\n... [truncated] ...\n\n" + res_str[-1000:]
            safe_update(self.query_one("#tool-result"), f"\nResult:\n{escape(res_str)}")
        except Exception:
            pass

    def _tick(self):
        if not self._done:
            self._spinner_frame += 1
            self._update_title()

    def _get_icon(self) -> str:
        name = self.tool_name.lower()
        if "file" in name or "read" in name or "write" in name or "edit" in name:
            return "📝"
        if "dir" in name or "list" in name:
            return "📁"
        if "shell" in name or "cmd" in name or "exec" in name or "run" in name:
            return "💻"
        if "search" in name or "grep" in name:
            return "🔍"
        if "web" in name or "browser" in name:
            return "🌐"
        return "🛠️"

    def _update_title(self):
        summary = ""
        m = re.search(r'"(path|command|DirectoryPath|query|Url|AbsolutePath)"\s*:\s*"([^"]+)"', self._args_json)
        if m:
            val = m.group(2)
            if len(val) > 35:
                val = val[:15] + "..." + val[-15:]
            summary = f" ({val})"
        
        elapsed = int(time.time() - self._start_time)
        icon = self._get_icon()
        status_color = "#22c55e" if self._done else "#eab308"
        
        if self._done:
            status = f"done in {elapsed}s"
            spin = "  "
        else:
            spin_char = self._SPINNER_CHARS[self._spinner_frame % len(self._SPINNER_CHARS)]
            spin = f"[dim #38bdf8]{spin_char}[/dim #38bdf8] "
            status = f"running ({elapsed}s)"
            
        try:
            col = self.query_one("#tool-col", Collapsible)
            col.title = f"{spin}[dim]{icon} {escape(self.tool_name)}{escape(summary)} [{status_color}]{status}[/{status_color}][/dim]"
        except Exception:
            pass

    def mark_done(self):
        self._done = True
        if self._timer:
            self._timer.stop()
        self._update_title()
        
        try:
            import json
            args_dict = json.loads(self._args_json)
            for big_field in ["content", "old_str", "new_str"]:
                if big_field in args_dict and len(str(args_dict[big_field])) > 100:
                    args_dict[big_field] = f"... [{len(str(args_dict[big_field]))} chars truncated] ..."
            pretty_args = json.dumps(args_dict, indent=2)
            safe_update(self.query_one("#tool-args"), f"Args:\n{escape(pretty_args)}")
        except Exception:
            pass


class ThinkingBubble(Widget):
    DEFAULT_CSS = """\
ThinkingBubble { width: 1fr; height: auto; padding: 0 1; margin: 0; }
ThinkingBubble Collapsible { border: none; padding: 0; background: transparent; }
#think-md { color: #38bdf8; text-style: italic; padding: 0 0 1 3; }
"""
    _SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._text = ""
        self._start_time = time.time()
        self._done = False
        self._spinner_frame = 0
        self._timer = None
        self._md_timer = None
        self._pending = False

    def compose(self) -> ComposeResult:
        with Collapsible(title="[dim #38bdf8]⠋[/dim #38bdf8]  [dim #38bdf8 italic]thinking (0s)[/dim #38bdf8 italic]", collapsed=True, id="think-col"):
            yield Static("", id="think-md", classes="dim italic")

    def on_mount(self):
        # 200ms intervals (was 100ms) — thinking spinner/flush is cosmetic, halving rate reduces CPU
        self._timer = self.set_interval(0.2, self._tick_time)
        self._md_timer = self.set_interval(0.2, self._flush)

    def _tick_time(self):
        if not self._done:
            self._spinner_frame += 1
            spin = self._SPINNER_CHARS[self._spinner_frame % len(self._SPINNER_CHARS)]
            elapsed = int(time.time() - self._start_time)
            try:
                col = self.query_one("#think-col", Collapsible)
                col.title = f"[dim #38bdf8]{spin}[/dim #38bdf8]  [dim #38bdf8 italic]thinking ({elapsed}s)[/dim #38bdf8 italic]"
            except Exception:
                pass

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
        try:
            col = self.query_one("#think-col", Collapsible)
            col.title = f"   [dim #38bdf8 italic]thought ({elapsed}s)[/dim #38bdf8 italic]"
        except Exception:
            pass

class StreamingMessage(Widget):
    DEFAULT_CSS = """\
StreamingMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
#stream-placeholder { color: #38bdf8; margin: 0 0 0 1; }
"""
    _SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    def __init__(self, show_header: bool = True, **kwargs):
        super().__init__(**kwargs)
        self._show_header = show_header
        self._text = ""
        self._pending = False
        self._timer = None
        self._spinner_frame = 0
        self._first_content_received = False
        self._last_rendered_len = 0  # track how many chars were last rendered

    def compose(self) -> ComposeResult:
        if self._show_header:
            yield Static("[bold green]Andromity:[/bold green]", id="assistant-header")
        yield Static("[dim #38bdf8]⠋ Thinking…[/dim #38bdf8]", id="stream-placeholder")
        yield Markdown(" ", id="md-view")

    def on_mount(self):
        # 150ms interval (was 90ms) — Markdown re-render is expensive; reduce frequency
        self._timer = self.set_interval(0.15, self._flush)

    def hide_placeholder(self):
        if not self._first_content_received:
            self._first_content_received = True
            try:
                self.query_one("#stream-placeholder").remove()
            except Exception:
                pass

    def _flush(self):
        if not self._first_content_received:
            self._spinner_frame += 1
            spin = self._SPINNER_CHARS[self._spinner_frame % len(self._SPINNER_CHARS)]
            try:
                placeholder = self.query_one("#stream-placeholder", Static)
                placeholder.update(f"[dim #38bdf8]{spin} Thinking…[/dim #38bdf8]")
            except Exception:
                pass
        elif self._pending:
            current_len = len(self._text)
            # Skip re-render if fewer than 30 new chars since last render
            # (avoids constant repaints on slow/trickle token streams)
            if current_len - self._last_rendered_len < 30:
                return
            self._pending = False
            self._last_rendered_len = current_len
            try:
                # Find the parent ChatPanel to check scroll position
                chat_panel = self.app.query_one("ChatPanel")
                # Check if we are at or very near the bottom
                at_bottom = chat_panel.scroll_y >= (chat_panel.max_scroll_y - 5)

                md = self.query_one("#md-view")
                md.update(self._text if self._text.strip() else " ")

                # Auto-scroll only if user hasn't scrolled up to read history
                if at_bottom:
                    chat_panel.scroll_end(animate=False)
            except MarkupError:
                md.update(escape(self._text) if self._text.strip() else " ")
                if at_bottom:
                    chat_panel.scroll_end(animate=False)
            except Exception:
                pass

    def append(self, text: str):
        self.hide_placeholder()
        self._text += text
        self._pending = True

    def finish(self):
        if self._timer:
            self._timer.stop()
        self.hide_placeholder()
        self._pending = True
        self._last_rendered_len = 0  # force a final full render
        self._flush()


class ChatPanel(VerticalScroll):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._streaming = None
        self._messages = []
        self._turn_started = False

    def add_user_message(self, text: str):
        self._turn_started = False
        self._messages.append({"role": "user", "content": text})
        self._append_widget(ChatMessage("user", text))

    def add_system_message(self, text: str, markup: bool = True, ephemeral: bool = False):
        """Add a system/info message. markup=True allows Rich markup tags."""
        self._messages.append({"role": "system", "content": text})
        if markup:
            msg = ChatMessage("system-markup", text)
        else:
            msg = ChatMessage("system", text)
            
        if ephemeral:
            msg.add_class("ephemeral")
            
        self.mount(msg)
        self.scroll_end()

    def clear_ephemeral(self):
        """Remove any system messages marked as ephemeral from the UI."""
        for child in self.query(".ephemeral"):
            child.remove()

    def start_thinking_message(self):
        self.start_assistant_message()
        if self._streaming:
            self._streaming.hide_placeholder()
        self._thinking = ThinkingBubble()
        self._streaming.mount(self._thinking, before="#md-view")

    def append_thinking(self, text: str):
        if hasattr(self, "_thinking") and getattr(self, "_thinking", None):
            self._thinking.append(text)

    def stop_thinking_message(self):
        if hasattr(self, "_thinking") and getattr(self, "_thinking", None):
            self._thinking.stop_timer()
            self._thinking = None

    def start_assistant_message(self):
        if getattr(self, "_streaming", None) is None:
            # Only show "Andromity:" header on the very first block of a turn
            show = not getattr(self, "_turn_started", False)
            self._turn_started = True
            self._streaming = StreamingMessage(show_header=show)
            self._append_widget(self._streaming)

    def append_text(self, text: str):
        if not getattr(self, "_streaming", None):
            self.start_assistant_message()
        if self._streaming:
            self._streaming.append(text)

    def end_assistant_message(self):
        if getattr(self, "_streaming", None):
            self._streaming.finish()
            if self._streaming._text.strip():
                self._messages.append({"role": "assistant", "content": self._streaming._text})
            self._streaming = None
            self._thinking = None
        # NOTE: do NOT reset _turn_started here — it resets in add_user_message()
        # so the header only shows once per full user→agent round-trip.

    def show_tool_start(self, tool_name: str, tool_id: str = ""):
        self.stop_thinking_message()
        # Park (finish) the current streaming block but keep _turn_started=True
        # so the next StreamingMessage after the tool won't emit "Andromity:" again.
        if getattr(self, "_streaming", None):
            self._streaming.finish()
            if self._streaming._text.strip():
                self._messages.append({"role": "assistant", "content": self._streaming._text})
            self._streaming = None
            self._thinking = None
        self._append_widget(ToolIndicator(tool_name, tool_id))

    def append_tool_args(self, tool_id: str, args_chunk: str):
        try:
            for ind in self.query(ToolIndicator):
                if ind.tool_id == tool_id:
                    ind.append_args(args_chunk)
                    return
            indicators = self.query(ToolIndicator)
            if indicators:
                indicators.last().append_args(args_chunk)
        except Exception:
            pass

    def show_tool_result(self, tool_id: str, result: str):
        try:
            for ind in self.query(ToolIndicator):
                if ind.tool_id == tool_id:
                    ind.append_result(result)
                    return
            indicators = self.query(ToolIndicator)
            if indicators:
                indicators.last().append_result(result)
        except Exception:
            pass

    def show_tool_end(self, tool_id: str):
        # Tools are now marked done in show_tool_result so they keep spinning during execution/approval
        pass

    def clear(self):
        self._messages.clear()
        self._streaming = None
        self.remove_children()

    def load_history(self, messages: list):
        """Replay a session's message history into the chat panel visually."""
        self._messages.clear()
        self._streaming = None
        self.remove_children()
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
        self.mount(widget)
        self.scroll_end()
