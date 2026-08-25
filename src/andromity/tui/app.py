import asyncio
import re
import threading
import time
from pathlib import Path
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual import on
from textual.widgets import Input, Static, Tree, TextArea, Header , Footer, Button
from textual.containers import Horizontal, Vertical

from typing import Any

from andromity.tui.panels.chat import ChatPanel
from andromity.tui.panels.filetree import FileTreePanel
from andromity.tui.panels.diff import DiffPanel
from andromity.tui.panels.plan import PlanPanel
from andromity.tui.footer import StatusBar, InputBar, ContextPanel, AppFooter, QueuePanel, CronStatusPanel
from andromity.tui.markup_utils import escape_textual as escape
from andromity.tui.overlays.model import ModelPickerOverlay
from andromity.tui.overlays.profile import ProfilePickerOverlay
from andromity.tui.overlays.help import HelpScreen
from andromity.tui.overlays.trust import TrustPromptOverlay
from andromity.tui.overlays.session import SessionBrowserOverlay
from andromity.tui.command_palette import CommandPalette
from andromity.tui.skill_mentions import SkillMentionPanel, mention_query
from andromity.tui.overlays.cron import CronManagerOverlay
from andromity.tui.overlays.undo import UndoConfirmOverlay
from andromity.tui.overlays.batch_review import BatchReviewOverlay
from andromity.tui.overlays.questions import QuestionPanel, format_question_answers, normalize_questions
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


# ── Textual workarounds ────────────────────────────────────────────────────
# Content.get_height() (used by OptionList and other nowrap widgets during
# layout) calls _wrap_and_format(width) with no guard against width == 0.
# Folding then runs `range(0, cell_length, width)`, and a zero width raises
# "ValueError: range() arg 3 must not be zero". On Windows, resizing the
# terminal fires WINDOW_BUFFER_SIZE_EVENT with transiently tiny sizes (e.g.
# 4x1 while dragging), which makes an open OptionList overlay compute a
# 0-width option region and crash the whole app mid-resize. render_strips()
# already guards `if not width`; mirror that here by clamping the width.
def _apply_textual_workarounds() -> None:
    import functools
    from textual.content import Content
    from andromity.tui.patches import apply_textual_patches

    apply_textual_patches()

    original = Content._wrap_and_format
    if getattr(original, "_andromity_guarded", False):
        return

    @functools.wraps(original)
    def _wrap_and_format(self, width, *args, **kwargs):
        return original(self, max(1, width), *args, **kwargs)

    _wrap_and_format._andromity_guarded = True
    Content._wrap_and_format = _wrap_and_format


_apply_textual_workarounds()

COMMANDS = ["/help", "/mode", "/model", "/profile", "/reason", "/update", "/context-menu", "/undo", "/keys", "/settings", "/sessions", "/new", "/rename", "/trust", "/untrust", "/dry-run", "/debug", "/logs", "/clear", "/cron", "/plan", "/mcp", "/skills", "/compact", "/export", "/tips", "/news"]

