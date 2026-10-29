"""Which prompt an undo puts back, with which images: through the VS Code engine and the terminal app, with messages
sent while a turn ran, compacted conversations, engine-added notices, drafts, and chats saved by older versions."""
import asyncio
import base64
import io
import re
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from andromity.config import config
from andromity.core.events import Done, TextDelta
from andromity.core.git_ops import create_pre_edit_snapshot
from andromity.core.images import store_prompt_image
from andromity.core.session import Session, is_compaction_summary
from andromity.core.session_context import background_context


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


def _image(fmt: str, size, color) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt)
    return buf.getvalue()


def _uri(data: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _decoded(uri: str) -> Image.Image:
    with Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1]))) as img:
        img.load()
        return img.copy()


SHOT_PNG = _uri(_image("PNG", (1400, 900), (10, 20, 30)))
SHOT_JPEG = _uri(_image("JPEG", (1000, 800), (200, 20, 30)), "image/jpeg")


def _session(root: Path) -> Session:
    session = Session(project_path=str(root))
    session.undo_stack = []
    session.add_message("system", "You are Andromity.")
    return session


def _turn(session: Session, root: Path, n: int, text: str = "", images=(), steering=None) -> None:
    """A finished turn as the engine records it; its images are kept in the session's image store."""
    session.undo_stack.append({"snapshot_hash": create_pre_edit_snapshot(root), "msg_count": len(session.messages),
                               "turn_index": len(session.get_user_turn_indices()), "anchored": True})
    stored = [store_prompt_image(uri, session.storage_dir) for uri in images]
    session.add_message("user", text or f"turn {n}: create f{n}.txt", images=[t for t, _ in stored] or None,
                        image_files=[name for _, name in stored] or None)
    if steering:
        steer_text, steer_images = steering
        session.add_message("user", steer_text, images=list(steer_images) or None, steering=True)
    (root / f"f{n}.txt").write_bytes(f"file {n}\n".encode())
    session.add_message("assistant", f"created f{n}.txt")
    session.undo_stack[-1]["after_hash"] = create_pre_edit_snapshot(root)


def _files(root: Path) -> list:
    return sorted(int(p.stem[1:]) for p in root.glob("f*.txt"))


def _handler():
    from andromity.server.rpc_handler import JsonRpcHandler
    return JsonRpcHandler(send_notification=lambda note: None)


async def _undo(session: Session, root: Path, handler=None, **params) -> dict:
    handler = handler or _handler()
    handler._active_sessions[session.id] = session
    return await handler.rpc_session_undo({"session_id": session.id, "project_path": str(root), **params})


def _model(root: Path):
    """A model that creates the file each prompt names; compaction gets a canned summary."""
    async def stream(messages, **kwargs):
        content = messages[-1].get("content")
        asked = " ".join(part.get("text", "") for part in content if isinstance(part, dict)) \
            if isinstance(content, list) else str(content or "")
        if asked.startswith("Summarize this conversation"):
            yield TextDelta(text="Earlier turns created files.")
            return
        name = re.search(r"create (f\d+\.txt)", asked).group(1)
        (root / name).write_bytes(f"{name}\n".encode())
        yield TextDelta(text=f"created {name}")
        yield Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
    return stream


def _vision(monkeypatch) -> None:
    monkeypatch.setattr("andromity.core.agent.Agent._model_supports_vision", lambda self: True)


async def _serve(session: Session, root: Path, prompt: str, **params) -> None:
    """One turn through the VS Code engine, start to finish."""
    handler = _handler()
    handler._active_sessions[session.id] = session
    await handler.rpc_agent_prompt({"session_id": session.id, "project_path": str(root), "prompt": prompt,
                                    "mode": "full", **params})
    await handler._running_tasks[session.id]
    await asyncio.sleep(0)


# ── The VS Code engine ───────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_undo_gives_back_the_prompt_as_typed_with_its_images_at_full_size(project, monkeypatch):
    _vision(monkeypatch)
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(project))
    s = _session(project)
    await _serve(s, project, "turn 0: create f0.txt", image_uris=[SHOT_PNG, SHOT_JPEG])
    await _serve(s, project, "turn 1: create f1.txt")
    assert len(s.messages[s.turn_starts()[0]].get("image_files") or []) == 2, "the engine keeps the files' names"

    result = await _undo(s, project, turns_to_undo=2)
    assert result["success"] is True and _files(project) == []
    assert result["undone_prompt"] == {"text": "turn 0: create f0.txt", "images": [SHOT_PNG, SHOT_JPEG]}


