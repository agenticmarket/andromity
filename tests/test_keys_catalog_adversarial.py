"""Adversarial tests for provider key tests, catalog/live model flags and key redaction.

Every provider call is mocked: litellm.acompletion and urllib are replaced, and the keys are fake.
"""
import asyncio
import io
import json
import logging
import socket
import threading
import urllib.error
import urllib.request

import litellm
import pytest

from andromity.config import config
from andromity.core import connections
from andromity.core import models as models_mod
from andromity.core import provider as provider_mod
from andromity.core.events import Done, TextDelta
from andromity.server import rpc_handler as rpc
from andromity.server.rpc_handler import JsonRpcHandler

FAKE_OPENAI = "sk-test-FAKEfake0000FAKEfake0000"
FAKE_GROQ = "gsk_FAKEfake0000FAKEfake0000ab"
FAKE_ANTHROPIC = "sk-ant-FAKEfake0000FAKEfake0000"
CUSTOM_KEY = "team-alpha-secret-2024-prod"

KEY_ENV_VARS = (
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "DEEPSEEK_API_KEY",
    "GROQ_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY", "ANDROMITY_API_KEY",
)


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    for name in KEY_ENV_VARS:
        monkeypatch.setenv(name, "placeholder")
        monkeypatch.delenv(name)

    def no_network(*args, **kwargs):
        raise AssertionError("a test reached for the network")

    monkeypatch.setattr(urllib.request, "urlopen", no_network)
    monkeypatch.setattr(models_mod, "reachable_loopback_url", lambda url: None)
    from andromity.core import reasoning
    from andromity.core.effort import ReasoningCapability, ReasoningMode
    monkeypatch.setattr(reasoning, "discover_model_reasoning_capability",
                        lambda provider, model: ReasoningCapability(ReasoningMode.UNKNOWN))
    monkeypatch.setattr(config, "get_pinned_models", lambda: [])


def providers(*entries: dict) -> None:
    config._config_cache["providers"] = [dict(entry) for entry in entries]


def live_cache(monkeypatch, data: dict) -> None:
    def cached(provider=None):
        return [dict(m) if isinstance(m, dict) else m for m in data.get(provider, [])]
    monkeypatch.setattr(models_mod, "get_cached_live_models", cached)
    monkeypatch.setattr(rpc, "get_cached_live_models", cached)


def catalog_ids(provider: str) -> list:
    return [m["id"] for m in models_mod.get_models_for_provider(provider)]


@pytest.fixture
def sleeps(monkeypatch):
    waits = []

    async def no_wait(delay, *args, **kwargs):
        waits.append(delay)

    monkeypatch.setattr(provider_mod.asyncio, "sleep", no_wait)
    return waits


def failing_completion(monkeypatch, exc: BaseException) -> list:
    calls = []

    async def acompletion(**kwargs):
        calls.append(kwargs)
        raise exc

    monkeypatch.setattr(litellm, "acompletion", acompletion)
    return calls


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def fake_http(monkeypatch, handler) -> list:
    """Route urllib requests to `handler(url, headers)`; it returns a JSON value, raw bytes or an exception."""
    seen = []

    def urlopen(request, timeout=None):
        url = getattr(request, "full_url", request)
        headers = {k.lower(): v for k, v in request.header_items()} if hasattr(request, "header_items") else {}
        seen.append((url, headers))
        reply = handler(url, headers)
        if isinstance(reply, BaseException):
            raise reply
        return _Response(reply if isinstance(reply, bytes) else json.dumps(reply).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return seen


def http_error(url: str, code: int, body: str = "") -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, code, f"HTTP {code} for {url}", {}, io.BytesIO(body.encode("utf-8")))


# ── Which model a key test uses ─────────────────────────────────────────────────────────────


def test_probe_model_is_the_connections_own_model(monkeypatch):
    providers({"name": "groq", "model": "  pinned-groq-model  ", "api_key": FAKE_GROQ})
    live_cache(monkeypatch, {"groq": [{"id": "llama-3.3-70b-versatile"}]})
    assert connections.probe_model_for("groq") == "pinned-groq-model"


def test_probe_model_is_a_catalog_model_that_the_live_list_confirms(monkeypatch):
    catalog = catalog_ids("openai")
    live = ["gpt-live-only-preview", catalog[2], catalog[1]]
    live_cache(monkeypatch, {"openai": [{"id": m} for m in live]})
    chosen = connections.probe_model_for("openai")
    assert chosen in set(catalog) & set(live)


