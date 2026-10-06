"""Usage pagination must not truncate aggregates or break older clients."""
import pytest

from andromity.core.usage_tracker import SessionStat, UsageSummary, UsageTracker
from andromity.server.rpc_handler import JsonRpcHandler


@pytest.fixture
def usage_summary(monkeypatch):
    summary = UsageSummary(
        total_tokens=153_000,
        total_cost_usd=1.53,
        total_sessions=153,
        sessions=[SessionStat(str(i), f"Session {i}", "local", "model", 1000,
                              0.01, "2026-10-06", "2026-10-06", "/project")
                  for i in range(153)],
        daily_activity={"2026-10-06": {"tokens": 153_000, "count": 153}},
        by_model={"model": {"tokens": 153_000}},
        by_provider={"local": {"tokens": 153_000}},
    )
    calls = []

    def get_summary(self, time_range="all", project_path=None):
        calls.append((time_range, project_path))
        return summary

    monkeypatch.setattr(UsageTracker, "get_summary", get_summary)
    return summary, calls


@pytest.mark.asyncio
async def test_usage_legacy_default(usage_summary):
    result = await JsonRpcHandler().rpc_usage_get({})
    assert len(result["sessions"]) == 100
    assert result["total_sessions"] == result["sessions_total"] == 153
    assert result["sessions_offset"] == 0


@pytest.mark.asyncio
async def test_usage_page_beyond_old_limit_preserves_aggregates(usage_summary):
    summary, calls = usage_summary
    result = await JsonRpcHandler().rpc_usage_get({
        "offset": 110, "limit": 10, "time_range": "week", "project_path": "/project",
    })
    assert [row["id"] for row in result["sessions"]] == [str(i) for i in range(110, 120)]
    assert result["total_tokens"] == summary.total_tokens
    assert result["total_cost_usd"] == summary.total_cost_usd
    assert result["daily_activity"] == summary.daily_activity
    assert result["by_model"] == summary.by_model
    assert result["by_provider"] == summary.by_provider
    assert result["hourly_activity"]["2026-10-06T00"]["tokens"] == 153_000
    assert result["hourly_activity"]["2026-10-06T00"]["count"] == 153
    assert calls == [("week", "/project")]


@pytest.mark.asyncio
@pytest.mark.parametrize("params,offset,size", [
    ({"offset": -30, "limit": 500}, 0, 100),
    ({"offset": 999, "limit": 10}, 150, 3),
    ({"offset": "bad", "limit": None}, 0, 100),
    ({"offset": 10, "limit": 0}, 10, 1),
])
async def test_usage_page_bounds(usage_summary, params, offset, size):
    result = await JsonRpcHandler().rpc_usage_get(params)
    assert result["sessions_offset"] == offset
    assert len(result["sessions"]) == size


@pytest.mark.asyncio
async def test_usage_empty_page(usage_summary):
    usage_summary[0].sessions.clear()
    result = await JsonRpcHandler().rpc_usage_get({"offset": 30, "limit": 10})
    assert result["sessions"] == []
    assert result["sessions_offset"] == result["sessions_total"] == 0
