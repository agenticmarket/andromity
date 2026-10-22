"""A suggested next step started in its own session runs in the background and reports back."""
from unittest.mock import AsyncMock

import pytest

from andromity.core.session import Session
from andromity.core.session_context import background_context, without_session_context
from andromity.server.rpc_handler import JsonRpcHandler


@pytest.fixture(autouse=True)
def _trusted(monkeypatch):
    from andromity.config import config
    monkeypatch.setattr(config, "is_trusted", lambda path: True)


@pytest.fixture
def parent(tmp_path):
    s = Session(name="Parser crash", project_path=str(tmp_path))
    s.add_message("user", content="Why does parse() crash on empty input?\n\n---\n[Active Document: parser.ts]\nsecret file text")
    s.add_message("assistant", content="parse() calls s.split without a null check.")
    s.save()
    return s


def _handler(parent):
    notes = []
    handler = JsonRpcHandler(send_notification=notes.append)
    handler._active_sessions[parent.id] = parent
    handler.rpc_agent_prompt = AsyncMock(return_value={"status": "started"})
    return handler, notes


def test_context_carries_the_last_exchange_without_ide_context(parent):
    context = background_context(parent)
    assert context.startswith('\n\n---\n[Started from session "Parser crash"]')
    assert "Its last request: Why does parse() crash on empty input?" in context
    assert "Its last reply: parse() calls s.split without a null check." in context
    assert "secret file text" not in context and "Active Document" not in context
    assert without_session_context("Fix it" + context) == "Fix it"
    assert without_session_context("Plain prompt") == "Plain prompt"


@pytest.mark.asyncio
async def test_start_runs_the_prompt_in_a_new_linked_session_and_leaves_the_parent_alone(parent):
    handler, notes = _handler(parent)
    res = await handler.rpc_session_startBackground({
        "parent_session_id": parent.id, "prompt": "Fix the null check in parser.ts", "title": "Fix the null check", "mode": "trust",
    })
    assert res["success"] is True
    child = handler._active_sessions[res["session_id"]]
    assert child.name == "Fix the null check"
    assert child.started_from == {"session_id": parent.id, "name": "Parser crash", "pending": True}

    params = handler.rpc_agent_prompt.call_args[0][0]
    assert handler.rpc_agent_prompt.call_count == 1, "only the new session runs"
    assert params["session_id"] == child.id and params["mode"] == "trust"
    assert params["prompt"].startswith("Fix the null check in parser.ts\n\n---\n[Started from session \"Parser crash\"]")

    assert parent.background_runs == [{
        "session_id": child.id, "title": "Fix the null check", "status": "running", "summary": "",
        "turn_index": 1, "started_at": parent.background_runs[0]["started_at"], "reported": False,
    }]
    started = next(n.params for n in notes if n.method == "session/backgroundStarted")
    assert started == {"parent_session_id": parent.id, "child_session_id": child.id, "title": "Fix the null check"}


@pytest.mark.asyncio
@pytest.mark.parametrize("final_status, expected", [("idle", "finished"), ("cancelled", "cancelled"), ("error", "error")])
async def test_end_of_the_first_run_is_reported_once(parent, final_status, expected):
    handler, notes = _handler(parent)
    res = await handler.rpc_session_startBackground({"parent_session_id": parent.id, "prompt": "Fix it", "title": "Fix it"})
    child = handler._active_sessions[res["session_id"]]
    child.add_message("assistant", content="Added the guard and a test.\n\nAll 12 tests pass.")
    child.status = final_status

    handler._report_background_run(child)
    handler._report_background_run(child)

    finished = [n.params for n in notes if n.method == "session/backgroundFinished"]
    assert finished == [{
        "parent_session_id": parent.id, "child_session_id": child.id, "title": "Fix it",
        "status": expected, "summary": "Added the guard and a test. All 12 tests pass.",
    }]
    assert parent.background_runs[0]["status"] == expected
    assert child.started_from["pending"] is False


@pytest.mark.asyncio
async def test_parent_agent_hears_about_finished_runs_on_its_next_turn_only(parent):
    handler, _ = _handler(parent)
    res = await handler.rpc_session_startBackground({"parent_session_id": parent.id, "prompt": "Fix it", "title": "Fix it"})
    child = handler._active_sessions[res["session_id"]]
    child.add_message("assistant", content="Fixed.")
    child.status = "idle"
    handler._report_background_run(child)

    first = handler._with_background_results(parent, "What next?")
    assert first == 'What next?\n\n---\n[Background sessions]\n- "Fix it" finished: Fixed.'
    assert handler._with_background_results(parent, "And now?") == "And now?", "each result is passed on once"
    assert without_session_context(first) == "What next?"


@pytest.mark.asyncio
async def test_results_wait_when_the_parent_is_busy(parent):
    import asyncio
    handler, _ = _handler(parent)
    del handler.rpc_agent_prompt  # use the real one for the parent
    parent.background_runs = [{"session_id": "c1", "title": "Fix it", "status": "finished", "summary": "Fixed.", "reported": False}]
    busy = asyncio.get_running_loop().create_future()
    handler._running_tasks[parent.id] = busy
    try:
        with pytest.raises(RuntimeError, match="already running"):
            await handler.rpc_agent_prompt({"session_id": parent.id, "prompt": "hi", "project_path": parent.project_path})
    finally:
        busy.cancel()
    assert parent.background_runs[0]["reported"] is False


@pytest.mark.asyncio
async def test_a_run_that_cannot_start_is_reported_as_failed(parent):
    handler, notes = _handler(parent)
    handler.rpc_agent_prompt = AsyncMock(side_effect=RuntimeError("provider exploded: litellm.RateLimitError"))
    res = await handler.rpc_session_startBackground({"parent_session_id": parent.id, "prompt": "Fix it", "title": "Fix it"})
    assert res["success"] is False
    finished = next(n.params for n in notes if n.method == "session/backgroundFinished")
    assert finished["status"] == "error"
    assert "litellm" not in finished["summary"], "internal errors stay out of the UI"


def test_links_survive_a_reload(parent):
    parent.background_runs = [{"session_id": "c1", "title": "Fix it", "status": "finished", "summary": "Fixed.", "reported": True}]
    parent.save()
    child = Session(name="Fix it", project_path=parent.project_path)
    child.started_from = {"session_id": parent.id, "name": parent.name, "pending": False}
    child.save()
    assert Session.load_by_id(parent.id, parent.project_path).background_runs == parent.background_runs
    assert Session.load_by_id(child.id, parent.project_path).started_from == child.started_from
