"""Cron scheduler — in-process async scheduler backed by SQLite and .andromity/crons.json."""
import asyncio
import calendar
import json
import os
import random
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Tuple

from andromity.core.debug_log import get_logger

log = get_logger("cron")

# A run that starts this late is still an on-time run (sleep/wake jitter, busy loop).
LATE_GRACE_SECONDS = 300
# Calendar schedules missed for longer than this are recorded as missed, not caught up.
CATCH_UP_WINDOW_SECONDS = 86400
# Consecutive failed runs before a job pauses itself.
AUTO_PAUSE_AFTER_FAILURES = 5
# Extra time past a job's timeout before another process may take over its claim.
CLAIM_GRACE_SECONDS = 120
RUN_HISTORY_LIMIT = 100
MAX_RETRY_DELAY_SECONDS = 900
DEFAULT_MAX_RETRIES = 2

CATCH_UP_POLICIES = ("once", "skip")
NOTIFY_POLICIES = ("failures", "always", "never")
ON_FAILURE_POLICIES = ("retry", "notify", "disable")
PERMISSION_MODES = ("safe", "trust", "full", "yolo")

# Provider error types (see provider.classify_error_info) worth retrying automatically.
TRANSIENT_ERROR_TYPES = {"rate_limit", "provider_unavailable", "ollama_offline"}

