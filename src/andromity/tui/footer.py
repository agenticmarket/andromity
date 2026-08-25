import re

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widget import Widget
from textual.widgets import Static, Input, TextArea, Button
from textual.reactive import reactive
from textual.message import Message
from textual.binding import Binding
from andromity.tui.markup_utils import safe_update, escape_textual as escape
from andromity.core.images import MAX_IMAGES, image_label
from andromity.core.debug_log import get_logger
from andromity.config import config
from andromity.tui.overlays.help import HelpScreen

log = get_logger("footer")

_SPINNER_FRAMES = "⣾⣽⣻⢿⡿⣟⣯⣷"

_TAG_RE = re.compile(r"\[/?[a-zA-Z#][^\]]*\]")


def _plain_len(s: str) -> int:
    """Rough display width of a Textual markup string (tags stripped)."""
    s2 = _TAG_RE.sub("", s)
    s2 = s2.replace("\\[", "[").replace("\\]", "]")
    return len(s2)


def _format_tok_compact(n: int) -> str:
    if n >= 1_000_000:
        val = n / 1_000_000
        return f"{val:.1f}M" if val % 1 != 0 and val < 10 else f"{int(round(val))}M"
    elif n >= 1_000:
        val = n / 1_000
        return f"{val:.1f}K" if val % 1 != 0 and val < 10 else f"{int(round(val))}K"
    return str(n)


def _format_smart_path(cwd: str, max_len: int = 35) -> str:
    """Intelligently shorten a directory path for compact footer display."""
    if not cwd:
        return ""
    try:
        from pathlib import Path
        import os
        p = Path(cwd).resolve()
        # Try replacing user home directory with ~
        try:
            home = Path.home()
            rel_home = p.relative_to(home)
            short = f"~{os.sep}{rel_home}"
            if len(short) <= max_len:
                return short
        except (ValueError, Exception):
            pass

        if len(cwd) <= max_len:
            return cwd

        # Keep last 2 path segments if possible, else last 1 segment
        parts = p.parts
        sep = os.sep
        if len(parts) >= 2:
            short2 = f"...{sep}{parts[-2]}{sep}{parts[-1]}"
            if len(short2) <= max_len:
                return short2
            short1 = f"...{sep}{parts[-1]}"
            if len(short1) <= max_len:
                return short1
    except Exception:
        pass

    if len(cwd) > max_len:
        return "..." + cwd[-(max_len - 3):]
    return cwd


class ContextPanel(Widget):
    DEFAULT_CSS = """\
ContextPanel {
    padding: 1 1;
}
#ctx-title { height: 1; }
"""
    tokens: reactive[int] = reactive(0)
    cost: reactive[float] = reactive(0.0)
    profile: reactive[str] = reactive("builder")

    def compose(self) -> ComposeResult:
        yield Static("[bold]Context[/]", id="ctx-title")
        yield Static("", id="ctx-session")
        yield Static("", id="ctx-model")
        yield Static("", id="ctx-mcp")
        yield Static("", id="ctx-lsp")

    def update_context(self, tokens: int = 0, cost: float = 0.0, profile: str = "builder", model: str = "", ctx_limit: int = 0, estimated: bool = False, session_name: str = "", mcp_summary: dict | None = None, cost_source: str = "unpriced"):
        # Cost and profile are intentionally NOT shown here — the status bar's
        # cost segment and the footer's profile badge are the canonical spots.
        try:
            safe_update(self.query_one("#ctx-session"), f"Session: [bold]{escape(session_name)}[/]")
            short_model = model.split("/")[-1] if "/" in model else model
            safe_update(self.query_one("#ctx-model"), f"[dim]{escape(short_model or '—')}[/dim]")

            # MCP status in context panel
            if mcp_summary and mcp_summary.get("configured", 0) > 0:
                active = mcp_summary.get("active", 0)
                failed = mcp_summary.get("failed", 0)
                initializing = mcp_summary.get("initializing", 0)
                tools_cnt = mcp_summary.get("tools_count", 0)
                
                if initializing > 0:
                    safe_update(self.query_one("#ctx-mcp"), f"[bold yellow]⟳[/] MCP: {initializing} initializing [dim]({active} ok)[/dim]")
                elif failed > 0:
                    safe_update(self.query_one("#ctx-mcp"), f"[bold red]✗[/] MCP: {failed} failed [dim]({active} ok, {tools_cnt} tools)[/dim]")
                else:
                    safe_update(self.query_one("#ctx-mcp"), f"[bold green]●[/] MCP: [green]{active} active[/] [dim]({tools_cnt} tools)[/dim]")
            else:
                safe_update(self.query_one("#ctx-mcp"), "[dim]MCP: None active[/dim]")

            if ctx_limit > 0:
                pct = min(tokens / ctx_limit * 100, 100.0)
                bar_width = 14
                filled = int(bar_width * pct / 100)
                bar = "█" * filled + "░" * (bar_width - filled)
                color = "green" if pct < 70 else ("yellow" if pct < 90 else "red")
                # Visual fill only — exact numbers live in the status bar's tok segment.
                safe_update(self.query_one("#ctx-lsp"),
                    f"[{color}]{bar}[/{color}] [{color}]{pct:.0f}%[/{color}]"
                )
            else:
                safe_update(self.query_one("#ctx-lsp"), "")
        except Exception:
            pass


