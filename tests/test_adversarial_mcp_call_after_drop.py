"""Adversarial probes for MCPSseSession.call_tool when a remote connection drops, stalls or is cancelled.

Real SDK ClientSession + lowlevel Server run over in-memory streams. The transport context raises from a
sibling task of an anyio task group, which is how the SDK's HTTP transports fail and the case in which the
receive loop cannot deliver "Connection closed" to pending requests. Race tests use a fake SDK session so the
event-loop ordering is exact.
"""
import asyncio
import gc
import time
import warnings
from contextlib import asynccontextmanager
from types import SimpleNamespace

import anyio
import httpx
import mcp.types as types
import pytest
from mcp.server.lowlevel import Server
from mcp.shared.exceptions import McpError
from mcp.shared.memory import create_client_server_memory_streams

from andromity.core import mcp as mcpmod
from andromity.core.mcp import MCPClientManager, MCPSseSession

SECRET = "sk-live-TOP-SECRET-0123456789"
URL = "https://mcp.example.invalid/v1/secret-path"


def http_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", URL)
    return httpx.HTTPStatusError(f"HTTP {status}", request=request, response=httpx.Response(status, request=request))


class StatusShaped(Exception):
    def __init__(self, status):
        super().__init__("status-shaped failure")
        self.response = SimpleNamespace(status_code=status)


async def within(awaitable, seconds=5.0):
    return await asyncio.wait_for(awaitable, seconds)


async def until(predicate, seconds=5.0):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, "condition not reached"
        await asyncio.sleep(0.005)


async def settle():
    for _ in range(6):
        await asyncio.sleep(0)
    gc.collect()
    await asyncio.sleep(0)
    gc.collect()


def stray_tasks():
    me = asyncio.current_task()
    return [t for t in asyncio.all_tasks() if t is not me and not t.done()]


class Hygiene:
    def __init__(self):
        self.loop_errors = []
        self.warnings = []

    async def check(self):
        await settle()
        bad = [str(c.get("message", "")) for c in self.loop_errors if "never retrieved" in str(c.get("message", ""))]
        bad += [str(w.message) for w in self.warnings
                if "never awaited" in str(w.message) or "never retrieved" in str(w.message)]
        assert not bad, bad


@pytest.fixture
async def hygiene():
    loop = asyncio.get_running_loop()
    h = Hygiene()
    loop.set_exception_handler(lambda _loop, context: h.loop_errors.append(context))
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        h.warnings = caught
        yield h
    loop.set_exception_handler(None)


class Remote:
    """In-memory remote MCP server whose transport can be made to fail or hang up on demand."""

    def __init__(self):
        self.entered = 0
        self.release = asyncio.Event()
        self.drop = asyncio.Event()
        self.hangup = asyncio.Event()
        self.drop_exc = None
        self.unwrap = False
        self.list_calls = 0
        self.gate_relist = False
        self.relist_gate = asyncio.Event()
        self.server = Server("adversarial")
        remote = self

        @self.server.list_tools()
        async def list_tools() -> list[types.Tool]:
            remote.list_calls += 1
            if remote.gate_relist:
                await remote.relist_gate.wait()
            schema = {"type": "object", "properties": {"text": {"type": "string"}}}
            return [types.Tool(name=n, description=n, inputSchema=schema)
                    for n in ("echo", "block", "fail", "image", "mixed")]

        @self.server.call_tool()
        async def call_tool(name: str, arguments: dict):
            if name == "echo":
                return [types.TextContent(type="text", text=arguments.get("text", "hi"))]
            if name == "block":
                remote.entered += 1
                await remote.release.wait()
                return [types.TextContent(type="text", text="released")]
            if name == "hidden":
                return [types.TextContent(type="text", text="hidden-result")]
            if name == "fail":
                raise RuntimeError("tool exploded")
            if name == "image":
                return [types.ImageContent(type="image", data="aGk=", mimeType="image/png")]
            if name == "mixed":
                return [types.TextContent(type="text", text="a"),
                        types.ImageContent(type="image", data="aGk=", mimeType="image/png"),
                        types.TextContent(type="text", text="b")]
            raise ValueError(name)

    def fail(self, exc, unwrap=False):
        self.drop_exc = exc
        self.unwrap = unwrap
        self.drop.set()

    async def _serve(self, read, write):
        await self.server.run(read, write, self.server.create_initialization_options())

    async def _watch(self):
        await self.drop.wait()
        raise self.drop_exc

    async def _hangup(self, write):
        await self.hangup.wait()
        await write.aclose()

    @asynccontextmanager
    async def transport(self, kind, url, headers):
        try:
            async with create_client_server_memory_streams() as (client_streams, server_streams):
                async with anyio.create_task_group() as tg:
                    tg.start_soon(self._serve, *server_streams)
                    tg.start_soon(self._watch)
                    tg.start_soon(self._hangup, server_streams[1])
                    yield client_streams
                    tg.cancel_scope.cancel()
        except BaseExceptionGroup as group:
            if self.unwrap and len(group.exceptions) == 1 and isinstance(group.exceptions[0], Exception):
                raise group.exceptions[0] from group
            raise


