from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from andromity.server.rpc_handler import JsonRpcHandler


def immediate(coroutine):
    """Exercise mocked RPC paths without opening an OS event-loop socket."""
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    finally:
        coroutine.close()
    raise AssertionError("Mocked RPC unexpectedly suspended")


def test_retry_strips_both_image_formats_and_preserves_session_payload(monkeypatch):
    handler = JsonRpcHandler()
    monkeypatch.setattr(handler, "_get_or_load_session", lambda *args: SimpleNamespace(id="tab"))
    handler._last_prompt_requests["other"] = {"prompt": "wrong session"}
    original = {"prompt": "Fix this screenshot", "images": ["raw"], "image_uris": ["data:image/png;base64,a"],
                "profile": "builder", "mode": "safe", "input_id": "previous", "provider": "old"}
    handler._last_prompt_requests["tab"] = original
    prompt = AsyncMock(return_value={"status": "started"})
    monkeypatch.setattr(handler, "rpc_agent_prompt", prompt)
    result = immediate(handler.rpc_agent_retry({"session_id": "tab", "strip_images": True, "provider": "new"}))
    payload = prompt.call_args.args[0]
    assert result == {"status": "started"}
    assert payload["prompt"] == original["prompt"]
    assert payload["session_id"] == "tab"
    assert payload["image_uris"] == []
    assert "images" not in payload and "input_id" not in payload
    assert payload["mode"] == "safe" and payload["provider"] == "new"
    assert original["image_uris"] and original["images"]


def test_retry_image_only_and_missing_request_are_actionable(monkeypatch):
    handler = JsonRpcHandler()
    monkeypatch.setattr(handler, "_get_or_load_session", lambda *args: SimpleNamespace(id="tab"))
    prompt = AsyncMock()
    monkeypatch.setattr(handler, "rpc_agent_prompt", prompt)
    with pytest.raises(ValueError, match="no longer available"):
        immediate(handler.rpc_agent_retry({"session_id": "tab", "strip_images": True}))
    handler._last_prompt_requests["tab"] = {"prompt": "", "image_uris": ["image"]}
    with pytest.raises(ValueError, match="Add a text prompt"):
        immediate(handler.rpc_agent_retry({"session_id": "tab", "strip_images": True}))
    prompt.assert_not_called()


def test_retry_refuses_overlapping_turn(monkeypatch):
    handler = JsonRpcHandler()
    monkeypatch.setattr(handler, "_get_or_load_session", lambda *args: SimpleNamespace(id="tab"))
    handler._running_tasks["tab"] = SimpleNamespace(done=lambda: False)
    with pytest.raises(ValueError, match="current turn to finish"):
        immediate(handler.rpc_agent_retry({"session_id": "tab", "strip_images": True}))
