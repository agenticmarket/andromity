"""Tests for core events."""
from andromity.core.events import (
    StreamEvent, TextDelta, ThinkingDelta,
    ToolCallStart, ToolCallDelta, ToolCallEnd, Done
)


def test_text_delta():
    e = TextDelta(text="hello")
    assert e.text == "hello"
    assert isinstance(e, StreamEvent)


def test_thinking_delta():
    e = ThinkingDelta(text="reasoning")
    assert e.text == "reasoning"


def test_tool_call_start():
    e = ToolCallStart(tool_name="read_file", tool_id="tc_123")
    assert e.tool_name == "read_file"
    assert e.tool_id == "tc_123"


def test_tool_call_delta():
    e = ToolCallDelta(tool_id="tc_123", args_json_chunk='{"path":')
    assert e.args_json_chunk == '{"path":'


def test_tool_call_end():
    e = ToolCallEnd(tool_id="tc_123")
    assert e.tool_id == "tc_123"


def test_done_no_usage():
    assert Done().usage is None


def test_done_with_usage():
    usage = {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
    assert Done(usage=usage).usage == usage
