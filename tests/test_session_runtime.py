from types import SimpleNamespace
import pytest

from andromity.server.runtime import SessionRuntime


def test_attach_snapshot_restores_interactions_tools_and_partial_output():
    runtime = SessionRuntime()
    runtime.observe("agent/started", {"session_id": "a"})
    runtime.observe("agent/toolStart", {"session_id": "a", "tool_id": "t", "tool_name": "shell_exec"})
    runtime.observe("agent/toolDelta", {"session_id": "a", "tool_id": "t", "chunk": '{"command":"python --version"}'})
    runtime.observe("agent/toolApprovalRequired", {"session_id": "a", "approval_id": "approval", "tool_name": "shell_exec", "args": {"command": "python --version"}})
    runtime.observe("agent/askQuestions", {"session_id": "a", "question_id": "question", "questions": [{"question": "Which file?"}]})
    runtime.observe("agent/textDelta", {"session_id": "b", "text": "other session"})
    snapshot = runtime.snapshot("a")
    assert snapshot["tools"][0]["args_json"].startswith('{"command":')
    assert [p["type"] for p in snapshot["interactions"]] == ["tool_approval_required", "ask_questions"]
    assert runtime.snapshot("b")["interactions"] == []
    assert snapshot["text"] == ""
    snapshot["interactions"][0]["args"]["command"] = "changed"
    assert runtime.snapshot("a")["interactions"][0]["args"]["command"] == "python --version"


def test_resolution_revisions_prevent_replaying_stale_requests():
    runtime = SessionRuntime()
    first = runtime.observe("agent/askQuestions", {"session_id": "a", "question_id": "q", "questions": []})
    snapshot = runtime.snapshot("a")
    resolution = runtime.observe("agent/interactionResolved", {"session_id": "a", "interaction_id": "q"})
    assert resolution["event_seq"] > snapshot["event_seq"] == first["event_seq"]
    assert runtime.snapshot("a")["interactions"] == []


def test_completed_turn_retains_pending_plan_only():
    runtime = SessionRuntime()
    runtime.observe("agent/planApproval", {"session_id": "a", "plan": {"status": "pending"}})
    runtime.observe("agent/toolApprovalRequired", {"session_id": "a", "approval_id": "p"})
    runtime.observe("agent/thinkingDelta", {"session_id": "a", "text": "thinking"})
    runtime.observe("agent/done", {"session_id": "a"})
    assert [p["type"] for p in runtime.snapshot("a")["interactions"]] == ["plan_approval"]
    assert runtime.snapshot("a")["thinking"] == ""
    runtime.observe("agent/planUpdated", {"session_id": "a", "plan": {"status": "approved"}})
    assert runtime.snapshot("a")["interactions"] == []