class AppFooter(Widget):
    DEFAULT_CSS = """\
AppFooter {
    height: 1; background: $surface-darken-1; padding: 0 1;
    layout: horizontal;
}
#footer-left { width: auto; content-align: left middle; }
#footer-profile {
    width: auto; height: 1;
    color: $text;
    padding: 0 1;
}
#footer-profile:hover { color: $accent !important; text-style: bold; }
#footer-spacer { width: 1fr; }
#footer-version {
    width: auto; height: 1;
    color: $text-muted;
    padding: 0 1;
    content-align: right middle;
}
#footer-version:hover { color: $accent !important; }
#footer-settings {
    width: auto; min-width: 12; height: 1;
    border: none !important; background: transparent !important;
    color: $text-muted !important;
    padding: 0 1 !important;
}
#footer-settings:hover { color: $accent !important; }
"""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.cwd = ""
        self._git_branch = ""  # cached; refreshed when cwd changes
        self._profile = "builder"  # shown in bottom bar
        self._update_available = False
        self._latest_version = ""
        self._is_trusted: bool | None = None  # None = unknown (not yet checked)

    def compose(self) -> ComposeResult:
        yield Static("", id="footer-left")
        yield Static("", id="footer-profile", classes="clickable")
        yield Static("", id="footer-spacer")
        yield Static("", id="footer-version", classes="clickable")
        yield Button("⚙  Settings", id="footer-settings")

    def on_mount(self):
        self._refresh_text()

    def _refresh_text(self):
        try:
            from andromity import __version__
            version = f"v{__version__}"

            parts = []
            if self.cwd:
                display_path = _format_smart_path(self.cwd, max_len=35)
                parts.append(f"[bold]⌂ {escape(display_path)}[/]")

            if self._git_branch:
                parts.append(f"[bold cyan]⎇ {escape(self._git_branch)}[/]")

            left_text = "  ".join(parts)
            if left_text:
                left_text = f" {left_text}  [dim]│[/] "
            else:
                left_text = " "
            footer_left = self.query_one("#footer-left")
            safe_update(footer_left, left_text)

            # Tooltip on hover
            if self._is_trusted is True:
                footer_left.tooltip = f"Trusted folder: {self.cwd}\nFull file access & shell execution enabled."
            elif self._is_trusted is False:
                footer_left.tooltip = f"Untrusted folder (Restricted): {self.cwd}\nFile writes and shell execution blocked. Click to trust."
            elif self.cwd:
                footer_left.tooltip = f"Working directory: {self.cwd}"

            profile_text = f"[bold $info]» {escape(self._profile)}[/]" if self._profile else ""
            safe_update(self.query_one("#footer-profile"), profile_text)

            version_text = f"[dim]Andromity {version}[/dim]"
            if self._update_available and self._latest_version:
                version_text += f" [bold $warning]▲ v{escape(self._latest_version)}[/]"
            safe_update(self.query_one("#footer-version"), version_text)
        except Exception:
            pass

    def on_click(self, event):
        control = getattr(event, "control", None)
        wid = getattr(control, "id", None)
        if wid == "footer-left":
            try:
                if self._is_trusted is False:
                    if hasattr(self.app, "action_show_trust_prompt"):
                        self.app.action_show_trust_prompt()
                elif self._is_trusted is True:
                    self.app.notify(f"Folder is trusted:\n{self.cwd}", title="Workspace Trust", severity="information")
            except Exception:
                pass
        elif wid == "footer-profile":
            try:
                self.app.action_toggle_profile()
            except Exception:
                pass
        elif wid == "footer-version":
            if self._update_available:
                try:
                    self.app.action_run_update()
                except Exception:
                    pass

    def set_update_available(self, latest_version: str):
        """Show update notification badge in the footer."""
        self._update_available = True
        self._latest_version = latest_version
        self._refresh_text()

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "footer-settings":
            try:
                self.app.action_toggle_settings()
            except Exception:
                pass

    def set_trust_state(self, is_trusted: bool) -> None:
        """Update the trust badge without changing any other footer state."""
        self._is_trusted = is_trusted
        self._refresh_text()

    def update_footer(self, cwd: str = "", profile: str = ""):
        self.cwd = cwd
        if profile:
            self._profile = profile
        # Refresh git branch whenever the working directory changes
        self._git_branch = self._read_git_branch(cwd)
        # Re-check trust status for the new cwd
        if cwd:
            try:
                from andromity.config import config
                self._is_trusted = config.is_trusted(cwd)
            except Exception:
                self._is_trusted = None
        else:
            self._is_trusted = None
        self._refresh_text()

    @staticmethod
    def _read_git_branch(cwd: str) -> str:
        """Return the current git branch name, or empty string if not a git repo."""
        if not cwd:
            return ""
        try:
            import subprocess
            result = subprocess.run(
                ["git", "branch", "--show-current"],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=2,
            )
            return result.stdout.strip() if result.returncode == 0 else ""
        except Exception:
            return ""


