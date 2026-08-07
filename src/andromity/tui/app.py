import asyncio
from pathlib import Path
from rich.markup import escape
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual import on
from textual.widgets import Input, Static, Tree, TextArea
from textual.containers import Horizontal, Vertical

from andromity.tui.panels.chat import ChatPanel
from andromity.tui.panels.filetree import FileTreePanel
from andromity.tui.panels.diff import DiffPanel
from andromity.tui.panels.plan import PlanPanel
from andromity.tui.footer import StatusBar, InputBar, ContextPanel, AppFooter
from andromity.tui.overlays.model import ModelPickerOverlay
from andromity.tui.overlays.profile import ProfilePickerOverlay
from andromity.tui.overlays.trust import TrustPromptOverlay
from andromity.tui.overlays.session import SessionBrowserOverlay
from andromity.tui.overlays.cron import CronManagerOverlay
from andromity.core.session import Session
from andromity.core.agent import Agent
from andromity.core.events import TextDelta, ThinkingDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done, ToolResult
from andromity.core.models import get_context_limit_for_model
from andromity.core.debug_log import get_logger, LOG_PATH
from andromity.core.cron import CronScheduler, CronJob
from andromity.core.tools import register_plan_callback
from andromity.config import config

log = get_logger("app")

COMMANDS = ["/help", "/mode", "/model", "/profile", "/keys", "/sessions", "/new", "/rename", "/trust", "/untrust", "/dry-run", "/debug", "/logs", "/clear", "/cron", "/plan"]

CSS = """\
Screen { background: $surface; }
#main-layout { height: 1fr; }
#left-panel {
    width: 24; min-width: 16; max-width: 35;
    border-right: solid $accent-darken-2; overflow-y: auto;
}
#left-panel.force-hidden { display: none; }
#left-panel.force-show { display: block; }
#center-panel { width: 1fr; }
#diff-panel {
    display: none;
    width: 60;
    height: 1fr;
    border-left: solid $accent-darken-2;
}
#diff-panel.visible { display: block; }
#right-sidebar {
    width: 45; height: 1fr;
    border-left: solid $accent-darken-2;
}
#context-panel {
    height: auto;
    padding: 1 1;
}
ChatPanel { height: 1fr; overflow-y: auto; padding: 1 2; }
FileTreePanel { height: 1fr; overflow-y: auto; padding: 1; }
PlanPanel { height: 1fr; border-top: solid $accent-darken-2; }
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
#cron-overlay { display: none; }
#cron-overlay.visible { display: block; }

.narrow #context-panel { display: none; }
.narrow #left-panel { display: none; }
.narrow #left-panel.force-show {
    display: block;
    dock: left;
    width: 35;
    height: 100%;
    background: $surface;
    border-right: solid $accent-darken-2;
}
.narrow #right-panel { width: 0; min-width: 0; border-left: none; }
"""


