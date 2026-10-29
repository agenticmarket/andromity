"""Adversarial tests for the key-test review fixes: cheap probe models, 403/404 wording, masked keys,
terminal markup, engine capabilities and one refresh per provider. All provider calls are mocked."""
import asyncio
import json
import threading

import litellm
import pytest

from andromity.config import config
from andromity.core import connections
from andromity.core import provider as provider_mod
from andromity.core.effort import ReasoningCapability, ReasoningMode
from andromity.core.events import Done, TextDelta
from andromity.server import rpc_handler as rpc
from andromity.server.rpc_handler import JsonRpcHandler
from tests.test_keys_catalog_adversarial import (  # noqa: F401  (fixtures are used by name)
    CUSTOM_KEY, FAKE_ANTHROPIC, FAKE_GROQ, FAKE_OPENAI, GROQ_MODELS, _offline, fake_http, live_cache, providers, sleeps,
)


def ids_live(*items):
    return [dict(item) if isinstance(item, dict) else {"id": item} for item in items]


# ── Which model a key test uses: cheap, and confirmed by the live list ────────────────────


def test_probe_prefers_a_small_model_the_live_list_confirms(monkeypatch):
    live_cache(monkeypatch, {"anthropic": ids_live("claude-opus-5", "claude-haiku-4-5-20251001", "claude-sonnet-5")})
    assert connections.probe_model_for("anthropic") == "claude-haiku-4-5-20251001"


def test_probe_prefers_a_small_model_over_a_cheaper_priced_one(monkeypatch):
    live_cache(monkeypatch, {"openai": ids_live("gpt-5.6-sol", "gpt-5.6-luna", "o4-mini")})
    assert connections.probe_model_for("openai") == "o4-mini"


def test_probe_prefers_a_free_model_over_priced_ones(monkeypatch):
    live_cache(monkeypatch, {"openrouter": [
        {"id": "anthropic/claude-3.7-sonnet", "pricing": "$3/$15 per MTok"},
        {"id": "openai/gpt-4o", "pricing": "$2.50/$10 per MTok"},
        {"id": "meta-llama/llama-3.3-70b-instruct", "is_free": True},
    ]})
    assert connections.probe_model_for("openrouter") == "meta-llama/llama-3.3-70b-instruct"


def test_probe_takes_the_cheapest_listed_price_when_nothing_is_small(monkeypatch):
    live_cache(monkeypatch, {"openai": ids_live("gpt-5.6-sol", "gpt-4.1", "gpt-5.6-luna")})
    assert connections.probe_model_for("openai") == "gpt-5.6-luna"


def test_probe_never_picks_an_unconfirmed_model_over_a_confirmed_one(monkeypatch):
    live_cache(monkeypatch, {"openai": ids_live("gpt-nano-unlisted-preview", "gpt-5.6-sol")})
    assert connections.probe_model_for("openai") == "gpt-5.6-sol"


def test_probe_with_a_stale_catalog_picks_a_flash_model_not_a_pro_one(monkeypatch):
    live_cache(monkeypatch, {"google": ids_live("gemini-9-pro-preview", "gemini-9-flash", "gemini-9-flash-lite")})
    chosen = connections.probe_model_for("google")
    assert "flash" in chosen, f"{chosen!r}: 'gemini' contains 'mini', so every Gemini model looks small"


def test_probe_survives_malformed_pricing_and_tags(monkeypatch):
    live_cache(monkeypatch, {"groq": [
        {"id": "groq-a", "pricing": 12, "tags": "free"},
        {"id": "groq-b", "pricing": None, "tags": [None, 3, "fast"]},
        {"id": "groq-c", "pricing": "$ abc", "is_free": "yes"},
    ]})
    assert connections.probe_model_for("groq") in {"groq-a", "groq-b", "groq-c"}


def test_own_model_still_wins_over_a_cheaper_one(monkeypatch):
    providers({"name": "anthropic", "api_key": FAKE_ANTHROPIC, "model": "claude-opus-5"})
    live_cache(monkeypatch, {"anthropic": ids_live("claude-haiku-4-5-20251001")})
    assert connections.probe_model_for("anthropic") == "claude-opus-5"


# ── Built-in probes are capped; empty replies; 403/404 wording ──────────────────────────────


