"""Tests for profiles."""
from andromity.core.profiles import get_system_prompt, get_allowed_tools, filter_tools_for_profile


def test_builder_profile():
    assert "Builder" in get_system_prompt("builder")


def test_reviewer_profile():
    assert "Reviewer" in get_system_prompt("reviewer") and "READ-ONLY" in get_system_prompt("reviewer")


def test_planner_profile():
    assert "Planner" in get_system_prompt("planner")


def test_unknown_defaults_to_builder():
    assert "Builder" in get_system_prompt("unknown")


def test_builder_allowed_tools():
    tools = get_allowed_tools("builder")
    assert all(t in tools for t in ["read_file", "write_file", "edit_file", "shell_exec", "list_dir"])
    assert all(t in tools for t in ["create_todo", "update_todo", "list_todos"])


def test_reviewer_allowed_tools():
    tools = get_allowed_tools("reviewer")
    assert "read_file" in tools and "write_file" not in tools


def test_planner_allowed_tools():
    assert "write_file" not in get_allowed_tools("planner")


def test_filter_tools():
    all_tools = [{"function": {"name": n}} for n in ["read_file", "write_file", "edit_file", "list_dir"]]
    filtered = filter_tools_for_profile(all_tools, "reviewer")
    names = [t["function"]["name"] for t in filtered]
    assert "read_file" in names and "write_file" not in names


def test_coder_has_todo_tools():
    tools = get_allowed_tools("coder")
    assert all(t in tools for t in ["create_todo", "update_todo", "list_todos"])
    assert "write_plan" not in tools  # coder doesn't plan


def test_slash_profile_accepts_every_registered_profile():
    """Regression: /profile parser must accept every key in PROFILES (coder was missing)."""
    from andromity.core.profiles import PROFILES

    for name in PROFILES:
        assert name in ("builder", "coder", "reviewer", "planner"), name
        assert get_system_prompt(name)  # every registered profile has a prompt
