"""Tests for session."""
import tempfile
import pytest
from andromity.core.session import Session


def test_session_creation():
    s = Session(name="test", project_path="/tmp/test")
    assert s.name == "test" and len(s.id) == 36
    assert s.messages == [] and s.token_total == 0


def test_session_add_message():
    s = Session(name="test", project_path="/tmp/test")
    s.add_message("user", content="hello")
    assert len(s.messages) == 1
    assert s.messages[0]["role"] == "user"


def test_session_persistence():
    with tempfile.TemporaryDirectory() as tmpdir:
        s = Session(name="persist", project_path=tmpdir)
        s.add_message("user", content="hello")
        loaded = Session.load(s.file_path)
        assert loaded.name == "persist" and loaded.messages[0]["content"] == "hello"


def test_session_to_dict():
    s = Session(name="d", project_path="/tmp/test")
    d = s.to_dict()
    assert "id" in d and "messages" in d and "token_total" in d


def test_session_update_usage():
    s = Session(name="u", project_path="/tmp/test")
    # Cost is only computed when the model is known; unknown models stay unpriced.
    s.update_usage({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
                   model="openai/gpt-4o-mini")
    assert s.token_total == 150 and s.cost_usd > 0


def test_session_update_usage_unpriced_without_model():
    s = Session(name="u2", project_path="/tmp/test")
    s.provider = ""
    s.model = ""
    s.update_usage({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150})
    assert s.token_total == 150 and s.cost_usd == 0.0 and s.cost_source == "unpriced"


def test_session_update_usage_unknown_model_is_estimate():
    """A configured model with no pricing data is an estimate (~), not '?'."""
    s = Session(name="u3", project_path="/tmp/test")
    s.provider = "openrouter"
    s.model = "vendor/paid-model-v9"
    s.update_usage({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150})
    assert s.cost_usd == 0.0
    assert s.cost_source == "unknown_estimate"


def test_session_update_usage_free_model():
    s = Session(name="u4", project_path="/tmp/test")
    s.provider = "openrouter"
    s.model = "z-ai/glm-5.2:free"
    s.update_usage({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150})
    assert s.cost_usd == 0.0
    assert s.cost_source == "free"


def test_session_update_usage_accumulates():
    s = Session(name="a", project_path="/tmp/test")
    s.update_usage({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150})
    s.update_usage({"prompt_tokens": 200, "completion_tokens": 100, "total_tokens": 300})
    assert s.token_total == 450


def test_session_tool_message():
    s = Session(name="t", project_path="/tmp/test")
    s.add_message("tool", content="result", name="read_file", tool_call_id="tc_123")
    assert s.messages[0]["name"] == "read_file" and s.messages[0]["tool_call_id"] == "tc_123"


# ─── New feature tests ────────────────────────────────────────────────────────

def test_session_rename():
    with tempfile.TemporaryDirectory() as tmpdir:
        s = Session(name="old-name", project_path=tmpdir)
        s.rename("My New Name")
        assert s.name == "My New Name"
        # Persisted
        loaded = Session.load(s.file_path)
        assert loaded.name == "My New Name"


def test_auto_name_short_message():
    name = Session.auto_name_from_message("Fix the login bug")
    assert name == "Fix the login bug"


def test_auto_name_long_message():
    long_msg = "A" * 100
    name = Session.auto_name_from_message(long_msg)
    assert len(name) <= 55
    assert name.endswith("...")


def test_auto_name_empty_message():
    assert Session.auto_name_from_message("   ") == "New Session"


def test_auto_name_strips_newlines():
    name = Session.auto_name_from_message("line one\nline two")
    assert "\n" not in name
    assert "line one" in name


@pytest.mark.asyncio
async def test_chat_panel_load_history_with_tools_and_thinking():
    from andromity.tui.panels.chat import ChatPanel, ChatMessage, ToolSequence, ThinkingBubble
    from textual.app import App, ComposeResult

    class TestApp(App):
        def compose(self) -> ComposeResult:
            yield ChatPanel(id="chat")

    app = TestApp()
    async with app.run_test() as pilot:
        chat = app.query_one(ChatPanel)
        msgs = [
            {"role": "user", "content": "First prompt"},
            {
                "role": "assistant",
                "thinking": "Pondering the problem...",
                "content": "Looking into the file",
                "tool_calls": [{
                    "id": "tc1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path": "foo.py"}'}
                }]
            },
            {"role": "tool", "content": "def foo(): pass", "name": "read_file", "tool_call_id": "tc1"},
            {"role": "assistant", "content": "Done investigating foo.py"},
            {"role": "user", "content": "Second prompt"},
            {
                "role": "assistant",
                "thinking": "Second thought...",
                "content": "Second answer",
            }
        ]
        await chat.load_history(msgs)
        await pilot.pause()

        chat_messages = list(chat.query(ChatMessage))
        tool_seqs = list(chat.query(ToolSequence))
        assert len(chat_messages) >= 4  # user 1, asst 1, asst done 1, user 2, asst 2
        assert len(tool_seqs) >= 1
        assert chat.query(".assistant-header")


