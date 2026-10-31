"""Attempts to break NVIDIA routing: which LiteLLM adapter and URL a request uses, the model ID NVIDIA receives,
whose key goes with it, retries, air-gap mode, the catalog and live list, and the cards for its errors.

Requests go through the real LiteLLM client to a local stand-in for NVIDIA's API, which records each request's
path, headers and body.
"""
import http.server
import json
import threading

import litellm
import pytest

import andromity.core.provider as provider
import andromity.core.reasoning as reasoning
from andromity.config import config
from andromity.core import airgap_guard, network_policy
from andromity.core.connections import provider_info, provider_request, validate_connection
from andromity.core.connections import test_connection as run_key_test
from andromity.core.effort import get_model_reasoning_capability
from andromity.core.events import Done, TextDelta
from andromity.core.models import MODEL_CATALOG, fetch_live_models_sync, get_models_for_provider
from andromity.core.provider import stream_completion
from tests.test_provider_error_spec_regression import _Clock

NVIDIA_URL = "https://integrate.api.nvidia.com/v1"
NIM_KEY = "nvapi-" + "Lk7_" * 12
LIGHTNING = "nvidia/nemotron-3.5-lightning-30b-a3b"
CATALOG = [LIGHTNING, "nvidia/nemotron-3-ultra-550b-a55b", "mistralai/mistral-large-4-1t-a52b",
           "minimaxai/minimax-m3.1-flash"]
OTHER_KEYS = {
    "OPENAI_API_KEY": "sk-proj-ENVOPENAI" + "a1" * 20,
    "OPENROUTER_API_KEY": "sk-or-v1-ENVROUTER" + "b2" * 20,
    "ANTHROPIC_API_KEY": "sk-ant-api03-ENVANTHROPIC" + "c3" * 20,
    "GROQ_API_KEY": "gsk_ENVGROQ" + "d4" * 20,
}
SAVED_OPENAI_KEY = "sk-proj-SAVEDOPENAI" + "e5" * 20


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


class _Nim:
    """A local stand-in for NVIDIA's API; each request gets the next reply and the last one repeats."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []
        nim = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                nim.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                                     "body": json.loads(raw or b"{}")})
                try:
                    nim.replies[min(len(nim.requests), len(nim.replies)) - 1](self)
                except OSError:
                    self.close_connection = True

            def log_message(self, *args):
                pass

        self.server = _Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _reply_ok(text="OK"):
    def reply(handler):
        def send(obj):
            data = b"data: " + (obj if isinstance(obj, bytes) else json.dumps(obj).encode()) + b"\n\n"
            handler.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")

        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        chunk = {"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m"}
        send({**chunk, "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]})
        send({**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
              "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}})
        send(b"[DONE]")
        handler.wfile.write(b"0\r\n\r\n")
        handler.close_connection = True
    return reply


def _reply(status, body, headers=None):
    payload = (body if isinstance(body, bytes) else json.dumps(body).encode())

    def reply(handler):
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


@pytest.fixture
def clock(monkeypatch):
    recorder = _Clock()
    monkeypatch.setattr(provider, "asyncio", recorder)
    monkeypatch.setattr(provider, "STREAM_BACKOFF_DELAYS", [5.0, 10.0, 20.0])
    return recorder


@pytest.fixture
def nim(monkeypatch):
    """Save an NVIDIA connection and send LiteLLM's real calls for it to a local stand-in, recording each call."""
    servers = []
    calls = []
    real = litellm.acompletion
    monkeypatch.setattr(reasoning, "discover_model_reasoning_capability",
                        lambda p, m: get_model_reasoning_capability(p, m))
    for name in ("NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"):
        monkeypatch.delenv(name, raising=False)

    def start(*replies, saved=None, key=NIM_KEY, name="nvidia", others=()):
        server = _Nim(*(replies or (_reply_ok(),)))
        servers.append(server)
        entries = [dict(entry) for entry in others]
        if saved is not None or key:
            entry = {"name": name, **(saved or {})}
            if key:
                entry["api_key"] = key
            entries.append(entry)
        config._config_cache["providers"] = entries

        async def routed(**kwargs):
            calls.append(dict(kwargs))
            kwargs["api_base"] = server.url
            return await real(**kwargs)

        monkeypatch.setattr(litellm, "acompletion", routed)
        server.calls = calls
        return server

    yield start
    for server in servers:
        server.close()