@pytest.fixture
async def make_session(monkeypatch):
    remotes = {}
    sessions = []
    monkeypatch.setattr(mcpmod, "open_remote_transport", lambda kind, url, headers: remotes[url].transport(kind, url, headers))

    async def make(remote, name="srv"):
        url = f"{URL}/{len(remotes)}"
        remotes[url] = remote
        session = MCPSseSession(name, url, headers={"Authorization": f"Bearer {SECRET}"}, transport="http")
        assert await within(session.start(), 15), session.error
        sessions.append(session)
        return session

    yield make
    for session in sessions:
        await within(session.stop(), 5)


@pytest.fixture
async def remote():
    return Remote()


def fake_session(call_tool, name="fake"):
    session = MCPSseSession(name, URL, transport="http")
    end = asyncio.get_running_loop().create_future()

    async def connection():
        await end

    session._bg_task = asyncio.ensure_future(connection())
    session._session = SimpleNamespace(call_tool=call_tool)
    return session, end


@pytest.fixture
async def cleanup_strays():
    yield
    for task in stray_tasks():
        task.cancel()
    await asyncio.sleep(0)


def lost(result: str) -> bool:
    return "connection" in result and "lost" in result


# ── behaviour that must be unchanged ────────────────────────────────────────

async def test_text_result_returned_verbatim(remote, make_session, hygiene):
    s = await make_session(remote)
    assert await within(s.call_tool("echo", {"text": "hello\nworld"})) == "hello\nworld"
    assert await within(s.call_tool("mixed", {})) == "a\nb"
    assert await within(s.call_tool("image", {})) == ""
    await hygiene.check()


async def test_tool_error_result_text_returned(remote, make_session):
    s = await make_session(remote)
    result = await within(s.call_tool("fail", {}))
    assert "tool exploded" in result
    assert "was lost" not in result and "did not answer" not in result


async def test_sdk_exception_formatted_as_before(cleanup_strays):
    async def raises(name, args):
        raise McpError(types.ErrorData(code=-32601, message="Method not found"))

    s, _ = fake_session(raises)
    assert await within(s.call_tool("x", {})) == "Error executing tool 'x': Method not found"


async def test_malformed_result_does_not_escape_call_tool(cleanup_strays):
    async def malformed(name, args):
        return SimpleNamespace(content=[SimpleNamespace(text=None)])

    s, _ = fake_session(malformed)
    result = await within(s.call_tool("x", {}))
    assert isinstance(result, str) and result.startswith("Error")


async def test_result_without_content_attribute_does_not_escape(cleanup_strays):
    async def malformed(name, args):
        return None

    s, _ = fake_session(malformed)
    result = await within(s.call_tool("x", {}))
    assert isinstance(result, str) and result.startswith("Error")


async def test_concurrent_calls_get_their_own_results(remote, make_session, hygiene):
    s = await make_session(remote)
    texts = [f"t{i}" for i in range(50)]
    results = await within(asyncio.gather(*(s.call_tool("echo", {"text": t}) for t in texts)), 10)
    assert results == texts
    await hygiene.check()


