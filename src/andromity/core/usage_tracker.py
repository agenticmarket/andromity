from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Literal
from andromity.core.debug_log import get_logger

log = get_logger("usage_tracker")

TimeRange = Literal["today", "week", "month", "all"]

@dataclass
class SessionStat:
    session_id: str
    name: str
    provider: str
    model: str
    tokens: int
    cost_usd: float
    created_at: str
    updated_at: str
    project_path: str

@dataclass  
class UsageSummary:
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    total_sessions: int = 0
    sessions: list[SessionStat] = field(default_factory=list)
    by_model: dict[str, dict] = field(default_factory=dict)    # model → {tokens, cost, count, provider}
    by_provider: dict[str, dict] = field(default_factory=dict) # provider → {tokens, cost, count}
    daily_activity: dict[str, dict] = field(default_factory=dict) # YYYY-MM-DD → {tokens, cost, count}

class UsageTracker:
    """Aggregates persisted session usage from SQLite."""

    def get_summary(self, time_range: TimeRange = "all",
                    project_path: str | None = None) -> UsageSummary:
        sessions = self._load_sessions_from_db(project_path)

        cutoff = self._cutoff(time_range)
        summary = UsageSummary()

        for s in sessions:
            if not project_path and self._is_test_or_temp_session(s.project_path, s.name):
                continue
            session_time = s.updated_at or s.created_at
            if cutoff and session_time and session_time < cutoff:
                continue
            summary.total_sessions += 1
            summary.total_tokens += s.tokens
            summary.total_cost_usd += s.cost_usd
            summary.sessions.append(s)
            
            # Aggregate daily activity
            day = (s.updated_at or s.created_at or "")[:10]
            if day:
                if day not in summary.daily_activity:
                    summary.daily_activity[day] = {"tokens": 0, "cost": 0.0, "count": 0}
                summary.daily_activity[day]["tokens"] += s.tokens
                summary.daily_activity[day]["cost"]   += s.cost_usd
                summary.daily_activity[day]["count"]  += 1

            # Aggregate per-model
            m = s.model or "unknown"
            if m not in summary.by_model:
                summary.by_model[m] = {"tokens": 0, "cost": 0.0, "sessions": 0, "provider": s.provider}
            summary.by_model[m]["tokens"] += s.tokens
            summary.by_model[m]["cost"]   += s.cost_usd
            summary.by_model[m]["sessions"] += 1
            
            # Aggregate per-provider
            p = s.provider or "unknown"
            if p not in summary.by_provider:
                summary.by_provider[p] = {"tokens": 0, "cost": 0.0, "sessions": 0}
            summary.by_provider[p]["tokens"] += s.tokens
            summary.by_provider[p]["cost"]   += s.cost_usd
            summary.by_provider[p]["sessions"] += 1

        # Sort sessions newest-first
        summary.sessions.sort(key=lambda x: x.updated_at, reverse=True)
        return summary

    def _cutoff(self, time_range: TimeRange) -> str | None:
        now = datetime.now(timezone.utc)
        if time_range == "today":
            return (now - timedelta(days=1)).isoformat()
        if time_range == "week":
            return (now - timedelta(weeks=1)).isoformat()
        if time_range == "month":
            return (now - timedelta(days=30)).isoformat()
        return None  # all time

    def _load_sessions_from_db(self, project_path: str | None) -> list[SessionStat]:
        try:
            from andromity.core.db import get_conn, init_schema
            init_schema()
            from andromity.core.session_migration import migrate_legacy_sessions
            migrate_legacy_sessions()
            conn = get_conn()
            if project_path:
                from andromity.core.session import normalize_project_path
                import hashlib
                from pathlib import Path
                norm = normalize_project_path(project_path)
                p_hash = hashlib.sha256(norm.encode()).hexdigest()[:16]
                hashes_to_check = {p_hash}
                raw_s = str(project_path)
                hashes_to_check.add(hashlib.sha256(raw_s.encode()).hexdigest()[:16])
                hashes_to_check.add(hashlib.sha256(raw_s.lower().encode()).hexdigest()[:16])
                hashes_to_check.add(hashlib.sha256(Path(project_path).resolve().as_posix().encode()).hexdigest()[:16])
                placeholders = ",".join("?" * len(hashes_to_check))
                rows = conn.execute(f"""
                    SELECT id, name, provider, model, token_total, cost_usd, created_at, updated_at, project_path
                    FROM sessions
                    WHERE project_hash IN ({placeholders})
                """, list(hashes_to_check)).fetchall()
            else:
                rows = conn.execute("""
                    SELECT id, name, provider, model, token_total, cost_usd, created_at, updated_at, project_path
                    FROM sessions
                """).fetchall()

            if rows:
                stats = []
                for r in rows:
                    provider = (r["provider"] or "").strip() or "unknown"
                    model = (r["model"] or "").strip() or "unknown"
                    cost_usd = float(r["cost_usd"] or 0.0)
                    if ":free" in model.lower() or provider.lower() in ("ollama", "local"):
                        cost_usd = 0.0
                    stats.append(SessionStat(
                        session_id=r["id"],
                        name=r["name"] or "Unnamed",
                        provider=provider,
                        model=model,
                        tokens=int(r["token_total"] or 0),
                        cost_usd=cost_usd,
                        created_at=r["created_at"] or "",
                        updated_at=r["updated_at"] or "",
                        project_path=r["project_path"] or "",
                    ))
                return stats
        except Exception:
            log.warning("Could not load usage history from SQLite. Please retry.")
        return []

    @staticmethod
    def _is_test_or_temp_session(project_path: str | None, name: str | None = None) -> bool:
        if not project_path:
            return False
        p = project_path.lower().replace("\\", "/")
        if "/pytest-of-" in p or "/temp/pytest" in p or "/tmp/pytest" in p:
            return True
        if "/appdata/local/temp" in p or "/tmp/tmp" in p:
            return True
        return False
