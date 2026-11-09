"""
Andromity usage telemetry, linked to a random per-installation ID; opt-out at any time.

TELEMETRY.md at the repository root is the public list of every event and field sent;
keep it in sync with the payloads in this module.

Never collected: prompts, responses, code, file contents, file names or paths, API keys,
names, emails, hostnames or hardware identifiers. The worker derives country server-side
and does not store IP addresses.

Opt-out: DO_NOT_TRACK=1, ANDROMITY_NO_TELEMETRY=1, `telemetry = false` in config, or air-gap mode.
"""
from __future__ import annotations

import atexit
import functools
import json
import math
import os
import platform
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from andromity import __version__
from andromity.config import get_config_dir, config

_PING_ENDPOINT  = "https://telemetry.agenticmarket.dev/ping"
_EVENT_ENDPOINT = "https://telemetry.agenticmarket.dev/event"
_ENDPOINTS = (_PING_ENDPOINT, _EVENT_ENDPOINT)

_ID_FILE = ".telemetry_uuid"
_SPOOL_FILE = ".telemetry_outbox.json"
_LOCK_FILE = ".telemetry.lock"
_NOTICE_FILE = ".telemetry_notice_shown"

_SPOOL_MAX_ITEMS = 100
_SPOOL_MAX_AGE = 7 * 86400
_SPOOL_MAX_BYTES = 1 << 20
_REQUEST_TIMEOUT = 3.0
_LOCK_WAIT = 2.0
_RETRY_BASE = 30.0
_RETRY_MAX = 900.0
_RETRY_AFTER_MAX = 3600.0
_MAX_ATTEMPTS = 10

_USER_ID = re.compile(r"[a-zA-Z0-9_-]{8,64}")
_SESSION_ID = re.compile(r"[a-zA-Z0-9_-]{4,64}")
_TOKEN_ID = re.compile(r"[a-zA-Z0-9_-]{16,64}")
_TRUTHY = ("1", "true", "True", "TRUE")

_tracked_sessions: set[str] = set()
_lock = threading.Lock()

# ─────────────────────────────────────────────────────────────────────
# Guard
# ─────────────────────────────────────────────────────────────────────

def _opted_out() -> bool:
    """The user turned telemetry off."""
    if os.environ.get("ANDROMITY_AIRGAP") == "1":
        return True
    if os.environ.get("DO_NOT_TRACK") in _TRUTHY:
        return True
    if os.environ.get("ANDROMITY_NO_TELEMETRY") in _TRUTHY:
        return True
    setting = config.get("default", "telemetry", True)
    if isinstance(setting, str):
        return setting.strip().lower() in ("", "0", "false", "no", "off")
    return not bool(setting)


def _suppressed() -> bool:
    """Automated runs that never send, without that being the user's choice."""
    if os.environ.get("CI") in _TRUTHY:
        return True
    if os.environ.get("ANDROMITY_INTERNAL") in _TRUTHY:
        return True
    return "pytest" in sys.modules or bool(os.environ.get("PYTEST_CURRENT_TEST"))


def _should_send_telemetry() -> bool:
    return not _opted_out() and not _suppressed()


def _enabled() -> bool:
    """Whether an event may be sent. Opting out also deletes events still waiting to be sent."""
    if _should_send_telemetry():
        return True
    if _opted_out():
        _discard_pending()
    return False


def _never_raises(func: Callable[..., None]) -> Callable[..., None]:
    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> None:
        try:
            func(*args, **kwargs)
        except Exception:
            pass
    return wrapper


# ─────────────────────────────────────────────────────────────────────
# Files shared between processes
# ─────────────────────────────────────────────────────────────────────

class _FileLock:
    """An exclusive lock on a file, held by one process at a time."""

    def __init__(self, path: Path, wait: float = _LOCK_WAIT) -> None:
        self._path = path
        self._wait = wait
        self._handle: Optional[Any] = None

    def __enter__(self) -> "_FileLock":
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self._path, "a+b")
        deadline = time.monotonic() + self._wait
        while not self._try_lock(handle):
            if time.monotonic() >= deadline:
                handle.close()
                raise TimeoutError(f"{self._path.name} is held by another process")
            time.sleep(0.02)
        self._handle = handle
        return self

    def __exit__(self, *exc: object) -> None:
        handle, self._handle = self._handle, None
        if handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            handle.close()

    @staticmethod
    def _try_lock(handle: Any) -> bool:
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False


