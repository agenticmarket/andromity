from __future__ import annotations
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Literal
from andromity.config import get_config_dir

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

class UsageTracker:
    """Aggregates usage data from all persisted session JSON files."""

    def get_summary(self, time_range: TimeRange = "all",
                    project_path: str | None = None) -> UsageSummary:
        sessions = self._load_sessions(project_path)
        cutoff = self._cutoff(time_range)
        summary = UsageSummary()

        for s in sessions:
            if cutoff and s.created_at < cutoff:
                continue
            summary.total_sessions += 1
            summary.total_tokens += s.tokens
            summary.total_cost_usd += s.cost_usd
            summary.sessions.append(s)
            
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

    def _load_sessions(self, project_path: str | None) -> list[SessionStat]:
        sessions_root = get_config_dir() / "sessions"
        if not sessions_root.exists():
            return []
        stats: list[SessionStat] = []
        if project_path:
            import hashlib
            p_hash = hashlib.sha256(project_path.encode()).hexdigest()[:16]
            target = sessions_root / p_hash
            dirs = [target] if target.exists() else []
        else:
            dirs = [d for d in sessions_root.iterdir() if d.is_dir()]
        for d in dirs:
            if not d.is_dir():
                continue
            for f in d.glob("*.json"):
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                    provider = (data.get("provider") or "").strip() or "unknown"
                    model = (data.get("model") or "").strip() or "unknown"
                    tokens = int(data.get("token_total", 0) or 0)
                    cost_usd = float(data.get("cost_usd", 0.0) or 0.0)

                    # Free models (":free" suffix) and local providers (ollama/local) cost strictly $0.00
                    if ":free" in model.lower() or provider.lower() in ("ollama", "local"):
                        cost_usd = 0.0

                    stats.append(SessionStat(
                        session_id=data.get("id", f.stem),
                        name=data.get("name", "Unnamed"),
                        provider=provider,
                        model=model,
                        tokens=tokens,
                        cost_usd=cost_usd,
                        created_at=data.get("created_at", ""),
                        updated_at=data.get("updated_at", ""),
                        project_path=data.get("project_path", ""),
                    ))
                except Exception:
                    continue
        return stats