async def _turn(name="nvidia", model="", **kwargs):
    events = [e async for e in stream_completion([{"role": "user", "content": "hi"}], provider_name=name,
                                                   model=model, **kwargs)]
    done = [e for e in events if isinstance(e, Done)]
    assert len(done) == 1 and events[-1] is done[0], events
    return "".join(e.text for e in events if isinstance(e, TextDelta)), done[0]


# ── 1. Routing ───────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("saved", [None, {}, {"type": "nvidia"}, {"type": "nvidia", "base_url": ""},
                                   {"type": "nvidia", "model": LIGHTNING}],
                         ids=["not-saved", "saved-without-type", "type-nvidia", "empty-base-url", "saved-model"])
async def test_the_built_in_connection_uses_the_openai_adapter_at_nvidias_url(nim, saved):
    server = nim(saved=saved)
    assert provider_request("nvidia", LIGHTNING) == {"model": f"openai/{LIGHTNING}", "api_key": NIM_KEY,
                                                     "api_base": NVIDIA_URL}
    text, done = await _turn(model=LIGHTNING)
    assert (text, done.outcome) == ("OK", "success")
    assert server.calls[-1]["model"] == f"openai/{LIGHTNING}" and server.calls[-1]["api_base"] == NVIDIA_URL
    assert [r["path"] for r in server.requests] == ["/v1/chat/completions"]
    assert server.requests[0]["body"]["model"] == LIGHTNING


@pytest.mark.parametrize("base_url", ["https://nim.internal.example/v1", "https://nim.internal.example/v1/",
                                      "https://nim.internal.example/v1/chat/completions"])
def test_a_saved_base_url_replaces_nvidias(nim, base_url):
    nim(saved={"type": "nvidia", "base_url": base_url})
    assert provider_request("nvidia", LIGHTNING)["api_base"] == "https://nim.internal.example/v1"


@pytest.mark.parametrize("model", [LIGHTNING, "openai/gpt-oss-20b", "openai/gpt-oss-120b", "gpt-oss-20b",
                                   "meta/llama/3.3/70b-instruct", "openai/openai/gpt-oss-20b", "nvidia_nim/whatever",
                                   "qwen/qwen3-coder-480b-a35b-instruct"])
@pytest.mark.parametrize("how", ["chosen", "saved"])
async def test_the_model_id_reaches_nvidia_exactly_as_chosen(nim, model, how):
    server = nim(saved={"type": "nvidia", "model": model} if how == "saved" else None)
    _, done = await _turn(model=model if how == "chosen" else "")
    assert done.outcome == "success", done
    assert server.requests[0]["body"]["model"] == model


@pytest.mark.parametrize("model", [LIGHTNING, "openai/gpt-oss-20b"])
async def test_an_explicit_nvidia_nim_type_keeps_litellms_nvidia_nim_adapter(nim, model):
    server = nim(saved={"type": "nvidia_nim"})
    request = provider_request("nvidia", model)
    assert request["model"] == f"nvidia_nim/{model}"
    _, done = await _turn(model=model)
    assert done.outcome == "success", done
    assert server.calls[-1]["model"] == f"nvidia_nim/{model}"
    assert server.requests[0]["body"]["model"] == model


@pytest.mark.parametrize("name,saved,model,routed", [
    ("lab", {"type": "openai", "base_url": "https://llm.lab.example/v1"}, "openai/gpt-4o", "openai/gpt-4o"),
    ("lab", {"type": "openai", "base_url": "https://llm.lab.example/v1"}, "gpt-4o", "openai/gpt-4o"),
    ("nvidia-lab", {"type": "openai", "base_url": "https://llm.lab.example/v1"}, "openai/gpt-4o", "openai/gpt-4o"),
    ("openai", None, "openai/gpt-4o", "openai/gpt-4o"),
    ("groq", None, "groq/llama-3.3-70b", "groq/llama-3.3-70b"),
    ("groq", None, "llama-3.3-70b", "groq/llama-3.3-70b"),
    ("openrouter", None, "openai/gpt-4o", "openrouter/openai/gpt-4o"),
    ("openrouter", None, "openrouter/auto", "openrouter/auto"),
    ("ollama", None, "ollama/llama3", "ollama/llama3"),
    ("ollama", None, "llama3", "ollama_chat/llama3"),
    ("google", None, "gemini-2.5-pro", "gemini/gemini-2.5-pro"),
    ("deepseek", None, "deepseek-chat", "deepseek/deepseek-chat"),
    ("andromity", None, "", "openai/auto"),
])
def test_other_providers_keep_their_prefix_handling(name, saved, model, routed):
    config._config_cache["providers"] = [{"name": name, "api_key": "k" * 20, **saved}] if saved else []
    assert provider_request(name, model)["model"] == routed