class CountingFuture(asyncio.Future):
    added = 0
    removed = 0

    def add_done_callback(self, fn, **kw):
        type(self).added += 1
        super().add_done_callback(fn, **kw)

    def remove_done_callback(self, fn):
        count = super().remove_done_callback(fn)
        type(self).removed += count
        return count


async def test_calls_leave_no_callbacks_on_the_connection_future(cleanup_strays):
    async def quick(name, args):
        return SimpleNamespace(content=[SimpleNamespace(text="ok")])

    s = MCPSseSession("fake", URL, transport="http")
    connection = CountingFuture()
    s._bg_task = connection
    s._session = SimpleNamespace(call_tool=quick)
    CountingFuture.added = CountingFuture.removed = 0
    results = await within(asyncio.gather(*(s.call_tool("t", {}) for _ in range(200))), 5)
    assert set(results) == {"ok"}
    assert CountingFuture.added == 200
    assert CountingFuture.added == CountingFuture.removed


# ── connection drop with calls in flight ────────────────────────────────────

DROPS = [
    ("401-direct", lambda: http_error(401), True, True),
    ("401-in-group", lambda: http_error(401), False, True),
    ("401-nested-group", lambda: ExceptionGroup("outer", [ValueError("x"), ExceptionGroup("inner", [http_error(401)])]), False, True),
    ("401-status-shaped", lambda: StatusShaped(401), False, True),
    ("500", lambda: http_error(500), False, False),
    ("403", lambda: http_error(403), False, False),
    ("no-response", lambda: RuntimeError("plain"), False, False),
    ("response-none", lambda: type("E", (Exception,), {"response": None})("x"), False, False),
]


@pytest.mark.parametrize("make_exc,unwrap,expect_auth", [d[1:] for d in DROPS], ids=[d[0] for d in DROPS])
async def test_inflight_call_ends_promptly_when_transport_fails(remote, make_session, hygiene, make_exc, unwrap, expect_auth):
    s = await make_session(remote)
    call = asyncio.create_task(s.call_tool("block", {}))
    await until(lambda: remote.entered == 1)
    started = time.monotonic()
    remote.fail(make_exc(), unwrap=unwrap)
    result = await within(call, 3)
    assert time.monotonic() - started < 2
    assert lost(result), result
    assert ("Authenticate it again" in result) is expect_auth, result
    assert ("Reconnect it" in result) is (not expect_auth), result
    assert "srv" in result and "block" in result
    assert s.needs_auth is expect_auth
    assert not s.is_alive()
    await hygiene.check()


async def test_error_text_never_leaks_secrets_or_tracebacks(remote, make_session):
    s = await make_session(remote)
    call = asyncio.create_task(s.call_tool("block", {}))
    await until(lambda: remote.entered == 1)
    remote.fail(RuntimeError(f"boom token={SECRET} url={URL}"))
    texts = [await within(call, 3), await within(s.call_tool("echo", {}), 1), s.error or ""]
    for text in texts:
        for needle in (SECRET, URL, "Traceback", "ExceptionGroup", "RuntimeError", "File \""):
            assert needle not in text, (needle, text)


async def test_call_after_drop_fails_at_once(remote, make_session):
    s = await make_session(remote)
    remote.fail(http_error(401))
    await until(lambda: not s.is_alive())
    started = time.monotonic()
    result = await within(s.call_tool("echo", {}), 1)
    assert time.monotonic() - started < 0.5
    assert result.startswith("Error") and "not connected" in result


async def test_call_on_never_started_or_stopped_session_fails_at_once(remote, make_session):
    fresh = MCPSseSession("fresh", URL, transport="http")
    assert "not connected" in await within(fresh.call_tool("echo", {}), 1)
    s = await make_session(remote)
    await within(s.stop(), 5)
    assert "not connected" in await within(s.call_tool("echo", {}), 1)


