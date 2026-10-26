"""What users see when the Andromity gateway's shared capacity runs out.

These go through a local HTTP server and the real LiteLLM client, because LiteLLM keeps only the
message and the headers of a failed call; a test that hands the classifier raw JSON would pass
while real users saw the wrong card.
"""
import http.server
import json
import threading

import litellm
import pytest

import andromity.core.provider as provider
from andromity.core.events import Done, TextDelta
from andromity.core.provider import (
    classify_and_format_error,
    classify_error_info,
    gateway_capacity_error,
    gateway_model_unavailable,
    gateway_wait_is_long,
    stream_completion,
)

BUSY_MESSAGE = (
    "Andromity's shared models are in very high demand right now, so this request couldn't be served. "
    "Capacity should free up in about 3 hours, choose another model, or add your own API key in Settings "
    "to keep working without shared limits."
)


def _gateway_exception(status, body, headers):
    payload = json.dumps(body).encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        litellm.completion(
            model="openai/auto", api_base=f"http://127.0.0.1:{server.server_address[1]}/v1", api_key="x",
            messages=[{"role": "user", "content": "hi"}], stream=True, max_retries=0,
        )
    except Exception as exc:
        return exc
    finally:
        server.shutdown()
    raise AssertionError("the gateway call should have failed")


def busy_exception(action="switch_model", retry_after=10800):
    error = {"message": BUSY_MESSAGE, "type": "service_busy", "code": "high_demand", "action": action, "retry_after": retry_after}
    return _gateway_exception(503, {"error": error}, {
        "Retry-After": str(retry_after), "x-andromity-error-type": "service_busy", "x-andromity-error-action": action,
    })


@pytest.fixture(scope="module")
def long_wait():
    return busy_exception()


@pytest.fixture(scope="module")
def short_wait():
    return busy_exception(action="retry", retry_after=20)


def test_litellm_drops_the_body_fields_so_headers_carry_them(long_wait):
    assert "service_busy" not in str(long_wait), "if LiteLLM starts keeping the body this test needs revisiting"
    error = gateway_capacity_error(long_wait, "andromity")
    assert error == {"type": "service_busy", "message": BUSY_MESSAGE, "action": "switch_model", "retry_after": 10800}


def test_busy_card_shows_the_gateway_message_and_when_capacity_returns(long_wait):
    info = classify_error_info(long_wait, provider="andromity", model="auto")
    assert info["type"] == "service_busy"
    assert info["badge"] == "HIGH DEMAND"
    assert info["desc_text"] == BUSY_MESSAGE
    assert info["timer_text"].startswith("Expected back around ")
    actions = info["actions_html"]
    assert actions.index('data-action="switch-model-flyout"') < actions.index('data-action="retry-turn"')
    assert 'class="btn-error-retry" data-action="switch-model-flyout"' in actions
    assert 'data-action="open-settings"' in actions

    card = classify_and_format_error(long_wait, provider="andromity", model="auto", output_format="html")
    assert "Technical Details" not in card
    assert "OpenAIException" not in card and "litellm" not in card
    terminal = classify_and_format_error(long_wait, provider="andromity", model="auto", output_format="terminal")
    assert "Details (" not in terminal and "<" not in terminal


def test_short_waits_lead_with_retry(short_wait):
    info = classify_error_info(short_wait, provider="andromity", model="auto")
    assert info["timer_text"] == "Expected back in about a minute"
    assert info["actions_html"].index('data-action="retry-turn"') < info["actions_html"].index('data-action="switch-model-flyout"')
    assert gateway_wait_is_long(short_wait) is False


def test_header_labelled_model_unavailable_is_recognised_through_litellm():
    exc = _gateway_exception(403, {"error": {"message": "Sign in to use this model.", "type": "model_unavailable", "action": "sign_in"}},
                             {"x-andromity-error-type": "model_unavailable", "x-andromity-error-action": "sign_in"})
    assert gateway_model_unavailable(exc) == {"type": "model_unavailable", "message": "Sign in to use this model.", "action": "sign_in"}
    assert classify_error_info(exc, provider="andromity", model="m")["badge"] == "SIGN IN REQUIRED"


def test_other_providers_cannot_borrow_the_gateway_card():
    exc = _gateway_exception(503, {"error": {"message": "Upstream overloaded", "type": "service_unavailable"}},
                             {"x-andromity-error-type": "service_unavailable"})
    assert gateway_capacity_error(exc, "openrouter") is None
    assert gateway_capacity_error(exc, "andromity")["message"] == "Upstream overloaded"


def test_malformed_headers_and_bodies_are_ignored():
    class Odd(Exception):
        litellm_response_headers = {"X-Andromity-Error-Type": "service_busy", "Retry-After": "soon"}
    error = gateway_capacity_error(Odd("OpenAIException - Busy now."), "andromity")
    assert error == {"type": "service_busy", "message": "Busy now."}

    class Broken(Exception):
        litellm_response_headers = 12
    assert gateway_capacity_error(Broken("x"), "andromity") is None
    assert gateway_capacity_error(Exception('{"error": "not an object"}'), "andromity") is None
    assert gateway_capacity_error(Exception('{"error": {"type": "service_busy", "message": "  "}}'), "andromity") is None


async def _run_turn(monkeypatch, exc):
    async def fail(**kwargs):
        raise exc

    waits = []

    async def no_sleep(seconds, *args, **kwargs):
        waits.append(seconds)

    monkeypatch.setattr(litellm, "acompletion", fail)
    monkeypatch.setattr(provider.asyncio, "sleep", no_sleep)
    events = [ev async for ev in stream_completion([{"role": "user", "content": "hi"}], provider_name="andromity", model="auto")]
    text = "".join(getattr(e, "text", "") for e in events if isinstance(e, TextDelta))
    return events, text, waits


@pytest.mark.asyncio
async def test_long_waits_show_the_card_at_once_instead_of_retrying(monkeypatch, long_wait):
    events, text, waits = await _run_turn(monkeypatch, long_wait)
    assert waits == []
    assert 'data-error-type="service_busy"' in text
    assert any(isinstance(e, Done) and e.outcome == "error" for e in events)


@pytest.mark.asyncio
async def test_short_waits_still_retry_with_backoff(monkeypatch, short_wait):
    events, text, waits = await _run_turn(monkeypatch, short_wait)
    assert len(waits) >= 1
    assert 'data-error-type="service_busy"' in text
