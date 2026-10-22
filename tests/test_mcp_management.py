import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from andromity.config import config
from andromity.core import oauth
from andromity.core.mcp import MCPClientManager, MCPSseSession
from andromity.core.skills import SkillsManager
from andromity.server.rpc_handler import JsonRpcHandler


def mock_http(monkeypatch, responder):
    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client(transport=httpx.MockTransport(responder), **kw))


async def test_discovery_uses_challenge_and_external_path_issuer(monkeypatch):
    seen = []
    def respond(request):
        seen.append(str(request.url))
        if request.url.host == "mcp.example" and request.url.path == "/mcp":
            return httpx.Response(401, headers={"www-authenticate": 'Bearer resource_metadata="https://mcp.example/metadata"'})
        if request.url.path == "/metadata":
            return httpx.Response(200, json={"resource": "https://mcp.example/mcp", "authorization_servers": ["https://auth.example/auth/v1"], "scopes_supported": ["tools:read"]})
        if request.url.path == "/.well-known/oauth-authorization-server/auth/v1":
            return httpx.Response(200, json={"issuer": "https://auth.example/auth/v1", "authorization_endpoint": "https://auth.example/authorize", "token_endpoint": "https://auth.example/token"})
        return httpx.Response(404)
    mock_http(monkeypatch, respond)
    meta = await oauth.discover_metadata("https://mcp.example/mcp?project_ref=abc")
    assert meta["token_endpoint"] == "https://auth.example/token"
    assert meta["resource"] == "https://mcp.example/mcp"
    assert meta["scopes_supported"] == ["tools:read"]
    assert "https://mcp.example/metadata" in seen


async def test_discovery_rejects_wrong_issuer(monkeypatch):
    mock_http(monkeypatch, lambda request: httpx.Response(200, json={"issuer": "https://wrong.example", "authorization_endpoint": "https://wrong.example/auth", "token_endpoint": "https://wrong.example/token"}))
    assert await oauth.discover_metadata("https://mcp.example/mcp") is None


@pytest.mark.parametrize("auth_method", ["none", "client_secret_basic", "client_secret_post"])
async def test_flow_listener_ready_pkce_and_resource(monkeypatch, auth_method):
    meta = {"authorization_endpoint": "https://auth.example/authorize?existing=1", "token_endpoint": "https://auth.example/token", "registration_endpoint": "https://auth.example/register", "resource": "https://mcp.example/mcp", "token_endpoint_auth_methods_supported": [auth_method]}
    monkeypatch.setattr(oauth, "discover_metadata", AsyncMock(return_value=meta))
    secret = "registered-secret" if auth_method != "none" else None
    registration = AsyncMock(return_value={"client_id": "registered-client", "client_secret": secret, "token_endpoint_auth_method": auth_method})
    monkeypatch.setattr(oauth, "dynamic_register", registration)
    monkeypatch.setattr(oauth, "_find_free_port", lambda: 54321)
    gate = asyncio.Event()
    listener_bound = []
    async def callback(port, expected_state, ready):
        listener_bound.append(True)
        ready.set()
        await gate.wait()
        return "code"
    monkeypatch.setattr(oauth, "run_callback_server", callback)
    urls = []
    def browser(url):
        assert listener_bound
        urls.append(url)
        gate_loop.call_soon_threadsafe(gate.set)
        return True
    gate_loop = asyncio.get_running_loop()
    monkeypatch.setattr(oauth.webbrowser, "open", browser)
    exchange = AsyncMock(return_value={"access_token": "test-token"})
    monkeypatch.setattr(oauth, "exchange_code", exchange)
    saved = []
    saved_credentials = []
    def save(*args, **kwargs):
        saved.append(args)
        saved_credentials.append(kwargs)
    monkeypatch.setattr(oauth, "store_token", save)
    assert await oauth.full_oauth_flow("test", "https://mcp.example/mcp?project_ref=abc", lambda _: None) == "test-token"
    query = parse_qs(urlparse(urls[0]).query)
    assert query["existing"] == ["1"]
    assert query["client_id"] == ["registered-client"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["resource"] == ["https://mcp.example/mcp"]
    assert "scope" not in query
    assert exchange.call_args.args[-1] == "https://mcp.example/mcp"
    assert saved[0][-1] == "https://mcp.example/mcp"
    assert registration.call_args.kwargs["auth_method"] == auth_method
    assert exchange.call_args.kwargs == {"client_secret": secret, "auth_method": auth_method}
    assert saved_credentials[0] == {"client_secret": secret, "auth_method": auth_method}


async def test_flow_does_not_invent_client_id(monkeypatch):
    monkeypatch.setattr(oauth, "discover_metadata", AsyncMock(return_value={"authorization_endpoint": "https://auth.example/authorize", "token_endpoint": "https://auth.example/token"}))
    monkeypatch.setattr(oauth, "_find_free_port", lambda: 54321)
    progress = []
    assert await oauth.full_oauth_flow("test", "https://mcp.example/mcp", progress.append) is None
    assert "oauth.client_id" in progress[-1]


async def test_token_requests_include_resource(monkeypatch):
    bodies = []
    def respond(request):
        bodies.append(parse_qs(request.content.decode()))
        return httpx.Response(200, json={"access_token": "new-token"})
    mock_http(monkeypatch, respond)
    await oauth.exchange_code("https://auth.example/token", "code", "verifier", "id", "http://127.0.0.1/callback", "https://mcp.example/mcp")
    await oauth.refresh_access_token("https://auth.example/token", "refresh", "id", "https://mcp.example/mcp")
    assert all(body["resource"] == ["https://mcp.example/mcp"] for body in bodies)


@pytest.mark.parametrize("method", ["client_secret_basic", "client_secret_post"])
async def test_code_and_refresh_use_registered_client_secret(monkeypatch, method):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"access_token": "new-token"})
    mock_http(monkeypatch, respond)
    await oauth.exchange_code("https://auth.example/token", "code", "verifier", "id", "http://127.0.0.1/callback", "https://mcp.example/mcp", client_secret="secret", auth_method=method)
    await oauth.refresh_access_token("https://auth.example/token", "refresh", "id", "https://mcp.example/mcp", client_secret="secret", auth_method=method)
    assert len(requests) == 2
    for request in requests:
        body = parse_qs(request.content.decode())
        assert body["resource"] == ["https://mcp.example/mcp"]
        if method == "client_secret_basic":
            assert request.headers["Authorization"] == "Basic aWQ6c2VjcmV0"
            assert "client_secret" not in body
            assert "client_id" not in body
        else:
            assert body["client_secret"] == ["secret"]
            assert body["client_id"] == ["id"]


