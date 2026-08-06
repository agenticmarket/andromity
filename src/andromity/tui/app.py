import asyncio
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual import on
from textual.widgets import Input, Static
from textual.containers import Horizontal, Vertical

from andromity.tui.panels.chat import ChatPanel
from andromity.tui.panels.filetree import FileTreePanel
from andromity.tui.panels.diff import DiffPanel
from andromity.tui.footer import StatusBar, InputBar, ContextPanel
from andromity.tui.overlays.model import ModelPickerOverlay
from andromity.core.session import Session
from andromity.core.agent import Agent
from andromity.core.events import TextDelta, ToolCallStart, ToolCallEnd, Done
from andromity.config import config

COMMANDS = ["/help", "/model", "/profile", "/dry-run", "/clear"]

CSS = """\
Screen { background: $surface; }
#main-layout { height: 1fr; }
#left-panel {
    width: 24; min-width: 16; max-width: 35;
    border-right: solid $accent-darken-2; overflow-y: auto;
}
#center-panel { width: 1fr; }
#right-panel { width: 0; min-width: 0; }
#right-panel.visible { width: 50%; min-width: 30; border-left: solid $accent; }
#context-panel {
    width: 22; min-width: 18;
    border-left: solid $accent-darken-2;
    overflow-y: auto;
}
ChatPanel { height: 1fr; overflow-y: auto; padding: 1 2; }
FileTreePanel { height: 1fr; overflow-y: auto; padding: 1; }
DiffPanel { height: 1fr; overflow-y: auto; padding: 1 2; }
#suggestions { display: none; }
#suggestions.visible { display: block; padding: 0 2; }
#model-overlay { display: none; }
#model-overlay.visible { display: block; width: 50; height: 25; border: solid $accent-darken-2; background: $surface; layer: overlay; }
"""