async def test_many_inflight_calls_all_released_when_connection_drops(remote, make_session, hygiene):
    s = await make_session(remote)
    sdk = s._session
    calls = [asyncio.create_task(s.call_tool("block", {})) for _ in range(80)]
    await until(lambda: remote.entered == 80, 10)
    remote.fail(http_error(401))
    results = await within(asyncio.gather(*calls), 5)
    assert all(lost(r) and "Authenticate it again" in r for r in results), set(results)
    assert not sdk._response_streams
    await hygiene.check()


async def test_calls_issued_while_connection_is_failing_are_released(remote, make_session):
    s = await make_session(remote)
    first = asyncio.create_task(s.call_tool("block", {}))
    await until(lambda: remote.entered == 1)
    remote.fail(http_error(401))
    late = []
    for _ in range(40):
        late.append(asyncio.create_task(s.call_tool("block", {})))
        await asyncio.sleep(0)
    results = await within(asyncio.gather(first, *late), 5)
    assert all(r.startswith("Error") for r in results), results


async def test_stop_with_inflight_calls_returns_promptly(remote, make_session, hygiene):
    s = await make_session(remote)
    sdk = s._session
    calls = [asyncio.create_task(s.call_tool("block", {})) for _ in range(10)]
    await until(lambda: remote.entered == 10)
    await within(s.stop(), 3)
    results = await within(asyncio.gather(*calls), 3)
    assert all(lost(r) and "Reconnect it" in r for r in results), set(results)
    assert not sdk._response_streams
    await hygiene.check()


async def test_calls_started_while_stop_is_pending_are_released(remote, make_session):
    s = await make_session(remote)
    first = asyncio.create_task(s.call_tool("block", {}))
    await until(lambda: remote.entered == 1)
    stopper = asyncio.create_task(s.stop())
    await asyncio.sleep(0)
    late = [asyncio.create_task(s.call_tool("block", {})) for _ in range(20)]
    await within(stopper, 3)
    results = await within(asyncio.gather(first, *late), 3)
    assert all(r.startswith("Error") for r in results), results


async def test_clean_server_hangup_gives_actionable_errors(remote, make_session, monkeypatch):
    monkeypatch.setattr(mcpmod, "REMOTE_TOOL_TIMEOUT_S", 30)
    s = await make_session(remote)
    inflight = asyncio.create_task(s.call_tool("block", {}))
    await until(lambda: remote.entered == 1)
    remote.hangup.set()
    first = await within(inflight, 3)
    assert first.startswith("Error")
    started = time.monotonic()
    later = await within(s.call_tool("echo", {}), 3)
    assert time.monotonic() - started < 2
    detail = later.split(":", 1)[1].strip() if ":" in later else later
    assert later.startswith("Error") and detail, f"empty error detail: {later!r}"


@pytest.mark.xfail(reason="pre-existing: the SDK gives no signal when a server closes its stream cleanly, so the connection task never ends; needs a liveness check", strict=True)
async def test_half_dead_session_is_not_reported_alive_after_server_hangup(remote, make_session):
    s = await make_session(remote)
    remote.hangup.set()
    await asyncio.sleep(0.3)
    await within(s.call_tool("echo", {}), 3)
    assert not s.is_alive()


# ── races ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("extra_yields", [0, 1, 2, 3, 5, 8])
async def test_response_routed_before_drop_is_not_replaced_by_error(remote, make_session, hygiene, extra_yields):
    s = await make_session(remote)
    sdk = s._session
    routed = asyncio.Event()
    original = sdk._handle_response

    async def spy(message):
        await original(message)
        routed.set()

    sdk._handle_response = spy
    call = asyncio.create_task(s.call_tool("block", {}))
    await until(lambda: remote.entered == 1)
    remote.release.set()
    await within(routed.wait(), 3)
    for _ in range(extra_yields):
        await asyncio.sleep(0)
    remote.fail(http_error(401))
    assert await within(call, 3) == "released"
    await hygiene.check()


