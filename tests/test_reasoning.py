"""Provider contract, discovery, and request regression tests."""
import json
from pathlib import Path
import pytest
from andromity.core import effort
from andromity.core.reasoning import (
    ReasoningCapability, ReasoningMode, apply_reasoning_to_request,
    get_model_reasoning_capability, discover_model_reasoning_capability,
)

FIXTURES = Path(__file__).parent / "fixtures" / "effort"

@pytest.fixture(autouse=True)
def isolate_capabilities(monkeypatch):
    monkeypatch.setattr("andromity.core.models.get_cached_live_models", lambda provider: [])
    monkeypatch.setattr(effort, "_DISCOVERED", {})
    monkeypatch.setattr(effort, "_DOCS", {})


def metadata(values, **extra):
    return {"reasoning": {"supported_efforts": values, **extra}}


@pytest.mark.parametrize("model", ["o3-mini", "claude-future-sonnet", "gemini-future-thinking", "deepseek-r1", "auto"])
def test_unknown_model_names_never_invent_controls(model):
    cap = get_model_reasoning_capability("custom", model)
    assert cap.mode == ReasoningMode.UNKNOWN
    assert cap.supported_efforts == []
    assert apply_reasoning_to_request("custom", model, "high", {}) == {}


def test_live_allowlist_does_not_invent_off():
    cap = get_model_reasoning_capability("openrouter", "custom", metadata(["high", "low"], mandatory=False))
    assert cap.supported_efforts == ["high", "low"]
    assert cap.mode == ReasoningMode.CONFIGURABLE
    assert apply_reasoning_to_request("openrouter", "custom", "off", {}, cap) == {}


def test_none_alias_and_default_normalize_consistently():
    cap = get_model_reasoning_capability("openrouter", "custom", metadata(["high", "none"], default_effort="none"))
    assert cap.supported_efforts == ["high", "off"]
    assert cap.default_effort == "off"
    assert apply_reasoning_to_request("openrouter", "custom", "off", {}, cap)["extra_body"]["reasoning"] == {"effort": "none"}


@pytest.mark.parametrize("values", [None, []])
def test_missing_effort_allowlist_is_toggle_only(values):
    cap = get_model_reasoning_capability(
        "openrouter", "custom",
        metadata(values, mandatory=False, default_enabled=False),
    )
    assert cap.supported_efforts == ["on", "off"]
    assert cap.request_format == "openrouter_toggle"
    assert apply_reasoning_to_request("openrouter", "custom", "on", {}, cap)["extra_body"]["reasoning"] == {"enabled": True}
    assert apply_reasoning_to_request("openrouter", "custom", "off", {}, cap)["extra_body"]["reasoning"] == {"enabled": False}


def test_gemma_openrouter_metadata_does_not_invent_effort_levels():
    row = {
        "id": "google/gemma-4-31b-it:free",
        "supported_parameters": ["include_reasoning", "reasoning"],
        "reasoning": {"mandatory": False, "default_enabled": False},
    }
    cap = get_model_reasoning_capability("openrouter", row["id"], row)
    assert cap.supported_efforts == ["on", "off"]
    for unsupported in ["minimal", "low", "medium", "high", "xhigh", "max"]:
        assert unsupported not in cap.supported_efforts


def test_mandatory_removes_none_and_rejects_all_unsupported_efforts():
    cap = get_model_reasoning_capability("openrouter", "custom", metadata(["none", "high", "low"], mandatory=True, default_effort="high"))
    for value in ["off", "none", "xhigh", "bogus"]:
        request = apply_reasoning_to_request("openrouter", "custom", value, {}, cap)
        assert request["extra_body"]["reasoning"]["effort"] == "high"
    assert "off" not in cap.supported_efforts
    assert apply_reasoning_to_request("openrouter", "custom", None, {}, cap) == {}


