import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock

from andromity.core.session import Session
from andromity.core.session_bus import SessionBus
from andromity.core.tools import (
    session_watch,
    _current_session_var,
    session_ask_question_async,
    session_answer_question,
    register_session,
)
from andromity.server.rpc_handler import JsonRpcHandler
from andromity.core.events import (
    SessionQuestionReceived,
    SessionAnswerReceived,
    HandoffWritten,
    SessionMessageReceived,
)


@pytest.fixture
def temp_workspace(tmp_path):
    return tmp_path


@pytest.fixture
def setup_sessions(temp_workspace):
    bus = SessionBus.reset_instance()
    sess_a = Session(name="Backend", project_path=str(temp_workspace), session_id="sess_backend_1")
    sess_b = Session(name="Tester", project_path=str(temp_workspace), session_id="sess_tester_2")

    sess_a.storage_dir = temp_workspace
    sess_a.file_path = temp_workspace / f"{sess_a.id}.json"
    sess_a.save()

    sess_b.storage_dir = temp_workspace
    sess_b.file_path = temp_workspace / f"{sess_b.id}.json"
    sess_b.save()

    bus.register(sess_a.id, sess_a.name, sess_a.project_path)
    bus.register(sess_b.id, sess_b.name, sess_b.project_path)

    return sess_a, sess_b, bus


@pytest.mark.asyncio
async def test_session_watch_and_persistence(temp_workspace):
    """Test that session_watch sets status, watching_for, and persists to JSON and DB."""
    s = Session(name="Watcher", project_path=str(temp_workspace), session_id="sess_watch_test")
    s.storage_dir = temp_workspace
    s.file_path = temp_workspace / f"{s.id}.json"
    s.save()

    token = _current_session_var.set(s)
    try:
        res = session_watch(target_session="Backend", reason="Waiting for database migration")
        assert "watching" in res
        assert s.status == "watching"
        assert s.watching_for == {"target_session": "Backend", "reason": "Waiting for database migration"}

        # Verify JSON file has watching metadata
        s.save()
        loaded = Session.load(s.file_path)
        assert loaded.status == "watching"
        assert loaded.watching_for == {"target_session": "Backend", "reason": "Waiting for database migration"}
        assert loaded.consecutive_auto_wakes == 0
    finally:
        _current_session_var.reset(token)


@pytest.mark.asyncio
async def test_auto_awake_reactive_turn_dispatch(setup_sessions):
    """Test that an incoming question auto-wakes an idle/watching session with a formatted prompt."""
    sess_a, sess_b, bus = setup_sessions
    sess_b.status = "watching"
    sess_b.watching_for = {"target_session": "Backend", "reason": "Waiting for code"}
    sess_b.save()

    notifications = []
    handler = JsonRpcHandler(send_notification=lambda n: notifications.append(n))
    handler._active_sessions[sess_a.id] = sess_a
    handler._active_sessions[sess_b.id] = sess_b

    mock_prompt = AsyncMock(return_value={"success": True})
    handler.rpc_agent_prompt = mock_prompt

    # Dispatch SessionQuestionReceived event to Session B
    event = SessionQuestionReceived(
        question_id="q_1001",
        from_session="Backend",
        to_session="Tester",
        question="Can you run contract tests against storage.py?",
        timestamp="2026-09-24T01:00:00Z",
        from_session_id=sess_a.id,
        to_session_id=sess_b.id,
    )
    handler._on_session_bus_event(event)

    # Let event loop process the async task
    await asyncio.sleep(0.05)

    assert mock_prompt.call_count == 1
    call_args = mock_prompt.call_args[0][0]
    assert call_args["session_id"] == sess_b.id
    assert call_args["is_auto_wake"] is True
    assert "q_1001" in call_args["prompt"]
    assert "storage.py" in call_args["prompt"]
    assert sess_b.consecutive_auto_wakes == 1
    assert "Backend" in sess_b.collaborators
    assert "Tester" in sess_a.collaborators


@pytest.mark.asyncio
async def test_busy_session_does_not_spawn_concurrent_auto_wake(setup_sessions):
    """If a session is already actively running a turn, auto-wake must not launch a second turn."""
    sess_a, sess_b, bus = setup_sessions
    handler = JsonRpcHandler()
    handler._active_sessions[sess_b.id] = sess_b

    # Simulate an active background running task
    active_fut = asyncio.get_running_loop().create_future()
    active_task = asyncio.create_task(asyncio.sleep(10))
    handler._running_tasks[sess_b.id] = active_task

    mock_prompt = AsyncMock()
    handler.rpc_agent_prompt = mock_prompt

    await handler._handle_auto_awake(
        target_session_id=sess_b.id,
        from_session="Backend",
        from_session_id=sess_a.id,
        prompt_content="Are tests passing?",
        trigger_type="question",
        question_id="q_busy",
    )

    # Must NOT have called prompt because session is busy
    assert mock_prompt.call_count == 0
    assert sess_b.consecutive_auto_wakes == 0

    active_task.cancel()
    try:
        await active_task
    except asyncio.CancelledError:
        pass


