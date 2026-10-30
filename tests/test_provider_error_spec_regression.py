"""Regression tests for the error-handling spec of stream_completion and the Done that ends a failed turn.

They try to break each rule with replies from a local server answering the real LiteLLM client: 422s in every shape
LiteLLM and FastAPI produce, calls that return no stream, retry hints, replies that read like timeouts, hostile error
text, and the undo image budget.
"""
import asyncio
import base64
import hashlib
import json
import random
import socket
import time
from pathlib import Path

import litellm
import pytest

import andromity.core.provider as provider
import andromity.core.reasoning as reasoning
from andromity.config import config
from andromity.core.effort import get_model_reasoning_capability
from andromity.core.events import Done, TextDelta
from andromity.core.images import MAX_IMAGES, MAX_RESTORED_URI_CHARS, MAX_STORED_IMAGE_BYTES, prompt_images
from andromity.core.provider import (
    _error_events,
    classify_error_info,
    extract_clean_error_message,
    short_error_detail,
    stream_completion,
)
from andromity.core.session import Session
from tests.test_provider_error_done_fields import (
    CANARY,
    INTERNALS,
    OWN_KEY,
    REMOTE,
    _answer,
    _Endpoint,
    _gateway_limit,
    _stream,
)

TOKEN = "Q7wErTy8uIoP9aSdFg0hJkLzXcVbNm12"
PROMPT_ECHO = "Please refactor the payroll module and email the salaries to my manager"
FIXED_BACKOFF = [5.0, 10.0, 20.0]
SMALL_THUMB_CHARS = 256 * 1024


class _Clock:
    """Stands in for asyncio inside provider.py: records each wait and does not sleep."""

    def __init__(self):
        self.waits = []

    def __getattr__(self, name):
        return getattr(asyncio, name)

    async def sleep(self, seconds, *args, **kwargs):
        self.waits.append(seconds)
        await asyncio.sleep(0)


@pytest.fixture
def clock(monkeypatch):
    recorder = _Clock()
    monkeypatch.setattr(provider, "asyncio", recorder)
    monkeypatch.setattr(provider, "STREAM_BACKOFF_DELAYS", list(FIXED_BACKOFF))
    return recorder


@pytest.fixture
def connect(monkeypatch):
    """Save a connection whose base URL is off this machine and route LiteLLM's real calls to a local endpoint."""
    endpoints = []
    real = litellm.acompletion
    monkeypatch.setattr(reasoning, "discover_model_reasoning_capability",
                        lambda p, m: get_model_reasoning_capability(p, m))

    def start(*replies, name="acme", kind="openai", key=OWN_KEY, local=False, extra=None, after=None):
        endpoint = _Endpoint(*replies)
        endpoints.append(endpoint)
        entry = {"name": name, "type": kind, "model": "m", "base_url": endpoint.url if local else REMOTE}
        if key:
            entry["api_key"] = key
        config._config_cache["providers"] = [entry]
        base = endpoint.url[:-len("/v1")] if kind in ("anthropic", "google") else endpoint.url

        async def routed(**kwargs):
            if not local:
                kwargs["api_base"] = base
            kwargs.update(extra or {})
            result = await real(**kwargs)
            return after(result) if after else result

        monkeypatch.setattr(litellm, "acompletion", routed)
        return endpoint

    yield start
    for endpoint in endpoints:
        endpoint.close()


async def _turn(name="acme", **kwargs):
    events = [e async for e in stream_completion([{"role": "user", "content": "hi"}], provider_name=name,
                                                   model="m", **kwargs)]
    done = [e for e in events if isinstance(e, Done)]
    assert len(done) == 1 and events[-1] is done[0], events
    return "".join(e.text for e in events if isinstance(e, TextDelta)), done[0]


def _leaks(text: str, *secrets: str, shortest: int = 4) -> list:
    """Every piece of a secret, at least `shortest` characters from its start, that the text still shows."""
    found = []
    for secret in secrets:
        for size in range(len(secret), shortest - 1, -1):
            if secret[:size] in (text or ""):
                found.append(secret[:size])
                break
    return found


