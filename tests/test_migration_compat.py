"""Tests for backward compatibility and auto-migration from JSON to SQLite."""
import json
import tempfile
from pathlib import Path
import pytest
from andromity.core.cron import CronJob, CronRun, CronRunStore, CronStore
from andromity.core.db import close_conn, get_conn, init_schema, set_custom_db_path
from andromity.core.session import Session, normalize_project_path
from andromity.core.usage_tracker import UsageTracker


@pytest.fixture(autouse=True)
def isolated_env(tmp_path):
    db_file = tmp_path / "compat_andromity.db"
    set_custom_db_path(db_file)
    init_schema()
    yield tmp_path
    set_custom_db_path(None)
    close_conn()



def test_legacy_session_json_auto_migrates(isolated_env, monkeypatch):
    """Verify that old JSON session files created in previous versions are loaded and imported to SQLite transparently."""
    sessions_root = isolated_env / "sessions"
    monkeypatch.setattr("andromity.core.session.get_config_dir", lambda: isolated_env)
    monkeypatch.setattr("andromity.core.usage_tracker.get_config_dir", lambda: isolated_env)

    project_dir = str(isolated_env / "my_project")
    import hashlib
    norm_path = normalize_project_path(project_dir)
    p_hash = hashlib.sha256(norm_path.encode()).hexdigest()[:16]
    project_sess_dir = sessions_root / p_hash
    project_sess_dir.mkdir(parents=True, exist_ok=True)

    legacy_session_id = "legacy-session-123"
    legacy_data = {
        "id": legacy_session_id,
        "name": "Old Legacy Chat",
        "project": p_hash,
        "project_path": norm_path,
        "created_at": "2025-12-01T10:00:00Z",
        "updated_at": "2025-12-01T10:30:00Z",
        "messages": [
            {"role": "user", "content": "What is Python?", "ts": "2025-12-01T10:00:01Z"},
            {"role": "assistant", "content": "Python is a programming language.", "thinking": "Let's explain simply.", "ts": "2025-12-01T10:00:05Z"},
            {"role": "tool", "content": "file contents", "name": "read_file", "tool_call_id": "call_1", "ts": "2025-12-01T10:00:10Z"},
        ],
        "token_total": 450,
        "context_tokens": 120,
        "cost_usd": 0.0035,
        "cost_source": "pricing_table",
        "usage_breakdown": {"prompt_tokens": 300, "completion_tokens": 150, "cached_tokens": 0, "reasoning_tokens": 50},
        "provider": "anthropic",
        "model": "claude-3-7-sonnet",
        "plan": {"title": "Learn Python", "steps": ["Read docs", "Write code"]},
        "compacted_history": [],
    }

    json_file = project_sess_dir / f"{legacy_session_id}.json"
    json_file.write_text(json.dumps(legacy_data), encoding="utf-8")

    # 1. Load by ID — must find JSON and migrate to SQLite
    loaded = Session.load_by_id(legacy_session_id, project_dir)
    assert loaded is not None
    assert loaded.id == legacy_session_id
    assert loaded.name == "Old Legacy Chat"
    assert len(loaded.messages) == 3
    assert loaded.messages[1]["thinking"] == "Let's explain simply."
    assert loaded.messages[2]["name"] == "read_file"
    assert loaded.token_total == 450
    assert loaded.cost_usd == 0.0035
    assert loaded.plan["title"] == "Learn Python"

    # 2. Verify it is now present in SQLite database
    conn = get_conn()
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (legacy_session_id,)).fetchone()
    assert row is not None
    assert row["name"] == "Old Legacy Chat"
    assert row["status"] == "idle"

    # 3. Verify messages are in session_messages table
    msg_rows = conn.execute("SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC", (legacy_session_id,)).fetchall()
    assert len(msg_rows) == 3
    assert msg_rows[0]["role"] == "user"
    assert msg_rows[1]["role"] == "assistant"
    assert msg_rows[1]["thinking"] == "Let's explain simply."
    assert msg_rows[2]["name"] == "read_file"


def test_cron_json_auto_migrates(isolated_env):
    """Verify legacy crons.json and cron_runs auto-migrate to SQLite."""
    project_dir = isolated_env / "cron_project"
    andromity_dir = project_dir / ".andromity"
    andromity_dir.mkdir(parents=True, exist_ok=True)

    crons_json = andromity_dir / "crons.json"
    crons_json.write_text(json.dumps({
        "crons": [
            {
                "id": "job_1",
                "name": "Nightly Build",
                "prompt": "Run tests",
                "schedule": "every 24h",
                "interval_seconds": 86400,
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "mode": "trust",
                "enabled": True,
                "created_at": "2026-01-01T00:00:00Z",
            }
        ]
    }), encoding="utf-8")

    store = CronStore(str(project_dir))
    jobs = store.load()
    assert len(jobs) == 1
    assert jobs[0].name == "Nightly Build"

    # Verify present in SQLite
    conn = get_conn()
    row = conn.execute("SELECT * FROM cron_jobs WHERE id = 'job_1'").fetchone()
    assert row is not None
    assert row["name"] == "Nightly Build"


def test_usage_tracker_aggregates_from_sqlite(isolated_env, monkeypatch):
    """Verify UsageTracker reads migrated SQLite sessions quickly."""
    monkeypatch.setattr("andromity.core.session.get_config_dir", lambda: isolated_env)
    project_dir = str(isolated_env / "usage_proj")

    s1 = Session(name="Chat 1", project_path=project_dir)
    s1.update_usage({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}, model="anthropic/claude-3-5-sonnet")
    s1.save()

    s2 = Session(name="Chat 2", project_path=project_dir)
    s2.update_usage({"prompt_tokens": 200, "completion_tokens": 100, "total_tokens": 300}, model="openai/gpt-4o")
    s2.save()

    tracker = UsageTracker()
    summary = tracker.get_summary(time_range="all", project_path=project_dir)
    assert summary.total_sessions == 2
    assert summary.total_tokens == 450
    assert summary.total_cost_usd > 0
