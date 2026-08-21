"""Cron scheduler — in-process async scheduler backed by .andromity/crons.json."""
import asyncio
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from andromity.core.debug_log import get_logger

log = get_logger("cron")


# ── Cron spec parsing ──────────────────────────────────────────────────────

def parse_interval_seconds(schedule: str) -> int:
    """Parse a human-readable schedule like 'every 30m', 'every 2h', 'every 1d'."""
    import re
    schedule = schedule.strip().lower()
    m = re.match(r"every\s+(\d+)(s|m|h|d)", schedule)
    if not m:
        raise ValueError(f"Invalid schedule: '{schedule}'. Use 'every Ns/Nm/Nh/Nd'.")
    value, unit = int(m.group(1)), m.group(2)
    multiplier = {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
    seconds = value * multiplier
    if seconds < 60:
        raise ValueError("Minimum cron interval is 1 minute (60s).")
    return seconds


# ── Data model ─────────────────────────────────────────────────────────────

@dataclass
class CronJob:
    id: str
    name: str
    prompt: str
    schedule: str          # e.g. "every 30m"
    interval_seconds: int
    provider: str
    model: str
    mode: str              # "safe" | "trust" | "yolo"
    allowed_commands: List[str]
    on_failure: str        # "notify" | "disable" | "retry"
    enabled: bool = True
    timeout_seconds: int = 600  # max wall-clock time per run; 0 = unlimited
    last_run: Optional[str] = None
    last_status: str = "never"   # "never" | "success" | "failed" | "timeout"
    last_error: Optional[str] = None
    run_count: int = 0
    fail_count: int = 0
    retry_count: int = 0

    def is_due(self) -> bool:
        if not self.enabled:
            return False
        if not self.last_run:
            return True
        last = datetime.fromisoformat(self.last_run)
        elapsed = (datetime.now(timezone.utc) - last).total_seconds()
        return elapsed >= self.interval_seconds

    def mark_run(self, success: bool, error: Optional[str] = None):
        self.run_count += 1
        if success:
            self.last_status = "success"
            self.last_error = None
            self.retry_count = 0
            self.last_run = datetime.now(timezone.utc).isoformat()
        else:
            self.last_status = "failed"
            self.last_error = error
            self.fail_count += 1
            if self.on_failure == "retry" and self.retry_count < 3:
                self.retry_count += 1
                # Do not update last_run, so it fires again next tick
            else:
                self.retry_count = 0
                self.last_run = datetime.now(timezone.utc).isoformat()
                
            if self.on_failure == "disable":
                self.enabled = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CronJob":
        return cls(**data)

    def next_run_in(self) -> str:
        """Human-readable time until next run."""
        if not self.last_run:
            return "now"
        last = datetime.fromisoformat(self.last_run)
        elapsed = (datetime.now(timezone.utc) - last).total_seconds()
        remaining = max(0, self.interval_seconds - elapsed)
        if remaining < 60:
            return f"{int(remaining)}s"
        elif remaining < 3600:
            return f"{int(remaining // 60)}m"
        else:
            return f"{int(remaining // 3600)}h {int((remaining % 3600) // 60)}m"


# ── Storage ────────────────────────────────────────────────────────────────

class CronStore:
    def __init__(self, project_path: str):
        self._path = Path(project_path) / ".andromity" / "crons.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> List[CronJob]:
        if not self._path.exists():
            return []
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return [CronJob.from_dict(c) for c in data.get("crons", [])]
        except Exception:
            return []

    def save(self, crons: List[CronJob]):
        import os
        tmp_path = self._path.with_suffix(".json.tmp")
        try:
            tmp_path.write_text(
                json.dumps({"crons": [c.to_dict() for c in crons]}, indent=2),
                encoding="utf-8",
            )
            os.replace(tmp_path, self._path)
        except Exception as e:
            log.error("Failed to save crons: %s", e)
            if tmp_path.exists():
                tmp_path.unlink()


# ── Run history ────────────────────────────────────────────────────────────

@dataclass
class CronRun:
    """A single execution record for a cron job."""
    id: str
    job_id: str
    job_name: str
    started_at: str
    finished_at: Optional[str] = None
    duration_ms: int = 0
    status: str = "running"  # "running" | "success" | "failed"
    prompt: str = ""
    model: str = ""
    messages: List[Dict[str, Any]] = field(default_factory=list)
    tools_used: List[str] = field(default_factory=list)
    files_modified: List[str] = field(default_factory=list)
    error: Optional[str] = None
    output_preview: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CronRun":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


class CronRunStore:
    """Persists cron run history to .andromity/cron_runs/<job_id>/<run_id>.json"""

    def __init__(self, project_path: str):
        self._base = Path(project_path) / ".andromity" / "cron_runs"
        self._base.mkdir(parents=True, exist_ok=True)

    def _job_dir(self, job_id: str) -> Path:
        d = self._base / job_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def save_run(self, run: CronRun):
        path = self._job_dir(run.job_id) / f"{run.id}.json"
        path.write_text(json.dumps(run.to_dict(), indent=2), encoding="utf-8")

    def list_runs(self, job_id: str, limit: int = 50) -> List[CronRun]:
        job_dir = self._job_dir(job_id)
        runs = []
        for f in job_dir.glob("*.json"):
            try:
                runs.append(CronRun.from_dict(json.loads(f.read_text(encoding="utf-8"))))
            except Exception:
                continue
        runs.sort(key=lambda r: r.started_at, reverse=True)
        return runs[:limit]

    def get_run(self, job_id: str, run_id: str) -> Optional[CronRun]:
        path = self._job_dir(job_id) / f"{run_id}.json"
        if path.exists():
            try:
                return CronRun.from_dict(json.loads(path.read_text(encoding="utf-8")))
            except Exception:
                pass
        return None


# ── Scheduler ──────────────────────────────────────────────────────────────

class CronScheduler:
    """In-process async cron scheduler. Checks every 10 seconds."""

    CHECK_INTERVAL = 10  # seconds

    def __init__(self, project_path: str, on_trigger: Callable[[CronJob], None]):
        self._project_path = project_path
        self._store = CronStore(project_path)
        self._run_store = CronRunStore(project_path)
        self._crons: List[CronJob] = self._store.load()
        self._on_trigger = on_trigger
        self._task: Optional[asyncio.Task] = None

    # ── Public API ─────────────────────────────────────────────────────────

    def start(self):
        if not self._task or self._task.done():
            self._task = asyncio.create_task(self._run_loop())

    def stop(self):
        if self._task and not self._task.done():
            self._task.cancel()

    def add(self, name: str, prompt: str, schedule: str, provider: str, model: str,
            mode: str = "trust", allowed_commands: Optional[List[str]] = None,
            on_failure: str = "notify", timeout_seconds: int = 600) -> CronJob:
        interval = parse_interval_seconds(schedule)
        job = CronJob(
            id=str(uuid.uuid4())[:8],
            name=name, prompt=prompt,
            schedule=schedule, interval_seconds=interval,
            provider=provider, model=model,
            mode=mode, allowed_commands=allowed_commands or [],
            on_failure=on_failure,
            timeout_seconds=timeout_seconds,
        )
        self._crons.append(job)
        self._store.save(self._crons)
        return job

    def remove(self, job_id: str) -> bool:
        before = len(self._crons)
        self._crons = [c for c in self._crons if c.id != job_id]
        if len(self._crons) < before:
            self._store.save(self._crons)
            return True
        return False

    def toggle(self, job_id: str) -> Optional[bool]:
        for cron in self._crons:
            if cron.id == job_id:
                cron.enabled = not cron.enabled
                self._store.save(self._crons)
                return cron.enabled
        return None

    def list(self) -> List[CronJob]:
        return list(self._crons)

    def run_now(self, job_id: str) -> bool:
        """Trigger a job immediately, bypassing the schedule. Returns True if
        the job was found and handed to the app's trigger callback."""
        cron = next((c for c in self._crons if c.id == job_id), None)
        if cron is None:
            return False
        try:
            self._on_trigger(cron)
            return True
        except Exception as e:
            log.error("run_now failed for '%s': %s", job_id, e)
            return False

    def mark_result(self, job_id: str, success: bool, error: Optional[str] = None,
                    run: Optional[CronRun] = None):
        for cron in self._crons:
            if cron.id == job_id:
                cron.mark_run(success, error)
                self._store.save(self._crons)
                if run:
                    run.status = "success" if success else "failed"
                    run.error = error
                    run.finished_at = datetime.now(timezone.utc).isoformat()
                    # Calculate duration
                    try:
                        started = datetime.fromisoformat(run.started_at)
                        finished = datetime.fromisoformat(run.finished_at)
                        run.duration_ms = int((finished - started).total_seconds() * 1000)
                    except Exception:
                        pass
                    self._run_store.save_run(run)
                break

    def start_run(self, job_id: str, prompt: str, model: str) -> Optional[CronRun]:
        """Create a new run record and return it for tracking."""
        cron = next((c for c in self._crons if c.id == job_id), None)
        if not cron:
            return None
        run = CronRun(
            id=str(uuid.uuid4())[:12],
            job_id=job_id,
            job_name=cron.name,
            started_at=datetime.now(timezone.utc).isoformat(),
            prompt=prompt,
            model=model,
        )
        self._run_store.save_run(run)
        return run

    def list_runs(self, job_id: str, limit: int = 50) -> List[CronRun]:
        return self._run_store.list_runs(job_id, limit)

    def get_run(self, job_id: str, run_id: str) -> Optional[CronRun]:
        return self._run_store.get_run(job_id, run_id)

    # ── Internal ───────────────────────────────────────────────────────────

    async def _run_loop(self):
        log.info("Cron scheduler started, checking every %ds", self.CHECK_INTERVAL)
        while True:
            try:
                await asyncio.sleep(self.CHECK_INTERVAL)
                for cron in list(self._crons):
                    if cron.is_due():
                        log.info("Cron '%s' is due, triggering", cron.name)
                        try:
                            self._on_trigger(cron)
                        except Exception as e:
                            log.error("Cron trigger failed for '%s': %s", cron.name, e)
            except asyncio.CancelledError:
                log.info("Cron scheduler stopped")
                break
            except Exception as e:
                log.error("Cron scheduler error: %s", e)
