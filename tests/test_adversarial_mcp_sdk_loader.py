"""Adversarial probes for the MCP SDK loader (load_mcp_sdk / _import_sdk / MCPSseSession._run).

Clean-import checks run in a fresh interpreter with a meta-path finder that records which thread
looked up each SDK module. In-process tests force the import path by clearing _sdk_ready and
swapping real SDK modules out of sys.modules behind a finder that blocks or raises.
"""
import asyncio
import gc
import importlib
import importlib.abc
import importlib.util
import json
import logging
import os
import subprocess
import sys
import threading
import time
import types
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from andromity.config import config
from andromity.core import mcp as mcpmod
from andromity.core import oauth
from andromity.core.mcp import MCPClientManager, MCPSseSession

SRC = Path(__file__).resolve().parents[1] / "src"
TIMEOUT_MESSAGE = "timed out"


# ── clean-interpreter harness ────────────────────────────────────────────────

PROLOGUE = r'''
import asyncio, json, os, sys, threading, time, traceback
from contextlib import asynccontextmanager
from types import SimpleNamespace

WATCH = {"mcp", "pydantic", "pydantic_core", "httpx", "httpx2", "httpcore", "anyio", "httpx_sse", "jsonschema"}
SLOW = {"mcp", "pydantic", "httpx"}
seen = []
callers = []
slept = set()


class Finder:
    def find_spec(self, name, path=None, target=None):
        top = name.split(".")[0]
        if top in WATCH:
            seen.append((name, threading.get_ident()))
            if top == "jsonschema":
                frames = [f.filename for f in traceback.extract_stack() if "importlib" not in f.filename and f.filename != "<string>"]
                callers.append((name, frames[-1] if frames else ""))
            if name in SLOW and name not in slept:
                slept.add(name)
                time.sleep(0.4)
        return None


import andromity.core.mcp as mcpmod

CLEAN_AT_IMPORT = sorted({m.split(".")[0] for m in sys.modules} & {"mcp", "pydantic", "httpx", "httpx2"})
sys.meta_path.insert(0, Finder())


async def _noop(*a, **k):
    return None


async def _no_tools(*a, **k):
    return SimpleNamespace(tools=[])


def install_fakes():
    real_load = mcpmod.load_mcp_sdk

    async def load_and_fake(*args, **kwargs):
        await real_load("sse")
        await real_load("http")
        import mcp.client.session as s
        import mcp.client.sse as sse
        import mcp.client.streamable_http as sh

        @asynccontextmanager
        async def conn(url, headers=None, **kw):
            await asyncio.sleep(0)
            yield ("read", "write")

        @asynccontextmanager
        async def session(read, write):
            yield SimpleNamespace(initialize=_noop, list_tools=_no_tools)

        sse.sse_client = conn
        sh.streamablehttp_client = conn
        s.ClientSession = session

    mcpmod.load_mcp_sdk = load_and_fake


def on_threads(tids):
    return sorted({n for n, t in seen if t in tids})


async def with_heartbeat(coro):
    ticks = []

    async def beat():
        while True:
            ticks.append(time.perf_counter())
            await asyncio.sleep(0.005)

    task = asyncio.create_task(beat())
    await asyncio.sleep(0.05)
    try:
        result = await coro
    finally:
        task.cancel()
    return result, max(b - a for a, b in zip(ticks, ticks[1:]))


def emit(**payload):
    print("RESULT " + json.dumps(payload))
'''


def run_clean(script, tmp_path, timeout=120, prelude=""):
    home = tmp_path / "home"
    (home / ".andromity").mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.update(
        USERPROFILE=str(home), HOME=str(home), ANDROMITY_CONFIG_DIR=str(home / ".andromity"),
        DO_NOT_TRACK="1", ANDROMITY_NO_TELEMETRY="1", PYTHONPATH=str(SRC), PYTHONIOENCODING="utf-8",
    )
    proc = subprocess.run(
        [sys.executable, "-c", PROLOGUE + prelude + script], cwd=str(tmp_path), env=env,
        capture_output=True, text=True, timeout=timeout,
    )
    lines = [line for line in proc.stdout.splitlines() if line.startswith("RESULT ")]
    assert proc.returncode == 0 and lines, f"rc={proc.returncode}\nSTDERR:\n{proc.stderr[-3000:]}\nSTDOUT:\n{proc.stdout[-1500:]}"
    return json.loads(lines[-1][len("RESULT "):])


