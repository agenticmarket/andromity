"""Tests for the Plan model (andromity.core.planner)."""
import json
import pytest
from pathlib import Path
from andromity.core.planner import Plan


def test_plan_requires_project_path():
    """Plan.save() must raise ValueError when project_path is empty."""
    p = Plan(title="Test", project_path="")
    with pytest.raises(ValueError, match="project_path"):
        p.save()


def test_plan_save_and_load(tmp_path):
    """Round-trip: save then load recovers all fields."""
    p = Plan(
        title="Add auth",
        description="JWT-based authentication",
        questions=["Which provider?", "Token TTL?"],
        status="pending",
        project_path=str(tmp_path),
    )
    p.save()

    plan_file = tmp_path / ".andromity" / "plan.json"
    assert plan_file.exists(), "plan.json should exist after save()"

    p2 = Plan.load(str(tmp_path))
    assert p2 is not None
    assert p2.title == "Add auth"
    assert p2.description == "JWT-based authentication"
    assert p2.questions == ["Which provider?", "Token TTL?"]
    assert p2.status == "pending"


def test_plan_no_steps_in_serialized_dict(tmp_path):
    """Plan.to_dict() must NOT contain a 'steps' key."""
    p = Plan(title="No steps", project_path=str(tmp_path))
    d = p.to_dict()
    assert "steps" not in d, "steps must not be in Plan dict — use TodoList"


def test_plan_gitignore_added(tmp_path):
    """Saving a plan should add .andromity/ to .gitignore."""
    p = Plan(title="GI test", project_path=str(tmp_path))
    p.save()
    gi = tmp_path / ".gitignore"
    assert gi.exists(), ".gitignore should be created"
    content = gi.read_text()
    assert ".andromity/" in content, ".andromity/ must appear in .gitignore"


def test_plan_gitignore_not_duplicated(tmp_path):
    """Saving plan twice must not add .andromity/ to .gitignore twice."""
    p = Plan(title="Dup test", project_path=str(tmp_path))
    p.save()
    p.save()
    gi = tmp_path / ".gitignore"
    content = gi.read_text()
    assert content.count(".andromity/") == 1, ".andromity/ should only appear once"


def test_plan_gitignore_respects_existing(tmp_path):
    """If .gitignore already has .andromity/, it should not be duplicated."""
    gi = tmp_path / ".gitignore"
    gi.write_text("node_modules/\n.andromity/\n__pycache__/\n")
    p = Plan(title="Already there", project_path=str(tmp_path))
    p.save()
    content = gi.read_text()
    assert content.count(".andromity/") == 1


def test_plan_clear(tmp_path):
    """Plan.clear() should delete the plan.json file."""
    p = Plan(title="To clear", project_path=str(tmp_path))
    p.save()
    assert (tmp_path / ".andromity" / "plan.json").exists()
    Plan.clear(str(tmp_path))
    assert not (tmp_path / ".andromity" / "plan.json").exists()


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
    )
    d = original.to_dict()
    restored = Plan.from_dict(d, "/some/path")
    assert restored.title == original.title
    assert restored.description == original.description
    assert restored.questions == original.questions
    assert restored.status == original.status
    assert restored.project_path == original.project_path
