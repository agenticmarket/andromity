"""Slash-command palette — a compact dropdown above the input bar.

Shown while the user types `/...`; filters commands live as they type and
supports ↑/↓ to move the highlight, Enter to insert the highlighted command
(so the user can continue typing arguments), and Esc to dismiss.
"""
from rich.text import Text
from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import OptionList, Static
from textual.widgets.option_list import Option

class PaletteOptionList(OptionList):
    """Option list that never takes focus — keyboard control stays in the input,
    so Enter always runs the highlighted command and clicks can't strand focus."""
    can_focus = False


COMMAND_DESCRIPTIONS = {
    "/help":     "Show all commands & shortcuts",
    "/model":    "Switch provider & model (Ctrl+L)",
    "/profile":  "Switch profile — builder / reviewer / planner (Ctrl+J)",
    "/reason":   "Set reasoning effort — off / low / medium / high / max",
    "/mode":     "Set permission mode — safe / trust / full / yolo",
    "/undo":     "Undo last prompt & revert all file changes",
    "/keys":     "View status of all provider API keys",
    "/attach":   "Attach an image file (path) to the next message",
    "/settings": "Open master settings panel",
    "/sessions": "Browse & switch sessions (Ctrl+O)",
    "/export":  "Export this chat to Markdown / HTML / JSON",
    "/new":      "Start a new session",
    "/compact":  "Summarize & compress old context (frees tokens)",
    "/rename":   "Rename current session",
    "/trust":    "Trust this folder (enable file writes + shell)",
    "/untrust":  "Remove trust for this folder",
    "/dry-run":  "Toggle dry-run (simulate tools, no writes)",
    "/debug":    "Toggle debug mode (tool calls inline + log path)",
    "/logs":     "Show log file location",
    "/clear":    "Clear chat history",
    "/cron":     "Manage scheduled cron jobs",
    "/skills":   "Browse & install skills (one-click)",
    "/plan":     "Show or clear the active plan",
    "/mcp":      "Show MCP server status & available tools",
    "/tips":     "Get a curated developer & coding tip",
    "/news":     "Show latest release notes & announcements",
    "/context-menu": "Toggle 'Open in Andromity' in Windows context menu",
}


class CommandPalette(Widget):
    """Dropdown list of slash commands with one-line descriptions."""

    DEFAULT_CSS = """\
CommandPalette {
    display: none;
    height: auto; max-height: 14;
    border-top: solid $accent-darken-2;
    background: $surface-darken-1;
}
CommandPalette.visible { display: block; }
#cp-list {
    height: auto; max-height: 12;
    border: none !important; background: transparent !important;
    padding: 0 1;
}
#cp-list > .option-list--option { padding: 0 1; }
#cp-hint { height: 1; padding: 0 1; color: $text-muted; }
"""

    def compose(self) -> ComposeResult:
        yield PaletteOptionList(id="cp-list")
        yield Static("", id="cp-hint")

    def on_option_list_option_selected(self, event: OptionList.OptionSelected):
        """A mouse click on a command runs it — same as highlight + Enter."""
        opt = getattr(event, "option", None)
        cmd = str(opt.id) if opt is not None and opt.id else ""
        if not cmd or cmd == "cp-none":
            return
        self.hide_commands()
        try:
            inp = self.app.query_one("#input-field")
            inp.text = ""
        except Exception:
            pass
        try:
            self.app._process_message(cmd)
        except Exception:
            pass
        try:
            self.app.focus_input()
        except Exception:
            pass

    def show_commands(self, query: str = ""):
        """Populate and show the palette, filtered by the typed prefix."""
        ol = self.query_one("#cp-list", OptionList)
        ol.clear_options()
        q = query.strip().lower()
        matches = [
            (cmd, desc)
            for cmd, desc in COMMAND_DESCRIPTIONS.items()
            if cmd.startswith("/" + q)
        ]
        if not matches:
            ol.add_option(Option(Text("[dim]No matching commands[/dim]"), id="cp-none", disabled=True))
            ol.highlighted = None
        else:
            for cmd, desc in matches:
                ol.add_option(Option(
                    Text.assemble(
                        Text(cmd, style="bold"),
                        Text("  "),
                        Text(desc, style="dim"),
                    ),
                    id=cmd,
                ))
            ol.highlighted = 0
        try:
            hint = self.query_one("#cp-hint", Static)
            if matches:
                hint.update(f"[dim]{len(matches)} command(s) · click or Enter run · Tab insert · Esc close[/dim]")
            else:
                hint.update("[dim]No commands match — Esc to close[/dim]")
        except Exception:
            pass
        self.add_class("visible")

    def hide_commands(self):
        self.remove_class("visible")

    def is_open(self) -> bool:
        return self.has_class("visible")

    def cursor_move(self, direction: str):
        """Move the highlight up/down (called from the input's key handler)."""
        if not self.is_open():
            return
        ol = self.query_one("#cp-list", OptionList)
        if direction == "up":
            ol.action_cursor_up()
        else:
            ol.action_cursor_down()
        try:
            ol.scroll_to_highlight()
        except Exception:
            pass

    def selected_command(self) -> str | None:
        """Return the highlighted command, or None if nothing is selectable."""
        if not self.is_open():
            return None
        ol = self.query_one("#cp-list", OptionList)
        opt = ol.highlighted_option
        if opt is not None and opt.id and opt.id != "cp-none":
            return str(opt.id)
        return None
