"""Collaboration is five tools, offered only when there is another session to work with."""
from datetime import datetime, timedelta, timezone

import pytest

from andromity.core import tools
from andromity.core.agent import Agent
from andromity.core.events import Done, ToolCallDelta, ToolCallEnd, ToolCallStart, ToolResult, TextDelta
from andromity.core.profiles import filter_tools_for_profile
from andromity.core.session import Session
from andromity.core.session_bus import SessionBus
from andromity.core.tools import (
    COLLAB_TOOLS, CORE_TOOLS, collab_action, collaboration_available, expand_collab_call, requires_workspace_trust,
)
from andromity.server.rpc_handler import READ_ONLY_TOOLS, SESSION_DRIVING_TOOLS

OLD_NAMES = {"session_send_message", "session_ask_question", "session_broadcast", "session_list", "session_read_messages",
             "session_answer_question", "shared_state_set", "shared_state_get", "write_handoff", "read_handoff"}


@pytest.fixture(autouse=True)
def _fresh_bus():
    SessionBus.reset_instance()
    yield
    SessionBus.reset_instance()


def _names(tool_list) -> set:
    return {t["function"]["name"] for t in tool_list}


def test_eleven_tools_became_five():
    names = _names(CORE_TOOLS)
    assert COLLAB_TOOLS <= names
    assert not (OLD_NAMES & names), "the single-purpose tools are no longer advertised"


@pytest.mark.parametrize("name, args, action, call", [
    ("session_message", {"to": "api", "content": "hi"}, "session_send_message", {"to_session": "api", "content": "hi"}),
    ("session_message", {"to": "api", "content": "which db?", "wait_for_answer": True, "timeout": 30},
     "session_ask_question", {"to_session": "api", "question": "which db?", "timeout": 30}),
    ("session_message", {"to": "all", "content": "v2 is out"}, "session_broadcast", {"content": "v2 is out"}),
    ("session_message", {"content": "postgres", "reply_to": "q_1"}, "session_answer_question", {"question_id": "q_1", "answer": "postgres"}),
    ("shared_state", {"key": "db"}, "shared_state_get", {"key": "db"}),
    ("shared_state", {"key": "db", "value": {"engine": "pg"}}, "shared_state_set", {"key": "db", "value": {"engine": "pg"}}),
    ("handoff", {"phase": "api"}, "read_handoff", {"phase": "api"}),
    ("handoff", {"phase": "api", "status": "complete", "notes": "n", "to_session": "Tester"}, "write_handoff",
     {"phase": "api", "status": "complete", "notes": "n", "to_session": "Tester"}),
])
def test_each_call_runs_as_the_action_it_stands_for(name, args, action, call):
    assert collab_action(name, args) == action
    assert expand_collab_call(name, args) == (action, call)


def test_approval_and_trust_rules_follow_the_action():
    assert collab_action("session_inbox", {}) in READ_ONLY_TOOLS
    assert collab_action("shared_state", {"key": "k"}) in READ_ONLY_TOOLS
    assert collab_action("shared_state", {"key": "k", "value": 1}) in SESSION_DRIVING_TOOLS
    assert collab_action("session_message", {"to": "x", "content": "c", "wait_for_answer": True}) in SESSION_DRIVING_TOOLS
    assert requires_workspace_trust(collab_action("session_inbox", {})) is False
    assert requires_workspace_trust(collab_action("handoff", {"phase": "p", "status": "complete"})) is True


def test_old_names_still_run(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "_is_trusted", lambda: True)
    session = Session(name="t", project_path=str(tmp_path))
    token = tools._current_session_var.set(session)
    try:
        assert "updated" in tools.execute_tool("shared_state_set", {"key": "db", "value": "pg"}).lower()
        assert tools.execute_tool("shared_state_get", {"key": "db"}) == "pg"
        assert tools.execute_tool("shared_state", {"key": "db"}) == "pg"
        inbox = tools.execute_tool("session_inbox", {})
        assert "No unread messages" in inbox
    finally:
        tools._current_session_var.reset(token)


def test_profiles_keep_their_limits():
    reviewer = _names(filter_tools_for_profile(CORE_TOOLS, "reviewer"))
    assert {"session_inbox", "session_message", "shared_state", "handoff"} <= reviewer
    assert "session_watch" not in reviewer
    assert not (COLLAB_TOOLS & _names(filter_tools_for_profile(CORE_TOOLS, "benchmark")))


def _calling(tool_name, args_json):
    calls = 0

    async def stream(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield ToolCallStart(tool_name=tool_name, tool_id="c1")
            yield ToolCallDelta(tool_id="c1", args_json_chunk=args_json)
            yield ToolCallEnd(tool_id="c1")
            yield Done()
        else:
            yield TextDelta(text="ok")
            yield Done()

    return stream


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_name, args_json, blocked", [
    ("session_message", '{"to": "api", "content": "hi"}', True),
    ("shared_state", '{"key": "db", "value": "pg"}', True),
    ("session_message", '{"content": "postgres", "reply_to": "q_1"}', False),
    ("session_send_message", '{"to_session": "api", "content": "hi"}', True),
])
async def test_reviewer_can_read_and_answer_but_not_send_or_write(tmp_path, monkeypatch, tool_name, args_json, blocked):
    from andromity.config import config
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    monkeypatch.setattr("andromity.core.agent.stream_completion", _calling(tool_name, args_json))
    agent = Agent(Session(name="r", project_path=str(tmp_path)), profile="reviewer", auto_approve=True)
    results = [e for e in [e async for e in agent.run("check")] if isinstance(e, ToolResult) and e.tool_id == "c1"]
    assert (results[0].result == "[Blocked: reviewer profile]") is blocked


def _register(session_id: str, project: str, minutes_ago: float = 0):
    bus = SessionBus.get_instance()
    reg = bus.register(session_id, session_id, project)
    reg.last_active_at = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def test_tools_appear_only_with_someone_to_work_with(tmp_path):
    session = Session(name="me", project_path=str(tmp_path))
    agent = Agent(session)
    assert not (COLLAB_TOOLS & _names(agent._tools_for_this_call())), "alone: no collaboration tools"

    _register("other-project-session", str(tmp_path / "elsewhere"))
    _register("stale-peer", str(tmp_path), minutes_ago=90)
    assert not collaboration_available(session)

    _register("peer", str(tmp_path))
    assert collaboration_available(session)
    assert COLLAB_TOOLS <= _names(agent._tools_for_this_call())


def test_a_waiting_session_keeps_the_tools(tmp_path):
    session = Session(name="me", project_path=str(tmp_path))
    session.watching_for = {"target_session": "api"}
    assert collaboration_available(session)