def _validation(*errors, wrap=None):
    """A 422 validation reply as FastAPI and pydantic write it, optionally inside an OpenAI-style error."""
    detail = {"detail": [dict(error) for error in errors]}
    if wrap == "message-string":
        return {"error": {"message": json.dumps(detail)}}
    if wrap == "message-object":
        return {"message": detail}
    return detail


EXTRA_FIELD = {"type": "extra_forbidden", "loc": ["body", "stream_options"], "msg": "Extra inputs are not permitted",
               "input": {"include_usage": True, "note": PROMPT_ECHO, "key": TOKEN}}
NESTED_FIELD = {"type": "string_type", "loc": ["body", "messages", 0, "content"], "msg": "Input should be a valid string",
                "input": PROMPT_ECHO + " " + TOKEN, "url": "https://errors.pydantic.dev/2.9/v/string_type"}


# ── 1. A 422 from the provider ───────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("body,said", [
    ({"error": {"message": f"Unprocessable entity: this model does not accept tools ({CANARY})"}},
     f"Unprocessable entity: this model does not accept tools ({CANARY})"),
    ({"detail": f"Model m cannot stream ({CANARY})"}, f"Model m cannot stream ({CANARY})"),
    ({"error": {"message": f"[\"messages: field required\", \"{CANARY}\"]"}}, CANARY),
    ({"error": {"message": "422"}}, "422"),
    ({"error": {"message": "null"}}, "null"),
], ids=["openai-style", "fastapi-string", "json-array-string", "number-string", "null-string"])
async def test_a_422_that_names_no_field_is_sent_once_with_its_status_and_message(connect, clock, body, said):
    endpoint = connect(_answer(422, body=body))
    _, done = await _turn()
    assert done.outcome == "error"
    assert (done.error_status, len(endpoint.requests)) == (422, 1), done
    assert said in (done.error_message or ""), done.error_message
    assert not [word for word in INTERNALS if word in (done.error_message or "")], done.error_message
    assert clock.waits == []


@pytest.mark.parametrize("wrap", [None, "message-string", "message-object"])
async def test_a_422_that_names_fields_reaches_the_provider_at_most_twice(connect, clock, wrap):
    endpoint = connect(_answer(422, body=_validation(EXTRA_FIELD, wrap=wrap)))
    _, done = await _turn()
    assert done.outcome == "error" and done.error_status == 422, done
    assert len(endpoint.requests) <= 2, f"{len(endpoint.requests)} requests"
    assert clock.waits == []


async def test_a_422_whose_named_field_is_dropped_lets_the_resent_turn_succeed(connect, clock):
    rejection = _answer(422, body=_validation(EXTRA_FIELD, wrap="message-string"))
    success = _stream("O", "K")

    def reply(handler, endpoint):
        (rejection if "stream_options" in endpoint.requests[-1] else success)(handler, endpoint)

    endpoint = connect(reply)
    text, done = await _turn()
    assert (text, done.outcome) == ("OK", "success"), done
    assert len(endpoint.requests) == 2 and "stream_options" not in endpoint.requests[1]


@pytest.mark.parametrize("wrap", [None, "message-string", "message-object"])
@pytest.mark.parametrize("error,shown", [(EXTRA_FIELD, "stream_options: Extra inputs are not permitted"),
                                         (NESTED_FIELD, "messages.0.content: Input should be a valid string")],
                         ids=["extra-field", "nested-field"])
async def test_a_validation_reply_shows_field_and_reason_and_never_the_echoed_input(connect, clock, wrap, error, shown):
    connect(_answer(422, body=_validation(error, wrap=wrap)))
    _, done = await _turn()
    message = done.error_message or ""
    assert shown in message, message
    assert "Please refactor" not in message and "payroll" not in message, message
    assert not _leaks(message, TOKEN), message
    assert "errors.pydantic.dev" not in message


async def test_a_validation_reply_with_many_errors_shows_at_most_three(connect, clock):
    errors = [dict(EXTRA_FIELD, loc=["body", f"field_{n}"], msg=f"bad value {n}") for n in range(6)]
    connect(_answer(422, body=_validation(*errors)))
    _, done = await _turn()
    assert done.error_message == "field_0: bad value 0; field_1: bad value 1; field_2: bad value 2"


