"""Independent adversarial tests for the stream_completion watchdog and request changes in provider.py.

Written to break the new behaviour, not to pass:
  * which first-token / idle window a request gets
  * retry policy for stalls on hidden-reasoning requests
  * the stall card
  * cancellation and stream closing
  * prompt-cache injection points (kwargs level and through LiteLLM's real request transform)

Windows are shrunk by monkeypatching provider constants so everything runs in seconds. No network.
"""
import asyncio
import functools
import json
import types

import litellm
import pytest

import andromity.core.provider as provider_mod
import andromity.core.reasoning as reasoning_mod
from andromity.config import config as app_config
from andromity.core.events import Done, TextDelta, ThinkingDelta
from andromity.core.provider import ProviderStalledError
from andromity.core.reasoning import ReasoningCapability, ReasoningMode
from tests.test_adversarial_effort_display import SUMMARIZED, adaptive_cap, enriched

HANG = object()
FIRST = 0.2
WINDOWS = {"minimal": 0.5, "low": 0.5, "medium": 0.8, "high": 1.2, "xhigh": 1.6, "max": 1.6}
DEFAULT_WINDOW = 0.8
LOCAL = 0.9
CACHE_POINTS = [{"location": "message", "role": "system"}, {"location": "message", "index": -1}]


def bounded(seconds: float = 30.0):
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            return await asyncio.wait_for(fn(*args, **kwargs), seconds)
        return wrapper
    return deco


def chunk(text=None, thinking=None, usage=None, finish=None):
    delta = types.SimpleNamespace(content=text, tool_calls=None, thinking=thinking, reasoning_content=None,
                                  reasoning=None, thought=None)
    choice = types.SimpleNamespace(delta=delta, finish_reason=finish)
    return types.SimpleNamespace(choices=[choice], usage=usage)


class FakeStream:
    def __init__(self, steps=()):
        self.steps = list(steps)
        self.close_calls = 0
        self.reading = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.steps:
            raise StopAsyncIteration
        step = self.steps.pop(0)
        self.reading = True
        try:
            if step is HANG:
                await asyncio.Event().wait()
            if isinstance(step, tuple) and step[0] == "sleep":
                await asyncio.sleep(step[1])
                step = step[2]
            if isinstance(step, BaseException):
                raise step
            return step
        finally:
            self.reading = False

    async def aclose(self):
        self.close_calls += 1


class Script:
    """Stand-in for litellm.acompletion. A behaviour is an exception to raise or a list of stream steps;
    the last behaviour repeats."""

    def __init__(self, *behaviours):
        self.behaviours = list(behaviours)
        self.calls = []
        self.streams = []

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        behaviour = self.behaviours.pop(0) if len(self.behaviours) > 1 else self.behaviours[0]
        if isinstance(behaviour, BaseException):
            raise behaviour
        stream = FakeStream(behaviour)
        self.streams.append(stream)
        return stream


def ok_stream(text="hello"):
    return [chunk(text=text), chunk(finish="stop")]


def configurable(fmt="openrouter", efforts=("low", "medium", "high", "xhigh", "max"),
                 mode=ReasoningMode.CONFIGURABLE):
    return ReasoningCapability(mode, supported_efforts=list(efforts), request_format=fmt)


NO_REASONING = ReasoningCapability(ReasoningMode.NONE)


