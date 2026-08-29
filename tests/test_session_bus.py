import asyncio
import pytest
from pathlib import Path
from andromity.core.session_bus import SessionBus
from andromity.core.events import (
    SessionAnswerReceived, SessionMessageReceived,
    SessionQuestionReceived, SessionRegistered, SessionUnregistered
)


@pytest.fixture
def bus(tmp_path):
    bus = SessionBus.reset_instance()
    bus.set_audit_log_path(tmp_path / "test_bus.jsonl")
    return bus


def test_session_registration(bus):
    events = []
    bus.subscribe(lambda e: events.append(e))

    reg1 = bus.register(session_id="sess-1", name="auth-worker", project_path="/workspace")
    reg2 = bus.register(session_id="sess-2", name="ui-worker", project_path="/workspace")

    assert reg1.name == "auth-worker"
    assert len(bus.list_sessions()) == 2

    # Resolution
    assert bus.resolve_session_id("auth-worker") == "sess-1"
    assert bus.resolve_session_id("ui-worker") == "sess-2"
    assert bus.resolve_session_id("sess-1") == "sess-1"

    # Unregister
    bus.unregister("sess-1")
    assert len(bus.list_sessions()) == 1
    assert any(isinstance(e, SessionRegistered) for e in events)
    assert any(isinstance(e, SessionUnregistered) for e in events)


@pytest.mark.asyncio
async def test_session_send_message(bus):
    events = []
    bus.subscribe(lambda e: events.append(e))

    bus.register("sess-a", "auth-session")
    bus.register("sess-b", "ui-session")

    sent = await bus.send_message(
        from_session_id="sess-a",
        to_target="ui-session",
        content="JWT auth endpoints are ready at /api/auth/login",
    )
    assert sent is True

    mailbox_b = bus.get_mailbox("sess-b")
    assert mailbox_b is not None
    msg = await mailbox_b.get()
    assert msg.from_session_name == "auth-session"
    assert "/api/auth/login" in msg.content
    assert any(isinstance(e, SessionMessageReceived) for e in events)


@pytest.mark.asyncio
async def test_session_ask_and_answer_question(bus):
    bus.register("sess-auth", "auth-session")
    bus.register("sess-ui", "ui-session")

    # UI session asks Auth session a question
    async def simulate_ui_asking():
        ans = await bus.ask_question(
            from_session_id="sess-ui",
            to_target="auth-session",
            question="What is the token header format?",
            timeout=5.0,
        )
        return ans

    async def simulate_auth_answering():
        await asyncio.sleep(0.05)
        pending = bus.get_pending_questions_for("sess-auth")
        assert len(pending) == 1
        qid = pending[0]["question_id"]
        bus.answer_question(
            from_session_id="sess-auth",
            question_id=qid,
            answer="Authorization: Bearer <jwt_token>",
        )

    task_ask = asyncio.create_task(simulate_ui_asking())
    task_ans = asyncio.create_task(simulate_auth_answering())

    answer, _ = await asyncio.gather(task_ask, task_ans)
    assert "Bearer <jwt_token>" in answer


@pytest.mark.asyncio
async def test_session_ask_question_timeout(bus):
    bus.register("sess-1", "session-one")
    bus.register("sess-2", "session-two")

    ans = await bus.ask_question(
        from_session_id="sess-1",
        to_target="session-two",
        question="Are you ready?",
        timeout=0.05,
    )
    assert "Timeout" in ans


@pytest.mark.asyncio
async def test_session_broadcast(bus):
    bus.register("sess-main", "main", project_path="/proj")
    bus.register("sess-w1", "worker-1", project_path="/proj")
    bus.register("sess-w2", "worker-2", project_path="/proj")
    bus.register("sess-other", "other-project-worker", project_path="/other")

    delivered = await bus.broadcast(
        from_session_id="sess-main",
        content="Deployment v1.0 starting now",
        project_path_only=True,
    )
    assert delivered == 2

    # Check worker-1 mailbox
    mb1 = bus.get_mailbox("sess-w1")
    msg = await mb1.get()
    assert msg.content == "Deployment v1.0 starting now"