def _atomic_write(path: Path, data: bytes) -> None:
    """Replace the file in one step through a temporary file only this call uses."""
    temp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex[:12]}.tmp")
    try:
        temp.write_bytes(data)
        for attempt in range(5):
            try:
                os.replace(temp, path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.02 * (attempt + 1))
    finally:
        temp.unlink(missing_ok=True)


# ─────────────────────────────────────────────────────────────────────
# Pseudonymous installation ID
# ─────────────────────────────────────────────────────────────────────

_user_ids: Dict[str, str] = {}
_user_id_lock = threading.Lock()


def _read_user_id(path: Path) -> Optional[str]:
    try:
        with open(path, "rb") as handle:
            value = handle.read(256).decode("utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return value if _USER_ID.fullmatch(value) else None


def _load_or_create_user_id(directory: Path) -> str:
    path = directory / _ID_FILE
    existing = _read_user_id(path)
    if existing:
        return existing
    try:
        with _FileLock(directory / _LOCK_FILE):
            existing = _read_user_id(path)
            if existing:
                return existing
            new_id = uuid.uuid4().hex
            _atomic_write(path, new_id.encode("utf-8"))
            return new_id
    except (OSError, TimeoutError):
        return uuid.uuid4().hex


def _get_or_create_user_id() -> str:
    """The installation's ID. One process keeps using the same ID even when the file can't be written."""
    directory = get_config_dir()
    key = str(directory)
    with _user_id_lock:
        if key not in _user_ids:
            _user_ids[key] = _load_or_create_user_id(directory)
        return _user_ids[key]


# ─────────────────────────────────────────────────────────────────────
# Client detection
# ─────────────────────────────────────────────────────────────────────

def _detect_client() -> str:
    explicit = (os.environ.get("ANDROMITY_CLIENT") or "").lower().strip()
    if explicit:
        return explicit if explicit in ("vscode", "tui", "cli", "server") else "cli"
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

_KEY_PATTERNS = re.compile(
    r"(?:sk-[a-zA-Z0-9_\-]{16,}|nvapi-[a-zA-Z0-9_\-]{16,}|gsk_[a-zA-Z0-9_\-]{16,}|AIza[a-zA-Z0-9_\-]{16,}|xai-[a-zA-Z0-9_\-]{16,}|key-[a-zA-Z0-9_\-]{16,}|pplx-[a-zA-Z0-9_\-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})"
)
_UUID_OR_SESS_PATTERN = re.compile(
    r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|sess-[a-zA-Z0-9_\-]+)$"
)
_SECRETS_IN_TEXT = re.compile(
    _KEY_PATTERNS.pattern
    + r"|andromity_[0-9a-fA-F]{32,}"
    + r"|(?i:bearer)\s+[A-Za-z0-9._~+/=\-]{8,}"
    + r"|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"
)
_MODEL_FILE = re.compile(r"\.(?:gguf|ggml|bin|safetensors|pt|pth|onnx|llamafile|mlmodel)\Z", re.IGNORECASE)
_URL = re.compile(r"[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_USER_INFO = re.compile(r"[^\s/@]*:[^\s/@]*@")
_HOSTNAME = re.compile(r"\..*\.|\.(?:com|net|org|io|ai|dev|app|cloud|co|internal|local|lan)\Z", re.IGNORECASE)
_PATH_ROOTS = ("home", "users", "mnt", "opt", "srv", "tmp", "var", "root")
_NAME_MAX_INPUT = 512


def redact_secrets(text: str, marker: str = "[redacted]") -> str:
    """The text with API keys, sign-in tokens and bearer credentials replaced by a marker."""
    return _SECRETS_IN_TEXT.sub(marker, text or "")


def _scrub_api_key(value: str) -> str:
    """Scrub raw API keys or tokens accidentally entered into provider/model fields."""
    if not value or not isinstance(value, str):
        return "unknown"
    if _UUID_OR_SESS_PATTERN.match(value):
        return value
    if _KEY_PATTERNS.search(value) or (len(value) >= 32 and re.match(r"^[a-zA-Z0-9_]{32,}$", value)):
        return "scrubbed_api_key"
    return value


def _safe_str(value: object, max_len: int = 96, allowed: str = r"a-zA-Z0-9._:/-") -> str:
    s = _scrub_api_key(str(value or "unknown"))[:max_len]
    return re.sub(f"[^{allowed}]", "", s) or "unknown"


def _looks_like_path(text: str) -> bool:
    lowered = text.lower()
    if lowered.startswith(("/", "~", "file:")) or "\\" in text or "//" in text:
        return True
    if text in (".", "..") or text.startswith(("./", "../")) or re.match(r"[A-Za-z]:", text):
        return True
    if re.search(r"(?:^|/)[A-Za-z]:/", text):
        return True
    return any(part.lower() in _PATH_ROOTS or part in (".", "..") or part.startswith("~")
               for part in text.split("/")[:-1])


def _looks_like_key(text: str) -> bool:
    if _SECRETS_IN_TEXT.search(text):
        return True
    if any(len(run) == 40 and re.search(r"[a-z]", run) and re.search(r"[A-Z]", run) and re.search(r"[0-9]", run)
           for run in re.split(r"[^A-Za-z0-9/+]+", text)):
        return True
    return any(len(token) >= 32 or (len(token) >= 24 and re.search(r"[0-9]", token) and re.search(r"[A-Za-z]", token))
               for token in re.split(r"[^A-Za-z0-9]+", text))


def _model_name(value: object) -> str:
    """A model identifier. A model file path is reduced to the file's name without its extension;
    any other path is sent as `local-path` and a URL as `url`."""
    text = str(value or "").strip()
    if len(text) > _NAME_MAX_INPUT:
        return "unknown"
    if re.search(r"\barn:", text, re.IGNORECASE):
        if "/" not in text:
            return "unknown"
        text = text[text.rfind("/") + 1:]
    elif (_URL.match(text) and not text.lower().startswith("file:")) or _USER_INFO.search(text):
        return "url"
    elif _looks_like_path(text) or _MODEL_FILE.search(text):
        name = re.split(r"[\\/]", text.rstrip("\\/"))[-1]
        text = _MODEL_FILE.sub("", name) if _MODEL_FILE.search(name) else ""
        if not text:
            return "local-path"
    cleaned = re.sub(r"[^a-zA-Z0-9._:/-]", "", text)
    if _looks_like_key(text) or _looks_like_key(cleaned):
        return "scrubbed_api_key"
    return cleaned[:64] or "unknown"


def _provider_name(value: object) -> str:
    text = str(value or "").strip()
    if (not text or len(text) > _NAME_MAX_INPUT or _HOSTNAME.search(text) or _looks_like_path(text)
            or _URL.match(text) or _USER_INFO.search(text) or re.search(r"\barn:", text, re.IGNORECASE)):
        return "unknown"
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "", text)
    if _looks_like_key(text) or _looks_like_key(cleaned):
        return "scrubbed_api_key"
    return cleaned[:32] or "unknown"