class Harness:
    def __init__(self, monkeypatch):
        self.monkeypatch = monkeypatch
        self.guard_calls = []
        original = provider_mod._first_token_guard

        def spy(stream, *args):
            self.guard_calls.append(args)
            return original(stream, *args)

        monkeypatch.setattr(provider_mod, "_first_token_guard", spy)
        monkeypatch.setattr(provider_mod, "FIRST_TOKEN_TIMEOUT", FIRST)
        monkeypatch.setattr(provider_mod, "LOCAL_FIRST_TOKEN_TIMEOUT", LOCAL)
        monkeypatch.setattr(provider_mod, "HIDDEN_REASONING_WINDOWS", dict(WINDOWS))
        monkeypatch.setattr(provider_mod, "HIDDEN_REASONING_DEFAULT_WINDOW", DEFAULT_WINDOW)
        monkeypatch.setattr(provider_mod, "STREAM_BACKOFF_DELAYS", [0.01, 0.01, 0.01])
        monkeypatch.setattr(original, "__defaults__", (0.6,))
        monkeypatch.setattr("andromity.core.models.get_ollama_num_ctx", lambda *a, **k: 0)

    def connection(self, name, **fields):
        app_config._config_cache["providers"] = [{"name": name, **fields}]

    def use(self, cap, *behaviours):
        self.monkeypatch.setattr(reasoning_mod, "discover_model_reasoning_capability", lambda p, m: cap)
        self.script = Script(*behaviours)
        self.monkeypatch.setattr(litellm, "acompletion", self.script)
        return self.script

    async def run(self, behaviours, *, provider="openrouter", model="some/model", effort=None, cap=None, **kw):
        cap = cap or configurable(efforts=("low", "medium", "high"))
        self.use(cap, *behaviours)
        events = []
        async for event in provider_mod.stream_completion(
                [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}],
                provider_name=provider, model=model, reasoning_effort=effort, **kw):
            events.append(event)
        return events


@pytest.fixture
def harness(monkeypatch):
    return Harness(monkeypatch)


def done_of(events):
    dones = [e for e in events if isinstance(e, Done)]
    assert len(dones) == 1, f"expected exactly one Done, got {len(dones)}"
    assert events[-1] is dones[0], "Done must be the last event"
    return dones[0]


def card_text(events):
    return "".join(e.text for e in events if isinstance(e, TextDelta))


# ---------------------------------------------------------------------------
# which window a request gets (spy on the guard, no waiting)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("effort,expected", [
    ("low", WINDOWS["low"]), ("minimal", WINDOWS["minimal"]), ("medium", WINDOWS["medium"]),
    ("high", WINDOWS["high"]), ("xhigh", WINDOWS["xhigh"]), ("max", WINDOWS["max"]),
    (None, DEFAULT_WINDOW), ("auto", DEFAULT_WINDOW), ("budget:2048", DEFAULT_WINDOW),
])
@bounded()
async def test_hidden_reasoning_window_by_effort(harness, effort, expected):
    cap = configurable(efforts=("minimal", "low", "medium", "high", "xhigh", "max"))
    if effort and effort.startswith("budget"):
        cap = ReasoningCapability(ReasoningMode.CONFIGURABLE, supported_efforts=["low"], request_format="google_budget",
                                  supports_max_tokens=True, budget_min=1024, budget_max=64000)
    events = await harness.run([ok_stream()], effort=effort, cap=cap)
    assert done_of(events).outcome == "success"
    assert harness.guard_calls == [(expected, expected)], harness.guard_calls


@pytest.mark.parametrize("mode", [ReasoningMode.MANDATORY, ReasoningMode.TOGGLEABLE,
                                  ReasoningMode.CONFIGURABLE, ReasoningMode.ROUTER])
@bounded()
async def test_every_reasoning_mode_gets_the_hidden_window(harness, mode):
    events = await harness.run([ok_stream()], effort="high", cap=configurable(mode=mode))
    assert harness.guard_calls == [(WINDOWS["high"], WINDOWS["high"])]
    assert done_of(events).outcome == "success"


@pytest.mark.parametrize("mode", [ReasoningMode.NONE, ReasoningMode.UNKNOWN])
@bounded()
async def test_non_reasoning_models_keep_the_default_window_and_idle(harness, mode):
    await harness.run([ok_stream()], effort="high", cap=ReasoningCapability(mode))
    assert harness.guard_calls == [(FIRST,)]


