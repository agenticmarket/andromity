import pytest
import asyncio
from andromity.core.session_bus import SessionBus
from andromity.core.tools import session_read_messages, session_answer_question, _current_session_var
from andromity.core.session import Session


@pytest.fixture(autouse=True)
def clean_bus(tmp_path):
    bus = SessionBus.reset_instance()
    bus.set_audit_log_path(tmp_path / "test_bus.jsonl")
    yield bus
    _current_session_var.set(None)


@pytest.mark.asyncio
async def test_session_drain_mailbox():
    bus = SessionBus.get_instance()
    bus.register("sess_a", "Agent A", "/tmp", ["coder"])
    bus.register("sess_b", "Agent B", "/tmp", ["coder"])

    assert bus.get_unread_count("sess_b") == 0

    await bus.send_message("sess_a", "sess_b", "Hello B, check this out")
    await bus.send_message("sess_a", "sess_b", "Another update")

    assert bus.get_unread_count("sess_b") == 2

    messages = bus.drain_mailbox("sess_b", max_count=5)
    assert len(messages) == 2
    assert messages[0].content == "Hello B, check this out"
    assert messages[1].content == "Another update"

    assert bus.get_unread_count("sess_b") == 0


@pytest.mark.asyncio
async def test_session_tools_read_and_answer():
    bus = SessionBus.get_instance()
    bus.register("sess_front", "Frontend", "/tmp", ["ui"])
    bus.register("sess_back", "Backend", "/tmp", ["api"])

    sess_front = Session(name="Frontend", project_path="/tmp", session_id="sess_front")
    sess_back = Session(name="Backend", project_path="/tmp", session_id="sess_back")

    _current_session_var.set(sess_back)
    assert "No unread messages" in session_read_messages()

    ask_task = asyncio.create_task(
        bus.ask_question("sess_front", "sess_back", "What is the endpoint URL?", timeout=5.0)
    )
    await asyncio.sleep(0.05)

    _current_session_var.set(sess_back)
    read_output = session_read_messages()
    assert "What is the endpoint URL?" in read_output
    assert "Pending Questions (1):" in read_output

    questions = bus.get_pending_questions_for("sess_back")
    assert len(questions) == 1
    qid = questions[0]["question_id"]

    answer_output = session_answer_question(qid, "It is /api/v1/data")
    assert "Successfully delivered answer" in answer_output

    received_answer = await ask_task
    assert received_answer == "It is /api/v1/data"


@pytest.mark.asyncio
async def test_rpc_session_coordination():
    from andromity.server.rpc_handler import JsonRpcHandler
    bus = SessionBus.get_instance()
    bus.register("sess_1", "Worker-1", "/tmp", ["coder"])
    bus.register("sess_2", "Worker-2", "/tmp", ["reviewer"])

    notifications = []
    handler = JsonRpcHandler(send_notification=lambda notif: notifications.append(notif))

    send_res = await handler.rpc_session_sendMessage({
        "from_session": "sess_1",
        "to_session": "sess_2",
        "content": "Please review PR #12",
    })
    assert send_res.get("success") is True

    read_res = await handler.rpc_session_readMessages({
        "session_id": "sess_2",
    })
    assert len(read_res.get("messages", [])) == 1
    assert read_res["messages"][0]["content"] == "Please review PR #12"

    ask_task = asyncio.create_task(handler.rpc_session_askQuestion({
        "from_session": "sess_1",
        "to_session": "sess_2",
        "question": "Is PR #12 approved?",
        "timeout": 5.0,
    }))
    await asyncio.sleep(0.05)

    pending_res = await handler.rpc_session_getPendingQuestions({
        "session_id": "sess_2",
    })
    assert len(pending_res.get("questions", [])) == 1
    qid = pending_res["questions"][0]["question_id"]

    ans_res = await handler.rpc_session_answerQuestion({
        "from_session": "sess_2",
        "question_id": qid,
        "answer": "Yes, LGTM",
    })
    assert ans_res.get("success") is True

    ask_res = await ask_task
    assert ask_res.get("success") is True
    assert ask_res.get("answer") == "Yes, LGTM"


