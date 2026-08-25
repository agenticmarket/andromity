"""Tests for /export — Markdown, HTML, and JSON session exports."""
import json
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from andromity.core.export import (
    build_export_data,
    default_export_filename,
    export_session,
    render_html,
    render_markdown,
)
from andromity.core.session import Session


def _make_session(tmp_path: Path, with_usage: bool = True) -> Session:
    s = Session(name="export-test", project_path=str(tmp_path))
    if with_usage:
        s.update_usage({"prompt_tokens": 1000, "completion_tokens": 500, "total_tokens": 1500},
                       model="openai/gpt-4o-mini")
    return s


def _seed_conversation(s: Session):
    s.add_message("system", content="system prompt")
    s.add_message("user", content="What files are here?")
    s.add_message("assistant", content=None, tool_calls=[
        {"id": "call_1", "type": "function",
         "function": {"name": "list_dir", "arguments": '{"path": "."}'}},
    ])
    s.add_message("tool", content="a.py\nb.py", name="list_dir", tool_call_id="call_1")
    s.add_message("assistant", content="There are two files: a.py and b.py.")


# ── Markdown ─────────────────────────────────────────────────────────────────

def test_markdown_header_contains_session_metadata(tmp_path):
    s = _make_session(tmp_path)
    md = render_markdown(build_export_data(s))
    assert "# Andromity Session Export" in md
    assert "| **Date** |" in md
    assert "`openai/gpt-4o-mini`" in md
    assert "1,500" in md
    assert re.search(r"\$\d+\.\d{4} \(litellm\)", md)


def test_markdown_contains_full_transcript_with_tools_and_timing(tmp_path):
    s = _make_session(tmp_path)
    _seed_conversation(s)
    md = render_markdown(build_export_data(s))
    assert "### 🧑 User" in md
    assert "What files are here?" in md
    assert "### 🤖 Andromity" in md
    assert "There are two files: a.py and b.py." in md
    assert "`list_dir`" in md
    assert "duration:" in md
    assert 'Args: `{"path": "."}`' in md
    assert "Result: a.py b.py" in md


def test_markdown_tool_without_result_shows_placeholder(tmp_path):
    s = _make_session(tmp_path)
    s.add_message("user", content="hi")
    s.add_message("assistant", content=None, tool_calls=[
        {"id": "c9", "type": "function", "function": {"name": "shell_exec", "arguments": "{}"}},
    ])
    md = render_markdown(build_export_data(s))
    assert "(no result)" in md
    assert "`shell_exec`" in md


# ── HTML ─────────────────────────────────────────────────────────────────────

def test_html_is_standalone_document_with_metadata(tmp_path):
    s = _make_session(tmp_path)
    html_out = render_html(build_export_data(s))
    assert html_out.lstrip().startswith("<!DOCTYPE html>")
    assert "</html>" in html_out
    assert "openai/gpt-4o-mini" in html_out
    assert "1,500" in html_out


def test_html_escapes_user_content(tmp_path):
    s = _make_session(tmp_path)
    s.add_message("user", content="<script>alert('x')</script> & <b>bold</b>")
    html_out = render_html(build_export_data(s))
    assert "<script>alert" not in html_out
    assert "&lt;script&gt;" in html_out
    assert "&amp; " in html_out


def test_html_contains_turns_tools_and_timing(tmp_path):
    s = _make_session(tmp_path)
    _seed_conversation(s)
    html_out = render_html(build_export_data(s))
    assert "Turn 1" in html_out
    assert 'class="role-user"' in html_out
    assert 'class="tool"' in html_out
    assert "list_dir" in html_out
    assert "duration:" in html_out


# ── JSON ─────────────────────────────────────────────────────────────────────

