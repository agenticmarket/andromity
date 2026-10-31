"""Images sent to a model that can't read them: the text goes on without them, a message of only images adds nothing."""
import asyncio
import base64
import copy
import inspect
import io
import json
import sqlite3
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from andromity.config import config
from andromity.core.agent import Agent
from andromity.core.events import (
    Done, ImagesSkipped, InputApplied, TextDelta, ToolCallDelta, ToolCallEnd, ToolCallStart, ToolResult,
)
from andromity.core.session import Session, skipped_image_count

TEXT_ONLY = {"provider": "deepseek", "model": "deepseek-chat"}
VISION = {"provider": "openai", "model": "gpt-4o"}
PLACEHOLDER = "Please inspect attached image"
NOTE = "not sent to the assistant, so you cannot see"


def _png(colour=(40, 90, 200)) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), colour).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


IMAGE = _png()


@pytest.fixture(autouse=True)
def telemetry(monkeypatch):
    import andromity.telemetry as telemetry_module
    seen = {"features": [], "session_end": [], "tasks": []}
    monkeypatch.setattr(telemetry_module, "send_feature_used", lambda feature, **kw: seen["features"].append(feature))
    monkeypatch.setattr(telemetry_module, "send_session_end", lambda sid, **kw: seen["session_end"].append(kw))
    monkeypatch.setattr(telemetry_module, "send_session_update", lambda *a, **kw: None)
    monkeypatch.setattr(telemetry_module, "send_session_start", lambda *a, **kw: None)
    monkeypatch.setattr(telemetry_module, "send_task_event",
                        lambda event, sid, run_id, **kw: seen["tasks"].append((event, kw.get("outcome"))))
    return seen


def _reply(text: str = "Got it."):
    return [TextDelta(text=text), Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})]


def _tool_call(name: str, args: dict, call_id: str = "call_1"):
    return [ToolCallStart(tool_name=name, tool_id=call_id),
            ToolCallDelta(tool_id=call_id, args_json_chunk=json.dumps(args)),
            ToolCallEnd(tool_id=call_id),
            Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})]


def _model(monkeypatch, *steps) -> list:
    """Each request gets the next step: a list of events, or a callable (sync or async) returning one."""
    requests: list = []

    async def stream(messages, **kwargs):
        requests.append(copy.deepcopy(messages))
        step = steps[len(requests) - 1] if len(requests) <= len(steps) else _reply("Done.")
        if callable(step):
            step = step()
            if inspect.isawaitable(step):
                step = await step
        for event in step:
            yield event

    monkeypatch.setattr("andromity.core.agent.stream_completion", stream)
    return requests


def _users(request: list) -> list:
    return [m for m in request if m["role"] == "user"]


def _errors(features: list) -> list:
    return [f for f in features if f.startswith("error_")]


@pytest.fixture
def session(tmp_path):
    s = Session(name="images without vision", project_path=str(tmp_path))
    s.add_message("system", "You are Andromity.")
    return s


# ── Text with images: sent without them, with a note ──────────────────────────


@pytest.mark.asyncio
async def test_text_with_one_image_reaches_the_model_without_it_and_with_a_note(session, monkeypatch, telemetry):
    requests = _model(monkeypatch, _reply("I can't see the screenshot."))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    events = [e async for e in agent.run("why is this button red?", image_uris=[IMAGE])]

    assert len(requests) == 1
    [user] = _users(requests[0])
    assert isinstance(user["content"], str), "no image parts reach a model that can't read them"
    assert user["content"].startswith("why is this button red?\n\n[The user attached 1 image that was " + NOTE + " it.")
    assert user["content"].endswith("If the request depends on it, say so instead of guessing.]")
    dumped = json.dumps(requests[0])
    assert "image_url" not in dumped and "data:image" not in dumped
    assert "images_skipped" not in dumped, "the stored count is never sent to the provider"

    stored = _users(session.messages)[-1]
    assert stored["content"] == "why is this button red?", "the note is added per request, never stored"
    assert stored["images_skipped"] == 1

    skipped = [e for e in events if isinstance(e, ImagesSkipped)]
    assert skipped == [ImagesSkipped(1, prompt_added=True, steering=False, input_id=None)]
    first_text = next(i for i, e in enumerate(events) if isinstance(e, TextDelta) and "screenshot" in e.text)
    assert events.index(skipped[0]) < first_text, "the notice shows before the reply"
    assert isinstance(events[-1], Done) and events[-1].outcome == "success"
    assert telemetry["features"].count("image_skipped_no_vision") == 1
    assert not _errors(telemetry["features"])
    assert telemetry["session_end"] and not any(end["had_error"] for end in telemetry["session_end"])
    assert ("task_finished", "completed") in telemetry["tasks"]


