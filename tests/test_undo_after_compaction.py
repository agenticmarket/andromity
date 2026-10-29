"""Undo after the conversation was compacted: only the turns asked for are undone, and summarized turns are refused."""
import asyncio
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from andromity.config import config
from andromity.core.events import Done, TextDelta
from andromity.core.git_ops import create_pre_edit_snapshot
from andromity.core.session import Session, is_compaction_summary


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "base.txt").write_bytes(b"base\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    config.set_trusted(str(root))
    return root


def _session(root: Path) -> Session:
    """A session as the agent starts one: its system prompt comes first."""
    session = Session(project_path=str(root))
    session.undo_stack = []
    session.add_message("system", "You are Andromity.")
    return session


def _start(session: Session, root: Path, n: int) -> dict:
    """Begin a turn the way the VS Code engine does: snapshot and record first, then the prompt."""
    record = {"snapshot_hash": create_pre_edit_snapshot(root), "msg_count": len(session.messages),
              "turn_index": len(session.get_user_turn_indices()), "anchored": True}
    session.undo_stack.append(record)
    session.add_message("user", f"turn {n}: create f{n}.txt")
    return record


def _finish(session: Session, root: Path, record: dict, n: int, steer: bool = False) -> None:
    if steer:
        session.add_message("user", f"while you are at it, mention {n}", steering=True)
    (root / f"f{n}.txt").write_bytes(f"file {n}\n".encode())
    session.add_message("assistant", f"created f{n}.txt")
    record["after_hash"] = create_pre_edit_snapshot(root)


def _turn(session: Session, root: Path, n: int, steer: bool = False) -> dict:
    record = _start(session, root, n)
    _finish(session, root, record, n, steer)
    return record


async def _compact(session: Session, monkeypatch, force: bool = True) -> None:
    """Run the real compaction with a canned summary."""
    from andromity.core.agent import Agent

    async def summary(*args, **kwargs):
        yield TextDelta(text="Earlier turns created files f0 to f9.")

    monkeypatch.setattr("andromity.core.agent.stream_completion", summary)
    agent = Agent(session=session)
    if not force:
        agent.ctx_limit = 1000
        session.context_tokens = 10 ** 6
    [event async for event in agent._compact_context(force=force)]


def _files(root: Path) -> list:
    return sorted(int(p.stem[1:]) for p in root.glob("f*.txt"))


async def _undo(session: Session, root: Path, **params) -> dict:
    from andromity.server.rpc_handler import JsonRpcHandler

    handler = JsonRpcHandler(send_notification=lambda note: None)
    handler._active_sessions[session.id] = session
    return await handler.rpc_session_undo({"session_id": session.id, "project_path": str(root), **params})


@pytest.mark.asyncio
async def test_undo_after_compaction_undoes_only_the_turn_asked_for(project, monkeypatch):
    s = _session(project)
    for n in range(10):
        _turn(s, project, n)
    record = _start(s, project, 10)
    await _compact(s, monkeypatch)
    _finish(s, project, record, 10)
    _turn(s, project, 11)
    s.save()
    assert _files(project) == list(range(12))

    # What the chat sends for "undo" on the newest prompt: it shows all twelve prompts, compacted ones included.
    result = await _undo(s, project, turn_index=11, turns_to_undo=1)
    assert result["success"] is True and result["turns_undone"] == 1
    assert _files(project) == list(range(11)), "only the last turn's file is reverted"
    assert s.messages[-1]["content"] == "created f10.txt"
    assert len(s.undo_stack) == 11, "the other turns' records are kept"

    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is True
    assert _files(project) == list(range(10))
    assert s.messages[-1]["role"] == "assistant" and "Understood" in s.messages[-1]["content"]


@pytest.mark.asyncio
async def test_a_summarized_turn_is_refused_and_nothing_changes(project, monkeypatch):
    s = _session(project)
    for n in range(10):
        _turn(s, project, n)
    record = _start(s, project, 10)
    await _compact(s, monkeypatch)
    _finish(s, project, record, 10)
    s.save()
    before_messages, before_records = list(s.messages), [dict(r) for r in s.undo_stack]

    for params in ({"turns_to_undo": 2}, {"turns_to_undo": 9}, {"turn_index": 3, "turns_to_undo": 8}):
        result = await _undo(s, project, **params)
        assert result["success"] is False, params
        assert "summarized" in result["error"]
        assert _files(project) == list(range(11)), params
        assert s.messages == before_messages and s.undo_stack == before_records


@pytest.mark.asyncio
async def test_compaction_keeps_each_turn_record_on_its_own_prompt(project, monkeypatch):
    s = _session(project)
    for n in range(10):
        _turn(s, project, n, steer=(n == 9))
    record = _start(s, project, 10)
    await _compact(s, monkeypatch, force=False)

    kept = [r for r in s.undo_stack if not r.get("compacted")]
    assert kept and kept[-1] is record
    for r in kept:
        prompt = s.messages[r["msg_count"]]
        assert prompt["role"] == "user" and not prompt.get("steering")
    assert all(r.get("compacted") for r in s.undo_stack[:10]), "turn 9's prompt was summarized"
    steering = [m for m in s.messages if m.get("role") == "user" and "mention 9" in str(m.get("content"))]
    assert steering and all(m.get("steering") for m in steering), "compaction must not strip the steering flag"
    assert [s.messages[i]["content"] for i in s.turn_starts()] == ["turn 10: create f10.txt"]


@pytest.mark.asyncio
async def test_undo_counts_turns_the_way_the_chat_shows_them_with_steering(project):
    s = _session(project)
    _turn(s, project, 0, steer=True)
    _turn(s, project, 1)
    _turn(s, project, 2)
    s.save()

    # "Undo to here" on turn 1: two prompts from there to the end, the steering message is not a turn.
    result = await _undo(s, project, turn_index=2, turns_to_undo=2)
    assert result["success"] is True and result["turns_undone"] == 2
    assert _files(project) == [0]
    assert [m["content"] for m in s.messages if m["role"] == "user"] == [
        "turn 0: create f0.txt", "while you are at it, mention 0"]


def test_terminal_compaction_keeps_records_on_their_prompts(project):
    s = _session(project)
    for n in range(6):
        _turn(s, project, n)
    s.compact_messages("summary", keep_last_n=4)
    kept = [r for r in s.undo_stack if not r.get("compacted")]
    assert [s.messages[r["msg_count"]]["content"] for r in kept] == ["turn 4: create f4.txt", "turn 5: create f5.txt"]
    assert len(s.undo_stack) == 6


def _terminal_app(session: Session, root: Path):
    from andromity.tui.app import AndromityApp

    chat = MagicMock()
    chat.load_history = AsyncMock()
    app = SimpleNamespace(session=session, _project_path=str(root), _undo_stack=[], _undo_in_progress=True,
                          query_one=lambda *args, **kwargs: chat, focus_input=lambda: None, _update_status=lambda: None)
    return app, chat, AndromityApp._async_perform_undo


@pytest.mark.asyncio
async def test_terminal_undo_after_compaction_trims_the_right_turn(project, monkeypatch):
    s = _session(project)
    checkpoints = []
    for n in range(10):
        checkpoints.append({"msg_count": len(s.messages), "prompt": f"turn {n}: create f{n}.txt"})
        record = _turn(s, project, n)
        checkpoints[-1].update(snapshot_hash=record["snapshot_hash"], after_hash=record["after_hash"])
    s.undo_stack = []
    await _compact(s, monkeypatch, force=False)
    app, chat, undo = _terminal_app(s, project)

    await undo(app, checkpoints[9])
    assert _files(project) == list(range(9))
    assert not any("turn 9" in str(m.get("content")) for m in s.messages), "the undone prompt is gone"
    assert any("Previous context summary" in str(m.get("content")) for m in s.messages), "the summary stays"

    kept = list(s.messages)
    for skipped in (checkpoints[7], checkpoints[6]):
        app._undo_in_progress, app._undo_stack = True, []
        await undo(app, skipped)
        assert _files(project) == list(range(9)), "a checkpoint for another turn never reverts files"
        assert s.messages == kept and app._undo_stack == [skipped]

    app._undo_in_progress, app._undo_stack = True, []
    await undo(app, checkpoints[8])
    assert _files(project) == list(range(8))

    app._undo_in_progress, app._undo_stack = True, []
    await undo(app, checkpoints[7])
    assert _files(project) == list(range(8)), "a summarized turn's files are left alone"
    assert app._undo_stack == [checkpoints[7]], "the checkpoint is kept for later"
    notes = " ".join(str(call.args[0]) for call in chat.add_system_message.call_args_list)
    assert "summarized" in notes


@pytest.mark.asyncio
async def test_turns_recorded_by_the_released_version_stay_undoable_after_compaction(project, monkeypatch):
    s = _session(project)
    for n in range(10):
        _turn(s, project, n)
    record = _start(s, project, 10)
    for r in s.undo_stack:
        del r["anchored"]
    await _compact(s, monkeypatch, force=False)
    _finish(s, project, record, 10)
    s.save()

    for left in (10, 9):
        result = await _undo(s, project, turns_to_undo=1)
        assert result["success"] is True and _files(project) == list(range(left)), left


@pytest.mark.asyncio
async def test_older_records_that_kept_only_a_turn_number(project, monkeypatch):
    s = _session(project)
    for n in range(4):
        _turn(s, project, n)
    record = _start(s, project, 4)
    for r in s.undo_stack:
        del r["msg_count"], r["anchored"]
    await _compact(s, monkeypatch)
    _finish(s, project, record, 4)
    assert [bool(r.get("compacted")) for r in s.undo_stack] == [True, True, True, True, False]
    assert s.messages[record["msg_count"]]["content"] == "turn 4: create f4.txt"

    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is True and _files(project) == [0, 1, 2, 3]
    assert (await _undo(s, project, turns_to_undo=1))["success"] is False


def test_an_older_record_is_never_guessed_at_once_the_conversation_was_compacted(project):
    s = _session(project)
    s.add_message("user", "[Previous context summary (8 messages compacted)]: earlier work")
    s.add_message("assistant", "Understood. I have the context from our previous conversation and will continue from here.")
    s.add_message("user", "turn 5: create f5.txt")
    numbered = {"turn_index": 1, "snapshot_hash": "a" * 40}
    stale = {"turn_index": 1, "msg_count": 3}
    current = {"turn_index": 1, "msg_count": 3, "anchored": True}
    summarized = {"msg_count": 3, "compacted": True, "anchored": True}
    off_prompt = {"msg_count": 2, "anchored": True}
    s.undo_stack = [numbered, stale, current, summarized, off_prompt]
    assert s.turn_records_from(0) == [current]


@pytest.mark.asyncio
async def test_a_chat_compacted_by_an_earlier_version_never_reverts_summarized_turns(project):
    s = _session(project)
    for n in range(10):
        _turn(s, project, n)
    for record in s.undo_stack:
        del record["anchored"]
    # What the released version did: older messages replaced by a summary, records left at their old positions.
    s.messages = [s.messages[0],
                  {"role": "user", "content": "[Previous context summary (18 messages compacted)]: earlier work"},
                  {"role": "assistant", "content": "Understood. I have the context from our previous conversation and will continue from here."},
                  *s.messages[-2:]]
    _turn(s, project, 10)
    s.save()

    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is True and _files(project) == list(range(10))
    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is True and "no file checkpoint" in result["git_status"]
    assert _files(project) == list(range(10)), "a record left stale by the old compaction never reverts files"


def _model(root: Path):
    """A model that creates the file each prompt names; compaction gets a canned summary."""
    async def stream(messages, **kwargs):
        asked = str(messages[-1].get("content") or "")
        if asked.startswith("Summarize this conversation"):
            yield TextDelta(text="Earlier turns created files.")
            return
        name = re.search(r"create (f\d+\.txt)", asked).group(1)
        (root / name).write_bytes(f"{name}\n".encode())
        yield TextDelta(text=f"created {name}")
        yield Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
    return stream


def _never_starts(monkeypatch) -> None:
    """A message of only images, sent to a model that can't read images, stops before its prompt is added."""
    monkeypatch.setattr("andromity.core.agent.Agent._model_supports_vision", lambda self: False)
    monkeypatch.setattr("andromity.core.images.image_to_data_uri", lambda image, **kwargs: "data:image/jpeg;base64,AA==")


async def _serve(session: Session, root: Path, prompt: str, **params) -> None:
    """One turn through the VS Code engine, start to finish."""
    from andromity.server.rpc_handler import JsonRpcHandler

    handler = JsonRpcHandler(send_notification=lambda note: None)
    handler._active_sessions[session.id] = session
    await handler.rpc_agent_prompt({"session_id": session.id, "project_path": str(root), "prompt": prompt,
                                    "mode": "full", **params})
    if session.id in handler._running_tasks:
        await handler._running_tasks[session.id]
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_a_turn_the_engine_compacts_in_can_still_be_undone(project, monkeypatch):
    s = _session(project)
    s.name = "undo after compaction"
    for n in range(10):
        _turn(s, project, n)
    s.save()
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(project))

    s.context_tokens = 10 ** 9
    await _serve(s, project, "turn 10: create f10.txt")
    assert any(map(is_compaction_summary, s.messages)), "the turn compacted the conversation"
    await _serve(s, project, "turn 11: create f11.txt")
    assert _files(project) == list(range(12))
    kept = [r for r in s.undo_stack if not r.get("compacted")]
    assert [s.messages[r["msg_count"]]["content"] for r in kept] == [
        "turn 9: create f9.txt", "turn 10: create f10.txt", "turn 11: create f11.txt"]

    for left in (11, 10, 9):
        result = await _undo(s, project, turns_to_undo=1)
        assert result["success"] is True and _files(project) == list(range(left)), left
    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is False and "summarized" in result["error"]
    assert _files(project) == list(range(9))