class StatusBar(Widget):
    DEFAULT_CSS = """\
StatusBar {
    height: 1; background: $surface-darken-1; padding: 0 1;
    layout: horizontal;
}
.status-seg { height: 1; padding: 0; width: auto; }
.status-seg.clickable:hover { color: $accent !important; text-style: bold; }
#seg-hint { width: auto; }
"""
    tokens: reactive[int] = reactive(0)
    cost: reactive[float] = reactive(0.0)

    _EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._model: str = ""
        self._provider: str = ""
        self._streaming: bool = False
        self._spinner_idx: int = 0
        self._spinner_timer = None
        self._ctx_limit: int = 0
        self._estimated: bool = False
        self._hint: str = ""
        self._todo_done: int = 0
        self._todo_total: int = 0
        self._effort: str = config.get("default", "reasoning_effort", "medium")

    def compose(self) -> ComposeResult:
        yield Static("", id="seg-stream", classes="status-seg")
        yield Static("", id="seg-model", classes="status-seg clickable")
        yield Static("", id="seg-effort", classes="status-seg clickable")
        yield Static("", id="seg-perm", classes="status-seg clickable")
        yield Static("", id="seg-ctx", classes="status-seg")
        yield Static("", id="seg-todo", classes="status-seg")
        yield Static("", id="seg-cost", classes="status-seg")
        yield Static("", id="seg-hint", classes="status-seg clickable")

    def _seg_stream(self) -> str:
        if not self._streaming:
            return ""
        frame = _SPINNER_FRAMES[self._spinner_idx % len(_SPINNER_FRAMES)]
        return f"[green]{frame} streaming…[/] [dim]·[/dim] "

    def _seg_model(self) -> str:
        if not self._model:
            return "[red]no model[/] [dim]·[/dim] "
        budget = self._model_budget()
        model = self._model
        if len(model) > budget:
            model = model[: max(budget - 1, 4)] + "…"
        if self._provider:
            return f"[bold cyan]{escape(self._provider)}[/] [white]{escape(model)}[/] [dim]·[/dim] "
        return f"[white]{escape(model)}[/] [dim]·[/dim] "

    def _model_budget(self) -> int:
        """Columns available for the model name so the whole bar fits the center
        panel and every segment keeps its own clickable area."""
        fixed = (
            _plain_len(self._seg_stream())
            + _plain_len(self._seg_effort())
            + _plain_len(self._seg_perm())
            + _plain_len(self._seg_ctx())
            + _plain_len(self._seg_todo())
            + _plain_len(self._seg_cost())
            + _plain_len(self._seg_hint())
            + 6
        )
        provider_overhead = len(self._provider) + 1 if self._provider else 0
        try:
            width = self.size.width
        except Exception:
            width = 0
        return max(10, width - fixed - provider_overhead - 2)

    def _seg_effort(self) -> str:
        if self._effort == "off":
            return "[dim]reason:off[/] [dim]·[/dim] "
        return f"[bold cyan]reason:{escape(self._effort)}[/] [dim]·[/dim] "

    def _seg_perm(self) -> str:
        perm_mode = getattr(self, "permission_mode", "safe")
        perm_colors = {"safe": "green", "trust": "yellow", "yolo": "red"}
        pcolor = perm_colors.get(perm_mode, "white")
        return f"[{pcolor}]\\[{perm_mode.upper()}][/][{pcolor}] [dim]·[/dim] "

    def _seg_ctx(self) -> str:
        tok = self.tokens
        tok_str = f"~{_format_tok_compact(tok)}" if self._estimated else _format_tok_compact(tok)
        if self._ctx_limit > 0:
            pct = min(tok / self._ctx_limit * 100, 100.0)
            ctx_k = _format_tok_compact(self._ctx_limit)
            color = "green" if pct < 70 else ("yellow" if pct < 90 else "red")
            warn_icon = "⚠" if pct >= 90 else ""
            return f"[{color}]{tok_str}/{ctx_k}{warn_icon} tok[/{color}] [dim]·[/dim] "
        return f"{tok_str} tok [dim]·[/dim] "

    def _seg_todo(self) -> str:
        if self._todo_total <= 0:
            return ""
        color = "green" if self._todo_done == self._todo_total else "yellow"
        return f"[{color}]{self._todo_done}/{self._todo_total} todos[/{color}] [dim]·[/dim] "

    def _seg_cost(self) -> str:
        cost_source = getattr(self, "cost_source", "")
        if cost_source == "free":
            return f"$0.00 (free) [dim]·[/dim] "
        cost_prefix = "~" if "estimate" in cost_source else ("?" if cost_source == "unpriced" else "")
        return f"{cost_prefix}${self.cost:.4f} [dim]·[/dim] "

    def _seg_hint(self) -> str:
        return f"[dim]{escape(self._hint) if self._hint else '/help'}[/dim]"

    def on_resize(self, event):
        # Re-run with the real bar width so the model truncation fits the panel.
        self._refresh_text()

    def _refresh_text(self):
        try:
            for wid, text in (
                ("seg-stream", self._seg_stream()),
                ("seg-model", self._seg_model()),
                ("seg-effort", self._seg_effort()),
                ("seg-perm", self._seg_perm()),
                ("seg-ctx", self._seg_ctx()),
                ("seg-todo", self._seg_todo()),
                ("seg-cost", self._seg_cost()),
                ("seg-hint", self._seg_hint()),
            ):
                safe_update(self.query_one(f"#{wid}"), text)
        except Exception:
            pass

    def on_click(self, event):
        """Clickable status segments: model → model picker, effort → cycle, mode → cycle."""
        control = getattr(event, "control", None)
        wid = getattr(control, "id", None)
        if wid == "seg-model":
            try:
                self.app.action_toggle_model()
            except Exception:
                pass
        elif wid == "seg-effort":
            self._cycle_effort()
        elif wid == "seg-perm":
            self._cycle_permission_mode()
        elif wid == "seg-hint":
            try:
                self.app.push_screen(HelpScreen())
            except Exception:
                pass

    def _cycle_effort(self):
        """Cycle reasoning effort: off → low → medium → high → xhigh → max → off."""
        try:
            levels = self._EFFORT_LEVELS
            idx = levels.index(self._effort) if self._effort in levels else 0
            self._effort = levels[(idx + 1) % len(levels)]
            # Persist reasoning effort in config
            try:
                config.set("default", "reasoning_effort", self._effort)
            except Exception:
                pass
            # Notify the app so it can update the agent
            try:
                self.app.on_reasoning_effort_changed(self._effort)
            except Exception:
                pass
            self._refresh_text()
        except Exception:
            pass

    def _cycle_permission_mode(self):
        """Cycle safe → trust → full (same persistence rules as /mode)."""
        try:
            app = self.app
            order = ["safe", "trust", "full"]
            current = getattr(self, "permission_mode", "safe")
            if getattr(app, "_yolo_session", False):
                app._yolo_session = False
                nxt = "safe"
            elif current in order:
                nxt = order[(order.index(current) + 1) % len(order)]
            else:
                nxt = "safe"
            config.set("default", "permission_mode", nxt)
            if getattr(app, "_is_streaming", False):
                app._pending_mode_change = True
                self.show_hint(f"Mode change to {nxt.upper()} pending…", 10.0)
            else:
                app._apply_mode_change()
        except Exception:
            pass

    def update_status(self, tokens: int = 0, cost: float = 0.0, profile: str = "builder", model: str = "", ctx_limit: int = 0, estimated: bool = False, session_name: str = "", permission_mode: str = "safe", cost_source: str = "unpriced", effort: str = ""):
        self.tokens = tokens
        self.cost = cost
        self.cost_source = cost_source
        self.session_name = session_name
        self.permission_mode = permission_mode
        self._ctx_limit = ctx_limit
        self._estimated = estimated
        if effort:
            self._effort = effort
        if "/" in model:
            self._provider, self._model = model.split("/", 1)
        else:
            self._provider = ""
            self._model = model
        self._refresh_text()

    def update_todo_progress(self, done: int, total: int):
        self._todo_done = done
        self._todo_total = total
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

    def show_hint(self, text: str, duration: float = 2.0):
        """Show a temporary hint message in the status bar."""
        self._hint = text
        self._refresh_text()
        self.set_timer(duration, self._clear_hint)

    def _clear_hint(self):
        self._hint = ""
        self._refresh_text()

    def _tick_spinner(self):
        self._spinner_idx = (self._spinner_idx + 1) % len(_SPINNER_FRAMES)
        # Only refresh the stream segment on tick — other segments update via
        # their own reactive watchers, not every 120 ms.
        try:
            safe_update(self.query_one("#seg-stream"), self._seg_stream())
        except Exception:
            pass
        if self._streaming:
            self._spinner_timer = self.set_timer(0.12, self._tick_spinner)


