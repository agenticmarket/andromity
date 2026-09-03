import asyncio
import pytest
from unittest.mock import patch
from andromity.core.subagent import SubAgentResult
from andromity.core.subagent_orchestrator import SubAgentOrchestrator
from andromity.core.events import Done, TextDelta


@pytest.mark.asyncio
async def test_orchestrator_spawn_and_await():
    orchestrator = SubAgentOrchestrator(parent_session_id="parent-orch")

    async def mock_stream(*args, **kwargs):
        yield TextDelta(text="Found 3 solutions.")
        yield Done(usage={"total_tokens": 50, "prompt_tokens": 30, "completion_tokens": 20})

    with patch("andromity.core.subagent.stream_completion", side_effect=mock_stream):
        res = await orchestrator.spawn(
            role="search",
            task="Find async patterns",
            wait=True,
        )
        assert isinstance(res, SubAgentResult)
        assert res.status == "completed"
        assert "Found 3 solutions" in res.summary

        agents = orchestrator.list_subagents()
        assert len(agents) == 1
        assert agents[0]["role"] == "search"


@pytest.mark.asyncio
async def test_orchestrator_background_spawn():
    orchestrator = SubAgentOrchestrator(parent_session_id="parent-orch-bg")

    async def mock_stream(*args, **kwargs):
        await asyncio.sleep(0.05)
        yield TextDelta(text="Background done.")
        yield Done()

    with patch("andromity.core.subagent.stream_completion", side_effect=mock_stream):
        res = await orchestrator.spawn(
            role="coder",
            task="Background task",
            wait=False,
        )
        assert res.status == "running"

        all_results = await orchestrator.await_all()
        assert len(all_results) == 1
        assert all_results[0].status == "completed"


@pytest.mark.asyncio
async def test_orchestrator_kill():
    orchestrator = SubAgentOrchestrator(parent_session_id="parent-orch-kill")

    async def slow_stream(*args, **kwargs):
        await asyncio.sleep(2.0)
        yield TextDelta(text="Never reached")
        yield Done()

    with patch("andromity.core.subagent.stream_completion", side_effect=slow_stream):
        res = await orchestrator.spawn(
            role="reviewer",
            task="Long task",
            wait=False,
        )
        agent_id = res.agent_id
        killed = orchestrator.kill(agent_id, reason="test_cancel")
        assert killed is True

        status = orchestrator.get_status(agent_id)
        assert status is not None
        assert status["status"] in ("killed", "running")
