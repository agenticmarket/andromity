"""Attempts to break the one Done event that ends a failed provider call.

Every failure path must end with the card type, the coarse code, the provider's own redacted text, the HTTP status
and a clean gateway action, and each reader of the event (the API-key Test, telemetry, the VS Code engine) must use
the right field. The failures come from a local OpenAI-compatible server answering the real LiteLLM client: before
the stream, during it, and a stream that never starts.
"""
import asyncio
import http.server
import json
import re
import socket
import threading

import litellm
import pytest

import andromity.core.provider as provider
import andromity.core.reasoning as reasoning
from andromity.config import config
from andromity.core.connections import test_connection as run_key_test
from andromity.core.cron import classify_exception
from andromity.core.effort import get_model_reasoning_capability
from andromity.core.events import Done, TextDelta
from andromity.core.provider import (
    ERROR_KINDS,
    ERROR_SOURCES,
    classify_error_info,
    format_error_terminal,
    stream_completion,
)

REDACTED = "•••"
OWN_KEY = "Zx9Kq2Lm8Np4Rt6Vw1Yb3Cd5Fg7Hj0As"
LEAKED_KEY = "sk-or-v1-" + "0123456789abcdef" * 4
REMOTE = "https://llm.acme.example/v1"
CANARY = "zebracanary"
DETAIL = re.compile(rf"({'|'.join(ERROR_SOURCES)})_({'|'.join(ERROR_KINDS)})")
INTERNALS = ("APIConnectionError", "OpenAIException", "litellm", "Original exception", "Traceback", "NoneType",
             "__aiter__", "TransferEncodingError", "aiohttp", "httpx", "Exception")
BRACKET_MARKER = re.compile(r"\[[^\]]{0,40}(redact|hidden|secret|removed)[^\]]{0,40}\]", re.IGNORECASE)
NO_RETRY = {"x-should-retry": "false"}
GATEWAY_LIMIT_MESSAGE = "You have used today's free requests. Join the waitlist for more."


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


