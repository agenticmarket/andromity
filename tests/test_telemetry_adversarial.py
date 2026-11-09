"""Adversarial tests for the telemetry client. Each test tries to break one stated guarantee."""
import email.message
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from andromity import telemetry
from andromity.config import config

LEGACY = not hasattr(telemetry, "_deliver")
TRUTHY = ("1", "true", "True", "TRUE")
SAFE_PING = "http://127.0.0.1:9/ping"
SAFE_EVENT = "http://127.0.0.1:9/event"
SRC = Path(telemetry.__file__).resolve().parents[1]
WORKER_USER_ID = re.compile(r"[a-zA-Z0-9_-]{8,64}")
SECRET_USER = "bobsecret"
SECRET_DIR = "secretproj"
RUN_ID = "0123456789abcdef0123456789abcdef"
new_client_only = pytest.mark.skipif(LEGACY, reason="internal state that the old client does not have")


def _wait(seconds: float) -> None:
    threading.Event().wait(seconds)


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, *args):
        return b"OK"

    def close(self):
        pass


class Network:
    """Stands in for urllib.request.urlopen and records every request body."""

    def __init__(self):
        self.requests = []
        self.raw = []
        self.respond = lambda url, payload: None
        self._lock = threading.Lock()

    def __call__(self, request, timeout=None, **kwargs):
        body = request.data
        payload = json.loads(body.decode("utf-8"))
        with self._lock:
            self.requests.append((request.full_url, payload))
            self.raw.append(body)
        outcome = self.respond(request.full_url, payload)
        if isinstance(outcome, BaseException):
            raise outcome
        return _Response()

    @property
    def payloads(self):
        with self._lock:
            return [payload for _, payload in self.requests]

    @property
    def urls(self):
        with self._lock:
            return [url for url, _ in self.requests]


def http_error(code, retry_after=None):
    headers = email.message.Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return urllib.error.HTTPError(SAFE_EVENT, code, "status", headers, io.BytesIO(b""))


class Exploding:
    def _boom(self, *args):
        raise RuntimeError("hostile value")

    __str__ = __repr__ = __bool__ = __float__ = __int__ = __index__ = _boom


class _ParkedSender:
    def is_alive(self):
        return True


def _join_legacy_threads(timeout=15.0):
    deadline = time.monotonic() + timeout
    for thread in threading.enumerate():
        if thread.name.endswith("(_post)"):
            thread.join(max(0.0, deadline - time.monotonic()))


def _enable_sending(monkeypatch):
    if hasattr(telemetry, "_suppressed"):
        monkeypatch.setattr(telemetry, "_suppressed", lambda: False)
        return

    def legacy_guard():
        env = os.environ
        if env.get("ANDROMITY_AIRGAP") == "1":
            return False
        if env.get("DO_NOT_TRACK") in TRUTHY or env.get("ANDROMITY_NO_TELEMETRY") in TRUTHY:
            return False
        return bool(config.get("default", "telemetry", True))

    monkeypatch.setattr(telemetry, "_should_send_telemetry", legacy_guard)


@pytest.fixture
def tele(monkeypatch):
    cfg = Path(os.environ["ANDROMITY_CONFIG_DIR"])
    for name in ("DO_NOT_TRACK", "ANDROMITY_NO_TELEMETRY", "ANDROMITY_AIRGAP", "CI",
                 "ANDROMITY_INTERNAL", "ANDROMITY_CLIENT"):
        monkeypatch.delenv(name, raising=False)
    net = Network()
    monkeypatch.setattr(urllib.request, "urlopen", net)
    monkeypatch.setattr(telemetry, "_PING_ENDPOINT", SAFE_PING)
    monkeypatch.setattr(telemetry, "_EVENT_ENDPOINT", SAFE_EVENT)
    if hasattr(telemetry, "_ENDPOINTS"):
        monkeypatch.setattr(telemetry, "_ENDPOINTS", (SAFE_PING, SAFE_EVENT))
    _enable_sending(monkeypatch)
    monkeypatch.setattr(telemetry, "_tracked_sessions", set())
    if LEGACY:
        monkeypatch.setattr(time, "sleep", lambda seconds: None)
    else:
        monkeypatch.setattr(telemetry, "_queued", [])
        monkeypatch.setattr(telemetry, "_unspooled", [])
        monkeypatch.setattr(telemetry, "_retry_at", 0.0)
        monkeypatch.setattr(telemetry, "_failures", 0)
        monkeypatch.setattr(telemetry, "_user_ids", {})
        monkeypatch.setattr(telemetry, "_wake", threading.Event())
        monkeypatch.setattr(telemetry, "_sender", _ParkedSender())
    yield SimpleNamespace(cfg=cfg, net=net, spool=cfg / ".telemetry_outbox.json", id_file=cfg / ".telemetry_uuid")
    _join_legacy_threads()


def drain(rounds=1):
    """Run delivery the way the background sender does: errors are swallowed, the outcome is checked."""
    errors = []
    if LEGACY:
        _join_legacy_threads()
        return errors
    for _ in range(rounds):
        try:
            telemetry._deliver()
        except Exception as error:
            errors.append(error)
    return errors


def expire_backoff():
    if not LEGACY:
        telemetry._retry_at = 0.0


def seed(spool: Path, count=1, age=0.0, endpoint=None):
    items = [{"endpoint": endpoint or SAFE_EVENT, "queued": time.time() - age,
              "payload": {"event": "feature_use", "feature_name": f"seed{i}", "user_id": "seeduser01",
                          "session_id": "", "event_id": uuid.uuid4().hex}}
             for i in range(count)]
    spool.parent.mkdir(parents=True, exist_ok=True)
    spool.write_text(json.dumps(items), encoding="utf-8")
    return [item["payload"]["event_id"] for item in items]


