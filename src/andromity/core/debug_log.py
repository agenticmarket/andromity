"""Andromity debug logger."""
import logging
import os
import stat
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

if sys.platform == "win32":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _INVALID_HANDLE = wintypes.HANDLE(-1).value
    _APPEND_ONLY = 0x0004 | 0x0080 | 0x00100000
    _SHARE_ALL = 0x0001 | 0x0002 | 0x0004
    _OPEN_ALWAYS = 4
    _OPEN_EXISTING = 3
    _NORMAL = 0x0080
    _DELETE = 0x00010000
    _SHARING_VIOLATION = 32

    def _open_append(path: str) -> int:
        """An append-only handle: every write lands at the real end, and the file may be renamed while open."""
        handle = _kernel32.CreateFileW(path, _APPEND_ONLY, _SHARE_ALL, None, _OPEN_ALWAYS, _NORMAL, None)
        if handle is None or handle == _INVALID_HANDLE:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return msvcrt.open_osfhandle(handle, 0)
        except OSError:
            _kernel32.CloseHandle(handle)
            raise

    def _can_rename(path: str) -> bool:
        """False while any process has the file open without allowing it to be renamed."""
        handle = _kernel32.CreateFileW(path, _DELETE, _SHARE_ALL, None, _OPEN_EXISTING, _NORMAL, None)
        if handle is None or handle == _INVALID_HANDLE:
            return ctypes.get_last_error() != _SHARING_VIOLATION
        _kernel32.CloseHandle(handle)
        return True

    def _try_lock(fd: int) -> bool:
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def _unlock(fd: int) -> None:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
else:
    import fcntl

    def _open_append(path: str) -> int:
        return os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_CLOEXEC", 0), 0o600)

    def _can_rename(path: str) -> bool:
        return True

    def _try_lock(fd: int) -> bool:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def _unlock(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_UN)


def _log_path() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", "~")).expanduser() / "andromity"
    else:
        base = Path.home() / ".andromity"
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError:
        base = Path(tempfile.gettempdir()) / "andromity"
        try:
            base.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
    return base / "andromity.log"


LOG_PATH = _log_path()


class _RotationLock:
    """A lock file that lets one process at a time rotate the log."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._fd: Optional[int] = None
        self.unusable = False

    def _open(self) -> Optional[int]:
        for _attempt in range(2):
            try:
                return os.open(self._path, os.O_RDWR | os.O_CREAT, 0o600)
            except PermissionError:
                try:
                    os.chmod(self._path, stat.S_IWRITE | stat.S_IREAD)
                except OSError:
                    break
            except OSError:
                break
        return None

    def acquire(self, wait_seconds: float) -> bool:
        """True once locked. False with `unusable` set when the lock file can't be opened at all."""
        fd = self._open()
        if fd is None:
            self.unusable = True
            return False
        deadline = time.monotonic() + wait_seconds
        while not _try_lock(fd):
            if time.monotonic() >= deadline:
                os.close(fd)
                return False
            time.sleep(0.01)
        self._fd = fd
        return True

    def release(self) -> None:
        if self._fd is None:
            return
        try:
            _unlock(self._fd)
        except OSError:
            pass
        finally:
            os.close(self._fd)
            self._fd = None