# ── in-process fixtures ──────────────────────────────────────────────────────

class ImportGate:
    """Finder that stalls and/or fails the import of one module, recording which thread asked."""

    def __init__(self, name, *, raises=None, block=False):
        self.name = name
        self.raises = raises
        self.block = block
        self.entered = threading.Event()
        self.release = threading.Event()
        self.done = threading.Event()
        self.threads = []

    def find_spec(self, fullname, path=None, target=None):
        if fullname != self.name:
            return None
        self.threads.append(threading.get_ident())
        self.entered.set()
        if self.block:
            self.release.wait(15)
        if self.raises is None:
            self.done.set()
            return None
        gate = self

        class Loader(importlib.abc.Loader):
            def create_module(self, spec):
                return None

            def exec_module(self, module):
                gate.done.set()
                raise gate.raises

        return importlib.util.spec_from_loader(fullname, Loader())


class Provide:
    """Finder that supplies a stub module for a name that is not installed, recording the asking thread."""

    def __init__(self, name, module):
        self.name = name
        self.module = module
        self.threads = []

    def find_spec(self, fullname, path=None, target=None):
        if fullname != self.name:
            return None
        self.threads.append(threading.get_ident())
        provider = self

        class Loader(importlib.abc.Loader):
            def create_module(self, spec):
                return provider.module

            def exec_module(self, module):
                return None

        return importlib.util.spec_from_loader(fullname, Loader())


@pytest.fixture
def cold_sdk():
    was_ready = mcpmod._sdk_ready.is_set()
    mcpmod._sdk_ready.clear()
    yield
    mcpmod._sdk_ready.set() if was_ready else mcpmod._sdk_ready.clear()


@pytest.fixture
def gate_import(monkeypatch):
    installed = []

    def install(name="mcp.client.sse", **kwargs):
        original = importlib.import_module(name)
        parent_name, _, child = name.rpartition(".")
        monkeypatch.setattr(sys.modules[parent_name], child, original)
        monkeypatch.delitem(sys.modules, name)
        gate = ImportGate(name, **kwargs)
        sys.meta_path.insert(0, gate)
        installed.append(gate)
        return gate

    yield install
    for gate in installed:
        gate.release.set()
        if gate in sys.meta_path:
            sys.meta_path.remove(gate)


@pytest.fixture
def block_import(monkeypatch):
    def block(name):
        importlib.import_module(name)
        monkeypatch.setitem(sys.modules, name, None)
    return block


@pytest.fixture
def fake_remote(monkeypatch):
    """Replace the transport and the SDK session; the loader itself stays real."""
    import mcp.client.session

    @asynccontextmanager
    async def transport(kind, url, headers):
        yield ("read", "write")

    @asynccontextmanager
    async def session(read, write):
        yield SimpleNamespace(initialize=AsyncMock(), list_tools=AsyncMock(return_value=SimpleNamespace(tools=[])))

    monkeypatch.setattr(mcpmod, "open_remote_transport", lambda *a: transport(*a))
    monkeypatch.setattr(mcp.client.session, "ClientSession", session)


@pytest.fixture
async def loop_errors():
    loop = asyncio.get_running_loop()
    errors = []
    loop.set_exception_handler(lambda _loop, context: errors.append(context))
    yield errors
    loop.set_exception_handler(None)


@pytest.fixture(autouse=True)
def quiet_telemetry(monkeypatch):
    monkeypatch.setenv("DO_NOT_TRACK", "1")


async def gaps_while(coro, interval=0.005):
    ticks = []

    async def beat():
        while True:
            ticks.append(time.perf_counter())
            await asyncio.sleep(interval)

    task = asyncio.create_task(beat())
    await asyncio.sleep(0.03)
    try:
        result = await coro
    finally:
        task.cancel()
    return result, max(b - a for a, b in zip(ticks, ticks[1:]))


