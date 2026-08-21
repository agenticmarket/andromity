"""Tests for pasted-image support: content-parts building, vision guard,
and session history staying text-only."""
import pytest
from unittest.mock import patch

from textual.app import App, ComposeResult

from andromity.core.agent import Agent
from andromity.core.events import TextDelta, Done
from andromity.core.images import (
    MAX_IMAGES, image_label, image_to_data_uri, extract_image_path, load_image_file,
)
from andromity.tui.footer import ChatInput, InputBar, AttachmentBar


@pytest.fixture
def session(tmp_path):
    from andromity.core.session import Session
    return Session(name="test", project_path=str(tmp_path))


def test_max_images_limit():
    assert MAX_IMAGES == 5


class _FakeImage:
    def __init__(self, size=(1280, 720)):
        self.size = size


def test_image_label_uses_dimensions():
    assert image_label(_FakeImage((640, 480)), 2) == "🖼 Image 2 · 640×480"


@pytest.mark.asyncio
async def test_run_with_images_sends_content_parts_but_keeps_session_text(session):
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)
    seen = {}

    async def mock_stream(messages, tools=None):
        seen["messages"] = messages
        yield TextDelta(text="I see the screenshot")
        yield Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream), \
         patch("litellm.supports_vision", return_value=True):
        events = []
        async for event in agent.run("what is this?", image_uris=["data:image/jpeg;base64,AAAA"]):
            events.append(event)

    # The provider saw the OpenAI-style content parts (text + image_url).
    user_msgs = [m for m in seen["messages"] if m["role"] == "user"]
    content = user_msgs[-1]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "what is this?"}
    assert content[1] == {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}}

    # But the session persisted the plain text message — no base64 bloat.
    session_user = [m for m in session.messages if m["role"] == "user"][-1]
    assert session_user["content"] == "what is this?"

    text_events = [e for e in events if isinstance(e, TextDelta)]
    assert text_events and text_events[-1].text == "I see the screenshot"


@pytest.mark.asyncio
async def test_run_blocks_images_for_non_vision_model(session):
    """Direct, well-known providers still get blocked when they explicitly
    report no vision support (e.g. openai/gpt-3.5-turbo)."""
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)

    def fake_config_get(section, key, default=None):
        if key == "provider":
            return "openai"
        if key == "model":
            return "gpt-3.5-turbo"
        return default

    with patch("andromity.core.agent.stream_completion") as mock_stream, \
         patch("litellm.supports_vision", return_value=False), \
         patch("andromity.core.agent.config.get", side_effect=fake_config_get):
        events = []
        async for event in agent.run("describe this", image_uris=["data:image/jpeg;base64,AAAA"]):
            events.append(event)

    mock_stream.assert_not_called()
    errs = [e for e in events if isinstance(e, TextDelta)]
    assert any("does not support images" in e.text for e in errs)
    # No user message was recorded for the blocked turn.
    assert not [m for m in session.messages if m["role"] == "user"]


@pytest.mark.asyncio
async def test_openrouter_model_not_blocked_on_supports_vision_false(session):
    """Routed providers (OpenRouter) must not be blocked on supports_vision()
    false-negatives — e.g. dots-3-note accepts images but litellm reports no
    vision support for it."""
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)
    seen = {}

    async def mock_stream(messages, tools=None):
        seen["messages"] = messages
        yield TextDelta(text="I see it")
        yield Done(usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})

    def fake_config_get(section, key, default=None):
        if key == "provider":
            return "openrouter"
        if key == "model":
            return "dots-studio/dots-3-note-preview:free"
        return default

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream), \
         patch("litellm.supports_vision", return_value=False), \
         patch("andromity.core.agent.config.get", side_effect=fake_config_get):
        events = []
        async for event in agent.run("what is this?", image_uris=["data:image/jpeg;base64,AAAA"]):
            events.append(event)

    # The stream was called — the image was sent instead of being blocked.
    assert "messages" in seen
    text_events = [e for e in events if isinstance(e, TextDelta)]
    assert text_events and "I see it" in text_events[-1].text


