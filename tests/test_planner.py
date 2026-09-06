"""Tests for the Plan model (andromity.core.planner)."""
import json
import pytest
from pathlib import Path
from andromity.core.planner import Plan, get_plans_dir


def test_plan_requires_project_path():
    """Plan.save() must raise ValueError when project_path is empty."""
    p = Plan(title="Test", project_path="")
    with pytest.raises(ValueError, match="project_path"):
        p.save()


def test_plan_save_and_load(tmp_path):
    """Round-trip: save then load recovers all fields from OS storage."""
    p = Plan(
        title="Add auth",
        description="JWT-based authentication",
        questions=["Which provider?", "Token TTL?"],
        status="pending",
        project_path=str(tmp_path),
    )
    p.save()

    assert p.plan_path.exists(), "plan file should exist in OS storage after save()"
    assert not (tmp_path / ".andromity" / "plan.json").exists(), "plan.json must not be written in project root"

    p2 = Plan.load(str(tmp_path))
    assert p2 is not None
    assert p2.title == "Add auth"
    assert p2.description == "JWT-based authentication"
    assert p2.questions == ["Which provider?", "Token TTL?"]
    assert p2.status == "pending"


def test_plan_session_scoped_isolation(tmp_path):
    """Different sessions have isolated plans."""
    p1 = Plan(title="Session 1 Plan", project_path=str(tmp_path), session_id="sess-1")
    p1.save()
    p2 = Plan(title="Session 2 Plan", project_path=str(tmp_path), session_id="sess-2")
    p2.save()

    loaded1 = Plan.load(str(tmp_path), session_id="sess-1")
    loaded2 = Plan.load(str(tmp_path), session_id="sess-2")
    assert loaded1.title == "Session 1 Plan"
    assert loaded2.title == "Session 2 Plan"


def test_plan_no_steps_in_serialized_dict(tmp_path):
    """Plan.to_dict() must NOT contain a 'steps' key."""
    p = Plan(title="No steps", project_path=str(tmp_path))
    d = p.to_dict()
    assert "steps" not in d, "steps must not be in Plan dict — use TodoList or to_enriched_dict"


def test_plan_does_not_pollute_project_folder(tmp_path):
    """Saving a plan must never create or modify files in project .andromity folder."""
    p = Plan(title="Clean test", project_path=str(tmp_path))
    p.save()
    assert not (tmp_path / ".andromity").exists(), "Project .andromity folder must not be created"


def test_plan_clear(tmp_path):
    """Plan.clear() should delete the plan file from OS storage."""
    p = Plan(title="To clear", project_path=str(tmp_path))
    p.save()
    assert p.plan_path.exists()
    Plan.clear(str(tmp_path))
    assert not p.plan_path.exists()


def test_plan_load_missing_returns_none(tmp_path):
    """Plan.load() on non-existent directory returns None gracefully."""
    result = Plan.load(str(tmp_path / "does_not_exist"))
    assert result is None


def test_plan_load_empty_project_path():
    """Plan.load() with empty project_path returns None, never crashes."""
    result = Plan.load("")
    assert result is None


def test_plan_status_transitions(tmp_path):
    """Status can be updated and persisted."""
    p = Plan(title="Status test", project_path=str(tmp_path), status="pending")
    p.save()
    p.status = "approved"
    p.save()
    p2 = Plan.load(str(tmp_path))
    assert p2.status == "approved"


def test_plan_from_dict_roundtrip():
    """from_dict(to_dict()) is a no-op."""
    original = Plan(
        title="Roundtrip",
        description="desc",
        questions=["Q1?"],
        status="rejected",
        project_path="/some/path",
        session_id="sess-xyz",
    )
    d = original.to_dict()
    restored = Plan.from_dict(d, "/some/path")
    assert restored.title == original.title
    assert restored.description == original.description
    assert restored.questions == original.questions
    assert restored.status == original.status
    assert restored.project_path == original.project_path
    assert restored.session_id == original.session_id
