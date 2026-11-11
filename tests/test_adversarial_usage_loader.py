"""Independent adversarial tests for
  C. usage.normalize_usage / pricing.calculate_cost cache-write accounting
  D. litellm_loader.load_litellm (off-loop import, concurrency, failure, cancellation)

Written to break the new behaviour, not to pass. No network (LiteLLM's local price map only).
"""
import asyncio
import builtins
import functools
import json
import os
import subprocess
import sys
import textwrap
import threading
import time
import types
from pathlib import Path

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

import litellm  # noqa: E402
import pytest  # noqa: E402

from andromity.core import litellm_loader as loader  # noqa: E402
from andromity.core.pricing import calculate_cost  # noqa: E402
from andromity.core.usage import normalize_usage  # noqa: E402

SRC = str(Path(__file__).resolve().parents[1] / "src")
MODEL = "claude-sonnet-4-5"


def bounded(seconds: float = 30.0):
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            return await asyncio.wait_for(fn(*args, **kwargs), seconds)
        return wrapper
    return deco


# ---------------------------------------------------------------------------
# C. usage + pricing
# ---------------------------------------------------------------------------

def rates():
    info = litellm.model_cost[MODEL]
    return (info["input_cost_per_token"], info["cache_read_input_token_cost"],
            info["cache_creation_input_token_cost"], info["output_cost_per_token"])


def test_c_cache_write_is_reported_only_when_non_zero():
    assert "cache_write_tokens" not in normalize_usage({"prompt_tokens": 5})
    assert "cache_write_tokens" not in normalize_usage({"prompt_tokens": 5, "cache_creation_input_tokens": 0})
    assert "cache_write_tokens" not in normalize_usage({"prompt_tokens": 5, "cache_creation_input_tokens": None})
    assert "cache_write_tokens" not in normalize_usage({"prompt_tokens": 5, "prompt_tokens_details": {"cache_creation_tokens": 0}})
    assert normalize_usage({"prompt_tokens": 5, "cache_creation_input_tokens": 3})["cache_write_tokens"] == 3
    assert normalize_usage({"prompt_tokens": 5, "prompt_tokens_details": {"cache_creation_tokens": 4}})["cache_write_tokens"] == 4