@pytest.mark.parametrize("effort", ["off", "none", "OFF"])
@bounded()
async def test_effort_off_on_a_toggleable_model_keeps_the_default_window(harness, effort):
    cap = configurable(efforts=("low", "high", "off"), mode=ReasoningMode.TOGGLEABLE)
    await harness.run([ok_stream()], effort=effort, cap=cap)
    assert harness.guard_calls == [(FIRST,)]
    assert harness.script.calls[0]["extra_body"]["reasoning"] == {"effort": "none"}


@bounded()
async def test_streamed_summaries_keep_the_default_window_and_default_idle(harness):
    await harness.run([ok_stream()], provider="anthropic", model="claude-sonnet-5-5", effort="high",
                      cap=adaptive_cap())
    assert harness.script.calls[0]["thinking"] == SUMMARIZED
    assert harness.guard_calls == [(FIRST,)], "summaries stream, so the default window and idle stay"


@bounded()
async def test_anthropic_disabled_thinking_keeps_the_default_window(harness):
    await harness.run([ok_stream()], provider="anthropic", model="claude-opus-4-8", effort="off",
                      cap=enriched("claude-opus-4-8"))
    assert harness.script.calls[0]["thinking"] == {"type": "disabled"}
    assert harness.guard_calls == [(FIRST,)]


@pytest.mark.xfail(strict=True, reason="Disputed: Anthropic documents display 'summarized' as the default for budget thinking on Opus 4.6, Sonnet 4.6 and earlier, so budget thinking streams and keeps the default window.")
@bounded()
async def test_anthropic_budget_thinking_has_no_display_so_gets_the_hidden_window(harness):
    cap = ReasoningCapability(ReasoningMode.TOGGLEABLE, supported_efforts=["on", "off"],
                              request_format="anthropic_budget")
    await harness.run([ok_stream()], provider="anthropic", model="claude-x", effort="on", cap=cap)
    assert harness.script.calls[0]["thinking"]["type"] == "enabled"
    assert harness.guard_calls == [(DEFAULT_WINDOW, DEFAULT_WINDOW)]


@bounded()
async def test_explicit_first_token_timeout_always_wins_and_keeps_default_idle(harness):
    for explicit in (0.05, 0.4, 7.0):
        harness.guard_calls.clear()
        await harness.run([ok_stream()], effort="max", cap=configurable(), first_token_timeout=explicit)
        assert harness.guard_calls == [(explicit,)], (explicit, harness.guard_calls)


@bounded()
async def test_explicit_timeout_stall_is_still_retried_on_a_hidden_request(harness):
    events = await harness.run([[HANG]], effort="high", cap=configurable(), first_token_timeout=0.05)
    assert len(harness.script.calls) == 4, "explicit timeout must keep the old retry behaviour"
    assert "reasoning" not in card_text(events).lower()
    assert done_of(events).outcome == "error"


@bounded()
async def test_local_providers_stay_at_the_local_window_with_default_idle(harness):
    cap = configurable(fmt="openai", mode=ReasoningMode.TOGGLEABLE, efforts=("low", "high", "off"))
    await harness.run([ok_stream()], provider="ollama", model="qwen3", effort="high", cap=cap)
    assert harness.guard_calls == [(LOCAL,)]
    harness.guard_calls.clear()
    harness.connection("lmstudio", type="openai", base_url="http://127.0.0.1:1234/v1", api_key="x")
    await harness.run([ok_stream()], provider="lmstudio", model="m", effort="max", cap=cap)
    assert harness.guard_calls == [(LOCAL,)]


@bounded()
async def test_local_stall_is_still_retried(harness):
    cap = configurable(fmt="openai", mode=ReasoningMode.TOGGLEABLE, efforts=("low", "high", "off"))
    events = await harness.run([[HANG]], provider="ollama", model="qwen3", effort="high", cap=cap)
    assert len(harness.script.calls) == 4
    assert done_of(events).outcome == "error"