async def test_registration_requests_advertised_auth_method(monkeypatch):
    payloads = []
    def respond(request):
        payloads.append(json.loads(request.content))
        return httpx.Response(201, json={"client_id": "id", "client_secret": "secret", "token_endpoint_auth_method": "client_secret_basic"})
    mock_http(monkeypatch, respond)
    reg = await oauth.dynamic_register("https://auth.example/register", "http://127.0.0.1/callback", auth_method="client_secret_basic")
    assert reg["client_secret"] == "secret"
    assert payloads[0]["token_endpoint_auth_method"] == "client_secret_basic"


async def test_refresh_retains_stored_client_authentication(tmp_path, monkeypatch):
    monkeypatch.setattr(oauth, "TOKEN_FILE", tmp_path / "tokens.json")
    oauth.store_token("test", {"access_token": "old", "refresh_token": "refresh", "expires_in": 1}, "id", "https://auth.example/token", "https://mcp.example/mcp", client_secret="secret", auth_method="client_secret_basic")
    monkeypatch.setattr(oauth.time, "time", lambda: 9999999999)
    refresh = AsyncMock(return_value={"access_token": "new", "expires_in": 3600})
    monkeypatch.setattr(oauth, "refresh_access_token", refresh)
    assert await oauth.ensure_fresh_token("test") == "new"
    assert refresh.call_args.kwargs == {"client_secret": "secret", "auth_method": "client_secret_basic"}
    stored = oauth.load_token("test")
    assert stored["client_secret"] == "secret"
    assert stored["token_endpoint_auth_method"] == "client_secret_basic"
    assert stored["refresh_token"] == "refresh"


async def test_refresh_preserves_nonrotated_token(monkeypatch):
    monkeypatch.setattr(oauth, "load_token", lambda _: {"access_token": "old", "refresh_token": "refresh", "expires_at": 1, "token_endpoint": "https://auth.example/token", "client_id": "id", "resource": "https://mcp.example/mcp"})
    monkeypatch.setattr(oauth, "refresh_access_token", AsyncMock(return_value={"access_token": "new", "expires_in": 3600}))
    saved = []
    monkeypatch.setattr(oauth, "store_token", lambda *args, **kwargs: saved.append(args))
    assert await oauth.ensure_fresh_token("test") == "new"
    assert saved[0][1]["refresh_token"] == "refresh"


