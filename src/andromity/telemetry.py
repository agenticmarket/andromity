import json
import os
import platform
import sys
import threading
import urllib.request
from pathlib import Path

from andromity.config import get_config_dir, config
from andromity.core.debug_log import get_logger
log = get_logger("telemetry")

def _should_send_telemetry(is_first_launch: bool = False) -> bool:
    if os.environ.get("DO_NOT_TRACK") in ("1", "true", "True", "TRUE"):
        return False
    if os.environ.get("ANDROMITY_NO_TELEMETRY") in ("1", "true", "True", "TRUE"):
        return False

    if not config.get("default", "telemetry", True):
        return False

    if is_first_launch:
        marker = get_config_dir() / ".telemetry_sent"
        if marker.exists():
            return False
    return True


import uuid

def _get_or_create_user_id() -> str:
    uuid_file = get_config_dir() / ".telemetry_uuid"
    if uuid_file.exists():
        try:
            return uuid_file.read_text().strip()
        except Exception:
            pass
    # Generate new random UUID
    new_id = uuid.uuid4().hex
    try:
        uuid_file.write_text(new_id)
    except Exception:
        pass
    return new_id


def _send_ping_worker(event: str = "first_launch", provider: str = None, profile: str = None):
    try:
        log.info("Sending '%s' ping to telemetry server...", event)
        from andromity import __version__
        data = {
            "event": event,
            "os": platform.system().lower(),
            "python": f"{sys.version_info.major}.{sys.version_info.minor}",
            "version": __version__,
            "user_id": _get_or_create_user_id()
        }
        if provider:
            data["provider"] = provider
        if profile:
            data["profile"] = profile
            
        req = urllib.request.Request(
            "https://telemetry.agenticmarket.dev/ping",
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": f"andromity-cli/{__version__}"},
            method="POST"
        )
        # Fast timeout so it doesn't hang the app if the network is down
        with urllib.request.urlopen(req, timeout=3.0) as response:
            if response.status in (200, 201, 202, 204) and event == "first_launch":
                # Mark as sent
                marker = get_config_dir() / ".telemetry_sent"
                marker.touch()
    except Exception as e:
        # Swallow all errors — telemetry should never break the app
        log.error("Telemetry ping failed: %s", e)
        pass


def maybe_ping():
    """
    Non-blocking anonymous telemetry ping for first launch.
    """
    if _should_send_telemetry(is_first_launch=True):
        print("\n\033[90mAndromity collects anonymous usage data to help us improve.")
        print("We do not collect PII, IP addresses, or code.")
        print("To opt-out, set the DO_NOT_TRACK=1 environment variable.\033[0m\n")
        log.info("First launch telemetry ping will be sent...")
        t = threading.Thread(target=_send_ping_worker, args=("first_launch",), daemon=True)
        t.start()


def send_session_start():
    """
    Non-blocking anonymous telemetry ping for a new session.
    """
    if _should_send_telemetry(is_first_launch=False):
        provider = config.get("default", "provider", "")
        profile = config.get("default", "profile", "builder")
        log.info("Session start telemetry ping will be sent...")
        t = threading.Thread(target=_send_ping_worker, args=("session_start", provider, profile), daemon=True)
        t.start()