def _profile_name(value: object) -> str:
    text = str(value or "builder").strip()
    return text if re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", text) else "custom"


def _session_id(value: object) -> str:
    """The session ID when it has the form the worker accepts, otherwise empty."""
    text = value.strip() if isinstance(value, str) else ""
    if not _SESSION_ID.fullmatch(text) or _KEY_PATTERNS.search(text):
        return ""
    return text


def _bounded_int(value: object, upper: int) -> int:
    try:
        number = float(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    if not math.isfinite(number):
        return 0
    return max(0, min(int(number), upper))


def _bounded_seconds(value: object, upper: float = 7 * 86400) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return round(max(0.0, min(number, upper)), 3)


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
# Delivery: one sender thread per process, a spool shared between processes
# ─────────────────────────────────────────────────────────────────────

_queue_lock = threading.Lock()
_wake = threading.Event()
_queued: List[dict] = []
_unspooled: List[dict] = []
_sender: Optional[threading.Thread] = None
_failures = 0
_retry_at = 0.0


def _spool_path() -> Path:
    return get_config_dir() / _SPOOL_FILE


def _valid_item(item: object, now: float) -> bool:
    if not isinstance(item, dict) or item.get("endpoint") not in _ENDPOINTS:
        return False
    payload, queued = item.get("payload"), item.get("queued")
    if not isinstance(payload, dict) or not isinstance(payload.get("event_id"), str):
        return False
    if not _TOKEN_ID.fullmatch(payload["event_id"]):
        return False
    if isinstance(queued, bool) or not isinstance(queued, (int, float)) or not math.isfinite(queued):
        return False
    return now - _SPOOL_MAX_AGE < queued <= now + 300


def _read_spool(path: Path) -> List[dict]:
    try:
        if path.stat().st_size > _SPOOL_MAX_BYTES:
            return []
        items = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError, RecursionError):
        return []
    if not isinstance(items, list):
        return []
    now = time.time()
    return [item for item in items if _valid_item(item, now)][-_SPOOL_MAX_ITEMS:]