def spooled(spool: Path):
    if not spool.exists():
        return []
    return json.loads(spool.read_text(encoding="utf-8"))


def _call_every_public_function():
    telemetry.send_task_event("task_started", "sess-optout", RUN_ID, provider="openai", model="gpt-4o")
    telemetry.send_session_start("sess-optout", provider="openai", model="gpt-4o")
    telemetry.send_session_update("sess-optout", turn_count=2, duration_sec=5)
    telemetry.send_feature_used("waterfall", session_id="sess-optout")
    telemetry.send_session_end("sess-optout", provider="openai", model="gpt-4o", turn_count=2)


def _unwritable_config_dir(tmp_path: Path) -> Path:
    blocker = tmp_path / "config_is_a_file"
    blocker.write_text("not a directory", encoding="utf-8")
    return blocker / "andromity"


# ── Guarantee 1: public functions never raise and never block ────────────────

HOSTILE_CALLS = {
    "task_event_all_none": lambda: telemetry.send_task_event(None, None, None),
    "task_event_bad_outcome": lambda: telemetry.send_task_event("task_finished", "sess-1234", RUN_ID, outcome="exploded"),
    "task_event_unknown_event": lambda: telemetry.send_task_event("rm -rf /", "sess-1234", RUN_ID),
    "task_event_short_run_id": lambda: telemetry.send_task_event("task_started", "sess-1234", "short"),
    "task_event_int_run_id": lambda: telemetry.send_task_event("task_started", "sess-1234", 12345678901234567890),
    "task_event_nan_inf": lambda: telemetry.send_task_event(
        "task_finished", "sess-1234", RUN_ID, outcome="completed",
        active_seconds=float("nan"), first_response_ms=float("inf")),
    "task_event_huge_ints": lambda: telemetry.send_task_event(
        "task_finished", "sess-1234", RUN_ID, outcome="failed", active_seconds=10 ** 400, first_response_ms=10 ** 400),
    "task_event_wrong_types": lambda: telemetry.send_task_event(
        "task_started", ["sess"], RUN_ID, active_seconds="soon", first_response_ms="fast",
        provider=b"\xff\xfe", model=Exploding()),
    "session_start_hostile": lambda: telemetry.send_session_start(
        {"id": 1}, provider=object(), model=12.5, reasoning_effort=["high"],
        mcp_tools_count=float("nan"), profile=Exploding(), duration_sec=float("-inf")),
    "session_start_huge": lambda: telemetry.send_session_start(
        "sess-huge", mcp_tools_count=10 ** 400, duration_sec=10 ** 400),
    "session_update_int_session": lambda: telemetry.send_session_update(42, turn_count=float("nan"), duration_sec="long"),
    "session_update_huge": lambda: telemetry.send_session_update("sess-1234", turn_count=10 ** 400, duration_sec=float("inf")),
    "feature_exploding_name": lambda: telemetry.send_feature_used(Exploding(), session_id=object()),
    "feature_none": lambda: telemetry.send_feature_used(None, None),
    "session_end_hostile": lambda: telemetry.send_session_end(
        b"sess", provider=None, model=None, turn_count="many", had_error=Exploding(),
        duration_sec=float("nan"), tool_counts={"bash": float("nan"), "file": "lots", "web": 10 ** 400}),
    "session_end_counts_not_a_dict": lambda: telemetry.send_session_end("sess-1234", tool_counts=[("bash", 3)]),
    "session_end_negative": lambda: telemetry.send_session_end("sess-1234", turn_count=-5, duration_sec=-100.0),
    "huge_strings": lambda: (telemetry.send_session_end("x" * 5_000_000, provider="p" * 5_000_000, model="m" * 5_000_000),
                             telemetry.send_feature_used("f" * 5_000_000, session_id="s" * 5_000_000)),
}


@pytest.mark.parametrize("name", HOSTILE_CALLS)
def test_public_function_never_raises_or_blocks_on_hostile_input(tele, name):
    start = time.monotonic()
    HOSTILE_CALLS[name]()
    assert time.monotonic() - start < 0.5
    assert drain() == []


def _strict_json(body: bytes):
    def refuse(constant):
        raise ValueError(f"non-standard JSON constant {constant}")
    return json.loads(body.decode("utf-8"), parse_constant=refuse)


def test_numeric_fields_are_finite_bounded_and_strict_json(tele):
    telemetry.send_task_event("task_finished", "sess-1234", RUN_ID, outcome="completed",
                              active_seconds=float("nan"), first_response_ms=float("inf"))
    telemetry.send_session_start("sess-numbers", mcp_tools_count=float("inf"), duration_sec=float("nan"))
    telemetry.send_session_update("sess-1234", turn_count=float("nan"), duration_sec=float("inf"))
    telemetry.send_session_end("sess-1234", turn_count=float("inf"), duration_sec=float("inf"),
                               tool_counts={"bash": float("nan"), "file": -3, "web": 10 ** 30})
    drain()
    assert len(tele.net.raw) == 4
    for body in tele.net.raw:
        payload = _strict_json(body)
        for field in ("duration_seconds",):
            if field in payload:
                assert 0 <= payload[field] <= 7 * 86400
        for field in ("turn_count", "tool_bash_count", "tool_file_count", "tool_web_count"):
            if field in payload:
                assert 0 <= payload[field] <= 9999
        if payload["event"] == "task_finished":
            assert 0 <= payload["active_seconds"] <= 7 * 86400
            assert payload["first_response_ms"] is None or 0 <= payload["first_response_ms"] <= 86_400_000


def _write_child(tmp_path: Path) -> Path:
    script = tmp_path / "telemetry_child.py"
    script.write_text(CHILD, encoding="utf-8")
    return script


