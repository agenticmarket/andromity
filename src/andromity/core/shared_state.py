import fnmatch
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from andromity.config import get_config_dir
from andromity.core.debug_log import get_logger
from andromity.core.events import SharedStateChanged, StreamEvent

log = get_logger("shared_state")


class SharedStateBoard:
    """A thread-safe, persisted, namespaced key-value state board for multi-session agent coordination."""

    _instances: Dict[str, "SharedStateBoard"] = {}
    _global_lock = threading.RLock()

    def __init__(self, project_path: Optional[str] = None, storage_path: Optional[Path] = None):
        self.project_path = project_path
        self._lock = threading.RLock()
        self._data: Dict[str, Any] = {}
        self._history: List[Dict[str, Any]] = []
        self._subscribers: List[Tuple_Sub] = []  # (pattern, callback)
        
        if storage_path:
            self.storage_file = storage_path
        elif project_path:
            p = Path(project_path) / ".andromity" / "shared_state.json"
            p.parent.mkdir(parents=True, exist_ok=True)
            self.storage_file = p
        else:
            p = get_config_dir() / "shared_state.json"
            p.parent.mkdir(parents=True, exist_ok=True)
            self.storage_file = p

        self._load()

    @classmethod
    def get_instance(cls, project_path: Optional[str] = None) -> "SharedStateBoard":
        key = project_path or "__global__"
        with cls._global_lock:
            if key not in cls._instances:
                cls._instances[key] = cls(project_path=project_path)
            return cls._instances[key]

    @classmethod
    def reset_instances(cls):
        with cls._global_lock:
            cls._instances.clear()

    def _load(self):
        with self._lock:
            if self.storage_file.exists():
                try:
                    content = self.storage_file.read_text(encoding="utf-8")
                    data = json.loads(content)
                    self._data = data.get("state", {})
                    self._history = data.get("history", [])
                except Exception as e:
                    log.warning("Failed to load shared_state from %s: %s", self.storage_file, e)
                    self._data = {}
                    self._history = []

    def _save(self):
        with self._lock:
            try:
                self.storage_file.parent.mkdir(parents=True, exist_ok=True)
                payload = {
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "state": self._data,
                    "history": self._history[-200:],  # keep last 200 history records
                }
                # Write to temp file then atomic rename
                tmp_file = self.storage_file.with_suffix(".tmp")
                tmp_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
                tmp_file.replace(self.storage_file)
            except Exception as e:
                log.error("Failed to save shared_state to %s: %s", self.storage_file, e, exc_info=True)

    def set(self, key: str, value: Any, author_session: Optional[str] = None) -> Any:
        """Set a namespaced key on the shared state board."""
        with self._lock:
            old_value = self._data.get(key)
            self._data[key] = value
            now_iso = datetime.now(timezone.utc).isoformat()
            
            record = {
                "action": "set",
                "key": key,
                "old_value": old_value,
                "new_value": value,
                "author": author_session or "anonymous",
                "timestamp": now_iso,
            }
            self._history.append(record)
            self._save()

            # Trigger matching watch subscribers
            for pattern, cb in list(self._subscribers):
                if fnmatch.fnmatch(key, pattern):
                    try:
                        cb(key, old_value, value)
                    except Exception as e:
                        log.warning("Error in shared state watcher: %s", e)

            from andromity.core.session_bus import SessionBus
            SessionBus.get_instance()._emit_event(SharedStateChanged(
                key=key,
                old_value=old_value,
                new_value=value,
                author_session=author_session,
                timestamp=now_iso,
            ))
            return value

    def get(self, key: str, default: Any = None) -> Any:
        """Get a value from the shared state board."""
        with self._lock:
            return self._data.get(key, default)

    def delete(self, key: str, author_session: Optional[str] = None) -> bool:
        """Delete a key from the shared state board."""
        with self._lock:
            if key in self._data:
                old_value = self._data.pop(key)
                now_iso = datetime.now(timezone.utc).isoformat()
                record = {
                    "action": "delete",
                    "key": key,
                    "old_value": old_value,
                    "new_value": None,
                    "author": author_session or "anonymous",
                    "timestamp": now_iso,
                }
                self._history.append(record)
                self._save()
                return True
            return False

    def list_keys(self, prefix: str = "") -> List[str]:
        """List keys matching optional prefix."""
        with self._lock:
            if not prefix:
                return sorted(list(self._data.keys()))
            return sorted([k for k in self._data.keys() if k.startswith(prefix)])

    def snapshot(self, prefix: str = "") -> Dict[str, Any]:
        """Return a copy of the state dictionary, optionally filtered by prefix."""
        with self._lock:
            if not prefix:
                return dict(self._data)
            return {k: v for k, v in self._data.items() if k.startswith(prefix)}

    def history(self, key: Optional[str] = None) -> List[Dict[str, Any]]:
        """Return history records, optionally filtered by key."""
        with self._lock:
            if not key:
                return list(self._history)
            return [h for h in self._history if h.get("key") == key]

    def watch(self, pattern: str, callback: Callable[[str, Any, Any], None]):
        """Watch keys matching glob pattern (e.g. 'auth.*', 'db.*')."""
        with self._lock:
            self._subscribers.append((pattern, callback))

    def clear(self, author_session: Optional[str] = None):
        """Clear all keys on the state board."""
        with self._lock:
            self._data.clear()
            self._history.append({
                "action": "clear",
                "author": author_session or "anonymous",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            self._save()


# Type alias for subscribers list
Tuple_Sub = tuple[str, Callable[[str, Any, Any], None]]
