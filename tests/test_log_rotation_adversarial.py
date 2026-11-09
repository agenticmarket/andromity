"""Adversarial tests for SharedRotatingFileHandler: several processes and threads sharing one size-rotated log.

Every test uses its own temporary folder and handler instances, never the real user log. Cross-process cases run
real worker processes; the deterministic race cases use extra file handles, which Windows treats exactly like
another process holding the file.
"""
import ctypes
import json
import logging
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import pytest

from andromity.core import debug_log
from andromity.core.debug_log import SharedRotatingFileHandler

SRC = Path(__file__).resolve().parents[1] / "src"
WINDOWS = sys.platform == "win32"
RECORD = re.compile(rb"<(W\d+)-(\d+)-(\d{6})\|(z*)\|END>")
windows_only = pytest.mark.skipif(not WINDOWS, reason="Windows file-sharing rules")

WORKER = r'''
import json, logging, os, sys, threading, time
from logging.handlers import RotatingFileHandler
cfg = json.loads(sys.argv[1])
from andromity.core import debug_log
if not os.path.normcase(os.path.abspath(debug_log.__file__)).startswith(os.path.normcase(os.path.abspath(cfg["src"]))):
    sys.exit("wrong andromity import: " + debug_log.__file__)
cls = debug_log.SharedRotatingFileHandler if cfg["kind"] == "shared" else RotatingFileHandler
handler = cls(cfg["path"], maxBytes=cfg["max_bytes"], backupCount=cfg["backups"], encoding="utf-8",
              delay=cfg["delay"])
handler.setFormatter(logging.Formatter("%(message)s"))
log = logging.getLogger("adv." + cfg["tag"])
log.propagate = False
log.setLevel(logging.DEBUG)
log.addHandler(handler)
pad = "z" * cfg["pad"]
slowest = [0.0]

def run(tid):
    for i in range(cfg["count"]):
        started = time.perf_counter()
        log.info("<%s-%d-%06d|%s|END>", cfg["tag"], tid, i, pad)
        took = time.perf_counter() - started
        if took > slowest[0]:
            slowest[0] = took
        if cfg["sleep"]:
            time.sleep(cfg["sleep"])

open(cfg["ready"], "w").close()
while not os.path.exists(cfg["go"]):
    time.sleep(0.002)
threads = [threading.Thread(target=run, args=(t,)) for t in range(cfg["threads"])]
for t in threads:
    t.start()
for t in threads:
    t.join()
if cfg["hold_until"]:
    deadline = time.monotonic() + 120
    while not os.path.exists(cfg["hold_until"]) and time.monotonic() < deadline:
        time.sleep(0.01)
handler.close()
print(json.dumps({"slowest": slowest[0]}))
'''


def _child_env(root: Path) -> Dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(SRC)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    home = root / "home"
    appdata = root / "appdata"
    home.mkdir(exist_ok=True)
    appdata.mkdir(exist_ok=True)
    env["APPDATA"] = str(appdata)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    return env


def _run_workers(root: Path, path: Path, workers: List[dict], timeout: float = 90.0,
                 on_busy_done: Optional[Callable[[], None]] = None) -> List[dict]:
    script = root / "worker.py"
    script.write_text(WORKER, encoding="utf-8")
    go = root / f"go-{uuid.uuid4().hex}"
    env = _child_env(root)
    defaults = {"kind": "shared", "threads": 1, "count": 1000, "pad": 60, "sleep": 0.0,
                "max_bytes": 64 * 1024, "backups": 3, "delay": True, "hold": False}
    procs = []
    readies = []
    for n, spec in enumerate(workers):
        ready = root / f"ready-{go.name}-{n}"
        readies.append(ready)
        cfg = {**defaults, **spec, "tag": f"W{n}", "path": str(path), "go": str(go), "ready": str(ready),
               "src": str(SRC)}
        cfg["hold_until"] = str(root / f"release-{go.name}") if cfg["hold"] else ""
        procs.append((cfg, subprocess.Popen(
            [sys.executable, str(script), json.dumps(cfg)], cwd=str(root), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )))
    deadline = time.monotonic() + 60
    while not all(r.exists() for r in readies):
        if time.monotonic() > deadline or any(p.poll() is not None for _, p in procs):
            for _, p in procs:
                p.kill()
            details = [p.communicate()[1].decode(errors="replace")[-2000:] for _, p in procs]
            pytest.fail(f"workers failed to start: {details}")
        time.sleep(0.01)
    go.write_text("go")
    results = []
    ordered = [item for item in procs if not item[0]["hold"]] + [item for item in procs if item[0]["hold"]]
    released = False
    for cfg, proc in ordered:
        if cfg["hold"] and not released:
            try:
                if on_busy_done is not None:
                    on_busy_done()
            finally:
                (root / f"release-{go.name}").write_text("go")
                released = True
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            for _, p in procs:
                p.kill()
            pytest.fail(f"worker {cfg['tag']} hung for more than {timeout}s")
        slowest = None
        if proc.returncode == 0 and out.strip():
            slowest = json.loads(out.decode().strip().splitlines()[-1])["slowest"]
        results.append({"cfg": cfg, "code": proc.returncode, "stderr": err.decode("utf-8", "replace"),
                        "slowest": slowest})
    return results


