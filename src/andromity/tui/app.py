import asyncio
from pathlib import Path
from rich.markup import escape
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual import on
from textual.widgets import Input, Static, Tree, TextArea, Header , Footer, Button
from textual.containers import Horizontal, Vertical

from andromity.tui.panels.chat import ChatPanel
from andromity.tui.panels.filetree import FileTreePanel
from andromity.tui.panels.diff import DiffPanel
from andromity.tui.panels.plan import PlanPanel
from andromity.tui.footer import StatusBar, InputBar, ContextPanel, AppFooter, QueuePanel, CronStatusPanel
from andromity.tui.overlays.model import ModelPickerOverlay
from andromity.tui.overlays.profile import ProfilePickerOverlay
from andromity.tui.overlays.trust import TrustPromptOverlay
from andromity.tui.overlays.session import SessionBrowserOverlay
from andromity.tui.overlays.cron import CronManagerOverlay
from andromity.tui.overlays.undo import UndoConfirmOverlay
from andromity.tui.overlays.settings import SettingsScreen
from andromity.tui.overlays.batch_review import BatchReviewOverlay
from andromity.core.session import Session
from andromity.core.agent import Agent
from andromity.core.events import (
    StreamEvent, TextDelta, ThinkingDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done, ToolResult, PlanApprovalRequired
)
from andromity.core.models import get_context_limit_for_model
from andromity.core.debug_log import get_logger, LOG_PATH
from andromity.core.cron import CronScheduler, CronJob
from andromity.core.tools import register_plan_callback, register_todo_callback, register_mcp_manager
from andromity.core.mcp import MCPClientManager
from andromity.config import config

log = get_logger("app")

COMMANDS = ["/help", "/mode", "/model", "/profile","/undo", "/keys", "/settings", "/sessions", "/new", "/rename", "/trust", "/untrust", "/dry-run", "/debug", "/logs", "/clear", "/cron", "/plan", "/mcp", "/compact"]

