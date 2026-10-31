"""Attacks on the images an undo puts back and the session.image RPC: names that leave the image store, links out of
it, other sessions' images, fake and oversized files, and thumbnails that are not base64 image data."""
import base64
import hashlib
import io
import os
import re
from pathlib import Path

import pytest
from PIL import Image

from andromity.core.images import (MAX_IMAGES, MAX_STORED_IMAGE_BYTES, checked_image_uri, image_from_data_uri,
                                   prompt_images, store_prompt_image, stored_image_uri)
from andromity.core.session import Session
from andromity.server.protocol import JsonRpcRequest

NAME = "0123456789abcdef.jpg"
SAFE_URI = re.compile(r"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}")


def _image(fmt: str, size=(6, 4), color=(200, 40, 40)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt)
    return buf.getvalue()


PNG = _image("PNG")
JPEG = _image("JPEG")


def _uri(data: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _bytes_of(uri: str) -> bytes:
    return base64.b64decode(uri.split(",", 1)[1])


def _hash_name(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16] + ".jpg"


@pytest.fixture
def store(tmp_path):
    storage = tmp_path / "sessions" / "project"
    (storage / "images").mkdir(parents=True)
    return storage


def _put(storage: Path, name: str, data: bytes) -> Path:
    path = storage / "images" / name
    path.write_bytes(data)
    return path


def _symlink(link: Path, target: Path) -> None:
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"creating symlinks needs a privilege this machine lacks: {error}")


# ── Names ────────────────────────────────────────────────────────────────────────────────────────────────────────


LOOKALIKE_NAMES = [
    "notes.png", ".0123456789abcdef.tmp", "0123456789ABCDEF.jpg", "0123456789abcdef.JPG", "0123456789abcdef.jpeg",
    "0123456789abcdef.png", "0123456789abcde.jpg", "0123456789abcdef0.jpg", "0123456789abcdeg.jpg",
    "0123456789abcdef.jpg.", "0123456789abcdef.jpg ", " 0123456789abcdef.jpg", "0123456789abcdef.jpg\n",
    "0123456789abcdef.jpg::$DATA", "./0123456789abcdef.jpg", ".\\0123456789abcdef.jpg", "\uff10123456789abcdef.jpg",
]


@pytest.mark.parametrize("name", LOOKALIKE_NAMES)
def test_a_name_not_of_the_stores_form_is_never_read_even_when_it_opens_a_real_image_in_the_store(store, name):
    _put(store, NAME, PNG)
    try:
        if not (store / "images" / name).exists():
            _put(store, name, PNG)
    except (OSError, ValueError):
        pass
    assert stored_image_uri(store, NAME) == _uri(PNG), "the store itself works"
    assert stored_image_uri(store, name) is None
    assert prompt_images({"images": [], "image_files": [name]}, store) == []


def test_traversal_absolute_drive_and_unc_names_never_reach_an_image_outside_the_store(store, tmp_path):
    secret = tmp_path / "secret.png"
    secret.write_bytes(PNG)
    (store / NAME).write_bytes(PNG)
    drive_relative = secret.drive + secret.name if secret.drive else "C:secret.png"
    unc = "\\\\localhost\\" + str(secret).replace(":", "$", 1) if secret.drive else "//localhost/" + str(secret)
    names = [
        "../" + NAME, "..\\" + NAME, "images/../../" + NAME, "../../secret.png", "..\\..\\secret.png",
        str(secret), secret.as_posix(), drive_relative, "\\\\?\\" + str(secret), unc, unc.replace("\\", "/"),
        "/etc/passwd", "~/secret.png", "%TEMP%\\secret.png", "file:///" + secret.as_posix(),
    ]
    for name in names:
        assert stored_image_uri(store, name) is None, name
    thumb = _uri(JPEG, "image/jpeg")
    assert prompt_images({"images": [thumb] * len(names), "image_files": names}, store) == [thumb] * MAX_IMAGES


