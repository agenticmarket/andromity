"""Track every process a shell command starts, so the whole set can be stopped.

Stopping a command by its process tree misses programs whose parent already exited:
a server started by ``npm start | Select-Object -First 8`` outlives the shell, keeps
the command's output pipe open, and no longer appears under the shell's process id.
On Windows the shell is placed in a job object, which keeps every descendant whatever
happens to its parent. Elsewhere the shell leads its own process group.
"""
import logging
import os
import subprocess
import sys
import threading
from typing import Optional

log = logging.getLogger(__name__)

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
    _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
    _kernel32.SetInformationJobObject.restype = wintypes.BOOL
    _kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    _kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    _kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    _kernel32.TerminateJobObject.restype = wintypes.BOOL
    _kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _kernel32.CloseHandle.restype = wintypes.BOOL

    _PROCESS_TERMINATE = 0x0001
    _PROCESS_SET_QUOTA = 0x0100
    _JOB_EXTENDED_LIMITS = 9
    _JOB_LIMIT_BREAKAWAY_OK = 0x00000800

    class _BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _IoCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_uint64),
            ("WriteOperationCount", ctypes.c_uint64),
            ("OtherOperationCount", ctypes.c_uint64),
            ("ReadTransferCount", ctypes.c_uint64),
            ("WriteTransferCount", ctypes.c_uint64),
            ("OtherTransferCount", ctypes.c_uint64),
        ]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimits),
            ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]


class CommandScope:
    """Every process started by one shell command. Safe to use from several threads."""

    def __init__(self, proc: subprocess.Popen, job: Optional[int]) -> None:
        self._pid = proc.pid
        self._job = job
        self._lock = threading.Lock()
        self._closed = False

    @classmethod
    def attach(cls, proc: subprocess.Popen) -> "CommandScope":
        """Start tracking ``proc`` and everything it starts. Never raises."""
        return cls(proc, _create_job_for(proc) if sys.platform == "win32" else None)

    def stop(self) -> None:
        """Stop every process in the scope, including ones whose parent already exited."""
        with self._lock:
            if self._closed:
                return
            if sys.platform == "win32":
                if self._job is not None and not _kernel32.TerminateJobObject(self._job, 1):
                    log.debug("Could not stop job for %s: %s", self._pid, ctypes.get_last_error())
                return
            import signal
            try:
                os.killpg(self._pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            except OSError as e:
                log.debug("Could not stop process group %s: %s", self._pid, e)

    def close(self) -> None:
        """Stop tracking. Processes still running that do not hold the output are left alone."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._job is not None:
                _kernel32.CloseHandle(self._job)
                self._job = None


def _create_job_for(proc: subprocess.Popen) -> Optional[int]:
    job = _kernel32.CreateJobObjectW(None, None)
    if not job:
        log.debug("Could not create a job object: %s", ctypes.get_last_error())
        return None
    limits = _ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = _JOB_LIMIT_BREAKAWAY_OK
    if not _kernel32.SetInformationJobObject(job, _JOB_EXTENDED_LIMITS, ctypes.byref(limits), ctypes.sizeof(limits)):
        log.debug("Could not let programs leave the job: %s", ctypes.get_last_error())
    handle = _kernel32.OpenProcess(_PROCESS_TERMINATE | _PROCESS_SET_QUOTA, False, proc.pid)
    if not handle:
        log.debug("Could not open process %s: %s", proc.pid, ctypes.get_last_error())
        _kernel32.CloseHandle(job)
        return None
    try:
        if not _kernel32.AssignProcessToJobObject(job, handle):
            log.debug("Could not add process %s to a job: %s", proc.pid, ctypes.get_last_error())
            _kernel32.CloseHandle(job)
            return None
    finally:
        _kernel32.CloseHandle(handle)
    return job
