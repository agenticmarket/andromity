import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from andromity.config import config
from andromity.core import connectors, oauth
from andromity.server.rpc_handler import JsonRpcHandler


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    monkeypatch.setattr(oauth, "TOKEN_FILE", tmp_path / "tokens.json")
    return tmp_path / "home"


def test_catalog_ids_are_unique_https_and_valid_widget_ids():
    ids = [c.id for c in connectors.CATALOG]
    assert len(ids) == len(set(ids))
    for c in connectors.CATALOG:
        assert urlparse(c.url).scheme == "https"
        assert c.id.replace("-", "").isalnum()
        assert not c.needs_client or c.setup_url


@pytest.mark.parametrize("advertised,issuer", [
    ("https://mcp.example/", "https://auth.example"),
    ("https://mcp.example", "https://auth.example/"),
])
async def test_discovery_tolerates_trailing_slashes(monkeypatch, advertised, issuer):
    def respond(request):
        if request.url.path == "/.well-known/oauth-protected-resource":
            return httpx.Response(200, json={"resource": advertised, "authorization_servers": [issuer]})
        if request.url.host == "auth.example" and request.url.path == "/.well-known/oauth-authorization-server":
            return httpx.Response(200, json={"issuer": issuer.rstrip("/") if issuer.endswith("/") else issuer + "/",
                                             "authorization_endpoint": "https://auth.example/authorize",
                                             "token_endpoint": "https://auth.example/token"})
        return httpx.Response(404)
    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
    meta = await oauth.discover_metadata("https://mcp.example")
    assert meta["token_endpoint"] == "https://auth.example/token"
    assert meta["resource"] == advertised


async def test_flow_adds_authorization_params_without_overriding_core_ones(monkeypatch):
    meta = {"authorization_endpoint": "https://auth.example/authorize", "token_endpoint": "https://auth.example/token",
            "resource": "https://mcp.example/mcp", "token_endpoint_auth_methods_supported": ["client_secret_post"]}
    monkeypatch.setattr(oauth, "discover_metadata", AsyncMock(return_value=meta))
    monkeypatch.setattr(oauth, "_find_free_port", lambda: 54321)

    gate = asyncio.Event()
    loop = asyncio.get_running_loop()

    async def callback(port, expected_state, ready):
        ready.set()
        await gate.wait()
        return "code"
    monkeypatch.setattr(oauth, "run_callback_server", callback)
    urls = []

    def browser(url):
        urls.append(url)
        loop.call_soon_threadsafe(gate.set)
        return True
    monkeypatch.setattr(oauth.webbrowser, "open", browser)
    monkeypatch.setattr(oauth, "exchange_code", AsyncMock(return_value={"access_token": "t"}))
    monkeypatch.setattr(oauth, "store_token", lambda *a, **k: None)
    token = await oauth.full_oauth_flow("g", "https://mcp.example/mcp", lambda _: None, client_id="cid", client_secret="sec",
                                        authorization_params={"access_type": "offline", "client_id": "evil"})
    assert token == "t"
    query = parse_qs(urlparse(urls[0]).query)
    assert query["access_type"] == ["offline"]
    assert query["client_id"] == ["cid"]


async def test_connect_signs_in_before_saving_to_user_config(tmp_path, home, monkeypatch):
    flow = AsyncMock(return_value="token")
    monkeypatch.setattr(oauth, "full_oauth_flow", flow)
    ok, message = await connectors.connect("gmail", str(tmp_path), lambda _: None, " cid ", "secret")
    assert ok, message
    saved = json.loads((home / ".andromity" / "mcp.json").read_text())["mcpServers"]["gmail"]
    assert saved["serverUrl"] == "https://gmailmcp.googleapis.com/mcp/v1"
    assert saved["oauth"] == {"client_id": "cid", "client_secret": "secret",
                              "authorization_params": {"access_type": "offline", "prompt": "consent"}}
    assert flow.call_args.kwargs["authorization_params"] == {"access_type": "offline", "prompt": "consent"}
    assert not (tmp_path / ".andromity" / "mcp.json").exists()
    assert next(c for c in connectors.list_connectors(str(tmp_path)) if c["id"] == "gmail")["connected"]
    ok, message = await connectors.connect("gmail", str(tmp_path), lambda _: None, "cid", "secret")
    assert not ok and "already connected" in message


async def test_failed_sign_in_writes_nothing(tmp_path, home, monkeypatch):
    async def fail(name, url, on_status, **kwargs):
        on_status("Authentication timed out or was cancelled.")
        return None
    monkeypatch.setattr(oauth, "full_oauth_flow", fail)
    ok, message = await connectors.connect("notion", str(tmp_path), lambda _: None)
    assert not ok and "cancelled" in message
    assert not (home / ".andromity" / "mcp.json").exists()


async def test_google_connector_requires_client_before_browser(tmp_path, home, monkeypatch):
    flow = AsyncMock()
    monkeypatch.setattr(oauth, "full_oauth_flow", flow)
    ok, message = await connectors.connect("google-calendar", str(tmp_path), lambda _: None, "cid", "")
    assert not ok and "client ID and secret" in message
    flow.assert_not_called()
    ok, _ = await connectors.connect("not-real", str(tmp_path), lambda _: None)
    assert not ok


