"""The Markdown receipt is safe to paste into a pull request: agent text can't add markup, links, images or mentions."""
import json
import re
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner
from markdown_it import MarkdownIt

from andromity.config import config
from andromity.core.git_ops import create_pre_edit_snapshot
from andromity.core.identity import approver_record
from andromity.core.receipt import build_receipt, close_turn_record, open_turn_record, render_markdown, seal_receipt
from andromity.core.session import Session

HOSTILE_COMMAND = 'rm -rf build | tee x ``` `whoami` <img src=x onerror=alert(1)> @octocat ![p](https://evil.example/p.png)'
HOSTILE_FILE = "docs/[click](evil)`y` @octocat.md"
HOSTILE_READ = "[x](https:/evil.example)<b>@octocat</b>|/.env"
HOSTILE_NAME = "@octocat <img src=https://evil.example/t.png> [me](https://evil.example) **bold**"


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
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    config.set_trusted(str(root))
    return root


def _hostile_receipt(project: Path) -> dict:
    s = Session(session_id="md-hostile", project_path=str(project))
    s.record_tool_decision("c1", True, approver_record({"name": HOSTILE_NAME, "email": "x@example.com"}))
    record = {"snapshot_hash": create_pre_edit_snapshot(project), "msg_count": 0, "turn_index": 0, **open_turn_record(s)}
    s.add_message("user", content="go")
    (project / "docs").mkdir()
    (project / HOSTILE_FILE).write_text("x\n")
    for call_id, name, result, args in (("c1", "shell_exec", "ok", {"command": HOSTILE_COMMAND}),
                                        ("c2", "read_file", "x", {"path": HOSTILE_READ}),
                                        ("c3", "shell_exec", "1 failed\n[exit code 1]", {"command": "pytest -q"}),
                                        ("c4", "write_file", "Successfully wrote", {"path": HOSTILE_FILE})):
        s.add_message("assistant", tool_calls=[{"id": call_id, "type": "function",
                                                "function": {"name": name, "arguments": json.dumps(args)}}],
                      model="provider/<b>model</b>")
        s.add_message("tool", content=result, tool_call_id=call_id, name=name)
    record.update(close_turn_record(s))
    record["after_hash"] = create_pre_edit_snapshot(project)
    s.undo_stack.append(record)
    seal_receipt(s, record)
    return build_receipt(s)


def _html(markdown: str) -> str:
    return MarkdownIt("gfm-like").render(markdown)


def test_agent_text_cannot_add_markup_links_images_or_mentions(project):
    markdown = render_markdown(_hostile_receipt(project))
    html = _html(markdown)
    assert "<img" not in html and "<a " not in html and "<b>" not in html and "<strong>me" not in html
    assert "onerror" not in html.replace("onerror=alert(1)", "")
    plain = re.sub(r"<code>.*?</code>", "", html, flags=re.S)
    assert "@octocat" not in plain
    assert "(you)" not in markdown


def test_issue_references_cannot_link_or_close_anything(project):
    s = Session(session_id="md-refs", project_path=str(project))
    s.record_tool_decision("c1", True, approver_record({"name": "closes octo/app#7", "email": "x@example.com"}))
    record = {"snapshot_hash": create_pre_edit_snapshot(project), "msg_count": 0, "turn_index": 0, **open_turn_record(s)}
    s.add_message("user", content="go")
    s.add_message("assistant", tool_calls=[{"id": "c1", "type": "function",
                                            "function": {"name": "shell_exec", "arguments": json.dumps({"command": "npm publish"})}}],
                  model="fixes #12, resolves gh-3, see octo/app#9")
    s.add_message("tool", content="ok", tool_call_id="c1", name="shell_exec")
    record.update(close_turn_record(s))
    record["after_hash"] = create_pre_edit_snapshot(project)
    s.undo_stack.append(record)
    markdown = render_markdown(build_receipt(s))
    plain = re.sub(r"<code>.*?</code>", "", _html(markdown), flags=re.S)
    assert "fixes #" + chr(0x200B) + "12" in plain
    assert not re.search(r"#\d", plain) and not re.search(r"gh-\d", plain, re.I)
    assert "<code>closes octo/app#7</code>" in _html(markdown)


def test_commands_keep_their_backticks_and_pipes_inside_one_cell(project):
    markdown = render_markdown(_hostile_receipt(project))
    html = _html(markdown)
    codes = [re.sub(r"&[a-z]+;|&#\d+;", "_", c) for c in re.findall(r"<code>(.*?)</code>", html, flags=re.S)]
    assert any("`whoami`" in code and "```" in code and "| tee x" in code for code in codes)
    for row in re.findall(r"<tr>(.*?)</tr>", html, flags=re.S):
        cells = len(re.findall(r"<t[dh]", row))
        assert cells in (2, 4), row


def test_the_markdown_receipt_says_what_happened_and_what_it_is(project):
    markdown = render_markdown(_hostile_receipt(project))
    assert markdown.startswith("### Andromity receipt · turn 1")
    assert "**Needs your eyes (" in markdown
    assert "<details><summary>Commands (2)</summary>" in markdown
    assert "matches the record made when the turn ended" in markdown
    assert "not written by the AI" in markdown
    assert "Approvals by" in markdown and "1 approved" in markdown


def test_the_cli_prints_markdown_and_refuses_two_formats(project, monkeypatch):
    from andromity.cli import main

    receipt_session = Session(session_id="md-cli", project_path=str(project))
    record = {"snapshot_hash": create_pre_edit_snapshot(project), "msg_count": 0, "turn_index": 0,
              **open_turn_record(receipt_session)}
    receipt_session.add_message("user", content="go")
    record.update(close_turn_record(receipt_session))
    record["after_hash"] = create_pre_edit_snapshot(project)
    receipt_session.undo_stack.append(record)
    receipt_session.save()
    runner = CliRunner()
    result = runner.invoke(main, ["receipt", "md-cli", "--markdown", "--project", str(project)])
    assert result.exit_code == 0, result.output
    assert result.output.startswith("### Andromity receipt · turn 1")
    both = runner.invoke(main, ["receipt", "md-cli", "--markdown", "--json", "--project", str(project)])
    assert both.exit_code != 0 and "not both" in both.output


async def test_the_server_sends_markdown_with_the_receipt(project):
    from andromity.server.rpc_handler import JsonRpcHandler

    s = Session(session_id="md-rpc", project_path=str(project))
    record = {"snapshot_hash": create_pre_edit_snapshot(project), "msg_count": 0, "turn_index": 0, **open_turn_record(s)}
    s.add_message("user", content="go")
    record.update(close_turn_record(s))
    record["after_hash"] = create_pre_edit_snapshot(project)
    s.undo_stack.append(record)
    s.save()
    response = await JsonRpcHandler().rpc_session_receipt({"session_id": "md-rpc", "project_path": str(project)})
    assert response["success"] and response["markdown"].startswith("### Andromity receipt · turn 1")
    assert response["turns"] == [0]