@pytest.mark.parametrize("name", [None, 7, b"0123456789abcdef.jpg", ["0123456789abcdef.jpg"], Path(NAME)])
def test_a_name_that_is_not_a_string_is_refused(store, name):
    _put(store, NAME, PNG)
    assert stored_image_uri(store, name) is None


def test_no_store_means_no_file_is_read(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "images").mkdir()
    _put(tmp_path, NAME, PNG)
    for storage in (None, ""):
        assert stored_image_uri(storage, NAME) is None, "an unset store must not mean the current directory"


# ── Links out of the store ───────────────────────────────────────────────────────────────────────────────────────


def test_a_link_in_the_store_to_an_image_outside_it_is_refused_and_the_thumbnail_is_used(store, tmp_path):
    outside = tmp_path / "private" / "photo.png"
    outside.parent.mkdir()
    outside.write_bytes(_image("PNG", (300, 200), (1, 2, 3)))
    _symlink(store / "images" / NAME, outside)
    assert stored_image_uri(store, NAME) is None
    thumb = _uri(JPEG, "image/jpeg")
    assert prompt_images({"images": [thumb], "image_files": [NAME]}, store) == [thumb]


def test_a_link_to_a_folder_at_an_images_name_is_refused(store, tmp_path):
    folder = tmp_path / "folder"
    folder.mkdir()
    (folder / NAME).write_bytes(PNG)
    try:
        os.symlink(folder, store / "images" / NAME, target_is_directory=True)
    except (OSError, NotImplementedError):
        import subprocess
        if os.name != "nt":
            pytest.skip("cannot create a directory link here")
        made = subprocess.run(["cmd", "/c", "mklink", "/J", str(store / "images" / NAME), str(folder)],
                              capture_output=True)
        if made.returncode:
            pytest.skip("cannot create a junction here")
    assert stored_image_uri(store, NAME) is None


# ── Size and type ────────────────────────────────────────────────────────────────────────────────────────────────


def test_the_size_limit_is_8_mb():
    assert MAX_STORED_IMAGE_BYTES == 8 * 1024 * 1024


def test_a_stored_file_is_read_up_to_exactly_8_mb_and_not_one_byte_more(store):
    exact = JPEG + b"\0" * (MAX_STORED_IMAGE_BYTES - len(JPEG))
    _put(store, NAME, exact)
    uri = stored_image_uri(store, NAME)
    assert uri is not None and uri.startswith("data:image/jpeg;base64,")
    assert _bytes_of(uri) == exact, "never a truncated copy"
    _put(store, NAME, exact + b"\0")
    assert stored_image_uri(store, NAME) is None


def test_a_thumbnail_is_accepted_up_to_exactly_8_mb_and_not_one_byte_more():
    exact = JPEG + b"\0" * (MAX_STORED_IMAGE_BYTES - len(JPEG))
    assert checked_image_uri(_uri(exact, "image/jpeg")) == _uri(exact, "image/jpeg")
    over = exact + b"\0"
    assert len(base64.b64encode(over)) == len(base64.b64encode(exact)), "same base64 length, one byte more"
    assert checked_image_uri(_uri(over, "image/jpeg")) is None
    assert checked_image_uri(_uri(over + b"\0" * 3, "image/jpeg")) is None


FAKES = {
    "empty": b"",
    "html": b"<html><script>alert(1)</script></html>",
    "svg": b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    "zip": b"PK\x03\x04" + b"\0" * 40,
    "pdf": b"%PDF-1.7\n%\xe2\xe3",
    "exe": b"MZ\x90\x00" + b"\0" * 60,
    "wave": b"RIFF\x24\x00\x00\x00WAVEfmt ",
    "png cut short": b"\x89PNG",
    "gif cut short": b"GIF8",
    "jpeg cut short": b"\xff\xd8",
    "bmp": _image("BMP"),
    "tiff": _image("TIFF"),
}