def test_actual_public_openrouter_metadata_fixtures():
    for row in json.loads((FIXTURES / "openrouter.json").read_text()):
        cap = get_model_reasoning_capability("openrouter", row["id"], row)
        expected = effort._efforts(row["reasoning"]["supported_efforts"])
        if row["reasoning"].get("mandatory"):
            expected = [value for value in expected if value != "off"]
        assert cap.supported_efforts == expected
        for value in expected:
            request = apply_reasoning_to_request("openrouter", row["id"], value, {}, cap)
            assert request["extra_body"]["reasoning"]["effort"] == ("none" if value == "off" else value)


def test_request_uses_same_cached_metadata_as_picker(monkeypatch):
    row = {"id": "custom", **metadata(["xhigh", "low"])}
    monkeypatch.setattr("andromity.core.models.get_cached_live_models", lambda provider: [row])
    assert apply_reasoning_to_request("openrouter", "custom", "xhigh", {})["extra_body"]["reasoning"]["effort"] == "xhigh"


def test_unknown_strips_stale_controls_preserving_unrelated_body():
    request = {"thinking": {}, "reasoning_effort": "high", "output_config": {"effort": "high", "format": "json"},
               "extra_body": {"reasoning": {}, "provider": {"allow_fallbacks": True}, "generationConfig": {"thinkingConfig": {}, "temperature": 0.5}}}
    apply_reasoning_to_request("unknown", "custom", "high", request)
    assert "thinking" not in request and "reasoning_effort" not in request
    assert request["output_config"] == {"format": "json"}
    assert request["extra_body"] == {"provider": {"allow_fallbacks": True}, "generationConfig": {"temperature": 0.5}}


def test_openai_documentation_efforts_preserve_extra_levels_and_off():
    cap = effort.parse_openai_efforts("<p>Reasoning.effort supports: none, low, medium (default), high, xhigh, and max.</p>")
    assert cap.supported_efforts == ["off", "low", "medium", "high", "xhigh", "max"]
    for value in cap.supported_efforts:
        assert apply_reasoning_to_request("openai", "custom", value, {}, cap)["reasoning_effort"] == ("none" if value == "off" else value)
    assert cap.default_effort == "medium"


def test_openai_changed_docs_fail_to_provider_default():
    assert effort.parse_openai_efforts("<script>Reasoning.effort supports: high.</script>").mode == ReasoningMode.UNKNOWN


@pytest.mark.parametrize("model,values", [
    ("gemini-3.5-flash", ["minimal", "low", "medium", "high"]),
    ("gemini-3.1-pro-preview", ["low", "medium", "high"]),
    ("gemini-3.8-flash", ["low", "medium", "high"]),
    ("gemini-3.1-flash-lite-image", ["minimal", "high"]),
])
def test_google_live_documentation_levels(model, values):
    cap = effort.parse_google_efforts((FIXTURES / "google.html").read_text(encoding="utf-8"), model)
    assert cap.supported_efforts == values
    assert cap.is_mandatory
    for value in values:
        request = apply_reasoning_to_request("google", model, value, {}, cap)
        assert request["extra_body"]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": value}


@pytest.mark.parametrize("model,off_allowed,minimum,maximum", [
    ("gemini-2.5-pro", False, 128, 32768),
    ("gemini-2.5-flash", True, 0, 24576),
])
def test_google_budget_ranges_and_off(model, off_allowed, minimum, maximum):
    cap = effort.parse_google_efforts((FIXTURES / "google.html").read_text(encoding="utf-8"), model)
    assert ("off" in cap.supported_efforts) is off_allowed
    assert (cap.budget_min, cap.budget_max) == (minimum, maximum)
    for budget in [minimum, maximum]:
        request = apply_reasoning_to_request("google", model, f"budget:{budget}", {}, cap)
        assert request["extra_body"]["generationConfig"]["thinkingConfig"] == {"thinkingBudget": budget}
    for invalid in [f"budget:{maximum+1}", "budget:-2", "budget:no", "high"]:
        assert apply_reasoning_to_request("google", model, invalid, {}, cap) == {}
    request = apply_reasoning_to_request("google", model, "dynamic", {}, cap)
    assert request["extra_body"]["generationConfig"]["thinkingConfig"] == {"thinkingBudget": -1}
    request = apply_reasoning_to_request("google", model, "off", {}, cap)
    assert bool(request) is off_allowed


