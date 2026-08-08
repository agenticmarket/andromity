"""Tests for session."""
import tempfile
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
    s.update_usage({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150})
    assert s.token_total == 150 and s.cost_usd > 0


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


