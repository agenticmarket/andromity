"""A session left "running" by an engine that died mid-turn shows as interrupted."""
import json
import subprocess
import sys
import textwrap
from datetime import datetime, timedelta, timezone

import pytest

from andromity.core import run_owner
from andromity.core.db import close_conn, get_conn, init_schema, set_custom_db_path
from andromity.core.session import LEGACY_LIVE_GRACE, Session, get_all_sessions, resolve_live_status


@pytest.fixture(autouse=True)
def isolated_db(tmp_path):
    db_file = tmp_path / "run_owner.db"
    set_custom_db_path(db_file)
    init_schema()
    yield db_file
    set_custom_db_path(None)
    close_conn()


CHILD_ENGINE = textwrap.dedent("""
    import sys, time
    from pathlib import Path
    from andromity.core.db import init_schema, set_custom_db_path
    from andromity.core.session import Session
    set_custom_db_path(Path(sys.argv[1]))
    init_schema()
    s = Session(name="child run", project_path=sys.argv[2], session_id=sys.argv[3])
    s.save()
    s.set_status("running")
    print("ready", flush=True)
    time.sleep(120)
""")


def _start_child_engine(db_file, project, session_id):
    child = subprocess.Popen(
        [sys.executable, "-c", CHILD_ENGINE, str(db_file), project, session_id],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    line = child.stdout.readline().strip()
    if line != "ready":
        child.kill()
        pytest.fail(f"child engine did not start: {child.stderr.read()}")
    return child


def _write_row(session_id, *, status, updated_at, metadata):
    conn = get_conn()
    conn.execute(
        "UPDATE sessions SET status = ?, updated_at = ?, session_metadata = ? WHERE id = ?",
        (status, updated_at, json.dumps(metadata), session_id),
    )
    conn.commit()


def test_running_session_records_this_engine_as_owner_and_clears_it_when_done(tmp_path):
    s = Session(name="owned", project_path=str(tmp_path))
    s.save()
    s.set_status("running")
    assert s.run_owner == run_owner.current_owner_id()

    loaded = Session.load_by_id(s.id, str(tmp_path))
    assert loaded.status == "running", "this engine is alive, so its own run stays running"
    assert loaded.run_owner == s.run_owner

    s.set_status("idle")
    assert s.run_owner is None
    meta = json.loads(get_conn().execute("SELECT session_metadata FROM sessions WHERE id = ?", (s.id,)).fetchone()[0])
    assert meta["run_owner"] is None


def test_run_owned_by_another_live_engine_stays_running_until_that_engine_is_killed(isolated_db, tmp_path):
    session_id = "cross-window-run"
    child = _start_child_engine(isolated_db, str(tmp_path), session_id)
    try:
        seen = Session.load_by_id(session_id, str(tmp_path))
        assert seen.status == "running", "another window's live run must not be shown as interrupted"
        owner = seen.run_owner
        assert owner and owner != run_owner.current_owner_id()
        assert run_owner.is_owner_alive(owner)
    finally:
        child.kill()
        child.wait(timeout=30)
        child.stdout.close()
        child.stderr.close()

    after = Session.load_by_id(session_id, str(tmp_path))
    assert after.status == "interrupted"
    assert after.run_owner is None
    assert not (run_owner._owners_dir() / f"{owner}.lock").exists(), "the dead owner's lock file is cleaned up"
    assert [x.status for x in get_all_sessions(str(tmp_path)) if x.id == session_id] == ["interrupted"]


@pytest.mark.parametrize("status", ["running", "compacting", "approval_required"])
def test_live_status_with_an_unknown_owner_is_interrupted(tmp_path, status):
    s = Session(name="gone", project_path=str(tmp_path))
    s.save()
    _write_row(s.id, status=status, updated_at=datetime.now(timezone.utc).isoformat(),
               metadata={"run_owner": "0" * 32})
    assert Session.load_by_id(s.id, str(tmp_path)).status == "interrupted"


def test_rows_from_older_versions_only_count_as_interrupted_after_a_long_silence(tmp_path):
    old = Session(name="legacy stuck", project_path=str(tmp_path))
    old.save()
    _write_row(old.id, status="running",
               updated_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat(), metadata={})
    recent = Session(name="legacy live", project_path=str(tmp_path))
    recent.save()
    _write_row(recent.id, status="running",
               updated_at=(datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat(), metadata={})

    assert Session.load_by_id(old.id, str(tmp_path)).status == "interrupted"
    assert Session.load_by_id(recent.id, str(tmp_path)).status == "running", \
        "an older engine in another window may still be on this run"


@pytest.mark.parametrize("status", ["idle", "cancelled", "error", "watching", "paused_limit_reached", "interrupted"])
def test_settled_statuses_are_never_rewritten(status):
    long_ago = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    assert resolve_live_status(status, None, long_ago) == status
    assert resolve_live_status(status, "0" * 32, long_ago) == status


def test_legacy_grace_boundary_and_unreadable_timestamps():
    now = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)
    just_inside = (now - LEGACY_LIVE_GRACE + timedelta(seconds=1)).isoformat()
    just_outside = (now - LEGACY_LIVE_GRACE - timedelta(seconds=1)).isoformat()
    assert resolve_live_status("running", None, just_inside, now=now) == "running"
    assert resolve_live_status("running", None, just_outside, now=now) == "interrupted"
    assert resolve_live_status("running", None, "2026-10-18T10:00:00", now=now) == "interrupted", "naive times are UTC"
    assert resolve_live_status("running", None, None, now=now) == "running"
    assert resolve_live_status("running", None, "not a date", now=now) == "running"


def test_owner_ids_cannot_point_outside_the_owner_folder(tmp_path):
    outside = tmp_path / "outside.lock"
    outside.write_text("x")
    assert run_owner.is_owner_alive("../outside") is False
    assert run_owner.is_owner_alive("") is False
    assert run_owner.is_owner_alive(None) is False
    assert outside.exists()


def test_owner_lock_follows_the_config_folder(tmp_path, monkeypatch):
    first = run_owner.current_owner_id()
    assert first and run_owner.current_owner_id() == first
    monkeypatch.setenv("ANDROMITY_CONFIG_DIR", str(tmp_path / "other_config"))
    second = run_owner.current_owner_id()
    assert second and second != first
    assert (tmp_path / "other_config" / "run_owners" / f"{second}.lock").exists()


def test_interrupted_session_can_run_again(tmp_path):
    s = Session(name="resume", project_path=str(tmp_path))
    s.save()
    _write_row(s.id, status="running", updated_at=datetime.now(timezone.utc).isoformat(),
               metadata={"run_owner": "f" * 32})
    loaded = Session.load_by_id(s.id, str(tmp_path))
    assert loaded.status == "interrupted"
    loaded.set_status("running")
    assert Session.load_by_id(s.id, str(tmp_path)).status == "running"
    loaded.set_status("idle")
    assert Session.load_by_id(s.id, str(tmp_path)).status == "idle"
