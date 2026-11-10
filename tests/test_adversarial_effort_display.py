"""Independent adversarial tests for the thinking-display changes in effort.py (thinks_by_default,
summarized display, auto handling). Written to break the new behaviour, not to pass. No network."""
import asyncio
import functools
import json
import subprocess
import sys
import types
from pathlib import Path

import litellm
import pytest

import andromity.core.provider as provider_mod
import andromity.core.reasoning as reasoning_mod
from andromity.core import effort
from andromity.core.effort import (
    ReasoningCapability, ReasoningMode, apply_reasoning_to_request, enrich_anthropic_capability,
)

FIXTURES = Path(__file__).parent / "fixtures" / "effort"
ANTHROPIC_DOC = (FIXTURES / "anthropic.html").read_text(encoding="utf-8")
SUMMARIZED = {"type": "adaptive", "display": "summarized"}
ALL_EFFORTS = ("low", "medium", "high", "xhigh", "max")

# Model name -> does the "No thinking field" column of tests/fixtures/effort/anthropic.html say
# the model thinks adaptively when no thinking field is sent.
THINKS = {
    "claude-opus-5-5": True, "claude-sonnet-5-5": True, "claude-fable-5-1": True,
    "claude-mythos-5-1": True, "claude-fable-5": True, "claude-mythos-5": True,
    "claude-opus-5": True, "claude-sonnet-5": True, "claude-mythos-preview": True,
    "claude-opus-4-8": False, "claude-opus-4-7": False, "claude-opus-4-6": False,
    "claude-sonnet-4-6": False, "claude-opus-4-5": False, "claude-sonnet-4-5": False,
    "claude-haiku-4-5": False,
}
ADAPTIVE_MODELS = [m for m in THINKS if m not in ("claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5")]


@pytest.fixture(autouse=True)
def _isolate_effort(monkeypatch):
    monkeypatch.setattr("andromity.core.models.get_cached_live_models", lambda provider: [])
    monkeypatch.setattr(effort, "_DISCOVERED", {})
    monkeypatch.setattr(effort, "_DOCS", {})


def adaptive_cap(efforts=ALL_EFFORTS, **kwargs) -> ReasoningCapability:
    return ReasoningCapability(ReasoningMode.CONFIGURABLE, supported_efforts=list(efforts),
                               request_format="anthropic_adaptive", **kwargs)


def enriched(model: str, html: str = ANTHROPIC_DOC, cap=None) -> ReasoningCapability:
    return enrich_anthropic_capability(html, model, cap or adaptive_cap())


def table(headers, rows) -> str:
    def cells(tag, values):
        return "<tr>" + "".join(f"<{tag}>{v}</{tag}>" for v in values) + "</tr>"
    return ("<html><body><table>" + cells("th", headers) + "".join(cells("td", row) for row in rows)
            + "</table></body></html>")


def has_display_on_bad_type(kwargs) -> bool:
    thinking = kwargs.get("thinking")
    return (isinstance(thinking, dict) and "display" in thinking
            and thinking.get("type") in ("disabled", "between_tools", "enabled"))


# --------------------------------------------------------------------------------------
# A. effort.py
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("model,expected", sorted(THINKS.items()))
def test_a_thinks_by_default_matches_docs_table(model, expected):
    assert enriched(model).thinks_by_default is expected


@pytest.mark.parametrize("model,expected", sorted(THINKS.items()))
def test_a_auto_sends_adaptive_only_for_models_that_think_by_default(model, expected):
    cap = enriched(model)
    for effort_value in ("auto", None, "AUTO", "  auto  ", ""):
        kwargs = apply_reasoning_to_request("anthropic", model, effort_value, {}, cap)
        if expected and cap.request_format == "anthropic_adaptive":
            assert kwargs.get("thinking") == SUMMARIZED, (model, effort_value, kwargs)
        else:
            assert "thinking" not in kwargs, (model, effort_value, kwargs)
        assert "output_config" not in kwargs, "auto must not pin an effort"


