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
ToolIndicator { width: 1fr; height: auto; min-height: 1; padding: 0 1; margin: 1 0; background: #1a1a24; border-left: tall #4a4a8a; }
ToolIndicator Collapsible { border: none; padding: 0 1; background: transparent; }
"""
    def __init__(self, tool_name: str = "", tool_id: str = "", **kwargs):
        super().__init__(**kwargs)
        self.tool_name = tool_name
        self.tool_id = tool_id
        self._args_json = ""
        self._done = False
        self._dots = 0
        self._timer = None

    def compose(self) -> ComposeResult:
        with Collapsible(title=f"  {escape(self.tool_name)} [yellow]Running...[/yellow]", collapsed=True, id="tool-col"):
            yield Static("", id="tool-args", classes="dim")
            yield Static("", id="tool-result")

    def on_mount(self):
        self._timer = self.set_interval(0.5, self._tick)

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
        try:
            res_str = result
            if len(res_str) > 2000:
                res_str = res_str[:1000] + "\n\n... [truncated] ...\n\n" + res_str[-1000:]
            safe_update(self.query_one("#tool-result"), f"\nResult:\n{escape(res_str)}")
        except Exception:
            pass

    def _tick(self):
        if not self._done:
            self._dots += 1
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
        
        icon = self._get_icon()
        status = "[yellow]Running...[/yellow]" if not self._done else "[green]Done[/green]"
        if not self._done:
            dots = "." * (self._dots % 4)
            status = f"[yellow]Running{dots}[/yellow]"
            
        try:
            col = self.query_one("#tool-col", Collapsible)
            col.title = f"{icon} [bold cyan]{escape(self.tool_name)}[/bold cyan]{escape(summary)} {status}"
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
ThinkingBubble { width: 1fr; height: auto; padding: 0 1; }
ThinkingBubble Collapsible { border: none; padding: 0; background: transparent; }
#think-md { color: $text-muted; text-style: italic; padding: 0 0 1 2; border-left: solid $accent-darken-2; }
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
        col.title = f"💭 Thinking ({elapsed}s)"

class StreamingMessage(Widget):
    DEFAULT_CSS = """\
StreamingMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
"""
    def __init__(self, show_header: bool = True, **kwargs):
        super().__init__(**kwargs)
        self._show_header = show_header
        self._text = ""
        self._pending = False
        self._timer = None

    def compose(self) -> ComposeResult:
        if self._show_header:
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


class WelcomeBanner(Widget):
    """Sleek, animated Welcome Hero Banner shown on startup."""
    DEFAULT_CSS = """\
WelcomeBanner {
    width: 1fr;
    height: auto;
    padding: 1 2;
    margin: 1 0;
    border: round #38bdf8;
    background: #0f172a;
}
#banner-ascii {
    width: 1fr;
    content-align: center middle;
    color: #38bdf8;
    text-style: bold;
}
#banner-tagline {
    width: 1fr;
    content-align: center middle;
    margin: 0 0 1 0;
}
#banner-info {
    width: 1fr;
    content-align: center middle;
    color: #94a3b8;
}
#banner-shortcuts {
    width: 1fr;
    content-align: center middle;
    margin: 1 0 0 0;
    color: #64748b;
}
"""
    _PULSE_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._frame = 0
        self._timer = None

    def compose(self) -> ComposeResult:
        banner_art = (
            "   ___   _  ______  ___  ____  __  __________________  __\n"
            "  / _ | / |/ / _  \\/ _ \\/ __ \\/  |/  /  _/_  __/ / / / / /\n"
            " / __ |/    / // // , _/ /_/ / /|_/ // /  / / / /_/ /_/ / \n"
            "/_/ |_/_/|_/____//_/|_|\\____/_/  /_/___/ /_/  \\____/___/  "
        )
        yield Static(banner_art, id="banner-ascii")
        yield Static("[bold cyan]⠋[/bold cyan] [dim italic]The autonomous coding agent that never clocks out[/dim italic] [bold cyan]⠋[/bold cyan]", id="banner-tagline")
        yield Static("[dim]Loading workspace...[/dim]", id="banner-info")
        yield Static(
            "[bold #38bdf8]/help[/] commands  •  [bold #38bdf8]Ctrl+B[/] file tree  •  [bold #38bdf8]Ctrl+L[/] model  •  [bold #38bdf8]Ctrl+J[/] profile",
            id="banner-shortcuts"
        )

    def on_mount(self):
        self._timer = self.set_interval(0.12, self._tick_animation)
        self._update_info()

    def _update_info(self):
        try:
            from andromity.config import config
            from pathlib import Path
            model = config.get("default", "model", "") or "default"
            profile = config.get("default", "profile", "builder")
            cwd_name = Path.cwd().name
            info_text = (
                f"[bold green]● Ready[/bold green]  │  "
                f"[dim]Project:[/] [bold cyan]{escape(cwd_name)}[/]  │  "
                f"[dim]Model:[/] [bold yellow]{escape(model.split('/')[-1])}[/]  │  "
                f"[dim]Profile:[/] [bold magenta]{escape(profile.capitalize())}[/]"
            )
            safe_update(self.query_one("#banner-info"), info_text)
        except Exception:
            pass

    def _tick_animation(self):
        self._frame += 1
        pulse = self._PULSE_CHARS[self._frame % len(self._PULSE_CHARS)]
        try:
            tagline = self.query_one("#banner-tagline", Static)
            tagline.update(
                f"[bold cyan]{pulse}[/bold cyan] [dim italic]The autonomous coding agent that never clocks out[/dim italic] [bold cyan]{pulse}[/bold cyan]"
            )
        except Exception:
            pass

    def on_unmount(self):
        if self._timer:
            self._timer.stop()


class ChatPanel(VerticalScroll):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._streaming = None
        self._messages = []
        self._turn_started = False

    def compose(self) -> ComposeResult:
        yield WelcomeBanner(id="welcome")

    def add_user_message(self, text: str):
        self._turn_started = False
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
        self.start_assistant_message()
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
            self._messages.append({"role": "assistant", "content": self._streaming._text})
            self._streaming = None

    def show_tool_start(self, tool_name: str, tool_id: str = ""):
        self.stop_thinking_message()
        self.end_assistant_message()
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
        try:
            for ind in self.query(ToolIndicator):
                if ind.tool_id == tool_id:
                    ind.mark_done()
                    return
            indicators = self.query(ToolIndicator)
            if indicators:
                indicators.last().mark_done()
        except Exception:
            pass

    def add_queued_message(self, prompt: str, queue_pos: int):
        """Show a queue badge for a message waiting to be sent."""
        badge = QueuedMessageBadge(prompt, queue_pos, classes=f"queued-badge")
        self._append_widget(badge)

    def clear_queue_badge(self, prompt: str):
        """Remove the queue badge when a message is picked up for processing."""
        try:
            for badge in self.query(QueuedMessageBadge):
                if badge._prompt == prompt:
                    # Update badge to show it's now being processed
                    try:
                        st = badge.query_one(Static)
                        short = prompt[:50] + ("…" if len(prompt) > 50 else "")
                        st.update(f"[green]▶ Processing:[/] [dim]{escape(short)}[/]")
                    except Exception:
                        pass
                    break
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