def immediate(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    finally:
        coroutine.close()
    raise AssertionError("RPC unexpectedly suspended")


class PendingFuture:
    def __init__(self):
        self.result = None

    def done(self):
        return self.result is not None

    def set_result(self, value):
        self.result = value


def test_rpc_session_snapshot_isolates_processes_and_reports_running(monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler
    from andromity.core import tools
    handler = JsonRpcHandler()
    session = SimpleNamespace(id="a", name="chat", status="running", project_path="workspace",
                              permission_mode="safe", profile="builder", messages=[], plan=None)
    monkeypatch.setattr(handler, "_get_or_load_session", lambda *args: session)
    handler._running_tasks["a"] = SimpleNamespace(done=lambda: False)
    proc = SimpleNamespace(poll=lambda: None, pid=123)
    monkeypatch.setattr(tools, "_bg_processes", {
        ("workspace", "one"): {"proc": proc, "session_id": "a"},
        ("workspace", "two"): {"proc": proc, "session_id": "b"},
    })
    handler.notify("agent/askQuestions", {"session_id": "a", "question_id": "q", "questions": ["Why?"]})
    data = immediate(handler.rpc_session_get({"session_id": "a"}))
    assert data["runtime"]["is_running"] is True
    assert [p["process_id"] for p in data["runtime"]["processes"]] == ["one"]
    assert data["runtime"]["interactions"][0]["questions"] == ["Why?"]


def test_rpc_rejects_cross_session_responses_and_resolves_shared_card(monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler
    handler = JsonRpcHandler()
    future = PendingFuture()
    handler._pending_questions["q"] = ("a", future)
    handler.notify("agent/askQuestions", {"session_id": "a", "question_id": "q", "questions": []})
    assert not immediate(handler.rpc_agent_answer_question({"session_id": "b", "question_id": "q", "answers": "bad"}))["success"]
    assert not future.done()
    assert immediate(handler.rpc_agent_answer_question({"session_id": "a", "question_id": "q", "answers": "good"}))["success"]
    assert future.result == "good"
    assert handler._runtime.snapshot("a")["interactions"] == []
    approval = PendingFuture()
    handler._pending_approvals["p"] = ("a", approval, "shell_exec", {})
    assert not immediate(handler.rpc_agent_approve_tool({"session_id": "b", "approval_id": "p"}))["success"]
    assert not approval.done()


def test_config_mode_change_handles_approval_tuples_without_bypassing_trust(monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler, config
    handler = JsonRpcHandler()
    monkeypatch.setattr(config, "set", lambda *args: None)
    monkeypatch.setattr(config, "save", lambda: None)
    monkeypatch.setattr(config, "is_trusted", lambda path: path == "trusted")
    trusted, untrusted = PendingFuture(), PendingFuture()
    handler._active_sessions = {"a": SimpleNamespace(project_path="trusted"), "b": SimpleNamespace(project_path="untrusted")}
    handler._pending_approvals = {"p": ("a", trusted, "shell_exec", {}), "q": ("b", untrusted, "shell_exec", {})}
    immediate(handler.rpc_config_set({"key": "permission_mode", "value": "full"}))
    assert trusted.result is True
    assert not untrusted.done()


@pytest.mark.parametrize("tool,args,approved", [
    ("edit_file", {"path": "src/app.py"}, True),
    ("edit_file", {"path": "package.json"}, False),
    ("read_file", {"path": ".env"}, False),
    ("shell_exec", {"command": "python --version"}, True),
    ("shell_exec", {"command": "curl example.com"}, False),
    ("fetch_url", {"url": "https://example.com"}, False),
    ("mcp__db__delete", {}, False),
])
def test_switch_to_trust_rechecks_pending_action(monkeypatch, tool, args, approved):
    from andromity.server.rpc_handler import JsonRpcHandler, config
    handler = JsonRpcHandler()
    monkeypatch.setattr(config, "set", lambda *args: None)
    monkeypatch.setattr(config, "save", lambda: None)
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    monkeypatch.setattr(config, "get", lambda section, key, default=None: ["python --version"] if key == "allowed_commands" else [])
    future = PendingFuture()
    handler._active_sessions = {"a": SimpleNamespace(project_path="trusted", profile="builder")}
    handler._pending_approvals = {"p": ("a", future, tool, args)}
    immediate(handler.rpc_config_set({"key": "permission_mode", "value": "trust"}))
    assert future.done() is approved


@pytest.mark.parametrize("mode", ["trust", "full", "yolo"])
def test_mode_switch_preserves_read_only_profile_gate(monkeypatch, mode):
    from andromity.server.rpc_handler import JsonRpcHandler, config
    handler = JsonRpcHandler()
    monkeypatch.setattr(config, "set", lambda *args: None)
    monkeypatch.setattr(config, "save", lambda: None)
    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    future = PendingFuture()
    handler._active_sessions = {"a": SimpleNamespace(project_path="trusted", profile="planner")}
    handler._pending_approvals = {"p": ("a", future, "shell_exec", {"command": "python --version"})}
    immediate(handler.rpc_config_set({"key": "permission_mode", "value": mode}))
    assert not future.done()


def test_process_actions_require_the_owning_session_and_restore_context(tmp_path, monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler, config
    from andromity.core import tools
    handler = JsonRpcHandler()
    session = SimpleNamespace(project_path=str(tmp_path), id="a")
    monkeypatch.setattr(handler, "_get_or_load_session", lambda *args: session)
    monkeypatch.setattr(config, "is_trusted", lambda *args: True)
    monkeypatch.setattr(tools, "_bg_processes", {(str(tmp_path.resolve()), "timer"): {"session_id": "a"}})
    previous = tools.get_current_session()
    with handler._process_session({"session_id": "a", "process_id": "timer"}):
        assert tools.get_current_session() is session
    assert tools.get_current_session() is previous
    with pytest.raises(ValueError, match="this session"):
        with handler._process_session({"session_id": "b", "process_id": "timer"}):
            pytest.fail("Must not execute a different session's process action")
    monkeypatch.setattr(config, "is_trusted", lambda *args: False)
    with pytest.raises(PermissionError, match="untrusted"):
        with handler._process_session({"session_id": "a", "process_id": "timer"}):
            pytest.fail("Must respect workspace trust")


def test_session_command_approval_does_not_allow_every_command_of_that_program(monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler, config
    handler = JsonRpcHandler()
    allowed = []
    future = PendingFuture()
    handler._pending_approvals["p"] = ("a", future, "shell_exec", {"command": "python --version"})
    handler._active_sessions["a"] = SimpleNamespace(project_path="trusted", allow_command=allowed.append)
    monkeypatch.setattr(config, "is_trusted", lambda *args: True)
    result = immediate(handler.rpc_agent_approve_tool({"session_id": "a", "approval_id": "p", "scope": "session"}))
    assert result["success"]
    assert allowed == ["python --version"]
    from andromity.core.security import is_command_allowlisted
    assert not is_command_allowlisted('python -c "print(123)"', allowed)