@pytest.mark.asyncio
async def test_note_counts_several_images(session, monkeypatch):
    requests = _model(monkeypatch, _reply())
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    [e async for e in agent.run("compare these", image_uris=[IMAGE, _png((1, 2, 3)), _png((9, 9, 9))])]
    content = _users(requests[0])[-1]["content"]
    assert "[The user attached 3 images that were " + NOTE + " them." in content
    assert "If the request depends on them, say so" in content
    assert _users(session.messages)[-1]["images_skipped"] == 3


@pytest.mark.asyncio
async def test_raw_images_from_the_terminal_are_left_out_too(session, monkeypatch):
    requests = _model(monkeypatch, _reply())
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    events = [e async for e in agent.run("what is this?", images=[Image.new("RGB", (30, 20), "red")])]
    content = _users(requests[0])[-1]["content"]
    assert isinstance(content, str) and content.startswith("what is this?") and NOTE in content
    assert any(isinstance(e, ImagesSkipped) and e.prompt_added for e in events)


@pytest.mark.asyncio
async def test_every_request_and_later_turn_carry_the_note_once(session, monkeypatch, tmp_path):
    (tmp_path / "notes.txt").write_bytes(b"The button is red because of .danger\n")
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    requests = _model(monkeypatch, _tool_call("read_file", {"path": "notes.txt"}), _reply("It is .danger."), _reply("You're welcome."))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    [e async for e in agent.run("why is this button red?", image_uris=[IMAGE])]
    [e async for e in agent.run("thanks")]

    assert len(requests) == 3
    for request in requests:
        users = _users(request)
        assert users[0]["content"].count(NOTE) == 1, "one note per request, never stacked"
        assert all(NOTE not in u["content"] for u in users[1:]), "only the message that had images gets it"
        assert "image_url" not in json.dumps(request)
    assert _users(requests[2])[-1]["content"] == "thanks"


@pytest.mark.asyncio
async def test_reloaded_session_keeps_the_count_and_a_new_agent_still_tells_the_model(session, monkeypatch):
    _model(monkeypatch, _reply())
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    [e async for e in agent.run("look at these two", image_uris=[IMAGE, IMAGE])]
    session.save()

    reloaded = Session.load_by_id(session.id, session.project_path)
    stored = _users(reloaded.messages)[-1]
    assert stored["images_skipped"] == 2 and stored["content"] == "look at these two"
    sent = Agent(reloaded, auto_approve=True, **TEXT_ONLY)._messages_for_api()
    content = _users(sent)[-1]["content"]
    assert content.startswith("look at these two") and "attached 2 images that were " + NOTE in content
    assert not any("images_skipped" in m for m in sent)


@pytest.mark.asyncio
async def test_a_failed_reply_is_the_turns_outcome_not_a_vision_error(session, monkeypatch, telemetry):
    _model(monkeypatch, [TextDelta(text="[RATE LIMIT] Slow down."), Done(outcome="error", error_type="rate_limit")])
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    events = [e async for e in agent.run("why is this button red?", image_uris=[IMAGE])]
    assert isinstance(events[-1], Done) and events[-1].outcome == "error"
    assert "error_rate_limit" in telemetry["features"]
    assert "error_vision_unsupported" not in telemetry["features"]
    assert "image_skipped_no_vision" in telemetry["features"]
    assert ("task_finished", "failed") in telemetry["tasks"]


@pytest.mark.asyncio
async def test_a_turn_that_compacts_keeps_the_count_and_the_note(session, monkeypatch):
    for n in range(6):
        session.add_message("user", f"question {n}")
        session.add_message("assistant", f"answer {n}")

    def summary_or_reply():
        return [TextDelta(text="Six questions were asked.")]

    requests = _model(monkeypatch, summary_or_reply, _reply("No image reached me."))
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    session.context_tokens = 10 ** 9
    agent.ctx_limit = 1000
    [e async for e in agent.run("what is in this screenshot?", image_uris=[IMAGE])]

    assert requests[0][-1]["content"].startswith("Summarize this conversation"), "the turn compacted the conversation"
    stored = _users(session.messages)[-1]
    assert stored["content"] == "what is in this screenshot?" and stored["images_skipped"] == 1
    assert NOTE in _users(requests[-1])[-1]["content"]


