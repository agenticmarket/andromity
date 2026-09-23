"""Tests for Undo confirmation overlay, state rollback behavior, and multi-click crash protection."""
import pytest
from unittest.mock import MagicMock
from textual.widgets import Button
from textual.events import MouseDown, Key
from textual.geometry import Offset
import textual.screen

from andromity.tui.overlays.undo import UndoConfirmOverlay
from andromity.tui.patches import apply_textual_patches
from andromity.core.session import Session


def test_undo_overlay_prompt_display():
    prompt_text = "Refactor the database connection pool to use retry logic"
    overlay = UndoConfirmOverlay(prompt=prompt_text)
    assert overlay._prompt == prompt_text
    assert overlay._dismissed is False


def test_undo_overlay_multi_click_protection():
    overlay = UndoConfirmOverlay(prompt="test prompt")
    dismiss_calls = []
    overlay.dismiss = lambda result: dismiss_calls.append(result)

    btn = Button("Undo Turn", id="undo-confirm")
    event = Button.Pressed(btn)

    # First click should dismiss
    overlay.on_button_pressed(event)
    assert len(dismiss_calls) == 1
    assert dismiss_calls[0] is True
    assert overlay._dismissed is True
    assert btn.disabled is True

    # Subsequent rapid clicks should be ignored and not call dismiss again
    overlay.on_button_pressed(event)
    overlay.on_button_pressed(event)
    assert len(dismiss_calls) == 1


def test_undo_overlay_multi_key_protection():
    overlay = UndoConfirmOverlay(prompt="test prompt")
    dismiss_calls = []
    overlay.dismiss = lambda result: dismiss_calls.append(result)

    key_event = Key("enter", "enter")
    overlay.on_key(key_event)
    assert len(dismiss_calls) == 1
    assert dismiss_calls[0] is True
    assert overlay._dismissed is True

    # Second key press is ignored
    overlay.on_key(key_event)
    assert len(dismiss_calls) == 1


def test_session_message_rollback_clean(tmp_path):
    session = Session(project_path=str(tmp_path))
    session.add_message("user", "First prompt")
    session.add_message("assistant", "First response")
    
    # Save checkpoint at msg_count = 2
    checkpoint_msg_count = len(session.messages)
    
    # Turn 2: User prompt + assistant response
    session.add_message("user", "Second prompt to be undone")
    session.add_message("assistant", "Second response with tool calls")
    assert len(session.messages) == 4

    # Perform rollback to checkpoint
    session.messages = session.messages[:checkpoint_msg_count]
    session.context_tokens = sum(
        len(str(msg.get("content", ""))) // 4 for msg in session.messages
    )
    session.save()

    assert len(session.messages) == 2
    assert session.messages[-1]["content"] == "First response"
    assert session.messages[-1]["role"] == "assistant"
    assert session.context_tokens > 0


def test_textual_screen_forward_event_patch():
    """Verify that Textual Screen._forward_event does not crash with AttributeError on detached widget."""
    apply_textual_patches()

    screen = textual.screen.Screen()
    # Mock get_widget_and_offset_at returning an orphaned widget whose parent is None
    detached_widget = MagicMock()
    detached_widget.allow_select = True
    detached_widget.parent = None

    screen.get_widget_and_offset_at = MagicMock(return_value=(detached_widget, Offset(0, 0)))
    screen.get_widget_at = MagicMock(side_effect=Exception("Unmounted"))

    mouse_down = MouseDown(None, x=10, y=10, delta_x=0, delta_y=0, button=1, shift=False, meta=False, ctrl=False, screen_x=10, screen_y=10)
    
    # This should not raise AttributeError: 'NoneType' object has no attribute 'region'
    screen._forward_event(mouse_down)