class AndromityApp(App):
    CSS = CSS
    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit", show=True),
        Binding("ctrl+p", "command_palette", "Commands", show=True),
        Binding("tab", "focus_next", "Next", show=False),
        Binding("shift+tab", "focus_prev", "Prev", show=False),
        Binding("ctrl+f", "toggle_filetree", "Files", show=True),
        Binding("ctrl+d", "toggle_diff", "Diff", show=True),
        Binding("ctrl+m", "toggle_model", "Model", show=True),
        Binding("escape", "escape_pressed", show=False),
    ]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.session = Session(name="tui-session")
        self.agent = Agent(self.session, on_tool_approval=self._on_tool_approval)
        self._esc_count = 0
        self._esc_timer = None
        self._current_task = None

    def compose(self) -> ComposeResult:
        yield Horizontal(
            FileTreePanel(id="left-panel"),
            Vertical(
                ChatPanel(id="chat"),
                Static("", id="suggestions"),
                InputBar(id="input-bar"),
                StatusBar(id="status-bar"),
                id="center-panel",
            ),
            DiffPanel(id="right-panel"),
            ContextPanel(id="context-panel"),
            id="main-layout",
        )
        yield ModelPickerOverlay(id="model-overlay")

    def on_mount(self):
        self.query_one(InputBar).query_one("#input-field").focus()
        self._update_status()
        self._show_welcome()

    def _show_welcome(self):
        chat = self.query_one(ChatPanel)
        chat.add_system_message(
            "Welcome to Andromity! I'm your AI coding assistant.\n\n"
            "Quick start:\n"
            "  Type any message below to start chatting\n"
            "  /help     Show all commands\n"
            "  /model    Switch provider & model\n"
            "  /profile  Switch builder/reviewer/planner\n\n"
            "Set your API key:  set ANTHROPIC_API_KEY=sk-ant-...\n"
            "Or use Ollama:     /model then select ollama"
        )

    def _update_status(self):
        model = config.get("default", "model", "claude-sonnet-4-20240514")
        provider = config.get("default", "provider", "anthropic")
        ctx = self.query_one(ContextPanel)
        ctx.update_context(
            tokens=self.session.token_total,
            cost=self.session.cost_usd,
            profile=self.agent.profile,
            model=f"{provider}/{model}",
        )
        self.query_one(StatusBar).update_status(
            tokens=self.session.token_total,
            cost=self.session.cost_usd,
            profile=self.agent.profile,
            model=f"{provider}/{model}",
        )

    def _on_tool_approval(self, tool_name: str, args: dict) -> bool:
        if tool_name in ("write_file", "edit_file"):
            diff_panel = self.query_one(DiffPanel)
            diff_panel.show_tool(tool_name, args)
            self.query_one("#right-panel").add_class("visible")
        return True

    def _refresh_agent(self):
        """Refresh agent with current config (after model/provider change)."""
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval)
        self._update_status()
        chat = self.query_one(ChatPanel)
        model = config.get("default", "model", "")
        provider = config.get("default", "provider", "")
        chat.add_system_message(f"Model: {provider}/{model}")

    def _show_suggestions(self, text: str):
        suggestions = self.query_one("#suggestions")
        if text.startswith("/"):
            matches = [c for c in COMMANDS if c.startswith(text)]
            if matches:
                suggestions.update("  ".join(matches))
                suggestions.add_class("visible")
                return
        suggestions.remove_class("visible")

    def escape_pressed(self):
        import time
        now = time.time()
        if self._esc_count > 0 and (now - self._esc_time) > 1.0:
            self._esc_count = 0
        self._esc_count += 1
        self._esc_time = now
        if self._esc_count >= 2:
            self._esc_count = 0
            if self._current_task and not self._current_task.done():
                self._current_task.cancel()
                self.query_one(ChatPanel).add_system_message("[Cancelled]")
                self.query_one(InputBar).clear_input()
                self.query_one(InputBar).query_one("#input-field").focus()
            return

    async def _stream_agent(self, prompt: str):
        chat = self.query_one(ChatPanel)
        chat.start_assistant_message()
        self._current_task = asyncio.current_task()
        try:
            async for event in self.agent.run(prompt):
                if isinstance(event, TextDelta):
                    chat.append_text(event.text)
                elif isinstance(event, ToolCallStart):
                    chat.show_tool_start(event.tool_name)
                elif isinstance(event, ToolCallEnd):
                    chat.show_tool_end()
        except asyncio.CancelledError:
            pass
        finally:
            self._current_task = None
            chat.end_assistant_message()
            self._update_status()
            self.query_one(InputBar).query_one("#input-field").focus()

    @on(InputBar.Submitted)
    def on_input_submitted(self, event: InputBar.Submitted):
        prompt = event.text.strip()
        if not prompt:
            return
        self._esc_count = 0
        self.query_one("#suggestions").remove_class("visible")
        chat = self.query_one(ChatPanel)
        chat.add_user_message(prompt)
        if prompt.startswith("/"):
            self._handle_command(prompt)
        else:
            self._stream_agent(prompt)

    @on(Input.Changed, "#input-field")
    def on_input_changed(self, event: Input.Changed):
        self._show_suggestions(event.value)

    def _handle_command(self, cmd: str):
        parts = cmd.split(maxsplit=1)
        command = parts[0].lower()
        chat = self.query_one(ChatPanel)

        if command == "/model":
            overlay = self.query_one("#model-overlay")
            overlay.add_class("visible")
        elif command == "/clear":
            chat.clear()
        elif command == "/help":
            chat.add_system_message(
                "Commands:\n"
                "  /model              Switch provider & model\n"
                "  /profile [name]     Switch profile (builder/reviewer/planner)\n"
                "  /dry-run            Toggle dry-run mode\n"
                "  /clear              Clear chat history\n"
                "  /help               Show this help\n\n"
                "Shortcuts:\n"
                "  Ctrl+F  Toggle file tree\n"
                "  Ctrl+D  Toggle diff panel\n"
                "  Ctrl+M  Model picker\n"
                "  Ctrl+P  Command palette\n"
                "  Escape x2  Stop response"
            )
        elif command == "/profile":
            profile = parts[1].strip() if len(parts) > 1 else "builder"
            self.agent = Agent(self.session, profile=profile)
            chat.add_system_message(f"Profile: {profile}")
            self._update_status()
        elif command == "/dry-run":
            self.agent.dry_run = not self.agent.dry_run
            state = "ON" if self.agent.dry_run else "OFF"
            chat.add_system_message(f"Dry-run: {state}")
        else:
            chat.add_system_message(f"Unknown: {command}. Type /help")

    def action_toggle_filetree(self):
        left = self.query_one("#left-panel")
        left.display = not left.display

    def action_toggle_diff(self):
        right = self.query_one("#right-panel")
        if right.has_class("visible"):
            right.remove_class("visible")
        else:
            right.add_class("visible")

    def action_toggle_model(self):
        overlay = self.query_one("#model-overlay")
        if overlay.has_class("visible"):
            overlay.remove_class("visible")
        else:
            overlay.add_class("visible")

    def action_close_overlays(self):
        for overlay in self.query(".visible"):
            overlay.remove_class("visible")
        self.query_one(InputBar).query_one("#input-field").focus()