class AndromityApp(App):
    CSS = CSS
    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit", show=True),
        Binding("tab", "focus_next", "Next", show=False),
        Binding("shift+tab", "focus_prev", "Prev", show=False),
        Binding("ctrl+b", "toggle_filetree", "Files", show=True),
        Binding("ctrl+d", "toggle_diff", "Viewer", show=True),
        Binding("ctrl+m", "toggle_model", "Model", show=True),
        Binding("ctrl+j", "toggle_profile", "Profile", show=True),
        Binding("ctrl+o", "toggle_sessions", "Sessions", show=True),
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
        self._debug_mode = False
        self._is_streaming = False
        self._prompt_queue = []
        self._pending_model_change = False
        self._pending_mode_change = False
        self._plan_approval_future: asyncio.Future | None = None
        self._cron_scheduler = CronScheduler(self._project_path, on_trigger=self._on_cron_trigger)
        # Register plan callback so PlanPanel updates when agent writes a plan
        register_plan_callback(self._on_plan_written)
        log.info("=== Andromity started | project=%s ===", self._project_path)

    def compose(self) -> ComposeResult:
        yield Horizontal(
            FileTreePanel(id="left-panel"),
            Vertical(
                ChatPanel(id="chat"),
                StatusBar(id="status-bar"),
                Static("", id="suggestions"),
                InputBar(id="input-bar"),
                id="center-panel",
            ),
            DiffPanel(id="diff-panel"),
            Vertical(
                ContextPanel(id="context-panel"),
                PlanPanel(self._project_path, id="plan-panel"),
                id="right-sidebar",
            ),
            id="main-layout",
        )
        yield AppFooter(id="app-footer")
        yield ModelPickerOverlay(id="model-overlay")
        yield ProfilePickerOverlay(id="profile-overlay")
        yield TrustPromptOverlay(self._project_path, id="trust-overlay")
        yield SessionBrowserOverlay(
            self.session.id, self._project_path, id="session-overlay"
        )
        yield CronManagerOverlay(
            self._cron_scheduler, self._project_path, id="cron-overlay"
        )

    def on_resize(self, event):
        if event.size.width <= 100:
            self.add_class("narrow")
        else:
            self.remove_class("narrow")

    def on_mount(self):
        self.focus_input()
        self._update_status()
        # Start cron scheduler
        self._cron_scheduler.start()
        # Load any existing plan
        from andromity.core.planner import Plan
        existing_plan = Plan.load(self._project_path)
        if existing_plan:
            self.query_one(PlanPanel).load_plan(existing_plan)
        # Check trust FIRST before showing welcome
        if not config.is_trusted(self._project_path):
            self.query_one("#trust-overlay").add_class("visible")
        else:
            self._show_welcome()

    def focus_input(self):
        """Force focus back to the main chat input field."""
        try:
            self.query_one("InputBar").query_one("#input-field").focus()
        except Exception:
            pass

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
        
        display_tokens = live_tokens if live_tokens is not None else self.session.token_total
        is_estimated = live_tokens is not None
        
        try:
            ctx = self.query_one(ContextPanel)
            ctx.update_context(
                tokens=display_tokens,
                cost=self.session.cost_usd,
                profile=self.agent.profile,
                model=display,
                ctx_limit=ctx_limit,
                estimated=is_estimated,
                session_name=self.session.name
            )
        except Exception:
            pass

        self.query_one(StatusBar).update_status(
            tokens=display_tokens,
            cost=self.session.cost_usd,
            profile=self.agent.profile,
            model=display,
            ctx_limit=ctx_limit,
            estimated=is_estimated,
            session_name=self.session.name,
            permission_mode=config.get("default", "permission_mode", "safe")
        )
        self.query_one(AppFooter).update_footer(cwd=self._project_path)

    async def _on_tool_approval(self, tool_name: str, args: dict) -> bool:
        if not config.is_trusted(self._project_path):
            if tool_name in ("write_file", "edit_file", "shell_exec"):
                chat = self.query_one(ChatPanel)
                chat.add_system_message(f"[red]✗ Blocked '{tool_name}'[/] — Folder is untrusted. Use [bold cyan]/trust[/] to enable.")
                return False

        mode = config.get("default", "permission_mode", "safe")
        if mode == "yolo":
            return True
            
        sensitive_patterns = [".env", ".ssh", ".git", "config.toml", "secret", "password"]
        target_path = str(args.get("path", "")).lower()
        is_sensitive = any(p in target_path for p in sensitive_patterns) if target_path else False
        
        needs_approval = False
        
        if tool_name in ("write_file", "edit_file"):
            if mode == "safe" or is_sensitive:
                needs_approval = True
        elif tool_name == "shell_exec":
            command = str(args.get("command", "")).strip()
            if mode == "safe":
                needs_approval = True
            elif mode == "trust":
                allowed = config.get("default", "allowed_commands", [])
                if not allowed:
                    needs_approval = True
                elif not any(command.startswith(prefix) for prefix in allowed):
                    needs_approval = True
        elif tool_name == "read_file":
            if is_sensitive:
                needs_approval = True
                
        if needs_approval:
            diff_panel = self.query_one("#diff-overlay", DiffPanel)
            diff_panel.show_tool(tool_name, args)
            self.query_one("#diff-overlay").add_class("visible")
            
            # Wait for user decision from the DiffPanel buttons
            self._tool_approval_future = asyncio.Future()
            result = await self._tool_approval_future
            self._tool_approval_future = None
            return result
            
        return True

    # ── Plan callbacks ────────────────────────────────────────────────────────

    def _on_plan_written(self, plan):
        """Called by tools.py when agent writes a plan. Runs in agent thread — schedule on UI thread."""
        if plan:
            self.call_from_thread(self._load_plan_in_ui, plan)

    def _load_plan_in_ui(self, plan):
        try:
            self.query_one(PlanPanel).load_plan(plan)
            chat = self.query_one(ChatPanel)
            chat.add_system_message(
                f"📋 [bold]Plan ready:[/] [cyan]{escape(plan.title)}[/] ({len(plan.steps)} steps)\n"
                "[dim]Review the plan in the right panel → Approve or Reject[/]"
            )
        except Exception:
            pass

    def _on_plan_approved(self, plan):
        """Called when user clicks Approve in PlanPanel."""
        chat = self.query_one(ChatPanel)
        chat.add_system_message(f"[green]✓ Plan approved.[/] Agent may now proceed.")
        # Unblock the agent if it's waiting for plan approval
        if self._plan_approval_future and not self._plan_approval_future.done():
            self._plan_approval_future.set_result(True)

    def _on_plan_rejected(self, plan, feedback: str):
        """Called when user clicks Reject + submits feedback in PlanPanel."""
        chat = self.query_one(ChatPanel)
        msg = f"[red]✗ Plan rejected.[/]"
        if feedback:
            msg += f" Reason: {escape(feedback)}"
            # Feed rejection back to agent as a new message
            self._process_message(f"The plan was rejected. Reason: {feedback}. Please revise the plan.")
        else:
            self._process_message("The plan was rejected. Please revise the plan and try again.")
        chat.add_system_message(msg)

    # ── Cron callbacks ────────────────────────────────────────────────────────

    def _on_cron_trigger(self, cron: CronJob):
        """Called from scheduler loop (async task). Must be thread-safe."""
        self.call_from_thread(self._run_cron_job, cron)

    def _run_cron_job(self, cron: CronJob):
        """Schedule cron agent run on the UI thread."""
        chat = self.query_one(ChatPanel)
        chat.add_system_message(
            f"⏱ [yellow bold]Cron:[/] [bold]{escape(cron.name)}[/] is firing…"
        )
        # Temporarily switch to cron's model/provider if different
        current_provider = config.get("default", "provider", "")
        current_model = config.get("default", "model", "")
        is_different = (cron.provider != current_provider or cron.model != current_model)

        if is_different:
            config.set("default", "provider", cron.provider)
            config.set("default", "model", cron.model)

        # Create a temporary agent with cron's permission mode
        cron_agent = Agent(
            self.session,
            profile=self.agent.profile,
            on_tool_approval=self._make_cron_approval(cron),
        )

        async def _run():
            try:
                # stream the cron prompt
                async for _ in cron_agent.run(cron.prompt):
                    pass
                self._cron_scheduler.mark_result(cron.id, success=True)
                chat.add_system_message(f"[green]✓ Cron '{escape(cron.name)}' completed.[/]")
            except Exception as e:
                self._cron_scheduler.mark_result(cron.id, success=False, error=str(e))
                chat.add_system_message(
                    f"[red]✗ Cron '{escape(cron.name)}' failed:[/] {escape(str(e))}\n"
                    f"[dim]Use /cron to view details or disable.[/]"
                )
            finally:
                if is_different:
                    config.set("default", "provider", current_provider)
                    config.set("default", "model", current_model)

        self.run_worker(_run(), exclusive=False)

    def _make_cron_approval(self, cron: CronJob):
        """Return an approval callback respecting the cron's own mode and allowlist."""
        async def _approval(tool_name: str, args: dict) -> bool:
            if cron.mode == "yolo":
                return True
            if tool_name == "shell_exec":
                command = str(args.get("command", "")).strip()
                if cron.allowed_commands and any(command.startswith(p) for p in cron.allowed_commands):
                    return True
                # Block unapproved commands — notify but don't prompt
                chat = self.query_one(ChatPanel)
                chat.add_system_message(
                    f"[yellow]⏱ Cron '{escape(cron.name)}':[/] blocked '{escape(tool_name)}' (not in allowlist)"
                )
                return False
            if tool_name in ("write_file", "edit_file") and cron.mode == "safe":
                chat = self.query_one(ChatPanel)
                chat.add_system_message(
                    f"[yellow]⏱ Cron '{escape(cron.name)}':[/] blocked '{escape(tool_name)}' (safe mode)"
                )
                return False
            return True
        return _approval

    def _refresh_agent(self):
        """Refresh agent with current config (after model/provider change)."""
        if self._is_streaming:
            self._pending_model_change = True
            chat = self.query_one(ChatPanel)
            chat.add_system_message("⚡ [yellow]Model change pending...[/] (Will apply after current response)")
            return
            
        self._apply_model_change()
        
    def _apply_model_change(self):
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
        status_bar.set_streaming(True)
        self._is_streaming = True
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
                        chat.start_assistant_message()
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
                elif isinstance(event, ToolResult):
                    log.debug("TOOL RESULT: %s", event.tool_id)
                    chat.show_tool_result(event.tool_id, event.result)
                elif isinstance(event, Done):
                    log.info("DONE usage=%s", event.usage)
                    self._update_status()
                    estimated_tokens = 0
                
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
            self._is_streaming = False
            status_bar.set_streaming(False)
            chat.stop_thinking_message()
            chat.end_assistant_message()
            self._update_status()
            
            # If the agent wrote or updated a plan, refresh the panel
            try:
                self.query_one(PlanPanel).refresh_plan()
            except Exception:
                pass
            
            if self._pending_model_change:
                self._pending_model_change = False
                self._apply_model_change()
            
            if self._pending_mode_change:
                self._pending_mode_change = False
                self._apply_mode_change()
                
            if self._prompt_queue:
                next_prompt = self._prompt_queue.pop(0)
                remaining = len(self._prompt_queue)
                # Clear the queue badge for this message before processing
                try:
                    self.query_one(ChatPanel).clear_queue_badge(next_prompt)
                except Exception:
                    pass
                # Process next queued message slightly after UI updates
                self.call_after_refresh(lambda p=next_prompt: self._process_message(p))
            else:
                self.focus_input()

    @on(InputBar.Submitted)
    def on_input_submitted(self, event: InputBar.Submitted):
        prompt = event.text.strip()
        if not prompt:
            return
        self._esc_count = 0
        self.query_one("#suggestions").remove_class("visible")
        
        # Guard: no model configured
        model = config.get("default", "model", "")
        if not model:
            chat = self.query_one(ChatPanel)
            chat.add_system_message(
                "[red]No model selected.[/] Please choose a provider and model first:\n"
                "  [bold cyan]/model[/] or [bold]Ctrl+M[/]"
            )
            return

        if prompt.startswith("/"):
            self._process_message(prompt)
            return

        if self._is_streaming:
            self._prompt_queue.append(prompt)
            chat = self.query_one(ChatPanel)
            # Show a distinct queue badge — NOT a system message that looks like a response
            qlen = len(self._prompt_queue)
            chat.add_queued_message(prompt, qlen)
            return
            
        self._process_message(prompt)

    def _process_message(self, prompt: str):
        chat = self.query_one(ChatPanel)
        chat.add_user_message(prompt)
        if prompt.startswith("/"):
            self._handle_command(prompt)
        else:
            # Auto-name session from the first user message
            if not self._session_named:
                self._session_named = True
                name = Session.auto_name_from_message(prompt)
                self.session.rename(name)
                self._update_status()
                asyncio.create_task(self._generate_ai_session_name(prompt))
            self.run_worker(self._stream_agent(prompt), exclusive=False)

    @on(TextArea.Changed, "#input-field")
    def on_input_changed(self, event: TextArea.Changed):
        self._show_suggestions(event.text_area.text)

    @on(Tree.NodeSelected, "#file-tree")
    def on_file_tree_selected(self, event: Tree.NodeSelected):
        if event.node.data:
            path = Path(event.node.data)
            if path.is_file():
                diff_panel = self.query_one("#diff-panel", DiffPanel)
                diff_panel.load_file(str(path))
                diff_panel.add_class("visible")


    def _apply_mode_change(self):
        mode = config.get("default", "permission_mode", "safe")
        self._update_status()
        chat = self.query_one(ChatPanel)
        chat.add_system_message(f"Permission mode set to [bold]{mode.upper()}[/]")

    async def _generate_ai_session_name(self, prompt: str):
        try:
            import litellm
            
            provider = config.get("default", "provider", "")
            model = config.get("default", "model", "")
            if not provider or not model:
                return
                
            provider_cfg = config.get_provider_config(provider)
            base_url = None
            api_key = config.get_api_key(provider)
            
            if provider == "ollama":
                litellm_model = f"ollama_chat/{model}" if not (model.startswith("ollama/") or model.startswith("ollama_chat/")) else model
                base_url = (provider_cfg.get("base_url") if provider_cfg else None) or "http://localhost:11434"
            elif provider == "google":
                litellm_model = f"gemini/{model}" if not model.startswith("gemini/") else model
            elif provider == "openrouter":
                litellm_model = f"openrouter/{model}" if not model.startswith("openrouter/") else model
            elif provider == "nvidia":
                litellm_model = f"nvidia_nim/{model}" if not model.startswith("nvidia_nim/") else model
            else:
                litellm_model = f"{provider}/{model}" if not model.startswith(f"{provider}/") else model
                base_url = provider_cfg.get("base_url") if provider_cfg else None

            kwargs = {"model": litellm_model, "stream": False}
            if api_key:
                kwargs["api_key"] = api_key
            if base_url:
                kwargs["api_base"] = base_url
                
            messages = [
                {"role": "system", "content": "You are a helpful assistant. Generate a very short (3-5 words) descriptive title for a conversation starting with the following message. Output ONLY the title, no quotes or prefixes."},
                {"role": "user", "content": prompt}
            ]
            kwargs["messages"] = messages
            
            response = await litellm.acompletion(**kwargs)
            if response.choices:
                name = response.choices[0].message.content.strip().strip('"').strip("'")
                if name:
                    self.session.rename(name)
                    self._update_status()
        except Exception as e:
            log.warning("Failed to generate AI session name: %s", e)

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
        elif command == "/mode":
            if len(parts) > 1:
                subparts = parts[1].strip().split()
                mode = subparts[0].lower()
                
                if mode == "trust" and len(subparts) > 1:
                    subcmd = subparts[1].lower()
                    if subcmd == "add" and len(subparts) > 2:
                        prefix = " ".join(subparts[2:])
                        allowed = config.get("default", "allowed_commands", [])
                        if prefix not in allowed:
                            allowed.append(prefix)
                            config.set("default", "allowed_commands", allowed)
                        chat.add_system_message(f"Added [bold]'{prefix}'[/] to trust allowlist.")
                    elif subcmd == "list":
                        allowed = config.get("default", "allowed_commands", [])
                        if allowed:
                            chat.add_system_message("Trusted prefixes:\n  - " + "\n  - ".join(allowed))
                        else:
                            chat.add_system_message("Trust allowlist is empty.")
                    elif subcmd == "clear":
                        config.set("default", "allowed_commands", [])
                        chat.add_system_message("Trust allowlist cleared.")
                    else:
                        chat.add_system_message("Usage: /mode trust [add <prefix> | list | clear]")
                    return

                if mode in ("safe", "trust", "yolo"):
                    config.set("default", "permission_mode", mode)
                    if self._is_streaming:
                        self._pending_mode_change = True
                        chat.add_system_message(f"⚡ [yellow]Mode change to {mode.upper()} pending...[/] (Will apply after current response)")
                    else:
                        self._apply_mode_change()
                else:
                    chat.add_system_message("Unknown mode. Use: safe, trust, or yolo")
            else:
                chat.add_system_message("Usage: /mode <safe|trust|yolo>")
        elif command == "/help":
            chat.add_system_message(
                "Commands:\n"
                "  /model                   Switch provider & model (Ctrl+M)\n"
                "  /profile [name]          Switch profile (builder/reviewer/planner, Ctrl+J)\n"
                "  /mode [safe|trust|yolo]  Set permission mode for file/shell approvals\n"
                "  /sessions                Browse & switch sessions (Ctrl+O)\n"
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
                "  Ctrl+O     Session browser\n"
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
        elif command == "/cron":
            overlay = self.query_one("#cron-overlay", CronManagerOverlay)
            overlay.add_class("visible")
        elif command.startswith("/plan"):
            parts = cmd.split()
            if len(parts) > 1 and parts[1].strip().lower() == "clear":
                from andromity.core.planner import Plan
                Plan.clear(self._project_path)
                panel = self.query_one(PlanPanel)
                panel._plan = None
                panel.refresh_plan()
                chat.add_system_message("[green]✓ Active plan cleared and removed.[/]")
            else:
                from andromity.core.planner import Plan
                plan = Plan.load(self._project_path)
                if plan:
                    self.query_one(PlanPanel).load_plan(plan)
                    chat.add_system_message(f"[cyan]Plan reloaded:[/] {escape(plan.title)}")
                else:
                    chat.add_system_message("[dim]No plan file found in this project.[/]")
        else:
            chat.add_system_message(f"Unknown: {command}. Type /help")

    def action_toggle_filetree(self):
        left = self.query_one("#left-panel")
        if self.size.width <= 100:
            left.remove_class("force-hidden")
            if left.has_class("force-show"):
                left.remove_class("force-show")
            else:
                left.add_class("force-show")
        else:
            left.remove_class("force-show")
            if left.has_class("force-hidden"):
                left.remove_class("force-hidden")
            else:
                left.add_class("force-hidden")

    def action_toggle_diff(self):
        """Ctrl+D — show/hide the file viewer/diff panel."""
        diff = self.query_one("#diff-panel")
        if diff.has_class("visible"):
            diff.remove_class("visible")
        else:
            diff.add_class("visible")

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