CSS = """\
Screen { background: $surface; }
#main-layout { height: 1fr; }
#left-panel {
    width: 34; min-width: 16; max-width: 35;
    border-right: solid $panel-lighten-2; overflow-y: auto;
}
.hide-context #right-sidebar { display: none; }
.hide-files #left-panel { display: none; }
#left-panel.force-hidden { display: none; }
#left-panel.force-show { display: block; }
#right-sidebar.force-hidden { display: none; }
#right-sidebar.force-show { display: block !important; }
#center-panel { width: 1fr; }
#diff-panel {
    display: none;
    width: 1fr;
    height: 1fr;
    border-left: solid $panel-lighten-2;
}
#diff-panel.visible { display: block; }
#right-sidebar {
    width: 45; height: 1fr;
    border-left: solid $panel-lighten-2;
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
ChatPanel MarkdownHorizontalRule { margin: 0; padding: 0; border: none; border-top: solid $panel-lighten-2; }
FileTreePanel { height: 1fr; overflow-y: auto; padding: 1; }
PlanPanel { height: 1fr; border-top: solid $panel-lighten-2; }
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
    border-right: solid $panel-lighten-2;
}
.narrow #right-sidebar { width: 0; min-width: 0; border-left: none; }

/* Minimal copy buttons — mirror the permission/Apply buttons (transparent, muted) */
.copy-btn, .copy-tools-btn {
    height: 1 !important; width: auto !important; min-width: 0 !important;
    border: none !important; background: transparent !important;
    color: $text-muted !important; padding: 0 1 !important; margin: 0 !important;
}
.copy-btn:hover, .copy-tools-btn:hover { color: $accent !important; }

/* One-line response footer: copy button + timing + tool calls */
.response-footer { height: 1; margin: 0 0 1 0; }
.resp-time { color: $text-muted; padding: 0 1; height: 1; content-align: left middle; }
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
        Binding("ctrl+u", "toggle_profile", "Profile", show=True),
        Binding("ctrl+o", "toggle_sessions", "Sessions", show=True),
        Binding("ctrl+e", "toggle_settings", "Settings", show=True),
        Binding("escape", "escape_pressed", show=False),
    ]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._project_path = str(Path.cwd())
        self.session = Session(name="new-session", project_path=self._project_path)
        self._ollama_num_ctx = 0
        init_effort = config.get("default", "reasoning_effort", "medium")
        self.agent = Agent(self.session, on_tool_approval=self._on_tool_approval,
                           on_questions=self._on_ask_questions, ctx_limit=self._get_ctx_limit(),
                           reasoning_effort=init_effort)
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
        self._undo_in_progress: bool = False
        self._pending_batch_files: set[Path] = set()
        self._pre_write_contents: dict[Path, bytes | None] = {}  # path → bytes before this turn (None = new file)
        self._pre_turn_snapshot: str | None = None
        log.info(
            "=== Andromity started | project=%s | session=%s | cron=%s | mcp=%s ===",
            self._project_path,
            getattr(self, "session", None),
            getattr(self, "_cron_scheduler", None),
            getattr(self, "_mcp_manager", None),
        )

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
                CommandPalette(id="command-palette"),
                SkillMentionPanel(id="skill-mentions"),
                QueuePanel(id="queue-panel"),
                QuestionPanel(id="question-panel"),
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
        # Responsive ladder, priority chat > context > file tree:
        # full layout → hide file tree (≤135) → chat-only narrow mode (≤110).
        # Context/token stats stay visible until narrow mode. Manual Ctrl+B
        # toggles use per-element force-show/force-hidden classes that always win.
        if event.size.width <= 110:
            self.add_class("narrow")
        else:
            self.remove_class("narrow")

        if event.size.width <= 135:
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
        # Auto-init git tracking in background (0.5s delay so UI paints first)
        self.set_timer(0.5, self._ensure_git_tracking)
        # Check for updates and auto-register Windows context menu (2.0s delay)
        self.set_timer(2.0, self._start_background_checks)
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

    def on_unmount(self):
        """Flush any pending debounced session writes to disk on app exit."""
        if hasattr(self, "session") and self.session:
            try:
                self.session.flush()
            except Exception:
                pass

    def _ensure_git_tracking(self):
        """Initialize git repo in the project folder if one doesn't exist.
        Runs in a background thread so it never blocks the UI."""
        def _job():
            try:
                from andromity.core.git_ops import ensure_git_tracking
                _, was_created = ensure_git_tracking(Path(self._project_path))
                if was_created:
                    self.call_from_thread(
                        self.query_one(ChatPanel).add_system_message,
                        "[green]📸 Git initialized[/] for this folder. "
                        "[dim]/undo will now work across all turns, even for newly created files.[/dim]",
                        ephemeral=True,
                    )
            except Exception as e:
                log.warning("ensure_git_tracking failed: %s", e)
        t = threading.Thread(target=_job, daemon=True, name="git-init")
        t.start()

    def _start_background_warmup(self):
        """Pre-import litellm in an isolated daemon worker thread so it never blocks the UI event loop or teardown."""
        def _import_job():
            try:
                import litellm  # noqa: F401
                from litellm import acompletion  # noqa: F401
                log.info("litellm warmed up in background thread")
            except Exception as e:
                log.warning("litellm background warm-up failed: %s", e)

        t = threading.Thread(target=_import_job, daemon=True, name="litellm-warmup")
        t.start()

    def _start_background_checks(self):
        """Auto-register context menu on first run and check for updates asynchronously."""
        # 1. Windows Context Menu auto-registration on first run
        try:
            from andromity.core.context_menu import maybe_auto_install_context_menu
            if maybe_auto_install_context_menu():
                try:
                    self.call_from_thread(
                        self.query_one(ChatPanel).add_system_message,
                        "[green]✓ Added 'Open in Andromity' to Windows right-click context menu.[/] "
                        "[dim](Toggle in /settings or with /context-menu)[/dim]",
                        ephemeral=True
                    )
                except Exception:
                    pass
        except Exception:
            pass

        # 2. Asynchronous update check (24h cached)
        try:
            from andromity.core.updater import check_for_updates_async
            def _on_update_result(info: dict):
                if info and info.get("update_available"):
                    latest = info.get("latest_version", "")
                    def _update_ui():
                        try:
                            self.query_one(AppFooter).set_update_available(latest)
                            self.query_one(ChatPanel).add_system_message(
                                f"🚀 [bold $warning]Update available: v{latest}[/] — run [bold cyan]/update[/] or click the footer badge to upgrade.",
                                ephemeral=True
                            )
                        except Exception:
                            pass
                    self.call_from_thread(_update_ui)

            check_for_updates_async(_on_update_result)
        except Exception:
            pass

    def action_run_update(self):
        """Perform an in-app upgrade of Andromity in the background."""
        chat = self.query_one(ChatPanel)
        chat.add_system_message("[cyan]⟳ Checking for updates and upgrading Andromity...[/]")

        def _do_upgrade():
            from andromity.core.updater import perform_update
            ok, msg = perform_update()
            if ok:
                self.call_from_thread(chat.add_system_message, f"[bold green]✓ {msg}[/]")
            else:
                self.call_from_thread(chat.add_system_message, f"[bold red]✗ {msg}[/]")

        self.run_worker(_do_upgrade, thread=True, exclusive=False, group="app-update")

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
            "[bold $success]✦ Welcome to Andromity![/]  "
            "Your AI coding assistant is ready.\n"
            "  [dim]Type a message and press [bold]Enter[/] to chat  ·  "
            "[bold]/help[/] for commands  ·  "
            "[bold]Ctrl+L[/] to switch model  ·  "
            "[bold]Alt+N[/] for new line[/dim]",
            ephemeral=True
        )

        # No-model warning banner
        if not model:
            chat.add_system_message(
                "[yellow]⚠  No model selected.[/] Press [bold]Ctrl+L[/] to pick a provider — "
                "you can paste your API key right inside the picker.",
                ephemeral=True
            )
            self.call_after_refresh(lambda: self.action_toggle_model())

        if not config.get_api_key("anthropic") and not config.get_api_key("openai") and \
                not config.get_api_key("google") and not config.get_api_key("openrouter"):
            if model and provider not in ("ollama",):
                chat.add_system_message(
                    "[yellow]⚠ No cloud API key configured.[/] Press [bold]Ctrl+L[/], choose your provider, "
                    "and paste the key there — it's saved automatically.",
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
        
        # The footer is a context-window indicator, not the cumulative bill.
        # token_total is retained for usage analytics and spend accounting.
        display_tokens = live_tokens if live_tokens is not None else self.session.context_tokens
        is_estimated = live_tokens is not None
        
        try:
            mcp_summary = self._mcp_manager.get_status_summary() if hasattr(self, "_mcp_manager") else None
            ctx = self.query_one(ContextPanel)
            ctx.update_context(
                tokens=display_tokens,
                cost=self.session.cost_usd,
                cost_source=self.session.cost_source,
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
        effort = getattr(self.agent, "reasoning_effort", None) or config.get("default", "reasoning_effort", "medium")
        try:
            self.query_one(StatusBar).update_status(
                tokens=display_tokens,
                cost=self.session.cost_usd,
                cost_source=self.session.cost_source,
                profile=self.agent.profile,
                model=display,
                ctx_limit=ctx_limit,
                estimated=is_estimated,
                session_name=self.session.name,
                permission_mode=active_mode,
                effort=effort,
            )
        except Exception:
            pass
        self.query_one(AppFooter).update_footer(cwd=self._project_path, profile=self.agent.profile)

    def refresh_cron_status(self):
        try:
            panel = self.query_one(CronStatusPanel)
            panel.refresh_jobs(self._cron_scheduler.list())
        except Exception:
            pass

    async def _on_tool_approval(self, tool_name: str, args: dict) -> bool:
        if not config.is_trusted(self._project_path):
            if tool_name in ("write_file", "edit_file", "edit_file_multi", "delete_file", "shell_exec", "shell_bg", "shell_kill"):
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
            # Only track for batch review in SAFE mode.
            # TRUST/FULL/YOLO all auto-approve writes — no review overlay needed.
            if mode == "safe":
                path = args.get("path") or args.get("target_path") or args.get("target_file")
                if path:
                    p = Path(path).resolve()
                    # Snapshot old content ONCE per file per turn, before the agent writes it.
                    # None means the file didn't exist yet (agent is creating it).
                    if p not in self._pre_write_contents:
                        try:
                            self._pre_write_contents[p] = p.read_bytes() if p.exists() else None
                        except OSError:
                            self._pre_write_contents[p] = None
                    self._pending_batch_files.add(p)
            return True

        if mode in ("yolo", "full"):
            return True

        needs_approval = False
        if tool_name in ("shell_exec", "shell_bg"):
            command = str(args.get("command", "")).strip()
            if mode == "safe":
                needs_approval = True
            elif mode == "trust":
                allowed = config.get("default", "allowed_commands", [])
                if not allowed:
                    needs_approval = True
                elif not any(command.startswith(prefix) for prefix in allowed):
                    needs_approval = True
        elif tool_name == "shell_kill":
            if mode == "safe":
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

    async def _on_ask_questions(self, questions: Any):
        """Agent-loop callback for ask_questions: show the inline question panel
        above the input bar (chat stays visible), wait for the user, and return
        the answers formatted as the tool result."""
        # Attention sound — same "AI needs you" signal as tool-approval prompts,
        # so a question panel is never silently missed while the user is away.
        try:
            if config.get("default", "sound_attention", True):
                from andromity.core.audio import play_sound
                play_sound("done.wav")
        except Exception:
            pass

        norm_questions = normalize_questions(questions)
        if not norm_questions:
            return "The user did not answer the questions. Proceed with reasonable assumptions."

        fut = asyncio.Future()

        def _on_done(answers):
            if not fut.done():
                fut.set_result(answers)

        try:
            panel = self.query_one("#question-panel", QuestionPanel)
            await panel.ask(norm_questions, _on_done)
        except Exception as e:
            log.warning("QuestionPanel error in ask: %s", e)
            if not fut.done():
                fut.set_result(None)

        try:
            answers = await fut
        except asyncio.CancelledError:
            try:
                self.query_one("#question-panel", QuestionPanel).hide_questions()
            except Exception:
                pass
            raise

        return format_question_answers(norm_questions, answers)

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

        # Create an isolated session for this cron run
        cron_session = Session(name=f"cron: {cron.name}", project_path=self._project_path)
        cron_agent = Agent(
            cron_session,
            profile=self.agent.profile,
            on_tool_approval=self._make_cron_approval(cron),
            ctx_limit=self._get_ctx_limit(),
            provider=cron.provider,
            model=cron.model,
        )

        # Start a run record for history tracking
        model_display = f"{cron.provider}/{cron.model}" if cron.provider else cron.model
        run = self._cron_scheduler.start_run(
            cron.id,
            cron.prompt,
            model_display,
            provider=cron.provider,
            session_id=cron_session.id,
        )

        async def _run():
            import json
            import time
            tools_used = set()
            files_modified = set()
            tool_executions = []
            active_tool_calls = {}  # tool_id -> {tool_name, args, start_time}
            output_text = ""

            async def _execute():
                nonlocal output_text
                async for event in cron_agent.run(cron.prompt):
                    if isinstance(event, TextDelta):
                        output_text += event.text
                    elif isinstance(event, ToolCallStart):
                        tools_used.add(event.tool_name)
                        active_tool_calls[event.tool_id] = {
                            "tool_name": event.tool_name,
                            "args": "",
                            "start_time": time.time(),
                        }
                    elif isinstance(event, ToolCallDelta):
                        if event.tool_id in active_tool_calls:
                            active_tool_calls[event.tool_id]["args"] += event.args_json_chunk
                    elif isinstance(event, ToolResult):
                        rec = active_tool_calls.pop(event.tool_id, None)
                        dur = int((time.time() - rec["start_time"]) * 1000) if rec else 0
                        tool_name = rec["tool_name"] if rec else "tool"
                        raw_args = rec["args"] if rec else ""
                        try:
                            parsed_args = json.loads(raw_args) if raw_args else {}
                        except Exception:
                            parsed_args = {"raw": raw_args}

                        # Track modified files
                        if tool_name in ("write_file", "edit_file", "write_to_file", "replace_file_content"):
                            fpath = parsed_args.get("path") or parsed_args.get("target_file") or parsed_args.get("file_path") or parsed_args.get("TargetFile")
                            if fpath:
                                files_modified.add(str(fpath))
                        elif tool_name == "multi_replace_file_content":
                            fpath = parsed_args.get("TargetFile")
                            if fpath:
                                files_modified.add(str(fpath))

                        res_str = str(event.result) if event.result is not None else ""
                        tool_executions.append({
                            "tool_name": tool_name,
                            "args": parsed_args,
                            "result": res_str[:3000],
                            "duration_ms": dur,
                            "status": "rejected" if "[Rejected by User]" in res_str else "ok",
                        })

            try:
                timeout = cron.timeout_seconds if cron.timeout_seconds > 0 else None
                if timeout:
                    await asyncio.wait_for(_execute(), timeout=timeout)
                else:
                    await _execute()

                cron_session.flush()
                run_messages = cron_session.messages
                if run:
                    run.messages = run_messages
                    run.tools_used = sorted(tools_used)
                    run.files_modified = sorted(files_modified)
                    run.tool_executions = tool_executions
                    run.output = output_text
                    run.output_preview = output_text[:500] if output_text else ""
                    run.cost_usd = getattr(cron_session, "cost_usd", 0.0)

                self._cron_scheduler.mark_result(cron.id, success=True, run=run)
                cron_panel.push_notification(f"[green]✓ Cron '{escape(cron.name)}' completed.[/]")
                self.refresh_cron_status()

            except asyncio.TimeoutError:
                timeout_msg = f"Timed out after {cron.timeout_seconds}s"
                log.warning("Cron '%s' timed out after %ds", cron.name, cron.timeout_seconds)
                cron_session.flush()
                if run:
                    run.error = timeout_msg
                    run.messages = cron_session.messages
                    run.tools_used = sorted(tools_used)
                    run.files_modified = sorted(files_modified)
                    run.tool_executions = tool_executions
                    run.output = output_text
                    run.output_preview = output_text[:500] if output_text else ""
                self._cron_scheduler.mark_result(cron.id, success=False, error=timeout_msg, run=run)
                cron_panel.push_notification(
                    f"[yellow]⏱ Cron '{escape(cron.name)}' timed out[/] after {cron.timeout_seconds}s. "
                    f"Job is free to run again next interval."
                )
                self.refresh_cron_status()

            except Exception as e:
                cron_session.flush()
                if run:
                    run.error = str(e)
                    run.messages = cron_session.messages
                    run.tools_used = sorted(tools_used)
                    run.files_modified = sorted(files_modified)
                    run.tool_executions = tool_executions
                    run.output = output_text
                    run.output_preview = output_text[:500] if output_text else ""
                self._cron_scheduler.mark_result(cron.id, success=False, error=str(e), run=run)
                cron_panel.push_notification(f"[red]✗ Cron '{escape(cron.name)}' failed:[/] {escape(str(e))}")
                self.refresh_cron_status()
            finally:
                self._cron_running_jobs.discard(cron.id)

        self.run_worker(_run(), exclusive=False)

    def _make_cron_approval(self, cron: CronJob):
        """Return an approval callback respecting the cron's own mode and allowlist."""
        async def _approval(tool_name: str, args: dict) -> bool:
            if cron.mode == "yolo":
                return True
            if tool_name in ("shell_exec", "shell_bg"):
                command = str(args.get("command", "")).strip()
                if cron.allowed_commands and any(command.startswith(p) for p in cron.allowed_commands):
                    return True
                # Block unapproved commands — notify but don't prompt
                cron_panel = self.query_one(CronStatusPanel)
                cron_panel.push_notification(
                    f"[yellow]⏱ Cron '{escape(cron.name)}':[/] blocked '{escape(tool_name)}' (not in allowlist)"
                )
                return False
            if tool_name in ("write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content") and cron.mode == "safe":
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
        current_effort = getattr(self.agent, "reasoning_effort", None) or config.get("default", "reasoning_effort", "medium")
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval,
                           on_questions=self._on_ask_questions, ctx_limit=self._get_ctx_limit(),
                           reasoning_effort=current_effort)
        self._update_status()
        chat = self.query_one(ChatPanel)
        chat.add_system_message(f"Provider: [bold]{provider}[/] | Model: [bold cyan]{model}[/]")

    def _apply_profile(self, profile: str):
        """Apply a new profile from the profile picker and persist it."""
        from andromity.config import config
        config.set("default", "profile", profile)
        current_effort = getattr(self.agent, "reasoning_effort", None) or config.get("default", "reasoning_effort", "medium")
        self.agent = Agent(self.session, profile=profile, on_tool_approval=self._on_tool_approval,
                           on_questions=self._on_ask_questions, ctx_limit=self._get_ctx_limit(),
                           reasoning_effort=current_effort)
        self._update_status()
        chat = self.query_one(ChatPanel)
        chat.add_system_message(f"Profile: {profile}")

    def on_reasoning_effort_changed(self, effort: str):
        """Called by StatusBar or slash command when reasoning effort changes."""
        self.agent.reasoning_effort = effort
        try:
            config.set("default", "reasoning_effort", effort)
        except Exception:
            pass
        label = "off" if effort == "off" else effort
        try:
            self.query_one(ChatPanel).add_system_message(
                f"[cyan]Reasoning effort:[/] [bold]{label}[/]"
                + (" — sent as reasoning.effort in every request." if effort != "off" else " — no reasoning param sent.")
            )
        except Exception:
            pass

    def action_show_trust_prompt(self) -> None:
        """Open the trust prompt overlay to allow trusting or untrusting the workspace."""
        def _on_trust(trusted: bool | None) -> None:
            if trusted is not None:
                self._on_trust_resolved(bool(trusted))
        self.push_screen(TrustPromptOverlay(self._project_path), _on_trust)

    def _on_trust_resolved(self, trusted: bool):
        """Called after the trust prompt is answered."""
        chat = self.query_one(ChatPanel)
        try:
            self.query_one(AppFooter).set_trust_state(trusted)
        except Exception:
            pass
        if trusted:
            chat.add_system_message(f"[green]✓ Folder trusted.[/] Full access enabled.")
        else:
            chat.add_system_message(
                "[yellow]Read-only mode.[/] File writes and shell commands are blocked.\n"
                "Use [bold cyan]/trust[/] to enable full access."
            )
        self._show_welcome()

    def _update_status(self, live_tokens: int | None = None):
        model = config.get("default", "model", "")
        provider = config.get("default", "provider", "")
        display = f"{provider}/{model}" if provider and model else model
        if provider == "ollama" and getattr(self, "_ollama_num_ctx", 0) > 0:
            ctx_limit = self._ollama_num_ctx
        else:
            from andromity.core.models import get_context_limit_for_model
            ctx_limit = get_context_limit_for_model(provider, model) if (provider and model) else 0
        
        # The footer is a context-window indicator, not the cumulative bill.
        # token_total is retained for usage analytics and spend accounting.
        display_tokens = live_tokens if live_tokens is not None else self.session.context_tokens
        is_estimated = live_tokens is not None
        
        try:
            mcp_summary = self._mcp_manager.get_status_summary() if hasattr(self, "_mcp_manager") else None
            ctx = self.query_one(ContextPanel)
            ctx.update_context(
                tokens=display_tokens,
                cost=self.session.cost_usd,
                cost_source=self.session.cost_source,
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
        effort = getattr(self.agent, "reasoning_effort", None) or config.get("default", "reasoning_effort", "medium")
        try:
            self.query_one(StatusBar).update_status(
                tokens=display_tokens,
                cost=self.session.cost_usd,
                cost_source=self.session.cost_source,
                profile=self.agent.profile,
                model=display,
                ctx_limit=ctx_limit,
                estimated=is_estimated,
                session_name=self.session.name,
                permission_mode=active_mode,
                effort=effort,
            )
            # Keep status bar todo progress in sync with session plan
            plan = self.session.load_plan_obj() if hasattr(self, "session") and self.session else None
            if plan:
                from andromity.core.todo import TodoList
                todo_list = TodoList.load(self._project_path)
                done, total = todo_list.progress()
                self.query_one(StatusBar).update_todo_progress(done, total)
            else:
                self.query_one(StatusBar).update_todo_progress(0, 0)
        except Exception:
            pass
        self.query_one(AppFooter).update_footer(cwd=self._project_path, profile=self.agent.profile)

    def refresh_cron_status(self):
        try:
            panel = self.query_one(CronStatusPanel)
            panel.refresh_jobs(self._cron_scheduler.list())
        except Exception:
            pass

    async def _new_session(self):
        """Start a fresh session, preserving the old one in storage."""
        if hasattr(self, "session") and self.session:
            try:
                self.session.flush()
            except Exception:
                pass
        self.session = Session(name="new-session", project_path=self._project_path)
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval,
                           on_questions=self._on_ask_questions, ctx_limit=self._get_ctx_limit())
        self._session_named = False
        chat = self.query_one(ChatPanel)
        await chat.clear()
        # Plan & todos are session-scoped — new session starts with no plan or leftover todos
        try:
            self.query_one(PlanPanel).clear_plan()
            self.query_one(StatusBar).update_todo_progress(0, 0)
            from andromity.core.todo import TodoList
            TodoList(project_path=self._project_path).save()
        except Exception:
            pass
        chat.add_system_message("[green]New session started.[/] Previous session saved.")
        self._update_status()
        self.focus_input()

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
        """Background async worker: runs context compaction on demand (/compact command).

        IMPORTANT: This is an async worker (runs on the event loop), NOT a thread worker.
        Never use call_from_thread() here — call UI methods directly.
        """
        chat = self.query_one(ChatPanel)
        try:
            from andromity.core.provider import stream_completion
            from andromity.core.events import TextDelta

            keep_last_n = 10
            msgs_to_summarize = self.session.messages[1:-keep_last_n]
            if not msgs_to_summarize:
                chat.add_system_message("[dim]Not enough history to compact.[/]")
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

            chat.add_system_message(
                f"[green]✓ Compacted.[/] Replaced {removed} messages with a summary block. "
                f"Working context now has {len(self.session.messages)} messages."
            )
            # Refresh token count + status bar so user sees updated numbers immediately
            self._update_status()

        except Exception as e:
            chat.add_system_message(f"[red]Compact failed:[/] {e}")


    async def _load_session(self, session: Session):
        """Switch to a historical session and replay its chat history."""
        if hasattr(self, "session") and self.session:
            try:
                self.session.flush()
            except Exception:
                pass
        self.session = session
        self.agent = Agent(self.session, profile=self.agent.profile, on_tool_approval=self._on_tool_approval,
                           on_questions=self._on_ask_questions, ctx_limit=self._get_ctx_limit())
        self._session_named = True  # already named
        chat = self.query_one(ChatPanel)
        await chat.load_history(session.messages, getattr(session, "compacted_history", None))
        self._update_status()
        # Load plan from session (if any)
        try:
            plan = session.load_plan_obj()
            panel = self.query_one(PlanPanel)
            if plan:
                panel.load_plan(plan)
                from andromity.core.todo import TodoList
                todo_list = TodoList.load(self._project_path)
                done, total = todo_list.progress()
                self.query_one(StatusBar).update_todo_progress(done, total)
            else:
                panel.clear_plan()
                self.query_one(StatusBar).update_todo_progress(0, 0)
        except Exception:
            pass
        chat.add_system_message(
            f"[green]Session loaded:[/] [bold]{session.name}[/]  "
            f"[dim]({len(session.messages)} messages, {session.token_total:,} tokens)[/]"
        )
        self.focus_input()

    def _update_command_palette(self, text: str):
        """Show the slash-command palette while the user types a `/command`
        prefix (no arguments yet); hide it once args or non-command text appear."""
        palette = self.query_one("#command-palette", CommandPalette)
        if text.startswith("/") and " " not in text[1:] and "/" not in text[1:]:
            palette.show_commands(text[1:])
        else:
            palette.hide_commands()

    def action_escape_pressed(self):
        import time
        # Esc belongs to whatever modal is on top. Modals stop the event in
        # their own handlers; this guard is the safety net so a modal's Esc
        # can never count toward cancelling a streaming AI response.
        try:
            if len(self.screen_stack) > 1:
                return
        except Exception:
            pass
        # If question panel is open, let escape skip questions rather than cancel agent
        try:
            panel = self.query_one("#question-panel", QuestionPanel)
            if panel.is_open():
                panel.action_skip()
                return
        except Exception:
            pass
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
        # Queue entries are (prompt, images) tuples — show just the prompt text.
        panel.update_queue([p for p, _ in self._prompt_queue])

    def _remove_from_queue(self, index: int):
        """Remove a message from the queue by index."""
        if 0 <= index < len(self._prompt_queue):
            self._prompt_queue.pop(index)
            self._update_queue_display()
            chat = self.query_one(ChatPanel)
            chat.add_system_message(f"[dim]Removed message #{index+1} from queue.[/]")

    async def _stream_agent(self, prompt: str, images: list | None = None):
        chat = self.query_one(ChatPanel)
        status_bar = self.query_one(StatusBar)
        status_bar.set_streaming(True)
        self._is_streaming = True
        self._current_task = asyncio.current_task()
        log.info("USER: %s", prompt[:200])

        # Images are passed as raw paths/bytes to agent.run() which handles
        # its own encoding via build_image_data_uri — no pre-conversion here.
        turn_started = time.time()
        tool_calls_count = 0
        estimated_tokens = 0
        first_text_seen = False
        new_files_created = False  # True only when write_file creates a brand-new file

        tools_used = set()  # track which tools were called this stream

        # ── UI feedback FIRST — zero perceived lag ────────────────────────────
        # Show "thinking" state immediately before any blocking work.
        msg_count_before = len(self.session.messages)
        self._pre_write_contents.clear()  # fresh file-content tracking for this turn
        chat.start_assistant_message()

        # ── Pre-turn checkpoint (for /undo) — runs in thread, never blocks UI ─
        # asyncio.to_thread offloads the git subprocess calls (git add -A,
        # write-tree, commit-tree) to the OS thread pool so the event loop
        # and TUI stay fully responsive while the snapshot is created.
        snapshot_hash: str | None = None
        try:
            def _take_snapshot() -> str | None:
                from andromity.core.git_ops import ensure_git_tracking, create_pre_edit_snapshot
                repo, _ = ensure_git_tracking(Path(self._project_path))
                return create_pre_edit_snapshot(repo)
            snapshot_hash = await asyncio.to_thread(_take_snapshot)
        except Exception as snap_err:
            log.warning("Pre-turn snapshot failed: %s", snap_err)

        self._undo_stack.append({
            "snapshot_hash": snapshot_hash,
            "msg_count": msg_count_before,
            "prompt": prompt[:20000] if len(prompt) > 20000 else prompt,
        })
        self._pre_turn_snapshot = snapshot_hash
        if len(self._undo_stack) > 20:
            self._undo_stack.pop(0)

        try:
            async for event in self.agent.run(prompt, images=images or None):
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
                    tools_used.add(event.tool_name)
                    tool_calls_count += 1
                    log.debug("TOOL START: %s", event.tool_name)
                    if self._debug_mode:
                        chat.add_system_message(f"[dim]▶ tool: {event.tool_name}[/]")
                    chat.show_tool_start(event.tool_name, event.tool_id)
                elif isinstance(event, ToolCallDelta):
                    chat.append_tool_args(event.tool_id, event.args_json_chunk)
                elif isinstance(event, ToolCallEnd):
                    log.debug("TOOL END: %s", event.tool_id)
                    chat.show_tool_end(event.tool_id)
                elif isinstance(event, ToolResult):
                    log.debug("TOOL RESULT: %s", event.tool_id)
                    chat.show_tool_result(event.tool_id, event.result)
                    
                    # Look up this tool's own args from its indicator — with
                    # parallel tool calls, active_tool_name/args only hold the
                    # last tool that started.
                    try:
                        from andromity.tui.panels.chat import ToolIndicator
                        for ind in chat.query(ToolIndicator):
                            if ind.tool_id == event.tool_id:
                                if ind.tool_name in ("write_file", "edit_file", "edit_file_multi", "delete_file", "shell_exec"):
                                    import json
                                    try:
                                        args = json.loads(ind._args_json)
                                        target_path = args.get("path") or args.get("target_path") or args.get("target_file")
                                        if target_path:
                                            abs_path = Path(target_path).absolute()
                                            # Track if this write_file created a genuinely new file
                                            # (didn't exist before the tool ran — needs tree rebuild)
                                            if ind.tool_name == "write_file" and not abs_path.exists():
                                                new_files_created = True
                                            if ind.tool_name == "delete_file":
                                                new_files_created = True
                                            self.query_one(FileTreePanel).highlight_recent_change(abs_path)
                                    except Exception:
                                        pass
                                break
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
                
                # Token count is updated at Done (real usage from API).
                # No mid-stream status rebuilds needed.

        except asyncio.CancelledError:
            log.info("Stream cancelled by user")
        except Exception as e:
            log.error("Unhandled exception in _stream_agent: %s", e, exc_info=True)
            _err_msg = str(e)
            if len(_err_msg) > 160:
                _err_msg = _err_msg[:157] + "..."
            chat.append_text(f"\n[Unexpected error: {type(e).__name__}] {_err_msg}\n")
        finally:
            self._current_task = None
            self._is_streaming = False
            status_bar.set_streaming(False)
            chat.stop_thinking_message()
            chat.end_assistant_message()
            self._update_status()

            # Show how long the response took as a distinct colored footnote,
            # e.g. "⏱ 3.5s · 4 tool calls" (kept separate from the AI text)
            try:
                elapsed = time.time() - turn_started
                chat.add_response_time(elapsed, tool_calls_count)
            except Exception:
                pass
            
            # Play done sound if enabled
            from andromity.config import config as _cfg
            try:
                if _cfg.get("default", "sound_done", True):
                    from andromity.core.audio import play_sound
                    play_sound("done.wav")
            except Exception:
                pass
            
            # Refresh file tree only if a new file was created or a file was deleted.
            # Plain edits (edit_file, edit_file_multi, write_file to existing path) are
            # already reflected by highlight_recent_change() during the stream — a full
            # rebuild is not needed and causes the visible flicker/reload the user sees.
            if new_files_created:
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
                
            # Trigger batch review if files were modified in safe mode.(not for trust mode)
            # NOTE: We check _pending_batch_files only — NOT _pre_turn_snapshot.
            # The snapshot is only needed for the Reject revert; the overlay must
            # still open even when git is unavailable (non-git folder, snap failed).
            if getattr(self, "_pending_batch_files", None):
                files_to_review = list(self._pending_batch_files)
                self._pending_batch_files.clear()

                mode = config.get("default", "permission_mode", "safe")
                if mode in ("full", "trust", "yolo"):
                    # These modes auto-approve writes — just confirm silently
                    if files_to_review:
                        chat.add_system_message(f"[green]✓ {len(files_to_review)} file(s) saved.[/]")
                elif mode == "safe":
                    snapshot = getattr(self, "_pre_turn_snapshot", None)
                    def _on_batch_review(accepted: bool | None):
                        if accepted:
                            chat.add_system_message(f"[green]✓ Batch review accepted for {len(files_to_review)} files.[/]")
                        else:
                            chat.add_system_message("[yellow]⚠ Batch review completed. Unaccepted files were reverted.[/]")
                            try:
                                self.query_one(FileTreePanel).refresh_tree()
                            except Exception:
                                pass

                    self.push_screen(
                        BatchReviewOverlay(
                            self._project_path,
                            snapshot,
                            files_to_review,
                            pre_write_contents=dict(self._pre_write_contents),
                        ),
                        _on_batch_review,
                    )
                
            if self._prompt_queue:
                next_prompt, next_images = self._prompt_queue.pop(0)
                self._update_queue_display()
                # Process next queued message after a short delay (survives cancel better)
                self.set_timer(0.3, lambda p=next_prompt, imgs=next_images: self._process_message(p, imgs))
            else:
                self.focus_input()

    @on(InputBar.Submitted)
    def on_input_submitted(self, event: InputBar.Submitted):
        prompt = event.text.strip()
        images = event.images or []
        if not prompt and not images:
            return
        self._esc_count = 0
        self.query_one("#command-palette", CommandPalette).hide_commands()
        try:
            self.query_one("#skill-mentions", SkillMentionPanel).hide()
        except Exception:
            pass
        
        # Slash commands always execute regardless of whether a model is configured
        if prompt.startswith("/"):
            self._process_message(prompt)
            return

        # Guard: no model configured for natural language chatting
        model = config.get("default", "model", "")
        if not model:
            chat = self.query_one(ChatPanel)
            chat.add_system_message(
                "[red]No model selected.[/] Please choose a provider and model first:\n"
                "  [bold cyan]/model[/] or [bold]Ctrl+L[/]"
            )
            return

        if self._is_streaming:
            if getattr(event, "steer", False):
                # STEER: Immediately cancel active response and inject new instruction
                if self._current_task and not self._current_task.done():
                    self._current_task.cancel()
                chat = self.query_one(ChatPanel)
                chat.add_system_message("[bold $primary]Steered agent with new instruction[/]")
                self._process_message(prompt, images)
                return

            if len(self._prompt_queue) >= 10:
                self.query_one(ChatPanel).add_system_message("Queue is full (max 10). Please wait for the agent to finish.")
                return

            self._prompt_queue.append((prompt, images))
            log.info("Queued: %s (queue size: %d)", prompt[:50], len(self._prompt_queue))
            self._update_queue_display()
            return
            
        self._process_message(prompt, images)

    def _process_message(self, prompt: str, images: list | None = None):
        chat = self.query_one(ChatPanel)
        chat.clear_ephemeral()
        
        if prompt.startswith("/"):
            self._handle_command(prompt)
        else:
            # Turn @skill mentions into explicit attach directives.
            try:
                from andromity.core.skills import SkillsManager, attach_skill_mentions
                prompt = attach_skill_mentions(prompt, SkillsManager(self._project_path))
            except Exception:
                pass
            chat.add_user_message(prompt, image_count=len(images) if images else 0)
            # Auto-name session from the first user message
            if not self._session_named:
                self._session_named = True
                name = Session.auto_name_from_message(prompt)
                self.session.rename(name)
                self._update_status()
                asyncio.create_task(self._generate_ai_session_name(prompt))
            self.run_worker(self._stream_agent(prompt, images), exclusive=False)

    @on(TextArea.Changed, "#input-field")
    def on_input_changed(self, event: TextArea.Changed):
        self._update_command_palette(event.text_area.text)
        # @skill mention completion (hidden while typing a slash command)
        try:
            panel = self.query_one("#skill-mentions", SkillMentionPanel)
            if event.text_area.text.startswith("/"):
                panel.hide()
            else:
                panel.update_query(mention_query(event.text_area.text, event.text_area.cursor_location))
        except Exception:
            pass

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
                {"role": "system", "content": """You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service"""},
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
                from andromity.core.profiles import PROFILES
                profile = parts[1].strip().lower()
                if profile in PROFILES:
                    self._apply_profile(profile)
                else:
                    chat.add_system_message(
                        f"Unknown profile: {profile}. Use {', '.join(PROFILES)}."
                    )
            else:
                # Open profile picker overlay
                self.action_toggle_profile()
        elif command in ("/reason", "/effort"):
            if len(parts) > 1 and parts[1].strip():
                effort_arg = parts[1].strip().lower()
                if effort_arg in ("off", "low", "medium", "high", "xhigh", "max"):
                    self.on_reasoning_effort_changed(effort_arg)
                    self._update_status()
                else:
                    chat.add_system_message(f"Unknown effort level: {effort_arg}. Choose: off, low, medium, high, xhigh, max")
            else:
                try:
                    self.query_one(StatusBar)._cycle_effort()
                except Exception:
                    pass
        elif command == "/update":
            self.action_run_update()
        elif command in ("/context-menu", "/context"):
            from andromity.core.context_menu import install_context_menu, remove_context_menu, is_context_menu_installed
            subcmd = parts[1].strip().lower() if len(parts) > 1 else ""
            if subcmd == "install":
                ok, msg = install_context_menu()
                chat.add_system_message(f"[{'green' if ok else 'red'}]{msg}[/]")
            elif subcmd in ("remove", "uninstall"):
                ok, msg = remove_context_menu()
                chat.add_system_message(f"[{'green' if ok else 'red'}]{msg}[/]")
            else:
                installed = is_context_menu_installed()
                status_str = "[bold green]Installed[/]" if installed else "[yellow]Not Installed[/]"
                chat.add_system_message(
                    f"Windows Context Menu Status: {status_str}\n\n"
                    "Usage:\n"
                    "  [bold cyan]/context-menu install[/] — Add 'Open in Andromity' to right-click menu\n"
                    "  [bold cyan]/context-menu remove[/]  — Remove from right-click menu"
                )
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
            self.run_worker(self._new_session())
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
            try:
                self.query_one(AppFooter).set_trust_state(True)
            except Exception:
                pass
            chat.add_system_message(f"[green]✓ Folder trusted:[/] {self._project_path}\nFull file access and shell commands are now enabled.")
        elif command == "/untrust":
            config.revoke_trust(self._project_path)
            try:
                self.query_one(AppFooter).set_trust_state(False)
            except Exception:
                pass
            chat.add_system_message(f"[yellow]Folder untrusted:[/] {self._project_path}\nFile writes and shell commands are now blocked.")
        elif command == "/export":
            arg = parts[1].strip().strip('"\'') if len(parts) > 1 else ""
            from andromity.core.export import export_session
            try:
                out_path = export_session(self.session, output_path=arg, project_path=self._project_path)
                path_str = str(out_path)
                self.notify(
                    f"Session exported to {path_str}",
                    title="Export complete",
                    severity="information",
                    timeout=5,
                )
                chat.add_system_message(
                    f"[green]✓ Session exported:[/] [link=file://{path_str}]{escape(path_str)}[/link]"
                )
            except ValueError as e:
                chat.add_system_message(f"[red]{escape(str(e))}[/]\n[dim]Usage: /export [filename.md|filename.html|filename.json][/]")
            except OSError as e:
                log.error("Export failed: %s", e)
                chat.add_system_message(f"[red]✗ Export failed:[/] {escape(str(e))}")
        elif command == "/clear":
            self.run_worker(chat.clear())
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
            self.push_screen(HelpScreen())
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
            from andromity.tui.overlays.settings import SettingsScreen
            self.push_screen(SettingsScreen(self._mcp_manager, self._project_path))
        elif command == "/skills":
            from andromity.tui.overlays.skills import SkillsScreen
            self.push_screen(SkillsScreen(self._project_path))
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
                    elif status == "needs_auth":
                        icon = "[bold yellow]⚠[/]"
                        status_str = "[yellow]needs token[/] [dim]— authenticate in Settings → MCP[/]"
                    elif status == "disabled":
                        icon = "[dim]◌[/]"
                        status_str = "[dim]disabled[/]"
                    elif status == "initializing":
                        icon = "[cyan]⟳[/]"
                        status_str = "[cyan]starting…[/]"
                    elif status == "error":
                        icon = "[bold red]✗[/]"
                        status_str = f"[red]error[/] [dim]{escape(err or '')}[/]"
                    else:
                        icon = "[dim]○[/]"
                        status_str = "[dim]stopped[/]"
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
                lines.append(f"[dim]Config: .andromity/mcp.json  |  Manage servers in Settings → MCP[/]")
                chat.add_system_message("\n".join(lines))
        elif command == "/attach":
            if len(parts) > 1 and parts[1].strip():
                raw = parts[1].strip().strip('"').strip("'")
                from pathlib import Path as _Path
                p = _Path(raw).expanduser()
                if not p.is_file():
                    chat.add_system_message(f"[red]File not found:[/] {escape(raw)}")
                else:
                    try:
                        ok = self.query_one(InputBar).attach_path(p)
                    except Exception as e:
                        ok = False
                        chat.add_system_message(f"[red]Could not attach image:[/] {e}")
                    if ok:
                        chat.add_system_message(f"[green]✓ Image attached:[/] {escape(str(p))}\n[dim]Now type your question and press Enter.[/]")
            else:
                chat.add_system_message(
                    "Usage: /attach <path-to-image>\n"
                    "Example: /attach C:\\Users\\you\\Pictures\\shot.png"
                )
        elif command == "/undo":
            self._run_undo()
        elif command in ("/tips", "/tip"):
            subtag = parts[1].strip().lstrip("#") if len(parts) > 1 and parts[1].strip() else None
            self.run_worker(self._handle_tip_command(subtag))
        elif command == "/news":
            self.run_worker(self._handle_news_command())
        elif command in (
            "/void", "/tao", "/roast", "/council", "/trial", "/sus", "/mirror",
            "/graveyard", "/archaeology", "/founder", "/matrix", "/zombie",
            "/secret", "/oracle", "/ghost"
        ):
            sub_prompt = parts[1].strip() if len(parts) > 1 else ""
            self.run_worker(self._handle_lore_command(command, sub_prompt))
        else:
            chat.add_system_message(f"Unknown: {command}. Type /help")

    async def _handle_tip_command(self, tag: str | None = None):
        chat = self.query_one(ChatPanel)
        from andromity.core.lore import fetch_random_tip
        data = await fetch_random_tip(tag)
        if data and data.get("tip"):
            tag_str = f" [dim cyan]#{escape(data.get('tag', 'dev'))}[/]" if data.get('tag') else ""
            season_str = f"\n[dim yellow]{escape(data.get('season'))}[/]" if data.get('season') else ""
            tip_content = data['tip']
            tip_formatted = re.sub(r'`([^`]+)`', r'[bold cyan]\1[/]', tip_content)
            chat.add_system_message(
                f"[bold cyan]💡 Developer Tip[/]{tag_str}\n\n"
                f"{tip_formatted}"
                f"{season_str}"
            )
        else:
            chat.add_system_message(
                "💡 [bold cyan]Developer Tip[/]\n\n"
                "Keep functions small, test boundaries, and use [bold cyan]/cron[/] for autonomous scheduled maintenance."
            )

    async def _handle_news_command(self):
        chat = self.query_one(ChatPanel)
        from andromity.core.lore import fetch_latest_news
        data = await fetch_latest_news()
        if data and data.get("version"):
            lines = [f"[bold green]📢 {data.get('title', 'Andromity News')}[/]\n"]
            if data.get("season_banner"):
                lines.append(f"[yellow]{data['season_banner']}[/]\n")
            for h in data.get("highlights", []):
                lines.append(f"  • {h}")
            if data.get("docs_url"):
                lines.append(f"\n[dim]GitHub: {data['docs_url']}[/dim]")
            chat.add_system_message("\n".join(lines))
        else:
            chat.add_system_message(
                "[bold green]📢 Andromity 0.2.3[/]\n"
                "• Built-in Cron Scheduler for autonomous scheduled runs\n"
                "• MCP Tool Support & Dynamic Profiles\n"
                "• Real-time Telemetry & Edge Intelligence"
            )

    async def _handle_lore_command(self, command: str, user_query: str):
        chat = self.query_one(ChatPanel)
        from andromity.core.lore import fetch_lore_directive
        lore = await fetch_lore_directive(command)

        if not lore or not lore.get("directive"):
            chat.add_system_message(f"Unknown: {command}. Type /help")
            return

        cmd_name = command.lstrip("/")
        prompt_display = f"/{cmd_name}" + (f" {user_query}" if user_query else "")
        chat.add_user_message(prompt_display)

        directive_text = lore["directive"]
        if lore.get("seasonal_modifier"):
            directive_text += f"\n\n[Active Season Event: {lore.get('seasonal', 'seasonal')}]\n{lore['seasonal_modifier']}"

        combined_prompt = (
            f"<special_instruction>\n{directive_text}\n</special_instruction>\n\n"
            + (f"User query / context: {user_query}" if user_query else "Execute your directive on the active repository or problem context.")
        )

        self.run_worker(self._stream_agent(combined_prompt, None), exclusive=False)


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
        from andromity.tui.overlays.settings import SettingsScreen
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
        if getattr(self, "_undo_in_progress", False):
            chat.add_system_message("[yellow]Undo operation is already in progress.[/]")
            return
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
          2. Trim session.messages back to pre-turn state and reset context tokens.
          3. Reload the visual chat panel so chat & prompt context are cleanly rolled back.
          4. Restore the undone prompt into the user input bar.
        """
        if getattr(self, "_undo_in_progress", False) or not self._undo_stack:
            return
        self._undo_in_progress = True
        checkpoint = self._undo_stack.pop()
        self.run_worker(self._async_perform_undo(checkpoint), exclusive=True)

    async def _async_perform_undo(self, checkpoint: dict):
        try:
            snapshot_hash = checkpoint.get("snapshot_hash")
            msg_count = checkpoint.get("msg_count", 0)
            undone_prompt = checkpoint.get("prompt", "")

            # ── 1. Revert file changes (in background thread) ─────────────────
            files_reverted = False
            if snapshot_hash:
                try:
                    from andromity.core.git_ops import get_repo, restore_snapshot
                    def _restore():
                        repo = get_repo(Path(self._project_path))
                        if repo:
                            return restore_snapshot(repo, snapshot_hash)
                        return False
                    files_reverted = await asyncio.to_thread(_restore)
                except Exception as e:
                    log.warning("Undo file revert failed: %s", e)

            # ── 2. Trim session messages & recalculate context tokens ─────────
            if msg_count <= len(self.session.messages):
                self.session.messages = self.session.messages[:msg_count]
                self.session.context_tokens = sum(
                    len(str(msg.get("content", ""))) // 4 for msg in self.session.messages
                )
                self.session.save()

            # ── 3. Clean visual chat panel rollback (await before system msg) ─
            chat = self.query_one(ChatPanel)
            try:
                await chat.load_history(self.session.messages, getattr(self.session, "compacted_history", None))
            except Exception as e:
                log.warning("Failed to reload chat history: %s", e)

            # ── 4. Refresh Sidebar UI & Diff ──────────────────────────────────
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
                f"{file_note}│ [dim]Conversation rolled back to {len(self.session.messages)} messages[/] │ [cyan]Prompt restored to input[/]"
            )

            # ── 5. Restore prompt into the user input box ─────────────────────
            try:
                input_field = self.query_one("InputBar").query_one("#input-field", TextArea)
                input_field.text = undone_prompt
                input_field.move_cursor(input_field.get_cursor_line_end_location())
                self.focus_input()
            except Exception:
                pass

            self._update_status()
        finally:
            self._undo_in_progress = False
