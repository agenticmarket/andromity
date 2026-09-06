"""Tests for agent loop."""
import pytest
from unittest.mock import patch

from andromity.core.agent import Agent
from andromity.core.session import Session
from andromity.core.events import TextDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done, LLMCallStart, LLMCallEnd, ToolResult


@pytest.fixture
def session(tmp_path):
    return Session(name="test", project_path=str(tmp_path))


@pytest.mark.asyncio
async def test_agent_simple_text(session):
    agent = Agent(session, profile="builder", auto_approve=True)

    async def mock_stream(messages, tools=None, **kwargs):
        yield TextDelta(text="Hi there")
        yield Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        events = []
        async for event in agent.run("hello"):
            events.append(event)

    text_events = [e for e in events if isinstance(e, TextDelta)]
    assert len(text_events) == 1 and text_events[0].text == "Hi there"
    assert len(session.messages) == 3  # system, user, assistant
    assert session.token_total == 15


@pytest.mark.asyncio
async def test_agent_dry_run(session):
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)
    call_count = 0

    async def mock_stream(messages, tools=None, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            # First call: yield tool call
            yield ToolCallStart(tool_name="write_file", tool_id="tc_1")
            yield ToolCallDelta(tool_id="tc_1", args_json_chunk='{"path":"x","content":"y"}')
            yield ToolCallEnd(tool_id="tc_1")
            yield Done()
        else:
            # Second call: text response (agent sees dry_run result and responds)
            yield TextDelta(text="Done.")
            yield Done(usage={"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25})

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        events = []
        async for event in agent.run("write x"):
            events.append(event)

    tool_msgs = [m for m in session.messages if m["role"] == "tool"]
    assert len(tool_msgs) == 1 and "DRY RUN" in tool_msgs[0]["content"]
    # Should have: system, user, assistant(tool_calls), tool, assistant(text)
    assert len(session.messages) == 5


@pytest.mark.asyncio
async def test_agent_profile_filter(session):
    agent = Agent(session, profile="reviewer")
    tool_names = [t["function"]["name"] for t in agent.allowed_tools]
    assert "read_file" in tool_names and "write_file" not in tool_names


@pytest.mark.asyncio
async def test_agent_waterfall_events(session):
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)
    call_count = 0

    async def mock_stream(messages, tools=None, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolCallStart(tool_name="list_dir", tool_id="tc_wf1")
            yield ToolCallDelta(tool_id="tc_wf1", args_json_chunk='{"path":"."}')
            yield ToolCallEnd(tool_id="tc_wf1")
            yield Done()
        else:
            yield TextDelta(text="Done.")
            yield Done(usage={"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150})

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        events = []
        async for event in agent.run("list files"):
            events.append(event)

    llm_starts = [e for e in events if isinstance(e, LLMCallStart)]
    llm_ends = [e for e in events if isinstance(e, LLMCallEnd)]
    tool_results = [e for e in events if isinstance(e, ToolResult)]

    assert len(llm_starts) == 2
    assert len(llm_ends) == 2
    assert len(tool_results) == 1

    # Verify LLMCallStart
    assert llm_starts[0].turn_id.startswith("1_1_")
    assert llm_starts[0].ts > 0

    # Verify LLMCallEnd
    assert llm_ends[1].total_tokens == 150
    assert llm_ends[1].prompt_tokens == 120
    assert llm_ends[1].completion_tokens == 30
    assert llm_ends[1].duration_ms >= 0
    assert llm_ends[1].ttfb_ms >= 0
    assert llm_ends[1].response == "Done."
    assert len(llm_ends[0].tool_calls) == 1
    assert llm_ends[0].tool_calls[0]["function"]["name"] == "list_dir"

    # Verify ToolResult timing and status
    assert tool_results[0].tool_id == "tc_wf1"
    assert tool_results[0].success is True
    assert tool_results[0].duration_ms >= 0
    assert tool_results[0].ts > 0