@pytest.mark.parametrize("kind", list(FAKES))
def test_bytes_that_are_not_png_jpeg_gif_or_webp_are_refused_whatever_they_are_called(store, kind):
    data = FAKES[kind]
    _put(store, NAME, data)
    assert stored_image_uri(store, NAME) is None
    for mime in ("image/png", "image/jpeg", "image/svg+xml"):
        assert checked_image_uri(_uri(data, mime)) is None


@pytest.mark.parametrize("data,mime", [
    (_image("PNG"), "image/png"), (_image("JPEG"), "image/jpeg"), (_image("GIF"), "image/gif"),
    (b"GIF87a" + b"\0" * 20, "image/gif"), (_image("WEBP"), "image/webp"),
])
def test_an_accepted_image_is_labelled_by_its_bytes_not_by_its_name_or_its_header(store, data, mime):
    _put(store, NAME, data)
    assert stored_image_uri(store, NAME) == _uri(data, mime)
    assert checked_image_uri(_uri(data, "image/svg+xml")) == _uri(data, mime)
    assert checked_image_uri(_uri(data, "image/x-icon")) == _uri(data, mime)


@pytest.mark.parametrize("uri", [
    "javascript:alert(1)", "https://example.com/a.png", "file:///C:/Windows/win.ini", "vscode-resource:/x.png",
    "data:text/html;base64," + base64.b64encode(PNG).decode(), "data:image/png," + PNG.decode("latin-1"),
    "data:image/png;base64,", "data:image/png;base64",
    "data:image/png;base64," + base64.b64encode(PNG).decode() + '"><img src=x onerror=alert(1)>',
    "data:image/png;base64," + base64.b64encode(PNG).decode()[:8] + "\n" + base64.b64encode(PNG).decode()[8:],
    "data:image/png;base64, " + base64.b64encode(PNG).decode(),
    "DATA:IMAGE/PNG;BASE64," + base64.b64encode(PNG).decode(),
    "data:image/png;base64," + base64.b64encode(PNG).decode().rstrip("=") + "=" * 5,
    None, 42, b"data:image/png;base64,AAAA", ["data:image/png;base64,AAAA"],
])
def test_a_thumbnail_that_is_not_base64_image_data_is_refused(uri):
    assert checked_image_uri(uri) is None


def test_a_thumbnail_too_long_to_be_8_mb_is_refused_before_it_is_decoded(monkeypatch):
    decoded = []
    real = base64.b64decode
    monkeypatch.setattr(base64, "b64decode", lambda data, *a, **k: decoded.append(len(data)) or real(data, *a, **k))
    huge = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode() + "A" * (12 * 1024 * 1024)
    assert checked_image_uri(huge) is None
    assert decoded == [], "a payload over the limit is never decoded"


def test_every_image_handed_back_is_plain_base64_of_one_of_four_types(store):
    candidates = [_uri(PNG, "image/svg+xml;charset=utf-8"), _uri(JPEG, "image/jpeg;name=x\"y"),
                  _uri(_image("GIF"), "image/png"), _uri(_image("WEBP"), "image/webp")]
    for uri in candidates:
        checked = checked_image_uri(uri)
        assert checked is not None and SAFE_URI.fullmatch(checked), uri[:40]
    _put(store, NAME, PNG)
    assert SAFE_URI.fullmatch(stored_image_uri(store, NAME))


# ── A prompt's images ────────────────────────────────────────────────────────────────────────────────────────────


def test_a_prompt_gets_its_full_size_files_then_thumbnails_and_skips_what_is_neither(store):
    fulls = [_image("PNG", (900, 700), (i * 40, 0, 0)) for i in range(5)]
    thumbs = [_uri(_image("JPEG", (90, 70), (0, i * 40, 0)), "image/jpeg") for i in range(5)]
    names = [_hash_name(data) for data in fulls]
    _put(store, names[0], fulls[0])
    _put(store, names[2], b"<svg onload=alert(1)>")
    _put(store, names[4], fulls[4])
    message = {"images": [thumbs[0], thumbs[1], thumbs[2], "javascript:alert(1)", thumbs[4]],
               "image_files": [names[0], names[1], names[2], None, "../" + names[4]]}
    assert prompt_images(message, store) == [_uri(fulls[0]), thumbs[1], thumbs[2], thumbs[4]]


