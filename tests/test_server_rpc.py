import asyncio
import pytest
from andromity.server.protocol import (
    JsonRpcRequest,
    JsonRpcResponse,
    JsonRpcNotification,
    METHOD_NOT_FOUND,
)
from andromity.server.rpc_handler import JsonRpcHandler


@pytest.mark.asyncio
async def test_protocol_serialization():
    req = JsonRpcRequest.from_dict({
        "jsonrpc": "2.0",
        "id": "123",
        "method": "session.create",
        "params": {"name": "test-session"}
    })
    assert req.id == "123"
    assert req.method == "session.create"
    assert req.params == {"name": "test-session"}
    assert not req.is_notification()

    resp = JsonRpcResponse.ok("123", {"status": "ok"})
    d = resp.to_dict()
    assert d["id"] == "123"
    assert d["result"] == {"status": "ok"}
    assert "error" not in d


@pytest.mark.asyncio
async def test_rpc_handler_session_lifecycle(tmp_path):
    notifications = []

    def on_notify(n):
        notifications.append(n)

    handler = JsonRpcHandler(send_notification=on_notify)

    # 1. Create Session
    create_req = JsonRpcRequest(
        id=1,
        method="session.create",
        params={"name": "unit-test-session", "project_path": str(tmp_path)},
    )
    resp = await handler.handle_request(create_req)
    assert resp is not None
    assert resp.error is None
    session_id = resp.result["id"]
    assert resp.result["name"] == "unit-test-session"

    # 2. Get Session
    get_req = JsonRpcRequest(
        id=2,
        method="session.get",
        params={"session_id": session_id, "project_path": str(tmp_path)},
    )
    resp = await handler.handle_request(get_req)
    assert resp.error is None
    assert resp.result["id"] == session_id

    # 3. List Sessions
    list_req = JsonRpcRequest(
        id=3,
        method="session.list",
        params={"project_path": str(tmp_path)},
    )
    resp = await handler.handle_request(list_req)
    assert resp.error is None
    assert isinstance(resp.result, list)


@pytest.mark.asyncio
async def test_rpc_config_methods():
    handler = JsonRpcHandler()

    req = JsonRpcRequest(id=10, method="config.get", params={})
    resp = await handler.handle_request(req)
    assert resp.error is None
    assert "default_provider" in resp.result
    assert "default_model" in resp.result

    req_models = JsonRpcRequest(id=11, method="config.list_models", params={})
    resp_models = await handler.handle_request(req_models)
    assert resp_models.error is None
    assert isinstance(resp_models.result, list)


@pytest.mark.asyncio
async def test_rpc_method_not_found():
    handler = JsonRpcHandler()
    req = JsonRpcRequest(id=99, method="non_existent.method", params={})
    resp = await handler.handle_request(req)
    assert resp.error is not None
    assert resp.error["code"] == METHOD_NOT_FOUND


@pytest.mark.asyncio
async def test_rpc_agent_prompt_streaming(tmp_path):
    notifications = []

    async def on_notify(n):
        notifications.append((n.method, n.params))

    handler = JsonRpcHandler(send_notification=on_notify)

    from unittest.mock import patch
    from andromity.core.events import TextDelta, ThinkingDelta, ToolCallStart, ToolCallEnd, Done

    call_count = 0
    async def mock_stream(messages, tools=None, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ThinkingDelta(text="Thinking...")
            yield ToolCallStart(tool_name="list_dir", tool_id="call_1")
            yield ToolCallEnd(tool_id="call_1")
            yield Done()
        else:
            yield TextDelta(text="Here is the response")
            yield Done(usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        req = JsonRpcRequest(
            id=101,
            method="agent.prompt",
            params={
                "prompt": "Hello test",
                "session_id": "test-stream-sess",
                "project_path": str(tmp_path),
                "mode": "safe",
            },
        )
        resp = await handler.handle_request(req)
        assert resp.error is None
        assert resp.result["status"] == "started"

        # Wait for _run_stream task
        for _ in range(20):
            await asyncio.sleep(0.05)
            if any(m == "agent/done" for m, _ in notifications):
                break

    method_names = [m for m, _ in notifications]
    assert "agent/started" in method_names
    assert "agent/thinkingDelta" in method_names
    assert "agent/toolStart" in method_names
    assert "agent/textDelta" in method_names
    assert "agent/done" in method_names


@pytest.mark.asyncio
async def test_rpc_trust_endpoints(tmp_path):
    handler = JsonRpcHandler()
    req = JsonRpcRequest(id=201, method="trust.status", params={"project_path": str(tmp_path)})
    resp = await handler.handle_request(req)
    assert resp.error is None
    assert "is_trusted" in resp.result

    req_set = JsonRpcRequest(id=202, method="trust.set", params={"project_path": str(tmp_path)})
    resp_set = await handler.handle_request(req_set)
    assert resp_set.error is None
    assert resp_set.result["is_trusted"] is True


@pytest.mark.asyncio
async def test_rpc_cron_lifecycle(tmp_path):
    notifications = []

    def on_notify(n):
        notifications.append((n.method, n.params))

    handler = JsonRpcHandler(send_notification=on_notify)

    # 1. List crons on fresh project (auto-seeds default presets)
    list_req = JsonRpcRequest(id=301, method="cron.list", params={"project_path": str(tmp_path)})
    list_resp = await handler.handle_request(list_req)
    assert list_resp.error is None
    assert isinstance(list_resp.result, list)
    assert len(list_resp.result) >= 2
    assert any("Run Tests" in j["name"] for j in list_resp.result)

    # 2. Create a new custom cron job
    create_req = JsonRpcRequest(
        id=302,
        method="cron.create",
        params={
            "project_path": str(tmp_path),
            "name": "E2E Nightly Sweep",
            "prompt": "Run full test suite and verify build",
            "schedule": "every 6h",
            "mode": "trust",
            "allowed_commands": ["pytest", "git status"],
        },
    )
    create_resp = await handler.handle_request(create_req)
    assert create_resp.error is None
    job_id = create_resp.result["id"]
    assert create_resp.result["name"] == "E2E Nightly Sweep"
    assert create_resp.result["enabled"] is True

    # 3. Toggle the cron job (pause)
    toggle_req = JsonRpcRequest(
        id=303,
        method="cron.toggle",
        params={"project_path": str(tmp_path), "id": job_id},
    )
    toggle_resp = await handler.handle_request(toggle_req)
    assert toggle_resp.error is None
    assert toggle_resp.result["enabled"] is False

    # 4. List runs for the job
    runs_req = JsonRpcRequest(
        id=304,
        method="cron.runs",
        params={"project_path": str(tmp_path), "id": job_id},
    )
    runs_resp = await handler.handle_request(runs_req)
    assert runs_resp.error is None
    assert isinstance(runs_resp.result, list)

    # 5. Delete the cron job
    del_req = JsonRpcRequest(
        id=305,
        method="cron.delete",
        params={"project_path": str(tmp_path), "id": job_id},
    )
    del_resp = await handler.handle_request(del_req)
    assert del_resp.error is None
    assert del_resp.result["deleted"] is True