def status_error(code):
    exc = Exception("transport failed with internal secret detail")
    exc.response = SimpleNamespace(status_code=code)
    return exc


# ── clean-import: the point of the change ───────────────────────────────────

def test_importing_the_module_does_not_pull_in_the_sdk(tmp_path):
    result = run_clean("emit(clean=CLEAN_AT_IMPORT)", tmp_path)
    assert result["clean"] == []


@pytest.mark.parametrize("transport", ["sse", "http"])
def test_cold_start_imports_nothing_heavy_on_the_loop_thread(tmp_path, transport):
    result = run_clean(f"""
install_fakes()
async def main():
    tid = threading.get_ident()
    session = mcpmod.MCPSseSession("x", "https://mcp.example/mcp", transport={transport!r})
    ok, gap = await with_heartbeat(session.start())
    await session.stop()
    emit(ok=ok, gap=gap, on_loop=on_threads({{tid}}), off_loop=len(on_threads({{t for _, t in seen if t != tid}})),
         ready=mcpmod._sdk_ready.is_set())
asyncio.run(main())
""", tmp_path)
    assert result["ok"]
    assert result["on_loop"] == []
    assert result["off_loop"] > 0
    assert result["ready"]
    assert result["gap"] < 0.3, "the loop stalled while the SDK imported (finder adds 0.4 s per heavy package)"


def test_expired_oauth_token_refresh_keeps_httpx_off_the_loop(tmp_path):
    result = run_clean("""
import http.server, json as _json
from pathlib import Path
from andromity.core import oauth
from andromity.config import config

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        body = _json.dumps({"access_token": "fresh", "expires_in": 3600}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
home = Path(os.environ["USERPROFILE"])
oauth.TOKEN_FILE = home / ".andromity" / "tokens.json"
project = home / "project"
project.mkdir()
config.set_trusted(str(project))
oauth.store_token("srv", {"access_token": "old", "refresh_token": "r", "expires_in": 3600}, "cid",
                  f"http://127.0.0.1:{server.server_address[1]}/token", "https://mcp.example/sse")
store = oauth._load_store()
store["srv"]["expires_at"] = 1
oauth._save_store(store)
install_fakes()
del seen[:]

async def main():
    tid = threading.get_ident()
    manager = mcpmod.MCPClientManager(str(project))
    await manager.start_server("srv", {"url": "https://mcp.example/sse"})
    status = manager.server_status["srv"]["status"]
    await manager.stop_all()
    emit(status=status, on_loop=on_threads({tid}))
asyncio.run(main())
""", tmp_path)
    assert result["status"] == "running"
    heavy = [n for n in result["on_loop"] if n.split(".")[0] in {"httpx", "httpcore", "anyio", "mcp", "pydantic"}]
    assert heavy == [], f"remote server start still imports on the loop thread: {heavy[:6]}"


@pytest.mark.xfail(reason="load_mcp_sdk preloads jsonschema; this test deletes it from sys.modules afterwards, so no preload can pass it", strict=True)
def test_first_structured_tool_call_does_not_import_jsonschema_on_the_loop(tmp_path):
    result = run_clean("""
async def main():
    tid = threading.get_ident()
    await mcpmod.load_mcp_sdk()
    import mcp.types as types
    from mcp.server.lowlevel import Server
    from mcp.shared.memory import create_connected_server_and_client_session
    server = Server("fake")

    @server.list_tools()
    async def list_tools():
        return [types.Tool(name="t", description="d", inputSchema={"type": "object"},
                           outputSchema={"type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"]})]

    @server.call_tool()
    async def call_tool(name, arguments):
        return {"x": 1}

    for name in [k for k in sys.modules if k == "jsonschema" or k.startswith("jsonschema.")]:
        del sys.modules[name]
    del seen[:]
    del callers[:]
    async with create_connected_server_and_client_session(server) as client:
        remote = mcpmod.MCPSseSession("x", "https://mcp.example/mcp")
        remote._session = client
        await remote.get_tools()
        out = await remote.call_tool("t", {})
    client_side = sorted({n for n, f in callers if f.replace("\\\\", "/").endswith("mcp/client/session.py")})
    emit(out=out, client_side=client_side, on_loop=[n for n in on_threads({tid}) if n.split(".")[0] == "jsonschema"])
asyncio.run(main())
""", tmp_path)
    assert "1" in result["out"] and "error" not in result["out"].lower()
    assert result["client_side"] == [], f"ClientSession imports jsonschema lazily on the loop: {result['client_side'][:3]}"