def recording_stream(monkeypatch, events):
    seen = []

    async def stream(messages, **kwargs):
        seen.append(kwargs)
        for event in events:
            yield event

    monkeypatch.setattr(provider_mod, "stream_completion", stream)
    return seen


async def test_builtin_probe_caps_tokens_and_reasoning_but_custom_does_not(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ},
              {"name": "selfhost", "type": "openai", "base_url": "http://localhost:8000/v1", "model": "m1"})
    seen = recording_stream(monkeypatch, [TextDelta(text="OK"), Done()])
    await connections.test_connection("groq", "llama-3.1-8b-instant")
    await connections.test_connection("selfhost")
    assert seen[0]["max_tokens"] == 16 and seen[0]["least_reasoning"] is True
    assert "max_tokens" not in seen[1] and "least_reasoning" not in seen[1]


@pytest.mark.parametrize("efforts,expected", [
    (["minimal", "low", "medium", "high"], "minimal"),
    (["low", "medium", "high"], "low"),
    (["off", "low", "high"], "none"),
])
async def test_probe_request_sends_max_tokens_and_the_least_effort(monkeypatch, efforts, expected):
    from andromity.core import reasoning
    providers({"name": "openai", "api_key": FAKE_OPENAI})
    monkeypatch.setattr(reasoning, "discover_model_reasoning_capability", lambda p, m: ReasoningCapability(
        ReasoningMode.CONFIGURABLE, supported_efforts=efforts, request_format="openai"))
    sent = []

    async def acompletion(**kwargs):
        sent.append(kwargs)
        raise litellm.AuthenticationError(message="Incorrect API key provided", model="gpt-x", llm_provider="openai")

    monkeypatch.setattr(litellm, "acompletion", acompletion)
    result = await connections.test_connection("openai", "gpt-x")
    assert sent[0]["max_tokens"] == 16
    assert sent[0]["reasoning_effort"] == expected
    assert result["error_type"] == "auth_error"


async def test_chat_requests_are_not_capped(monkeypatch, sleeps):
    providers({"name": "openai", "api_key": FAKE_OPENAI})
    sent = []

    async def acompletion(**kwargs):
        sent.append(kwargs)
        raise litellm.AuthenticationError(message="Incorrect API key provided", model="gpt-x", llm_provider="openai")

    monkeypatch.setattr(litellm, "acompletion", acompletion)
    [e async for e in provider_mod.stream_completion([{"role": "user", "content": "hi"}], provider_name="openai", model="gpt-x")]
    assert "max_tokens" not in sent[0]


async def test_empty_completed_reply_passes_for_builtin_but_not_for_custom(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ},
              {"name": "selfhost", "type": "openai", "base_url": "http://localhost:8000/v1", "model": "m1"})
    recording_stream(monkeypatch, [Done()])
    assert (await connections.test_connection("groq", "llama-3.1-8b-instant"))["success"] is True
    assert (await connections.test_connection("selfhost"))["error_type"] == "empty_response"


async def test_unfinished_stream_still_fails_for_builtin(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ})
    recording_stream(monkeypatch, [TextDelta(text="O")])
    assert (await connections.test_connection("groq", "llama-3.1-8b-instant"))["error_type"] == "incomplete_stream"


@pytest.mark.parametrize("status,detail,expected", [
    (401, "Unauthorized", "auth_error"),
    (403, "Incorrect API key provided. You can find your API key at the dashboard.", "auth_error"),
    (403, "API key expired. Please renew the API key.", "auth_error"),
    (403, "The API key provided is not valid.", "auth_error"),
    (403, "Your API key does not have permission to use the specified resource.", "model_forbidden"),
    (403, "Project proj_x does not have access to model gpt-5.6-sol", "model_forbidden"),
    (403, "", "model_forbidden"),
    (404, "The model gpt-x does not exist or you do not have access to it.", "model_not_found"),
])
async def test_403_says_key_rejected_only_when_the_key_is_bad(monkeypatch, status, detail, expected):
    providers({"name": "openai", "api_key": FAKE_OPENAI})
    recording_stream(monkeypatch, [Done(outcome="error", error_type="auth_error" if status != 404 else "generic",
                                        error_detail=detail, error_status=status)])
    result = await connections.test_connection("openai", "gpt-x")
    assert result["error_type"] == expected, result


