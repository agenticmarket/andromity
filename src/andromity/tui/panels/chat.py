from textual.app import ComposeResult
from textual.containers import VerticalScroll, Vertical, Horizontal
from textual.widget import Widget
from textual.widgets import Static, Markdown, Collapsible, Button

from andromity.config import config
from andromity.tui.markup_utils import safe_markup, safe_update, escape_textual as escape
import re
import time
from typing import Any


_ASSISTANT_HEADER = "[bold $success]■ Andromity:[/bold $success]"

class ChatMessage(Widget):
    DEFAULT_CSS = """\
ChatMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
.assistant-header, #assistant-header { width: 1fr; content-align: left middle; }
"""
    def __init__(self, role: str, content: str = "", show_header: bool = True,
                 show_footer: bool = True, **kwargs):
        super().__init__(**kwargs)
        self.role = role
        self._content = content
        self._show_header = show_header
        self._show_footer = show_footer

    def compose(self) -> ComposeResult:
        if self.role == "user":
            yield Static(f"[bold cyan]◆ You:[/bold cyan] {escape(self._content)}")
        elif self.role == "assistant":
            if self._show_header:
                yield Static(_ASSISTANT_HEADER, classes="assistant-header")
            if self._content.strip():
                yield Markdown(self._content)
            else:
                yield Static("")
            # One compact footer line: copy button + timing + tool calls.
            # Intermediate text blocks parked between tool calls pass
            # show_footer=False so only the final block of the turn shows it.
            if self._show_footer:
                with Horizontal(classes="response-footer"):
                    yield Button("⧉ Copy", classes="copy-btn")
                    yield Static("", classes="resp-time")
        elif self.role == "system":
            yield Static(f"[dim italic]{escape(self._content)}[/dim italic]")
        elif self.role == "system-markup":
            # Pre-validate markup — bad tags fall back to plain escaped text
            yield Static(safe_markup(self._content))
        elif self.role == "tool":
            yield Static(f"[dim][tool: {escape(self._content)}][/dim]")

    def on_button_pressed(self, event: Button.Pressed):
        """Copy the raw message content when the ⧉ button is pressed."""
        if event.button.has_class("copy-btn"):
            try:
                self.app.copy_to_clipboard(self._content)
                self.app.notify("Response copied to clipboard")
            except Exception:
                pass

    def set_timing(self, elapsed_s: float, tool_calls: int = 0):
        """Fill in the response-time part of the footer line."""
        try:
            tool_part = ""
            if tool_calls:
                label = "tool call" if tool_calls == 1 else "tool calls"
                tool_part = f" · {tool_calls} {label}"
            self.query_one(".resp-time", Static).update(f"⏱  {elapsed_s:.1f}s{tool_part}")
        except Exception:
            pass