def _files_oldest_first(path: Path, backups: int) -> List[Path]:
    return [Path(f"{path}.{i}") for i in range(backups, 0, -1)] + [path]


def _scan(files: List[Path]) -> Tuple[List[Tuple[str, int, int, int]], List[bytes], int]:
    """Return (tag, thread, index, pad length) for each complete record in file order, broken lines, NUL bytes."""
    records = []
    broken = []
    nuls = 0
    for f in files:
        if not f.exists():
            continue
        data = f.read_bytes()
        nuls += data.count(b"\x00")
        for raw in data.split(b"\n"):
            line = raw.rstrip(b"\r")
            if not line:
                continue
            m = RECORD.fullmatch(line)
            if m is None:
                broken.append(line[:120])
                continue
            records.append((m.group(1).decode(), int(m.group(2)), int(m.group(3)), len(m.group(4))))
    return records, broken, nuls


def _expected_ids(results: List[dict]) -> set:
    ids = set()
    for r in results:
        cfg = r["cfg"]
        if cfg["kind"] != "shared":
            continue
        for t in range(cfg["threads"]):
            for i in range(cfg["count"]):
                ids.add((cfg["tag"], t, i))
    return ids


def _stderr_of_shared(results: List[dict]) -> Dict[str, str]:
    """Per shared-handler worker that wrote to stderr: traceback count, the distinct errors and where they came from."""
    noisy = {}
    for r in results:
        err = r["stderr"]
        if r["cfg"]["kind"] != "shared" or not err:
            continue
        reasons = sorted(set(re.findall(r"^(\w+Error[^\r\n]{0,90})", err, re.M)))
        sources = sorted(set(re.findall(r'File "[^"]*[\\/]([^"\\/]+)", line (\d+), in (\w+)', err)))
        noisy[r["cfg"]["tag"]] = (f"{err.count('--- Logging error ---')} tracebacks; {reasons}; "
                                  f"{[':'.join(s) for s in sources if s[0] != 'threading.py'][:6]}")
    return noisy


def _assert_quiet(results: List[dict]) -> None:
    noisy = _stderr_of_shared(results)
    assert not noisy, "shared-handler processes printed logging errors:\n" + "\n".join(
        f"{tag}: {summary}" for tag, summary in noisy.items())


def _history_gaps(records: List[Tuple[str, int, int, int]], tags: set) -> Dict[Tuple[str, int], int]:
    """Per writer: records missing from the middle of retained history (only the oldest may fall off the end)."""
    seen: Dict[Tuple[str, int], List[int]] = {}
    for tag, tid, idx, _ in records:
        if tag in tags:
            seen.setdefault((tag, tid), []).append(idx)
    gaps = {}
    for key, idxs in seen.items():
        unique = sorted(set(idxs))
        missing = (unique[-1] - unique[0] + 1) - len(unique)
        if missing:
            gaps[key] = missing
    return gaps


def _out_of_order(records: List[Tuple[str, int, int, int]], tags: set) -> Dict[Tuple[str, int], int]:
    """Per writer: places where, reading oldest file to live log, a record is older than one before it."""
    last: Dict[Tuple[str, int], int] = {}
    bad: Dict[Tuple[str, int], int] = {}
    for tag, tid, idx, _ in records:
        if tag not in tags:
            continue
        key = (tag, tid)
        if key in last and idx <= last[key]:
            bad[key] = bad.get(key, 0) + 1
        last[key] = idx
    return bad


def _handler(path: Path, max_bytes: int, backups: int, delay: bool = True) -> SharedRotatingFileHandler:
    h = SharedRotatingFileHandler(path, maxBytes=max_bytes, backupCount=backups, encoding="utf-8", delay=delay)
    h.setFormatter(logging.Formatter("%(message)s"))
    return h


def _logger(handler: logging.Handler) -> logging.Logger:
    log = logging.getLogger(f"advlog.{uuid.uuid4().hex}")
    log.propagate = False
    log.setLevel(logging.DEBUG)
    log.addHandler(handler)
    return log


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def _all_text(path: Path, backups: int) -> str:
    return "".join(_text(f) for f in _files_oldest_first(path, backups))


class _ExclusiveHold:
    """Open a file the way a locking viewer or backup tool would: read access, sharing only reads."""

    GENERIC_READ = 0x80000000
    FILE_SHARE_READ = 0x1
    OPEN_EXISTING = 3

    def __init__(self, path: Path) -> None:
        from ctypes import wintypes
        self._k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._k32.CreateFileW.restype = wintypes.HANDLE
        self._k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                          wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self._k32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle: Optional[int] = self._k32.CreateFileW(
            str(path), self.GENERIC_READ, self.FILE_SHARE_READ, None, self.OPEN_EXISTING, 0x80, None)
        if self.handle in (None, wintypes.HANDLE(-1).value):
            raise OSError(ctypes.get_last_error(), f"could not hold {path}")

    def release(self) -> None:
        if self.handle is not None:
            self._k32.CloseHandle(self.handle)
            self.handle = None


def test_module_under_test_is_this_checkout():
    assert os.path.normcase(str(Path(debug_log.__file__).resolve())).startswith(os.path.normcase(str(SRC)))


# ---------------------------------------------------------------------------------------------------------------
# Real processes sharing one log
# ---------------------------------------------------------------------------------------------------------------

