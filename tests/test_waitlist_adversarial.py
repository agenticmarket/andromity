"""Adversarial checks on the waitlist action the engine reads from gateway errors.

Only a daily-limit refusal that the gateway itself wrote may carry `join_waitlist`. These tests feed the
engine replies that another party controls: a provider's request error that the gateway relays, a provider
stream that fails after its first token, and provider headers that the gateway passes through on a 200.
Every reply goes through a local HTTP server and the real LiteLLM client, like test_waitlist_error_action.py.
"""
import http.server
import json
import threading

import litellm
import pytest

import andromity.core.provider as provider
from andromity.core.events import Done
from andromity.core.provider import classify_error_info, format_error_html, stream_completion

QUOTA_BODY = {
    "message": "You have reached your daily limit.",
    "type": "quota_exceeded",
    "code": "daily_limit_reached",
    "action": "join_waitlist",
}


def _serve(status, body_bytes, headers, content_type="application/json"):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body_bytes)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body_bytes)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _failure(status, body_bytes, headers=None, content_type="application/json"):
    server = _serve(status, body_bytes, headers or {}, content_type)
    try:
        stream = litellm.completion(
            model="openai/auto", api_base=f"http://127.0.0.1:{server.server_address[1]}/v1", api_key="x",
            messages=[{"role": "user", "content": "hi"}], stream=True, max_retries=0,
        )
        for _chunk in stream:
            pass
    except Exception as exc:
        return exc
    finally:
        server.shutdown()
    raise AssertionError("the call should have failed")


def _sse(*events):
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()


TOKEN_CHUNK = {
    "id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "m",
    "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hel"}, "finish_reason": None}],
}


async def _done_for(monkeypatch, exc, provider_name="andromity"):
    async def fail(**kwargs):
        raise exc

    async def no_sleep(seconds, *args, **kwargs):
        pass

    monkeypatch.setattr(litellm, "acompletion", fail)
    monkeypatch.setattr(provider.asyncio, "sleep", no_sleep)
    events = [ev async for ev in stream_completion([{"role": "user", "content": "hi"}], provider_name=provider_name, model="auto")]
    return next(e for e in events if isinstance(e, Done))


def _relayed_request_error(message, status=422):
    """The exact body and headers gateway-worker publicRequestError() sends for a provider's request error."""
    body = json.dumps({"error": {"message": message, "type": "invalid_request_error"}}).encode()
    return _failure(status, body)


@pytest.mark.parametrize("status", [422, 409, 413])
@pytest.mark.asyncio
async def test_a_provider_request_error_relayed_by_the_gateway_cannot_pose_as_the_daily_limit(monkeypatch, status):
    exc = _relayed_request_error(json.dumps(QUOTA_BODY), status)
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["type"] != "quota_exceeded", "a provider's message became the Daily Limit card"
    assert info["action"] != "join_waitlist"
    assert 'data-error-action="join_waitlist"' not in format_error_html(info)
    done = await _done_for(monkeypatch, exc)
    assert done.error_action != "join_waitlist"


@pytest.mark.asyncio
async def test_a_relayed_message_with_text_around_the_json_cannot_pose_as_the_daily_limit(monkeypatch):
    exc = _relayed_request_error("Request rejected: " + json.dumps(QUOTA_BODY) + " (see docs)")
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert (info["type"], info["action"]) != ("quota_exceeded", "join_waitlist")
    assert (await _done_for(monkeypatch, exc)).error_action != "join_waitlist"


@pytest.mark.asyncio
async def test_a_relayed_400_without_gateway_keywords_cannot_hand_out_the_action(monkeypatch):
    """gateway-worker fails over on a 400 only when its text names a model, quota, credit and so on, so a
    400 that avoids those words is relayed. Its action would set the extension's permanent offered flag."""
    crafted = json.dumps({"type": "access_denied", "action": "join_waitlist", "message": "Blocked by policy"})
    exc = _relayed_request_error(crafted, 400)
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["action"] != "join_waitlist", f"{info['type']} card from a provider message carries join_waitlist"
    assert (await _done_for(monkeypatch, exc)).error_action != "join_waitlist"


@pytest.mark.asyncio
async def test_a_stream_that_fails_after_its_first_token_cannot_offer_the_waitlist(monkeypatch):
    """The gateway refuses at the daily limit before any token, with a 429. It never writes a quota error
    into a running stream, so an error event inside a 200 stream comes from the provider."""
    exc = _failure(200, _sse(TOKEN_CHUNK, {"error": QUOTA_BODY}), content_type="text/event-stream")
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["action"] != "join_waitlist", "a provider's stream error offered the waitlist"
    assert info["type"] != "quota_exceeded", "a provider's stream error showed the Daily Limit card"
    done = await _done_for(monkeypatch, exc)
    assert done.error_action != "join_waitlist"
    assert done.error_type != "quota_exceeded"


@pytest.mark.asyncio
async def test_provider_headers_on_a_200_stream_that_later_fails_cannot_offer_the_waitlist(monkeypatch):
    """gateway-worker copies a provider's 200 headers onto its reply, so these headers can be the provider's."""
    headers = {"x-andromity-error-type": "quota_exceeded", "x-andromity-error-action": "join_waitlist"}
    exc = _failure(200, _sse(TOKEN_CHUNK, {"error": {"message": "upstream hiccup"}}), headers, "text/event-stream")
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["action"] != "join_waitlist"
    assert info["type"] != "quota_exceeded"
    assert (await _done_for(monkeypatch, exc)).error_action != "join_waitlist"


