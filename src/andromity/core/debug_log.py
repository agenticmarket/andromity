"""Andromity debug logger."""
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path


def _log_path() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", "~")).expanduser() / "andromity"
    else:
        base = Path.home() / ".andromity"
    base.mkdir(parents=True, exist_ok=True)
    return base / "andromity.log"


LOG_PATH = _log_path()

_handler = RotatingFileHandler(
    LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8",
)
_handler.setFormatter(logging.Formatter(
    "%(asctime)s [%(levelname)-8s] %(name)s: %(message)s", datefmt="%H:%M:%S",
))

_root = logging.getLogger("andromity")
_root.setLevel(logging.DEBUG)
if not _root.handlers:
    _root.addHandler(_handler)

logger = _root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"andromity.{name}")