class ChatInput(TextArea):
    BINDINGS = [
        Binding("enter", "submit", "Send", priority=True),
        Binding("shift+enter", "newline", "New Line", priority=True),
        Binding("alt+enter", "newline", "New Line", priority=True),
        Binding("alt+n", "newline", "New Line", priority=True),
        Binding("ctrl+j", "steer", "Steer", priority=True),
        Binding("ctrl+enter", "steer", "Steer", priority=True),
        # priority=True so it shadows TextArea's default paste — lets us grab
        # an image off the clipboard instead of inserting its text repr.
        Binding("ctrl+v", "paste_image_or_text", "Paste", priority=True),
    ]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._prompt_history: list[str] = []
        self._history_idx: int = -1
        self._draft: str = ""
        self._is_placeholder: bool = False
        self._just_attached_image: bool = False

    def _command_palette(self):
        try:
            return self.app.query_one("#command-palette")
        except Exception:
            return None

    def _mentions(self):
        try:
            return self.app.query_one("#skill-mentions")
        except Exception:
            return None

    def _insert_mention(self, name: str):
        """Replace the current @token at the cursor with '@name '."""
        try:
            row, col = self.cursor_location
            row, col = int(row), int(col)
        except Exception:
            self.text = (self.text.rstrip() + " @" + name + " ")
            self.move_cursor(self.get_cursor_line_end_location())
            return
        lines = self.text.split("\n")
        row = max(0, min(row, len(lines) - 1))
        line = lines[row]
        col = min(col, len(line))
        start = line[:col].rfind(" ") + 1
        lines[row] = line[:start] + "@" + name + " " + line[col:]
        self.text = "\n".join(lines)
        self.move_cursor((row, start + len(name) + 2))

    def action_submit(self):
        # If the command palette is open, run the highlighted command now
        # (like a real command palette): no second Enter needed. Tab inserts
        # it with a trailing space instead, for commands that take args.
        palette = self._command_palette()
        if palette is not None and palette.is_open():
            chosen = palette.selected_command()
            palette.hide_commands()
            if chosen:
                self.text = ""
                self.post_message(InputBar.Submitted(chosen))
            return

        # If an @skill mention is highlighted, Enter inserts it at the cursor
        # instead of sending the message.
        mentions = self._mentions()
        if mentions is not None and mentions.is_open():
            chosen = mentions.selected_skill()
            mentions.hide()
            if chosen:
                self._insert_mention(chosen)
                return

        text = self.text.strip()
        images = getattr(self.parent, "attachments", None) or []
        if text or images:
            # Push to history if non-duplicate
            if text and (not self._prompt_history or self._prompt_history[-1] != text):
                self._prompt_history.append(text)
            # Reset history cursor
            self._history_idx = -1
            self._draft = ""
            self.post_message(InputBar.Submitted(text, images))
            self.text = ""

    def action_steer(self):
        """Ctrl+Enter / Ctrl+J: immediately interrupt/steer active agent or submit prompt."""
        text = self.text.strip()
        images = getattr(self.parent, "attachments", None) or []
        if text or images:
            if text and (not self._prompt_history or self._prompt_history[-1] != text):
                self._prompt_history.append(text)
            self._history_idx = -1
            self._draft = ""
            self.post_message(InputBar.Submitted(text, images, steer=True))
            self.text = ""

    def action_paste_image_or_text(self):
        try:
            from andromity.core.images import paste_image_from_clipboard
            img = paste_image_from_clipboard()
        except Exception:
            img = None
        if img is not None:
            self._just_attached_image = True
            self.post_message(InputBar.ImagePasted(image=img))
            return

    async def _on_paste(self, event):
        event.prevent_default()
        event.stop()

        if getattr(self, "_just_attached_image", False):
            self._just_attached_image = False
            return

        from andromity.core.images import extract_image_path, paste_image_from_clipboard
        path = extract_image_path(getattr(event, "text", ""))
        if path is not None:
            self.post_message(InputBar.ImagePasted(path=path))
            return

        if not getattr(event, "text", ""):
            try:
                img = paste_image_from_clipboard()
            except Exception:
                img = None
            if img is not None:
                self.post_message(InputBar.ImagePasted(image=img))
                return

        if self.read_only:
            return
        if result := self._replace_via_keyboard(event.text, *self.selection):
            self.move_cursor(result.end_location)
            self.focus()

    def on_click(self, event) -> None:
        """Ctrl+Click to select all text."""
        if event.control:
            self.select_all()
            event.prevent_default()
            event.stop()

    def action_newline(self):
        self.insert("\n")

    def on_key(self, event) -> None:
        """Handle Up/Down arrow keys for prompt history when input is empty or single-line.
        While the command palette or @skill mention panel is open, arrows/Esc control it."""
        palette = self._command_palette()
        if palette is not None and palette.is_open():
            if event.key in ("up", "down"):
                palette.cursor_move(event.key)
                event.prevent_default()
                event.stop()
                return
            if event.key == "tab":
                # Insert the command + space so the user can type arguments
                chosen = palette.selected_command()
                if chosen:
                    self.text = chosen + " "
                    self.move_cursor(self.get_cursor_line_end_location())
                palette.hide_commands()
                event.prevent_default()
                event.stop()
                return
            if event.key == "escape":
                palette.hide_commands()
                event.prevent_default()
                event.stop()
                return
        mentions = self._mentions()
        if mentions is not None and mentions.is_open():
            if event.key in ("up", "down"):
                mentions.cursor_move(event.key)
                event.prevent_default()
                event.stop()
                return
            if event.key == "tab":
                chosen = mentions.selected_skill()
                if chosen:
                    self._insert_mention(chosen)
                mentions.hide()
                event.prevent_default()
                event.stop()
                return
            if event.key == "escape":
                mentions.hide()
                event.prevent_default()
                event.stop()
                return
        if event.key == "up":
            lines = self.text.split("\n")
            # Navigate history only when empty or cursor is on the first line
            cursor_row = self.cursor_location[0] if self.cursor_location else 0
            if cursor_row == 0 and self._prompt_history:
                if self._history_idx == -1:
                    self._draft = self.text  # cache current draft
                    self._history_idx = len(self._prompt_history) - 1
                elif self._history_idx > 0:
                    self._history_idx -= 1
                self.text = self._prompt_history[self._history_idx]
                self.move_cursor(self.get_cursor_line_end_location())
                event.prevent_default()
                event.stop()
        elif event.key == "down":
            cursor_row = self.cursor_location[0] if self.cursor_location else 0
            lines = self.text.split("\n")
            if cursor_row == len(lines) - 1 and self._history_idx != -1:
                self._history_idx += 1
                if self._history_idx >= len(self._prompt_history):
                    self._history_idx = -1
                    self.text = self._draft
                else:
                    self.text = self._prompt_history[self._history_idx]
                self.move_cursor(self.get_cursor_line_end_location())
                event.prevent_default()
                event.stop()