def test_json_round_trip_structure(tmp_path):
    s = _make_session(tmp_path)
    _seed_conversation(s)
    out = export_session(s, output_path="session.json", project_path=str(tmp_path))
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["model"] == "openai/gpt-4o-mini"
    assert data["token_total"] == 1500
    assert data["cost_usd"] > 0
    assert len(data["turns"]) == 1
    turn = data["turns"][0]
    assert turn["prompt"] == "What files are here?"
    assert turn["responses"][0]["text"].startswith("There are two files")
    tool = turn["tools"][0]
    assert tool["name"] == "list_dir"
    assert tool["result"] == "a.py\nb.py"
    assert isinstance(tool["duration_s"], float)


def test_json_includes_usage_breakdown(tmp_path):
    s = _make_session(tmp_path)
    data = build_export_data(s)
    assert data["usage_breakdown"]["prompt_tokens"] == 1000
    assert data["usage_breakdown"]["completion_tokens"] == 500


# ── Command syntax & file resolution ─────────────────────────────────────────

def test_default_export_creates_timestamped_md_in_project_root(tmp_path):
    s = _make_session(tmp_path)
    out = export_session(s, output_path="", project_path=str(tmp_path))
    assert out.parent == tmp_path
    assert out.name.startswith("andromity-session-")
    assert out.suffix == ".md"
    assert out.exists() and out.read_text(encoding="utf-8").startswith("# Andromity Session Export")


def test_default_filename_pattern():
    name = default_export_filename(".md", now=datetime(2025, 6, 15, 10, 30, 45))
    assert name == "andromity-session-20250615-103045.md"


def test_custom_paths_md_html_json(tmp_path):
    s = _make_session(tmp_path)
    for fname in ("out/report.md", "report.html", "report.json"):
        out = export_session(s, output_path=fname, project_path=str(tmp_path))
        assert Path(out).exists()
        assert out.suffix.lower() in (".md", ".html", ".json")
        assert out.stat().st_size > 0


def test_unsupported_extension_raises_valueerror(tmp_path):
    s = _make_session(tmp_path)
    with pytest.raises(ValueError):
        export_session(s, output_path="report.pdf", project_path=str(tmp_path))


def test_extension_missing_raises_valueerror(tmp_path):
    s = _make_session(tmp_path)
    with pytest.raises(ValueError):
        export_session(s, output_path="report", project_path=str(tmp_path))


def test_case_insensitive_extensions_and_quoted_filenames(tmp_path):
    s = _make_session(tmp_path)
    out = export_session(s, output_path='"REPORT.HTML"', project_path=str(tmp_path))
    assert out.name == "REPORT.HTML"
    assert "<!DOCTYPE html>" in out.read_text(encoding="utf-8")


# ── Edge cases ───────────────────────────────────────────────────────────────

def test_empty_session_exports_valid_skeleton(tmp_path):
    s = _make_session(tmp_path, with_usage=False)
    for ext in (".md", ".html", ".json"):
        out = export_session(s, output_path=f"empty{ext}", project_path=str(tmp_path))
        content = out.read_text(encoding="utf-8")
        if ext == ".json":
            parsed = json.loads(content)
            assert parsed["turns"] == []
            assert parsed["token_total"] == 0
        elif ext == ".md":
            assert "# Andromity Session Export" in content
        else:
            assert content.lstrip().startswith("<!DOCTYPE html>")


def test_assistant_message_before_any_prompt_gets_implicit_turn(tmp_path):
    s = _make_session(tmp_path)
    s.messages.append({"role": "assistant", "content": "Hello!"})
    data = build_export_data(s)
    assert len(data["turns"]) == 1
    assert data["turns"][0]["prompt"] == "(no user prompt)"
    assert data["turns"][0]["responses"][0]["text"] == "Hello!"
    assert "(no user prompt)" in render_markdown(data)


def test_legacy_messages_without_ts_do_not_crash(tmp_path):
    s = _make_session(tmp_path)
    _seed_conversation(s)
    for m in s.messages:
        m.pop("ts", None)
    md = render_markdown(build_export_data(s))
    assert "n/a" in md
    assert "`list_dir`" in md