# ── 2. A call that returns no stream ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def no_recorder(monkeypatch):
    """LiteLLM as it ships: Andromity's recording of its 422 helper is missing."""
    from litellm.llms.openai import common_utils
    from litellm.llms.openai import openai as openai_llm

    monkeypatch.setattr(provider, "_record_unprocessable_rejections", lambda: None)
    monkeypatch.setattr(openai_llm, "drop_params_from_unprocessable_entity_error",
                        common_utils.drop_params_from_unprocessable_entity_error)


@pytest.fixture
def idle_recorder(monkeypatch):
    """A recorder is in place but records and raises nothing; it only hands the call on to LiteLLM's helper."""
    from litellm.llms.openai import common_utils
    from litellm.llms.openai import openai as openai_llm

    def passing(e, data):
        return common_utils.drop_params_from_unprocessable_entity_error(e, data)

    passing._records_rejections = True
    monkeypatch.setattr(openai_llm, "drop_params_from_unprocessable_entity_error", passing)


@pytest.mark.parametrize("body", [{"error": {"message": f"Unprocessable ({CANARY})"}},
                                  _validation(EXTRA_FIELD, wrap="message-string")],
                         ids=["names-no-field", "names-a-field"])
@pytest.mark.parametrize("recorder", ["no_recorder", "idle_recorder"])
async def test_a_swallowed_422_without_the_recorder_still_ends_with_one_clean_done(request, connect, clock, body,
                                                                                    recorder):
    request.getfixturevalue(recorder)
    endpoint = connect(_answer(422, body=body))
    _, done = await _turn()
    assert done.outcome == "error"
    assert len(endpoint.requests) <= 2, f"{len(endpoint.requests)} requests"
    assert not [word for word in INTERNALS if word in (done.error_message or "")], done.error_message
    assert clock.waits == []


class _NotAStream:
    pass


@pytest.mark.parametrize("returned", [lambda r: None, lambda r: {}, lambda r: _NotAStream(), lambda r: "data: [DONE]"],
                         ids=["none", "dict", "object", "string"])
async def test_a_call_that_returns_no_stream_ends_with_one_clean_done_and_is_not_retried(connect, clock, returned):
    endpoint = connect(_stream("never", "read"), after=returned)
    _, done = await _turn()
    assert done.outcome == "error"
    assert len(endpoint.requests) <= 2, f"{len(endpoint.requests)} requests"
    assert clock.waits == [], f"retried after waiting {clock.waits}"
    message = done.error_message or ""
    internal = INTERNALS + ("__aiter__", "object has no attribute", "'dict'", "'str'", "_NotAStream", "not iterable")
    assert not [word for word in internal if word in message], message


# ── 3. Retries ───────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
async def test_only_our_loop_retries_a_retryable_reply(connect, clock, status):
    endpoint = connect(_answer(status, f"Try later ({status})"))
    _, done = await _turn()
    assert (len(endpoint.requests), clock.waits) == (4, FIXED_BACKOFF)
    assert done.error_status == status


@pytest.mark.parametrize("kind", ["openai", "openrouter", "deepseek", "groq", "nvidia", "anthropic", "google"])
async def test_no_built_in_adapter_retries_on_its_own(connect, clock, kind):
    endpoint = connect(_answer(429, "Too many requests", {"Retry-After": "1"}), name=kind, kind=kind)
    started = time.monotonic()
    _, done = await _turn(kind, retry=False)
    assert done.error_status == 429
    assert len(endpoint.requests) == 1, f"{len(endpoint.requests)} requests in {time.monotonic() - started:.1f}s"


@pytest.mark.parametrize("status,headers,message,waits", [
    (429, {"Retry-After": "7"}, "Too many requests", [7.0] * 3),
    (503, {"Retry-After": "12"}, "Overloaded", [12.0] * 3),
    (429, {"Retry-After": "120"}, "Too many requests", [30.0] * 3),
    (503, {"Retry-After": "1"}, "Overloaded", [1.0] * 3),
    (429, {}, "Rate limited, please retry in 4s.", [4.0] * 3),
    (503, {}, "Upstream busy; retry in 0.2s", [1.0] * 3),
    (429, {}, "Quota window full, retry in 45s", [30.0] * 3),
    (429, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, "Too many requests", FIXED_BACKOFF),
    (429, {"Retry-After": "soon"}, "Too many requests", FIXED_BACKOFF),
    (429, {"Retry-After": "-3"}, "Too many requests", FIXED_BACKOFF),
], ids=["429-header-7", "503-header-12", "header-clamped-to-30", "header-1", "phrase-4", "phrase-clamped-to-1",
        "phrase-clamped-to-30", "http-date", "not-a-number", "negative"])
