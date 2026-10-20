"""Reliability and editing behaviour of scheduled (cron) jobs."""
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from andromity.config import config
from andromity.core import cron as cron_mod
from andromity.core.cron import (
    AUTO_PAUSE_AFTER_FAILURES,
    CronJob,
    CronRun,
    CronRunCollector,
    CronScheduler,
    CronStore,
    build_unattended_prompt,
    cron_tool_decision,
    describe_schedule,
    normalize_job_fields,
    parse_interval_seconds,
    parse_schedule,
    preview_schedule,
    project_folder_problem,
)
from andromity.core.db import get_conn as _raw_conn, init_schema
from andromity.core.events import Done, TextDelta, ToolCallStart, ToolResult
from andromity.server.protocol import JsonRpcRequest
from andromity.server.rpc_handler import JsonRpcHandler

UTC = timezone.utc


def get_conn():
    init_schema()
    return _raw_conn()


def _sched(path: Path, fired=None) -> CronScheduler:
    return CronScheduler(str(path), on_trigger=lambda job: (fired.append(job.id) if fired is not None else None))


def _add(s: CronScheduler, schedule="every 1h", **kw) -> CronJob:
    return s.add(name=kw.pop("name", "Job"), prompt=kw.pop("prompt", "do it"), schedule=schedule,
                 provider="ollama", model="m", **kw)


def _run_count(job_id: str) -> int:
    return get_conn().execute("SELECT count(*) FROM cron_runs WHERE job_id = ?", (job_id,)).fetchone()[0]


def _set_job(job_id: str, **cols):
    sets = ", ".join(f"{k} = ?" for k in cols)
    get_conn().execute(f"UPDATE cron_jobs SET {sets} WHERE id = ?", list(cols.values()) + [job_id])


# ── Bug 1: saving a job must not wipe its run history ──────────────────────

def test_saving_a_job_keeps_its_run_history(tmp_path):
    s = _sched(tmp_path)
    job = _add(s)
    run = s.start_run(job.id, "p", "m")
    assert _run_count(job.id) == 1
    s.toggle(job.id)
    s.toggle(job.id)
    s.update(job.id, {"name": "Renamed"})
    CronStore(str(tmp_path)).save(s.list())
    assert _run_count(job.id) == 1
    s.finish_run(job.id, run, "success")
    assert _run_count(job.id) == 1
    assert s.list_runs(job.id)[0].status == "success"


# ── Bug 2: no duplicate or overlapping runs ────────────────────────────────

def test_tick_does_not_refire_a_running_job(tmp_path):
    fired = []
    s = _sched(tmp_path, fired)
    job = _add(s)
    _set_job(job.id, next_run_at=(datetime.now(UTC) - timedelta(seconds=5)).isoformat())
    assert s.tick() == [job.id]
    for _ in range(5):
        assert s.tick() == []
    assert fired == [job.id]


def test_two_schedulers_on_one_project_fire_once(tmp_path):
    fired_a, fired_b = [], []
    a = _sched(tmp_path, fired_a)
    job = _add(a)
    b = _sched(tmp_path, fired_b)
    _set_job(job.id, next_run_at=(datetime.now(UTC) - timedelta(seconds=5)).isoformat())
    a.tick()
    b.tick()
    assert len(fired_a) + len(fired_b) == 1


def test_run_now_refuses_while_running(tmp_path):
    fired = []
    s = _sched(tmp_path, fired)
    job = _add(s)
    assert s.run_now(job.id) is True
    assert s.run_now(job.id) is False
    assert s.is_running(job.id)
    run = s.start_run(job.id, "p", "m")
    assert run.trigger == "manual"
    s.finish_run(job.id, run, "success")
    assert not s.is_running(job.id)
    assert s.run_now(job.id) is True


def test_expired_claim_from_dead_process_is_reclaimed(tmp_path):
    s = _sched(tmp_path)
    job = _add(s, timeout_seconds=60)
    run = s.start_run(job.id, "p", "m")
    stale = (datetime.now(UTC) - timedelta(seconds=60 + cron_mod.CLAIM_GRACE_SECONDS + 5)).isoformat()
    _set_job(job.id, running_since=stale, lease_owner="dead-process")
    fresh = _sched(tmp_path)
    assert not fresh.is_running(job.id)
    assert fresh.get_run(job.id, run.id).status == "interrupted"
    assert fresh.run_now(job.id) is True


def test_live_claim_from_other_process_is_respected(tmp_path):
    s = _sched(tmp_path)
    job = _add(s)
    run = s.start_run(job.id, "p", "m")
    _set_job(job.id, running_since=datetime.now(UTC).isoformat(), lease_owner="other-window")
    other = _sched(tmp_path)
    assert other.is_running(job.id)
    assert other.run_now(job.id) is False
    assert other.get_run(job.id, run.id).status == "running"


