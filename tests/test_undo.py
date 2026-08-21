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