class QueuedMessageBadge(Widget):
    """Shown in chat when a message is queued during streaming."""
    DEFAULT_CSS = """\
QueuedMessageBadge {
    width: 1fr; height: auto; min-height: 1;
    padding: 0 1; margin: 0;
    border-left: tall $warning-darken-1;
    background: $warning 15%;
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
        self._args_chunks: list[str] = []
        self._args_pending = False
        self._done = False
        self._result_text = ""
        self._spinner_frame = 0
        self._start_time = time.time()
        self._timer = None
        self._args_timer = None

    @property
    def _args_json(self) -> str:
        return "".join(self._args_chunks)

    def compose(self) -> ComposeResult:
        with Collapsible(title=self._title_text(), collapsed=True, id="tool-col"):
            args_disp = self._args_json
            if args_disp:
                yield Static(f"Args:\n{escape(args_disp)}", id="tool-args", classes="dim")
            else:
                yield Static("", id="tool-args", classes="dim")
            yield Static("", id="tool-subagent", classes="dim")
            res_disp = self._result_text
            if res_disp:
                if len(res_disp) > 2000:
                    res_disp = res_disp[:1000] + "\n\n... [truncated] ...\n\n" + res_disp[-1000:]
                yield Static(f"\nResult:\n{escape(res_disp)}", id="tool-result")
            else:
                yield Static("", id="tool-result")

    def on_mount(self):
        # 250ms (was 100ms) — spinner is cosmetic, 4fps is indistinguishable from 10fps
        if not self._done:
            self._timer = self.set_interval(0.25, self._tick)
            self._args_timer = self.set_interval(0.15, self._flush_args)

    def on_unmount(self):
        if self._timer is not None:
            try:
                self._timer.stop()
            except Exception:
                pass
            self._timer = None
        if self._args_timer is not None:
            try:
                self._args_timer.stop()
            except Exception:
                pass
            self._args_timer = None

    def set_complete(self, args_json: str = "", result: str = ""):
        """Populate a finished tool call before mounting — used when replaying
        session history so args + result render without live streaming."""
        if args_json:
            self._args_chunks = [args_json]
        if result:
            self._result_text = result
        self._done = True

    def append_args(self, args_chunk: str):
        self._args_chunks.append(args_chunk)
        self._args_pending = True

    def append_subagent_activity(self, evt: Any):
        """Update ToolIndicator with live subagent progress."""
        if not hasattr(self, "_subagent_logs"):
            self._subagent_logs = []
        if not hasattr(self, "_thinking_buf"):
            self._thinking_buf = ""

        event_type = getattr(evt, "event_type", "") or ""
        role = getattr(evt, "role", "") or "subagent"
        detail = getattr(evt, "detail", "") or ""
        tool_name = getattr(evt, "tool_name", None)
        tool_args = getattr(evt, "tool_args", None)
        delta_text = getattr(evt, "delta_text", None)

        entry = None

        if event_type == "thinking" and delta_text:
            # Accumulate thinking tokens — only flush when we hit punctuation or newline
            self._thinking_buf += delta_text
            flush_chars = {".", "!", "?", "\n"}
            if any(c in self._thinking_buf for c in flush_chars) or len(self._thinking_buf) > 80:
                snippet = self._thinking_buf.strip().replace("\n", " ")[:80]
                self._thinking_buf = ""
                if snippet:
                    entry = f"[{role}] thought: {snippet}"
                    self._current_subagent_activity = f"thinking: {snippet[:40]}"
        elif event_type == "tool_call" and tool_name and tool_args is not None:
            # Only emit when ToolCallEnd fires (args are populated) — skip ToolCallStart
            args_str = f"({tool_args[:60]})" if tool_args else ""
            entry = f"[{role}] calling {tool_name}{args_str}"
            self._current_subagent_activity = f"calling {tool_name}"
        elif event_type == "tool_result" and detail:
            # Completion of tool
            snippet = detail[:80]
            entry = f"[{role}] {snippet}"
            self._current_subagent_activity = snippet
        elif event_type == "text" and detail:
            entry = f"[{role}] {detail}"
            self._current_subagent_activity = detail

        if entry and (not self._subagent_logs or self._subagent_logs[-1] != entry):
            self._subagent_logs.append(entry)
            if len(self._subagent_logs) > 20:
                self._subagent_logs.pop(0)

            self._update_title()
            try:
                disp = "\n".join(f"  • {e}" for e in self._subagent_logs)
                safe_update(self.query_one("#tool-subagent", Static), f"\nSubagent Activity:\n{escape(disp)}")
            except Exception:
                pass


    def _flush_args(self):
        if not self._args_pending:
            return
        self._args_pending = False
        try:
            disp = self._args_json
            if len(disp) > 200:
                disp = disp[:200] + "..."
            safe_update(self.query_one("#tool-args"), f"Args: {escape(disp)}")
        except Exception:
            pass

    def append_result(self, result: str):
        self.mark_done()
        self._result_text = result
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
        if "subagent" in name:
            return "🤖"
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

    def _title_text(self) -> str:
        summary = ""
        if self.tool_name == "spawn_subagent" and getattr(self, "_current_subagent_activity", None) and not self._done:
            act = self._current_subagent_activity
            if len(act) > 35:
                act = act[:32] + "…"
            summary = f" ({act})"
        else:
            m = re.search(r'"(path|command|DirectoryPath|query|Url|AbsolutePath|role)"\s*:\s*"([^"]+)"', self._args_json)
            if m:
                val = m.group(2)
                if len(val) > 35:
                    val = val[:15] + "..." + val[-15:]
                summary = f" ({val})"

        elapsed = int(time.time() - self._start_time)
        icon = self._get_icon()

        if self._done:
            status_color = "$success"
            status = f"done in {elapsed}s"
            spin = "  "
            timeout_warn = ""
        else:
            spin_char = self._SPINNER_CHARS[self._spinner_frame % len(self._SPINNER_CHARS)]
            spin = f"[dim $primary]{spin_char}[/dim $primary] "
            # Warn when approaching the 120s default timeout
            if elapsed >= 100:
                status_color = "$error"
                status = f"running ({elapsed}s) ⚠ timeout soon"
            elif elapsed >= 60:
                status_color = "$warning"
                status = f"running ({elapsed}s)"
            else:
                status_color = "$warning"
                status = f"running ({elapsed}s)"
            timeout_warn = ""

        return f"{spin}[dim]{icon} {escape(self.tool_name)}{escape(summary)} [{status_color}]{status}[/{status_color}]{timeout_warn}[/dim]"


    def _update_title(self):
        try:
            col = self.query_one("#tool-col", Collapsible)
            col.title = self._title_text()
        except Exception:
            pass

    def mark_done(self):
        self._done = True
        if self._timer:
            try:
                self._timer.stop()
            except Exception:
                pass
            self._timer = None
        if self._args_timer:
            try:
                self._args_timer.stop()
            except Exception:
                pass
            self._args_timer = None
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


class ToolSequence(Widget):
    """Groups all tool calls of one turn into a single collapsible summary,
    e.g. "🛠 4 tools · worked for 32s". Expand to reveal each tool's own
    collapsible (args / result).
    """
    DEFAULT_CSS = """\