class _Endpoint:
    """A local OpenAI-compatible server: each request gets the next scripted reply and the last one repeats."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []
        self.release = threading.Event()
        endpoint = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                endpoint.requests.append(json.loads(body or b"{}"))
                reply = endpoint.replies[min(len(endpoint.requests), len(endpoint.replies)) - 1]
                try:
                    reply(self, endpoint)
                except OSError:
                    self.close_connection = True

            def log_message(self, *args):
                pass

        self.server = _Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


def _answer(status, message="", headers=None, body=None):
    """An HTTP error reply with an OpenAI-style error body."""
    payload = json.dumps(body if body is not None else {"error": {"message": message}}).encode()

    def reply(handler, endpoint):
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(payload)))
        handler.send_header("Connection", "close")
        for key, value in (headers or {}).items():
            handler.send_header(key, value)
        handler.end_headers()
        handler.wfile.write(payload)
        handler.close_connection = True
    return reply


def _chunk(text):
    return {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "m",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]}


def _stream(*texts, then=None):
    """A 200 event stream of text chunks, then `then`: an error event, "drop", "stall", or None for a clean end."""
    def reply(handler, endpoint):
        def send(data: bytes):
            handler.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
            handler.wfile.flush()

        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        handler.wfile.flush()
        if then == "stall":
            endpoint.release.wait(30)
            handler.close_connection = True
            return
        for text in texts:
            send(b"data: " + json.dumps(_chunk(text)).encode() + b"\n\n")
        if then == "drop":
            handler.connection.shutdown(socket.SHUT_RDWR)
            handler.close_connection = True
            return
        if isinstance(then, dict):
            send(b"data: " + json.dumps(then).encode() + b"\n\n")
        else:
            send(b"data: [DONE]\n\n")
        handler.wfile.write(b"0\r\n\r\n")
        handler.close_connection = True
    return reply


@pytest.fixture
def serve(monkeypatch):
    """Start an endpoint and save a connection to it; `remote` keeps the saved base URL off this machine."""
    endpoints = []
    raised = []
    real = litellm.acompletion
    monkeypatch.setattr(reasoning, "discover_model_reasoning_capability",
                        lambda p, m: get_model_reasoning_capability(p, m))
    monkeypatch.setattr(provider, "STREAM_BACKOFF_DELAYS", [0.0, 0.0, 0.0])

    def start(*replies, name="acme", key=OWN_KEY, remote=True):
        endpoint = _Endpoint(*replies)
        endpoints.append(endpoint)
        entry = {"name": name, "type": "openai", "model": "m", "base_url": REMOTE if remote else endpoint.url}
        if key:
            entry["api_key"] = key
        config._config_cache["providers"] = [entry]

        async def routed(**kwargs):
            if remote:
                assert kwargs["api_base"].startswith(REMOTE)
                kwargs["api_base"] = endpoint.url
            try:
                return await real(**kwargs)
            except Exception as exc:
                raised.append(exc)
                raise

        monkeypatch.setattr(litellm, "acompletion", routed)
        endpoint.raised = raised
        return endpoint

    yield start
    for endpoint in endpoints:
        endpoint.close()


async def _call(name="acme", **kwargs):
    events = [e async for e in stream_completion([{"role": "user", "content": "hi"}], provider_name=name,
                                                   model="m", **kwargs)]
    done = [e for e in events if isinstance(e, Done)]
    assert len(done) == 1 and events[-1] is done[0], events
    return "".join(e.text for e in events if isinstance(e, TextDelta)), done[0]


def _fields(done: Done) -> dict:
    return {name: getattr(done, name) for name in ("error_type", "error_detail", "error_message", "error_status",
                                                     "error_action")}


def _gateway_limit(action="join_waitlist", extra_headers=None, no_retry=True):
    error = {"message": GATEWAY_LIMIT_MESSAGE, "type": "quota_exceeded", "code": "daily_limit_reached"}
    headers = {"x-ratelimit-limit": "50", "x-ratelimit-remaining": "0", "x-andromity-error-type": "quota_exceeded",
               **(NO_RETRY if no_retry else {}), **(extra_headers or {})}
    if action is not None:
        error["action"] = action
        headers["x-andromity-error-action"] = action
    return _answer(429, body={"error": error}, headers=headers)


# ── Before the stream ───────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name,status,message,expected", [
    ("acme", 401, f"Incorrect API key provided: {LEAKED_KEY}.",
     {"error_type": "auth_error", "error_detail": "provider_4xx", "error_message": f"Incorrect API key provided: {REDACTED}."}),
    ("acme", 404, "The model `m` does not exist or you do not have access to it.",
     {"error_type": "model_not_found", "error_detail": "provider_4xx",
      "error_message": "The model `m` does not exist or you do not have access to it."}),
    ("acme", 402, "Insufficient credits. Add more using https://acme.example/credits",
     {"error_type": "insufficient_credits", "error_detail": "provider_4xx",
      "error_message": "Insufficient credits. Add more using https://acme.example/credits"}),
    ("acme", 429, "Rate limit reached for requests per minute.",
     {"error_type": "rate_limit", "error_detail": "provider_429", "error_message": "Rate limit reached for requests per minute."}),
    ("acme", 503, "The engine is currently overloaded, please try again later",
     {"error_type": "provider_unavailable", "error_detail": "provider_5xx",
      "error_message": "The engine is currently overloaded, please try again later"}),
])
async def test_an_error_before_the_stream_fills_every_field(serve, name, status, message, expected):
    endpoint = serve(_answer(status, message, NO_RETRY), name=name)
    text, done = await _call(name)
    assert done.outcome == "error"
    assert _fields(done) == {**expected, "error_status": status, "error_action": None}
    assert f'data-error-type="{expected["error_type"]}"' in text
    assert len(endpoint.requests) == (4 if status in (429, 503) else 1)


async def test_a_gateway_quota_before_the_stream_carries_its_action_and_its_own_message(serve):
    endpoint = serve(_gateway_limit(), name="andromity", key=None, remote=False)
    text, done = await _call("andromity")
    assert _fields(done) == {"error_type": "quota_exceeded", "error_detail": "gateway_429",
                             "error_message": GATEWAY_LIMIT_MESSAGE, "error_status": 429,
                             "error_action": "join_waitlist"}
    assert 'data-error-action="join_waitlist"' in text
    assert len(endpoint.requests) == 1


@pytest.mark.parametrize("action,expected", [
    ("join_waitlist", "join_waitlist"),
    ("JOIN_WAITLIST", "join_waitlist"),
    ("join waitlist", None),
    ('join_waitlist" onclick="x', None),
    ("join_waitlist<script>", None),
    ("j" * 65, None),
    ("", None),
])
async def test_the_gateway_action_is_dropped_unless_it_is_a_plain_identifier(serve, action, expected):
    serve(_answer(429, body={"error": {"message": "Limit reached.", "type": "quota_exceeded", "action": action}},
                  headers={"x-andromity-error-type": "quota_exceeded", "x-andromity-error-action": action, **NO_RETRY}),
          name="andromity", key=None, remote=False)
    _, done = await _call("andromity")
    assert done.error_type == "quota_exceeded"
    assert done.error_action == expected


async def test_another_provider_sending_the_gateway_headers_gets_no_action(serve):
    serve(_gateway_limit(), name="acme")
    _, done = await _call("acme")
    assert done.error_action is None
    assert done.error_detail == "provider_429" and done.error_status == 429


# ── During the stream ───────────────────────────────────────────────────────────────────────────────────────────


async def test_an_error_event_during_the_stream_fills_every_field(serve):
    event = {"error": {"message": f"Upstream rate limit hit while streaming ({LEAKED_KEY})", "code": 429}}
    endpoint = serve(_stream("Hel", "lo", then=event))
    text, done = await _call()
    assert text.startswith("Hello") and "andromity-error-card" in text
    assert done.outcome == "error" and done.error_type == "rate_limit"
    assert DETAIL.fullmatch(done.error_detail) and done.error_detail.startswith("provider_")
    assert done.error_message and LEAKED_KEY not in done.error_message and REDACTED in done.error_message
    assert done.error_action is None
    assert len(endpoint.requests) == 1, "text was already shown, so the turn is not sent again"


async def test_a_gateway_error_event_during_the_stream_still_carries_the_action(serve):
    event = {"error": {"message": GATEWAY_LIMIT_MESSAGE, "type": "quota_exceeded", "action": "join_waitlist"}}
    serve(_stream("Hel", then=event), name="andromity", key=None, remote=False)
    text, done = await _call("andromity")
    assert done.error_type == "quota_exceeded" and done.error_action == "join_waitlist"
    assert done.error_detail.startswith("gateway_") and DETAIL.fullmatch(done.error_detail)
    assert 'data-error-action="join_waitlist"' in text


@pytest.mark.parametrize("name,event,requests,expected", [
    ("acme", {"error": {"message": "Rate limit reached, slow down", "code": 429}}, 4,
     {"error_type": "rate_limit", "error_action": None}),
    ("andromity", {"error": {"message": GATEWAY_LIMIT_MESSAGE, "type": "quota_exceeded", "action": "join_waitlist"}}, 1,
     {"error_type": "quota_exceeded", "error_action": "join_waitlist"}),
])
async def test_an_error_event_before_any_text_ends_with_one_full_done(serve, name, event, requests, expected):
    endpoint = serve(_stream(then=event), name=name, key=None if name == "andromity" else OWN_KEY,
                     remote=name != "andromity")
    text, done = await _call(name)
    assert text.count("andromity-error-card") == 1
    assert {key: getattr(done, key) for key in expected} == expected
    assert DETAIL.fullmatch(done.error_detail or "") and done.error_message
    assert len(endpoint.requests) == requests


async def test_a_connection_dropped_during_the_stream_fills_every_field(serve):
    endpoint = serve(_stream("Hel", then="drop"))
    text, done = await _call()
    assert text.startswith("Hel") and "andromity-error-card" in text
    assert done.outcome == "error" and done.error_type == "network_error"
    assert done.error_detail == "network_conn"
    assert done.error_action is None
    assert len(endpoint.requests) == 1


@pytest.mark.parametrize("reply", [_stream("Hel", then="drop"), _stream("Hel", then={"error": {"message": "boom"}})],
                         ids=["dropped", "error-event"])
async def test_a_failure_after_a_200_reply_has_no_http_error_status(serve, reply):
    serve(reply)
    _, done = await _call()
    assert done.outcome == "error"
    assert done.error_status is None, f"the provider answered 200, but the turn reports HTTP {done.error_status}"


@pytest.mark.parametrize("reply,words", [
    (_stream("Hel", then="drop"), ""),
    (_stream("Hel", then={"error": {"message": f"Upstream rate limit hit while streaming {CANARY}"}}),
     f"Upstream rate limit hit while streaming {CANARY}"),
    (_answer(422, f"Unprocessable entity: unknown field 'reasoning' {CANARY}", NO_RETRY),
     f"Unprocessable entity: unknown field 'reasoning' {CANARY}"),
], ids=["dropped", "error-event", "422"])
async def test_the_error_message_is_the_providers_words_without_internal_exception_text(serve, reply, words):
    serve(reply)
    _, done = await _call(retry=False)
    leaked = [word for word in INTERNALS if word in (done.error_message or "")]
    assert leaked == [], done.error_message
    if words:
        assert done.error_message == words


async def test_a_422_from_the_provider_is_reported_with_its_status_and_message_and_not_retried(serve):
    endpoint = serve(_answer(422, f"Unprocessable entity: unknown field 'reasoning' {CANARY}", NO_RETRY))
    _, done = await _call()
    assert done.error_status == 422, _fields(done)
    assert CANARY in (done.error_message or ""), _fields(done)
    assert done.error_detail == "provider_4xx"
    assert len(endpoint.requests) <= 2, f"{len(endpoint.requests)} requests for one final 422"


# ── A stream that never starts ──────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name,remote,detail", [("acme", True, "provider_timeout"),
                                                ("andromity", False, "gateway_timeout")])
async def test_a_stalled_stream_fills_every_field_and_has_no_message(serve, name, remote, detail):
    endpoint = serve(_stream(then="stall"), name=name, key=None if name == "andromity" else OWN_KEY, remote=remote)
    text, done = await _call(name, first_token_timeout=0.5, retry=False)
    assert "stalled" in text.lower()
    assert _fields(done) == {"error_type": "timeout", "error_detail": detail, "error_message": None,
                             "error_status": None, "error_action": None}
    assert len(endpoint.requests) == 1


async def test_a_stall_that_is_retried_still_ends_with_one_done(serve):
    endpoint = serve(_stream(then="stall"))
    _, done = await _call(first_token_timeout=0.3)
    assert len(endpoint.requests) == 4
    assert (done.error_type, done.error_detail, done.error_message) == ("timeout", "provider_timeout", None)


# ── The API-key Test ────────────────────────────────────────────────────────────────────────────────────────────


async def test_the_key_test_shows_the_providers_message_not_the_code(serve):
    serve(_answer(400, f"Model m is not enabled for this project ({CANARY}).", NO_RETRY), name="acme")
    result = await run_key_test("acme")
    assert result["success"] is False and result["error_type"] == "generic"
    assert result["detail"] == f"Model m is not enabled for this project ({CANARY})."
    assert result["message"] == f"Connection failed: Model m is not enabled for this project ({CANARY})."
    assert not any(DETAIL.search(str(value)) for value in result.values()), result


@pytest.mark.parametrize("status,error_type", [(401, "auth_error"), (404, "model_not_found"), (429, "rate_limit")])
async def test_the_key_test_keeps_the_providers_message_as_the_detail_of_a_typed_failure(serve, status, error_type):
    serve(_answer(status, f"Provider says {CANARY}; key {OWN_KEY} and {LEAKED_KEY}", NO_RETRY), name="acme")
    result = await run_key_test("acme")
    assert result["error_type"] == error_type
    assert result["detail"].startswith(f"Provider says {CANARY}; key {REDACTED}")
    assert OWN_KEY not in str(result) and LEAKED_KEY not in str(result)
    assert not DETAIL.search(result["detail"])


async def test_the_key_test_of_a_dropped_stream_shows_no_internal_error_text(serve):
    serve(_stream("Hel", then="drop"), name="acme")
    result = await run_key_test("acme")
    assert result["success"] is False
    leaked = [word for word in INTERNALS if word in str(result)]
    assert leaked == [], result


@pytest.mark.parametrize("name,expected", [("openrouter", "rate_limit"), ("andromity", "quota_exceeded")])
async def test_a_refusal_that_is_not_retried_reaches_the_provider_once(serve, name, expected):
    endpoint = serve(_answer(429, "Too many requests", {"Retry-After": "1"}) if name != "andromity"
                     else _gateway_limit(extra_headers={"Retry-After": "1"}, no_retry=False),
                     name=name, key=OWN_KEY if name != "andromity" else None, remote=name != "andromity")
    if name == "andromity":
        _, done = await _call(name)
        error_type = done.error_type
    else:
        error_type = (await run_key_test(name))["error_type"]
    assert error_type == expected
    assert len(endpoint.requests) == 1, f"{len(endpoint.requests)} requests were sent for one refused call"


# ── Telemetry ───────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def telemetry_calls(monkeypatch):
    import andromity.core.models as models
    import andromity.telemetry as telemetry

    calls = []
    for name in ("send_feature_used", "send_session_update", "send_session_end"):
        monkeypatch.setattr(telemetry, name, lambda *a, _name=name, **k: calls.append((_name, a, k)))
    monkeypatch.setattr(models, "get_ollama_num_ctx", lambda *a, **k: 0)
    return calls


@pytest.mark.parametrize("name,reply,remote,expected", [
    ("acme", _answer(401, f"Bad key {CANARY} {OWN_KEY}", NO_RETRY), True, "error_src_provider_4xx"),
    ("acme", _answer(503, f"Overloaded {CANARY}", NO_RETRY), False, "error_src_local_5xx"),
    ("andromity", _gateway_limit(), False, "error_src_gateway_429"),
    ("acme", _stream("Hel", then="drop"), True, "error_src_network_conn"),
    ("acme", _stream("Hel", then={"error": {"message": f"midway {CANARY}", "code": 429}}), True, None),
])
async def test_error_detail_sends_one_source_event_and_never_provider_text(serve, telemetry_calls, tmp_path, name,
                                                                           reply, remote, expected):
    from andromity.core.agent import Agent
    from andromity.core.session import Session

    serve(reply, name=name, key=None if name == "andromity" else OWN_KEY, remote=remote)
    agent = Agent(Session(name="t", project_path=str(tmp_path)), profile="builder", auto_approve=True,
                  ctx_limit=100000, provider=name, model="m")
    done = [e for e in [e async for e in agent.run("hello")] if isinstance(e, Done)][-1]
    sources = [a[0] for n, a, _ in telemetry_calls if n == "send_feature_used" and a[0].startswith("error_src_")]
    assert DETAIL.fullmatch(done.error_detail or ""), done.error_detail
    assert sources == [f"error_src_{done.error_detail}"]
    if expected:
        assert sources == [expected]
    sent = repr(telemetry_calls)
    assert CANARY not in sent and OWN_KEY not in sent and "midway" not in sent


# ── The VS Code engine: the waitlist action reaches agent/done ─────────────────────────────────────────────────


async def _agent_done(tmp_path, name, session_id):
    from andromity.server.protocol import JsonRpcRequest
    from andromity.server.rpc_handler import JsonRpcHandler

    notes = []

    async def on_notify(note):
        notes.append((note.method, note.params))

    handler = JsonRpcHandler(send_notification=on_notify)
    response = await handler.handle_request(JsonRpcRequest(id=1, method="agent.prompt", params={
        "prompt": "hi", "session_id": session_id, "project_path": str(tmp_path), "mode": "safe",
        "provider": name, "model": "auto" if name == "andromity" else "m"}))
    assert response.error is None, response.error
    for _ in range(400):
        if any(method == "agent/done" for method, _ in notes):
            break
        await asyncio.sleep(0.05)
    finished = [params for method, params in notes if method == "agent/done"]
    assert len(finished) == 1, [method for method, _ in notes]
    return finished[0], json.dumps([params for _, params in notes], default=str)


async def test_a_gateway_quota_with_join_waitlist_reaches_agent_done_as_its_action(serve, telemetry_calls, tmp_path):
    endpoint = serve(_gateway_limit(), name="andromity", key=None, remote=False)
    done, everything = await _agent_done(tmp_path, "andromity", "waitlist-e2e")
    assert done["outcome"] == "error"
    assert done["error_type"] == "quota_exceeded"
    assert done["error_action"] == "join_waitlist"
    assert 'data-error-action=\\"join_waitlist\\"' in everything
    assert any(request["messages"][-1]["content"] == "hi" for request in endpoint.requests)


@pytest.mark.parametrize("name,reply", [
    ("andromity", _gateway_limit(action=None)),
    ("andromity", _gateway_limit(action='join_waitlist" data-x="1')),
    ("acme", _gateway_limit()),
])
async def test_agent_done_has_no_action_unless_the_gateway_sent_a_clean_one(serve, telemetry_calls, tmp_path, name,
                                                                            reply):
    serve(reply, name=name, key=None if name == "andromity" else OWN_KEY, remote=False)
    done, _ = await _agent_done(tmp_path, name, f"no-action-{name}")
    assert done["outcome"] == "error"
    assert done["error_action"] is None


# ── One redaction marker ────────────────────────────────────────────────────────────────────────────────────────


async def test_every_user_visible_error_text_uses_the_dot_marker_and_no_brackets(serve):
    message = f"Request refused for Authorization: Bearer {LEAKED_KEY} (key={OWN_KEY})"
    endpoint = serve(_answer(418, message, NO_RETRY), name="acme")
    card, done = await _call()
    exc = endpoint.raised[-1]
    info = classify_error_info(exc, provider="acme", model="m")
    terminal = format_error_terminal(info)
    key_test = await run_key_test("acme")
    cron_type, cron_text = classify_exception(exc, provider="acme", model="m")
    shown = {"card": card, "terminal": terminal, "error_message": done.error_message or "",
             "key test": json.dumps(key_test, ensure_ascii=False), "cron": cron_text}
    for where, text in shown.items():
        assert LEAKED_KEY not in text and OWN_KEY not in text and LEAKED_KEY[:14] not in text, where
        assert not BRACKET_MARKER.search(text), (where, BRACKET_MARKER.search(text).group(0))
    for where in ("card", "terminal", "error_message", "key test"):
        assert REDACTED in shown[where], (where, shown[where][-300:])
    assert cron_type != "generic" or REDACTED in cron_text, cron_text