@pytest.mark.parametrize("efforts,expected", [
    (("low", "high"), WINDOWS["low"]), (("minimal", "high"), WINDOWS["minimal"]),
    (("medium", "high"), DEFAULT_WINDOW),
])
@bounded()
async def test_least_reasoning_picks_the_smallest_effort_and_its_window(harness, efforts, expected):
    await harness.run([ok_stream()], effort="max", cap=configurable(efforts=efforts), least_reasoning=True)
    assert harness.guard_calls == [(expected, expected)]


@bounded()
async def test_least_reasoning_with_off_available_uses_the_default_window(harness):
    cap = configurable(efforts=("off", "low", "high"), mode=ReasoningMode.TOGGLEABLE)
    await harness.run([ok_stream()], effort="max", cap=cap, least_reasoning=True)
    assert harness.guard_calls == [(FIRST,)]


# ---------------------------------------------------------------------------
# retry / stall behaviour with shrunk real windows
# ---------------------------------------------------------------------------

@bounded()
async def test_hidden_stall_is_not_retried_and_card_says_it_may_still_have_been_working(harness):
    events = await harness.run([[HANG]], effort="medium")
    assert len(harness.script.calls) == 1, "a hidden-reasoning stall must not be retried"
    assert done_of(events).outcome == "error"
    text = card_text(events)
    assert "Provider stalled" in text and "may still have been" in text and "reasoning" in text
    assert harness.script.streams[0].close_calls == 1


@bounded()
async def test_ordinary_stall_is_retried_three_times_with_the_old_card(harness):
    events = await harness.run([[HANG]], effort=None, cap=NO_REASONING)
    assert len(harness.script.calls) == 4
    assert [s.close_calls for s in harness.script.streams] == [1, 1, 1, 1]
    text = card_text(events)
    assert "may still have been" not in text and "reasoning" not in text.lower()
    assert "upstream queued or overloaded" in text


@bounded()
async def test_hidden_and_ordinary_stall_end_with_the_same_error_classification(harness):
    hidden = done_of(await harness.run([[HANG]], effort="low"))
    ordinary = done_of(await harness.run([[HANG]], cap=NO_REASONING))
    for field in ("outcome", "error_type", "error_detail", "error_status", "error_action", "error_message"):
        assert getattr(hidden, field) == getattr(ordinary, field), field


@bounded()
async def test_slow_first_token_inside_the_hidden_window_succeeds_where_the_default_window_fails(harness):
    slow = [("sleep", FIRST * 2.5, chunk(text="answer")), chunk(finish="stop")]
    events = await harness.run([slow], effort="medium")
    assert done_of(events).outcome == "success" and card_text(events) == "answer"
    assert len(harness.script.calls) == 1
    events = await harness.run([slow], effort="medium", cap=NO_REASONING)
    assert done_of(events).outcome == "error", "the default window must still cut off a slow first token"


@bounded()
async def test_idle_between_chunks_uses_the_hidden_window_not_the_default(harness):
    steps = [chunk(thinking="t"), ("sleep", FIRST * 2.5, chunk(text="answer")), chunk(finish="stop")]
    events = await harness.run([steps], effort="medium")
    assert done_of(events).outcome == "success"
    assert any(isinstance(e, ThinkingDelta) for e in events)


@bounded()
async def test_idle_gap_longer_than_the_hidden_window_stalls_without_retry(harness):
    events = await harness.run([[chunk(text="partial"), HANG]], effort="low")
    assert len(harness.script.calls) == 1
    assert done_of(events).outcome == "error"
    assert "partial" in card_text(events)


@bounded()
async def test_idle_stall_after_content_is_not_retried_on_ordinary_requests_either(harness):
    events = await harness.run([[chunk(text="partial"), HANG]], cap=NO_REASONING, first_token_timeout=0.1)
    assert len(harness.script.calls) == 1
    assert done_of(events).outcome == "error"


@bounded()
async def test_thinking_before_stall_counts_as_emitted_content_and_is_not_retried(harness):
    events = await harness.run([[chunk(thinking="hmm"), HANG]], cap=NO_REASONING, first_token_timeout=0.1)
    assert len(harness.script.calls) == 1
    assert done_of(events).outcome == "error"


