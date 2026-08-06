import asyncio
from pathlib import Path
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual import on
from textual.widgets import Input, Static, Tree
from textual.containers import Horizontal, Vertical

from andromity.tui.panels.chat import ChatPanel
from andromity.tui.panels.filetree import FileTreePanel
from andromity.tui.panels.diff import DiffPanel
from andromity.tui.footer import StatusBar, InputBar, ContextPanel
from andromity.tui.overlays.model import ModelPickerOverlay
from andromity.tui.overlays.profile import ProfilePickerOverlay
from andromity.tui.overlays.trust import TrustPromptOverlay
from andromity.tui.overlays.session import SessionBrowserOverlay
from andromity.core.session import Session
from andromity.core.agent import Agent
from andromity.core.events import TextDelta, ThinkingDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done
from andromity.core.models import get_context_limit_for_model
from andromity.core.debug_log import get_logger, LOG_PATH
from andromity.config import config

log = get_logger("app")

COMMANDS = ["/help", "/model", "/profile", "/keys", "/sessions", "/new", "/rename", "/trust", "/untrust", "/dry-run", "/debug", "/logs", "/clear"]

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
#model-overlay.visible { display: block; }
#profile-overlay { display: none; }
#profile-overlay.visible { display: block; }
#trust-overlay { display: none; }
#trust-overlay.visible { display: block; }
#session-overlay { display: none; }
#session-overlay.visible { display: block; }
"""


class AndromityApp(App):
    CSS = CSS
    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit", show=True),
        Binding("tab", "focus_next", "Next", show=False),
        Binding("shift+tab", "focus_prev", "Prev", show=False),
        Binding("ctrl+b", "toggle_filetree", "Files", show=True),
        Binding("ctrl+d", "toggle_diff", "Diff", show=True),
        Binding("ctrl+m", "toggle_model", "Model", show=True),
        Binding("ctrl+j", "toggle_profile", "Profile", show=True),
        Binding("ctrl+s", "toggle_sessions", "Sessions", show=True),
        Binding("escape", "escape_pressed", show=False),
    ]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._project_path = str(Path.cwd())
        self.session = Session(name="new-session", project_path=self._project_path)
        self.agent = Agent(self.session, on_tool_approval=self._on_tool_approval)
        self._esc_count = 0
        self._esc_time = 0.0
        self._esc_timer = None
        self._current_task = None
        self._session_named = False
        self._debug_mode = False  # when True, show tool calls inline in chat
        log.info("=== Andromity started | project=%s ===", self._project_path)

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
        yield ProfilePickerOverlay(id="profile-overlay")
        yield TrustPromptOverlay(self._project_path, id="trust-overlay")
        yield SessionBrowserOverlay(
            self.session.id, self._project_path, id="session-overlay"
        )

    def on_mount(self):
        self.query_one(InputBar).query_one("#input-field").focus()
        self._update_status()
        # Check trust FIRST before showing welcome
        if not config.is_trusted(self._project_path):
            self.query_one("#trust-overlay").add_class("visible")
        else:
            self._show_welcome()

    def _show_welcome(self):
        chat = self.query_one(ChatPanel)
        model = config.get("default", "model", "")
        provider = config.get("default", "provider", "")

        # No-model warning banner
        if not model:
            chat.add_system_message(
                "[yellow]⚠ No model selected.[/] Use [bold cyan]/model[/] or [bold]Ctrl+M[/] to pick a provider and model first."
            )
            # Auto-open model picker
            self.call_after_refresh(lambda: self.action_toggle_model())
        else:
            sess_name = escape(self.session.name) if self.session.name != "new-session" else "New Session"
            chat.add_system_message(
                f"Welcome to Andromity! Session: [bold]{sess_name}[/]\nProvider: [bold]{provider}[/] | Model: [bold cyan]{model}[/]\n\n"
                "Quick start:\n"
                "  Type any message below to start chatting\n"
                "  /help     Show all commands\n"
                "  /model    Switch provider & model (Ctrl+M)\n"
                "  /keys     Check or set your API keys\n"
                "  /profile  Switch builder/reviewer/planner (Ctrl+J)\n\n"
                "Set an API key:   /keys set anthropic sk-ant-...\n"
                "Or use Ollama:    /model then select ollama"
            )

        if not config.get_api_key("anthropic") and not config.get_api_key("openai") and \
                not config.get_api_key("google") and not config.get_api_key("openrouter"):
            if model and provider not in ("ollama",):
                chat.add_system_message(
                    "⚠ No cloud API key configured. Use [bold cyan]/keys set <provider> <key>[/] or set environment variables."
                )

    def _update_status(self, live_tokens: int | None = None):
        model = config.get("default", "model", "")
        provider = config.get("default", "provider", "")
        display = f"{provider}/{model}" if provider and model else model
        ctx_limit = get_context_limit_for_model(provider, model) if (provider and model) else 0
        ctx = self.query_one(ContextPanel)
        
        display_tokens = live_tokens if live_tokens is not None else self.session.token_total
        is_estimated = live_tokens is not None
        
        ctx.update_context(
            tokens=display_tokens,
            cost=self.session.cost_usd,
            profile=self.agent.profile,
            model=display,
            ctx_limit=ctx_limit,
            estimated=is_estimated
        )
        self.query_one(StatusBar).update_status(
            tokens=display_tokens,
            cost=self.session.cost_usd,
            profile=self.agent.profile,
            model=display,
            ctx_limit=ctx_limit,
            estimated=is_estimated
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
        chat.add_system_message(f"Provider: [bold]{provider}[/] | Model: [bold cyan]{model}[/]")

    def _apply_profile(self, profile: str):
        """Apply a new profile from the profile picker."""
        self.agent = Agent(self.session, profile=profile, on_tool_approval=self._on_tool_approval)
        self._update_status()
        chat = self.query_one(ChatPanel)
        chat.add_system_message(f"Profile: {profile}")

    def _on_trust_resolved(self, trusted: bool):
        """Called after the trust prompt is answered."""
        chat = self.query_one(ChatPanel)
        if trusted:
            chat.add_system_message(f"[green]✓ Folder trusted.[/] Full access enabled.")
        else:
            chat.add_system_message(
                "[yellow]Read-only mode.[/] File writes and shell commands are blocked.\n"
                "Use [bold cyan]/trust[/] to enable full access."
            )
        self._show_welcome()

    def _new_session(self):
        """Start a fresh session, preserving the old one in storage."""
        self.session = Session(name="new-session", project_path=self._project_path)
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval)
        self._session_named = False
        chat = self.query_one(ChatPanel)
        chat.clear()
        chat.add_system_message("[green]New session started.[/] Previous session saved.")
        self._update_status()
        # Refresh session browser overlay
        try:
            sb = self.query_one("#session-overlay", SessionBrowserOverlay)
            sb._current_id = self.session.id
            sb._project_path = self._project_path
        except Exception:
            pass

    def _load_session(self, session: Session):
        """Switch to a historical session and replay its chat history."""
        self.session = session
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval)
        self._session_named = True  # already named
        chat = self.query_one(ChatPanel)
        chat.load_history(session.messages)
        self._update_status()
        chat.add_system_message(
            f"[green]Session loaded:[/] [bold]{session.name}[/]  "
            f"[dim]({len(session.messages)} messages, {session.token_total:,} tokens)[/]"
        )

    def _show_suggestions(self, text: str):
        suggestions = self.query_one("#suggestions")
        if text.startswith("/"):
            matches = [c for c in COMMANDS if c.startswith(text)]
            if matches:
                suggestions.update("  ".join(matches))
                suggestions.add_class("visible")
                return
        suggestions.remove_class("visible")

    def action_escape_pressed(self):
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
        status_bar = self.query_one(StatusBar)
        chat.start_assistant_message()
        status_bar.set_streaming(True)
        self._current_task = asyncio.current_task()
        log.info("USER: %s", prompt[:200])
        estimated_tokens = 0
        delta_count = 0
        first_text_seen = False
        try:
            async for event in self.agent.run(prompt):
                if isinstance(event, ThinkingDelta):
                    if not hasattr(chat, "_thinking") or not getattr(chat, "_thinking", None):
                        chat.start_thinking_message()
                    chat.append_thinking(event.text)
                    estimated_tokens += len(event.text) // 4
                elif isinstance(event, TextDelta):
                    if not first_text_seen:
                        first_text_seen = True
                        chat.stop_thinking_message()
                    chat.append_text(event.text)
                    estimated_tokens += len(event.text) // 4
                elif isinstance(event, ToolCallStart):
                    log.debug("TOOL START: %s", event.tool_name)
                    if self._debug_mode:
                        chat.add_system_message(f"[dim]▶ tool: {event.tool_name}[/]")
                    chat.show_tool_start(event.tool_name)
                elif isinstance(event, ToolCallDelta):
                    chat.append_tool_args(event.args_json_chunk)
                elif isinstance(event, ToolCallEnd):
                    log.debug("TOOL END: %s", event.tool_id)
                    chat.show_tool_end()
                elif isinstance(event, Done):
                    log.info("DONE usage=%s", event.usage)
                    if event.usage and event.usage.get("total_tokens"):
                        self._update_status()
                        estimated_tokens = 0 # reset
                
                # Live token update
                delta_count += 1
                if delta_count % 10 == 0 and estimated_tokens > 0 and not isinstance(event, Done):
                    self._update_status(live_tokens=self.session.token_total + estimated_tokens)

        except asyncio.CancelledError:
            log.info("Stream cancelled by user")
        except Exception as e:
            log.error("Unhandled exception in _stream_agent: %s", e, exc_info=True)
            chat.append_text(f"\n[Unexpected error: {type(e).__name__}] {e}\n")
        finally:
            self._current_task = None
            status_bar.set_streaming(False)
            chat.stop_thinking_message()
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
            # Guard: no model configured
            model = config.get("default", "model", "")
            if not model:
                chat.add_system_message(
                    "[red]No model selected.[/] Please choose a provider and model first:\n"
                    "  [bold cyan]/model[/] or [bold]Ctrl+M[/]"
                )
                return
            # Auto-name session from the first user message
            if not self._session_named:
                self._session_named = True
                name = Session.auto_name_from_message(prompt)
                self.session.rename(name)
                self._update_status()
            self.run_worker(self._stream_agent(prompt), exclusive=True)

    @on(Input.Changed, "#input-field")
    def on_input_changed(self, event: Input.Changed):
        self._show_suggestions(event.value)

    @on(Tree.NodeSelected, "#file-tree")
    def on_file_tree_selected(self, event: Tree.NodeSelected):
        if event.node.data:
            path = Path(event.node.data)
            if path.is_file():
                diff_panel = self.query_one(DiffPanel)
                diff_panel.show_file(path)
                self.query_one("#right-panel").add_class("visible")


    def _handle_command(self, cmd: str):
        parts = cmd.split(maxsplit=1)
        command = parts[0].lower()
        chat = self.query_one(ChatPanel)

        if command == "/model":
            overlay = self.query_one("#model-overlay")
            overlay.add_class("visible")
        elif command == "/profile":
            if len(parts) > 1 and parts[1].strip():
                # Direct profile name provided
                profile = parts[1].strip().lower()
                if profile in ("builder", "reviewer", "planner"):
                    self._apply_profile(profile)
                else:
                    chat.add_system_message(f"Unknown profile: {profile}. Use builder, reviewer, or planner.")
            else:
                # Open profile picker overlay
                overlay = self.query_one("#profile-overlay")
                overlay.add_class("visible")
        elif command == "/keys":
            if len(parts) > 1 and parts[1].strip():
                subparts = parts[1].strip().split(maxsplit=2)
                subcmd = subparts[0].lower()
                if subcmd == "set" and len(subparts) == 3:
                    provider_name = subparts[1].lower()
                    key_val = subparts[2].strip()
                    config.set_api_key(provider_name, key_val)
                    masked = key_val[:6] + "..." + key_val[-4:] if len(key_val) > 10 else "***"
                    chat.add_system_message(f"✓ API key for [bold]{provider_name}[/] saved to config: {masked}")
                    return
                else:
                    chat.add_system_message("Usage: /keys set <provider> <api_key>\nExample: /keys set anthropic sk-ant-...")
                    return

            # Display all keys status
            from andromity.core.models import MODEL_CATALOG
            lines = ["[bold]API Key Status:[/]\n"]
            for pkey, pinfo in MODEL_CATALOG.items():
                pname = pinfo["name"]
                req = pinfo.get("requires_env")
                if not req:
                    lines.append(f"  [green]✓[/] {pname:<24} [dim]Local / No key needed[/]")
                else:
                    key = config.get_api_key(pkey)
                    if key:
                        masked = key[:5] + "..." + key[-3:] if len(key) > 8 else "***"
                        lines.append(f"  [green]✓[/] {pname:<24} [green]Configured[/] [dim]({masked})[/]")
                    else:
                        lines.append(f"  [red]✗[/] {pname:<24} [red]Not set[/] [dim]({req})[/]")
            lines.append("\n[dim]To set a key: /keys set <provider> <key>[/]")
            chat.add_system_message("\n".join(lines))
        elif command == "/sessions":
            sb = self.query_one("#session-overlay", SessionBrowserOverlay)
            sb._current_id = self.session.id
            sb._project_path = self._project_path
            sb._load_sessions()
            sb.add_class("visible")
        elif command == "/new":
            self._new_session()
        elif command == "/rename":
            if len(parts) > 1 and parts[1].strip():
                new_name = parts[1].strip()
                self.session.rename(new_name)
                self._session_named = True
                self._update_status()
                chat.add_system_message(f"[green]Session renamed:[/] {new_name}")
            else:
                chat.add_system_message("Usage: /rename <new name>")
        elif command == "/trust":
            config.set_trusted(self._project_path)
            chat.add_system_message(f"[green]✓ Folder trusted:[/] {self._project_path}\nFull file access and shell commands are now enabled.")
        elif command == "/untrust":
            config.revoke_trust(self._project_path)
            chat.add_system_message(f"[yellow]Folder untrusted:[/] {self._project_path}\nFile writes and shell commands are now blocked.")
        elif command == "/clear":
            chat.clear()
        elif command == "/help":
            chat.add_system_message(
                "Commands:\n"
                "  /model                   Switch provider & model (Ctrl+M)\n"
                "  /profile [name]          Switch profile (builder/reviewer/planner, Ctrl+J)\n"
                "  /sessions                Browse & switch sessions (Ctrl+S)\n"
                "  /new                     Start a new session\n"
                "  /rename <name>           Rename current session\n"
                "  /keys                    View status of all provider API keys\n"
                "  /keys set <prov> <key>   Save API key to universal config\n"
                "  /trust                   Trust this folder (enable file writes + shell)\n"
                "  /untrust                 Remove trust for this folder\n"
                "  /dry-run                 Toggle dry-run mode (simulate tools, no writes)\n"
                "  /debug                   Toggle debug mode (show tool calls inline + log path)\n"
                "  /logs                    Show last 30 lines of the debug log\n"
                "  /clear                   Clear chat history\n"
                "  /help                    Show this help\n\n"
                "Shortcuts:\n"
                "  Ctrl+B     Toggle file tree\n"
                "  Ctrl+D     Toggle diff panel\n"
                "  Ctrl+M     Model picker\n"
                "  Ctrl+J     Profile picker\n"
                "  Ctrl+S     Session browser\n"
                "  Escape x2  Cancel current response\n\n"
                f"[dim]Log: {LOG_PATH}[/]"
            )
        elif command == "/dry-run":
            self.agent.dry_run = not self.agent.dry_run
            state = "ON" if self.agent.dry_run else "OFF"
            log.info("Dry-run toggled: %s", state)
            chat.add_system_message(
                f"Dry-run: [bold]{state}[/]\n"
                f"[dim]When ON, tools are simulated — no files are written, no shell commands run.[/]"
            )
        elif command == "/debug":
            self._debug_mode = not self._debug_mode
            state = "ON" if self._debug_mode else "OFF"
            color = "green" if self._debug_mode else "yellow"
            log.info("Debug mode toggled: %s", state)
            chat.add_system_message(
                f"Debug mode: [{color} bold]{state}[/{color} bold]\n"
                f"[dim]Log file: {LOG_PATH}[/dim]\n"
                f"[dim]Tail it live: Get-Content -Wait '{LOG_PATH}'[/dim]"
            )
        elif command == "/logs":
            chat.add_system_message(
                f"Log file location: [bold]{LOG_PATH}[/]\n\n"
                f"To monitor logs live, open a new PowerShell window and run:\n"
                f"[bold cyan]Get-Content -Wait '{LOG_PATH}'[/]"
            )
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

    def action_toggle_profile(self):
        overlay = self.query_one("#profile-overlay")
        if overlay.has_class("visible"):
            overlay.remove_class("visible")
        else:
            overlay.add_class("visible")

    def action_toggle_sessions(self):
        sb = self.query_one("#session-overlay", SessionBrowserOverlay)
        if sb.has_class("visible"):
            sb.remove_class("visible")
        else:
            sb._current_id = self.session.id
            sb._project_path = self._project_path
            sb._load_sessions()
            sb.add_class("visible")

    def action_close_overlays(self):
        for overlay in self.query(".visible"):
            overlay.remove_class("visible")
        self.query_one(InputBar).query_one("#input-field").focus()