ToolSequence { width: 1fr; height: auto; min-height: 1; padding: 0 1; margin: 0; }
ToolSequence Collapsible { border: none; padding: 0; background: transparent; }
#tools-list { height: auto; }
"""
    _TOOL_ICON = "🛠️"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._started = time.time()
        self._count = 0
        self._finished = False
        self._user_toggled = False
        self._timer = None
        self._pending_tools: list[Widget] = []
        self._last_tool = ""
        self._last_tool_id = ""
        self._last_tool_done = False

    def compose(self) -> ComposeResult:
        auto_expand = config.get("default", "expand_tools_while_working", True)
        is_collapsed = self._finished or not auto_expand
        with Collapsible(title=self._title(), collapsed=is_collapsed, id="tools-col"):
            yield Button("⧉ Copy tool log", classes="copy-tools-btn")
            yield Vertical(id="tools-list")

    def on_mount(self):
        # 1s tick keeps the elapsed counter live while tools are running
        if not self._finished:
            self._timer = self.set_interval(1.0, self._tick)
        # Flush any tools added before the widget finished mounting
        if self._pending_tools:
            for indicator in self._pending_tools:
                try:
                    self.query_one("#tools-list", Vertical).mount(indicator)
                except Exception:
                    pass
            self._pending_tools.clear()

    def _title(self) -> str:
        elapsed = int(time.time() - self._started)
        label = f"{self._count} tool" + ("s" if self._count != 1 else "")
        if self._finished:
            # Replayed sequences have no recorded duration — just say complete
            status = "complete" if elapsed < 1 else f"worked for {elapsed}s"
        elif not self._last_tool_done and self._last_tool:
            # A specific tool is actively executing
            status = f"[$primary]{escape(self._last_tool)}[/$primary] working… ({elapsed}s)"
        elif self._last_tool_done and self._count > 0:
            status = f"working… ({elapsed}s)"
        else:
            # Turn/block is still active (thinking, between tools, or preparing next step)
            status = f"working… ({elapsed}s)"
        return f"[dim]{self._TOOL_ICON} {label} · {status}[/dim]"

    def _tick(self):
        if self._finished:
            return
        try:
            self.query_one("#tools-col", Collapsible).title = self._title()
        except Exception:
            pass

    def on_collapsible_toggled(self, event: Collapsible.Toggled):
        if event.collapsible.id == "tools-col":
            if not self._finished:
                self._user_toggled = True

    def add_tool(self, indicator: "ToolIndicator"):
        self._count += 1
        self._last_tool = indicator.tool_name
        self._last_tool_id = indicator.tool_id
        self._last_tool_done = False
        try:
            self.query_one("#tools-list", Vertical).mount(indicator)
        except Exception:
            # Sequence itself may not be in the DOM yet — flush in on_mount
            self._pending_tools.append(indicator)
        self._tick()

    def add_thinking(self, bubble: "ThinkingBubble"):
        """Insert a thinking bubble into the tool block at the current position.
        Keeps the transcript chronological when the model thinks BETWEEN calls:
        tool1 → thinking → tool2, instead of all thinking after the block.
        """
        try:
            self.query_one("#tools-list", Vertical).mount(bubble)
        except Exception:
            self._pending_tools.append(bubble)
        self._tick()

    def mark_tool_done(self, tool_id: str):
        """Called when the current tool's result arrives — the header stops
        showing its name as "working" (it only shows the running tool)."""
        if self._last_tool_id == tool_id:
            self._last_tool_done = True
        self._tick()

    def on_unmount(self):
        if self._timer is not None:
            try:
                self._timer.stop()
            except Exception:
                pass
            self._timer = None

    def finish(self):
        """Freeze the summary and collapse the section once the turn ends."""
        self._finished = True
        if self._timer is not None:
            try:
                self._timer.stop()
            except Exception:
                pass
            self._timer = None
        try:
            col = self.query_one("#tools-col", Collapsible)
            col.title = self._title()
            if not self._user_toggled:
                col.collapsed = True
        except Exception:
            pass

    def on_button_pressed(self, event: Button.Pressed):
        """Copy a formatted summary of every tool execution in this block."""
        if event.button.has_class("copy-tools-btn"):
            try:
                parts = []
                for i, ind in enumerate(self.query(ToolIndicator), 1):
                    parts.append(
                        f"{i}. {ind.tool_name}\n"
                        f"   Args: {ind._args_json}\n"
                        f"   Result: {getattr(ind, '_result_text', '')}"
                    )
                self.app.copy_to_clipboard("\n\n".join(parts))
                self.app.notify("Tool log copied to clipboard")
            except Exception:
                pass
            event.stop()


class ThinkingBubble(Widget):
    DEFAULT_CSS = """\
