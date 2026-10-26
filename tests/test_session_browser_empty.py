"""The TUI session browser should not fill up with sessions that hold only the system prompt."""
from types import SimpleNamespace

from andromity.core.session import Session
from andromity.tui.overlays.session import _worth_listing


def test_list_sessions_counts_conversation_messages_separately(tmp_path):
    empty = Session(name="new-session", project_path=str(tmp_path))
    empty.add_message("system", "You are Andromity.")
    empty.save()
    used = Session(name="Fix the login bug", project_path=str(tmp_path))
    used.add_message("system", "You are Andromity.")
    used.add_message("user", "fix the login bug")
    used.add_message("assistant", "Done.")
    used.save()

    listed = {s.id: s for s in Session.list_sessions(str(tmp_path))}
    assert listed[empty.id].message_count == 1
    assert listed[empty.id].conversation_count == 0
    assert listed[used.id].message_count == 3
    assert listed[used.id].conversation_count == 2


def _row(**kw):
    base = dict(id="s1", name="new-session", status="idle", conversation_count=0)
    base.update(kw)
    return SimpleNamespace(**base)


def test_browser_hides_abandoned_empty_sessions_only():
    assert _worth_listing(_row(), current_id="other") is False
    assert _worth_listing(_row(), current_id="s1") is True, "the session you are in stays"
    assert _worth_listing(_row(conversation_count=1), current_id="other") is True
    assert _worth_listing(_row(status="running"), current_id="other") is True
    assert _worth_listing(_row(status="approval_required"), current_id="other") is True
    assert _worth_listing(_row(name="cron:nightly"), current_id="other") is True
    assert _worth_listing(SimpleNamespace(id="old", name="x", status="idle"), current_id="other") is True, "rows without the count stay visible"


def test_session_list_rpc_reports_conversation_count(tmp_path):
    import asyncio
    from andromity.server.rpc_handler import JsonRpcHandler

    used = Session(name="Review the parser", project_path=str(tmp_path))
    used.add_message("system", "You are Andromity.")
    used.add_message("user", "review the parser")
    used.save()

    rows = asyncio.run(JsonRpcHandler().rpc_session_list({"project_path": str(tmp_path)}))
    row = next(r for r in rows if r["id"] == used.id)
    assert row["message_count"] == 2, "kept for older clients"
    assert row["conversation_count"] == 1