async def test_403_from_a_raised_error_uses_the_same_rule(monkeypatch, sleeps):
    providers({"name": "openai", "api_key": FAKE_OPENAI})

    async def acompletion(**kwargs):
        raise litellm.PermissionDeniedError(message="Project does not have access to model gpt-x", model="gpt-x",
                                            llm_provider="openai", response=__import__("httpx").Response(
                                                403, request=__import__("httpx").Request("POST", "https://api.openai.com")))

    monkeypatch.setattr(litellm, "acompletion", acompletion)
    result = await connections.test_connection("openai", "gpt-x")
    assert result["error_type"] == "model_forbidden"
    assert "cannot use the selected model" in result["message"]


# ── Masked keys and the bracket-free placeholder ───────────────────────────────────────────


@pytest.mark.parametrize("text,leak", [
    ("Incorrect API key provided: sk-proj-********************************abcd. You can find your API key at x.", "abcd"),
    ("key ending in ****Zq9X was revoked", "Zq9X"),
    ("token ***4f2a1b expired", "4f2a1b"),
])
def test_masked_key_endings_are_redacted(text, leak):
    detail = provider_mod.short_error_detail(RuntimeError(text))
    assert leak not in detail, detail
    assert "[" not in detail and "•••" in detail


async def test_probe_detail_has_no_markup_brackets(monkeypatch, sleeps):
    providers({"name": "selfhost", "type": "openai", "base_url": "http://localhost:8000/v1", "model": "m1", "api_key": CUSTOM_KEY})

    async def acompletion(**kwargs):
        raise litellm.BadRequestError(message=f"credential {CUSTOM_KEY} rejected, Bearer abc.def", model="m1", llm_provider="openai")

    monkeypatch.setattr(litellm, "acompletion", acompletion)
    result = await connections.test_connection("selfhost")
    assert CUSTOM_KEY not in json.dumps(result)
    assert "[redacted]" not in result["detail"] and "•••" in result["detail"]


# ── Terminal connection overlay renders provider text as text ──────────────────────────────


HOSTILE = "Connection failed: [link=https://evil.example/steal]Click to fix[/link] [b]urgent[/b] [@click=app.quit]x[/]"
TRUNCATED = "Connection failed: upstream rejected the request body near [/v1/chat/completio…"


def _status_after(monkeypatch, run):
    from textual.app import App
    from textual.content import Content
    from textual.widgets import Static
    from andromity.tui.overlays.connection import ProviderConnectionScreen

    class Host(App):
        pass

    out = {}

    async def scenario():
        app = Host()
        async with app.run_test(size=(100, 40)) as pilot:
            screen = ProviderConnectionScreen("selfhost")
            app.push_screen(screen)
            await pilot.pause()
            await run(screen)
            await pilot.pause()
            raw = str(screen.query_one("#connection-status", Static).content)
            out["content"] = Content.from_markup(raw)

    asyncio.run(scenario())
    return out["content"]


def test_terminal_shows_provider_test_message_without_markup(monkeypatch):
    async def fake_test(provider, model=""):
        return {"success": False, "message": HOSTILE}

    monkeypatch.setattr(connections, "test_connection", fake_test)
    content = _status_after(monkeypatch, lambda screen: screen._test())
    assert content.plain == HOSTILE
    assert not any("link" in str(span.style) for span in content.spans)


def test_terminal_shows_a_truncated_provider_message_instead_of_a_generic_failure(monkeypatch):
    async def fake_test(provider, model=""):
        return {"success": False, "message": TRUNCATED}

    monkeypatch.setattr(connections, "test_connection", fake_test)
    content = _status_after(monkeypatch, lambda screen: screen._test())
    assert content.plain == TRUNCATED, "an unclosed [/ tag is not escaped, so the overlay hides the provider's reason"


def test_terminal_shows_save_errors_without_markup(monkeypatch):
    from textual.widgets import Button

    def reject(values):
        raise ValueError(HOSTILE)

    monkeypatch.setattr(config, "save_provider", reject)

    async def press(screen):
        screen.on_button_pressed(Button.Pressed(screen.query_one("#connection-save", Button)))

    content = _status_after(monkeypatch, press)
    assert content.plain == HOSTILE
    assert not any("link" in str(span.style) for span in content.spans)


# ── config.capabilities and the refresh RPC ────────────────────────────────────────────────


async def test_capabilities_rpc_advertises_key_tests():
    response = await JsonRpcHandler().handle_request(rpc.JsonRpcRequest(id=1, method="config.capabilities", params=None))
    assert response.error is None
    assert response.result["key_tests"] is True and response.result["provider_model_refresh"] is True