# ── Bug 3 and 4: outcome reflects what really happened ─────────────────────

def test_provider_error_is_a_failure_not_success():
    c = CronRunCollector()
    c.feed(TextDelta(text="Authentication failed"))
    c.feed(Done(outcome="error", error_type="auth_error"))
    status, error, error_type = c.outcome()
    assert (status, error_type) == ("failed", "auth_error")
    assert "API key" in error


def test_blocked_tools_need_attention():
    c = CronRunCollector()
    c.note_blocked("shell_exec", {"command": "git rev-parse --show-toplevel"})
    c.feed(TextDelta(text="Summary: 3 TODOs found."))
    status, error, error_type = c.outcome()
    assert status == "needs_attention"
    assert error_type == "blocked"
    assert "git rev-parse" in error


def test_unanswerable_question_needs_attention():
    c = CronRunCollector()
    c.feed(TextDelta(text="I found 211 matches.\n\n**How would you like to proceed?**"))
    status, _, error_type = c.outcome()
    assert (status, error_type) == ("needs_attention", "question")


def test_clean_run_is_success_and_tracks_tools():
    c = CronRunCollector()
    c.feed(ToolCallStart(tool_name="read_file", tool_id="t1"))
    c.feed(ToolResult(tool_id="t1", result="ok", success=True))
    c.feed(TextDelta(text="All tests pass."))
    c.feed(Done(outcome="success"))
    assert c.outcome() == ("success", None, None)
    assert c.tools_used == ["read_file"]
    assert c.tool_executions[0]["success"] is True


def test_timeout_and_exception_outcomes_are_friendly():
    c = CronRunCollector()
    status, error, error_type = c.outcome(timed_out=True, timeout_seconds=600)
    assert (status, error_type) == ("timeout", "timeout")
    assert "10 minutes" in error
    status, error, error_type = c.outcome(exc=RuntimeError("boom"))
    assert status == "failed"
    assert "Traceback" not in error


# ── Bug 5: allowed commands are explained to the agent ─────────────────────

def test_blocked_command_reason_lists_allowed_commands():
    job = CronJob(id="j", name="n", prompt="p", mode="safe", allowed_commands=["git status", "git diff"])
    ok, reason = cron_tool_decision(job, "shell_exec", {"command": "git rev-parse --show-toplevel"}, True)
    assert ok is False
    assert "Allowed commands: git status, git diff" in reason
    assert "REJECTED BY USER" not in reason
    assert cron_tool_decision(job, "shell_exec", {"command": "git status"}, True) == (True, None)
    ok, reason = cron_tool_decision(job, "write_file", {"path": "a.txt"}, True)
    assert ok is False and "SAFE mode" in reason
    ok, reason = cron_tool_decision(job, "shell_exec", {"command": "git status"}, False)
    assert ok is False and "not trusted" in reason


def test_unattended_prompt_states_the_rules():
    job = CronJob(id="j", name="Health", prompt="Scan TODOs", mode="safe", allowed_commands=["git status"])
    prompt = build_unattended_prompt(job)
    assert prompt.endswith("Scan TODOs")
    assert "do not ask questions" in prompt
    assert "git status" in prompt
    assert "SAFE" in prompt
    bare = build_unattended_prompt(CronJob(id="k", name="x", prompt="p"))
    assert "No shell commands are allowed" in bare


# ── Bug 6: jobs never run in an editor install folder ──────────────────────

def test_project_folder_problem(tmp_path):
    assert project_folder_problem(None)
    assert project_folder_problem(str(tmp_path / "missing"))
    app_dir = tmp_path / "Microsoft VS Code"
    (app_dir / "resources" / "app").mkdir(parents=True)
    assert "application install folder" in project_folder_problem(str(app_dir))
    assert project_folder_problem(str(tmp_path)) is None


async def test_rpc_cron_requires_a_real_folder(tmp_path):
    handler = JsonRpcHandler()
    resp = await handler.handle_request(JsonRpcRequest(id=1, method="cron.list", params={}))
    assert resp.error is None and resp.result == []
    resp = await handler.handle_request(JsonRpcRequest(id=2, method="cron.create", params={"prompt": "p"}))
    assert resp.error is not None
    app_dir = tmp_path / "Antigravity IDE"
    (app_dir / "resources" / "app").mkdir(parents=True)
    resp = await handler.handle_request(JsonRpcRequest(id=3, method="cron.list", params={"project_path": str(app_dir)}))
    assert resp.result == []
    assert not (app_dir / ".andromity").exists()
    assert get_conn().execute("SELECT count(*) FROM cron_jobs").fetchone()[0] == 0


