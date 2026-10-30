"""Attempts to break the provider error cards: wrong provider or wrong card, leaked secrets,
injected markup, wrong retries and telemetry names.

Errors are produced the way users get them: a local HTTP server answers the real LiteLLM client,
so the exception chain, the response headers and the body are what LiteLLM and openai/httpx raise.
"""
import functools
import http.server
import json
import re
import socket
import threading
import time

import httpx
import litellm
import pytest

import andromity.core.provider as provider
import andromity.core.reasoning as reasoning
from andromity.config import config
from andromity.core.agent import Agent, error_detail_feature_name
from andromity.core.cron import ERROR_HELP, TRANSIENT_ERROR_TYPES, CronJob, classify_exception
from andromity.core.effort import get_model_reasoning_capability
from andromity.core.events import Done, TextDelta
from andromity.core.provider import (
    ERROR_KINDS,
    ERROR_SOURCES,
    classify_error_info,
    format_error_html,
    format_error_terminal,
    stream_completion,
)
from andromity.core.session import Session

OPENROUTER_KEY = "sk-or-v1-" + "0123456789abcdef" * 4
GATEWAY_TOKEN = "andromity_" + "ab12" * 16
SIGN_IN_MESSAGE = "Invalid or expired authentication token. Please sign in again at https://agenticmarket.dev"
DETAIL_NAME = re.compile(r"error_src_(gateway|provider|local|network)_(4xx|429|5xx|timeout|conn|other)")
GATEWAY_ONLY_WORDS = ("gateway", "00:00 UTC", "panel", "free trial", "AgenticMarket", "Andromity Cloud")


def _reply(status, body, headers=None, delay=0.0, timeout=None, api_key="x"):
    """The exception LiteLLM raises when an OpenAI-compatible endpoint answers with this reply."""
    payload = json.dumps(body).encode() if not isinstance(body, bytes) else body

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if delay:
                time.sleep(delay)
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(payload)
            except OSError:
                pass

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    extra = {"timeout": timeout} if timeout else {}
    try:
        litellm.completion(
            model="openai/auto", api_base=f"http://127.0.0.1:{server.server_address[1]}/v1", api_key=api_key,
            messages=[{"role": "user", "content": "hi"}], stream=True, max_retries=0, **extra,
        )
    except Exception as exc:
        return exc
    finally:
        server.shutdown()
        server.server_close()
    raise AssertionError("the call should have failed")