ThinkingBubble { width: 1fr; height: auto; padding: 0 1; margin: 0; }
ThinkingBubble Collapsible { border: none; padding: 0; margin: 0; background: transparent; }
ThinkingBubble Collapsible > Contents { padding: 0; margin: 0; }
#think-md { color: $primary; text-style: italic; padding: 0 0 0 3; margin: 0; }
"""
    _SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._chunks: list[str] = []
        self._start_time = time.time()
        self._done = False
        self._spinner_frame = 0
        self._timer = None
        self._md_timer = None
        self._pending = False

    @property
    def _text(self) -> str:
        return "".join(self._chunks).lstrip("\r\n")

    def set_content(self, text: str):
        self._chunks = [text]
        self._done = True
        self._pending = False

    def compose(self) -> ComposeResult:
        # Collapsed by default — shows the live spinner + elapsed time in the
        # title; expand to read the reasoning. Stays in place once finished.
        title = "   [dim italic]thought[/dim italic]" if self._done else "[dim $primary]⠋[/dim $primary]  [dim italic]thinking (0s)[/dim italic]"
        with Collapsible(title=title, collapsed=True, id="think-col"):
            yield Static(escape(self._text), id="think-md", classes="dim italic")

    def on_mount(self):
        if not self._done:
            # 200ms intervals (was 100ms) — thinking spinner/flush is cosmetic, halving rate reduces CPU
            self._timer = self.set_interval(0.2, self._tick_time)
            self._md_timer = self.set_interval(0.2, self._flush)

    def on_unmount(self):
        if self._timer is not None:
            try:
                self._timer.stop()
            except Exception:
                pass
            self._timer = None
        if self._md_timer is not None:
            try:
                self._md_timer.stop()
            except Exception:
                pass
            self._md_timer = None

    def _tick_time(self):
        if not self._done:
            self._spinner_frame += 1
            spin = self._SPINNER_CHARS[self._spinner_frame % len(self._SPINNER_CHARS)]
            elapsed = int(time.time() - self._start_time)
            try:
                col = self.query_one("#think-col", Collapsible)
                col.title = f"[dim $primary]{spin}[/dim $primary]  [dim $primary italic]thinking ({elapsed}s)[/dim $primary italic]"
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
        self._chunks.append(text)
        self._pending = True

    def stop_timer(self):
        self._done = True
        if self._timer:
            try:
                self._timer.stop()
            except Exception:
                pass
            self._timer = None
        if self._md_timer:
            try:
                self._md_timer.stop()
            except Exception:
                pass
            self._md_timer = None
        self._flush()  # Final flush
        elapsed = int(time.time() - self._start_time)
        try:
            col = self.query_one("#think-col", Collapsible)
            col.title = f"   [dim italic]thought ({elapsed}s)[/dim italic]"
        except Exception:
            pass

class StreamingMessage(Widget):
    DEFAULT_CSS = """\
StreamingMessage { width: 1fr; height: auto; min-height: 1; padding: 0 1; }
#stream-placeholder { color: $primary; margin: 0 0 0 1; }
"""
    _SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._header_shown = False
        self._chunks: list[str] = []
        self._pending = False
        self._timer = None
        self._spinner_frame = 0
        self._first_content_received = False
        self._last_rendered_len = 0  # track how many chars were last rendered
        self._last_md_render = time.time()

    @property
    def _text(self) -> str:
        return "".join(self._chunks)

    def compose(self) -> ComposeResult:
        yield Static("[dim $primary]⠋ Thinking…[/dim $primary]", id="stream-placeholder")
        yield Markdown("", id="stream-content")

    def show_header(self):
        """Show the "Andromity:" label above the streamed text. Mounted lazily
        (only on the first block that actually receives text) so the label is
        never lost to an empty thinking-only block."""
        if self._header_shown:
            return
        self._header_shown = True
        try:
            if not self.query(".assistant-header"):
                self.mount(Static(_ASSISTANT_HEADER, classes="assistant-header"), before="#stream-content")
        except Exception:
            # #stream-content may not be mounted yet when text starts in the
            # same tick — defer until the DOM settles.
            def _defer():
                try:
                    if not self.query(".assistant-header"):
                        self.mount(Static(_ASSISTANT_HEADER, classes="assistant-header"), before="#stream-content")
                except Exception:
                    pass
            self.call_after_refresh(_defer)

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

    def _flush(self, force: bool = False):
        if not self._first_content_received:
            self._spinner_frame += 1
            spin = self._SPINNER_CHARS[self._spinner_frame % len(self._SPINNER_CHARS)]
            try:
                placeholder = self.query_one("#stream-placeholder", Static)
                placeholder.update(f"[dim $primary]{spin} Thinking…[/dim $primary]")
            except Exception:
                pass
        elif self._pending:
            text = self._text
            current_len = len(text)
            elapsed_ms = (time.time() - self._last_md_render) * 1000
            
            # Skip small intermediate repaints, but never skip the final flush.
            if not force and (current_len - self._last_rendered_len < 50 or elapsed_ms < 300):
                return
                
            self._pending = False
            self._last_rendered_len = current_len
            self._last_md_render = time.time()
            try:
                # Use self.parent (ChatPanel) directly — cheaper than an
                # app-wide query_one("ChatPanel") on every flush tick.
                chat_panel = self.parent
                at_bottom = chat_panel.scroll_y >= (chat_panel.max_scroll_y - 5)

                stream_content = self.query_one("#stream-content", Markdown)
                stream_content.update(text)

                # Auto-scroll only if user hasn't scrolled up to read history
                if at_bottom:
                    chat_panel.scroll_end(animate=False)
            except Exception:
                pass

    def on_unmount(self):
        if self._timer is not None:
            try:
                self._timer.stop()
            except Exception:
                pass
            self._timer = None

    def append(self, text: str):
        self.hide_placeholder()
        self._chunks.append(text)
        self._pending = True

    def finish(self):
        if self._timer:
            try:
                self._timer.stop()
            except Exception:
                pass
            self._timer = None
        self.hide_placeholder()
        self._pending = True
        self._last_rendered_len = 0  # force a final full render
        self._flush(force=True)


def _serialize_widget(w: Widget) -> dict | None:
    """Extract lightweight display data from a widget to free live widget memory."""
    if isinstance(w, ChatMessage):
        return {
            "type": "chat",
            "role": w.role,
            "content": w._content,
            "show_header": getattr(w, "_show_header", True),
            "show_footer": getattr(w, "_show_footer", True),
        }
    elif isinstance(w, ToolSequence):
        tools = []
        try:
            for child in w.query("#tools-list > *"):
                if isinstance(child, ToolIndicator):
                    tools.append({
                        "kind": "tool",
                        "name": child.tool_name,
                        "id": child.tool_id,
                        "args": child._args_json,
                        "result": getattr(child, "_result_text", ""),
                    })
                elif isinstance(child, ThinkingBubble):
                    tools.append({
                        "kind": "thinking",
                        "text": child._text,
                    })
        except Exception:
            pass
        return {
            "type": "tool_seq",
            "tools": tools,
        }
    elif isinstance(w, ThinkingBubble):
        return {
            "type": "thinking",
            "text": w._text,
        }
    elif isinstance(w, Static) and w.has_class("assistant-header"):
        return {
            "type": "header",
        }
    return None


def _deserialize_widget(d: dict) -> Widget | None:
    """Recreate a live Textual widget from serialized data on demand."""
    wtype = d.get("type")
    if wtype == "chat":
        return ChatMessage(
            role=d.get("role", "assistant"),
            content=d.get("content", ""),
            show_header=d.get("show_header", True),
            show_footer=d.get("show_footer", True),
        )
    elif wtype == "tool_seq":
        seq = ToolSequence()
        for t in d.get("tools", []):
            if t.get("kind") == "thinking":
                tb = ThinkingBubble()
                tb.set_content(t.get("text", ""))
                seq.add_thinking(tb)
            else:
                ind = ToolIndicator(t.get("name", "?"), t.get("id", ""))
                ind.set_complete(args_json=t.get("args", ""), result=t.get("result", ""))
                seq.add_tool(ind)
        seq.finish()
        return seq
    elif wtype == "thinking":
        tb = ThinkingBubble()
        tb.set_content(d.get("text", ""))
        return tb
    elif wtype == "header":
        return Static(_ASSISTANT_HEADER, classes="assistant-header")
    return None


class ChatPanel(VerticalScroll):
    DEFAULT_CSS = """\