def test_a_custom_connection_of_type_nvidia_is_accepted():
    saved = validate_connection({"id": "nim-lab", "type": "nvidia", "model": "openai/gpt-oss-20b"})
    assert saved["type"] == "nvidia" and saved["base_url"] == ""


async def test_a_custom_connection_of_type_nvidia_still_goes_to_nvidia_with_its_model_id(nim):
    saved = validate_connection({"id": "nim-lab", "type": "nvidia", "model": "openai/gpt-oss-20b"})
    server = nim(saved=saved, name="nim-lab")
    request = provider_request("nim-lab", "")
    _, done = await _turn("nim-lab")
    problems = []
    if request.get("api_base") != NVIDIA_URL:
        problems.append(f"api_base {request.get('api_base')!r}: LiteLLM's OpenAI adapter would use api.openai.com")
    if server.requests and server.requests[0]["body"]["model"] != "openai/gpt-oss-20b":
        problems.append(f"model sent as {server.requests[0]['body']['model']!r}")
    assert problems == []


# ── 2. Retries ───────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("status,headers,waits", [(429, {"Retry-After": "1"}, [1.0] * 3), (503, {}, [5.0, 10.0, 20.0]),
                                                  (500, {}, [5.0, 10.0, 20.0])])
async def test_only_our_loop_retries_nvidia_calls(nim, clock, status, headers, waits):
    server = nim(_reply(status, {"error": {"message": "busy"}}, headers))
    _, done = await _turn(model=LIGHTNING)
    assert (len(server.requests), clock.waits, done.error_status) == (4, waits, status)


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
async def test_a_single_attempt_reaches_nvidia_once(nim, clock, status):
    server = nim(_reply(status, {"error": {"message": "busy"}}, {"Retry-After": "1"}))
    _, done = await _turn(model=LIGHTNING, retry=False)
    assert (len(server.requests), done.error_status) == (1, status)


async def test_the_key_test_of_a_rate_limited_nvidia_key_sends_one_request(nim, clock):
    server = nim(_reply(429, {"error": {"message": "Too many requests"}}, {"Retry-After": "5"}))
    result = await run_key_test("nvidia")
    assert result["error_type"] == "rate_limit"
    assert (len(server.requests), clock.waits) == (1, [])


# ── 3. Keys ──────────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("saved", [None, {"type": "nvidia"}, {"type": "nvidia_nim"},
                                   {"type": "nvidia", "base_url": "https://nim.internal.example/v1"}],
                         ids=["not-saved", "type-nvidia", "type-nvidia-nim", "own-base-url"])
async def test_without_an_nvidia_key_no_other_key_reaches_nvidia(nim, monkeypatch, saved):
    for env, value in OTHER_KEYS.items():
        monkeypatch.setenv(env, value)
    server = nim(saved=saved, key=None, others=[{"name": "openai", "api_key": SAVED_OPENAI_KEY},
                                               {"name": "openrouter", "api_key": OTHER_KEYS["OPENROUTER_API_KEY"]}])
    await _turn(model=LIGHTNING)
    sent = json.dumps([request["headers"] for request in server.requests] + [
        {k: v for k, v in call.items() if k != "messages"} for call in server.calls], default=str)
    leaked = [name for name, value in {**OTHER_KEYS, "saved openai": SAVED_OPENAI_KEY}.items() if value in sent]
    assert server.calls, "LiteLLM was never called"
    assert leaked == []


async def test_the_key_test_without_an_nvidia_key_sends_nothing(nim, monkeypatch):
    for env, value in OTHER_KEYS.items():
        monkeypatch.setenv(env, value)
    server = nim(key=None)
    result = await run_key_test("nvidia")
    assert result["error_type"] == "no_key" and server.requests == []


# ── 4. Air-gap mode ──────────────────────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def airgap(monkeypatch):
    def enable(allow: str = ""):
        monkeypatch.setenv("ANDROMITY_AIRGAP", "1")
        monkeypatch.setenv("ANDROMITY_AIRGAP_ALLOW", allow)
        airgap_guard._reset_for_tests()
        assert network_policy.activate() is True
    try:
        yield enable
    finally:
        airgap_guard._reset_for_tests()