def test_probe_model_falls_back_to_the_live_list_when_the_catalog_is_stale(monkeypatch):
    live_cache(monkeypatch, {"groq": [{"id": None}, "not-a-dict", {"id": "   "}, {"id": "groq-live-1"}, {"id": "groq-live-2"}]})
    assert connections.probe_model_for("groq") == "groq-live-1"


def test_probe_model_uses_the_catalog_when_nothing_is_live(monkeypatch):
    live_cache(monkeypatch, {"openrouter": [{"id": "x/only-for-openrouter"}]})
    assert connections.probe_model_for("deepseek") == catalog_ids("deepseek")[0]


async def test_key_test_never_borrows_another_providers_default_model(monkeypatch):
    config._config_cache["default"] = {"provider": "anthropic", "model": "claude-opus-5"}
    providers({"name": "groq", "api_key": FAKE_GROQ})
    live_cache(monkeypatch, {"anthropic": [{"id": "claude-opus-5"}]})
    seen = []

    async def stream(messages, **kwargs):
        seen.append(kwargs)
        yield TextDelta(text="OK")
        yield Done()

    monkeypatch.setattr(provider_mod, "stream_completion", stream)
    result = await JsonRpcHandler().rpc_config_test_provider({"provider": "groq"})
    assert [call["provider_name"] for call in seen] == ["groq"]
    assert seen[0]["model"] in catalog_ids("groq")
    assert seen[0]["retry"] is False
    assert result["success"] is True and result["model"] == seen[0]["model"]
    assert isinstance(result["latency_ms"], int) and result["latency_ms"] >= 1


async def test_old_rpc_callers_keep_their_explicit_model(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ, "model": "own-model"})
    seen = []

    async def stream(messages, **kwargs):
        seen.append(kwargs["model"])
        yield TextDelta(text="OK")
        yield Done()

    monkeypatch.setattr(provider_mod, "stream_completion", stream)
    result = await JsonRpcHandler().rpc_config_test_provider({"provider": "groq", "model": "caller-model"})
    assert seen == ["caller-model"]
    assert result["success"] is True and result["message"] == "Connection ready."


async def test_builtin_without_a_key_is_refused_before_any_request(monkeypatch):
    calls = []

    async def stream(*args, **kwargs):
        calls.append(kwargs)
        yield Done()

    monkeypatch.setattr(provider_mod, "stream_completion", stream)
    result = await connections.test_connection("openai")
    assert result["success"] is False and result["error_type"] == "no_key"
    assert calls == []


async def test_loopback_builtin_and_custom_endpoints_are_tested_without_a_key(monkeypatch):
    providers(
        {"name": "openai", "type": "openai", "base_url": "http://127.0.0.1:1234/v1", "model": "local-coder"},
        {"name": "selfhost", "type": "openai", "base_url": "https://llm.internal.example/v1", "model": "m1"},
    )
    seen = []

    async def stream(messages, **kwargs):
        seen.append((kwargs["provider_name"], kwargs["model"], kwargs["retry"]))
        yield TextDelta(text="OK")
        yield Done()

    monkeypatch.setattr(provider_mod, "stream_completion", stream)
    assert (await connections.test_connection("openai"))["success"] is True
    assert (await connections.test_connection("selfhost"))["success"] is True
    assert seen == [("openai", "local-coder", False), ("selfhost", "m1", True)]


async def test_custom_connection_without_a_model_is_not_sent_anywhere(monkeypatch):
    providers({"name": "selfhost", "type": "openai", "base_url": "https://llm.internal.example/v1"})
    calls = []

    async def stream(*args, **kwargs):
        calls.append(kwargs)
        yield Done()

    monkeypatch.setattr(provider_mod, "stream_completion", stream)
    result = await connections.test_connection("selfhost")
    assert result["error_type"] == "no_model"
    assert calls == []


async def test_builtin_test_answers_inside_the_twenty_second_ui_budget(monkeypatch):
    limits = {}
    real_wait_for = asyncio.wait_for

    async def record(awaitable, timeout):
        limits[len(limits)] = timeout
        return await real_wait_for(awaitable, timeout)

    async def quick(provider, model=""):
        return {"success": True}

    monkeypatch.setattr(connections, "test_connection", quick)
    monkeypatch.setattr(rpc.asyncio, "wait_for", record)
    await JsonRpcHandler().rpc_config_test_provider({"provider": "openai"})
    assert 0 < limits[0] < 20


