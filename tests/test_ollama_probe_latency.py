"""Regression tests for the fast loopback probe used before contacting Ollama.

Windows retries refused TCP connections for ~2 s per address and resolves
"localhost" to ::1 first, which made model listing (and the VS Code chat's
first paint, which waits for it) stall for ~3 s whether or not Ollama ran.
"""

import socket
import time
import urllib.request

import pytest

from andromity.core import models


@pytest.fixture(autouse=True)
def _clear_probe_cache():
    models._loopback_closed_until.clear()
    yield
    models._loopback_closed_until.clear()


def _closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_closed_loopback_port_fails_fast_and_is_cached():
    url = f"http://localhost:{_closed_port()}"
    started = time.perf_counter()
    assert models.reachable_loopback_url(url) is None
    assert time.perf_counter() - started < 1.0

    started = time.perf_counter()
    assert models.reachable_loopback_url(url) is None
    assert time.perf_counter() - started < 0.05


def test_listening_localhost_is_pinned_to_the_accepting_address():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        port = server.getsockname()[1]
        assert models.reachable_loopback_url(f"http://localhost:{port}/api") == f"http://127.0.0.1:{port}/api"


def test_remote_hosts_are_returned_unchanged_without_probing(monkeypatch):
    monkeypatch.setattr(models, "_first_accepting_address", lambda *args: pytest.fail("remote hosts must not be probed"))
    assert models.reachable_loopback_url("https://ollama.example.com:8443/v1") == "https://ollama.example.com:8443/v1"


def test_ollama_listing_skips_http_when_nothing_listens(monkeypatch):
    monkeypatch.setattr("andromity.config.config.get_provider_config", lambda provider: {})
    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: pytest.fail("closed port must not be requested"))
    assert models.fetch_live_models_sync("ollama", base_url=f"http://localhost:{_closed_port()}") == []


def test_ollama_context_lookup_falls_back_without_waiting_on_closed_port(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: pytest.fail("closed port must not be requested"))
    assert models.get_ollama_num_ctx("qwen", f"http://localhost:{_closed_port()}") == 32768


def test_daemon_defers_litellm_prewarm_until_after_startup():
    from andromity.server import main

    assert main.PREWARM_DELAY_S > 0
    assert not any(
        getattr(thread, "_target", None) is main._prewarm_dependencies
        for thread in __import__("threading").enumerate()
    )


def test_https_loopback_url_keeps_its_hostname_for_tls():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        port = server.getsockname()[1]
        assert models.reachable_loopback_url(f"https://localhost:{port}") == f"https://localhost:{port}"


def test_synchronous_connect_refusal_counts_as_closed(monkeypatch):
    import errno as errno_mod

    class RefusingSocket:
        def __init__(self, *args, **kwargs):
            pass

        def setblocking(self, flag):
            pass

        def connect_ex(self, address):
            return errno_mod.ECONNREFUSED

        def close(self):
            pass

    monkeypatch.setattr(socket, "socket", RefusingSocket)
    assert models._first_accepting_address(["127.0.0.1"], 11434, 0.1) is None