@pytest.mark.parametrize("name,saved", [("nvidia", None), ("nvidia", {"type": "nvidia"}),
                                        ("nvidia", {"type": "nvidia_nim"}),
                                        ("nim-lab", {"type": "nvidia", "model": LIGHTNING})],
                         ids=["not-saved", "type-nvidia", "type-nvidia-nim", "custom-type-nvidia"])
async def test_air_gap_blocks_the_nvidia_connection(nim, airgap, name, saved):
    server = nim(saved=saved, name=name)
    airgap()
    with pytest.raises(network_policy.AirgapFeatureOff):
        provider_request(name, LIGHTNING)
    assert await _airgap_outcome(name) == await _airgap_outcome("openrouter")
    if name == "nvidia":
        assert (await run_key_test(name))["error_type"] == "airgap"
    assert server.calls == [] and server.requests == []


async def _airgap_outcome(name: str) -> str:
    try:
        _, done = await _turn(name, model=LIGHTNING)
    except network_policy.AirgapFeatureOff:
        return "raised"
    return done.error_type


def test_air_gap_marks_the_nvidia_connection_blocked(nim, airgap):
    nim(saved={"type": "nvidia"})
    airgap()
    assert next(p for p in provider_info() if p["id"] == "nvidia")["airgap_blocked"] is True


def test_air_gap_allows_an_nvidia_connection_saved_on_an_allowed_host(nim, airgap):
    nim(saved={"type": "nvidia", "base_url": "https://nim.internal.example/v1"})
    airgap("nim.internal.example")
    assert provider_request("nvidia", LIGHTNING)["api_base"] == "https://nim.internal.example/v1"