@pytest.mark.parametrize("raw", [
    {"prompt_tokens": 100, "completion_tokens": 5, "cache_creation_input_tokens": 30, "cache_read_input_tokens": 20},
    {"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 10, "cache_creation_tokens": 20}},
    {"input_tokens": 100, "output_tokens": 4, "cache_creation_input_tokens": 7},
    {"prompt_tokens": 0},
    {"prompt_tokens": 100, "cache_write_tokens": 25},
])
def test_c_renormalizing_a_normalized_dict_is_stable(raw):
    once = normalize_usage(raw)
    twice = normalize_usage(once)
    assert twice == once
    assert normalize_usage(twice) == once


def test_c_renormalizing_keeps_the_estimate_source_when_told_to():
    once = normalize_usage({"prompt_tokens": 10, "cache_creation_input_tokens": 3}, "estimate")
    assert normalize_usage(once, once["usage_source"]) == once


@pytest.mark.parametrize("value,expected", [
    ("300", 300), (300.9, 300), (" 7 ", 7), ("abc", None), ("", None), (None, None), ([], None), ({}, None),
    (float("nan"), None), (0, None), (0.0, None), ("0", None),
])
def test_c_weird_write_values_never_crash_and_are_dropped_or_coerced(value, expected):
    out = normalize_usage({"prompt_tokens": 1000, "cache_creation_input_tokens": value})
    assert out.get("cache_write_tokens") == expected


def test_c_infinite_write_value_does_not_crash():
    normalize_usage({"prompt_tokens": 1, "cache_creation_input_tokens": float("inf")})


@pytest.mark.parametrize("value", [-1, -300, "-5"])
def test_c_negative_write_values_are_not_reported(value):
    assert "cache_write_tokens" not in normalize_usage({"prompt_tokens": 1000, "cache_creation_input_tokens": value})


def test_c_negative_write_cannot_lower_the_cost():
    base = {"prompt_tokens": 1000, "completion_tokens": 100, "cached_tokens": 400}
    plain = calculate_cost(base, "anthropic", MODEL).usd
    negative = calculate_cost({**base, "cache_write_tokens": -300}, "anthropic", MODEL).usd
    assert negative >= plain


def test_c_write_tokens_beyond_the_prompt_cannot_exceed_the_priciest_possible_cost():
    """Garbage usage from a custom endpoint (write count far above the prompt) must not price into thousands of dollars."""
    _, _, creation, output = rates()
    usage = {"prompt_tokens": 1000, "completion_tokens": 100, "cache_write_tokens": 10**9}
    ceiling = 1000 * creation + 100 * output
    assert calculate_cost(usage, "anthropic", MODEL).usd <= ceiling * 1.0001


def test_c_object_and_dict_forms_agree():
    ns = types.SimpleNamespace(prompt_tokens=100, completion_tokens=5, total_tokens=105,
                               cache_creation_input_tokens=30, cache_read_input_tokens=20,
                               prompt_tokens_details=types.SimpleNamespace(cached_tokens=20, cache_creation_tokens=30))
    as_dict = {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105,
               "cache_creation_input_tokens": 30, "cache_read_input_tokens": 20,
               "prompt_tokens_details": {"cached_tokens": 20, "cache_creation_tokens": 30}}
    assert normalize_usage(ns) == normalize_usage(as_dict)


def test_c_real_litellm_usage_object_reports_the_write_tokens():
    from litellm.types.utils import Usage
    usage = Usage(prompt_tokens=1000, completion_tokens=10, total_tokens=1010,
                  cache_creation_input_tokens=300, cache_read_input_tokens=400)
    out = normalize_usage(usage)
    assert out["cache_write_tokens"] == 300 and out["cached_tokens"] == 400 and out["prompt_tokens"] == 1000


def test_c_explicit_zero_top_level_does_not_hide_a_detail_value():
    """prompt_tokens_details carries the write count while the top-level legacy field is a literal 0."""
    out = normalize_usage({"prompt_tokens": 100, "cache_creation_input_tokens": 0,
                           "prompt_tokens_details": {"cache_creation_tokens": 20}})
    assert out.get("cache_write_tokens") == 20


def test_c_openrouter_style_cache_write_tokens_detail_is_read():
    out = normalize_usage({"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 10, "cache_write_tokens": 20}})
    assert out.get("cache_write_tokens") == 20


def test_c_cost_counts_each_token_class_once():
    inp, read, creation, output = rates()
    usage = {"prompt_tokens": 1000, "completion_tokens": 100, "cached_tokens": 400, "cache_write_tokens": 300}
    expected = 300 * inp + 400 * read + 300 * creation + 100 * output
    result = calculate_cost(usage, "anthropic", MODEL)
    assert result.source == "litellm"
    assert result.usd == pytest.approx(expected, rel=1e-9)
    naive_double_count = 1000 * inp + 400 * read + 300 * creation + 100 * output
    assert result.usd < naive_double_count


def test_c_cost_ordering_and_monotonicity():
    base = {"prompt_tokens": 1000, "completion_tokens": 100}
    none = calculate_cost(base, "anthropic", MODEL).usd
    cached = calculate_cost({**base, "cached_tokens": 400}, "anthropic", MODEL).usd
    written = calculate_cost({**base, "cache_write_tokens": 400}, "anthropic", MODEL).usd
    both = calculate_cost({**base, "cached_tokens": 400, "cache_write_tokens": 300}, "anthropic", MODEL).usd
    assert cached < none < written
    assert both > cached
    last = -1.0
    for write in (0, 100, 300, 600, 1000):
        cost = calculate_cost({**base, "cache_write_tokens": write}, "anthropic", MODEL).usd
        assert cost >= last
        last = cost


@pytest.mark.parametrize("provider,model", [("openrouter", "vendor/paid-model-v9"), ("anthropic", "claude-unknown-9"),
                                            ("custom", "")])
def test_c_unpriced_models_with_write_tokens_stay_zero_estimates_not_errors(provider, model):
    result = calculate_cost({"prompt_tokens": 1000, "completion_tokens": 10, "cache_write_tokens": 500}, provider, model)
    assert result.usd >= 0.0
    assert result.source


@pytest.mark.parametrize("provider,model", [("ollama", "qwen3"), ("openrouter", "vendor/model:free")])
def test_c_free_and_local_models_stay_free_with_write_tokens(provider, model):
    result = calculate_cost({"prompt_tokens": 1000, "cache_write_tokens": 500}, provider, model)
    assert result.usd == 0.0 and result.source == "free"


def test_c_litellm_older_signature_falls_back_without_losing_the_cost(monkeypatch):
    calls = []

    def old_cost_per_token(model, prompt_tokens, completion_tokens, **extra):
        calls.append(extra)
        if extra:
            raise TypeError("unexpected keyword argument")
        return (0.001, 0.002)

    monkeypatch.setattr(litellm, "cost_per_token", old_cost_per_token)
    result = calculate_cost({"prompt_tokens": 100, "completion_tokens": 5, "cache_write_tokens": 30}, "anthropic", MODEL)
    assert result.usd == pytest.approx(0.003)
    assert calls[0] == {"cache_creation_input_tokens": 30} and calls[-1] == {}


def test_c_cost_call_gets_cache_creation_only_when_non_zero(monkeypatch):
    seen = []

    def spy(**kwargs):
        seen.append(kwargs)
        return (0.0, 0.0)

    monkeypatch.setattr(litellm, "cost_per_token", spy)
    calculate_cost({"prompt_tokens": 10, "completion_tokens": 1}, "anthropic", MODEL)
    calculate_cost({"prompt_tokens": 10, "completion_tokens": 1, "cache_write_tokens": 0}, "anthropic", MODEL)
    calculate_cost({"prompt_tokens": 10, "completion_tokens": 1, "cache_write_tokens": 4, "cached_tokens": 2}, "anthropic", MODEL)
    assert "cache_creation_input_tokens" not in seen[0] and "cache_creation_input_tokens" not in seen[1]
    assert seen[2]["cache_creation_input_tokens"] == 4 and seen[2]["cache_read_input_tokens"] == 2


@pytest.mark.parametrize("garbage", ["x", "1e3", None, [], {}, object(), float("nan"), "", " "])
def test_c_provider_garbage_in_the_write_field_survives_normalize_then_cost(garbage):
    """The supported path is normalize_usage first, then calculate_cost; both must tolerate junk."""
    usage = normalize_usage({"prompt_tokens": 100, "completion_tokens": 5, "cache_creation_input_tokens": garbage})
    assert calculate_cost(usage, "anthropic", MODEL).usd >= 0


def test_c_session_update_usage_prices_the_write_tokens_and_survives_renormalization():
    from andromity.core.session import Session
    session = Session(name="t", project_path=str(Path.cwd()))
    session.provider, session.model = "anthropic", MODEL
    usage = normalize_usage({"prompt_tokens": 1000, "completion_tokens": 100, "cache_creation_input_tokens": 300,
                             "cache_read_input_tokens": 400})
    session.update_usage(usage)
    inp, read, creation, output = rates()
    assert session.cost_usd == pytest.approx(300 * inp + 400 * read + 300 * creation + 100 * output, rel=1e-9)
    session.update_usage(usage)
    assert session.cost_usd == pytest.approx(2 * (300 * inp + 400 * read + 300 * creation + 100 * output), rel=1e-9)
    assert session.usage_breakdown["prompt_tokens"] == 2000


# ---------------------------------------------------------------------------
# D. litellm_loader
# ---------------------------------------------------------------------------

@pytest.fixture
def fresh_loader(monkeypatch):
    monkeypatch.setattr(loader, "_ready", threading.Event())
    return loader


class ImportHook:
    """Wraps builtins.__import__ for `import litellm` statements executed inside the loader module only."""

    def __init__(self, monkeypatch, delay=0.0, fail_first=0, delay_first_only=True):
        self.real = builtins.__import__
        self.delay = delay
        self.fail_first = fail_first
        self.delay_first_only = delay_first_only
        self.calls = []
        self.lock = threading.Lock()
        monkeypatch.setattr(builtins, "__import__", self._hook)

    def _hook(self, name, globals=None, locals=None, fromlist=(), level=0):
        if name == "litellm" and level == 0 and (globals or {}).get("__name__") == "andromity.core.litellm_loader":
            with self.lock:
                index = len(self.calls)
                self.calls.append((threading.get_ident(), time.perf_counter()))
            if index < self.fail_first:
                raise ImportError("simulated import failure")
            if self.delay and (index == 0 or not self.delay_first_only):
                time.sleep(self.delay)
        return self.real(name, globals, locals, fromlist, level)


async def lag_while(coro, interval=0.01):
    lags, stop = [], False

    async def ticker():
        while not stop:
            started = time.perf_counter()
            await asyncio.sleep(interval)
            lags.append(time.perf_counter() - started - interval)

    task = asyncio.create_task(ticker())
    await asyncio.sleep(0.05)
    try:
        result = await coro
    finally:
        stop = True
        await task
    return result, max(lags)


@bounded()
async def test_d_import_runs_in_a_worker_thread_and_does_not_block_the_loop(fresh_loader, monkeypatch):
    hook = ImportHook(monkeypatch, delay=0.6)
    loop_thread = threading.get_ident()
    module, worst = await lag_while(fresh_loader.load_litellm())
    assert module is litellm
    assert hook.calls and hook.calls[0][0] != loop_thread, "import executed on the event-loop thread"
    assert worst < 0.25, f"event loop stalled for {worst:.2f}s while LiteLLM imported"


@bounded()
async def test_d_fast_path_after_ready_does_not_touch_the_thread_pool(fresh_loader, monkeypatch):
    await fresh_loader.load_litellm()
    assert fresh_loader._ready.is_set()

    async def boom(*a, **k):
        raise AssertionError("fast path must not spawn a thread")

    monkeypatch.setattr(asyncio, "to_thread", boom)
    assert await fresh_loader.load_litellm() is litellm


@bounded()
async def test_d_many_concurrent_first_calls_import_once_and_return_the_same_module(fresh_loader, monkeypatch):
    hook = ImportHook(monkeypatch, delay=0.4)
    started = time.perf_counter()
    results = await asyncio.gather(*(fresh_loader.load_litellm() for _ in range(60)))
    elapsed = time.perf_counter() - started
    assert all(r is litellm for r in results)
    assert elapsed < 3.0, f"60 concurrent callers took {elapsed:.1f}s; the import must be shared"
    assert fresh_loader._ready.is_set()
    assert len({ident for ident, _ in hook.calls}) >= 1


@bounded()
async def test_d_concurrent_calls_do_not_starve_other_to_thread_users(fresh_loader, monkeypatch):
    ImportHook(monkeypatch, delay=0.8)
    waiters = [asyncio.create_task(fresh_loader.load_litellm()) for _ in range(40)]
    await asyncio.sleep(0.1)
    started = time.perf_counter()
    assert await asyncio.wait_for(asyncio.to_thread(lambda: 42), 5.0) == 42
    elapsed = time.perf_counter() - started
    await asyncio.gather(*waiters)
    assert elapsed < 1.5, f"an unrelated to_thread call waited {elapsed:.1f}s behind loader callers"


@bounded()
async def test_d_import_failure_surfaces_for_every_caller_and_does_not_hang(fresh_loader, monkeypatch):
    ImportHook(monkeypatch, fail_first=10**6)
    results = await asyncio.wait_for(
        asyncio.gather(*(fresh_loader.load_litellm() for _ in range(10)), return_exceptions=True), 5.0)
    assert all(isinstance(r, ImportError) for r in results), results
    assert not fresh_loader._ready.is_set(), "a failed import must not mark the loader ready"


@bounded()
async def test_d_failure_is_not_cached_and_a_later_call_recovers(fresh_loader, monkeypatch):
    ImportHook(monkeypatch, fail_first=1)
    with pytest.raises(ImportError):
        await fresh_loader.load_litellm()
    assert not fresh_loader._ready.is_set()
    assert await fresh_loader.load_litellm() is litellm
    assert fresh_loader._ready.is_set()


@bounded()
async def test_d_other_exception_types_also_surface(fresh_loader, monkeypatch):
    real = builtins.__import__

    def hook(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "litellm" and (globals or {}).get("__name__") == "andromity.core.litellm_loader":
            raise FileNotFoundError("model_prices_and_context_window_backup.json")
        return real(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", hook)
    with pytest.raises(FileNotFoundError):
        await asyncio.wait_for(fresh_loader.load_litellm(), 5.0)


@bounded()
async def test_d_cancelling_a_caller_does_not_break_the_import_for_the_next_one(fresh_loader, monkeypatch):
    ImportHook(monkeypatch, delay=0.5)
    first = asyncio.create_task(fresh_loader.load_litellm())
    await asyncio.sleep(0.1)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert await asyncio.wait_for(fresh_loader.load_litellm(), 5.0) is litellm
    assert fresh_loader._ready.is_set()


@bounded()
async def test_d_prewarm_thread_and_loop_callers_share_one_import(fresh_loader, monkeypatch):
    from andromity.server import main as server_main
    hook = ImportHook(monkeypatch, delay=0.5)
    thread = threading.Thread(target=server_main._prewarm_dependencies)
    thread.start()
    await asyncio.sleep(0.05)
    results = await asyncio.wait_for(asyncio.gather(*(fresh_loader.load_litellm() for _ in range(5))), 10.0)
    await asyncio.to_thread(thread.join, 10.0)
    assert not thread.is_alive()
    assert all(r is litellm for r in results)
    assert fresh_loader._ready.is_set()


def test_d_import_litellm_sets_the_ready_event_and_is_idempotent(fresh_loader):
    assert not fresh_loader._ready.is_set()
    first = fresh_loader.import_litellm()
    second = fresh_loader.import_litellm()
    assert first is second is litellm and fresh_loader._ready.is_set()
    assert litellm.drop_params is True and litellm.suppress_debug_info is True


def test_d_import_litellm_from_many_threads_is_safe(fresh_loader):
    errors, modules = [], []

    def work():
        try:
            modules.append(fresh_loader.import_litellm())
        except BaseException as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    assert not errors and len(modules) == 12 and all(m is litellm for m in modules)


@bounded()
async def test_d_stream_completion_surfaces_an_import_failure_instead_of_hanging(fresh_loader, monkeypatch):
    import andromity.core.provider as provider_mod
    ImportHook(monkeypatch, fail_first=10**6)

    async def consume():
        async for _ in provider_mod.stream_completion([{"role": "user", "content": "hi"}],
                                                      provider_name="openrouter", model="m"):
            pass

    with pytest.raises(ImportError):
        await asyncio.wait_for(consume(), 5.0)


@bounded()
async def test_d_title_generation_swallows_an_import_failure(fresh_loader, monkeypatch):
    from andromity.core.session import Session
    from andromity.server.rpc_handler import JsonRpcHandler
    ImportHook(monkeypatch, fail_first=10**6)
    handler = JsonRpcHandler(send_notification=lambda n: None)
    session = Session(name="orig", project_path=str(Path.cwd()))
    await asyncio.wait_for(handler._generate_ai_session_name(session, "make a title", "openrouter", "m"), 5.0)
    assert session.name == "orig"


@bounded()
async def test_d_title_generation_does_not_block_the_loop_while_importing(fresh_loader, monkeypatch):
    from andromity.core.session import Session
    from andromity.server.rpc_handler import JsonRpcHandler
    ImportHook(monkeypatch, delay=0.6)

    async def fake_acompletion(**kwargs):
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="A title"))])

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    handler = JsonRpcHandler(send_notification=lambda n: None)
    session = Session(name="orig", project_path=str(Path.cwd()))
    _, worst = await lag_while(handler._generate_ai_session_name(session, "make a title", "openrouter", "m"))
    assert worst < 0.25, f"loop stalled {worst:.2f}s during title generation import"
    assert session.name == "A title"


@bounded()
async def test_d_quick_prompt_import_failure_is_reported_not_hung(fresh_loader, monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler
    ImportHook(monkeypatch, fail_first=10**6)
    handler = JsonRpcHandler(send_notification=lambda n: None)
    with pytest.raises(RuntimeError) as info:
        await asyncio.wait_for(handler.rpc_agent_quickPrompt({"prompt": "x", "raw": True, "provider": "openrouter",
                                                              "model": "m"}), 10.0)
    assert "simulated import failure" in str(info.value) or "failed" in str(info.value).lower()


@bounded()
async def test_d_quick_prompt_does_not_block_the_loop_while_importing(fresh_loader, monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler
    ImportHook(monkeypatch, delay=0.6)

    def fake_completion(**kwargs):
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="feat: x y z"))])

    monkeypatch.setattr(litellm, "completion", fake_completion)
    handler = JsonRpcHandler(send_notification=lambda n: None)
    result, worst = await lag_while(handler.rpc_agent_quickPrompt(
        {"prompt": "x", "raw": True, "provider": "openrouter", "model": "m"}))
    assert result["message"] == "feat: x y z"
    assert worst < 0.25, f"loop stalled {worst:.2f}s during quickPrompt import"


