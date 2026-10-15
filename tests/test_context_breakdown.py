import pytest

from andromity.core import context_breakdown as cb
from andromity.core.context_breakdown import AUTO_COMPACT_THRESHOLD, context_breakdown
from andromity.core.session import Session


def _session(messages, context_tokens=0):
    s = Session.__new__(Session)
    s.id = "sess-ctx"
    s.messages = messages
    s.project_path = "."
    s.context_tokens = context_tokens
    s.profile = "builder"
    s.provider = "anthropic"
    s.model = "claude-sonnet-4-5"
    return s


def _by_key(result):
    return {c["key"]: c["tokens"] for c in result["categories"]}


def test_categories_follow_what_the_agent_sends(monkeypatch):
    monkeypatch.setattr(cb, "_system_parts", lambda prompt, path: {"system_prompt": len(prompt) // 4, "deferred_tools": 0, "skills": 0})
    session = _session([
        {"role": "system", "content": "s" * 400},
        {"role": "user", "content": "[Previous context summary (12 messages compacted)]:\n" + "x" * 400},
        {"role": "assistant", "content": "Understood."},
        {"role": "user", "content": "u" * 200},
        {"role": "assistant", "content": "a" * 80, "thinking": "t" * 4000,
         "tool_calls": [{"function": {"name": "read_file", "arguments": "{\"path\": \"src/app.py\"}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "r" * 800},
    ])
    result = context_breakdown(session, tools=[{"name": "read_file"}])
    sizes = _by_key(result)
    assert sizes["system_prompt"] == 100
    assert sizes["summary"] > 100
    assert sizes["user"] == 50
    assert sizes["assistant"] == len("Understood.") // 4 + 20
    assert sizes["tool_calls"] > 0
    assert sizes["tool_results"] == 202
    # Thinking is stored for display but never sent, so it takes no context.
    assert result["estimated_tokens"] == sum(sizes.values())
    assert result["estimated_tokens"] < 1000


def test_used_tokens_prefers_the_provider_report(monkeypatch):
    monkeypatch.setattr(cb, "_system_parts", lambda prompt, path: {"system_prompt": 10, "deferred_tools": 0, "skills": 0})
    estimated = context_breakdown(_session([{"role": "system", "content": "s"}], context_tokens=0), tools=[])
    assert estimated["used_source"] == "estimate"
    assert estimated["used_tokens"] == estimated["estimated_tokens"] > 0
    reported = context_breakdown(_session([{"role": "system", "content": "s"}], context_tokens=4321), tools=[])
    assert reported["used_source"] == "provider"
    assert reported["used_tokens"] == 4321


def test_threshold_matches_auto_compaction():
    from andromity.core import agent
    assert agent.AUTO_COMPACT_THRESHOLD == AUTO_COMPACT_THRESHOLD == 0.80
    result = context_breakdown(_session([{"role": "system", "content": "s"}]), tools=[])
    if result["limit"]:
        assert result["compact_at_tokens"] == int(result["limit"] * 0.80)


@pytest.mark.asyncio
async def test_rpc_session_context(monkeypatch, tmp_path):
    from andromity.server.rpc_handler import JsonRpcHandler
    handler = JsonRpcHandler(send_notification=lambda n: None)
    session = _session([{"role": "system", "content": "s" * 40}, {"role": "user", "content": "hi there"}])
    monkeypatch.setattr(handler, "_get_or_load_session", lambda sid, path=None: session)
    result = await handler.rpc_session_context({"session_id": "sess-ctx"})
    assert result["session_id"] == "sess-ctx"
    assert {c["key"] for c in result["categories"]} >= {"system_prompt", "tool_definitions", "user", "tool_results"}


@pytest.mark.asyncio
async def test_manual_compaction_reports_an_estimate_instead_of_a_stale_size(monkeypatch):
    from andromity.core.events import TextDelta
    from andromity.server import rpc_handler as rpc_mod

    notes = []
    handler = rpc_mod.JsonRpcHandler(send_notification=lambda n: notes.append(n))
    session = _session([
        {"role": "system", "content": "s" * 400},
        {"role": "user", "content": "u" * 4000},
        {"role": "assistant", "content": "a" * 4000},
        {"role": "user", "content": "u" * 4000},
        {"role": "assistant", "content": "a" * 4000},
    ], context_tokens=50000)
    session.name = "ctx"
    session.save = lambda: None
    monkeypatch.setattr(handler, "_get_or_load_session", lambda sid, path=None: session)

    class FakeAgent:
        def __init__(self, session, model=None, provider=None):
            self.session = session
            self.profile, self.provider, self.model, self.allowed_tools = "builder", provider, model, [{"name": "read_file"}]

        async def _compact_context(self, force=False):
            self.session.messages = [self.session.messages[0], {"role": "user", "content": "[Previous context summary (4 messages compacted)]:\nshort"}]
            self.session.context_tokens = 0
            yield TextDelta(text="*Context compacted successfully (5 → 2 messages).*")

    monkeypatch.setattr(rpc_mod, "Agent", FakeAgent)
    result = await handler.rpc_session_compact({"session_id": "sess-ctx"})
    assert result["success"] and result["context_estimated"] is True
    assert session.context_tokens == 0, "the provider-reported size is unknown until the next request"
    assert 0 < result["context_tokens"] < 50000
    compacted = [n.params for n in notes if n.method == "session/compacted"]
    assert compacted[-1]["context_tokens"] == result["context_tokens"] and compacted[-1]["context_estimated"] is True
