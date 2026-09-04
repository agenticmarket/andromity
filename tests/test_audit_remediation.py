"""Comprehensive tests for dual-write consistency, security hardening, and audit remediation."""
import json
import os
import tempfile
from pathlib import Path
import pytest
from andromity.config import ConfigManager
from andromity.core.cron import (
    CronJob,
    CronRun,
    CronRunStore,
    CronStore,
    _validate_cron_id,
)
from andromity.core.db import (
    close_conn,
    get_conn,
    init_schema,
    j,
    set_custom_db_path,
    transaction,
    uj,
)
from andromity.core.session import Session, normalize_project_path
from andromity.core.tools import _shell_invocation
from andromity.core.usage_tracker import UsageTracker
from andromity.server.rpc_handler import JsonRpcHandler


@pytest.fixture(autouse=True)
def isolated_env(tmp_path):
    db_file = tmp_path / "test_remediation.db"
    set_custom_db_path(db_file)
    init_schema()
    yield tmp_path
    set_custom_db_path(None)
    close_conn()



def test_nested_transaction_reentrancy():
    """Verify that nested transaction() blocks do not crash SQLite."""
    conn = get_conn()
    with transaction(conn):
        conn.execute(
            "INSERT INTO sessions (id, project_hash, project_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("s_nested_1", "h1", "/proj", "Root Tx", "idle", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
        )
        # Nested transaction block
        with transaction(conn):
            conn.execute(
                "INSERT INTO sessions (id, project_hash, project_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("s_nested_2", "h1", "/proj", "Nested Tx", "idle", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
            )

    row1 = conn.execute("SELECT * FROM sessions WHERE id = 's_nested_1'").fetchone()
    row2 = conn.execute("SELECT * FROM sessions WHERE id = 's_nested_2'").fetchone()
    assert row1 is not None
    assert row2 is not None


def test_j_and_uj_type_safety():
    """Verify serialization handles None and defaults without type distortion."""
    assert j(None) is None
    assert j(None, default="[]") == "[]"
    assert j(["cmd1", "cmd2"]) == '["cmd1","cmd2"]'
    assert uj(None, default=[]) == []
    assert uj("", default=[]) == []
    assert uj("null", default=[]) == []
    assert uj('["git","npm"]', default=[]) == ["git", "npm"]
    assert uj('{"a":1}', default={}) == {"a": 1}


def test_session_set_status_dual_write(isolated_env, monkeypatch):
    """Verify set_status updates both SQLite and the JSON file snapshot."""
    monkeypatch.setattr("andromity.core.session.get_config_dir", lambda: isolated_env)
    project_dir = str(isolated_env / "status_proj")
    s = Session(name="Status Test", project_path=project_dir)
    s.save()

    s.set_status("running")
    s.flush()

    # 1. Verify in DB
    conn = get_conn()
    row = conn.execute("SELECT status FROM sessions WHERE id = ?", (s.id,)).fetchone()
    assert row is not None
    assert row["status"] == "running"

    # 2. Verify on disk JSON
    assert s.file_path.exists()
    disk_data = json.loads(s.file_path.read_text(encoding="utf-8"))
    assert disk_data["status"] == "running"


def test_session_list_merges_unmigrated_json(isolated_env, monkeypatch):
    """Verify list_sessions returns both existing DB sessions and unmigrated JSON files."""
    monkeypatch.setattr("andromity.core.session.get_config_dir", lambda: isolated_env)
    project_dir = str(isolated_env / "merge_proj")
    import hashlib
    norm = normalize_project_path(project_dir)
    p_hash = hashlib.sha256(norm.encode()).hexdigest()[:16]

    # Create session 1 directly in DB
    s1 = Session(name="DB Session", project_path=project_dir)
    s1.save()

    # Create session 2 solely on disk (simulating unmigrated legacy session)
    sess_dir = isolated_env / "sessions" / p_hash
    sess_dir.mkdir(parents=True, exist_ok=True)
    json_path = sess_dir / "unmigrated_sess.json"
    json_path.write_text(json.dumps({
        "id": "unmigrated_sess",
        "name": "Disk Session",
        "project": p_hash,
        "project_path": norm,
        "created_at": "2026-01-01T12:00:00Z",
        "updated_at": "2026-01-01T12:00:00Z",
        "messages": [],
    }), encoding="utf-8")

    all_sessions = Session.list_sessions(project_dir)
    session_ids = {s.id for s in all_sessions}
    assert s1.id in session_ids
    assert "unmigrated_sess" in session_ids


def test_load_by_id_idor_prevention(isolated_env, monkeypatch):
    """Verify load_by_id does not return sessions from another project when project_path is supplied."""
    monkeypatch.setattr("andromity.core.session.get_config_dir", lambda: isolated_env)
    proj_a = str(isolated_env / "proj_a")
    proj_b = str(isolated_env / "proj_b")

    sess_a = Session(name="Project A Session", project_path=proj_a)
    sess_a.save()

    # Attempting to load Session A while scoped to Project B must return None
    loaded = Session.load_by_id(sess_a.id, project_path=proj_b)
    assert loaded is None

    # Scoped to Project A must succeed
    loaded_correct = Session.load_by_id(sess_a.id, project_path=proj_a)
    assert loaded_correct is not None
    assert loaded_correct.id == sess_a.id