@pytest.mark.asyncio
async def test_a_turn_that_never_started_leaves_no_undo_record(project, monkeypatch):
    s = _session(project)
    s.name = "undo after compaction"
    for n in range(10):
        _turn(s, project, n)
    await _compact(s, monkeypatch)
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(project))
    await _serve(s, project, "turn 10: create f10.txt")
    records = list(s.undo_stack)

    _never_starts(monkeypatch)
    await _serve(s, project, "", image_uris=["data:image/png;base64,AA=="])
    assert s.undo_stack == records
    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is True and _files(project) == list(range(10))


@pytest.mark.asyncio
async def test_terminal_turns_that_compact_or_never_start_keep_undo_in_step(project, monkeypatch):
    from andromity.tui.app import AndromityApp

    monkeypatch.chdir(project)
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(project))
    app = AndromityApp()
    async with app.run_test(size=(120, 30)):
        app.agent.auto_approve = True
        for n in range(5):
            await app._stream_agent(f"turn {n}: create f{n}.txt")
        app.session.context_tokens = 10 ** 9
        await app._stream_agent("turn 5: create f5.txt")
        assert any(map(is_compaction_summary, app.session.messages)), "the turn compacted the conversation"

        _never_starts(monkeypatch)
        await app._stream_agent("", images=["screenshot.png"])
        assert [c["prompt"] for c in app._undo_stack] == [f"turn {n}: create f{n}.txt" for n in range(6)]

        for left in (5, 4, 4):
            app._undo_in_progress = True
            await app._async_perform_undo(app._undo_stack.pop())
            assert _files(project) == list(range(left)), left
        assert app._undo_stack[-1]["prompt"] == "turn 3: create f3.txt", "turn 3 was summarized, so it stays"