@pytest.mark.asyncio
async def test_switching_the_terminal_agent_to_a_text_only_model_stops_sending_earlier_images(session, monkeypatch):
    """The terminal keeps one agent and changes its model in place; a model that can't read images must not get any."""
    requests = _model(monkeypatch, _reply("A red button."), _reply("Sure."))
    agent = Agent(session, auto_approve=True, **VISION)
    [e async for e in agent.run("what is this?", image_uris=[IMAGE])]
    assert "image_url" in json.dumps(requests[0])

    agent.provider, agent.model = TEXT_ONLY["provider"], TEXT_ONLY["model"]
    [e async for e in agent.run("make it blue")]
    assert "image_url" not in json.dumps(requests[1]), "the provider rejects image parts for a text-only model"


# ── A message of only images ──────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("prompt, image_only", [(PLACEHOLDER, True), ("", False), ("  \n\t", False), (PLACEHOLDER + "\n\n--- [Active Document: a.py]", True)])
async def test_a_message_of_only_images_is_not_sent_and_adds_no_turn(session, monkeypatch, telemetry, prompt, image_only):
    requests = _model(monkeypatch)
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    before = copy.deepcopy(session.messages)
    events = [e async for e in agent.run(prompt, image_uris=[IMAGE], image_only=image_only)]

    assert requests == [], "the model is not called"
    assert session.messages == before, "no turn is added"
    assert events == [ImagesSkipped(1, prompt_added=False), Done(outcome="success")]
    assert telemetry["features"] == ["image_skipped_no_vision"]
    assert not any(end.get("had_error") for end in telemetry["session_end"])
    assert telemetry["tasks"] == [], "no task starts for a message that is not sent"


@pytest.mark.asyncio
async def test_image_only_flag_keeps_images_for_a_model_that_reads_them(session, monkeypatch, telemetry):
    requests = _model(monkeypatch, _reply("A red button."))
    agent = Agent(session, auto_approve=True, **VISION)
    events = [e async for e in agent.run(PLACEHOLDER, image_uris=[IMAGE], image_only=True)]
    content = _users(requests[0])[-1]["content"]
    assert content == [{"type": "text", "text": PLACEHOLDER}, {"type": "image_url", "image_url": {"url": IMAGE}}]
    assert not [e for e in events if isinstance(e, ImagesSkipped)]
    assert "image_skipped_no_vision" not in telemetry["features"]
    assert "images_skipped" not in _users(session.messages)[-1]


@pytest.mark.asyncio
async def test_image_only_flag_without_images_is_an_ordinary_prompt(session, monkeypatch):
    requests = _model(monkeypatch, _reply())
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    events = [e async for e in agent.run("hello", image_only=True)]
    assert _users(requests[0])[-1]["content"] == "hello"
    assert not [e for e in events if isinstance(e, ImagesSkipped)]


# ── Messages sent while a turn runs (steering) ───────────────────────────────


def _steer(agent: Agent, prompt: str, **payload):
    return agent.input_queue.submit({"prompt": prompt, **payload}, "steer")


@pytest.mark.asyncio
async def test_steering_text_with_images_is_applied_with_the_note(session, monkeypatch, telemetry):
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    steered = {}

    def first():
        steered["item"] = _steer(agent, "also check the footer", image_uris=[IMAGE, IMAGE])
        return _reply("The button is red.")

    requests = _model(monkeypatch, first, _reply("The footer is fine."))
    events = [e async for e in agent.run("why is this button red?")]

    assert len(requests) == 2
    last = _users(requests[1])[-1]["content"]
    assert isinstance(last, str) and last.startswith("also check the footer") and "attached 2 images that were " + NOTE in last
    assert "image_url" not in json.dumps(requests[1])
    applied = [e for e in events if isinstance(e, InputApplied)]
    skipped = [e for e in events if isinstance(e, ImagesSkipped)]
    assert len(applied) == 1 and applied[0].input_id == steered["item"].id
    assert skipped == [ImagesSkipped(2, prompt_added=True, steering=True, input_id=steered["item"].id)]
    assert events.index(applied[0]) < events.index(skipped[0])
    stored = _users(session.messages)[-1]
    assert stored["steering"] is True and stored["images_skipped"] == 2
    assert len(session.get_user_turn_indices()) == 1, "a steering message is not a turn of its own"
    assert not agent.input_queue.paused and not agent.input_queue.items
    assert [e.outcome for e in events if isinstance(e, Done)] == ["success"]
    assert telemetry["features"].count("image_skipped_no_vision") == 1 and not _errors(telemetry["features"])