def test_tick_skips_and_pauses_jobs_whose_folder_disappeared(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    fired = []
    s = _sched(proj, fired)
    job = _add(s)
    _set_job(job.id, next_run_at=(datetime.now(UTC) - timedelta(seconds=5)).isoformat())
    (proj / "resources" / "app").mkdir(parents=True)
    s.tick()
    assert fired == []
    job = s.get(job.id)
    assert job.enabled is False and job.paused_reason
    assert s.list_runs(job.id)[0].status == "skipped"


# ── Bug 7: a cron run's session is never served stale ─────────────────────

def test_live_cron_session_is_served_and_not_cached(tmp_path):
    from andromity.core.session import Session
    handler = JsonRpcHandler()
    live = Session(session_id="cron-abc-1", name="Cron: x", project_path=str(tmp_path))
    handler._cron_live_sessions[live.id] = live
    assert handler._get_or_load_session("cron-abc-1", str(tmp_path)) is live
    assert "cron-abc-1" not in handler._active_sessions


def test_missing_cron_session_is_not_recreated_empty(tmp_path):
    handler = JsonRpcHandler()
    with pytest.raises(ValueError):
        handler._get_or_load_session("cron-gone-123", str(tmp_path))
    assert get_conn().execute("SELECT count(*) FROM sessions WHERE id = 'cron-gone-123'").fetchone()[0] == 0


# ── Bug 8: an untrusted workspace does not spam failed runs ────────────────

async def test_untrusted_run_is_skipped_once_and_pauses(tmp_path):
    handler = JsonRpcHandler()
    s = handler._get_or_create_cron_scheduler(str(tmp_path.resolve()))
    job = _add(s)
    res = await handler._execute_cron_job(str(tmp_path.resolve()), s.claim(job.id))
    assert res["status"] == "skipped" and res["error_type"] == "untrusted"
    job = s.get(job.id)
    assert job.enabled is False and "not trusted" in job.paused_reason
    assert not job.is_running()
    assert s.tick() == []
    assert _run_count(job.id) == 1
    s.stop()


# ── End-to-end daemon run with a scripted agent ────────────────────────────

class _ScriptedAgent:
    script = []

    def __init__(self, session, on_tool_approval=None, **kw):
        self.session = session
        self.on_tool_approval = on_tool_approval
        type(self).last_init = kw

    def kill_subagents(self, reason):
        pass

    async def run(self, prompt, **kw):
        type(self).last_prompt = prompt
        self.session.messages.append({"role": "user", "content": prompt})
        self.session.save()
        for step in type(self).script:
            if step[0] == "tool":
                res = await self.on_tool_approval(step[1], step[2])
                yield ToolCallStart(tool_name=step[1], tool_id="t")
                yield ToolResult(tool_id="t", result="ok" if res is True else "[Tool Blocked]", success=res is True)
            elif step[0] == "wait":
                await step[1].wait()
            elif step[0] == "sleep":
                await asyncio.sleep(step[1])
            elif step[0] == "raise":
                raise step[1]
            else:
                yield step[1]


@pytest.fixture
def trusted_project(tmp_path, monkeypatch):
    proj = tmp_path / "repo"
    proj.mkdir()
    config.set_trusted(str(proj))
    monkeypatch.setattr("andromity.server.rpc_handler.Agent", _ScriptedAgent)
    return proj.resolve()


async def _run_job(handler, proj, script, **job_kw):
    _ScriptedAgent.script = script
    s = handler._get_or_create_cron_scheduler(str(proj))
    job = _add(s, **job_kw)
    res = await handler._execute_cron_job(str(proj), s.claim(job.id))
    return s, s.get(job.id), res


async def test_daemon_records_provider_failure(trusted_project):
    notes = []
    handler = JsonRpcHandler(send_notification=lambda n: notes.append(n))
    s, job, res = await _run_job(handler, trusted_project, [
        ("event", TextDelta(text="Rate limited")), ("event", Done(outcome="error", error_type="rate_limit")),
    ], on_failure="retry")
    assert res["status"] == "failed" and res["error_type"] == "rate_limit"
    assert job.last_status == "failed" and job.retry_count == 1
    assert not job.is_running()
    completed = [n for n in notes if n.method == "cron/run_completed"]
    assert completed and completed[-1].params["job"]["last_error_type"] == "rate_limit"
    s.stop()


async def test_daemon_marks_blocked_run_needs_attention(trusted_project):
    handler = JsonRpcHandler()
    s, job, res = await _run_job(handler, trusted_project, [
        ("tool", "shell_exec", {"command": "git rev-parse --show-toplevel"}),
        ("event", TextDelta(text="Could not inspect the repo.")),
    ], mode="safe", allowed_commands=["git status"])
    assert res["status"] == "needs_attention"
    assert res["blocked_tools"] == ["shell_exec: git rev-parse --show-toplevel"]
    assert job.last_status == "needs_attention" and job.consecutive_failures == 0
    assert "git status" in _ScriptedAgent.last_prompt
    assert res["session_id"] and res["session_id"] not in handler._cron_live_sessions
    s.stop()


async def test_daemon_success_keeps_history_and_session(trusted_project):
    handler = JsonRpcHandler()
    s, job, res = await _run_job(handler, trusted_project, [("event", TextDelta(text="Done. All good."))])
    assert res["status"] == "success"
    loaded = handler._get_or_load_session(res["session_id"], str(trusted_project))
    assert loaded.id == res["session_id"]
    assert len(s.list_runs(job.id)) == 1
    s.stop()


# ── Schedules ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, message", [
    ("99 * * * *", "out of range"),
    ("0 0 30 2 *", "never runs"),
    ("* * * *", "5 fields"),
    ("every 30s", "Minimum"),
    ("daily", "Add a time"),
    ("whenever", "Invalid schedule"),
    ("0 25 * * *", "out of range"),
    ("5-1 * * * *", "backwards"),
])
def test_invalid_schedules_are_rejected_with_reasons(text, message):
    with pytest.raises(ValueError, match=message):
        parse_schedule(text)