def use_mcp2_streamable_http(monkeypatch, connection):
    """Route the "http" transport through the mcp 2.x client, even when mcp 1.x is installed."""
    pytest.importorskip("httpx2")
    import mcp.client.streamable_http
    monkeypatch.delattr(mcp.client.streamable_http, "streamablehttp_client", raising=False)
    monkeypatch.setattr(mcp.client.streamable_http, "streamable_http_client", connection, raising=False)


def fake_client_session(monkeypatch, tool):
    """Answer fake ("read", "write") streams; real transport streams still reach the SDK session."""
    import mcp.client.session
    real = mcp.client.session.ClientSession
    def session(read, write):
        if (read, write) != ("read", "write"):
            return real(read, write)
        return fake(read, write)
    @asynccontextmanager
    async def fake(read, write):
        yield SimpleNamespace(initialize=AsyncMock(), list_tools=AsyncMock(return_value=SimpleNamespace(tools=[tool])))
    monkeypatch.setattr(mcp.client.session, "ClientSession", session)


@pytest.mark.parametrize("transport", ["http", "sse"])
async def test_remote_session_sdk_transport_and_lifecycle(monkeypatch, transport):
    import mcp.client.sse
    called = []
    closed = []
    @asynccontextmanager
    async def connection(url, headers=None, http_client=None):
        called.append((url, dict(http_client.headers) if http_client else headers))
        try:
            yield ("read", "write")
        finally:
            closed.append(True)
    if transport == "http":
        use_mcp2_streamable_http(monkeypatch, connection)
    else:
        monkeypatch.setattr(mcp.client.sse, "sse_client", connection)
    fake_client_session(monkeypatch, SimpleNamespace(name="query", description="Query", input_schema={"type": "object"}))
    remote = MCPSseSession("test", "https://mcp.example/mcp", {"X-Key": "key"}, transport=transport)
    assert await remote.start()
    assert remote.tools[0].full_name == "mcp__test__query"
    assert remote.tools[0].input_schema == {"type": "object"}
    assert remote.is_alive()
    await remote.stop()
    assert not remote.is_alive()
    assert closed == [True]
    assert called[0][0] == "https://mcp.example/mcp"
    assert {k.lower(): v for k, v in called[0][1].items()}["x-key"] == "key"


async def test_http_transport_closes_its_httpx2_client(monkeypatch):
    clients = []
    @asynccontextmanager
    async def connection(url, http_client):
        clients.append(http_client)
        yield ("read", "write")
    use_mcp2_streamable_http(monkeypatch, connection)
    fake_client_session(monkeypatch, SimpleNamespace(name="query", description="", input_schema={}))
    remote = MCPSseSession("test", "https://mcp.example/mcp", {"Authorization": "Bearer t"}, transport="http")
    assert await remote.start()
    assert clients[0].headers["authorization"] == "Bearer t"
    assert not clients[0].is_closed
    await remote.stop()
    assert clients[0].is_closed


async def test_http_transport_keeps_mcp1_client_when_available(monkeypatch):
    import mcp.client.streamable_http
    called = []
    @asynccontextmanager
    async def legacy(url, headers):
        called.append(("legacy", headers))
        yield ("read", "write", lambda: "session-id")
    @asynccontextmanager
    async def modern(url, http_client):
        called.append(("modern", None))
        yield ("read", "write")
    monkeypatch.setattr(mcp.client.streamable_http, "streamablehttp_client", legacy, raising=False)
    monkeypatch.setattr(mcp.client.streamable_http, "streamable_http_client", modern, raising=False)
    fake_client_session(monkeypatch, SimpleNamespace(name="query", description="", inputSchema={"type": "object"}))
    remote = MCPSseSession("test", "https://mcp.example/mcp", {"X-Key": "key"}, transport="http")
    assert await remote.start()
    assert called == [("legacy", {"X-Key": "key"})]
    assert remote.tools[0].input_schema == {"type": "object"}
    await remote.stop()