@pytest.mark.asyncio
async def test_chat_panel_load_history_repeatedly_no_duplicate_ids():
    from andromity.tui.panels.chat import ChatPanel
    from textual.app import App, ComposeResult

    class TestApp(App):
        def compose(self) -> ComposeResult:
            yield ChatPanel(id="chat")

    app = TestApp()
    async with app.run_test() as pilot:
        chat = app.query_one(ChatPanel)
        msgs1 = [
            {"role": "user", "content": f"msg {i}"}
            for i in range(40)
        ]
        await chat.load_history(msgs1)
        await pilot.pause()

        # Load another session with thinking and header — must not raise DuplicateIds
        msgs2 = [
            {"role": "user", "content": "hello again"},
            {"role": "assistant", "thinking": "thinking again", "content": "response again"}
        ]
        await chat.load_history(msgs2)
        await pilot.pause()

        assert len(chat.children) >= 2


@pytest.mark.asyncio
async def test_chat_panel_load_history_pagination_and_load_more():
    from andromity.tui.panels.chat import ChatPanel
    from textual.app import App, ComposeResult
    from textual.widgets import Button

    class TestApp(App):
        def compose(self) -> ComposeResult:
            yield ChatPanel(id="chat")

    app = TestApp()
    async with app.run_test() as pilot:
        chat = app.query_one(ChatPanel)
        msgs = [
            {"role": "user", "content": f"Message number {i}"}
            for i in range(45)
        ]
        await chat.load_history(msgs)
        await pilot.pause()

        load_more = chat.query_one("#load-more-chat", Button)
        assert load_more is not None
        # Click load more button (scroll to top so button is in viewport)
        chat.scroll_to(y=0, animate=False)
        await pilot.pause()
        await pilot.click("#load-more-chat")
        await pilot.pause()
        # All messages loaded, button should be removed
        assert not chat.query("#load-more-chat")


@pytest.mark.asyncio
async def test_app_load_session(tmp_path, monkeypatch):
    from andromity.config import config
    from andromity.tui.app import AndromityApp
    from andromity.tui.panels.chat import ChatPanel, ChatMessage

    cfg_dir = tmp_path / "cfg"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "config_dir", cfg_dir)
    monkeypatch.setattr(config, "config_path", cfg_dir / "config.toml")
    config._config_cache = {}
    config._load()
    config.set_trusted(str(tmp_path))
    monkeypatch.chdir(tmp_path)

    # Create a historical session
    saved_session = Session(name="saved-chat-1", project_path=str(tmp_path))
    saved_session.add_message("user", content="Hello in historical session")
    saved_session.add_message("assistant", content="Response in historical session")

    app = AndromityApp()
    async with app.run_test(size=(120, 30)) as pilot:
        for _ in range(5):
            await pilot.pause()

        # Load historical session
        await app._load_session(saved_session)
        for _ in range(5):
            await pilot.pause()

        assert app.session.id == saved_session.id
        assert app.session.name == "saved-chat-1"

        chat = app.query_one(ChatPanel)
        chat_texts = [m._content for m in chat.query(ChatMessage)]
        assert "Hello in historical session" in chat_texts
        assert "Response in historical session" in chat_texts


@pytest.mark.asyncio
async def test_tool_sequence_expands_while_working_and_collapses_on_finish():
    from andromity.tui.panels.chat import ToolSequence, ToolIndicator
    from textual.app import App, ComposeResult
    from textual.widgets import Collapsible

    class TestApp(App):
        def compose(self) -> ComposeResult:
            yield ToolSequence(id="ts")

    app = TestApp()
    async with app.run_test() as pilot:
        ts = app.query_one(ToolSequence)
        await pilot.pause()

        # While working, the collapsible should be expanded (collapsed == False)
        col = ts.query_one("#tools-col", Collapsible)
        assert col.collapsed is False

        # Add a tool and check title shows active tool working
        ts.add_tool(ToolIndicator("read_file", "t1"))
        await pilot.pause()
        assert col.collapsed is False
        assert "read_file" in ts._title()
        assert "working" in ts._title()

        # Mark tool done — sequence is still active in the turn so title must still say "working", NOT "done"
        ts.mark_tool_done("t1")
        await pilot.pause()
        assert "working" in ts._title()
        assert "done" not in ts._title()

        # Finish turn -> auto-collapse and show worked/complete
        ts.finish()
        await pilot.pause()
        assert col.collapsed is True
        assert "worked for" in ts._title() or "complete" in ts._title()