async def test_rpc_connect_requires_trust_and_starts_server(tmp_path, home, monkeypatch):
    handler = JsonRpcHandler()
    result = await handler.rpc_connectors_connect({"project_path": str(tmp_path), "id": "linear"})
    assert not result["success"] and "Trust" in result["error"]
    config.set_trusted(str(tmp_path))
    monkeypatch.setattr(oauth, "full_oauth_flow", AsyncMock(return_value="token"))
    started = []

    async def ensure(project_path):
        async def start_server(name):
            started.append(name)
        return type("M", (), {"start_server": staticmethod(start_server), "server_status": {"linear": {"status": "running"}}})()
    monkeypatch.setattr(handler, "_ensure_mcp_started", ensure)
    result = await handler.rpc_connectors_connect({"project_path": str(tmp_path), "id": "linear"})
    assert result == {"success": True, "name": "linear", "message": "Linear connected.", "status": "running"}
    assert started == ["linear"]
    listed = await handler.rpc_connectors_list({"project_path": str(tmp_path)})
    assert next(c for c in listed if c["id"] == "linear")["connected"]


async def test_token_connector_verifies_then_stores_token_encrypted_not_in_config(tmp_path, home, monkeypatch):
    seen = []

    async def accept(connector, token):
        seen.append((connector.id, token))
        return None
    monkeypatch.setattr(connectors, "verify_token", accept)
    flow = AsyncMock()
    monkeypatch.setattr(oauth, "full_oauth_flow", flow)
    ok, message = await connectors.connect("pagerduty", str(tmp_path), lambda _: None, access_token=" pd-key ")
    assert ok, message
    flow.assert_not_called()
    assert seen == [("pagerduty", "pd-key")]
    raw = (home / ".andromity" / "mcp.json").read_text()
    assert "pd-key" not in raw
    assert json.loads(raw)["mcpServers"]["pagerduty"]["token_prefix"] == "Token token="
    assert oauth.load_token("pagerduty", "https://mcp.pagerduty.com/mcp")["access_token"] == "pd-key"
    assert oauth.load_token("pagerduty", "https://evil.example/mcp") is None


async def test_rejected_or_missing_token_saves_nothing(tmp_path, home, monkeypatch):
    async def reject(connector, token):
        return "GitHub rejected the token."
    monkeypatch.setattr(connectors, "verify_token", reject)
    ok, message = await connectors.connect("github", str(tmp_path), lambda _: None, access_token="bad")
    assert not ok and "rejected" in message
    ok, message = await connectors.connect("github", str(tmp_path), lambda _: None)
    assert not ok and "github.com/settings/personal-access-tokens" in message
    assert not (home / ".andromity" / "mcp.json").exists()
    assert oauth.load_token("github") is None


@pytest.mark.parametrize("status,headers,expect", [
    (200, {}, None),
    (401, {}, "rejected"),
    (400, {"www-authenticate": 'Bearer error="invalid_token"'}, "rejected"),
    (500, {}, "HTTP 500"),
])
async def test_verify_token_reads_status_and_challenge(monkeypatch, status, headers, expect):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(status, headers=headers)
    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
    problem = await connectors.verify_token(connectors.get_connector("pagerduty"), "k")
    assert (problem is None) if expect is None else (expect in problem)
    assert requests[0].headers["Authorization"] == "Token token=k"


async def test_verify_url_checks_token_where_initialize_does_not(monkeypatch):
    urls = []

    def respond(request):
        urls.append(str(request.url))
        return httpx.Response(401)
    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
    assert "rejected" in await connectors.verify_token(connectors.get_connector("render"), "k")
    assert urls == ["https://api.render.com/v1/owners?limit=1"]


async def test_mcp_session_uses_configured_token_prefix(tmp_path, home, monkeypatch):
    from andromity.core import mcp as mcp_mod
    captured = {}

    class FakeSession:
        def __init__(self, name, url, headers=None, transport="sse"):
            captured.update(headers or {})
            self.transport, self.legacy_endpoint, self.tools = transport, False, []

        async def start(self):
            return True
    monkeypatch.setattr(mcp_mod, "MCPSseSession", FakeSession)
    oauth.store_token("pagerduty", {"access_token": "k"}, "", "", "https://mcp.pagerduty.com/mcp")
    config.set_trusted(str(tmp_path))
    mgr = mcp_mod.MCPClientManager(str(tmp_path))
    await mgr.start_server("pagerduty", {"serverUrl": "https://mcp.pagerduty.com/mcp", "token_prefix": "Token token="})
    assert captured["Authorization"] == "Token token=k"
    captured.clear()
    oauth.store_token("github", {"access_token": "g"}, "", "", "https://api.githubcopilot.com/mcp/")
    await mgr.start_server("github", {"serverUrl": "https://api.githubcopilot.com/mcp/"})
    assert captured["Authorization"] == "Bearer g"