def _child_env(cfg: Path, network: str) -> dict:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("PYTEST") and key not in (
               "CI", "DO_NOT_TRACK", "ANDROMITY_NO_TELEMETRY", "ANDROMITY_AIRGAP",
               "ANDROMITY_INTERNAL", "ANDROMITY_CLIENT")}
    env.update(ANDROMITY_CONFIG_DIR=str(cfg), PYTHONPATH=str(SRC), PYTHONDONTWRITEBYTECODE="1",
               CHILD_NETWORK=network)
    return env


def _spawn(script, scenario, out, go, *args, cfg, network="fail"):
    return subprocess.Popen([sys.executable, str(script), scenario, str(out), str(go), *map(str, args)],
                            env=_child_env(cfg, network), stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _finish(process, timeout):
    try:
        out, err = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        out, err = process.communicate(timeout=5)
        raise AssertionError(f"child timed out: {err.decode(errors='replace')[-2000:]}")
    assert process.returncode == 0, err.decode(errors="replace")[-2000:]
    return out


def _wait_for(paths, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if all(Path(p).exists() for p in paths):
            return True
        _wait(0.01)
    return False


def _shared_config(tmp_path: Path) -> Path:
    cfg = tmp_path / "shared_config"
    cfg.mkdir()
    (cfg / "config.toml").write_text("[default]\ntelemetry = true\n", encoding="utf-8")
    return cfg


def test_first_event_does_not_stall_the_caller_while_another_process_holds_the_lock(tele, tmp_path):
    script = _write_child(tmp_path)
    locked = tmp_path / "locked.flag"
    holder = _spawn(script, "hold_lock", tmp_path / "hold.json", locked,
                    tele.cfg / ".telemetry.lock", 6, cfg=tele.cfg)
    try:
        assert _wait_for([locked], 10), "lock holder did not start"
        start = time.monotonic()
        telemetry.send_feature_used("app_started")
        elapsed = time.monotonic() - start
    finally:
        holder.kill()
        holder.communicate(timeout=5)
    assert elapsed < 0.5, f"send_feature_used blocked the caller for {elapsed:.2f}s"


def test_burst_of_1000_events_uses_one_thread_and_returns_at_once(tmp_path):
    cfg = _shared_config(tmp_path)
    script = _write_child(tmp_path)
    go = tmp_path / "go"
    go.write_text("go")
    out = tmp_path / "burst.json"
    _finish(_spawn(script, "burst", out, go, 1000, 10, cfg=cfg, network="hang"), timeout=20)
    result = json.loads(out.read_text())
    assert result["send_seconds"] < 2.0, result
    assert result["max_telemetry_threads"] <= 1, result
    assert result["max_threads"] <= 10 + 3, result


# ── Guarantee 2: opting out sends nothing and deletes waiting events ─────────

OPT_OUTS = {
    "do_not_track": lambda mp: mp.setenv("DO_NOT_TRACK", "1"),
    "andromity_no_telemetry": lambda mp: mp.setenv("ANDROMITY_NO_TELEMETRY", "1"),
    "config_false": lambda mp: config.set("default", "telemetry", False),
    "airgap": lambda mp: mp.setenv("ANDROMITY_AIRGAP", "1"),
}


@pytest.mark.parametrize("opt_out", OPT_OUTS)
def test_opt_out_sends_nothing_and_deletes_waiting_events(tele, monkeypatch, opt_out):
    seed(tele.spool, 3)
    OPT_OUTS[opt_out](monkeypatch)
    _call_every_public_function()
    drain(2)
    assert tele.net.requests == []
    assert spooled(tele.spool) == []


@new_client_only
def test_opt_out_after_events_were_queued_drops_them_unsent(tele, monkeypatch):
    telemetry.send_feature_used("queued_before_opt_out")
    monkeypatch.setenv("DO_NOT_TRACK", "1")
    drain(2)
    assert tele.net.requests == []
    assert spooled(tele.spool) == []


@new_client_only
def test_events_queued_at_exit_are_not_kept_after_opting_out(tele, monkeypatch):
    telemetry.send_feature_used("queued_at_exit")
    monkeypatch.setenv("ANDROMITY_NO_TELEMETRY", "1")
    telemetry._spool_on_exit()
    assert spooled(tele.spool) == []


def test_config_telemetry_string_false_is_treated_as_opt_out(tele):
    config.set("default", "telemetry", "false")
    telemetry.send_feature_used("probe")
    drain()
    assert tele.net.requests == []


# ── Guarantee 3: spool first, bounded, survives corruption ───────────────────

def test_spool_never_holds_more_than_100_events(tele):
    tele.net.respond = lambda url, payload: OSError("offline")
    for batch in range(25):
        for i in range(10):
            telemetry.send_feature_used(f"burst_{batch}_{i}")
        drain()
        assert len(spooled(tele.spool)) <= 100
    names = {item["payload"]["feature_name"] for item in spooled(tele.spool)}
    assert "burst_24_9" in names


def test_events_older_than_seven_days_are_never_sent(tele):
    old = seed(tele.spool, 2, age=8 * 86400)
    items = spooled(tele.spool)
    fresh = [{"endpoint": SAFE_EVENT, "queued": time.time() - 3600,
              "payload": {"event": "feature_use", "feature_name": "fresh", "user_id": "seeduser01",
                          "event_id": uuid.uuid4().hex}}]
    tele.spool.write_text(json.dumps(items + fresh), encoding="utf-8")
    telemetry.send_feature_used("trigger")
    drain()
    sent = {payload["event_id"] for payload in tele.net.payloads}
    assert fresh[0]["payload"]["event_id"] in sent
    assert not sent & set(old)
    assert spooled(tele.spool) == []


CORRUPT_SPOOLS = {
    "garbage_bytes": b"\x00\xffnot json at all",
    "json_object": b'{"endpoint": "x"}',
    "json_null": b"null",
    "list_of_numbers": b"[1, 2, 3]",
    "invalid_utf8": b'[{"endpoint": "\xff\xfe"}]',
    "deeply_nested_array": b"[" * 100_000,
    "over_one_megabyte": b'["' + b"x" * (2 << 20) + b'"]',
    "malformed_items": json.dumps([
        {"endpoint": SAFE_EVENT, "queued": "yesterday", "payload": {"event_id": 5}},
        {"endpoint": SAFE_EVENT, "queued": float("nan"), "payload": {"event_id": "a" * 32}},
        {"endpoint": SAFE_EVENT, "queued": True, "payload": {"event_id": "b" * 32}},
        {"endpoint": SAFE_EVENT, "queued": 1e308, "payload": {"event_id": "c" * 32}},
        {"endpoint": SAFE_EVENT, "payload": "not a dict", "queued": 0},
    ]).encode(),
}


@pytest.mark.parametrize("kind", CORRUPT_SPOOLS)
def test_corrupted_spool_neither_crashes_nor_wedges_delivery(tele, kind):
    tele.spool.write_bytes(CORRUPT_SPOOLS[kind])
    telemetry.send_feature_used("after_corruption")
    errors = drain(2)
    telemetry.send_feature_used("second_event")
    errors += drain(2)
    names = [payload.get("feature_name") for payload in tele.net.payloads]
    assert "after_corruption" in names, f"fresh event lost; delivery raised {errors!r}"
    assert "second_event" in names, f"delivery stayed wedged; raised {errors!r}"
    assert set(tele.net.urls) <= {SAFE_PING, SAFE_EVENT}


def test_spool_path_occupied_by_a_directory_still_delivers(tele):
    tele.spool.mkdir()
    telemetry.send_feature_used("dir_in_the_way")
    drain()
    assert "dir_in_the_way" in [payload.get("feature_name") for payload in tele.net.payloads]


def test_spool_entry_cannot_redirect_events_to_another_host(tele):
    seed(tele.spool, 1, endpoint="http://127.0.0.1:9/attacker")
    items = spooled(tele.spool)
    items.append({"endpoint": "https://evil.example/collect", "queued": time.time(),
                  "payload": {"event": "feature_use", "event_id": uuid.uuid4().hex}})
    tele.spool.write_text(json.dumps(items), encoding="utf-8")
    telemetry.send_feature_used("trigger")
    drain()
    assert set(tele.net.urls) <= {SAFE_PING, SAFE_EVENT}


def test_event_id_is_kept_when_the_spool_cannot_be_written(tele, tmp_path, monkeypatch):
    monkeypatch.setenv("ANDROMITY_CONFIG_DIR", str(_unwritable_config_dir(tmp_path)))
    attempts = []

    def offline_once(url, payload):
        attempts.append(payload["event_id"])
        return OSError("offline") if len(attempts) == 1 else None

    tele.net.respond = offline_once
    telemetry.send_feature_used("unspoolable")
    drain()
    expire_backoff()
    drain()
    ids = [payload["event_id"] for payload in tele.net.payloads if payload.get("feature_name") == "unspoolable"]
    assert len(ids) == 2 and ids[0] == ids[1]


@new_client_only
def test_event_that_could_not_be_spooled_once_survives_exit_while_offline(tele, tmp_path):
    tele.id_file.write_text(uuid.uuid4().hex, encoding="utf-8")
    tele.net.respond = lambda url, payload: OSError("offline")
    script = _write_child(tmp_path)
    locked = tmp_path / "locked.flag"
    holder = _spawn(script, "hold_lock", tmp_path / "hold.json", locked,
                    tele.cfg / ".telemetry.lock", 2.5, cfg=tele.cfg)
    try:
        assert _wait_for([locked], 10), "lock holder did not start"
        telemetry.send_feature_used("contended")
        drain()
    finally:
        holder.communicate(timeout=10)
    telemetry._spool_on_exit()
    names = [item["payload"].get("feature_name") for item in spooled(tele.spool)]
    assert "contended" in names, "the event was never spooled and is gone once the process exits"


# ── Guarantee 4: HTTP status handling ─────────────────────────────────────────

@pytest.mark.parametrize("code", [400, 401, 403, 404, 410, 413, 422])
def test_permanent_client_error_drops_the_event(tele, code):
    tele.net.respond = lambda url, payload: http_error(code)
    telemetry.send_feature_used("rejected")
    drain()
    expire_backoff()
    drain()
    assert len(tele.net.requests) == 1
    assert spooled(tele.spool) == []


def test_rejected_event_does_not_stop_the_round(tele):
    seed(tele.spool, 1)
    rejected = spooled(tele.spool)[0]["payload"]["event_id"]
    tele.net.respond = lambda url, payload: http_error(400) if payload["event_id"] == rejected else None
    telemetry.send_feature_used("after_rejected")
    drain()
    assert "after_rejected" in [payload.get("feature_name") for payload in tele.net.payloads]
    assert spooled(tele.spool) == []


TRANSIENT = {
    "http_408": lambda: http_error(408),
    "http_500": lambda: http_error(500),
    "http_502": lambda: http_error(502),
    "http_503": lambda: http_error(503),
    "url_error": lambda: urllib.error.URLError("dns failure"),
    "socket_timeout": lambda: TimeoutError("timed out"),
    "connection_reset": lambda: ConnectionResetError("reset"),
}


@pytest.mark.parametrize("failure", TRANSIENT)
def test_transient_failure_keeps_the_event_backs_off_then_retries(tele, failure):
    calls = []

    def respond(url, payload):
        calls.append(payload["event_id"])
        return TRANSIENT[failure]() if len(calls) == 1 else None

    tele.net.respond = respond
    telemetry.send_feature_used("flaky")
    drain()
    assert len(calls) == 1
    assert [item["payload"]["event_id"] for item in spooled(tele.spool)] == calls
    drain()
    assert len(calls) == 1, "retried without waiting"
    expire_backoff()
    drain()
    assert len(calls) == 2 and calls[0] == calls[1]
    assert spooled(tele.spool) == []


@new_client_only
@pytest.mark.parametrize("header,low,high", [
    ("120", 115, 125),
    ("0", 1, 3600),
    ("-5", 1, 3600),
    ("nan", 1, 3600),
    ("inf", 1, 3600),
    ("1e12", 1, 3600),
    ("Wed, 21 Oct 2026 07:28:00 GMT", 1, 3600),
    (None, 1, 3600),
])
def test_rate_limit_waits_for_retry_after(tele, header, low, high):
    tele.net.respond = lambda url, payload: http_error(429, header)
    telemetry.send_feature_used("limited")
    drain()
    wait = telemetry._retry_at - time.monotonic()
    assert low <= wait <= high
    assert len(spooled(tele.spool)) == 1
    telemetry.send_feature_used("while_waiting")
    drain()
    assert len(tele.net.requests) == 1


def test_offline_round_makes_one_attempt_not_one_per_event(tele):
    seed(tele.spool, 30)
    tele.net.respond = lambda url, payload: OSError("offline")
    telemetry.send_feature_used("one_more")
    drain()
    assert len(tele.net.requests) == 1


# ── Guarantee 5: an event that keeps failing is dropped ──────────────────────

def test_event_failing_forever_is_dropped_after_ten_attempts(tele):
    tele.net.respond = lambda url, payload: http_error(500)
    telemetry.send_feature_used("doomed")
    for _ in range(15):
        drain()
        expire_backoff()
    assert len(tele.net.requests) == 10
    assert spooled(tele.spool) == []


def test_poison_event_does_not_block_the_queue_forever(tele):
    poison = seed(tele.spool, 1)[0]
    tele.net.respond = lambda url, payload: http_error(503) if payload["event_id"] == poison else None
    telemetry.send_feature_used("behind_the_poison")
    for _ in range(12):
        drain()
        expire_backoff()
    assert "behind_the_poison" in [payload.get("feature_name") for payload in tele.net.payloads]


# ── Guarantee 7: processes sharing a config dir ──────────────────────────────

@pytest.mark.parametrize("network", ["fail", "ok"])
def test_processes_sharing_a_config_dir_lose_no_events(tmp_path, network):
    cfg = _shared_config(tmp_path)
    script = _write_child(tmp_path)
    go = tmp_path / "go"
    children, outs = 6, []
    processes = []
    for n in range(children):
        out = tmp_path / f"child{n}.json"
        outs.append(out)
        processes.append(_spawn(script, "spool", out, go, f"p{n}", 15, cfg=cfg, network=network))
    try:
        assert _wait_for([Path(f"{out}.ready") for out in outs], 15), "children did not start"
        go.write_text("go")
        for process in processes:
            _finish(process, timeout=20)
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
    expected = {f"p{n}_{i}" for n in range(children) for i in range(15)}
    in_spool = {item["payload"].get("feature_name") for item in spooled(cfg / ".telemetry_outbox.json")}
    delivered = set()
    for out in outs:
        delivered |= set(json.loads(out.read_text())["delivered"])
    missing = expected - in_spool - delivered
    assert not missing, f"{len(missing)} of {len(expected)} events lost, e.g. {sorted(missing)[:5]}"
    assert not list(cfg.glob("*.tmp")), "temporary files left behind"


def test_eleven_short_offline_runs_keep_every_event(tmp_path):
    cfg = _shared_config(tmp_path)
    script = _write_child(tmp_path)
    go = tmp_path / "go"
    go.write_text("go")
    for n in range(11):
        _finish(_spawn(script, "spool", tmp_path / f"run{n}.json", go, f"run{n}", 1, cfg=cfg, network="fail"),
                timeout=20)
    in_spool = {item["payload"].get("feature_name") for item in spooled(cfg / ".telemetry_outbox.json")}
    missing = {f"run{n}_0" for n in range(11)} - in_spool
    assert not missing, f"offline events dropped although each process tried only once: {sorted(missing)}"


# ── Guarantee 8: installation ID ──────────────────────────────────────────────

def test_installation_id_is_stable_in_process_when_config_dir_is_unwritable(tele, tmp_path, monkeypatch):
    monkeypatch.setenv("ANDROMITY_CONFIG_DIR", str(_unwritable_config_dir(tmp_path)))
    telemetry.send_feature_used("one")
    telemetry.send_session_update("sess-1234", turn_count=1)
    telemetry.send_session_end("sess-1234")
    drain()
    ids = {payload["user_id"] for payload in tele.net.payloads}
    assert len(tele.net.payloads) == 3
    assert len(ids) == 1
    assert WORKER_USER_ID.fullmatch(ids.pop())


@pytest.mark.parametrize("junk", [
    b"", b"   \n", b"short", b"has spaces in it", b"../../../etc/passwd", b"\xff\xfe\x00junk",
    b"a" * 65, b"<script>alert(1)</script>", b"C:\\Users\\bobsecret",
])
def test_junk_installation_id_is_replaced_with_a_valid_one(tele, junk):
    tele.id_file.write_bytes(junk)
    user_id = telemetry._get_or_create_user_id()
    assert WORKER_USER_ID.fullmatch(user_id)
    assert tele.id_file.read_text(encoding="utf-8").strip() == user_id
    telemetry.send_feature_used("probe")
    drain()
    assert tele.net.payloads[-1]["user_id"] == user_id


def test_installation_id_is_reused_by_the_next_process(tmp_path):
    cfg = _shared_config(tmp_path)
    script = _write_child(tmp_path)
    go = tmp_path / "go"
    go.write_text("go")
    ids = []
    for n in range(2):
        out = tmp_path / f"id{n}.json"
        _finish(_spawn(script, "user_id", out, go, cfg=cfg), timeout=20)
        ids.append(json.loads(out.read_text())["user_id"])
    assert ids[0] == ids[1] == (cfg / ".telemetry_uuid").read_text(encoding="utf-8").strip()


def test_processes_racing_on_first_run_persist_one_installation_id(tmp_path):
    cfg = _shared_config(tmp_path)
    script = _write_child(tmp_path)
    go = tmp_path / "go"
    outs = [tmp_path / f"race{n}.json" for n in range(8)]
    processes = [_spawn(script, "user_id", out, go, cfg=cfg) for out in outs]
    try:
        assert _wait_for([Path(f"{out}.ready") for out in outs], 15), "children did not start"
        go.write_text("go")
        for process in processes:
            _finish(process, timeout=20)
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
    ids = {json.loads(out.read_text())["user_id"] for out in outs}
    persisted = (cfg / ".telemetry_uuid").read_text(encoding="utf-8").strip()
    assert ids == {persisted}


# ── Guarantee 9: model names given as paths, and API keys ────────────────────

PATH_MODELS = [
    (r"C:\Users\bobsecret\secretproj\llama-3-8b.Q4_K_M.gguf", "llama-3-8b.Q4_K_M"),
    ("C:/Users/bobsecret/secretproj/llama.gguf", "llama"),
    ("/home/bobsecret/secretproj/llama.gguf", "llama"),
    ("~/secretproj/llama.gguf", "llama"),
    ("file:///home/bobsecret/secretproj/llama.gguf", "llama"),
    ("file:///C:/Users/bobsecret/secretproj/llama.gguf", "llama"),
    ("./secretproj/llama.gguf", "llama"),
    (r".\secretproj\llama.gguf", "llama"),
    ("../bobsecret/llama.safetensors", "llama"),
    (r"\\fileserver\bobsecret\models\llama.bin", "llama"),
    ("secretproj/bobsecret/llama.gguf", "llama"),
    ("FILE:///home/bobsecret/secretproj/llama.GGUF", "llama"),
    ("  /home/bobsecret/secretproj/llama.gguf \n", "llama"),
    ("/Users/bobsecret/secretproj/model.onnx", "model"),
    (r"%USERPROFILE%\secretproj\llama.gguf", "llama"),
    (r"\\?\C:\Users\bobsecret\llama.gguf", "llama"),
    (r"C:\Users\bobsecret\secretproj\llama.gguf" + "\\", "llama"),
]

OTHER_PATHS = [
    "/home/bobsecret/secretproj/Llama-3-8B",
    "d:/work/bobsecret/secretproj/mistral",
    "~/secretproj/Llama-3-8B",
    r"\\fileserver\bobsecret\models",
    r"C:\Users\bobsecret" + "\\",
    "/home/bobsecret/",
    "C:Users/bobsecret/secretproj/mistral",
]

URL_MODELS = [
    "http://bobsecret-laptop.local:1234/v1/models/qwen",
    "https://bobsecret:hunter2pass@llm.internal/v1/chat",
    "HTTP://10.0.0.5:8080/secretproj/llama",
]


def _model_payloads(tele, model):
    telemetry.send_task_event("task_started", "sess-1234", RUN_ID, provider="ollama", model=model)
    telemetry.send_session_start("sess-model", provider="ollama", model=model)
    telemetry.send_session_end("sess-1234", provider="ollama", model=model)
    drain()
    return tele.net.payloads


@pytest.mark.parametrize("model,expected", PATH_MODELS)
def test_model_path_is_reduced_to_its_file_name(tele, model, expected):
    payloads = _model_payloads(tele, model)
    assert len(payloads) == 3
    for payload in payloads:
        assert payload["model"] == expected
        dumped = json.dumps(payload)
        assert SECRET_USER not in dumped and SECRET_DIR not in dumped


@pytest.mark.parametrize("model", OTHER_PATHS)
def test_path_that_is_not_a_model_file_is_sent_as_local_path(tele, model):
    for payload in _model_payloads(tele, model):
        assert SECRET_USER not in payload["model"] and SECRET_DIR not in payload["model"], payload["model"]
        assert payload["model"] == "local-path"


@pytest.mark.parametrize("model", URL_MODELS)
def test_model_given_as_a_url_is_sent_as_url(tele, model):
    for payload in _model_payloads(tele, model):
        assert SECRET_USER not in payload["model"] and "hunter2" not in payload["model"], payload["model"]
        assert payload["model"] == "url"


@pytest.mark.parametrize("model", [
    "openrouter/anthropic/claude-sonnet-4", "llama3:8b", "hf.co/org/repo:Q4_K_M", "gpt-4o",
    "qwen2.5-coder:32b", "meta-llama/Llama-3.1-8B-Instruct", "gemini/gemini-2.5-pro",
    "us.anthropic.claude-3-5-sonnet-20241022-v2:0", "deepseek-chat",
    "accounts/fireworks/models/llama-v3p1-70b-instruct", "ollama/llama3.1:latest", "mistral-large-latest",
])
def test_normal_model_ids_pass_unchanged(tele, model):
    for payload in _model_payloads(tele, model):
        assert payload["model"] == model


API_KEYS = {
    "openai_project": ("sk-proj-" + "Ab3dEf6hIj9lMn2pQr5tUv8x" * 2, "Ab3dEf6hIj"),
    "openrouter_prefixed": ("openrouter/sk-or-v1-" + "0123456789abcdef" * 4, "0123456789ab"),
    "anthropic": ("sk-ant-api03-" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2" * 2, "Zz9Yy8Xx7W"),
    "google": ("AIzaSy" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n", "A1b2C3d4E5"),
    "huggingface": ("hf_" + "AbCdEfGhIjKlMnOpQrStUvWxYz01234567", "AbCdEfGhIj"),
    "perplexity": ("pplx-" + "a1B2c3D4e5F6g7H8i9J0" * 2 + "k1L2m3N4", "a1B2c3D4e5"),
    "key_split_by_newline": ("sk-abcdefghij\nklmnopqrstuvwxyz0123", "ghijklmnop"),
    "key_split_by_space": ("sk-proj-abc def0123456789ghijklmnop", "abcdef0123"),
    "jwt": ("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "eyJzdWIiOi"),
    "key_as_gguf_file_name": (r"C:\keys\sk-proj-abcdefghijklmnopqrstuvwx.gguf", "abcdefghij"),
}


@pytest.mark.parametrize("kind", API_KEYS)
def test_api_key_in_model_or_provider_is_never_sent(tele, kind):
    key, fragment = API_KEYS[kind]
    telemetry.send_session_end("sess-1234", provider=key, model=key)
    telemetry.send_session_start("sess-key", provider=key, model=key)
    telemetry.send_task_event("task_started", "sess-1234", RUN_ID, provider=key, model=key)
    drain()
    assert len(tele.net.payloads) == 3
    for payload in tele.net.payloads:
        assert fragment not in payload["model"], payload["model"]
        assert fragment not in payload["provider"], payload["provider"]


# ── Guarantee 10: session IDs ─────────────────────────────────────────────────

def _session_ids_sent(tele, session_id):
    telemetry.send_task_event("task_started", session_id, RUN_ID)
    telemetry.send_session_start(session_id)
    telemetry.send_session_update(session_id, turn_count=1)
    telemetry.send_feature_used("probe", session_id=session_id)
    telemetry.send_session_end(session_id)
    drain()
    return {payload["event"]: payload.get("session_id") for payload in tele.net.payloads}


@pytest.mark.parametrize("session_id", [
    "0123456789abcdef0123456789abcdef01234567",
    "A" * 48,
    "0f8fad5b-d9cb-469f-a165-70867728950e",
    "sess-abc_123",
])
def test_valid_session_id_is_identical_in_every_event(tele, session_id):
    sent = _session_ids_sent(tele, session_id)
    assert set(sent) == {"task_started", "session_start", "session_update", "feature_use", "session_end"}
    assert set(sent.values()) == {session_id}, sent


@pytest.mark.parametrize("session_id", [
    "bad id!", "x" * 65, "ab", 12345, "../../etc/passwd", "sk-" + "a" * 30, r"C:\Users\bobsecret",
])
def test_invalid_session_id_is_sent_empty_in_every_event(tele, session_id):
    sent = _session_ids_sent(tele, session_id)
    for event in ("task_started", "session_start", "feature_use", "session_end"):
        assert sent.get(event) == "", (event, sent)
    assert sent.get("session_update", "") == ""


# ── Guarantee 11: first-run notice ────────────────────────────────────────────

def test_notice_is_returned_once_per_installation(tele):
    first = telemetry.take_first_run_notice()
    assert first and "DO_NOT_TRACK" in first
    assert telemetry.take_first_run_notice() is None
    assert telemetry.take_first_run_notice() is None


@pytest.mark.parametrize("off", [*OPT_OUTS, "ci", "internal"])
def test_notice_is_never_returned_while_off_and_shown_once_turned_on(tele, monkeypatch, off):
    with monkeypatch.context() as patch:
        if off == "ci":
            patch.setenv("CI", "true")
            patch.setattr(telemetry, "_suppressed", lambda: os.environ.get("CI") in TRUTHY)
        elif off == "internal":
            patch.setenv("ANDROMITY_INTERNAL", "1")
            patch.setattr(telemetry, "_suppressed", lambda: os.environ.get("ANDROMITY_INTERNAL") in TRUTHY)
        else:
            OPT_OUTS[off](patch)
        assert telemetry.take_first_run_notice() is None
    config.set("default", "telemetry", True)
    assert telemetry.take_first_run_notice() is not None


def test_notice_is_shown_even_when_it_cannot_be_remembered(tele, tmp_path, monkeypatch):
    monkeypatch.setenv("ANDROMITY_CONFIG_DIR", str(_unwritable_config_dir(tmp_path)))
    notice = telemetry.take_first_run_notice()
    telemetry.send_feature_used("app_started")
    drain()
    assert tele.net.requests, "telemetry is sent from this config dir"
    assert notice is not None, "telemetry is sent but the user is never told"


def test_two_simultaneous_first_runs_show_the_notice_once(tele, monkeypatch):
    real_write = telemetry._atomic_write

    def slow_disk(path, data):
        _wait(0.2)
        real_write(path, data)

    monkeypatch.setattr(telemetry, "_atomic_write", slow_disk)
    barrier = threading.Barrier(2)
    results = []

    def first_run():
        barrier.wait(5)
        results.append(telemetry.take_first_run_notice())

    threads = [threading.Thread(target=first_run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    assert len(results) == 2
    assert sum(result is not None for result in results) == 1


def test_notice_never_raises_when_the_config_dir_lookup_fails(tele, monkeypatch):
    def broken():
        raise RuntimeError("Could not determine home directory.")

    monkeypatch.setattr(telemetry, "get_config_dir", broken)
    telemetry.send_feature_used("still_fine")
    assert telemetry.take_first_run_notice() is None


# ── Guarantee 13: no payload carries a path, home directory, username or key ─

def test_realistic_session_never_leaks_local_details(tele, monkeypatch):
    monkeypatch.setenv("ANDROMITY_CLIENT", "tui")
    sid = str(uuid.uuid4())
    model = r"C:\Users\bobsecret\secretproj\qwen2.5-coder-7b.Q4_K_M.gguf"
    telemetry.send_session_start(sid, provider="ollama", model=model, profile="builder", reasoning_effort="high")
    telemetry.send_task_event("task_started", sid, RUN_ID, provider="ollama", model=model)
    telemetry.send_feature_used("waterfall", session_id=sid)
    telemetry.send_session_update(sid, turn_count=3, duration_sec=42.5)
    telemetry.send_session_end(sid, provider="ollama", model=model, turn_count=3, tool_counts={"bash": 2})
    drain()
    assert len(tele.net.raw) == 5
    for body in tele.net.raw:
        text = body.decode("utf-8")
        for secret in (SECRET_USER, SECRET_DIR, "Users", "\\\\"):
            assert secret not in text, text


LEAKY_INPUTS = {
    "client_from_environment": lambda mp: (mp.setenv("ANDROMITY_CLIENT", r"C:\Users\bobsecret\tools\wrapper"),
                                           telemetry.send_feature_used("probe")),
    "profile_given_as_a_path": lambda mp: telemetry.send_session_start(
        "sess-profile", profile="/home/bobsecret/p.toml"),
    "provider_given_as_a_path": lambda mp: telemetry.send_session_end(
        "sess-1234", provider=r"C:\Users\bobsecret\llama"),
}


@pytest.mark.parametrize("field", LEAKY_INPUTS)
def test_free_text_fields_never_carry_a_username(tele, monkeypatch, field):
    LEAKY_INPUTS[field](monkeypatch)
    drain()
    assert tele.net.raw
    for body in tele.net.raw:
        assert SECRET_USER not in body.decode("utf-8"), body


CHILD = r'''
import json, os, sys, threading, time, urllib.request

scenario, out_path, go_path = sys.argv[1], sys.argv[2], sys.argv[3]
args = sys.argv[4:]
real_sleep = time.sleep

if scenario == "hold_lock":
    lock_path, seconds = args[0], float(args[1])
    handle = open(lock_path, "a+b")
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    open(go_path, "w").close()
    real_sleep(seconds)
    sys.exit(0)

network = os.environ.get("CHILD_NETWORK", "fail")
delivered = []
delivered_lock = threading.Lock()


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def close(self):
        pass


def fake_urlopen(request, timeout=None, **kwargs):
    payload = json.loads(request.data.decode("utf-8"))
    if network == "fail":
        raise OSError("offline")
    if network == "hang":
        real_sleep(5)
    with delivered_lock:
        delivered.append(payload)
    return _Response()


urllib.request.urlopen = fake_urlopen
from andromity import telemetry as t

LEGACY = not hasattr(t, "_deliver")
t._PING_ENDPOINT = "http://127.0.0.1:9/ping"
t._EVENT_ENDPOINT = "http://127.0.0.1:9/event"
if hasattr(t, "_ENDPOINTS"):
    t._ENDPOINTS = (t._PING_ENDPOINT, t._EVENT_ENDPOINT)
if LEGACY:
    time.sleep = lambda seconds: None


def wait_for_go():
    open(out_path + ".ready", "w").close()
    deadline = time.monotonic() + 15
    while not os.path.exists(go_path) and time.monotonic() < deadline:
        real_sleep(0.002)


def write(result):
    with open(out_path, "w") as handle:
        json.dump(result, handle)


def spool_names():
    try:
        items = json.loads(open(os.path.join(os.environ["ANDROMITY_CONFIG_DIR"], ".telemetry_outbox.json")).read())
        return {item["payload"].get("feature_name") for item in items}
    except Exception:
        return set()


if scenario == "user_id":
    wait_for_go()
    write({"user_id": t._get_or_create_user_id()})
    sys.exit(0)

if scenario == "spool":
    tag, count = args[0], int(args[1])
    wait_for_go()
    names = [f"{tag}_{i}" for i in range(count)]
    for name in names:
        t.send_feature_used(name)
        real_sleep(0.002)
    deadline = time.monotonic() + 6
    if LEGACY:
        for thread in [th for th in threading.enumerate() if th.name.endswith("(_post)")]:
            thread.join(max(0, deadline - time.monotonic()))
    else:
        while time.monotonic() < deadline:
            with delivered_lock:
                done = {payload.get("feature_name") for payload in delivered}
            held = {item["payload"].get("feature_name") for item in list(t._unspooled)}
            round_done = network != "fail" or t._retry_at > 0
            if not t._queued and round_done and set(names) <= (spool_names() | done | held):
                real_sleep(0.3)
                break
            real_sleep(0.02)
    with delivered_lock:
        done = [payload.get("feature_name") for payload in delivered]
    write({"delivered": done,
           "unspooled": [] if LEGACY else [item["payload"].get("feature_name") for item in t._unspooled]})
    sys.exit(0)

if scenario == "burst":
    count, callers = int(args[0]), int(args[1])
    wait_for_go()
    stats = {"max_threads": 0, "max_telemetry_threads": 0}
    stop = threading.Event()

    def watch():
        while not stop.is_set():
            threads = threading.enumerate()
            stats["max_threads"] = max(stats["max_threads"], len(threads))
            stats["max_telemetry_threads"] = max(
                stats["max_telemetry_threads"],
                sum(1 for th in threads if th.name == "andromity-telemetry" or th.name.endswith("(_post)")))
            real_sleep(0.002)

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()

    def send(n):
        for i in range(n):
            t.send_feature_used(f"burst_{i}")

    start = time.monotonic()
    workers = [threading.Thread(target=send, args=(count // callers,), daemon=True) for _ in range(callers - 1)]
    for worker in workers:
        worker.start()
    send(count // callers)
    for worker in workers:
        worker.join(10)
    stats["send_seconds"] = time.monotonic() - start
    real_sleep(0.5)
    stop.set()
    watcher.join(2)
    write(stats)
    sys.stdout.flush()
    os._exit(0)

raise SystemExit(f"unknown scenario {scenario}")
'''