@pytest.mark.asyncio
async def test_a_saved_chat_reopened_by_a_new_engine_still_gives_back_full_size_images(project, monkeypatch):
    _vision(monkeypatch)
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(project))
    s = _session(project)
    await _serve(s, project, "turn 0: create f0.txt", image_uris=[SHOT_PNG])
    s.save()

    result = await _handler().rpc_session_undo({"session_id": s.id, "project_path": str(project), "turns_to_undo": 1})
    assert result["success"] is True
    assert result["undone_prompt"] == {"text": "turn 0: create f0.txt", "images": [SHOT_PNG]}


@pytest.mark.asyncio
async def test_a_chat_saved_before_file_names_were_kept_gets_its_thumbnails_back(project):
    from andromity.core.db import get_conn

    s = _session(project)
    _turn(s, project, 0, images=[SHOT_PNG, SHOT_JPEG])
    s.save()
    get_conn().execute("UPDATE session_messages SET image_files = NULL WHERE session_id = ?", (s.id,))

    result = await _handler().rpc_session_undo({"session_id": s.id, "project_path": str(project), "turns_to_undo": 1})
    assert result["success"] is True and result["undone_prompt"]["text"] == "turn 0: create f0.txt"
    images = result["undone_prompt"]["images"]
    assert len(images) == 2 and all(uri.startswith("data:image/jpeg;base64,") for uri in images)
    assert all(max(_decoded(uri).size) <= 360 for uri in images), "the small copies kept with the prompt"


def test_an_older_database_gains_the_column_and_its_chats_still_load_and_save(project):
    from andromity.core import db

    s = _session(project)
    s.add_message("user", "old prompt", images=[SHOT_JPEG])
    s.save()
    conn = db.get_conn()
    conn.execute("ALTER TABLE session_messages DROP COLUMN image_files")
    db.init_schema()

    loaded = Session.load_by_id(s.id, str(project))
    assert loaded is not None and "image_files" not in loaded.messages[-1]
    loaded.add_message("user", "new prompt", images=[SHOT_JPEG], image_files=["0123456789abcdef.jpg"])
    loaded.save()
    again = Session.load_by_id(s.id, str(project))
    assert again.messages[-1]["image_files"] == ["0123456789abcdef.jpg"]


@pytest.mark.asyncio
async def test_the_co_agent_mailbox_notice_the_engine_adds_is_not_put_back(project, monkeypatch):
    from andromity.core.session_bus import SessionBus

    _vision(monkeypatch)
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(project))
    monkeypatch.setattr(SessionBus, "get_unread_count", lambda self, sid: 2)
    monkeypatch.setattr(SessionBus, "get_pending_questions_for", lambda self, sid: [
        {"question": "is [step 2] done? ]", "question_id": "q1", "from_session": "helper"}])
    s = _session(project)
    await _serve(s, project, "turn 0: create f0.txt", image_uris=[SHOT_PNG])
    sent = s.messages[s.turn_starts()[0]]["content"]
    assert "[Co-Agent Mailbox: Pending questions:" in sent and "2 unread message(s)" in sent

    result = await _undo(s, project, turns_to_undo=1)
    assert result["undone_prompt"] == {"text": "turn 0: create f0.txt", "images": [SHOT_PNG]}


@pytest.mark.asyncio
async def test_the_session_context_and_the_mailbox_notice_are_both_left_out(project):
    parent = Session(name="refactor auth", project_path=str(project))
    parent.add_message("user", "split the auth module")
    parent.add_message("assistant", "Split it into three files.")
    typed = "Write tests for the new auth files.\nCover the [login] path too."
    s = _session(project)
    s.add_message("user", typed + background_context(parent)
                  + "\n\n[Co-Agent Mailbox: 1 unread message(s). (Read them with session_inbox)]")
    s.add_message("assistant", "Done.")

    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is True and result["undone_prompt"] == {"text": typed, "images": []}


@pytest.mark.asyncio
async def test_a_prompt_that_quotes_a_mailbox_notice_is_put_back_whole(project):
    typed = ("Why does the agent print this?\n\n[Co-Agent Mailbox: 3 unread message(s). (Read them with session_inbox)]"
             "\n\nIt shows up after every turn.")
    s = _session(project)
    s.add_message("user", typed + "\n\n[Co-Agent Mailbox: 1 unread message(s). (Read them with session_inbox)]")
    s.add_message("assistant", "That is the mailbox notice.")

    result = await _undo(s, project, turns_to_undo=1)
    assert result["undone_prompt"]["text"] == typed


@pytest.mark.asyncio
async def test_a_prompt_that_only_looks_like_it_ends_in_a_notice_keeps_its_text(project):
    typed = "Rename [Co-Agent Mailbox: tasks] to inbox in the docs]"
    s = _session(project)
    s.add_message("user", typed)
    s.add_message("assistant", "Renamed.")
    assert (await _undo(s, project, turns_to_undo=1))["undone_prompt"]["text"] == typed