async def test_a_hung_key_test_reports_a_timeout(monkeypatch):
    real_wait_for = asyncio.wait_for

    async def short(awaitable, timeout):
        return await real_wait_for(awaitable, 0.05)

    async def hang(provider, model=""):
        await asyncio.Event().wait()

    monkeypatch.setattr(connections, "test_connection", hang)
    monkeypatch.setattr(rpc.asyncio, "wait_for", short)
    result = await JsonRpcHandler().rpc_config_test_provider({"provider": "groq"})
    assert result["success"] is False and result["error_type"] == "timeout"


async def test_missing_provider_returns_a_failure_instead_of_raising():
    for params in ({}, {"provider": "   "}, {"provider": None}):
        result = await JsonRpcHandler().rpc_config_test_provider(params)
        assert result["success"] is False


async def test_air_gap_block_is_reported_as_air_gap(monkeypatch):
    from andromity.core import network_policy
    providers({"name": "openai", "api_key": FAKE_OPENAI})
    monkeypatch.setattr(network_policy, "url_allowed", lambda url: False)
    calls = failing_completion(monkeypatch, AssertionError("must not be called"))
    result = await connections.test_connection("openai", "gpt-4o")
    assert result["error_type"] == "airgap"
    assert calls == []


# ── One attempt for built-in providers; a 429 means the key works ───────────────────────────


async def test_builtin_rate_limit_is_one_attempt_without_backoff(monkeypatch, sleeps):
    providers({"name": "openai", "api_key": FAKE_OPENAI})
    calls = failing_completion(monkeypatch, litellm.RateLimitError(
        message="Rate limit exceeded. Please slow down.", model="gpt-4o", llm_provider="openai"))
    result = await connections.test_connection("openai", "gpt-4o")
    assert len(calls) == 1
    assert sleeps == []
    assert result["error_type"] == "rate_limit"


async def test_openai_429_that_quotes_its_rpm_limit_is_still_reported_as_rate_limited(monkeypatch, sleeps):
    providers({"name": "openai", "api_key": FAKE_OPENAI})
    calls = failing_completion(monkeypatch, litellm.RateLimitError(
        message="Rate limit reached for gpt-4o in organization org-test on requests per min (RPM): "
                "Limit 500, Used 500, Requested 1. Please try again in 120ms.",
        model="gpt-4o", llm_provider="openai"))
    result = await connections.test_connection("openai", "gpt-4o")
    assert len(calls) == 1 and sleeps == []
    assert result["error_type"] in ("rate_limit", "quota_exceeded"), result


async def test_chat_streams_keep_their_backoff_by_default(monkeypatch, sleeps):
    providers({"name": "openai", "api_key": FAKE_OPENAI})
    calls = failing_completion(monkeypatch, litellm.APIConnectionError(
        message="Connection reset by peer", model="gpt-4o", llm_provider="openai"))
    events = [e async for e in provider_mod.stream_completion([{"role": "user", "content": "hi"}],
                                                             provider_name="openai", model="gpt-4o")]
    assert len(calls) == 4
    assert sleeps == list(provider_mod.STREAM_BACKOFF_DELAYS)
    assert isinstance(events[-1], Done) and events[-1].outcome == "error"


async def test_custom_endpoint_tests_keep_their_retries(monkeypatch, sleeps):
    providers({"name": "selfhost", "type": "openai", "base_url": "http://localhost:8000/v1", "model": "m1"})
    calls = failing_completion(monkeypatch, litellm.APIConnectionError(
        message="Connection reset by peer", model="m1", llm_provider="openai"))
    result = await connections.test_connection("selfhost")
    assert len(calls) == 4 and len(sleeps) == 3
    assert result["success"] is False


# ── Provider error text never carries the key ──────────────────────────────────────────────