@pytest.mark.parametrize("text, description", [
    ("every 30m", "Every 30 minutes"),
    ("every 1h30m", "Every 1 hour 30 minutes"),
    ("every 2 hours", "Every 2 hours"),
    ("every 1d", "Every day"),
    ("daily at 09:00", "Every day at 09:00"),
    ("at 9:15pm", "Every day at 21:15"),
    ("weekdays at 9am", "Weekdays at 09:00"),
    ("mondays and fridays at 17:30", "Mondays and Fridays at 17:30"),
    ("0 9 * * MON-FRI", "Weekdays at 09:00"),
    ("@daily", "Every day at 00:00"),
    ("15 * * * *", "Every hour at :15"),
    ("0 8 1 * *", "Day 1 of every month at 08:00"),
])
def test_schedule_descriptions(text, description):
    assert describe_schedule(text) == description


def test_compound_interval_is_not_truncated():
    assert parse_interval_seconds("every 1h30m") == 5400


def test_cron_day_of_month_or_day_of_week():
    spec = parse_schedule("0 9 1 * 1").cron
    assert spec.day_matches(datetime(2026, 10, 1).date())   # 1st (Thursday)
    assert spec.day_matches(datetime(2026, 10, 5).date())   # Monday
    assert not spec.day_matches(datetime(2026, 10, 6).date())


def test_preview_lists_next_runs_in_order():
    now = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
    p = preview_schedule("every 2h", count=5, now=now)
    assert p["valid"] and len(p["next_runs"]) == 5
    times = [datetime.fromisoformat(t) for t in p["next_runs"]]
    assert times[0] == now + timedelta(hours=2)
    assert all(b - a == timedelta(hours=2) for a, b in zip(times, times[1:]))
    weekly = preview_schedule("weekdays at 09:00", count=5, now=now)
    for t in weekly["next_runs"]:
        local = datetime.fromisoformat(t).astimezone()
        assert local.weekday() < 5 and (local.hour, local.minute) == (9, 0)
    bad = preview_schedule("every 10s")
    assert bad["valid"] is False and bad["next_runs"] == []


# ── Due decisions, catch-up and missed runs ────────────────────────────────

def test_daily_job_created_after_its_time_waits_for_tomorrow(tmp_path):
    s = _sched(tmp_path)
    past = (datetime.now() - timedelta(hours=1)).strftime("%H:%M")
    job = _add(s, schedule=f"daily at {past}")
    assert job.due_decision() is None
    nxt = job.next_run_datetime()
    assert nxt > datetime.now(UTC) + timedelta(hours=22)


def test_new_interval_job_waits_one_interval(tmp_path):
    s = _sched(tmp_path)
    job = _add(s, schedule="every 2h")
    assert job.due_decision() is None
    assert job.next_run_in().startswith("1h") or job.next_run_in().startswith("2h")


def test_calendar_catch_up_within_window(tmp_path):
    now = datetime.now(UTC)
    job = CronJob(id="c", name="n", prompt="p", schedule="0 9 * * *",
                  next_run_at=(now - timedelta(hours=3)).isoformat())
    assert job.due_decision(now) == "catch_up"
    job.catch_up = "skip"
    assert job.due_decision(now) == "missed"
    job.catch_up = "once"
    job.next_run_at = (now - timedelta(days=2)).isoformat()
    assert job.due_decision(now) == "missed"
    job.next_run_at = (now - timedelta(seconds=30)).isoformat()
    assert job.due_decision(now) == "run"


def test_missed_run_is_recorded_once_and_advances(tmp_path):
    fired = []
    s = _sched(tmp_path, fired)
    job = _add(s, schedule="0 9 * * *")
    _set_job(job.id, next_run_at=(datetime.now(UTC) - timedelta(days=3)).isoformat())
    s.tick()
    s.tick()
    assert fired == []
    runs = s.list_runs(job.id)
    assert [r.status for r in runs] == ["missed"]
    assert "Andromity was not running" in runs[0].error
    assert s.get(job.id).next_run_datetime() > datetime.now(UTC)