async def test_sse_transport_never_touches_streamable_http(monkeypatch):
    import mcp.client.sse
    import mcp.client.streamable_http
    called = []
    @asynccontextmanager
    async def sse(url, headers):
        called.append(("sse", url, headers))
        yield ("read", "write")
    def unexpected(*args, **kwargs):
        raise AssertionError("streamable HTTP client used for an SSE server")
    monkeypatch.setattr(mcp.client.sse, "sse_client", sse)
    monkeypatch.setattr(mcp.client.streamable_http, "streamablehttp_client", unexpected, raising=False)
    monkeypatch.setattr(mcp.client.streamable_http, "streamable_http_client", unexpected, raising=False)
    fake_client_session(monkeypatch, SimpleNamespace(name="query", description="", input_schema={}))
    remote = MCPSseSession("test", "https://mcp.example/sse", {"X-Key": "key"}, transport="sse")
    assert await remote.start()
    assert called == [("sse", "https://mcp.example/sse", {"X-Key": "key"})]
    await remote.stop()


@pytest.mark.parametrize("status,needs_auth,legacy", [(401, True, False), (404, False, True), (405, False, True), (500, False, False)])
async def test_mcp2_http_status_reaches_auth_and_legacy_detection(monkeypatch, status, needs_auth, legacy):
    httpx2 = pytest.importorskip("httpx2")
    import mcp.client.streamable_http
    if hasattr(mcp.client.streamable_http, "streamablehttp_client"):
        pytest.skip("mcp 1.x raises HTTPStatusError itself")
    client = httpx2.AsyncClient
    respond = lambda request: httpx2.Response(status, text="internal secret detail")
    monkeypatch.setattr(httpx2, "AsyncClient", lambda **kw: client(transport=httpx2.MockTransport(respond), **kw))
    remote = MCPSseSession("test", "https://mcp.example/mcp", {"Authorization": "Bearer t"}, transport="http")
    assert not await remote.start()
    assert (remote.needs_auth, remote.legacy_endpoint) == (needs_auth, legacy)
    assert "secret" not in remote.error


async def test_auto_transport_falls_back_to_sse_on_real_mcp2_405(tmp_path, monkeypatch):
    httpx2 = pytest.importorskip("httpx2")
    import mcp.client.sse
    import mcp.client.streamable_http
    if hasattr(mcp.client.streamable_http, "streamablehttp_client"):
        pytest.skip("mcp 1.x raises HTTPStatusError itself")
    config.set_trusted(str(tmp_path))
    monkeypatch.setattr(oauth, "ensure_fresh_token", AsyncMock(return_value=None))
    client = httpx2.AsyncClient
    monkeypatch.setattr(httpx2, "AsyncClient", lambda **kw: client(transport=httpx2.MockTransport(lambda r: httpx2.Response(405)), **kw))
    @asynccontextmanager
    async def sse(url, headers):
        yield ("read", "write")
    monkeypatch.setattr(mcp.client.sse, "sse_client", sse)
    fake_client_session(monkeypatch, SimpleNamespace(name="query", description="", input_schema={}))
    manager = MCPClientManager(str(tmp_path))
    await manager.start_server("legacy", {"url": "https://mcp.example/events"})
    assert manager.server_status["legacy"]["status"] == "running"
    assert manager.sessions["legacy"].transport == "sse"
    await manager.stop_all()


@pytest.mark.parametrize("tool", [
    SimpleNamespace(name="q", description="d", input_schema={"type": "object", "required": ["x"]}),
    SimpleNamespace(name="q", description="d", inputSchema={"type": "object", "required": ["x"]}),
])
def test_sdk_tool_schema_survives_mcp2_field_rename(tool):
    from andromity.core.mcp import sdk_tool_info
    info = sdk_tool_info("srv", tool)
    assert info.input_schema == {"type": "object", "required": ["x"]}
    assert info.to_openai_schema()["function"]["parameters"]["required"] == ["x"]


def test_sdk_tool_schema_from_real_mcp_tool_type():
    from mcp.types import Tool
    from andromity.core.mcp import sdk_tool_info
    tool = Tool.model_validate({"name": "q", "inputSchema": {"type": "object", "properties": {"x": {"type": "string"}}}})
    assert sdk_tool_info("srv", tool).input_schema["properties"] == {"x": {"type": "string"}}


async def test_remote_manager_preserves_headers_and_allows_public_servers(tmp_path, monkeypatch):
    config.set_trusted(str(tmp_path))
    monkeypatch.setattr(oauth, "ensure_fresh_token", AsyncMock(return_value=None))
    seen = []
    class Remote:
        def __init__(self, **kwargs):
            seen.append(kwargs)
            self.tools = []
            self.transport = kwargs["transport"]
        async def start(self):
            return True
    monkeypatch.setattr("andromity.core.mcp.MCPSseSession", Remote)
    manager = MCPClientManager(str(tmp_path))
    await manager.start_server("public", {"url": "https://mcp.example/mcp", "headers": {"X-API-Key": "key"}})
    assert seen[0]["transport"] == "http"
    assert seen[0]["headers"] == {"X-API-Key": "key"}
    assert manager.server_status["public"]["status"] == "running"