def test_many_concurrent_cold_starts_all_connect(tmp_path):
    result = run_clean("""
install_fakes()
async def main():
    tid = threading.get_ident()
    sessions = [mcpmod.MCPSseSession(f"s{i}", "https://mcp.example/x", transport="sse" if i % 2 else "http") for i in range(24)]
    started = await asyncio.wait_for(asyncio.gather(*(s.start() for s in sessions), return_exceptions=True), 60)
    errors = [s.error for s in sessions if s.error]
    await asyncio.gather(*(s.stop() for s in sessions))
    emit(started=[x if isinstance(x, bool) else repr(x) for x in started], errors=errors,
         on_loop=on_threads({tid}), ready=mcpmod._sdk_ready.is_set())
asyncio.run(main())
""", tmp_path)
    assert result["started"] == [True] * 24
    assert result["errors"] == []
    assert result["on_loop"] == []
    assert result["ready"]


def test_loops_on_several_threads_race_the_first_import(tmp_path):
    result = run_clean("""
install_fakes()
outcomes = []
loop_tids = set()

def run_loop(i):
    async def inner():
        loop_tids.add(threading.get_ident())
        s = mcpmod.MCPSseSession(f"t{i}", "https://mcp.example/x", transport="sse" if i % 2 else "http")
        ok = await s.start()
        err = s.error
        await s.stop()
        return ok, err
    outcomes.append(asyncio.run(inner()))

threads = [threading.Thread(target=run_loop, args=(i,)) for i in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join(60)
emit(outcomes=outcomes, alive=[t.is_alive() for t in threads], on_loop=on_threads(loop_tids), ready=mcpmod._sdk_ready.is_set())
""", tmp_path)
    assert not any(result["alive"])
    assert result["outcomes"] == [[True, None]] * 6
    assert result["on_loop"] == []
    assert result["ready"]


# ── failure of the import itself ─────────────────────────────────────────────

def raisers():
    return [
        pytest.param(lambda: ImportError("No module named 'pydantic_core._pydantic_core'"), id="ImportError"),
        pytest.param(lambda: AttributeError("partially initialised module 'mcp.client.sse' has no attribute 'sse_client'"), id="AttributeError"),
        pytest.param(lambda: RuntimeError("internal secret detail in /home/user/.venv"), id="RuntimeError"),
        pytest.param(lambda: OSError(5, "I/O error reading pyc (cold disk)"), id="OSError"),
    ]


@pytest.mark.parametrize("make_exc", raisers())
async def test_failing_sdk_import_fails_start_fast_and_cleanly(cold_sdk, gate_import, fake_remote, loop_errors, make_exc, caplog):
    gate_import(raises=make_exc())
    remote = MCPSseSession("test", "https://mcp.example/sse", transport="sse")
    started = time.perf_counter()
    with caplog.at_level(logging.WARNING):
        ok = await asyncio.wait_for(remote.start(), 5)
    assert time.perf_counter() - started < 3, "start() waited out the connection timeout instead of failing"
    assert not ok
    assert remote.error and TIMEOUT_MESSAGE not in remote.error.lower()
    assert "secret" not in remote.error and "pydantic" not in remote.error
    assert not remote.needs_auth and not remote.legacy_endpoint
    assert not mcpmod._sdk_ready.is_set()
    assert remote._bg_task.done() and remote._bg_task.exception() is None
    assert not remote.is_alive()
    await remote.stop()
    gc.collect()
    await asyncio.sleep(0.05)
    assert loop_errors == []
    assert "secret detail" not in caplog.text


async def test_failed_import_is_retried_not_cached(cold_sdk, gate_import, fake_remote):
    gate = gate_import(raises=ImportError("transient"))
    remote = MCPSseSession("test", "https://mcp.example/sse", transport="sse")
    assert not await remote.start()
    assert not mcpmod._sdk_ready.is_set()
    sys.meta_path.remove(gate)
    assert await asyncio.wait_for(remote.start(), 10)
    assert mcpmod._sdk_ready.is_set()
    assert remote.error is None
    await remote.stop()


