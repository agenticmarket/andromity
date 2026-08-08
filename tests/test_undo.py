"""Tests for Undo confirmation overlay and state rollback behavior."""
import pytest
from pathlib import Path
from andromity.tui.overlays.undo import UndoConfirmOverlay
from andromity.core.session import Session


def test_undo_overlay_prompt_display():
    overlay = UndoConfirmOverlay()
    prompt_text = "Refactor the database connection pool to use retry logic"
    overlay.show_prompt(prompt_text)
    assert overlay._prompt == prompt_text


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
    session.save()

    assert len(session.messages) == 2
    assert session.messages[-1]["content"] == "First response"
    assert session.messages[-1]["role"] == "assistant"