async def test_a_wait_hint_before_the_stream_replaces_the_fixed_backoff(connect, clock, status, headers, message, waits):
    endpoint = connect(_answer(status, message, headers))
    await _turn()
    assert clock.waits == waits
    assert len(endpoint.requests) == 4


@pytest.mark.parametrize("value,waits", [("0", [1.0] * 3), ("90000", [30.0] * 3)])
async def test_a_retry_after_outside_the_range_is_clamped_not_ignored(connect, clock, value, waits):
    connect(_answer(429, "Too many requests", {"Retry-After": value}))
    await _turn()
    assert clock.waits == waits


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 413, 451])
async def test_a_refused_call_reaches_the_provider_once(connect, clock, status):
    endpoint = connect(_answer(status, f"Refused ({status})", {"Retry-After": "1"}))
    _, done = await _turn()
    assert (len(endpoint.requests), clock.waits, done.error_status) == (1, [], status)


async def test_the_gateway_daily_limit_reaches_the_gateway_once(connect, clock):
    endpoint = connect(_gateway_limit(no_retry=False, extra_headers={"Retry-After": "3"}), name="andromity", key=None,
                       local=True)
    _, done = await _turn("andromity")
    assert done.error_type == "quota_exceeded" and done.error_action == "join_waitlist"
    assert (len(endpoint.requests), clock.waits) == (1, [])


# ── 4. Which failures carry a message ────────────────────────────────────────────────────────────────────────────


def _closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def test_a_refused_connection_has_no_message(connect, clock):
    connect(_answer(500, "unused"), extra={"api_base": f"http://127.0.0.1:{_closed_port()}/v1"})
    _, done = await _turn()
    assert (done.error_message, done.error_status) == (None, None), done
    assert done.error_detail == "network_conn"


async def test_a_read_timeout_without_a_status_has_no_message(connect, clock):
    def slow(handler, endpoint):
        endpoint.release.wait(5)

    connect(slow, extra={"timeout": 0.5})
    _, done = await _turn(retry=False)
    assert (done.error_message, done.error_status) == (None, None), done
    assert done.error_detail.endswith("_timeout")


@pytest.mark.parametrize("reply", [_stream(then="stall"), _stream("Hel", then="drop")], ids=["stall", "dropped"])
async def test_a_stream_that_stalls_or_drops_has_no_message(connect, clock, reply):
    connect(reply)
    _, done = await _turn(first_token_timeout=0.5, retry=False)
    assert (done.error_message, done.error_status) == (None, None), done


@pytest.mark.parametrize("status,said", [
    (408, f"Request Timeout: the upstream read timed out ({CANARY})"),
    (400, f"The request timed out while reading the body ({CANARY})"),
    (504, f"Gateway Timeout: upstream timed out ({CANARY})"),
    (502, f"Bad gateway: connection reset by upstream ({CANARY})"),
    (503, f"Service unavailable: connect timeout to backend ({CANARY})"),
])
async def test_a_reply_with_a_status_keeps_its_message_even_when_it_reads_as_a_timeout(connect, clock, status, said):
    connect(_answer(status, said))
    _, done = await _turn(retry=False)
    assert (done.error_status, done.error_message) == (status, said), done


@pytest.mark.parametrize("status", [400, 404, 422, 500])
async def test_a_fastapi_style_error_body_keeps_its_message(connect, clock, status):
    said = f"Model m is not served here ({CANARY})"
    connect(_answer(status, body={"detail": said}))
    _, done = await _turn(retry=False)
    assert (done.error_status, done.error_message) == (status, said), done


@pytest.mark.parametrize("said", [f"Upstream timed out after 30s ({CANARY})", f"Connection reset by upstream ({CANARY})"])
async def test_an_error_event_the_provider_sent_keeps_its_message_even_when_it_reads_as_no_reply(connect, clock, said):
    connect(_stream("Hel", then={"error": {"message": said}}))
    _, done = await _turn(retry=False)
    assert done.error_message == said, done