def _update_spool(change: Callable[[List[dict]], List[dict]], wait: float = _LOCK_WAIT) -> bool:
    """Apply a change to the spool under the cross-process lock. False when the spool can't be written."""
    path = _spool_path()
    try:
        with _FileLock(path.parent / _LOCK_FILE, wait):
            items = change(_read_spool(path))[-_SPOOL_MAX_ITEMS:]
            if items:
                _atomic_write(path, json.dumps(items).encode("utf-8"))
            else:
                path.unlink(missing_ok=True)
        return True
    except (OSError, TimeoutError, ValueError):
        return False


def _append_new(items: List[dict], new: List[dict]) -> List[dict]:
    present = {item["payload"]["event_id"] for item in items}
    return items + [item for item in new if item["payload"]["event_id"] not in present]


def _discard_pending() -> None:
    with _queue_lock:
        _queued.clear()
        _unspooled.clear()
    try:
        _spool_path().unlink(missing_ok=True)
    except OSError:
        pass


def _retry_delay(header: Optional[str] = None) -> float:
    try:
        seconds = float(header) if header else 0.0
    except ValueError:
        seconds = 0.0
    if math.isfinite(seconds) and seconds > 0:
        return min(seconds, _RETRY_AFTER_MAX)
    return min(_RETRY_MAX, _RETRY_BASE * 2 ** min(_failures, 5))


def _send(item: dict) -> Optional[Tuple[float, bool]]:
    """None once the item is done with, delivered or refused for good. Otherwise the seconds to wait,
    and whether the failure counts against this item rather than the network or the rate limit."""
    import urllib.error
    import urllib.request
    request = urllib.request.Request(
        item["endpoint"], data=json.dumps(item["payload"]).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": f"andromity/{__version__}"})
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT):
            return None
    except urllib.error.HTTPError as error:
        error.close()
        if error.code == 429:
            return _retry_delay(error.headers.get("Retry-After") if error.headers else None), False
        if 400 <= error.code < 500 and error.code != 408:
            return None
        return _retry_delay(), True
    except Exception:
        return _retry_delay(), False


def _settle(items: List[dict], finished: set, failed: Optional[str]) -> List[dict]:
    """Remove finished items and count a failed attempt, dropping an item that keeps failing."""
    kept = []
    for item in items:
        event_id = item["payload"]["event_id"]
        if event_id in finished:
            continue
        if event_id == failed:
            attempts = _bounded_int(item.get("attempts"), _MAX_ATTEMPTS) + 1
            if attempts >= _MAX_ATTEMPTS:
                continue
            item = {**item, "attempts": attempts}
        kept.append(item)
    return kept