ERROR_HELP: Dict[str, Tuple[str, Optional[str]]] = {
    "auth_error": ("The provider rejected the API key for this job's model.", "api_keys"),
    "quota_exceeded": ("The provider quota for this job's model is used up.", "edit_job"),
    "rate_limit": ("The provider is rate limiting requests.", None),
    "provider_unavailable": ("The provider was temporarily unavailable.", None),
    "model_not_found": ("This job's model is not available from its provider.", "edit_job"),
    "endpoint_not_found": ("The provider endpoint was not found. Check the provider base URL.", "api_keys"),
    "context_exceeded": ("The run grew past this model's context window.", "edit_job"),
    "ollama_offline": ("Ollama is not running.", None),
    "vision_unsupported": ("This job's model does not support images.", "edit_job"),
    "timeout": ("The run hit its time limit.", "edit_job"),
    "untrusted": ("This workspace is not trusted, so scheduled runs are blocked.", "trust_workspace"),
    "folder": ("This job's folder is not a project folder.", None),
    "blocked": ("Some actions were blocked by this job's permissions.", "edit_job"),
    "question": ("The agent asked a question, but nobody was there to answer it.", "edit_job"),
    "generic": ("The run failed.", None),
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_utc(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _safe_parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return _parse_iso_utc(ts)
    except (TypeError, ValueError):
        return None


def _local_naive(dt: datetime) -> datetime:
    return dt.astimezone().replace(tzinfo=None)


def _from_local_naive(dt: datetime) -> datetime:
    return dt.astimezone().astimezone(timezone.utc)


# ── Cron spec parsing ──────────────────────────────────────────────────────

_DOW_NAMES = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
_MONTH_NAMES = {m.lower(): i for i, m in enumerate(calendar.month_abbr) if m}
_DOW_WORDS = {
    "sunday": 0, "monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4, "friday": 5, "saturday": 6,
    **_DOW_NAMES, "tues": 2, "weds": 3, "thur": 4, "thurs": 4,
}
_DOW_LABELS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
_CRON_MACROS = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
}
_TIME_RE = r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?"
SCHEDULE_HELP = (
    "Use 'every 30m', 'every 2h', 'daily at 09:00', 'weekdays at 09:00', "
    "'mondays at 9am', '2026-12-01 14:00' (once) or cron syntax like '0 9 * * 1-5'."
)


def _parse_time_of_day(text: str) -> Optional[Tuple[int, int]]:
    m = re.fullmatch(_TIME_RE, text.strip())
    if not m:
        return None
    h, mins, ampm = int(m.group(1)), m.group(2), m.group(3)
    if mins is None and ampm is None:
        return None
    minute = int(mins) if mins is not None else 0
    if ampm:
        if not 1 <= h <= 12:
            return None
        if ampm == "pm" and h < 12:
            h += 12
        elif ampm == "am" and h == 12:
            h = 0
    if 0 <= h <= 23 and 0 <= minute <= 59:
        return (h, minute)
    return None


def parse_daily_time(schedule: str) -> Optional[tuple[int, int]]:
    s = re.sub(r"\s+", " ", schedule.strip().lower())
    m = re.fullmatch(r"(?:(?:daily|every day)\s+)?at\s+(.+)", s)
    if not m:
        return None
    return _parse_time_of_day(m.group(1))


def parse_exact_datetime(schedule: str) -> Optional[datetime]:
    s = schedule.strip().lower()
    s = re.sub(r"^(?:on\s+|at\s+|once\s+)+", "", s)
    s = s.replace(" at ", " ").replace("t", " ")
    parts = s.split()
    if len(parts) >= 2:
        date_str, time_str = parts[0], parts[1]
        try:
            if re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
                dt = datetime.fromisoformat(f"{date_str}T{time_str}")
                if dt.tzinfo is None:
                    return _from_local_naive(dt)
                return dt.astimezone(timezone.utc)
        except Exception:
            return None
    return None


def _cron_value(token: str, names: Optional[Dict[str, int]]) -> int:
    token = token.strip().lower()
    if names and token in names:
        return names[token]
    if not token.isdigit():
        raise ValueError(f"'{token}' is not a number")
    return int(token)


def _parse_cron_field(spec: str, lo: int, hi: int, label: str,
                      names: Optional[Dict[str, int]] = None) -> FrozenSet[int]:
    values: set = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            raise ValueError(f"The {label} field has an empty entry.")
        step = 1
        base = part
        if "/" in part:
            base, step_str = part.split("/", 1)
            if not step_str.isdigit() or int(step_str) <= 0:
                raise ValueError(f"The {label} step '{step_str}' must be a positive number.")
            step = int(step_str)
        try:
            if base == "*":
                start, end = lo, hi
            elif "-" in base:
                a, b = base.split("-", 1)
                start, end = _cron_value(a, names), _cron_value(b, names)
            else:
                start = _cron_value(base, names)
                end = hi if "/" in part else start
        except ValueError:
            raise ValueError(f"The {label} field '{part}' is not valid.")
        if not (lo <= start <= hi and lo <= end <= hi):
            raise ValueError(f"The {label} field '{part}' is out of range ({lo}-{hi}).")
        if start > end:
            raise ValueError(f"The {label} range '{part}' runs backwards.")
        values.update(range(start, end + 1, step))
    return frozenset(values)


@dataclass(frozen=True)
class CronSpec:
    minutes: FrozenSet[int]
    hours: FrozenSet[int]
    days: FrozenSet[int]
    months: FrozenSet[int]
    weekdays: FrozenSet[int]
    days_any: bool
    weekdays_any: bool

    @classmethod
    def parse(cls, expr: str) -> "CronSpec":
        expr = _CRON_MACROS.get(expr.strip().lower(), expr)
        parts = expr.split()
        if len(parts) != 5:
            raise ValueError("Cron syntax needs 5 fields: minute hour day-of-month month day-of-week.")
        mi, ho, dom, mon, dow = parts
        weekdays = _parse_cron_field(dow, 0, 7, "day-of-week", _DOW_NAMES)
        weekdays = frozenset(0 if d == 7 else d for d in weekdays)
        return cls(
            minutes=_parse_cron_field(mi, 0, 59, "minute"),
            hours=_parse_cron_field(ho, 0, 23, "hour"),
            days=_parse_cron_field(dom, 1, 31, "day-of-month"),
            months=_parse_cron_field(mon, 1, 12, "month", _MONTH_NAMES),
            weekdays=weekdays,
            days_any=dom.strip() == "*",
            weekdays_any=dow.strip() == "*",
        )

    def day_matches(self, d: date) -> bool:
        if d.month not in self.months:
            return False
        dom_ok = d.day in self.days
        dow_ok = ((d.weekday() + 1) % 7) in self.weekdays
        if self.days_any or self.weekdays_any:
            return dom_ok and dow_ok
        return dom_ok or dow_ok

    def matches(self, dt: datetime) -> bool:
        return dt.minute in self.minutes and dt.hour in self.hours and self.day_matches(dt.date())

    def next_after(self, after: datetime) -> Optional[datetime]:
        """Next matching wall-clock minute strictly after a naive local datetime."""
        t = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
        hours = sorted(self.hours)
        minutes = sorted(self.minutes)
        day = t.date()
        for _ in range(366 * 8):
            if self.day_matches(day):
                first_hour = t.hour if day == t.date() else 0
                for h in hours:
                    if h < first_hour:
                        continue
                    first_min = t.minute if (day == t.date() and h == t.hour) else 0
                    for mi in minutes:
                        if mi >= first_min:
                            return datetime(day.year, day.month, day.day, h, mi)
            day += timedelta(days=1)
        return None


def is_cron_expression(schedule: str) -> bool:
    try:
        CronSpec.parse(schedule)
        return True
    except ValueError:
        return False


def matches_cron(schedule: str, dt: datetime) -> bool:
    try:
        return CronSpec.parse(schedule).matches(dt)
    except ValueError:
        return False


_UNIT_SECONDS = {
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
}
_DURATION_RE = re.compile(r"(\d+)\s*([a-z]+)")


def _parse_every(s: str) -> Optional[int]:
    m = re.fullmatch(r"every\s+(.+)", s)
    if not m:
        return None
    body = m.group(1).strip()
    if body in ("minute", "hour", "day"):
        return _UNIT_SECONDS[body]
    if not re.fullmatch(r"(?:\d+\s*[a-z]+\s*)+", body):
        return None
    total = 0
    for num, unit in _DURATION_RE.findall(body):
        if unit not in _UNIT_SECONDS:
            return None
        total += int(num) * _UNIT_SECONDS[unit]
    return total


def _parse_day_words(text: str) -> Optional[FrozenSet[int]]:
    text = text.strip()
    if text in ("weekday", "weekdays"):
        return frozenset({1, 2, 3, 4, 5})
    if text in ("weekend", "weekends"):
        return frozenset({0, 6})
    days = set()
    for word in re.split(r"\s*(?:,|\band\b)\s*", text):
        word = word.strip()
        if not word:
            continue
        key = word[:-1] if word.endswith("s") and word[:-1] in _DOW_WORDS else word
        if key not in _DOW_WORDS:
            return None
        days.add(_DOW_WORDS[key])
    return frozenset(days) or None


@dataclass(frozen=True)
class Schedule:
    kind: str  # "interval" | "cron" | "once"
    text: str
    interval_seconds: int = 0
    cron: Optional[CronSpec] = None
    once_at: Optional[datetime] = None

    @property
    def is_calendar(self) -> bool:
        return self.kind in ("cron", "once")

    def next_after(self, after: datetime) -> Optional[datetime]:
        if self.kind == "interval":
            return after + timedelta(seconds=self.interval_seconds)
        if self.kind == "once":
            return self.once_at if self.once_at and self.once_at > after else None
        nxt = self.cron.next_after(_local_naive(after)) if self.cron else None
        return _from_local_naive(nxt) if nxt else None

    def describe(self) -> str:
        if self.kind == "interval":
            return "Every " + _describe_duration(self.interval_seconds)
        if self.kind == "once":
            return "Once on " + _format_local(self.once_at)
        return _describe_cron(self.cron, self.text) if self.cron else self.text


def parse_schedule(schedule: str) -> Schedule:
    """Parse any supported schedule. Raises ValueError with a user-facing message."""
    raw = (schedule or "").strip()
    s = re.sub(r"\s+", " ", raw.lower())
    if not s:
        raise ValueError("Enter a schedule. " + SCHEDULE_HELP)

    every = _parse_every(s)
    if every is not None:
        if every < 60:
            raise ValueError("Minimum cron interval is 1 minute (60s).")
        return Schedule("interval", raw, interval_seconds=every)
    if s == "hourly":
        return Schedule("interval", raw, interval_seconds=3600)

    daily = parse_daily_time(s)
    if daily is not None:
        h, mi = daily
        return Schedule("cron", raw, cron=CronSpec.parse(f"{mi} {h} * * *"))

    m = re.fullmatch(r"(?:every |on )?(.+?) at (.+)", s)
    if m:
        days = _parse_day_words(m.group(1))
        tod = _parse_time_of_day(m.group(2))
        if days is not None and tod is not None:
            h, mi = tod
            dow = ",".join(str(d) for d in sorted(days))
            return Schedule("cron", raw, cron=CronSpec.parse(f"{mi} {h} * * {dow}"))

    once = parse_exact_datetime(s)
    if once is not None:
        return Schedule("once", raw, once_at=once)

    tokens = s.split()
    looks_like_cron = "*" in s and all(re.fullmatch(r"[\d*/,\-a-z]+", t) for t in tokens)
    if s.startswith("@") or len(tokens) == 5 or (looks_like_cron and 3 <= len(tokens) <= 7):
        try:
            spec = CronSpec.parse(s)
        except ValueError as e:
            raise ValueError(f"{e} {SCHEDULE_HELP}")
        if spec.next_after(datetime(2000, 1, 1)) is None:
            raise ValueError("This cron schedule never runs (for example 30 February).")
        return Schedule("cron", raw, cron=spec)

    if s in ("daily", "weekly", "monthly"):
        raise ValueError(f"Add a time, for example '{s} at 09:00'." if s == "daily" else f"Use '@{s}' or cron syntax. {SCHEDULE_HELP}")
    raise ValueError(f"Invalid schedule: '{raw}'. {SCHEDULE_HELP}")


def _describe_duration(seconds: int) -> str:
    parts = []
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if seconds >= size:
            n, seconds = divmod(seconds, size)
            parts.append(f"{n} {unit}" + ("s" if n != 1 else ""))
    if parts == ["1 day"]:
        return "day"
    if parts == ["1 hour"]:
        return "hour"
    if parts == ["1 minute"]:
        return "minute"
    return " ".join(parts) or "minute"


def _format_local(dt: Optional[datetime]) -> str:
    if not dt:
        return "—"
    local = dt.astimezone()
    return local.strftime("%a %d %b %Y at %H:%M")


def _describe_cron(spec: CronSpec, text: str) -> str:
    one_time = len(spec.minutes) == 1 and len(spec.hours) == 1
    all_months = len(spec.months) == 12
    if one_time and all_months and spec.days_any:
        at = f"{next(iter(spec.hours)):02d}:{next(iter(spec.minutes)):02d}"
        days = spec.weekdays
        if len(days) == 7:
            return f"Every day at {at}"
        if days == frozenset({1, 2, 3, 4, 5}):
            return f"Weekdays at {at}"
        if days == frozenset({0, 6}):
            return f"Weekends at {at}"
        labels = [_DOW_LABELS[d] for d in sorted(days, key=lambda d: (d + 6) % 7)]
        joined = labels[0] if len(labels) == 1 else ", ".join(labels[:-1]) + " and " + labels[-1]
        return f"{joined} at {at}"
    if one_time and all_months and spec.weekdays_any and len(spec.days) == 1:
        at = f"{next(iter(spec.hours)):02d}:{next(iter(spec.minutes)):02d}"
        return f"Day {next(iter(spec.days))} of every month at {at}"
    if len(spec.minutes) == 1 and len(spec.hours) == 24 and spec.days_any and spec.weekdays_any and all_months:
        return f"Every hour at :{next(iter(spec.minutes)):02d}"
    return f"Cron schedule '{text.strip()}'"


def describe_schedule(schedule: str) -> str:
    try:
        return parse_schedule(schedule).describe()
    except ValueError:
        return schedule


def preview_schedule(schedule: str, count: int = 5, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Validate a schedule and list its next run times (ISO UTC) for the editor preview."""
    now = now or _utcnow()
    try:
        sched = parse_schedule(schedule)
    except ValueError as e:
        return {"valid": False, "error": str(e), "description": "", "next_runs": [], "kind": None}
    runs: List[str] = []
    cursor = now
    for _ in range(max(1, min(count, 20))):
        nxt = sched.next_after(cursor)
        if nxt is None:
            break
        runs.append(nxt.isoformat())
        cursor = nxt
    return {"valid": True, "error": None, "description": sched.describe(), "next_runs": runs, "kind": sched.kind}


def _format_remaining_seconds(remaining: float) -> str:
    if remaining <= 0:
        return "now"
    if remaining < 60:
        return f"{int(remaining)}s"
    elif remaining < 3600:
        return f"{int(remaining // 60)}m"
    elif remaining < 86400:
        return f"{int(remaining // 3600)}h {int((remaining % 3600) // 60)}m"
    else:
        days = int(remaining // 86400)
        hours = int((remaining % 86400) // 3600)
        return f"{days}d {hours}h"


def parse_interval_seconds(schedule: str) -> int:
    sched = parse_schedule(schedule)
    if sched.kind == "interval":
        return sched.interval_seconds
    if sched.kind == "once":
        return 86400
    if parse_daily_time(schedule) is not None:
        return 86400
    return 3600


def friendly_error(error_type: Optional[str], detail: Optional[str] = None) -> str:
    base, _ = ERROR_HELP.get(error_type or "generic", ERROR_HELP["generic"])
    if detail and detail.strip() and detail.strip() != base:
        return f"{base} {detail.strip()}"
    return base


def classify_exception(e: BaseException, provider: str = "", model: str = "") -> Tuple[str, str]:
    """Map an exception from a cron run to (error_type, user-facing message)."""
    try:
        from andromity.core.provider import classify_error_info, extract_clean_error_message
        info = classify_error_info(e, provider=provider, model=model)  # type: ignore[arg-type]
        err_type = info.get("type") or "generic"
        detail = extract_clean_error_message(e) if err_type == "generic" else ""
    except Exception:
        err_type, detail = "generic", ""
    if err_type == "generic" and not detail:
        detail = type(e).__name__
    return err_type, friendly_error(err_type, detail[:300] if detail else None)


# ── Folder checks ──────────────────────────────────────────────────────────

def project_folder_problem(path: Optional[str]) -> Optional[str]:
    """Why a folder can't host scheduled jobs, or None when it is usable."""
    if not path:
        return "Open a folder to use scheduled jobs."
    p = Path(path)
    if not p.is_dir():
        return f"This job's folder no longer exists: {path}"
    if (p / "resources" / "app").is_dir():
        return f"{path} is an application install folder, not a project. Open your project folder instead."
    return None


# ── Unattended run helpers ─────────────────────────────────────────────────

_SAFE_BLOCKED_TOOLS = ("write_file", "edit_file", "edit_file_multi", "shell_kill", "spawn_subagent")
_UNTRUSTED_BLOCKED_TOOLS = ("write_file", "edit_file", "edit_file_multi", "shell_exec", "shell_bg", "shell_kill", "spawn_subagent")
_UNATTENDED_NOTE = "Nobody can approve actions during a scheduled run, so continue without it and list it under Blocked in your final report."


def effective_allowed_commands(job: "CronJob", default_allowed: Optional[List[str]] = None) -> List[str]:
    return list(job.allowed_commands or default_allowed or [])


def cron_tool_decision(job: "CronJob", tool_name: str, args: Dict[str, Any], trusted: bool,
                       default_allowed: Optional[List[str]] = None) -> Tuple[bool, Optional[str]]:
    """Approve or block a tool call in an unattended cron run. Returns (approved, reason)."""
    if not trusted and tool_name in _UNTRUSTED_BLOCKED_TOOLS:
        return False, f"Blocked: this workspace is not trusted, so '{tool_name}' cannot run. {_UNATTENDED_NOTE}"
    mode = (job.mode or "trust").lower()
    if mode == "yolo":
        return True, None
    from andromity.core.security import is_execution_control_path, is_sensitive_path
    target_path = str(args.get("path", "") or args.get("target_path", "") or args.get("target_file", "") or args.get("file_path", ""))
    if target_path and is_sensitive_path(target_path, job.project_path):
        return False, f"Blocked: '{target_path}' is a sensitive file, and scheduled runs never touch sensitive files. {_UNATTENDED_NOTE}"
    is_write = tool_name in ("write_file", "edit_file", "edit_file_multi")
    if mode != "full" and is_write and target_path and is_execution_control_path(target_path, job.project_path):
        return False, (
            f"Blocked: '{target_path}' controls what runs later (git hooks, editor tasks, package scripts, MCP servers), "
            f"and only FULL mode may change it without a person approving. {_UNATTENDED_NOTE}"
        )
    if tool_name in ("shell_exec", "shell_bg"):
        from andromity.core.security import is_command_allowlisted
        command = str(args.get("command", "")).strip()
        allowed = effective_allowed_commands(job, default_allowed)
        if is_command_allowlisted(command, allowed):
            return True, None
        listed = ", ".join(allowed) if allowed else "none"
        return False, (
            f"Blocked by this scheduled job's allowed commands: '{command[:120]}' is not on the list. "
            f"Allowed commands: {listed}. {_UNATTENDED_NOTE}"
        )
    if tool_name in _SAFE_BLOCKED_TOOLS and mode == "safe":
        return False, f"Blocked: this scheduled job runs in SAFE mode, which does not allow '{tool_name}'. {_UNATTENDED_NOTE}"
    if mode in ("safe", "trust"):
        reason = _unattended_network_block(tool_name, args, mode)
        if reason:
            return False, f"{reason} {_UNATTENDED_NOTE}"
    return True, None


def _unattended_network_block(tool_name: str, args: Dict[str, Any], mode: str) -> Optional[str]:
    """The checks an interactive run would ask a person about, answered "no" when nobody is there."""
    if tool_name in ("web_search", "fetch_url") and mode == "safe":
        return f"Blocked: this scheduled job runs in SAFE mode, which does not allow '{tool_name}'."
    if tool_name == "fetch_url":
        from andromity.config import config
        from andromity.core.security import is_domain_allowed
        url = str(args.get("url", ""))
        if not is_domain_allowed(url, config.get("default", "allowed_domains", []) or []):
            return f"Blocked: '{url[:120]}' is not on the allowed domains list, and scheduled runs only fetch allowed domains."
    if tool_name.startswith("mcp__"):
        from andromity.core.security import mcp_tool_may_change
        if mode == "safe":
            return f"Blocked: this scheduled job runs in SAFE mode, which does not allow MCP tools such as '{tool_name}'."
        if mcp_tool_may_change(tool_name):
            return f"Blocked: '{tool_name}' may change data, and only FULL mode runs such MCP tools without a person approving."
    return None


def build_unattended_prompt(job: "CronJob", default_allowed: Optional[List[str]] = None) -> str:
    allowed = effective_allowed_commands(job, default_allowed)
    mode = (job.mode or "trust").upper()
    lines = [
        f"[Scheduled run of \"{job.name}\". Nobody is watching this run, so do not ask questions or wait for replies.",
        "Finish the task on your own, then end with a short report: what you did, what you found, and anything that was blocked.",
        f"Permission mode: {mode}" + (" (file edits are blocked)." if mode == "SAFE" else "."),
        ("Shell commands allowed for this job: " + ", ".join(allowed) + ". Other commands will be blocked."
         if allowed else "No shell commands are allowed for this job."),
        "]",
    ]
    return "\n".join(lines) + "\n\n" + job.prompt


def _ends_with_question(text: str) -> bool:
    for line in reversed(text.strip().splitlines()):
        cleaned = line.strip().strip("*_`> ").strip()
        if cleaned:
            return cleaned.endswith("?")
    return False


class CronRunCollector:
    """Accumulates agent stream events for a cron run and decides its outcome."""

    def __init__(self):
        self._text: List[str] = []
        self.tools_used: List[str] = []
        self.tool_executions: List[Dict[str, Any]] = []
        self.files_modified: List[str] = []
        self.blocked: List[str] = []
        self.provider_error_type: Optional[str] = None
        self._active: Dict[str, Dict[str, Any]] = {}

    def note_blocked(self, tool_name: str, args: Dict[str, Any]):
        detail = str(args.get("command") or args.get("path") or args.get("file_path") or "").strip()
        label = f"{tool_name}: {detail[:80]}" if detail else tool_name
        if label not in self.blocked:
            self.blocked.append(label)

    def feed(self, event: Any):
        from andromity.core.events import Done, TextDelta, ToolCallDelta, ToolCallStart, ToolResult
        if isinstance(event, TextDelta):
            self._text.append(event.text)
        elif isinstance(event, ToolCallStart):
            self.tools_used.append(event.tool_name)
            self._active[event.tool_id] = {"tool_name": event.tool_name, "args": ""}
        elif isinstance(event, ToolCallDelta):
            rec = self._active.get(event.tool_id)
            if rec is not None:
                rec["args"] += event.args_json_chunk or ""
        elif isinstance(event, ToolResult):
            rec = self._active.pop(event.tool_id, None) or {"tool_name": "tool", "args": ""}
            res_str = str(event.result)[:1000] if event.result is not None else ""
            ok = bool(getattr(event, "success", True))
            try:
                parsed = json.loads(rec["args"]) if rec["args"] else {}
            except Exception:
                parsed = {}
            if ok and rec["tool_name"] in ("write_file", "edit_file", "edit_file_multi", "write_to_file", "replace_file_content", "multi_replace_file_content"):
                fpath = parsed.get("path") or parsed.get("target_file") or parsed.get("file_path") or parsed.get("TargetFile")
                if fpath and str(fpath) not in self.files_modified:
                    self.files_modified.append(str(fpath))
            self.tool_executions.append({
                "tool_name": rec["tool_name"],
                "result": res_str,
                "success": ok,
                "duration_ms": int(getattr(event, "duration_ms", 0) or 0),
            })
        elif isinstance(event, Done) and event.outcome == "error":
            self.provider_error_type = event.error_type or "generic"

    @property
    def output(self) -> str:
        return "".join(self._text).strip()

    def outcome(self, exc: Optional[BaseException] = None, timed_out: bool = False, timeout_seconds: int = 0,
                provider: str = "", model: str = "") -> Tuple[str, Optional[str], Optional[str]]:
        """Return (status, error, error_type) for the finished run."""
        if timed_out:
            return "timeout", f"The run hit its time limit of {_describe_duration(timeout_seconds or 60)} and was stopped. Raise the timeout or narrow the prompt.", "timeout"
        if exc is not None:
            err_type, msg = classify_exception(exc, provider, model)
            return "failed", msg, err_type
        if self.provider_error_type:
            return "failed", friendly_error(self.provider_error_type), self.provider_error_type
        problems = []
        err_type = None
        if self.blocked:
            problems.append("Blocked: " + "; ".join(self.blocked[:5]) + ". Edit the job's allowed commands or permission mode if it needs these.")
            err_type = "blocked"
        if _ends_with_question(self.output):
            problems.append("The agent ended with a question that nobody could answer. Make the prompt more specific so the job can finish on its own.")
            err_type = err_type or "question"
        if problems:
            return "needs_attention", " ".join(problems), err_type
        return "success", None, None


# ── Jobs ───────────────────────────────────────────────────────────────────

@dataclass
class CronJob:
    id: str
    name: str
    prompt: str
    schedule: str = "every 1h"
    interval_seconds: int = 3600
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    mode: str = "trust"
    allowed_commands: List[str] = field(default_factory=list)
    on_failure: str = "retry"
    retry_delay_seconds: int = 0
    timeout_seconds: int = 600
    enabled: bool = True
    project_path: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    last_run: Optional[str] = None
    last_status: str = "never"
    last_error: Optional[str] = None
    run_count: int = 0
    fail_count: int = 0
    retry_count: int = 0
    next_run_at: Optional[str] = None
    catch_up: str = "once"
    max_retries: int = DEFAULT_MAX_RETRIES
    notify: str = "failures"
    consecutive_failures: int = 0
    paused_reason: Optional[str] = None
    last_error_type: Optional[str] = None
    updated_at: Optional[str] = None
    running_since: Optional[str] = None
    lease_owner: Optional[str] = None

    # ── Schedule ───────────────────────────────────────────────────────────

    def parsed_schedule(self) -> Optional[Schedule]:
        try:
            return parse_schedule(self.schedule)
        except ValueError:
            return None

    def _regular_next(self, now: datetime, sched: Schedule, fresh: bool = False) -> Optional[datetime]:
        if sched.kind == "interval":
            last = _safe_parse_iso(self.last_run)
            if last is not None:
                nxt = last + timedelta(seconds=sched.interval_seconds)
                return nxt if nxt > now else now
            return now + timedelta(seconds=sched.interval_seconds)
        if sched.kind == "once":
            if fresh:
                return sched.once_at if sched.once_at and sched.once_at > now else None
            return None if self.last_run else sched.once_at
        return sched.next_after(now)

    def ensure_next_run(self, now: Optional[datetime] = None) -> bool:
        """Fill next_run_at for jobs saved before it existed. Returns True if it changed."""
        if self.next_run_at:
            return False
        now = now or _utcnow()
        sched = self.parsed_schedule()
        if sched is None:
            return False
        last = _safe_parse_iso(self.last_run)
        if self.retry_count > 0 and self.retry_delay_seconds > 0 and last is not None:
            nxt: Optional[datetime] = last + timedelta(seconds=self.retry_delay_seconds)
        elif sched.kind == "interval":
            nxt = (last + timedelta(seconds=sched.interval_seconds)) if last is not None else now
        elif sched.kind == "once":
            nxt = None if last is not None else sched.once_at
        else:
            nxt = sched.next_after(last) if last is not None else sched.next_after(now)
        if nxt is None:
            return False
        self.next_run_at = nxt.isoformat()
        return True

    def reschedule(self, now: Optional[datetime] = None, fresh: bool = False):
        """Recompute the next run from now, e.g. after an edit or resume.

        fresh=True treats a one-time schedule as new even if an earlier time already ran."""
        now = now or _utcnow()
        self.retry_count = 0
        self.retry_delay_seconds = 0
        sched = self.parsed_schedule()
        nxt = self._regular_next(now, sched, fresh) if sched else None
        self.next_run_at = nxt.isoformat() if nxt else None

    def due_decision(self, now: Optional[datetime] = None) -> Optional[str]:
        """'run', 'catch_up', 'retry', 'missed' or None when the job is not due."""
        if not self.enabled:
            return None
        now = now or _utcnow()
        self.ensure_next_run(now)
        nxt = _safe_parse_iso(self.next_run_at)
        if nxt is None or now < nxt:
            return None
        if self.retry_count > 0:
            return "retry"
        late = (now - nxt).total_seconds()
        if late <= LATE_GRACE_SECONDS:
            return "run"
        sched = self.parsed_schedule()
        if sched is None or not sched.is_calendar:
            return "catch_up"
        if self.catch_up == "once" and late <= CATCH_UP_WINDOW_SECONDS:
            return "catch_up"
        return "missed"

    def is_due(self) -> bool:
        return self.due_decision() in ("run", "catch_up", "retry")

    def next_run_datetime(self) -> Optional[datetime]:
        if not self.enabled:
            return None
        self.ensure_next_run()
        return _safe_parse_iso(self.next_run_at)

    # ── Results ────────────────────────────────────────────────────────────

    def apply_result(self, status: str, error: Optional[str] = None, error_type: Optional[str] = None,
                     now: Optional[datetime] = None):
        """Record a finished, skipped or missed run and plan the next one."""
        now = now or _utcnow()
        sched = self.parsed_schedule()
        self.updated_at = now.isoformat()
        if status in ("skipped", "missed"):
            self.last_error = error
            self.last_error_type = error_type
            if status == "skipped":
                self.last_status = "skipped"
            if error_type == "untrusted":
                self.enabled = False
                self.paused_reason = "Paused because this workspace is not trusted. Trust the workspace, then resume the job."
            elif error_type == "folder":
                self.enabled = False
                self.paused_reason = error
            nxt = sched.next_after(now) if sched else None
            if sched and sched.kind == "once":
                self.enabled = False
                nxt = None
            self.next_run_at = nxt.isoformat() if nxt else None
            return

        self.run_count += 1
        self.last_run = now.isoformat()
        self.last_status = status
        self.last_error = error
        self.last_error_type = error_type
        if status == "interrupted":
            self.retry_count = 0
            self.retry_delay_seconds = 0
            self._plan_regular(now, sched)
            return
        if status in ("success", "needs_attention"):
            self.consecutive_failures = 0
            self.retry_count = 0
            self.retry_delay_seconds = 0
            self._plan_regular(now, sched)
            return

        self.fail_count += 1
        self.consecutive_failures += 1
        transient = error_type in TRANSIENT_ERROR_TYPES
        limit = self.max_retries if self.max_retries is not None else DEFAULT_MAX_RETRIES
        if self.on_failure == "retry" and transient and self.retry_count < limit:
            self.retry_count += 1
            base = min(60 * (2 ** (self.retry_count - 1)), MAX_RETRY_DELAY_SECONDS)
            delay = int(base + random.uniform(0, base * 0.1))
            self.retry_delay_seconds = delay
            self.next_run_at = (now + timedelta(seconds=delay)).isoformat()
        else:
            self.retry_count = 0
            self.retry_delay_seconds = 0
            self._plan_regular(now, sched)
        if self.on_failure == "disable":
            self.enabled = False
            self.paused_reason = "Paused after a failed run (this job pauses on failure)."
        elif self.consecutive_failures >= AUTO_PAUSE_AFTER_FAILURES:
            self.enabled = False
            self.paused_reason = f"Paused after {self.consecutive_failures} failed runs in a row. Fix the cause, then resume."

    def _plan_regular(self, now: datetime, sched: Optional[Schedule]):
        if sched is not None and sched.kind == "once":
            self.enabled = False
            self.next_run_at = None
            return
        nxt = self._regular_next(now, sched) if sched else None
        self.next_run_at = nxt.isoformat() if nxt else None

    def mark_run(self, success: bool, error: Optional[str] = None):
        self.apply_result("success" if success else "failed", error, None if success else "generic")

    def set_enabled(self, enabled: bool, now: Optional[datetime] = None):
        self.enabled = enabled
        if enabled:
            self.paused_reason = None
            self.consecutive_failures = 0
            self.reschedule(now)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CronJob":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    def next_run_in(self) -> str:
        nxt = self.next_run_datetime()
        if nxt is None:
            return "completed"
        return _format_remaining_seconds((nxt - _utcnow()).total_seconds())

    def claim_expired(self, now: Optional[datetime] = None) -> bool:
        started = _safe_parse_iso(self.running_since)
        if started is None:
            return True
        now = now or _utcnow()
        limit = (self.timeout_seconds if self.timeout_seconds and self.timeout_seconds > 0 else 600) + CLAIM_GRACE_SECONDS
        return (now - started).total_seconds() > limit

    def is_running(self, now: Optional[datetime] = None) -> bool:
        return bool(self.running_since) and not self.claim_expired(now)

    def summary(self) -> Dict[str, Any]:
        """Job fields plus derived values for UIs (next run, schedule text, folder state)."""
        d = self.to_dict()
        d.pop("lease_owner", None)
        d["next_run_in"] = self.next_run_in()
        nxt = self.next_run_datetime()
        d["next_run_at"] = nxt.isoformat() if nxt else None
        d["schedule_description"] = describe_schedule(self.schedule)
        d["schedule_valid"] = self.parsed_schedule() is not None
        d["running"] = self.is_running()
        d["folder_problem"] = project_folder_problem(self.project_path)
        d["fix_action"] = ERROR_HELP.get(self.last_error_type or "", (None, None))[1] if self.last_error_type else None
        return d


_CRON_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")


def _validate_cron_id(id_str: str) -> str:
    """Validate that a cron job or run ID is a safe identifier without path traversal."""
    if not id_str or not _CRON_ID_RE.match(str(id_str)):
        raise ValueError(f"Invalid cron identifier: {id_str!r}")
    return str(id_str)


# ── Storage ────────────────────────────────────────────────────────────────

_JOB_COLUMNS = (
    "name", "prompt", "schedule", "interval_seconds", "provider", "model", "mode",
    "allowed_commands", "on_failure", "retry_delay_seconds", "timeout_seconds", "enabled",
    "last_run", "last_status", "last_error", "run_count", "fail_count", "retry_count", "created_at",
    "next_run_at", "catch_up", "max_retries", "notify", "consecutive_failures", "paused_reason",
    "last_error_type", "updated_at",
)
_SNAPSHOT_EXCLUDE = ("running_since", "lease_owner")


def _row_get(row, key: str, default: Any = None) -> Any:
    try:
        value = row[key]
    except (IndexError, KeyError):
        return default
    return default if value is None and default is not None else value


class CronStore:
    def __init__(self, project_path: str):
        self._project_path = str(Path(project_path).resolve())
        self._path = Path(project_path) / ".andromity" / "crons.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _job_from_row(r) -> CronJob:
        from andromity.core.db import uj
        return CronJob(
            id=r["id"],
            project_path=r["project_path"],
            name=r["name"],
            prompt=r["prompt"],
            schedule=r["schedule"],
            interval_seconds=r["interval_seconds"],
            provider=r["provider"],
            model=r["model"],
            mode=r["mode"],
            allowed_commands=uj(r["allowed_commands"], []),
            on_failure=r["on_failure"],
            retry_delay_seconds=r["retry_delay_seconds"],
            timeout_seconds=r["timeout_seconds"],
            enabled=bool(r["enabled"]),
            last_run=r["last_run"],
            last_status=r["last_status"],
            last_error=r["last_error"],
            run_count=r["run_count"],
            fail_count=r["fail_count"],
            retry_count=r["retry_count"],
            created_at=r["created_at"],
            next_run_at=_row_get(r, "next_run_at"),
            catch_up=_row_get(r, "catch_up", "once"),
            max_retries=_row_get(r, "max_retries", DEFAULT_MAX_RETRIES),
            notify=_row_get(r, "notify", "failures"),
            consecutive_failures=_row_get(r, "consecutive_failures", 0),
            paused_reason=_row_get(r, "paused_reason"),
            last_error_type=_row_get(r, "last_error_type"),
            updated_at=_row_get(r, "updated_at"),
            running_since=_row_get(r, "running_since"),
            lease_owner=_row_get(r, "lease_owner"),
        )

    def load(self) -> List[CronJob]:
        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()
        rows = conn.execute(
            "SELECT * FROM cron_jobs WHERE project_path = ? ORDER BY created_at ASC",
            (self._project_path,)
        ).fetchall()

        jobs: List[CronJob] = [self._job_from_row(r) for r in rows]
        known_ids = {j.id for j in jobs}

        # Also check JSON file for any unmigrated jobs
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
                unmigrated = []
                for c_dict in data.get("crons", []):
                    c_obj = CronJob.from_dict(c_dict)
                    if c_obj.id not in known_ids:
                        # The file can arrive with a cloned repository. Jobs never created on this
                        # machine stay off until the user enables them, and never start auto-approving.
                        c_obj.enabled = False
                        if (c_obj.mode or "").lower() in ("full", "yolo"):
                            c_obj.mode = "safe"
                        c_obj.running_since = None
                        c_obj.lease_owner = None
                        unmigrated.append(c_obj)
                        jobs.append(c_obj)
                        known_ids.add(c_obj.id)
                if unmigrated:
                    self.save(jobs)  # Auto-migrate missing jobs to SQLite
            except Exception:
                pass

        return jobs

    def get(self, job_id: str) -> Optional[CronJob]:
        from andromity.core.db import get_conn, init_schema
        init_schema()
        r = get_conn().execute(
            "SELECT * FROM cron_jobs WHERE id = ? AND project_path = ?", (job_id, self._project_path)
        ).fetchone()
        return self._job_from_row(r) if r else None

    def _upsert(self, conn, c: CronJob):
        from andromity.core.db import j
        c.project_path = self._project_path
        values = {
            "name": c.name, "prompt": c.prompt, "schedule": c.schedule,
            "interval_seconds": c.interval_seconds, "provider": c.provider, "model": c.model,
            "mode": c.mode, "allowed_commands": j(c.allowed_commands, default="[]"),
            "on_failure": c.on_failure, "retry_delay_seconds": c.retry_delay_seconds,
            "timeout_seconds": c.timeout_seconds, "enabled": 1 if c.enabled else 0,
            "last_run": c.last_run, "last_status": c.last_status, "last_error": c.last_error,
            "run_count": c.run_count, "fail_count": c.fail_count, "retry_count": c.retry_count,
            "created_at": c.created_at, "next_run_at": c.next_run_at, "catch_up": c.catch_up,
            "max_retries": c.max_retries, "notify": c.notify,
            "consecutive_failures": c.consecutive_failures, "paused_reason": c.paused_reason,
            "last_error_type": c.last_error_type, "updated_at": c.updated_at,
        }
        cols = ", ".join(("id", "project_path") + _JOB_COLUMNS)
        marks = ", ".join("?" * (2 + len(_JOB_COLUMNS)))
        updates = ", ".join(f"{k} = excluded.{k}" for k in _JOB_COLUMNS)
        # An upsert, not INSERT OR REPLACE: REPLACE deletes the row first, and the
        # ON DELETE CASCADE foreign key would then wipe the job's run history.
        conn.execute(
            f"INSERT INTO cron_jobs ({cols}) VALUES ({marks}) ON CONFLICT(id) DO UPDATE SET {updates}",
            [c.id, self._project_path] + [values[k] for k in _JOB_COLUMNS],
        )

    def save(self, crons: List[CronJob]):
        from andromity.core.db import get_conn, init_schema, transaction
        init_schema()
        conn = get_conn()
        current_ids = {c.id for c in crons}
        try:
            with transaction(conn):
                # 1. Delete only jobs removed from this project (preserves run history for retained jobs)
                existing_rows = conn.execute(
                    "SELECT id FROM cron_jobs WHERE project_path = ?", (self._project_path,)
                ).fetchall()
                removed_ids = {r["id"] for r in existing_rows} - current_ids
                if removed_ids:
                    placeholders = ",".join("?" * len(removed_ids))
                    conn.execute(
                        f"DELETE FROM cron_jobs WHERE id IN ({placeholders})", list(removed_ids)
                    )
                # 2. Upsert current jobs
                for c in crons:
                    self._upsert(conn, c)
        except Exception as e:
            log.exception("Failed to save crons to SQLite: %s", e)
        self._write_snapshot(crons)

    def upsert(self, job: CronJob):
        """Save one job without touching the others (safe when several processes share the DB)."""
        from andromity.core.db import get_conn, init_schema
        init_schema()
        try:
            self._upsert(get_conn(), job)
        except Exception as e:
            log.exception("Failed to save cron %s: %s", job.id, e)
        self._write_snapshot(self.load_db_only())

    def delete(self, job_id: str) -> bool:
        from andromity.core.db import get_conn, init_schema
        init_schema()
        cur = get_conn().execute(
            "DELETE FROM cron_jobs WHERE id = ? AND project_path = ?", (job_id, self._project_path)
        )
        self._write_snapshot(self.load_db_only())
        return cur.rowcount > 0

    def load_db_only(self) -> List[CronJob]:
        from andromity.core.db import get_conn, init_schema
        init_schema()
        rows = get_conn().execute(
            "SELECT * FROM cron_jobs WHERE project_path = ? ORDER BY created_at ASC", (self._project_path,)
        ).fetchall()
        return [self._job_from_row(r) for r in rows]

    def claim(self, job: CronJob, owner: str, now: datetime) -> bool:
        """Atomically mark a job as running for this owner. False if someone else holds it."""
        from andromity.core.db import get_conn, init_schema
        init_schema()
        limit = (job.timeout_seconds if job.timeout_seconds and job.timeout_seconds > 0 else 600) + CLAIM_GRACE_SECONDS
        cutoff = (now - timedelta(seconds=limit)).isoformat()
        cur = get_conn().execute(
            "UPDATE cron_jobs SET running_since = ?, lease_owner = ? "
            "WHERE id = ? AND project_path = ? AND (running_since IS NULL OR running_since < ?)",
            (now.isoformat(), owner, job.id, self._project_path, cutoff),
        )
        return cur.rowcount == 1

    def release(self, job_id: str, owner: str):
        from andromity.core.db import get_conn, init_schema
        init_schema()
        get_conn().execute(
            "UPDATE cron_jobs SET running_since = NULL, lease_owner = NULL WHERE id = ? AND lease_owner = ?",
            (job_id, owner),
        )

    def _write_snapshot(self, crons: List[CronJob]):
        tmp_path = self._path.with_suffix(".json.tmp")
        try:
            payload = []
            for c in crons:
                d = c.to_dict()
                for key in _SNAPSHOT_EXCLUDE:
                    d.pop(key, None)
                payload.append(d)
            tmp_path.write_text(json.dumps({"crons": payload}, indent=2), encoding="utf-8")
            os.replace(tmp_path, self._path)
        except Exception as e:
            log.warning("Failed to save crons JSON snapshot: %s", e)
            if tmp_path.exists():
                tmp_path.unlink()


# ── Run history ────────────────────────────────────────────────────────────

@dataclass
class CronRun:
    """A single execution record for a cron job with full telemetry."""
    id: str
    job_id: str
    job_name: str
    started_at: str
    finished_at: Optional[str] = None
    duration_ms: int = 0
    # "running" | "success" | "needs_attention" | "failed" | "timeout" | "interrupted" | "skipped" | "missed"
    status: str = "running"
    prompt: str = ""
    model: str = ""
    provider: str = ""
    session_id: Optional[str] = None
    output: str = ""                         # full untruncated response
    output_preview: str = ""                 # compact summary
    tool_executions: List[Dict[str, Any]] = field(default_factory=list) # [{tool_name, args, result, status, duration_ms}]
    tools_used: List[str] = field(default_factory=list)
    files_modified: List[str] = field(default_factory=list)
    messages: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None
    error_traceback: Optional[str] = None
    cost_usd: float = 0.0
    error_type: Optional[str] = None
    trigger: str = "schedule"  # "schedule" | "manual" | "catch_up" | "retry"
    scheduled_for: Optional[str] = None
    blocked_tools: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CronRun":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


class CronRunStore:
    """Persists cron run history to SQLite and .andromity/cron_runs/<job_id>/<run_id>.json"""

    def __init__(self, project_path: str):
        self._project_path = str(Path(project_path).resolve())
        self._base = (Path(project_path) / ".andromity" / "cron_runs").resolve()
        self._base.mkdir(parents=True, exist_ok=True)

    def _job_dir(self, job_id: str) -> Path:
        valid_job_id = _validate_cron_id(job_id)
        d = (self._base / valid_job_id).resolve()
        if not d.is_relative_to(self._base.resolve()):
            raise ValueError(f"Path traversal detected for job_id: {job_id!r}")
        d.mkdir(parents=True, exist_ok=True)
        return d

    def sanitize_stale_runs(self, active_run_ids: Optional[set] = None, job_ids: Optional[set] = None):
        """Mark runs still in 'running' state as 'interrupted' if not currently active.

        job_ids limits the sweep to those jobs (jobs whose claim has expired), so a
        run owned by another live process is left alone."""
        active = active_run_ids or set()
        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()
        params: List[Any] = [self._project_path]
        job_filter = ""
        if job_ids is not None:
            if not job_ids:
                return
            job_filter = f" AND job_id IN ({','.join('?' * len(job_ids))})"
            params += list(job_ids)
        active_filter = ""
        if active:
            active_filter = f" AND id NOT IN ({','.join('?' * len(active))})"
            params += list(active)
        try:
            conn.execute(f"""
                UPDATE cron_runs
                SET status = 'interrupted',
                    error = coalesce(error, 'Execution interrupted (app closed or restarted)'),
                    finished_at = coalesce(finished_at, started_at)
                WHERE status = 'running'
                  AND job_id IN (SELECT id FROM cron_jobs WHERE project_path = ?){job_filter}{active_filter}
            """, params)
        except Exception as e:
            log.warning("Failed to sanitize stale runs in SQLite: %s", e)

        if not self._base.exists():
            return
        for f in self._base.glob("*/*.json"):
            try:
                if job_ids is not None and f.parent.name not in job_ids:
                    continue
                data = json.loads(f.read_text(encoding="utf-8"))
                if data.get("status") == "running" and data.get("id") not in active:
                    data["status"] = "interrupted"
                    data["error"] = data.get("error") or "Execution interrupted (app closed or restarted)"
                    data["finished_at"] = data.get("finished_at") or data.get("started_at")
                    f.write_text(json.dumps(data, indent=2), encoding="utf-8")
            except Exception:
                continue

    def save_run(self, run: CronRun):
        _validate_cron_id(run.job_id)
        _validate_cron_id(run.id)
        if not run.output_preview and run.output:
            run.output_preview = run.output[:500]

        from andromity.core.db import get_conn, init_schema, j
        init_schema()
        conn = get_conn()
        try:
            conn.execute("""
                INSERT OR REPLACE INTO cron_runs (
                    id, job_id, job_name, started_at, finished_at,
                    duration_ms, status, prompt, model, provider,
                    session_id, output, output_preview, tools_used,
                    files_modified, tool_executions, error, error_traceback,
                    cost_usd, error_type, trigger, scheduled_for, blocked_tools
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                run.id, run.job_id, run.job_name, run.started_at, run.finished_at,
                run.duration_ms, run.status, run.prompt, run.model, run.provider,
                run.session_id, run.output, run.output_preview,
                j(run.tools_used, default="[]"), j(run.files_modified, default="[]"),
                j(run.tool_executions, default="[]"),
                run.error, run.error_traceback, run.cost_usd,
                run.error_type, run.trigger, run.scheduled_for, j(run.blocked_tools, default="[]"),
            ))
        except Exception as e:
            log.exception("Failed to save cron run %s to SQLite: %s", run.id, e)

        # JSON snapshot
        try:
            path = self._job_dir(run.job_id) / f"{run.id}.json"
            path.write_text(json.dumps(run.to_dict(), indent=2), encoding="utf-8")
        except Exception as e:
            log.warning("Failed to save cron run JSON: %s", e)

    @staticmethod
    def _run_from_row(r) -> CronRun:
        from andromity.core.db import uj
        return CronRun(
            id=r["id"],
            job_id=r["job_id"],
            job_name=r["job_name"],
            started_at=r["started_at"],
            finished_at=r["finished_at"],
            duration_ms=r["duration_ms"],
            status=r["status"],
            prompt=r["prompt"],
            model=r["model"],
            provider=r["provider"],
            session_id=r["session_id"],
            output=r["output"],
            output_preview=r["output_preview"],
            tool_executions=uj(r["tool_executions"], []),
            tools_used=uj(r["tools_used"], []),
            files_modified=uj(r["files_modified"], []),
            error=r["error"],
            error_traceback=r["error_traceback"],
            cost_usd=r["cost_usd"],
            error_type=_row_get(r, "error_type"),
            trigger=_row_get(r, "trigger", "schedule"),
            scheduled_for=_row_get(r, "scheduled_for"),
            blocked_tools=uj(_row_get(r, "blocked_tools", "[]"), []),
        )

    def list_runs(self, job_id: str, limit: int = 50) -> List[CronRun]:
        valid_job_id = _validate_cron_id(job_id)
        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()
        rows = conn.execute("""
            SELECT * FROM cron_runs
            WHERE job_id = ?
            ORDER BY started_at DESC
            LIMIT ?
        """, (valid_job_id, limit)).fetchall()

        runs: List[CronRun] = [self._run_from_row(r) for r in rows]
        known_run_ids = {r.id for r in runs}
        stored_ids = {r["id"] for r in conn.execute("SELECT id FROM cron_runs WHERE job_id = ?", (valid_job_id,))}

        # Fallback / merge with unmigrated JSON runs
        try:
            job_dir = self._base / valid_job_id
            if job_dir.is_dir():
                for f in job_dir.glob("*.json"):
                    if f.stem not in stored_ids and f.stem not in known_run_ids:
                        try:
                            run_obj = CronRun.from_dict(json.loads(f.read_text(encoding="utf-8")))
                            self.save_run(run_obj)  # Auto-migrate
                            runs.append(run_obj)
                            known_run_ids.add(run_obj.id)
                        except Exception:
                            continue
        except Exception:
            pass

        runs.sort(key=lambda r: r.started_at, reverse=True)
        return runs[:limit]

    def get_run(self, job_id: str, run_id: str) -> Optional[CronRun]:
        valid_job_id = _validate_cron_id(job_id)
        valid_run_id = _validate_cron_id(run_id)
        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()
        r = conn.execute(
            "SELECT * FROM cron_runs WHERE id = ? AND job_id = ?",
            (valid_run_id, valid_job_id)
        ).fetchone()
        if r:
            return self._run_from_row(r)
        try:
            path = self._job_dir(valid_job_id) / f"{valid_run_id}.json"
            if path.exists():
                run = CronRun.from_dict(json.loads(path.read_text(encoding="utf-8")))
                self.save_run(run)
                return run
        except Exception:
            pass
        return None

    def delete_run(self, job_id: str, run_id: str) -> bool:
        valid_job_id = _validate_cron_id(job_id)
        valid_run_id = _validate_cron_id(run_id)
        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()
        deleted = False
        try:
            cur = conn.execute(
                "DELETE FROM cron_runs WHERE id = ? AND job_id = ?",
                (valid_run_id, valid_job_id)
            )
            if cur.rowcount > 0:
                deleted = True
        except Exception as e:
            log.warning("Failed to delete cron run from SQLite: %s", e)

        try:
            path = self._job_dir(valid_job_id) / f"{valid_run_id}.json"
            if path.exists():
                path.unlink()
                deleted = True
        except Exception:
            pass
        return deleted

    def prune(self, job_id: str, keep: int = RUN_HISTORY_LIMIT) -> int:
        """Keep the newest `keep` runs of a job; delete older rows and JSON files."""
        valid_job_id = _validate_cron_id(job_id)
        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()
        rows = conn.execute(
            "SELECT id FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?",
            (valid_job_id, keep),
        ).fetchall()
        old_ids = [r["id"] for r in rows]
        if old_ids:
            conn.execute(f"DELETE FROM cron_runs WHERE id IN ({','.join('?' * len(old_ids))})", old_ids)
        job_dir = self._base / valid_job_id
        for run_id in old_ids:
            try:
                (job_dir / f"{run_id}.json").unlink(missing_ok=True)
            except Exception:
                pass
        return len(old_ids)

    def delete_job_history(self, job_id: str):
        valid_job_id = _validate_cron_id(job_id)
        job_dir = (self._base / valid_job_id).resolve()
        if job_dir.is_relative_to(self._base) and job_dir.is_dir():
            shutil.rmtree(job_dir, ignore_errors=True)


# ── Scheduler ──────────────────────────────────────────────────────────────

EDITABLE_FIELDS = (
    "name", "prompt", "schedule", "provider", "model", "mode", "allowed_commands",
    "on_failure", "timeout_seconds", "catch_up", "max_retries", "notify",
)


def normalize_job_fields(changes: Dict[str, Any]) -> Dict[str, Any]:
    """Validate and coerce user-editable job fields. Raises ValueError with a user-facing message."""
    out: Dict[str, Any] = {}
    for key in EDITABLE_FIELDS:
        if key not in changes or changes[key] is None:
            continue
        value = changes[key]
        if key in ("name", "prompt", "provider", "model"):
            value = str(value).strip()
            if key == "prompt" and not value:
                raise ValueError("Enter a prompt for the job.")
            if key == "name" and not value:
                value = "Scheduled Job"
        elif key == "schedule":
            value = str(value).strip()
            parse_schedule(value)
        elif key == "mode":
            value = str(value).strip().lower()
            if value not in PERMISSION_MODES:
                raise ValueError(f"Permission mode must be one of: {', '.join(PERMISSION_MODES)}.")
        elif key == "allowed_commands":
            if isinstance(value, str):
                value = [c.strip() for c in value.split(",") if c.strip()]
            elif isinstance(value, list):
                value = [str(c).strip() for c in value if str(c).strip()]
            else:
                value = []
        elif key == "on_failure":
            value = str(value).strip().lower()
            if value not in ON_FAILURE_POLICIES:
                raise ValueError(f"On failure must be one of: {', '.join(ON_FAILURE_POLICIES)}.")
        elif key == "catch_up":
            value = str(value).strip().lower()
            if value not in CATCH_UP_POLICIES:
                raise ValueError(f"Missed runs must be one of: {', '.join(CATCH_UP_POLICIES)}.")
        elif key == "notify":
            value = str(value).strip().lower()
            if value not in NOTIFY_POLICIES:
                raise ValueError(f"Notify must be one of: {', '.join(NOTIFY_POLICIES)}.")
        elif key == "timeout_seconds":
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise ValueError("Timeout must be a number of seconds.")
            if not 60 <= value <= 86400:
                raise ValueError("Timeout must be between 1 minute and 24 hours.")
        elif key == "max_retries":
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise ValueError("Retries must be a whole number.")
            if not 0 <= value <= 5:
                raise ValueError("Retries must be between 0 and 5.")
        out[key] = value
    return out


class CronScheduler:
    """In-process async cron scheduler. Checks every 10 seconds.

    Several processes (TUI, VS Code windows) can schedule the same project: a run
    only starts after an atomic claim on the job row, so each due run fires once."""

    CHECK_INTERVAL = 10  # seconds

    def __init__(self, project_path: str, on_trigger: Callable[[CronJob], None]):
        self._project_path = project_path
        self._store = CronStore(project_path)
        self._run_store = CronRunStore(project_path)
        self._owner = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self._triggers: Dict[str, Tuple[str, Optional[str]]] = {}
        self._crons: List[CronJob] = self._store.load()
        self._on_trigger = on_trigger
        self._task: Optional[asyncio.Task] = None
        self._persist_missing_next_runs()
        try:
            self._reap_expired_claims(include_unclaimed=True)
        except Exception:
            pass

    @property
    def owner(self) -> str:
        return self._owner

    # ── Public API ─────────────────────────────────────────────────────────

    def start(self):
        if not self._task or self._task.done():
            self._task = asyncio.create_task(self._run_loop())

    def stop(self):
        if self._task and not self._task.done():
            self._task.cancel()

    def reload(self) -> List[CronJob]:
        self._crons = self._store.load()
        self._persist_missing_next_runs()
        return self._crons

    def _persist_missing_next_runs(self):
        now = _utcnow()
        for job in self._crons:
            if job.ensure_next_run(now):
                self._store.upsert(job)

    def get(self, job_id: str) -> Optional[CronJob]:
        return next((c for c in self.reload() if c.id == job_id), None)

    def add(self, name: str, prompt: str, schedule: str, provider: str, model: str,
            mode: str = "trust", allowed_commands: Optional[List[str]] = None,
            on_failure: str = "notify", timeout_seconds: int = 600, enabled: bool = True,
            catch_up: str = "once", max_retries: int = DEFAULT_MAX_RETRIES,
            notify: str = "failures") -> CronJob:
        interval = parse_interval_seconds(schedule)
        now = _utcnow()
        job = CronJob(
            id=str(uuid.uuid4())[:8],
            name=name, prompt=prompt,
            schedule=schedule, interval_seconds=interval,
            provider=provider, model=model,
            mode=mode, allowed_commands=allowed_commands or [],
            on_failure=on_failure,
            timeout_seconds=timeout_seconds,
            enabled=enabled,
            catch_up=catch_up,
            max_retries=max_retries,
            notify=notify,
            created_at=now.isoformat(),
            updated_at=now.isoformat(),
            project_path=self._store._project_path,
        )
        job.reschedule(now)
        self._store.upsert(job)
        self.reload()
        return job

    def update(self, job_id: str, changes: Dict[str, Any]) -> CronJob:
        """Edit a job in place. Its id and run history are kept; changes apply from the next run."""
        job = self.get(job_id)
        if job is None:
            raise ValueError("This scheduled job no longer exists.")
        fields = normalize_job_fields(changes)
        schedule_changed = "schedule" in fields and fields["schedule"] != job.schedule
        for key, value in fields.items():
            setattr(job, key, value)
        if schedule_changed:
            job.interval_seconds = parse_interval_seconds(job.schedule)
            job.reschedule(fresh=True)
        job.updated_at = _utcnow().isoformat()
        self._store.upsert(job)
        self.reload()
        return job

    def duplicate(self, job_id: str) -> CronJob:
        src = self.get(job_id)
        if src is None:
            raise ValueError("This scheduled job no longer exists.")
        return self.add(
            name=f"{src.name} (copy)", prompt=src.prompt, schedule=src.schedule,
            provider=src.provider, model=src.model, mode=src.mode,
            allowed_commands=list(src.allowed_commands), on_failure=src.on_failure,
            timeout_seconds=src.timeout_seconds, enabled=False, catch_up=src.catch_up,
            max_retries=src.max_retries, notify=src.notify,
        )

    def remove(self, job_id: str) -> bool:
        if not any(c.id == job_id for c in self.reload()):
            return False
        deleted = self._store.delete(job_id)
        try:
            self._run_store.delete_job_history(job_id)
        except Exception:
            pass
        self.reload()
        return deleted

    def toggle(self, job_id: str) -> Optional[bool]:
        job = self.get(job_id)
        if job is None:
            return None
        return self.set_enabled(job_id, not job.enabled)

    def set_enabled(self, job_id: str, enabled: bool) -> Optional[bool]:
        job = self.get(job_id)
        if job is None:
            return None
        job.set_enabled(enabled)
        job.updated_at = _utcnow().isoformat()
        self._store.upsert(job)
        self.reload()
        return job.enabled

    def list(self) -> List[CronJob]:
        return list(self.reload())

    def claim(self, job_id: str, trigger: str = "schedule", scheduled_for: Optional[str] = None) -> Optional[CronJob]:
        """Reserve a job for one run. None if it is missing or already running anywhere."""
        job = next((c for c in self._crons if c.id == job_id), None) or self.get(job_id)
        if job is None:
            return None
        now = _utcnow()
        if not self._store.claim(job, self._owner, now):
            return None
        job.running_since = now.isoformat()
        job.lease_owner = self._owner
        self._triggers[job_id] = (trigger, scheduled_for)
        return job

    def release(self, job_id: str):
        self._store.release(job_id, self._owner)
        self._triggers.pop(job_id, None)

    def is_running(self, job_id: str) -> bool:
        job = self.get(job_id)
        return bool(job and job.is_running())

    def run_now(self, job_id: str) -> bool:
        """Trigger a job immediately, bypassing the schedule. False if it is missing or already running."""
        cron = self.claim(job_id, trigger="manual")
        if cron is None:
            return False
        try:
            self._on_trigger(cron)
            return True
        except Exception as e:
            log.error("run_now failed for '%s': %s", job_id, e)
            self.release(job_id)
            return False

    def start_run(self, job_id: str, prompt: str, model: str, provider: str = "",
                  session_id: Optional[str] = None) -> Optional[CronRun]:
        """Create a new run record and return it for tracking."""
        cron = next((c for c in self._crons if c.id == job_id), None) or self.get(job_id)
        if not cron:
            return None
        trigger, scheduled_for = self._triggers.get(job_id, ("schedule", None))
        run = CronRun(
            id=str(uuid.uuid4())[:12],
            job_id=job_id,
            job_name=cron.name,
            started_at=_utcnow().isoformat(),
            prompt=prompt,
            model=model,
            provider=provider or cron.provider,
            session_id=session_id,
            trigger=trigger,
            scheduled_for=scheduled_for,
        )
        self._run_store.save_run(run)
        return run

    def finish_run(self, job_id: str, run: Optional[CronRun], status: str, error: Optional[str] = None,
                   error_type: Optional[str] = None) -> Optional[CronJob]:
        """Record a run's outcome, plan the next run and release the claim."""
        now = _utcnow()
        job = self._store.get(job_id)
        try:
            if job is not None:
                job.apply_result(status, error, error_type, now)
                self._store.upsert(job)
            if run is not None:
                run.status = status
                run.error = error
                run.error_type = error_type
                run.finished_at = now.isoformat()
                try:
                    run.duration_ms = int((now - _parse_iso_utc(run.started_at)).total_seconds() * 1000)
                except Exception:
                    pass
                self._run_store.save_run(run)
                self._run_store.prune(job_id)
        finally:
            self.release(job_id)
            self.reload()
        return job

    def mark_result(self, job_id: str, success: bool, error: Optional[str] = None,
                    run: Optional[CronRun] = None):
        status = "success" if success else ("timeout" if error and "timed out" in error.lower() else "failed")
        self.finish_run(job_id, run, status, error, None if success else ("timeout" if status == "timeout" else "generic"))

    def record_skip(self, job: CronJob, status: str, reason: str, error_type: Optional[str] = None,
                    scheduled_for: Optional[str] = None) -> CronRun:
        """Record a run that did not execute (missed while closed, untrusted, bad folder)."""
        now = _utcnow()
        run = CronRun(
            id=str(uuid.uuid4())[:12], job_id=job.id, job_name=job.name,
            started_at=now.isoformat(), finished_at=now.isoformat(), status=status,
            prompt=job.prompt, model=job.model, provider=job.provider,
            error=reason, error_type=error_type, scheduled_for=scheduled_for,
            trigger=self._triggers.get(job.id, ("schedule", None))[0],
            output_preview=reason,
        )
        self._run_store.save_run(run)
        fresh = self._store.get(job.id) or job
        fresh.apply_result(status, reason, error_type, now)
        self._store.upsert(fresh)
        self._run_store.prune(job.id)
        self.reload()
        return run

    def list_runs(self, job_id: str, limit: int = 50) -> List[CronRun]:
        return self._run_store.list_runs(job_id, limit)

    def get_run(self, job_id: str, run_id: str) -> Optional[CronRun]:
        return self._run_store.get_run(job_id, run_id)

    def delete_run(self, job_id: str, run_id: str) -> bool:
        return self._run_store.delete_run(job_id, run_id)

    # ── Internal ───────────────────────────────────────────────────────────

    def _reap_expired_claims(self, now: Optional[datetime] = None, include_unclaimed: bool = False):
        """Clear claims left by a process that died mid-run and mark its runs interrupted.

        include_unclaimed also sweeps 'running' runs of jobs nobody holds (startup only)."""
        now = now or _utcnow()
        expired = {c.id for c in self._crons if c.running_since and c.claim_expired(now)}
        stale_jobs = set(expired)
        if include_unclaimed:
            stale_jobs |= {c.id for c in self._crons if not c.running_since}
        if expired:
            from andromity.core.db import get_conn
            conn = get_conn()
            for job_id in expired:
                conn.execute(
                    "UPDATE cron_jobs SET running_since = NULL, lease_owner = NULL WHERE id = ? AND running_since IS NOT NULL",
                    (job_id,),
                )
        if stale_jobs:
            self._run_store.sanitize_stale_runs(job_ids=stale_jobs)
        if expired:
            self.reload()

    def tick(self, now: Optional[datetime] = None) -> List[str]:
        """Fire every due job once. Returns the ids handed to the trigger callback."""
        now = now or _utcnow()
        self.reload()
        self._reap_expired_claims(now)
        fired: List[str] = []
        for cron in list(self._crons):
            if cron.is_running(now):
                continue
            decision = cron.due_decision(now)
            if decision is None:
                continue
            scheduled_for = cron.next_run_at
            if decision == "missed":
                when = _format_local(_safe_parse_iso(scheduled_for))
                reason = (f"Missed the run planned for {when} because Andromity was not running. "
                          + ("Catch-up is off for this job." if cron.catch_up == "skip"
                             else "It was more than 24 hours late, so it was skipped."))
                self.record_skip(cron, "missed", reason, None, scheduled_for)
                continue
            problem = project_folder_problem(self._store._project_path)
            if problem:
                self.record_skip(cron, "skipped", problem, "folder", scheduled_for)
                continue
            claimed = self.claim(cron.id, trigger=decision if decision != "run" else "schedule", scheduled_for=scheduled_for)
            if claimed is None:
                continue
            log.info("Cron '%s' is due (%s), triggering", cron.name, decision)
            try:
                self._on_trigger(claimed)
                fired.append(cron.id)
            except Exception as e:
                log.error("Cron trigger failed for '%s': %s", cron.name, e)
                self.release(cron.id)
        return fired

    async def _run_loop(self):
        log.info("Cron scheduler started, checking every %ds", self.CHECK_INTERVAL)
        while True:
            try:
                await asyncio.sleep(self.CHECK_INTERVAL)
                self.tick()
            except asyncio.CancelledError:
                log.info("Cron scheduler stopped")
                break
            except Exception as e:
                log.error("Cron scheduler error: %s", e)