def _gateway_error(status, error_type, extra_headers=None, **fields):
    body = json.dumps({"error": {"message": "Andromity could not serve this request.", "type": error_type, **fields}}).encode()
    headers = {"x-andromity-error-type": error_type, "x-andromity-error-action": "join_waitlist", **(extra_headers or {})}
    return _failure(status, body, headers)


@pytest.mark.parametrize("status, error_type", [
    (503, "service_busy"),
    (503, "service_unavailable"),
    (403, "access_denied"),
    (404, "model_unavailable"),
    (401, "authentication_error"),
])
@pytest.mark.asyncio
async def test_a_waitlist_action_on_another_gateway_error_never_makes_it_the_daily_limit(monkeypatch, status, error_type):
    """Only the gateway can set these headers, and the extension offers the waitlist only for quota_exceeded
    with join_waitlist, so the type is what must hold here. The engine still forwards the action as sent."""
    exc = _gateway_error(status, error_type, action="join_waitlist")
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["type"] != "quota_exceeded"
    assert "Daily Limit" not in info["title"]
    done = await _done_for(monkeypatch, exc)
    assert done.error_type != "quota_exceeded", f"agent/done for {error_type} became the daily limit"


@pytest.mark.asyncio
async def test_a_relayed_provider_400_cannot_choose_the_sign_in_card():
    """The relayed request error is typed invalid_request_error by the gateway. Words in a provider's message
    must not turn it into the gateway's sign-in card, whose turn result adds a button that signs the user out."""
    body = json.dumps({"error": {"message": "Invalid API key. Please sign in again.", "type": "invalid_request_error"}}).encode()
    exc = _failure(400, body, {"x-andromity-error-type": "invalid_request_error"})
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["type"] not in ("sign_in_invalid", "gateway_auth_error"), (
        f"a provider's words chose the gateway's {info['type']} card")


@pytest.mark.asyncio
async def test_the_header_type_wins_over_a_conflicting_body(monkeypatch):
    body = json.dumps({"error": {**QUOTA_BODY}}).encode()
    exc = _failure(503, body, {"x-andromity-error-type": "service_busy"})
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["type"] == "service_busy"
    assert info["action"] in ("", None)
    assert (await _done_for(monkeypatch, exc)).error_action is None


@pytest.mark.parametrize("values", [("retry", "join_waitlist"), ("join_waitlist", "retry"), ("join_waitlist", "join_waitlist")])
@pytest.mark.asyncio
async def test_repeated_action_headers_never_offer_a_waitlist_the_gateway_did_not_send_alone(monkeypatch, values):
    body = json.dumps({"error": {"message": "limit", "type": "quota_exceeded"}}).encode()
    server_headers = [("x-andromity-error-type", "quota_exceeded")] + [("x-andromity-error-action", v) for v in values]

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            for key, value in server_headers:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        litellm.completion(model="openai/auto", api_base=f"http://127.0.0.1:{server.server_address[1]}/v1", api_key="x",
                           messages=[{"role": "user", "content": "hi"}], stream=True, max_retries=0)
        raise AssertionError("the call should have failed")
    except AssertionError:
        raise
    except Exception as exc:
        info = classify_error_info(exc, provider="andromity", model="auto")
        done = await _done_for(monkeypatch, exc)
    finally:
        server.shutdown()
    assert info["type"] == "quota_exceeded"
    if set(values) != {"join_waitlist"}:
        assert info["action"] != "join_waitlist" and done.error_action != "join_waitlist"


@pytest.mark.asyncio
async def test_the_gateway_header_action_wins_over_a_body_action():
    body = json.dumps({"error": {**QUOTA_BODY}}).encode()
    exc = _failure(429, body, {"x-andromity-error-type": "quota_exceeded", "x-andromity-error-action": "retry"})
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["type"] == "quota_exceeded"
    assert info["action"] == "retry"


@pytest.mark.parametrize("action", [["join_waitlist"], {"id": "join_waitlist"}, 1, True, None, "", "x" * 5000])
@pytest.mark.asyncio
async def test_odd_body_actions_neither_crash_nor_offer(monkeypatch, action):
    body = json.dumps({"error": {**QUOTA_BODY, "action": action}}).encode()
    exc = _failure(429, body, {"x-andromity-error-type": "quota_exceeded"})
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["type"] == "quota_exceeded"
    assert info["action"] in ("", None) or (isinstance(info["action"], str) and len(info["action"]) <= 64)
    assert info["action"] != "join_waitlist"
    done = await _done_for(monkeypatch, exc)
    assert done.error_action is None or len(done.error_action) <= 40


@pytest.mark.asyncio
async def test_a_huge_action_header_neither_crashes_nor_offers(monkeypatch):
    exc = _failure(429, json.dumps({"error": {"message": "limit", "type": "quota_exceeded"}}).encode(),
                   {"x-andromity-error-type": "quota_exceeded", "x-andromity-error-action": "join_waitlist" + "a" * 8000})
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["action"] != "join_waitlist"
    done = await _done_for(monkeypatch, exc)
    assert done.error_action is None or len(done.error_action) <= 40