class QueuePanel(Widget):
    """Area above input bar showing queued messages with delete buttons."""
    DEFAULT_CSS = """\
QueuePanel {
    height: auto;
    display: none;
    padding: 0 1;
    background: $surface-darken-1;
    border-top: solid $panel-lighten-2;
}
QueuePanel.has-items { display: block; }
#queue-list { height: auto; max-height: 5; }
.queue-item { height: 1; align: left middle; }
.queue-item Static { width: 1fr; height: 1; }
.queue-del-btn, .queue-item Button {
    width: auto !important;
    min-width: 0 !important;
    height: 1 !important;
    min-height: 1 !important;
    border: none !important;
    padding: 0 1 !important;
    margin: 0 !important;
    background: transparent !important;
    color: $text-muted !important;
    text-style: bold;
}
.queue-del-btn:hover, .queue-item Button:hover {
    background: $error 30% !important;
    color: $error-lighten-2 !important;
}
.queue-del-btn:focus, .queue-item Button:focus {
    background: $error 40% !important;
    color: $text !important;
    border: none !important;
}
"""
    def compose(self) -> ComposeResult:
        yield VerticalScroll(id="queue-list")

    def update_queue(self, items: list[str]):
        try:
            container = self.query_one("#queue-list", VerticalScroll)
            container.remove_children()
            if not items:
                self.remove_class("has-items")
                return
            for i, item in enumerate(items):
                short = item if len(item) <= 50 else item[:47] + "..."
                row = Horizontal(
                    Static(f"[yellow]#{i+1}[/] [dim]{escape(short)}[/]"),
                    Button("✕", id=f"q-del-{i}", classes="queue-del-btn"),
                    classes="queue-item",
                )
                container.mount(row)
            self.add_class("has-items")
        except Exception as e:
            log.warning("QueuePanel.update_queue error: %s", e)

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id and event.button.id.startswith("q-del-"):
            try:
                idx = int(event.button.id.split("-")[-1])
                self.app._remove_from_queue(idx)
            except Exception:
                pass