async def test_refresh_stays_under_the_client_timeout_and_lists_without_discovery(monkeypatch):
    providers({"name": "openai", "type": "openai", "base_url": "https://llm.internal.example/v1", "api_key": FAKE_OPENAI})
    fetches = []

    def fetch(provider, *args, status=None, **kwargs):
        fetches.append(provider)
        if status is not None:
            status.setdefault("error", "timeout")
        return []

    monkeypatch.setattr(rpc, "fetch_live_models_sync", fetch)
    timeouts = []
    real_wait_for = asyncio.wait_for

    async def record(awaitable, timeout):
        timeouts.append(timeout)
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr(rpc.asyncio, "wait_for", record)
    reply = await JsonRpcHandler().rpc_config_refresh_provider_models({"provider": "openai"})
    assert fetches == ["openai"], "the listing after a refresh must not fetch again"
    assert timeouts and timeouts[0] <= 7 and sum(timeouts) < 12, timeouts
    assert reply["ok"] is False and reply["message"] == "Couldn't reach provider."


async def test_concurrent_refreshes_of_one_provider_share_one_fetch(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ}, {"name": "deepseek", "api_key": "sk-test-FAKEdeepseek000000"})
    release = threading.Event()
    seen = fake_http(monkeypatch, lambda url, headers: (release.wait(5), GROQ_MODELS if "groq" in url else {"data": [{"id": "deepseek-chat"}]})[1])
    handler = JsonRpcHandler()
    calls = [asyncio.ensure_future(handler.rpc_config_refresh_provider_models({"provider": p})) for p in ("groq", "groq", "deepseek", "groq")]
    await asyncio.sleep(0.2)
    release.set()
    replies = await asyncio.gather(*calls)
    urls = [url for url, _ in seen]
    assert urls.count("https://api.groq.com/openai/v1/models") == 1
    assert len(urls) == 2
    assert [r["provider"] for r in replies] == ["groq", "groq", "deepseek", "groq"]
    assert replies[0] == replies[1] == replies[3] and replies[0]["ok"] is True

    again = await handler.rpc_config_refresh_provider_models({"provider": "groq"})
    assert again["ok"] is True
    assert [url for url, _ in seen].count("https://api.groq.com/openai/v1/models") == 2, "a finished refresh must not be reused"


async def test_a_caller_that_gives_up_does_not_cancel_the_shared_refresh(monkeypatch):
    providers({"name": "groq", "api_key": FAKE_GROQ})
    release = threading.Event()
    fake_http(monkeypatch, lambda url, headers: (release.wait(5), GROQ_MODELS)[1])
    handler = JsonRpcHandler()
    first = asyncio.ensure_future(handler.rpc_config_refresh_provider_models({"provider": "groq"}))
    second = asyncio.ensure_future(handler.rpc_config_refresh_provider_models({"provider": "groq"}))
    await asyncio.sleep(0.1)
    first.cancel()
    release.set()
    assert (await second)["ok"] is True
    assert handler._model_refreshes == {}


async def test_refresh_after_a_key_change_does_not_reuse_the_old_keys_result(monkeypatch):
    providers({"name": "groq", "api_key": "gsk_OLDfake0000FAKEfake0000ab"})
    release = threading.Event()

    def reply(url, headers):
        if headers.get("authorization", "").endswith("OLDfake0000FAKEfake0000ab"):
            release.wait(5)
            return __import__("urllib.error").error.HTTPError(url, 401, "Unauthorized", {}, None)
        return GROQ_MODELS

    seen = fake_http(monkeypatch, reply)
    handler = JsonRpcHandler()
    old = asyncio.ensure_future(handler.rpc_config_refresh_provider_models({"provider": "groq"}))
    await asyncio.sleep(0.1)
    providers({"name": "groq", "api_key": FAKE_GROQ})
    new = asyncio.ensure_future(handler.rpc_config_refresh_provider_models({"provider": "groq"}))
    await asyncio.sleep(0.1)
    release.set()
    old_reply, new_reply = await asyncio.gather(old, new)
    assert old_reply["error_type"] == "auth_error"
    assert new_reply["ok"] is True, "the refresh for the newly saved key reported the old key's 'Key rejected.'"
    assert any(h.get("authorization") == f"Bearer {FAKE_GROQ}" for _, h in seen)