def test_messages_for_api_swaps_last_user_content(session):
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)
    session.add_message("system", "sys")
    session.add_message("user", "plain text")

    assert agent._messages_for_api()[-1]["content"] == "plain text"

    agent._turn_image_parts = [
        {"type": "text", "text": "hi"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,BBBB"}},
    ]
    msgs = agent._messages_for_api()
    assert msgs[-1]["content"] == agent._turn_image_parts
    # Original session is untouched.
    assert session.messages[-1]["content"] == "plain text"


class _InputHost(App):
    """Minimal host for InputBar so its handlers have an App to talk to."""
    def compose(self) -> ComposeResult:
        yield InputBar(id="input-bar")

    def focus_input(self):
        pass


def _chips(host) -> list:
    bar = host.query_one("#attachment-bar", AttachmentBar)
    return list(bar.query(".attach-chip"))


@pytest.mark.asyncio
async def test_paste_event_with_image_path_attaches_chip(tmp_path):
    """Windows Terminal pastes copied files as a quoted path — that paste
    event must attach the image instead of inserting text."""
    pytest.importorskip("PIL")
    from PIL import Image
    from textual.events import Paste

    img_file = tmp_path / "shot.png"
    Image.new("RGB", (40, 30)).save(img_file)

    host = _InputHost()
    async with host.run_test(size=(120, 30)) as pilot:
        await pilot.pause()
        chat_input = host.query_one("#input-field", ChatInput)
        chat_input.post_message(Paste(f'"{img_file}"'))
        await pilot.pause()

        assert len(_chips(host)) == 1
        # The input field did not receive the path as text.
        assert chat_input.text == ""


@pytest.mark.asyncio
async def test_ctrl_v_with_clipboard_image_attaches_chip():
    """The ctrl+v binding attaches an image found on the OS clipboard."""
    pytest.importorskip("PIL")
    from PIL import Image

    host = _InputHost()
    async with host.run_test(size=(120, 30)) as pilot:
        await pilot.pause()
        with patch("andromity.core.images.paste_image_from_clipboard",
                   return_value=Image.new("RGB", (16, 16))):
            host.query_one("#input-field", ChatInput).action_paste_image_or_text()
        await pilot.pause()
        assert len(_chips(host)) == 1


@pytest.mark.asyncio
async def test_paste_chip_removal():
    """Clicking ✕ on a chip removes it."""
    pytest.importorskip("PIL")
    from PIL import Image

    host = _InputHost()
    async with host.run_test(size=(120, 30)) as pilot:
        await pilot.pause()
        with patch("andromity.core.images.paste_image_from_clipboard",
                   return_value=Image.new("RGB", (16, 16))):
            chat_input = host.query_one("#input-field", ChatInput)
            chat_input.action_paste_image_or_text()
        await pilot.pause()
        assert len(_chips(host)) == 1

        bar = host.query_one("#attachment-bar", AttachmentBar)
        button = bar.query_one("Button")
        button.press()
        await pilot.pause()
        assert len(_chips(host)) == 0
        assert not bar.has_class("has-items")


def test_image_to_data_uri_roundtrip():
    pytest.importorskip("PIL")
    from PIL import Image
    img = Image.new("RGB", (64, 48), color=(255, 0, 0))
    uri = image_to_data_uri(img)
    assert uri.startswith("data:image/jpeg;base64,")
    assert len(uri) > len("data:image/jpeg;base64,")


def test_extract_image_path(tmp_path):
    img_file = tmp_path / "shot.png"
    img_file.write_bytes(b"fake")

    # Quoted Windows-style path (what Windows Terminal pastes for a copied file).
    quoted = str(img_file).replace("/", "\\")
    assert extract_image_path(f'"{quoted}"') == str(img_file).replace("/", "\\")

    # Bare path works too.
    assert extract_image_path(str(img_file)) == str(img_file)

    # Prose, non-image extensions, multi-file pastes, and missing files → None.
    assert extract_image_path("look at this chart") is None
    assert extract_image_path('"C:\\a.png" "C:\\b.png"') is None
    assert extract_image_path(str(tmp_path / "notes.txt")) is None
    assert extract_image_path(str(tmp_path / "missing.png")) is None


def test_load_image_file_roundtrip(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image
    src = tmp_path / "test.png"
    Image.new("RGB", (32, 32), color=(10, 200, 30)).save(src)
    img = load_image_file(src)
    assert img.size == (32, 32)


def test_image_to_data_uri_downscales_huge_images():
    pytest.importorskip("PIL")
    from PIL import Image
    img = Image.new("RGB", (4000, 2000), color=(0, 128, 255))
    uri = image_to_data_uri(img)
    assert uri.startswith("data:image/jpeg;base64,")
    # Downscaled to ≤2048 on the longest side: 2000 * (2048/4000) = 1024 tall.
    import base64
    import io
    from PIL import Image as PILImage
    b64 = uri.split(",", 1)[1]
    decoded = PILImage.open(io.BytesIO(base64.b64decode(b64)))
    assert max(decoded.size) <= 2048