def test_session_multi_turn_rollback_to_turn_index(tmp_path):
    """Verify that rollback_to_turn(target_turn_index) accurately rolls back multi-turn sessions."""
    session = Session(project_path=str(tmp_path))
    
    # 4 distinct turns:
    # Turn 0
    session.add_message("user", "Prompt 1: init repo")
    session.add_message("assistant", "Response 1", tool_calls=[{"id": "c1", "name": "view_file"}])
    session.add_message("tool", "content", tool_call_id="c1")
    session.add_message("assistant", "Response 1 done")
    
    # Turn 1
    session.add_message("user", "Prompt 2: add feature A")
    session.add_message("assistant", "Response 2 done")
    
    # Turn 2 (3rd turn)
    session.add_message("user", "Prompt 3: add feature B")
    session.add_message("assistant", "Response 3 done")
    
    # Turn 3 (4th turn)
    session.add_message("user", "Prompt 4: add feature C")
    session.add_message("assistant", "Response 4 done")
    
    user_turns = session.get_user_turn_indices()
    assert len(user_turns) == 4
    assert len(session.messages) == 10
    
    # Setup mock undo_stack with 4 items
    session.undo_stack = [
        {"snapshot_hash": "hash0", "msg_count": 0, "turn_index": 0},
        {"snapshot_hash": "hash1", "msg_count": 4, "turn_index": 1},
        {"snapshot_hash": "hash2", "msg_count": 6, "turn_index": 2},
        {"snapshot_hash": "hash3", "msg_count": 8, "turn_index": 3},
    ]
    
    # User clicks "Undo to here" on Turn 2 (the 3rd turn)
    turns_undone, popped, snap = session.rollback_to_turn(target_turn_index=2)
    
    assert turns_undone == 2  # Turns 3 and 2 were undone
    assert popped == 4        # Turn 2 (2 msgs) + Turn 3 (2 msgs)
    assert len(session.messages) == 6  # Turn 0 (4 msgs) + Turn 1 (2 msgs) remain
    assert session.messages[-1]["content"] == "Response 2 done"
    assert session.messages[-2]["content"] == "Prompt 2: add feature A"
    assert snap is not None
    assert snap["snapshot_hash"] == "hash2"
    assert len(session.undo_stack) == 2  # hash0 and hash1 remain
    assert [x["snapshot_hash"] for x in session.undo_stack] == ["hash0", "hash1"]


def test_session_multi_turn_rollback_to_turn_0(tmp_path):
    """Verify that rollback_to_turn(0) rolls back all turns back to clean slate."""
    session = Session(project_path=str(tmp_path))
    session.add_message("user", "Turn 1")
    session.add_message("assistant", "Answer 1")
    session.add_message("user", "Turn 2")
    session.add_message("assistant", "Answer 2")
    session.undo_stack = [
        {"snapshot_hash": "snap_base", "turn_index": 0},
        {"snapshot_hash": "snap_turn1", "turn_index": 1},
    ]
    
    turns_undone, popped, snap = session.rollback_to_turn(0)
    assert turns_undone == 2
    assert popped == 4
    assert len(session.messages) == 0
    assert snap["snapshot_hash"] == "snap_base"
    assert len(session.undo_stack) == 0


def test_session_undo_stack_persistence(tmp_path):
    """Verify undo_stack is preserved through Session.save, load, and SQLite DB."""
    session = Session(project_path=str(tmp_path))
    session.add_message("user", "Hello")
    session.add_message("assistant", "World")
    session.undo_stack = [
        {"snapshot_hash": "abc1234", "msg_count": 0, "turn_index": 0},
        {"snapshot_hash": "def5678", "msg_count": 2, "turn_index": 1},
    ]
    session.save()
    
    # 1. Test JSON load
    loaded = Session.load(session.file_path)
    assert loaded.undo_stack == session.undo_stack
    
    # 2. Test SQLite load
    from andromity.core.db import get_conn
    row = get_conn().execute("SELECT * FROM sessions WHERE id = ?", (session.id,)).fetchone()
    assert row is not None
    from_db = Session._from_db_row(row)
    assert from_db.undo_stack == session.undo_stack


