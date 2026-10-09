import asyncio
import hashlib
import inspect
import json
import logging
import os
import sys
import time
import traceback
import uuid
from copy import deepcopy
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Set

from andromity import __version__
from andromity.config import config, get_config_dir
from andromity.core.agent import Agent

READ_ONLY_TOOLS = {
    # Core read-only filesystem & search inspection
    "read_file", "view_file", "find_files", "grep_search", "list_dir",
    # Shell background process inspection
    "shell_read", "shell_list",
    # Tool discovery
    "list_tools",
    # Planning & interactive tools (safe non-code-mutating)
    "write_plan", "update_plan_step", "ask_questions", "ask_question",
    # Session & multi-agent coordination read-only tools
    "session_list", "session_read_messages", "shared_state_get", "read_handoff",
}
SESSION_DRIVING_TOOLS = {
    "session_send_message", "session_ask_question", "session_broadcast",
    "shared_state_set", "write_handoff",
}
_MODE_RANK = {"safe": 0, "trust": 1, "full": 2, "yolo": 3}
CRON_SEED_PRESET_NAMES = {"Run Tests & Verify Build", "Daily Code Health & TODO Scanner"}
from andromity.core.events import (
    Done,
    InputApplied,
    HandoffWritten,
    LLMCallEnd,
    LLMCallStart,
    PlanApprovalRequired,
    PlanUpdated,
    SessionAnswerReceived,
    SessionMessageReceived,
    SessionQuestionReceived,
    SharedStateChanged,
    StreamEvent,
    SubAgentDone,
    SubAgentFailed,
    SubAgentProgress,
    SubAgentSpawned,
    TextDelta,
    ThinkingDelta,
    ToolCallDelta,
    ToolCallEnd,
    ToolCallStart,
    ToolResult,
)
from andromity.core.git_ops import (
    create_pre_edit_snapshot,
    ensure_git_tracking,
    get_repo,
    restore_snapshot,
    list_snapshots,
    get_git_status,
)
from andromity.core.models import (
    MODEL_CATALOG,
    get_context_limit_for_model,
    fetch_live_models_sync,
    get_cached_live_models,
)
from andromity.core.session import Session
from andromity.server.runtime import SessionRuntime
from andromity.server.protocol import (
    AGENT_BUSY,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    METHOD_NOT_FOUND,
    SESSION_NOT_FOUND,
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
)

log = logging.getLogger("andromity.server")


