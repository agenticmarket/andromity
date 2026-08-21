"""Background update checker and updater for Andromity.

Checks PyPI / GitHub Releases asynchronously with a 24-hour cache.
Never blocks application startup or UI rendering.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from typing import Callable, Dict, Optional, Tuple

from andromity import __version__
from andromity.config import get_config_dir
from andromity.core.debug_log import get_logger

log = get_logger("updater")

CACHE_FILE = get_config_dir() / "update_cache.json"
CACHE_TTL_SECONDS = 86400  # 24 hours
PYPI_URL = "https://pypi.org/pypi/andromity/json"
GITHUB_API_URL = "https://api.github.com/repos/agenticmarket/andromity/releases/latest"


def _parse_version(v: str) -> tuple:
    """Parse version string into a comparable numeric tuple."""
    nums = re.findall(r"\d+", v)
    return tuple(int(n) for n in nums) if nums else (0,)


def _is_newer_version(latest: str, current: str) -> bool:
    """Return True if latest is strictly newer than current."""
    try:
        return _parse_version(latest) > _parse_version(current)
    except Exception:
        return False


def get_cached_update_info() -> Dict[str, any]:
    """Read the last cached update check result, or empty dict if invalid/expired."""
    if not CACHE_FILE.exists():
        return {}
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        last_check = data.get("timestamp", 0)
        if time.time() - last_check < CACHE_TTL_SECONDS:
            return data
    except Exception as e:
        log.debug("Failed to read update cache: %s", e)
    return {}


def _save_update_cache(latest_version: str, update_available: bool, release_notes: str = ""):
    """Save update check result to local cache."""
    try:
        data = {
            "timestamp": time.time(),
            "current_version": __version__,
            "latest_version": latest_version,
            "update_available": update_available,
            "release_notes": release_notes,
        }
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        log.debug("Failed to save update cache: %s", e)


def check_for_updates_sync(force: bool = False) -> Dict[str, any]:
    """Perform a synchronous update check against PyPI / GitHub (3s timeout)."""
    if not force:
        cached = get_cached_update_info()
        if cached:
            return cached

    latest_version = ""
    release_notes = ""

    # 1. Try PyPI JSON API first
    try:
        req = urllib.request.Request(PYPI_URL, headers={"User-Agent": f"Andromity/{__version__}"})
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            if resp.status == 200:
                pypi_data = json.loads(resp.read().decode("utf-8"))
                latest_version = pypi_data.get("info", {}).get("version", "")
    except Exception as e:
        log.debug("PyPI check failed: %s", e)

    # 2. Fallback to GitHub Releases API if PyPI was unreachable
    if not latest_version:
        try:
            req = urllib.request.Request(GITHUB_API_URL, headers={"User-Agent": f"Andromity/{__version__}"})
            with urllib.request.urlopen(req, timeout=3.5) as resp:
                if resp.status == 200:
                    gh_data = json.loads(resp.read().decode("utf-8"))
                    tag = gh_data.get("tag_name", "").lstrip("v")
                    latest_version = tag
                    release_notes = gh_data.get("body", "")
        except Exception as e:
            log.debug("GitHub check failed: %s", e)

    if latest_version:
        is_newer = _is_newer_version(latest_version, __version__)
        _save_update_cache(latest_version, is_newer, release_notes)
        return {
            "timestamp": time.time(),
            "current_version": __version__,
            "latest_version": latest_version,
            "update_available": is_newer,
            "release_notes": release_notes,
        }

    return {"current_version": __version__, "update_available": False}


def check_for_updates_async(callback: Optional[Callable[[Dict[str, any]], None]] = None, force: bool = False):
    """Run update check in a background daemon thread and invoke callback when done."""
    def _worker():
        try:
            res = check_for_updates_sync(force=force)
            if callback and res:
                callback(res)
        except Exception as e:
            log.debug("Async update check worker error: %s", e)

    t = threading.Thread(target=_worker, daemon=True, name="AndromityUpdateChecker")
    t.start()


def perform_update() -> Tuple[bool, str]:
    """Execute the upgrade command (pipx or pip) in a subprocess."""
    pipx_bin = shutil.which("pipx")
    is_pipx = False

    if pipx_bin:
        try:
            res = subprocess.run([pipx_bin, "list"], capture_output=True, text=True, timeout=5)
            if "andromity" in res.stdout:
                is_pipx = True
        except Exception:
            pass

    if is_pipx:
        cmd = [pipx_bin, "upgrade", "andromity"]
    else:
        cmd = [sys.executable, "-m", "pip", "install", "--upgrade", "andromity"]

    try:
        log.info("Running upgrade command: %s", " ".join(cmd))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode == 0:
            # Clear update cache on successful upgrade
            try:
                if CACHE_FILE.exists():
                    CACHE_FILE.unlink()
            except Exception:
                pass
            return True, f"Successfully upgraded Andromity! Restart the app to apply the update.\n\n{result.stdout.strip()}"
        else:
            return False, f"Upgrade failed (exit code {result.returncode}):\n{result.stderr.strip() or result.stdout.strip()}"
    except Exception as e:
        log.error("Update execution error: %s", e)
        return False, f"Update failed: {e}"
