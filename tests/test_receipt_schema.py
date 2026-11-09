"""Every receipt Andromity builds matches the published schema, and the schema rejects undocumented fields."""
import json
import subprocess
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from andromity.config import config
from andromity.core.git_ops import create_pre_edit_snapshot
from andromity.core.identity import approver_record
from andromity.core.receipt import build_receipt, close_turn_record, open_turn_record, seal_receipt
from andromity.core.session import Session

SCHEMA = json.loads((Path(__file__).resolve().parents[1] / "docs" / "receipt-v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA)


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "app.py").write_text("print('a')\n")
    (root / "old.py").write_text("x = 1\n")
    (root / ".gitignore").write_text(".env*\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    config.set_trusted(str(root))
    return root


def _turn(session: Session, root: Path, calls, before=None):
    record = {"snapshot_hash": create_pre_edit_snapshot(root), "msg_count": len(session.messages),
              "turn_index": len(session.get_user_turn_indices()), **open_turn_record(session)}
    session.add_message("user", content="do the task")
    if before:
        before()
    for call_id, name, result, args in calls:
        session.add_message("assistant", tool_calls=[{"id": call_id, "type": "function",
                                                      "function": {"name": name, "arguments": json.dumps(args)}}],
                            model="provider/model-a")
        session.add_message("tool", content=result, tool_call_id=call_id, name=name)
    record.update(close_turn_record(session))
    record["after_hash"] = create_pre_edit_snapshot(root)
    session.undo_stack.append(record)
    return record


def _errors(receipt):
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.message}" for e in VALIDATOR.iter_errors(receipt)]


def test_a_busy_turn_matches_the_schema(project):
    s = Session(session_id="schema-busy", project_path=str(project))
    s.record_tool_decision("c5", True, approver_record({"name": "Shubham", "email": "s@example.com"}))
    s.record_tool_decision("c6", False, approver_record({"name": "Alex", "email": "a@example.com"}))
    s.record_tool_gate("c6", "declined")

    def change_files():
        (project / "app.py").write_text("print('b')\n")
        (project / "old.py").unlink()
        (project / ".github" / "workflows").mkdir(parents=True)
        (project / ".github" / "workflows" / "ci.yml").write_text("on: push\n")
        (project / ".env.local").write_text("TOKEN=abc\n")

    record = _turn(s, project, [
        ("c1", "read_file", "API_KEY=x", {"path": ".env"}),
        ("c2", "edit_file", "Successfully edited app.py", {"path": "app.py", "old_str": "a", "new_str": "b"}),
        ("c3", "shell_exec", "1 failed\n[exit code 1]", {"command": "pytest -q"}),
        ("c4", "shell_exec", "1 passed", {"command": "pytest -q"}),
        ("c5", "shell_exec", "removed", {"command": "rm -rf old.py"}),
        ("c6", "shell_exec", "TOOL REJECTED BY USER: declined", {"command": "git push --force"}),
        ("c7", "shell_bg", "started", {"command": "npm run dev"}),
        ("c8", "fetch_url", "<html>", {"url": "https://docs.python.org/3/"}),
        ("c9", "mcp__github__create_issue", "ok", {"title": "x"}),
        ("c10", "grep_search", "3 matches", {"query": "x"}),
        ("c11", "spawn_subagent", "done", {"role": "coder", "task": "x"}),
        ("c12", "todo_write", "ok", {"items": []}),
    ], before=change_files)
    seal_receipt(s, record)
    receipt = build_receipt(s)
    assert _errors(receipt) == []
    kinds = {finding["kind"] for finding in receipt["needs_attention"]}
    assert {"sensitive", "destructive", "runs_code", "hidden_change", "background", "changed_outside_edits"} <= kinds
    assert receipt["approvers"] and receipt["sealed"]["matches"] is True


def test_an_empty_turn_matches_the_schema(project):
    s = Session(session_id="schema-empty", project_path=str(project))
    _turn(s, project, [])
    assert _errors(build_receipt(s)) == []


def test_a_turn_whose_snapshots_are_gone_still_matches_the_schema(project):
    s = Session(session_id="schema-gone", project_path=str(project))
    record = _turn(s, project, [("c1", "edit_file", "Successfully edited app.py",
                                 {"path": "app.py", "old_str": "a", "new_str": "b"})])
    record["after_hash"] = "f" * 40
    receipt = build_receipt(s)
    assert receipt["files_changed"][0]["status"] == "?"
    assert _errors(receipt) == []


def test_the_schema_rejects_fields_it_does_not_document(project):
    s = Session(session_id="schema-strict", project_path=str(project))
    _turn(s, project, [("c1", "shell_exec", "removed", {"command": "rm -rf build"})])
    receipt = build_receipt(s)
    for mutate in (
        lambda r: r.__setitem__("prompt", "secret"),
        lambda r: r["commands"][0].__setitem__("output", "secret"),
        lambda r: r["needs_attention"][0].__setitem__("content", "secret"),
        lambda r: r["summary"].__setitem__("files_changed", -1),
        lambda r: r["commands"][0].__setitem__("outcome", "fine"),
    ):
        broken = json.loads(json.dumps(receipt))
        mutate(broken)
        assert _errors(broken), "the schema must reject this"