async def test_mcp_remote_command_keeps_its_header_arguments(tmp_path, monkeypatch):
    config.set_trusted(str(tmp_path))
    monkeypatch.setattr(oauth, "ensure_fresh_token", AsyncMock(return_value=None))
    seen = []
    class Remote:
        def __init__(self, **kwargs):
            seen.append(kwargs)
            self.tools = []
            self.transport = kwargs["transport"]
        async def start(self):
            return True
    monkeypatch.setattr("andromity.core.mcp.MCPSseSession", Remote)
    manager = MCPClientManager(str(tmp_path))
    await manager.start_server("legacy", {
        "command": "npx",
        "args": ["-y", "mcp-remote", "https://mcp.example/sse", "--header", "Authorization:Bearer pat-123",
                 "--header", "X-Team: core"],
    })
    assert seen[0]["url"] == "https://mcp.example/sse"
    assert seen[0]["headers"] == {"Authorization": "Bearer pat-123", "X-Team": "core"}


async def test_remote_manager_blocks_untrusted_before_auth(tmp_path, monkeypatch):
    token = AsyncMock()
    monkeypatch.setattr(oauth, "ensure_fresh_token", token)
    manager = MCPClientManager(str(tmp_path))
    await manager.start_server("test", {"url": "https://mcp.example/mcp"})
    assert manager.server_status["test"]["status"] == "needs_trust"
    token.assert_not_awaited()


async def test_auto_transport_falls_back_to_legacy_sse(tmp_path, monkeypatch):
    config.set_trusted(str(tmp_path))
    monkeypatch.setattr(oauth, "ensure_fresh_token", AsyncMock(return_value=None))
    seen = []
    class Remote:
        def __init__(self, **kwargs):
            self.transport = kwargs["transport"]
            seen.append(self.transport)
            self.legacy_endpoint = self.transport == "http"
            self.needs_auth = False
            self.tools = []
        async def start(self):
            return self.transport == "sse"
        async def stop(self):
            pass
    monkeypatch.setattr("andromity.core.mcp.MCPSseSession", Remote)
    manager = MCPClientManager(str(tmp_path))
    await manager.start_server("legacy", {"url": "https://mcp.example/events"})
    assert seen == ["http", "sse"]
    assert manager.server_status["legacy"]["status"] == "running"


async def test_http_auth_failure_is_actionable_and_sanitized(monkeypatch):
    @asynccontextmanager
    async def connection(*args, **kwargs):
        request = httpx.Request("POST", "https://mcp.example/mcp")
        response = httpx.Response(401, request=request)
        raise ExceptionGroup("internal secret", [httpx.HTTPStatusError("sensitive detail", request=request, response=response)])
        yield
    use_mcp2_streamable_http(monkeypatch, connection)
    remote = MCPSseSession("test", "https://mcp.example/mcp", transport="http")
    assert not await remote.start()
    assert remote.needs_auth
    assert "secret" not in remote.error
    assert "sensitive" not in remote.error


