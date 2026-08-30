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

    # ── Session Methods ─────────────────────────────────────────────────────────

    def _get_or_load_session(self, session_id: Optional[str] = None, project_path: Optional[str] = None) -> Session:
        if not session_id:
            if self._active_sessions:
                return next(reversed(self._active_sessions.values()))
            session_id = str(uuid.uuid4())

        if session_id in self._active_sessions:
            return self._active_sessions[session_id]

        target_dir = Path(project_path).resolve() if project_path else Path.cwd().resolve()
        storage_root = get_config_dir()
        
        # 1. Try project-specific sessions directory first
        project_hash = hashlib.sha256(str(target_dir).encode()).hexdigest()[:16]
        proj_session_file = storage_root / "sessions" / project_hash / f"{session_id}.json"
        if proj_session_file.exists():
            try:
                session = Session.load(proj_session_file)
                self._active_sessions[session_id] = session
                return session
            except Exception as e:
                log.warning("Failed to load session from %s: %s", proj_session_file, e)

        # 2. Search across any project storage directory in storage_root / sessions
        sessions_dir = storage_root / "sessions"
        if sessions_dir.exists():
            for p_dir in sessions_dir.iterdir():
                if p_dir.is_dir():
                    s_file = p_dir / f"{session_id}.json"
                    if s_file.exists():
                        try:
                            session = Session.load(s_file)
                            self._active_sessions[session_id] = session
                            return session
                        except Exception as e:
                            log.warning("Failed to load session from %s: %s", s_file, e)

        # 3. If not found on disk, create new session with this exact session_id
        short_id = session_id[:8] if session_id else "main"
        session = Session(name=f"session-{short_id}", project_path=str(target_dir), session_id=session_id)
        session.save()
        self._active_sessions[session_id] = session
        return session

    async def rpc_session_list(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        project_path = params.get("project_path")
        target_path = Path(project_path).resolve() if project_path else Path.cwd().resolve()

        sessions = []
        try:
            from andromity.core.session import Session, get_all_sessions
            raw_sessions = get_all_sessions(str(target_path))
            for s in raw_sessions:
                sessions.append({
                    "id": s.id,
                    "name": s.name,
                    "project_path": s.project_path,
                    "updated_at": getattr(s, "updated_at", None),
                    "created_at": getattr(s, "created_at", None),
                    "message_count": len(s.messages),
                    "token_total": getattr(s, "token_total", 0),
                    "cost_usd": getattr(s, "cost_usd", 0.0),
                    "provider": getattr(s, "provider", ""),
                    "model": getattr(s, "model", ""),
                })
        except Exception as e:
            log.warning("Session list from disk failed: %s", e)
            for sid, s in self._active_sessions.items():
                sessions.append({
                    "id": s.id,
                    "name": s.name,
                    "project_path": s.project_path,
                    "message_count": len(s.messages),
                    "token_total": getattr(s, "token_total", 0),
                    "cost_usd": getattr(s, "cost_usd", 0.0),
                })
        return sessions

    async def rpc_session_create(self, params: Dict[str, Any]) -> Dict[str, Any]:
        name = params.get("name", "new-session")
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        session_id = params.get("session_id")
        session = Session(name=name, project_path=project_path, session_id=session_id)
        session.save()
        self._active_sessions[session.id] = session
        return {
            "id": session.id,
            "name": session.name,
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
        if session_id in self._active_sessions:
            sess = self._active_sessions.pop(session_id)
            try:
                if hasattr(sess, "file_path") and Path(sess.file_path).exists():
                    Path(sess.file_path).unlink()
            except Exception:
                pass
        else:
            # Try removing file from disk across project session directories
            storage_root = get_config_dir()
            sessions_dir = storage_root / "sessions"
            if sessions_dir.exists():
                for p_dir in sessions_dir.iterdir():
                    if p_dir.is_dir():
                        s_file = p_dir / f"{session_id}.json"
                        if s_file.exists():
                            try:
                                s_file.unlink()
                            except Exception:
                                pass
        return {"success": True, "session_id": session_id}

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
        session = self._get_or_load_session(session_id, params.get("project_path"))
        model = getattr(session, "model", None) or config.get("default", "model", "claude-sonnet-4-6")
        provider = getattr(session, "provider", None) or config.get("default", "provider", "anthropic")
        agent = Agent(session=session, model=model, provider=provider)
        async for _ in agent._compact_context():
            pass
        return {"success": True, "message_count": len(session.messages)}

    async def rpc_session_undo(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session_id = params.get("session_id")
        session = self._get_or_load_session(session_id, params.get("project_path"))

        # Rollback git snapshot if available
        repo = get_repo(Path(session.project_path))
        rollback_msg = "No git snapshot available"
        if repo:
            try:
                snaps = list_snapshots(repo, limit=2)
                if snaps:
                    ok = restore_snapshot(repo, snaps[0]["hash"])
                    rollback_msg = f"Restored snapshot {snaps[0]['hash'][:7]}" if ok else "Failed to restore snapshot"
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
        # Primary source of truth is the requested mode parameter, falling back to config
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
                        allowed = config.get("default", "allowed_commands", [])
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

            if not needs_approval:
                return True

            approval_id = str(uuid.uuid4())
            fut = asyncio.get_running_loop().create_future()
            self._pending_approvals[approval_id] = fut

            if config.get("default", "sound_attention", True):
                try:
                    from andromity.core.audio import play_sound
                    play_sound("done.wav")
                except Exception:
                    pass

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
            self._pending_questions[question_id] = fut

            if config.get("default", "sound_attention", True):
                try:
                    from andromity.core.audio import play_sound
                    play_sound("done.wav")
                except Exception:
                    pass

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
            first_line = prompt.strip().split("\n")[0].strip()
            if first_line:
                short_title = first_line[:32].strip()
                if len(first_line) > 32:
                    short_title += "…"
                session.name = short_title
                session.save()
                self.notify("session/updated", {"session_id": session.id, "name": session.name})

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
                # Trigger snapshot in fire-and-forget background task so turn start is instantaneous
                try:
                    asyncio.create_task(asyncio.to_thread(create_pre_edit_snapshot, Path(session.project_path)))
                except Exception as snap_err:
                    log.debug("Pre-edit snapshot skipped: %s", snap_err)

                self.notify("agent/started", {"session_id": session_id})
                images = params.get("images")
                image_uris = params.get("image_uris")
                async for event in agent.run(prompt, images=images, image_uris=image_uris):
                    if isinstance(event, TextDelta):
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
                                    "plan": plan_obj.to_dict(),
                                })
                        except Exception:
                            pass
                    elif isinstance(event, PlanApprovalRequired):
                        plan_payload = event.plan
                        if hasattr(plan_payload, "to_dict"):
                            plan_payload = plan_payload.to_dict()
                        self.notify("agent/planApproval", {
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
                        self.notify("subagent/progress", {
                            "session_id": session_id,
                            "agent_id": event.agent_id,
                            "role": event.role,
                            "status": event.status,
                            "event_type": event.event_type,
                            "delta_text": event.delta_text,
                            "tool_name": event.tool_name,
                            "tool_args": event.tool_args,
                            "tool_result": event.tool_result,
                            "detail": event.detail,
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
                        if config.get("default", "sound_done", True):
                            try:
                                from andromity.core.audio import play_sound
                                play_sound("done.wav")
                            except Exception:
                                pass
                        self.notify("agent/done", {
                            "session_id": session_id,
                            "usage": event.usage,
                            "token_total": getattr(session, "token_total", 0),
                            "cost_usd": getattr(session, "cost_usd", 0.0),
                        })

                session.save()
            except asyncio.CancelledError:
                self.notify("agent/cancelled", {"session_id": session_id})
                log.info("Agent execution cancelled for session %s", session_id)
            except Exception as e:
                log.exception("Agent execution failed for session %s: %s", session_id, e)
                self.notify("agent/error", {
                    "session_id": session_id,
                    "error": str(e),
                    "traceback": traceback.format_exc(),
                })

        task = asyncio.create_task(_run_stream())
        self._running_tasks[session_id] = task

        return {"status": "started", "session_id": session_id}

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
        approved = params.get("approved", True)
        if approval_id in self._pending_approvals:
            fut = self._pending_approvals[approval_id]
            if not fut.done():
                fut.set_result(approved)
            return {"success": True, "approval_id": approval_id, "approved": approved}
        return {"success": False, "error": "Approval ID not found or already resolved"}

    async def rpc_agent_reject_tool(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self.rpc_agent_approve_tool({**params, "approved": False})

    async def rpc_agent_answer_question(self, params: Dict[str, Any]) -> Dict[str, Any]:
        question_id = params.get("question_id")
        answers = params.get("answers") or params.get("answer") or ""
        if isinstance(answers, (dict, list)):
            answer_str = json.dumps(answers)
        else:
            answer_str = str(answers)

        if question_id in self._pending_questions:
            fut = self._pending_questions[question_id]
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

        # Resolve any pending futures
        for aid, fut in list(self._pending_approvals.items()):
            if not fut.done():
                fut.set_result(False)
        for qid, fut in list(self._pending_questions.items()):
            if not fut.done():
                fut.set_result("Cancelled by user")

        return {"success": True, "session_id": session_id, "cancelled": cancelled}

    # ── Configuration & Models ──────────────────────────────────────────────────

    async def rpc_config_get(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        all_cfg = config.to_dict() if hasattr(config, "to_dict") else {}
        user = config.get_user() if hasattr(config, "get_user") else {}
        return {
            "config": all_cfg,
            "default_provider": config.get("default", "provider", "openrouter"),
            "default_model": config.get("default", "model", "anthropic/claude-3.7-sonnet"),
            "default_profile": config.get("default", "profile", "builder"),
            "permission_mode": config.get("default", "permission_mode", "safe"),
            "reasoning_effort": config.get("default", "reasoning_effort", "medium"),
            "user_name": user.get("name", ""),
            "user_email": user.get("email", ""),
            "max_subagents": config.get("subagents", "max_parallel", 3),
            "auto_compact": config.get("advanced", "auto_compact", True),
            "max_file_size_kb": config.get("advanced", "max_file_size_kb", 500),
            "is_trusted": config.is_trusted(params.get("project_path") or str(Path.cwd())) if params else False,
        }

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
        target_path = Path(project_path).resolve() if project_path else Path.cwd().resolve()
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
        try:
            from andromity.core.skills import SkillsManager
            mgr = SkillsManager()
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
        if not name:
            raise ValueError("Skill name is required")
        try:
            from andromity.core.skills import SkillsManager
            mgr = SkillsManager()
            installed = await asyncio.to_thread(mgr.install, name, source_id, scope)
            return {
                "success": bool(installed),
                "name": name,
                "path": str(installed.path) if installed else "",
            }
        except Exception as e:
            log.error("Failed to install skill %s: %s", name, e)
            return {"success": False, "error": str(e)}

    async def rpc_mcp_list(self, params: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """List configured MCP servers and their statuses."""
        servers = []
        try:
            mcp_conf = config.get("mcp_servers", {}) or {}
            if isinstance(mcp_conf, dict):
                for name, s_data in mcp_conf.items():
                    cmd = s_data.get("command", "") if isinstance(s_data, dict) else ""
                    args = s_data.get("args", []) if isinstance(s_data, dict) else []
                    servers.append({
                        "name": name,
                        "command": cmd,
                        "args": args,
                        "status": "configured",
                        "tools_count": len(s_data.get("tools", [])) if isinstance(s_data, dict) else 0,
                    })
        except Exception as e:
            log.warning("Error listing MCP servers: %s", e)
        return servers

    async def rpc_usage_get(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Get aggregate usage statistics and cost analytics."""
        session_id = params.get("session_id") if params else None
        session = self._active_sessions.get(session_id) if session_id else None
        return {
            "session_tokens": session.token_total if session else 0,
            "session_cost_usd": session.cost_usd if session else 0.0,
            "message_count": len(session.messages) if session else 0,
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
        return {
            "version": __version__,
            "python_version": platform.python_version(),
            "python_executable": sys.executable,
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

    # ── Workspace Trust ─────────────────────────────────────────────────────────

    async def rpc_trust_status(self, params: Dict[str, Any] = None) -> Dict[str, Any]:
        params = params or {}
        project_path = params.get("project_path") or str(Path.cwd())
        return {
            "is_trusted": config.is_trusted(project_path),
            "project_path": project_path,
        }

    async def rpc_trust_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        params = params or {}
        project_path = params.get("project_path") or str(Path.cwd())
        config.set_trusted(project_path)
        return {
            "success": True,
            "is_trusted": True,
            "project_path": project_path,
        }

    async def rpc_trust_revoke(self, params: Dict[str, Any]) -> Dict[str, Any]:
        params = params or {}
        project_path = params.get("project_path") or str(Path.cwd())
        config.revoke_trust(project_path)
        return {
            "success": True,
            "is_trusted": False,
            "project_path": project_path,
        }

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

    # ── Cron & Scheduled Jobs ───────────────────────────────────────────────────

    async def rpc_cron_list(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        try:
            from andromity.core.cron import CronStore
            store = CronStore(project_path)
            return [job.to_dict() if hasattr(job, "to_dict") else job for job in store.load()]
        except Exception as e:
            log.warning("Cron listing error: %s", e)
            return []

    async def rpc_cron_create(self, params: Dict[str, Any]) -> Dict[str, Any]:
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        try:
            from andromity.core.cron import CronStore, CronJob, parse_interval_seconds
            store = CronStore(project_path)
            crons = store.load()
            name = params.get("name") or "Scheduled Job"
            prompt = params.get("prompt") or ""
            schedule = params.get("schedule") or "every 1h"
            provider = params.get("provider") or config.get("default", "provider", "anthropic")
            model = params.get("model") or config.get("default", "model", "claude-sonnet-4-6")
            mode = params.get("mode") or "trust"
            interval = parse_interval_seconds(schedule)
            job = CronJob(
                id=str(uuid.uuid4())[:8],
                name=name,
                prompt=prompt,
                schedule=schedule,
                interval_seconds=interval,
                provider=provider,
                model=model,
                mode=mode,
            )
            crons.append(job)
            store.save(crons)
            return {"success": True, "job": job.to_dict()}
        except Exception as e:
            log.error("Cron create error: %s", e)
            return {"success": False, "error": str(e)}

    async def rpc_cron_toggle(self, params: Dict[str, Any]) -> Dict[str, Any]:
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        try:
            from andromity.core.cron import CronStore
            store = CronStore(project_path)
            crons = store.load()
            job_id = params.get("job_id") or params.get("id")
            for c in crons:
                if c.id == job_id:
                    c.enabled = not c.enabled
                    store.save(crons)
                    return {"success": True, "enabled": c.enabled}
            return {"success": False, "error": "Job not found"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def rpc_cron_delete(self, params: Dict[str, Any]) -> Dict[str, Any]:
        project_path = params.get("project_path") or str(Path.cwd().resolve())
        try:
            from andromity.core.cron import CronStore
            store = CronStore(project_path)
            crons = store.load()
            job_id = params.get("job_id") or params.get("id")
            crons = [c for c in crons if c.id != job_id]
            store.save(crons)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── MCP & Skills ────────────────────────────────────────────────────────────

    async def rpc_mcp_list_servers(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        try:
            from andromity.core.mcp import get_mcp_config
            cfg = get_mcp_config()
            return cfg.get("mcpServers", {}) if isinstance(cfg, dict) else []
        except Exception:
            return []

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