class JsonRpcHandler:
    """Core RPC Handler managing agent execution, sessions, tools, and multi-client sync."""

    def __init__(self, send_notification: Optional[Callable[[JsonRpcNotification], Any]] = None):
        self.send_notification = send_notification
        self._active_sessions: Dict[str, Session] = {}
        self._running_tasks: Dict[str, asyncio.Task] = {}
        self._runtime = SessionRuntime()
        self._pending_approvals: Dict[str, Any] = {}
        self._pending_questions: Dict[str, Any] = {}
        self._pending_plan_approvals: Dict[str, asyncio.Future] = {}
        self._cron_schedulers: Dict[str, Any] = {}
        self._active_agents: Dict[str, Any] = {}
        self._input_queues: Dict[str, Any] = {}
        self._input_locks: Dict[str, asyncio.Lock] = {}
        self._last_prompt_requests: Dict[str, Dict[str, Any]] = {}
        self._git_mutating_roots: Set[str] = set()
        self._mcp_manager: Optional[Any] = None
        self._mcp_started: bool = False
        self._user_killed_processes: Set[str | tuple[str, str]] = set()
        try:
            self._loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        from andromity.core.session_bus import SessionBus
        SessionBus.get_instance().subscribe(self._on_session_bus_event)
        from andromity.core import tools as _tools_mod
        _tools_mod.register_process_started_callback(self._on_process_started)
        _tools_mod.register_process_exited_callback(self._on_process_exited)

    def _on_session_bus_event(self, event: StreamEvent):
        if isinstance(event, SessionMessageReceived):
            self.notify("session/messageReceived", {
                "from_session": event.from_session,
                "to_session": event.to_session,
                "from_session_id": getattr(event, "from_session_id", ""),
                "to_session_id": getattr(event, "to_session_id", ""),
                "content": event.content,
                "message_type": event.message_type,
                "timestamp": event.timestamp,
            })
        elif isinstance(event, SessionQuestionReceived):
            self.notify("session/questionReceived", {
                "question_id": event.question_id,
                "from_session": event.from_session,
                "to_session": event.to_session,
                "from_session_id": getattr(event, "from_session_id", ""),
                "to_session_id": getattr(event, "to_session_id", ""),
                "question": event.question,
                "timestamp": event.timestamp,
            })
            to_sid = getattr(event, "to_session_id", "")
            if to_sid:
                auto_prompt = (
                    f"[Incoming Question from co-agent '{event.from_session}' (ID: {event.question_id})]:\n"
                    f"\"{event.question}\"\n\n"
                    f"Please address this question, perform any required actions or tools, and provide an answer using "
                    f"session_answer_question(question_id='{event.question_id}', answer='...')."
                )
                asyncio.create_task(self._handle_auto_awake(
                    target_session_id=to_sid,
                    from_session=event.from_session,
                    from_session_id=getattr(event, "from_session_id", ""),
                    prompt_content=auto_prompt,
                    trigger_type="question",
                    question_id=event.question_id,
                ))
        elif isinstance(event, SessionAnswerReceived):
            self.notify("session/answerReceived", {
                "question_id": event.question_id,
                "from_session": event.from_session,
                "to_session": event.to_session,
                "from_session_id": getattr(event, "from_session_id", ""),
                "to_session_id": getattr(event, "to_session_id", ""),
                "answer": event.answer,
                "timestamp": event.timestamp,
            })
        elif isinstance(event, SharedStateChanged):
            self.notify("session/sharedStateChanged", {
                "key": event.key,
                "value": event.new_value,
                "author_session": event.author_session,
                "timestamp": event.timestamp,
            })
        elif isinstance(event, HandoffWritten):
            h_id = getattr(event, "handoff_id", getattr(event, "phase", ""))
            to_sess = getattr(event, "to_session", "")
            summary = getattr(event, "task_summary", getattr(event, "summary", ""))
            self.notify("session/handoffWritten", {
                "handoff_id": h_id,
                "from_session": event.from_session,
                "to_session": to_sess,
                "task_summary": summary,
                "timestamp": event.timestamp,
            })
            if to_sess:
                from andromity.core.session_bus import SessionBus
                to_sid = SessionBus.get_instance().resolve_session_id(to_sess)
                if to_sid:
                    auto_prompt = (
                        f"[Incoming Task Handoff from co-agent '{event.from_session}' (Phase: {getattr(event, 'phase', h_id)})]:\n"
                        f"Summary: {summary}\n\n"
                        f"Please review the handoff details with read_handoff(phase='{getattr(event, 'phase', '')}'), take any necessary actions, and report progress."
                    )
                    asyncio.create_task(self._handle_auto_awake(
                        target_session_id=to_sid,
                        from_session=event.from_session,
                        from_session_id="",
                        prompt_content=auto_prompt,
                        trigger_type="handoff",
                    ))

    def _on_process_started(self, info: dict):
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self.notify, "process/started", info)
        else:
            self.notify("process/started", info)

    def _on_process_exited(self, info: dict):
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._handle_process_exit_threadsafe, info)
        else:
            self._handle_process_exit_threadsafe(info)

    def _handle_process_exit_threadsafe(self, info: dict):
        self.notify("process/exited", info)
        session_id = info.get("session_id")
        pid_str = info.get("process_id", "")
        scoped_pid = (session_id, pid_str)
        was_user_killed = scoped_pid in self._user_killed_processes or pid_str in self._user_killed_processes
        if was_user_killed:
            self._user_killed_processes.discard(pid_str)
            self._user_killed_processes.discard(scoped_pid)
        if session_id:
            exit_code = info.get("exit_code", 0)
            cmd_str = info.get("command", "")
            if was_user_killed:
                prompt_content = (
                    f"[User Action]: Background process '{pid_str}' (Command: `{cmd_str}`) "
                    f"was manually stopped by the user."
                )
            else:
                prompt_content = (
                    f"[Background Process Notification]:\n"
                    f"Process '{pid_str}' (Command: `{cmd_str}`) has finished with exit code {exit_code}.\n"
                    f"Use shell_read('{pid_str}') to review its final output if needed."
                )
            coro = self._handle_auto_awake(
                target_session_id=session_id,
                from_session=f"bg_proc_{pid_str}",
                from_session_id="",
                prompt_content=prompt_content,
                trigger_type="process_exit",
            )
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(coro)
            except RuntimeError:
                if self._loop and self._loop.is_running():
                    asyncio.run_coroutine_threadsafe(coro, self._loop)
                else:
                    try:
                        coro.close()
                    except Exception:
                        pass

    async def _handle_auto_awake(
        self,
        target_session_id: str,
        from_session: str,
        from_session_id: str,
        prompt_content: str,
        trigger_type: str = "question",
        question_id: Optional[str] = None,
    ):
        """Evaluate auto-wake rules, circuit breaker, and dispatch reactive turn if allowed."""
        if not target_session_id:
            return

        session = self._active_sessions.get(target_session_id)
        if not session:
            try:
                session = self._get_or_load_session(target_session_id)
            except Exception as e:
                log.warning("Auto-wake: failed to load target session %s: %s", target_session_id, e)
                return

        # 1. If session is already actively executing a turn, do not auto-wake
        if session.id in self._running_tasks and not self._running_tasks[session.id].done():
            log.info("Auto-wake: session %s is already running a turn; skipping wake.", session.id)
            return

        if not config.is_trusted(session.project_path):
            log.info("Auto-wake: session %s is in an untrusted folder; skipping wake.", session.id)
            return

        # 2. Check watching / auto-wake eligibility
        status = getattr(session, "status", "idle")
        if status not in ("watching", "idle", "cancelled", "error"):
            log.info("Auto-wake: session %s status is '%s'; skipping wake.", session.id, status)
            return

        # 3. Check Circuit Breaker (Max consecutive auto-wakes)
        max_auto_wakes = int(config.get("collaboration", "max_auto_wakes", 2))
        current_wakes = getattr(session, "consecutive_auto_wakes", 0)

        if current_wakes >= max_auto_wakes:
            session.set_status("paused_limit_reached")
            session.save()
            log.warning("Auto-wake circuit breaker tripped for session %s (count=%s, max=%s)", session.id, current_wakes, max_auto_wakes)
            self.notify("session/autoWakeLimitReached", {
                "session_id": session.id,
                "current_wakes": current_wakes,
                "max_auto_wakes": max_auto_wakes,
                "from_session": from_session,
                "from_session_id": from_session_id,
                "question_id": question_id,
            })
            self.notify("session/updated", {
                "session_id": session.id,
                "status": "paused_limit_reached",
                "consecutive_auto_wakes": current_wakes,
                "collaborators": getattr(session, "collaborators", []),
            })
            return

        # 4. Increment circuit breaker counter and record collaborator link
        session.consecutive_auto_wakes = current_wakes + 1
        if trigger_type != "process_exit":
            if not hasattr(session, "collaborators") or session.collaborators is None:
                session.collaborators = []
            if from_session and from_session not in session.collaborators:
                session.collaborators.append(from_session)
        session.save()

        # Update sender's collaborators as well for bidirectional UI link
        if from_session_id:
            sender = self._active_sessions.get(from_session_id)
            if sender:
                if not hasattr(sender, "collaborators") or sender.collaborators is None:
                    sender.collaborators = []
                if session.name and session.name not in sender.collaborators:
                    sender.collaborators.append(session.name)
                    sender.save()
                    self.notify("session/updated", {
                        "session_id": sender.id,
                        "collaborators": sender.collaborators,
                    })

        log.info("Auto-waking session %s from '%s' (%s/%s auto-wakes)", session.id, from_session, session.consecutive_auto_wakes, max_auto_wakes)

        # Notify UI of auto-wake activity
        self.notify("session/updated", {
            "session_id": session.id,
            "status": "running",
            "consecutive_auto_wakes": session.consecutive_auto_wakes,
            "collaborators": session.collaborators,
        })

        # 5. Dispatch turn with the target's own settings. Without them the turn would fall back to
        # global defaults, so a SAFE/planner session could be woken as a FULL/YOLO builder by another
        # session's content. Woken turns are also capped at TRUST because nobody asked for them.
        own_mode = (getattr(session, "permission_mode", "") or "safe").lower()
        wake_mode = own_mode if _MODE_RANK.get(own_mode, 0) <= _MODE_RANK["trust"] else "trust"
        wake_params: Dict[str, Any] = {
            "session_id": session.id,
            "prompt": prompt_content,
            "project_path": session.project_path,
            "is_auto_wake": True,
            "mode": wake_mode,
            "profile": getattr(session, "profile", "") or "builder",
        }
        if getattr(session, "provider", "") and getattr(session, "model", ""):
            wake_params["provider"] = session.provider
            wake_params["model"] = session.model
        try:
            await self.rpc_agent_prompt(wake_params)
        except Exception as e:
            log.exception("Auto-wake execution failed for session %s: %s", session.id, e)
            session.set_status("idle")
            self.notify("session/updated", {"session_id": session.id, "status": "idle"})
            return
        if wake_mode != own_mode:
            # rpc_agent_prompt stores the mode it ran with; keep the user's own choice for their next prompt.
            session.permission_mode = own_mode
            session.save()

    def notify(self, method: str, params: Dict[str, Any]):
        """Send a JSON-RPC notification to the client in a thread-safe manner."""
        params = self._runtime.observe(method, params)
        if not self.send_notification:
            return
        notif = JsonRpcNotification(method=method, params=params)
        res = self.send_notification(notif)
        if inspect.isawaitable(res):
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(res)
            except RuntimeError:
                if self._loop and self._loop.is_running():
                    asyncio.run_coroutine_threadsafe(res, self._loop)
                else:
                    try:
                        res.close()
                    except Exception:
                        pass

    async def handle_request(self, request: JsonRpcRequest) -> Optional[JsonRpcResponse]:
        """Dispatch a single JSON-RPC request to its corresponding handler."""
        method_name = request.method.replace(".", "_").replace("/", "_")
        handler = getattr(self, f"rpc_{method_name}", None)

        if handler is None:
            if request.is_notification():
                return None
            return JsonRpcResponse.err(
                request.id,
                METHOD_NOT_FOUND,
                f"Method '{request.method}' not found",
            )

        try:
            result = await handler(request.params)
            if request.is_notification():
                return None
            return JsonRpcResponse.ok(request.id, result)
        except asyncio.CancelledError:
            if request.is_notification():
                return None
            return JsonRpcResponse.err(request.id, -32000, "Request cancelled")
        except Exception as e:
            log.exception("Error executing RPC method %s: %s", request.method, e)
            if request.is_notification():
                return None
            err_msg = str(e)
            # Prevent leaking local system usernames, file paths, or raw DB operational queries
            if (
                "OperationalError" in type(e).__name__
                or "sqlite3" in type(e).__name__.lower()
                or "\\Users\\" in err_msg
                or "/home/" in err_msg
                or "/Users/" in err_msg
            ):
                err_msg = f"Internal server error occurred while processing {request.method}."
            return JsonRpcResponse.err(
                request.id,
                INTERNAL_ERROR,
                err_msg,
            )

    async def rpc_process_kill(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Kill a background process started with shell_bg."""
        process_id = params.get("process_id", "")
        if not process_id:
            raise ValueError("process_id is required")
        from andromity.core.tools import shell_kill
        with self._process_session(params):
            self._user_killed_processes.add((params["session_id"], process_id) if params.get("session_id") else process_id)
            result = shell_kill(process_id)
        return {"status": "ok", "message": result, "process_id": process_id}

    async def rpc_process_read(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Read output from a running or exited background process."""
        process_id = params.get("process_id", "")
        lines = int(params.get("lines", 200))
        if not process_id:
            raise ValueError("process_id is required")
        from andromity.core.tools import shell_read
        with self._process_session(params):
            output = shell_read(process_id, lines=lines)
        return {"process_id": process_id, "output": output}

    @contextmanager
    def _process_session(self, params: Dict[str, Any]) -> Iterator[None]:
        """New clients address processes by their owning session; legacy calls remain supported."""
        sid = params.get("session_id")
        if not sid:
            yield
            return
        from andromity.core import tools
        session = self._get_or_load_session(sid, params.get("project_path"))
        if not config.is_trusted(session.project_path):
            raise PermissionError("Workspace is untrusted. Enable trust before managing background commands.")
        key = (str(Path(session.project_path).resolve()), params.get("process_id"))
        with tools._bg_lock:
            entry = tools._bg_processes.get(key)
            if entry is None or entry.get("session_id") != sid:
                raise ValueError("Background command is no longer available in this session.")
        token = tools._current_session_var.set(session)
        try:
            yield
        finally:
            tools._current_session_var.reset(token)

    async def rpc_process_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """List active background processes."""
        from andromity.core.tools import _bg_processes, _bg_lock, _bg_project_key
        proj_key = params.get("project_path") or _bg_project_key()
        with _bg_lock:
            entries = []
            for key, entry in _bg_processes.items():
                if isinstance(key, tuple):
                    pk, pid = key
                    if pk != proj_key and proj_key != "__global__":
                        continue
                else:
                    pid = key
                proc = entry["proc"]
                alive = proc.poll() is None
                entries.append({
                    "process_id": pid,
                    "pid": proc.pid,
                    "command": entry.get("cmd", ""),
                    "status": "running" if alive else f"exited ({proc.returncode})",
                    "started": entry.get("started", 0),
                    "elapsed": int(time.time() - entry.get("started", time.time())),
                    "session_id": entry.get("session_id", ""),
                })
        return {"processes": entries}

    # ── MCP Manager helpers ─────────────────────────────────────────────────
    def _get_mcp_manager(self, project_path: Optional[str] = None):
        """Return (and lazily create) the daemon's MCPClientManager."""
        if self._mcp_manager is not None:
            if project_path:
                try:
                    resolved = str(Path(project_path).resolve())
                    if resolved != str(Path(self._mcp_manager.project_path).resolve()):
                        self._mcp_manager.project_path = resolved
                        self._mcp_started = False
                except Exception:
                    pass
            return self._mcp_manager
        # Reuse global manager if TUI/tools already created one
        try:
            from andromity.core import tools as _tools_mod
            existing = getattr(_tools_mod, "_mcp_manager", None)
            if existing is not None:
                self._mcp_manager = existing
                if project_path:
                    try:
                        self._mcp_manager.project_path = str(Path(project_path).resolve())
                    except Exception:
                        pass
                return self._mcp_manager
        except Exception:
            pass
        from andromity.core.mcp import MCPClientManager
        pp = str(Path(project_path).resolve()) if project_path else str(Path.cwd().resolve())
        self._mcp_manager = MCPClientManager(pp)
        try:
            from andromity.core import tools as _tools_mod2
            _tools_mod2._mcp_manager = self._mcp_manager
        except Exception:
            pass
        return self._mcp_manager

    async def _ensure_mcp_started(self, project_path: Optional[str] = None):
        """Ensure the MCP manager has called start_all() once."""
        if not hasattr(self, "_mcp_start_lock") or self._mcp_start_lock is None:
            self._mcp_start_lock = asyncio.Lock()
        async with self._mcp_start_lock:
            if (self._mcp_manager is not None and project_path
                    and Path(project_path).resolve() != Path(self._mcp_manager.project_path).resolve()):
                await self._mcp_manager.stop_all()
            mgr = self._get_mcp_manager(project_path)
            if not self._mcp_started:
                try:
                    # A project switch invalidates live sessions, not just cached status.
                    if mgr.sessions:
                        await mgr.stop_all()
                    await mgr.start_all()
                    self._mcp_started = True
                except Exception as e:
                    log.warning("MCP start_all failed: %s", e)
                    raise
            return mgr

    # ── Session Methods ─────────────────────────────────────────────────────────

    def _get_or_load_session(self, session_id: Optional[str] = None, project_path: Optional[str] = None) -> Session:
        if not session_id:
            if self._active_sessions:
                return next(reversed(self._active_sessions.values()))
            session_id = str(uuid.uuid4())

        if session_id in self._active_sessions:
            return self._active_sessions[session_id]

        loaded = Session.load_by_id(session_id, project_path)
        if loaded:
            self._active_sessions[session_id] = loaded
            return loaded

        # 3. If not found on disk, create new session with this exact session_id
        short_id = session_id[:8] if session_id else "main"
        target_dir = Path(project_path).resolve() if project_path else Path.cwd().resolve()
        session = Session(name=f"session-{short_id}", project_path=str(target_dir), session_id=session_id)
        session.save()
        self._active_sessions[session_id] = session
        return session

    async def rpc_session_list(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        project_path = params.get("project_path")
        include_subagents = bool(params.get("include_subagents", False))
        target_path = Path(project_path).resolve() if project_path else Path.cwd().resolve()

        sessions = []
        try:
            self._prune_empty_sessions(str(target_path))
            from andromity.core.session import Session, get_all_sessions
            raw_sessions = get_all_sessions(str(target_path), include_subagents=include_subagents)
            for s in raw_sessions:
                sessions.append({
                    "id": s.id,
                    "name": s.name,
                    "status": getattr(s, "status", "idle"),
                    "project_path": s.project_path,
                    "parent_session": getattr(s, "parent_session", None),
                    "updated_at": getattr(s, "updated_at", None),
                    "created_at": getattr(s, "created_at", None),
                    "message_count": len(s.messages),
                    "token_total": getattr(s, "token_total", 0),
                    "context_tokens": getattr(s, "context_tokens", 0),
                    "cost_usd": getattr(s, "cost_usd", 0.0),
                    "provider": getattr(s, "provider", ""),
                    "model": getattr(s, "model", ""),
                })
        except Exception as e:
            log.warning("Session list from disk failed: %s", e)
            for sid, s in self._active_sessions.items():
                if not include_subagents and getattr(s, "parent_session", None):
                    continue
                sessions.append({
                    "id": s.id,
                    "name": s.name,
                    "status": getattr(s, "status", "idle"),
                    "project_path": s.project_path,
                    "parent_session": getattr(s, "parent_session", None),
                    "message_count": len(s.messages),
                    "token_total": getattr(s, "token_total", 0),
                    "context_tokens": getattr(s, "context_tokens", 0),
                    "cost_usd": getattr(s, "cost_usd", 0.0),
                })
        return sessions

    def _prune_empty_sessions(self, project_path: str, keep_id: Optional[str] = None) -> None:
        """Prune abandoned empty sessions (0 messages) for the project to prevent clutter."""
        try:
            import hashlib
            from andromity.core.db import get_conn, init_schema
            from andromity.core.session import normalize_project_path
            init_schema()
            conn = get_conn()
            phash = hashlib.sha256(normalize_project_path(project_path).encode()).hexdigest()[:16]
            rows = conn.execute(
                "SELECT id FROM sessions WHERE project_hash = ? AND (parent_session IS NULL OR parent_session = '') ORDER BY updated_at DESC",
                (phash,),
            ).fetchall()
            kept_one = False
            for r in rows:
                sid = r[0]
                if sid == keep_id:
                    kept_one = True
                    continue
                if sid in self._running_tasks and not self._running_tasks[sid].done():
                    continue
                active_sess = self._active_sessions.get(sid)
                if active_sess and len(active_sess.messages) > 0:
                    continue
                try:
                    cnt = conn.execute("SELECT COUNT(*) FROM session_messages WHERE session_id = ?", (sid,)).fetchone()[0]
                except Exception:
                    cnt = 1
                if cnt == 0:
                    # Allow at most 1 empty session to remain if keep_id is not specified
                    if keep_id is None and not kept_one:
                        kept_one = True
                        continue
                    if active_sess:
                        active_sess.delete()
                    else:
                        Session.delete_by_id(sid)
                    self._active_sessions.pop(sid, None)
            try:
                conn.commit()
            except Exception:
                pass
        except Exception as prune_err:
            log.warning("Auto-pruning empty sessions error: %s", prune_err)

    async def rpc_initialize(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """ACP (Agent Client Protocol) initialize handshake."""
        protocol_version = params.get("protocolVersion", 1)
        client_info = params.get("clientInfo", {})
        log.info("ACP handshake from %s (protocolVersion=%s)", client_info, protocol_version)
        return {
            "protocolVersion": protocol_version,
            "agentCapabilities": {
                "session": {
                    "streaming": True,
                    "resumption": True,
                },
                "tools": True,
            },
            "agentInfo": {
                "name": "Andromity",
                "version": __version__,
                "description": "Autonomous AI coding agent by AgenticMarket",
            },
        }

    async def rpc_session_new(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """ACP session/new handler."""
        cwd = params.get("cwd") or params.get("project_path") or str(Path.cwd().resolve())
        session = Session(name="JetBrains AI Assistant Session", project_path=cwd)
        session.save()
        self._active_sessions[session.id] = session
        return {"sessionId": session.id}

    async def rpc_session_prompt(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """ACP session/prompt handler."""
        session_id = params.get("sessionId") or params.get("session_id")
        prompt_raw = params.get("prompt", "")
        if isinstance(prompt_raw, list):
            prompt_text = "\n".join(
                b.get("text", "")
                for b in prompt_raw
                if isinstance(b, dict) and b.get("type") == "text"
            )
        else:
            prompt_text = str(prompt_raw)

        await self.rpc_agent_prompt({
            "session_id": session_id,
            "prompt": prompt_text,
        })
        return {"stopReason": "end_turn"}

    async def rpc_session_create(self, params: Dict[str, Any]) -> Dict[str, Any]:
        name = params.get("name", "new-session")
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        session_id = params.get("session_id")

        self._prune_empty_sessions(project_path, keep_id=params.get("keep_id"))

        session = Session(name=name, project_path=project_path, session_id=session_id)
        session.save()
        self._active_sessions[session.id] = session
        return {
            "id": session.id,
            "name": session.name,
            "status": getattr(session, "status", "idle"),
            "project_path": session.project_path,
            "created_at": session.created_at,
        }

    async def rpc_session_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        project_path = params.get("project_path")
        session = self._get_or_load_session(session_id, project_path)
        runtime = self._runtime.snapshot(session.id)
        processes = await self.rpc_process_list({"project_path": session.project_path})
        runtime["processes"] = [p for p in processes["processes"] if p["session_id"] == session.id and p["status"] == "running"]
        task = self._running_tasks.get(session.id)
        runtime["is_running"] = task is not None and not task.done()
        plan = getattr(session, "plan", None)
        if isinstance(plan, dict) and plan.get("status") == "pending" and not any(i["type"] == "plan_approval" for i in runtime["interactions"]):
            runtime["interactions"].append({"type": "plan_approval", "session_id": session.id, "plan": plan})
        return {
            "id": session.id,
            "name": session.name,
            "status": getattr(session, "status", "idle"),
            "is_running": runtime["is_running"],
            "runtime": runtime,
            "permission_mode": session.permission_mode,
            "profile": session.profile,
            "project_path": session.project_path,
            "messages": deepcopy(session.messages),
            "token_total": getattr(session, "token_total", 0),
            "context_tokens": getattr(session, "context_tokens", 0),
            "cost_usd": getattr(session, "cost_usd", 0.0),
            "usage_breakdown": getattr(session, "usage_breakdown", {}),
            "plan": deepcopy(plan),
            "compacted_history": getattr(session, "compacted_history", []),
            "model": getattr(session, "model", None) or getattr(getattr(self, "agent", None), "model_name", None) or getattr(getattr(self, "config", None), "model", None),
            "provider": getattr(session, "provider", None) or getattr(getattr(self, "agent", None), "provider_name", None) or getattr(getattr(self, "config", None), "provider", None),
            "collaborators": list(getattr(session, "collaborators", None) or []),
            "watching_for": getattr(session, "watching_for", None),
        }

    async def rpc_session_delete(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        if not session_id:
            raise ValueError("session_id is required")
        from andromity.core.session import _validate_session_id
        try:
            valid_id = _validate_session_id(session_id)
        except ValueError:
            raise ValueError(f"Invalid session_id: {session_id!r}")

        task = self._running_tasks.get(valid_id)
        if task is not None and not task.done():
            return {"success": False, "error": "This chat is running. Stop it before deleting it."}
        session = self._active_sessions.get(valid_id)
        if session is not None:
            session.delete()
        else:
            Session.delete_by_id(valid_id)
        self._active_sessions.pop(valid_id, None)
        return {"success": True, "session_id": valid_id}

    async def rpc_session_rename(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        name = params.get("name")
        if not session_id or not name:
            raise ValueError("session_id and name are required")
        session = self._get_or_load_session(session_id, params.get("project_path"))
        session.name = str(name).strip()
        session.save()
        self.notify("session/updated", {"session_id": session.id, "name": session.name})
        return {"success": True, "id": session.id, "name": session.name}

    async def rpc_session_compact(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        if session_id in self._running_tasks and not self._running_tasks[session_id].done():
            return {"success": False, "error": f"Session {session_id} is currently running an active turn. Cancel or wait for it to finish."}
        session = self._get_or_load_session(session_id, params.get("project_path"))
        if not session:
            return {"success": False, "error": f"Session {session_id} not found"}

        non_system = [m for m in session.messages if m.get("role") != "system"]
        old_count = len(session.messages)

        # If nothing to compact (fewer than 3 user/assistant turns)
        if len(non_system) < 3:
            self.notify("session/compacted", {
                "session_id": session.id,
                "old_count": old_count,
                "message_count": old_count,
                "context_tokens": getattr(session, "context_tokens", 0),
                "skipped": True,
                "reason": "Conversation is already compact — not enough history to summarize.",
            })
            return {
                "success": True,
                "skipped": True,
                "reason": "Conversation is already compact — not enough history to summarize.",
                "old_count": old_count,
                "message_count": old_count,
                "context_tokens": getattr(session, "context_tokens", 0),
            }

        self.notify("session/compacting", {
            "session_id": session.id,
            "reason": f"Compacting {len(non_system)} messages to reduce token usage...",
        })

        model = getattr(session, "model", None) or config.get("default", "model", "claude-sonnet-4-6")
        provider = getattr(session, "provider", None) or config.get("default", "provider", "anthropic")
        agent = Agent(session=session, model=model, provider=provider)

        compact_error = None
        try:
            async for event in agent._compact_context(force=True):
                if hasattr(event, "text") and ("skipped" in event.text or "failed" in event.text):
                    compact_error = event.text.strip("* \n[]")
        except Exception as e:
            log.exception("Compaction failed: %s", e)
            compact_error = str(e)

        if compact_error:
            self.notify("session/compacted", {
                "session_id": session.id,
                "error": compact_error,
                "old_count": old_count,
                "message_count": len(session.messages),
                "context_tokens": getattr(session, "context_tokens", 0),
            })
            return {
                "success": False,
                "error": compact_error,
                "old_count": old_count,
                "message_count": len(session.messages),
                "context_tokens": getattr(session, "context_tokens", 0),
            }

        # Recalculate context tokens (use same estimator as agent: include thinking + tool_calls)
        try:
            from andromity.core.agent import _estimate_tokens as _est
            total_tokens = _est(session.messages)
        except Exception:
            total_tokens = sum(len(str(m.get("content", ""))) // 4 + len(str(m.get("thinking", ""))) // 4 for m in session.messages)
        session.context_tokens = total_tokens
        session.save()
        self.notify("session/updated", {
            "session_id": session.id,
            "name": session.name,
            "message_count": len(session.messages),
            "context_tokens": session.context_tokens,
        })
        self.notify("session/compacted", {
            "session_id": session.id,
            "old_count": old_count,
            "message_count": len(session.messages),
            "context_tokens": session.context_tokens,
        })
        return {
            "success": True,
            "old_count": old_count,
            "message_count": len(session.messages),
            "context_tokens": session.context_tokens,
        }

    async def rpc_session_undo(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        if session_id in self._running_tasks and not self._running_tasks[session_id].done():
            return {"success": False, "error": f"Session {session_id} is currently running an active turn. Cancel or wait for it to finish."}
        session = self._get_or_load_session(session_id, params.get("project_path"))

        user_turn_indices = session.get_user_turn_indices()
        total_turns = len(user_turn_indices)
        if total_turns == 0:
            return {
                "success": True,
                "turns_undone": 0,
                "target_turn_index": 0,
                "popped_messages": 0,
                "git_status": "No turns to undo in session",
            }

        target_turn = params.get("turn_index")
        if target_turn is None:
            target_turn = params.get("target_turn_index")

        if target_turn is not None:
            target_turn_idx = max(0, min(int(target_turn), total_turns - 1))
            turns_to_undo = total_turns - target_turn_idx
        elif "turns_to_undo" in params:
            turns_to_undo = max(1, min(int(params["turns_to_undo"]), total_turns))
            target_turn_idx = total_turns - turns_to_undo
        else:
            turns_to_undo = 1
            target_turn_idx = total_turns - 1

        if not config.is_trusted(session.project_path):
            return {"success": False, "error": "Trust this workspace before undoing file changes."}
        self._review_repo({"project_path": session.project_path}, mutate=True)
        records = [record for record in getattr(session, "undo_stack", [])
                   if record.get("turn_index", -1) >= target_turn_idx]
        repo = get_repo(Path(session.project_path))
        rollback_msg = "Conversation restored; no file checkpoint available."
        if records:
            if not repo:
                return {"success": False, "error": "The repository is unavailable. No conversation messages were removed."}
            try:
                from andromity.core.git_ops import rollback_recorded_turns, run_restoration
                root = str(Path(repo.working_tree_dir).resolve())
                self._git_mutating_roots.add(root)
                try:
                    ok = await run_restoration(rollback_recorded_turns, repo, records, session.project_path)
                finally:
                    self._git_mutating_roots.discard(root)
            except Exception:
                log.exception("Turn rollback failed")
                ok = False
            if not ok:
                return {"success": False, "error": "Files changed after this turn or its checkpoint is incomplete. Review the changes before undoing; your conversation is preserved."}
            rollback_msg = "Restored snapshot " + records[0]["snapshot_hash"][:7]
        turns_undone, popped, _ = session.rollback_to_turn(target_turn_idx)

        return {
            "success": True,
            "turns_undone": turns_undone,
            "target_turn_index": target_turn_idx,
            "popped_messages": popped,
            "git_status": rollback_msg,
        }

    async def rpc_session_sendMessage(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.session_bus import SessionBus
        bus = SessionBus.get_instance()
        from_id = params.get("from_session", "user")
        to_id = params.get("to_session")
        content = params.get("content", "")
        message_type = params.get("message_type", "chat")
        if not to_id:
            raise ValueError("to_session is required")
        ok = await bus.send_message(
            from_session_id=from_id,
            to_target=to_id,
            content=content,
            message_type=message_type,
        )
        return {"success": ok}

    async def rpc_session_askQuestion(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.session_bus import SessionBus
        bus = SessionBus.get_instance()
        from_id = params.get("from_session", "user")
        to_id = params.get("to_session")
        question = params.get("question", "")
        timeout = float(params.get("timeout", 60.0))
        if not to_id or not question:
            raise ValueError("to_session and question are required")
        answer = await bus.ask_question(
            from_session_id=from_id,
            to_target=to_id,
            question=question,
            timeout=timeout,
        )
        return {"success": True, "answer": answer}

    async def rpc_session_answerQuestion(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.session_bus import SessionBus
        bus = SessionBus.get_instance()
        from_id = params.get("from_session", "user")
        question_id = params.get("question_id")
        answer = params.get("answer", "")
        if not question_id:
            raise ValueError("question_id is required")
        success = bus.answer_question(
            from_session_id=from_id,
            question_id=question_id,
            answer=answer,
            answered_by_user=True,
        )
        return {"success": success}

    async def rpc_session_readMessages(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.session_bus import SessionBus
        bus = SessionBus.get_instance()
        session_id = params.get("session_id")
        max_count = int(params.get("max_count", 10))
        if not session_id:
            raise ValueError("session_id is required")
        msgs = bus.drain_mailbox(session_id, max_count=max_count)
        return {
            "messages": [
                {
                    "id": m.id,
                    "from_session": m.from_session_name,
                    "to_session": m.to_session_id,
                    "content": m.content,
                    "message_type": m.message_type,
                    "timestamp": m.created_at,
                }
                for m in msgs
            ]
        }

    async def rpc_session_getPendingQuestions(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.session_bus import SessionBus
        bus = SessionBus.get_instance()
        session_id = params.get("session_id")
        if not session_id:
            raise ValueError("session_id is required")
        questions = bus.get_pending_questions_for(session_id)
        return {"questions": questions}

    async def rpc_session_setWatching(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        target_session = params.get("target_session")
        reason = params.get("reason", "")
        if not session_id:
            raise ValueError("session_id is required")
        session = self._get_or_load_session(session_id)
        session.set_status("watching", watching_for={"target_session": target_session, "reason": reason})
        session.save()
        self.notify("session/updated", {
            "session_id": session.id,
            "status": "watching",
            "watching_for": session.watching_for,
            "consecutive_auto_wakes": getattr(session, "consecutive_auto_wakes", 0),
            "collaborators": getattr(session, "collaborators", []),
        })
        return {"success": True, "status": "watching"}

    async def rpc_session_resetAutoWake(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        if not session_id:
            raise ValueError("session_id is required")
        session = self._get_or_load_session(session_id)
        session.consecutive_auto_wakes = 0
        if session.status == "paused_limit_reached":
            session.set_status("watching")
        session.save()
        self.notify("session/updated", {
            "session_id": session.id,
            "status": session.status,
            "consecutive_auto_wakes": 0,
            "collaborators": getattr(session, "collaborators", []),
        })
        return {"success": True, "consecutive_auto_wakes": 0}

    # ── Agent Execution & Streaming Methods ─────────────────────────────────────

    def _inputs(self, session_id: str):
        from andromity.core.inputs import InputQueue
        if session_id not in self._input_queues:
            self._input_queues[session_id] = InputQueue(
                session_id, lambda state: self.notify("agent/queueChanged", state))
        return self._input_queues[session_id]

    async def rpc_agent_queue(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session = self._get_or_load_session(params.get("session_id"), params.get("project_path"))
        return {**self._inputs(session.id).snapshot(), "supported": True}

    async def rpc_agent_submit(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session = self._get_or_load_session(params.get("session_id"), params.get("project_path"))
        sid = session.id
        async with self._input_locks.setdefault(sid, asyncio.Lock()):
            queue = self._inputs(sid)
            payload = {**params, "session_id": sid}
            item = queue.submit(payload, params.get("delivery", "queue"), params.get("request_id"))
            await self._start_pending(sid)
            return {"session_id": sid, "input_id": item.id, "status": item.status,
                    "queue": queue.snapshot()}

    async def rpc_agent_promote(self, params: Dict[str, Any]) -> Dict[str, Any]:
        sid = params["session_id"]
        async with self._input_locks.setdefault(sid, asyncio.Lock()):
            self._inputs(sid).promote(params["input_id"])
            await self._start_pending(sid)
            return self._inputs(sid).snapshot()

    async def rpc_agent_remove(self, params: Dict[str, Any]) -> Dict[str, Any]:
        queue = self._inputs(params["session_id"])
        queue.remove(params["input_id"])
        return queue.snapshot()

    async def rpc_agent_resume(self, params: Dict[str, Any]) -> Dict[str, Any]:
        sid = params["session_id"]
        async with self._input_locks.setdefault(sid, asyncio.Lock()):
            self._inputs(sid).resume()
            await self._start_pending(sid)
            return self._inputs(sid).snapshot()

    async def _start_pending(self, sid: str) -> None:
        task = self._running_tasks.get(sid)
        if task and not task.done():
            return
        queue = self._inputs(sid)
        item = queue.peek()
        if item is None:
            return
        payload = {**item.payload, "input_id": item.id}
        try:
            await self.rpc_agent_prompt(payload)
            queue.applied(item)
            from andromity.telemetry import send_feature_used
            send_feature_used("queue_dispatched", session_id=sid)
        except Exception:
            queue.pause()
            raise

    async def _finish_pending(self, sid: str, task: asyncio.Task) -> None:
        async with self._input_locks.setdefault(sid, asyncio.Lock()):
            if self._running_tasks.get(sid) is task:
                self._running_tasks.pop(sid, None)
            try:
                await self._start_pending(sid)
            except Exception:
                log.exception("Unable to start queued input for %s", sid)

    async def rpc_agent_retry(self, params: Dict[str, Any]) -> Dict[str, Any]:
        sid = params.get("session_id")
        session = self._get_or_load_session(sid, params.get("project_path"))
        sid = session.id
        async with self._input_locks.setdefault(sid, asyncio.Lock()):
            task = self._running_tasks.get(sid)
            if task and not task.done():
                raise ValueError("Wait for the current turn to finish before retrying.")
            previous = self._last_prompt_requests.get(sid)
            if previous is None:
                raise ValueError("This request is no longer available. Send the prompt again.")
            payload = {**previous, "session_id": sid}
            payload.pop("input_id", None)
            payload.pop("request_id", None)
            if params.get("strip_images"):
                payload.pop("images", None)
                payload["image_uris"] = []
                if not str(payload.get("prompt", "")).strip():
                    raise ValueError("This message only contains an image. Add a text prompt before retrying.")
            for key in ("model", "provider", "reasoning_effort"):
                if params.get(key):
                    payload[key] = params[key]
            # Retry never restores files or resumes messages paused after an error.
            return await self.rpc_agent_prompt(payload)

    async def rpc_agent_prompt(self, params: Dict[str, Any]) -> Dict[str, Any]:
        prompt = params.get("prompt", "")
        if not prompt and not (params.get("images") or params.get("image_uris")):
            raise ValueError("prompt is required")

        project_path = params.get("project_path")
        session_id = params.get("session_id")
        session = self._get_or_load_session(session_id, project_path)
        session_id = session.id

        if session_id in self._running_tasks and not self._running_tasks[session_id].done():
            raise RuntimeError(f"Session {session_id} is already running a turn.")
        prompt_repo = get_repo(Path(session.project_path))
        if prompt_repo and str(Path(prompt_repo.working_tree_dir).resolve()) in self._git_mutating_roots:
            raise ValueError("Wait for file restoration to finish before starting another turn.")

        if not params.get("is_auto_wake"):
            from copy import deepcopy
            self._last_prompt_requests[session_id] = deepcopy(params)

        is_auto_wake = bool(params.get("is_auto_wake", False))
        if not is_auto_wake:
            session.consecutive_auto_wakes = 0
            session.save()

        profile = params.get("profile") or config.get("default", "profile", "builder")
        session.profile = profile
        model = params.get("model") or config.get("default", "model", "claude-sonnet-4-6")
        provider = params.get("provider") or config.get("default", "provider", "anthropic")
        reasoning_effort = params.get("reasoning_effort") or config.get("default", "reasoning_effort", "auto")
        # Respect per-session mode passed from client, falling back to server default
        mode = (params.get("mode") or config.get("default", "permission_mode", "safe")).lower()
        session.permission_mode = mode
        is_trusted_workspace = config.is_trusted(session.project_path)
        auto_approve = mode in ("full", "yolo")

        # Create callbacks for interactive approval and clarifying questions
        async def _on_tool_approval(tool_name: str, args: Dict[str, Any]) -> bool:
            t_lower = (tool_name or "").strip().lower()
            prof_lower = (profile or "").strip().lower()

            # 1. Profile confinement check (hard gate: planner/reviewer cannot mutate files or execute shell)
            if prof_lower in ("planner", "reviewer") and t_lower in ("write_file", "edit_file", "edit_file_multi", "shell_exec", "shell_bg", "shell_kill"):
                log.warning("Tool '%s' blocked — profile %s is read-only", tool_name, profile)
                return (False, f"TOOL BLOCKED: Profile '{profile}' is restricted from executing mutating tool '{tool_name}'.")

            # 2. Untrusted workspace security check (hard fence: blocks writes across all modes)
            if not is_trusted_workspace:
                from andromity.core.tools import requires_workspace_trust
                if requires_workspace_trust(t_lower):
                    log.warning("Tool '%s' blocked — workspace %s is untrusted", tool_name, session.project_path)
                    return (False, "TOOL BLOCKED: Workspace is untrusted. Grant trust in Settings to permit workspace reads, writes, and commands.")

            # 3. YOLO / FULL mode auto-approves all actions once security gates pass
            if mode in ("full", "yolo"):
                return True

            from andromity.core.security import is_sensitive_path
            target_path = str(args.get("path", "") or args.get("target_path", "") or args.get("target_file", "") or args.get("file_path", ""))
            is_sensitive = is_sensitive_path(target_path) if target_path else False

            # 3. Read-only tools bypass approval UNLESS accessing sensitive credentials/keys
            if is_sensitive:
                needs_approval = True
            elif tool_name in READ_ONLY_TOOLS:
                return True
            else:
                needs_approval = False

            # 4. Mode-specific evaluation (exact match with TUI app.py:549-617)
            if tool_name in ("write_file", "edit_file", "edit_file_multi"):
                from andromity.core.security import is_execution_control_path
                if mode == "safe":
                    needs_approval = True
                elif mode == "trust":
                    if is_sensitive or is_execution_control_path(target_path):
                        needs_approval = True
                    else:
                        return True

            elif tool_name in SESSION_DRIVING_TOOLS:
                # These reach other sessions, which may auto-wake and act on the content.
                if mode == "safe":
                    needs_approval = True

            elif tool_name in ("shell_exec", "shell_bg"):
                command = str(args.get("command", "")).strip()
                if mode == "safe":
                    needs_approval = True
                elif mode == "trust":
                    from andromity.core.security import is_command_allowlisted
                    global_allowed = config.get("default", "allowed_commands", []) or []
                    session_allowed = getattr(session, "allowed_commands", []) or []
                    allowed = list(set(global_allowed) | set(session_allowed))
                    if not is_command_allowlisted(command, allowed):
                        needs_approval = True

            elif tool_name == "shell_kill":
                if mode == "safe":
                    needs_approval = True

            elif tool_name == "spawn_subagent":
                if mode == "safe":
                    needs_approval = True

            elif tool_name in ("read_file", "view_file", "grep_search"):
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
                    global_domains = config.get("default", "allowed_domains", []) or []
                    session_domains = getattr(session, "allowed_domains", []) or []
                    allowed_domains = list(global_domains) + list(session_domains)
                    if not is_domain_allowed(url, allowed_domains):
                        needs_approval = True

            elif tool_name.startswith("mcp__"):
                if mode == "safe":
                    needs_approval = True
                elif mode == "trust":
                    lower_name = tool_name.lower()
                    if any(m in lower_name for m in ("write", "insert", "update", "delete", "create", "drop", "push", "exec", "post")):
                        needs_approval = True

            if not needs_approval:
                return True

            approval_id = str(uuid.uuid4())
            fut = asyncio.get_running_loop().create_future()
            self._pending_approvals[approval_id] = (session_id, fut, tool_name, args)

            self.notify("agent/toolApprovalRequired", {
                "session_id": session_id,
                "approval_id": approval_id,
                "tool_name": tool_name,
                "args": args,
            })

            try:
                approved = await fut
                return bool(approved)
            finally:
                self._pending_approvals.pop(approval_id, None)
                self.notify("agent/interactionResolved", {"session_id": session_id, "interaction_id": approval_id})

        async def _on_questions(questions: List[Dict[str, Any]]) -> str:
            question_id = str(uuid.uuid4())
            fut = asyncio.get_running_loop().create_future()
            self._pending_questions[question_id] = (session_id, fut)

            self.notify("agent/askQuestions", {
                "session_id": session_id,
                "question_id": question_id,
                "questions": questions,
            })

            try:
                answer = await asyncio.wait_for(fut, timeout=900)
                return str(answer)
            except asyncio.TimeoutError:
                return "The user did not answer the questions within 15 minutes. Proceed with reasonable assumptions.If serious question wait to user send next message."
            finally:
                self._pending_questions.pop(question_id, None)
                self.notify("agent/interactionResolved", {"session_id": session_id, "interaction_id": question_id})

        # Auto-title session from first user prompt if still default
        if not is_auto_wake and (session.name in ("new-session", "Main Session") or session.name.startswith("Session ") or session.name.startswith("session-")):
            try:
                auto_name = Session.auto_name_from_message(prompt)
                if auto_name:
                    session.name = auto_name
                    session.save()
                    self.notify("session/updated", {"session_id": session.id, "name": session.name})
            except Exception:
                first_line = prompt.strip().split("\n")[0].strip()
                if first_line:
                    short_title = first_line[:32].strip()
                    if len(first_line) > 32:
                        short_title += "…"
                    session.name = short_title
                    session.save()
                    self.notify("session/updated", {"session_id": session.id, "name": session.name})
            # Trigger background AI LLM-powered title generation (TUI parity)
            try:
                asyncio.create_task(self._generate_ai_session_name(session, prompt, provider, model))
            except Exception:
                pass

        agent = Agent(
            session=session,
            profile=profile,
            auto_approve=False,
            on_tool_approval=_on_tool_approval,
            on_questions=_on_questions,
            reasoning_effort=reasoning_effort,
            provider=provider,
            model=model,
        )
        self._active_agents[session_id] = agent
        agent.input_queue = self._inputs(session_id)

        async def _run_stream():
            turn_checkpoint = None
            try:
                # Reset turn snapshot flag and take pre-turn snapshot
                session._turn_snapshotted = False
                try:
                    p_path = Path(session.project_path)
                    if not config.is_trusted(str(p_path)):
                        raise ValueError("Workspace is not trusted")
                    await asyncio.to_thread(ensure_git_tracking, p_path)
                    snap_hash = await asyncio.to_thread(create_pre_edit_snapshot, p_path)
                    if snap_hash:
                        session._turn_snapshotted = True
                        if not hasattr(session, "undo_stack") or session.undo_stack is None:
                            session.undo_stack = []
                        user_turn_idx = len(session.get_user_turn_indices())
                        turn_checkpoint = {"snapshot_hash": snap_hash, "msg_count": len(session.messages),
                                           "turn_index": user_turn_idx}
                        session.undo_stack.append(turn_checkpoint)
                        session.save()
                except Exception as snap_err:
                    log.debug("Pre-edit snapshot skipped: %s", snap_err)

                images = params.get("images")
                image_uris = params.get("image_uris")
                user_turn_idx = len(session.get_user_turn_indices()) if hasattr(session, "get_user_turn_indices") else 0
                self.notify("agent/started", {
                    "session_id": session_id,
                    "prompt": prompt,
                    "turn_index": user_turn_idx,
                    "input_id": params.get("input_id"),
                    "image_uris": image_uris or [],
                })
                session.set_status("running")
                async for event in agent.run(prompt, images=images, image_uris=image_uris):
                    if isinstance(event, InputApplied):
                        self.notify("agent/inputApplied", {
                            "session_id": session_id, "input_id": event.input_id,
                            "prompt": event.prompt, "image_uris": event.image_uris or [],
                            "turn_index": event.turn_index,
                        })
                    elif isinstance(event, TextDelta):
                        if "[Context compacting" in event.text:
                            self.notify("session/compacting", {
                                "session_id": session_id,
                                "reason": "Auto-compacting: context limit reached",
                            })
                        elif "*Context compacted successfully" in event.text:
                            self.notify("session/compacted", {
                                "session_id": session_id,
                                "message_count": len(session.messages),
                                "compacted_history": getattr(session, "compacted_history", []),
                            })
                        self.notify("agent/textDelta", {"session_id": session_id, "text": event.text})
                        self.notify("session/update", {
                            "sessionId": session_id,
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": event.text},
                            },
                        })
                    elif isinstance(event, ThinkingDelta):
                        self.notify("agent/thinkingDelta", {"session_id": session_id, "text": event.text})
                        self.notify("session/update", {
                            "sessionId": session_id,
                            "update": {
                                "sessionUpdate": "agent_thought_chunk",
                                "content": {"type": "text", "text": event.text},
                            },
                        })
                    elif isinstance(event, LLMCallStart):
                        self.notify("waterfall/llmStart", {
                            "session_id": session_id,
                            "turn_id": event.turn_id,
                            "model": event.model,
                            "provider": event.provider,
                            "prompt_tokens_est": event.prompt_tokens_est,
                            "ts": getattr(event, "ts", 0.0) or time.time(),
                        })
                    elif isinstance(event, LLMCallEnd):
                        self.notify("waterfall/llmEnd", {
                            "session_id": session_id,
                            "turn_id": event.turn_id,
                            "ttfb_ms": event.ttfb_ms,
                            "duration_ms": event.duration_ms,
                            "prompt_tokens": event.prompt_tokens,
                            "completion_tokens": event.completion_tokens,
                            "total_tokens": event.total_tokens,
                            "model": event.model,
                            "ts": getattr(event, "ts", 0.0) or time.time(),
                            "response": getattr(event, "response", "") or "",
                            "thinking": getattr(event, "thinking", "") or "",
                            "tool_calls": getattr(event, "tool_calls", []) or [],
                        })
                    elif isinstance(event, ToolCallStart):
                        self.notify("agent/toolStart", {
                            "session_id": session_id,
                            "tool_id": event.tool_id,
                            "tool_name": event.tool_name,
                            "ts": time.time(),
                        })
                    elif isinstance(event, ToolCallDelta):
                        self.notify("agent/toolDelta", {
                            "session_id": session_id,
                            "tool_id": event.tool_id,
                            "chunk": event.args_json_chunk,
                            "ts": time.time(),
                        })
                    elif isinstance(event, ToolCallEnd):
                        self.notify("agent/toolEnd", {
                            "session_id": session_id,
                            "tool_id": event.tool_id,
                            "ts": time.time(),
                        })
                    elif isinstance(event, ToolResult):
                        self.notify("agent/toolResult", {
                            "session_id": session_id,
                            "tool_id": event.tool_id,
                            "result": event.result,
                            "duration_ms": getattr(event, "duration_ms", 0.0),
                            "success": getattr(event, "success", True),
                            "ts": getattr(event, "ts", 0.0) or time.time(),
                        })
                        try:
                            plan_obj = session.load_plan_obj() if session else None
                            if plan_obj:
                                self.notify("agent/planUpdated", {
                                    "session_id": session_id,
                                    "plan": getattr(plan_obj, "to_enriched_dict", plan_obj.to_dict)(),
                                })
                        except Exception:
                            pass
                    elif isinstance(event, PlanApprovalRequired):
                        plan_payload = event.plan
                        if hasattr(plan_payload, "to_enriched_dict"):
                            plan_payload = plan_payload.to_enriched_dict()
                        elif hasattr(plan_payload, "to_dict"):
                            plan_payload = plan_payload.to_dict()
                        self.notify("agent/planApproval", {
                            "session_id": session_id,
                            "plan": plan_payload,
                        })
                    elif isinstance(event, PlanUpdated):
                        plan_payload = event.plan
                        if hasattr(plan_payload, "to_enriched_dict"):
                            plan_payload = plan_payload.to_enriched_dict()
                        elif hasattr(plan_payload, "to_dict"):
                            plan_payload = plan_payload.to_dict()
                        self.notify("agent/planUpdated", {
                            "session_id": session_id,
                            "plan": plan_payload,
                        })
                    elif isinstance(event, SubAgentSpawned):
                        self.notify("subagent/spawned", {
                            "session_id": session_id,
                            "agent_id": event.agent_id,
                            "role": event.role,
                            "model": event.model,
                            "provider": event.provider,
                            "task": event.task,
                        })
                    elif isinstance(event, SubAgentProgress):
                        if event.event_type == "spawned":
                            # Tool-path spawns only emit SubAgentProgress(type="spawned")
                            # (run_stream, which emits SubAgentSpawned, is never used by
                            # orchestrator.spawn). Surface it through the spawned channel
                            # too so webview card creation gets model/provider/task.
                            self.notify("subagent/spawned", {
                                "session_id": session_id,
                                "agent_id": event.agent_id,
                                "role": event.role,
                                "model": event.model,
                                "provider": event.provider,
                                "task": event.task,
                            })
                        elif event.event_type in ("completed", "done"):
                            self.notify("subagent/done", {
                                "session_id": session_id,
                                "agent_id": event.agent_id,
                                "role": event.role,
                                "result": event.detail or "",
                                "duration_ms": getattr(event, "duration_ms", 0.0),
                            })
                        elif event.event_type in ("failed", "error", "killed", "timeout"):
                            self.notify("subagent/failed", {
                                "session_id": session_id,
                                "agent_id": event.agent_id,
                                "role": event.role,
                                "error": event.detail or "Subagent execution failed",
                                "duration_ms": getattr(event, "duration_ms", 0.0),
                            })
                        self.notify("subagent/progress", {
                            "session_id": session_id,
                            "agent_id": event.agent_id,
                            "role": event.role,
                            "status": event.status,
                            "event_type": event.event_type,
                            "tool_id": event.tool_id,
                            "delta_text": event.delta_text,
                            "tool_name": event.tool_name,
                            "tool_args": event.tool_args,
                            "tool_result": event.tool_result,
                            "detail": event.detail,
                            "model": event.model,
                            "provider": event.provider,
                            "task": event.task,
                            "duration_ms": getattr(event, "duration_ms", 0.0),
                        })
                    elif isinstance(event, SubAgentDone):
                        self.notify("subagent/done", {
                            "session_id": session_id,
                            "agent_id": event.agent_id,
                            "role": event.role,
                            "result": event.result,
                            "token_usage": event.token_usage,
                            "duration_ms": event.duration_ms,
                        })
                    elif isinstance(event, SubAgentFailed):
                        self.notify("subagent/failed", {
                            "session_id": session_id,
                            "agent_id": event.agent_id,
                            "role": event.role,
                            "error": event.error,
                        })
                    elif isinstance(event, Done):
                        if event.outcome != "success":
                            agent.input_queue.pause()
                        turn_files = self._extract_turn_files(session)
                        if turn_checkpoint:
                            turn_checkpoint["after_hash"] = await asyncio.to_thread(create_pre_edit_snapshot, Path(session.project_path))
                            if turn_checkpoint["after_hash"]:
                                from andromity.core.git_ops import checkpoint_changed_files
                                turn_files = await asyncio.to_thread(checkpoint_changed_files,
                                    get_repo(Path(session.project_path)), turn_checkpoint, session.project_path)
                        self.notify("agent/done", {
                            "session_id": session_id,
                            "usage": event.usage,
                            "outcome": event.outcome,
                            "token_total": getattr(session, "token_total", 0),
                            "context_tokens": getattr(session, "context_tokens", 0),
                            "cost_usd": getattr(session, "cost_usd", 0.0),
                            "turn_files": turn_files,
                        })

                if len(session.messages) <= 3 and (session.name in ("new-session", "Main Session") or session.name.startswith("Session ") or session.name.startswith("session-")):
                    try:
                        first_user_msg = next((m.get("content", "") for m in session.messages if m.get("role") == "user"), "")
                        if first_user_msg:
                            clean_words = [w for w in first_user_msg.replace("\n", " ").split(" ") if w.strip()]
                            if clean_words:
                                refined = " ".join(clean_words[:6])
                                if len(clean_words) > 6:
                                    refined += "…"
                                session.name = refined
                                session.save()
                                self.notify("session/updated", {
                                    "session_id": session.id,
                                    "name": session.name,
                                    "context_tokens": getattr(session, "context_tokens", 0),
                                    "token_total": getattr(session, "token_total", 0),
                                    "cost_usd": getattr(session, "cost_usd", 0.0),
                                })
                    except Exception as title_err:
                        log.debug("Auto-title refinement error: %s", title_err)

                if getattr(session, "watching_for", None):
                    session.set_status("watching", watching_for=session.watching_for)
                else:
                    session.set_status("idle")
                session.save()
                self.notify("session/updated", {
                    "session_id": session.id,
                    "status": session.status,
                    "watching_for": getattr(session, "watching_for", None),
                    "consecutive_auto_wakes": getattr(session, "consecutive_auto_wakes", 0),
                    "collaborators": getattr(session, "collaborators", []),
                })
            except asyncio.CancelledError:
                agent.input_queue.pause()
                try:
                    agent.kill_subagents("cancelled")
                except Exception:
                    pass
                session.set_status("cancelled")
                from andromity.telemetry import send_feature_used
                send_feature_used("cancel_completed", session_id=session_id)
                self.notify("agent/cancelled", {
                    "session_id": session_id,
                    "token_total": getattr(session, "token_total", 0),
                    "context_tokens": getattr(session, "context_tokens", 0),
                    "cost_usd": getattr(session, "cost_usd", 0.0),
                })
                log.info("Agent execution cancelled for session %s", session_id)
            except Exception as e:
                agent.input_queue.pause()
                session.set_status("error")
                log.exception("Agent execution failed for session %s: %s", session_id, e)
                self.notify("agent/error", {
                    "session_id": session_id,
                    "error": "The run could not finish. Pending messages are paused. Check your connection and provider settings, then retry.",
                })
                # Zero-PII error classification telemetry
                try:
                    from andromity.telemetry import send_feature_used
                    err_lower = str(e).lower()
                    if any(k in err_lower for k in ("401", "unauthorized", "invalid api key", "authentication", "forbidden", "invalid_api_key")):
                        cat = "error_auth"
                    elif any(k in err_lower for k in ("429", "rate limit", "quota", "too many requests", "rate_limit_exceeded")):
                        cat = "error_rate_limit"
                    elif any(k in err_lower for k in ("context length", "maximum context", "token limit", "context_length_exceeded")):
                        cat = "error_context_length"
                    elif any(k in err_lower for k in ("timeout", "timed out", "deadline")):
                        cat = "error_timeout"
                    elif any(k in err_lower for k in ("tool", "command failed", "execution failed")):
                        cat = "error_tool_execution"
                    else:
                        cat = "error_generic"
                    send_feature_used(cat, session_id=session_id)
                except Exception:
                    pass
            finally:
                if turn_checkpoint:
                    if len(session.get_user_turn_indices()) <= turn_checkpoint["turn_index"]:
                        session.undo_stack.remove(turn_checkpoint)
                    elif not turn_checkpoint.get("after_hash"):
                        turn_checkpoint["after_hash"] = await asyncio.to_thread(create_pre_edit_snapshot, Path(session.project_path))
                    session.save()
                self._active_agents.pop(session_id, None)

        task = asyncio.create_task(_run_stream())
        self._running_tasks[session_id] = task
        task.add_done_callback(lambda finished: asyncio.create_task(self._finish_pending(session_id, finished)))

        return {"status": "started", "session_id": session_id}

    # Alias for client backwards-compatibility
    rpc_agent_run = rpc_agent_prompt

    async def rpc_agent_quickPrompt(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Lightweight single-turn completion for commit messages / summaries."""
        prompt = params.get("prompt", "")
        if not prompt:
            raise ValueError("prompt is required")
        project_path = params.get("project_path")
        model = params.get("model")
        provider = params.get("provider")

        # Fallback to user's active/configured provider that actually has a valid API key
        def find_working_provider(preferred_prov: Optional[str] = None):
            candidates = []
            if preferred_prov:
                candidates.append(str(preferred_prov).lower().strip())
            default_prov = (config.get("default", "provider", "") or "").lower().strip()
            if default_prov and default_prov not in candidates:
                candidates.append(default_prov)
            for p in ["openrouter", "anthropic", "openai", "google", "deepseek", "groq", "nvidia", "ollama"]:
                if p not in candidates:
                    candidates.append(p)
            for p in candidates:
                if config.get_provider_config(p) and p in (preferred_prov, default_prov):
                    return p, config.get_api_key(p)
                if p == "ollama":
                    return p, config.get_api_key(p)
                k = config.get_api_key(p)
                if k:
                    return p, k
            return (preferred_prov or default_prov or "openrouter"), None

        provider_name, api_key = find_working_provider(provider)

        # Resolve model name: if provider fell back to a different provider, use default model
        if not model or (provider and provider.lower().strip() != provider_name):
            model_name = config.get("default", "model") or "anthropic/claude-3.7-sonnet"
        else:
            model_name = str(model)

        from andromity.core.connections import provider_request
        resolved = provider_request(provider_name, model_name)

        try:
            import sys, os, re
            if getattr(sys, "frozen", False):
                _mei = getattr(sys, "_MEIPASS", None)
                if _mei:
                    _litellm_dir = os.path.join(_mei, "litellm")
                    _price_file = os.path.join(_litellm_dir, "model_prices_and_context_window_backup.json")
                    if not os.path.exists(_price_file):
                        os.makedirs(_litellm_dir, exist_ok=True)
                        with open(_price_file, "w") as _f:
                            _f.write("{}")

            import litellm
            litellm.suppress_debug_info = True

            messages = [{"role": "user", "content": prompt}]
            kwargs: Dict[str, Any] = {
                **resolved, "messages": messages, "temperature": 0.2, "max_tokens": 800,
            }

            resp = await asyncio.wait_for(asyncio.to_thread(lambda: litellm.completion(**kwargs)), timeout=25)
            text = ""
            try:
                msg_obj = resp.choices[0].message
                text = getattr(msg_obj, "content", "") or ""
                # For reasoning models that store output in reasoning_content
                if not text and hasattr(msg_obj, "reasoning_content") and msg_obj.reasoning_content:
                    text = msg_obj.reasoning_content
                if not text and hasattr(resp.choices[0], "text"):
                    text = resp.choices[0].text or ""
            except Exception:
                text = str(resp)

            # Strip markdown code blocks (e.g. ```text ... ```) and backticks
            # Also strip <think>...</think> reasoning blocks emitted by reasoning models
            text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()

            # If the prompt used <commit_message> tag format, extract only that portion
            tag_match = re.search(r"<commit_message>([\s\S]*?)(?:</commit_message>|$)", text, flags=re.DOTALL | re.IGNORECASE)
            if tag_match and tag_match.group(1).strip():
                text = tag_match.group(1).strip()
            else:
                # Fallback: scan for first conventional commit header line to skip any preamble
                commit_line_match = re.search(
                    r"^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^\)]*\))?!?:\s*.+",
                    text, flags=re.MULTILINE | re.IGNORECASE
                )
                if commit_line_match and commit_line_match.start() > 0:
                    text = text[commit_line_match.start():].strip()

            cleaned = re.sub(r"^```[^\n]*\n?|```$", "", text.strip(), flags=re.MULTILINE).strip()
            if cleaned:
                return {"message": cleaned, "result": cleaned}
            raise RuntimeError(f"Model {provider_name}/{model_name} returned empty completion text.")
        except Exception as e:
            log.warning("quickPrompt direct completion failed: %s", e)
            raise RuntimeError(f"Failed to generate commit message via {provider_name}/{model_name}: {e}")

    async def rpc_agent_approve_tool(self, params: Dict[str, Any]) -> Dict[str, Any]:
        approval_id = params.get("approval_id")
        session_id = params.get("session_id")
        approved = params.get("approved", True)
        scope = params.get("scope", "once")  # "once" | "session" | "always" | "project"
        tool_name = params.get("tool_name")
        args = params.get("args") or {}

        if approval_id in self._pending_approvals:
            item = self._pending_approvals[approval_id]
            if isinstance(item, tuple):
                stored_sid, fut = item[0], item[1]
                if not tool_name and len(item) > 2:
                    tool_name = item[2]
                if not args and len(item) > 3:
                    args = item[3]
                if session_id and stored_sid and session_id != stored_sid:
                    return {"success": False, "error": "Approval belongs to another session"}
                session_id = session_id or stored_sid
            else:
                fut = item

            if fut.done():
                return {"success": False, "error": "Approval already resolved"}

            # If user approved with session or permanent scope, update session and config allowlists
            if approved and session_id:
                session = self._active_sessions.get(session_id)
                if session is None:
                    try:
                        session = Session.load_by_id(session_id)
                    except Exception:
                        pass
                if session is None or not config.is_trusted(session.project_path):
                    return {"success": False, "error": "Workspace is untrusted"}

                if tool_name in ("shell_exec", "shell_bg"):
                    cmd = str(args.get("command", "")).strip()
                    if cmd:
                        if scope == "session" and session:
                            session.allow_command(cmd)
                        elif scope in ("always", "project"):
                            existing = config.get("default", "allowed_commands", []) or []
                            if cmd not in existing:
                                config.set("default", "allowed_commands", list(existing) + [cmd])
                            if session:
                                session.allow_command(cmd)

                elif tool_name == "fetch_url":
                    url = str(args.get("url", "")).strip()
                    if url:
                        from andromity.core.security import get_domain
                        domain = get_domain(url)
                        if domain:
                            if scope == "session" and session:
                                session.allow_domain(domain)
                            elif scope in ("always", "project"):
                                existing = config.get("default", "allowed_domains", []) or []
                                if domain not in existing:
                                    config.set("default", "allowed_domains", list(existing) + [domain])
                                if session:
                                    session.allow_domain(domain)

            if not fut.done():
                fut.set_result(approved)
                self.notify("agent/interactionResolved", {"session_id": session_id, "interaction_id": approval_id})
            return {"success": True, "approval_id": approval_id, "approved": approved, "scope": scope}
        return {"success": False, "error": "Approval ID not found or already resolved"}

    async def rpc_agent_reject_tool(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self.rpc_agent_approve_tool({**params, "approved": False})

    async def rpc_agent_answer_question(self, params: Dict[str, Any]) -> Dict[str, Any]:
        question_id = params.get("question_id")
        session_id = params.get("session_id")
        answers = params.get("answers") or params.get("answer") or ""
        if isinstance(answers, (dict, list)):
            answer_str = json.dumps(answers)
        else:
            answer_str = str(answers)

        if question_id in self._pending_questions:
            item = self._pending_questions[question_id]
            if isinstance(item, tuple):
                stored_sid, fut = item
                if session_id and stored_sid and session_id != stored_sid:
                    return {"success": False, "error": "Question belongs to another session"}
                session_id = session_id or stored_sid
            else:
                fut = item
            if not fut.done():
                fut.set_result(answer_str)
                self.notify("agent/interactionResolved", {"session_id": session_id, "interaction_id": question_id})
            return {"success": True, "question_id": question_id}
        return {"success": False, "error": "Question ID not found or already resolved"}

    async def rpc_agent_cancel(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        if not session_id:
            raise ValueError("session_id is required")
        self._inputs(session_id).pause()

        cancelled = False
        if session_id in self._active_agents:
            try:
                self._active_agents[session_id].kill_subagents("cancelled")
            except Exception:
                pass

        if session_id in self._running_tasks:
            task = self._running_tasks[session_id]
            if not task.done():
                if not task.cancelling():
                    task.cancel()
                cancelled = True

        # Resolve any pending futures specifically for this session
        for aid, item in list(self._pending_approvals.items()):
            if isinstance(item, tuple) and len(item) > 0 and item[0] != session_id:
                continue
            fut = item[1] if isinstance(item, tuple) else item
            if not fut.done():
                fut.set_result(False)
        for qid, item in list(self._pending_questions.items()):
            if isinstance(item, tuple) and len(item) > 0 and item[0] != session_id:
                continue
            fut = item[1] if isinstance(item, tuple) else item
            if not fut.done():
                fut.set_result("Cancelled by user")

        return {"success": True, "session_id": session_id, "cancelled": cancelled}

    # ── Configuration & Models ──────────────────────────────────────────────────

    async def rpc_config_get(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        all_cfg = config.to_dict() if hasattr(config, "to_dict") else {}
        user = config.get_user() if hasattr(config, "get_user") else {}
        from andromity.core.profiles import PROFILES
        def_provider = config.get("default", "provider", "openrouter")
        def_model = config.get("default", "model", "anthropic/claude-3.7-sonnet")
        from andromity.core.reasoning import discover_model_reasoning_capability
        model_cap = await asyncio.to_thread(discover_model_reasoning_capability, def_provider, def_model)
        return {
            "config": all_cfg,
            "capabilities": {"input_queue": True, "steering": True, "custom_providers": True},
            "default_provider": def_provider,
            "default_model": def_model,
            "default_profile": config.get("default", "profile", "builder"),
            "available_profiles": list(PROFILES.keys()),
            "available_reasoning_efforts": model_cap.supported_efforts,
            "model_reasoning_capability": model_cap.to_dict(),
            "permission_mode": config.get("default", "permission_mode", "safe"),
            "reasoning_effort": config.get("default", "reasoning_effort", "auto"),
            "user_name": user.get("name", ""),
            "user_email": user.get("email", ""),
            "max_subagents": config.get("subagents", "max_parallel", 3),
            "auto_compact": config.get("advanced", "auto_compact", True),
            "max_file_size_kb": config.get("advanced", "max_file_size_kb", 500),
            "sound_done": config.get("default", "sound_done", True),
            "sound_attention": config.get("default", "sound_attention", True),
            "telemetry": config.get("default", "telemetry", True),
            "include_co_author": config.get("default", "include_co_author", True),
            "is_trusted": config.is_trusted(params.get("project_path") or str(Path.cwd())) if params else False,
            "pinned_models": config.get_pinned_models(),
        }

    async def rpc_profiles_list(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        from andromity.core.profiles import PROFILES
        descs = {
            "builder": "Full implementation agent with plan generation, full tool suite, and subagents",
            "coder": "Fast direct coding agent with shell execution and multi-file editing",
            "reviewer": "Read-only auditor for security, bugs, logic flaws, and performance",
            "planner": "Architecture and system designer for step-by-step task breakdown",
        }
        return [{"id": k, "name": k.capitalize(), "description": descs.get(k, ""), "tools": v.get("tools", [])} for k, v in PROFILES.items()]

    async def rpc_telemetry_recordFeature(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Record anonymous feature usage telemetry (Zero-PII)."""
        params = params or {}
        feature = params.get("feature") or params.get("feature_name") or ""
        session_id = params.get("session_id")
        if feature:
            try:
                from andromity.telemetry import send_feature_used
                send_feature_used(feature, session_id=session_id)
            except Exception:
                pass
        return {"success": True}

    async def rpc_config_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        section = params.get("section", "default")
        key = params.get("key")
        value = params.get("value")
        if not key:
            raise ValueError("key is required")
        config.set(section, key, value)
        config.save()

        # Re-evaluate pending actions; Trust retains its command and path exceptions.
        if key in ("permission_mode", "mode") and str(value).lower() in ("trust", "full", "yolo"):
            for app_id, item in list(self._pending_approvals.items()):
                sid, fut = (item[0], item[1]) if isinstance(item, tuple) else (None, item)
                session = self._active_sessions.get(sid)
                if session is None or not config.is_trusted(session.project_path):
                    continue
                tool_name = item[2] if isinstance(item, tuple) and len(item) > 2 else ""
                args = item[3] if isinstance(item, tuple) and len(item) > 3 else {}
                if getattr(session, "profile", "builder") in ("planner", "reviewer") and tool_name in ("write_file", "edit_file", "edit_file_multi", "shell_exec", "shell_bg", "shell_kill"):
                    continue
                if str(value).lower() == "trust":
                    from andromity.core.security import is_sensitive_path, is_execution_control_path, is_command_allowlisted, is_domain_allowed
                    target = str(args.get("path") or args.get("target_path") or args.get("target_file") or args.get("file_path") or "")
                    if is_sensitive_path(target):
                        continue
                    if tool_name in ("write_file", "edit_file", "edit_file_multi"):
                        if is_execution_control_path(target):
                            continue
                    elif tool_name in ("shell_exec", "shell_bg"):
                        allowed = (config.get("default", "allowed_commands", []) or []) + (getattr(session, "allowed_commands", []) or [])
                        if not is_command_allowlisted(str(args.get("command", "")), allowed):
                            continue
                    elif tool_name == "fetch_url":
                        domains = (config.get("default", "allowed_domains", []) or []) + (getattr(session, "allowed_domains", []) or [])
                        if not is_domain_allowed(str(args.get("url", "")), domains):
                            continue
                    elif tool_name.startswith("mcp__"):
                        if any(m in tool_name.lower() for m in ("write", "insert", "update", "delete", "create", "drop", "push", "exec", "post")):
                            continue
                    elif tool_name not in READ_ONLY_TOOLS | SESSION_DRIVING_TOOLS | {"shell_kill", "spawn_subagent", "web_search"}:
                        continue
                if not fut.done():
                    fut.set_result(True)
                    self.notify("agent/interactionResolved", {"session_id": sid, "interaction_id": app_id})

        return {"success": True, "section": section, "key": key, "value": value}

    async def rpc_config_get_pinned_models(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        return config.get_pinned_models()

    async def rpc_config_set_pinned_models(self, params: Dict[str, Any]) -> Dict[str, Any]:
        pinned = params.get("pinned", [])
        return {"success": True, "pinned": config.set_pinned_models(pinned)}

    async def rpc_config_toggle_pin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        model_id = params.get("model_id") or params.get("modelId")
        provider = params.get("provider", "")
        name = params.get("name", "")
        return {"success": True, "pinned": config.toggle_pinned_model(model_id, provider, name)}

    async def rpc_config_list_models(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        target_provider = params.get("provider") if params else None
        force_refresh = params.get("refresh", False) if params else False
        models = []
        try:
            from andromity.core.connections import provider_info
            providers_to_check = [target_provider] if target_provider else [p["id"] for p in provider_info()]
            pinned_list = config.get_pinned_models()

            async def _discover_connection(p: str) -> None:
                if p == "ollama":
                    return  # Installed models are probed below; never reuse a catalog snapshot.
                saved = config.get_provider_config(p) or {}
                if not force_refresh and get_cached_live_models(p):
                    return
                if force_refresh or (saved.get("type") in ("openai", "anthropic") and saved.get("base_url")):
                    try:
                        await asyncio.wait_for(asyncio.to_thread(
                            fetch_live_models_sync, p, api_key=config.get_api_key(p), base_url=saved.get("base_url"),
                        ), timeout=6.0)
                    except Exception:
                        pass

            await asyncio.gather(*[_discover_connection(p) for p in providers_to_check])

            def _is_pinned(m_id: str, p_key: str) -> bool:
                return any(p.get("id") == m_id and (not p.get("provider") or p.get("provider") == p_key) for p in pinned_list)

            # If OpenRouter not cached and not force_refresh, trigger background fetch without blocking
            openrouter_cached = get_cached_live_models("openrouter")
            if not openrouter_cached and ("openrouter" in providers_to_check):
                try:
                    asyncio.create_task(
                        asyncio.to_thread(fetch_live_models_sync, "openrouter", api_key=config.get_api_key("openrouter"))
                    )
                except Exception:
                    pass

            for p in providers_to_check:
                cached = get_cached_live_models(p)
                if p == "ollama":
                    saved = config.get_provider_config(p) or {}
                    try:
                        cached = await asyncio.wait_for(asyncio.to_thread(
                            fetch_live_models_sync, p, base_url=saved.get("base_url"),
                        ), timeout=3.0)
                    except Exception:
                        cached = []
                    if not cached:
                        continue
                if p == "openrouter" and openrouter_cached and not cached:
                    cached = openrouter_cached

                from andromity.core.reasoning import get_model_reasoning_capability
                if cached:
                    for m in cached:
                        m_id = m.get("id")
                        models.append({
                            "id": m_id,
                            "name": m.get("name", m_id),
                            "desc": m.get("desc", ""),
                            "provider": p,
                            "context": m.get("context", ""),
                            "context_limit": m.get("context_limit") or get_context_limit_for_model(p, m_id),
                            "pricing": m.get("pricing", ""),
                            "is_free": m.get("is_free", False) or m_id.lower().endswith(":free"),
                            "tags": m.get("tags", []),
                            "is_pinned": _is_pinned(m_id, p),
                            "reasoning": get_model_reasoning_capability(p, m_id, m).to_dict(),
                        })
                else:
                    # Fallback to catalog instantly
                    from andromity.core.models import get_models_for_provider
                    for m in get_models_for_provider(p):
                        m_id = m.get("id")
                        ctx = get_context_limit_for_model(p, m_id)
                        models.append({
                            "id": m_id,
                            "name": m.get("name", m_id),
                            "desc": m.get("desc", ""),
                            "provider": p,
                            "context": m.get("context", ""),
                            "context_limit": ctx,
                            "pricing": m.get("pricing", ""),
                            "is_free": m.get("is_free", False) or m_id.lower().endswith(":free"),
                            "tags": m.get("tags", []),
                            "is_pinned": _is_pinned(m_id, p),
                            "reasoning": get_model_reasoning_capability(p, m_id, m).to_dict(),
                        })
        except Exception as e:
            log.warning("Error listing models: %s", e)
        return models

    async def rpc_model_reasoning_capability(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Return the genuine reasoning capability for a given provider and model."""
        provider = params.get("provider", "openrouter") if params else "openrouter"
        model_id = params.get("model", "") if params else ""
        from andromity.core.reasoning import discover_model_reasoning_capability
        cap = await asyncio.to_thread(discover_model_reasoning_capability, provider, model_id)
        return cap.to_dict()

    async def rpc_config_refresh_models(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """Force refresh live models in parallel with strict timeout and resilient fallback."""
        target_provider = params.get("provider") if params else None
        from andromity.core.connections import provider_info
        providers = [target_provider] if target_provider else [p["id"] for p in provider_info()]

        async def _fetch_one(p: str):
            api_key = config.get_api_key(p)
            base_url = None
            p_conf = config.get_provider_config(p)
            if p_conf and isinstance(p_conf, dict):
                base_url = p_conf.get("base_url")
            try:
                timeout_val = 2.0 if p == "ollama" else 6.0
                return await asyncio.wait_for(
                    asyncio.to_thread(fetch_live_models_sync, p, api_key=api_key, base_url=base_url),
                    timeout=timeout_val
                )
            except Exception:
                return []

        try:
            # Fetch providers in parallel while keeping the model hub responsive.
            await asyncio.wait_for(
                asyncio.gather(*[_fetch_one(p) for p in providers], return_exceptions=True),
                timeout=7.0
            )
        except Exception as e:
            log.warning("Parallel model refresh encountered timeout or error: %s", e)

        return await self.rpc_config_list_models({"provider": target_provider})

    async def rpc_skills_list(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """List installed and discoverable skills."""
        project_path = params.get("project_path") if params else None
        target_path = str(Path(project_path).resolve()) if project_path else str(Path.cwd().resolve())
        skills = []
        try:
            from andromity.core.skills import SkillsManager
            mgr = SkillsManager(target_path)
            for s in mgr.installed():
                skills.append({
                    "name": s.name,
                    "description": s.description or "",
                    "path": str(s.path) if hasattr(s, "path") else "",
                    "scope": getattr(s, "scope", "project"),
                })
        except Exception as e:
            log.warning("Error listing skills: %s", e)
        return skills

    async def rpc_skills_browse(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """Browse remote skills available in public registries (Anthropic & Community)."""
        source_id = params.get("source_id") if params else None
        project_path = params.get("project_path") if params else None
        target_path = str(Path(project_path).resolve()) if project_path else str(Path.cwd().resolve())
        try:
            from andromity.core.skills import SkillsManager
            mgr = SkillsManager(target_path)
            remotes = await asyncio.to_thread(mgr.browse, source_id)
            return [
                {
                    "name": r.name,
                    "description": r.description or "",
                    "source_id": r.source_id,
                    "source_label": r.source_label,
                    "repo": r.repo,
                    "dir": r.dir,
                }
                for r in remotes
            ]
        except Exception as e:
            log.warning("Error browsing skills registry: %s", e)
            return []

    async def rpc_skills_install(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Install a remote skill from GitHub registries into local skills library."""
        name = params.get("name")
        source_id = params.get("source_id", "anthropic")
        scope = params.get("scope", "user")
        project_path = params.get("project_path")
        target_path = str(Path(project_path).resolve()) if project_path else str(Path.cwd().resolve())
        if not name:
            raise ValueError("Skill name is required")
        try:
            from andromity.core.skills import SkillsManager
            mgr = SkillsManager(target_path)
            installed = await asyncio.to_thread(mgr.install, name, source_id, scope)
            return {
                "success": bool(installed),
                "name": name,
                "path": str(installed.path) if installed else "",
            }
        except Exception as e:
            log.error("Failed to install skill %s: %s", name, e)
            return {"success": False, "error": str(e)}

    async def rpc_skills_remove(self, params: Dict[str, Any]) -> Dict[str, Any]:
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        if not config.is_trusted(project_path):
            return {"success": False, "error": "Trust this workspace before removing skills."}
        try:
            from andromity.core.skills import SkillsManager
            name = params.get("name", "")
            path = params.get("path")
            if not path:
                return {"success": False, "error": "Select an installed skill to remove."}
            removed = await asyncio.to_thread(SkillsManager(project_path).uninstall, name, path)
            return {"success": removed, "name": name}
        except (ValueError, OSError):
            return {"success": False, "error": "Could not remove this skill. Refresh the list and check folder permissions."}


    async def rpc_usage_get(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Get aggregate usage statistics and cost analytics (UsageTracker-backed)."""
        try:
            from andromity.core.usage_tracker import UsageTracker
            params = params or {}
            project_path = params.get("project_path") or None
            time_range = params.get("timeRange") or params.get("time_range") or "all"
            # normalize alias
            if time_range not in ("today", "week", "month", "all"):
                time_range = "all"
            tracker = UsageTracker()
            summary = tracker.get_summary(time_range=time_range, project_path=project_path)
            # Defaults preserve the existing latest-100 response for older clients.
            try:
                limit = max(1, min(100, int(params.get("limit", 100))))
                offset = max(0, int(params.get("offset", 0)))
            except (TypeError, ValueError, OverflowError):
                limit, offset = 100, 0
            if offset >= len(summary.sessions):
                offset = max(0, (len(summary.sessions) - 1) // limit * limit)
            from datetime import datetime, timezone
            hourly_activity: Dict[str, Dict[str, Any]] = {}
            for session in summary.sessions:
                try:
                    stamp = datetime.fromisoformat(session.updated_at or session.created_at)
                    if stamp.tzinfo is None:
                        stamp = stamp.replace(tzinfo=timezone.utc)
                    hour = stamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H")
                except (ValueError, TypeError):
                    continue
                bucket = hourly_activity.setdefault(hour, {"tokens": 0, "cost": 0.0, "count": 0})
                bucket["tokens"] += session.tokens
                bucket["cost"] += session.cost_usd
                bucket["count"] += 1
            result: Dict[str, Any] = {
                "total_tokens": summary.total_tokens,
                "total_cost_usd": summary.total_cost_usd,
                "total_sessions": summary.total_sessions,
                "daily_activity": summary.daily_activity,
                "hourly_activity": hourly_activity,
                "sessions_total": len(summary.sessions),
                "sessions_offset": offset,
                "sessions_limit": limit,
                "sessions": [
                    {
                        "id": s.session_id,
                        "name": s.name,
                        "provider": s.provider,
                        "model": s.model,
                        "token_total": s.tokens,
                        "cost_usd": s.cost_usd,
                        "created_at": s.created_at,
                        "updated_at": s.updated_at,
                        "project_path": s.project_path,
                    }
                    for s in summary.sessions[offset:offset + limit]
                ],
                "by_model": summary.by_model,
                "by_provider": summary.by_provider,
            }
            # Backward compat for callers expecting per-session fields
            session_id = params.get("session_id")
            if session_id and session_id in self._active_sessions:
                sess = self._active_sessions[session_id]
                result["session_tokens"] = getattr(sess, "token_total", 0)
                result["session_cost_usd"] = getattr(sess, "cost_usd", 0.0)
                result["message_count"] = len(getattr(sess, "messages", []))
            return result
        except Exception as exc:
            log.warning("usage.get error: %s", exc)
            return {
                "error": "Could not load usage. Please retry.",
                "total_tokens": 0,
                "total_cost_usd": 0.0,
                "total_sessions": 0,
                "sessions": [],
                "by_model": {},
                "by_provider": {},
            }

    async def rpc_config_set_api_key(self, params: Dict[str, Any]) -> Dict[str, Any]:
        provider = params.get("provider")
        api_key = params.get("api_key", "")
        if not provider:
            raise ValueError("provider is required")
        config.set_api_key(provider, api_key)
        config.save()
        return {"success": True, "provider": provider, "has_key": bool(api_key)}

    async def rpc_auth_logout(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        config.set_api_key("andromity", "")
        config.set("default", "user_name", "")
        config.set("default", "user_email", "")
        config.save()
        return {"success": True, "authenticated": False}

    async def rpc_config_list_providers(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        from andromity.core.connections import provider_info
        return provider_info()

    async def rpc_config_save_provider(self, params: Dict[str, Any]) -> Dict[str, Any]:
        name = config.save_provider(params)
        return {"success": True, "provider": name, "providers": await self.rpc_config_list_providers()}

    async def rpc_config_delete_provider(self, params: Dict[str, Any]) -> Dict[str, Any]:
        config.delete_provider(params["provider"])
        return {"success": True, "providers": await self.rpc_config_list_providers()}

    async def rpc_config_test_provider(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.connections import connection_failure, test_connection
        try:
            return await asyncio.wait_for(test_connection(params["provider"], params.get("model", "")), 30)
        except asyncio.TimeoutError:
            return connection_failure("timeout")
        except Exception:
            return connection_failure("generic")

    async def rpc_system_info(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Return system runtime details, version, python executable, tools count, etc."""
        import sys, os, platform
        from andromity import __version__
        from andromity.core.tools import CORE_TOOLS
        tools = [t.get("function", {}).get("name", "") for t in CORE_TOOLS if isinstance(t, dict)]

        exe = sys.executable
        # Detect if we are running from a PyInstaller bundle (bundled standalone binary)
        is_bundled = getattr(sys, "frozen", False)
        engine_mode = "Bundled Standalone Binary" if is_bundled else "System Python"

        return {
            "version": __version__,
            "engine_mode": engine_mode,
            "is_bundled": is_bundled,
            "python_version": platform.python_version(),
            "python_executable": exe,
            "os": f"{platform.system()} {platform.release()}",
            "pid": os.getpid(),
            "tools_count": len(tools),
            "tools": tools,
            "active_sessions": len(self._active_sessions),
        }

    # ── Trust & Security ────────────────────────────────────────────────────────

    async def rpc_trust_status(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Check if workspace is trusted and list all trusted project folders."""
        path = params.get("project_path") if params else None
        project_path = Path(path).resolve() if path else Path.cwd().resolve()
        is_trusted = config.is_trusted(str(project_path))
        trusted_map = config.get_root("trusted_projects", {}) or {}
        trusted_list = [
            {"key": k, "path": v.get("path", ""), "trusted_at": v.get("trusted_at", "")}
            for k, v in trusted_map.items()
        ]
        return {
            "is_trusted": is_trusted,
            "project_path": str(project_path),
            "trusted_projects": trusted_list,
        }

    async def rpc_trust_set(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Mark the project folder as trusted."""
        path = params.get("project_path") if params else None
        target = str(Path(path).resolve()) if path else str(Path.cwd().resolve())
        config.set_trusted(target)
        return {"success": True, "project_path": target, "is_trusted": True}

    async def rpc_trust_revoke(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Revoke trust from a project folder."""
        path = params.get("project_path") if params else None
        target = str(Path(path).resolve()) if path else str(Path.cwd().resolve())
        config.revoke_trust(target)
        return {"success": True, "project_path": target, "is_trusted": False}

    # ── Plan Approval ───────────────────────────────────────────────────────────

    async def rpc_plan_approve(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Mark the session's pending plan as approved (TUI parity)."""
        session_id = params.get("session_id")
        if not session_id:
            raise ValueError("session_id is required")
        session = self._get_or_load_session(session_id, params.get("project_path"))
        plan = session.load_plan_obj()
        if not plan:
            raise ValueError("No pending plan found for this session")
        plan.status = "approved"
        plan.save()
        enriched = plan.to_enriched_dict()
        session.save_plan(enriched)
        self.notify("agent/planUpdated", {
            "session_id": session_id,
            "plan": enriched,
        })
        return {"success": True, "status": "approved"}

    async def rpc_plan_reject(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Mark the session's pending plan as rejected (TUI parity)."""
        session_id = params.get("session_id")
        if not session_id:
            raise ValueError("session_id is required")
        session = self._get_or_load_session(session_id, params.get("project_path"))
        plan = session.load_plan_obj()
        if not plan:
            raise ValueError("No pending plan found for this session")
        plan.status = "rejected"
        plan.save()
        enriched = plan.to_enriched_dict()
        session.save_plan(enriched)
        self.notify("agent/planUpdated", {
            "session_id": session_id,
            "plan": enriched,
        })
        return {"success": True, "status": "rejected"}

    async def rpc_plan_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Get the current session's active plan."""
        session_id = params.get("session_id")
        if not session_id:
            return {"plan": None}
        session = self._get_or_load_session(session_id, params.get("project_path"))
        plan = session.load_plan_obj()
        return {"plan": plan.to_enriched_dict() if plan else None}


    # ── Git & Snapshots ─────────────────────────────────────────────────────────

    def _review_repo(self, params: Dict[str, Any], mutate: bool = False):
        project_path = Path(params.get("project_path") or Path.cwd()).resolve()
        if not config.is_trusted(str(project_path)):
            raise ValueError("Trust this workspace before reviewing or reverting files.")
        repo = get_repo(project_path)
        if mutate and repo:
            root = Path(repo.working_tree_dir).resolve()
            if str(root) in self._git_mutating_roots:
                raise ValueError("Another file restoration is in progress. Wait for it to finish.")
            for sid, task in self._running_tasks.items():
                session = self._active_sessions.get(sid)
                if not task.done() and session:
                    active_repo = get_repo(Path(session.project_path))
                    if active_repo and Path(active_repo.working_tree_dir).resolve() == root:
                        raise ValueError("Wait for all agent turns in this repository to finish before reverting.")
        return repo

    async def rpc_git_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.git_ops import status_entries
        repo = self._review_repo(params)
        try:
            if not repo:
                return {"is_git": False, "branch": None, "dirty": False, "files": []}
            entries = await asyncio.to_thread(status_entries, repo)
            project = Path(params.get("project_path") or Path.cwd()).resolve()
            entries = [entry for entry in entries
                       if (Path(repo.working_tree_dir) / entry["path"]).resolve().is_relative_to(project)]
            branch = "detached"
            try:
                branch = repo.active_branch.name
            except Exception:
                pass
            return {"is_git": True, "branch": branch, "dirty": bool(entries), "files": entries,
                    "repository_root": str(Path(repo.working_tree_dir).resolve()),
                    "untracked_files": [e["path"] for e in entries if e["status"] == "U"],
                    "modified_files": [e["path"] for e in entries if e["status"] != "U"]}
        finally:
            if repo:
                await asyncio.to_thread(repo.close)


    async def rpc_git_diff(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.git_review import review_base
        repo = self._review_repo(params)
        try:
            return {"diff": await asyncio.to_thread(repo.git.diff, "--no-ext-diff", "--no-renames", review_base(repo)) if repo else ""}
        finally:
            if repo:
                await asyncio.to_thread(repo.close)


    async def rpc_git_show_file(self, params: Dict[str, Any]) -> Dict[str, str]:
        from andromity.core.git_review import show_file
        repo = self._review_repo(params)
        try:
            if not repo:
                raise ValueError("Not a Git repository.")
            self._review_file_path(repo, params)
            return {"content": await asyncio.to_thread(show_file, repo, params.get("path", ""), params.get("ref", "HEAD"))}
        finally:
            if repo:
                await asyncio.to_thread(repo.close)


    async def rpc_git_file_diff(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.git_review import file_diff
        repo = self._review_repo(params)
        try:
            if repo:
                self._review_file_path(repo, params)
            return await asyncio.to_thread(file_diff, repo, params.get("path", "")) if repo else {"diff": ""}
        finally:
            if repo:
                await asyncio.to_thread(repo.close)


    async def rpc_git_diff_numstat(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.git_review import numstat
        repo = self._review_repo(params)
        try:
            stats = await asyncio.to_thread(numstat, repo) if repo else {}
            project = Path(params.get("project_path") or Path.cwd()).resolve()
            return {"files": {name: value for name, value in stats.items()
                              if (Path(repo.working_tree_dir) / name).resolve().is_relative_to(project)}}
        finally:
            if repo:
                await asyncio.to_thread(repo.close)


    async def rpc_git_revert_file(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from andromity.core.git_review import revert_file
        from andromity.core.git_ops import run_restoration
        repo = self._review_repo(params, mutate=True)
        try:
            if not repo:
                raise ValueError("Not a Git repository. No files were changed.")
            self._review_file_path(repo, params)
            root = str(Path(repo.working_tree_dir).resolve())
            self._git_mutating_roots.add(root)
            try:
                return await run_restoration(revert_file, repo, params.get("path", ""))
            finally:
                self._git_mutating_roots.discard(root)
        finally:
            if repo:
                await asyncio.to_thread(repo.close)


    def _review_file_path(self, repo, params: Dict[str, Any]) -> None:
        from andromity.core.git_ops import repository_path
        full, _ = repository_path(repo, params.get("path", ""))
        project = Path(params.get("project_path") or Path.cwd()).resolve()
        if not full.resolve().is_relative_to(project):
            raise ValueError("Choose a file inside the trusted workspace.")

    def _get_or_create_cron_scheduler(self, project_path: str):
        if project_path not in self._cron_schedulers:
            from andromity.core.cron import CronScheduler
            scheduler = CronScheduler(
                project_path,
                on_trigger=lambda job: asyncio.create_task(self._execute_cron_job(project_path, job, is_manual=False))
            )
            scheduler.start()
            self._cron_schedulers[project_path] = scheduler
        return self._cron_schedulers[project_path]

    def _make_cron_approval(self, cron_job):
        async def _approval(tool_name: str, args: dict) -> bool:
            cron_proj = getattr(cron_job, "project_path", None)
            if cron_proj and not config.is_trusted(cron_proj):
                if tool_name in ("write_file", "edit_file", "edit_file_multi", "shell_exec", "shell_bg", "shell_kill", "spawn_subagent"):
                    return False
            if cron_job.mode == "yolo":
                return True
            from andromity.core.security import is_sensitive_path
            target_path = str(args.get("path", "") or args.get("target_path", "") or args.get("target_file", "") or args.get("file_path", ""))
            if target_path and is_sensitive_path(target_path):
                return False
            if tool_name in ("shell_exec", "shell_bg"):
                from andromity.core.security import is_command_allowlisted
                command = str(args.get("command", "")).strip()
                allowed = cron_job.allowed_commands or config.get("default", "allowed_commands", [])
                return is_command_allowlisted(command, allowed)
            if tool_name in ("write_file", "edit_file", "edit_file_multi", "shell_kill", "spawn_subagent") and cron_job.mode == "safe":
                return False
            return True
        return _approval

    async def _execute_cron_job(self, project_path: str, job, is_manual: bool = False) -> Dict[str, Any]:
        from andromity.core.cron import CronStore, CronRunStore, CronRun
        from andromity.core.events import TextDelta, ToolCallStart, ToolResult
        from datetime import datetime, timezone
        import time

        run_store = CronRunStore(project_path)
        store = CronStore(project_path)

        cron_session = Session(
            session_id=f"cron-{job.id}-{int(time.time())}",
            name=f"Cron: {job.name}",
            project_path=project_path,
        )

        run = CronRun(
            id=str(uuid.uuid4())[:12],
            job_id=job.id,
            job_name=job.name,
            started_at=datetime.now(timezone.utc).isoformat(),
            prompt=job.prompt,
            model=job.model,
            provider=job.provider,
            session_id=cron_session.id,
            status="running",
        )
        run_store.save_run(run)
        self.notify("cron/run_started", {"job_id": job.id, "run": run.to_dict()})

        # Telemetry: track real scheduled execution vs seed preset execution
        try:
            from andromity.telemetry import send_feature_used
            is_seed = getattr(job, "name", "") in CRON_SEED_PRESET_NAMES
            if is_manual:
                send_feature_used("cron_seed_run_manual" if is_seed else "cron_user_run_manual")
            else:
                send_feature_used("cron_seed_run_auto" if is_seed else "cron_user_run_auto")
        except Exception:
            pass

        # ── Trust Governance Gate ──────────────────────────────────────────────
        if project_path and not config.is_trusted(project_path):
            error_msg = f"Workspace folder is untrusted. Trust this workspace in Andromity to allow autonomous cron runs."
            run.status = "failed"
            run.error = error_msg
            run.finished_at = datetime.now(timezone.utc).isoformat()
            run_store.save_run(run)
            self.notify("cron/run_completed", {"job_id": job.id, "run": run.to_dict(), "job": job.to_dict()})
            return run.to_dict()

        agent = Agent(
            session=cron_session,
            profile="builder",
            auto_approve=False,
            on_tool_approval=self._make_cron_approval(job),
            reasoning_effort="medium",
            provider=job.provider,
            model=job.model,
        )

        accumulated_text = []
        tools_used = []
        tool_executions = []
        active_tool_calls: dict = {}  # tool_id -> tool_name
        start_time = time.time()
        error_msg = None

        try:
            timeout = job.timeout_seconds if (hasattr(job, "timeout_seconds") and job.timeout_seconds > 0) else 600
            async with asyncio.timeout(timeout):
                async for event in agent.run(job.prompt):
                    if isinstance(event, TextDelta):
                        accumulated_text.append(event.text)
                    elif isinstance(event, ToolCallStart):
                        tools_used.append(event.tool_name)
                        active_tool_calls[event.tool_id] = event.tool_name
                    elif isinstance(event, ToolResult):
                        tool_name = active_tool_calls.pop(event.tool_id, "tool")
                        res_str = str(event.result)[:1000] if event.result is not None else ""
                        tool_executions.append({
                            "tool_name": tool_name,
                            "result": res_str,
                            "success": "[Rejected by User]" not in res_str,
                        })
        except asyncio.TimeoutError:
            error_msg = f"Execution timed out after {job.timeout_seconds}s"
        except Exception as e:
            error_msg = str(e)
            log.exception("Cron run error for '%s': %s", job.name, e)

        finished_at = datetime.now(timezone.utc).isoformat()
        duration_ms = int((time.time() - start_time) * 1000)
        full_output = "".join(accumulated_text).strip()

        try:
            cron_session.flush()
        except Exception:
            pass

        run.finished_at = finished_at
        run.duration_ms = duration_ms
        run.output = full_output
        run.output_preview = (full_output[:300] + "…") if len(full_output) > 300 else (full_output or ("Job completed successfully with no text output." if not error_msg else f"Failed: {error_msg}"))
        run.tools_used = list(dict.fromkeys(tools_used))
        run.tool_executions = tool_executions
        run.status = "success" if not error_msg else ("timeout" if "timed out" in str(error_msg).lower() else "failed")
        run.error = error_msg
        run.cost_usd = cron_session.cost_usd if hasattr(cron_session, "cost_usd") else 0.0
        run.session_id = cron_session.id

        run_store.save_run(run)

        # Update and persist cron status
        crons = store.load()
        for c in crons:
            if c.id == job.id:
                c.mark_run(success=(error_msg is None), error=error_msg)
                job = c
                break
        store.save(crons)

        # Also update in-memory scheduler crons
        if project_path in self._cron_schedulers:
            self._cron_schedulers[project_path]._crons = crons

        self.notify("cron/run_completed", {
            "job_id": job.id,
            "run": run.to_dict(),
            "job": job.to_dict(),
        })

        return run.to_dict()

    async def rpc_cron_list(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """List all scheduled cron jobs for the project, seeding smart default presets if empty."""
        project_path = params.get("project_path") or os.getcwd()
        scheduler = self._get_or_create_cron_scheduler(project_path)
        jobs = scheduler.list()

        if not jobs and not scheduler._store._path.exists():
            default_presets = [
                {
                    "name": "Run Tests & Verify Build",
                    "prompt": "Run the project test suite and report any failing tests, errors, or regressions.",
                    "schedule": "every 2h",
                    "mode": "trust",
                    "allowed_commands": ["pytest", "npm test", "npm run test", "git status"],
                },
                {
                    "name": "Daily Code Health & TODO Scanner",
                    "prompt": "Scan for new FIXME or TODO comments, check git diff/status, and summarize repository health.",
                    "schedule": "every 1d",
                    "mode": "safe",
                    "allowed_commands": ["git status", "git diff", "git log"],
                },
            ]
            for preset in default_presets:
                created = scheduler.add(
                    name=preset["name"],
                    prompt=preset["prompt"],
                    schedule=preset["schedule"],
                    provider=config.get("default", "provider", "anthropic"),
                    model=config.get("default", "model", "claude-sonnet-4-6"),
                    mode=preset["mode"],
                    allowed_commands=preset.get("allowed_commands", []),
                )
                # Keep newly seeded presets paused by default so user can review and enable explicitly
                created.enabled = False
            scheduler._store.save(scheduler._crons)
            jobs = scheduler.list()

        results = []
        for j in jobs:
            jd = j.to_dict()
            jd["next_run_in"] = j.next_run_in()
            try:
                latest_runs = scheduler.list_runs(j.id, limit=1)
                if latest_runs and latest_runs[0].session_id:
                    jd["latest_session_id"] = latest_runs[0].session_id
            except Exception:
                pass
            results.append(jd)
        return results

    async def rpc_cron_create(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new scheduled cron job."""
        project_path = params.get("project_path") or os.getcwd()
        scheduler = self._get_or_create_cron_scheduler(project_path)

        name = params.get("name") or "Scheduled Job"
        prompt = params.get("prompt") or ""
        schedule = params.get("schedule") or "every 1h"
        provider = params.get("provider") or config.get("default", "provider", "anthropic")
        model = params.get("model") or config.get("default", "model", "claude-sonnet-4-6")
        mode = params.get("mode") or "trust"
        allowed_raw = params.get("allowed_commands", "")
        if isinstance(allowed_raw, str):
            allowed_cmds = [c.strip() for c in allowed_raw.split(",") if c.strip()]
        elif isinstance(allowed_raw, list):
            allowed_cmds = allowed_raw
        else:
            allowed_cmds = []
        on_failure = params.get("on_failure", "notify")
        timeout_seconds = int(params.get("timeout_seconds", 600))

        job = scheduler.add(
            name=name,
            prompt=prompt,
            schedule=schedule,
            provider=provider,
            model=model,
            mode=mode,
            allowed_commands=allowed_cmds,
            on_failure=on_failure,
            timeout_seconds=timeout_seconds,
        )
        jd = job.to_dict()
        jd["next_run_in"] = job.next_run_in()

        # Telemetry: real custom cron created by user
        try:
            from andromity.telemetry import send_feature_used
            send_feature_used("cron_created")
        except Exception:
            pass

        return jd

    async def rpc_cron_toggle(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Toggle active/paused state of a scheduled cron job."""
        project_path = params.get("project_path") or os.getcwd()
        scheduler = self._get_or_create_cron_scheduler(project_path)
        job_id = params.get("id")
        if not job_id:
            raise ValueError("Missing cron job id")
        
        job = next((c for c in scheduler.list() if c.id == job_id), None)
        enabled = scheduler.toggle(job_id)

        # Telemetry: differentiate seed vs custom cron toggle
        try:
            from andromity.telemetry import send_feature_used
            is_seed = bool(job and job.name in CRON_SEED_PRESET_NAMES)
            send_feature_used("cron_seed_toggled" if is_seed else "cron_user_toggled")
        except Exception:
            pass

        return {"id": job_id, "enabled": enabled}

    async def rpc_cron_delete(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Delete a scheduled cron job."""
        project_path = params.get("project_path") or os.getcwd()
        scheduler = self._get_or_create_cron_scheduler(project_path)
        job_id = params.get("id")
        if not job_id:
            raise ValueError("Missing cron job id")
        deleted = scheduler.remove(job_id)
        return {"id": job_id, "deleted": deleted}

    async def rpc_cron_run_now(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Trigger immediate execution of a scheduled cron job."""
        project_path = params.get("project_path") or os.getcwd()
        scheduler = self._get_or_create_cron_scheduler(project_path)
        job_id = params.get("id")
        if not job_id:
            raise ValueError("Missing cron job id")
        job = next((c for c in scheduler.list() if c.id == job_id), None)
        if not job:
            raise ValueError(f"Cron job {job_id} not found")

        asyncio.create_task(self._execute_cron_job(project_path, job, is_manual=True))
        return {"id": job_id, "triggered": True}

    async def rpc_cron_runs(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Fetch execution run history for a cron job."""
        project_path = params.get("project_path") or os.getcwd()
        scheduler = self._get_or_create_cron_scheduler(project_path)
        job_id = params.get("id")
        limit = int(params.get("limit", 50))
        if not job_id:
            raise ValueError("Missing cron job id")
        runs = scheduler.list_runs(job_id, limit=limit)
        return [r.to_dict() for r in runs]

    def _extract_turn_files(self, session) -> list[str]:
        if not session or not getattr(session, "messages", None):
            return []

        last_user_idx = -1
        for i in range(len(session.messages) - 1, -1, -1):
            if session.messages[i].get("role") == "user" and not session.messages[i].get("steering"):
                last_user_idx = i
                break

        turn_msgs = session.messages[last_user_idx:] if last_user_idx >= 0 else session.messages

        write_tool_names = {
            "write_file", "write_to_file", "edit_file", "edit_file_multi",
            "multi_replace_file_content", "replace_file_content", "patch_file",
            "create_file", "delete_file", "move_file", "rename_file", "save_file"
        }

        proj_root = Path(session.project_path).resolve() if getattr(session, "project_path", None) else None
        edited_files: list[str] = []
        seen: set[str] = set()

        for msg in turn_msgs:
            if msg.get("role") != "assistant":
                continue
            tool_calls = msg.get("tool_calls") or []
            for tc in tool_calls:
                fn = tc.get("function") or {} if isinstance(tc, dict) else {}
                name = fn.get("name", "")
                if name not in write_tool_names:
                    continue
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        parsed = json.loads(args)
                    except Exception:
                        import re
                        m = re.search(r'"(?:TargetFile|file_path|target_file|target_path|path)"\s*:\s*"([^"]+)"', args)
                        parsed = {"path": m.group(1)} if m else {}
                elif isinstance(args, dict):
                    parsed = args
                else:
                    parsed = {}

                candidates = []
                for key in ("path", "target_path", "target_file", "file_path", "TargetFile"):
                    val = parsed.get(key)
                    if val and isinstance(val, str):
                        candidates.append(val)
                if isinstance(parsed.get("edits"), list):
                    for edit in parsed["edits"]:
                        if isinstance(edit, dict):
                            for key in ("path", "target_path", "file_path", "TargetFile"):
                                val = edit.get(key)
                                if val and isinstance(val, str):
                                    candidates.append(val)

                for path_str in candidates:
                    clean_str = path_str.strip()
                    if not clean_str:
                        continue
                    if proj_root:
                        try:
                            # Normalize backslashes for cross-platform compatibility
                            p = Path(clean_str.replace("\\", "/"))
                            if p.is_absolute():
                                clean_str = str(p.resolve().relative_to(proj_root.resolve()))
                        except Exception:
                            pass
                    norm = clean_str.replace("\\", "/").strip().lstrip("./")
                    if norm and norm not in seen:
                        seen.add(norm)
                        edited_files.append(norm)

        return edited_files

    async def _generate_ai_session_name(self, session: Session, prompt: str, provider: str, model: str):
        try:
            import sys, os
            if getattr(sys, "frozen", False):
                _mei = getattr(sys, "_MEIPASS", None)
                if _mei:
                    _price_file = os.path.join(_mei, "litellm", "model_prices_and_context_window_backup.json")
                    if not os.path.exists(_price_file):
                        os.makedirs(os.path.dirname(_price_file), exist_ok=True)
                        with open(_price_file, "w") as _f:
                            _f.write("{}")
            import litellm
            if not provider or not model:
                provider = config.get("default", "provider", "")
                model = config.get("default", "model", "")
            if not provider or not model:
                return

            from andromity.core.connections import provider_request
            kwargs = {**provider_request(provider, model), "stream": False}

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
                    session.name = name
                    session.save()
                    self.notify("session/updated", {
                        "session_id": session.id,
                        "name": session.name,
                        "message_count": len(session.messages),
                        "context_tokens": session.context_tokens,
                    })
        except Exception as e:
            log.debug("Failed to generate AI session name: %s (HTTP %s)", type(e).__name__, getattr(e, "status_code", "unknown"))

    # ── MCP & Skills ────────────────────────────────────────────────────────────

    async def rpc_mcp_add(self, params: Dict[str, Any]) -> Dict[str, Any]:
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        if not config.is_trusted(project_path):
            return {"success": False, "error": "Trust this workspace before adding MCP servers."}
        name = params.get("name")
        conf = params.get("config")
        if not isinstance(name, str) or not name.strip() or not isinstance(conf, dict):
            return {"success": False, "error": "A server name and configuration are required."}
        from andromity.core.mcp import MCPClientManager
        if name in MCPClientManager(project_path).load_config().get("mcpServers", {}):
            return {"success": False, "error": "That server name already exists. Choose another name."}
        command = conf.get("command")
        url = conf.get("url") or conf.get("serverUrl")
        from urllib.parse import urlparse
        if bool(command) == bool(url) or (command and not isinstance(command, str)):
            return {"success": False, "error": "Specify either a command or a remote HTTP URL."}
        if url and (not isinstance(url, str) or urlparse(url).scheme not in ("http", "https") or not urlparse(url).netloc):
            return {"success": False, "error": "Enter a valid HTTP or HTTPS server URL."}
        if not isinstance(conf.get("disabled", False), bool):
            return {"success": False, "error": "disabled must be true or false."}
        if not isinstance(conf.get("args", []), list) or any(not isinstance(a, str) for a in conf.get("args", [])):
            return {"success": False, "error": "Command arguments must be a JSON array of strings."}
        for key in ("headers", "env"):
            values = conf.get(key, {})
            if not isinstance(values, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in values.items()):
                return {"success": False, "error": "Headers and environment values must be strings."}
        oauth_config = conf.get("oauth", {})
        if not isinstance(oauth_config, dict) or any(not isinstance(oauth_config.get(key, ""), str) for key in ("client_id", "client_secret")):
            return {"success": False, "error": "OAuth client credentials must be strings."}
        if not config.add_mcp_server(project_path, name, conf):
            return {"success": False, "error": "Could not save MCP configuration. Check the file and folder permissions."}
        mgr = await self._ensure_mcp_started(project_path)
        if name not in mgr.server_status:
            await mgr.start_server(name)
        status = dict(mgr.server_status.get(name, {}))
        self.notify("mcp/statusChanged", {"name": name, "status": status})
        return {"success": True, "name": name, "status": status.get("status", "unknown")}

    async def rpc_mcp_remove(self, params: Dict[str, Any]) -> Dict[str, Any]:
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        if not config.is_trusted(project_path):
            return {"success": False, "error": "Trust this workspace before removing MCP servers."}
        name = params.get("name")
        if not isinstance(name, str) or not name:
            return {"success": False, "error": "Select an MCP server to remove."}
        if not config.remove_mcp_server(project_path, name):
            return {"success": False, "error": "Could not remove this server. Refresh the list and check folder permissions."}
        mgr = self._get_mcp_manager(project_path)
        await mgr.stop_server(name)
        from andromity.core.oauth import clear_token
        clear_token(name)
        # A lower-priority config may contain another entry with the same name.
        if name in mgr.load_config().get("mcpServers", {}):
            await mgr.start_server(name)
        self.notify("mcp/statusChanged", {"name": name, "status": dict(mgr.server_status.get(name, {}))})
        return {"success": True, "name": name}

    async def rpc_mcp_list_servers(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """Return a list of MCP server objects with live status, tool counts, and error details."""
        try:
            from andromity.core.mcp import MCPClientManager
            from andromity.core import tools as _tools_mod
            params = params or {}
            # Prefer daemon's own manager, fallback to global tools manager
            live_manager = self._mcp_manager or getattr(_tools_mod, "_mcp_manager", None)
            # Ensure manager is started at least once so status is live, but don't block on error
            if not self._mcp_started or params.get("project_path"):
                try:
                    # lazy start for first list call
                    live_manager = await self._ensure_mcp_started(params.get("project_path"))
                except Exception:
                    live_manager = self._mcp_manager

            # Load raw config entries
            project_path = params.get("project_path") or str(Path.cwd().resolve())
            tmp_mgr = MCPClientManager(project_path)
            cfg = tmp_mgr.load_config()
            servers_cfg: dict = cfg.get("mcpServers", {})

            # Live status dict from the running manager (if agent has initialised one)
            live_status: dict = {}
            live_sessions: dict = {}
            if live_manager:
                # refresh liveness before reporting
                try:
                    live_manager.check_liveness()
                except Exception:
                    pass
                live_status = live_manager.server_status or {}
                live_sessions = live_manager.sessions or {}

            result = []
            for name, srv_conf in servers_cfg.items():
                status_entry = live_status.get(name, {})
                session = live_sessions.get(name)
                tools_count = len(session.tools) if session and hasattr(session, "tools") else status_entry.get("tools", 0)
                status = status_entry.get("status", "unknown")
                command = srv_conf.get("command") or srv_conf.get("serverUrl") or srv_conf.get("url") or ""
                args = srv_conf.get("args", [])
                result.append({
                    "name": name,
                    "command": command,
                    "args": args,
                    "status": status,
                    "tools_count": tools_count,
                    "tools": [{"name": tool.name, "description": tool.description}
                              for tool in session.tools] if session and hasattr(session, "tools") else [],
                    "error": status_entry.get("error") or srv_conf.get("error") or None,
                    "error_detail": status_entry.get("error_detail") or None,
                    "disabled": srv_conf.get("disabled", False),
                    "remote": bool(srv_conf.get("serverUrl") or srv_conf.get("url") or "mcp-remote" in args or "mcp-remote" in str(srv_conf.get("command", ""))),
                    "updated_at": status_entry.get("updated_at") or None,
                })
            return result
        except Exception as exc:
            log.warning("mcp.list_servers error: %s", exc)
            return []

    async def rpc_mcp_list(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """Alias for mcp.list_servers — the VS Code extension calls this method name."""
        return await self.rpc_mcp_list_servers(params)

    async def rpc_mcp_restart(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Stop and restart the session for a named MCP server."""
        try:
            params = params or {}
            name = params.get("name") or params.get("server_name") or params.get("server")
            project_path = params.get("project_path") or str(Path.cwd().resolve())
            if not name:
                raise ValueError("name is required")
            mgr = await self._ensure_mcp_started(project_path)
            # Ensure manager looks at requested project
            try:
                mgr.project_path = str(Path(project_path).resolve())
            except Exception:
                mgr.project_path = project_path
            ok = await mgr.restart(name)
            status = dict(mgr.server_status.get(name, {}))
            self.notify("mcp/statusChanged", {"name": name, "status": status})
            return {"success": bool(ok), "name": name, "status": status.get("status", "unknown"), "detail": status}
        except Exception as e:
            log.warning("mcp.restart error: %s", e)
            return {"success": False, "error": str(e)}

    async def rpc_mcp_enable(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Enable (disabled=false) a server in mcp.json and restart it."""
        try:
            params = params or {}
            name = params.get("name") or params.get("server_name") or params.get("server")
            project_path = params.get("project_path") or str(Path.cwd().resolve())
            if not name:
                raise ValueError("name is required")
            from andromity.config import config as app_config
            ok = app_config.set_mcp_server_disabled(project_path, name, False)
            if not ok:
                # Server not found in any mcp.json — still try restart in case it's new
                log.warning("mcp.enable: server '%s' not found in any mcp.json", name)
            mgr = await self._ensure_mcp_started(project_path)
            try:
                mgr.project_path = str(Path(project_path).resolve())
            except Exception:
                mgr.project_path = project_path
            restarted = await mgr.restart(name)
            status = dict(mgr.server_status.get(name, {}))
            self.notify("mcp/statusChanged", {"name": name, "status": status})
            return {"success": bool(ok or restarted), "name": name, "status": status.get("status", "unknown"), "detail": status}
        except Exception as e:
            log.warning("mcp.enable error: %s", e)
            return {"success": False, "error": str(e)}

    async def rpc_mcp_disable(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Disable (disabled=true) a server in mcp.json and stop it."""
        try:
            params = params or {}
            name = params.get("name") or params.get("server_name") or params.get("server")
            project_path = params.get("project_path") or str(Path.cwd().resolve())
            if not name:
                raise ValueError("name is required")
            from andromity.config import config as app_config
            ok = app_config.set_mcp_server_disabled(project_path, name, True)
            if not ok:
                log.warning("mcp.disable: server '%s' not found in any mcp.json", name)
            mgr = self._get_mcp_manager(project_path)
            # If already started, stop and mark disabled
            if mgr and self._mcp_started:
                try:
                    if name in mgr.sessions:
                        await mgr.stop_server(name)
                except Exception:
                    pass
                # Ensure status reflects disabled (stop_server clears it)
                try:
                    mgr._set_status(name, status="disabled", tools=0, error=None, command=mgr.server_status.get(name, {}).get("command", "") if mgr.server_status.get(name) else "")
                except Exception:
                    pass
                status = dict(mgr.server_status.get(name, {}))
                if not status:
                    status = {"status": "disabled"}
                self.notify("mcp/statusChanged", {"name": name, "status": status})
                return {"success": bool(ok), "name": name, "status": status.get("status", "disabled"), "detail": status}
            return {"success": bool(ok), "name": name, "status": "disabled"}
        except Exception as e:
            log.warning("mcp.disable error: %s", e)
            return {"success": False, "error": str(e)}

    async def rpc_mcp_toggle(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Toggle enable/disable based on 'disabled' param."""
        try:
            params = params or {}
            disabled = params.get("disabled")
            # If disabled is True, caller wants to disable (toggle off)
            # If disabled is False, caller wants to enable
            # Also support 'enabled' param
            if disabled is None:
                # Fallback: check current config disabled flag and invert
                name = params.get("name") or params.get("server_name") or ""
                project_path = params.get("project_path") or str(Path.cwd().resolve())
                from andromity.core.mcp import MCPClientManager as _M
                tmp = _M(project_path)
                cfg = tmp.load_config().get("mcpServers", {}).get(name, {})
                disabled = not cfg.get("disabled", False)
            if disabled:
                return await self.rpc_mcp_disable(params)
            else:
                return await self.rpc_mcp_enable(params)
        except Exception as e:
            log.warning("mcp.toggle error: %s", e)
            return {"success": False, "error": str(e)}

    async def rpc_mcp_authenticate(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Trigger real OAuth 2.1 PKCE authorization flow for remote MCP server."""
        try:
            params = params or {}
            name = params.get("name") or params.get("server_name")
            project_path = params.get("project_path") or str(Path.cwd().resolve())
            if not name:
                raise ValueError("name is required")

            from andromity.core.mcp import MCPClientManager
            if not config.is_trusted(project_path):
                return {"success": False, "error": "Trust this workspace before authenticating MCP servers."}
            tmp_mgr = MCPClientManager(project_path)
            cfg = tmp_mgr.load_config().get("mcpServers", {}).get(name, {})
            server_url = cfg.get("serverUrl") or cfg.get("url") or ""

            if not server_url:
                # If command is something like npx mcp-remote https://...
                args = cfg.get("args", [])
                for arg in args:
                    if isinstance(arg, str) and (arg.startswith("http://") or arg.startswith("https://")):
                        server_url = arg
                        break

            if not server_url:
                return {"success": False, "error": f"No serverUrl found in config for '{name}'"}

            from andromity.core.oauth import full_oauth_flow

            progress = []
            def _status_cb(msg: str):
                progress.append(msg)
                self.notify("mcp/authProgress", {"name": name, "status": msg})

            if params.get("access_token"):
                from andromity.core.oauth import store_token
                token = params["access_token"]
                if not isinstance(token, str) or not token.strip():
                    return {"success": False, "error": "Enter a valid access token."}
                store_token(name, {"access_token": token.strip()}, "", "")
            else:
                token = await full_oauth_flow(name, server_url, _status_cb,
                                              client_id=cfg.get("oauth", {}).get("client_id"),
                                              client_secret=cfg.get("oauth", {}).get("client_secret"))
            if not token:
                return {"success": False, "error": progress[-1] if progress else "Authentication failed. Please retry."}

            # Restart the server now that token is saved in tokens.json
            mgr = await self._ensure_mcp_started(project_path)
            await mgr.restart(name)
            status = dict(mgr.server_status.get(name, {}))
            self.notify("mcp/statusChanged", {"name": name, "status": status})
            return {"success": True, "name": name, "authenticated": True, "status": status.get("status", "running")}
        except Exception as e:
            log.warning("mcp.authenticate error: %s", e)
            return {"success": False, "error": "Could not authenticate. Check the server configuration and retry."}

    async def rpc_mcp_auth(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Alias for mcp.authenticate."""
        return await self.rpc_mcp_authenticate(params)

    # ── Session Bus & Shared State ──────────────────────────────────────────────

    async def rpc_session_bus_get_state(self, params: Dict[str, Any]) -> Dict[str, Any]:
        try:
            from andromity.core.session_bus import SessionBus
            bus = SessionBus.get_instance()
            return {
                "active_sessions": bus.list_sessions(),
                "shared_state": bus.get_all_state() if hasattr(bus, "get_all_state") else {},
            }
        except Exception:
            return {"active_sessions": [], "shared_state": {}}
