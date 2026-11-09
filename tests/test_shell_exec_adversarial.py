"""Adversarial tests for shell_exec: it must return, stop what it started, and keep its output format.

Every helper process these tests start is a copy of ``helper.py`` written into a unique
folder. Each one records its PID and creation time there, exits on its own after a
lifetime cap or when a STOP file appears, and is only ever killed by that verified PID.
"""
import ctypes
import gc
import importlib.util
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
import uuid
import warnings
from ctypes import wintypes
from pathlib import Path

import pytest

from andromity.core import tools
from andromity.core.receipt import _EXIT_LINE
from andromity.core.session import Session
from andromity.core.tools import _current_session_var, shell_exec, stop_session_commands

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows process semantics")

PY = getattr(sys, "_base_executable", None) or sys.executable
SRC_DIR = Path(tools.__file__).resolve().parents[2]
STOPPED = "Stopped: the user cancelled this command before it finished."
LEFTOVER_NOTE = (
    "Note: the command finished, but something it started kept running and held its output open, "
    "so everything the command started was stopped. "
    "Start servers, watchers and other long-running programs with shell_bg."
)
MIB = 1024 * 1024
LEFTOVER_BOUND = 12.0
HANG_DEADLINE = 25.0

HELPER = r'''
import ctypes, os, subprocess, sys, time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
PIDS = os.path.join(HERE, "pids")
STOP = os.path.join(HERE, "STOP")
PY = sys.executable
SELF = os.path.abspath(__file__)

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
k32.OpenProcess.restype = wintypes.HANDLE
k32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
k32.GetProcessTimes.restype = wintypes.BOOL
k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
k32.GetExitCodeProcess.restype = wintypes.BOOL
k32.GetCurrentProcess.restype = wintypes.HANDLE
k32.CloseHandle.argtypes = (wintypes.HANDLE,)
k32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
k32.TerminateProcess.restype = wintypes.BOOL

QUERY = 0x1000
TERMINATE = 0x0001
STILL_ACTIVE = 259
DEVNULL = subprocess.DEVNULL


def _ctime(handle):
    times = [wintypes.FILETIME() for _ in range(4)]
    if not k32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
        return None
    return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime


def register(role):
    os.makedirs(PIDS, exist_ok=True)
    tag = os.environ.get("ADV_TAG", "top") + ":" + role
    tmp = os.path.join(PIDS, "%d.tmp" % os.getpid())
    with open(tmp, "w") as f:
        f.write("%d %s" % (_ctime(k32.GetCurrentProcess()), tag))
    os.replace(tmp, os.path.join(PIDS, str(os.getpid())))


def registered():
    out = {}
    if os.path.isdir(PIDS):
        for name in os.listdir(PIDS):
            if not name.isdigit():
                continue
            try:
                with open(os.path.join(PIDS, name)) as f:
                    ct, tag = f.read().split(" ", 1)
            except (OSError, ValueError):
                continue
            out[int(name)] = (int(ct), tag)
    return out


def is_alive(pid, ct):
    h = k32.OpenProcess(QUERY, False, pid)
    if not h:
        return False
    try:
        if _ctime(h) != ct:
            return False
        code = wintypes.DWORD()
        k32.GetExitCodeProcess(h, ctypes.byref(code))
        return code.value == STILL_ACTIVE
    finally:
        k32.CloseHandle(h)


def alive(suffix=""):
    return sorted(p for p, (ct, tag) in registered().items() if tag.endswith(suffix) and is_alive(p, ct))


def terminate(pid, ct):
    h = k32.OpenProcess(QUERY | TERMINATE, False, pid)
    if not h:
        return False
    try:
        if _ctime(h) != ct:
            return False
        return bool(k32.TerminateProcess(h, 1))
    finally:
        k32.CloseHandle(h)


def stopped():
    return os.path.exists(STOP)


def hold(seconds):
    end = time.monotonic() + float(seconds)
    while time.monotonic() < end and not stopped():
        time.sleep(0.05)


def wait_registered(pid, limit=20.0):
    path = os.path.join(PIDS, str(pid))
    end = time.monotonic() + limit
    while time.monotonic() < end:
        if os.path.exists(path):
            return True
        time.sleep(0.02)
    return False


def spawn(argv, kind, wait=True):
    cmd = [PY, SELF] + [str(a) for a in argv]
    env = dict(os.environ, ADV_TAG=kind)
    sys.stdout.flush()
    sys.stderr.flush()
    if kind == "inherit":
        p = subprocess.Popen(cmd, close_fds=False, env=env)
    elif kind == "stdout":
        p = subprocess.Popen(cmd, stdin=DEVNULL, stdout=sys.stdout, stderr=DEVNULL, env=env)
    elif kind == "stderr":
        p = subprocess.Popen(cmd, stdin=DEVNULL, stdout=DEVNULL, stderr=sys.stderr, env=env)
    elif kind == "none":
        p = subprocess.Popen(cmd, stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, env=env)
    elif kind == "detached":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        p = subprocess.Popen(cmd, stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, env=env, creationflags=flags)
    elif kind == "breakaway":
        try:
            p = subprocess.Popen(cmd, close_fds=False, env=env, creationflags=subprocess.CREATE_BREAKAWAY_FROM_JOB)
        except OSError as e:
            say("SPAWN-FAILED %s" % e)
            raise SystemExit(9)
    else:
        raise SystemExit("unknown kind " + kind)
    if wait:
        wait_registered(p.pid)
    return p


def say(text, stream=None):
    try:
        print(text, file=stream or sys.stdout, flush=True)
        return True
    except OSError:
        return False


def deny_terminate():
    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.ULONG))
    adv.GetSecurityDescriptorDacl.argtypes = (
        ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL))
    adv.SetSecurityInfo.argtypes = (
        wintypes.HANDLE, ctypes.c_int, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
    sd = ctypes.c_void_p()
    if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            "D:(D;;0x0001;;;WD)(A;;0x1FFFFF;;;WD)", 1, ctypes.byref(sd), None):
        return False
    present, defaulted, dacl = wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
    adv.GetSecurityDescriptorDacl(sd, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted))
    return adv.SetSecurityInfo(k32.GetCurrentProcess(), 6, 4, None, None, dacl, None) == 0


def main(argv):
    role = argv[0]
    if role == "hold":
        register("hold")
        hold(argv[1])
    elif role == "say_hold":
        register("hold")
        say(argv[1])
        hold(argv[2])
    elif role in ("spawn", "spawn_quiet"):
        register("launcher")
        for part in argv[1].split(","):
            kind, count = part.split(":")
            for _ in range(int(count)):
                spawn(argv[2:], kind)
        if role == "spawn":
            say("launcher-done")
    elif role == "chain":
        register("chain")
        depth = int(argv[1])
        if depth == 0:
            say("chain-bottom")
            hold(argv[2])
        else:
            spawn(["chain", depth - 1, argv[2]], "inherit")
            say("chain-%d" % depth)
    elif role == "late_child":
        register("hold")
        end = time.monotonic() + float(argv[1])
        while time.monotonic() < end and not stopped():
            time.sleep(0.02)
        say("LATE-OUTPUT")
        hold(argv[2])
    elif role == "flood_child":
        register("hold")
        limit = int(argv[2])
        chunk = b"F" * 65535 + b"\n"
        written = 0
        try:
            while written < limit and not stopped():
                sys.stdout.buffer.write(chunk)
                written += len(chunk)
            sys.stdout.flush()
        except OSError:
            pass
        hold(argv[1])
    elif role == "flood":
        n_out, n_err = int(argv[1]), int(argv[2])
        out_chunk = b"0123456789abcdef" * 4095 + b"0123456789abcde\n"
        err_chunk = b"EEEEEEEEEEEEEEEE" * 4095 + b"EEEEEEEEEEEEEEE\n"
        while n_out or n_err:
            if n_out:
                sys.stdout.buffer.write(out_chunk)
                n_out -= 1
            if n_err:
                sys.stderr.buffer.write(err_chunk)
                n_err -= 1
        if len(argv) > 3:
            sys.stdout.buffer.write(b"Z" * int(argv[3]))
            sys.stderr.buffer.write(b"Y" * int(argv[4]))
        sys.stdout.flush()
        sys.stderr.flush()
    elif role == "flood_forever":
        chunk = b"Q" * 65535 + b"\n"
        try:
            while not stopped():
                sys.stdout.buffer.write(chunk)
                sys.stderr.buffer.write(chunk)
        except OSError:
            pass
    elif role == "rawio":
        for path, stream in ((argv[1], sys.stdout.buffer), (argv[2], sys.stderr.buffer)):
            if path != "-":
                with open(path, "rb") as f:
                    stream.write(f.read())
                stream.flush()
        raise SystemExit(int(argv[3]))
    elif role == "undying":
        register("hold")
        say("UNDYING-OK" if deny_terminate() else "UNDYING-FAILED")
        hold(argv[1])
    elif role == "breakaway":
        register("launcher")
        cmd = [PY, SELF, "hold", "3"]
        env = dict(os.environ, ADV_TAG="breakaway")
        try:
            p = subprocess.Popen(cmd, stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, env=env,
                                 creationflags=subprocess.CREATE_BREAKAWAY_FROM_JOB)
            wait_registered(p.pid)
            say("BREAKAWAY-OK")
        except OSError as e:
            say("BREAKAWAY-FAILED %s" % e)
    elif role == "npm":
        register("npm")
        say("> app@1.0 start")
        spawn(["server_child", argv[1]], "inherit")
        end = time.monotonic() + float(argv[1])
        while time.monotonic() < end and not stopped():
            say("npm-alive")
            time.sleep(0.2)
    elif role == "server_child":
        register("hold")
        end = time.monotonic() + float(argv[1])
        talking = True
        while time.monotonic() < end and not stopped():
            if talking:
                talking = say("ready - started server on 0.0.0.0:3101")
            time.sleep(0.2)
    else:
        raise SystemExit("unknown role " + role)


if __name__ == "__main__":
    main(sys.argv[1:])
'''