def test_anthropic_live_effort_flags_and_adaptive_request():
    row = {"capabilities": {"effort": {"supported": True, "low": {"supported": True}, "xhigh": {"supported": True}, "max": {"supported": False}},
                            "thinking": {"supported": True, "types": {"adaptive": {"supported": True}}}}}
    cap = get_model_reasoning_capability("anthropic", "future", row)
    assert cap.supported_efforts == ["low", "xhigh"]
    request = apply_reasoning_to_request("anthropic", "future", "xhigh", {}, cap)
    assert request["output_config"] == {"effort": "xhigh"}
    assert request["thinking"] == {"type": "adaptive"}
    assert apply_reasoning_to_request("anthropic", "future", "off", {}, cap) == {}


def test_anthropic_manual_thinking_has_budget_not_fake_efforts():
    row = {"max_tokens": 8192, "capabilities": {"thinking": {"supported": True, "types": {"enabled": {"supported": True}, "disabled": {"supported": True}}}}}
    cap = get_model_reasoning_capability("anthropic", "manual", row)
    assert cap.supported_efforts == ["on", "off"]
    request = apply_reasoning_to_request("anthropic", "manual", "budget:2048", {}, cap)
    assert request["thinking"] == {"type": "enabled", "budget_tokens": 2048}
    assert request["max_tokens"] > 2048
    assert apply_reasoning_to_request("anthropic", "manual", "off", {}, cap)["thinking"] == {"type": "disabled"}


def test_discovery_and_negative_cache_avoid_repeated_network(monkeypatch):
    calls = []
    def fetch(url):
        calls.append(url)
        raise OSError("offline")
    monkeypatch.setattr(effort, "_fetch_document", fetch)
    for _ in range(3):
        assert discover_model_reasoning_capability("openai", "custom").mode == ReasoningMode.UNKNOWN
    assert len(calls) == 1


def test_official_discovery_shared_with_request(monkeypatch):
    monkeypatch.setattr(effort, "_fetch_document", lambda url: "<p>Reasoning.effort supports: low, high (default).</p>")
    cap = discover_model_reasoning_capability("openai", "custom")
    assert cap.supported_efforts == ["low", "high"]
    assert get_model_reasoning_capability("openai", "custom") == cap
    assert apply_reasoning_to_request("openai", "custom", "off", {}) == {"reasoning_effort": "high"}


def test_google_litellm_preserves_native_config():
    from litellm.llms.vertex_ai.gemini.transformation import _pop_and_merge_extra_body
    request = {"generationConfig": {"maxOutputTokens": 100}}
    optional = {"extra_body": {"generationConfig": {"thinkingConfig": {"thinkingLevel": "minimal"}}}}
    _pop_and_merge_extra_body(request, optional)
    assert request["generationConfig"] == {"maxOutputTokens": 100, "thinkingConfig": {"thinkingLevel": "minimal"}}