@pytest.mark.parametrize("key", [
    "sk-proj-FAKEfake0000FAKEfake0000",
    "gsk_FAKEfake0000FAKEfake0000ab",
    "AIzaFAKEfake0000FAKEfake0000FAKEfake00",
    "nvapi-FAKEfake0000FAKEfake0000",
    CUSTOM_KEY,
])
@pytest.mark.parametrize("template", [
    "Incorrect API key provided: {key}. Check your account.",
    "Authorization: Bearer {key} was rejected",
    "GET https://example.invalid/v1/models?key={key}&alt=json failed",
    "invalid api_key: {key}",
])
async def test_probe_failure_never_echoes_the_saved_key(monkeypatch, sleeps, caplog, key, template):
    caplog.set_level(logging.DEBUG)
    providers({"name": "selfhost", "type": "openai", "base_url": "http://localhost:8000/v1", "model": "m1", "api_key": key})
    failing_completion(monkeypatch, litellm.BadRequestError(
        message=template.format(key=key), model="m1", llm_provider="openai"))
    result = await connections.test_connection("selfhost")
    assert result["success"] is False
    assert result.get("detail")
    assert key not in json.dumps(result)
    assert key not in caplog.text


async def test_key_from_the_environment_is_redacted_too(monkeypatch, sleeps):
    monkeypatch.setenv("GROQ_API_KEY", CUSTOM_KEY)
    failing_completion(monkeypatch, litellm.BadRequestError(
        message=f"credential {CUSTOM_KEY} is disabled", model="llama-3.3-70b-versatile", llm_provider="groq"))
    result = await connections.test_connection("groq", "llama-3.3-70b-versatile")
    assert CUSTOM_KEY not in json.dumps(result)


async def test_saved_key_cut_by_detail_truncation_is_still_redacted(monkeypatch, sleeps):
    providers({"name": "selfhost", "type": "openai", "base_url": "http://localhost:8000/v1", "model": "m1", "api_key": CUSTOM_KEY})
    filler = "The upstream gateway refused this request: the supplied credential matches no active project "
    filler = filler + "for this endpoint " + "." * (139 - len(filler) - len("for this endpoint ")) + " "
    exc = litellm.BadRequestError(message=filler + CUSTOM_KEY + " was rejected.", model="m1", llm_provider="openai")
    cleaned = " ".join(provider_mod.extract_clean_error_message(exc).split())
    start = cleaned.index(CUSTOM_KEY)
    assert start + 12 < 159 < start + len(CUSTOM_KEY), "the key must straddle the 160-character cut"
    failing_completion(monkeypatch, exc)
    result = await connections.test_connection("selfhost")
    assert CUSTOM_KEY[:12] not in json.dumps(result), result


def test_short_error_detail_strips_markup_and_newlines():
    exc = RuntimeError("<!DOCTYPE html><html><body>secret page sk-live-FAKEfake0000FAKEfake</body></html>")
    detail = provider_mod.short_error_detail(exc)
    assert "<" not in detail and "sk-live" not in detail
    exc = RuntimeError("first line Bearer abc.def.ghi\nsecond line api_key=hunter2hunter2")
    detail = provider_mod.short_error_detail(exc)
    assert "\n" not in detail and "abc.def.ghi" not in detail and "hunter2" not in detail


# ── "Needs API key": which connections need their own key ──────────────────────────────────


@pytest.mark.parametrize("base_url,required", [
    ("", True),
    ("https://api.openai.com/v1", True),
    ("http://localhost:1234/v1", False),
    ("http://LOCALHOST:1234/v1", False),
    ("http://127.0.0.1:8080/v1", False),
    ("http://[::1]:8080/v1", False),
    ("http://models.localhost:8080/v1", False),
    ("http://localhost.attacker.example/v1", True),
    ("http://127.0.0.1.nip.io/v1", True),
    ("https://attacker.example/localhost/v1", True),
])
def test_key_required_skips_only_real_loopback_endpoints(base_url, required):
    providers({"name": "openai", "type": "openai", "base_url": base_url} if base_url else {"name": "openai"})
    info = {p["id"]: p for p in connections.provider_info()}
    assert info["openai"]["key_required"] is required


@pytest.mark.parametrize("base_url", ["http://127.0.0.2:8000/v1", "http://127.10.0.1:8000/v1"])
def test_whole_127_loopback_range_is_never_tagged_as_needing_a_key(base_url):
    from andromity.core import airgap_guard
    providers({"name": "openai", "type": "openai", "base_url": base_url})
    host = base_url.split("//")[1].split(":")[0]
    assert airgap_guard._Policy().name_allowed(host), "air-gap mode already treats this host as local"
    info = {p["id"]: p for p in connections.provider_info()}
    assert info["openai"]["key_required"] is False


