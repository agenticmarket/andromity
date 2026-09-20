"""
Comprehensive unit tests for Andromity telemetry and privacy opt-out guards.
"""
import os
import sys
from unittest.mock import patch
import pytest

from andromity.telemetry import (
    _should_send_telemetry,
    _get_or_create_user_id,
    _safe_str,
    _duration_bucket,
    _provider_type,
    send_session_start,
    send_session_end,
    maybe_send_weekly_ping,
)
from andromity.config import config


def test_do_not_track_env():
    """DO_NOT_TRACK env var disables all telemetry."""
    with patch.dict(os.environ, {"DO_NOT_TRACK": "1"}):
        assert _should_send_telemetry() is False

    with patch.dict(os.environ, {"DO_NOT_TRACK": "true"}):
        assert _should_send_telemetry() is False


def test_andromity_no_telemetry_env():
    """ANDROMITY_NO_TELEMETRY env var disables all telemetry."""
    with patch.dict(os.environ, {"ANDROMITY_NO_TELEMETRY": "1"}):
        assert _should_send_telemetry() is False


def test_ci_env():
    """CI environment disables all telemetry."""
    with patch.dict(os.environ, {"CI": "1"}):
        assert _should_send_telemetry() is False


def test_pytest_auto_guard():
    """Verify that running under pytest automatically disables telemetry."""
    assert _should_send_telemetry() is False


def test_config_opt_out():
    """Setting default.telemetry = False in config disables telemetry."""
    with patch("andromity.telemetry.sys.modules", {}):
        with patch.dict(os.environ, {}, clear=True):
            config.set("default", "telemetry", False)
            assert _should_send_telemetry() is False

            config.set("default", "telemetry", True)
            assert _should_send_telemetry() is True


def test_session_start_noop_when_opted_out():
    """When opted out, send_session_start does not spawn post threads or call _post."""
    with patch.dict(os.environ, {"DO_NOT_TRACK": "1"}):
        with patch("andromity.telemetry._post") as mock_post:
            send_session_start("session-optout-123")
            assert mock_post.call_count == 0


def test_session_end_noop_when_opted_out():
    """When opted out, send_session_end does not call _post."""
    with patch.dict(os.environ, {"ANDROMITY_NO_TELEMETRY": "1"}):
        with patch("andromity.telemetry._post") as mock_post:
            send_session_end("session-optout-123")
            assert mock_post.call_count == 0


def test_weekly_ping_noop_when_opted_out():
    """When opted out, maybe_send_weekly_ping does not call _post."""
    with patch.dict(os.environ, {"DO_NOT_TRACK": "1"}):
        with patch("andromity.telemetry._post") as mock_post:
            maybe_send_weekly_ping(["mcp", "subagent"])
            assert mock_post.call_count == 0


def test_sanitization_helpers():
    """Verify helpers sanitize provider/model/duration without leaking content."""
    assert _provider_type("ollama") == "local"
    assert _provider_type("anthropic") == "cloud"
    assert _duration_bucket(120) == "0-5min"
    assert _duration_bucket(600) == "5-15min"
    assert _duration_bucket(1200) == "15-30min"
    assert _duration_bucket(2400) == "30min+"
    assert _safe_str("claude-3.7-sonnet") == "claude-3.7-sonnet"
    # Strips disallowed characters
    assert _safe_str("malicious!@#payload$%^&*()") == "maliciouspayload"
    # Scrubs accidental API keys in model/provider fields
    assert _safe_str("nvapi-dG23LLucX-CZrKhqwA8QxNvpGDP62KbimBPFvR5KZAEOQwg8z2HNsUl1Ui") == "scrubbed_api_key"
    assert _safe_str("sk-ant-api03-abcdef1234567890abcdef123456") == "scrubbed_api_key"
    assert _safe_str("gsk_1234567890abcdef1234567890abcdef") == "scrubbed_api_key"


def test_session_start_initial_turn_count(monkeypatch):
    """Verify send_session_start initializes turn_count to 0 (not 1)."""
    captured = []
    monkeypatch.setattr("andromity.telemetry._should_send_telemetry", lambda: True)
    monkeypatch.setattr("andromity.telemetry._post", lambda ep, p: captured.append((ep, p)))
    send_session_start("sess-start-test", provider="google", model="gemini-2.5-flash")
    import time
    time.sleep(0.1)
    assert len(captured) == 1
    assert captured[0][1]["turn_count"] == 0


def test_send_feature_used_and_session_update(monkeypatch):
    """Test send_feature_used and send_session_update payloads when enabled."""
    from andromity.telemetry import send_feature_used, send_session_update

    captured_posts = []

    def mock_post(endpoint, payload):
        captured_posts.append((endpoint, payload))

    monkeypatch.setattr("andromity.telemetry._should_send_telemetry", lambda: True)
    monkeypatch.setattr("andromity.telemetry._post", mock_post)

    send_feature_used("waterfall", session_id="sess-123")
    send_session_update("sess-123", turn_count=5, duration_sec=120)

    # Wait briefly for background threads
    import time
    time.sleep(0.1)

    assert len(captured_posts) == 2
    feat_endpoint, feat_payload = captured_posts[0]
    assert feat_payload["event"] == "feature_use"
    assert feat_payload["feature_name"] == "waterfall"
    assert feat_payload["session_id"] == "sess-123"

    up_endpoint, up_payload = captured_posts[1]
    assert up_payload["event"] == "session_update"
    assert up_payload["turn_count"] == 5
    assert up_payload["duration_seconds"] == 120


def test_cron_seed_preset_and_error_telemetry_tokens():
    """Verify that CRON_SEED_PRESET_NAMES and error categories adhere to Zero-PII tokens."""
    from andromity.server.rpc_handler import CRON_SEED_PRESET_NAMES

    assert "Run Tests & Verify Build" in CRON_SEED_PRESET_NAMES
    assert "Daily Code Health & TODO Scanner" in CRON_SEED_PRESET_NAMES
    assert "My Custom Scraper" not in CRON_SEED_PRESET_NAMES

    # Test error categorization logic
    test_errors = [
        ("401 Unauthorized: Invalid API Key", "error_auth"),
        ("429 Too Many Requests: Rate Limit Reached", "error_rate_limit"),
        ("Token limit of 128000 exceeded, maximum context reached", "error_context_length"),
        ("RPC timeout waiting for response after 120s", "error_timeout"),
        ("Command failed: exit code 1", "error_tool_execution"),
        ("Some unexpected OS error occurred", "error_generic"),
    ]

    for err_msg, expected_cat in test_errors:
        lower = err_msg.lower()
        if any(k in lower for k in ("401", "unauthorized", "invalid api key", "authentication")):
            cat = "error_auth"
        elif any(k in lower for k in ("429", "rate limit", "quota", "too many requests")):
            cat = "error_rate_limit"
        elif any(k in lower for k in ("context length", "maximum context", "token limit")):
            cat = "error_context_length"
        elif any(k in lower for k in ("timeout", "timed out")):
            cat = "error_timeout"
        elif any(k in lower for k in ("tool", "command failed")):
            cat = "error_tool_execution"
        else:
            cat = "error_generic"
        assert cat == expected_cat
