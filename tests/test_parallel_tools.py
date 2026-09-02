"""Tests for parallel tool execution.

When the model emits several tool calls in one message, the agent must run
them concurrently while preserving the original call order in the session
context (models expect tool results in call order).
"""
import asyncio
import time

import pytest
from unittest.mock import patch

from andromity.core.agent import Agent
from andromity.core.session import Session
from andromity.core.events import TextDelta, ToolCallStart, ToolCallDelta, ToolCallEnd, Done, ToolResult


TOOL_CALLS = [
    {"id": "call_a", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "a.txt"}'}},
    {"id": "call_b", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "b.txt"}'}},
]


@pytest.fixture
def session(tmp_path):
    return Session(name="test", project_path=str(tmp_path))


def _make_stream(calls):
    """Return an async-generator stream: first call yields the given tool
    calls, every later call yields a plain text answer."""
    count = 0

    async def mock_stream(messages, tools=None, **kwargs):
        nonlocal count
        count += 1
        if count == 1:
            for call in calls:
                yield ToolCallStart(tool_name=call["function"]["name"], tool_id=call["id"])
                yield ToolCallDelta(tool_id=call["id"], args_json_chunk=call["function"]["arguments"])
                yield ToolCallEnd(tool_id=call["id"])
            yield Done()
        else:
            yield TextDelta(text="Final answer done.")
            yield Done()

    return mock_stream


@pytest.mark.asyncio
async def test_parallel_tools_run_concurrently(session):
    """Two tool calls from one message must overlap in time, not run serially."""
    running = 0
    max_running = 0

    async def fake_execute(name, args, **kwargs):
        nonlocal running, max_running
        running += 1
        max_running = max(max_running, running)
        # b.txt finishes while a.txt is still running
        await asyncio.sleep(0.05 if args["path"] == "b.txt" else 0.15)
        running -= 1
        return f"result for {args['path']}"

    agent = Agent(session, profile="builder", auto_approve=True)
    with patch("andromity.core.agent.stream_completion", side_effect=_make_stream(TOOL_CALLS)):
        with patch("andromity.core.tools.execute_tool_async", side_effect=fake_execute):
            results = []
            async for event in agent.run("read both files"):
                if isinstance(event, ToolResult):
                    results.append((event.tool_id, event.result))

    assert len(results) == 2
    assert max_running >= 2, f"tools never overlapped (max concurrent = {max_running})"


@pytest.mark.asyncio
async def test_parallel_tools_preserve_result_order(session):
    """Session tool messages must be recorded in the original tool-call order,
    even when the fast call finishes first."""
    async def fake_execute(name, args, **kwargs):
        # b.txt finishes first, but must still be recorded AFTER a.txt
        await asyncio.sleep(0.05 if args["path"] == "b.txt" else 0.15)
        return f"result for {args['path']}"

    agent = Agent(session, profile="builder", auto_approve=True)
    with patch("andromity.core.agent.stream_completion", side_effect=_make_stream(TOOL_CALLS)):
        with patch("andromity.core.tools.execute_tool_async", side_effect=fake_execute):
            async for _ in agent.run("read both files"):
                pass

    tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["call_a", "call_b"]
    assert tool_msgs[0]["content"] == "result for a.txt"
    assert tool_msgs[1]["content"] == "result for b.txt"


@pytest.mark.asyncio
async def test_parallel_tools_with_rejection(session):
    """One approved + one rejected call in the same batch: only the approved
    one executes, and both messages stay in original order."""
    executed = []

    async def fake_execute(name, args, **kwargs):
        executed.append(args["path"])
        return f"result for {args['path']}"

    async def approval(name, args):
        return args.get("path") != "b.txt"  # reject b.txt

    agent = Agent(session, profile="builder", auto_approve=False, on_tool_approval=approval)
    with patch("andromity.core.agent.stream_completion", side_effect=_make_stream(TOOL_CALLS)):
        with patch("andromity.core.tools.execute_tool_async", side_effect=fake_execute):
            results = {}
            async for event in agent.run("read both files"):
                if isinstance(event, ToolResult):
                    results[event.tool_id] = event.result

    assert executed == ["a.txt"]
    assert results["call_b"] == "[Rejected by User]"
    assert results["call_a"] == "result for a.txt"
    tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["call_a", "call_b"]
    assert "declined" in tool_msgs[1]["content"].lower()


@pytest.mark.asyncio
async def test_single_tool_still_works(session):
    """A lone tool call behaves exactly as before (no gather edge cases)."""
    async def fake_execute(name, args, **kwargs):
        return f"result for {args['path']}"

    agent = Agent(session, profile="builder", auto_approve=True)
    with patch("andromity.core.agent.stream_completion", side_effect=_make_stream(TOOL_CALLS[:1])):
        with patch("andromity.core.tools.execute_tool_async", side_effect=fake_execute):
            results = []
            async for event in agent.run("read a"):
                if isinstance(event, ToolResult):
                    results.append((event.tool_id, event.result))

    assert results == [("call_a", "result for a.txt")]


@pytest.mark.asyncio
async def test_interleaved_parallel_tool_streaming(session):
    """When a streaming provider interleaves ToolCallStart/Delta/End across multiple tools,
    all tools must be accumulated and executed rather than overwriting each other."""
    executed = []

    async def fake_execute(name, args, **kwargs):
        executed.append(args["path"])
        return f"result for {args['path']}"

    count = 0
    async def mock_interleaved_stream(messages, tools=None, **kwargs):
        nonlocal count
        count += 1
        if count == 1:
            # 1. Start call 1
            yield ToolCallStart(tool_name="read_file", tool_id="call_1")
            # 2. Start call 2 before call 1 finishes (interleaved)
            yield ToolCallStart(tool_name="read_file", tool_id="call_2")
            # 3. Start call 3
            yield ToolCallStart(tool_name="read_file", tool_id="call_3")
            # 4. Deltas arrive interleaved
            yield ToolCallDelta(tool_id="call_1", args_json_chunk='{"path": "file1.txt"}')
            yield ToolCallDelta(tool_id="call_2", args_json_chunk='{"path": "file2.txt"}')
            yield ToolCallDelta(tool_id="call_3", args_json_chunk='{"path": "file3.txt"}')
            # 5. End signals arrive
            yield ToolCallEnd(tool_id="call_1")
            yield ToolCallEnd(tool_id="call_2")
            yield ToolCallEnd(tool_id="call_3")
            yield Done()
        else:
            yield TextDelta(text="All done.")
            yield Done()

    agent = Agent(session, profile="builder", auto_approve=True)
    with patch("andromity.core.agent.stream_completion", side_effect=mock_interleaved_stream):
        with patch("andromity.core.tools.execute_tool_async", side_effect=fake_execute):
            results = []
            async for event in agent.run("read 3 files"):
                if isinstance(event, ToolResult):
                    results.append((event.tool_id, event.result))

    assert len(results) == 3
    assert set(executed) == {"file1.txt", "file2.txt", "file3.txt"}
    assert set(r[0] for r in results) == {"call_1", "call_2", "call_3"}
    tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["call_1", "call_2", "call_3"]