class CronStatusPanel(Widget):
    """Sidebar panel showing active cron jobs and recent status notifications."""
    DEFAULT_CSS = """\
CronStatusPanel {
    height: auto; max-height: 15;
    padding: 1 1;
    border-top: solid $panel-lighten-2;
    display: none;
}
CronStatusPanel.has-crons { display: block; }
#cron-status-title { height: 1; text-style: bold; margin-bottom: 1; }
#cron-jobs-list { height: auto; max-height: 8; overflow-y: auto; }
#cron-notifs { height: auto; margin-top: 1; color: $text-muted; }
"""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._jobs = []
        self._notifs = []

    def compose(self) -> ComposeResult:
        yield Static("⏱  Cron Status", id="cron-status-title")
        yield Static("", id="cron-jobs-list")
        yield Static("", id="cron-notifs")

    def refresh_jobs(self, jobs: list):
        self._jobs = jobs
        if not jobs:
            self.remove_class("has-crons")
        else:
            self.add_class("has-crons")
        
        try:
            list_el = self.query_one("#cron-jobs-list", Static)
            lines = []
            for j in jobs:
                status_icon = {"never": "○", "success": "✓", "failed": "✗"}.get(j.last_status, "○")
                color = {"never": "dim", "success": "green", "failed": "red"}.get(j.last_status, "dim")
                enabled_c = "white" if j.enabled else "dim"
                next_run = j.next_run_in() if j.enabled else "off"
                lines.append(f"[{color}]{status_icon}[/] [{enabled_c}]{escape(j.name)}[/] [dim]({next_run})[/]")
            safe_update(list_el, "\n".join(lines))
        except Exception as e:
            log.warning("CronStatusPanel error: %s", e)

    def push_notification(self, msg: str):
        self._notifs.append(msg)
        if len(self._notifs) > 5:
            self._notifs.pop(0)
        try:
            notifs_el = self.query_one("#cron-notifs", Static)
            lines = []
            for n in self._notifs:
                lines.append(f"• {n}")
            safe_update(notifs_el, "\n".join(lines))
        except Exception:
            pass