@functools.lru_cache(maxsize=1)
def _refused():
    """The exception LiteLLM raises when nothing listens on the endpoint's port."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    try:
        litellm.completion(model="openai/auto", api_base=f"http://127.0.0.1:{port}/v1", api_key="x",
                           messages=[{"role": "user", "content": "hi"}], stream=True, max_retries=0)
    except Exception as exc:
        return exc
    raise AssertionError("the call should have failed")


def _error(message, **fields):
    return {"error": {"message": message, **fields}}


def _connections(*entries):
    config._config_cache["providers"] = [dict(entry) for entry in entries]


def _card(exc, provider_name, model="m"):
    info = classify_error_info(exc, provider=provider_name, model=model)
    return info, format_error_html(info), format_error_terminal(info)


@pytest.fixture
def offline(monkeypatch):
    """stream_completion without network lookups or backoff sleeps; returns the recorded waits."""
    waits = []

    async def no_sleep(seconds, *args, **kwargs):
        waits.append(seconds)

    monkeypatch.setattr(reasoning, "discover_model_reasoning_capability",
                        lambda p, m: get_model_reasoning_capability(p, m))
    monkeypatch.setattr(provider.asyncio, "sleep", no_sleep)
    return waits


async def _turn(monkeypatch, exc, provider_name, mid_stream=False):
    async def failing_stream():
        raise exc
        yield  # pragma: no cover

    async def call(**kwargs):
        if mid_stream:
            return failing_stream()
        raise exc

    monkeypatch.setattr(litellm, "acompletion", call)
    events = [e async for e in stream_completion([{"role": "user", "content": "hi"}],
                                                   provider_name=provider_name, model="m")]
    text = "".join(e.text for e in events if isinstance(e, TextDelta))
    done = [e for e in events if isinstance(e, Done)]
    assert len(done) == 1, events
    return text, done[0]


# ── The built-in gateway: status and typed fields before keywords ─────────────────────────────


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_every_plain_gateway_5xx_is_cloud_trouble_with_retry_first(status):
    info, html, _ = _card(_reply(status, _error("Something went wrong upstream")), "andromity")
    assert info["type"] == "service_unavailable", info["title"]
    assert info["title"] == "Andromity Cloud is having trouble right now"
    assert re.search(r'class="btn-error-retry" data-action="retry-turn"', html), html
    assert info["detail"] == "gateway_5xx"


def test_gateway_5xx_that_mentions_a_daily_limit_is_still_cloud_trouble_not_the_quota_card():
    exc = _reply(503, _error("Upstream daily limit reached for this model, try another model"))
    info, html, _ = _card(exc, "andromity")
    assert info["type"] == "service_unavailable", (info["type"], info["title"])
    assert "00:00 UTC" not in html and "Daily Limit" not in html


@pytest.mark.parametrize("message", [
    "Upstream provider returned 403 Forbidden",
    "permission denied while reading the routing table",
    "Upstream answered: Unauthorized",
])
def test_gateway_5xx_that_mentions_an_auth_word_is_still_cloud_trouble(message):
    info, _, _ = _card(_reply(502, _error(message)), "andromity")
    assert info["type"] == "service_unavailable", (info["type"], info["title"])


def test_gateway_typed_header_beats_keywords_in_the_message():
    exc = _reply(429, _error("You have reached your daily limit for now"),
                 {"x-andromity-error-type": "service_busy", "x-andromity-error-action": "retry", "Retry-After": "30"})
    info, html, _ = _card(exc, "andromity")
    assert info["type"] == "service_busy"
    assert 'data-error-action="retry"' in html
    assert "00:00 UTC" not in html


def test_gateway_body_type_is_used_when_the_typed_headers_are_missing():
    body = _error("Shared models are busy.", type="service_busy", code="high_demand", action="switch_model",
                  retry_after=7200)
    info, html, _ = _card(_reply(503, body), "andromity")
    assert info["type"] == "service_busy"
    assert 'data-error-action="switch_model"' in html
    assert info["timer_text"].startswith("Expected back around")


@pytest.mark.parametrize("value", [
    'retry" onmouseover="alert(1)',
    "retry><img src=x onerror=alert(1)>",
    "sign in",
    "x" * 65,
])
def test_gateway_action_header_cannot_inject_into_the_card(value):
    exc = _reply(503, _error("Busy."), {"x-andromity-error-type": "service_busy", "x-andromity-error-action": value})
    info, html, _ = _card(exc, "andromity")
    assert "data-error-action" not in html, html
    assert "onmouseover" not in html and "<img" not in html


def test_gateway_invalid_token_offers_sign_in_again_then_use_without_signing_in():
    exc = _reply(401, _error(SIGN_IN_MESSAGE, type="authentication_error", code="invalid_token",
                             login_url="https://agenticmarket.dev/login"))
    info, html, terminal = _card(exc, "andromity")
    assert info["type"] == "sign_in_invalid"
    assert info["title"] == "Your Andromity sign-in isn't valid anymore"
    buttons = re.findall(r'<button class="([^"]+)" data-action="([^"]+)"', html)
    assert buttons == [("btn-error-retry", "open-account-login"), ("btn-error-secondary", "use-without-sign-in")]
    assert "Technical Details" not in html
    assert "<" not in terminal


def test_gateway_invalid_key_blames_andromity_and_never_offers_sign_out():
    exc = _reply(401, _error("Unauthorized", type="authentication_error", code="invalid_key"))
    info, html, _ = _card(exc, "andromity")
    assert info["type"] == "gateway_auth_error"
    assert "use-without-sign-in" not in html and "open-account-login" not in html
    assert 'data-action="retry-turn"' in html


def test_gateway_invalid_key_wins_even_when_its_message_sounds_like_a_sign_in_problem():
    exc = _reply(401, _error("Session expired, please log in", type="authentication_error", code="invalid_key"))
    info, html, _ = _card(exc, "andromity")
    assert info["type"] == "gateway_auth_error"
    assert "use-without-sign-in" not in html


# ── Every other provider: named, own message, never gateway wording ───────────────────────────


@pytest.mark.parametrize("provider_name,expected", [
    ("openrouter", "OpenRouter"), ("google", "Google Gemini"), ("nvidia", "NVIDIA NIM"), ("deepseek", "DeepSeek"),
])
def test_cards_name_the_provider_from_its_preset(provider_name, expected):
    info, _, _ = _card(_reply(429, _error("Too many requests")), provider_name)
    assert info["title"] == f"Rate limit at {expected}"


def test_byok_limit_with_gateway_like_text_and_headers_never_borrows_the_gateway_card():
    text = ("daily_limit_reached: You have reached your free trial limit. Sign in with GitHub at "
            "https://agenticmarket.dev to unlock more. upgrade_url")
    exc = _reply(429, _error(text, type="quota_exceeded"), {"x-andromity-error-type": "quota_exceeded"})
    info, html, terminal = _card(exc, "openrouter")
    assert info["type"] == "rate_limit"
    assert info["title"].endswith("at OpenRouter")
    shown = " ".join([info["title"], info["desc_text"], " ".join(info["actions_tui"])])
    for word in GATEWAY_ONLY_WORDS:
        assert word not in shown, word
    assert "open-account-login" not in html and "use-without-sign-in" not in html
    assert "Quota resets" not in html and "Quota resets" not in terminal


def test_byok_sign_in_wording_is_an_api_key_card_without_sign_out():
    exc = _reply(401, _error(SIGN_IN_MESSAGE, type="authentication_error", code="invalid_token"))
    info, html, _ = _card(exc, "openrouter")
    assert info["type"] == "auth_error"
    assert "use-without-sign-in" not in html and "open-account-login" not in html


@pytest.mark.parametrize("message", [
    "Invalid request: field 'quota' must be an integer",
    "Invalid value for 'daily limit' in metadata",
    "Unsupported parameter: rate_limit_tier",
])
def test_byok_400_that_merely_mentions_a_limit_word_is_not_a_rate_limit(message):
    info, _, _ = _card(_reply(400, _error(message)), "openrouter")
    assert info["type"] not in ("rate_limit", "quota_exceeded"), (info["type"], info["title"])


@pytest.mark.parametrize("provider_name", ["openrouter", "andromity"])
@pytest.mark.parametrize("message", [
    "Invalid request: see request id req_503",
    "Tool returned HTTP 503 from the user's own web server",
])
def test_a_503_inside_the_message_of_a_400_is_not_an_outage(provider_name, message):
    info, _, _ = _card(_reply(400, _error(message)), provider_name)
    assert info["type"] not in ("provider_unavailable", "service_unavailable"), info["title"]


def test_a_503_inside_text_without_any_status_is_not_an_outage():
    info, _, _ = _card(Exception("The model wrote: retry when you see 503 in the log"), "openrouter")
    assert info["type"] != "provider_unavailable"


def test_overloaded_529_is_an_outage_named_after_the_provider():
    exc = _reply(529, {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})
    info, _, _ = _card(exc, "anthropic")
    assert info["type"] == "provider_unavailable"
    assert info["title"] == "Service disruption at Anthropic"
    assert info["detail"] == "provider_5xx"


def test_connection_failures_are_network_cards_not_outages():
    exc = _refused()
    assert getattr(exc, "status_code", None) == 500, "LiteLLM reports refused connections as a synthetic 500"
    info, _, _ = _card(exc, "openrouter")
    assert info["type"] == "network_error"
    assert info["title"] == "Couldn't reach OpenRouter"
    assert info["detail"] == "network_conn"


def test_refused_custom_localhost_server_is_the_local_offline_card_with_its_name():
    _connections({"name": "lab-box", "display_name": "Lab Box (Local)", "type": "openai",
                  "base_url": "http://localhost:1234/v1", "model": "m"})
    info, html, _ = _card(_refused(), "lab-box")
    assert info["type"] == "ollama_offline"
    assert info["title"] == "Lab Box isn't running"
    assert "localhost:1234" in info["desc_text"]
    assert info["detail"] == "local_conn"


def test_a_remote_url_that_only_mentions_localhost_is_not_local():
    _connections({"name": "proxy", "display_name": "Proxy", "type": "openai",
                  "base_url": "https://api.example.com/localhost/127.0.0.1/v1", "model": "m"})
    info, _, _ = _card(_refused(), "proxy")
    assert info["type"] == "network_error"
    assert info["detail"] == "network_conn"


def test_litellm_internal_error_is_not_reported_as_a_provider_outage():
    exc = litellm.InternalServerError(message="Unexpected response shape from provider", llm_provider="openai", model="m")
    assert exc.status_code == 500 and exc.__cause__ is None and exc.__context__ is None
    info, _, _ = _card(exc, "openrouter")
    assert info["type"] != "provider_unavailable", info["title"]
    assert info["detail"] == "provider_other"


def test_litellm_connection_error_without_its_cause_is_still_a_network_card():
    exc = litellm.APIConnectionError(message="OpenAIException - [Errno 111] Connection refused",
                                     llm_provider="openai", model="m")
    info, _, _ = _card(exc, "openrouter")
    assert info["type"] == "network_error", info["title"]
    assert info["detail"] == "network_conn"


def test_tls_mismatch_is_a_network_card_even_when_the_message_names_no_connection_problem():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        try:
            httpx.post(f"https://127.0.0.1:{server.server_address[1]}/v1/messages", timeout=5)
        except httpx.ConnectError as cause:
            try:
                raise litellm.APIConnectionError(message=f"AnthropicException - {cause}", llm_provider="anthropic",
                                                 model="m") from cause
            except litellm.APIConnectionError as wrapped:
                exc = wrapped
    finally:
        server.shutdown()
        server.server_close()
    assert "connect" not in str(exc).lower().replace("apiconnectionerror", "")
    info, _, _ = _card(exc, "anthropic")
    assert info["type"] == "network_error", (info["type"], str(exc))
    assert info["title"] == "Couldn't reach Anthropic"
    assert info["detail"] == "network_conn"


def test_litellm_read_timeout_is_a_timeout_not_an_outage():
    exc = _reply(200, b"{}", delay=2.0, timeout=0.4)
    assert getattr(exc, "status_code", None) == 408, "LiteLLM reports client read timeouts as a synthetic 408"
    info, _, _ = _card(exc, "openrouter")
    assert info["type"] == "timeout"
    assert info["detail"] == "provider_timeout"


# ── Secrets ───────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("secret", [
    OPENROUTER_KEY,
    "sk-ant-api03-" + "Ab9_" * 20,
    "sk-proj-" + "Zq8x" * 12,
    "AIza" + "SyD9" * 8 + "xYz",
    "gsk_" + "Qw3r" * 13,
    "nvapi-" + "Lk7_" * 12,
    GATEWAY_TOKEN,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
])
@pytest.mark.parametrize("status", [400, 401, 429, 500])
def test_provider_messages_never_put_a_key_or_token_on_the_card(secret, status):
    exc = _reply(status, _error(f"Request with Authorization: Bearer {secret} was refused; key={secret}"))
    info, html, terminal = _card(exc, "openrouter")
    for shown in (html, terminal, json.dumps(info)):
        assert secret not in shown
        assert secret[:14] not in shown


def test_the_configured_key_is_never_shown_even_without_a_known_prefix():
    key = "Zx9Kq2Lm8Np4Rt6Vw1Yb3Cd5Fg7Hj0As"
    _connections({"name": "acme", "display_name": "Acme", "type": "openai",
                  "base_url": "https://llm.acme.example/v1", "model": "m", "api_key": key})
    exc = _reply(401, _error(f"Invalid API key provided: {key}"), api_key=key)
    info, html, terminal = _card(exc, "acme")
    assert key not in html and key not in terminal


def test_redaction_happens_before_the_400_character_cut():
    exc = _reply(400, _error("x" * 387 + " " + OPENROUTER_KEY + " " + "y" * 100))
    info, _, _ = _card(exc, "openrouter")
    assert "sk-or-v1-01" not in info["raw_preview"]
    assert len(info["raw_preview"]) == 403 and info["raw_preview"].endswith("...")


def test_a_whitespace_padded_provider_message_does_not_stall_the_event_loop():
    exc = _reply(400, _error("Bad request:" + " " * 40000 + "end"))
    started = time.perf_counter()
    classify_error_info(exc, provider="openrouter", model="m")
    assert time.perf_counter() - started < 1.0, "the card is built on the event loop, so this blocks every session"


def test_cron_failure_text_never_contains_a_key():
    exc = _reply(422, _error(f"Unprocessable entity: header Authorization=Bearer {OPENROUTER_KEY} is malformed"))
    error_type, message = classify_exception(exc, provider="openrouter", model="m")
    assert OPENROUTER_KEY not in message, (error_type, message)


# ── Markup ────────────────────────────────────────────────────────────────────────────────────


PAYLOADS = ('<img src=x onerror=alert(1)>', '"><script>alert(1)</script>',
            '</div></div><button data-action="trigger-compact">x</button>')


@pytest.mark.parametrize("payload", PAYLOADS)
@pytest.mark.parametrize("status,provider_name", [
    (400, "openrouter"), (404, "openrouter"), (402, "openrouter"), (429, "openrouter"), (503, "openrouter"),
    (403, "andromity"), (400, "andromity"), (503, "andromity"),
])
def test_provider_text_is_escaped_on_every_card(payload, status, provider_name):
    exc = _reply(status, _error(f"Failure: {payload}"))
    info, html, _ = _card(exc, provider_name)
    assert "<img" not in html and "<script" not in html
    assert '<button data-action="trigger-compact">' not in html
    assert html.count("<div") == html.count("</div>"), html


@pytest.mark.parametrize("exc_factory", [
    lambda: _reply(401, _error("bad key")), lambda: _reply(429, _error("slow")), lambda: _reply(404, _error("no model")),
    lambda: _reply(503, _error("down")), lambda: _reply(402, _error("credits")), _refused,
    lambda: _reply(400, _error("odd request")), lambda: _reply(200, b"{}", delay=2.0, timeout=0.4),
])
def test_connection_name_and_model_are_escaped(exc_factory):
    _connections({"name": "evil", "display_name": '<img src=x onerror=alert(1)>', "type": "openai",
                  "base_url": "http://localhost:9/v1", "model": "m"},
                 {"name": "evil-remote", "display_name": '<svg onload=alert(1)>', "type": "openai",
                  "base_url": "https://evil.example/v1", "model": "m"})
    exc = exc_factory()
    for name in ("evil", "evil-remote"):
        info = classify_error_info(exc, provider=name, model="<svg onload=alert(2)>")
        html = format_error_html(info)
        assert "<img" not in html and "<svg onload" not in html, html


# ── Retries ───────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("mid_stream", [False, True])
async def test_gateway_quota_marked_by_its_header_is_not_retried(monkeypatch, offline, mid_stream):
    exc = _reply(429, _error("Slow down."), {"x-andromity-error-type": "quota_exceeded"})
    text, done = await _turn(monkeypatch, exc, "andromity", mid_stream=mid_stream)
    assert offline == []
    assert done.error_type == "quota_exceeded"
    assert 'data-error-type="quota_exceeded"' in text


async def test_the_gateway_quota_header_from_another_provider_does_not_stop_retries(monkeypatch, offline):
    exc = _reply(429, _error("Slow down."), {"x-andromity-error-type": "quota_exceeded"})
    text, done = await _turn(monkeypatch, exc, "openrouter")
    assert offline == [5.0, 10.0, 20.0]
    assert done.error_type == "rate_limit"


async def test_gateway_sign_in_invalid_is_shown_at_once_without_retrying(monkeypatch, offline):
    exc = _reply(401, _error(SIGN_IN_MESSAGE, type="authentication_error", code="invalid_token"))
    text, done = await _turn(monkeypatch, exc, "andromity")
    assert offline == []
    assert done.error_type == "sign_in_invalid"
    assert text.count('data-action="use-without-sign-in"') == 1


async def test_gateway_access_denied_is_not_retried(monkeypatch, offline):
    exc = _reply(403, _error("Access from this network is blocked by the gateway security policy.",
                             type="access_denied", code="ip_blocked"))
    text, done = await _turn(monkeypatch, exc, "andromity")
    assert done.error_type == "access_denied"
    assert offline == [], "a blocked request cannot succeed seconds later"


async def test_out_of_credits_is_not_retried(monkeypatch, offline):
    exc = _reply(402, _error("This request requires more credits, or fewer max_tokens."))
    text, done = await _turn(monkeypatch, exc, "openrouter")
    assert done.error_type == "insufficient_credits"
    assert offline == [], "an empty balance cannot refill seconds later"


@pytest.mark.parametrize("exc_factory", [lambda: _reply(503, _error("down")), _refused])
async def test_outages_and_connection_failures_are_retried_with_backoff(monkeypatch, offline, exc_factory):
    text, done = await _turn(monkeypatch, exc_factory(), "openrouter")
    assert offline == [5.0, 10.0, 20.0]
    assert done.error_type in ("provider_unavailable", "network_error")


async def test_a_mid_stream_503_whose_request_id_contains_403_is_still_retried(monkeypatch, offline):
    exc = _reply(503, _error("Service temporarily unavailable, request req_4031a9"))
    text, done = await _turn(monkeypatch, exc, "openrouter", mid_stream=True)
    assert done.error_type == "provider_unavailable"
    assert offline == [5.0, 10.0, 20.0]


# ── Telemetry ─────────────────────────────────────────────────────────────────────────────────


async def _features_for(monkeypatch, tmp_path, exc, provider_name):
    sent = []
    import andromity.core.models as models
    import andromity.telemetry as telemetry
    monkeypatch.setattr(telemetry, "send_feature_used", lambda name, session_id=None: sent.append(name))
    monkeypatch.setattr(telemetry, "send_session_update", lambda *a, **k: None)
    monkeypatch.setattr(telemetry, "send_session_end", lambda *a, **k: None)
    monkeypatch.setattr(models, "get_ollama_num_ctx", lambda *a, **k: 0)

    async def fail(**kwargs):
        raise exc

    monkeypatch.setattr(litellm, "acompletion", fail)
    agent = Agent(Session(name="t", project_path=str(tmp_path)), profile="builder", auto_approve=True,
                  ctx_limit=100000, provider=provider_name, model="m")
    events = [e async for e in agent.run("hello")]
    done = [e for e in events if isinstance(e, Done)]
    return [name for name in sent if name.startswith("error_")], done


@pytest.mark.parametrize("exc_factory,provider_name,expected", [
    (lambda: _reply(429, _error("Too many requests")), "openrouter", ["error_rate_limit", "error_src_provider_429"]),
    (lambda: _reply(401, _error("bad key")), "openrouter", ["error_auth", "error_src_provider_4xx"]),
    (lambda: _reply(503, _error("down")), "openrouter", ["error_provider_unavailable", "error_src_provider_5xx"]),
    (lambda: _reply(429, _error("Slow down."), {"x-andromity-error-type": "quota_exceeded"}), "andromity",
     ["error_quota_exceeded", "error_src_gateway_429"]),
    (lambda: _reply(401, _error(SIGN_IN_MESSAGE)), "andromity", ["error_sign_in_invalid", "error_src_gateway_4xx"]),
    (lambda: _reply(502, _error("bad gateway")), "andromity", ["error_service_unavailable", "error_src_gateway_5xx"]),
    (_refused, "openrouter", ["error_network_error", "error_src_network_conn"]),
    (_refused, "ollama", ["error_ollama_offline", "error_src_local_conn"]),
    (lambda: _reply(200, b"{}", delay=2.0, timeout=0.4), "openrouter", ["error_timeout", "error_src_provider_timeout"]),
])
async def test_each_failed_turn_sends_its_category_and_one_source_event(monkeypatch, offline, tmp_path, exc_factory,
                                                                         provider_name, expected):
    sent, done = await _features_for(monkeypatch, tmp_path, exc_factory(), provider_name)
    assert sent == expected
    assert done[-1].error_detail == expected[1][len("error_src_"):]
    assert sum(1 for name in sent if name.startswith("error_src_")) == 1
    assert all(DETAIL_NAME.fullmatch(name) for name in sent if name.startswith("error_src_"))


async def test_telemetry_names_carry_no_text_url_or_key(monkeypatch, offline, tmp_path):
    exc = _reply(400, _error(f"See https://evil.example/{OPENROUTER_KEY} for details"))
    sent, done = await _features_for(monkeypatch, tmp_path, exc, "openrouter")
    assert len(sent) == 2, sent
    for name in sent:
        assert re.fullmatch(r"error_[a-z0-9_]{1,58}", name), name
        assert "evil" not in name and "sk-or" not in name and "http" not in name


@pytest.mark.parametrize("detail", [
    None, "", "provider", "_429", "provider_", "evil_429", "provider_429_extra", "provider_https://x",
    "provider_sk-or-v1-abc", "gateway_5XX ", "local_conn\nerror_auth",
])
def test_error_detail_feature_name_rejects_anything_outside_the_fixed_sets(detail):
    name = error_detail_feature_name(detail)
    assert name is None or DETAIL_NAME.fullmatch(name), name


def test_every_source_and_kind_pair_has_a_detail_event():
    for source in ERROR_SOURCES:
        for kind in ERROR_KINDS:
            assert error_detail_feature_name(f"{source}_{kind}") == f"error_src_{source}_{kind}"


# ── Cron ──────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("error_type", [
    "network_error", "insufficient_credits", "sign_in_invalid", "gateway_auth_error", "access_denied",
    "service_unavailable",
])
def test_new_card_types_have_their_own_cron_help(error_type):
    assert error_type in ERROR_HELP
    assert ERROR_HELP[error_type][0] != ERROR_HELP["generic"][0]


@pytest.mark.parametrize("error_type,retried", [
    ("network_error", True), ("service_unavailable", True), ("rate_limit", True), ("provider_unavailable", True),
    ("sign_in_invalid", False), ("insufficient_credits", False), ("access_denied", False), ("auth_error", False),
])
def test_cron_retries_only_transient_failures(error_type, retried):
    job = CronJob(id="j", name="j", prompt="p", schedule="every 1h", on_failure="retry")
    job.apply_result("failed", "x", error_type)
    assert (job.retry_count == 1) is retried
    assert (error_type in TRANSIENT_ERROR_TYPES) is retried