@pytest.mark.asyncio
@pytest.mark.parametrize("prompt, flags", [(PLACEHOLDER, {"image_only": True}), ("", {}), ("   ", {})])
async def test_steering_images_alone_after_the_final_reply_end_the_turn(session, monkeypatch, telemetry, prompt, flags):
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)
    steered = {}

    def first():
        steered["item"] = _steer(agent, prompt, image_uris=[IMAGE], **flags)
        return _reply("The button is red.")

    requests = _model(monkeypatch, first)
    events = [e async for e in agent.run("why is this button red?")]

    assert len(requests) == 1, "the model is not asked again for a message it can't read"
    assert not [e for e in events if isinstance(e, InputApplied)]
    assert [e for e in events if isinstance(e, ImagesSkipped)] == [
        ImagesSkipped(1, prompt_added=False, steering=True, input_id=steered["item"].id)]
    dones = [e for e in events if isinstance(e, Done)]
    assert len(dones) == 1 and dones[0].outcome == "success" and events[-1] is dones[0]
    assert [m["content"] for m in _users(session.messages)] == ["why is this button red?"]
    assert not agent.input_queue.paused and not agent.input_queue.items
    assert telemetry["features"] == ["image_skipped_no_vision"]
    assert not any(end["had_error"] for end in telemetry["session_end"])


@pytest.mark.asyncio
async def test_steering_images_alone_mid_turn_add_no_message(session, monkeypatch, tmp_path):
    (tmp_path / "notes.txt").write_bytes(b"red\n")
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    agent = Agent(session, auto_approve=True, **TEXT_ONLY)

    def first():
        _steer(agent, PLACEHOLDER, image_uris=[IMAGE], image_only=True)
        return _tool_call("read_file", {"path": "notes.txt"})

    requests = _model(monkeypatch, first, _reply("It's red."))
    events = [e async for e in agent.run("why is this button red?")]
    assert len(requests) == 2
    assert len(_users(requests[1])) == 1, "nothing was added for the images"
    assert any(isinstance(e, ImagesSkipped) and not e.prompt_added and e.steering for e in events)
    assert [e.outcome for e in events if isinstance(e, Done)] == ["success"]


@pytest.mark.asyncio
async def test_steering_images_alone_after_a_suggested_next_step_end_the_turn(session, monkeypatch):
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    agent = Agent(session, auto_approve=True, next_step_suggestions=True, **TEXT_ONLY)

    def first():
        _steer(agent, PLACEHOLDER, image_uris=[IMAGE], image_only=True)
        return [TextDelta(text="Fixed it."),
                *_tool_call("suggest_next_step", {"title": "Run tests", "prompt": "Run the tests", "new_session": False})]

    requests = _model(monkeypatch, first)
    events = [e async for e in agent.run("fix the button")]
    assert len(requests) == 1
    assert [e.outcome for e in events if isinstance(e, Done)] == ["success"]
    assert not agent.input_queue.items


@pytest.mark.asyncio
async def test_steering_images_alone_do_not_dismiss_a_pending_approval(session, monkeypatch, tmp_path):
    """Images the model can't read add nothing, so they must not cancel the approval the user is looking at."""
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    asked = asyncio.Event()
    decision: asyncio.Future = asyncio.get_running_loop().create_future()

    async def approve(tool_name, args):
        asked.set()
        return await decision

    agent = Agent(session, auto_approve=False, on_tool_approval=approve, **TEXT_ONLY)
    requests = _model(monkeypatch, _tool_call("write_file", {"path": "a.txt", "content": "x"}), _reply("Wrote a.txt."))
    run = asyncio.ensure_future(_collect(agent.run("create a.txt")))
    await asyncio.wait_for(asked.wait(), 10)
    _steer(agent, PLACEHOLDER, image_uris=[IMAGE], image_only=True)
    await asyncio.sleep(0.05)
    if not decision.done():
        decision.set_result(True)
    events = await asyncio.wait_for(run, 10)

    results = [e.result for e in events if isinstance(e, ToolResult)]
    assert not any("superseded" in str(r).lower() for r in results), results
    assert (tmp_path / "a.txt").exists(), ("the user approved the write", results)
    assert len(requests) == 2