def test_keyless_and_custom_connections_never_need_a_key():
    providers({"name": "selfhost", "type": "openai", "base_url": "https://llm.internal.example/v1", "model": "m1"})
    info = {p["id"]: p for p in connections.provider_info()}
    for pid in ("andromity", "ollama"):
        assert info[pid]["key_required"] is False and info[pid]["has_key"] is True
    assert info["selfhost"]["key_required"] is False and info["selfhost"]["has_key"] is False
    for pid in ("openai", "anthropic", "google", "groq", "deepseek", "openrouter", "nvidia"):
        assert info[pid]["key_required"] is True and info[pid]["has_key"] is False
    assert all("api_key" not in p for p in info.values())


async def test_list_providers_rpc_exposes_key_required_without_any_key_material(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ})
    listed = await JsonRpcHandler().rpc_config_list_providers({})
    groq = next(p for p in listed if p["id"] == "groq")
    assert groq["has_key"] is True and groq["key_required"] is True
    assert FAKE_GROQ not in json.dumps(listed)


async def test_list_models_flags_keys_and_sources_per_provider(monkeypatch):
    providers(
        {"name": "anthropic", "api_key": FAKE_ANTHROPIC},
        {"name": "openai", "type": "openai", "base_url": "http://localhost:1234/v1", "model": "local-coder"},
        {"name": "selfhost", "type": "openai", "base_url": "https://llm.internal.example/v1", "model": "m1"},
    )
    live_cache(monkeypatch, {"anthropic": [{"id": "claude-live-1", "name": "Claude Live"}]})

    def fetch(provider, *args, **kwargs):
        return [{"id": "qwen2.5-coder:3b", "name": "qwen2.5-coder:3b"}] if provider == "ollama" else []

    monkeypatch.setattr(rpc, "fetch_live_models_sync", fetch)
    listed = await JsonRpcHandler().rpc_config_list_models({})
    by = {}
    for m in listed:
        assert isinstance(m["has_key"], bool) and isinstance(m["needs_key"], bool)
        assert m["source"] in ("live", "catalog")
        by.setdefault(m["provider"], []).append(m)

    def flags(pid):
        return {(m["has_key"], m["needs_key"], m["source"]) for m in by[pid]}

    assert flags("groq") == {(False, True, "catalog")}
    assert flags("anthropic") == {(True, False, "live")}
    assert flags("andromity") == {(True, False, "catalog")}
    assert flags("ollama") == {(True, False, "live")}
    assert flags("openai") == {(False, False, "catalog")}
    assert flags("selfhost") == {(False, False, "catalog")}
    assert FAKE_ANTHROPIC not in json.dumps(listed)


# ── config.refresh_provider_models ─────────────────────────────────────────────────────────


GROQ_MODELS = {"data": [{"id": "groq-live-a", "active": True, "context_window": 131072},
                        {"id": "groq-old", "active": False}]}


async def test_refresh_requires_a_provider():
    with pytest.raises(ValueError):
        await JsonRpcHandler().rpc_config_refresh_provider_models({})
    response = await JsonRpcHandler().handle_request(
        rpc.JsonRpcRequest(id=1, method="config.refresh_provider_models", params={"provider": ""}))
    assert response.error is not None


async def test_refresh_without_a_key_sends_nothing_and_says_so(monkeypatch):
    seen = fake_http(monkeypatch, lambda url, headers: AssertionError("no request expected"))
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "groq"})
    assert seen == []
    assert reply["ok"] is False and reply["error_type"] == "no_key" and reply["message"] == "No API key set."
    assert reply["source"] == "catalog"
    assert reply["models"] and all(m["needs_key"] and m["source"] == "catalog" for m in reply["models"])


@pytest.mark.parametrize("code,error_type,message", [
    (401, "auth_error", "Key rejected."),
    (403, "auth_error", "Key rejected."),
    (429, "rate_limit", "Rate limited. Try again shortly."),
    (503, "provider_unavailable", "The provider is unavailable. Try again later."),
])
async def test_refresh_reports_why_the_provider_refused(monkeypatch, caplog, code, error_type, message):
    caplog.set_level(logging.DEBUG)
    providers({"name": "groq", "api_key": FAKE_GROQ})
    seen = fake_http(monkeypatch, lambda url, headers: http_error(url, code, f'{{"error": "bad key {FAKE_GROQ}"}}'))
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "groq"})
    assert reply["ok"] is False and reply["error_type"] == error_type and reply["message"] == message
    assert [url for url, _ in seen] == ["https://api.groq.com/openai/v1/models"]
    assert FAKE_GROQ not in json.dumps(reply) and FAKE_GROQ not in caplog.text


