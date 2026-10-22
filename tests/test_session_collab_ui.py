"""How session collaboration is presented: wake prompts, handoff payloads, the
"Answer now" action and the TUI cards."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from textual.app import App
from textual.color import Color

from andromity.core.events import (
    HandoffWritten, SessionMessageReceived, SessionQuestionReceived, SharedStateChanged,
)
from andromity.core.session import Session
from andromity.core.session_bus import BusMessage, SessionBus, handoff_wake_prompt, question_wake_prompt
from andromity.server.rpc_handler import JsonRpcHandler
from andromity.tui.app import AndromityApp
from andromity.tui.panels.chat import ChatMessage


@pytest.fixture(autouse=True)
def _trusted_and_fresh_bus(monkeypatch):
    from andromity.config import config
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    SessionBus.reset_instance()
    yield
    SessionBus.reset_instance()


@pytest.fixture
def worker(tmp_path):
    s = Session(name="worker", project_path=str(tmp_path))
    s.storage_dir = tmp_path
    s.file_path = tmp_path / f"{s.id}.json"
    s.permission_mode = "full"
    s.save()
    return s


def _pending_question(to_session: Session, question_id: str = "q_1", question: str = "Who owns the schema?") -> None:
    SessionBus.get_instance()._question_records[question_id] = BusMessage(
        id=question_id, from_session_id="arch-id", from_session_name="architect",
        to_session_id=to_session.id, to_session_name=to_session.name,
        content=question, message_type="question", question_id=question_id,
    )


def test_wake_prompts_keep_the_headers_clients_recognise():
    # vscode-extension/src/providers/promptDisplay.ts parses these headers; saved histories use them too.
    q = question_wake_prompt("architect", "q_1", "Who owns the schema?")
    assert q.startswith("[Incoming Question from co-agent 'architect' (ID: q_1)]:\n\"Who owns the schema?\"\n\nPlease address this question")
    assert "session_message(reply_to='q_1'" in q
    h = handoff_wake_prompt("architect", "api", "Phase 'api' marked done by session 'architect'")
    assert h.startswith("[Incoming Task Handoff from co-agent 'architect' (Phase: api)]:\nSummary: Phase 'api' marked done")
    assert "\n\nPlease review the handoff details with handoff(phase='api')" in h


def test_handoff_notification_carries_phase_and_status():
    notes = []
    handler = JsonRpcHandler(send_notification=notes.append)
    handler._on_session_bus_event(HandoffWritten(
        phase="api", from_session="architect", status="done",
        summary="Phase 'api' marked done by session 'architect'", timestamp="2026-10-19T00:00:00Z",
    ))
    params = next(n.params for n in notes if n.method == "session/handoffWritten")
    assert params["phase"] == "api"
    assert params["status"] == "done"
    assert params["task_summary"] == "Phase 'api' marked done by session 'architect'"
    assert params["handoff_id"] == "api"


@pytest.mark.asyncio
async def test_answer_now_starts_a_capped_turn_and_clears_the_limit(worker):
    handler = JsonRpcHandler()
    handler._active_sessions[worker.id] = worker
    worker.consecutive_auto_wakes = 2
    worker.set_status("paused_limit_reached")
    _pending_question(worker)
    handler.rpc_agent_prompt = AsyncMock(return_value={"status": "started"})

    res = await handler.rpc_session_wakeForQuestion({"session_id": worker.id, "question_id": "q_1"})

    assert res == {"success": True, "delivery": "started"}
    params = handler.rpc_agent_prompt.call_args[0][0]
    assert params["prompt"] == question_wake_prompt("architect", "q_1", "Who owns the schema?")
    assert params["mode"] == "trust", "content from another session never runs above TRUST"
    assert worker.consecutive_auto_wakes == 0
    assert worker.status != "paused_limit_reached"
    assert worker.permission_mode == "full", "the user's own mode is kept for their next prompt"


@pytest.mark.asyncio
async def test_answer_now_steers_a_running_turn(worker):
    handler = JsonRpcHandler()
    handler._active_sessions[worker.id] = worker
    _pending_question(worker)
    running = asyncio.get_running_loop().create_future()
    handler._running_tasks[worker.id] = running
    handler.rpc_agent_submit = AsyncMock(return_value={})
    handler.rpc_agent_prompt = AsyncMock()
    try:
        res = await handler.rpc_session_wakeForQuestion({"session_id": worker.id, "question_id": "q_1"})
    finally:
        running.cancel()
    assert res == {"success": True, "delivery": "steer"}
    assert handler.rpc_agent_submit.call_args[0][0]["delivery"] == "steer"
    handler.rpc_agent_prompt.assert_not_called()


@pytest.mark.asyncio
async def test_answer_now_reports_answered_or_expired_questions(worker):
    handler = JsonRpcHandler()
    handler._active_sessions[worker.id] = worker
    handler.rpc_agent_prompt = AsyncMock()
    res = await handler.rpc_session_wakeForQuestion({"session_id": worker.id, "question_id": "q_gone"})
    assert res == {"success": False, "reason": "not_pending"}
    handler.rpc_agent_prompt.assert_not_called()


def _route(event, session_name="worker", session_id="worker-id"):
    chat = MagicMock()
    fake_app = SimpleNamespace(
        session=SimpleNamespace(id=session_id, name=session_name),
        query_one=lambda _cls: chat, notify=MagicMock(),
    )
    AndromityApp._handle_session_bus_event_ui(fake_app, event)
    return chat, fake_app.notify


def test_tui_shows_its_own_messages_without_ids():
    chat, notify = _route(SessionQuestionReceived(
        question_id="q_1", from_session="architect", to_session="worker", question="Who owns the schema?",
        to_session_id="worker-id",
    ))
    chat.add_session_question.assert_called_once_with("architect", "Who owns the schema?")
    notify.assert_not_called()


def test_tui_stays_quiet_about_other_sessions_traffic():
    chat, notify = _route(SessionMessageReceived(
        from_session="architect", to_session="reviewer", content="ping", to_session_id="reviewer-id",
    ))
    chat.add_session_message.assert_not_called()
    notify.assert_not_called()


def test_tui_skips_its_own_shared_state_and_handoffs():
    chat, _ = _route(SharedStateChanged(key="api", old_value=None, new_value={"v": 2}, author_session="worker"))
    chat.add_shared_state_notification.assert_not_called()
    chat, _ = _route(HandoffWritten(phase="api", from_session="worker", status="done", summary="s"))
    chat.add_handoff_notification.assert_not_called()

    chat, _ = _route(SharedStateChanged(key="api", old_value=None, new_value={"v": 2}, author_session="architect"))
    chat.add_shared_state_notification.assert_called_once_with("architect", "api", {"v": 2})
    chat, _ = _route(HandoffWritten(phase="api", from_session="architect", status="done", summary="Phase 'api' marked done"))
    chat.add_handoff_notification.assert_called_once_with("architect", "Phase 'api' marked done")


class _CardApp(App):
    def compose(self):
        yield ChatMessage("session-question", content="Who owns [the] schema?", heading="Question from builder", id="card")


@pytest.mark.asyncio
async def test_tui_card_keeps_single_word_session_names_and_uses_theme_colours():
    app = _CardApp()
    async with app.run_test():
        card = app.query_one("#card", ChatMessage)
        text = str(card.query_one("Static").render())
        assert "Question from builder" in text, text
        assert "Who owns [the] schema?" in text
        assert card.styles.border_left[0] == "solid", "card styles must apply to the message itself"
        assert card.styles.border_left[1].hex == Color.parse(app.get_css_variables()["accent"]).hex