@pytest.mark.asyncio
async def test_rpc_session_undo_multi_turn_git_rollback(tmp_path):
    """End-to-end test: 4 turns modifying files, undoing to turn 2 restores files to pre-turn 2 state."""
    from git import Repo
    from andromity.core.git_ops import ensure_git_tracking, create_pre_edit_snapshot
    from andromity.server.rpc_handler import JsonRpcHandler
    
    # 1. Initialize isolated git repo and baseline commit
    repo = Repo.init(tmp_path)
    baseline_file = tmp_path / "baseline.txt"
    baseline_file.write_text("baseline data\n", encoding="utf-8")
    repo.git.add("-A")
    repo.index.commit("baseline commit")
    
    handler = JsonRpcHandler()
    session = Session(project_path=str(tmp_path))
    session.undo_stack = []
    session.save()
    handler._active_sessions[session.id] = session
    
    # Simulate Turn 0: pre-turn snapshot, creates file1.txt
    s0 = create_pre_edit_snapshot(repo)
    session.undo_stack.append({"snapshot_hash": s0, "msg_count": len(session.messages), "turn_index": 0})
    session.add_message("user", "Turn 0: create file1")
    (tmp_path / "file1.txt").write_text("file1 v0\n", encoding="utf-8")
    session.add_message("assistant", "Created file1")
    
    # Simulate Turn 1: pre-turn snapshot, modifies file1, creates file2.txt
    s1 = create_pre_edit_snapshot(repo)
    session.undo_stack.append({"snapshot_hash": s1, "msg_count": len(session.messages), "turn_index": 1})
    session.add_message("user", "Turn 1: update file1 and create file2")
    (tmp_path / "file1.txt").write_text("file1 v1\n", encoding="utf-8")
    (tmp_path / "file2.txt").write_text("file2 v1\n", encoding="utf-8")
    session.add_message("assistant", "Updated file1, created file2")
    
    # Simulate Turn 2 (3rd turn): pre-turn snapshot, modifies file1, creates file3.txt
    s2 = create_pre_edit_snapshot(repo)
    session.undo_stack.append({"snapshot_hash": s2, "msg_count": len(session.messages), "turn_index": 2})
    session.add_message("user", "Turn 2: update file1 and create file3")
    (tmp_path / "file1.txt").write_text("file1 v2\n", encoding="utf-8")
    (tmp_path / "file3.txt").write_text("file3 v2\n", encoding="utf-8")
    session.add_message("assistant", "Updated file1, created file3")
    
    # Simulate Turn 3 (4th turn): pre-turn snapshot, creates file4.txt
    s3 = create_pre_edit_snapshot(repo)
    session.undo_stack.append({"snapshot_hash": s3, "msg_count": len(session.messages), "turn_index": 3})
    session.add_message("user", "Turn 3: create file4")
    (tmp_path / "file4.txt").write_text("file4 v3\n", encoding="utf-8")
    session.add_message("assistant", "Created file4")
    session.save()
    
    # Verify disk state before undo: all 4 files exist
    assert (tmp_path / "file1.txt").read_text() == "file1 v2\n"
    assert (tmp_path / "file2.txt").read_text() == "file2 v1\n"
    assert (tmp_path / "file3.txt").read_text() == "file3 v2\n"
    assert (tmp_path / "file4.txt").read_text() == "file4 v3\n"
    assert len(session.get_user_turn_indices()) == 4
    
    # --- TEST 1: User clicks "Undo to here" on Turn 2 (3rd turn) ---
    res = await handler.rpc_session_undo({
        "session_id": session.id,
        "project_path": str(tmp_path),
        "turn_index": 2,
    })
    
    assert res["success"] is True
    assert res["turns_undone"] == 2
    assert res["target_turn_index"] == 2
    assert "Restored snapshot" in res["git_status"]
    
    # Verify file rollback:
    # file4 was created in Turn 3 -> MUST be deleted!
    assert not (tmp_path / "file4.txt").exists()
    # file3 was created in Turn 2 -> MUST be deleted!
    assert not (tmp_path / "file3.txt").exists()
    # file2 was created in Turn 1 -> MUST exist!
    assert (tmp_path / "file2.txt").is_file()
    assert (tmp_path / "file2.txt").read_text() == "file2 v1\n"
    # file1 was modified in Turn 2 to v2 -> MUST be restored to v1!
    assert (tmp_path / "file1.txt").is_file()
    assert (tmp_path / "file1.txt").read_text() == "file1 v1\n"
    # baseline file MUST be intact!
    assert (tmp_path / "baseline.txt").read_text() == "baseline data\n"
    
    # Verify session messages:
    assert len(session.get_user_turn_indices()) == 2
    assert len(session.messages) == 4
    assert session.messages[-1]["content"] == "Updated file1, created file2"
    
    # --- TEST 2: User now clicks "Undo to here" on Turn 0 (rollback all remaining turns) ---
    res0 = await handler.rpc_session_undo({
        "session_id": session.id,
        "project_path": str(tmp_path),
        "turn_index": 0,
    })
    
    assert res0["success"] is True
    assert res0["turns_undone"] == 2
    assert res0["target_turn_index"] == 0
    
    # Both file1 and file2 were created after baseline commit -> MUST be deleted!
    assert not (tmp_path / "file1.txt").exists()
    assert not (tmp_path / "file2.txt").exists()
    assert (tmp_path / "baseline.txt").read_text() == "baseline data\n"
    assert len(session.messages) == 0


