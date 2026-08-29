import json
import pytest
from unittest.mock import patch
from andromity.core.session import Session
from andromity.core.tools import execute_tool, execute_tool_async, register_session
from andromity.core.events import Done, TextDelta


@pytest.fixture(autouse=True)
def setup_session(tmp_path):
    session = Session(name="main-session", project_path=str(tmp_path))
    register_session(session)
    return session


@pytest.mark.asyncio
async def test_execute_spawn_subagent():
    async def mock_stream(*args, **kwargs):
        yield TextDelta(text="Subagent finished task successfully.")
        yield Done(usage={"total_tokens": 60, "prompt_tokens": 40, "completion_tokens": 20})

    with patch("andromity.core.subagent.stream_completion", side_effect=mock_stream):
        result_str = await execute_tool_async("spawn_subagent", {
            "role": "search",
            "task": "Find modern CSS frameworks",
            "wait": True,
        })
        res = json.loads(result_str)
        assert res["status"] == "completed"
        assert "Subagent finished" in res["summary"]


@pytest.mark.asyncio
async def test_execute_shared_state_tools():
    # Set value
    res_set = execute_tool("shared_state_set", {
        "key": "auth.jwt_secret",
        "value": "super-secret-key",
    })
    assert "Shared state updated" in res_set

    # Get value
    res_get = execute_tool("shared_state_get", {
        "key": "auth.jwt_secret",
    })
    assert res_get == "super-secret-key"


@pytest.mark.asyncio
async def test_execute_handoff_tools(tmp_path):
    res_write = execute_tool("write_handoff", {
        "phase": "backend_api",
        "status": "complete",
        "produced": {"routes": ["/users", "/posts"]},
        "notes": "FastAPI router mounted at /api/v1",
    })
    assert "backend_api" in res_write

    res_read = execute_tool("read_handoff", {
        "phase": "backend_api",
    })
    data = json.loads(res_read)
    assert data["status"] == "complete"
    assert data["produced"]["routes"] == ["/users", "/posts"]


@pytest.mark.asyncio
async def test_execute_session_messaging_tools():
    from andromity.core.session_bus import SessionBus
    bus = SessionBus.reset_instance()
    bus.register("sess-1", "main-session")
    bus.register("sess-2", "worker-session")

    # List sessions
    res_list = execute_tool("session_list", {})
    assert "worker-session" in res_list

    # Send message
    res_send = await execute_tool_async("session_send_message", {
        "to_session": "worker-session",
        "content": "Hello worker!",
    })
    assert "Message sent successfully" in res_send

    # Broadcast
    res_bcast = await execute_tool_async("session_broadcast", {
        "content": "Attention all workers",
    })
    assert "Broadcast message delivered" in res_bcast
