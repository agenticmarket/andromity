"""The daily-limit card carries the gateway's waitlist action for the Andromity provider only.

The errors go through a local HTTP server and the real LiteLLM client, because LiteLLM keeps only the
message and the headers of a failed call.
"""
import http.server
import json
import re
import threading
from html.parser import HTMLParser

import litellm
import pytest

import andromity.core.provider as provider
from andromity.core.events import Done, TextDelta
from andromity.core.provider import (
    classify_and_format_error,
    classify_error_info,
    format_error_html,
    format_error_terminal,
    stream_completion,
)

ANON_MESSAGE = (
    "You have reached your free trial limit. Sign in with GitHub at https://agenticmarket.dev to unlock more, "
    "or enter your BYOK key in Settings."
)
SIGNED_IN_MESSAGE = "You have reached your daily limit. Add your BYOK key in Settings for unlimited requests."
SUBNET_MESSAGE = (
    "Anti-abuse protection: too many anonymous requests from this network today. "
    "Sign in with GitHub or add a BYOK key in Settings to continue."
)
UPGRADE_URL = "https://agenticmarket.dev/login?callback=vscode://agenticmarket.andromity-agent/auth"
CARD_ATTRIBUTES = {"class", "data-error-type", "data-error-action", "data-retryable"}


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


def daily_limit(message=ANON_MESSAGE, action="join_waitlist", code="daily_limit_reached"):
    error = {"message": message, "type": "quota_exceeded", "code": code, "upgrade_url": UPGRADE_URL}
    headers = {
        "x-ratelimit-limit": "50", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600",
        "x-andromity-error-type": "quota_exceeded",
    }
    if action is not None:
        error["action"] = action
        headers["x-andromity-error-action"] = action
    return _gateway_exception(429, {"error": error}, headers)


class _CardTag(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cards = []

    def handle_starttag(self, tag, attrs):
        if tag == "div" and "andromity-error-card" in (dict(attrs).get("class") or ""):
            self.cards.append(attrs)


def card_attributes(html):
    parser = _CardTag()
    parser.feed(html)
    assert len(parser.cards) == 1, html[:300]
    return parser.cards[0]


@pytest.fixture(scope="module")
def anonymous_limit():
    return daily_limit()


def test_the_daily_limit_card_carries_the_waitlist_action(anonymous_limit):
    info = classify_error_info(anonymous_limit, provider="andromity", model="auto")
    assert info["type"] == "quota_exceeded"
    assert info["action"] == "join_waitlist"
    attrs = dict(card_attributes(format_error_html(info)))
    assert attrs["data-error-type"] == "quota_exceeded"
    assert attrs["data-error-action"] == "join_waitlist"
    assert attrs["data-retryable"] == "true"
    html = classify_and_format_error(anonymous_limit, provider="andromity", model="auto", output_format="html")
    assert 'data-error-action="join_waitlist"' in html


def test_signed_in_daily_limit_carries_it_too():
    exc = daily_limit(message=SIGNED_IN_MESSAGE)
    info = classify_error_info(exc, provider="andromity", model="auto")
    assert info["type"] == "quota_exceeded"
    assert info["action"] == "join_waitlist"


@pytest.mark.parametrize("name", ["openrouter", "openai", "groq", "ollama", "custom", ""])
def test_other_providers_never_get_the_action(anonymous_limit, name):
    info = classify_error_info(anonymous_limit, provider=name, model="auto")
    assert info["action"] == ""
    assert "data-error-action" not in format_error_html(info)


def test_a_raw_gateway_body_from_another_provider_cannot_add_the_action():
    body = json.dumps({"error": {"type": "quota_exceeded", "message": "daily limit reached", "action": "join_waitlist"}})
    info = classify_error_info(Exception(body), provider="openrouter", model="m")
    assert info["type"] == "quota_exceeded"
    assert info["action"] == ""
    assert "data-error-action" not in format_error_html(info)


def test_a_raw_gateway_body_is_read_for_the_andromity_provider():
    body = json.dumps({"error": {"type": "quota_exceeded", "message": "daily limit reached", "action": "join_waitlist"}})
    info = classify_error_info(Exception(body), provider="andromity", model="m")
    assert info["action"] == "join_waitlist"


def test_the_subnet_cap_and_a_switched_off_offer_have_no_action():
    for exc in (daily_limit(message=SUBNET_MESSAGE, action=None, code="subnet_cap_reached"), daily_limit(action=None)):
        info = classify_error_info(exc, provider="andromity", model="auto")
        assert info["type"] == "quota_exceeded"
        assert info["action"] == ""
        assert "data-error-action" not in format_error_html(info)


@pytest.mark.parametrize("hostile", [
    'join_waitlist" onmouseover="alert(1)',
    "join_waitlist' autofocus onfocus='alert(1)",
    "join_waitlist><script>alert(1)</script>",
    "join_waitlist data-retryable=false",
    "join_waitlist&quot; onclick=&quot;x",
])
def test_a_hostile_action_header_cannot_break_out_of_the_attribute(hostile):
    exc = daily_limit(action=hostile)
    html = classify_and_format_error(exc, provider="andromity", model="auto", output_format="html")
    attrs = card_attributes(html)
    assert {name for name, _ in attrs} <= CARD_ATTRIBUTES
    action = dict(attrs).get("data-error-action")
    assert action is not None and re.fullmatch(r"[a-z_]{1,40}", action), action
    assert dict(attrs)["data-retryable"] == "true"
    assert "<script" not in html


def test_the_action_is_cut_to_forty_characters_and_dropped_when_nothing_is_left():
    card = format_error_html({**classify_error_info(Exception("daily limit reached"), provider="andromity"), "action": "a" * 200})
    assert dict(card_attributes(card))["data-error-action"] == "a" * 40
    for empty in ("", None, "JOIN-WAITLIST", "123", "<>\"'", "éè"):
        card = format_error_html({**classify_error_info(Exception("daily limit reached"), provider="andromity"), "action": empty})
        assert "data-error-action" not in card, repr(empty)


def test_the_terminal_card_stays_free_of_markup_and_the_action(anonymous_limit):
    info = classify_error_info(anonymous_limit, provider="andromity", model="auto")
    text = format_error_terminal(info)
    assert "<" not in text
    assert "join_waitlist" not in text


@pytest.mark.asyncio
async def test_a_turn_that_hits_the_daily_limit_shows_the_card_with_the_action_at_once(monkeypatch, anonymous_limit):
    async def fail(**kwargs):
        raise anonymous_limit

    waits = []

    async def no_sleep(seconds, *args, **kwargs):
        waits.append(seconds)

    monkeypatch.setattr(litellm, "acompletion", fail)
    monkeypatch.setattr(provider.asyncio, "sleep", no_sleep)
    events = [ev async for ev in stream_completion([{"role": "user", "content": "hi"}], provider_name="andromity", model="auto")]
    text = "".join(getattr(e, "text", "") for e in events if isinstance(e, TextDelta))
    assert waits == []
    assert 'data-error-type="quota_exceeded"' in text
    assert 'data-error-action="join_waitlist"' in text
    assert any(isinstance(e, Done) and e.outcome == "error" and e.error_type == "quota_exceeded" for e in events)
