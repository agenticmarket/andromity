"""Tests for the @skill mention completer (query parsing + panel behavior)."""
import asyncio
import tempfile
from pathlib import Path

from andromity.tui.skill_mentions import mention_query


DOCX_SKILL = """\
---
name: docx
description: Create and edit .docx documents with python-docx.
---
# docx skill
"""


def test_mention_query():
    # Cursor right after the typed token (where it sits while typing)
    assert mention_query("hey @doc", (0, 8)) == "doc"
    # Cursor in the middle of the token
    assert mention_query("hey @doc", (0, 7)) == "do"
    assert mention_query("hey @doc", (0, 6)) == "d"
    # Bare @ shows everything
    assert mention_query("hey @", (0, 5)) == ""
    # No @ token -> None (hide panel)
    assert mention_query("no mention", (0, 5)) is None
    assert mention_query("", (0, 0)) is None
    # Trailing punctuation is stripped
    assert mention_query("@docx,", (0, 6)) == "docx"
    # Works on the current line of multiline input
    assert mention_query("first line\nsecond @doc", (1, 12)) == "doc"
    # Out-of-range cursor is clamped, not crashed
    assert mention_query("@doc", (5, 2)) is not None


def test_mention_panel_filters_and_selects():
    async def _run():
        from unittest.mock import patch
        from textual.app import App, ComposeResult
        from textual.widgets import Static

        from andromity.tui.skill_mentions import SkillMentionPanel

        class T(App):
            def compose(self) -> ComposeResult:
                yield Static("host")
                yield SkillMentionPanel(id="skill-mentions")

        proj = tempfile.mkdtemp()
        user_dir = Path(tempfile.mkdtemp())
        skill_dir = Path(proj) / ".andromity" / "skills" / "docx"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(DOCX_SKILL, encoding="utf-8")

        with patch("andromity.core.skills.get_config_dir", return_value=user_dir):
            app = T()
            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause()
                app._project_path = proj
                panel = app.query_one("#skill-mentions", SkillMentionPanel)

                panel.update_query("doc")
                await pilot.pause()
                assert panel.is_open()
                assert panel.selected_skill() == "docx"

                # No match -> panel stays open with nothing selectable
                panel.update_query("zzz")
                await pilot.pause()
                assert panel.is_open()
                assert panel.selected_skill() is None

                # Hiding
                panel.update_query(None)
                assert not panel.is_open()

    asyncio.run(_run())
