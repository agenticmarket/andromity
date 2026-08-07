"""Cron scheduler — in-process async scheduler backed by .andromity/crons.json."""
import asyncio
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


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
    last_run: Optional[str] = None
    last_status: str = "never"   # "never" | "success" | "failed"
    last_error: Optional[str] = None
    run_count: int = 0
    fail_count: int = 0

    def is_due(self) -> bool:
        if not self.enabled:
            return False
        if not self.last_run:
            return True
        last = datetime.fromisoformat(self.last_run)
        elapsed = (datetime.now(timezone.utc) - last).total_seconds()
        return elapsed >= self.interval_seconds

    def mark_run(self, success: bool, error: Optional[str] = None):
        self.last_run = datetime.now(timezone.utc).isoformat()
        self.run_count += 1
        if success:
            self.last_status = "success"
            self.last_error = None
        else:
            self.last_status = "failed"
            self.last_error = error
            self.fail_count += 1
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
        self._path.write_text(
            json.dumps({"crons": [c.to_dict() for c in crons]}, indent=2),
            encoding="utf-8",
        )


# ── Scheduler ──────────────────────────────────────────────────────────────

class CronScheduler:
    """In-process async cron scheduler. Checks every 10 seconds."""

    CHECK_INTERVAL = 10  # seconds

    def __init__(self, project_path: str, on_trigger: Callable[[CronJob], None]):
        self._project_path = project_path
        self._store = CronStore(project_path)
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
            on_failure: str = "notify") -> CronJob:
        interval = parse_interval_seconds(schedule)
        job = CronJob(
            id=str(uuid.uuid4())[:8],
            name=name, prompt=prompt,
            schedule=schedule, interval_seconds=interval,
            provider=provider, model=model,
            mode=mode, allowed_commands=allowed_commands or [],
            on_failure=on_failure,
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

    def mark_result(self, job_id: str, success: bool, error: Optional[str] = None):
        for cron in self._crons:
            if cron.id == job_id:
                cron.mark_run(success, error)
                self._store.save(self._crons)
                break

    # ── Internal ───────────────────────────────────────────────────────────

    async def _run_loop(self):
        while True:
            try:
                await asyncio.sleep(self.CHECK_INTERVAL)
                for cron in list(self._crons):
                    if cron.is_due():
                        self._on_trigger(cron)
            except asyncio.CancelledError:
                break
            except Exception:
                pass  # Never crash the scheduler loop