async def _collect(stream) -> list:
    return [event async for event in stream]


# ── Through the VS Code engine ────────────────────────────────────────────────


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


class Engine:
    def __init__(self, root: Path, name: str = "images without vision"):
        from andromity.server.rpc_handler import JsonRpcHandler
        self.root = root
        self.notes: list = []
        self.handler = JsonRpcHandler(send_notification=self.notes.append)
        self.session = Session(project_path=str(root))
        self.session.name = name
        self.session.undo_stack = []
        self.session.add_message("system", "You are Andromity.")
        self.session.save()
        self.handler._active_sessions[self.session.id] = self.session

    async def submit(self, request_id: str, delivery: str = "queue", wait: bool = True, **params) -> str:
        result = await self.handler.rpc_agent_submit({
            "session_id": self.session.id, "project_path": str(self.root), "request_id": request_id,
            "delivery": delivery, "mode": "full", **TEXT_ONLY, **params})
        if wait:
            await self.settle()
        return result["input_id"]

    async def settle(self) -> None:
        sid = self.session.id
        while (task := self.handler._running_tasks.get(sid)) is not None and not task.done():
            await task
            for _ in range(10):
                await asyncio.sleep(0)
        for _ in range(10):
            await asyncio.sleep(0)

    def methods(self, since: int = 0) -> list:
        return [n.method for n in self.notes[since:]]

    def params(self, method: str, since: int = 0) -> list:
        return [{k: v for k, v in n.params.items() if k != "event_seq"} for n in self.notes[since:] if n.method == method]

    def queue(self) -> dict:
        return self.handler._inputs(self.session.id).snapshot()


@pytest.mark.asyncio
async def test_engine_image_only_message_ends_quietly_and_leaves_no_turn(project, monkeypatch, telemetry):
    def first():
        (project / "f0.txt").write_bytes(b"0\n")
        return _reply("Created f0.txt")

    requests = _model(monkeypatch, first)
    engine = Engine(project)
    await engine.submit("r0", prompt="create f0.txt")
    messages, records = copy.deepcopy(engine.session.messages), copy.deepcopy(engine.session.undo_stack)
    since = len(engine.notes)

    input_id = await engine.submit("r1", prompt=PLACEHOLDER, image_uris=[IMAGE], image_only=True)

    assert len(requests) == 1, "the model is not called for the images"
    assert engine.params("agent/imagesSkipped", since) == [
        {"session_id": engine.session.id, "count": 1, "prompt_added": False, "steering": False, "input_id": input_id}]
    methods = engine.methods(since)
    assert "agent/error" not in methods
    assert methods.index("agent/started") < methods.index("agent/imagesSkipped") < methods.index("agent/done")
    assert [p["outcome"] for p in engine.params("agent/done", since)] == ["success"]
    assert not engine.queue()["paused"] and not engine.queue()["items"]
    assert engine.session.messages == messages and engine.session.undo_stack == records
    reloaded = Session.load_by_id(engine.session.id, str(project))
    assert [m.get("content") for m in reloaded.messages] == [m.get("content") for m in messages]
    assert not _errors(telemetry["features"])

    result = await engine.handler.rpc_session_undo({"session_id": engine.session.id, "project_path": str(project), "turns_to_undo": 1})
    assert result["success"] is True and not (project / "f0.txt").exists(), "undo still reaches the last real turn"


@pytest.mark.asyncio
async def test_engine_text_with_images_is_one_saved_undoable_turn(project, monkeypatch, telemetry):
    def answer():
        (project / "fix.txt").write_bytes(b"fixed\n")
        return _reply("Fixed the colour.")

    requests = _model(monkeypatch, answer)
    engine = Engine(project)
    input_id = await engine.submit("r1", prompt="make this button blue", image_uris=[IMAGE, IMAGE])

    assert NOTE in _users(requests[0])[-1]["content"]
    assert engine.params("agent/imagesSkipped") == [
        {"session_id": engine.session.id, "count": 2, "prompt_added": True, "steering": False, "input_id": input_id}]
    methods = engine.methods()
    assert methods.index("agent/imagesSkipped") < methods.index("agent/textDelta") < methods.index("agent/done")
    assert "agent/error" not in methods
    assert [p["outcome"] for p in engine.params("agent/done")] == ["success"]

    reloaded = Session.load_by_id(engine.session.id, str(project))
    stored = _users(reloaded.messages)[-1]
    assert stored["content"].startswith("make this button blue") and stored["images_skipped"] == 2
    assert len(reloaded.get_user_turn_indices()) == 1
    assert len(reloaded.undo_stack) == 1 and reloaded.messages[reloaded.undo_stack[0]["msg_count"]] == stored
    got = await engine.handler.rpc_session_get({"session_id": engine.session.id, "project_path": str(project)})
    assert _users(got["messages"])[-1]["images_skipped"] == 2, "clients rebuild the notice from this"
    assert not _errors(telemetry["features"])

    result = await engine.handler.rpc_session_undo({"session_id": engine.session.id, "project_path": str(project), "turns_to_undo": 1})
    assert result["success"] is True and not (project / "fix.txt").exists()
    assert not _users(engine.session.messages)