def test_catch_up_run_is_labelled(tmp_path):
    fired = []
    s = _sched(tmp_path, fired)
    job = _add(s, schedule="0 9 * * *")
    _set_job(job.id, next_run_at=(datetime.now(UTC) - timedelta(hours=2)).isoformat())
    s.tick()
    assert fired == [job.id]
    assert s.start_run(job.id, "p", "m").trigger == "catch_up"


def test_legacy_job_without_next_run_keeps_old_timing(tmp_path):
    s = _sched(tmp_path)
    job = _add(s, schedule="every 1h")
    _set_job(job.id, next_run_at=None, last_run=(datetime.now(UTC) - timedelta(hours=2)).isoformat())
    reloaded = _sched(tmp_path).get(job.id)
    assert reloaded.next_run_at is not None
    assert reloaded.due_decision() in ("run", "catch_up")


# ── Retries and auto-pause ─────────────────────────────────────────────────

def test_transient_errors_retry_with_backoff():
    job = CronJob(id="r", name="n", prompt="p", schedule="every 1h", on_failure="retry", max_retries=2)
    now = datetime.now(UTC)
    job.apply_result("failed", "x", "rate_limit", now)
    assert job.retry_count == 1
    first = (datetime.fromisoformat(job.next_run_at) - now).total_seconds()
    assert 60 <= first <= 66
    assert job.due_decision(now + timedelta(seconds=70)) == "retry"
    job.apply_result("failed", "x", "rate_limit", now)
    assert job.retry_count == 2
    job.apply_result("failed", "x", "rate_limit", now)
    assert job.retry_count == 0
    assert (datetime.fromisoformat(job.next_run_at) - now).total_seconds() == pytest.approx(3600, abs=1)


def test_permanent_errors_do_not_retry():
    job = CronJob(id="r", name="n", prompt="p", schedule="every 1h", on_failure="retry")
    job.apply_result("failed", "bad key", "auth_error")
    assert job.retry_count == 0


def test_auto_pause_after_consecutive_failures():
    job = CronJob(id="r", name="n", prompt="p", schedule="every 1h", on_failure="notify")
    for _ in range(AUTO_PAUSE_AFTER_FAILURES - 1):
        job.apply_result("failed", "x", "generic")
    assert job.enabled
    job.apply_result("timeout", "x", "timeout")
    assert job.enabled is False
    assert "failed runs in a row" in job.paused_reason
    job.set_enabled(True)
    assert job.paused_reason is None and job.consecutive_failures == 0


def test_success_and_needs_attention_reset_failure_streak():
    job = CronJob(id="r", name="n", prompt="p", schedule="every 1h", on_failure="notify")
    job.apply_result("failed", "x", "generic")
    job.apply_result("needs_attention", "blocked", "blocked")
    assert job.consecutive_failures == 0 and job.fail_count == 1


def test_one_time_job_disables_after_final_outcome():
    future = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
    job = CronJob(id="o", name="n", prompt="p", schedule=future, on_failure="notify")
    job.reschedule()
    job.apply_result("failed", "x", "generic")
    assert job.enabled is False and job.next_run_in() == "completed"


def test_interrupted_run_does_not_count_as_failure():
    job = CronJob(id="i", name="n", prompt="p", schedule="every 1h")
    job.apply_result("interrupted", "shutdown")
    assert job.consecutive_failures == 0 and job.fail_count == 0 and job.last_status == "interrupted"


# ── Editing ────────────────────────────────────────────────────────────────

def test_update_keeps_id_and_history_and_reschedules(tmp_path):
    s = _sched(tmp_path)
    job = _add(s, schedule="every 1h")
    run = s.start_run(job.id, "p", "m")
    s.finish_run(job.id, run, "success")
    updated = s.update(job.id, {"schedule": "weekdays at 07:30", "prompt": "new", "mode": "safe",
                                "allowed_commands": "pytest, git status", "notify": "always", "catch_up": "skip"})
    assert updated.id == job.id
    assert updated.allowed_commands == ["pytest", "git status"]
    assert updated.schedule_description if hasattr(updated, "schedule_description") else True
    assert describe_schedule(updated.schedule) == "Weekdays at 07:30"
    local = updated.next_run_datetime().astimezone()
    assert (local.hour, local.minute) == (7, 30) and local.weekday() < 5
    assert len(s.list_runs(job.id)) == 1