async def test_refresh_of_google_never_echoes_the_key_from_its_url(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    google_key = "AIzaFAKEfake0000FAKEfake0000FAKEfake00"
    providers({"name": "google", "api_key": google_key})
    fake_http(monkeypatch, lambda url, headers: http_error(url, 400, "API key not valid. Please pass a valid API key."))
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "google"})
    assert reply["ok"] is False and reply["message"]
    assert google_key not in json.dumps(reply) and google_key not in caplog.text


@pytest.mark.parametrize("exc,message", [
    (urllib.error.URLError(socket.timeout("timed out")), "Couldn't reach provider."),
    (urllib.error.URLError(ConnectionRefusedError(10061, "refused")), "Couldn't reach provider."),
    (TimeoutError("read timed out"), "Couldn't reach provider."),
])
async def test_refresh_reports_an_unreachable_provider(monkeypatch, exc, message):
    providers({"name": "groq", "api_key": FAKE_GROQ})
    fake_http(monkeypatch, lambda url, headers: exc)
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "groq"})
    assert reply["ok"] is False and reply["message"] == message


async def test_refresh_reports_a_garbled_model_list(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ})
    fake_http(monkeypatch, lambda url, headers: b"<html>not json</html>")
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "groq"})
    assert reply["ok"] is False and reply["error_type"] == "bad_response"


async def test_refresh_that_hangs_is_cut_off_with_a_timeout(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ})
    release = threading.Event()
    fake_http(monkeypatch, lambda url, headers: (release.wait(10), {"data": []})[1])
    real_wait_for = asyncio.wait_for

    async def short(awaitable, timeout):
        return await real_wait_for(awaitable, min(timeout, 0.2))

    monkeypatch.setattr(rpc.asyncio, "wait_for", short)
    try:
        reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "groq"})
    finally:
        release.set()
    assert reply["ok"] is False and reply["error_type"] == "timeout" and reply["message"] == "Couldn't reach provider."


async def test_refresh_success_marks_the_provider_live(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ})
    seen = fake_http(monkeypatch, lambda url, headers: GROQ_MODELS)
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "groq"})
    assert reply["ok"] is True and reply["error_type"] is None and reply["message"] == ""
    assert reply["source"] == "live"
    assert [m["id"] for m in reply["models"]] == ["groq-live-a"]
    assert all(m["source"] == "live" and m["has_key"] and not m["needs_key"] for m in reply["models"])
    assert seen[0][1].get("authorization") == f"Bearer {FAKE_GROQ}"


async def test_refresh_of_custom_connection_never_sends_its_key_elsewhere(monkeypatch):
    providers({"name": "proxy", "type": "groq", "base_url": "https://llm.internal.example/v1", "model": "m1",
               "api_key": CUSTOM_KEY})
    seen = fake_http(monkeypatch, lambda url, headers: GROQ_MODELS)
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "proxy"})
    assert seen == []
    assert reply["ok"] is False and reply["error_type"] == "unsupported"
    assert CUSTOM_KEY not in json.dumps(reply)


async def test_refresh_under_air_gap_sends_nothing(monkeypatch):
    from andromity.core import network_policy
    providers({"name": "groq", "api_key": FAKE_GROQ})
    monkeypatch.setattr(network_policy, "url_allowed", lambda url: False)
    seen = fake_http(monkeypatch, lambda url, headers: GROQ_MODELS)
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "groq"})
    assert seen == []
    assert reply["error_type"] == "airgap" and reply["message"] == "Blocked by air-gap mode."


async def test_refresh_never_calls_keyless_providers_keyless(monkeypatch):
    fake_http(monkeypatch, lambda url, headers: urllib.error.URLError(ConnectionRefusedError(10061, "refused")))
    for pid in ("andromity", "ollama"):
        reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": pid})
        assert reply["error_type"] != "no_key", pid


# ── fetch_live_models_sync(status=...) stays compatible ────────────────────────────────────