ChatPanel { width: 1fr; height: 1fr; overflow-y: auto; background: $surface; }
#load-more-chat {
    width: 100%;
    height: 3;
    margin: 1 0;
    background: $surface-darken-1;
    color: $accent;
    border: tall $accent-darken-2;
    content-align: center middle;
}
#load-more-chat:hover {
    background: $accent-darken-2;
    color: $text;
    text-style: bold;
}

/* ── Markdown polish ─────────────────────────────────────────────────── */
ChatPanel Markdown { padding: 0; margin: 0; }
ChatPanel MarkdownParagraph { margin: 0 0 1 0; }
ChatPanel MarkdownH1 {
    content-align: center middle;
    margin: 1 0;
    padding: 1 0;
    text-style: bold;
    color: $text;
    background: $accent-darken-2;
}
ChatPanel MarkdownH2 {
    margin: 1 0 0 0;
    text-style: bold;
    color: $accent;
}
ChatPanel MarkdownH3,
ChatPanel MarkdownH4,
ChatPanel MarkdownH5,
ChatPanel MarkdownH6 {
    margin: 1 0 0 0;
    text-style: bold;
    color: $text;
}
ChatPanel MarkdownFence {
    background: $surface-darken-1;
    border: round $accent-darken-2;
    margin: 1 0;
    padding: 0 1;
}
ChatPanel MarkdownBlockQuote {
    border-left: thick $accent-darken-1;
    margin: 1 0;
    padding: 0 1;
    color: $text-muted;
}
ChatPanel MarkdownLink { color: $accent; text-style: underline; }
ChatPanel MarkdownBulletList,
ChatPanel MarkdownOrderedList { margin: 0 0 1 1; padding: 0; }
ChatPanel MarkdownListItem { margin: 0; padding: 0; }
ChatPanel MarkdownBlock > .strong { text-style: bold; }
ChatPanel MarkdownBlock > .em { text-style: italic; }
ChatPanel MarkdownBlock > .code_inline { color: $accent; }
"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._streaming = None
        self._thinking = None
        self._tool_seq = None
        self._header_shown = False
        self._unloaded_history = []
        # True when the user has manually scrolled up to read history.
        # While True, new tool calls and system messages won't hijack scroll.
        self._user_scrolled_up = False

    def on_scroll(self, event) -> None:
        """Track scroll position to decide whether to auto-scroll on new content."""
        try:
            at_bottom = self.scroll_y >= (self.max_scroll_y - 5)
            at_top = self.scroll_y <= 5

            # If user scrolled back to bottom, resume auto-scroll
            self._user_scrolled_up = not at_bottom

            # Auto-load older messages when user scrolls to the very top
            if at_top and self._unloaded_history:
                self._load_previous_messages()
        except Exception:
            pass

    def add_user_message(self, text: str, image_count: int = 0):
        self._header_shown = False
        self._tool_seq = None
        display = text
        if image_count:
            marker = "🖼 Image attached" if image_count == 1 else f"🖼 {image_count} images attached"
            display = f"[{marker}]\n\n" + text if text else f"[{marker}]"
        if len(display) > 8000:
            display = display[:4000] + "\n\n...[truncated]...\n\n" + display[-4000:]
        self._append_widget(ChatMessage("user", display))
        self._prune_dom()

    def add_response_time(self, elapsed_s: float, tool_calls: int = 0):
        """Set the timing on the latest assistant message's footer line, so the
        copy button + timing + tool calls share one compact row."""
        try:
            for msg in reversed(list(self.query(ChatMessage))):
                if msg.role == "assistant":
                    msg.set_timing(elapsed_s, tool_calls)
                    break
        except Exception:
            pass

    def add_system_message(self, text: str, markup: bool = True, ephemeral: bool = False):
        """Add a system/info message. markup=True allows Rich markup tags."""
        if markup:
            msg = ChatMessage("system-markup", text)
        else:
            msg = ChatMessage("system", text)

        if ephemeral:
            msg.add_class("ephemeral")

        self.mount(msg)
        if not ephemeral:
            self._prune_dom()
        # Only auto-scroll if the user hasn't scrolled up to read history
        if not self._user_scrolled_up:
            self.scroll_end()

    def clear_ephemeral(self):
        """Remove any system messages marked as ephemeral from the UI."""
        for child in self.query(".ephemeral"):
            child.remove()

    def _ensure_assistant_header(self, before=None):
        """Mount the single '■ Andromity:' label at the TOP of the assistant's
        turn — before thinking and tool blocks — so it always appears first."""
        if self._header_shown:
            return
        self._header_shown = True
        header = Static(_ASSISTANT_HEADER, classes="assistant-header")
        try:
            if before is not None:
                self.mount(header, before=before)
            else:
                self.mount(header)
        except Exception:
            try:
                self.mount(header)
            except Exception:
                pass

    def start_thinking_message(self):
        if self._tool_seq is not None:
            # Thinking BETWEEN tool calls belongs inside the tool block, right
            # after the previous call — the transcript stays chronological.
            self._thinking = ThinkingBubble()
            self._tool_seq.add_thinking(self._thinking)
            return

        # Ensure Andromity: header is at the very top (before any streaming widget)
        if self._streaming is not None:
            self._ensure_assistant_header(before=self._streaming)
            self._streaming.hide_placeholder()
        else:
            self._ensure_assistant_header()
            self.start_assistant_message()
            if self._streaming is not None:
                self._streaming.hide_placeholder()

        self._thinking = ThinkingBubble()
        try:
            self.mount(self._thinking, before=self._streaming)
        except Exception:
            stream = self._streaming
            bubble = self._thinking

            def _defer_mount():
                try:
                    self.mount(bubble, before=stream)
                except Exception:
                    try:
                        self.mount(bubble)
                    except Exception:
                        pass

            if stream is not None:
                stream.call_after_refresh(_defer_mount)
            else:
                try:
                    self.mount(bubble)
                except Exception:
                    pass

    def append_thinking(self, text: str):
        if self._thinking:
            self._thinking.append(text)

    def stop_thinking_message(self):
        if self._thinking:
            self._thinking.stop_timer()
            self._thinking = None

    def start_assistant_message(self):
        if self._streaming is None:
            self._ensure_assistant_header()
            self._streaming = StreamingMessage()
            self._append_widget(self._streaming)

    def append_text(self, text: str):
        # A NEW text block ends the previous segment's tool block. This keeps
        # the transcript chronological per model turn: text → thinking/tools →
        # next text → new thinking/tools block, instead of every tool of the
        # turn piling into one giant sequence.
        if text.strip() and self._tool_seq is not None:
            self._finish_tool_sequence()
        if not self._streaming:
            if text.strip():
                # Label goes above the streaming block, not inside it
                self._ensure_assistant_header()
            self.start_assistant_message()
        if self._streaming:
            if text.strip():
                self._ensure_assistant_header()
            self._streaming.append(text)

    def _prune_dom(self):
        """Keep the DOM light by moving old messages to serialized unloaded history when >60.

        Strategy:
        1. Remove ephemeral system messages first — they are startup-only noise
           and must not count toward the conversation cap.
        2. Prune real conversation messages beyond the 60-message limit into
           _unloaded_history as lightweight dicts so live widget memory is freed.
        """
        # Step 1: sweep out ephemeral startup messages
        for w in list(self.query(".ephemeral")):
            try:
                w.remove()
            except Exception:
                pass

        # Step 2: prune real conversation messages beyond the cap into _unloaded_history
        limit = 60
        messages = [
            m for m in self.children
            if isinstance(m, (ChatMessage, ToolSequence, ThinkingBubble))
            and not m.has_class("ephemeral")
            and getattr(m, "id", None) != "load-more-chat"
        ]
        if len(messages) > limit:
            excess = len(messages) - limit
            for m in messages[:excess]:
                try:
                    ser = _serialize_widget(m)
                    if ser is not None:
                        self._unloaded_history.append(ser)
                    m.remove()
                except Exception:
                    pass
            self._update_load_more_button()

    def _update_load_more_button(self):
        """Ensure the 'Load Previous Messages' button exists and displays the count."""
        if not self._unloaded_history:
            try:
                for btn in self.query("#load-more-chat"):
                    btn.remove()
            except Exception:
                pass
            return

        label = f"↑ Load Previous Messages ({len(self._unloaded_history)} older)"
        try:
            btn = self.query_one("#load-more-chat", Button)
            btn.label = label
        except Exception:
            first_msg = None
            for child in self.children:
                if isinstance(child, (ChatMessage, ToolSequence, ThinkingBubble)) and child.id != "load-more-chat":
                    first_msg = child
                    break
            btn = Button(label, id="load-more-chat")
            if first_msg:
                self.mount(btn, before=first_msg)
            else:
                self.mount(btn)

    def _finish_streaming_block(self, show_footer: bool = True):
        """Replace the plain-text stream with one final rendered Markdown message.

        show_footer=False parks an INTERMEDIATE text block (text that arrived
        before a tool call) without its Copy/footer line — only the last block
        of the turn should carry it.
        """
        streaming = getattr(self, "_streaming", None)
        if streaming is None:
            return

        # A thinking bubble that never got stopped must not keep spinning —
        # stop it now (it stays mounted in the chat panel, above this block).
        if getattr(self, "_thinking", None) is not None:
            try:
                self._thinking.stop_timer()
            except Exception:
                pass
            self._thinking = None

        streaming.finish()
        content = streaming._text
        streaming.remove()

        if content.strip():
            if len(content) > 8000:
                content = content[:4000] + "\n\n...[truncated due to length]...\n\n" + content[-4000:]
            # The turn-level label is already mounted above by
            # _ensure_assistant_header() — parked blocks don't repeat it.
            self.mount(ChatMessage("assistant", content, show_header=False, show_footer=show_footer))
            self._prune_dom()

        self._streaming = None
        self._thinking = None

    def end_assistant_message(self):
        self._finish_streaming_block()
        # A mid-batch thinking bubble (inside the tool block) may still be
        # spinning — stop it now that the turn is over.
        if getattr(self, "_thinking", None) is not None:
            try:
                self._thinking.stop_timer()
            except Exception:
                pass
            self._thinking = None
        self._finish_tool_sequence()
        self._header_shown = False

    def _finish_tool_sequence(self):
        """Freeze the current turn's tool summary once the turn ends."""
        if self._tool_seq is not None:
            try:
                self._tool_seq.finish()
            except Exception:
                pass
            self._tool_seq = None

    def show_tool_start(self, tool_name: str, tool_id: str = ""):
        self.stop_thinking_message()
        # Park (finish) the current streaming block — the next block after the
        # tool still belongs to the same turn. Intermediate blocks carry no
        # Copy/footer line; only the final block of the turn shows it.
        self._finish_streaming_block(show_footer=False)
        # Group sequential tool calls of this turn into one collapsible summary
        if self._tool_seq is None:
            self._ensure_assistant_header()
            self._tool_seq = ToolSequence()
            self._append_widget(self._tool_seq)
        self._tool_seq.add_tool(ToolIndicator(tool_name, tool_id))

    def append_tool_args(self, tool_id: str, args_chunk: str):
        try:
            indicators = list(self.query(ToolIndicator))
            for ind in indicators:
                if ind.tool_id == tool_id:
                    ind.append_args(args_chunk)
                    return
            # No exact id match — fall back to the most-recently added indicator
            if indicators:
                indicators[-1].append_args(args_chunk)
        except Exception:
            pass

    def show_tool_result(self, tool_id: str, result: str):
        try:
            for ind in self.query(ToolIndicator):
                if ind.tool_id == tool_id:
                    ind.append_result(result)
                    break
            else:
                indicators = self.query(ToolIndicator)
                if indicators:
                    indicators.last().append_result(result)
            # Header should stop showing the finished tool's name as "working"
            if self._tool_seq is not None:
                self._tool_seq.mark_tool_done(tool_id)
        except Exception:
            pass

    def show_tool_end(self, tool_id: str):
        # Tools are now marked done in show_tool_result so they keep spinning during execution/approval
        pass

    def show_subagent_progress(self, event: Any):
        """Forward SubAgentProgress event to the matching spawn_subagent ToolIndicator."""
        try:
            target_tool_id = getattr(event, "tool_id", None)
            target_agent_id = getattr(event, "agent_id", None)
            indicators = list(self.query(ToolIndicator))

            # 1. Exact match by parent turn's tool_id (each concurrent spawn has a
            # unique tool_id, so this is unambiguous).
            if target_tool_id:
                for ind in indicators:
                    if ind.tool_id == target_tool_id:
                        ind.append_subagent_activity(event)
                        return

            # 2. Match by previously assigned agent_id on this indicator
            if target_agent_id:
                for ind in indicators:
                    if getattr(ind, "_assigned_agent_id", None) == target_agent_id:
                        ind.append_subagent_activity(event)
                        return

            # 3. Associate agent_id with the first running spawn_subagent indicator
            # without an assigned agent_id.
            if target_agent_id:
                for ind in indicators:
                    if ind.tool_name == "spawn_subagent" and not ind._done and not getattr(ind, "_assigned_agent_id", None):
                        ind._assigned_agent_id = target_agent_id
                        ind.append_subagent_activity(event)
                        return

            # 4. Fallback: forward to any running spawn_subagent indicator that
            # isn't already bound to a different agent (prevents event stealing
            # when multiple spawn_subagent calls run in parallel).
            if target_agent_id:
                for ind in reversed(indicators):
                    if ind.tool_name == "spawn_subagent" and not ind._done:
                        assigned = getattr(ind, "_assigned_agent_id", None)
                        if assigned and assigned != target_agent_id:
                            continue
                        ind.append_subagent_activity(event)
                        return
        except Exception:
            pass



    async def clear(self):
        self._unloaded_history.clear()
        self._streaming = None
        self._thinking = None
        self._tool_seq = None
        self._header_shown = False
        await self.remove_children()

    async def load_history(self, messages: list, compacted_history: list | None = None):
        """Replay a session's message history into the chat panel visually.

        Reconstructs the collapsible tool blocks (args + results) from the
        stored assistant tool_calls / tool messages, so reopening a session
        shows what the agent actually did. Thinking is replayed if persisted.
        Older messages beyond the viewport limit are serialized into lightweight
        data so live widget instances are not kept in memory.

        If *compacted_history* is provided (old messages that were summarized
        away by auto-compaction), they are prepended so the chat UI shows the
        full conversation timeline. The AI never sees these — it only gets
        the summary + recent messages from ``session.messages``.
        """
        self._unloaded_history.clear()
        self._streaming = None
        self._thinking = None
        self._tool_seq = None
        self._header_shown = False
        await self.remove_children()

        # Build full visual timeline: compacted old messages + current messages.
        # Skip system-role messages from compacted history (system prompt,
        # memory summaries) — they add noise to the chat UI.
        full_messages = []
        if compacted_history:
            full_messages.extend(
                m for m in compacted_history if m.get("role") not in ("system",)
            )
        full_messages.extend(messages)

        # ── Replay render ────────────────────────────────────────────────────
        widgets: list[Widget] = []
        tool_seq: ToolSequence | None = None
        pending: list[tuple[str, ToolIndicator]] = []  # (tool_call_id, indicator)
        turn_header_shown = False

        def _flush_seq():
            nonlocal tool_seq, pending
            if tool_seq is not None:
                tool_seq.finish()
                widgets.append(tool_seq)
                tool_seq = None
            pending = []

        def _ensure_turn_header():
            """Emit the green Andromity: label exactly once per assistant turn."""
            nonlocal turn_header_shown
            if not turn_header_shown:
                widgets.append(Static("[bold green]Andromity:[/bold green]", classes="assistant-header"))
                turn_header_shown = True

        for msg in full_messages:
            role = msg.get("role", "")
            content = msg.get("content") or ""
            if role == "user":
                _flush_seq()
                turn_header_shown = False  # reset for the next assistant turn
                widgets.append(ChatMessage("user", content))
            elif role == "assistant":
                thinking_text = msg.get("thinking") or ""
                if thinking_text.strip():
                    tb = ThinkingBubble()
                    tb.set_content(thinking_text)
                    if tool_seq is not None:
                        tool_seq.add_thinking(tb)
                    else:
                        _ensure_turn_header()
                        widgets.append(tb)

                if content.strip():
                    _flush_seq()
                    # show_header=False always — _ensure_turn_header() handles the label
                    _ensure_turn_header()
                    widgets.append(ChatMessage("assistant", content, show_header=False))
                tool_calls = msg.get("tool_calls") or []
                if tool_calls:
                    if tool_seq is None:
                        _ensure_turn_header()
                        tool_seq = ToolSequence()
                    for tc in tool_calls:
                        fn = tc.get("function") or {}
                        ind = ToolIndicator(fn.get("name", "?"), tc.get("id", ""))
                        try:
                            import json
                            args = json.loads(fn.get("arguments") or "{}")
                            args_json = json.dumps(args, indent=2)
                        except Exception:
                            args_json = fn.get("arguments", "")
                        ind.set_complete(args_json)
                        tool_seq.add_tool(ind)
                        pending.append((tc.get("id"), ind))
            elif role == "tool":
                cid = msg.get("tool_call_id")
                for pid, ind in pending:
                    # Guard against None == None matching every id-less entry
                    if pid is not None and pid == cid:
                        ind.set_complete(result=content)
                        break
            elif role == "system":
                # Render compacted memory summary or informational system messages
                if content.strip() and not content.startswith("You are Andromity"):
                    _flush_seq()
                    widgets.append(ChatMessage("system-markup", f"[cyan]ℹ {escape(content)}[/cyan]"))
        _flush_seq()

        # Cap at last 30 turn-widgets, keep earlier ones as lightweight serialized data
        limit = 30
        if len(widgets) > limit:
            older = widgets[:-limit]
            self._unloaded_history = [
                ser for w in older if (ser := _serialize_widget(w)) is not None
            ]
            visible = widgets[-limit:]
            await self.mount(Button(f"↑ Load Previous Messages ({len(self._unloaded_history)} older)", id="load-more-chat"))
        else:
            visible = widgets

        for w in visible:
            await self.mount(w)

        self.scroll_end()

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "load-more-chat":
            event.stop()
            self._load_previous_messages()

    def _load_previous_messages(self):
        if not self._unloaded_history:
            try:
                for btn in self.query("#load-more-chat"):
                    btn.remove()
            except Exception:
                pass
            return

        limit = 30
        to_load_data = self._unloaded_history[-limit:]
        self._unloaded_history = self._unloaded_history[:-limit]

        first_msg = None
        for child in self.children:
            if isinstance(child, (ChatMessage, ToolSequence, ThinkingBubble)) and child.id != "load-more-chat":
                first_msg = child
                break

        widgets_to_mount = [
            _deserialize_widget(d) if isinstance(d, dict) else d
            for d in to_load_data
        ]
        widgets_to_mount = [w for w in widgets_to_mount if w is not None]
        if widgets_to_mount:
            if first_msg:
                self.mount(*widgets_to_mount, before=first_msg)
            else:
                self.mount(*widgets_to_mount)

        self._update_load_more_button()

    def _append_widget(self, widget: Widget):
        self.mount(widget)
        # Only auto-scroll if the user hasn't scrolled up to read history
        if not self._user_scrolled_up:
            self.scroll_end()
