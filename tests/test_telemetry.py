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