def test_fetch_live_models_old_positional_callers_are_unaffected(monkeypatch):
    fake_http(monkeypatch, lambda url, headers: GROQ_MODELS)
    assert [m["id"] for m in models_mod.fetch_live_models_sync("groq", FAKE_GROQ, None)] == ["groq-live-a"]
    fake_http(monkeypatch, lambda url, headers: http_error(url, 401))
    assert models_mod.fetch_live_models_sync("groq", FAKE_GROQ) == []
    with pytest.raises(TypeError):
        models_mod.fetch_live_models_sync("groq", FAKE_GROQ, None, {})


@pytest.mark.parametrize("reply,reason", [
    (http_error("https://api.groq.com/openai/v1/models", 401), "auth_error"),
    (http_error("https://api.groq.com/openai/v1/models", 429), "rate_limit"),
    (http_error("https://api.groq.com/openai/v1/models", 404), "not_found"),
    (http_error("https://api.groq.com/openai/v1/models", 502), "provider_unavailable"),
    (http_error("https://api.groq.com/openai/v1/models", 402), "http_error"),
    (urllib.error.URLError(socket.timeout("timed out")), "timeout"),
    (urllib.error.URLError(ConnectionRefusedError(10061, "refused")), "offline"),
    (b"\xff\xfe not utf-8", "bad_response"),
])
def test_fetch_status_names_the_first_failure(monkeypatch, reply, reason):
    fake_http(monkeypatch, lambda url, headers: reply)
    status = {}
    assert models_mod.fetch_live_models_sync("groq", FAKE_GROQ, status=status) == []
    assert status == {"error": reason}


def test_fetch_status_reports_a_missing_key_only_for_providers_that_need_one():
    status = {}
    models_mod.fetch_live_models_sync("groq", "", status=status)
    assert status == {"error": "no_key"}


def test_fetch_status_stays_empty_on_success(monkeypatch):
    fake_http(monkeypatch, lambda url, headers: GROQ_MODELS)
    status = {}
    assert models_mod.fetch_live_models_sync("groq", FAKE_GROQ, status=status)
    assert status == {}


# ── Terminal app ───────────────────────────────────────────────────────────────────────────


class _KeyStore:
    keys: dict = {}

    @classmethod
    def get(cls, section, key, default=None):
        return default

    @classmethod
    def get_api_key(cls, provider):
        return cls.keys.get(provider)

    @classmethod
    def set_api_key(cls, provider, key):
        cls.keys[provider] = key


def test_tui_provider_prompt_tags_only_providers_that_lack_a_key(monkeypatch):
    import andromity.tui.overlays.model as mm
    store = type("Store", (_KeyStore,), {"keys": {"anthropic": FAKE_ANTHROPIC}})
    monkeypatch.setattr(mm, "config", store)
    catalog = models_mod.provider_catalog()
    prompt = {key: mm.ModelPickerScreen._provider_prompt(key, info).plain for key, info in catalog.items()}
    assert "needs key" in prompt["groq"] and "needs key" in prompt["openai"]
    assert "needs key" not in prompt["anthropic"]
    assert "needs key" not in prompt["andromity"] and "needs key" not in prompt["ollama"]


def test_tui_tag_clears_after_a_key_is_saved_and_key_step_shows_portal(monkeypatch):
    import andromity.tui.overlays.model as mm
    from textual.app import App
    from textual.widgets import OptionList, Static

    store = type("Store", (_KeyStore,), {"keys": {}})
    monkeypatch.setattr(mm, "config", store)
    monkeypatch.setattr(mm, "fetch_live_models_sync", lambda *a, **k: [])
    monkeypatch.setattr(mm, "get_cached_live_models", lambda *a, **k: [])

    class Host(App):
        pass

    async def scenario():
        app = Host()
        async with app.run_test(size=(110, 34)) as pilot:
            screen = mm.ModelPickerScreen()
            app.push_screen(screen)
            await pilot.pause()
            options = screen.query_one("#mp-providers", OptionList)
            index = screen._provider_keys.index("anthropic")
            assert "needs key" in options.get_option_at_index(index).prompt.plain

            screen._show_step2("anthropic")
            await pilot.pause()
            header = str(screen.query_one("#mp-models-header", Static).content)
            assert "https://console.anthropic.com/settings/keys" in header

            store.keys["anthropic"] = FAKE_ANTHROPIC
            screen._show_step1()
            await pilot.pause()
            assert "needs key" not in options.get_option_at_index(index).prompt.plain

    asyncio.run(scenario())
