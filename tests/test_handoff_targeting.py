"""Handoffs can be sent to one session, which is then woken to pick them up."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from andromity.core.events import HandoffWritten
from andromity.core.handoff import read_handoff
from andromity.core.session import Session
from andromity.core.session_bus import SessionBus
from andromity.core.tools import _current_session_var, execute_tool, write_handoff_tool
from andromity.server.rpc_handler import JsonRpcHandler
from andromity.tui.app import AndromityApp


@pytest.fixture(autouse=True)
def _trusted(monkeypatch):
    from andromity.config import config
    monkeypatch.setattr(config, "is_trusted", lambda path: True)


def _session(name: str, project, session_id: str) -> Session:
    s = Session(name=name, project_path=str(project), session_id=session_id)
    s.storage_dir = project
    s.file_path = project / f"{s.id}.json"
    s.save()
    return s


@pytest.fixture
def team(tmp_path):
    bus = SessionBus.reset_instance()
    other_project = tmp_path / "other"
    other_project.mkdir()
    backend = _session("Backend", tmp_path, "sess_backend")
    tester = _session("Tester", tmp_path, "sess_tester")
    stranger = _session("Stranger", other_project, "sess_stranger")
    for s in (backend, tester, stranger):
        bus.register(s.id, s.name, s.project_path)
    handler = JsonRpcHandler()
    for s in (backend, tester, stranger):
        handler._active_sessions[s.id] = s
    handler.rpc_agent_prompt = AsyncMock(return_value={"status": "started"})
    yield SimpleNamespace(backend=backend, tester=tester, stranger=stranger, handler=handler, project=tmp_path)
    SessionBus.reset_instance()


def _as(session: Session):
    return _current_session_var.set(session)


@pytest.mark.asyncio
async def test_handoff_to_a_session_wakes_it(team):
    token = _as(team.backend)
    try:
        result = write_handoff_tool(phase="api", status="complete", next_steps=["verify contract"], to_session="Tester")
    finally:
        _current_session_var.reset(token)
    await asyncio.sleep(0.05)

    assert "sent to 'Tester'" in result
    assert read_handoff("api", project_path=str(team.project))["to_session"] == "Tester"
    team.handler.rpc_agent_prompt.assert_called_once()
    params = team.handler.rpc_agent_prompt.call_args[0][0]
    assert params["session_id"] == team.tester.id
    assert params["prompt"].startswith("[Incoming Task Handoff from co-agent 'Backend' (Phase: api)]")
    assert params["mode"] in ("safe", "trust"), "woken turns never run above TRUST"
    assert "Tester" in team.backend.collaborators, "the author is linked to the session it handed off to"


@pytest.mark.asyncio
async def test_handoff_tool_accepts_the_target_from_the_model(team):
    token = _as(team.backend)
    try:
        result = execute_tool("write_handoff", {"phase": "db", "status": "complete", "to_session": "Tester"})
    finally:
        _current_session_var.reset(token)
    if asyncio.iscoroutine(result):
        result = await result
    await asyncio.sleep(0.05)
    assert team.handler.rpc_agent_prompt.call_args[0][0]["session_id"] == team.tester.id


@pytest.mark.asyncio
async def test_handoff_never_reaches_a_session_in_another_project(team):
    token = _as(team.backend)
    try:
        result = write_handoff_tool(phase="api", status="complete", to_session="Stranger")
    finally:
        _current_session_var.reset(token)
    await asyncio.sleep(0.05)

    assert "no open session named 'Stranger' was found in this project, so none was woken" in result
    assert "to_session" not in read_handoff("api", project_path=str(team.project))
    team.handler.rpc_agent_prompt.assert_not_called()


@pytest.mark.asyncio
async def test_project_wide_handoff_wakes_nobody_and_keeps_the_document_format(team):
    token = _as(team.backend)
    try:
        write_handoff_tool(phase="api", status="complete")
    finally:
        _current_session_var.reset(token)
    await asyncio.sleep(0.05)

    doc = read_handoff("api", project_path=str(team.project))
    assert set(doc) == {"phase", "from_session", "status", "produced", "blocked_on", "next_steps", "notes", "created_at"}
    team.handler.rpc_agent_prompt.assert_not_called()


@pytest.mark.asyncio
async def test_handoff_notification_names_its_target():
    notes = []
    handler = JsonRpcHandler(send_notification=notes.append)
    handler._handle_auto_awake = AsyncMock()
    handler._on_session_bus_event(HandoffWritten(
        phase="api", from_session="Backend", status="complete", summary="s",
        to_session="Tester", to_session_id="sess_tester", from_session_id="sess_backend",
    ))
    await asyncio.sleep(0)
    params = next(n.params for n in notes if n.method == "session/handoffWritten")
    assert params["to_session_id"] == "sess_tester"
    assert params["from_session_id"] == "sess_backend"
    assert handler._handle_auto_awake.call_args.kwargs["target_session_id"] == "sess_tester"


def _route(event, name="Tester", session_id="sess_tester"):
    chat = MagicMock()
    app = SimpleNamespace(session=SimpleNamespace(id=session_id, name=name), query_one=lambda _cls: chat, notify=MagicMock())
    AndromityApp._handle_session_bus_event_ui(app, event)
    return chat


def test_tui_shows_a_targeted_handoff_only_to_its_target():
    event = HandoffWritten(phase="api", from_session="Backend", status="complete", summary="Phase 'api' marked complete",
                           to_session="Tester", to_session_id="sess_tester")
    _route(event).add_handoff_notification.assert_called_once_with("Backend", "Phase 'api' marked complete")
    _route(event, name="Reviewer", session_id="sess_reviewer").add_handoff_notification.assert_not_called()
