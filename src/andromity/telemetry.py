"""
Andromity anonymous telemetry — privacy-safe, opt-out at any time.

What is collected:
  - A random anonymous UUID (never linked to identity)
  - Client type (vscode / tui / cli / server)
  - OS family (windows / darwin / linux)
  - App version
  - Provider name (e.g. "anthropic") — equivalent to reporting browser name
  - Model name (e.g. "claude-sonnet-5") — not content, just model id
  - Whether local or cloud inference is used
  - Reasoning effort setting (off / low / medium / high)
  - Number of MCP tools enabled at session start (integer count only)
  - Session end: turn count, had_error (bool), duration bucket, coarse tool counts

What is NEVER collected:
  - Prompts, code, file contents, file paths, API keys
  - Precise IP addresses (Cloudflare resolves country server-side, IP not stored)
  - Machine fingerprint, hostname, username

Opt-out:
  - Set env var  DO_NOT_TRACK=1  or  ANDROMITY_NO_TELEMETRY=1
  - Or toggle "Anonymous Telemetry" off in settings
"""
from __future__ import annotations

import json
import os
import platform
import re
import sys
import threading
import time
import uuid
from typing import Optional

from andromity import __version__
from andromity.config import get_config_dir, config

_PING_ENDPOINT  = "https://telemetry.agenticmarket.dev/ping"
_EVENT_ENDPOINT = "https://telemetry.agenticmarket.dev/event"

_tracked_sessions: set[str] = set()
_lock = threading.Lock()

# ─────────────────────────────────────────────────────────────────────
# Guard
# ─────────────────────────────────────────────────────────────────────

def _should_send_telemetry() -> bool:
    if os.environ.get("DO_NOT_TRACK") in ("1", "true", "True", "TRUE"):
        return False
    if os.environ.get("ANDROMITY_NO_TELEMETRY") in ("1", "true", "True", "TRUE"):
        return False
    return bool(config.get("default", "telemetry", True))


# ─────────────────────────────────────────────────────────────────────
# Anonymous user identity
# ─────────────────────────────────────────────────────────────────────

def _get_or_create_user_id() -> str:
    uuid_file = get_config_dir() / ".telemetry_uuid"
    if uuid_file.exists():
        try:
            val = uuid_file.read_text(encoding="utf-8").strip()
            if val:
                return val
        except Exception:
            pass
    new_id = uuid.uuid4().hex
    try:
        uuid_file.write_text(new_id, encoding="utf-8")
    except Exception:
        pass
    return new_id


# ─────────────────────────────────────────────────────────────────────
# Client detection
# ─────────────────────────────────────────────────────────────────────

def _detect_client() -> str:
    explicit = os.environ.get("ANDROMITY_CLIENT")
    if explicit:
        return explicit.lower().strip()
    if os.environ.get("VSCODE_PID") or os.environ.get("VSCODE_IPC_HOOK"):
        return "vscode"
    if "andromity.server" in sys.argv or os.environ.get("ANDROMITY_SERVER_MODE"):
        return "server"
    if hasattr(sys.stdout, "isatty") and sys.stdout.isatty():
        return "tui"
    return "cli"


# ─────────────────────────────────────────────────────────────────────
# Sanitise helpers
# ─────────────────────────────────────────────────────────────────────

def _safe_str(value: object, max_len: int = 64, allowed: str = r"a-zA-Z0-9._:-") -> str:
    s = str(value or "unknown")[:max_len]
    return re.sub(f"[^{allowed}]", "", s) or "unknown"


def _provider_type(provider: str) -> str:
    return "local" if provider.lower() in ("ollama", "local", "lmstudio") else "cloud"


def _duration_bucket(duration_sec: float) -> str:
    if duration_sec < 300:
        return "0-5min"
    if duration_sec < 900:
        return "5-15min"
    if duration_sec < 1800:
        return "15-30min"
    return "30min+"


# ─────────────────────────────────────────────────────────────────────
# HTTP helpers (fire-and-forget, background thread)
# ─────────────────────────────────────────────────────────────────────

def _post(endpoint: str, payload: dict) -> None:
    """Send JSON payload to endpoint; silently swallow all errors."""
    try:
        import urllib.request
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=data,
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"andromity/{__version__} ({payload.get('client', 'cli')})",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3.0):
            pass
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────

