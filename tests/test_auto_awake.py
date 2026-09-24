import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from andromity.core.session import Session
from andromity.core.tools import session_watch, _current_session_var
from andromity.server.rpc_handler import JsonRpcHandler
from andromity.core.events import SessionQuestionReceived, SessionAnswerReceived


@pytest.fixture
def clean_session(tmp_path):
    s = Session(name="WorkerSession", project_path=str(tmp_path))
    s.storage_dir = tmp_path
    s.file_path = tmp_path / f"{s.id}.json"
    s.save()
    return s


def test_session_watch_tool(clean_session):
    token = _current_session_var.set(clean_session)
    try:
        res = session_watch(target_session="ArchSession", reason="Waiting for API spec")
        assert "watching" in res
        assert clean_session.status == "watching"
        assert clean_session.watching_for == {"target_session": "ArchSession", "reason": "Waiting for API spec"}
    finally:
        _current_session_var.reset(token)


@pytest.mark.asyncio
async def test_auto_awake_dispatch_and_circuit_breaker(clean_session, monkeypatch):
    notifications = []
    def fake_notify(notif):
        notifications.append(notif)

    handler = JsonRpcHandler(send_notification=fake_notify)
    handler._active_sessions[clean_session.id] = clean_session

    # Mock rpc_agent_prompt to avoid running real LLM
    mock_prompt = AsyncMock(return_value={"success": True})
    handler.rpc_agent_prompt = mock_prompt

    # 1. First question -> should auto-wake (count becomes 1)
    await handler._handle_auto_awake(
        target_session_id=clean_session.id,
        from_session="ArchSession",
        from_session_id="arch-123",
        prompt_content="Question 1",
        trigger_type="question",
        question_id="q_1",
    )

    assert clean_session.consecutive_auto_wakes == 1
    assert "ArchSession" in clean_session.collaborators
    assert mock_prompt.call_count == 1
    assert mock_prompt.call_args[0][0]["is_auto_wake"] is True

    # 2. Second question -> should auto-wake (count becomes 2)
    await handler._handle_auto_awake(
        target_session_id=clean_session.id,
        from_session="ArchSession",
        from_session_id="arch-123",
        prompt_content="Question 2",
        trigger_type="question",
        question_id="q_2",
    )

    assert clean_session.consecutive_auto_wakes == 2
    assert mock_prompt.call_count == 2

    # 3. Third question -> hits circuit breaker (limit=2), must NOT auto-wake!
    await handler._handle_auto_awake(
        target_session_id=clean_session.id,
        from_session="ArchSession",
        from_session_id="arch-123",
        prompt_content="Question 3",
        trigger_type="question",
        question_id="q_3",
    )

    # Call count should still be 2 (blocked!)
    assert mock_prompt.call_count == 2
    assert clean_session.status == "paused_limit_reached"

    # Circuit breaker notification emitted
    tripped_notifs = [n for n in notifications if n.method == "session/autoWakeLimitReached"]
    assert len(tripped_notifs) == 1
    assert tripped_notifs[0].params["session_id"] == clean_session.id
    assert tripped_notifs[0].params["max_auto_wakes"] == 2


@pytest.mark.asyncio
async def test_human_prompt_resets_auto_wake_counter(clean_session):
    handler = JsonRpcHandler()
    handler._active_sessions[clean_session.id] = clean_session
    clean_session.consecutive_auto_wakes = 2
    clean_session.status = "paused_limit_reached"
    clean_session.save()

    # Reset via RPC method
    res = await handler.rpc_session_resetAutoWake({"session_id": clean_session.id})
    assert res["success"] is True
    assert clean_session.consecutive_auto_wakes == 0
    assert clean_session.status == "watching"


@pytest.mark.asyncio
async def test_anti_ping_pong_answer_does_not_wake(clean_session):
    handler = JsonRpcHandler()
    handler._active_sessions[clean_session.id] = clean_session
    mock_prompt = AsyncMock()
    handler.rpc_agent_prompt = mock_prompt

    # Dispatch SessionAnswerReceived event
    event = SessionAnswerReceived(
        question_id="q_123",
        from_session="ArchSession",
        to_session="WorkerSession",
        answer="Here is the API spec",
        timestamp="2026-09-24T00:00:00Z",
        from_session_id="arch-123",
        to_session_id=clean_session.id,
    )
    handler._on_session_bus_event(event)

    # Must NOT call prompt or increment auto-wake
    assert mock_prompt.call_count == 0
    assert clean_session.consecutive_auto_wakes == 0