@pytest.mark.asyncio
async def test_engine_placeholder_from_an_old_extension_takes_the_text_path(project, monkeypatch):
    requests = _model(monkeypatch, _reply("I can't see images."))
    engine = Engine(project)
    await engine.submit("r1", prompt=PLACEHOLDER, image_uris=[IMAGE])
    content = _users(requests[0])[-1]["content"]
    assert content.startswith(PLACEHOLDER) and NOTE in content
    assert [p["prompt_added"] for p in engine.params("agent/imagesSkipped")] == [True]
    assert len(engine.session.get_user_turn_indices()) == 1


@pytest.mark.asyncio
async def test_engine_steering_images_alone_while_running(project, monkeypatch, telemetry):
    engine = Engine(project)

    async def first():
        await engine.submit("steer-1", delivery="steer", wait=False, prompt=PLACEHOLDER, image_uris=[IMAGE], image_only=True)
        return _reply("The button is red.")

    requests = _model(monkeypatch, first)
    await engine.submit("r1", prompt="why is this button red?")

    assert len(requests) == 1
    assert engine.params("agent/imagesSkipped") == [
        {"session_id": engine.session.id, "count": 1, "prompt_added": False, "steering": True, "input_id": "steer-1"}]
    assert "agent/inputApplied" not in engine.methods() and "agent/error" not in engine.methods()
    assert [p["outcome"] for p in engine.params("agent/done")] == ["success"]
    assert not engine.queue()["paused"] and not engine.queue()["items"]
    assert len(engine.session.undo_stack) == 1
    assert not _errors(telemetry["features"])


@pytest.mark.asyncio
async def test_engine_steering_text_with_images_while_running(project, monkeypatch, telemetry):
    engine = Engine(project)

    async def first():
        await engine.submit("steer-1", delivery="steer", wait=False, prompt="and the footer", image_uris=[IMAGE])
        return _reply("The button is red.")

    requests = _model(monkeypatch, first, _reply("Footer is fine."))
    await engine.submit("r1", prompt="why is this button red?")

    assert len(requests) == 2 and NOTE in _users(requests[1])[-1]["content"]
    methods = engine.methods()
    assert methods.index("agent/inputApplied") < methods.index("agent/imagesSkipped")
    assert engine.params("agent/imagesSkipped") == [
        {"session_id": engine.session.id, "count": 1, "prompt_added": True, "steering": True, "input_id": "steer-1"}]
    assert "agent/error" not in methods
    assert not engine.queue()["paused"]
    assert not _errors(telemetry["features"])


@pytest.mark.asyncio
async def test_engine_retry_without_images_refuses_a_message_of_only_images(project, monkeypatch):
    _model(monkeypatch)
    engine = Engine(project)
    await engine.submit("r1", prompt=PLACEHOLDER, image_uris=[IMAGE], image_only=True)
    with pytest.raises(ValueError, match="This request is no longer available"):
        await engine.handler.rpc_agent_retry({"session_id": engine.session.id, "project_path": str(project), "strip_images": True})


@pytest.mark.asyncio
async def test_engine_image_only_first_message_does_not_name_the_session(project, monkeypatch):
    """No turn is added, so the chat keeps its default name and no title is generated from the placeholder."""
    from andromity.server.rpc_handler import JsonRpcHandler
    titled = []

    async def title(self, session, prompt, provider, model):
        titled.append(prompt)

    monkeypatch.setattr(JsonRpcHandler, "_generate_ai_session_name", title)
    _model(monkeypatch)
    engine = Engine(project, name="Main Session")
    await engine.submit("r1", prompt=PLACEHOLDER, image_uris=[IMAGE], image_only=True)
    await engine.settle()
    assert engine.session.name == "Main Session"
    assert titled == []