@pytest.mark.parametrize("model", ADAPTIVE_MODELS)
def test_a_explicit_effort_sends_summarized_adaptive_and_effort(model):
    cap = enriched(model)
    for value in cap.supported_efforts:
        if value == "off":
            continue
        kwargs = apply_reasoning_to_request("anthropic", model, value, {}, cap)
        assert kwargs["thinking"] == SUMMARIZED
        assert kwargs["output_config"]["effort"] == value


@pytest.mark.parametrize("model", sorted(THINKS))
def test_a_display_is_never_combined_with_disabled_enabled_or_between_tools(model):
    cap = enriched(model)
    for value in (*ALL_EFFORTS, "off", "none", "on", "auto", "bogus", "budget:2048", "budget:0"):
        kwargs = apply_reasoning_to_request("anthropic", model, value, {}, cap)
        assert not has_display_on_bad_type(kwargs), (model, value, kwargs)
        thinking = kwargs.get("thinking")
        if isinstance(thinking, dict) and thinking.get("type") == "disabled":
            assert thinking == {"type": "disabled"}, (model, value, kwargs)
        if isinstance(thinking, dict) and "display" in thinking:
            assert thinking["type"] == "adaptive" and thinking["display"] == "summarized"


@pytest.mark.parametrize("model", [m for m, thinks in THINKS.items() if not thinks and m in ADAPTIVE_MODELS])
def test_a_off_disables_without_display_on_models_that_allow_it(model):
    cap = enriched(model)
    assert "off" in cap.supported_efforts
    kwargs = apply_reasoning_to_request("anthropic", model, "off", {}, cap)
    assert kwargs["thinking"] == {"type": "disabled"}
    assert "display" not in json.dumps(kwargs)


