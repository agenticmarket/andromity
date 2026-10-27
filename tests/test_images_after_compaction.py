"""A pasted image still reaches the model when the turn it was sent with compacts the conversation."""
import asyncio
import base64
import io
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from andromity.config import config
from andromity.core.events import Done, TextDelta, ToolCallDelta, ToolCallEnd, ToolCallStart
from andromity.core.session import Session, is_compaction_summary

PROMPT = "what colour is the logo in this screenshot?"


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "notes.txt").write_bytes(b"The logo is blue.\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    config.set_trusted(str(root))
    return root


def _screenshot() -> str:
    """A paste larger than the thumbnail the chat keeps of it."""
    buffer = io.BytesIO()
    Image.new("RGB", (1200, 800), (40, 90, 200)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _long_chat(root: Path) -> Session:
    """Enough earlier turns that compaction summarizes some and keeps the newest."""
    session = Session(project_path=str(root))
    session.name = "image after compaction"
    session.add_message("system", "You are Andromity.")
    for n in range(6):
        session.add_message("user", f"question {n}")
        session.add_message("assistant", f"answer {n}")
    session.save()
    return session


def _model(requests: list):
    """Reads a file before it answers, so the turn sends two requests; compaction gets a canned summary."""
    async def stream(messages, **kwargs):
        if str(messages[-1].get("content")).startswith("Summarize this conversation"):
            yield TextDelta(text="The user asked six questions.")
            return
        requests.append(messages)
        if len(requests) == 1:
            yield ToolCallStart(tool_name="read_file", tool_id="call_notes")
            yield ToolCallDelta(tool_id="call_notes", args_json_chunk='{"path": "notes.txt"}')
            yield ToolCallEnd(tool_id="call_notes")
        else:
            yield TextDelta(text="Blue.")
        yield Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
    return stream


async def _serve(session: Session, root: Path, prompt: str, **params) -> None:
    """One turn through the VS Code engine, start to finish."""
    from andromity.server.rpc_handler import JsonRpcHandler

    handler = JsonRpcHandler(send_notification=lambda note: None)
    handler._active_sessions[session.id] = session
    await handler.rpc_agent_prompt({"session_id": session.id, "project_path": str(root), "prompt": prompt,
                                    "mode": "full", **params})
    await handler._running_tasks[session.id]
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_a_pasted_image_reaches_the_model_when_its_turn_compacts_the_conversation(project, monkeypatch):
    s = _long_chat(project)
    requests = []
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(requests))
    monkeypatch.setattr("andromity.core.agent.Agent._model_supports_vision", lambda self: True)
    image = _screenshot()

    s.context_tokens = 10 ** 9
    await _serve(s, project, PROMPT, image_uris=[image])

    assert len(requests) == 2, "a tool call, then the answer: two requests in one turn"
    assert all(any(map(is_compaction_summary, sent)) for sent in requests), "both were sent after compaction"
    parts = [{"type": "text", "text": PROMPT}, {"type": "image_url", "image_url": {"url": image}}]
    for number, sent in enumerate(requests, 1):
        assert [m for m in sent if m["role"] == "user"][-1]["content"] == parts, f"request {number}"

    stored = [m for m in s.messages if m["role"] == "user"][-1]
    assert stored["content"] == PROMPT, "the chat stores the prompt as text"
    assert stored["images"] and image not in stored["images"], "and a thumbnail of the paste, not the paste"