def test_cron_store_safe_differential_save(isolated_env):
    """Verify CronStore.save does not wipe all jobs and keeps run history intact."""
    project_dir = str(isolated_env / "cron_save_proj")
    store = CronStore(project_dir)

    job1 = CronJob(id="job_keep", project_path=project_dir, name="Job 1", prompt="p1", schedule="every 1h", interval_seconds=3600)
    job2 = CronJob(id="job_remove", project_path=project_dir, name="Job 2", prompt="p2", schedule="every 2h", interval_seconds=7200)

    store.save([job1, job2])
    assert len(store.load()) == 2

    # Save only job1
    store.save([job1])
    loaded = store.load()
    assert len(loaded) == 1
    assert loaded[0].id == "job_keep"


def test_cron_path_traversal_validation(isolated_env):
    """Verify CronRunStore rejects malicious path traversal IDs."""
    run_store = CronRunStore(str(isolated_env / "cron_run_proj"))

    with pytest.raises(ValueError):
        _validate_cron_id("../../etc/passwd")

    with pytest.raises(ValueError):
        run_store._job_dir("../../malicious")


def test_cron_sanitize_scoped_to_project(isolated_env):
    """Verify sanitize_stale_runs only affects jobs belonging to the target project."""
    proj_a = str(isolated_env / "proj_a")
    proj_b = str(isolated_env / "proj_b")

    store_a = CronStore(proj_a)
    store_b = CronStore(proj_b)

    job_a = CronJob(id="job_a", project_path=proj_a, name="Job A", prompt="p", schedule="1h", interval_seconds=3600)
    job_b = CronJob(id="job_b", project_path=proj_b, name="Job B", prompt="p", schedule="1h", interval_seconds=3600)
    store_a.save([job_a])
    store_b.save([job_b])

    run_store_a = CronRunStore(proj_a)
    run_store_b = CronRunStore(proj_b)

    run_a = CronRun(id="run_a", job_id="job_a", job_name="Job A", started_at="2026-01-01T00:00:00Z", status="running")
    run_b = CronRun(id="run_b", job_id="job_b", job_name="Job B", started_at="2026-01-01T00:00:00Z", status="running")
    run_store_a.save_run(run_a)
    run_store_b.save_run(run_b)

    # Sanitize project A only
    run_store_a.sanitize_stale_runs()

    # Run A should be interrupted, but Run B must remain untouched
    updated_a = run_store_a.get_run("job_a", "run_a")
    updated_b = run_store_b.get_run("job_b", "run_b")
    assert updated_a.status == "interrupted"
    assert updated_b.status == "running"


@pytest.mark.asyncio
async def test_rpc_session_delete_cleans_db_and_json(isolated_env, monkeypatch):
    """Verify rpc_session_delete purges SQLite records and removes JSON files without traversal risk."""
    monkeypatch.setattr("andromity.core.session.get_config_dir", lambda: isolated_env)
    monkeypatch.setattr("andromity.server.rpc_handler.get_config_dir", lambda: isolated_env)
    project_dir = str(isolated_env / "rpc_proj")

    s = Session(name="To Delete", project_path=project_dir)
    s.save()

    conn = get_conn()
    assert conn.execute("SELECT * FROM sessions WHERE id = ?", (s.id,)).fetchone() is not None
    assert s.file_path.exists()

    handler = JsonRpcHandler()
    res = await handler.rpc_session_delete({"session_id": s.id})
    assert res["success"] is True

    # Check both DB and disk
    assert conn.execute("SELECT * FROM sessions WHERE id = ?", (s.id,)).fetchone() is None
    assert not s.file_path.exists()

    # Traversal attempt must be rejected
    with pytest.raises(ValueError):
        await handler.rpc_session_delete({"session_id": "../../etc/passwd"})


def test_powershell_no_profile_flag():
    """Verify PowerShell invocation includes -NoProfile and -NonInteractive."""
    inv = _shell_invocation("powershell.exe", "Get-Process")
    assert "-NoProfile" in inv
    assert "-NonInteractive" in inv
    assert "-Command" in inv


def test_config_atomic_save(isolated_env):
    """Verify ConfigManager.save saves atomically without leaving temp files."""
    cfg_file = isolated_env / "config.toml"
    cfg = ConfigManager(cfg_file)
    cfg.set("general", "theme", "nord")

    assert cfg_file.exists()
    assert not cfg_file.with_suffix(".tmp").exists()
    assert cfg.get("general", "theme") == "nord"


@pytest.mark.asyncio
async def test_compaction_error_handling_logger_defined(isolated_env, monkeypatch):
    """Verify Agent._compact_context handles summarization stream exceptions cleanly without NameError."""
    from andromity.core.agent import Agent

    monkeypatch.setattr("andromity.core.session.get_config_dir", lambda: isolated_env)

    async def _failing_stream(*args, **kwargs):
        raise RuntimeError("LLM connection timeout during summarization")
        yield  # make it a generator

    monkeypatch.setattr("andromity.core.agent.stream_completion", _failing_stream)

    s = Session(name="Compaction Test", project_path=str(isolated_env))
    for i in range(10):
        s.add_message("user", f"Question {i}")
        s.add_message("assistant", f"Answer {i}")

    agent = Agent(session=s)
    events = [e async for e in agent._compact_context(force=True)]

    # Must yield error text without raising NameError for undefined logger
    error_events = [e for e in events if "Context compaction failed" in getattr(e, "text", "")]
    assert len(error_events) > 0
    assert "LLM connection timeout" in error_events[0].text