@pytest.mark.asyncio
async def test_undo_gives_back_the_turns_own_prompt_not_a_message_sent_while_it_ran(project):
    s = _session(project)
    steer_shot = _uri(_image("PNG", (500, 300), (0, 0, 255)))
    _turn(s, project, 0, images=[SHOT_PNG], steering=("also add a footer", [steer_shot]))
    _turn(s, project, 1, steering=("and log it", []))

    result = await _undo(s, project, turns_to_undo=1)
    assert result["undone_prompt"] == {"text": "turn 1: create f1.txt", "images": []}
    result = await _undo(s, project, turns_to_undo=1)
    assert result["undone_prompt"] == {"text": "turn 0: create f0.txt", "images": [SHOT_PNG]}
    assert _files(project) == []


@pytest.mark.asyncio
async def test_undoing_several_turns_gives_back_the_earliest_prompt_removed(project):
    shots = [_uri(_image("PNG", (300 + n, 200), (n * 60, 0, 0))) for n in range(3)]
    s = _session(project)
    for n in range(3):
        _turn(s, project, n, images=[shots[n]])
    s.save()

    result = await _undo(s, project, turn_index=1)
    assert result["turns_undone"] == 2
    assert result["undone_prompt"] == {"text": "turn 1: create f1.txt", "images": [shots[1]]}
    result = await _undo(s, project, turns_to_undo=1)
    assert result["undone_prompt"] == {"text": "turn 0: create f0.txt", "images": [shots[0]]}


@pytest.mark.asyncio
async def test_the_turn_that_compacted_the_conversation_gives_back_its_prompt_and_image(project, monkeypatch):
    _vision(monkeypatch)
    s = _session(project)
    for n in range(10):
        _turn(s, project, n)
    s.save()
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(project))
    s.context_tokens = 10 ** 9
    await _serve(s, project, "turn 10: create f10.txt", image_uris=[SHOT_JPEG])
    assert any(map(is_compaction_summary, s.messages)), "the turn compacted the conversation"

    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is True and _files(project) == list(range(10))
    assert result["undone_prompt"] == {"text": "turn 10: create f10.txt", "images": [SHOT_JPEG]}
    result = await _undo(s, project, turns_to_undo=1)
    assert result["undone_prompt"] == {"text": "turn 9: create f9.txt", "images": []}
    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is False and "summarized" in result["error"] and "undone_prompt" not in result


@pytest.mark.asyncio
async def test_undo_still_succeeds_when_the_prompt_cannot_be_read_back(project, monkeypatch):
    s = _session(project)
    _turn(s, project, 0, images=[SHOT_PNG])

    def broken(*args, **kwargs):
        raise MemoryError("image store unreadable")

    monkeypatch.setattr("andromity.server.rpc_handler.prompt_images", broken)
    result = await _undo(s, project, turns_to_undo=1)
    assert result["success"] is True and result["undone_prompt"] is None
    assert _files(project) == [] and [m["role"] for m in s.messages] == ["system"]


@pytest.mark.asyncio
async def test_a_prompt_stored_as_content_parts_gives_back_its_text(project):
    s = _session(project)
    s.add_message("user", [{"type": "text", "text": "compare "}, {"type": "image_url", "image_url": {"url": SHOT_PNG}},
                           {"type": "text", "text": "these two"}, "stray", None])
    s.add_message("assistant", "They differ.")
    result = await _undo(s, project, turns_to_undo=1)
    assert result["undone_prompt"]["text"] == "compare these two"


@pytest.mark.asyncio
async def test_an_image_only_prompt_comes_back_with_no_text(project):
    s = _session(project)
    _turn(s, project, 0, text=" ", images=[SHOT_PNG])
    s.messages[s.turn_starts()[0]]["content"] = None
    result = await _undo(s, project, turns_to_undo=1)
    assert result["undone_prompt"] == {"text": "", "images": [SHOT_PNG]}


@pytest.mark.asyncio
async def test_an_old_prompt_with_seven_thumbnails_gives_back_five(project):
    thumbs = [_uri(_image("JPEG", (40, 40), (n * 30, 0, 0)), "image/jpeg") for n in range(7)]
    s = _session(project)
    s.add_message("user", "many shots", images=thumbs)
    s.add_message("assistant", "ok")
    assert (await _undo(s, project, turns_to_undo=1))["undone_prompt"]["images"] == thumbs[:5]


@pytest.mark.asyncio
async def test_a_file_named_by_the_prompt_but_kept_in_another_projects_store_is_not_used(project, tmp_path):
    other_root = tmp_path / "other"
    other_root.mkdir()
    other = Session(project_path=str(other_root))
    _, name = store_prompt_image(SHOT_PNG, other.storage_dir)
    thumb = _uri(_image("JPEG", (40, 40), (1, 1, 1)), "image/jpeg")
    s = _session(project)
    assert s.storage_dir != other.storage_dir
    s.add_message("user", "copied", images=[thumb], image_files=[name])
    s.add_message("assistant", "ok")
    assert (await _undo(s, project, turns_to_undo=1))["undone_prompt"]["images"] == [thumb]


