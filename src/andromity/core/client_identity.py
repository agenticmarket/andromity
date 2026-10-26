"""Per-install identity sent to the Andromity gateway for anonymous quota accounting."""
import re
import uuid

from andromity.config import config, get_config_dir

_ID_FILE = ".gateway_client_id"
_ID_PATTERN = re.compile(r"^anon_[0-9a-f]{32}$")
_SHARED_IDS = {"", "anonymous", "local_client", "unknown"}

_process_id = ""


def gateway_client_id() -> str:
    """Return this install's gateway client ID, creating and persisting it on first use.

    Kept separate from the telemetry ID so gateway quota records cannot be joined to telemetry.
    """
    global _process_id
    configured = str(config.get("user", "anonymous_id", "") or "").strip()
    if configured.lower() not in _SHARED_IDS:
        return configured

    path = get_config_dir() / _ID_FILE
    try:
        stored = path.read_text(encoding="utf-8").strip()
        if _ID_PATTERN.match(stored):
            return stored
    except OSError:
        pass

    new_id = f"anon_{uuid.uuid4().hex}"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{_ID_FILE}.{uuid.uuid4().hex}.tmp")
        tmp.write_text(new_id, encoding="utf-8")
        tmp.replace(path)
        return new_id
    except OSError:
        if not _process_id:
            _process_id = new_id
        return _process_id
