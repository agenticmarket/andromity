import re

import litellm
import pytest

import andromity.core.provider as provider_mod
from andromity.config import config, get_config_dir
from andromity.core import client_identity
from andromity.core.client_identity import gateway_client_id

ID_PATTERN = re.compile(r"^anon_[0-9a-f]{32}$")


def test_generates_and_persists_a_per_install_id():
    first = gateway_client_id()
    assert ID_PATTERN.match(first)
    assert (get_config_dir() / ".gateway_client_id").read_text(encoding="utf-8") == first
    assert gateway_client_id() == first


def test_separate_installs_get_different_ids(tmp_path, monkeypatch):
    first = gateway_client_id()
    monkeypatch.setenv("ANDROMITY_CONFIG_DIR", str(tmp_path / "other_install"))
    assert gateway_client_id() != first


def test_is_not_the_telemetry_id():
    from andromity.telemetry import _get_or_create_user_id

    assert gateway_client_id().removeprefix("anon_") != _get_or_create_user_id()


@pytest.mark.parametrize("shared", ["local_client", "anonymous", "unknown", "LOCAL_CLIENT", ""])
def test_ignores_shared_fallback_ids_in_config(shared):
    config.set("user", "anonymous_id", shared)
    assert ID_PATTERN.match(gateway_client_id())


def test_keeps_an_explicit_configured_id():
    config.set("user", "anonymous_id", "team-ci-runner")
    assert gateway_client_id() == "team-ci-runner"


def test_replaces_a_corrupt_stored_id():
    path = get_config_dir() / ".gateway_client_id"
    path.write_text("local_client", encoding="utf-8")
    new_id = gateway_client_id()
    assert ID_PATTERN.match(new_id)
    assert path.read_text(encoding="utf-8") == new_id


def test_stays_stable_for_the_process_when_the_id_cannot_be_saved(monkeypatch):
    monkeypatch.setattr(client_identity, "_process_id", "")

    def refuse(*_args, **_kwargs):
        raise PermissionError("read-only config dir")

    monkeypatch.setattr("pathlib.Path.write_text", refuse)
    first = gateway_client_id()
    assert ID_PATTERN.match(first)
    assert gateway_client_id() == first


@pytest.mark.asyncio
async def test_gateway_requests_send_the_install_id_not_the_shared_fallback(monkeypatch):
    captured = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)

        async def _gen():
            chunk = type("C", (), {})()
            delta = type("D", (), {})()
            delta.content = "ok"
            delta.tool_calls = None
            delta.thinking = None
            delta.reasoning_content = None
            delta.reasoning = None
            chunk.choices = [type("Choice", (), {"delta": delta, "finish_reason": "stop"})()]
            chunk.usage = None
            yield chunk
        return _gen()

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    monkeypatch.setattr(provider_mod.config, "get_api_key", lambda name: None)
    monkeypatch.setattr(provider_mod.config, "get_provider_config", lambda name: None)
    async for _ in provider_mod.stream_completion([{"role": "user", "content": "hi"}], provider_name="andromity", model="auto"):
        pass

    sent = captured["extra_headers"]["x-andromity-client-id"]
    assert sent == gateway_client_id()
    assert sent != "local_client"


@pytest.mark.asyncio
async def test_rpc_exposes_the_same_id_the_agent_sends():
    from andromity.server.rpc_handler import JsonRpcHandler

    handler = JsonRpcHandler(send_notification=lambda n: None)
    assert await handler.rpc_gateway_clientId({}) == {"client_id": gateway_client_id()}