@bounded()
async def test_empty_keepalive_chunk_is_not_content_so_ordinary_stall_after_it_is_retried(harness):
    events = await harness.run([[chunk(), HANG]], cap=NO_REASONING, first_token_timeout=0.1)
    assert len(harness.script.calls) == 4
    assert done_of(events).outcome == "error"


@bounded()
async def test_empty_keepalive_chunk_then_hidden_stall_is_not_retried(harness):
    events = await harness.run([[chunk(), HANG]], effort="low")
    assert len(harness.script.calls) == 1
    assert "may still have been" in card_text(events)


@bounded()
async def test_non_stall_error_on_hidden_request_is_still_retried(harness):
    events = await harness.run([[RuntimeError("upstream connection reset 503")]], effort="high")
    assert len(harness.script.calls) == 4
    assert done_of(events).outcome == "error"
    assert "may still have been" not in card_text(events)


@bounded()
async def test_error_then_success_on_hidden_request_recovers_and_keeps_the_hidden_window(harness):
    events = await harness.run([[RuntimeError("connection reset")], ok_stream("fine")], effort="medium")
    assert done_of(events).outcome == "success" and card_text(events) == "fine"
    assert harness.guard_calls == [(WINDOWS["medium"], WINDOWS["medium"])] * 2


@bounded()
async def test_stall_raised_by_the_call_itself_follows_the_same_policy(harness):
    events = await harness.run([ProviderStalledError(5.0)], effort="medium")
    assert len(harness.script.calls) == 1
    assert "may still have been" in card_text(events)
    events = await harness.run([ProviderStalledError(5.0)], cap=NO_REASONING)
    assert len(harness.script.calls) == 4
    assert "may still have been" not in card_text(events)


@bounded()
async def test_stall_after_an_error_on_a_hidden_request_ends_the_turn(harness):
    events = await harness.run([[RuntimeError("connection reset")], [HANG], ok_stream()], effort="low")
    assert len(harness.script.calls) == 2, "an error, then a hidden stall: the stall must end the turn"
    assert done_of(events).outcome == "error"
    assert [s.close_calls for s in harness.script.streams] == [1, 1]


@bounded()
async def test_stall_card_does_not_leak_secrets_or_urls(harness):
    harness.connection("myclaude", type="anthropic", api_key="sk-LEAKME-123",
                       base_url="https://user:hunter2@proxy.internal.example/v1?token=TOPSECRET")
    events = await harness.run([[HANG]], provider="myclaude", model="claude-x", effort="low")
    blob = json.dumps([getattr(e, "__dict__", str(e)) for e in events], default=str)
    for needle in ("sk-LEAKME-123", "hunter2", "TOPSECRET", "proxy.internal", "https://", "api_key"):
        assert needle not in blob, needle
    assert len(harness.script.calls) == 1


@bounded()
async def test_cancellation_during_a_hidden_stall_propagates_and_closes_the_stream_once(harness):
    script = harness.use(configurable(), [HANG])
    events = []

    async def consume():
        async for event in provider_mod.stream_completion(
                [{"role": "user", "content": "hi"}], provider_name="openrouter", model="m", reasoning_effort="max"):
            events.append(event)

    task = asyncio.create_task(consume())
    for _ in range(200):
        if script.streams:
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(script.calls) == 1, "a cancelled turn must not be retried"
    assert script.streams[0].close_calls == 1
    assert not events or not isinstance(events[-1], Done)
    leftovers = [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    assert leftovers == []


@bounded()
async def test_cancellation_while_waiting_for_a_retry_backoff_still_propagates(harness):
    harness.monkeypatch.setattr(provider_mod, "STREAM_BACKOFF_DELAYS", [30.0, 30.0, 30.0])
    harness.use(NO_REASONING, [RuntimeError("connection reset")])

    async def consume():
        async for _ in provider_mod.stream_completion([{"role": "user", "content": "hi"}],
                                                      provider_name="openrouter", model="m"):
            pass

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)