async def test_sdk_import_failure_is_not_reported_as_a_server_url_problem(cold_sdk, gate_import, fake_remote):
    gate_import(raises=ImportError("broken install"))
    remote = MCPSseSession("test", "https://mcp.example/sse", transport="sse")
    assert not await remote.start()
    assert "server url" not in remote.error.lower(), "a local SDK install problem is reported as a server URL problem"


@pytest.mark.parametrize("transport,other", [("http", "mcp.client.sse"), ("sse", "mcp.client.streamable_http")])
async def test_one_transport_does_not_depend_on_the_other_transports_module(cold_sdk, block_import, monkeypatch, transport, other):
    import mcp.client.session
    import mcp.client.sse
    import mcp.client.streamable_http

    @asynccontextmanager
    async def connection(*args, **kwargs):
        yield ("read", "write")

    @asynccontextmanager
    async def session(read, write):
        yield SimpleNamespace(initialize=AsyncMock(), list_tools=AsyncMock(return_value=SimpleNamespace(tools=[])))

    monkeypatch.setattr(mcp.client.sse, "sse_client", connection)
    monkeypatch.setattr(mcp.client.streamable_http, "streamablehttp_client", connection, raising=False)
    monkeypatch.setattr(mcp.client.session, "ClientSession", session)
    block_import(other)
    remote = MCPSseSession("test", "https://mcp.example/mcp", transport=transport)
    assert await asyncio.wait_for(remote.start(), 10), remote.error
    await remote.stop()


# ── cancellation while the import runs on its worker thread ──────────────────

async def test_stop_while_import_is_blocked_returns_promptly_and_loop_stays_live(cold_sdk, gate_import, fake_remote, loop_errors):
    gate = gate_import(block=True, raises=RuntimeError("late failure"))
    remote = MCPSseSession("test", "https://mcp.example/sse", transport="sse")
    starter = asyncio.create_task(remote.start())
    await asyncio.to_thread(gate.entered.wait, 5)
    assert gate.entered.is_set()
    loop_tid = threading.get_ident()
    assert gate.threads == [t for t in gate.threads if t != loop_tid], "import ran on the loop thread"

    async def stop_and_time():
        began = time.perf_counter()
        await remote.stop()
        return time.perf_counter() - began

    elapsed, gap = await gaps_while(stop_and_time())
    assert elapsed < 1.0, "stop() waited for the import thread"
    assert gap < 0.25, "loop was blocked while an import was in flight"
    assert not remote.is_alive()
    assert await asyncio.wait_for(starter, 5) is False
    gate.release.set()
    await asyncio.to_thread(gate.done.wait, 5)
    await asyncio.sleep(0.2)
    gc.collect()
    await asyncio.sleep(0.05)
    assert loop_errors == [], "a late import failure after stop() surfaced as an unretrieved exception"
    assert not mcpmod._sdk_ready.is_set()


async def test_start_timeout_while_import_is_blocked_keeps_the_30s_contract(cold_sdk, gate_import, fake_remote, monkeypatch):
    waits = []

    class ShortWait:
        def __getattr__(self, name):
            return getattr(asyncio, name)

        async def wait_for(self, awaitable, timeout=None):
            waits.append(timeout)
            return await asyncio.wait_for(awaitable, 0.3)

    monkeypatch.setattr(mcpmod, "asyncio", ShortWait())
    gate = gate_import(block=True)
    remote = MCPSseSession("test", "https://mcp.example/sse", transport="sse")
    began = time.perf_counter()
    ok = await remote.start()
    assert not ok
    assert waits == [30]
    assert "timed out" in remote.error.lower()
    assert time.perf_counter() - began < 3
    assert remote._bg_task is None and not remote.is_alive()
    gate.release.set()
    await asyncio.to_thread(mcpmod._sdk_ready.wait, 10)
    assert mcpmod._sdk_ready.is_set()
    assert await asyncio.wait_for(remote.start(), 10)
    await remote.stop()