@pytest.mark.asyncio
async def test_rpc_session_undo_turns_to_undo_param(tmp_path):
    """Verify turns_to_undo parameter can be passed directly."""
    from andromity.server.rpc_handler import JsonRpcHandler
    handler = JsonRpcHandler()
    session = Session(project_path=str(tmp_path))
    session.add_message("user", "Turn 1")
    session.add_message("assistant", "A1")
    session.add_message("user", "Turn 2")
    session.add_message("assistant", "A2")
    session.add_message("user", "Turn 3")
    session.add_message("assistant", "A3")
    session.save()
    handler._active_sessions[session.id] = session
    
    res = await handler.rpc_session_undo({
        "session_id": session.id,
        "project_path": str(tmp_path),
        "turns_to_undo": 2,
    })
    assert res["success"] is True
    assert res["turns_undone"] == 2
    assert res["target_turn_index"] == 1
    assert len(session.get_user_turn_indices()) == 1
    assert session.messages[-1]["content"] == "A1"


@pytest.mark.asyncio
async def test_per_file_snapshot_isolation_and_rollback(tmp_path):
    """Verify targeted per-file snapshotting rolls back agent edits without clobbering unrelated user edits."""
    from git import Repo
    from andromity.core.git_ops import create_pre_edit_snapshot, restore_snapshot
    
    repo = Repo.init(tmp_path)
    (tmp_path / "baseline.py").write_text("print('baseline')\n", encoding="utf-8")
    repo.git.add("-A")
    repo.index.commit("baseline commit")
    
    # 1. User is editing an unrelated document
    user_file = tmp_path / "user_notes.txt"
    user_file.write_text("User personal notes - DO NOT TOUCH\n", encoding="utf-8")
    
    # 2. Agent prepares to edit agent_code.py (takes targeted snapshot of agent_code.py)
    agent_file = tmp_path / "agent_code.py"
    agent_file.write_text("def v1(): pass\n", encoding="utf-8")
    repo.git.add("agent_code.py")
    repo.index.commit("add agent_code")
    
    # Pre-edit snapshot of ONLY agent_code.py
    snap = create_pre_edit_snapshot(repo, target_files=["agent_code.py"])
    assert snap is not None
    
    # Agent makes modification
    agent_file.write_text("def v2_broken(): raise RuntimeError()\n", encoding="utf-8")
    # User adds more to user_notes.txt while agent is running
    user_file.write_text("User personal notes - DO NOT TOUCH - Updated by User\n", encoding="utf-8")
    
    # 3. Rollback the agent turn
    ok = restore_snapshot(repo, snap, files=["agent_code.py"])
    assert ok is True
    
    # Agent code restored to pre-edit state
    assert agent_file.read_text(encoding="utf-8") == "def v1(): pass\n"
    # User's manual file completely preserved and untainted!
    assert user_file.read_text(encoding="utf-8") == "User personal notes - DO NOT TOUCH - Updated by User\n"