@pytest.mark.parametrize("changes, message", [
    ({"schedule": "99 * * * *"}, "out of range"),
    ({"mode": "root"}, "Permission mode"),
    ({"timeout_seconds": 5}, "Timeout"),
    ({"prompt": "   "}, "prompt"),
    ({"notify": "loud"}, "Notify"),
    ({"max_retries": 9}, "Retries"),
])
def test_update_validates_fields(tmp_path, changes, message):
    s = _sched(tmp_path)
    job = _add(s)
    with pytest.raises(ValueError, match=message):
        s.update(job.id, changes)
    assert s.get(job.id).schedule == "every 1h"


def test_duplicate_is_paused_copy(tmp_path):
    s = _sched(tmp_path)
    job = _add(s, name="Nightly", allowed_commands=["pytest"], mode="safe")
    copy = s.duplicate(job.id)
    assert copy.id != job.id and copy.name == "Nightly (copy)"
    assert copy.enabled is False and copy.allowed_commands == ["pytest"] and copy.mode == "safe"


def test_delete_removes_job_and_history_files(tmp_path):
    s = _sched(tmp_path)
    job = _add(s)
    s.start_run(job.id, "p", "m")
    assert (tmp_path / ".andromity" / "cron_runs" / job.id).is_dir()
    assert s.remove(job.id)
    assert not (tmp_path / ".andromity" / "cron_runs" / job.id).exists()
    assert s.get(job.id) is None


def test_run_history_is_pruned(tmp_path, monkeypatch):
    monkeypatch.setattr(cron_mod, "RUN_HISTORY_LIMIT", 3)
    s = _sched(tmp_path)
    job = _add(s)
    for i in range(5):
        run = CronRun(id=f"run{i}", job_id=job.id, job_name="Job",
                      started_at=(datetime.now(UTC) + timedelta(seconds=i)).isoformat())
        s._run_store.save_run(run)
    s._run_store.prune(job.id, keep=3)
    assert [r.id for r in s.list_runs(job.id)] == ["run4", "run3", "run2"]
    assert not (tmp_path / ".andromity" / "cron_runs" / job.id / "run0.json").exists()


def test_listing_latest_run_does_not_rewrite_history(tmp_path, monkeypatch):
    import json
    s = _sched(tmp_path)
    job = _add(s)
    for i in range(4):
        s._run_store.save_run(CronRun(id=f"run{i}", job_id=job.id, job_name="Job",
                                      started_at=(datetime.now(UTC) + timedelta(seconds=i)).isoformat()))
    legacy = CronRun(id="legacy1", job_id=job.id, job_name="Job", started_at="2026-01-01T00:00:00+00:00", status="success")
    (tmp_path / ".andromity" / "cron_runs" / job.id / "legacy1.json").write_text(json.dumps(legacy.to_dict()), encoding="utf-8")
    saved = []
    original = s._run_store.save_run
    monkeypatch.setattr(s._run_store, "save_run", lambda run: (saved.append(run.id), original(run)))
    assert [r.id for r in s.list_runs(job.id, limit=1)] == ["run3"]
    assert saved == ["legacy1"]
    s.list_runs(job.id, limit=1)
    assert saved == ["legacy1"]


def test_snapshot_never_contains_claim_state(tmp_path):
    import json
    s = _sched(tmp_path)
    job = _add(s)
    s.claim(job.id)
    s.update(job.id, {"name": "x"})
    data = json.loads((tmp_path / ".andromity" / "crons.json").read_text(encoding="utf-8"))
    assert "running_since" not in data["crons"][0] and "lease_owner" not in data["crons"][0]


def test_normalize_job_fields_parses_commands():
    assert normalize_job_fields({"allowed_commands": " a, ,b "})["allowed_commands"] == ["a", "b"]
    assert normalize_job_fields({"name": "  "})["name"] == "Scheduled Job"


# ── RPC surface ────────────────────────────────────────────────────────────

async def test_rpc_update_preview_duplicate_and_run_now(trusted_project):
    handler = JsonRpcHandler()
    proj = str(trusted_project)
    created = (await handler.handle_request(JsonRpcRequest(id=1, method="cron.create", params={
        "project_path": proj, "name": "Tests", "prompt": "run tests", "schedule": "every 1h",
        "mode": "safe", "allowed_commands": "pytest", "timeout_seconds": 900, "notify": "always",
    }))).result
    assert created["schedule_description"] == "Every hour"
    assert created["timeout_seconds"] == 900 and created["notify"] == "always"
    assert created["next_run_at"] and created["folder_problem"] is None

    bad = await handler.handle_request(JsonRpcRequest(id=2, method="cron.create", params={
        "project_path": proj, "prompt": "x", "schedule": "every 10s"}))
    assert bad.error is not None

    updated = (await handler.handle_request(JsonRpcRequest(id=3, method="cron.update", params={
        "project_path": proj, "id": created["id"], "schedule": "daily at 06:00", "name": "Morning tests"}))).result
    assert updated["id"] == created["id"] and updated["name"] == "Morning tests"
    assert updated["schedule_description"] == "Every day at 06:00"

    preview = (await handler.handle_request(JsonRpcRequest(id=4, method="cron.preview", params={
        "schedule": "weekdays at 9am", "count": 3}))).result
    assert preview["valid"] and preview["description"] == "Weekdays at 09:00" and len(preview["next_runs"]) == 3

    dup = (await handler.handle_request(JsonRpcRequest(id=5, method="cron.duplicate", params={
        "project_path": proj, "id": created["id"]}))).result
    assert dup["enabled"] is False and dup["id"] != created["id"]

    _ScriptedAgent.script = [("event", TextDelta(text="ok"))]
    s = handler._get_or_create_cron_scheduler(proj)
    s.claim(created["id"])
    busy = await handler.handle_request(JsonRpcRequest(id=6, method="cron.run_now", params={
        "project_path": proj, "id": created["id"]}))
    assert busy.error is not None and "already running" in busy.error["message"]
    s.release(created["id"])

    toggled = (await handler.handle_request(JsonRpcRequest(id=7, method="cron.toggle", params={
        "project_path": proj, "id": created["id"], "enabled": False}))).result
    assert toggled["enabled"] is False
    s.stop()