@pytest.mark.asyncio
async def test_two_agents_concurrent_coordination(tmp_path):
    from andromity.core.agent import Agent
    from andromity.core.events import ToolCallStart, ToolCallDelta, ToolCallEnd, Done, TextDelta
    from unittest.mock import patch

    bus = SessionBus.get_instance()
    bus.register("sess_back", "Backend", str(tmp_path), ["coder"])
    bus.register("sess_front", "Frontend", str(tmp_path), ["coder"])

    sess_back = Session(name="Backend", project_path=str(tmp_path), session_id="sess_back")
    sess_front = Session(name="Frontend", project_path=str(tmp_path), session_id="sess_front")

    agent_back = Agent(sess_back, profile="coder", auto_approve=True)
    agent_front = Agent(sess_front, profile="coder", auto_approve=True)

    call_back = 0
    async def mock_stream_back(messages, tools=None, **kwargs):
        nonlocal call_back
        call_back += 1
        if call_back == 1:
            yield ToolCallStart(tool_name="session_send_message", tool_id="tc_send")
            yield ToolCallDelta(tool_id="tc_send", args_json_chunk='{"to_session":"Frontend","content":"Database tables ready"}')
            yield ToolCallEnd(tool_id="tc_send")
            yield Done()
        else:
            yield TextDelta(text="Done sending.")
            yield Done()

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream_back):
        async for _ in agent_back.run("Tell frontend we are ready"):
            pass

    assert bus.get_unread_count("sess_front") == 1

    call_front = 0
    async def mock_stream_front(messages, tools=None, **kwargs):
        nonlocal call_front
        call_front += 1
        if call_front == 1:
            yield ToolCallStart(tool_name="session_read_messages", tool_id="tc_read")
            yield ToolCallDelta(tool_id="tc_read", args_json_chunk='{}')
            yield ToolCallEnd(tool_id="tc_read")
            yield Done()
        else:
            yield TextDelta(text="Read messages.")
            yield Done()

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream_front):
        async for _ in agent_front.run("Check status"):
            pass

    assert bus.get_unread_count("sess_front") == 0
    tool_msgs = [m for m in sess_front.messages if m.get("role") == "tool"]
    assert any("Database tables ready" in m.get("content", "") for m in tool_msgs)


@pytest.mark.asyncio
async def test_two_agents_concurrent_question_answer(tmp_path):
    from andromity.core.agent import Agent
    from andromity.core.events import ToolCallStart, ToolCallDelta, ToolCallEnd, Done, TextDelta
    from unittest.mock import patch

    bus = SessionBus.get_instance()
    bus.register("sess_a", "Planner", str(tmp_path), ["planner"])
    bus.register("sess_b", "Engineer", str(tmp_path), ["coder"])

    sess_a = Session(name="Planner", project_path=str(tmp_path), session_id="sess_a")
    sess_b = Session(name="Engineer", project_path=str(tmp_path), session_id="sess_b")

    agent_a = Agent(sess_a, profile="planner", auto_approve=True)
    agent_b = Agent(sess_b, profile="coder", auto_approve=True)

    call_a = 0
    async def mock_stream_a(messages, tools=None, **kwargs):
        nonlocal call_a
        call_a += 1
        if call_a == 1:
            yield ToolCallStart(tool_name="session_ask_question", tool_id="tc_ask")
            yield ToolCallDelta(tool_id="tc_ask", args_json_chunk='{"to_session":"Engineer","question":"What auth type?","timeout":5.0}')
            yield ToolCallEnd(tool_id="tc_ask")
            yield Done()
        else:
            yield TextDelta(text="Received answer.")
            yield Done()

    call_b = 0
    async def mock_stream_b(messages, tools=None, **kwargs):
        nonlocal call_b
        call_b += 1
        if call_b == 1:
            pending = bus.get_pending_questions_for("sess_b")
            qid = pending[0]["question_id"] if pending else "q_none"
            yield ToolCallStart(tool_name="session_answer_question", tool_id="tc_ans")
            yield ToolCallDelta(tool_id="tc_ans", args_json_chunk=f'{{"question_id":"{qid}","answer":"OAuth2 with PKCE"}}')
            yield ToolCallEnd(tool_id="tc_ans")
            yield Done()
        else:
            yield TextDelta(text="Answered question.")
            yield Done()

    async def run_agent_a():
        with patch("andromity.core.agent.stream_completion", side_effect=mock_stream_a):
            async for _ in agent_a.run("Ask engineer"):
                pass

    async def run_agent_b():
        await asyncio.sleep(0.1)
        with patch("andromity.core.agent.stream_completion", side_effect=mock_stream_b):
            async for _ in agent_b.run("Answer pending question"):
                pass

    await asyncio.gather(run_agent_a(), run_agent_b())

    tool_msgs_a = [m for m in sess_a.messages if m.get("role") == "tool"]
    assert any("OAuth2 with PKCE" in m.get("content", "") for m in tool_msgs_a)