@pytest.mark.parametrize("model", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1"])
def test_a_off_on_mandatory_thinking_models_never_emits_disabled(model):
    cap = enriched(model)
    assert cap.is_mandatory and "off" not in cap.supported_efforts
    for value in ("off", "none"):
        kwargs = apply_reasoning_to_request("anthropic", model, value, {}, cap)
        assert kwargs.get("thinking") != {"type": "disabled"}
        assert not has_display_on_bad_type(kwargs)
        assert kwargs.get("thinking") == SUMMARIZED


def test_a_off_effort_condition_is_kept_without_display():
    cap = enriched("claude-opus-5")
    assert cap.off_effort == "high" and "off" in cap.supported_efforts and cap.thinks_by_default
    kwargs = apply_reasoning_to_request("anthropic", "claude-opus-5", "off", {}, cap)
    assert kwargs == {"thinking": {"type": "disabled"}, "output_config": {"effort": "high"}}


@pytest.mark.parametrize("model", ["claude-opus-4-8", "claude-opus-5-5"])
def test_a_unsupported_effort_falls_back_like_auto(model):
    cap = enriched(model, cap=adaptive_cap(("low", "high")))
    for bogus in ("max", "ultra", "xhigh", "nonsense", "budget:99", "ON"):
        kwargs = apply_reasoning_to_request("anthropic", model, bogus, {}, cap)
        if cap.thinks_by_default:
            assert kwargs.get("thinking") == SUMMARIZED
        else:
            assert "thinking" not in kwargs
        assert "output_config" not in kwargs


def test_a_unsupported_effort_with_pinned_default_effort_still_has_display():
    cap = enriched("claude-opus-4-8", cap=adaptive_cap(("low", "high"), default_effort="high"))
    kwargs = apply_reasoning_to_request("anthropic", "claude-opus-4-8", "max", {}, cap)
    assert kwargs == {"thinking": SUMMARIZED, "output_config": {"effort": "high"}}


@pytest.mark.parametrize("stale", [
    {"thinking": {"type": "enabled", "budget_tokens": 5000}},
    {"thinking": {"type": "adaptive", "display": "summarized"}},
    {"thinking": {"type": "adaptive", "display": "omitted"}},
    {"thinking": {"type": "disabled", "display": "summarized"}},
    {"thinking": {"type": "between_tools"}},
    {"thinking": "garbage"},
    {"thinking": None},
    {"extra_body": {"thinking": {"type": "adaptive", "display": "summarized"}}},
    {"extra_body": {"reasoning": {"effort": "high"}, "thinking": {"type": "enabled"}}},
    {"output_config": {"effort": "max"}},
    {"output_config": {"effort": "max", "format": {"type": "json_schema"}}},
    {"reasoning_effort": "high", "reasoning": {"x": 1}, "thinking_level": "high"},
])
@pytest.mark.parametrize("model", ["claude-opus-4-8", "claude-sonnet-5-5"])
def test_a_stale_kwargs_never_survive_into_the_request(stale, model):
    cap = enriched(model)
    for value in ("auto", "off", "high"):
        kwargs = json.loads(json.dumps(stale))
        out = apply_reasoning_to_request("anthropic", model, value, kwargs, cap)
        fresh = apply_reasoning_to_request("anthropic", model, value, {}, cap)
        thinking = out.get("thinking")
        assert thinking == fresh.get("thinking"), (stale, value, out)
        assert not has_display_on_bad_type(out)
        assert out.get("output_config", {}).get("effort") == fresh.get("output_config", {}).get("effort")
        assert "reasoning_effort" not in out and "thinking_level" not in out
        assert "thinking" not in out.get("extra_body", {})


def test_a_unrelated_output_config_keys_survive():
    cap = enriched("claude-opus-4-8")
    kwargs = {"output_config": {"effort": "max", "format": {"type": "json_schema"}}}
    out = apply_reasoning_to_request("anthropic", "claude-opus-4-8", "auto", kwargs, cap)
    assert out["output_config"] == {"format": {"type": "json_schema"}}


@pytest.mark.parametrize("mode", [ReasoningMode.NONE, ReasoningMode.UNKNOWN])
def test_a_none_and_unknown_capability_never_send_thinking_even_if_flagged(mode):
    cap = ReasoningCapability(mode, supported_efforts=["high"], request_format="anthropic_adaptive",
                              thinks_by_default=True)
    for value in ("auto", "high", "off", None):
        assert apply_reasoning_to_request("anthropic", "claude-x", value, {"thinking": SUMMARIZED}, cap) == {}


@pytest.mark.parametrize("request_format", ["anthropic_budget", "openai", "google_level", "google_budget",
                                            "openrouter", "openrouter_toggle", "", "anthropic"])
def test_a_thinks_by_default_alone_never_adds_thinking_outside_adaptive_format(request_format):
    cap = ReasoningCapability(ReasoningMode.CONFIGURABLE, supported_efforts=["low", "high"],
                              request_format=request_format, thinks_by_default=True)
    out = apply_reasoning_to_request("anthropic", "claude-x", "auto", {}, cap)
    assert "thinking" not in out


def test_a_budget_format_is_unchanged_from_dev():
    old = _old_effort()
    for provider, fmt, efforts in [
        ("anthropic", "anthropic_budget", ["on", "off"]),
        ("anthropic", "anthropic_budget", ["low", "high", "off"]),
        ("openrouter", "openrouter_toggle", ["on", "off"]),
        ("openrouter", "openrouter", ["low", "high"]),
        ("google", "google_level", ["low", "high"]),
        ("google", "google_budget", ["dynamic", "off"]),
        ("openai", "openai", ["low", "high", "off"]),
        ("custom", "openai", ["low", "high"]),
        ("custom", "anthropic", ["low", "high"]),
    ]:
        for mode in (ReasoningMode.CONFIGURABLE, ReasoningMode.TOGGLEABLE, ReasoningMode.MANDATORY):
            extra = dict(supports_max_tokens=True, budget_min=1024, budget_max=64000)
            new_cap = ReasoningCapability(mode, supported_efforts=list(efforts), request_format=fmt, **extra)
            old_cap = old.ReasoningCapability(old.ReasoningMode(mode.value), supported_efforts=list(efforts),
                                              request_format=fmt, **extra)
            for value in (None, "auto", "off", "none", "on", "low", "high", "xhigh", "dynamic",
                          "budget:2048", "budget:0", "budget:999999", "budget:x", "bogus"):
                seed = {"max_tokens": 10, "extra_body": {"reasoning": {"enabled": True}}}
                new = apply_reasoning_to_request(provider, "m", value, json.loads(json.dumps(seed)), new_cap)
                was = old.apply_reasoning_to_request(provider, "m", value, json.loads(json.dumps(seed)), old_cap)
                if fmt == "openai" and provider != "openai" and "reasoning_effort" in new:
                    # Added after dev by "Send declared reasoning efforts to custom endpoints" (d9205f8).
                    assert new.pop("allowed_openai_params") == ["reasoning_effort"]
                assert new == was, (provider, fmt, mode, value, new, was)


def test_a_adaptive_format_differs_from_dev_only_by_display_and_auto_default():
    old = _old_effort()
    for model in ADAPTIVE_MODELS:
        cap = enriched(model)
        old_cap = old.ReasoningCapability(old.ReasoningMode(cap.mode.value), supported_efforts=list(cap.supported_efforts),
                                          request_format=cap.request_format, off_effort=cap.off_effort,
                                          is_mandatory=cap.is_mandatory)
        for value in (None, "auto", "off", "none", "low", "high", "max", "bogus"):
            new = apply_reasoning_to_request("anthropic", model, value, {}, cap)
            was = old.apply_reasoning_to_request("anthropic", model, value, {}, old_cap)
            if "thinking" in was and was["thinking"] == {"type": "adaptive"}:
                was["thinking"] = dict(SUMMARIZED)
            wanted = "off" if value == "none" else (value or "auto")
            falls_back_to_auto = wanted == "auto" or wanted not in cap.supported_efforts
            if falls_back_to_auto and cap.thinks_by_default and "thinking" not in was:
                was["thinking"] = dict(SUMMARIZED)
            assert new == was, (model, value, new, was)


@pytest.mark.parametrize("provider,fmt,efforts", [
    ("openrouter", "openrouter", ["low", "high"]), ("openrouter", "openrouter_toggle", ["on", "off"]),
    ("google", "google_level", ["low", "high"]), ("openai", "openai", ["low", "high", "off"]),
    ("my-custom", "openai", ["low", "high"]), ("my-custom", "anthropic", ["low", "high"]),
])
def test_a_other_providers_never_get_display(provider, fmt, efforts):
    cap = ReasoningCapability(ReasoningMode.CONFIGURABLE, supported_efforts=efforts, request_format=fmt,
                              thinks_by_default=True)
    for value in (None, "auto", "off", "low", "high", "on", "bogus"):
        out = apply_reasoning_to_request(provider, "m", value, {}, cap)
        assert "display" not in json.dumps(out), (provider, fmt, value, out)
        assert "thinking" not in out


@pytest.mark.parametrize("provider", ["openai", "google", "my-custom"])
def test_a_adaptive_cap_on_a_foreign_provider_name_behaves_like_dev_for_explicit_effort(provider):
    """Informational: apply_reasoning_to_request keys off request_format, not the provider name, so an
    adaptive capability cached under another provider's key already produced Anthropic fields in dev for an
    explicit effort. 'auto' now does the same. get_model_reasoning_capability cannot produce this pairing."""
    cap = adaptive_cap(thinks_by_default=True)
    explicit = apply_reasoning_to_request(provider, "m", "high", {}, cap)
    auto = apply_reasoning_to_request(provider, "m", "auto", {}, cap)
    assert explicit["thinking"] == auto["thinking"] == SUMMARIZED


def test_a_to_dict_exposes_thinks_by_default_as_json_bool():
    cap = enriched("claude-sonnet-5-5")
    data = cap.to_dict()
    assert data["thinks_by_default"] is True
    json.dumps(data)
    assert ReasoningCapability(ReasoningMode.NONE).to_dict()["thinks_by_default"] is False


def test_a_applied_thinking_dict_is_not_shared_between_requests():
    cap = enriched("claude-sonnet-5-5")
    first = apply_reasoning_to_request("anthropic", "m", "high", {}, cap)
    first["thinking"]["display"] = "omitted"
    second = apply_reasoning_to_request("anthropic", "m", "high", {}, cap)
    assert second["thinking"] == SUMMARIZED
    assert effort._visible_thinking() is not effort._visible_thinking()


@pytest.mark.parametrize("value", ["  HIGH ", "High", "hIgH"])
def test_a_effort_case_and_space_are_normalized(value):
    cap = enriched("claude-sonnet-5-5")
    out = apply_reasoning_to_request("anthropic", "claude-sonnet-5-5", value, {}, cap)
    assert out == {"thinking": SUMMARIZED, "output_config": {"effort": "high"}}


# ---- A: malformed / changed documentation tables ----

HEAD = ["Model", "No thinking field", '"adaptive"', '"enabled" with budget_tokens', '"between_tools"', '"disabled"']
ROW_ADAPTIVE = ["Claude Sonnet 5.5", "Adaptive thinking", "Adaptive thinking", "400 error", "400 error", "400 error"]
ROW_OFF = ["Claude Opus 4.8", "Thinking off", "Adaptive thinking", "400 error", "400 error", "Thinking off"]


def thinks_in(html, model):
    return enriched(model, html).thinks_by_default


@pytest.mark.parametrize("header", [
    "No thinking field", "no thinking field", "NO THINKING FIELD", "  No   thinking   field  ",
    "<code>No thinking field</code>", "`No thinking field`", "No <em>thinking</em> field",
])
def test_a_header_spelling_variants_still_found(header):
    head = list(HEAD)
    head[1] = header
    assert thinks_in(table(head, [ROW_ADAPTIVE, ROW_OFF]), "claude-sonnet-5-5") is True
    assert thinks_in(table(head, [ROW_ADAPTIVE, ROW_OFF]), "claude-opus-4-8") is False


def test_a_missing_column_defaults_to_not_thinking_and_does_not_raise():
    head = [h for h in HEAD if h != "No thinking field"]
    rows = [[c for i, c in enumerate(r) if i != 1] for r in (ROW_ADAPTIVE, ROW_OFF)]
    html = table(head, rows)
    cap = enriched("claude-sonnet-5-5", html)
    assert cap.thinks_by_default is False
    assert cap.is_mandatory is True
    assert "thinking" not in apply_reasoning_to_request("anthropic", "claude-sonnet-5-5", "auto", {}, cap)


def test_a_reordered_columns_give_the_same_answer():
    order = [0, 5, 4, 3, 2, 1]
    head = [HEAD[i] for i in order]
    rows = [[r[i] for i in order] for r in (ROW_ADAPTIVE, ROW_OFF)]
    html = table(head, rows)
    assert thinks_in(html, "claude-sonnet-5-5") is True
    assert thinks_in(html, "claude-opus-4-8") is False
    cap = enriched("claude-opus-4-8", html)
    assert "off" in cap.supported_efforts


def test_a_no_thinking_column_first_and_model_last():
    head = [HEAD[1], HEAD[2], HEAD[3], HEAD[4], HEAD[5], HEAD[0]]
    rows = [[*r[1:], r[0]] for r in (ROW_ADAPTIVE, ROW_OFF)]
    html = table(head, rows)
    # Model name sits in the last column: the lookup keys on column 0, so the model is simply not found.
    cap = enriched("claude-sonnet-5-5", html)
    assert cap.thinks_by_default is False


@pytest.mark.parametrize("cell,expected", [
    ("Adaptive thinking", True), ("adaptive thinking", True), ("ADAPTIVE THINKING", True),
    ("Adaptive thinking (default)", True), ("Adaptive", True), ("  Adaptive thinking  ", True),
    (" Adaptive thinking", True), ("Adaptive thinking<br>(default)", True),
    ("<code>Adaptive</code> thinking", True), ("Adaptive thinking *", True),
    ("Thinking off", False), ("thinking off", False), ("", False), ("400 error", False),
    ("Not adaptive thinking", False), ("Extended thinking", False), ("Adaptivethinking", True),
])
def test_a_cell_text_variants(cell, expected):
    row = list(ROW_ADAPTIVE)
    row[1] = cell
    assert thinks_in(table(HEAD, [row]), "claude-sonnet-5-5") is expected


def test_a_short_row_missing_the_no_thinking_cell_does_not_crash():
    html = table(HEAD, [["Claude Sonnet 5.5"]])
    assert enriched("claude-sonnet-5-5", html) == adaptive_cap()
    html = table(HEAD, [["Claude Sonnet 5.5", "Adaptive thinking", "x", "x", "x", "400 error"]])
    assert enriched("claude-sonnet-5-5", html).thinks_by_default is True
    html = table(HEAD, [["Claude Sonnet 5.5", "Adaptive thinking", "x", "x", "x"]])
    assert enriched("claude-sonnet-5-5", html) == adaptive_cap()


def test_a_header_with_only_disabled_column_and_no_rows():
    assert enriched("claude-sonnet-5-5", table(['"disabled"'], [])) == adaptive_cap()


def test_a_duplicate_model_rows_first_one_wins_and_second_table_is_ignored():
    first = table(HEAD, [ROW_OFF])
    second = table(HEAD, [["Claude Opus 4.8", "Adaptive thinking", "Adaptive thinking", "x", "x", "Thinking off"]])
    assert thinks_in(first + second, "claude-opus-4-8") is False


def test_a_hostile_html_does_not_raise():
    for html in ("", "<table>", "<table><tr><td>", "<tr><th>No thinking field</th></tr>",
                 "<table><tr><th>\"disabled\"</th><th>No thinking field</th></tr><tr><td>Claude X</td></tr>",
                 "<script>No thinking field</script>", "\x00" * 100, "<table>" * 500):
        assert enriched("claude-sonnet-5-5", html) == adaptive_cap()


def test_a_stale_thinks_by_default_is_reset_when_docs_say_otherwise():
    cap = adaptive_cap(thinks_by_default=True)
    assert enrich_anthropic_capability(ANTHROPIC_DOC, "claude-opus-4-8", cap).thinks_by_default is False


def test_a_model_missing_from_docs_keeps_cap_untouched_even_if_it_was_flagged():
    cap = adaptive_cap(thinks_by_default=True)
    assert enrich_anthropic_capability(ANTHROPIC_DOC, "claude-unknown-9", cap) is cap


def test_a_header_with_trailing_qualifier_is_a_known_fragility():
    """Probe: the column is matched by exact title. A renamed header silently turns every model into
    'does not think by default' (no summaries requested). This documents the fail-safe direction."""
    head = list(HEAD)
    head[1] = "No thinking field (default)"
    assert thinks_in(table(head, [ROW_ADAPTIVE]), "claude-sonnet-5-5") is False


# ---- A: the real discovery pipeline (docs and Models API mocked, no network) ----

MODELS_ROW = {"capabilities": {
    "effort": {"supported": True, "low": {"supported": True}, "medium": {"supported": True},
               "high": {"supported": True}, "xhigh": {"supported": True}, "max": {"supported": True}},
    "thinking": {"supported": True, "types": {"adaptive": {"supported": True}, "disabled": {"supported": True}}}}}


def _mock_anthropic(monkeypatch, docs=ANTHROPIC_DOC):
    import io
    from andromity.config import config

    monkeypatch.setattr(config, "get_api_key", lambda name: "test-key")

    def fetch_models(request, **kwargs):
        return io.BytesIO(json.dumps(MODELS_ROW).encode())

    def fetch_docs(url):
        if isinstance(docs, Exception):
            raise docs
        return docs

    monkeypatch.setattr(effort, "urlopen", fetch_models)
    monkeypatch.setattr(effort, "_fetch_document", fetch_docs)


@pytest.mark.parametrize("model,expected", [("claude-sonnet-5-5", True), ("claude-opus-4-8", False),
                                            ("claude-sonnet-4-6", False), ("claude-opus-5-5", True)])
def test_a_discovery_pipeline_sets_thinks_by_default_and_apply_follows_it(monkeypatch, model, expected):
    _mock_anthropic(monkeypatch)
    cap = effort.discover_model_reasoning_capability("anthropic", model)
    assert cap.request_format == "anthropic_adaptive" and cap.thinks_by_default is expected
    out = apply_reasoning_to_request("anthropic", model, "auto", {}, cap)
    assert out.get("thinking") == (SUMMARIZED if expected else None)
    again = effort.discover_model_reasoning_capability("anthropic", model)
    assert again.thinks_by_default is expected, "the cached capability lost the flag"
    assert effort.get_model_reasoning_capability("anthropic", model).thinks_by_default is expected


def test_a_docs_outage_leaves_a_safe_capability_and_never_raises(monkeypatch):
    _mock_anthropic(monkeypatch, docs=OSError("offline"))
    cap = effort.discover_model_reasoning_capability("anthropic", "claude-sonnet-5-5")
    assert cap.thinks_by_default is False
    assert "thinking" not in apply_reasoning_to_request("anthropic", "claude-sonnet-5-5", "auto", {}, cap)
    out = apply_reasoning_to_request("anthropic", "claude-sonnet-5-5", "high", {}, cap)
    assert out["thinking"] == SUMMARIZED


@pytest.mark.xfail(strict=True, reason='Product decision: after a docs outage the capability is retried after 60 s, not on every request, because each retry costs a 4 s fetch timeout before the turn starts. Until then the watchdog treats an undocumented Claude capability as possibly hidden reasoning.')
def test_a_docs_outage_is_not_cached_for_an_hour(monkeypatch):
    """A transient docs failure must not pin 'does not think by default' (no summaries) for the full TTL."""
    _mock_anthropic(monkeypatch, docs=OSError("offline"))
    first = effort.discover_model_reasoning_capability("anthropic", "claude-sonnet-5-5")
    assert first.thinks_by_default is False
    _mock_anthropic(monkeypatch)
    second = effort.discover_model_reasoning_capability("anthropic", "claude-sonnet-5-5")
    assert second.thinks_by_default is True


def test_a_air_gap_mode_cannot_enrich_so_auto_sends_no_thinking(monkeypatch):
    _mock_anthropic(monkeypatch)
    from andromity.core import network_policy
    monkeypatch.setattr(network_policy, "enabled", lambda: True)
    cap = effort.discover_model_reasoning_capability("anthropic", "claude-sonnet-5-5")
    assert cap.thinks_by_default is False
    assert "thinking" not in apply_reasoning_to_request("anthropic", "claude-sonnet-5-5", "auto", {}, cap)


# --------------------------------------------------------------------------------------
# helpers to load dev's effort.py for differential checks
# --------------------------------------------------------------------------------------

_OLD = {}


def _old_effort():
    if "mod" not in _OLD:
        root = Path(__file__).resolve().parents[1]
        try:
            source = subprocess.run(["git", "show", "d9205f8^:src/andromity/core/effort.py"], cwd=root,
                                    capture_output=True, text=True, timeout=20, check=True).stdout
        except Exception as exc:  # pragma: no cover
            pytest.skip(f"dev branch not available: {exc}")
        module = types.ModuleType("old_effort_from_dev")
        module.__dict__["__name__"] = "old_effort_from_dev"
        sys.modules["old_effort_from_dev"] = module
        exec(compile(source, "old_effort_from_dev", "exec"), module.__dict__)
        _OLD["mod"] = module
    return _OLD["mod"]