class AttachmentBar(Widget):
    """Horizontal strip of pasted-image chips shown above the chat input.

    Each chip is a small label + a ✕ button. Chips are re-rendered wholesale
    on any change (add/remove), so the button ids always map to the current
    list order.
    """
    DEFAULT_CSS = """\
AttachmentBar {
    height: auto;
    display: none;
    padding: 0;
}
AttachmentBar.has-items { display: block; }
#attach-row { height: auto; }
.attach-chip { width: auto; height: 1; margin: 0 1 0 0; background: $surface-darken-1; }
.attach-chip Static { width: auto; height: 1; padding: 0 0 0 1; }
.attach-chip Button {
    width: auto !important;
    min-width: 0 !important;
    height: 1 !important;
    min-height: 1 !important;
    border: none !important;
    background: transparent !important;
    padding: 0 1 !important;
    margin: 0 !important;
    color: $text-muted !important;
}
.attach-chip Button:hover { color: $error !important; text-style: bold; }
"""

    def compose(self) -> ComposeResult:
        yield Horizontal(id="attach-row")

    def update_attachments(self, items: list[str]):
        """Rebuild the chip row. `items` are ready-to-render labels; the ✕
        button for index i carries id `att-del-<i>`."""
        row = self.query_one("#attach-row", Horizontal)
        row.remove_children()
        if not items:
            self.remove_class("has-items")
            return
        for i, label in enumerate(items):
            chip = Horizontal(
                Static(label),
                Button("✕", id=f"att-del-{i}"),
                classes="attach-chip",
            )
            row.mount(chip)
        self.add_class("has-items")

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id and event.button.id.startswith("att-del-"):
            try:
                idx = int(event.button.id.split("-")[-1])
            except ValueError:
                return
            event.stop()
            self.post_message(AttachmentBar.RemoveRequested(idx))

    class RemoveRequested(Message):
        def __init__(self, index: int):
            super().__init__()
            self.index = index