class SharedRotatingFileHandler(logging.Handler):
    """A size-rotated log that several processes (daemons, terminals) write at once.

    Each record is one append-only write, so processes never write over each other. Rotation renames the files while
    holding a lock file, after checking the size again, so only one process rotates at a time; every other process
    sees the rename before its next write and reopens. Windows renames an open file only when every handle on it
    allows that, as these do; while a process whose handle doesn't has the log open, rotation is retried later.
    Nothing here prints to stderr except a record that can't be formatted.
    """

    RETRY_SECONDS = 60.0
    LOCK_WAIT_SECONDS = 0.2

    def __init__(self, filename, maxBytes: int = 0, backupCount: int = 0, encoding: Optional[str] = None,
                 delay: bool = True, errors: Optional[str] = None) -> None:
        super().__init__()
        self.baseFilename = os.path.abspath(os.fspath(filename))
        self.maxBytes = maxBytes
        self.backupCount = backupCount
        self.encoding = encoding or "utf-8"
        self.errors = errors or "backslashreplace"
        self._fd: Optional[int] = None
        self._retry_at = 0.0
        if not delay:
            self._current()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            data = (self.format(record) + "\n").encode(self.encoding, self.errors)
        except Exception:
            self.handleError(record)
            return
        fd = self._current()
        if fd is not None and self._due(fd, len(data)):
            self._rotate(len(data))
            fd = self._current()
        if fd is None:
            return
        if not self._write(fd, data):
            self._close_fd()
            fd = self._current()
            if fd is not None and not self._write(fd, data):
                self._close_fd()

    def close(self) -> None:
        self.acquire()
        try:
            self._close_fd()
        finally:
            self.release()
            super().close()

    def _backup(self, index: int) -> str:
        return f"{self.baseFilename}.{index}"

    @staticmethod
    def _write(fd: int, data: bytes) -> bool:
        try:
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    return False
                view = view[written:]
            return True
        except OSError:
            return False

    def _current(self) -> Optional[int]:
        if self._fd is not None and not self._still_the_log(self._fd):
            self._close_fd()
        if self._fd is None:
            self._fd = self._open()
        return self._fd

    def _still_the_log(self, fd: int) -> bool:
        try:
            mine = os.fstat(fd)
            current = os.stat(self.baseFilename)
        except OSError:
            return False
        return (mine.st_ino, mine.st_dev) == (current.st_ino, current.st_dev)

    def _open(self) -> Optional[int]:
        for _attempt in range(2):
            try:
                fd = _open_append(self.baseFilename)
            except FileNotFoundError:
                try:
                    os.makedirs(os.path.dirname(self.baseFilename), exist_ok=True)
                except OSError:
                    return None
                continue
            except PermissionError:
                if os.path.isdir(self.baseFilename):
                    return None
                continue
            except OSError:
                return None
            try:
                regular = stat.S_ISREG(os.fstat(fd).st_mode)
            except OSError:
                regular = False
            if regular:
                return fd
            os.close(fd)
            return None
        return None

    def _close_fd(self) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None

    def _due(self, fd: int, incoming: int) -> bool:
        if self.maxBytes <= 0 or self.backupCount <= 0 or time.monotonic() < self._retry_at:
            return False
        try:
            size = os.fstat(fd).st_size
        except OSError:
            return False
        return size > 0 and size + incoming > self.maxBytes

    def _rotate(self, incoming: int) -> None:
        lock = _RotationLock(self.baseFilename + ".lock")
        if not lock.acquire(self.LOCK_WAIT_SECONDS) and not lock.unusable:
            self._retry_at = time.monotonic() + self.RETRY_SECONDS
            return
        try:
            size = os.stat(self.baseFilename).st_size
            if size == 0 or size + incoming <= self.maxBytes:
                return
            if not _can_rename(self.baseFilename):
                self._retry_at = time.monotonic() + self.RETRY_SECONDS
                return
            self._close_fd()
            self._free_first_backup()
            os.replace(self.baseFilename, self._backup(1))
        except FileNotFoundError:
            pass
        except OSError:
            self._retry_at = time.monotonic() + self.RETRY_SECONDS
        finally:
            lock.release()

    def _free_first_backup(self) -> None:
        """Frees `.1` by shifting backups down into the first gap, dropping the oldest only when there is none.

        An attempt that stops partway leaves a gap, which the next attempt fills, so it never costs a backup.
        """
        gap = next((index for index in range(1, self.backupCount + 1) if not os.path.exists(self._backup(index))), None)
        if gap is None:
            self._remove(self._backup(self.backupCount))
            gap = self.backupCount
        for index in range(gap - 1, 0, -1):
            os.replace(self._backup(index), self._backup(index + 1))

    @staticmethod
    def _remove(path: str) -> None:
        """Deletes a file even when it is read-only, or open in a process that allows deleting it."""
        try:
            os.remove(path)
        except PermissionError:
            os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
            os.remove(path)


_handler = SharedRotatingFileHandler(
    LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8", delay=True,
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
