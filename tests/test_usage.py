from andromity.core.usage import normalize_usage


def test_normalize_openai_usage_details():
    usage = normalize_usage({
        "prompt_tokens": 100,
        "completion_tokens": 40,
        "total_tokens": 140,
        "prompt_tokens_details": {"cached_tokens": 25},
        "completion_tokens_details": {"reasoning_tokens": 10},
    })
    assert usage == {
        "prompt_tokens": 100,
        "completion_tokens": 40,
        "total_tokens": 140,
        "cached_tokens": 25,
        "reasoning_tokens": 10,
        "usage_source": "provider",
    }


def test_normalize_gemini_usage_metadata():
    usage = normalize_usage({
        "promptTokenCount": 100,
        "candidatesTokenCount": 20,
        "thoughtsTokenCount": 30,
        "cachedContentTokenCount": 15,
        "totalTokenCount": 150,
    })
    assert usage["prompt_tokens"] == 100
    assert usage["completion_tokens"] == 20
    assert usage["reasoning_tokens"] == 30
    assert usage["cached_tokens"] == 15
    assert usage["total_tokens"] == 150


def test_normalize_reconstructs_missing_total():
    usage = normalize_usage({"input_tokens": 12, "output_tokens": 8})
    assert usage["total_tokens"] == 20


def test_free_models_cost_zero_in_pricing():
    from andromity.core.pricing import calculate_cost

    res1 = calculate_cost({"prompt_tokens": 1000, "completion_tokens": 500}, "openrouter", "dots-studio/dots-3-note-preview:free")
    assert res1.usd == 0.0
    assert res1.source == "free"

    res2 = calculate_cost({"prompt_tokens": 2000, "completion_tokens": 1000}, "ollama", "llama3:latest")
    assert res2.usd == 0.0
    assert res2.source == "free"

    res3 = calculate_cost({"prompt_tokens": 500, "completion_tokens": 200}, "openrouter", "nvidia/nemotron-3.5-lightning:free")
    assert res3.usd == 0.0
    assert res3.source == "free"


def test_usage_tracker_free_models_and_unmodeled_sessions(tmp_path, monkeypatch):
    import json
    from andromity.core.usage_tracker import UsageTracker
    from andromity.config import config

    cfg_dir = tmp_path / "cfg"
    sessions_dir = cfg_dir / "sessions" / "proj1"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "config_dir", cfg_dir)
    monkeypatch.setattr(config, "config_path", cfg_dir / "config.toml")
    monkeypatch.setattr("andromity.core.usage_tracker.get_config_dir", lambda: cfg_dir)
    monkeypatch.setattr("andromity.config.get_config_dir", lambda: cfg_dir)

    # Set current active config model to a free model
    config.set("default", "provider", "openrouter")
    config.set("default", "model", "dots-studio/dots-3-note-preview:free")

    # Session 1: Free model with 10k tokens
    s1 = {
        "id": "s1", "name": "Free Chat", "provider": "openrouter",
        "model": "dots-studio/dots-3-note-preview:free", "token_total": 10000,
        "cost_usd": 0.0, "created_at": "2026-08-20T10:00:00Z", "updated_at": "2026-08-20T10:00:00Z"
    }
    (sessions_dir / "s1.json").write_text(json.dumps(s1), encoding="utf-8")

    # Session 2: Old session without model/provider saved, but had non-zero cost (e.g. legacy claude test)
    s2 = {
        "id": "s2", "name": "Legacy Chat", "token_total": 5000,
        "cost_usd": 0.05, "created_at": "2026-08-20T11:00:00Z", "updated_at": "2026-08-20T11:00:00Z"
    }
    (sessions_dir / "s2.json").write_text(json.dumps(s2), encoding="utf-8")

    tracker = UsageTracker()
    summary = tracker.get_summary("all")

    assert summary.total_sessions == 2
    assert summary.total_tokens == 15000
    assert summary.total_cost_usd == 0.05

    # Free model MUST have $0.00 cost and only its own tokens
    free_stats = summary.by_model["dots-studio/dots-3-note-preview:free"]
    assert free_stats["tokens"] == 10000
    assert free_stats["cost"] == 0.0
    assert free_stats["sessions"] == 1

    # Legacy unmodeled session MUST be categorized as unknown, NOT free model
    unknown_stats = summary.by_model["unknown"]
    assert unknown_stats["tokens"] == 5000
    assert unknown_stats["cost"] == 0.05
    assert unknown_stats["sessions"] == 1


import pytest
from textual.app import App, ComposeResult
from textual.widgets import ContentSwitcher


@pytest.mark.asyncio
async def test_settings_usage_tab_ui(tmp_path, monkeypatch):
    import json
    from andromity.tui.overlays.settings import SettingsScreen
    from andromity.config import config
    from textual.widgets import Button, Label

    cfg_dir = tmp_path / "cfg"
    sessions_dir = cfg_dir / "sessions" / "proj1"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "config_dir", cfg_dir)
    monkeypatch.setattr(config, "config_path", cfg_dir / "config.toml")
    monkeypatch.setattr("andromity.core.usage_tracker.get_config_dir", lambda: cfg_dir)
    monkeypatch.setattr("andromity.config.get_config_dir", lambda: cfg_dir)

    s1 = {
        "id": "s1", "name": "Free Chat", "provider": "openrouter",
        "model": "dots-studio/dots-3-note-preview:free", "token_total": 10000,
        "cost_usd": 0.0, "created_at": "2026-08-20T10:00:00Z", "updated_at": "2026-08-20T10:00:00Z"
    }
    (sessions_dir / "s1.json").write_text(json.dumps(s1), encoding="utf-8")

    class TestApp(App):
        def compose(self) -> ComposeResult:
            yield Label("Root")

    app = TestApp()
    async with app.run_test() as pilot:
        screen = SettingsScreen()
        await app.push_screen(screen)
        await pilot.pause()

        # Switch to Usage pane
        screen.query_one("#settings-content", ContentSwitcher).current = "pane-usage"
        await pilot.pause()

        # Check tab buttons are composed
        today_btn = screen.query_one("#usage-tab-today", Button)
        all_btn = screen.query_one("#usage-tab-all", Button)
        assert today_btn is not None
        assert all_btn is not None

        # Click Today tab
        today_btn.press()
        await pilot.pause()
        assert "active" in today_btn.classes

        # Check metric toggle buttons
        metric_cost = screen.query_one("#usage-metric-cost", Button)
        metric_tokens = screen.query_one("#usage-metric-tokens", Button)
        assert metric_cost is not None
        assert metric_tokens is not None

        # Switch to By Tokens metric
        metric_tokens.press()
        await pilot.pause()
        assert "active" in metric_tokens.classes
        assert "active" not in metric_cost.classes
        assert screen._usage_metric == "tokens"