def test_tool_duration_computed_from_timestamps(tmp_path):
    s = _make_session(tmp_path)
    t0 = datetime.now(timezone.utc)
    t1 = datetime.fromtimestamp(t0.timestamp() + 2.5, tz=timezone.utc)
    s.add_message("user", content="go")
    s.add_message("assistant", content=None, tool_calls=[
        {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}},
    ])
    s.messages[-2]["ts"] = t0.isoformat()
    s.add_message("tool", content="ok", name="read_file", tool_call_id="c1")
    s.messages[-1]["ts"] = t1.isoformat()
    data = build_export_data(s)
    assert data["turns"][0]["tools"][0]["duration_s"] == pytest.approx(2.5, abs=0.01)


def test_mismatched_tool_call_id_leaves_result_none(tmp_path):
    s = _make_session(tmp_path)
    s.add_message("user", content="go")
    s.add_message("assistant", content=None, tool_calls=[
        {"id": "aaa", "type": "function", "function": {"name": "read_file", "arguments": "{}"}},
    ])
    s.add_message("tool", content="ok", name="read_file", tool_call_id="bbb")
    data = build_export_data(s)
    assert data["turns"][0]["tools"][0]["result"] is None
    assert "(no result)" in render_markdown(data)


# ── Integration: palette / help registration + app command handling ──────────

def test_export_registered_in_palette_and_help():
    from andromity.tui.command_palette import COMMAND_DESCRIPTIONS
    assert "/export" in COMMAND_DESCRIPTIONS


def test_export_registered_in_app_commands():
    from andromity.tui.app import COMMANDS
    assert "/export" in COMMANDS


@pytest.mark.asyncio
async def test_app_export_command_writes_file_and_system_message(tmp_path, monkeypatch):
    from andromity.config import config
    from andromity.tui.app import AndromityApp
    from andromity.tui.panels.chat import ChatPanel, ChatMessage

    cfg_dir = tmp_path / "cfg"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "config_dir", cfg_dir)
    monkeypatch.setattr(config, "config_path", cfg_dir / "config.toml")
    config._config_cache = {}
    config._load()

    monkeypatch.chdir(tmp_path)
    app = AndromityApp()
    async with app.run_test(size=(120, 30)) as pilot:
        for _ in range(5):
            await pilot.pause()
        app._handle_command("/export chat.md")
        await pilot.pause()

        out_file = tmp_path / "chat.md"
        assert out_file.exists()
        assert out_file.read_text(encoding="utf-8").startswith("# Andromity Session Export")

        chat = app.query_one(ChatPanel)
        texts = [m._content for m in chat.query(ChatMessage)]
        assert any("Session exported" in t and str(out_file) in t for t in texts), texts


@pytest.mark.asyncio
async def test_app_export_invalid_format_shows_usage(tmp_path, monkeypatch):
    from andromity.config import config
    from andromity.tui.app import AndromityApp
    from andromity.tui.panels.chat import ChatPanel, ChatMessage

    cfg_dir = tmp_path / "cfg"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "config_dir", cfg_dir)
    monkeypatch.setattr(config, "config_path", cfg_dir / "config.toml")
    config._config_cache = {}
    config._load()

    monkeypatch.chdir(tmp_path)
    app = AndromityApp()
    async with app.run_test(size=(120, 30)) as pilot:
        for _ in range(5):
            await pilot.pause()
        before = sorted(p.name for p in tmp_path.iterdir())
        app._handle_command("/export report.xyz")
        await pilot.pause()

        chat = app.query_one(ChatPanel)
        texts = [m._content for m in chat.query(ChatMessage)]
        assert any("Usage: /export" in t for t in texts)
        after = sorted(p.name for p in tmp_path.iterdir())
        assert before == after, "no file should be written for an invalid format"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