def test_processes_appending_without_rotation_keep_every_record(tmp_path):
    path = tmp_path / "andromity.log"
    results = _run_workers(tmp_path, path, [{"count": 3000, "max_bytes": 1 << 30}] * 4)
    _assert_quiet(results)
    assert all(r["code"] == 0 for r in results)
    records, broken, nuls = _scan(_files_oldest_first(path, 3))
    found = [(t, tid, i) for t, tid, i, _ in records]
    expected = _expected_ids(results)
    missing = expected - set(found)
    assert not missing, (f"{len(missing)} of {len(expected)} records lost with plain concurrent appends; "
                         f"{len(broken)} torn lines, e.g. {broken[:2]}")
    assert len(found) == len(set(found))
    assert not broken and nuls == 0


def test_processes_rotating_keep_every_record_when_backups_can_hold_them(tmp_path):
    path = tmp_path / "andromity.log"
    backups = 300
    results = _run_workers(tmp_path, path, [
        {"count": 1500, "max_bytes": 32 * 1024, "backups": backups, "sleep": 0.001}] * 4)
    _assert_quiet(results)
    records, broken, nuls = _scan(_files_oldest_first(path, backups))
    found = [(t, tid, i) for t, tid, i, _ in records]
    expected = _expected_ids(results)
    missing = expected - set(found)
    dupes = len(found) - len(set(found))
    assert (len(missing), dupes, nuls, len(broken)) == (0, 0, 0, 0), (
        f"lost {len(missing)}/{len(expected)}, duplicated {dupes}, NUL bytes {nuls}, torn lines {len(broken)}")


def test_many_processes_rotating_often_never_print_logging_errors(tmp_path):
    path = tmp_path / "andromity.log"
    results = _run_workers(tmp_path, path, [
        {"count": 3000, "threads": 2, "pad": 200, "max_bytes": 64 * 1024, "backups": 3}] * 6)
    _assert_quiet(results)
    assert all(r["code"] == 0 for r in results)


