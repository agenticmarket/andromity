import asyncio
import hashlib
import inspect
import json
import logging
import os
import sys
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from andromity.config import config, get_config_dir
from andromity.core.agent import Agent

READ_ONLY_TOOLS = {
    "list_dir", "view_file", "find_files", "grep_search",
    "file_outline", "read_symbol", "fetch_web_page", "web_search",
    "read_image", "semantic_search", "git_status", "git_diff", "git_log",
    "ask_questions", "ask_question", "fetch_context_bundle", "fetch_code_structure",
    "update_plan_step", "create_todo", "update_todo", "list_tools", "write_plan",
}
from andromity.core.events import (
    Done,
    HandoffWritten,
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
        self._pending_approvals: Dict[str, asyncio.Future] = {}
        self._pending_questions: Dict[str, asyncio.Future] = {}
        self._pending_plan_approvals: Dict[str, asyncio.Future] = {}
        self._cron_schedulers: Dict[str, Any] = {}
        self._mcp_manager: Optional[Any] = None
        self._mcp_started: bool = False

    def notify(self, method: str, params: Dict[str, Any]):
        """Send a JSON-RPC notification to the client."""
        if self.send_notification:
            notif = JsonRpcNotification(method=method, params=params)
            res = self.send_notification(notif)
            if inspect.isawaitable(res):
                asyncio.create_task(res)

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
            return JsonRpcResponse.err(
                request.id,
                INTERNAL_ERROR,
                str(e),
            )

    # ── MCP Manager helpers ─────────────────────────────────────────────────
    def _get_mcp_manager(self, project_path: Optional[str] = None):
        """Return (and lazily create) the daemon's MCPClientManager."""
        if self._mcp_manager is not None:
            if project_path:
                try:
                    resolved = str(Path(project_path).resolve())
                    if resolved != str(Path(self._mcp_manager.project_path).resolve()):
                        self._mcp_manager.project_path = resolved
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
            mgr = self._get_mcp_manager(project_path)
            if not self._mcp_started:
                try:
                    await mgr.start_all()
                except Exception as e:
                    log.warning("MCP start_all failed: %s", e)
                finally:
                    self._mcp_started = True
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
                    conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
                    try:
                        conn.execute("DELETE FROM session_messages WHERE session_id = ?", (sid,))
                    except Exception:
                        pass
                    self._active_sessions.pop(sid, None)
                    try:
                        s_file = (get_config_dir() / "sessions" / phash / f"{sid}.json").resolve()
                        if s_file.exists():
                            s_file.unlink()
                    except Exception:
                        pass
            try:
                conn.commit()
            except Exception:
                pass
        except Exception as prune_err:
            log.warning("Auto-pruning empty sessions error: %s", prune_err)

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
        return {
            "id": session.id,
            "name": session.name,
            "status": getattr(session, "status", "idle"),
            "project_path": session.project_path,
            "messages": session.messages,
            "token_total": getattr(session, "token_total", 0),
            "context_tokens": getattr(session, "context_tokens", 0),
            "cost_usd": getattr(session, "cost_usd", 0.0),
            "usage_breakdown": getattr(session, "usage_breakdown", {}),
            "plan": getattr(session, "plan", None),
            "compacted_history": getattr(session, "compacted_history", []),
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

        # 1. Delete from SQLite
        from andromity.core.db import get_conn, init_schema
        try:
            init_schema()
            conn = get_conn()
            conn.execute("DELETE FROM sessions WHERE id = ?", (valid_id,))
        except Exception as e:
            log.warning("Failed to delete session %s from SQLite: %s", valid_id, e)

        # 2. Delete JSON snapshot from disk
        if valid_id in self._active_sessions:
            sess = self._active_sessions.pop(valid_id)
            try:
                if hasattr(sess, "file_path") and Path(sess.file_path).exists():
                    p = Path(sess.file_path).resolve()
                    sessions_dir = (get_config_dir() / "sessions").resolve()
                    if p.is_relative_to(sessions_dir):
                        p.unlink()
            except Exception:
                pass
        else:
            storage_root = get_config_dir()
            sessions_dir = (storage_root / "sessions").resolve()
            if sessions_dir.exists():
                for p_dir in sessions_dir.iterdir():
                    if p_dir.is_dir():
                        s_file = (p_dir / f"{valid_id}.json").resolve()
                        if s_file.is_relative_to(sessions_dir) and s_file.exists():
                            try:
                                s_file.unlink()
                            except Exception:
                                pass
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

        # Rollback git snapshot if available
        repo = get_repo(Path(session.project_path))
        rollback_msg = "No git snapshot available"
        if repo:
            try:
                snap_hash = None
                if hasattr(session, "undo_stack") and session.undo_stack:
                    item = session.undo_stack.pop()
                    snap_hash = item.get("snapshot_hash")
                if not snap_hash:
                    snaps = list_snapshots(repo, limit=2)
                    if snaps:
                        snap_hash = snaps[0]["hash"]
                if snap_hash:
                    ok = restore_snapshot(repo, snap_hash)
                    rollback_msg = f"Restored snapshot {snap_hash[:7]}" if ok else "Failed to restore snapshot"
                else:
                    rollback_msg = "No snapshots recorded"
            except Exception as e:
                rollback_msg = f"Git rollback error: {e}"

        # Pop last assistant turn and user turn if present
        popped = 0
        while session.messages and session.messages[-1].get("role") != "user":
            session.messages.pop()
            popped += 1
        if session.messages and session.messages[-1].get("role") == "user":
            session.messages.pop()
            popped += 1
        session.save()

        return {"success": True, "popped_messages": popped, "git_status": rollback_msg}

    # ── Agent Execution & Streaming Methods ─────────────────────────────────────

    async def rpc_agent_prompt(self, params: Dict[str, Any]) -> Dict[str, Any]:
        prompt = params.get("prompt", "")
        if not prompt:
            raise ValueError("prompt is required")

        project_path = params.get("project_path")
        session_id = params.get("session_id")
        session = self._get_or_load_session(session_id, project_path)
        session_id = session.id

        if session_id in self._running_tasks and not self._running_tasks[session_id].done():
            raise RuntimeError(f"Session {session_id} is already running a turn.")

        profile = params.get("profile") or config.get("default", "profile", "builder")
        model = params.get("model") or config.get("default", "model", "claude-sonnet-4-6")
        provider = params.get("provider") or config.get("default", "provider", "anthropic")
        reasoning_effort = params.get("reasoning_effort") or config.get("default", "reasoning_effort", "medium")
        # Respect per-session mode passed from client, falling back to server default
        mode = (params.get("mode") or config.get("default", "permission_mode", "safe")).lower()
        is_trusted_workspace = config.is_trusted(session.project_path)
        auto_approve = mode in ("full", "yolo")

        # Create callbacks for interactive approval and clarifying questions
        async def _on_tool_approval(tool_name: str, args: Dict[str, Any]) -> bool:
            # 1. Untrusted workspace security check (matching TUI app.py:534)
            if not is_trusted_workspace and mode not in ("full", "yolo"):
                if tool_name in ("write_file", "edit_file", "edit_file_multi", "patch_file", "delete_file", "shell_exec", "shell_bg", "shell_kill"):
                    log.warning("Tool '%s' blocked — workspace %s is untrusted", tool_name, session.project_path)
                    return False

            # 2. YOLO / FULL mode auto-approves all actions
            if auto_approve or mode in ("full", "yolo"):
                return True

            from andromity.core.security import is_sensitive_path
            target_path = str(args.get("path", "") or args.get("target_path", "") or args.get("target_file", "") or args.get("file_path", ""))
            is_sensitive = is_sensitive_path(target_path) if target_path else False

            # 3. Read-only tools bypass approval UNLESS accessing sensitive credentials/keys
            if tool_name in READ_ONLY_TOOLS:
                if tool_name == "read_file" and is_sensitive:
                    pass  # Sensitive file (e.g. .env, id_rsa) requires approval even in read mode
                else:
                    return True

            needs_approval = False

            # 4. Mode-specific evaluation (exact match with TUI app.py:549-617)
            if tool_name in ("write_file", "edit_file", "edit_file_multi", "patch_file"):
                if mode == "safe":
                    needs_approval = True
                elif mode == "trust":
                    # In TRUST mode on trusted workspace, file modifications are auto-approved
                    return True

            elif tool_name in ("shell_exec", "shell_bg"):
                command = str(args.get("command", "")).strip()
                if mode == "safe":
                    needs_approval = True
                elif mode == "trust":
                    import shlex
                    import re as _re
                    _SHELL_META = _re.compile(r'[;&|`$(){}\\<>]')
                    if _SHELL_META.search(command):
                        needs_approval = True
                    else:
                        global_allowed = config.get("default", "allowed_commands", []) or []
                        session_allowed = getattr(session, "allowed_commands", []) or []
                        allowed = set(global_allowed) | set(session_allowed)
                        if not allowed:
                            needs_approval = True
                        else:
                            try:
                                cmd_token = shlex.split(command)[0] if command else ""
                            except ValueError:
                                cmd_token = ""
                            if not any(cmd_token == prefix or command.startswith(prefix + " ") or command == prefix for prefix in allowed):
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
                answer = await fut
                return str(answer)
            finally:
                self._pending_questions.pop(question_id, None)

        # Auto-title session from first user prompt if still default
        if session.name in ("new-session", "Main Session") or session.name.startswith("Session ") or session.name.startswith("session-"):
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
            auto_approve=auto_approve,
            on_tool_approval=_on_tool_approval,
            on_questions=_on_questions,
            reasoning_effort=reasoning_effort,
            provider=provider,
            model=model,
        )

        async def _run_stream():
            try:
                # Reset turn snapshot flag and take pre-turn snapshot
                session._turn_snapshotted = False
                try:
                    snap_hash = await asyncio.to_thread(create_pre_edit_snapshot, Path(session.project_path))
                    if snap_hash:
                        session._turn_snapshotted = True
                        if not hasattr(session, "undo_stack") or session.undo_stack is None:
                            session.undo_stack = []
                        session.undo_stack.append({
                            "snapshot_hash": snap_hash,
                            "msg_count": len(session.messages),
                        })
                except Exception as snap_err:
                    log.debug("Pre-edit snapshot skipped: %s", snap_err)

                images = params.get("images")
                image_uris = params.get("image_uris")
                self.notify("agent/started", {"session_id": session_id})
                session.set_status("running")
                async for event in agent.run(prompt, images=images, image_uris=image_uris):
                    if isinstance(event, TextDelta):
                        if "[Context compacting" in event.text:
                            self.notify("session/compacting", {
                                "session_id": session_id,
                                "reason": "Auto-compacting: context limit reached",
                            })
                        self.notify("agent/textDelta", {"session_id": session_id, "text": event.text})
                    elif isinstance(event, ThinkingDelta):
                        self.notify("agent/thinkingDelta", {"session_id": session_id, "text": event.text})
                    elif isinstance(event, ToolCallStart):
                        self.notify("agent/toolStart", {
                            "session_id": session_id,
                            "tool_id": event.tool_id,
                            "tool_name": event.tool_name,
                        })
                    elif isinstance(event, ToolCallDelta):
                        self.notify("agent/toolDelta", {
                            "session_id": session_id,
                            "tool_id": event.tool_id,
                            "chunk": event.args_json_chunk,
                        })
                    elif isinstance(event, ToolCallEnd):
                        self.notify("agent/toolEnd", {
                            "session_id": session_id,
                            "tool_id": event.tool_id,
                        })
                    elif isinstance(event, ToolResult):
                        self.notify("agent/toolResult", {
                            "session_id": session_id,
                            "tool_id": event.tool_id,
                            "result": event.result,
                        })
                        try:
                            from andromity.core.planner import Plan
                            plan_obj = Plan.load(session.project_path)
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
                        self.notify("agent/done", {
                            "session_id": session_id,
                            "usage": event.usage,
                            "token_total": getattr(session, "token_total", 0),
                            "context_tokens": getattr(session, "context_tokens", 0),
                            "cost_usd": getattr(session, "cost_usd", 0.0),
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

                session.set_status("idle")
                session.save()
            except asyncio.CancelledError:
                session.set_status("cancelled")
                self.notify("agent/cancelled", {
                    "session_id": session_id,
                    "token_total": getattr(session, "token_total", 0),
                    "context_tokens": getattr(session, "context_tokens", 0),
                    "cost_usd": getattr(session, "cost_usd", 0.0),
                })
                log.info("Agent execution cancelled for session %s", session_id)
            except Exception as e:
                session.set_status("error")
                log.exception("Agent execution failed for session %s: %s", session_id, e)
                self.notify("agent/error", {
                    "session_id": session_id,
                    "error": str(e),
                })

        task = asyncio.create_task(_run_stream())
        self._running_tasks[session_id] = task
        task.add_done_callback(lambda _: self._running_tasks.pop(session_id, None))

        return {"status": "started", "session_id": session_id}

    # Alias for client backwards-compatibility
    rpc_agent_run = rpc_agent_prompt

    async def rpc_agent_quickPrompt(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Lightweight single-turn completion for commit messages / summaries."""
        prompt = params.get("prompt", "")
        if not prompt:
            raise ValueError("prompt is required")
        project_path = params.get("project_path")
        model = params.get("model") or config.get("default", "model", "claude-sonnet-4-6")
        provider = params.get("provider") or config.get("default", "provider", "anthropic")
        # Use litellm directly for speed, fallback to Agent if unavailable
        try:
            import sys, os
            # PyInstaller bundled binary: litellm looks for model_prices_and_context_window_backup.json
            # in the extracted _MEIxxx temp folder which doesn't persist between runs.
            # Pre-create an empty stub so litellm won't crash with FileNotFoundError.
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
            from andromity.core.models import get_context_limit_for_model

            api_key = config.get_api_key(provider)
            base_url = None
            p_conf = config.get_provider_config(provider)
            if p_conf and isinstance(p_conf, dict):
                base_url = p_conf.get("base_url")

            model_id = model
            # litellm expects provider prefix for some models; try raw then with provider/
            messages = [{"role": "user", "content": prompt}]
            kwargs: Dict[str, Any] = {"model": model_id, "messages": messages, "temperature": 0.3, "max_tokens": 300}
            if api_key:
                kwargs["api_key"] = api_key
            if base_url:
                kwargs["api_base"] = base_url
            # Quick timeout: 25s
            resp = await asyncio.wait_for(asyncio.to_thread(lambda: litellm.completion(**kwargs)), timeout=25)
            text = ""
            try:
                text = resp.choices[0].message.content or ""
            except Exception:
                text = str(resp)
            if text.strip():
                return {"message": text.strip(), "result": text.strip()}
        except Exception as e:
            log.debug("quickPrompt litellm failed: %s, falling back to Agent", e)

        # Fallback: run a one-shot Agent without tools streaming, collect TextDelta
        session = Session(name="quick-prompt-temp", project_path=str(project_path or Path.cwd()))
        agent = Agent(session=session, model=model, provider=provider, auto_approve=True)
        collected = []
        async for event in agent.run(prompt):
            if isinstance(event, TextDelta):
                collected.append(event.text)
            elif isinstance(event, Done):
                break
        result = "".join(collected).strip()
        return {"message": result, "result": result}

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
                    log.warning("Tool approval session mismatch: %s != %s", session_id, stored_sid)
                session_id = session_id or stored_sid
            else:
                fut = item

            # If user approved with session or permanent scope, update session and config allowlists
            if approved and session_id:
                session = self._active_sessions.get(session_id)
                if session is None:
                    try:
                        session = Session.load_by_id(session_id)
                    except Exception:
                        pass

                if tool_name in ("shell_exec", "shell_bg"):
                    cmd = str(args.get("command", "")).strip()
                    if cmd:
                        try:
                            import shlex
                            prefix = shlex.split(cmd)[0]
                        except Exception:
                            prefix = cmd
                        if scope == "session" and session:
                            session.allow_command(prefix)
                            session.allow_command(cmd)
                        elif scope in ("always", "project"):
                            existing = config.get("default", "allowed_commands", []) or []
                            if prefix not in existing:
                                config.set("default", "allowed_commands", list(existing) + [prefix])
                            if session:
                                session.allow_command(prefix)
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
                    log.warning("Question answer session mismatch: %s != %s", session_id, stored_sid)
            else:
                fut = item
            if not fut.done():
                fut.set_result(answer_str)
            return {"success": True, "question_id": question_id}
        return {"success": False, "error": "Question ID not found or already resolved"}

    async def rpc_agent_cancel(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        if not session_id:
            raise ValueError("session_id is required")

        cancelled = False
        if session_id in self._running_tasks:
            task = self._running_tasks[session_id]
            if not task.done():
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
        return {
            "config": all_cfg,
            "default_provider": config.get("default", "provider", "openrouter"),
            "default_model": config.get("default", "model", "anthropic/claude-3.7-sonnet"),
            "default_profile": config.get("default", "profile", "builder"),
            "available_profiles": list(PROFILES.keys()),
            "available_reasoning_efforts": ["low", "medium", "high", "off"],
            "permission_mode": config.get("default", "permission_mode", "safe"),
            "reasoning_effort": config.get("default", "reasoning_effort", "medium"),
            "user_name": user.get("name", ""),
            "user_email": user.get("email", ""),
            "max_subagents": config.get("subagents", "max_parallel", 3),
            "auto_compact": config.get("advanced", "auto_compact", True),
            "max_file_size_kb": config.get("advanced", "max_file_size_kb", 500),
            "sound_done": config.get("default", "sound_done", True),
            "sound_attention": config.get("default", "sound_attention", True),
            "telemetry": config.get("default", "telemetry", True),
            "is_trusted": config.is_trusted(params.get("project_path") or str(Path.cwd())) if params else False,
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

    async def rpc_config_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        section = params.get("section", "default")
        key = params.get("key")
        value = params.get("value")
        if not key:
            raise ValueError("key is required")
        config.set(section, key, value)
        config.save()

        # If permission_mode is switched to trust/full/yolo, auto-approve any pending approvals!
        if key in ("permission_mode", "mode") and str(value).lower() in ("trust", "full", "yolo"):
            for app_id, fut in list(self._pending_approvals.items()):
                if not fut.done():
                    fut.set_result(True)
            self._pending_approvals.clear()

        return {"success": True, "section": section, "key": key, "value": value}

    async def rpc_config_list_models(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        target_provider = params.get("provider") if params else None
        force_refresh = params.get("refresh", False) if params else False
        models = []
        try:
            providers_to_check = [target_provider] if target_provider else list(MODEL_CATALOG.keys())

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
                cached = get_cached_live_models(p) if not force_refresh else []
                if p == "openrouter" and openrouter_cached and not cached:
                    cached = openrouter_cached

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
                            "is_free": m.get("is_free", False),
                            "tags": m.get("tags", []),
                        })
                else:
                    # Fallback to catalog instantly
                    for m in MODEL_CATALOG.get(p, {}).get("models", []):
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
                            "is_free": False,
                            "tags": [],
                        })
        except Exception as e:
            log.warning("Error listing models: %s", e)
        return models

    async def rpc_config_refresh_models(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """Force refresh live models in parallel with strict timeout."""
        target_provider = params.get("provider") if params else None
        providers = [target_provider] if target_provider else ["openrouter", "ollama", "anthropic", "openai", "google", "groq", "nvidia", "deepseek"]

        async def _fetch_one(p: str):
            api_key = config.get_api_key(p)
            base_url = None
            p_conf = config.get_provider_config(p)
            if p_conf and isinstance(p_conf, dict):
                base_url = p_conf.get("base_url")
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(fetch_live_models_sync, p, api_key=api_key, base_url=base_url),
                    timeout=3.5
                )
            except Exception:
                return []

        # Run all provider fetches in parallel
        await asyncio.gather(*[_fetch_one(p) for p in providers], return_exceptions=True)
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
            result: Dict[str, Any] = {
                "total_tokens": summary.total_tokens,
                "total_cost_usd": summary.total_cost_usd,
                "total_sessions": summary.total_sessions,
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
                    for s in summary.sessions[:50]
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

    async def rpc_config_list_providers(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        providers = [
            {"id": "openrouter", "name": "OpenRouter", "has_key": bool(config.get_api_key("openrouter")), "portal": "https://openrouter.ai/keys"},
            {"id": "anthropic", "name": "Anthropic (Claude)", "has_key": bool(config.get_api_key("anthropic")), "portal": "https://console.anthropic.com/settings/keys"},
            {"id": "openai", "name": "OpenAI (GPT / o-series)", "has_key": bool(config.get_api_key("openai")), "portal": "https://platform.openai.com/api-keys"},
            {"id": "google", "name": "Google Gemini", "has_key": bool(config.get_api_key("google")), "portal": "https://aistudio.google.com/app/apikey"},
            {"id": "deepseek", "name": "DeepSeek", "has_key": bool(config.get_api_key("deepseek")), "portal": "https://platform.deepseek.com/api_keys"},
            {"id": "groq", "name": "Groq Cloud", "has_key": bool(config.get_api_key("groq")), "portal": "https://console.groq.com/keys"},
            {"id": "nvidia", "name": "NVIDIA NIM", "has_key": bool(config.get_api_key("nvidia")), "portal": "https://build.nvidia.com/"},
            {"id": "ollama", "name": "Ollama (Local)", "has_key": True, "portal": "https://ollama.com"},
        ]
        return providers

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
        return {"success": True, "status": "rejected"}


    # ── Git & Snapshots ─────────────────────────────────────────────────────────

    async def rpc_git_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        project_path = Path(params.get("project_path") or Path.cwd()).resolve()
        repo = get_repo(project_path)
        if not repo:
            return {"is_git": False, "branch": None, "dirty": False}

        return {
            "is_git": True,
            "branch": str(repo.active_branch) if not repo.head.is_detached else "detached",
            "dirty": repo.is_dirty(untracked_files=True),
            "untracked_files": repo.untracked_files,
            "modified_files": [item.a_path for item in repo.index.diff(None)],
        }

    async def rpc_git_diff(self, params: Dict[str, Any]) -> Dict[str, Any]:
        project_path = Path(params.get("project_path") or Path.cwd()).resolve()
        repo = get_repo(project_path)
        if not repo:
            return {"diff": ""}

        try:
            diff_text = repo.git.diff("HEAD")
        except Exception:
            diff_text = repo.git.diff()
        return {"diff": diff_text}

    async def rpc_git_show_file(self, params: Dict[str, Any]) -> Dict[str, str]:
        """Return the content of a file at a given git ref (default HEAD)."""
        project_path = Path(params.get("project_path") or Path.cwd()).resolve()
        file_path = params.get("path", "")
        ref = params.get("ref", "HEAD")
        if not file_path:
            raise ValueError("path is required")

        repo = get_repo(project_path)
        if not repo:
            raise ValueError("Not a git repository")

        rel = Path(file_path).resolve().relative_to(project_path.resolve()).as_posix()
        try:
            content = repo.git.show(f"{ref}:{rel}")
        except Exception:
            content = ""
        return {"content": content}

    async def rpc_git_file_diff(self, params: Dict[str, Any]) -> Dict[str, str]:
        """Return the unified diff of a single file against HEAD."""
        project_path = Path(params.get("project_path") or Path.cwd()).resolve()
        file_path = params.get("path", "")
        if not file_path:
            raise ValueError("path is required")

        repo = get_repo(project_path)
        if not repo:
            return {"diff": ""}

        rel = Path(file_path).resolve().relative_to(project_path.resolve()).as_posix()
        try:
            diff_text = repo.git.diff("HEAD", "--", rel)
        except Exception:
            diff_text = ""
        return {"diff": diff_text}

    async def rpc_git_diff_numstat(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Return numstat diff (+additions, -deletions) for files against HEAD or index."""
        project_path = Path(params.get("project_path") or Path.cwd()).resolve()
        repo = get_repo(project_path)
        if not repo:
            return {"files": {}}

        files_stats: Dict[str, Dict[str, int]] = {}
        try:
            try:
                raw_numstat = repo.git.diff("HEAD", "--numstat")
            except Exception:
                raw_numstat = repo.git.diff("--numstat")

            for line in raw_numstat.splitlines():
                parts = line.strip().split("\t")
                if len(parts) >= 3:
                    add = int(parts[0]) if parts[0].isdigit() else 0
                    dele = int(parts[1]) if parts[1].isdigit() else 0
                    rel_p = parts[2].replace("\\", "/")
                    files_stats[rel_p] = {"additions": add, "deletions": dele}
        except Exception:
            pass

        try:
            for untracked in repo.untracked_files:
                p = project_path / untracked
                if p.is_file():
                    try:
                        line_count = sum(1 for _ in p.open("r", encoding="utf-8", errors="ignore"))
                        rel_p = Path(untracked).as_posix()
                        if rel_p not in files_stats:
                            files_stats[rel_p] = {"additions": line_count, "deletions": 0}
                    except Exception:
                        pass
        except Exception:
            pass

        return {"files": files_stats}

    # ── Cron & Scheduled Jobs ───────────────────────────────────────────────────

    def _get_or_create_cron_scheduler(self, project_path: str):
        if project_path not in self._cron_schedulers:
            from andromity.core.cron import CronScheduler
            scheduler = CronScheduler(
                project_path,
                on_trigger=lambda job: asyncio.create_task(self._execute_cron_job(project_path, job))
            )
            scheduler.start()
            self._cron_schedulers[project_path] = scheduler
        return self._cron_schedulers[project_path]

    async def _execute_cron_job(self, project_path: str, job) -> Dict[str, Any]:
        from andromity.core.cron import CronStore, CronRunStore, CronRun
        from andromity.core.events import TextDelta, ToolCallStart, ToolResult
        from datetime import datetime, timezone
        import time

        run_store = CronRunStore(project_path)
        store = CronStore(project_path)

        run = CronRun(
            id=str(uuid.uuid4())[:12],
            job_id=job.id,
            job_name=job.name,
            started_at=datetime.now(timezone.utc).isoformat(),
            prompt=job.prompt,
            model=job.model,
            provider=job.provider,
            status="running",
        )
        run_store.save_run(run)
        self.notify("cron/run_started", {"job_id": job.id, "run": run.to_dict()})

        # ── Trust Governance Gate ──────────────────────────────────────────────
        from andromity.core.session import normalize_project_path
        trusted_projects = config.get("trust", "trusted_projects", [])
        if project_path and trusted_projects:
            norm_path = normalize_project_path(project_path)
            if norm_path not in [normalize_project_path(p) for p in trusted_projects]:
                error_msg = f"Workspace folder is untrusted. Trust this workspace in Andromity to allow autonomous cron runs."
                run.status = "failed"
                run.error = error_msg
                run.finished_at = datetime.now(timezone.utc).isoformat()
                run_store.save_run(run)
                self.notify("cron/run_completed", {"job_id": job.id, "run": run.to_dict(), "job": job.to_dict()})
                return run.to_dict()

        # Create dedicated cron session
        cron_session = Session(
            session_id=f"cron-{job.id}-{int(time.time())}",
            name=f"Cron: {job.name}",
            project_path=project_path,
        )

        def _make_cron_approval(cron_job):
            async def _approval(tool_name: str, args: dict) -> bool:
                if cron_job.mode == "yolo":
                    return True
                if tool_name in ("shell_exec", "shell_bg"):
                    command = str(args.get("command", "")).strip()
                    allowed = cron_job.allowed_commands or config.get("default", "allowed_commands", [])
                    return any(command.startswith(p) for p in allowed)
                if tool_name in ("write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content") and cron_job.mode == "safe":
                    return False
                return True
            return _approval

        agent = Agent(
            session=cron_session,
            profile="builder",
            auto_approve=(job.mode in ("trust", "yolo", "full")),
            on_tool_approval=_make_cron_approval(job),
            reasoning_effort="medium",
            provider=job.provider,
            model=job.model,
        )

        accumulated_text = []
        tools_used = []
        tool_executions = []
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
                    elif isinstance(event, ToolResult):
                        tool_executions.append({
                            "tool_name": event.tool_name,
                            "result": str(event.result)[:1000] if event.result else "",
                            "success": event.success,
                        })
        except asyncio.TimeoutError:
            error_msg = f"Execution timed out after {job.timeout_seconds}s"
        except Exception as e:
            error_msg = str(e)
            log.exception("Cron run error for '%s': %s", job.name, e)

        finished_at = datetime.now(timezone.utc).isoformat()
        duration_ms = int((time.time() - start_time) * 1000)
        full_output = "".join(accumulated_text).strip()

        run.finished_at = finished_at
        run.duration_ms = duration_ms
        run.output = full_output
        run.output_preview = (full_output[:300] + "…") if len(full_output) > 300 else (full_output or ("Job completed successfully with no text output." if not error_msg else f"Failed: {error_msg}"))
        run.tools_used = list(dict.fromkeys(tools_used))
        run.tool_executions = tool_executions
        run.status = "success" if not error_msg else ("timeout" if "timed out" in str(error_msg).lower() else "failed")
        run.error = error_msg
        run.cost_usd = cron_session.cost_usd if hasattr(cron_session, "cost_usd") else 0.0

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

        # Seed default curated cron jobs for new projects so solo devs have instant value
        if not jobs:
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
        return jd

    async def rpc_cron_toggle(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Toggle active/paused state of a scheduled cron job."""
        project_path = params.get("project_path") or os.getcwd()
        scheduler = self._get_or_create_cron_scheduler(project_path)
        job_id = params.get("id")
        if not job_id:
            raise ValueError("Missing cron job id")
        enabled = scheduler.toggle(job_id)
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
        asyncio.create_task(self._execute_cron_job(project_path, job))
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
                    session.name = name
                    session.save()
                    self.notify("session/updated", {
                        "session_id": session.id,
                        "name": session.name,
                        "message_count": len(session.messages),
                        "context_tokens": session.context_tokens,
                    })
        except Exception as e:
            log.debug("Failed to generate AI session name: %s", e)

    # ── MCP & Skills ────────────────────────────────────────────────────────────

    async def rpc_mcp_list_servers(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """Return a list of MCP server objects with live status, tool counts, and error details."""
        try:
            from andromity.core.mcp import MCPClientManager
            from andromity.core import tools as _tools_mod
            params = params or {}
            # Prefer daemon's own manager, fallback to global tools manager
            live_manager = self._mcp_manager or getattr(_tools_mod, "_mcp_manager", None)
            # Ensure manager is started at least once so status is live, but don't block on error
            if live_manager is None:
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
                command = srv_conf.get("command") or srv_conf.get("serverUrl") or ""
                args = srv_conf.get("args", [])
                result.append({
                    "name": name,
                    "command": command,
                    "args": args,
                    "status": status,
                    "tools_count": tools_count,
                    "error": status_entry.get("error") or srv_conf.get("error") or None,
                    "error_detail": status_entry.get("error_detail") or None,
                    "disabled": srv_conf.get("disabled", False),
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

            def _status_cb(msg: str):
                self.notify("mcp/authProgress", {"name": name, "status": msg})

            token = await full_oauth_flow(name, server_url, _status_cb)
            if not token:
                return {"success": False, "error": "OAuth authorization flow was cancelled or failed"}

            # Restart the server now that token is saved in tokens.json
            mgr = await self._ensure_mcp_started(project_path)
            await mgr.restart(name)
            status = dict(mgr.server_status.get(name, {}))
            self.notify("mcp/statusChanged", {"name": name, "status": status})
            return {"success": True, "name": name, "authenticated": True, "status": status.get("status", "running")}
        except Exception as e:
            log.warning("mcp.authenticate error: %s", e)
            return {"success": False, "error": str(e)}

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