async def test_concurrent_starts_share_one_slow_import(cold_sdk, gate_import, fake_remote):
    gate = gate_import(block=True)
    remotes = [MCPSseSession(f"s{i}", "https://mcp.example/sse", transport="sse") for i in range(12)]
    tasks = [asyncio.create_task(r.start()) for r in remotes]
    await asyncio.to_thread(gate.entered.wait, 5)
    await asyncio.sleep(0.2)
    loop_tid = threading.get_ident()
    assert loop_tid not in gate.threads
    gate.release.set()
    assert await asyncio.wait_for(asyncio.gather(*tasks), 15) == [True] * 12
    assert len(gate.threads) == 1, f"module body looked up {len(gate.threads)} times; import lock should serialise it"
    await asyncio.gather(*(r.stop() for r in remotes))


def test_session_started_from_another_threads_loop_imports_off_that_loop(cold_sdk, gate_import, fake_remote):
    gate = gate_import()
    remote = MCPSseSession("test", "https://mcp.example/sse", transport="sse")
    outcome = {}

    def run():
        async def go():
            outcome["loop_thread"] = threading.get_ident()
            outcome["ok"] = await remote.start()
            await remote.stop()
        asyncio.run(go())

    worker = threading.Thread(target=run)
    worker.start()
    worker.join(20)
    assert not worker.is_alive()
    assert outcome["ok"]
    assert gate.threads and outcome["loop_thread"] not in gate.threads
    assert mcpmod._sdk_ready.is_set()


# ── mcp 2.x path: streamablehttp_client absent, httpx2 needed ────────────────

def make_httpx2():
    mod = types.ModuleType("httpx2")

    class HTTPStatusError(Exception):
        def __init__(self, message, *, request=None, response=None):
            super().__init__(message)
            self.request = request
            self.response = response

    class Timeout:
        def __init__(self, *args, **kwargs):
            pass

    class AsyncClient:
        def __init__(self, headers=None, timeout=None, event_hooks=None):
            self.headers = headers
            self.event_hooks = event_hooks or {}
            self.is_closed = False

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            self.is_closed = True

    mod.HTTPStatusError, mod.Timeout, mod.AsyncClient = HTTPStatusError, Timeout, AsyncClient
    return mod


@pytest.fixture
def mcp2(monkeypatch):
    import mcp.client.session
    import mcp.client.streamable_http as sh
    monkeypatch.delattr(sh, "streamablehttp_client", raising=False)
    monkeypatch.setitem(sys.modules, "httpx2", None)
    monkeypatch.delitem(sys.modules, "httpx2")
    stub = make_httpx2()
    provider = Provide("httpx2", stub)
    sys.meta_path.insert(0, provider)
    state = SimpleNamespace(stub=stub, provider=provider, clients=[], failure=None)

    @asynccontextmanager
    async def streamable_http_client(url, http_client=None):
        state.clients.append(http_client)
        if state.failure is not None:
            hook = http_client.event_hooks["response"][0]
            request = SimpleNamespace(method="POST")
            await hook(SimpleNamespace(request=request, status_code=state.failure))
            raise RuntimeError("jsonrpc error without status; internal secret detail")
        yield ("read", "write")

    @asynccontextmanager
    async def session(read, write):
        yield SimpleNamespace(initialize=AsyncMock(), list_tools=AsyncMock(return_value=SimpleNamespace(tools=[])))

    monkeypatch.setattr(sh, "streamable_http_client", streamable_http_client, raising=False)
    monkeypatch.setattr(mcp.client.session, "ClientSession", session)
    yield state
    if provider in sys.meta_path:
        sys.meta_path.remove(provider)


async def test_mcp2_cold_start_imports_httpx2_off_the_loop_and_closes_its_client(cold_sdk, mcp2):
    remote = MCPSseSession("test", "https://mcp.example/mcp", {"Authorization": "Bearer t"}, transport="http")
    assert await asyncio.wait_for(remote.start(), 10), remote.error
    assert mcp2.provider.threads, "httpx2 was never looked up through the import system"
    assert threading.get_ident() not in mcp2.provider.threads
    assert mcpmod._sdk_ready.is_set()
    assert mcp2.clients[0].headers == {"Authorization": "Bearer t"}
    await remote.stop()
    assert mcp2.clients[0].is_closed