# ── The terminal app ─────────────────────────────────────────────────────────────────────────────────────────────


def _terminal(project: Path, monkeypatch):
    from andromity.tui.app import AndromityApp

    monkeypatch.chdir(project)
    _vision(monkeypatch)
    monkeypatch.setattr("andromity.core.agent.stream_completion", _model(project))
    return AndromityApp()


async def _terminal_undo(app) -> None:
    app._undo_in_progress = True
    await app._async_perform_undo(app._undo_stack.pop())


def _input(app):
    from textual.widgets import TextArea
    from andromity.tui.footer import InputBar

    bar = app.query_one(InputBar)
    return bar, bar.query_one("#input-field", TextArea)


@pytest.mark.asyncio
async def test_terminal_undo_puts_the_text_and_the_full_size_image_back(project, monkeypatch):
    app = _terminal(project, monkeypatch)
    async with app.run_test(size=(120, 30)) as pilot:
        app.agent.auto_approve = True
        await app._stream_agent("turn 0: create f0.txt", images=[Image.new("RGB", (900, 700), (10, 200, 30))])
        await _terminal_undo(app)
        await pilot.pause()
        bar, field = _input(app)
        assert field.text == "turn 0: create f0.txt"
        assert [image.size for image in bar.attachments] == [(900, 700)], "full size, not the 360px thumbnail"
        red, green, blue = bar.attachments[0].convert("RGB").getpixel((450, 350))
        assert abs(green - 200) < 12 and red < 30 and blue < 45
        assert _files(project) == []


@pytest.mark.asyncio
async def test_terminal_undo_keeps_a_draft_and_offers_the_prompt_back(project, monkeypatch):
    from andromity.tui.panels.chat import PromptBackCard

    app = _terminal(project, monkeypatch)
    async with app.run_test(size=(120, 30)) as pilot:
        app.agent.auto_approve = True
        await app._stream_agent("turn 0: create f0.txt", images=[Image.new("RGB", (640, 480), (200, 0, 0))])
        bar, field = _input(app)
        field.text = "my half-written idea"
        draft_image = Image.new("RGB", (32, 32), (0, 0, 0))
        bar._add_attachment(draft_image)
        await _terminal_undo(app)
        await pilot.pause()

        assert field.text == "my half-written idea" and bar.attachments == [draft_image], "the draft stays"
        cards = list(app.query(PromptBackCard))
        assert len(cards) == 1
        cards[0].query_one("#prompt-back").press()
        await pilot.pause()
        await pilot.pause()
        assert field.text == "turn 0: create f0.txt"
        assert [image.size for image in bar.attachments] == [(640, 480)]
        assert not list(app.query(PromptBackCard)), "the card goes once the prompt is back"


@pytest.mark.asyncio
async def test_terminal_undo_keeps_a_draft_that_is_only_an_image(project, monkeypatch):
    from andromity.tui.panels.chat import PromptBackCard

    app = _terminal(project, monkeypatch)
    async with app.run_test(size=(120, 30)) as pilot:
        app.agent.auto_approve = True
        await app._stream_agent("turn 0: create f0.txt")
        bar, field = _input(app)
        draft_image = Image.new("RGB", (32, 32), (0, 0, 0))
        bar._add_attachment(draft_image)
        await _terminal_undo(app)
        await pilot.pause()
        assert field.text == "" and bar.attachments == [draft_image]
        assert len(list(app.query(PromptBackCard))) == 1


@pytest.mark.asyncio
async def test_terminal_undo_puts_a_long_prompt_back_whole(project, monkeypatch):
    app = _terminal(project, monkeypatch)
    prompt = "turn 0: create f0.txt\n" + "log line\n" * 3000
    assert len(prompt) > 20000
    async with app.run_test(size=(120, 30)) as pilot:
        app.agent.auto_approve = True
        await app._stream_agent(prompt)
        await _terminal_undo(app)
        await pilot.pause()
        _, field = _input(app)
        assert len(field.text) == len(prompt), f"{len(prompt) - len(field.text)} characters of the prompt were lost"


@pytest.mark.asyncio
async def test_terminal_attachments_for_an_old_prompt_are_its_thumbnails(tmp_path):
    from andromity.tui.app import _prompt_attachments

    thumb = _uri(_image("JPEG", (360, 240), (0, 90, 0)), "image/jpeg")
    images = await _prompt_attachments({"role": "user", "images": [thumb, "javascript:alert(1)"]}, tmp_path)
    assert [image.size for image in images] == [(360, 240)]
    assert await _prompt_attachments({"role": "user", "content": "text only"}, tmp_path) == []
