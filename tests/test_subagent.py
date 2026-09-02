import asyncio
import pytest
from unittest.mock import patch, AsyncMock
from andromity.core.subagent import SubAgent, SubAgentResult
from andromity.core.events import (
    Done, SubAgentDone, SubAgentFailed, SubAgentKilled, SubAgentSpawned, TextDelta
)


def test_subagent_initialization():
    agent = SubAgent(
        parent_session_id="parent-12345678",
        role="search",
        task="Find documentation on JWT authentication",
        model_override="claude-3-5-haiku",
        provider_override="anthropic",
    )
    assert agent.role == "search"
    assert "parent-12345678"[:8] in agent.id
    assert agent.model == "claude-3-5-haiku"
    assert agent.provider == "anthropic"
    assert agent.session.parent_session == "parent-12345678"
    assert len(agent.allowed_tools) > 0


def test_subagent_summary_compression():
    agent = SubAgent(
        parent_session_id="parent-abc",
        role="analyst",
        task="Analyze structure",
    )
    agent.max_tokens_budget = 50
    short_text = "This is a short summary."
    assert agent._compress_summary(short_text) == short_text

    long_text = "word " * 500
    compressed = agent._compress_summary(long_text)
    assert len(compressed) < len(long_text)
    assert "Result condensed" in compressed


@pytest.mark.asyncio
async def test_subagent_kill():
    agent = SubAgent(
        parent_session_id="parent-xyz",
        role="coder",
        task="Code something",
    )
    agent.kill(reason="test_kill")
    assert agent.status == "killed"
    assert agent._killed is True


@pytest.mark.asyncio
async def test_subagent_execute_mocked():
    agent = SubAgent(
        parent_session_id="parent-test",
        role="search",
        task="Research OAuth2 flows",
    )

    async def mock_stream(*args, **kwargs):
        yield TextDelta(text="OAuth2 PKCE flow is recommended for SPAs.")
        yield Done(usage={"total_tokens": 120, "prompt_tokens": 80, "completion_tokens": 40})

    with patch("andromity.core.subagent.stream_completion", side_effect=mock_stream):
        res = await agent.execute()
        assert isinstance(res, SubAgentResult)
        assert res.status == "completed"
        assert "OAuth2 PKCE" in res.summary
        assert res.tokens_used.get("total_tokens", 0) > 0


@pytest.mark.asyncio
async def test_subagent_timeout_handling():
    agent = SubAgent(
        parent_session_id="parent-timeout",
        role="reviewer",
        task="Review security",
        timeout=0.05,
    )

    async def slow_stream(*args, **kwargs):
        await asyncio.sleep(0.5)
        yield TextDelta(text="Finished")
        yield Done()

    with patch("andromity.core.subagent.stream_completion", side_effect=slow_stream):
        res = await agent.execute()
        assert res.status == "timeout"
        assert "timed out" in res.summary.lower()


@pytest.mark.asyncio
async def test_subagent_stream_events():
    agent = SubAgent(
        parent_session_id="parent-stream",
        role="analyst",
        task="Analyze trade-offs",
    )

    async def mock_stream(*args, **kwargs):
        yield TextDelta(text="Analysis complete.")
        yield Done()

    with patch("andromity.core.subagent.stream_completion", side_effect=mock_stream):
        events = []
        async for evt in agent.run_stream():
            events.append(evt)

        assert any(isinstance(e, SubAgentSpawned) for e in events)
        assert any(isinstance(e, SubAgentDone) for e in events)


@pytest.mark.asyncio
async def test_subagent_progress_callback():
    progress_events = []

    def on_prog(evt):
        progress_events.append(evt)

    agent = SubAgent(
        parent_session_id="parent-prog",
        role="coder",
        task="Write a test helper",
        progress_callback=on_prog,
        context_snapshot={"framework": "pytest", "python_version": "3.13"},
    )

    async def mock_stream(*args, **kwargs):
        yield TextDelta(text="Helper written.")
        yield Done()

    with patch("andromity.core.subagent.stream_completion", side_effect=mock_stream):
        await agent.execute()

    assert len(progress_events) > 0
    assert any("Working on task" in (e.detail or "") or "Started subagent" in (e.detail or "") for e in progress_events)
    # Verify context snapshot was attached to system prompt
    assert "RELEVANT CONTEXT SNAPSHOT" in agent.session.messages[0]["content"]
    assert "pytest" in agent.session.messages[0]["content"]

