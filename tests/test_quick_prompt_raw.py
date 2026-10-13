"""agent.quickPrompt raw mode, used by the VS Code inline edit."""

import sys
import types

import pytest

from andromity.server import rpc_handler as rpc
from andromity.server.rpc_handler import JsonRpcHandler


class _Message:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Message(content)


class _Response:
    def __init__(self, content):
        self.choices = [_Choice(content)]


@pytest.fixture
def fake_litellm(monkeypatch):
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        return _Response(fake.reply)

    fake = types.SimpleNamespace(completion=completion, suppress_debug_info=False, reply="", calls=calls)
    monkeypatch.setitem(sys.modules, "litellm", fake)
    monkeypatch.setattr(rpc.config, "get_provider_config", lambda provider: {"type": provider})
    monkeypatch.setattr(rpc.config, "get_api_key", lambda provider: "test-key")
    monkeypatch.setattr("andromity.core.connections.provider_request", lambda provider, model: {"model": model})
    return fake


@pytest.mark.asyncio
async def test_raw_mode_returns_code_untouched_and_allows_longer_output(fake_litellm):
    fake_litellm.reply = "<think>plan</think>```py\nfix: keep this line\nx = 1\n```"
    result = await JsonRpcHandler().rpc_agent_quickPrompt({"prompt": "edit", "raw": True, "max_tokens": 8000, "provider": "openai", "model": "m"})
    assert result["message"] == "```py\nfix: keep this line\nx = 1\n```"
    assert fake_litellm.calls[0]["max_tokens"] == 8000


@pytest.mark.asyncio
async def test_raw_mode_caps_max_tokens(fake_litellm):
    fake_litellm.reply = "ok"
    await JsonRpcHandler().rpc_agent_quickPrompt({"prompt": "edit", "raw": True, "max_tokens": 10**9, "provider": "openai", "model": "m"})
    assert fake_litellm.calls[0]["max_tokens"] == 16000


@pytest.mark.asyncio
async def test_default_mode_still_extracts_commit_messages(fake_litellm):
    fake_litellm.reply = "Here you go:\n<commit_message>fix: handle empty input</commit_message>"
    result = await JsonRpcHandler().rpc_agent_quickPrompt({"prompt": "commit", "provider": "openai", "model": "m"})
    assert result["message"] == "fix: handle empty input"
    assert fake_litellm.calls[0]["max_tokens"] == 2000