CSS = """\
Screen { background: $surface; }
#main-layout { height: 1fr; }
#left-panel {
    width: 34; min-width: 16; max-width: 35;
    border-right: solid $accent-darken-2; overflow-y: auto;
}
.hide-files #left-panel { display: none; }
.hide-context #right-sidebar { display: none; }
#left-panel.force-hidden { display: none; }
#left-panel.force-show { display: block; }
#right-sidebar.force-hidden { display: none; }
#right-sidebar.force-show { display: block !important; }
#center-panel { width: 1fr; }
#diff-panel {
    display: none;
    width: 1fr;
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
ChatPanel Markdown { padding: 0; margin: 0; }
ChatPanel MarkdownParagraph { margin: 0 0 1 0; }
ChatPanel MarkdownListItem { margin: 0; padding: 0; }
ChatPanel MarkdownListItem > Vertical { height: auto; margin: 0; padding: 0; }
ChatPanel MarkdownListItem MarkdownParagraph { margin: 0; padding: 0; }
ChatPanel MarkdownBulletList { margin: 0 0 1 1; padding: 0; }
ChatPanel MarkdownOrderedList { margin: 0 0 1 1; padding: 0; }
ChatPanel MarkdownHeader { margin: 1 0 0 0; }
ChatPanel MarkdownH1, ChatPanel MarkdownH2, ChatPanel MarkdownH3, ChatPanel MarkdownH4, ChatPanel MarkdownH5, ChatPanel MarkdownH6 { margin: 0; padding: 0; }
ChatPanel MarkdownHorizontalRule { margin: 0; padding: 0; border: none; border-top: solid $accent-darken-2; }
FileTreePanel { height: 1fr; overflow-y: auto; padding: 1; }
PlanPanel { height: 1fr; border-top: solid $accent-darken-2; }
#suggestions { display: none; }
#suggestions.visible { display: block; padding: 0 2; }
#model-overlay { display: none; }
#model-overlay.visible { display: block; }

/* Scrollable file tabs */
#viewer-tabs > TabBar { overflow-x: auto; overflow-y: hidden; }
#viewer-tabs > TabBar Tab { min-width: 12; max-width: 28; }

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
    TITLE = "Andromity"
    CSS = CSS
    BINDINGS = [
        Binding("tab", "focus_next", "Next", show=False),
        Binding("shift+tab", "focus_prev", "Prev", show=False),
        Binding("ctrl+b", "toggle_filetree", "Files", show=True),
        Binding("ctrl+r", "toggle_right_panel", "Context", show=True),
        Binding("ctrl+d", "toggle_diff", "Viewer", show=True),
        Binding("ctrl+l", "toggle_model", "Model", show=True),
        Binding("ctrl+j", "toggle_profile", "Profile", show=True),
        Binding("ctrl+o", "toggle_sessions", "Sessions", show=True),
        Binding("ctrl+e", "toggle_settings", "Settings", show=True),
        Binding("escape", "escape_pressed", show=False),
    ]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._project_path = str(Path.cwd())
        self.session = Session(name="new-session", project_path=self._project_path)
        self._ollama_num_ctx = 0
        self.agent = Agent(self.session, on_tool_approval=self._on_tool_approval, ctx_limit=self._get_ctx_limit())
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
        self._yolo_session = False
        if config.get("default", "permission_mode") == "yolo":
            config.set("default", "permission_mode", "safe")
        self._plan_approval_future: asyncio.Future | None = None
        self._cron_scheduler = CronScheduler(self._project_path, on_trigger=self._on_cron_trigger)
        self._mcp_manager = MCPClientManager(self._project_path)
        register_mcp_manager(self._mcp_manager)
        # Register plan callback so PlanPanel updates when agent writes a plan
        register_plan_callback(self._on_plan_written)
        register_todo_callback(self._on_todo_changed)
        self._cron_running_jobs: set = set()  # tracks which cron job IDs are currently executing
        # Undo checkpoint stack — each entry: {snapshot_hash, msg_count, prompt}
        self._undo_stack: list[dict] = []
        self._pending_batch_files: set[Path] = set()
        self._pre_turn_snapshot: str | None = None
        log.info("=== Andromity started | project=%s ===", self._project_path)

    def _get_ctx_limit(self) -> int:
        """Return live context limit for current provider/model."""
        provider = config.get("default", "provider", "")
        model = config.get("default", "model", "")
        if provider == "ollama" and self._ollama_num_ctx > 0:
            return self._ollama_num_ctx
        from andromity.core.models import get_context_limit_for_model
        return get_context_limit_for_model(provider, model) if (provider and model) else 0

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True, name="Andromity")
        yield Horizontal(
            FileTreePanel(id="left-panel"),
            Vertical(
                ChatPanel(id="chat"),
                StatusBar(id="status-bar"),
                Static("", id="suggestions"),
                QueuePanel(id="queue-panel"),
                InputBar(id="input-bar"),
                id="center-panel",
            ),
            DiffPanel(id="diff-panel"),
            Vertical(
                ContextPanel(id="context-panel"),
                CronStatusPanel(id="cron-status"),
                PlanPanel(self._project_path, id="plan-panel"),
                id="right-sidebar",
            ),
            id="main-layout",
        )
        yield AppFooter(id="app-footer")

    def on_resize(self, event):
        if event.size.width <= 120:
            self.add_class("hide-context")
        else:
            self.remove_class("hide-context")
            
        if event.size.width <= 200:
            self.add_class("hide-files")
        else:
            self.remove_class("hide-files")

    def on_mount(self):
        try:
            from andromity.telemetry import send_session_start
            send_session_start()
        except Exception:
            pass
            
        self.focus_input()
        provider = config.get("default", "provider", "")
        model = config.get("default", "model", "")
        if provider == "ollama":
            from andromity.core.models import get_ollama_num_ctx
            self._ollama_num_ctx = get_ollama_num_ctx(model)
        self._update_status()
        # Delay heavy dependency pre-import (litellm) until 1s after the UI load
        # is fully mounted and rendered, and run it in a background thread
        # so the UI launch is instantaneous (0 lag).
        self.set_timer(1.0, self._start_background_warmup)
        # Start cron scheduler
        try:
            crons = self._cron_scheduler.list()
            if crons:
                chat = self.query_one(ChatPanel)
                chat.add_system_message(
                    f"[yellow]⚠ {len(crons)} scheduled cron job(s) found.[/] "
                    "These will run automatically at their configured intervals. "
                    "Type [bold cyan]/cron[/] to review or disable them.",
                    ephemeral=True
                )
            self._cron_scheduler.start()
            log.info("Cron scheduler started")
            self.refresh_cron_status()
        except Exception as e:
            log.error("Failed to start cron scheduler: %s", e)
        # Start MCP client manager — run in a background worker so the UI
        # stays responsive, then refresh the context panel + show a toast.
        async def _init_mcp():
            try:
                cfg = self._mcp_manager.load_config().get("mcpServers", {})
                for k in cfg.keys():
                    self._mcp_manager.server_status[k] = {"status": "initializing", "tools": 0, "error": None, "command": ""}
                self._update_status()
            except Exception:
                pass
                
            await self._mcp_manager.start_all()
            # Refresh context panel immediately — no need to wait for a message
            try:
                self._update_status()
            except Exception:
                pass
            n_srv = len(self._mcp_manager.sessions)
            n_tools = len(self._mcp_manager.get_all_tools())
            if n_srv:
                try:
                    chat = self.query_one(ChatPanel)
                    chat.add_system_message(
                        f"[green]✓ MCP:[/] {n_srv} server(s) ready "
                        f"({n_tools} tool(s) available)",
                        ephemeral=True,
                    )
                except Exception:
                    pass

        self.run_worker(_init_mcp(), exclusive=False, group="mcp-init")
        # Do NOT auto-load stale plan from disk — plans are session-scoped
        # Check trust FIRST before showing welcome
        if not config.is_trusted(self._project_path):
            def _on_trust(trusted: bool | None) -> None:
                self._on_trust_resolved(bool(trusted))
            self.push_screen(TrustPromptOverlay(self._project_path), _on_trust)
        else:
            self._show_welcome()

    def _start_background_warmup(self):
        """Pre-import litellm in an isolated worker thread so it never blocks the UI event loop."""
        def _import_job():
            try:
                import litellm  # noqa: F401
                from litellm import acompletion  # noqa: F401
                log.info("litellm warmed up in background thread")
            except Exception as e:
                log.warning("litellm background warm-up failed: %s", e)

        self.run_worker(_import_job, thread=True, exclusive=False, group="warmup")

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

        # Always show a welcome banner first
        chat.add_system_message(
            "[bold green]✦ Welcome to Andromity![/bold green]  "
            "Your AI coding assistant is ready.\n"
            "  [dim]Type a message and press [bold]Enter[/] to chat  ·  "
            "[bold cyan]/help[/] for commands  ·  "
            "[bold]Ctrl+L[/] to switch model  ·  "
            "[bold]Shift+Enter[/] for new line[/dim]",
            ephemeral=True
        )

        # No-model warning banner
        if not model:
            chat.add_system_message(
                "[yellow]⚠ No model selected.[/] Use [bold cyan]/model[/] or [bold]Ctrl+L[/] to pick a provider and model first.",
                ephemeral=True
            )
            self.call_after_refresh(lambda: self.action_toggle_model())

        if not config.get_api_key("anthropic") and not config.get_api_key("openai") and \
                not config.get_api_key("google") and not config.get_api_key("openrouter"):
            if model and provider not in ("ollama",):
                chat.add_system_message(
                    "[yellow]⚠ No cloud API key configured.[/] Use [bold cyan]/keys set <provider> <key>[/] or set environment variables.",
                    ephemeral=True
                )

    def _update_status(self, live_tokens: int | None = None):
        model = config.get("default", "model", "")
        provider = config.get("default", "provider", "")
        display = f"{provider}/{model}" if provider and model else model
        if provider == "ollama" and getattr(self, "_ollama_num_ctx", 0) > 0:
            ctx_limit = self._ollama_num_ctx
        else:
            ctx_limit = get_context_limit_for_model(provider, model) if (provider and model) else 0
        
        display_tokens = live_tokens if live_tokens is not None else self.session.token_total
        is_estimated = live_tokens is not None
        
        try:
            mcp_summary = self._mcp_manager.get_status_summary() if hasattr(self, "_mcp_manager") else None
            ctx = self.query_one(ContextPanel)
            ctx.update_context(
                tokens=display_tokens,
                cost=self.session.cost_usd,
                profile=self.agent.profile,
                model=display,
                ctx_limit=ctx_limit,
                estimated=is_estimated,
                session_name=self.session.name,
                mcp_summary=mcp_summary,
            )
        except Exception:
            pass

        active_mode = "yolo" if self._yolo_session else config.get("default", "permission_mode", "safe")
        self.query_one(StatusBar).update_status(
            tokens=display_tokens,
            cost=self.session.cost_usd,
            profile=self.agent.profile,
            model=display,
            ctx_limit=ctx_limit,
            estimated=is_estimated,
            session_name=self.session.name,
            permission_mode=active_mode
        )
        self.query_one(AppFooter).update_footer(cwd=self._project_path)

    def refresh_cron_status(self):
        try:
            panel = self.query_one(CronStatusPanel)
            panel.refresh_jobs(self._cron_scheduler.list())
        except Exception:
            pass

    async def _on_tool_approval(self, tool_name: str, args: dict) -> bool:
        if not config.is_trusted(self._project_path):
            if tool_name in ("write_file", "edit_file", "edit_file_multi", "delete_file", "shell_exec"):
                chat = self.query_one(ChatPanel)
                chat.add_system_message(f"[red]✗ Blocked '{tool_name}'[/] — Folder is untrusted. Use [bold cyan]/trust[/] to enable.")
                return False

        if self._yolo_session:
            return True

        mode = config.get("default", "permission_mode", "safe")
        
        sensitive_patterns = [".env", ".ssh", ".git", "config.toml", "secret", "password"]
        target_path = str(args.get("path", "")).lower()
        is_sensitive = any(p in target_path for p in sensitive_patterns) if target_path else False
        
        if tool_name in ("write_file", "edit_file", "edit_file_multi", "delete_file"):
            if mode != "yolo":
                path = args.get("path") or args.get("target_path") or args.get("target_file")
                if path:
                    self._pending_batch_files.add(Path(path).resolve())
            return True

        if mode in ("yolo", "full"):
            return True

        needs_approval = False
        if tool_name == "shell_exec":
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
        elif tool_name == "web_search":
            if mode == "safe":
                needs_approval = True
        elif tool_name == "fetch_url":
            if mode == "safe":
                needs_approval = True
            elif mode == "trust":
                from andromity.core.security import is_domain_allowed
                url = str(args.get("url", ""))
                allowed_domains = config.get("default", "allowed_domains", [])
                if not is_domain_allowed(url, allowed_domains):
                    needs_approval = True
        elif tool_name.startswith("mcp__"):
            if mode == "safe":
                needs_approval = True
            elif mode == "trust":
                lower_name = tool_name.lower()
                if any(m in lower_name for m in ("write", "insert", "update", "delete", "create", "drop", "push", "exec", "post")):
                    needs_approval = True
                
        if needs_approval:
            diff_panel = self.query_one("#diff-panel", DiffPanel)
            diff_panel.show_tool(tool_name, args)
            diff_panel.add_class("visible")
            
            # Wait for user decision from the DiffPanel buttons
            self._tool_approval_future = asyncio.Future()
            result = await self._tool_approval_future
            self._tool_approval_future = None
            return result
            
        return True

    def _resolve_tool_approval(self, approved: bool) -> None:
        """Called to resolve a pending tool approval (e.g. from UI buttons or panel closing)."""
        if getattr(self, "_tool_approval_future", None) and not self._tool_approval_future.done():
            self._tool_approval_future.set_result(approved)

    # ── Plan callbacks ────────────────────────────────────────────────────────

    def _on_plan_written(self, plan):
        """Called by tools.py on write_plan. Runs in agent thread."""
        if plan:
            self.call_from_thread(self._refresh_plan_in_ui, plan)

    def _refresh_plan_in_ui(self, plan):
        """Show plan in DiffPanel (file viewer) and todos in PlanPanel sidebar."""
        # Show plan card in the file viewer (#diff-panel is the CSS id)
        try:
            diff = self.query_one("#diff-panel", DiffPanel)
            diff.show_plan(plan)
            diff.add_class("visible")   # #diff-panel.visible { display: block }
        except Exception as e:
            log.warning("_refresh_plan_in_ui: diff panel error: %s", e)

        # Update right-sidebar todo tracker
        try:
            panel = self.query_one(PlanPanel)
            panel.load_plan(plan)
        except Exception:
            pass

        # Chat notification
        try:
            chat = self.query_one(ChatPanel)
            if plan.status == "pending":
                chat.add_system_message(
                    f"📋 [bold]Plan ready:[/] [cyan]{escape(plan.title)}[/]\n"
                    "[dim]Open Viewer (Ctrl+D) → optional comment → Approve or Reject[/]"
                )
        except Exception:
            pass

    def _on_todo_changed(self):
        """Called by tools.py when todos are created/updated. Runs in agent thread."""
        self.call_from_thread(self._refresh_todos_in_ui)

    def _refresh_todos_in_ui(self):
        try:
            panel = self.query_one(PlanPanel)
            panel.refresh_todos()
            from andromity.core.todo import TodoList
            todo_list = TodoList.load(self._project_path)
            done, total = todo_list.progress()
            self.query_one(StatusBar).update_todo_progress(done, total)
        except Exception:
            pass

    def _on_plan_approved(self, plan, comment: str = ""):
        """Called when user clicks Approve in DiffPanel."""
        plan.status = "approved"
        plan.save()
        chat = self.query_one(ChatPanel)
        suffix = f" Comment: {escape(comment)}" if comment else ""
        chat.add_system_message(f"✅ [green]Plan approved.[/]{suffix}")
        msg = "The plan has been approved by the user. Proceed with execution of the todos in order."
        if comment:
            msg += f" User note: {comment}"
            
        if getattr(self, "_plan_approval_future", None) and not self._plan_approval_future.done():
            self._send_to_agent(msg)
            self._plan_approval_future.set_result(True)
        else:
            self._send_to_agent(msg)

    def _on_plan_rejected(self, plan, feedback: str = ""):
        """Called when user clicks Reject in DiffPanel."""
        plan.status = "rejected"
        plan.save()
        chat = self.query_one(ChatPanel)
        suffix = f" Reason: {escape(feedback)}" if feedback else ""
        chat.add_system_message(f"❌ [red]Plan rejected.[/]{suffix}")
        msg = "The plan was rejected by the user. Please revise the plan and present a new one."
        if feedback:
            msg += f" User reason: {feedback}"
            
        if getattr(self, "_plan_approval_future", None) and not self._plan_approval_future.done():
            self._process_message(msg)
            self._plan_approval_future.set_result(False)
        else:
            self._process_message(msg)

    # ── Cron callbacks ────────────────────────────────────────────────────────

    def _on_cron_trigger(self, cron: CronJob):
        """Called from scheduler loop (async task)."""
        if cron.id in getattr(self, "_cron_running_jobs", set()):
            log.debug("Skipping cron trigger for '%s': already running", cron.name)
            return
        
        # Mark as running immediately so the next scheduler tick (in 10s) 
        # doesn't re-trigger it before the UI thread actually starts the worker.
        self._cron_running_jobs.add(cron.id)
        log.info("Cron trigger fired for '%s'", cron.name)
        self.call_later(self._run_cron_job, cron)

    def _run_cron_job(self, cron: CronJob):
        """Schedule cron agent run on the UI thread."""
        cron_panel = self.query_one(CronStatusPanel)
        cron_panel.push_notification(
            f"⏱ [yellow bold]Cron:[/] [bold]{escape(cron.name)}[/] is firing…"
        )
        # Temporarily switch to cron's model/provider if different
        current_provider = config.get("default", "provider", "")
        current_model = config.get("default", "model", "")
        is_different = (cron.provider != current_provider or cron.model != current_model)

        if is_different:
            config.set("default", "provider", cron.provider)
            config.set("default", "model", cron.model)

        # Create a temporary agent with isolated session and cron's permission mode
        cron_session = Session(name=f"cron-{cron.name}", project_path=self._project_path)
        cron_agent = Agent(
            cron_session,
            profile=self.agent.profile,
            on_tool_approval=self._make_cron_approval(cron),
            ctx_limit=self._get_ctx_limit(),
        )

        # Start a run record for history tracking
        model_display = f"{cron.provider}/{cron.model}"
        run = self._cron_scheduler.start_run(cron.id, cron.prompt, model_display)

        async def _run():
            run_messages = []
            tools_used = set()
            files_modified = set()
            output_text = ""
            # ID is already added to _cron_running_jobs in _on_cron_trigger

            async def _execute():
                nonlocal output_text
                async for event in cron_agent.run(cron.prompt):
                    if isinstance(event, TextDelta):
                        output_text += event.text
                    elif isinstance(event, ToolCallStart):
                        tools_used.add(event.tool_name)

            try:
                timeout = cron.timeout_seconds if cron.timeout_seconds > 0 else None
                if timeout:
                    await asyncio.wait_for(_execute(), timeout=timeout)
                else:
                    await _execute()

                # Collect session messages from this run
                run_messages = cron_session.messages[-10:]
                if run:
                    run.messages = run_messages
                    run.tools_used = sorted(tools_used)
                    run.files_modified = sorted(files_modified)
                    run.output_preview = output_text[:500] if output_text else ""

                self._cron_scheduler.mark_result(cron.id, success=True, run=run)
                cron_panel.push_notification(f"[green]✓ Cron '{escape(cron.name)}' completed.[/]")
                self.refresh_cron_status()

            except asyncio.TimeoutError:
                timeout_msg = f"Timed out after {cron.timeout_seconds}s"
                log.warning("Cron '%s' timed out after %ds", cron.name, cron.timeout_seconds)
                if run:
                    run.error = timeout_msg
                self._cron_scheduler.mark_result(cron.id, success=False, error=timeout_msg, run=run)
                # Mark status as timeout distinctly so history shows it clearly
                for c in self._cron_scheduler.list():
                    if c.id == cron.id:
                        c.last_status = "timeout"
                        break
                cron_panel.push_notification(
                    f"[yellow]⏱ Cron '{escape(cron.name)}' timed out[/] after {cron.timeout_seconds}s. "
                    f"Job is free to run again next interval."
                )
                self.refresh_cron_status()

            except Exception as e:
                if run:
                    run.error = str(e)
                self._cron_scheduler.mark_result(cron.id, success=False, error=str(e), run=run)
                cron_panel.push_notification(f"[red]✗ Cron '{escape(cron.name)}' failed:[/] {escape(str(e))}")
                self.refresh_cron_status()
            finally:
                self._cron_running_jobs.discard(cron.id)  # ALWAYS release — timeout, fail, or success
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
                cron_panel = self.query_one(CronStatusPanel)
                cron_panel.push_notification(
                    f"[yellow]⏱ Cron '{escape(cron.name)}':[/] blocked '{escape(tool_name)}' (not in allowlist)"
                )
                return False
            if tool_name in ("write_file", "edit_file") and cron.mode == "safe":
                cron_panel = self.query_one(CronStatusPanel)
                cron_panel.push_notification(
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
        model = config.get("default", "model", "")
        provider = config.get("default", "provider", "")
        if provider == "ollama":
            from andromity.core.models import get_ollama_num_ctx
            self._ollama_num_ctx = get_ollama_num_ctx(model)
        else:
            self._ollama_num_ctx = 0
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval, ctx_limit=self._get_ctx_limit())
        self._update_status()
        chat = self.query_one(ChatPanel)
        chat.add_system_message(f"Provider: [bold]{provider}[/] | Model: [bold cyan]{model}[/]")

    def _apply_profile(self, profile: str):
        """Apply a new profile from the profile picker and persist it."""
        from andromity.config import config
        config.set("default", "profile", profile)
        self.agent = Agent(self.session, profile=profile, on_tool_approval=self._on_tool_approval, ctx_limit=self._get_ctx_limit())
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
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval, ctx_limit=self._get_ctx_limit())
        self._session_named = False
        chat = self.query_one(ChatPanel)
        chat.clear()
        # Plan is session-scoped — new session starts with no plan
        try:
            self.query_one(PlanPanel).clear_plan()
        except Exception:
            pass
        chat.add_system_message("[green]New session started.[/] Previous session saved.")
        self._update_status()

    def _run_compact(self):
        """Manually trigger context window compaction via /compact command."""
        chat = self.query_one(ChatPanel)
        n = len(self.session.messages)
        if n <= 4:
            chat.add_system_message("[dim]Context is short — nothing to compact yet.[/]")
            return
        chat.add_system_message(
            f"[cyan]Compacting context…[/] Summarizing {n - 1} messages → will keep last 10 turns."
        )
        self.run_worker(self._compact_worker(), exclusive=False)

    async def _compact_worker(self):
        """Background worker: runs the same compaction logic as _compact_context but on demand."""
        chat = self.query_one(ChatPanel)
        try:
            from andromity.core.provider import stream_completion
            from andromity.core.events import TextDelta

            keep_last_n = 10
            msgs_to_summarize = self.session.messages[1:-keep_last_n]
            if not msgs_to_summarize:
                self.call_from_thread(
                    chat.add_system_message, "[dim]Not enough history to compact.[/]"
                )
                return

            summary_prompt = (
                "Summarize the following conversation history concisely. "
                "Focus on: decisions made, files created/edited, the overarching goal, "
                "and any important constraints or facts. Be terse but complete:\n\n"
            )
            for m in msgs_to_summarize:
                role = m.get("role", "unknown")
                content = str(m.get("content", ""))
                if len(content) > 600:
                    content = content[:600] + " …[truncated]"
                summary_prompt += f"{role.upper()}: {content}\n\n"

            summary_msgs = [{"role": "user", "content": summary_prompt}]
            new_summary = ""
            async for event in stream_completion(summary_msgs, tools=[]):
                if isinstance(event, TextDelta):
                    new_summary += event.text

            removed = self.session.compact_messages(new_summary, keep_last_n=keep_last_n)
            self.call_from_thread(
                chat.add_system_message,
                f"[green]✓ Compacted.[/] Replaced {removed} messages with a summary block. "
                f"Working context now has {len(self.session.messages)} messages."
            )
            self.call_from_thread(self._update_status)
        except Exception as e:
            self.call_from_thread(
                chat.add_system_message, f"[red]Compact failed:[/] {e}"
            )

    def _load_session(self, session: Session):
        """Switch to a historical session and replay its chat history."""
        self.session = session
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval, ctx_limit=self._get_ctx_limit())
        self._session_named = True  # already named
        chat = self.query_one(ChatPanel)
        chat.load_history(session.messages)
        self._update_status()
        # Load plan from session (if any)
        try:
            plan = session.load_plan_obj()
            panel = self.query_one(PlanPanel)
            if plan:
                panel.load_plan(plan)
            else:
                panel.clear_plan()
        except Exception:
            pass
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
        # First ESC — show hint
        if self._is_streaming:
            try:
                self.query_one(StatusBar).show_hint("Press ESC again to interrupt", 2.0)
            except Exception:
                pass

    def _send_to_agent(self, prompt: str):
        """Send a message to the agent without showing it as a user message in chat."""
        if prompt.startswith("/"):
            self._handle_command(prompt)
        else:
            self.run_worker(self._stream_agent(prompt), exclusive=False)

    def _update_queue_display(self):
        """Update the static queue panel above input bar."""
        panel = self.query_one("#queue-panel", QueuePanel)
        panel.update_queue(self._prompt_queue)

    def _remove_from_queue(self, index: int):
        """Remove a message from the queue by index."""
        if 0 <= index < len(self._prompt_queue):
            self._prompt_queue.pop(index)
            self._update_queue_display()
            chat = self.query_one(ChatPanel)
            chat.add_system_message(f"[dim]Removed message #{index+1} from queue.[/]")

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

        active_tool_name = ""
        active_tool_args = ""
        tools_used = set()  # track which tools were called this stream

        # ── Pre-turn checkpoint (for /undo) ──────────────────────────────────
        snapshot_hash: str | None = None
        msg_count_before = len(self.session.messages)
        try:
            from andromity.core.git_ops import get_repo, create_pre_edit_snapshot
            repo = get_repo(Path(self._project_path))
            if repo:
                snapshot_hash = create_pre_edit_snapshot(repo)
        except Exception as snap_err:
            log.warning("Pre-turn snapshot failed: %s", snap_err)
        self._undo_stack.append({
            "snapshot_hash": snapshot_hash,
            "msg_count": msg_count_before,
            "prompt": prompt,
        })
        self._pre_turn_snapshot = snapshot_hash
        # Keep undo stack capped at 20
        if len(self._undo_stack) > 20:
            self._undo_stack.pop(0)

        # Start response placeholder immediately so there is ZERO perceived lag/freeze
        chat.start_assistant_message()

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
                    active_tool_name = event.tool_name
                    active_tool_args = ""
                    tools_used.add(event.tool_name)
                    log.debug("TOOL START: %s", event.tool_name)
                    if self._debug_mode:
                        chat.add_system_message(f"[dim]▶ tool: {event.tool_name}[/]")
                    chat.show_tool_start(event.tool_name, event.tool_id)
                elif isinstance(event, ToolCallDelta):
                    active_tool_args += event.args_json_chunk
                    chat.append_tool_args(event.tool_id, event.args_json_chunk)
                elif isinstance(event, ToolCallEnd):
                    log.debug("TOOL END: %s", event.tool_id)
                    chat.show_tool_end(event.tool_id)
                elif isinstance(event, ToolResult):
                    log.debug("TOOL RESULT: %s", event.tool_id)
                    chat.show_tool_result(event.tool_id, event.result)
                    
                    if active_tool_name in ("write_file", "edit_file", "edit_file_multi", "delete_file", "shell_exec"):
                        import json
                        try:
                            args = json.loads(active_tool_args)
                            target_path = args.get("path") or args.get("target_path") or args.get("target_file")
                            if target_path:
                                self.query_one(FileTreePanel).highlight_recent_change(Path(target_path).absolute())
                        except Exception:
                            pass
                elif isinstance(event, PlanApprovalRequired):
                    log.info("Plan approval required. Pausing agent loop.")
                    self._plan_approval_future = asyncio.Future()
                    await self._plan_approval_future
                    self._plan_approval_future = None
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
            
            # Play done sound if enabled
            from andromity.config import config as _cfg
            try:
                if _cfg.get("default", "sound_done", True):
                    from andromity.core.audio import play_sound
                    play_sound("done.wav")
            except Exception:
                pass
            
            # Refresh file tree only if file-modifying tools were used
            file_tools = {"write_file", "edit_file", "edit_file_multi", "delete_file", "shell_exec"}
            if tools_used & file_tools:
                try:
                    self.query_one(FileTreePanel).refresh_tree()
                except Exception:
                    pass
            
            # If the agent wrote or updated a plan, refresh the panel from session
            try:
                plan = self.session.load_plan_obj()
                panel = self.query_one(PlanPanel)
                if plan:
                    panel.load_plan(plan)
            except Exception:
                pass
            
            if self._pending_model_change:
                self._pending_model_change = False
                self._apply_model_change()
            
            if self._pending_mode_change:
                self._pending_mode_change = False
                self._apply_mode_change()
                
            # Trigger batch review if files were modified
            if getattr(self, "_pending_batch_files", None) and getattr(self, "_pre_turn_snapshot", None):
                files_to_review = list(self._pending_batch_files)
                self._pending_batch_files.clear()
                
                mode = config.get("default", "permission_mode", "safe")
                if mode == "full":
                    chat.add_system_message(f"[green]✓ {len(files_to_review)} files saved (auto-approved in FULL mode).[/]")
                elif mode in ("safe", "trust"):
                    def _on_batch_review(accepted: bool | None):
                        if accepted:
                            chat.add_system_message(f"[green]✓ Batch review accepted for {len(files_to_review)} files.[/]")
                        else:
                            chat.add_system_message("[yellow]⚠ Batch review completed. Unaccepted files were reverted.[/]")
                            try:
                                self.query_one(FileTreePanel).refresh_tree()
                            except Exception:
                                pass
                                
                    self.push_screen(BatchReviewOverlay(self._project_path, self._pre_turn_snapshot, files_to_review), _on_batch_review)
                
            if self._prompt_queue:
                next_prompt = self._prompt_queue.pop(0)
                self._update_queue_display()
                # Process next queued message after a short delay (survives cancel better)
                self.set_timer(0.3, lambda p=next_prompt: self._process_message(p))
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
            if len(self._prompt_queue) >= 10:
                self.query_one(ChatPanel).add_system_message("Queue is full (max 10). Please wait for the agent to finish.")
                return

            self._prompt_queue.append(prompt)
            log.info("Queued: %s (queue size: %d)", prompt[:50], len(self._prompt_queue))
            self._update_queue_display()
            return
            
        self._process_message(prompt)

    def _process_message(self, prompt: str):
        chat = self.query_one(ChatPanel)
        chat.clear_ephemeral()
        
        if prompt.startswith("/"):
            self._handle_command(prompt)
        else:
            chat.add_user_message(prompt)
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
                diff_panel.show_file(path)
                diff_panel.add_class("visible")


    def _apply_mode_change(self):
        mode = "yolo" if self._yolo_session else config.get("default", "permission_mode", "safe")
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
            self.action_toggle_model()
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
                self.action_toggle_profile()
        elif command == "/keys":
            if len(parts) > 1 and parts[1].strip():
                subparts = parts[1].strip().split(maxsplit=2)
                subcmd = subparts[0].lower()
                if subcmd == "set" and len(subparts) == 3:
                    provider_name = subparts[1].lower()
                    key_val = subparts[2].strip()
                    config.set_api_key(provider_name, key_val)
                    masked = key_val[:6] + "..." + key_val[-4:] if len(key_val) > 10 else "***"
                    chat.add_system_message(
                        f"✓ API key for [bold]{provider_name}[/] saved: {masked}\n"
                        f"[dim yellow]⚠ Stored in plaintext at: {config.config_path}[/]\n"
                        f"[dim]Do not commit this file to version control.[/]"
                    )
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
            self.action_toggle_sessions()
        elif command == "/new":
            self._new_session()
        elif command == "/compact":
            self._run_compact()
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

                if mode == "yolo":
                    self._yolo_session = True
                    self._update_status()
                    chat.add_system_message(
                        "⚡ [bold red]YOLO mode enabled for this session only.[/]\n"
                        "[dim yellow]All tool confirmation prompts are bypassed. This will automatically reset to SAFE on restart.[/]"
                    )
                elif mode in ("safe", "trust", "full"):
                    self._yolo_session = False
                    config.set("default", "permission_mode", mode)
                    if self._is_streaming:
                        self._pending_mode_change = True
                        chat.add_system_message(f"⚡ [yellow]Mode change to {mode.upper()} pending...[/] (Will apply after current response)")
                    else:
                        self._apply_mode_change()
                else:
                    chat.add_system_message("Unknown mode. Use: safe, trust, full, or yolo")
            else:
                chat.add_system_message("Usage: /mode <safe|trust|full|yolo>")
        elif command == "/help":
            chat.add_system_message(
                "Commands:\n"
                "  /model                   Switch provider & model (Ctrl+L)\n"
                "  /profile [name]          Switch profile (builder/reviewer/planner, Ctrl+J)\n"
                "  /mode [safe|trust|yolo]  Set permission mode for file/shell approvals\n"
                "  /undo                    Undo last prompt & revert all file changes\n"
                "  /mcp                     Show MCP server status & available tools\n"
                "  /sessions                Browse & switch sessions (Ctrl+O)\n"
                "  /new                     Start a new session\n"
                "  /compact                  Summarize & compress old context (frees token space)\n"
                "  /rename <name>           Rename current session\n"
                "  /settings                Open master settings panel\n"
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
                "  Ctrl+L     Model picker\n"
                "  Ctrl+J     Profile picker\n"
                "  Ctrl+O     Session browser\n"
                "  ↑/↓ arrows  Navigate prompt history (when input is empty)\n"
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
        elif command in ("/settings", "/setting"):
            self.push_screen(SettingsScreen(self._mcp_manager, self._project_path))
        elif command == "/cron":
            self.push_screen(CronManagerOverlay(self._cron_scheduler, self._project_path))
        elif command.startswith("/plan"):
            parts = cmd.split()
            if len(parts) > 1 and parts[1].strip().lower() == "clear":
                self.session.clear_plan()
                panel = self.query_one(PlanPanel)
                panel.clear_plan()
                chat.add_system_message("[green]✓ Active plan cleared.[/]")
            else:
                plan = self.session.load_plan_obj()
                if plan:
                    self.query_one(PlanPanel).load_plan(plan)
                    chat.add_system_message(f"[cyan]Plan reloaded:[/] {escape(plan.title)}")
                else:
                    chat.add_system_message("[dim]No plan in this session.[/]")
        elif command == "/mcp":
            summary = self._mcp_manager.get_status_summary()
            servers = summary.get("servers", {})
            if not servers:
                chat.add_system_message(
                    "[yellow]No MCP servers configured.[/]\n"
                    f"Add servers to [bold].andromity/mcp.json[/] in your project.\n\n"
                    "[dim]Format:\n"
                    '{  "mcpServers": {\n'
                    '    "my-server": {\n'
                    '      "command": "npx",\n'
                    '      "args": ["agenticmarket", "proxy", "agenticmarket/exchange-rate"]\n'
                    "    }\n  }\n}[/]"
                )
            else:
                lines = ["[bold]MCP Servers[/]\n"]
                for name, info in servers.items():
                    status = info.get("status", "unknown")
                    tools_count = info.get("tools", 0)
                    err = info.get("error")
                    cmd_str = info.get("command", "")
                    if status == "running":
                        icon = "[bold green]●[/]"
                        status_str = f"[green]running[/] [dim]({tools_count} tools)[/]"
                    else:
                        icon = "[bold red]✗[/]"
                        status_str = f"[red]error[/] [dim]{escape(err or '')}[/]"
                    lines.append(f"  {icon} [bold]{escape(name)}[/]  {status_str}")
                    if cmd_str:
                        lines.append(f"      [dim]cmd: {escape(cmd_str)}[/]")

                # List all available tools
                all_tools = self._mcp_manager.get_all_tools()
                if all_tools:
                    lines.append("")
                    lines.append("[bold]Available Tools[/]")
                    for t in all_tools:
                        # Guard: only MCPToolInfo objects have .full_name
                        full_name = getattr(t, 'full_name', None) or getattr(t, 'name', str(t))
                        description = getattr(t, 'description', '') or ''
                        lines.append(f"  [cyan]{escape(full_name)}[/]")
                        if description:
                            desc = description[:80] + ("\u2026" if len(description) > 80 else "")
                            lines.append(f"    [dim]{escape(desc)}[/]")

                lines.append("")
                lines.append(f"[dim]Config: .andromity/mcp.json  |  Restart Andromity to reload servers[/]")
                chat.add_system_message("\n".join(lines))
        elif command == "/undo":
            self._run_undo()
        else:
            chat.add_system_message(f"Unknown: {command}. Type /help")

    def action_toggle_filetree(self):
        panel = self.query_one("#left-panel")
        if panel.styles.display == "none":
            panel.remove_class("force-hidden")
            panel.add_class("force-show")
        else:
            panel.remove_class("force-show")
            panel.add_class("force-hidden")

    def action_toggle_right_panel(self):
        panel = self.query_one("#right-sidebar")
        if panel.styles.display == "none":
            panel.remove_class("force-hidden")
            panel.add_class("force-show")
        else:
            panel.remove_class("force-show")
            panel.add_class("force-hidden")

    def action_toggle_diff(self):
        """Ctrl+D — show/hide the file viewer/diff panel."""
        diff = self.query_one("#diff-panel")
        if diff.has_class("visible"):
            # Resolve pending tool approval if hiding the panel
            self._resolve_tool_approval(False)
            diff.remove_class("visible")
        else:
            diff.add_class("visible")

    @on(Button.Pressed, "#btn-apply")
    def on_btn_apply(self, event: Button.Pressed):
        self._resolve_tool_approval(True)
        try:
            self.query_one("#diff-panel", DiffPanel).dismiss_tool()
        except Exception:
            pass
        self.query_one("#diff-panel").remove_class("visible")

    @on(Button.Pressed, "#btn-reject")
    def on_btn_reject(self, event: Button.Pressed):
        self._resolve_tool_approval(False)
        try:
            self.query_one("#diff-panel", DiffPanel).dismiss_tool()
        except Exception:
            pass
        self.query_one("#diff-panel").remove_class("visible")

    @on(Button.Pressed, "#btn-allow-domain")
    def on_btn_allow_domain(self, event: Button.Pressed):
        self._resolve_tool_approval(True)
        try:
            self.query_one("#diff-panel", DiffPanel).dismiss_tool()
        except Exception:
            pass
        self.query_one("#diff-panel").remove_class("visible")


    def action_toggle_model(self):
        self.push_screen(ModelPickerOverlay())

    def action_toggle_settings(self):
        self.push_screen(SettingsScreen(self._mcp_manager, self._project_path))

    def action_toggle_profile(self):
        self.push_screen(ProfilePickerOverlay())

    def action_toggle_sessions(self):
        self.push_screen(SessionBrowserOverlay(self.session.id, self._project_path))

    def action_close_overlays(self):
        # Resolve pending tool approval if diff panel is visible
        diff = self.query_one("#diff-panel")
        if diff.has_class("visible"):
            self._resolve_tool_approval(False)
        for overlay in self.query(".visible"):
            overlay.remove_class("visible")
        self.query_one(InputBar).query_one("#input-field").focus()

    def _resolve_tool_approval(self, result: bool):
        """Resolve pending tool approval future if one exists."""
        if getattr(self, '_tool_approval_future', None) and not self._tool_approval_future.done():
            self._tool_approval_future.set_result(result)
            self._tool_approval_future = None

    def _run_undo(self):
        """
        Trigger confirmation modal to undo the last AI turn.
        """
        chat = self.query_one(ChatPanel)
        if not self._undo_stack:
            chat.add_system_message("[yellow]Nothing to undo — no turns on the stack.[/]")
            return
        if self._is_streaming:
            chat.add_system_message("[yellow]Cannot undo while the agent is running. Cancel first (Esc).[/]")
            return

        checkpoint = self._undo_stack[-1]
        undone_prompt = checkpoint.get("prompt", "")

        def _on_undo_result(confirmed: bool | None) -> None:
            if confirmed:
                self._perform_confirmed_undo()
            else:
                try:
                    self.focus_input()
                except Exception:
                    pass

        self.push_screen(UndoConfirmOverlay(prompt=undone_prompt), _on_undo_result)

    def _perform_confirmed_undo(self):
        """
        Execute confirmed undo:
          1. Revert all file changes from that turn using git snapshot.
          2. Trim session.messages back to pre-turn state.
          3. Reload the visual chat panel so chat & prompt context are cleanly rolled back.
          4. Restore the undone prompt into the user input bar.
        """
        if not self._undo_stack:
            return

        checkpoint = self._undo_stack.pop()
        snapshot_hash = checkpoint.get("snapshot_hash")
        msg_count = checkpoint.get("msg_count", 0)
        undone_prompt = checkpoint.get("prompt", "")

        # ── 1. Revert file changes ────────────────────────────────────────────
        files_reverted = False
        if snapshot_hash:
            try:
                from andromity.core.git_ops import get_repo, restore_snapshot
                repo = get_repo(Path(self._project_path))
                if repo:
                    files_reverted = restore_snapshot(repo, snapshot_hash)
            except Exception as e:
                log.warning("Undo file revert failed: %s", e)

        # ── 2. Trim session messages ─────────────────────────────────────────
        if msg_count <= len(self.session.messages):
            self.session.messages = self.session.messages[:msg_count]
            self.session.save()

        # ── 3. Clean visual chat panel rollback (prevents chat/LLM context pollution)
        chat = self.query_one(ChatPanel)
        try:
            chat.load_history(self.session.messages)
        except Exception as e:
            log.warning("Failed to reload chat history: %s", e)

        # ── 4. Refresh Sidebar UI & Diff ──────────────────────────────────────
        try:
            self.query_one(FileTreePanel).refresh_tree()
        except Exception:
            pass
        try:
            panel = self.query_one(PlanPanel)
            plan = self.session.load_plan_obj()
            if plan:
                panel.load_plan(plan)
            else:
                panel.clear_plan()
        except Exception:
            pass

        short = undone_prompt[:60] + ("…" if len(undone_prompt) > 60 else "")
        file_note = "[green]✓ Files reverted[/] " if files_reverted else "[yellow]⚠ File revert unavailable (no git repo)[/] "
        chat.add_system_message(
            f"[bold green]↩ Undone:[/] \"{escape(short)}\"\n"
            f"{file_note}│ [dim]Conversation rolled back {len(self.session.messages)} messages[/] │ [cyan]Prompt restored to input[/]"
        )

        # ── 5. Restore prompt into the user input box ─────────────────────────
        try:
            input_field = self.query_one("InputBar").query_one("#input-field", TextArea)
            input_field.text = undone_prompt
            input_field.move_cursor(input_field.get_cursor_line_end_location())
            self.focus_input()
        except Exception:
            pass

        self._update_status()