JOBRUNNER = r'''
import ctypes, json, os, pathlib, sys, threading, time
from ctypes import wintypes

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import helper

cfg, src, result_path = sys.argv[1], sys.argv[2], sys.argv[3]
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateJobObjectW.restype = wintypes.HANDLE
k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
k32.GetCurrentProcess.restype = wintypes.HANDLE


class BASIC(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class IOC(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint64) for n in ("a", "b", "c", "d", "e", "f")]


class EXT(ctypes.Structure):
    _fields_ = [("Basic", BASIC), ("Io", IOC), ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


job = k32.CreateJobObjectW(None, None)
ext = EXT()
flags = 0x2000
if cfg == "libuv":
    flags |= 0x800 | 0x1000 | 0x400
if cfg == "breakaway_ok":
    flags |= 0x800
ext.Basic.LimitFlags = flags
k32.SetInformationJobObject(job, 9, ctypes.byref(ext), ctypes.sizeof(ext))
if cfg == "ui":
    ui = wintypes.DWORD(0x1 | 0x2 | 0x4)
    k32.SetInformationJobObject(job, 4, ctypes.byref(ui), ctypes.sizeof(ui))
assigned = bool(k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()))

sys.path.insert(0, src)
from andromity.core import tools
tools._is_trusted = lambda: True
tools._get_project_root = lambda: pathlib.Path(here)
helper.register("jobrunner")
cmd = "& '%s' '%s' spawn inherit:1 hold 60" % (helper.PY, os.path.join(here, "helper.py"))
box = {}


def run():
    try:
        box["out"] = tools.shell_exec(cmd, timeout=600)
    except BaseException as e:
        box["exc"] = repr(e)


t0 = time.monotonic()
th = threading.Thread(target=run, daemon=True)
th.start()
th.join(25)
elapsed = time.monotonic() - t0
holders = helper.alive(":hold")
with open(result_path, "w") as f:
    json.dump({"assigned": assigned, "hung": th.is_alive(), "elapsed": elapsed, "out": box.get("out"),
               "exc": box.get("exc"), "alive_holders": holders}, f)
os._exit(0)
'''