def test_d_cold_import_does_not_stall_the_loop_in_a_fresh_interpreter():
    """Real LiteLLM cold import in a subprocess: the loop must keep ticking while it loads."""
    script = textwrap.dedent("""
        import asyncio, json, os, sys, time
        os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
        sys.path.insert(0, sys.argv[1])
        assert "litellm" not in sys.modules
        async def main():
            lags, stop = [], False
            async def ticker():
                while not stop:
                    t = time.perf_counter(); await asyncio.sleep(0.01)
                    lags.append(time.perf_counter() - t - 0.01)
            task = asyncio.create_task(ticker())
            await asyncio.sleep(0.05)
            from andromity.core.litellm_loader import load_litellm
            t0 = time.perf_counter()
            await load_litellm()
            took = time.perf_counter() - t0
            import andromity.core.provider as p
            t1 = time.perf_counter(); p._record_unprocessable_rejections(); rec = time.perf_counter() - t1
            stop = True; await task
            print(json.dumps({"import_s": took, "max_lag_s": max(lags), "record_s": rec}))
        asyncio.run(main())
    """)
    proc = subprocess.run([sys.executable, "-I", "-c", script, SRC], capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr[-2000:]
    data = json.loads(proc.stdout.strip().splitlines()[-1])
    assert data["max_lag_s"] < 0.5, data
    assert data["record_s"] < 0.5, f"first-call patching of LiteLLM blocks the loop: {data}"


def test_d_other_first_use_paths_do_not_import_litellm_on_the_loop():
    """agent.model_supports_vision imports LiteLLM inline for any direct-provider model it has no hard-coded
    answer for. It is reached on the loop when a prompt carries images."""
    script = textwrap.dedent("""
        import asyncio, json, os, sys, time
        os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
        sys.path.insert(0, sys.argv[1])
        assert "litellm" not in sys.modules
        async def main():
            lags, stop = [], False
            async def ticker():
                while not stop:
                    t = time.perf_counter(); await asyncio.sleep(0.01)
                    lags.append(time.perf_counter() - t - 0.01)
            task = asyncio.create_task(ticker())
            await asyncio.sleep(0.05)
            from andromity.core.agent import model_supports_vision
            model_supports_vision("xai", "grok-4")
            stop = True; await task
            print(json.dumps({"max_lag_s": max(lags)}))
        asyncio.run(main())
    """)
    proc = subprocess.run([sys.executable, "-I", "-c", script, SRC], capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr[-2000:]
    data = json.loads(proc.stdout.strip().splitlines()[-1])
    assert data["max_lag_s"] < 0.5, f"the loop froze for {data['max_lag_s']:.1f}s on a vision check: {data}"
