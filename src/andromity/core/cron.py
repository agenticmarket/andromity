"""Cron scheduler — in-process async scheduler backed by .andromity/crons.json."""
import asyncio
import json
import re
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


def _parse_iso_utc(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ── Data model ─────────────────────────────────────────────────────────────

@dataclass
class CronJob:
    id: str
    name: str
    prompt: str
    schedule: str = "every 1h"          # e.g. "every 30m"
    interval_seconds: int = 3600
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    mode: str = "trust"              # "safe" | "trust" | "yolo"
    allowed_commands: List[str] = field(default_factory=list)
    on_failure: str = "retry"        # "notify" | "disable" | "retry"
    retry_delay_seconds: int = 0
    timeout_seconds: int = 600  # max wall-clock time per run; 0 = unlimited
    enabled: bool = True
    project_path: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    last_run: Optional[str] = None
    last_status: str = "never"   # "never" | "success" | "failed" | "timeout" | "interrupted"
    last_error: Optional[str] = None
    run_count: int = 0
    fail_count: int = 0
    retry_count: int = 0

    def is_due(self) -> bool:
        if not self.enabled:
            return False
        if not self.last_run:
            return True
        last = _parse_iso_utc(self.last_run)
        elapsed = (datetime.now(timezone.utc) - last).total_seconds()
        required_interval = self.retry_delay_seconds if (self.retry_count > 0 and self.retry_delay_seconds > 0) else self.interval_seconds
        return elapsed >= required_interval

    def mark_run(self, success: bool, error: Optional[str] = None):
        self.run_count += 1
        if success:
            self.last_status = "success"
            self.last_error = None
            self.retry_count = 0
            self.retry_delay_seconds = 0
            self.last_run = datetime.now(timezone.utc).isoformat()
        else:
            self.last_status = "failed"
            self.last_error = error
            self.fail_count += 1
            if self.on_failure == "retry" and self.retry_count < 3:
                self.retry_count += 1
                backoffs = [60, 120, 300]
                self.retry_delay_seconds = backoffs[min(self.retry_count - 1, len(backoffs) - 1)]
                self.last_run = datetime.now(timezone.utc).isoformat()
            else:
                self.retry_count = 0
                self.retry_delay_seconds = 0
                self.last_run = datetime.now(timezone.utc).isoformat()
                
            if self.on_failure == "disable":
                self.enabled = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CronJob":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    def next_run_in(self) -> str:
        """Human-readable time until next run."""
        if not self.last_run:
            return "now"
        last = _parse_iso_utc(self.last_run)
        elapsed = (datetime.now(timezone.utc) - last).total_seconds()
        interval = self.retry_delay_seconds if (self.retry_count > 0 and self.retry_delay_seconds > 0) else self.interval_seconds
        remaining = max(0, interval - elapsed)
        if remaining <= 0:
            return "now"
        if remaining < 60:
            return f"{int(remaining)}s"
        elif remaining < 3600:
            return f"{int(remaining // 60)}m"
        else:
            return f"{int(remaining // 3600)}h {int((remaining % 3600) // 60)}m"


_CRON_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")


def _validate_cron_id(id_str: str) -> str:
    """Validate that a cron job or run ID is a safe identifier without path traversal."""
    if not id_str or not _CRON_ID_RE.match(str(id_str)):
        raise ValueError(f"Invalid cron identifier: {id_str!r}")
    return str(id_str)


# ── Storage ────────────────────────────────────────────────────────────────

class CronStore:
    def __init__(self, project_path: str):
        self._project_path = str(Path(project_path).resolve())
        self._path = Path(project_path) / ".andromity" / "crons.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> List[CronJob]:
        from andromity.core.db import get_conn, init_schema, uj
        init_schema()
        conn = get_conn()
        rows = conn.execute(
            "SELECT * FROM cron_jobs WHERE project_path = ? ORDER BY created_at ASC",
            (self._project_path,)
        ).fetchall()
        
        jobs: List[CronJob] = []
        known_ids = set()
        if rows:
            for r in rows:
                c_job = CronJob(
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
                )
                jobs.append(c_job)
                known_ids.add(c_job.id)

        # Also check JSON file for any unmigrated jobs
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
                unmigrated = []
                for c_dict in data.get("crons", []):
                    c_obj = CronJob.from_dict(c_dict)
                    if c_obj.id not in known_ids:
                        unmigrated.append(c_obj)
                        jobs.append(c_obj)
                        known_ids.add(c_obj.id)
                if unmigrated:
                    self.save(jobs)  # Auto-migrate missing jobs to SQLite
            except Exception:
                pass

        return jobs

    def save(self, crons: List[CronJob]):
        import os
        from andromity.core.db import get_conn, init_schema, j, transaction
        init_schema()
        conn = get_conn()
        current_ids = {c.id for c in crons}
        try:
            with transaction(conn):
                # 1. Delete only jobs removed from this project (preserves run history for retained jobs)
                existing_rows = conn.execute(
                    "SELECT id FROM cron_jobs WHERE project_path = ?", (self._project_path,)
                ).fetchall()
                existing_ids = {r["id"] for r in existing_rows}
                removed_ids = existing_ids - current_ids
                if removed_ids:
                    placeholders = ",".join("?" * len(removed_ids))
                    conn.execute(
                        f"DELETE FROM cron_jobs WHERE id IN ({placeholders})", list(removed_ids)
                    )

                # 2. Upsert current jobs
                for c in crons:
                    c.project_path = self._project_path
                    conn.execute("""
                        INSERT OR REPLACE INTO cron_jobs (
                            id, project_path, name, prompt, schedule,
                            interval_seconds, provider, model, mode,
                            allowed_commands, on_failure, retry_delay_seconds,
                            timeout_seconds, enabled, last_run, last_status,
                            last_error, run_count, fail_count, retry_count,
                            created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        c.id, self._project_path, c.name, c.prompt, c.schedule,
                        c.interval_seconds, c.provider, c.model, c.mode,
                        j(c.allowed_commands, default="[]"), c.on_failure, c.retry_delay_seconds,
                        c.timeout_seconds, 1 if c.enabled else 0, c.last_run,
                        c.last_status, c.last_error, c.run_count, c.fail_count,
                        c.retry_count, c.created_at
                    ))
        except Exception as e:
            log.exception("Failed to save crons to SQLite: %s", e)

        # Atomic write JSON snapshot
        tmp_path = self._path.with_suffix(".json.tmp")
        try:
            tmp_path.write_text(
                json.dumps({"crons": [c.to_dict() for c in crons]}, indent=2),
                encoding="utf-8",
            )
            os.replace(tmp_path, self._path)
        except Exception as e:
            log.warning("Failed to save crons JSON snapshot: %s", e)
            log.error("Failed to save crons JSON: %s", e)
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
    status: str = "running"  # "running" | "success" | "failed" | "timeout" | "interrupted"
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

    def sanitize_stale_runs(self, active_run_ids: Optional[set] = None):
        """Mark any runs still in 'running' state as 'interrupted' if not currently active."""
        active = active_run_ids or set()
        from andromity.core.db import get_conn, init_schema
        init_schema()
        conn = get_conn()
        try:
            if active:
                placeholders = ",".join("?" * len(active))
                conn.execute(f"""
                    UPDATE cron_runs
                    SET status = 'interrupted',
                        error = coalesce(error, 'Execution interrupted (app closed or restarted)'),
                        finished_at = coalesce(finished_at, started_at)
                    WHERE status = 'running'
                      AND job_id IN (SELECT id FROM cron_jobs WHERE project_path = ?)
                      AND id NOT IN ({placeholders})
                """, [self._project_path] + list(active))
            else:
                conn.execute("""
                    UPDATE cron_runs
                    SET status = 'interrupted',
                        error = coalesce(error, 'Execution interrupted (app closed or restarted)'),
                        finished_at = coalesce(finished_at, started_at)
                    WHERE status = 'running'
                      AND job_id IN (SELECT id FROM cron_jobs WHERE project_path = ?)
                """, (self._project_path,))
        except Exception as e:
            log.warning("Failed to sanitize stale runs in SQLite: %s", e)

        if not self._base.exists():
            return
        for f in self._base.glob("*/*.json"):
            try:
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
                    cost_usd
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                run.id, run.job_id, run.job_name, run.started_at, run.finished_at,
                run.duration_ms, run.status, run.prompt, run.model, run.provider,
                run.session_id, run.output, run.output_preview,
                j(run.tools_used, default="[]"), j(run.files_modified, default="[]"),
                j(run.tool_executions, default="[]"),
                run.error, run.error_traceback, run.cost_usd
            ))
        except Exception as e:
            log.exception("Failed to save cron run %s to SQLite: %s", run.id, e)

        # JSON snapshot
        try:
            path = self._job_dir(run.job_id) / f"{run.id}.json"
            path.write_text(json.dumps(run.to_dict(), indent=2), encoding="utf-8")
        except Exception as e:
            log.warning("Failed to save cron run JSON: %s", e)

    def list_runs(self, job_id: str, limit: int = 50) -> List[CronRun]:
        valid_job_id = _validate_cron_id(job_id)
        from andromity.core.db import get_conn, init_schema, uj
        init_schema()
        conn = get_conn()
        rows = conn.execute("""
            SELECT * FROM cron_runs 
            WHERE job_id = ? 
            ORDER BY started_at DESC 
            LIMIT ?
        """, (valid_job_id, limit)).fetchall()
        
        runs: List[CronRun] = []
        known_run_ids = set()
        if rows:
            for r in rows:
                c_run = CronRun(
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
                )
                runs.append(c_run)
                known_run_ids.add(c_run.id)

        # Fallback / merge with unmigrated JSON runs
        try:
            job_dir = self._job_dir(valid_job_id)
            for f in job_dir.glob("*.json"):
                stem = f.stem
                if stem not in known_run_ids:
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
        from andromity.core.db import get_conn, init_schema, uj
        init_schema()
        conn = get_conn()
        r = conn.execute(
            "SELECT * FROM cron_runs WHERE id = ? AND job_id = ?",
            (valid_run_id, valid_job_id)
        ).fetchone()
        if r:
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
            )
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
        try:
            self._run_store.sanitize_stale_runs()
        except Exception:
            pass

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
                    run.status = "success" if success else ("timeout" if error and "timed out" in error.lower() else "failed")
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

    def start_run(self, job_id: str, prompt: str, model: str, provider: str = "", session_id: Optional[str] = None) -> Optional[CronRun]:
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
            provider=provider or cron.provider,
            session_id=session_id,
        )
        self._run_store.save_run(run)
        return run

    def list_runs(self, job_id: str, limit: int = 50) -> List[CronRun]:
        return self._run_store.list_runs(job_id, limit)

    def get_run(self, job_id: str, run_id: str) -> Optional[CronRun]:
        return self._run_store.get_run(job_id, run_id)

    def delete_run(self, job_id: str, run_id: str) -> bool:
        return self._run_store.delete_run(job_id, run_id)

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
