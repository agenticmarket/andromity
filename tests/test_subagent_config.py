import pytest
from andromity.core.subagent_config import SubAgentConfigManager, DEFAULT_SUBAGENT_ROLES
from andromity.config import config


def test_default_subagent_roles():
    for role in ["search", "coder", "reviewer", "analyst", "general"]:
        cfg = SubAgentConfigManager.get_role_config(role)
        assert cfg.name == role
        assert len(cfg.tools) > 0
        assert cfg.system_prompt is not None


def test_fallback_custom_role():
    cfg = SubAgentConfigManager.get_role_config("custom_tester")
    assert cfg.name == "custom_tester"
    assert "read_file" in cfg.tools


def test_config_subagent_settings():
    max_c = SubAgentConfigManager.get_max_concurrent()
    assert isinstance(max_c, int)
    assert max_c > 0

    timeout = SubAgentConfigManager.get_default_timeout()
    assert isinstance(timeout, float)
    assert timeout > 0

    max_tokens = SubAgentConfigManager.get_result_max_tokens()
    assert isinstance(max_tokens, int)
    assert max_tokens >= 100


def test_set_and_get_subagent_role():
    config.set_subagent_role(
        role_name="fast_searcher",
        model="gemini-2.5-flash",
        provider="google",
        tools=["web_search", "fetch_url"],
        description="Fast search role"
    )
    role_cfg = SubAgentConfigManager.get_role_config("fast_searcher")
    assert role_cfg.name == "fast_searcher"
    assert role_cfg.model == "gemini-2.5-flash"
    assert role_cfg.provider == "google"
    assert role_cfg.tools == ["web_search", "fetch_url"]
