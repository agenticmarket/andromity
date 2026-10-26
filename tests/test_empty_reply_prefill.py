"""An empty model reply must never be sent back as a prefill, and a suggestion ends the turn."""
from unittest.mock import patch

import pytest

from andromity.core.agent import Agent
from andromity.core.events import Done, TextDelta, ToolCallDelta, ToolCallEnd, ToolCallStart
from andromity.core.provider import sanitize_messages_for_api
from andromity.core.session import Session


def test_trailing_empty_assistant_message_is_dropped():
    sent = sanitize_messages_for_api([
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": None},
        {"role": "assistant", "content": "  "},
    ])
    assert sent == [{"role": "user", "content": "hi"}]


def test_empty_assistant_messages_are_dropped_mid_history_but_real_ones_stay():
    sent = sanitize_messages_for_api([
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": ""},
        {"role": "user", "content": "b"},
        {"role": "assistant", "content": "reply"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "x", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "ok"},
    ])
    assert [m["role"] for m in sent] == ["user", "user", "assistant", "assistant", "tool"]
    assert sent[2]["content"] == "reply"


@pytest.fixture
def session(tmp_path):
    return Session(name="t", project_path=str(tmp_path))


def _suggest_call(tool_id="s1"):
    args = '{"title": "Fix the bugs", "prompt": "Fix the three bugs"}'
    return [ToolCallStart(tool_name="suggest_next_step", tool_id=tool_id),
            ToolCallDelta(tool_id=tool_id, args_json_chunk=args), ToolCallEnd(tool_id=tool_id)]


@pytest.mark.asyncio
async def test_a_suggestion_only_step_ends_the_turn_without_another_model_call(session):
    calls = []

    async def stream(messages, **kwargs):
        calls.append(messages)
        yield TextDelta(text="Done reviewing.")
        for event in _suggest_call():
            yield event
        yield Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})

    agent = Agent(session, profile="builder", auto_approve=True, next_step_suggestions=True)
    with patch("andromity.core.agent.stream_completion", side_effect=stream):
        events = [e async for e in agent.run("review")]

    assert len(calls) == 1
    done = [e for e in events if isinstance(e, Done)]
    assert len(done) == 1 and done[0].outcome == "success"
    assert not any(isinstance(e, TextDelta) and "retrying" in e.text for e in events)


@pytest.mark.asyncio
async def test_an_empty_reply_after_a_suggestion_alongside_other_tools_ends_cleanly(session):
    calls = []

    async def stream(messages, **kwargs):
        calls.append(messages)
        if len(calls) == 1:
            yield ToolCallStart(tool_name="list_dir", tool_id="l1")
            yield ToolCallDelta(tool_id="l1", args_json_chunk='{"path": "."}')
            yield ToolCallEnd(tool_id="l1")
            for event in _suggest_call():
                yield event
            yield Done()
        else:
            yield Done()

    agent = Agent(session, profile="builder", auto_approve=True, next_step_suggestions=True)
    with patch("andromity.core.agent.stream_completion", side_effect=stream):
        events = [e async for e in agent.run("look")]

    assert len(calls) == 2, "the model still sees the other tool's result"
    assert calls[1][-1]["role"] == "tool", "the request never ends on an assistant message"
    done = [e for e in events if isinstance(e, Done)]
    assert len(done) == 1 and done[0].outcome == "success"
    assert not any(isinstance(e, TextDelta) and ("retrying" in e.text or "No response" in e.text) for e in events)


@pytest.mark.asyncio
async def test_a_plain_empty_reply_retries_without_sending_a_prefill(session):
    calls = []

    async def stream(messages, **kwargs):
        calls.append(messages)
        if len(calls) == 1:
            yield Done()
        else:
            yield TextDelta(text="Here you go.")
            yield Done()

    agent = Agent(session, profile="builder", auto_approve=True)
    with patch("andromity.core.agent.stream_completion", side_effect=stream):
        events = [e async for e in agent.run("hello")]

    assert len(calls) == 2
    assert calls[1][-1]["role"] == "user"
    assert any(isinstance(e, TextDelta) and e.text == "Here you go." for e in events)
