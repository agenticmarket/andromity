"""Air-gap mode: the process guard, the per-feature gates and the commands the agent runs.

Network probes target public addresses but must be refused before any packet is
sent; a test that reaches the network has found a hole in the guard.
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from andromity.core import airgap_guard, network_policy
from andromity.core.airgap_guard import AirgapBlockedError

REPO = Path(__file__).resolve().parent.parent


@pytest.fixture
def airgap(monkeypatch):
    """Air-gap mode on for this test only; the guard is turned back off afterwards."""
    def enable(allow: str = ""):
        monkeypatch.setenv("ANDROMITY_AIRGAP", "1")
        monkeypatch.setenv("ANDROMITY_AIRGAP_ALLOW", allow)
        airgap_guard._reset_for_tests()
        assert network_policy.activate() is True
    try:
        yield enable
    finally:
        airgap_guard._reset_for_tests()


def _blocked(fn):
    with pytest.raises(AirgapBlockedError):
        fn()


# ── Process guard ─────────────────────────────────────────────────────────

def test_guard_refuses_tcp_dns_udp_and_https(airgap):
    airgap()
    _blocked(lambda: socket.create_connection(("1.1.1.1", 443), timeout=2))
    _blocked(lambda: socket.getaddrinfo("example.com", 443))
    _blocked(lambda: socket.gethostbyname("example.com"))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        _blocked(lambda: udp.sendto(b"x", ("8.8.8.8", 53)))
    with pytest.raises(OSError, match="Air-gap mode blocked"):
        urllib.request.urlopen("https://example.com", timeout=2)
    kinds = {entry["kind"] for entry in airgap_guard.blocked_attempts()}
    assert {"connection", "DNS lookup", "network send"} <= kinds


def test_guard_refuses_raw_socket_connect_and_ipv6(airgap):
    airgap()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as raw:
        _blocked(lambda: raw.connect(("93.184.216.34", 80)))
        assert raw.connect_ex  # the socket object itself is untouched
    if socket.has_ipv6:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as raw6:
            _blocked(lambda: raw6.connect(("2606:4700:4700::1111", 443, 0, 0)))


def test_guard_refuses_asyncio_connections_on_every_event_loop(airgap):
    airgap()

    async def connect():
        _, writer = await asyncio.wait_for(asyncio.open_connection("1.1.1.1", 443), 3)
        writer.close()

    _blocked(lambda: asyncio.run(connect()))
    if sys.platform == "win32":
        # The default Windows proactor connects through ConnectEx, which raises no audit event.
        _blocked(lambda: asyncio.run(connect(), loop_factory=asyncio.SelectorEventLoop))
        _blocked(lambda: asyncio.run(connect(), loop_factory=asyncio.ProactorEventLoop))


def test_this_machine_stays_reachable(airgap):
    airgap()
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(8)
    port = server.getsockname()[1]
    try:
        for host in ("127.0.0.1", "localhost"):
            client = socket.create_connection((host, port), timeout=5)
            conn, _ = server.accept()
            conn.close()
            client.close()
    finally:
        server.close()


def test_allowlist_takes_private_hosts_only(airgap):
    airgap("10.20.0.0/16, buildbox.lan, 192.168.1.50:11434, 8.8.8.8, example.com")
    assert airgap_guard.host_allowed("10.20.3.4")
    assert airgap_guard.host_allowed("192.168.1.50")
    assert airgap_guard.host_allowed("buildbox.lan")
    assert not airgap_guard.host_allowed("10.21.0.1")
    assert not airgap_guard.host_allowed("8.8.8.8"), "public addresses are refused even when listed"
    status = network_policy.status()
    assert "8.8.8.8" in status["ignored_hosts"]
    # A listed name may be resolved, but only private answers become reachable.
    assert airgap_guard.host_allowed("example.com"), "listed names may be looked up"
    airgap_guard._remember_resolution("example.com", [(None, None, None, "", ("93.184.216.34", 443))])
    assert not airgap_guard.host_allowed("93.184.216.34")


def test_guard_is_inactive_when_air_gap_mode_is_off(monkeypatch):
    monkeypatch.delenv("ANDROMITY_AIRGAP", raising=False)
    airgap_guard._reset_for_tests()
    assert network_policy.activate() is False
    assert airgap_guard.host_allowed("8.8.8.8")
    assert network_policy.url_allowed("https://api.anthropic.com")


def test_config_file_turns_air_gap_mode_on(monkeypatch):
    from andromity.config import config
    monkeypatch.delenv("ANDROMITY_AIRGAP", raising=False)
    monkeypatch.delenv("ANDROMITY_AIRGAP_ALLOW", raising=False)
    config.set("default", "airgap", True)
    config.set("default", "airgap_allowed_hosts", ["10.1.2.3"])
    try:
        airgap_guard._reset_for_tests()
        assert network_policy.activate() is True
        assert os.environ["ANDROMITY_AIRGAP"] == "1"
        assert os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] == "True"
        assert network_policy.status()["sources"] == ["config"]
        assert airgap_guard.host_allowed("10.1.2.3")
    finally:
        airgap_guard._reset_for_tests()
        os.environ.pop("ANDROMITY_AIRGAP", None)
        os.environ.pop("ANDROMITY_AIRGAP_ALLOW", None)


# ── Commands the agent runs ───────────────────────────────────────────────

def test_child_python_processes_load_the_guard(airgap):
    airgap()
    from andromity.core.tools import get_clean_subprocess_env
    code = (
        "import socket\n"
        "try:\n"
        "    socket.create_connection(('1.1.1.1', 443), timeout=2); print('ALLOWED')\n"
        "except PermissionError as e:\n"
        "    print('BLOCKED' if 'Air-gap' in str(e) else 'OTHER')\n"
    )
    out = subprocess.run([sys.executable, "-c", code], env=get_clean_subprocess_env(),
                         capture_output=True, text=True, timeout=60).stdout.strip()
    assert out.endswith("BLOCKED"), out


def test_command_env_blocks_proxies_and_cannot_be_loosened(airgap):
    airgap("10.0.0.5")
    from andromity.core.tools import get_clean_subprocess_env
    env = get_clean_subprocess_env({"HTTPS_PROXY": "http://evil:3128", "ANDROMITY_AIRGAP": "0", "NO_PROXY": "*"})
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        assert env[name] == "http://127.0.0.1:9", name
    assert env["ANDROMITY_AIRGAP"] == "1"
    assert env["NO_PROXY"].split(",")[:3] == ["localhost", "127.0.0.1", "::1"]
    assert "10.0.0.5" in env["NO_PROXY"] and "*" not in env["NO_PROXY"]
    assert env["NODE_USE_ENV_PROXY"] == "1"
    assert env["GIT_SSH_COMMAND"] == "false"
    assert "airgap_sitecustomize" in env["PYTHONPATH"]


# ── Feature gates ─────────────────────────────────────────────────────────

def test_cloud_providers_are_refused_with_a_clear_message(airgap):
    airgap()
    from andromity.core.connections import provider_info, provider_request
    from andromity.core.provider import classify_error_info
    with pytest.raises(network_policy.AirgapFeatureOff) as caught:
        provider_request("anthropic", "claude-sonnet-4-6")
    info = classify_error_info(caught.value, "anthropic", "claude-sonnet-4-6")
    assert info["type"] == "airgap"
    assert "local model" in info["desc_text"]
    assert provider_request("ollama", "llama3")["api_base"] == "http://localhost:11434"
    blocked = {p["id"]: p["airgap_blocked"] for p in provider_info()}
    assert blocked["ollama"] is False
    assert blocked["andromity"] is True and blocked["openai"] is True


def test_private_model_server_on_the_allowlist_is_usable(airgap):
    airgap("10.0.0.0/8")
    from andromity.config import config
    from andromity.core.connections import provider_request
    config.save_provider({"id": "labvllm", "type": "openai", "base_url": "http://10.0.0.7:8000/v1", "model": "qwen"})
    assert provider_request("labvllm", "qwen")["api_base"] == "http://10.0.0.7:8000/v1"
    config.save_provider({"id": "cloudy", "type": "openai", "base_url": "https://api.example.com/v1", "model": "m"})
    with pytest.raises(network_policy.AirgapFeatureOff):
        provider_request("cloudy", "m")


def test_web_tools_are_not_offered(airgap):
    from andromity.core.profiles import filter_tools_for_profile
    from andromity.core.tools import CORE_TOOLS
    names = lambda: {t["function"]["name"] for t in filter_tools_for_profile(CORE_TOOLS, "builder")}
    assert {"web_search", "fetch_url"} <= names()
    airgap()
    assert not ({"web_search", "fetch_url"} & names())


def test_background_fetches_and_telemetry_stay_off(airgap, monkeypatch):
    airgap()
    calls = []
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: calls.append(a) or (_ for _ in ()).throw(AssertionError("network")))
    from andromity import telemetry
    from andromity.core.models import fetch_live_models_sync
    from andromity.core.effort import discover_model_reasoning_capability
    assert telemetry._should_send_telemetry() is False
    assert fetch_live_models_sync("openrouter", api_key="k") == []
    assert fetch_live_models_sync("anthropic", api_key="k") == []
    discover_model_reasoning_capability("openai", "gpt-5")
    assert calls == []


def test_skills_catalog_is_refused(airgap):
    airgap()
    from andromity.core.skills import _default_fetch
    with pytest.raises(network_policy.AirgapFeatureOff, match="skills catalog"):
        _default_fetch("https://api.github.com/repos/x/y")


def test_remote_and_unapproved_local_mcp_servers_are_paused(airgap, tmp_path, monkeypatch):
    airgap()
    from andromity.core import mcp
    manager = mcp.MCPClientManager(str(tmp_path))
    asyncio.run(manager.start_server("remote", {"serverUrl": "https://mcp.example.com/sse"}, trusted=True))
    assert manager.server_status["remote"]["status"] == "error"
    assert "air-gap" in manager.server_status["remote"]["error"]

    asyncio.run(manager.start_server("local", {"command": "npx", "args": ["-y", "some-server"]}, trusted=True))
    assert "allowInAirgap" in manager.server_status["local"]["error_detail"]

    started = []

    async def fake_start(self):
        started.append(self.name)
        self.tools = []
        return True

    monkeypatch.setattr(mcp.MCPStdioSession, "start", fake_start)
    asyncio.run(manager.start_server("approved", {"command": "my-local-server", "allowInAirgap": True}, trusted=True))
    assert started == ["approved"]
    assert manager.server_status["approved"]["status"] == "running"


def test_mcp_sign_in_and_connectors_are_refused(airgap):
    airgap()
    from andromity.core import connectors, oauth
    seen = []
    assert asyncio.run(oauth.full_oauth_flow("srv", "https://mcp.example.com", seen.append)) is None
    assert "Air-gap mode is on" in seen[0]
    connector = connectors.get_connector(connectors.list_connectors("")[0]["id"])
    ok, message = asyncio.run(connectors.connect(connector.id, "", lambda _m: None))
    assert ok is False and "Air-gap mode is on" in message
    assert "Air-gap mode is on" in asyncio.run(connectors.verify_token(connector, "t"))


# ── Self-test and the real engine ─────────────────────────────────────────

def test_self_test_passes_and_never_runs_while_off(airgap, monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler
    handler = JsonRpcHandler()
    monkeypatch.delenv("ANDROMITY_AIRGAP", raising=False)
    airgap_guard._reset_for_tests()
    assert asyncio.run(handler.rpc_airgap_self_test({})) == {"enabled": False, "checks": []}
    airgap()
    result = asyncio.run(handler.rpc_airgap_self_test({}))
    assert result["passed"], [c for c in result["checks"] if not c["ok"]]
    assert len(result["checks"]) == 8


def test_blocked_attempts_are_reported_to_the_client_once_per_target(airgap):
    from andromity.server.rpc_handler import JsonRpcHandler
    airgap()
    sent = []
    handler = JsonRpcHandler()
    handler.notify = lambda method, params: sent.append((method, params))
    airgap_guard._listeners.clear()
    handler._watch_airgap_blocks()
    for _ in range(3):
        with pytest.raises(AirgapBlockedError):
            socket.create_connection(("1.1.1.1", 443), timeout=2)
    assert [m for m, _ in sent] == ["airgap/blocked"]
    assert sent[0][1]["target"].startswith("1.1.1.1")


def test_real_engine_starts_air_gapped_without_reaching_the_network(tmp_path):
    env = dict(os.environ, ANDROMITY_AIRGAP="1", ANDROMITY_CLIENT="vscode",
               ANDROMITY_CONFIG_DIR=str(tmp_path / "conf"), PYTHONPATH=str(REPO / "src"))
    proc = subprocess.Popen([sys.executable, "-P", "-m", "andromity.server", "--stdio"], cwd=str(REPO), env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    try:
        def call(i, method, params=None):
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
            proc.stdin.flush()
            while True:
                line = proc.stdout.readline()
                assert line, "engine exited"
                msg = json.loads(line)
                if msg.get("id") == i:
                    return msg["result"]

        assert call(1, "config.get", {"project_path": str(REPO)})["airgap"]["enabled"] is True
        call(2, "config.list_models")
        providers = call(3, "config.list_providers")
        assert [p["id"] for p in providers if not p["airgap_blocked"]] == ["ollama"]
        time.sleep(3)
        assert call(4, "airgap.status")["blocked"] == [], "startup work should be stopped at its source"
    finally:
        proc.kill()
        proc.wait(timeout=10)