# ── 5. Catalog and live list ─────────────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def nvidia_models(monkeypatch):
    """Answer the model-list request with `payload`; records the URLs and headers it was asked for."""
    asked = []

    def serve(payload):
        def urlopen(request, timeout=None):
            asked.append((request.full_url, dict(request.header_items())))
            return _Response(payload if isinstance(payload, bytes) else json.dumps(payload).encode())

        monkeypatch.setattr("urllib.request.urlopen", urlopen)
        return asked

    for name in ("NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    return serve


class _Response:
    def __init__(self, body: bytes):
        self.body = body

    def read(self, *args):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_the_catalog_lists_exactly_the_four_answering_models():
    assert [m["id"] for m in MODEL_CATALOG["nvidia"]["models"]] == CATALOG
    assert [m["id"] for m in get_models_for_provider("nvidia")] == CATALOG


CHAT = ["meta/llama-3.3-70b-instruct", "openai/gpt-oss-20b", LIGHTNING, "qwen/qwen3-coder-480b-a35b-instruct",
        "Mistralai/Mistral-Large-4-1T-A52B"]
NON_CHAT = ["nvidia/nv-embedqa-e5-v5", "NVIDIA/NV-EmbedQA-Mistral-7B-v2", "nvidia/nv-rerankqa-mistral-4b-v3",
            "nvidia/nemotron-4-340b-reward", "nvidia/llama-3.1-nemoguard-8b-content-safety", "meta/llama-guard-4-12b",
            "Meta/Llama-Guard-3-8B", "nvidia/nemoretriever-parse", "nvidia/llama-3.2-nemoretriever-300m-embed-v1",
            "nvidia/nemoretriever-page-elements-v2-retriever"]


def test_the_live_list_holds_only_the_chat_models_nvidia_returned(nvidia_models):
    asked = nvidia_models({"object": "list", "data": [{"id": i, "object": "model"} for i in
                                                      [CHAT[0], NON_CHAT[0], CHAT[1], *NON_CHAT[1:], *CHAT[2:]]]})
    found = [m["id"] for m in fetch_live_models_sync("nvidia", api_key=NIM_KEY)]
    assert found == CHAT
    assert asked and asked[0][0] == f"{NVIDIA_URL}/models"


@pytest.mark.parametrize("payload,expected", [
    ({"object": "list", "data": []}, []),
    ({"data": None}, []),
    ({}, []),
    ([], []),
    ({"data": [{"id": 5}, {"id": None}, "nvidia/not-an-object", {"name": "no id"}, {"id": "nvidia/ok-model"}]},
     ["nvidia/ok-model"]),
    (b"not json", []),
], ids=["empty", "null-data", "no-data", "list", "bad-items", "not-json"])
def test_an_empty_or_malformed_live_list_adds_nothing_and_does_not_raise(nvidia_models, payload, expected):
    nvidia_models(payload)
    assert [m["id"] for m in fetch_live_models_sync("nvidia", api_key=NIM_KEY)] == expected


def test_the_live_list_is_asked_of_the_saved_base_url(nvidia_models):
    asked = nvidia_models({"data": [{"id": LIGHTNING}]})
    config._config_cache["providers"] = [{"name": "nvidia", "type": "nvidia",
                                          "base_url": "https://nim.internal.example/v1", "api_key": NIM_KEY}]
    fetch_live_models_sync("nvidia")
    assert [url for url, _ in asked] == ["https://nim.internal.example/v1/models"]


def test_air_gap_blocks_the_nvidia_live_list(nvidia_models, airgap):
    asked = nvidia_models({"data": [{"id": LIGHTNING}]})
    airgap()
    status = {}
    assert fetch_live_models_sync("nvidia", api_key=NIM_KEY, status=status) == []
    assert asked == [] and status.get("error") == "airgap"


@pytest.mark.parametrize("live", [None, ["microsoft/phi-3-mini-128k-instruct", "minimaxai/minimax-m3.1-flash",
                                         "google/gemma-2-2b-it", "meta/llama-3.2-1b-instruct", LIGHTNING,
                                         "nvidia/nemotron-3-ultra-550b-a55b"]],
                         ids=["no-live-list", "live-list"])
async def test_the_key_test_picks_nemotron_lightning_without_a_saved_model(nim, nvidia_models, live):
    if live:
        nvidia_models({"data": [{"id": i} for i in live]})
        assert fetch_live_models_sync("nvidia", api_key=NIM_KEY)
    server = nim(saved={"type": "nvidia"})
    result = await run_key_test("nvidia")
    assert result["success"] is True and result["model"] == LIGHTNING
    assert server.requests[0]["body"]["model"] == LIGHTNING


async def test_the_key_test_uses_a_saved_model_over_lightning(nim):
    server = nim(saved={"type": "nvidia", "model": "mistralai/mistral-large-4-1t-a52b"})
    await run_key_test("nvidia")
    assert server.requests[0]["body"]["model"] == "mistralai/mistral-large-4-1t-a52b"


# ── 6. Errors ────────────────────────────────────────────────────────────────────────────────────────────────────


RETIRED = "Model nvidia/llama-3.1-nemotron-70b-instruct has been retired and is no longer available."


@pytest.mark.parametrize("body", [{"error": {"message": RETIRED}}, {"status": 410, "title": "Gone", "detail": RETIRED},
                                  {"detail": RETIRED}], ids=["openai-style", "problem-json", "fastapi"])
async def test_a_410_shows_the_model_not_found_card_and_is_not_retried(nim, clock, body):
    server = nim(_reply(410, body))
    text, done = await _turn(model="nvidia/llama-3.1-nemotron-70b-instruct")
    assert (done.error_type, done.error_status) == ("model_not_found", 410), done
    assert 'data-error-type="model_not_found"' in text
    assert (len(server.requests), clock.waits) == (1, [])
    assert done.error_message == RETIRED


async def test_the_key_test_of_a_retired_model_reports_model_not_found_once(nim, clock):
    server = nim(_reply(410, {"error": {"message": RETIRED}}), saved={"type": "nvidia", "model": "nvidia/old"})
    result = await run_key_test("nvidia")
    assert result["error_type"] == "model_not_found" and len(server.requests) == 1


@pytest.mark.parametrize("body", [
    {"error": {"message": "Authorization failed"}},
    {"detail": "Authorization failed"},
    {"type": "about:blank", "status": 403, "title": "Forbidden", "detail": "Authorization failed"},
    {"error": {"message": "authorization failed."}},
    b"Authorization failed",
], ids=["openai-style", "fastapi", "problem-json", "lowercase", "plain-text"])
async def test_the_key_test_reads_authorization_failed_as_a_key_problem(nim, body):
    nim(_reply(403, body), saved={"type": "nvidia"})
    result = await run_key_test("nvidia")
    assert result["error_type"] == "auth_error", result


@pytest.mark.parametrize("message", [
    "Forbidden: model nvidia/nemotron-3-ultra-550b-a55b is not available on your plan",
    "Your current plan does not include access to this model.",
    "Authorization failed for model nvidia/nemotron-3-ultra-550b-a55b",
    "Authorization failed: this model requires an NVIDIA AI Enterprise plan",
])
async def test_a_403_that_names_a_model_or_plan_stays_model_forbidden(nim, message):
    nim(_reply(403, {"error": {"message": message}}), saved={"type": "nvidia"})
    result = await run_key_test("nvidia")
    assert result["error_type"] == "model_forbidden", result
