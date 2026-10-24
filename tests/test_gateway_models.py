import io
import json
import urllib.request

import pytest

from andromity.core.models import fetch_live_models_sync
from andromity.core.provider import classify_error_info, format_error_terminal, gateway_model_unavailable


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def _serve_models(monkeypatch, payload):
    seen = []

    def fake_urlopen(req, timeout=None):
        seen.append(req.full_url)
        return _FakeResponse(json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return seen


def test_gateway_models_use_label_description_pricing_and_context(monkeypatch):
    seen = _serve_models(monkeypatch, {
        "object": "list",
        "data": [
            {"id": "auto", "object": "model", "owned_by": "andromity"},
            {
                "id": "vendor-model-1",
                "object": "model",
                "owned_by": "vendor",
                "label": "Vendor Model 1",
                "description": "Available to signed-in users.",
                "pricing": "Included for signed-in users",
                "context_window": 90000,
            },
        ],
    })

    models = fetch_live_models_sync("andromity")

    assert seen == ["https://gateway.agenticmarket.dev/v1/models"]
    assert [m["id"] for m in models] == ["auto", "vendor-model-1"]
    listed = models[1]
    assert listed["name"] == "Vendor Model 1"
    assert listed["desc"] == "Available to signed-in users."
    assert listed["pricing"] == "Included for signed-in users"
    assert listed["context"] == "90K"
    assert listed["context_limit"] == 90000


def test_gateway_models_without_metadata_keep_their_previous_shape(monkeypatch):
    _serve_models(monkeypatch, {"data": [{"id": "gemini-2.5-flash", "owned_by": "google-ai-studio"}]})

    plain = fetch_live_models_sync("andromity")[1]

    assert plain["name"] == "gemini-2.5-flash"
    assert plain["desc"] == "Gateway model (google-ai-studio)"
    assert plain["context"] == "128K"
    assert "context_limit" not in plain
    assert plain["tags"] == ["cloud"]


def _unavailable(action: str, message: str, code: str = "any_reason") -> Exception:
    body = json.dumps({"error": {"message": message, "type": "model_unavailable", "code": code, "action": action}})
    err = Exception(f"litellm.PermissionDeniedError: OpenAIException - {body}")
    err.status_code = 403
    return err


def test_detects_only_model_unavailable_errors():
    assert gateway_model_unavailable(_unavailable("switch_model", "x"))["action"] == "switch_model"
    assert gateway_model_unavailable(Exception('OpenAIException - {"error": {"type": "invalid_request_error"}}')) is None
    assert gateway_model_unavailable(Exception("plain failure")) is None


def test_sign_in_action_offers_sign_in_and_switch_model():
    message = "This model is available to signed-in users. Sign in, or switch to Andromity Auto."
    info = classify_error_info(_unavailable("sign_in", message), provider="andromity")

    assert info["type"] == "model_unavailable"
    assert info["title"] == "Sign in to use this model"
    assert info["desc_text"] == message
    assert 'data-action="open-account-login"' in info["actions_html"]
    assert 'data-action="switch-model-flyout"' in info["actions_html"]


def test_switch_model_action_shows_the_gateway_message_not_auth_advice():
    message = "Today's allowance for this model is used. It resets at 00:00 UTC."
    info = classify_error_info(_unavailable("switch_model", message), provider="andromity")

    assert info["type"] == "model_unavailable"
    assert info["desc_text"] == message
    assert "API key" not in info["desc_text"]
    assert 'data-action="open-account-login"' not in info["actions_html"]
    assert 'data-action="switch-model-flyout"' in info["actions_html"]
    assert "Press Ctrl+L to switch model" in format_error_terminal(info)


@pytest.mark.asyncio
async def test_model_unavailable_is_not_retried(monkeypatch):
    from andromity.core.events import Done, TextDelta
    from andromity.core.provider import stream_completion
    import litellm

    calls = 0

    async def refusing_acompletion(**kwargs):
        nonlocal calls
        calls += 1
        body = json.dumps({"error": {"message": "Capacity for this model is used up today.", "type": "model_unavailable", "action": "switch_model"}})
        raise Exception(f"litellm.APIError: OpenAIException - {body}")

    monkeypatch.setattr(litellm, "acompletion", refusing_acompletion)

    events = [ev async for ev in stream_completion(
        [{"role": "user", "content": "hi"}], provider_name="andromity", model="vendor-model-1"
    )]

    assert calls == 1
    text = "".join(getattr(e, "text", "") for e in events if isinstance(e, TextDelta))
    assert 'data-error-type="model_unavailable"' in text
    assert "Capacity for this model is used up today." in text
    assert isinstance(events[-1], Done) and events[-1].outcome == "error"