@pytest.mark.xfail(reason="ClientSession.call_tool makes a second tools/list request for uncached tools; surviving a drop there means bypassing it. The error tells the model to check before retrying", strict=True)
async def test_received_result_survives_drop_during_sdk_output_validation(remote, make_session):
    s = await make_session(remote)
    remote.gate_relist = True
    calls_before = remote.list_calls
    call = asyncio.create_task(s.call_tool("hidden", {}))
    await until(lambda: remote.list_calls > calls_before)
    remote.fail(http_error(401))
    assert await within(call, 3) == "hidden-result"


@pytest.mark.parametrize("connection_first", [False, True])
@pytest.mark.parametrize("extra_yields", [0, 1, 2, 3])
async def test_result_survives_connection_ending_in_the_same_tick(cleanup_strays, extra_yields, connection_first):
    loop = asyncio.get_running_loop()
    gate = loop.create_future()

    async def slow(name, args):
        await gate
        for _ in range(extra_yields):
            await asyncio.sleep(0)
        return SimpleNamespace(content=[SimpleNamespace(text="payload")])

    s, end = fake_session(slow)
    task = asyncio.ensure_future(s.call_tool("t", {}))
    await asyncio.sleep(0.01)

    def fire():
        if connection_first:
            end.set_result(None)
            gate.set_result(None)
        else:
            gate.set_result(None)
            end.set_result(None)

    loop.call_soon(fire)
    assert await within(task, 2) == "payload"


async def test_cancel_racing_with_failing_call_leaves_no_unretrieved_exception(hygiene, cleanup_strays):
    loop = asyncio.get_running_loop()
    gate = loop.create_future()

    async def boom(name, args):
        await gate
        raise RuntimeError("late failure")

    s, end = fake_session(boom)
    task = asyncio.ensure_future(s.call_tool("t", {}))
    await asyncio.sleep(0.01)

    def fire():
        gate.set_result(None)
        task.cancel()

    loop.call_soon(fire)
    with pytest.raises(asyncio.CancelledError):
        await task
    await hygiene.check()


async def test_cancel_racing_with_connection_end_still_cancels_caller(cleanup_strays):
    loop = asyncio.get_running_loop()
    gate = loop.create_future()

    async def slow(name, args):
        await gate

    s, end = fake_session(slow)
    task = asyncio.ensure_future(s.call_tool("t", {}))
    await asyncio.sleep(0.01)

    def fire():
        end.set_result(None)
        task.cancel()

    loop.call_soon(fire)
    try:
        result = await within(task, 2)
    except asyncio.CancelledError:
        return
    pytest.fail(f"caller cancellation was swallowed into {result!r}")


# ── caller cancellation ─────────────────────────────────────────────────────

async def test_caller_cancel_raises_cancelled_and_leaves_session_usable(remote, make_session, hygiene):
    s = await make_session(remote)
    sdk = s._session
    before = set(asyncio.all_tasks())
    call = asyncio.create_task(s.call_tool("block", {}))
    await until(lambda: remote.entered == 1)
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await within(call, 3)
    assert call.cancelled()
    assert not sdk._response_streams
    remote.release.set()
    await asyncio.sleep(0.05)
    await settle()
    leaked = [t for t in asyncio.all_tasks() if t not in before and t is not asyncio.current_task() and not t.done()]
    assert not leaked, leaked
    assert await within(s.call_tool("echo", {"text": "after"}), 3) == "after"
    assert s.is_alive()
    await hygiene.check()


async def test_outer_timeout_cancels_call_like_tools_py_does(remote, make_session, hygiene):
    s = await make_session(remote)
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        async with asyncio.timeout(0.3):
            await s.call_tool("block", {})
    assert time.monotonic() - started < 2
    assert not s._session._response_streams
    assert await within(s.call_tool("echo", {"text": "ok"}), 3) == "ok"
    await hygiene.check()


async def test_many_callers_cancelled_at_once(remote, make_session, hygiene):
    s = await make_session(remote)
    sdk = s._session
    calls = [asyncio.create_task(s.call_tool("block", {})) for _ in range(50)]
    await until(lambda: remote.entered == 50, 10)
    for call in calls:
        call.cancel()
    results = await within(asyncio.gather(*calls, return_exceptions=True), 5)
    assert all(isinstance(r, asyncio.CancelledError) for r in results)
    assert not sdk._response_streams
    await hygiene.check()


