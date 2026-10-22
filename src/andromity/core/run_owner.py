"""Which engine process owns a running session.

Several engines can share one session database (one per VS Code window, plus
the TUI). Each engine holds an exclusive OS lock on its own file under
``<config dir>/run_owners`` for as long as it lives; the OS drops the lock when
the process exits, even on a hard kill. A session marked running records the
owner's id, so any engine can tell a live run from one whose engine died
mid-turn by trying to take that lock.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import uuid
from pathlib import Path
from typing import IO, Dict, Optional, Tuple

log = logging.getLogger(__name__)

_OWNER_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_lock = threading.Lock()
_owners: Dict[str, Tuple[str, IO[bytes]]] = {}


def _owners_dir() -> Path:
    from andromity.config import get_config_dir
    return get_config_dir() / "run_owners"


def _try_lock(handle: IO[bytes]) -> bool:
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


def _unlock(handle: IO[bytes]) -> None:
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


def current_owner_id() -> Optional[str]:
    """This process's owner id, taking its lock on first use. None if the lock file can't be created."""
    directory = _owners_dir()
    key = str(directory)
    with _lock:
        held = _owners.get(key)
        if held:
            return held[0]
        try:
            directory.mkdir(parents=True, exist_ok=True)
            owner_id = uuid.uuid4().hex
            handle = open(directory / f"{owner_id}.lock", "a+b")
            if not _try_lock(handle):
                handle.close()
                return None
            _owners[key] = (owner_id, handle)
            return owner_id
        except OSError as e:
            log.warning("Could not create the run owner lock: %s", e)
            return None


def is_owner_alive(owner_id: Optional[str]) -> bool:
    """Whether the engine that recorded ``owner_id`` is still running.

    Unknown or unreadable states count as alive so a live run is never shown
    as interrupted; only a lock file that is missing or can be taken means the
    owner is gone.
    """
    if not owner_id or not _OWNER_ID_RE.match(owner_id):
        return False
    directory = _owners_dir()
    with _lock:
        held = _owners.get(str(directory))
        if held and held[0] == owner_id:
            return True
    path = directory / f"{owner_id}.lock"
    if not path.exists():
        return False
    try:
        handle = open(path, "a+b")
    except OSError:
        return True
    try:
        if not _try_lock(handle):
            return True
        _unlock(handle)
    finally:
        handle.close()
    try:
        path.unlink()
    except OSError:
        pass
    return False