async def test_mcp_add_remove_persists_and_cleans_live_state(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    monkeypatch.setattr(oauth, "TOKEN_FILE", tmp_path / "tokens.json")
    config.set_trusted(str(tmp_path))
    handler = JsonRpcHandler()
    params = {"project_path": str(tmp_path), "name": "supabase", "config": {"url": "https://mcp.example/mcp", "disabled": True}}
    assert (await handler.rpc_mcp_add(params))["success"]
    assert not (await handler.rpc_mcp_add(params))["success"]
    assert handler._mcp_manager.server_status["supabase"]["status"] == "disabled"
    oauth.store_token("supabase", {"access_token": "secret"}, "id", "endpoint")
    assert (await handler.rpc_mcp_remove(params))["success"]
    assert "supabase" not in handler._mcp_manager.server_status
    assert oauth.load_token("supabase") is None
    assert json.loads((tmp_path / ".andromity/mcp.json").read_text())["mcpServers"] == {}


async def test_mcp_list_includes_tool_descriptions_without_schemas(tmp_path, monkeypatch):
    from andromity.core.mcp import MCPToolInfo
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    config.add_mcp_server(str(tmp_path), "test", {"url": "https://mcp.example/mcp"})
    handler = JsonRpcHandler()
    handler._mcp_manager = SimpleNamespace(
        project_path=str(tmp_path),
        check_liveness=lambda: None,
        server_status={"test": {"status": "running", "tools": 1}},
        sessions={"test": SimpleNamespace(tools=[MCPToolInfo("test", "list_tables", "List project tables", {"type": "object"})])},
    )
    handler._mcp_started = True
    servers = await handler.rpc_mcp_list({"project_path": str(tmp_path)})
    assert servers[0]["tools_count"] == 1
    assert servers[0]["tools"] == [{"name": "list_tables", "description": "List project tables"}]


async def test_constructed_manager_is_started_once_on_list(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    config.add_mcp_server(str(tmp_path), "test", {"command": "test", "disabled": True})
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    handler = JsonRpcHandler()
    manager = SimpleNamespace(project_path=str(tmp_path), sessions={}, server_status={},
                              start_all=AsyncMock(), check_liveness=lambda: None)
    handler._mcp_manager = manager
    await handler.rpc_mcp_list({"project_path": str(tmp_path)})
    await handler.rpc_mcp_list({"project_path": str(tmp_path)})
    manager.start_all.assert_awaited_once()


async def test_failed_startup_can_retry(tmp_path):
    from unittest.mock import AsyncMock
    handler = JsonRpcHandler()
    manager = SimpleNamespace(project_path=str(tmp_path), sessions={},
                              start_all=AsyncMock(side_effect=[RuntimeError("startup"), None]))
    handler._mcp_manager = manager
    with pytest.raises(RuntimeError):
        await handler._ensure_mcp_started(str(tmp_path))
    assert not handler._mcp_started
    await handler._ensure_mcp_started(str(tmp_path))
    assert handler._mcp_started


async def test_project_switch_stops_old_sessions_before_starting_new(tmp_path):
    handler = JsonRpcHandler()
    old = tmp_path / "old"
    new = tmp_path / "new"
    observed = []
    manager = SimpleNamespace(project_path=str(old), sessions={})
    async def stop():
        observed.append(("stop", manager.project_path))
    async def start():
        observed.append(("start", manager.project_path))
    manager.stop_all = stop
    manager.start_all = start
    handler._mcp_manager = manager
    handler._mcp_started = True
    await handler._ensure_mcp_started(str(new))
    assert observed == [("stop", str(old)), ("start", str(new))]


async def test_management_rejects_untrusted_and_malformed(tmp_path):
    handler = JsonRpcHandler()
    params = {"project_path": str(tmp_path), "name": "test", "config": {"url": "https://mcp.example/mcp", "disabled": True}}
    assert not (await handler.rpc_mcp_add(params))["success"]
    assert not (tmp_path / ".andromity/mcp.json").exists()
    config.set_trusted(str(tmp_path))
    for conf in ({"url": "javascript:alert(1)"}, {"command": "npx", "args": "bad"}, {"url": "https://mcp.example", "headers": []}):
        assert not (await handler.rpc_mcp_add({**params, "config": conf}))["success"]
    path = tmp_path / ".andromity/mcp.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text("broken JSON", encoding="utf-8")
    assert not (await handler.rpc_mcp_add(params))["success"]
    assert path.read_text() == "broken JSON"


def test_skill_removal_targets_selected_copy_and_rejects_traversal(tmp_path):
    user = tmp_path / "user-skills"
    project = tmp_path / ".agents/skills/docx"
    fallback = user / "docx"
    for skill in (project, fallback):
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("# Skill", encoding="utf-8")
    manager = SkillsManager(str(tmp_path), user_dir=user)
    assert manager.uninstall("docx", str(project))
    assert fallback.is_dir()
    assert manager.installed()[0].path == str(fallback)
    with pytest.raises(ValueError):
        manager.uninstall("../user-skills")
    with pytest.raises(ValueError):
        manager.uninstall("docx", str(tmp_path))


async def test_skill_remove_rpc_requires_selected_installed_path(tmp_path):
    config.set_trusted(str(tmp_path))
    skill = tmp_path / ".andromity/skills/test"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Skill", encoding="utf-8")
    handler = JsonRpcHandler()
    params = {"name": "test", "project_path": str(tmp_path)}
    assert not (await handler.rpc_skills_remove(params))["success"]
    assert (await handler.rpc_skills_remove({**params, "path": str(skill)}))["success"]
    assert not skill.exists()