async def test_rpc_create_and_run_now(trusted_project):
    handler = JsonRpcHandler()
    _ScriptedAgent.script = [("event", TextDelta(text="Done."))]
    created = (await handler.handle_request(JsonRpcRequest(id=1, method="cron.create", params={
        "project_path": str(trusted_project), "prompt": "check", "schedule": "every 1h", "run_now": True}))).result
    for _ in range(50):
        await asyncio.sleep(0.02)
        if not handler._cron_tasks:
            break
    runs = (await handler.handle_request(JsonRpcRequest(id=2, method="cron.runs", params={
        "project_path": str(trusted_project), "id": created["id"]}))).result
    assert [r["status"] for r in runs] == ["success"]
    assert runs[0]["trigger"] == "manual"
    handler._get_or_create_cron_scheduler(str(trusted_project)).stop()


# ── Backward compatibility ─────────────────────────────────────────────────

def test_old_database_rows_load_with_defaults(tmp_path):
    s = _sched(tmp_path)
    job = _add(s)
    _set_job(job.id, next_run_at=None, paused_reason=None, last_error_type=None)
    loaded = CronStore(str(tmp_path)).get(job.id)
    assert loaded.catch_up == "once" and loaded.notify == "failures"
    legacy = CronJob.from_dict({"id": "x", "name": "n", "prompt": "p", "schedule": "every 2h", "unknown_field": 1})
    assert legacy.ensure_next_run() is True


# ── An open cron chat: live updates, finish signal, mode, busy guard ───────

def _notes_for(notes, session_id, method=None):
    return [n for n in notes if (n.params or {}).get("session_id") == session_id and (method is None or n.method == method)]


FINISH_METHODS = ("agent/done", "agent/error", "agent/cancelled")


@pytest.mark.parametrize("script, finish, outcome, job_kw", [
    ([("event", TextDelta(text="All good."))], "agent/done", "success", {}),
    ([("tool", "shell_exec", {"command": "rm -rf build"}), ("event", TextDelta(text="Blocked."))], "agent/done", "success",
     {"mode": "safe", "allowed_commands": ["git status"]}),
    ([("event", TextDelta(text="Rate limited")), ("event", Done(outcome="error", error_type="rate_limit"))], "agent/done", "error", {}),
    ([("event", TextDelta(text="partial")), ("raise", RuntimeError("socket closed"))], "agent/error", None, {}),
    ([("event", TextDelta(text="slow")), ("sleep", 5)], "agent/error", None, {"timeout_seconds": 1}),
])
async def test_open_cron_chat_streams_and_always_finishes(trusted_project, script, finish, outcome, job_kw):
    notes = []
    handler = JsonRpcHandler(send_notification=lambda n: notes.append(n))
    s, job, res = await _run_job(handler, trusted_project, script, **job_kw)
    sid = res["session_id"]
    methods = [n.method for n in _notes_for(notes, sid)]
    assert methods[0] == "agent/started"
    assert _notes_for(notes, sid, "agent/started")[0].params["scheduled"] is True
    assert "agent/textDelta" in methods
    finishes = [m for m in methods if m in FINISH_METHODS]
    assert finishes == [finish]
    final = _notes_for(notes, sid, finish)[0].params
    if outcome:
        assert final["outcome"] == outcome
    else:
        assert final["error"] and "Traceback" not in final["error"]
    # The finish signal comes after the run stops being live, so a reload shows it finished.
    assert sid not in handler._cron_live_sessions and sid not in handler._running_tasks
    got = await handler.rpc_session_get({"session_id": sid, "project_path": str(trusted_project)})
    assert got["is_running"] is False
    assert got["status"] in ("idle", "error")
    s.stop()


