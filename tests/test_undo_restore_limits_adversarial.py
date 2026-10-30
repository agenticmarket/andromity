"""Attempts to break the limits on what an undo hands back: the 16 MB budget for full-size images, the image store
read off the event loop, and pasted base64 that arrives wrapped in lines."""
import asyncio
import base64
import hashlib
import io
import subprocess
import threading
from pathlib import Path

import pytest
from PIL import Image

from andromity.config import config
from andromity.core.images import (
    MAX_IMAGES,
    MAX_RESTORED_URI_CHARS,
    MAX_STORED_IMAGE_BYTES,
    STORED_IMAGE_NAME,
    prompt_images,
    store_prompt_image,
)
from andromity.core.session import Session

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_HEADER = "data:image/png;base64,"


def _uri(data: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _uri_chars(raw_bytes: int) -> int:
    return len(PNG_HEADER) + 4 * -(-raw_bytes // 3)


def _image(fmt: str, size, color, **save) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt, **save)
    return buf.getvalue()


def _thumb(n: int) -> str:
    return _uri(_image("JPEG", (24, 16), (n * 40 % 256, 90, 10)), "image/jpeg")


def _blob(raw_bytes: int, fill: int) -> bytes:
    """Bytes the store accepts as a PNG: the signature, then filler up to the exact size."""
    return PNG_SIGNATURE + bytes([fill]) * (raw_bytes - len(PNG_SIGNATURE))


def _keep(storage_dir, data: bytes) -> str:
    """Put bytes in the session's image store the way a pasted image is kept."""
    name = f"{hashlib.sha256(data).hexdigest()[:16]}.jpg"
    images = Path(storage_dir) / "images"
    images.mkdir(parents=True, exist_ok=True)
    (images / name).write_bytes(data)
    return name


def _prompt(storage_dir, sizes) -> tuple:
    """A sent prompt with one stored image of each raw size and a small distinct thumbnail for each."""
    fulls, thumbs, names = [], [], []
    for n, size in enumerate(sizes):
        data = _blob(size, n + 1)
        names.append(_keep(storage_dir, data))
        fulls.append(_uri(data))
        thumbs.append(_thumb(n))
    return {"role": "user", "content": "look", "images": list(thumbs), "image_files": names}, fulls, thumbs


def _kinds(result, fulls, thumbs) -> list:
    kinds = []
    for uri, full, thumb in zip(result, fulls, thumbs):
        kinds.append("full" if uri == full else "thumb" if uri == thumb else "other")
    return kinds


BIG = MAX_STORED_IMAGE_BYTES
BIG_URI = _uri_chars(BIG)
EXACT_REST = 3 * ((MAX_RESTORED_URI_CHARS - BIG_URI - len(PNG_HEADER)) // 4)


@pytest.fixture
def storage(tmp_path):
    return Session(project_path=str(tmp_path)).storage_dir


# ── The 16 MB budget ─────────────────────────────────────────────────────────────────────────────────────────────


def test_the_budget_is_16_mb_and_one_stored_image_never_fills_it_alone():
    assert MAX_RESTORED_URI_CHARS == 16 * 1024 * 1024
    assert BIG_URI < MAX_RESTORED_URI_CHARS < 2 * BIG_URI


def test_two_images_that_fill_the_budget_exactly_both_come_back_full_size(storage):
    assert BIG_URI + _uri_chars(EXACT_REST) == MAX_RESTORED_URI_CHARS
    message, fulls, thumbs = _prompt(storage, [BIG, EXACT_REST])
    result = prompt_images(message, storage)
    assert _kinds(result, fulls, thumbs) == ["full", "full"]
    assert sum(map(len, result)) == MAX_RESTORED_URI_CHARS


def test_one_byte_past_the_budget_comes_back_as_its_thumbnail(storage):
    assert BIG_URI + _uri_chars(EXACT_REST + 1) == MAX_RESTORED_URI_CHARS + 4
    message, fulls, thumbs = _prompt(storage, [BIG, EXACT_REST + 1])
    assert _kinds(prompt_images(message, storage), fulls, thumbs) == ["full", "thumb"]


def test_once_the_budget_is_spent_even_a_tiny_image_comes_back_as_its_thumbnail(storage):
    message, fulls, thumbs = _prompt(storage, [BIG, EXACT_REST, 64])
    assert _kinds(prompt_images(message, storage), fulls, thumbs) == ["full", "full", "thumb"]


def test_five_8_mb_images_give_back_one_at_full_size_and_four_thumbnails(storage):
    message, fulls, thumbs = _prompt(storage, [BIG] * MAX_IMAGES)
    result = prompt_images(message, storage)
    assert _kinds(result, fulls, thumbs) == ["full"] + ["thumb"] * (MAX_IMAGES - 1)
    assert sum(len(uri) for uri, full in zip(result, fulls) if uri == full) <= MAX_RESTORED_URI_CHARS


def test_mixed_sizes_keep_their_order_and_a_later_small_image_still_fits_after_a_large_one_did_not(storage):
    message, fulls, thumbs = _prompt(storage, [BIG, 1024, BIG, 3 * 1024 * 1024, 1024])
    result = prompt_images(message, storage)
    assert _kinds(result, fulls, thumbs) == ["full", "full", "thumb", "full", "full"]
    assert sum(map(len, result)) <= MAX_RESTORED_URI_CHARS


def test_thumbnails_handed_back_count_against_the_budget_too(storage):
    old_thumb = _thumb(9)
    message, fulls, thumbs = _prompt(storage, [BIG, EXACT_REST])
    message["images"].insert(0, old_thumb)
    message["image_files"].insert(0, None)
    result = prompt_images(message, storage)
    assert result[0] == old_thumb
    assert _kinds(result[1:], fulls, thumbs) == ["full", "thumb"]
    assert sum(map(len, result)) <= MAX_RESTORED_URI_CHARS


def test_an_image_whose_file_is_gone_does_not_spend_the_budget_of_the_next_one(storage):
    message, fulls, thumbs = _prompt(storage, [BIG, EXACT_REST])
    (Path(storage) / "images" / message["image_files"][0]).unlink()
    assert _kinds(prompt_images(message, storage), fulls, thumbs) == ["thumb", "full"]


def test_a_prompt_whose_kept_thumbnails_are_whole_images_still_stays_within_the_budget(storage):
    """A pasted image the thumbnailer cannot decode is kept with the prompt as it was sent."""
    names, sent = [], []
    for n in range(MAX_IMAGES):
        data = PNG_SIGNATURE + b"\x00\x00\x00\x0dIHDR" + bytes([n + 1]) * (BIG - 16)
        uri = _uri(data)
        thumb, name = store_prompt_image(uri, storage)
        assert name and thumb == uri, "the thumbnailer cannot decode this, so the whole image is kept"
        names.append(name)
        sent.append(thumb)
    result = prompt_images({"role": "user", "images": sent, "image_files": names}, storage)
    total = sum(map(len, result))
    assert total <= MAX_RESTORED_URI_CHARS, f"{len(result)} images, {total / 2**20:.1f} MB of data URIs handed back"


# ── Through session.undo and the terminal app ───────────────────────────────────────────────────────────────────


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


def _handler():
    from andromity.server.rpc_handler import JsonRpcHandler
    return JsonRpcHandler(send_notification=lambda note: None)


async def _undo(session: Session, root: Path) -> dict:
    handler = _handler()
    handler._active_sessions[session.id] = session
    return await handler.rpc_session_undo({"session_id": session.id, "project_path": str(root), "turns_to_undo": 1})


@pytest.mark.asyncio
async def test_session_undo_hands_back_at_most_16_mb_of_full_size_images(project):
    s = Session(project_path=str(project))
    message, fulls, thumbs = _prompt(s.storage_dir, [BIG, EXACT_REST + 1, 1024, BIG])
    s.add_message("user", "compare these", images=message["images"], image_files=message["image_files"])
    s.add_message("assistant", "ok")
    result = await _undo(s, project)
    assert result["success"] is True
    undone = result["undone_prompt"]
    assert undone["text"] == "compare these"
    assert _kinds(undone["images"], fulls, thumbs) == ["full", "thumb", "full", "thumb"]
    assert sum(map(len, undone["images"])) <= MAX_RESTORED_URI_CHARS


def _solid_png(color) -> bytes:
    """A real 1600x1600 screenshot-sized PNG of about 7.7 MB."""
    return _image("PNG", (1600, 1600), color, compress_level=0)


@pytest.mark.asyncio
async def test_the_terminal_gets_one_full_size_image_and_thumbnails_for_the_rest(tmp_path):
    from andromity.tui.app import _prompt_attachments

    storage = Session(project_path=str(tmp_path)).storage_dir
    shots = [_solid_png((200, 10, 10)), _solid_png((10, 200, 10)), _solid_png((10, 10, 200))]
    assert all(len(shot) <= MAX_STORED_IMAGE_BYTES for shot in shots)
    assert 2 * len(_uri(shots[0])) > MAX_RESTORED_URI_CHARS
    stored = [store_prompt_image(_uri(shot), storage) for shot in shots]
    message = {"role": "user", "images": [t for t, _ in stored], "image_files": [n for _, n in stored]}

    images = await _prompt_attachments(message, storage)
    assert [image.size for image in images] == [(1600, 1600), (360, 360), (360, 360)]
    colors = [image.convert("RGB").getpixel((5, 5)) for image in images]
    assert [max(range(3), key=color.__getitem__) for color in colors] == [0, 1, 2], colors


# ── Off the event loop ───────────────────────────────────────────────────────────────────────────────────────────


class _Gate:
    """Blocks a worker until a coroutine on the event loop opens it; if the worker runs on the loop, nothing can."""

    def __init__(self):
        self.opened = threading.Event()
        self.threads = []
        self.waited = []

    def block(self):
        self.threads.append(threading.get_ident())
        self.waited.append(self.opened.wait(5))

    async def open_from_the_loop(self):
        await asyncio.sleep(0.05)
        self.opened.set()


def _session_with_image(root: Path) -> tuple:
    session = Session(project_path=str(root))
    data = _image("PNG", (64, 48), (1, 2, 3))
    thumb, name = store_prompt_image(_uri(data), session.storage_dir)
    session.add_message("user", "see", images=[thumb], image_files=[name])
    session.add_message("assistant", "seen")
    session.save()
    return session, name, data


@pytest.mark.asyncio
async def test_session_image_loads_a_session_that_is_not_open_off_the_event_loop(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    root.mkdir()
    session, name, data = _session_with_image(root)
    gate = _Gate()
    load = Session.load_by_id

    def slow_load(session_id, project_path=None):
        gate.block()
        return load(session_id, project_path)

    monkeypatch.setattr(Session, "load_by_id", staticmethod(slow_load))
    opener = asyncio.create_task(gate.open_from_the_loop())
    result = await _handler().rpc_session_image({"session_id": session.id, "name": name, "project_path": str(root)})
    await opener

    assert gate.threads and gate.threads[0] != threading.get_ident(), "the session was loaded on the event loop thread"
    assert gate.waited == [True], "the event loop could not run while the session was loading"
    assert result["success"] is True and base64.b64decode(result["uri"].split(",", 1)[1]) == data


@pytest.mark.asyncio
async def test_other_requests_are_answered_while_a_closed_session_is_loading(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    root.mkdir()
    closed, closed_name, _ = _session_with_image(root)
    open_session, open_name, open_data = _session_with_image(root)
    handler = _handler()
    handler._active_sessions[open_session.id] = open_session
    started = threading.Event()
    finish = threading.Event()
    load = Session.load_by_id

    def slow_load(session_id, project_path=None):
        started.set()
        finish.wait(5)
        return load(session_id, project_path)

    monkeypatch.setattr(Session, "load_by_id", staticmethod(slow_load))
    slow = asyncio.create_task(handler.rpc_session_image({"session_id": closed.id, "name": closed_name,
                                                         "project_path": str(root)}))
    for _ in range(200):
        if started.is_set():
            break
        await asyncio.sleep(0.01)
    assert started.is_set()
    try:
        quick = await asyncio.wait_for(handler.rpc_session_image({"session_id": open_session.id, "name": open_name}), 2)
        still_loading = not slow.done()
    finally:
        finish.set()
    assert still_loading, "the open session's image waited for the other session to finish loading"
    assert quick["success"] is True and base64.b64decode(quick["uri"].split(",", 1)[1]) == open_data
    assert (await slow)["success"] is True


@pytest.mark.asyncio
async def test_session_image_reads_the_image_store_off_the_event_loop(tmp_path, monkeypatch):
    import andromity.server.rpc_handler as rpc

    root = tmp_path / "proj"
    root.mkdir()
    session, name, data = _session_with_image(root)
    gate = _Gate()
    read = rpc.stored_image_uri

    def slow_read(storage_dir, file_name):
        gate.block()
        return read(storage_dir, file_name)

    monkeypatch.setattr(rpc, "stored_image_uri", slow_read)
    handler = _handler()
    handler._active_sessions[session.id] = session
    opener = asyncio.create_task(gate.open_from_the_loop())
    result = await handler.rpc_session_image({"session_id": session.id, "name": name})
    await opener
    assert gate.waited == [True] and gate.threads[0] != threading.get_ident()
    assert result["success"] is True


@pytest.mark.asyncio
async def test_session_undo_reads_the_undone_images_off_the_event_loop(project, monkeypatch):
    import andromity.server.rpc_handler as rpc

    s = Session(project_path=str(project))
    message, fulls, _ = _prompt(s.storage_dir, [1024])
    s.add_message("user", "x", images=message["images"], image_files=message["image_files"])
    s.add_message("assistant", "ok")
    gate = _Gate()
    images = rpc.prompt_images

    def slow_images(prompt, storage_dir):
        gate.block()
        return images(prompt, storage_dir)

    monkeypatch.setattr(rpc, "prompt_images", slow_images)
    opener = asyncio.create_task(gate.open_from_the_loop())
    result = await _undo(s, project)
    await opener
    assert gate.waited == [True] and gate.threads[0] != threading.get_ident()
    assert result["undone_prompt"]["images"] == fulls


# ── Line-wrapped base64 ──────────────────────────────────────────────────────────────────────────────────────────


SHOT = _image("PNG", (900, 500), (30, 140, 220))


def _wrapped(data: bytes, width: int = 76, newline: str = "\r\n") -> str:
    b64 = base64.b64encode(data).decode("ascii")
    return "data:image/png;base64," + newline.join(b64[i:i + width] for i in range(0, len(b64), width))


def _stored(storage) -> list:
    folder = Path(storage) / "images"
    return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []


@pytest.mark.parametrize("uri", [
    _wrapped(SHOT),
    _wrapped(SHOT, 64, "\n"),
    _wrapped(SHOT, 76, "\r\n") + "\r\n",
    "data:image/png;base64,\n" + _wrapped(SHOT, 60, "\n \t").split(",", 1)[1],
    "data:image/png;base64," + " ".join(base64.b64encode(SHOT).decode("ascii")),
], ids=["crlf-76", "lf-64", "trailing-crlf", "leading-newline-tabs-spaces", "space-between-every-char"])
def test_line_wrapped_base64_is_kept_byte_for_byte_with_a_thumbnail(storage, uri):
    thumb, name = store_prompt_image(uri, storage)
    assert name is not None and STORED_IMAGE_NAME.fullmatch(name)
    assert (Path(storage) / "images" / name).read_bytes() == SHOT
    assert name == store_prompt_image(_uri(SHOT), storage)[1], "the same image is stored once, however it was wrapped"
    assert thumb.startswith("data:image/jpeg;base64,") and "\n" not in thumb and " " not in thumb
    with Image.open(io.BytesIO(base64.b64decode(thumb.split(",", 1)[1]))) as img:
        assert max(img.size) == 360
    assert prompt_images({"images": [thumb], "image_files": [name]}, storage) == [_uri(SHOT)]


@pytest.mark.parametrize("uri", [
    "data:image/png;base64,",
    "data:image/png;base64,\r\n",
    "data:image/png;base64, \n\t \r\n ",
    "data:image/png;base64,====",
    "data:image/png;base64,\n====\n",
    "data:image/png;base64,iVBORw0K\n*GgoAAAANSUhEUg==",
    "data:image/png;base64,iVBORw0K\nGgo-AAAANSUhEUg==",
    "data:image/png;base64,iVBORw0KGgo",
    "data:image/png;base64,iVBO\nRw0K\nGgo",
    "data:image/png;base64," + base64.b64encode(SHOT).decode("ascii")[:-2] + "\n%%",
    "data:image/png;base64,iVBORw0KéGgoAAAANSUhEUg==",
    "data:image/png;base64,iVBORw0K\x00GgoAAAANSUhEUg==",
    "data:image/png;base64",
], ids=["empty", "only-crlf", "only-whitespace", "only-padding", "wrapped-padding", "star", "dash", "bad-length",
        "wrapped-bad-length", "percent-tail", "non-ascii", "nul", "no-comma"])
def test_garbage_or_empty_base64_is_never_stored(storage, uri):
    thumb, name = store_prompt_image(uri, storage)
    assert name is None and thumb == uri
    assert _stored(storage) == []


def test_wrapped_base64_of_bytes_that_are_not_an_image_is_not_stored(storage):
    uri = "data:image/png;base64," + "\n".join(base64.b64encode(b"#!/bin/sh\nrm -rf ~\n" * 40).decode("ascii")[i:i + 76]
                                               for i in range(0, 1080, 76))
    thumb, name = store_prompt_image(uri, storage)
    assert name is None
    assert _stored(storage) == []