@pytest.mark.parametrize("provider", ["anthropic", "openrouter"])
def test_provider_discovery_reads_actual_metadata(provider, monkeypatch):
    import io
    from andromity.config import config
    monkeypatch.setattr(config, "get_api_key", lambda name: "test-key")
    if provider == "openrouter":
        monkeypatch.setattr("andromity.core.models.fetch_live_models_sync", lambda *args, **kwargs: [
            {"id": "custom", **metadata(["low", "xhigh"], mandatory=True)}])
    else:
        row = {"capabilities": {"effort": {"supported": True, "low": {"supported": True}, "xhigh": {"supported": True}},
                                "thinking": {"supported": True, "types": {"adaptive": {"supported": True}}}}}
        def fetch(request, **kwargs):
            assert request.full_url == "https://api.anthropic.com/v1/models/custom"
            assert request.get_header("X-api-key") == "test-key"
            return io.BytesIO(json.dumps(row).encode())
        monkeypatch.setattr(effort, "urlopen", fetch)
    cap = discover_model_reasoning_capability(provider, "custom")
    assert cap.supported_efforts == ["low", "xhigh"]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,model,value,body_key", [
    ("openrouter", "custom", "xhigh", "extra_body"),
    ("openai", "custom", "max", "reasoning_effort"),
    ("google", "custom", "minimal", "extra_body"),
    ("anthropic", "custom", "xhigh", "thinking"),
])
async def test_stream_request_uses_discovered_capability(provider, model, value, body_key, monkeypatch):
    import litellm
    from types import SimpleNamespace
    from andromity.core.provider import stream_completion
    from andromity.config import config
    formats = {"openrouter": "openrouter", "openai": "openai", "google": "google_level", "anthropic": "anthropic_adaptive"}
    cap = ReasoningCapability(ReasoningMode.CONFIGURABLE, supported_efforts=[value], request_format=formats[provider])
    monkeypatch.setattr("andromity.core.reasoning.discover_model_reasoning_capability", lambda *args: cap)
    monkeypatch.setattr(config, "get_api_key", lambda name: None)
    monkeypatch.setattr(config, "get_provider_config", lambda name: {})
    calls = []
    async def completion(**kwargs):
        calls.append(kwargs)
        async def chunks():
            yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="done", tool_calls=None), finish_reason="stop")], usage=None)
        return chunks()
    monkeypatch.setattr(litellm, "acompletion", completion)
    events = [event async for event in stream_completion([{ "role": "user", "content": "ping" }], provider_name=provider, model=model, reasoning_effort=value)]
    assert calls and body_key in calls[0]
    assert any(type(event).__name__ == "Done" for event in events)
    if provider == "openrouter":
        assert calls[0]["extra_body"]["provider"]["allow_fallbacks"] is True
        assert calls[0]["extra_body"]["reasoning"]["effort"] == value
    elif provider == "openai":
        assert calls[0]["reasoning_effort"] == value
    elif provider == "google":
        assert calls[0]["extra_body"]["generationConfig"]["thinkingConfig"]["thinkingLevel"] == value
    else:
        assert calls[0]["output_config"]["effort"] == value


@pytest.mark.parametrize("model,off,mandatory", [
    ("claude-opus-5.5", False, True),
    ("claude-sonnet-5.5", False, True),
    ("claude-sonnet-5", True, False),
    ("claude-opus-5", True, False),
    ("claude-opus-4-6", True, False),
])
def test_anthropic_off_rules_from_live_official_table(model, off, mandatory):
    cap = ReasoningCapability(ReasoningMode.CONFIGURABLE, supported_efforts=["low", "high", "xhigh", "max"], request_format="anthropic_adaptive")
    cap = effort.enrich_anthropic_capability((FIXTURES / "anthropic.html").read_text(encoding="utf-8"), model, cap)
    assert ("off" in cap.supported_efforts) is off
    assert cap.is_mandatory is mandatory
    request = apply_reasoning_to_request("anthropic", model, "off", {}, cap)
    assert bool(request) is off
    if model == "claude-opus-5":
        assert request["output_config"] == {"effort": "high"}


def test_refresh_invalidates_discovered_capabilities():
    cap = ReasoningCapability(ReasoningMode.CONFIGURABLE, supported_efforts=["high"])
    effort._DISCOVERED[("openai", "custom")] = (effort.time.monotonic(), cap)
    assert get_model_reasoning_capability("openai", "custom") == cap
    effort.invalidate_reasoning_capabilities("openai")
    assert get_model_reasoning_capability("openai", "custom").mode == ReasoningMode.UNKNOWN