def _ps_quote(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


class Result:
    def __init__(self, thread, box, elapsed):
        self.thread = thread
        self.out = box.get("out")
        self.exc = box.get("exc")
        self.elapsed = elapsed

    @property
    def hung(self) -> bool:
        return self.thread.is_alive()


class Lab:
    def __init__(self, root: Path):
        self.root = root
        self.helper_path = root / "helper.py"
        self.helper_path.write_text(HELPER, encoding="utf-8")
        spec = importlib.util.spec_from_file_location(f"adv_helper_{root.name.replace('-', '_')}", self.helper_path)
        self.h = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.h)
        self.threads = []

    def cmd(self, *args) -> str:
        return "& " + " ".join(_ps_quote(a) for a in (PY, self.helper_path, *args))

    def start(self, command, timeout=600, session=None):
        box = {}

        def target():
            token = _current_session_var.set(session) if session is not None else None
            try:
                box["out"] = shell_exec(command, timeout=timeout)
            except BaseException as e:  # noqa: BLE001 - surfaced to the test as a failure
                box["exc"] = e
            finally:
                if token is not None:
                    _current_session_var.reset(token)
                box["end"] = time.monotonic()

        thread = threading.Thread(target=target, daemon=True, name="adv-shell-exec")
        self.threads.append(thread)
        box["start"] = time.monotonic()
        thread.start()
        return thread, box

    def finish(self, thread, box, deadline=HANG_DEADLINE) -> Result:
        thread.join(max(0.0, box["start"] + deadline - time.monotonic()))
        end = box.get("end", time.monotonic())
        if not thread.is_alive():
            self.threads.remove(thread)
        return Result(thread, box, end - box["start"])

    def run(self, command, timeout=600, deadline=HANG_DEADLINE, session=None) -> Result:
        thread, box = self.start(command, timeout, session)
        return self.finish(thread, box, deadline)

    def alive(self, suffix=""):
        return self.h.alive(suffix)

    def wait_for(self, predicate, limit=20.0) -> bool:
        end = time.monotonic() + limit
        while time.monotonic() < end:
            if predicate():
                return True
            time.sleep(0.05)
        return False

    def wait_dead(self, suffix="", limit=3.0) -> list:
        self.wait_for(lambda: not self.alive(suffix), limit)
        return self.alive(suffix)

    def cleanup(self):
        (self.root / "STOP").write_text("stop", encoding="utf-8")
        self.wait_for(lambda: not self.alive(), 6.0)
        for pid, (ct, _tag) in self.h.registered().items():
            if self.h.is_alive(pid, ct):
                self.h.terminate(pid, ct)
        for thread in self.threads:
            thread.join(15)


@pytest.fixture
def lab(tmp_path, monkeypatch):
    shell = tools.get_shell().lower()
    if "powershell" not in shell and "pwsh" not in shell:
        pytest.skip("these tests drive PowerShell")
    root = tmp_path / f"adv-{uuid.uuid4().hex[:10]}"
    root.mkdir()
    if " " in str(root) or " " in PY:
        pytest.skip("cmd /c tests need space-free paths")
    monkeypatch.setattr(tools, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools, "_get_project_root", lambda: root)
    the_lab = Lab(root)
    yield the_lab
    the_lab.cleanup()


def assert_returned(res: Result, within: float):
    assert not res.hung, f"shell_exec never returned (still blocked after {HANG_DEADLINE}s)"
    assert res.exc is None, f"shell_exec raised {res.exc!r}"
    assert res.elapsed < within, f"shell_exec took {res.elapsed:.1f}s, expected under {within}s; output={res.out!r}"


def assert_leftover_note(out: str):
    assert LEFTOVER_NOTE in out, f"expected the leftover note, got {out[-400:]!r}"


def note_count(out: str):
    m = re.search(r"\b(\d+) process", out)
    return int(m.group(1)) if m else None


# --- 1-3: returns, stops leftovers ------------------------------------------------------------


def test_real_bug_shape_is_stopped_at_the_timeout_with_its_output(lab):
    res = lab.run(lab.cmd("npm", 60) + " 2>&1 | Select-Object -First 3", timeout=6)
    assert_returned(res, 6 + 10)
    assert res.out.startswith("Error: Command timed out after 6 seconds"), res.out
    head, sep, partial = res.out.partition("\nOutput before it was stopped:\n")
    assert sep, f"the timeout message should carry the output collected so far: {res.out!r}"
    assert partial.startswith("> app@1.0 start"), partial
    assert "shell_bg" in head
    assert lab.wait_dead() == [], "the npm process and its server must be stopped"


def _process_ctime(pid: int):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.OpenProcess.restype = wintypes.HANDLE
    handle = k32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        return lab_ctime(handle)
    finally:
        k32.CloseHandle(wintypes.HANDLE(handle))


def lab_ctime(handle):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    code = wintypes.DWORD()
    k32.GetExitCodeProcess(handle, ctypes.byref(code))
    if code.value != 259:
        return None
    times = [wintypes.FILETIME() for _ in range(4)]
    k32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times])
    return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime


NPM_SERVER = r'''
const fs = require('fs'); const path = require('path');
fs.writeFileSync(path.join(__dirname, 'server.pid'), String(process.pid));
const stop = path.join(__dirname, 'STOP');
const end = Date.now() + 60000;
process.stdout.on('error', () => {});
const t = setInterval(() => {
  if (Date.now() > end || fs.existsSync(stop)) { clearInterval(t); process.exit(0); }
  try { process.stdout.write('ready - started server on 0.0.0.0:3101\n'); } catch (e) {}
}, 200);
'''


@pytest.mark.skipif(not __import__("shutil").which("npm"), reason="needs npm")
def test_real_npm_start_behind_select_first(lab):
    timeout = 10
    (lab.root / "package.json").write_text(
        json.dumps({"name": "adv-npm-probe", "version": "1.0.0", "private": True,
                    "scripts": {"start": "node server.js"}}), encoding="utf-8")
    (lab.root / "server.js").write_text(NPM_SERVER, encoding="utf-8")
    res = lab.run("npm start -- -p 3101 2>&1 | Select-Object -First 8", timeout=timeout, deadline=timeout + 25)
    pid_file = lab.root / "server.pid"
    pid = int(pid_file.read_text()) if pid_file.exists() else None
    ctime = _process_ctime(pid) if pid else None
    try:
        assert_returned(res, timeout + 15)
        assert res.out.startswith(f"Error: Command timed out after {timeout} seconds"), res.out
        partial = res.out.partition("\nOutput before it was stopped:\n")[2]
        assert "> adv-npm-probe@1.0.0 start" in partial, res.out
        assert partial.count("ready - started server on 0.0.0.0:3101") >= 3, partial
        assert ctime is None, "the npm-started server must not survive"
    finally:
        (lab.root / "STOP").write_text("stop", encoding="utf-8")
        res.thread.join(10)
        if pid and ctime and _process_ctime(pid) == ctime:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10)