def send_session_start(
    session_id: Optional[str] = None,
    *,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    mcp_tools_count: int = 0,
) -> None:
    """
    Fire once per session (deduplicated by session_id).
    Sends anonymous session metadata — never any content.

    NOTE: Existing callers using positional session_id still work.
    New callers should pass provider/model as keyword args.
    """
    if not _should_send_telemetry():
        return

    sid = str(session_id).strip() if session_id else uuid.uuid4().hex

    with _lock:
        if sid in _tracked_sessions:
            return
        _tracked_sessions.add(sid)

    _prov = _safe_str(provider or "unknown", 32)
    _mod  = _safe_str(model    or "unknown", 64)
    _re   = (reasoning_effort or "off")
    if _re not in ("off", "low", "medium", "high"):
        _re = "off"

    client = _detect_client()
    payload = {
        "event":            "session_start",
        "user_id":          _get_or_create_user_id(),
        "session_id":       sid,
        "client":           client,
        "os":               platform.system().lower(),
        "version":          __version__,
        # v2 fields
        "provider":         _prov,
        "model":            _mod,
        "provider_type":    _provider_type(_prov),
        "reasoning_effort": _re,
        "mcp_tools_count":  min(int(mcp_tools_count or 0), 999),
    }
    threading.Thread(target=_post, args=(_PING_ENDPOINT, payload), daemon=True).start()


def send_session_end(
    session_id: Optional[str] = None,
    *,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    turn_count: int = 0,
    had_error: bool = False,
    duration_sec: float = 0,
    tool_counts: Optional[dict] = None,
) -> None:
    """
    Fire once when a session ends.
    Sends coarse, aggregate stats — no content, no paths.

    tool_counts: dict with optional keys 'bash', 'file', 'web' (integer call counts).
    """
    if not _should_send_telemetry():
        return

    _prov = _safe_str(provider or "unknown", 32)
    _mod  = _safe_str(model    or "unknown", 64)
    tc    = tool_counts or {}

    payload = {
        "event":            "session_end",
        "user_id":          _get_or_create_user_id(),
        "session_id":       _safe_str(session_id or "", 64, r"a-zA-Z0-9_-"),
        "client":           _detect_client(),
        "os":               platform.system().lower(),
        "version":          __version__,
        "provider":         _prov,
        "model":            _mod,
        "provider_type":    _provider_type(_prov),
        "turn_count":       min(int(turn_count or 0), 9999),
        "had_error":        1 if had_error else 0,
        "duration_bucket":  _duration_bucket(float(duration_sec or 0)),
        "tool_bash_count":  min(int(tc.get("bash", 0)), 9999),
        "tool_file_count":  min(int(tc.get("file", 0)), 9999),
        "tool_web_count":   min(int(tc.get("web",  0)), 9999),
    }
    threading.Thread(target=_post, args=(_EVENT_ENDPOINT, payload), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────
# Weekly aggregate ping (feature usage summary — no session linkage)
# ─────────────────────────────────────────────────────────────────────

_WEEKLY_PING_FILE = ".telemetry_weekly_ts"


def maybe_send_weekly_ping(features_used: Optional[list] = None) -> None:
    """
    Send at most one lightweight aggregate ping per 7 days.
    Contains only feature flags used this week and coarse session stats.
    Carries no session_id — fully unlinked from individual sessions.
    """
    if not _should_send_telemetry():
        return

    ts_file = get_config_dir() / _WEEKLY_PING_FILE
    now = time.time()

    try:
        if ts_file.exists():
            last_ts = float(ts_file.read_text(encoding="utf-8").strip())
            if now - last_ts < 7 * 86400:
                return
    except Exception:
        pass

    try:
        ts_file.write_text(str(now), encoding="utf-8")
    except Exception:
        pass

    safe_features = [
        f for f in (features_used or [])
        if isinstance(f, str) and re.match(r"^[a-zA-Z0-9_]{1,32}$", f)
    ][:20]

    payload = {
        "event":         "weekly_summary",
        "user_id":       _get_or_create_user_id(),
        "client":        _detect_client(),
        "os":            platform.system().lower(),
        "version":       __version__,
        "features_used": safe_features,
    }
    threading.Thread(target=_post, args=(_EVENT_ENDPOINT, payload), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────
# Legacy stub — kept for backwards compat
# ─────────────────────────────────────────────────────────────────────

def maybe_ping() -> None:
    """Deprecated no-op — use send_session_start() instead."""
    pass