@pytest.mark.asyncio
@pytest.mark.parametrize("images_first", [False, True], ids=["text-only", "after-an-image-only-message"])
async def test_engine_image_only_message_keeps_background_results_for_the_next_turn(project, monkeypatch, images_first):
    """Finished background sessions are reported with the next prompt the model sees; an unsent one must not use them up."""
    requests = _model(monkeypatch, _reply())
    engine = Engine(project)
    engine.session.background_runs = [{"title": "Run the test suite", "status": "finished", "summary": "all green"}]
    engine.session.save()
    if images_first:
        await engine.submit("r1", prompt=PLACEHOLDER, image_uris=[IMAGE], image_only=True)
    await engine.submit("r2", prompt="what did the background run find?")
    assert len(requests) == 1
    assert "[Background sessions]" in _users(requests[0])[-1]["content"]


# ── Terminal app ──────────────────────────────────────────────────────────────


@pytest.fixture
def tui(project, monkeypatch):
    from andromity.tui.app import AndromityApp
    monkeypatch.chdir(project)
    return AndromityApp()


def _picture():
    return Image.new("RGB", (40, 30), "red")


def _notices(chat) -> list:
    from andromity.tui.panels.chat import ChatMessage
    return [w for w in chat.children
            if isinstance(w, ChatMessage) and w.role == "system-markup" and "can't read images" in w._content]


def _indexes(chat, role: str) -> list:
    from andromity.tui.panels.chat import ChatMessage
    return [i for i, w in enumerate(chat.children) if isinstance(w, ChatMessage) and w.role == role]


def _headers(chat) -> list:
    return [i for i, w in enumerate(chat.children) if "assistant-header" in w.classes]


@pytest.mark.asyncio
async def test_terminal_shows_the_notice_above_the_reply_and_again_after_reload(tui, monkeypatch):
    from andromity.tui.panels.chat import ChatPanel
    requests = _model(monkeypatch, _reply("I can't see it."))
    async with tui.run_test(size=(120, 30)) as pilot:
        tui.agent.provider, tui.agent.model = TEXT_ONLY["provider"], TEXT_ONLY["model"]
        chat = tui.query_one(ChatPanel)
        chat.add_user_message("why is this red?", image_count=1)
        await tui._stream_agent("why is this red?", images=[_picture()])
        await pilot.pause()

        [notice] = _notices(chat)
        assert "Ctrl+L" in notice._content and "/model" in notice._content
        at = list(chat.children).index(notice)
        assert _indexes(chat, "user")[-1] < at < _headers(chat)[-1], "between the prompt and the reply"
        assert NOTE in _users(requests[0])[-1]["content"]
        assert not tui._inputs().paused
        assert len(tui._undo_stack) == 1

        await chat.load_history(tui.session.messages)
        await pilot.pause()
        [notice] = _notices(chat)
        assert list(chat.children).index(notice) == _indexes(chat, "user")[-1] + 1


@pytest.mark.asyncio
async def test_terminal_message_of_only_images_leaves_no_empty_reply(tui, monkeypatch):
    from andromity.tui.panels.chat import ChatPanel
    requests = _model(monkeypatch)
    async with tui.run_test(size=(120, 30)) as pilot:
        tui.agent.provider, tui.agent.model = TEXT_ONLY["provider"], TEXT_ONLY["model"]
        chat = tui.query_one(ChatPanel)
        before = copy.deepcopy(tui.session.messages)
        chat.add_user_message("", image_count=1)
        await tui._stream_agent("", images=[_picture()])
        await pilot.pause()

        assert requests == []
        assert tui.session.messages == before and tui._undo_stack == []
        assert len(_notices(chat)) == 1
        assert _headers(chat) == [] and _indexes(chat, "assistant") == [], "no empty reply"
        assert chat._streaming is None
        assert not tui._inputs().paused


@pytest.mark.asyncio
async def test_terminal_steering_images_alone_show_the_notice_below_the_reply(tui, monkeypatch):
    from andromity.tui.panels.chat import ChatPanel

    def first():
        tui._inputs().submit({"prompt": "", "images": [_picture()]}, "steer")
        return _reply("The button is red.")

    requests = _model(monkeypatch, first)
    async with tui.run_test(size=(120, 30)) as pilot:
        tui.agent.provider, tui.agent.model = TEXT_ONLY["provider"], TEXT_ONLY["model"]
        chat = tui.query_one(ChatPanel)
        chat.add_user_message("why is this red?")
        await tui._stream_agent("why is this red?")
        await pilot.pause()

        assert len(requests) == 1
        [notice] = _notices(chat)
        assert list(chat.children).index(notice) > _headers(chat)[-1]
        assert len(_indexes(chat, "user")) == 1
        assert not tui._inputs().paused and not tui._inputs().items