@bounded()
async def test_consumer_closing_the_generator_mid_stream_closes_the_provider_stream_once(harness):
    script = harness.use(configurable(), [chunk(text="a"), chunk(text="b"), HANG])
    gen = provider_mod.stream_completion([{"role": "user", "content": "hi"}], provider_name="openrouter",
                                         model="m", reasoning_effort="high")
    assert isinstance(await gen.__anext__(), TextDelta)
    await gen.aclose()
    assert script.streams[0].close_calls == 1
    assert len(script.calls) == 1


@bounded()
async def test_every_attempt_stream_is_closed_exactly_once_on_ordinary_stalls(harness):
    await harness.run([[HANG]], cap=NO_REASONING)
    assert [s.close_calls for s in harness.script.streams] == [1, 1, 1, 1]
    assert not any(s.reading for s in harness.script.streams)


# ---------------------------------------------------------------------------
# window selector unit attacks
# ---------------------------------------------------------------------------

WEIRD_KWARGS = [
    {}, {"thinking": None}, {"thinking": "x"}, {"thinking": []}, {"thinking": {"display": None}},
    {"output_config": None}, {"output_config": []}, {"output_config": {"effort": 5}},
    {"extra_body": None}, {"extra_body": []}, {"extra_body": {"reasoning": "x"}},
    {"extra_body": {"reasoning": {"enabled": "no"}}}, {"reasoning_effort": 5}, {"reasoning_effort": ""},
    {"reasoning_effort": "   "}, {"reasoning_effort": ["high"]}, {"reasoning_effort": "HIGH"},
]


def test_window_selector_never_raises_and_is_bounded():
    efforts = [None, "", "auto", "AUTO", "  low ", "off", "none", "weird", "budget:1"]
    caps = [None, object(), ReasoningCapability(ReasoningMode.CONFIGURABLE), types.SimpleNamespace(mode="configurable")]
    for kwargs in WEIRD_KWARGS:
        for effort in efforts:
            for cap in caps:
                for provider in ("openrouter", "anthropic"):
                    result = provider_mod._hidden_reasoning_window(provider, json.loads(json.dumps(kwargs)), cap)
                    assert result is None or 0 < result <= 900, (kwargs, effort, cap, provider, result)


def test_reasoning_effort_in_kwargs_overrides_the_effort_argument():
    cap = configurable(fmt="openai")
    assert provider_mod._hidden_reasoning_window("openai", {"reasoning_effort": "xhigh"}, cap) == 900.0
    assert provider_mod._hidden_reasoning_window("openai", {"reasoning_effort": "none"}, cap) is None
    assert provider_mod._hidden_reasoning_window(
        "openrouter", {"extra_body": {"reasoning": {"enabled": False}}}, cap) is None


def test_default_windows_are_the_documented_values():
    assert provider_mod.FIRST_TOKEN_TIMEOUT == 60.0
    assert provider_mod.LOCAL_FIRST_TOKEN_TIMEOUT == 600.0
    assert provider_mod.HIDDEN_REASONING_DEFAULT_WINDOW == 300.0
    assert provider_mod.HIDDEN_REASONING_WINDOWS == {
        "minimal": 120.0, "low": 120.0, "medium": 300.0, "high": 600.0, "xhigh": 900.0, "max": 900.0}
    assert provider_mod._first_token_guard.__defaults__ == (60.0,)


# ---------------------------------------------------------------------------
# semantic gaps: expected to expose problems
# ---------------------------------------------------------------------------

@bounded()
async def test_mandatory_reasoner_with_effort_off_requested_still_gets_the_hidden_window(harness):
    """A model whose reasoning cannot be switched off ignores effort 'off' (apply_reasoning falls back to the
    provider default), so it still reasons out of sight. The window must follow what the model does, not
    what was requested."""
    cap = configurable(efforts=("low", "high"), mode=ReasoningMode.MANDATORY)
    events = await harness.run([ok_stream()], effort="off", cap=cap)
    assert done_of(events).outcome == "success"
    assert "reasoning" not in harness.script.calls[0].get("extra_body", {}), "off is unsupported so nothing is sent"
    assert harness.guard_calls[0][0] > FIRST, harness.guard_calls


