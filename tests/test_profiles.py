"""Tests for profiles."""
from andromity.core.profiles import get_system_prompt, get_allowed_tools, filter_tools_for_profile


def test_builder_profile():
    assert "Builder" in get_system_prompt("builder")


def test_builder_prompt_includes_professional_execution_rules():
    prompt = get_system_prompt("builder")
    for rule in (
        "Behave as a professional",
        "Begin with evidence",
        "smallest coherent change",
        "dummy actions",
        "Never claim that code was changed",
    ):
        assert rule in prompt


def test_reviewer_profile():
    assert "Reviewer" in get_system_prompt("reviewer") and "READ-ONLY" in get_system_prompt("reviewer")


def test_planner_profile():
    assert "Planner" in get_system_prompt("planner")


def test_unknown_defaults_to_builder():
    assert "Builder" in get_system_prompt("unknown")


def test_builder_allowed_tools():
    tools = get_allowed_tools("builder")
    assert all(t in tools for t in ["read_file", "write_file", "edit_file", "shell_exec", "list_dir", "write_plan"])


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


def test_coder_allowed_tools():
    tools = get_allowed_tools("coder")
    assert all(t in tools for t in ["read_file", "write_file", "edit_file", "shell_exec", "list_dir"])
    assert "write_plan" not in tools  # coder doesn't plan


def _with_co_author_setting(monkeypatch, value):
    from andromity.core import profiles

    original_get = profiles.config.get

    def fake_get(section, key, default=None, fallback=None):
        if (section, key) == ("default", "include_co_author"):
            return value
        return original_get(section, key, default, fallback)

    monkeypatch.setattr(profiles.config, "get", fake_get)


def test_prompt_requests_co_author_trailer_by_default(monkeypatch):
    from andromity.core.profiles import CO_AUTHOR_TRAILER

    _with_co_author_setting(monkeypatch, True)
    assert CO_AUTHOR_TRAILER == "Co-authored-by: Andromity <333054755+andromity-bot@users.noreply.github.com>"
    assert CO_AUTHOR_TRAILER in get_system_prompt("builder")


def test_prompt_omits_co_author_trailer_when_disabled(monkeypatch):
    _with_co_author_setting(monkeypatch, False)
    prompt = get_system_prompt("builder")
    assert "Co-authored-by" not in prompt
    assert "NEVER commit changes or push to git unless explicitly instructed by the user.\n- Never log" in prompt


def test_slash_profile_accepts_every_registered_profile():
    """Regression: /profile parser must accept every key in PROFILES (coder was missing)."""
    from andromity.core.profiles import PROFILES

    for name in PROFILES:
        assert name in ("builder", "coder", "reviewer", "planner", "benchmark"), name
        assert get_system_prompt(name)  # every registered profile has a prompt