@pytest.mark.parametrize("kind", ["inherit", "stdout", "stderr"])
def test_orphan_holding_output_is_stopped_and_reported(lab, kind):
    res = lab.run(lab.cmd("spawn", f"{kind}:1", "hold", 60), timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert res.out.startswith("launcher-done"), res.out
    assert_leftover_note(res.out)
    assert lab.wait_dead(":hold") == [], "an orphan holding the output must be stopped"


def test_orphan_that_writes_after_the_shell_exits_is_captured(lab):
    res = lab.run(lab.cmd("spawn", "inherit:1", "late_child", 1.0, 60), timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert "LATE-OUTPUT" in res.out, res.out
    assert_leftover_note(res.out)
    assert lab.wait_dead(":hold") == []


def test_leftover_that_finishes_within_grace_gets_no_note(lab):
    res = lab.run(lab.cmd("spawn", "inherit:1", "late_child", 0.4, 0), timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert "LATE-OUTPUT" in res.out
    assert "Note:" not in res.out, res.out


def test_deep_chain_of_orphans_is_stopped(lab):
    res = lab.run(lab.cmd("chain", 10, 60), timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert_leftover_note(res.out)
    assert lab.wait_for(lambda: len(lab.h.registered()) >= 11, 5)
    assert lab.wait_dead() == [], "every level of a deep chain must be stopped"


def test_wide_tree_of_orphans_is_stopped(lab):
    res = lab.run(lab.cmd("spawn", "inherit:20", "hold", 60), timeout=600, deadline=60)
    assert_returned(res, 40)
    assert_leftover_note(res.out)
    assert lab.wait_dead(":hold", 5) == []


def test_orphan_that_denies_termination_is_stopped(lab):
    res = lab.run(lab.cmd("spawn", "inherit:1", "undying", 60), timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert lab.wait_dead(":hold") == [], f"an orphan that refuses PROCESS_TERMINATE survived; output={res.out!r}"


def test_cmd_start_b_inside_powershell(lab):
    res = lab.run(f"cmd /c start /b \"\" {PY} {lab.helper_path} hold 60", timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert_leftover_note(res.out)
    assert lab.wait_dead(":hold") == []


def test_nested_cmd_running_a_launcher(lab):
    res = lab.run(f"cmd /c {PY} {lab.helper_path} spawn inherit:1 hold 60", timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert "launcher-done" in res.out
    assert_leftover_note(res.out)
    assert lab.wait_dead(":hold") == []


def test_nested_powershell_running_a_launcher(lab):
    inner = lab.cmd("spawn", "inherit:1", "hold", 60).replace("'", "''")
    res = lab.run(f"powershell -NoProfile -NonInteractive -Command '{inner}'", timeout=600)
    assert_returned(res, LEFTOVER_BOUND + 3)
    assert "launcher-done" in res.out
    assert lab.wait_dead(":hold") == []


def test_start_process_no_new_window_is_stopped(lab):
    args = ",".join(_ps_quote(a) for a in (lab.helper_path, "hold", 60))
    res = lab.run(f"Start-Process -NoNewWindow -FilePath {_ps_quote(PY)} -ArgumentList {args}", timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert lab.wait_dead(":hold") == []


# --- 5: programs that let go of the output keep running ---------------------------------------


@pytest.mark.parametrize("kind", ["none", "detached"])
def test_child_that_lets_go_of_output_is_left_running(lab, kind):
    res = lab.run(lab.cmd("spawn", f"{kind}:1", "hold", 30), timeout=600)
    assert_returned(res, 6)
    assert res.out == "launcher-done", res.out
    assert lab.alive(f"{kind}:hold"), "a detached program must be left running"


def test_start_process_hidden_window_is_left_running(lab):
    args = ",".join(_ps_quote(a) for a in (lab.helper_path, "hold", 30))
    res = lab.run(f"Start-Process -WindowStyle Hidden -FilePath {_ps_quote(PY)} -ArgumentList {args}", timeout=600)
    assert_returned(res, 6)
    assert lab.wait_for(lambda: lab.alive(":hold"), 5), "Start-Process'd program never registered"
    assert "Note:" not in (res.out or "")
    time.sleep(1.0)
    assert lab.alive(":hold"), "a program started in its own window must be left running"


def test_detached_program_is_stopped_too_when_a_sibling_holds_the_output(lab):
    res = lab.run(lab.cmd("spawn", "detached:1,inherit:1", "hold", 30), timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert_leftover_note(res.out)
    assert lab.wait_dead("inherit:hold") == [], "the sibling holding the output must be stopped"
    assert lab.wait_dead("detached:hold") == [], "everything the command started is stopped once something held the output"


def test_leftover_note_has_no_count_and_exact_text(lab):
    res = lab.run(lab.cmd("spawn", "detached:2,inherit:2", "hold", 30), timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert res.out == f"launcher-done\n{LEFTOVER_NOTE}", res.out
    assert note_count(res.out) is None


def test_leftover_note_alone_when_there_is_no_output(lab):
    res = lab.run(lab.cmd("spawn_quiet", "inherit:1", "hold", 30), timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert res.out == LEFTOVER_NOTE, res.out
    assert lab.wait_dead() == []


# --- 3: timeouts --------------------------------------------------------------------------------


def test_timeout_stops_shell_and_orphans(lab):
    res = lab.run(lab.cmd("spawn", "inherit:1", "hold", 60) + "; Start-Sleep 60", timeout=3)
    assert_returned(res, 3 + 10)
    assert res.out.startswith("Error: Command timed out after 3 seconds"), res.out
    assert "shell_bg" in res.out
    assert lab.wait_dead() == [], "a timeout must stop the launcher and its orphan"


def test_timeout_stops_a_live_tree(lab):
    res = lab.run(lab.cmd("spawn", "inherit:3", "hold", 60) + "; " + lab.cmd("hold", 60), timeout=4)
    assert_returned(res, 4 + 10)
    assert res.out.startswith("Error: Command timed out"), res.out
    assert lab.wait_dead() == []


def test_timeout_also_stops_detached_programs(lab):
    res = lab.run(lab.cmd("spawn", "detached:1", "hold", 60) + "; Start-Sleep 60", timeout=3)
    assert_returned(res, 3 + 10)
    assert lab.wait_dead() == [], "on timeout everything the command started is stopped"


@pytest.mark.parametrize("timeout", [0, -5, 0.5])
def test_zero_negative_and_fractional_timeouts(lab, timeout):
    res = lab.run(lab.cmd("say_hold", "started", 30), timeout=timeout, deadline=20)
    assert_returned(res, 12)
    assert res.out.startswith("Error: Command timed out"), res.out
    assert lab.wait_dead() == []


def test_huge_timeout_runs_normally(lab):
    res = lab.run("'ok'", timeout=10 ** 7, deadline=20)
    assert_returned(res, 12)
    assert res.out == "ok"


@pytest.mark.parametrize("timeout", [4294968, 4294967.296])
def test_timeout_past_the_32_bit_millisecond_range(lab, timeout):
    res = lab.run("Start-Sleep 3; 'ok'", timeout=timeout, deadline=20)
    assert_returned(res, 15)
    assert res.out == "ok", f"timeout={timeout} gave {res.out!r} after {res.elapsed:.1f}s"


def test_string_timeout_does_not_leak_a_running_command(lab):
    res = lab.run(lab.cmd("say_hold", "started", 30), timeout="5", deadline=20)
    assert not res.hung
    time.sleep(1.5)
    survivors = lab.alive()
    assert res.exc is None and not survivors, (
        f"timeout='5' raised {res.exc!r} and left {len(survivors)} process(es) running unsupervised"
    )
    assert res.out.startswith("Error: Command timed out after 5 seconds"), res.out


def test_none_timeout_runs_a_quick_command(lab):
    res = lab.run("'ok'", timeout=None, deadline=20)
    assert_returned(res, 12)
    assert res.out == "ok"


@pytest.mark.parametrize("timeout,shown", [("5", "5"), (" 4 ", "4"), ("2.5", "2.5"), ("-3", "0"), (-0.0, "0"),
                                           ("1_0", "10")])
def test_text_and_signed_timeouts_are_parsed(lab, timeout, shown):
    res = lab.run(lab.cmd("say_hold", "started", 30), timeout=timeout, deadline=30)
    assert_returned(res, float(shown) + 12)
    assert res.out.startswith(f"Error: Command timed out after {shown} seconds"), res.out
    assert lab.wait_dead() == []


@pytest.mark.parametrize("timeout", [None, "abc", "nan", float("nan"), "", "5s", [], {}, object()])
def test_unusable_timeouts_fall_back_to_the_default(lab, monkeypatch, timeout):
    monkeypatch.setattr(tools, "_DEFAULT_COMMAND_TIMEOUT", 2.0)
    res = lab.run(lab.cmd("say_hold", "started", 30), timeout=timeout, deadline=30)
    assert_returned(res, 2 + 12)
    assert res.out.startswith("Error: Command timed out after 2 seconds"), res.out
    assert lab.wait_dead() == []


@pytest.mark.parametrize("timeout", [10 ** 6, "inf", float("inf"), "1e309", 4294968, 4294967.296])
def test_huge_timeouts_are_capped(lab, monkeypatch, timeout):
    monkeypatch.setattr(tools, "_MAX_COMMAND_TIMEOUT", 3.0)
    res = lab.run(lab.cmd("say_hold", "started", 30), timeout=timeout, deadline=30)
    assert_returned(res, 3 + 12)
    assert res.out.startswith("Error: Command timed out after 3 seconds"), res.out


def test_timeout_too_large_for_a_float(lab):
    res = lab.run("'ok'", timeout=10 ** 400, deadline=30)
    assert not res.hung
    assert res.exc is None, f"shell_exec raised {res.exc!r} for an integer timeout too large for a float"
    assert res.out == "ok"


def test_bool_timeout_is_not_one_second(lab):
    res = lab.run("Start-Sleep 2; 'ok'", timeout=True, deadline=30)
    assert_returned(res, 20)
    assert res.out == "ok", f"timeout=True was treated as {res.out!r}"


@pytest.mark.parametrize("timeout", [10 ** 400, "abc", None, 2])
async def test_outer_budget_lets_shell_exec_answer(lab, timeout):
    command = lab.cmd("say_hold", "started", 30) if timeout == 2 else "'ok'"
    out = await __import__("asyncio").wait_for(
        tools.execute_tool_async("shell_exec", {"command": command, "timeout": timeout}), 60)
    if timeout == 2:
        assert out.startswith("Error: Command timed out after 2 seconds"), out
    else:
        assert out == "ok", out


def test_timeout_message_shows_the_real_number(lab):
    res = lab.run(lab.cmd("say_hold", "started", 30), timeout=1.2345678, deadline=30)
    assert_returned(res, 14)
    assert res.out.startswith("Error: Command timed out after 1.2345678 seconds"), res.out


# --- 4: Stop ------------------------------------------------------------------------------------


def _wait_registered_command(session_id, limit=20.0):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        procs = tools._fg_processes.get(session_id)
        if procs:
            return next(iter(procs))
        time.sleep(0.02)
    return None


def test_stop_ends_command_and_its_orphans_promptly(lab, tmp_path):
    session = Session(name="a", project_path=str(tmp_path))
    thread, box = lab.start(lab.cmd("spawn", "inherit:1", "hold", 60) + "; Start-Sleep 60", 600, session)
    assert _wait_registered_command(session.id)
    assert lab.wait_for(lambda: lab.alive(":hold"), 20), "orphan never started"
    stopped_at = time.monotonic()
    assert stop_session_commands(session.id) == 1
    thread.join(10)
    assert not thread.is_alive(), "Stop did not end the command"
    assert box["end"] - stopped_at < 8
    assert box.get("out") == STOPPED, box.get("out")
    assert lab.wait_dead() == []
    assert session.id not in tools._fg_processes


def test_stop_during_the_leftover_grace_period(lab, tmp_path):
    session = Session(name="a", project_path=str(tmp_path))
    thread, box = lab.start(lab.cmd("spawn", "inherit:1", "hold", 60), 600, session)
    proc = _wait_registered_command(session.id)
    assert proc is not None
    assert lab.wait_for(lambda: proc.poll() is not None, 20), "shell never exited"
    stopped_at = time.monotonic()
    assert stop_session_commands(session.id) == 1
    thread.join(10)
    assert not thread.is_alive()
    assert box["end"] - stopped_at < 1.5, "Stop during the grace period should not wait out the grace period"
    assert box.get("out") == STOPPED, box.get("out")
    assert lab.wait_dead() == []


def test_stop_reaches_an_orphan_that_denies_termination(lab, tmp_path):
    session = Session(name="a", project_path=str(tmp_path))
    thread, box = lab.start(lab.cmd("spawn", "inherit:1", "undying", 60) + "; Start-Sleep 60", 600, session)
    assert _wait_registered_command(session.id)
    assert lab.wait_for(lambda: lab.alive(":hold"), 20)
    time.sleep(0.5)
    assert stop_session_commands(session.id) == 1
    thread.join(10)
    assert not thread.is_alive()
    assert box.get("out") == STOPPED
    assert lab.wait_dead() == []


def test_stop_leaves_another_sessions_command_alone(lab, tmp_path):
    a = Session(name="a", project_path=str(tmp_path))
    b = Session(name="b", project_path=str(tmp_path))
    ta, box_a = lab.start(lab.cmd("spawn", "inherit:1", "hold", 60) + "; Start-Sleep 60", 600, a)
    tb, box_b = lab.start(lab.cmd("spawn", "detached:1", "hold", 30) + "; Start-Sleep 5; 'B-FINISHED'", 600, b)
    assert _wait_registered_command(a.id) and _wait_registered_command(b.id)
    assert lab.wait_for(lambda: lab.alive("inherit:hold") and lab.alive("detached:hold"), 20)
    assert stop_session_commands(a.id) == 1
    ta.join(10)
    assert box_a.get("out") == STOPPED
    assert lab.alive("detached:hold"), "stopping session a killed session b's program"
    assert tb.is_alive(), "session b's command should still be running"
    tb.join(20)
    assert box_b.get("out") == "launcher-done\nB-FINISHED", box_b.get("out")
    assert lab.alive("detached:hold")


def test_stop_racing_normal_finish(lab, tmp_path):
    rng = random.Random(1234)
    outcomes = []
    for i in range(15):
        session = Session(name=f"r{i}", project_path=str(tmp_path))
        thread, box = lab.start(f"'run-{i}'", 600, session)
        _wait_registered_command(session.id, limit=5)
        time.sleep(rng.uniform(0.0, 0.8))
        stop_session_commands(session.id)
        thread.join(15)
        assert not thread.is_alive(), f"run {i} hung after a racing Stop"
        assert box.get("exc") is None, box.get("exc")
        assert box.get("out") in (f"run-{i}", STOPPED), box.get("out")
        outcomes.append(box["out"])
    assert not tools._fg_processes
    assert not tools._fg_cancelled, f"stale cancelled pids: {tools._fg_cancelled}"


def test_stop_with_nothing_running(lab):
    assert stop_session_commands("nobody-" + uuid.uuid4().hex) == 0


# --- 6: output format ---------------------------------------------------------------------------


def _old_format(stdout: str, stderr: str, code: int) -> str:
    output = stdout or ""
    if stderr:
        output += f"\nSTDERR:\n{stderr}"
    output = output.strip()
    if code:
        marker = f"[exit code {code}]"
        return f"{output}\n{marker}" if output else marker
    return output if output else "Command executed successfully with no output."


def _locale_bytes(text: str) -> bytes:
    import locale
    return text.encode(locale.getpreferredencoding(False), "replace")


FORMAT_CASES = {
    "invalid_bytes": (b"ok \x81\x8d\x8f\x90\x9d \xff\xfe end\n", None, 0),
    "crlf": (b"line1\r\nline2\r\n", None, 0),
    "lone_cr": (b"progress 10%\rprogress 100%\rdone\n", None, 0),
    "cr_cr_lf": (b"a\r\r\nb\rc", None, 0),
    "non_ascii_locale": (_locale_bytes("café naïve € “q”"), None, 0),
    "utf8_bytes": ("日本 ✓ \U0001f600".encode("utf-8"), None, 0),
    "bom": (b"\xef\xbb\xbfbom-line\n", None, 0),
    "nul": (b"a\x00b\n", None, 0),
    "stderr_only": (None, b"err line\r\n", 0),
    "both_and_exit": (b"out\n", b"err\xff\r\n", 3),
    "whitespace_only": (b"  \r\n\t\n", b"  ", 0),
    "empty_with_exit": (None, None, 4),
    "empty": (None, None, 0),
    "long_line": (b"x" * (3 * 1024 * 1024 + 7), None, 0),
    "cr_at_read_boundary": (b"y" * 65535 + b"\r\n" + b"z" * 10, None, 0),
    "multibyte_at_read_boundary": (b"y" * 65535 + "é€".encode("utf-8") + b"z", None, 0),
    "cr_at_textio_boundary": (b"y" * 8191 + b"\r\n" + b"w" * 8191 + b"\r" + b"v", None, 0),
}


@pytest.mark.parametrize("case", sorted(FORMAT_CASES))
def test_output_format_matches_text_mode(lab, case):
    out_bytes, err_bytes, code = FORMAT_CASES[case]
    paths = []
    for name, data in (("out", out_bytes), ("err", err_bytes)):
        if data is None:
            paths.append("-")
        else:
            p = lab.root / f"{case}.{name}.bin"
            p.write_bytes(data)
            paths.append(str(p))
    argv = [PY, str(lab.helper_path), "rawio", paths[0], paths[1], str(code)]
    ref = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=30)
    expected = _old_format(ref.stdout, ref.stderr, ref.returncode)
    res = lab.run(lab.cmd("rawio", paths[0], paths[1], code) + "; exit $LASTEXITCODE", timeout=60, deadline=40)
    assert_returned(res, 30)
    assert res.out == expected, f"len {len(res.out)} vs {len(expected)}; head {res.out[:120]!r} vs {expected[:120]!r}"


@pytest.mark.parametrize("command,code", [("exit 3", 3), ("'hi'; exit 7", 7), ("exit 255", 255), ("exit -1", None)])
def test_exit_code_line_still_parses(lab, command, code):
    res = lab.run(command, timeout=60, deadline=30)
    assert_returned(res, 20)
    m = _EXIT_LINE.search(res.out)
    assert m, res.out
    if code is not None:
        assert int(m.group(1)) == code


def test_leftover_note_keeps_exit_line_last(lab):
    res = lab.run(lab.cmd("spawn", "inherit:1", "hold", 60) + "; exit 5", timeout=600)
    assert_returned(res, LEFTOVER_BOUND)
    assert res.out.splitlines()[-1] == "[exit code 5]", res.out
    assert _EXIT_LINE.search(res.out).group(1) == "5"
    assert res.out.startswith("launcher-done")


def test_instant_exit_and_empty_output(lab):
    res = lab.run("exit 0", timeout=60, deadline=30)
    assert_returned(res, 10)
    assert res.out == "Command executed successfully with no output."
    res = lab.run("$null", timeout=60, deadline=30)
    assert res.out == "Command executed successfully with no output."


def test_many_megabytes_of_stdout_and_stderr(lab):
    n_out, n_err = 640, 160
    res = lab.run(lab.cmd("flood", n_out, n_err), timeout=300, deadline=120)
    assert_returned(res, 90)
    out_chunk = "0123456789abcdef" * 4095 + "0123456789abcde\n"
    err_chunk = "EEEEEEEEEEEEEEEE" * 4095 + "EEEEEEEEEEEEEEE\n"
    expected = _old_format(out_chunk * n_out, err_chunk * n_err, 0)
    assert len(res.out) == len(expected)
    assert res.out == expected


def test_leftover_flooding_output_after_shell_exit(lab):
    res = lab.run(lab.cmd("spawn", "inherit:1", "flood_child", 60, 2048 * MIB), timeout=600, deadline=90)
    assert_returned(res, 30)
    assert lab.wait_dead(":hold") == []
    assert "launcher-done" in res.out
    assert_leftover_note(res.out)
    assert len(res.out) <= 64 * MIB + 4096, f"{len(res.out) / MIB:.0f} MiB returned"
    assert re.search(r"\[\d+ more bytes of output were not kept\]", res.out)


_OUT_CHUNK = "0123456789abcdef" * 4095 + "0123456789abcde\n"
_ERR_CHUNK = "EEEEEEEEEEEEEEEE" * 4095 + "EEEEEEEEEEEEEEE\n"


def test_output_of_exactly_the_cap_is_kept_whole(lab):
    res = lab.run(lab.cmd("flood", 1024, 0), timeout=300, deadline=120)
    assert_returned(res, 90)
    assert "more bytes of output were not kept" not in res.out[-200:]
    assert res.out == (_OUT_CHUNK * 1024).strip()


def test_one_byte_over_the_cap(lab):
    res = lab.run(lab.cmd("flood", 1024, 0, 1, 0), timeout=300, deadline=120)
    assert_returned(res, 90)
    assert res.out == (_OUT_CHUNK * 1024) + "\n[1 more bytes of output were not kept]", res.out[-120:]


def test_both_streams_over_the_cap(lab):
    res = lab.run(lab.cmd("flood", 1100, 1060, 5, 7), timeout=300, deadline=150)
    assert_returned(res, 120)
    out_drop = 76 * 65536 + 5
    err_drop = 36 * 65536 + 7
    expected = (_OUT_CHUNK * 1024 + f"\n[{out_drop} more bytes of output were not kept]"
                + "\nSTDERR:\n" + _ERR_CHUNK * 1024 + f"\n[{err_drop} more bytes of output were not kept]")
    assert len(res.out) == len(expected)
    assert res.out == expected


def test_timeout_while_flooding_is_bounded(lab):
    res = lab.run(lab.cmd("flood_forever"), timeout=3, deadline=60)
    assert_returned(res, 3 + 20)
    assert res.out.startswith("Error: Command timed out after 3 seconds")
    assert "\nOutput before it was stopped:\n" in res.out
    assert len(res.out) <= 2 * 64 * MIB + 8192, f"{len(res.out) / MIB:.0f} MiB returned"
    assert res.out.count("more bytes of output were not kept") == 2


# --- concurrency and leaks ------------------------------------------------------------------------


def test_concurrent_runs_across_sessions(lab, tmp_path):
    results = {}
    errors = []

    def worker(i):
        session = Session(name=f"c{i}", project_path=str(tmp_path))
        token = _current_session_var.set(session)
        try:
            for j in range(3):
                command = lab.cmd("spawn", "inherit:1", "hold", 30) if i < 2 and j == 0 else f"'out-{i}-{j}'"
                results[(i, j)] = shell_exec(command, timeout=120)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)
        finally:
            _current_session_var.reset(token)

    threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(8)]
    lab.threads.extend(threads)
    for t in threads:
        t.start()
    deadline = time.monotonic() + 90
    for t in threads:
        t.join(max(0.0, deadline - time.monotonic()))
    assert not any(t.is_alive() for t in threads), "concurrent shell_exec calls hung"
    assert not errors, errors
    for (i, j), out in results.items():
        if i < 2 and j == 0:
            assert_leftover_note(out)
        else:
            assert out == f"out-{i}-{j}", (i, j, out)
    assert len(results) == 24
    assert not tools._fg_processes
    assert lab.wait_dead(":hold") == []


def _handle_count() -> int:
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.GetProcessHandleCount.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    count = wintypes.DWORD()
    k32.GetProcessHandleCount(k32.GetCurrentProcess(), ctypes.byref(count))
    return count.value


def _reader_threads() -> int:
    return sum(1 for t in threading.enumerate() if t.name == "shell-exec-output")


def test_no_thread_or_handle_leaks_over_many_runs(lab):
    for _ in range(3):
        lab.run("'warm'", timeout=60, deadline=30)
    gc.collect()
    threads_before = len(threading.enumerate())
    handles_before = _handle_count()
    for i in range(50):
        res = lab.run(f"'n{i}'", timeout=60, deadline=30)
        assert_returned(res, 20)
        assert res.out == f"n{i}"
    for _ in range(3):
        res = lab.run(lab.cmd("spawn", "inherit:1", "hold", 30), timeout=600)
        assert_returned(res, LEFTOVER_BOUND)
    for _ in range(2):
        res = lab.run(lab.cmd("say_hold", "x", 30), timeout=1, deadline=20)
        assert_returned(res, 12)
    for t in lab.threads:
        t.join(5)
    gc.collect()
    time.sleep(0.5)
    assert _reader_threads() == 0, f"{_reader_threads()} output reader threads still running"
    leaked_threads = len([t for t in threading.enumerate() if t.is_alive()]) - threads_before
    assert leaked_threads <= 0, f"{leaked_threads} threads leaked"
    handles_after = _handle_count()
    assert handles_after - handles_before < 25, f"handle count grew {handles_before} -> {handles_after}"
    assert not tools._fg_processes and not tools._fg_cancelled


def test_pipes_are_closed_not_left_to_the_garbage_collector(lab):
    lab.run("'warm'", timeout=60, deadline=30)
    gc.collect()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        res = lab.run("'x'", timeout=60, deadline=30)
        res.thread.join(5)
        gc.collect()
    unclosed = [str(w.message) for w in caught if issubclass(w.category, ResourceWarning)]
    assert res.out == "x"
    assert not unclosed, f"shell_exec left its pipes for the garbage collector: {unclosed}"


# --- 7: trust and air-gap --------------------------------------------------------------------------


def test_untrusted_folder_is_refused_without_starting_anything(lab, monkeypatch):
    monkeypatch.setattr(tools, "_is_trusted", lambda: False)
    started = []
    real = subprocess.Popen
    monkeypatch.setattr(tools.subprocess, "Popen", lambda *a, **k: started.append(a) or real(*a, **k))
    out = shell_exec(lab.cmd("hold", 5), timeout=30)
    assert out == "Error: This folder is not trusted. Use /trust to allow shell commands."
    assert not started


@pytest.mark.parametrize("command", ["curl example.com", "iwr http://x", "git push origin main", "npm install left-pad"])
def test_airgap_refuses_network_commands(lab, monkeypatch, command):
    monkeypatch.setenv("ANDROMITY_AIRGAP", "1")
    started = []
    real = subprocess.Popen
    monkeypatch.setattr(tools.subprocess, "Popen", lambda *a, **k: started.append(a) or real(*a, **k))
    out = shell_exec(command, timeout=30)
    assert "blocked by air-gap policy" in out
    assert not started


# --- breakaway and an engine already inside a job ----------------------------------------------------


def test_commands_can_still_break_away_from_a_job(lab):
    res = lab.run(lab.cmd("breakaway"), timeout=60, deadline=30)
    assert_returned(res, 15)
    assert res.out.startswith("BREAKAWAY-OK"), (
        f"a program that asks CreateProcess for CREATE_BREAKAWAY_FROM_JOB now fails: {res.out!r}"
    )


def _skip_if_breakaway_refused(res):
    if res.out and "SPAWN-FAILED" in res.out:
        pytest.skip(f"this machine refuses CREATE_BREAKAWAY_FROM_JOB: {res.out!r}")


BREAKAWAY_LIMIT = pytest.mark.xfail(
    strict=True,
    reason="Accepted limit: a program that explicitly asks to leave the job (CREATE_BREAKAWAY_FROM_JOB) is outside "
           "Andromity's reach; refusing breakaway would make such programs fail to start, and the command still returns.",
)


def _broke_away_leftover(lab):
    readers_before = _reader_threads()
    res = lab.run(lab.cmd("spawn", "breakaway:1", "hold", 60), timeout=600)
    _skip_if_breakaway_refused(res)
    assert_returned(res, LEFTOVER_BOUND)
    assert res.out == f"launcher-done\n{LEFTOVER_NOTE}", res.out
    return res, readers_before


def _broke_away_timeout(lab):
    res = lab.run(lab.cmd("spawn", "breakaway:1", "hold", 60) + "; Start-Sleep 60", timeout=3)
    _skip_if_breakaway_refused(res)
    assert_returned(res, 3 + 20)
    assert res.out.startswith("Error: Command timed out after 3 seconds"), res.out
    return res


def _broke_away_stop(lab, tmp_path):
    session = Session(name="a", project_path=str(tmp_path))
    thread, box = lab.start(lab.cmd("spawn", "breakaway:1", "hold", 60) + "; Start-Sleep 60", 600, session)
    assert _wait_registered_command(session.id)
    if not lab.wait_for(lambda: lab.alive(":hold"), 20):
        lab.finish(thread, box, 30)
        pytest.skip(f"breakaway child never started: {box.get('out')!r}")
    stopped_at = time.monotonic()
    assert stop_session_commands(session.id) == 1
    thread.join(20)
    assert not thread.is_alive(), "Stop did not end the command"
    assert box["end"] - stopped_at < 10, f"Stop took {box['end'] - stopped_at:.1f}s"
    assert box.get("out") == STOPPED
    assert session.id not in tools._fg_processes


def test_command_returns_when_an_orphan_broke_away_and_holds_output(lab):
    _broke_away_leftover(lab)


def test_timeout_returns_when_an_orphan_broke_away(lab):
    _broke_away_timeout(lab)


def test_stop_returns_when_an_orphan_broke_away(lab, tmp_path):
    _broke_away_stop(lab, tmp_path)


@BREAKAWAY_LIMIT
def test_orphan_that_broke_away_and_holds_output(lab):
    res, readers_before = _broke_away_leftover(lab)
    survivors = lab.wait_dead(":hold")
    stuck_readers = _reader_threads() - readers_before
    assert not survivors and stuck_readers <= 0, (
        f"output said {res.out[-160:]!r} but {len(survivors)} process(es) that broke away still hold the output "
        f"and {stuck_readers} reader thread(s) are stuck on the pipe"
    )


@BREAKAWAY_LIMIT
def test_timeout_reaches_an_orphan_that_broke_away(lab):
    _broke_away_timeout(lab)
    assert lab.wait_dead(":hold") == [], "a timeout must stop a program that broke away while holding the output"


@BREAKAWAY_LIMIT
def test_stop_reaches_an_orphan_that_broke_away(lab, tmp_path):
    _broke_away_stop(lab, tmp_path)
    assert lab.wait_dead(":hold") == [], "Stop must stop a program that broke away while holding the output"


@pytest.mark.parametrize("cfg", ["plain", "breakaway_ok", "libuv", "ui"])
def test_engine_already_inside_a_job(lab, cfg):
    runner = lab.root / "jobrunner.py"
    runner.write_text(JOBRUNNER, encoding="utf-8")
    result_path = lab.root / f"jobrunner-{cfg}.json"
    log_path = lab.root / f"jobrunner-{cfg}.log"
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(SRC_DIR)] + [p for p in sys.path if p and os.path.isdir(p)])
    with open(log_path, "wb") as log_file:
        proc = subprocess.Popen([PY, str(runner), cfg, str(SRC_DIR), str(result_path)], cwd=str(lab.root),
                                stdin=subprocess.DEVNULL, stdout=log_file, stderr=log_file, env=env)
        try:
            proc.wait(timeout=90)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(10)
    assert result_path.exists(), log_path.read_text(errors="replace")[-3000:]
    data = json.loads(result_path.read_text())
    assert data["assigned"], "could not put the runner into a job"
    assert not data["hung"], f"[{cfg}] shell_exec hung inside a job: {data}"
    assert data["exc"] is None, data
    assert data["elapsed"] < LEFTOVER_BOUND, data
    assert not data["alive_holders"], f"[{cfg}] orphan survived: {data}"