def _take_unsaved() -> List[dict]:
    """Every event this process holds that is not yet in the spool, with the installation ID filled in."""
    with _queue_lock:
        unsaved = _unspooled + _queued
        _unspooled.clear()
        _queued.clear()
    if unsaved:
        user_id = _get_or_create_user_id()
        for item in unsaved:
            item["payload"]["user_id"] = item["payload"].get("user_id") or user_id
    return unsaved


def _keep_unsaved(items: List[dict]) -> None:
    with _queue_lock:
        _unspooled[:0] = items
        del _unspooled[:-_SPOOL_MAX_ITEMS]


def _deliver() -> None:
    """Persist events not yet saved, then send what is waiting until one attempt fails."""
    global _failures, _retry_at
    if not _enabled():
        with _queue_lock:
            _queued.clear()
            _unspooled.clear()
        _failures, _retry_at = 0, 0.0
        return
    unsaved = _take_unsaved()
    if unsaved and not _update_spool(lambda items: _append_new(items, unsaved)):
        _keep_unsaved(unsaved)
    if time.monotonic() < _retry_at:
        return
    spooled = _read_spool(_spool_path())
    with _queue_lock:
        pending = {item["payload"]["event_id"]: item for item in spooled + _unspooled}
    finished: set[str] = set()
    failed: Optional[str] = None
    for event_id, item in pending.items():
        if not _enabled():
            return
        outcome = _send(item)
        if outcome is not None:
            wait, counts = outcome
            failed = event_id if counts else None
            _failures += 1
            _retry_at = time.monotonic() + wait
            break
        finished.add(event_id)
    else:
        _failures, _retry_at = 0, 0.0
    if finished or failed:
        _update_spool(lambda items: _settle(items, finished, failed))
        with _queue_lock:
            _unspooled[:] = _settle(_unspooled, finished, failed)


def _sender_loop() -> None:
    while True:
        wait = max(1.0, _retry_at - time.monotonic()) if _retry_at else None
        _wake.wait(wait)
        _wake.clear()
        try:
            _deliver()
        except Exception:
            pass


def _post(endpoint: str, payload: dict) -> None:
    """Queue an event; a background thread spools it, then sends it."""
    global _sender
    now = time.time()
    item = {"endpoint": endpoint, "queued": now,
            "payload": {**payload, "event_id": payload.get("event_id") or uuid.uuid4().hex,
                        "occurred_at": payload.get("occurred_at") or now}}
    with _queue_lock:
        _queued.append(item)
        del _queued[:-_SPOOL_MAX_ITEMS]
        if _sender is None or not _sender.is_alive():
            _sender = threading.Thread(target=_sender_loop, name="andromity-telemetry", daemon=True)
            _sender.start()
    _wake.set()


@atexit.register
def _spool_on_exit() -> None:
    """Keep events not yet saved at exit; the next run sends them."""
    try:
        if not _should_send_telemetry():
            return
        unsaved = _take_unsaved()
        if unsaved:
            _update_spool(lambda items: _append_new(items, unsaved), wait=0.5)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────
# First-run notice
# ─────────────────────────────────────────────────────────────────────

TELEMETRY_NOTICE = (
    "Andromity sends usage telemetry linked to a random installation ID: sessions, features used, "
    "provider and model names. Never prompts, code or file paths. Turn it off in Settings, "
    "with DO_NOT_TRACK=1, or `telemetry = false` in config.toml. "
    "Details: https://github.com/agenticmarket/andromity/blob/main/TELEMETRY.md"
)


