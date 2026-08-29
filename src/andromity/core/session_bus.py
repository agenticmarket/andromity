import asyncio
import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set

from andromity.config import get_config_dir
from andromity.core.debug_log import get_logger
from andromity.core.events import (
    SessionAnswerReceived, SessionMessageReceived,
    SessionQuestionReceived, SessionRegistered, SessionUnregistered, StreamEvent
)

log = get_logger("session_bus")


@dataclass
class BusMessage:
    id: str
    from_session_id: str
    from_session_name: str
    to_session_id: str
    to_session_name: str
    content: str
    message_type: str = "message"  # "message" | "question" | "answer" | "broadcast"
    question_id: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class SessionRegistration:
    session_id: str
    name: str
    project_path: Optional[str] = None
    capabilities: List[str] = field(default_factory=list)
    registered_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    last_active_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class SessionBus:
    """In-process, client-agnostic async message and coordination bus for multi-session agent workflows."""

    _instance: Optional["SessionBus"] = None
    _lock = threading.RLock()

    def __init__(self):
        self._registrations: Dict[str, SessionRegistration] = {}
        # session_id -> asyncio.Queue of BusMessage
        self._mailboxes: Dict[str, asyncio.Queue] = {}
        # question_id -> asyncio.Future
        self._pending_questions: Dict[str, asyncio.Future] = {}
        # question_id -> BusMessage (metadata)
        self._question_records: Dict[str, BusMessage] = {}
        # Event callbacks: callable(StreamEvent)
        self._event_subscribers: List[Callable[[StreamEvent], None]] = []
        self._audit_log_path: Optional[Path] = None

    @classmethod
    def get_instance(cls) -> "SessionBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    @classmethod
    def reset_instance(cls):
        """Reset the singleton instance (useful for test isolation)."""
        with cls._lock:
            cls._instance = cls()
            return cls._instance

    def set_audit_log_path(self, path: Path):
        self._audit_log_path = path

    def _get_audit_log_path(self) -> Path:
        if self._audit_log_path:
            return self._audit_log_path
        p = get_config_dir() / "session_bus.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def _append_audit(self, event_type: str, data: Dict[str, Any]):
        try:
            log_path = self._get_audit_log_path()
            record = {
                "event": event_type,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "data": data,
            }
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except Exception as e:
            log.warning("Failed to write to session bus audit log: %s", e)

    def subscribe(self, callback: Callable[[StreamEvent], None]):
        """Subscribe a listener to session bus StreamEvents."""
        if callback not in self._event_subscribers:
            self._event_subscribers.append(callback)

    def unsubscribe(self, callback: Callable[[StreamEvent], None]):
        if callback in self._event_subscribers:
            self._event_subscribers.remove(callback)

    def _emit_event(self, event: StreamEvent):
        for sub in list(self._event_subscribers):
            try:
                sub(event)
            except Exception as e:
                log.warning("Error in SessionBus event subscriber: %s", e)

    # ── Registration ─────────────────────────────────────────────────────────

    def register(
        self,
        session_id: str,
        name: str,
        project_path: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
    ) -> SessionRegistration:
        """Register a session with the bus."""
        with self._lock:
            reg = SessionRegistration(
                session_id=session_id,
                name=name,
                project_path=project_path,
                capabilities=capabilities or [],
            )
            self._registrations[session_id] = reg
            if session_id not in self._mailboxes:
                self._mailboxes[session_id] = asyncio.Queue()
            
            self._append_audit("session_registered", {
                "session_id": session_id,
                "name": name,
                "project_path": project_path,
            })
            self._emit_event(SessionRegistered(
                session_id=session_id,
                name=name,
                project_path=project_path,
            ))
            log.info("Session registered on bus: %s (%s)", name, session_id)
            return reg

    def unregister(self, session_id: str):
        """Unregister a session from the bus."""
        with self._lock:
            reg = self._registrations.pop(session_id, None)
            self._mailboxes.pop(session_id, None)
            # Cancel any open question futures for this session
            for qid, fut in list(self._pending_questions.items()):
                record = self._question_records.get(qid)
                if record and (record.from_session_id == session_id or record.to_session_id == session_id):
                    if not fut.done():
                        fut.cancel()
                    self._pending_questions.pop(qid, None)
                    self._question_records.pop(qid, None)

            if reg:
                self._append_audit("session_unregistered", {"session_id": session_id, "name": reg.name})
                self._emit_event(SessionUnregistered(session_id=session_id))
                log.info("Session unregistered from bus: %s (%s)", reg.name, session_id)

    def list_sessions(self, project_path: Optional[str] = None) -> List[Dict[str, Any]]:
        """List active sessions, optionally filtered by project path."""
        with self._lock:
            res = []
            for s in self._registrations.values():
                if project_path and s.project_path and s.project_path != project_path:
                    continue
                res.append({
                    "session_id": s.session_id,
                    "name": s.name,
                    "project_path": s.project_path,
                    "capabilities": s.capabilities,
                    "registered_at": s.registered_at,
                    "last_active_at": s.last_active_at,
                })
            return res

    def resolve_session_id(self, target: str, from_session_id: Optional[str] = None) -> Optional[str]:
        """Resolve a session name or ID to an active session ID."""
        with self._lock:
            target_clean = target.strip()
            # 1. Exact ID match
            if target_clean in self._registrations:
                return target_clean
            # 2. Exact Name match
            for sid, reg in self._registrations.items():
                if reg.name.lower() == target_clean.lower():
                    return sid
            # 3. Partial ID match
            for sid in self._registrations.keys():
                if sid.startswith(target_clean):
                    return sid
            return None

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        from_session_id: str,
        to_target: str,
        content: str,
        message_type: str = "message",
    ) -> bool:
        """Send an asynchronous message to another session."""
        to_session_id = self.resolve_session_id(to_target, from_session_id)
        if not to_session_id:
            log.warning("SessionBus: target session '%s' not found.", to_target)
            return False

        with self._lock:
            from_reg = self._registrations.get(from_session_id)
            to_reg = self._registrations.get(to_session_id)
            from_name = from_reg.name if from_reg else from_session_id
            to_name = to_reg.name if to_reg else to_session_id

            msg_id = f"msg_{int(time.time()*1000)}"
            msg = BusMessage(
                id=msg_id,
                from_session_id=from_session_id,
                from_session_name=from_name,
                to_session_id=to_session_id,
                to_session_name=to_name,
                content=content,
                message_type=message_type,
            )

            mailbox = self._mailboxes.get(to_session_id)
            if mailbox is not None:
                await mailbox.put(msg)

            self._append_audit("message_sent", {
                "message_id": msg_id,
                "from": from_name,
                "to": to_name,
                "type": message_type,
                "content_preview": content[:120],
            })
            self._emit_event(SessionMessageReceived(
                from_session=from_name,
                to_session=to_name,
                content=content,
                message_type=message_type,
                timestamp=msg.created_at,
            ))
            return True

    async def ask_question(
        self,
        from_session_id: str,
        to_target: str,
        question: str,
        timeout: float = 60.0,
    ) -> str:
        """Ask another session a question and await its response with a strict timeout."""
        to_session_id = self.resolve_session_id(to_target, from_session_id)
        if not to_session_id:
            return f"Error: Target session '{to_target}' was not found or is offline."

        from_reg = self._registrations.get(from_session_id)
        to_reg = self._registrations.get(to_session_id)
        from_name = from_reg.name if from_reg else from_session_id
        to_name = to_reg.name if to_reg else to_session_id

        question_id = f"q_{int(time.time()*1000)}"
        loop = asyncio.get_running_loop()
        answer_future = loop.create_future()

        with self._lock:
            self._pending_questions[question_id] = answer_future
            msg = BusMessage(
                id=question_id,
                from_session_id=from_session_id,
                from_session_name=from_name,
                to_session_id=to_session_id,
                to_session_name=to_name,
                content=question,
                message_type="question",
                question_id=question_id,
            )
            self._question_records[question_id] = msg

            mailbox = self._mailboxes.get(to_session_id)
            if mailbox is not None:
                await mailbox.put(msg)

            self._append_audit("question_asked", {
                "question_id": question_id,
                "from": from_name,
                "to": to_name,
                "question": question,
            })
            self._emit_event(SessionQuestionReceived(
                question_id=question_id,
                from_session=from_name,
                to_session=to_name,
                question=question,
                timestamp=msg.created_at,
            ))

        # Wait for answer with timeout
        try:
            answer = await asyncio.wait_for(answer_future, timeout=timeout)
            return answer
        except asyncio.TimeoutError:
            with self._lock:
                self._pending_questions.pop(question_id, None)
                self._question_records.pop(question_id, None)
            return f"[Timeout] Session '{to_name}' did not answer within {timeout}s. Proceed with reasonable assumptions or check shared state."
        except asyncio.CancelledError:
            with self._lock:
                self._pending_questions.pop(question_id, None)
                self._question_records.pop(question_id, None)
            return f"[Cancelled] Question to '{to_name}' was cancelled."

    def answer_question(
        self,
        from_session_id: str,
        question_id: str,
        answer: str,
    ) -> bool:
        """Provide an answer to a pending question."""
        with self._lock:
            future = self._pending_questions.pop(question_id, None)
            record = self._question_records.pop(question_id, None)

            if not future or future.done() or not record:
                log.warning("SessionBus: No active question future found for id %s", question_id)
                return False

            future.set_result(answer)

            from_reg = self._registrations.get(from_session_id)
            from_name = from_reg.name if from_reg else from_session_id

            self._append_audit("question_answered", {
                "question_id": question_id,
                "from": from_name,
                "to": record.from_session_name,
                "answer_preview": answer[:120],
            })
            self._emit_event(SessionAnswerReceived(
                question_id=question_id,
                from_session=from_name,
                to_session=record.from_session_name,
                answer=answer,
                timestamp=datetime.now(timezone.utc).isoformat(),
            ))
            return True

    async def broadcast(
        self,
        from_session_id: str,
        content: str,
        project_path_only: bool = True,
    ) -> int:
        """Broadcast a message to all active sessions except the sender."""
        sent_count = 0
        from_reg = self._registrations.get(from_session_id)
        from_project = from_reg.project_path if from_reg else None
        from_name = from_reg.name if from_reg else from_session_id

        targets = []
        with self._lock:
            for sid, reg in self._registrations.items():
                if sid == from_session_id:
                    continue
                if project_path_only and from_project and reg.project_path and reg.project_path != from_project:
                    continue
                targets.append((sid, reg.name))

        for sid, name in targets:
            ok = await self.send_message(
                from_session_id=from_session_id,
                to_target=sid,
                content=content,
                message_type="broadcast",
            )
            if ok:
                sent_count += 1

        return sent_count

    def get_mailbox(self, session_id: str) -> Optional[asyncio.Queue]:
        with self._lock:
            return self._mailboxes.get(session_id)

    def get_pending_questions_for(self, session_id: str) -> List[Dict[str, Any]]:
        with self._lock:
            res = []
            for qid, record in self._question_records.items():
                if record.to_session_id == session_id:
                    res.append({
                        "question_id": qid,
                        "from_session": record.from_session_name,
                        "question": record.content,
                        "timestamp": record.created_at,
                    })
            return res
