import json
import os
import platform
import sys
import threading
import urllib.request
import uuid
from typing import Optional

from andromity import __version__
from andromity.config import get_config_dir, config

_ENDPOINT = "https://telemetry.agenticmarket.dev/ping"
_tracked_sessions = set()
_lock = threading.Lock()


def _should_send_telemetry() -> bool:
    if os.environ.get("DO_NOT_TRACK") in ("1", "true", "True", "TRUE"):
        return False
    if os.environ.get("ANDROMITY_NO_TELEMETRY") in ("1", "true", "True", "TRUE"):
        return False
    return bool(config.get("default", "telemetry", True))


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


def _send_ping_worker(session_id: str, client: str):
    try:
        payload = {
            "event": "session_start",
            "user_id": _get_or_create_user_id(),
            "session_id": session_id,
            "client": client,
            "os": platform.system().lower(),
            "version": __version__,
        }
        req = urllib.request.Request(
            _ENDPOINT,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"andromity/{__version__} ({client})",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2.5):
            pass
    except Exception:
        pass


def send_session_start(session_id: Optional[str] = None):
    if not _should_send_telemetry():
        return

    sid = str(session_id).strip() if session_id else uuid.uuid4().hex

    with _lock:
        if sid in _tracked_sessions:
            return
        _tracked_sessions.add(sid)

    client = _detect_client()
    t = threading.Thread(target=_send_ping_worker, args=(sid, client), daemon=True)
    t.start()


def maybe_ping():
    pass