def take_first_run_notice() -> Optional[str]:
    """The telemetry notice the first time this installation sends telemetry, then None.
    Shown every time when the config folder can't record that it was shown."""
    try:
        if not _should_send_telemetry():
            return None
        marker = get_config_dir() / _NOTICE_FILE
        if marker.is_file():
            return None
    except Exception:
        return None
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        os.close(os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    except OSError:
        try:
            return None if marker.is_file() else TELEMETRY_NOTICE
        except OSError:
            return TELEMETRY_NOTICE
    return TELEMETRY_NOTICE


# ─────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────

def _base(event: str, session_id: str) -> dict:
    return {"event": event, "user_id": None, "session_id": session_id,
            "client": _detect_client(), "os": platform.system().lower(), "version": __version__}


@_never_raises
def send_task_event(event: str, session_id: str, run_id: str, *, outcome: Optional[str] = None,
                    active_seconds: float = 0, first_response_ms: Optional[int] = None,
                    provider: Optional[str] = None, model: Optional[str] = None) -> None:
    if not _enabled():
        return
    if event not in ("task_started", "task_finished"):
        return
    if event == "task_finished" and outcome not in ("completed", "failed", "cancelled"):
        return
    if not isinstance(run_id, str) or not _TOKEN_ID.fullmatch(run_id):
        return
    payload = {**_base(event, _session_id(session_id)), "run_id": run_id,
               "provider": _provider_name(provider), "model": _model_name(model),
               "outcome": outcome if event == "task_finished" else None,
               "active_seconds": _bounded_seconds(active_seconds),
               "first_response_ms": None if first_response_ms is None else _bounded_int(first_response_ms, 86_400_000)}
    _post(_EVENT_ENDPOINT, payload)


@_never_raises
def send_session_start(
    session_id: Optional[str] = None,
    *,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    mcp_tools_count: int = 0,
    profile: Optional[str] = "builder",
    duration_sec: float = 0,
) -> None:
    """Once per session, deduplicated by session ID."""
    if not _enabled():
        return
    sid = _session_id(session_id) if session_id else str(uuid.uuid4())
    if sid:
        with _lock:
            if sid in _tracked_sessions:
                return
            _tracked_sessions.add(sid)

    prov = _provider_name(provider)
    effort = reasoning_effort if reasoning_effort in ("off", "low", "medium", "high") else "off"
    payload = {
        **_base("session_start", sid),
        "provider":         prov,
        "model":            _model_name(model),
        "provider_type":    _provider_type(prov),
        "reasoning_effort": effort,
        "mcp_tools_count":  _bounded_int(mcp_tools_count, 999),
        "profile":          _profile_name(profile),
        "duration_seconds": _bounded_int(duration_sec, 7 * 86400),
        "turn_count":       0,
    }
    _post(_PING_ENDPOINT, payload)


@_never_raises
def send_session_update(
    session_id: str,
    *,
    turn_count: int = 1,
    duration_sec: float = 0,
) -> None:
    """The session's turn count and duration so far."""
    if not _enabled():
        return
    sid = _session_id(session_id)
    if not sid:
        return
    payload = {
        **_base("session_update", sid),
        "turn_count":       max(_bounded_int(turn_count, 9999), 1),
        "duration_seconds": _bounded_int(duration_sec, 7 * 86400),
    }
    _post(_EVENT_ENDPOINT, payload)


@_never_raises
def send_feature_used(
    feature_name: str,
    session_id: Optional[str] = None,
) -> None:
    """A feature was used. Only its sanitised name is sent, never arguments, code or paths."""
    if not _enabled():
        return
    payload = {
        **_base("feature_use", _session_id(session_id)),
        "feature_name": _safe_str(feature_name or "unknown", 64, r"a-zA-Z0-9_-"),
    }
    _post(_EVENT_ENDPOINT, payload)


@_never_raises
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
    """The session's totals so far, sent after each request; the worker keeps one record per session.

    tool_counts: dict with optional keys 'bash', 'file', 'web' (integer call counts).
    """
    if not _enabled():
        return
    prov = _provider_name(provider)
    counts = tool_counts if isinstance(tool_counts, dict) else {}
    duration = _bounded_seconds(duration_sec)
    payload = {
        **_base("session_end", _session_id(session_id)),
        "provider":         prov,
        "model":            _model_name(model),
        "provider_type":    _provider_type(prov),
        "turn_count":       _bounded_int(turn_count, 9999),
        "had_error":        1 if had_error else 0,
        "duration_bucket":  _duration_bucket(duration),
        "duration_seconds": int(duration),
        "tool_bash_count":  _bounded_int(counts.get("bash"), 9999),
        "tool_file_count":  _bounded_int(counts.get("file"), 9999),
        "tool_web_count":   _bounded_int(counts.get("web"), 9999),
    }
    _post(_EVENT_ENDPOINT, payload)