class InputBar(Widget):
    """Input bar that lives inside the center panel."""
    DEFAULT_CSS = """\
InputBar {
    height: auto; min-height: 4; max-height: 15; dock: bottom;
    padding: 0 1;
}
#input-field {
    width: 1fr;
    height: auto;
    min-height: 3;
    max-height: 14;
    border: none;
    background: $surface;
}
"""
    _PLACEHOLDER = "Ask Andromity… (Enter to send, / for commands, @ for skills)"
 
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._attachments: list = []

    def compose(self) -> ComposeResult:
        yield AttachmentBar(id="attachment-bar")
        # Pass placeholder natively to Textual's TextArea
        yield ChatInput(id="input-field", placeholder=self._PLACEHOLDER)

    def on_click(self, event):
        # Focus input if clicking anywhere in the bar
        self.app.focus_input()

    @property
    def attachments(self) -> list:
        """PIL Images currently attached (a copy, so callers can't mutate)."""
        return list(self._attachments)

    def clear_input(self):
        ta = self.query_one("#input-field", ChatInput)
        ta.text = ""
        self._attachments.clear()
        self._update_attachment_bar()

    def _update_attachment_bar(self):
        try:
            bar = self.query_one("#attachment-bar", AttachmentBar)
            bar.update_attachments(
                [image_label(img, i) for i, img in enumerate(self._attachments, 1)]
            )
        except Exception:
            pass

    # Handler names follow Textual's convention for messages defined inside a
    # widget: InputBar.Submitted → on_input_bar_submitted (camel_to_snake),
    # and the message bubbles up from ChatInput through this widget.
    def on_input_bar_image_pasted(self, event: "InputBar.ImagePasted"):
        if event.path is not None:
            self.attach_path(event.path)
        elif event.image is not None:
            self._add_attachment(event.image)

    def _add_attachment(self, img):
        """Append an image, enforcing the 5-image cap, and refresh the chips."""
        if len(self._attachments) >= MAX_IMAGES:
            self.app.notify(f"Maximum {MAX_IMAGES} images per message", severity="warning")
            return
        self._attachments.append(img)
        self._update_attachment_bar()
        self.app.focus_input()
        self.app.notify(
            f"Image {len(self._attachments)} of {MAX_IMAGES} attached"
            if len(self._attachments) == MAX_IMAGES
            else f"Image {len(self._attachments)} attached"
        )

    def attach_path(self, path) -> bool:
        """Attach an image file from disk (used by /attach and pasted paths).
        Returns True on success; notifies on failure."""
        try:
            from andromity.core.images import load_image_file
            img = load_image_file(path)
        except Exception as e:
            self.app.notify(f"Not a readable image: {path}", severity="error")
            return False
        self._add_attachment(img)
        return True

    def on_input_bar_submitted(self, event: "InputBar.Submitted"):
        # The send consumed the attachments — clear the chip strip.
        self._attachments.clear()
        self._update_attachment_bar()

    def on_attachment_bar_remove_requested(self, event: AttachmentBar.RemoveRequested):
        if 0 <= event.index < len(self._attachments):
            self._attachments.pop(event.index)
            self._update_attachment_bar()
            self.app.focus_input()

    class ImagePasted(Message):
        def __init__(self, image=None, path=None):
            super().__init__()
            self.image = image
            self.path = path

    class Submitted(Message):
        def __init__(self, text: str, images: list | None = None, steer: bool = False):
            super().__init__()
            self.text = text
            self.images = list(images) if images else None
            self.steer = steer