async def test_second_cancel_during_cleanup_does_not_leak_the_sdk_call(cleanup_strays):
    release = asyncio.Event()
    state = {"running": 0}

    async def slow_cleanup(name, args):
        state["running"] += 1
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            await release.wait()
            raise
        finally:
            state["running"] -= 1

    s, _ = fake_session(slow_cleanup)
    task = asyncio.ensure_future(s.call_tool("t", {}))
    await asyncio.sleep(0.01)
    task.cancel()
    await asyncio.sleep(0.01)
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await within(task, 2)
    await settle()
    assert state["running"] == 0


# ── timeout ─────────────────────────────────────────────────────────────────

async def test_timeout_ends_call_and_session_stays_usable(remote, make_session, monkeypatch, hygiene):
    monkeypatch.setattr(mcpmod, "REMOTE_TOOL_TIMEOUT_S", 0.3)
    s = await make_session(remote)
    sdk = s._session
    started = time.monotonic()
    result = await within(s.call_tool("block", {}), 3)
    elapsed = time.monotonic() - started
    assert 0.25 <= elapsed < 1.5, elapsed
    assert "did not answer" in result and "0.3" in result and "block" in result
    assert "lost" not in result
    assert not sdk._response_streams
    remote.release.set()
    await asyncio.sleep(0.05)
    assert await within(s.call_tool("echo", {"text": "still"}), 3) == "still"
    assert s.is_alive()
    await hygiene.check()


async def test_many_timeouts_in_parallel(remote, make_session, monkeypatch, hygiene):
    monkeypatch.setattr(mcpmod, "REMOTE_TOOL_TIMEOUT_S", 0.3)
    s = await make_session(remote)
    results = await within(asyncio.gather(*(s.call_tool("block", {}) for _ in range(40))), 5)
    assert all("did not answer" in r for r in results)
    assert not s._session._response_streams
    await hygiene.check()


async def test_timeout_and_drop_at_the_same_moment(remote, make_session, monkeypatch):
    monkeypatch.setattr(mcpmod, "REMOTE_TOOL_TIMEOUT_S", 0.2)
    s = await make_session(remote)
    call = asyncio.create_task(s.call_tool("block", {}))
    await until(lambda: remote.entered == 1)
    await asyncio.sleep(0.19)
    remote.fail(http_error(401))
    result = await within(call, 3)
    assert result.startswith("Error") and ("lost" in result or "did not answer" in result)


async def test_call_that_ignores_cancellation_cannot_outlive_the_timeout(monkeypatch, cleanup_strays):
    monkeypatch.setattr(mcpmod, "REMOTE_TOOL_TIMEOUT_S", 0.1)
    stop = asyncio.Event()

    async def stubborn(name, args):
        while not stop.is_set():
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                continue

    s, _ = fake_session(stubborn)
    task = asyncio.ensure_future(s.call_tool("t", {}))
    try:
        done, _pending = await asyncio.wait({task}, timeout=2)
        assert done, "call_tool is still blocked on a call that ignores cancellation"
        assert task.result().startswith("Error")
    finally:
        stop.set()
        task.cancel()
        await asyncio.wait({task}, timeout=2)


async def test_cancelled_sdk_call_is_not_reported_as_a_timeout(cleanup_strays):
    async def self_cancelled(name, args):
        raise asyncio.CancelledError()

    s, _ = fake_session(self_cancelled)
    started = time.monotonic()
    try:
        result = await within(s.call_tool("t", {}), 2)
    except asyncio.CancelledError:
        return
    assert time.monotonic() - started < 1
    assert "did not answer" not in result, result


async def test_default_timeout_is_finite_and_read_at_call_time(monkeypatch, cleanup_strays):
    assert isinstance(mcpmod.REMOTE_TOOL_TIMEOUT_S, (int, float)) and 0 < mcpmod.REMOTE_TOOL_TIMEOUT_S < 24 * 3600
    gate = asyncio.get_running_loop().create_future()

    async def slow(name, args):
        await gate

    s, _ = fake_session(slow)
    monkeypatch.setattr(mcpmod, "REMOTE_TOOL_TIMEOUT_S", 0.05)
    assert "did not answer" in await within(s.call_tool("t", {}), 2)