# ── 5. Hostile error text ────────────────────────────────────────────────────────────────────────────────────────


HOSTILE = {
    "whitespace-run": "Error: " + " " * 19990 + "x",
    "whitespace-runs": "x" + (" " * 50 + "y") * 390,
    "tabs-and-newlines": "Bad request:" + "\t\n \r" * 5000 + "end",
    "repeated-original-exception": " Original exception:" * 1000,
    "original-exception-after-spaces": "x" + " " * 19000 + "Original exception: y",
    "repeated-error": "Error" * 4000,
    "repeated-error-prefix": "Error: " * 2900,
    "repeated-exception-prefix": "litellm.BadRequestError: OpenAIException - " * 470,
    "nested-arrays": "[" * 9000 + "]" * 9000,
    "nested-error-objects": '{"error":' * 2000 + '"x"' + "}" * 2000,
    "many-braces": "{" * 19000 + "}",
    "huge-body": "Bad request " + "x" * 10_000_000,
    "huge-json-body": json.dumps({"error": {"message": "y" * 5_000_000}}),
    "retry-digits": "retry in 1." + "1" * 19000,
    "stars": "*" * 19000 + "abc",
    "long-token-run": "a1" * 10000,
    "secret-prefix-run": OWN_KEY[:8] * 2500,
}
CLEANERS = {
    "extract": lambda e: extract_clean_error_message(e),
    "short": lambda e: short_error_detail(e, secrets=(OWN_KEY,)),
    "card": lambda e: classify_error_info(e, provider="acme", model="m"),
    "done": lambda e: _error_events(e, "acme", "m", False, secrets=(OWN_KEY,)),
}


@pytest.mark.parametrize("cleaner", list(CLEANERS))
@pytest.mark.parametrize("name", list(HOSTILE))
def test_error_text_cleaning_stays_under_50_ms_on_hostile_input(name, cleaner):
    exc = Exception(HOSTILE[name])
    clean = CLEANERS[cleaner]
    clean(exc)
    best = min(_timed(clean, exc) for _ in range(3))
    assert best < 0.050, f"{best * 1000:.1f} ms"


def _timed(clean, exc) -> float:
    started = time.perf_counter()
    clean(exc)
    return time.perf_counter() - started


@pytest.mark.parametrize("depth", [3000, 6000])
def test_a_deeply_nested_json_error_body_is_cleaned_without_raising(depth):
    exc = Exception('{"error": ' + '{"a":' * 4 + "[" * depth + "]" * depth + "}" * 4 + "}")
    started = time.perf_counter()
    events = _error_events(exc, "acme", "m", False, secrets=(OWN_KEY,))
    assert isinstance(events[-1], Done) and time.perf_counter() - started < 0.050


async def test_a_deeply_nested_json_reply_ends_the_turn_with_the_providers_message(connect, clock):
    body = ('{"error": {"message": "Bad request body", "data": ' + "[" * 4000 + "]" * 4000 + "}}").encode()

    def reply(handler, endpoint):
        handler.send_response(400)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Connection", "close")
        handler.end_headers()
        handler.wfile.write(body)

    endpoint = connect(reply)
    _, done = await _turn()
    assert (done.outcome, done.error_status, len(endpoint.requests)) == ("error", 400, 1)
    assert done.error_message == "Bad request body", done.error_message


@pytest.mark.parametrize("secret,configured", [(OWN_KEY, True), (TOKEN, False)], ids=["saved-key", "other-token"])
def test_redaction_happens_before_truncation(secret, configured):
    shown = {}
    for padding in range(0, 2000):
        text = short_error_detail(Exception("Rejected credential" + " " * padding + secret),
                                  secrets=(secret,) if configured else ())
        if _leaks(text, secret):
            shown[padding] = _leaks(text, secret)[0]
    assert shown == {}, f"{len(shown)} paddings show part of it, e.g. {sorted(shown.items(), key=lambda i: -len(i[1]))[:3]}"