@bounded()
async def test_mandatory_reasoner_with_effort_off_stall_is_not_retried(harness):
    cap = configurable(efforts=("low", "high"), mode=ReasoningMode.MANDATORY)
    await harness.run([[HANG]], effort="off", cap=cap)
    assert len(harness.script.calls) == 1


@bounded()
async def test_anthropic_model_with_no_reasoning_support_keeps_the_default_window_and_retry(harness):
    """An Anthropic request that carries no thinking field at all (capability NONE): nothing can be hidden."""
    await harness.run([[HANG]], provider="anthropic", model="claude-3-haiku", effort="auto", cap=NO_REASONING)
    assert "thinking" not in harness.script.calls[0]
    assert harness.guard_calls[0] == (FIRST,), harness.guard_calls[0]
    assert len(harness.script.calls) == 4


@bounded()
async def test_anthropic_model_that_does_not_think_by_default_on_auto_keeps_the_default_window(harness):
    """Opus 4.8 on 'auto' sends no thinking field and therefore does not think. A hang there is an ordinary
    stall: default window and the usual retries, as in dev."""
    await harness.run([[HANG]], provider="anthropic", model="claude-opus-4-8", effort="auto",
                      cap=enriched("claude-opus-4-8"))
    assert "thinking" not in harness.script.calls[0]
    assert harness.guard_calls[0] == (FIRST,), harness.guard_calls[0]
    assert len(harness.script.calls) == 4


@pytest.mark.parametrize("model", ["claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"])
@bounded()
async def test_default_effort_on_models_that_do_not_think_by_default_keeps_the_default_window(harness, model):
    """claude-sonnet-4-6 is the stock default model. On 'auto' (the stock effort) none of these send a thinking
    field, so they cannot be reasoning out of sight; their stalls must keep the 60 s window and retries."""
    cap = enriched(model)
    assert cap.thinks_by_default is False
    await harness.run([ok_stream()], provider="anthropic", model=model, effort=None, cap=cap)
    assert "thinking" not in harness.script.calls[0]
    assert harness.guard_calls == [(FIRST,)], harness.guard_calls