@pytest.mark.parametrize("status,needs_auth,legacy", [(401, True, False), (404, False, True), (405, False, True), (500, False, False)])
async def test_mcp2_cold_http_status_still_drives_auth_and_legacy_flags(cold_sdk, mcp2, status, needs_auth, legacy):
    mcp2.failure = status
    remote = MCPSseSession("test", "https://mcp.example/mcp", transport="http")
    assert not await asyncio.wait_for(remote.start(), 10)
    assert (remote.needs_auth, remote.legacy_endpoint) == (needs_auth, legacy)
    assert "secret" not in remote.error
    assert mcp2.clients[0].is_closed


async def test_mcp2_missing_httpx2_fails_fast_and_is_not_marked_ready(cold_sdk, mcp2, monkeypatch, loop_errors):
    sys.meta_path.remove(mcp2.provider)
    monkeypatch.setitem(sys.modules, "httpx2", None)
    remote = MCPSseSession("test", "https://mcp.example/mcp", transport="http")
    began = time.perf_counter()
    assert not await asyncio.wait_for(remote.start(), 5)
    assert time.perf_counter() - began < 3
    assert remote.error and TIMEOUT_MESSAGE not in remote.error.lower()
    assert not mcpmod._sdk_ready.is_set()
    await remote.stop()
    gc.collect()
    await asyncio.sleep(0.05)
    assert loop_errors == []


# ── existing behaviours, driven through the cold import path (mcp 1.x client) ─

@pytest.fixture
def mcp1_http(monkeypatch):
    import mcp.client.session
    import mcp.client.sse
    import mcp.client.streamable_http as sh
    state = SimpleNamespace(error=None, urls=[])

    @asynccontextmanager
    async def legacy(url, headers=None):
        state.urls.append(("http", url, dict(headers or {})))
        if state.error is not None:
            raise state.error
        yield ("read", "write", lambda: "sid")

    @asynccontextmanager
    async def sse(url, headers=None):
        state.urls.append(("sse", url, dict(headers or {})))
        yield ("read", "write")

    @asynccontextmanager
    async def session(read, write):
        yield SimpleNamespace(initialize=AsyncMock(), list_tools=AsyncMock(return_value=SimpleNamespace(tools=[
            SimpleNamespace(name="q", description="d", inputSchema={"type": "object"})])))

    monkeypatch.setattr(sh, "streamablehttp_client", legacy, raising=False)
    monkeypatch.setattr(mcp.client.sse, "sse_client", sse)
    monkeypatch.setattr(mcp.client.session, "ClientSession", session)
    return state


@pytest.mark.parametrize("build,needs_auth,legacy", [
    (lambda: status_error(401), True, False),
    (lambda: status_error(404), False, True),
    (lambda: status_error(405), False, True),
    (lambda: status_error(500), False, False),
    (lambda: ExceptionGroup("g", [ExceptionGroup("inner", [status_error(401)])]), True, False),
    (lambda: ExceptionGroup("g", [status_error(405)]), False, True),
    (lambda: RuntimeError("connection refused"), False, False),
])
async def test_cold_start_still_maps_http_failures(cold_sdk, mcp1_http, build, needs_auth, legacy):
    mcp1_http.error = build()
    remote = MCPSseSession("test", "https://mcp.example/mcp", transport="http")
    assert not await asyncio.wait_for(remote.start(), 10)
    assert (remote.needs_auth, remote.legacy_endpoint) == (needs_auth, legacy)
    assert "secret" not in (remote.error or "") and remote.error
    assert mcpmod._sdk_ready.is_set(), "the SDK imported fine; only the server refused"
    assert not remote.is_alive()


async def test_cold_start_reports_tools_and_stop_cancels(cold_sdk, mcp1_http):
    remote = MCPSseSession("test", "https://mcp.example/mcp", {"X-Key": "k"}, transport="http")
    assert await remote.start()
    assert remote.is_alive() and [t.full_name for t in remote.tools] == ["mcp__test__q"]
    await remote.stop()
    assert not remote.is_alive() and remote._session is None