def test_many_processes_rotating_at_once_leave_no_tiny_backups(tmp_path):
    path = tmp_path / "andromity.log"
    limit = 256 * 1024
    _run_workers(tmp_path, path, [
        {"count": 400, "threads": 2, "pad": 1000, "max_bytes": limit, "backups": 3}] * 16)
    sizes = {f.name: f.stat().st_size for f in _files_oldest_first(path, 3) if f.exists()}
    tiny = {name: size for name, size in sizes.items() if name != path.name and size < limit // 2}
    assert not tiny, f"overlapping rotations replaced a full backup with a near-empty one: {sizes}"


@pytest.fixture(scope="module")
def real_size_run(tmp_path_factory):
    """Three processes x two threads writing ~30 MB through the production limits (5 MB, 3 backups)."""
    root = tmp_path_factory.mktemp("realsize")
    path = root / "andromity.log"
    workers = [{"count": 5000, "threads": 2, "pad": 1000, "max_bytes": 5 * 1024 * 1024, "backups": 3}] * 3
    results = _run_workers(root, path, workers, timeout=120)
    records, broken, nuls = _scan(_files_oldest_first(path, 3))
    return {"path": path, "results": results, "records": records, "broken": broken, "nuls": nuls}


def test_real_size_run_is_quiet_and_does_not_hang(real_size_run):
    results = real_size_run["results"]
    _assert_quiet(results)
    assert all(r["code"] == 0 for r in results)
    slowest = max(r["slowest"] or 0.0 for r in results)
    assert slowest < 1.0, f"a single log call took {slowest:.2f}s"


def test_real_size_run_keeps_log_and_backups_bounded_and_full(real_size_run):
    path = real_size_run["path"]
    limit = 5 * 1024 * 1024
    sizes = {f.name: f.stat().st_size for f in _files_oldest_first(path, 3) if f.exists()}
    assert all(size <= limit * 5 // 4 for size in sizes.values()), sizes
    backups = {name: size for name, size in sizes.items() if name != path.name}
    assert len(backups) == 3, sizes
    tiny = {name: size for name, size in backups.items() if size < limit // 2}
    assert not tiny, f"backups overwritten by near-empty files (double rotation): {sizes}"
    assert not list(path.parent.glob("andromity.log.4"))


def test_real_size_run_has_no_nul_padding_or_torn_records(real_size_run):
    assert real_size_run["nuls"] == 0, f"{real_size_run['nuls']} NUL bytes written into the log"
    assert not real_size_run["broken"], f"{len(real_size_run['broken'])} torn lines: {real_size_run['broken'][:2]}"


def test_real_size_run_retained_history_has_no_holes(real_size_run):
    tags = {r["cfg"]["tag"] for r in real_size_run["results"]}
    gaps = _history_gaps(real_size_run["records"], tags)
    assert not gaps, f"records missing from the middle of retained history: {gaps}"


def test_real_size_run_newer_records_are_never_in_older_files(real_size_run):
    tags = {r["cfg"]["tag"] for r in real_size_run["results"]}
    assert not _out_of_order(real_size_run["records"], tags)


def test_stdlib_handler_process_alongside_does_not_break_shared_writers(tmp_path):
    path = tmp_path / "andromity.log"
    max_bytes = 32 * 1024
    results = _run_workers(tmp_path, path, [
        {"count": 2000, "max_bytes": max_bytes, "sleep": 0.0005},
        {"count": 2000, "max_bytes": max_bytes, "sleep": 0.0005},
        {"count": 2000, "max_bytes": max_bytes, "sleep": 0.0005, "kind": "stdlib"},
    ])
    _assert_quiet(results)
    assert all(r["code"] == 0 for r in results if r["cfg"]["kind"] == "shared")
    sizes = {f.name: f.stat().st_size for f in _files_oldest_first(path, 3) if f.exists()}
    assert all(size <= 2 * max_bytes for size in sizes.values()), sizes
    records, _, nuls = _scan(_files_oldest_first(path, 3))
    assert nuls == 0
    assert not _out_of_order(records, {"W0", "W1"})


def test_concurrent_huge_records_stay_intact(tmp_path):
    path = tmp_path / "andromity.log"
    backups = 60
    pad = 300_000
    results = _run_workers(tmp_path, path, [
        {"count": 12, "pad": pad, "max_bytes": 1024 * 1024, "backups": backups}] * 3)
    _assert_quiet(results)
    records, broken, nuls = _scan(_files_oldest_first(path, backups))
    whole = {(t, tid, i) for t, tid, i, n in records if n == pad}
    missing = _expected_ids(results) - whole
    assert (len(missing), len(broken), nuls) == (0, 0, 0), (
        f"{len(missing)} huge records lost or truncated, {len(broken)} torn lines, {nuls} NUL bytes")


# ---------------------------------------------------------------------------------------------------------------
# Deterministic interleavings (an extra handle stands in for another process)
# ---------------------------------------------------------------------------------------------------------------

def _fill_to_threshold(log: logging.Logger, path: Path, max_bytes: int, line: int = 100) -> int:
    """Log fixed-size records until one more would still fit but two would not."""
    count = 0
    while True:
        log.info("fill-%04d-%s", count, "f" * (line - 10))
        count += 1
        if path.stat().st_size + 2 * (line + 2) >= max_bytes:
            return count


def _write_backups(path: Path) -> None:
    for n, word in ((1, "BACKUP-ONE"), (2, "BACKUP-TWO"), (3, "BACKUP-THREE")):
        Path(f"{path}.{n}").write_text(f"{word}\n" * 20, encoding="utf-8")


def _backup_heads(path: Path) -> Dict[int, str]:
    return {n: _text(Path(f"{path}.{n}"))[:12] for n in (1, 2, 3)}


HOLDER = r'''
import msvcrt, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT)
msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
open(sys.argv[2], "w").close()
deadline = time.monotonic() + 60
while not os.path.exists(sys.argv[3]) and time.monotonic() < deadline:
    time.sleep(0.01)
'''


class _ChildLockHolder:
    """Another process holding the rotation lock, for example one frozen in a debugger mid-rotation."""

    def __init__(self, root: Path, lock_path: Path) -> None:
        tag = uuid.uuid4().hex
        self._ready = root / f"holder-ready-{tag}"
        self._release = root / f"holder-release-{tag}"
        script = root / f"holder-{tag}.py"
        script.write_text(HOLDER, encoding="utf-8")
        self._proc = subprocess.Popen([sys.executable, str(script), str(lock_path), str(self._ready),
                                       str(self._release)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 30
        while not self._ready.exists():
            if self._proc.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError(self._proc.communicate()[1].decode(errors="replace"))
            time.sleep(0.01)

    def release(self) -> None:
        self._release.write_text("go")
        try:
            self._proc.wait(10)
        except subprocess.TimeoutExpired:
            self._proc.kill()


@windows_only
def test_handle_like_an_old_version_on_the_log_costs_no_backups(tmp_path, capsys):
    """An older Andromity (stdlib handler) keeps the log open without delete sharing, so the log can't be renamed.
    Rotation is then declined by design; the backups must survive the declined attempts."""
    path = tmp_path / "andromity.log"
    _write_backups(path)
    handlers = [_handler(path, 4096, 3) for _ in range(3)]
    for h in handlers:
        h.RETRY_SECONDS = 0.05
    logs = [_logger(h) for h in handlers]
    old_version = None
    try:
        _fill_to_threshold(logs[0], path, 4096)
        old_version = open(path, "a", encoding="utf-8")
        for round_ in range(4):
            for n, log in enumerate(logs):
                log.info("held-%d-%d-%s", round_, n, "h" * 300)
            time.sleep(0.06)
        old_version.close()
        old_version = None
        time.sleep(0.06)
        logs[0].info("after-old-version-exits-%s", "a" * 300)
    finally:
        if old_version is not None:
            old_version.close()
        for h in handlers:
            h.close()
    assert capsys.readouterr().err == ""
    assert path.stat().st_size <= 4096, "rotation did not resume after the old version let go"
    history = _all_text(path, 3)
    assert "BACKUP-ONE" in history and "BACKUP-TWO" in history, (
        "declined rotations shifted the backups anyway and dropped history that a single real rotation keeps; "
        f"backups now start with {_backup_heads(path)}")


@windows_only
def test_idle_process_does_not_stop_rotation_in_process(tmp_path, capsys):
    """A process logs once and goes quiet (a daemon in a background window). Its handle follows the file into the
    backups; once that file is the oldest backup, replacing it must still work."""
    path = tmp_path / "andromity.log"
    idle = _handler(path, 4096, 3)
    busy = _handler(path, 4096, 3)
    idle_log, busy_log = _logger(idle), _logger(busy)
    try:
        idle_log.info("idle process says hello")
        for i in range(400):
            busy_log.info("busy-%04d-%s", i, "b" * 90)
        size_while_idle = path.stat().st_size
    finally:
        idle.close()
        busy.close()
    assert capsys.readouterr().err == ""
    assert size_while_idle <= 4096, (
        f"live log reached {size_while_idle} bytes (limit 4096): rotation stopped once the idle process's file "
        f"became andromity.log.3 and could not be replaced")


@windows_only
def test_idle_process_does_not_stop_rotation_across_processes(tmp_path):
    path = tmp_path / "andromity.log"
    limit = 64 * 1024
    seen: Dict[str, int] = {}

    def measure() -> None:
        seen["live"] = path.stat().st_size

    results = _run_workers(tmp_path, path, [
        {"count": 1, "hold": True},
        {"count": 6000, "pad": 200, "max_bytes": limit, "sleep": 0.0002},
    ], on_busy_done=measure)
    _assert_quiet(results)
    assert seen["live"] <= 2 * limit, (
        f"live log reached {seen['live']} bytes (limit {limit}) while one process sat idle with the log open")


@pytest.mark.parametrize("hold_seconds", [0.0, 0.8], ids=["waits-for-lock", "gives-up-on-lock"])
def test_two_processes_rotating_at_once_do_not_double_rotate(tmp_path, monkeypatch, capsys, hold_seconds):
    """While one process is inside its rotation, a second process finds the log full and logs."""
    path = tmp_path / "andromity.log"
    _write_backups(path)
    first = _handler(path, 4096, 3)
    second = _handler(path, 4096, 3)
    first_log, second_log = _logger(first), _logger(second)
    real_replace = os.replace
    state: Dict[str, object] = {}

    def replace_while_the_other_process_logs(src, dst):
        if "thread" not in state:
            def other_process() -> None:
                started = time.perf_counter()
                first_log.info("first-%s", "x" * 300)
                state["took"] = time.perf_counter() - started

            thread = threading.Thread(target=other_process)
            state["thread"] = thread
            thread.start()
            time.sleep(0.15 + hold_seconds)
        return real_replace(src, dst)

    try:
        _fill_to_threshold(first_log, path, 4096)
        monkeypatch.setattr(os, "replace", replace_while_the_other_process_logs)
        second_log.info("second-%s", "y" * 300)
        monkeypatch.setattr(os, "replace", real_replace)
        state["thread"].join(10)
    finally:
        monkeypatch.setattr(os, "replace", real_replace)
        first.close()
        second.close()
    assert capsys.readouterr().err == ""
    history = _all_text(path, 3)
    assert "first-x" in history and "second-y" in history
    assert "fill-0000" in _text(Path(f"{path}.1"))
    assert "BACKUP-ONE" in history and "BACKUP-TWO" in history, (
        f"two processes rotated for one full log; backups now start with {_backup_heads(path)}")


# ---------------------------------------------------------------------------------------------------------------
# Hostile filesystem states
# ---------------------------------------------------------------------------------------------------------------

def test_read_only_oldest_backup_does_not_let_log_grow_without_bound(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    for n in (1, 2, 3):
        Path(f"{path}.{n}").write_text(f"old backup {n}\n", encoding="utf-8")
    oldest = Path(f"{path}.3")
    os.chmod(oldest, stat.S_IREAD)
    h = _handler(path, 4096, 3)
    h.RETRY_SECONDS = 0.0
    log = _logger(h)
    try:
        for i in range(400):
            log.info("record-%04d-%s", i, "r" * 90)
    finally:
        h.close()
        os.chmod(oldest, stat.S_IREAD | stat.S_IWRITE)
    assert capsys.readouterr().err == ""
    assert "record-0399" in _text(path)
    assert path.stat().st_size <= 2 * 4096, (
        f"live log grew to {path.stat().st_size} bytes (limit 4096) because the oldest backup is read-only")


@windows_only
def test_locked_backup_then_released_keeps_history_and_recovers(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    for n, word in ((1, "BACKUP-ONE"), (2, "BACKUP-TWO"), (3, "BACKUP-THREE")):
        Path(f"{path}.{n}").write_text(f"{word}\n" * 20, encoding="utf-8")
    h = _handler(path, 4096, 3)
    h.RETRY_SECONDS = 0.2
    log = _logger(h)
    hold = _ExclusiveHold(Path(f"{path}.1"))
    slowest = 0.0
    try:
        for i in range(60):
            started = time.perf_counter()
            log.info("during-lock-%03d-%s", i, "d" * 90)
            slowest = max(slowest, time.perf_counter() - started)
        hold.release()
        time.sleep(0.3)
        for i in range(10):
            log.info("after-lock-%03d-%s", i, "a" * 90)
    finally:
        hold.release()
        h.close()
    assert capsys.readouterr().err == ""
    assert slowest < 0.5
    assert path.stat().st_size <= 4096, "rotation did not recover after the lock was released"
    assert "during-lock-000" in _text(Path(f"{path}.1"))
    texts = {n: _text(Path(f"{path}.{n}")) for n in (1, 2, 3)}
    assert "BACKUP-TWO" in "".join(texts.values()), (
        "a backup briefly held open by a reader cost a whole backup of history; backups now start with "
        + str({n: t[:12] for n, t in texts.items()}))
    assert len(set(texts.values())) == 3, "two backups are identical copies"


def test_log_folder_removed_before_first_record(tmp_path, capsys):
    folder = tmp_path / "andromity"
    folder.mkdir()
    path = folder / "andromity.log"
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        shutil.rmtree(folder)
        log.info("first record after the folder was removed")
        log.info("second record")
    finally:
        h.close()
    err = capsys.readouterr().err
    assert err == "", f"logging printed to stderr:\n{err[:600]}"
    assert "second record" in _text(path)


def test_log_path_is_a_directory(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    path.mkdir()
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        for i in range(3):
            log.info("record %d", i)
    finally:
        h.close()
    err = capsys.readouterr().err
    assert err == "", f"{err.count('Logging error')} tracebacks printed:\n{err[:400]}"


@windows_only
def test_live_log_locked_by_another_program_before_first_record(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    path.write_text("existing\n", encoding="utf-8")
    hold = _ExclusiveHold(path)
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        log.info("while another program holds the log")
        hold.release()
        log.info("after release")
    finally:
        hold.release()
        h.close()
    err = capsys.readouterr().err
    assert "after release" in _text(path)
    assert err == "", f"logging printed to stderr:\n{err[:400]}"


def test_importing_module_survives_log_folder_being_a_file(tmp_path):
    env = _child_env(tmp_path)
    Path(env["APPDATA"], "andromity").write_text("not a folder", encoding="utf-8")
    Path(env["HOME"], ".andromity").write_text("not a folder", encoding="utf-8")
    proc = subprocess.run([sys.executable, "-c", "import andromity.core.debug_log"], env=env, cwd=str(tmp_path),
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, f"import crashed: {proc.stderr.strip().splitlines()[-1:]}"


# ---------------------------------------------------------------------------------------------------------------
# Rotation lock, readers, deletions, older versions, cost
# ---------------------------------------------------------------------------------------------------------------

@windows_only
def test_rotation_lock_held_by_another_process_does_not_slow_every_call(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    h = _handler(path, 4096, 3)
    log = _logger(h)
    holder = None
    timings: List[float] = []
    try:
        _fill_to_threshold(log, path, 4096)
        holder = _ChildLockHolder(tmp_path, Path(f"{path}.lock"))
        for i in range(6):
            started = time.perf_counter()
            log.info("while-lock-held-%d-%s", i, "w" * 300)
            timings.append(time.perf_counter() - started)
    finally:
        if holder is not None:
            holder.release()
        h.close()
    assert capsys.readouterr().err == ""
    assert "while-lock-held-5" in _text(path)
    slow = [round(t, 2) for t in timings if t > 0.1]
    assert len(slow) <= 1, f"{len(slow)} of {len(timings)} log calls each waited for the held lock: {slow}s"


@pytest.mark.parametrize("kind", ["read-only", "directory"])
def test_unusable_rotation_lock_does_not_let_log_grow_without_bound(tmp_path, capsys, kind):
    path = tmp_path / "andromity.log"
    lock = Path(f"{path}.lock")
    if kind == "directory":
        lock.mkdir()
    else:
        lock.write_text("", encoding="utf-8")
        os.chmod(lock, stat.S_IREAD)
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        for i in range(400):
            log.info("record-%04d-%s", i, "r" * 90)
    finally:
        h.close()
        if kind != "directory":
            os.chmod(lock, stat.S_IREAD | stat.S_IWRITE)
    assert capsys.readouterr().err == ""
    assert "record-0399" in _text(path)
    assert path.stat().st_size <= 2 * 4096, (
        f"live log grew to {path.stat().st_size} bytes (limit 4096) because {lock.name} is a {kind}")


def test_rotation_lock_file_deleted_between_rotations(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    lock = Path(f"{path}.lock")
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        for i in range(60):
            log.info("first-%03d-%s", i, "f" * 90)
        assert Path(f"{path}.1").exists()
        if lock.exists():
            lock.unlink()
        for i in range(60):
            log.info("second-%03d-%s", i, "s" * 90)
    finally:
        h.close()
    assert capsys.readouterr().err == ""
    assert path.stat().st_size <= 4096
    assert "second-059" in _text(path)


@windows_only
@pytest.mark.parametrize("held", [1, 2, 3])
def test_reader_holding_a_backup_delays_rotation_without_losing_history(tmp_path, capsys, held):
    path = tmp_path / "andromity.log"
    _write_backups(path)
    h = _handler(path, 4096, 3)
    h.RETRY_SECONDS = 0.1
    log = _logger(h)
    reader = open(f"{path}.{held}", "rb")
    try:
        _fill_to_threshold(log, path, 4096)
        for i in range(20):
            log.info("while-read-%02d-%s", i, "r" * 90)
        reader.close()
        time.sleep(0.15)
        log.info("after-reader-closed")
    finally:
        reader.close()
        h.close()
    assert capsys.readouterr().err == ""
    assert _text(path).startswith("after-reader-closed"), "rotation did not resume after the reader closed"
    heads = _backup_heads(path)
    assert heads[1].startswith("fill-0000") and heads[2] == "BACKUP-ONE\nB" and heads[3] == "BACKUP-TWO\nB", heads


def test_log_deleted_repeatedly_while_processes_write(tmp_path):
    path = tmp_path / "andromity.log"
    stop = threading.Event()
    deletions = [0]

    def deleter() -> None:
        deadline = time.monotonic() + 1.5
        while not stop.is_set() and time.monotonic() < deadline:
            try:
                os.remove(path)
                deletions[0] += 1
            except OSError:
                pass
            time.sleep(0.02)

    thread = threading.Thread(target=deleter)
    thread.start()
    try:
        results = _run_workers(tmp_path, path, [
            {"count": 3000, "threads": 2, "sleep": 0.0004, "max_bytes": 1 << 30}] * 3)
    finally:
        stop.set()
        thread.join()
    _assert_quiet(results)
    assert deletions[0] > 0
    records, broken, nuls = _scan([path])
    last = {(t, tid, i) for t, tid, i, _ in records}
    expected_last = {(r["cfg"]["tag"], tid, 2999) for r in results for tid in range(2)}
    assert expected_last <= last, f"newest records missing after deletions: {expected_last - last}"
    assert not broken and nuls == 0


def test_old_version_process_loses_no_records_alongside_shared_writers(tmp_path):
    """An older Andromity (stdlib handler, opened at import) logs alongside two current processes."""
    path = tmp_path / "andromity.log"
    backups = 200
    results = _run_workers(tmp_path, path, [
        {"count": 3000, "max_bytes": 32 * 1024, "backups": backups, "sleep": 0.0003},
        {"count": 3000, "max_bytes": 32 * 1024, "backups": backups, "sleep": 0.0003},
        {"count": 3000, "max_bytes": 32 * 1024, "backups": backups, "sleep": 0.0003, "kind": "stdlib",
         "delay": False},
    ])
    _assert_quiet(results)
    old = next(r for r in results if r["cfg"]["kind"] == "stdlib")
    records, _, _ = _scan(_files_oldest_first(path, backups))
    old_found = {i for t, _, i, _ in records if t == old["cfg"]["tag"]}
    errors = sorted(set(re.findall(r"^(\w+Error)", old["stderr"], re.M)))
    assert len(old_found) == 3000, (
        f"old-version process lost {3000 - len(old_found)} of 3000 records; its own rotation failed "
        f"{old['stderr'].count('--- Logging error ---')} times with {errors}")


def test_very_high_rate_many_processes_keep_every_record_in_order(tmp_path):
    path = tmp_path / "andromity.log"
    backups = 100
    results = _run_workers(tmp_path, path, [
        {"count": 1200, "threads": 4, "pad": 60, "max_bytes": 48 * 1024, "backups": backups}] * 8)
    _assert_quiet(results)
    records, broken, nuls = _scan(_files_oldest_first(path, backups))
    found = [(t, tid, i) for t, tid, i, _ in records]
    expected = _expected_ids(results)
    missing = expected - set(found)
    assert (len(missing), len(found) - len(set(found)), len(broken), nuls) == (0, 0, 0, 0), (
        f"lost {len(missing)}, duplicated {len(found) - len(set(found))}, torn {len(broken)}, NUL bytes {nuls}")
    assert not _out_of_order(records, {r["cfg"]["tag"] for r in results})
    assert not Path(f"{path}.{backups + 1}").exists()


def _per_record_microseconds(handler: logging.Handler, count: int) -> float:
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)-8s] %(name)s: %(message)s"))
    log = _logger(handler)
    started = time.perf_counter()
    for i in range(count):
        log.debug("record %d %s", i, "x" * 80)
    took = time.perf_counter() - started
    handler.close()
    return took / count * 1e6


def test_per_record_cost_stays_close_to_the_standard_handler(tmp_path):
    std = min(_per_record_microseconds(logging.FileHandler(tmp_path / f"std{n}.log", encoding="utf-8"), 5000)
              for n in range(2))
    ours = min(_per_record_microseconds(
        SharedRotatingFileHandler(tmp_path / f"ours{n}.log", maxBytes=50 << 20, backupCount=3), 5000)
        for n in range(2))
    assert ours < 300 and ours < 5 * std, f"{ours:.0f} us per record against {std:.0f} us for FileHandler"


@windows_only
def test_live_log_locked_exclusively_does_not_make_every_call_slow(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    path.write_text("existing\n", encoding="utf-8")
    hold = _ExclusiveHold(path)
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        started = time.perf_counter()
        for i in range(50):
            log.info("while-locked %d", i)
        mean_ms = (time.perf_counter() - started) / 50 * 1000
    finally:
        hold.release()
        h.close()
    assert capsys.readouterr().err == ""
    assert mean_ms < 2.0, f"each log call took {mean_ms:.1f} ms while another program held the log exclusively"


def test_unicode_log_folder_and_plain_newlines(tmp_path, capsys):
    folder = tmp_path / "Jürgen 日本 \U0001F600"
    folder.mkdir()
    path = folder / "andromity.log"
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        for i in range(80):
            log.info("ünïcode-%03d-%s", i, "u" * 90)
    finally:
        h.close()
    assert capsys.readouterr().err == ""
    assert Path(f"{path}.1").exists()
    assert "ünïcode-079" in _text(path)
    assert b"\r" not in path.read_bytes()


# ---------------------------------------------------------------------------------------------------------------
# Odd records
# ---------------------------------------------------------------------------------------------------------------

def test_lone_surrogate_text_is_logged_not_dropped(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        log.info("tool output: %s", b"caf\xe9 \xff".decode("utf-8", "surrogateescape"))
        log.info("next record")
    finally:
        h.close()
    err = capsys.readouterr().err
    assert err == "", f"logging printed to stderr:\n{err[-300:]}"
    assert "tool output: caf" in _text(path), "record with undecodable bytes was dropped"


def test_bad_format_arguments_behave_like_standard_logging(tmp_path, capsys):
    """Standard behaviour, accepted: a record whose arguments don't fit its format string is reported through
    Handler.handleError exactly as the standard library's FileHandler does, and logging carries on."""
    path = tmp_path / "andromity.log"
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        log.info("%d files", "three")
        log.info("after")
    finally:
        h.close()
    ours = capsys.readouterr().err
    stdlib_path = tmp_path / "stdlib.log"
    std = logging.FileHandler(stdlib_path, encoding="utf-8")
    std_log = _logger(std)
    try:
        std_log.info("%d files", "three")
    finally:
        std.close()
    theirs = capsys.readouterr().err
    assert "after" in _text(path)
    assert ours.count("--- Logging error ---") == theirs.count("--- Logging error ---") == 1


def test_record_bigger_than_limit_is_kept_whole_and_files_stay_bounded(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    h = _handler(path, 4096, 3)
    log = _logger(h)
    huge = "H" * 20000
    try:
        log.info("small-before")
        log.info(huge)
        log.info("small-after")
        log.info(huge)
        log.info("newest")
    finally:
        h.close()
    assert capsys.readouterr().err == ""
    existing = [f for f in _files_oldest_first(path, 3) if f.exists()]
    assert not Path(f"{path}.4").exists()
    whole = sum(_text(f).count(huge) for f in existing)
    assert whole == 2
    assert "newest" in _text(path)
    assert "small-after" in _all_text(path, 3)
    for f in existing:
        assert f.stat().st_size <= 4096 or _text(f).strip() in (huge, f"{huge}\nnewest", "newest")


def test_multiline_records_do_not_overshoot_the_limit(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    h = _handler(path, 4096, 3)
    log = _logger(h)
    try:
        for i in range(120):
            log.info("traceback %03d\n%s", i, "\n".join(["  frame"] * 40))
    finally:
        h.close()
    assert capsys.readouterr().err == ""
    sizes = {f.name: f.stat().st_size for f in _files_oldest_first(path, 3) if f.exists()}
    assert all(size <= 4096 for size in sizes.values()), f"files over the 4096-byte limit: {sizes}"


# ---------------------------------------------------------------------------------------------------------------
# Threads, lifecycle, retry behaviour
# ---------------------------------------------------------------------------------------------------------------

def test_threads_in_one_process_keep_every_record_in_order(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    backups = 150
    h = _handler(path, 32 * 1024, backups)
    log = _logger(h)
    threads_n, count = 8, 1200
    errors: List[BaseException] = []

    def run(tid: int) -> None:
        try:
            for i in range(count):
                log.info("<W0-%d-%06d|%s|END>", tid, i, "z" * 60)
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(t,)) for t in range(threads_n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    h.close()
    assert not any(t.is_alive() for t in threads), "a logging thread hung"
    assert not errors
    assert capsys.readouterr().err == ""
    records, broken, nuls = _scan(_files_oldest_first(path, backups))
    found = [(tid, i) for _, tid, i, _ in records]
    assert len(found) == threads_n * count == len(set(found))
    assert not broken and nuls == 0
    for tid in range(threads_n):
        order = [i for t, i in found if t == tid]
        assert order == sorted(order)


def test_delay_with_nothing_logged_creates_no_file_and_closes_twice(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    h = _handler(path, 4096, 3)
    h.close()
    h.close()
    assert not path.exists()
    assert capsys.readouterr().err == ""


def test_use_after_close_is_quiet_and_releases_the_file(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    h = _handler(path, 4096, 3)
    log = _logger(h)
    log.info("before close")
    h.close()
    log.info("after close")
    h.close()
    assert capsys.readouterr().err == ""
    moved = tmp_path / "moved.log"
    os.replace(path, moved)
    assert "before close" in _text(moved)


@windows_only
def test_failed_rotation_does_not_make_every_call_slow(tmp_path, capsys):
    path = tmp_path / "andromity.log"
    for n in (1, 2, 3):
        Path(f"{path}.{n}").write_text(f"old {n}\n", encoding="utf-8")
    h = _handler(path, 2 * 1024 * 1024, 3)
    log = _logger(h)
    big = "b" * 4000
    try:
        for i in range(500):
            log.info("%04d %s", i, big)
        other = open(path, "a", encoding="utf-8")
        hold = _ExclusiveHold(Path(f"{path}.1"))
        timings = []
        try:
            for i in range(400):
                started = time.perf_counter()
                log.info("%04d %s", i, big)
                timings.append(time.perf_counter() - started)
        finally:
            hold.release()
            other.close()
    finally:
        h.close()
    assert capsys.readouterr().err == ""
    slow = [t for t in timings if t > 0.02]
    assert len(slow) <= 2, f"{len(slow)} of {len(timings)} calls took >20ms while rotation was failing"