@pytest.mark.parametrize("model", ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"])
@bounded()
async def test_default_effort_on_budget_thinking_models_keeps_the_default_window(harness, model):
    cap = ReasoningCapability(ReasoningMode.TOGGLEABLE, supported_efforts=["on", "off"], request_format="anthropic_budget")
    await harness.run([ok_stream()], provider="anthropic", model=model, effort=None, cap=cap)
    assert "thinking" not in harness.script.calls[0]
    assert harness.guard_calls == [(FIRST,)], harness.guard_calls


@pytest.mark.parametrize("model", ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5"])
@bounded()
async def test_default_effort_on_models_that_think_by_default_streams_summaries_so_keeps_the_default_window(harness, model):
    cap = enriched(model)
    assert cap.thinks_by_default is True
    await harness.run([ok_stream()], provider="anthropic", model=model, effort=None, cap=cap)
    assert harness.script.calls[0]["thinking"] == SUMMARIZED
    assert harness.guard_calls == [(FIRST,)], harness.guard_calls


# ---------------------------------------------------------------------------
# prompt-cache injection points
# ---------------------------------------------------------------------------

@bounded()
async def test_anthropic_gets_exactly_the_two_cache_points(harness):
    await harness.run([ok_stream()], provider="anthropic", model="claude-sonnet-5-5", effort="high",
                      cap=adaptive_cap())
    assert harness.script.calls[0]["cache_control_injection_points"] == CACHE_POINTS


@bounded()
async def test_cache_points_are_copies_not_the_shared_module_constant(harness):
    await harness.run([ok_stream()], provider="anthropic", model="claude-sonnet-5-5", cap=adaptive_cap())
    points = harness.script.calls[0]["cache_control_injection_points"]
    points[0]["role"] = "user"
    points.append({"location": "message", "index": 0})
    assert list(provider_mod.ANTHROPIC_CACHE_POINTS) == CACHE_POINTS
    await harness.run([ok_stream()], provider="anthropic", model="claude-sonnet-5-5", cap=adaptive_cap())
    assert harness.script.calls[0]["cache_control_injection_points"] == CACHE_POINTS


@pytest.mark.parametrize("provider,model,fields", [
    ("openrouter", "anthropic/claude-sonnet-5-5", {}),
    ("openai", "gpt-5", {}),
    ("google", "gemini-3-pro", {}),
    ("ollama", "qwen3", {}),
    ("andromity", "auto", {}),
    ("deepseek", "deepseek-chat", {}),
    ("myclaude", "claude-sonnet-5-5", {"type": "anthropic", "api_key": "sk-x"}),
    ("myclaude", "claude-sonnet-5-5", {"type": "anthropic", "api_key": "sk-x", "base_url": "https://proxy.example/v1"}),
    ("anthropic-proxy", "claude-x", {"type": "anthropic", "api_key": "sk-x"}),
    ("mycustom", "m", {"type": "openai", "base_url": "https://llm.example/v1", "api_key": "k"}),
    ("Anthropic", "claude-x", {}),
    ("anthropic ", "claude-x", {}),
])
@bounded()
async def test_no_other_provider_gets_cache_points(harness, provider, model, fields):
    if fields:
        harness.connection(provider, **fields)
    await harness.run([ok_stream()], provider=provider, model=model, effort="auto", cap=NO_REASONING)
    assert "cache_control_injection_points" not in harness.script.calls[0]
    assert "cache_control" not in json.dumps(harness.script.calls[0], default=str)


@bounded()
async def test_anthropic_cache_points_reach_the_wire_and_stay_within_four_breakpoints(harness, monkeypatch):
    """Run LiteLLM's real request transform (no network) and count cache_control blocks."""
    from litellm.llms.custom_httpx import http_handler
    captured = {}

    class Stop(Exception):
        pass

    async def fake_post(self, url, data=None, json=None, **kw):
        captured["body"] = data
        raise Stop("no network in tests")

    monkeypatch.setattr(http_handler.AsyncHTTPHandler, "post", fake_post)
    monkeypatch.setattr(reasoning_mod, "discover_model_reasoning_capability",
                        lambda p, m: enriched("claude-sonnet-5-5"))
    app_config._config_cache["providers"] = [{"name": "anthropic", "api_key": "sk-ant-test"}]
    messages = [{"role": "system", "content": "You are an agent."}]
    for i in range(6):
        messages += [{"role": "user", "content": f"q{i}"},
                     {"role": "assistant", "content": None,
                      "tool_calls": [{"id": f"call_{i}", "type": "function",
                                      "function": {"name": "read_file", "arguments": "{}"}}]},
                     {"role": "tool", "tool_call_id": f"call_{i}", "content": "result " * 10}]
    messages.append({"role": "user", "content": "next"})
    events = [e async for e in provider_mod.stream_completion(
        messages, provider_name="anthropic", model="claude-sonnet-5-5", reasoning_effort="high", retry=False)]
    assert done_of(events).outcome == "error"
    body = json.loads(captured["body"])

    def count(node):
        if isinstance(node, dict):
            return ("cache_control" in node) + sum(count(v) for v in node.values())
        if isinstance(node, list):
            return sum(count(v) for v in node)
        return 0

    assert 1 <= count(body) <= 4
    assert body["system"][-1].get("cache_control") == {"type": "ephemeral"}
    assert body["messages"][-1]["content"][-1].get("cache_control") == {"type": "ephemeral"}
    assert body["thinking"] == SUMMARIZED
    assert body["output_config"] == {"effort": "high"}
    assert "cache_control_injection_points" not in body