@pytest.mark.asyncio
async def test_terminal_message_of_only_images_does_not_name_the_session(tui, monkeypatch):
    """The first message the model actually gets names the chat, as it would without the unsent one."""
    _model(monkeypatch, _reply())
    async with tui.run_test(size=(120, 30)) as pilot:
        tui.agent.provider, tui.agent.model = TEXT_ONLY["provider"], TEXT_ONLY["model"]
        titled = []

        async def title(prompt):
            titled.append(prompt)

        monkeypatch.setattr(tui, "_generate_ai_session_name", title)
        tui._process_message("", [_picture()])
        await tui.workers.wait_for_complete()
        await pilot.pause()
        tui._process_message("fix the login button")
        await tui.workers.wait_for_complete()
        await pilot.pause()
        assert tui.session.name == "fix the login button"
        assert titled == ["fix the login button"]


# ── Storage ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value, expected", [
    (None, 0), (0, 0), (-2, 0), (True, 0), (False, 0), ("3", 0), (2.0, 0), ([1], 0), (1, 1), (5, 5)])
def test_skipped_image_count_only_trusts_positive_whole_numbers(value, expected):
    assert skipped_image_count({"role": "user", "images_skipped": value}) == expected


def test_bad_counts_are_neither_saved_nor_sent(tmp_path):
    s = Session(project_path=str(tmp_path))
    s.add_message("user", "zero", images_skipped=0)
    s.add_message("user", "negative", images_skipped=-1)
    s.messages.append({"role": "user", "content": "text count", "images_skipped": "2", "ts": "2026-01-01T00:00:00+00:00"})
    s.messages.append({"role": "user", "content": "bool count", "images_skipped": True, "ts": "2026-01-01T00:00:00+00:00"})
    s.save()
    assert "images_skipped" not in s.messages[0] and "images_skipped" not in s.messages[1]
    reloaded = Session.load_by_id(s.id, str(tmp_path))
    assert not any("images_skipped" in m for m in reloaded.messages)
    sent = Agent(reloaded, auto_approve=True, **TEXT_ONLY)._messages_for_api()
    assert not any(NOTE in str(m.get("content")) for m in sent)


def test_count_on_a_non_user_message_is_not_sent(tmp_path):
    s = Session(project_path=str(tmp_path))
    s.add_message("user", "hi")
    s.messages.append({"role": "assistant", "content": "hello", "images_skipped": 2})
    sent = Agent(s, auto_approve=True, **TEXT_ONLY)._messages_for_api()
    assert [m["content"] for m in sent if m["role"] != "system"] == ["hi", "hello"]


def test_database_from_before_the_change_gains_the_column_and_loads(tmp_path):
    from andromity.core import db

    old = tmp_path / "old.db"
    db.set_custom_db_path(old)
    s = Session(project_path=str(tmp_path))
    s.add_message("user", "from an older version")
    s.add_message("assistant", "an older answer")
    s.save()
    db.close_conn()
    with sqlite3.connect(old) as conn:
        conn.execute("ALTER TABLE session_messages DROP COLUMN images_skipped")
    assert "images_skipped" not in {r[1] for r in sqlite3.connect(old).execute("PRAGMA table_info(session_messages)")}

    db.set_custom_db_path(old)
    reloaded = Session.load_by_id(s.id, str(tmp_path))
    assert [m["content"] for m in reloaded.messages] == ["from an older version", "an older answer"]
    assert not any("images_skipped" in m for m in reloaded.messages)
    columns = {r[1]: r for r in sqlite3.connect(old).execute("PRAGMA table_info(session_messages)")}
    assert "images_skipped" in columns
    assert columns["images_skipped"][3] == 0 and columns["images_skipped"][4] is None, "nullable, no default"

    reloaded.add_message("user", "with a picture", images_skipped=2)
    reloaded.save()
    db.set_custom_db_path(old)
    again = Session.load_by_id(s.id, str(tmp_path))
    assert [m.get("images_skipped") for m in again.messages] == [None, None, 2]
    db.set_custom_db_path(old)
    db.init_schema()
    db.init_schema()