async def test_cron_chat_uses_the_jobs_mode_and_profile(trusted_project, monkeypatch):
    config.set("default", "permission_mode", "full")
    handler = JsonRpcHandler()
    gate = asyncio.Event()
    _ScriptedAgent.script = [("event", TextDelta(text="working")), ("wait", gate)]
    s = handler._get_or_create_cron_scheduler(str(trusted_project))
    job = _add(s, name="hii", mode="safe")
    task = asyncio.create_task(handler._execute_cron_job(str(trusted_project), s.claim(job.id)))
    for _ in range(100):
        await asyncio.sleep(0.01)
        if handler._cron_live_sessions:
            break
    sid = next(iter(handler._cron_live_sessions))
    live = await handler.rpc_session_get({"session_id": sid, "project_path": str(trusted_project)})
    assert live["permission_mode"] == "safe" and live["profile"] == "builder"
    assert live["is_running"] is True
    assert live["scheduled_run"] == {"job_id": job.id, "job_name": "hii", "mode": "safe", "running": True}
    gate.set()
    await task
    done = await handler.rpc_session_get({"session_id": sid, "project_path": str(trusted_project)})
    assert done["scheduled_run"]["running"] is False and done["scheduled_run"]["mode"] == "safe"
    normal = await handler.rpc_session_get({"session_id": "plain-chat", "project_path": str(trusted_project)})
    assert normal["scheduled_run"] is None
    s.stop()


async def test_messages_are_refused_during_a_cron_run_and_accepted_after(trusted_project):
    notes = []
    handler = JsonRpcHandler(send_notification=lambda n: notes.append(n))
    gate = asyncio.Event()
    _ScriptedAgent.script = [("event", TextDelta(text="working")), ("wait", gate)]
    s = handler._get_or_create_cron_scheduler(str(trusted_project))
    job = _add(s)
    task = asyncio.create_task(handler._execute_cron_job(str(trusted_project), s.claim(job.id)))
    for _ in range(100):
        await asyncio.sleep(0.01)
        if handler._cron_live_sessions:
            break
    sid = next(iter(handler._cron_live_sessions))
    live_session = handler._cron_live_sessions[sid]
    for method in ("agent.prompt", "agent.submit"):
        resp = await handler.handle_request(JsonRpcRequest(id=1, method=method, params={
            "session_id": sid, "prompt": "hello?", "project_path": str(trusted_project)}))
        assert resp.error is not None
        assert "still in progress" in resp.error["message"]
    assert len(live_session.messages) == 1, "no second agent touched the live session"
    gate.set()
    await task

    _ScriptedAgent.script = [("event", TextDelta(text="continued")), ("event", Done(outcome="success"))]
    started = await handler.rpc_agent_prompt({"session_id": sid, "prompt": "thanks, continue", "project_path": str(trusted_project)})
    assert started["status"] == "started"
    await handler._running_tasks[sid]
    assert _notes_for(notes, sid, "agent/done")[-1].params["outcome"] == "success"
    assert "scheduled" not in _notes_for(notes, sid, "agent/done")[-1].params
    s.stop()


async def test_stop_in_an_open_cron_chat_cancels_the_run(trusted_project):
    notes = []
    handler = JsonRpcHandler(send_notification=lambda n: notes.append(n))
    gate = asyncio.Event()
    _ScriptedAgent.script = [("event", TextDelta(text="working")), ("wait", gate)]
    s = handler._get_or_create_cron_scheduler(str(trusted_project))
    job = _add(s)
    task = asyncio.create_task(handler._execute_cron_job(str(trusted_project), s.claim(job.id)))
    for _ in range(100):
        await asyncio.sleep(0.01)
        if handler._cron_live_sessions:
            break
    sid = next(iter(handler._cron_live_sessions))
    await handler.rpc_agent_cancel({"session_id": sid})
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [n.method for n in _notes_for(notes, sid) if n.method in FINISH_METHODS] == ["agent/cancelled"]
    assert s.list_runs(job.id)[0].status == "interrupted"
    assert not s.get(job.id).is_running()
    s.stop()


async def test_chat_turn_still_forwards_events_through_shared_helper(trusted_project):
    notes = []
    handler = JsonRpcHandler(send_notification=lambda n: notes.append(n))
    _ScriptedAgent.script = [
        ("event", TextDelta(text="hi")),
        ("event", ToolCallStart(tool_name="read_file", tool_id="t1")),
        ("event", ToolResult(tool_id="t1", result="ok")),
        ("event", Done(outcome="success")),
    ]
    await handler.rpc_agent_prompt({"session_id": "chat-1", "prompt": "hello", "project_path": str(trusted_project)})
    await handler._running_tasks["chat-1"]
    methods = [n.method for n in _notes_for(notes, "chat-1")]
    for expected in ("agent/started", "agent/textDelta", "agent/toolStart", "agent/toolResult", "agent/done"):
        assert expected in methods
