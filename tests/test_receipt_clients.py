"""Receipts from the terminal app and the headless CLI: the same turn records and named decisions as the server."""
import asyncio
import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from andromity.config import config
from andromity.core.events import Done, TextDelta, ToolCallDelta, ToolCallEnd, ToolCallStart
from andromity.core.receipt import build_receipt, render_text
from andromity.core.session import Session

PERSON = {"name": "Test Person", "email": "test.person@example.com", "os_user": "tperson"}


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def project(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "app.py").write_text("print('a')\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    config.set_trusted(str(root))
    monkeypatch.chdir(root)
    monkeypatch.setattr("andromity.core.agent.local_identity", lambda project_path=None: dict(PERSON))
    monkeypatch.setattr("andromity.core.identity.local_identity", lambda project_path=None: dict(PERSON))
    return root


def _scripted(calls):
    state = {"n": 0}

    async def stream(messages, tools=None, **kwargs):
        state["n"] += 1
        if state["n"] == 1 and calls:
            for call_id, name, args in calls:
                yield ToolCallStart(tool_name=name, tool_id=call_id)
                yield ToolCallDelta(tool_id=call_id, args_json_chunk=json.dumps(args))
                yield ToolCallEnd(tool_id=call_id)
            yield Done()
        else:
            yield TextDelta(text="done")
            yield Done(usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
    return stream


def _lines(receipt):
    return [f"{f['detail']}: {f['subject']}" if f.get("subject") else f["detail"] for f in receipt["needs_attention"]]


async def _until(pilot, condition, steps=600):
    for _ in range(steps):
        if condition():
            return True
        await pilot.pause(0.01)
    return condition()


def test_the_terminal_app_records_a_receipt_naming_the_person_who_decided(project):
    async def run():
        from andromity.tui.app import AndromityApp
        from andromity.tui.panels.chat import ChatMessage

        app = AndromityApp()
        async with app.run_test(size=(120, 35)) as pilot:
            await _until(pilot, lambda: False, steps=10)
            while len(app.screen_stack) > 1:
                await pilot.press("escape")
                await pilot.pause()
            app.session.permission_mode = "safe"
            calls = [("t1", "shell_exec", {"command": "git push --force origin main"}),
                     ("t2", "shell_exec", {"command": "git reset --hard HEAD"})]
            with patch("andromity.core.agent.stream_completion", side_effect=_scripted(calls)):
                app.run_worker(app._stream_agent("tidy up"), exclusive=False)
                assert await _until(pilot, lambda: getattr(app, "_tool_approval_future", None) is not None)
                app._resolve_tool_approval(False)
                await _until(pilot, lambda: False, steps=5)
                assert await _until(pilot, lambda: getattr(app, "_tool_approval_future", None) is not None)
                app._resolve_tool_approval(True)
                sealed = await _until(pilot, lambda: not app._is_streaming and app.session.undo_stack
                                      and "receipt_hash" in app.session.undo_stack[-1], steps=1500)
                assert sealed, (app._is_streaming, [sorted(r) for r in app.session.undo_stack])

            record = app.session.undo_stack[-1]
            assert len(record["receipt_hash"]) == 64 and record["after_hash"]
            decisions = app.session.tool_decisions
            assert decisions["t1"]["approved"] is False and decisions["t2"]["approved"] is True
            assert {d["name"] for d in decisions.values()} == {"Test Person"}
            assert not any("email" in d for d in decisions.values())

            receipt = build_receipt(app.session)
            assert "Destructive command, declined: git push --force origin main" in _lines(receipt)
            assert "Destructive command, approved: git reset --hard HEAD" in _lines(receipt)
            assert len({f.get("approver") for f in receipt["needs_attention"] if f["kind"] == "destructive"}) == 1
            assert receipt["sealed"]["matches"] is True

            texts = [message._content for message in app.query(ChatMessage)]
            assert any("2 things in this turn need your eyes" in text for text in texts)
            await app._show_receipt("")
            shown = [message._content for message in app.query(ChatMessage)][-1]
            assert 'approved by "Test Person" (you)' in shown and 'declined by "Test Person" (you)' in shown

            await app._show_receipt("x")
            assert "Usage: /receipt" in [message._content for message in app.query(ChatMessage)][-1]

            start = record["msg_count"]
            app._perform_confirmed_undo()
            assert await _until(pilot, lambda: not getattr(app, "_undo_in_progress", False))
            assert all(r["msg_count"] < start for r in app.session.undo_stack)

    asyncio.run(run())


def test_the_terminal_app_reports_who_answered_and_who_did_not(project):
    async def run():
        from andromity.tui.app import AndromityApp

        app = AndromityApp()
        async with app.run_test(size=(120, 35)) as pilot:
            await pilot.pause()
            app.session.permission_mode = "safe"
            asked = asyncio.ensure_future(app._on_tool_approval("shell_exec", {"command": "git push --force"}))
            assert await _until(pilot, lambda: getattr(app, "_tool_approval_future", None) is not None)
            app._resolve_tool_approval(True)
            assert await asked == {"approved": True, "by": "person"}
            app.session.permission_mode = "yolo"
            assert await app._on_tool_approval("shell_exec", {"command": "git push --force"}) is True

    asyncio.run(run())


def test_a_headless_run_records_the_person_who_answered(project, monkeypatch, capsys):
    from andromity.cli import _run_async

    monkeypatch.setattr("builtins.input", lambda prompt="": "n")
    with patch("andromity.core.agent.stream_completion",
               side_effect=_scripted([("c1", "shell_exec", {"command": "git push --force origin main"})])):
        asyncio.run(_run_async("push it", False, False, "builder"))
    out = capsys.readouterr().out
    assert "Receipt: 1 thing needs your eyes." in out
    session_id = out.rsplit("andromity receipt ", 1)[1].split()[0]
    session = Session.load_by_id(session_id, str(project))
    assert len(session.undo_stack[-1]["receipt_hash"]) == 64
    receipt = build_receipt(session)
    assert "Destructive command, declined: git push --force origin main" in _lines(receipt)
    assert 'declined by "Test Person"' in render_text(receipt)
    assert receipt["sealed"]["matches"] is True


def test_a_headless_run_never_turns_a_folder_into_a_repository(tmp_path, monkeypatch, capsys):
    from andromity.cli import _run_async

    folder = tmp_path / "plain"
    folder.mkdir()
    config.set_trusted(str(folder))
    monkeypatch.chdir(folder)
    with patch("andromity.core.agent.stream_completion", side_effect=_scripted([])):
        asyncio.run(_run_async("hello", False, False, "builder"))
    assert not (folder / ".git").exists()
    assert "Receipt:" not in capsys.readouterr().out


def test_a_headless_run_in_an_untrusted_folder_takes_no_snapshot(project, monkeypatch, capsys):
    from andromity.cli import _run_async

    config.set_untrusted(str(project)) if hasattr(config, "set_untrusted") else monkeypatch.setattr(
        config, "is_trusted", lambda *a, **k: False)
    with patch("andromity.core.agent.stream_completion", side_effect=_scripted([])):
        asyncio.run(_run_async("hello", False, False, "builder"))
    assert "Receipt:" not in capsys.readouterr().out
    assert _git(project, "branch", "--list", "andromity-snapshots").strip() == ""