@pytest.mark.parametrize("failure,expected_status", [(401, "needs_auth"), (500, "error")])
async def test_manager_cold_start_status_for_http_failures(tmp_path, monkeypatch, cold_sdk, mcp1_http, failure, expected_status):
    config.set_trusted(str(tmp_path))
    monkeypatch.setattr(oauth, "ensure_fresh_token", AsyncMock(return_value=None))
    mcp1_http.error = status_error(failure)
    manager = MCPClientManager(str(tmp_path))
    await manager.start_server("srv", {"url": "https://mcp.example/mcp"})
    entry = manager.server_status["srv"]
    assert entry["status"] == expected_status
    assert "secret" not in (entry.get("error") or "") + (entry.get("error_detail") or "")
    assert "srv" not in manager.sessions


async def test_manager_cold_start_falls_back_to_legacy_sse_on_405(tmp_path, monkeypatch, cold_sdk, mcp1_http):
    config.set_trusted(str(tmp_path))
    monkeypatch.setattr(oauth, "ensure_fresh_token", AsyncMock(return_value=None))
    mcp1_http.error = status_error(405)
    manager = MCPClientManager(str(tmp_path))
    await manager.start_server("srv", {"url": "https://mcp.example/events"})
    assert manager.server_status["srv"]["status"] == "running"
    assert manager.sessions["srv"].transport == "sse"
    assert [kind for kind, _, _ in mcp1_http.urls] == ["http", "sse"]
    await manager.stop_all()


async def test_manager_start_with_blocked_import_reports_error_not_a_hang(tmp_path, monkeypatch, cold_sdk, gate_import, fake_remote):
    config.set_trusted(str(tmp_path))
    monkeypatch.setattr(oauth, "ensure_fresh_token", AsyncMock(return_value=None))
    gate_import(raises=ImportError("broken install"))
    manager = MCPClientManager(str(tmp_path))
    await asyncio.wait_for(manager.start_server("srv", {"url": "https://mcp.example/sse", "type": "sse"}), 10)
    assert manager.server_status["srv"]["status"] == "error"
    assert manager.server_status["srv"]["error"]
    await manager.stop_all()


async def test_concurrent_cold_starts_do_not_starve_the_default_executor(cold_sdk, gate_import, fake_remote):
    from concurrent.futures import ThreadPoolExecutor
    loop = asyncio.get_running_loop()
    pool = ThreadPoolExecutor(max_workers=4)
    loop.set_default_executor(pool)
    gate = gate_import(block=True)
    remotes = [MCPSseSession(f"s{i}", "https://mcp.example/sse", transport="sse") for i in range(8)]
    tasks = [asyncio.create_task(r.start()) for r in remotes]
    deadline = time.perf_counter() + 5
    while not gate.entered.is_set() and time.perf_counter() < deadline:
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.3)
    unrelated = asyncio.ensure_future(asyncio.to_thread(lambda: "done"))
    try:
        finished, _ = await asyncio.wait({unrelated}, timeout=1.0)
        starved = not finished
    finally:
        gate.release.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 15)
        await asyncio.gather(*(r.stop() for r in remotes))
        pool.shutdown(wait=True)
    assert not starved, "N concurrent first starts each hold a default-executor worker for the whole import"


async def test_sdk_session_class_missing_after_a_clean_import_fails_cleanly(cold_sdk, monkeypatch, loop_errors):
    import mcp.client.session

    @asynccontextmanager
    async def transport(kind, url, headers):
        yield ("read", "write")

    monkeypatch.setattr(mcpmod, "open_remote_transport", lambda *a: transport(*a))
    monkeypatch.delattr(mcp.client.session, "ClientSession")
    remote = MCPSseSession("test", "https://mcp.example/sse", transport="sse")
    began = time.perf_counter()
    assert not await asyncio.wait_for(remote.start(), 5)
    assert time.perf_counter() - began < 3
    assert remote.error and TIMEOUT_MESSAGE not in remote.error.lower()
    await remote.stop()
    gc.collect()
    await asyncio.sleep(0.05)
    assert loop_errors == []