async def test_a_reply_that_pads_a_token_past_the_cut_does_not_show_part_of_it(connect, clock):
    connect(_answer(400, "Rejected credential" + " " * 630 + TOKEN))
    _, done = await _turn()
    assert not _leaks(done.error_message, TOKEN), done.error_message


# ── 6. Undo restore budget ───────────────────────────────────────────────────────────────────────────────────────


PNG = b"\x89PNG\r\n\x1a\n"


def _png_uri(chars: int, fill: int) -> str:
    """A PNG data URI of exactly `chars` characters (a multiple of 4 past the 22-character header)."""
    payload = (chars - 22) // 4 * 3
    return "data:image/png;base64," + base64.b64encode(PNG + bytes([fill % 256]) * (payload - len(PNG))).decode()


def _keep(storage: Path, raw_bytes: int, fill: int) -> str:
    data = PNG + bytes([fill % 256]) * (raw_bytes - len(PNG))
    name = f"{hashlib.sha256(data).hexdigest()[:16]}.jpg"
    (storage / "images").mkdir(parents=True, exist_ok=True)
    (storage / "images" / name).write_bytes(data)
    return name


def _check_budget(found: list) -> None:
    spent = 0
    for uri in found:
        if len(uri) > SMALL_THUMB_CHARS:
            assert spent + len(uri) <= MAX_RESTORED_URI_CHARS, f"a {len(uri)}-character image overran the budget"
        spent += len(uri)
    small = sum(1 for uri in found if len(uri) <= SMALL_THUMB_CHARS)
    assert spent <= MAX_RESTORED_URI_CHARS + min(small, MAX_IMAGES) * SMALL_THUMB_CHARS, spent


def test_restored_images_never_exceed_the_budget_plus_five_small_thumbnails(tmp_path):
    storage = Path(Session(project_path=str(tmp_path)).storage_dir)
    raw_sizes = [None, 1024, 3 * 1024 * 1024, 4_194_270, 4_194_271, MAX_STORED_IMAGE_BYTES]
    thumb_sizes = [None, 1_002, SMALL_THUMB_CHARS - 2, SMALL_THUMB_CHARS + 2, 1024 * 1024 + 2, 5 * 1024 * 1024 + 2,
                   11_184_830]
    names = {size: _keep(storage, size, n) if size else None for n, size in enumerate(raw_sizes)}
    thumbs = {size: _png_uri(size, 200 + n) if size else None for n, size in enumerate(thumb_sizes)}
    rng = random.Random(1729)
    for _ in range(60):
        count = rng.randint(1, MAX_IMAGES + 2)
        message = {"images": [thumbs[rng.choice(thumb_sizes)] for _ in range(count)],
                   "image_files": [names[rng.choice(raw_sizes)] for _ in range(count)]}
        _check_budget(prompt_images(message, storage))


def test_a_thumbnail_over_256_kb_counts_against_the_budget(tmp_path):
    storage = Path(Session(project_path=str(tmp_path)).storage_dir)
    full = _keep(storage, MAX_STORED_IMAGE_BYTES, 1)
    left = MAX_RESTORED_URI_CHARS - (22 + 4 * -(-MAX_STORED_IMAGE_BYTES // 3))
    fits, too_big = _png_uri(left, 2), _png_uri(SMALL_THUMB_CHARS + 22, 3)
    small = _png_uri(SMALL_THUMB_CHARS - 2, 4)
    assert len(fits) <= left < len(fits) + 4 and len(too_big) > SMALL_THUMB_CHARS and len(small) <= SMALL_THUMB_CHARS
    found = prompt_images({"images": [None, fits, too_big, small], "image_files": [full, None, None, None]}, storage)
    assert [len(uri) for uri in found] == [MAX_RESTORED_URI_CHARS - left, len(fits), len(small)]


def test_a_large_thumbnail_before_a_full_image_takes_the_budget_the_full_image_needed(tmp_path):
    storage = Path(Session(project_path=str(tmp_path)).storage_dir)
    full = _keep(storage, MAX_STORED_IMAGE_BYTES, 5)
    first = _png_uri(10 * 1024 * 1024 + 2, 6)
    own_thumb = _png_uri(1_002, 7)
    found = prompt_images({"images": [first, own_thumb], "image_files": [None, full]}, storage)
    assert found == [first, own_thumb]
    _check_budget(found)