# ── manager level ───────────────────────────────────────────────────────────

async def test_manager_reauth_new_session_does_not_adopt_or_strand_old_calls(tmp_path, make_session, hygiene):
    old_remote, new_remote = Remote(), Remote()
    manager = MCPClientManager(str(tmp_path))
    old = await make_session(old_remote)
    manager.sessions["srv"] = old
    inflight = [asyncio.create_task(manager.execute_mcp_tool("mcp__srv__block", {})) for _ in range(3)]
    await until(lambda: old_remote.entered == 3)
    old_remote.fail(http_error(401))
    results = await within(asyncio.gather(*inflight), 3)
    assert all("Authenticate it again" in r for r in results), results
    assert "not connected" in await within(manager.execute_mcp_tool("mcp__srv__echo", {}), 1)

    new = await make_session(new_remote)
    manager.sessions["srv"] = new
    assert await within(manager.execute_mcp_tool("mcp__srv__echo", {"text": "fresh"}), 3) == "fresh"
    await hygiene.check()


async def test_manager_session_replaced_while_calls_are_in_flight(tmp_path, make_session, hygiene):
    old_remote, new_remote = Remote(), Remote()
    manager = MCPClientManager(str(tmp_path))
    old = await make_session(old_remote)
    manager.sessions["srv"] = old
    inflight = [asyncio.create_task(manager.execute_mcp_tool("mcp__srv__block", {})) for _ in range(3)]
    await until(lambda: old_remote.entered == 3)

    new = await make_session(new_remote)
    await within(manager.sessions["srv"].stop(), 3)
    manager.sessions["srv"] = new

    results = await within(asyncio.gather(*inflight), 3)
    assert all(lost(r) for r in results), results
    assert new_remote.entered == 0
    new_remote.release.set()
    assert await within(manager.execute_mcp_tool("mcp__srv__block", {}), 3) == "released"
    await hygiene.check()


async def test_manager_restart_path_with_inflight_calls(tmp_path, make_session, monkeypatch):
    old_remote, new_remote = Remote(), Remote()
    manager = MCPClientManager(str(tmp_path))
    manager.sessions["srv"] = await make_session(old_remote)
    inflight = asyncio.create_task(manager.execute_mcp_tool("mcp__srv__block", {}))
    await until(lambda: old_remote.entered == 1)

    async def fake_start(name, srv_conf=None, trusted=False):
        manager.sessions[name] = await make_session(new_remote)
        manager._set_status(name, status="running", tools=5, error=None, command="")

    monkeypatch.setattr(manager, "load_config", lambda: {"mcpServers": {"srv": {"url": URL}}})
    monkeypatch.setattr(manager, "start_server", fake_start)
    assert await within(manager.restart("srv"), 10)
    assert "lost" in await within(inflight, 3)
    assert await within(manager.execute_mcp_tool("mcp__srv__echo", {"text": "new"}), 3) == "new"


async def test_manager_unknown_server_and_bad_names_unchanged(tmp_path):
    manager = MCPClientManager(str(tmp_path))
    assert "not active" in await manager.execute_mcp_tool("mcp__ghost__x", {})
    assert "Invalid MCP tool name" in await manager.execute_mcp_tool("mcp__ghost", {})
    assert "not an MCP tool" in await manager.execute_mcp_tool("plain", {})


def test_session_started_in_a_closed_loop_fails_at_once(monkeypatch):
    remote = Remote()
    monkeypatch.setattr(mcpmod, "open_remote_transport", lambda kind, url, headers: remote.transport(kind, url, headers))

    async def start():
        session = MCPSseSession("srv", URL, transport="http")
        assert await session.start(), session.error
        return session

    async def call(session):
        return await asyncio.wait_for(session.call_tool("echo", {}), 3)

    session = asyncio.run(start())
    result = asyncio.run(call(session))
    assert result.startswith("Error") and "srv" in result