def test_a_prompt_never_gives_back_more_than_five_images(store):
    fulls = [_image("PNG", (20, 20), (i * 30, 0, 0)) for i in range(7)]
    names = [_hash_name(data) for data in fulls]
    for name, data in zip(names, fulls):
        _put(store, name, data)
    thumbs = [_uri(JPEG, "image/jpeg")] * 7
    got = prompt_images({"images": thumbs, "image_files": names}, store)
    assert got == [_uri(data) for data in fulls[:MAX_IMAGES]]
    assert prompt_images({"images": thumbs * 3}, store) == thumbs[:MAX_IMAGES]


def test_a_prompt_with_more_file_names_than_thumbnails_still_gets_each_file(store):
    fulls = [_image("PNG", (20, 20), (0, 0, i * 60)) for i in range(3)]
    names = [_hash_name(data) for data in fulls]
    for name, data in zip(names, fulls):
        _put(store, name, data)
    assert prompt_images({"images": [_uri(JPEG, "image/jpeg")], "image_files": names}, store) == [
        _uri(data) for data in fulls]


@pytest.mark.parametrize("images,image_files", [
    (_uri(PNG), None), ({"0": _uri(PNG)}, NAME), (None, {"0": NAME}), (42, 42), ([None, 3, {}], [3, None, {}]),
])
def test_malformed_image_lists_from_an_old_or_imported_session_give_no_images_and_no_error(store, images, image_files):
    _put(store, NAME, PNG)
    assert prompt_images({"images": images, "image_files": image_files}, store) == []


def test_a_list_of_file_names_still_works_when_the_thumbnails_are_malformed(store):
    _put(store, NAME, PNG)
    assert prompt_images({"images": _uri(JPEG, "image/jpeg"), "image_files": [NAME]}, store) == [_uri(PNG)]


def test_a_prompt_from_before_image_files_were_kept_gets_its_thumbnails(store):
    thumb = _uri(JPEG, "image/jpeg")
    assert prompt_images({"role": "user", "content": "old", "images": [thumb, thumb]}, store) == [thumb, thumb]
    assert prompt_images({"role": "user", "content": "old"}, store) == []


# ── Writing to the store ─────────────────────────────────────────────────────────────────────────────────────────


def _store_files(storage: Path) -> list:
    return sorted(p.name for p in (storage / "images").iterdir())


def test_a_pasted_image_is_kept_whole_under_its_content_hash_with_a_small_thumbnail(store):
    data = _image("PNG", (1200, 900))
    thumb, name = store_prompt_image(_uri(data), store)
    assert name == _hash_name(data)
    assert (store / "images" / name).read_bytes() == data
    with Image.open(io.BytesIO(_bytes_of(thumb))) as small:
        assert max(small.size) <= 360
    assert _store_files(store) == [name], "no temporary file is left behind"