@pytest.mark.asyncio
async def test_circuit_breaker_strict_limit(setup_sessions):
    """Test that when consecutive auto-wakes hit limit (2), execution halts and alerts."""
    sess_a, sess_b, bus = setup_sessions
    notifications = []
    handler = JsonRpcHandler(send_notification=lambda n: notifications.append(n))
    handler._active_sessions[sess_b.id] = sess_b

    mock_prompt = AsyncMock(return_value={"success": True})
    handler.rpc_agent_prompt = mock_prompt

    # Wake 1 -> allowed
    await handler._handle_auto_awake(
        target_session_id=sess_b.id,
        from_session="Backend",
        from_session_id=sess_a.id,
        prompt_content="Question 1",
        question_id="q_1",
    )
    assert mock_prompt.call_count == 1
    assert sess_b.consecutive_auto_wakes == 1

    # Wake 2 -> allowed (hits ceiling)
    await handler._handle_auto_awake(
        target_session_id=sess_b.id,
        from_session="Backend",
        from_session_id=sess_a.id,
        prompt_content="Question 2",
        question_id="q_2",
    )
    assert mock_prompt.call_count == 2
    assert sess_b.consecutive_auto_wakes == 2

    # Wake 3 -> TRIPPED!
    await handler._handle_auto_awake(
        target_session_id=sess_b.id,
        from_session="Backend",
        from_session_id=sess_a.id,
        prompt_content="Question 3",
        question_id="q_3",
    )
    # Call count still 2
    assert mock_prompt.call_count == 2
    assert sess_b.status == "paused_limit_reached"

    # Verify notification
    limit_notifs = [n for n in notifications if n.method == "session/autoWakeLimitReached"]
    assert len(limit_notifs) == 1
    assert limit_notifs[0].params["current_wakes"] == 2
    assert limit_notifs[0].params["max_auto_wakes"] == 2


@pytest.mark.asyncio
async def test_handoff_triggers_auto_wake(setup_sessions):
    """Test that a task handoff written to a session wakes it up with task summary."""
    sess_a, sess_b, bus = setup_sessions
    handler = JsonRpcHandler()
    handler._active_sessions[sess_a.id] = sess_a
    handler._active_sessions[sess_b.id] = sess_b

    mock_prompt = AsyncMock(return_value={"success": True})
    handler.rpc_agent_prompt = mock_prompt

    event = HandoffWritten(
        phase="phase1_backend",
        from_session="Backend",
        status="complete",
        summary="Backend API implementation complete. Ready for contract verification.",
        timestamp="2026-09-24T01:30:00Z",
    )
    # Set to_session dynamically as done during session coordination
    event.to_session = "Tester"
    handler._on_session_bus_event(event)
    await asyncio.sleep(0.05)

    assert mock_prompt.call_count == 1
    call_args = mock_prompt.call_args[0][0]
    assert call_args["session_id"] == sess_b.id
    assert "phase1_backend" in call_args["prompt"]
    assert "contract verification" in call_args["prompt"]


@pytest.mark.asyncio
async def test_anti_ping_pong_answers_do_not_wake(setup_sessions):
    """Test that answers to questions do not trigger auto-awake cycles."""
    sess_a, sess_b, bus = setup_sessions
    handler = JsonRpcHandler()
    handler._active_sessions[sess_a.id] = sess_a
    handler._active_sessions[sess_b.id] = sess_b

    mock_prompt = AsyncMock()
    handler.rpc_agent_prompt = mock_prompt

    event = SessionAnswerReceived(
        question_id="q_test",
        from_session="Tester",
        to_session="Backend",
        answer="All contract tests passed!",
        timestamp="2026-09-24T01:35:00Z",
        from_session_id=sess_b.id,
        to_session_id=sess_a.id,
    )
    handler._on_session_bus_event(event)
    await asyncio.sleep(0.05)

    assert mock_prompt.call_count == 0
    assert sess_a.consecutive_auto_wakes == 0


@pytest.mark.asyncio
async def test_broadcast_does_not_wake_all_sessions(setup_sessions):
    """Test that general broadcast messages do not blindly auto-wake idle sessions."""
    sess_a, sess_b, bus = setup_sessions
    handler = JsonRpcHandler()
    handler._active_sessions[sess_a.id] = sess_a
    handler._active_sessions[sess_b.id] = sess_b

    mock_prompt = AsyncMock()
    handler.rpc_agent_prompt = mock_prompt

    event = SessionMessageReceived(
        from_session="Backend",
        to_session="all",
        content="General announcement: server port changed to 8080",
        message_type="broadcast",
        timestamp="2026-09-24T01:40:00Z",
        from_session_id=sess_a.id,
        to_session_id="all",
    )
    handler._on_session_bus_event(event)
    await asyncio.sleep(0.05)

    assert mock_prompt.call_count == 0
    assert sess_b.consecutive_auto_wakes == 0


@pytest.mark.asyncio
async def test_human_reset_via_rpc_and_prompt(setup_sessions):
    """Test that human prompt and reset RPC both clear circuit breaker."""
    sess_a, sess_b, bus = setup_sessions
    handler = JsonRpcHandler()
    handler._active_sessions[sess_b.id] = sess_b

    sess_b.consecutive_auto_wakes = 2
    sess_b.status = "paused_limit_reached"
    sess_b.save()

    # 1. Reset via RPC
    res = await handler.rpc_session_resetAutoWake({"session_id": sess_b.id})
    assert res["success"] is True
    assert sess_b.consecutive_auto_wakes == 0
    assert sess_b.status == "watching"

    # Trip it again
    sess_b.consecutive_auto_wakes = 2
    sess_b.save()

    # 2. Reset via human prompt (is_auto_wake=False)
    # Mock agent execution
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(handler, "_get_or_load_session", lambda sid, path=None: sess_b)
        mp.setattr("andromity.server.rpc_handler.Agent", MagicMock())
        # Call rpc_agent_prompt
        await handler.rpc_agent_prompt({
            "session_id": sess_b.id,
            "prompt": "Hello from human",
            "is_auto_wake": False,
        })
        assert sess_b.consecutive_auto_wakes == 0