def test_a_write_that_fails_leaves_no_partial_image_and_no_temporary_file(store, monkeypatch):
    data = _image("PNG", (300, 300))
    real_fdopen = os.fdopen

    class HalfWritten:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.handle.close()
            return False

        def write(self, chunk):
            self.handle.write(chunk[: len(chunk) // 2])
            raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "fdopen", lambda fd, mode="r", *a, **k: HalfWritten(real_fdopen(fd, mode, *a, **k)))
    thumb, name = store_prompt_image(_uri(data), store)
    assert name is None
    assert thumb.startswith("data:image/jpeg;base64,"), "the prompt still gets its thumbnail"
    assert _store_files(store) == []


def test_a_rename_that_fails_leaves_no_temporary_file(store, monkeypatch):
    def refuse(src, dst):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(os, "replace", refuse)
    _, name = store_prompt_image(_uri(_image("PNG", (40, 40))), store)
    assert name is None
    assert _store_files(store) == []


def test_an_interrupted_write_cleans_up_and_lets_the_interrupt_through(store, monkeypatch):
    def interrupted(src, dst):
        raise KeyboardInterrupt

    monkeypatch.setattr(os, "replace", interrupted)
    with pytest.raises(KeyboardInterrupt):
        store_prompt_image(_uri(_image("PNG", (40, 40))), store)
    assert _store_files(store) == []


def test_a_truncated_copy_left_by_an_earlier_crash_is_replaced_whole(store):
    data = _image("PNG", (500, 400))
    name = _hash_name(data)
    _put(store, name, data[:100])
    _, got = store_prompt_image(_uri(data), store)
    assert got == name and (store / "images" / name).read_bytes() == data


def test_storing_never_writes_through_a_link_planted_at_the_images_name(store, tmp_path):
    data = _image("PNG", (64, 64))
    name = _hash_name(data)
    victim = tmp_path / "victim.cfg"
    victim.write_bytes(b"precious settings")
    _symlink(store / "images" / name, victim)
    _, got = store_prompt_image(_uri(data), store)
    assert victim.read_bytes() == b"precious settings"
    assert got == name
    assert not (store / "images" / name).is_symlink()
    assert (store / "images" / name).read_bytes() == data


def test_an_image_store_that_is_a_file_gives_no_name_but_still_a_thumbnail(tmp_path):
    storage = tmp_path / "storage"
    storage.mkdir()
    (storage / "images").write_bytes(b"not a folder")
    thumb, name = store_prompt_image(_uri(_image("PNG", (40, 40))), storage)
    assert name is None and thumb.startswith("data:image/jpeg;base64,")
    assert (storage / "images").read_bytes() == b"not a folder"


@pytest.mark.parametrize("uri", ["data:image/png;base64", "https://example.com/a.png", "C:\\shot.png"])
def test_a_paste_that_is_not_a_data_uri_is_not_stored(store, uri):
    thumb, name = store_prompt_image(uri, store)
    assert name is None and thumb == uri
    assert _store_files(store) == []


def test_a_paste_whose_base64_is_garbage_is_not_stored_as_an_empty_image(store):
    uri = "data:image/png;base64,@@@@"
    thumb, name = store_prompt_image(uri, store)
    assert name is None, f"garbage decoded to nothing and was kept as {name}"
    assert _store_files(store) == []


# ── Opening images in the terminal ───────────────────────────────────────────────────────────────────────────────


def _bilevel(width: int, height: int) -> str:
    buf = io.BytesIO()
    Image.new("1", (width, height)).save(buf, format="PNG")
    return _uri(buf.getvalue())


def test_the_terminal_never_decodes_an_image_with_more_pixels_than_it_allows():
    bomb = _bilevel(4097, 4096)
    assert len(bomb) < 50_000, "a small file that decodes to millions of pixels"
    assert image_from_data_uri(bomb) is None
    allowed = image_from_data_uri(_bilevel(4096, 4096))
    assert allowed is not None and allowed.size == (4096, 4096)


@pytest.mark.parametrize("uri", [_uri(FAKES["svg"], "image/svg+xml"), _uri(FAKES["html"]), "javascript:alert(1)",
                                 _uri(b"\x89PNG\r\n\x1a\n" + b"\0" * 30)])
def test_the_terminal_opens_nothing_that_is_not_a_readable_image(uri):
    assert image_from_data_uri(uri) is None


# ── session.image ────────────────────────────────────────────────────────────────────────────────────────────────


def _handler():
    from andromity.server.rpc_handler import JsonRpcHandler
    return JsonRpcHandler(send_notification=lambda note: None)


def _project(tmp_path, name: str = "proj") -> Path:
    root = tmp_path / name
    root.mkdir(exist_ok=True)
    return root


def _session_with_image(root: Path, data: bytes, text: str = "look at this") -> tuple:
    session = Session(project_path=str(root))
    thumb, name = store_prompt_image(_uri(data), session.storage_dir)
    assert name
    session.add_message("user", text, images=[thumb], image_files=[name])
    session.add_message("assistant", "I see it.")
    session.save()
    return session, name


async def _image_rpc(handler, **params) -> dict:
    response = await handler.handle_request(JsonRpcRequest(id=1, method="session.image", params=params))
    assert response.error is None, response.error
    return response.result


@pytest.mark.asyncio
async def test_a_session_gets_the_full_size_copy_of_an_image_its_own_prompt_sent(tmp_path):
    root = _project(tmp_path)
    data = _image("PNG", (800, 600), (9, 99, 199))
    session, name = _session_with_image(root, data)

    live = _handler()
    live._active_sessions[session.id] = session
    result = await _image_rpc(live, session_id=session.id, name=name)
    assert result["success"] is True and _bytes_of(result["uri"]) == data

    saved = await _image_rpc(_handler(), session_id=session.id, name=name, project_path=str(root))
    assert saved["success"] is True and _bytes_of(saved["uri"]) == data, "a saved session keeps its file names"


@pytest.mark.asyncio
async def test_a_session_cannot_read_an_image_only_another_session_sent_though_they_share_a_store(tmp_path):
    root = _project(tmp_path)
    owner, name = _session_with_image(root, _image("PNG", (300, 200), (250, 0, 0)), "my private screenshot")
    other = Session(project_path=str(root))
    other.add_message("user", "hello")
    other.save()
    assert other.storage_dir == owner.storage_dir and (other.storage_dir / "images" / name).is_file()

    live = _handler()
    live._active_sessions[other.id] = other
    live._active_sessions[owner.id] = owner
    result = await _image_rpc(live, session_id=other.id, name=name, project_path=str(root))
    assert result["success"] is False and "uri" not in result
    result = await _image_rpc(_handler(), session_id=other.id, name=name, project_path=str(root))
    assert result["success"] is False and "uri" not in result
    assert (await _image_rpc(live, session_id=owner.id, name=name))["success"] is True


@pytest.mark.asyncio
async def test_naming_another_projects_image_reads_nothing_from_that_projects_store(tmp_path):
    owner, name = _session_with_image(_project(tmp_path, "a"), _image("PNG", (300, 200), (0, 250, 0)))
    elsewhere = Session(project_path=str(_project(tmp_path, "b")))
    elsewhere.add_message("user", "copied prompt", images=[], image_files=[name])
    elsewhere.save()
    assert elsewhere.storage_dir != owner.storage_dir

    handler = _handler()
    handler._active_sessions[elsewhere.id] = elsewhere
    result = await _image_rpc(handler, session_id=elsewhere.id, name=name)
    assert result["success"] is False and "uri" not in result


@pytest.mark.asyncio
async def test_a_name_kept_only_in_the_compacted_history_can_still_be_viewed(tmp_path):
    root = _project(tmp_path)
    data = _image("PNG", (120, 80), (5, 5, 5))
    session, name = _session_with_image(root, data)
    session.compacted_history = list(session.messages)
    session.messages = [{"role": "user", "content": "[Previous context summary (2 messages compacted)]:\nwork"}]
    handler = _handler()
    handler._active_sessions[session.id] = session
    result = await _image_rpc(handler, session_id=session.id, name=name)
    assert result["success"] is True and _bytes_of(result["uri"]) == data


@pytest.mark.asyncio
async def test_a_name_that_only_appears_inside_a_string_is_not_a_reference(tmp_path):
    root = _project(tmp_path)
    session, name = _session_with_image(root, _image("PNG", (30, 30)))
    session.messages = [{"role": "user", "content": f"see {name}", "image_files": f"{name},{name}"},
                        {"role": "user", "content": "x", "images": [name]}]
    handler = _handler()
    handler._active_sessions[session.id] = session
    assert (await _image_rpc(handler, session_id=session.id, name=name))["success"] is False


@pytest.mark.asyncio
async def test_session_image_refuses_a_referenced_name_whose_file_is_not_a_safe_image(tmp_path):
    root = _project(tmp_path)
    session, name = _session_with_image(root, _image("PNG", (30, 30)))
    handler = _handler()
    handler._active_sessions[session.id] = session
    path = session.storage_dir / "images" / name
    for data in (FAKES["svg"], FAKES["html"], JPEG + b"\0" * MAX_STORED_IMAGE_BYTES):
        path.write_bytes(data)
        assert (await _image_rpc(handler, session_id=session.id, name=name))["success"] is False
    path.unlink()
    assert (await _image_rpc(handler, session_id=session.id, name=name))["success"] is False


@pytest.mark.asyncio
async def test_session_image_refuses_a_referenced_name_linked_out_of_the_store(tmp_path):
    root = _project(tmp_path)
    session, name = _session_with_image(root, _image("PNG", (30, 30)))
    outside = tmp_path / "outside.png"
    outside.write_bytes(_image("PNG", (31, 31), (1, 1, 1)))
    path = session.storage_dir / "images" / name
    path.unlink()
    _symlink(path, outside)
    handler = _handler()
    handler._active_sessions[session.id] = session
    assert (await _image_rpc(handler, session_id=session.id, name=name))["success"] is False


@pytest.mark.asyncio
async def test_session_image_refuses_unsafe_names_even_when_the_session_refers_to_them(tmp_path):
    root = _project(tmp_path)
    session, name = _session_with_image(root, _image("PNG", (30, 30)))
    secret = tmp_path / "secret.png"
    secret.write_bytes(PNG)
    unsafe = ["../" + name, "..\\..\\secret.png", str(secret), "\\\\localhost\\" + str(secret).replace(":", "$", 1),
              name.upper(), name + ".", name + "::$DATA"]
    session.messages[0]["image_files"] = [name, *unsafe]
    handler = _handler()
    handler._active_sessions[session.id] = session
    for bad in unsafe:
        result = await _image_rpc(handler, session_id=session.id, name=bad)
        assert result["success"] is False and "uri" not in result, bad


@pytest.mark.asyncio
async def test_session_image_refuses_an_unsafe_name_before_it_opens_the_session_or_the_store(tmp_path, monkeypatch):
    root = _project(tmp_path)
    session, name = _session_with_image(root, _image("PNG", (30, 30)))
    session.messages[0]["image_files"] = [name, "../" + name, name.upper()]
    session.save()
    touched = []
    monkeypatch.setattr(Session, "load_by_id", classmethod(lambda cls, *a, **k: touched.append("load") or session))
    monkeypatch.setattr("andromity.server.rpc_handler.stored_image_uri", lambda *a: touched.append("read"))
    for bad in ("../" + name, name.upper(), name + " "):
        assert (await _image_rpc(_handler(), session_id=session.id, name=bad, project_path=str(root)))["success"] is False
    assert touched == []


@pytest.mark.asyncio
@pytest.mark.parametrize("params", [
    {}, {"name": NAME}, {"session_id": "s"}, {"session_id": None, "name": NAME}, {"session_id": 1, "name": NAME},
    {"session_id": ["s"], "name": NAME}, {"session_id": "../../etc", "name": NAME},
    {"session_id": "no-such-session", "name": NAME}, {"session_id": "s", "name": None},
    {"session_id": "s", "name": [NAME]}, {"session_id": "s", "name": {"$ne": ""}},
])
async def test_session_image_answers_bad_requests_with_unavailable_not_an_error(params):
    result = await _image_rpc(_handler(), **params)
    assert result == {"success": False, "error": "The full-size image is no longer available."}
