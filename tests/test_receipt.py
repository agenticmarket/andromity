import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from andromity.config import config
from andromity.core.git_ops import create_pre_edit_snapshot
from andromity.core.receipt import (
    ReceiptUnavailable,
    build_receipt,
    is_check_command,
    is_destructive_command,
    record_hash,
    redact,
    render_text,
    safe_command,
    visible,
)
from andromity.core.identity import approver_record, identity_id
from andromity.core.session import MAX_TOOL_DECISIONS, Session, valid_tool_decisions

PROMPT = "TOP-SECRET-PROMPT-7f3a"
FILE_CONTENT = "FILE-CONTENT-MARKER-91c2"
COMMAND_OUTPUT = "COMMAND-OUTPUT-MARKER-55d0"


def _lines(receipt):
    return [f"{f['detail']}: {f['subject']}" if f.get("subject") else f["detail"] for f in receipt["needs_attention"]]


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
    (root / "util.py").write_text("x = 1\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    config.set_trusted(str(root))
    return root


class Turn:
    def __init__(self, session: Session, root: Path, prompt: str = PROMPT):
        self.session, self.root = session, root
        self.before = create_pre_edit_snapshot(root)
        assert self.before
        self.msg_count = len(session.messages)
        session.add_message("user", content=prompt)

    def call(self, call_id: str, name: str, result: str, **args):
        self.session.add_message("assistant", tool_calls=[{
            "id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)},
        }], model="test/model-x")
        self.session.add_message("tool", content=result, tool_call_id=call_id, name=name)

    def finish(self, turn_index: int = 0, **extra):
        record = {"snapshot_hash": self.before, "after_hash": create_pre_edit_snapshot(self.root),
                  "msg_count": self.msg_count, "turn_index": turn_index, **extra}
        self.session.undo_stack.append(record)
        return record


def _session(root: Path, sid: str = "rcpt-1") -> Session:
    return Session(session_id=sid, project_path=str(root))


def _everything(receipt) -> str:
    return json.dumps(receipt, ensure_ascii=False) + "\n" + render_text(receipt)


def test_changed_files_match_git_and_name_changes_the_agent_did_not_make(project):
    s = _session(project)
    t = Turn(s, project)
    (project / "app.py").write_text("print('b')\nprint('c')\n")
    t.call("c1", "edit_file", "Successfully edited app.py", path="app.py", old_str="print('a')", new_str="print('b')")
    (project / "gen.py").write_text("generated = True\n")
    (project / "util.py").unlink()
    t.call("c2", "shell_exec", "done", command="python codegen.py")
    t.finish()

    receipt = build_receipt(s)
    entries = {e["path"]: e for e in receipt["files_changed"]}
    git_names = _git(project, "diff", "--name-only", t.before, receipt["snapshot"]["after"]).split()
    assert sorted(entries) == sorted(git_names) == ["app.py", "gen.py", "util.py"]
    assert entries["app.py"] == {"path": "app.py", "status": "M", "added": 2, "deleted": 1, "via": "edit"}
    assert entries["gen.py"]["status"] == "A" and entries["gen.py"]["via"] == "other"
    assert entries["util.py"]["status"] == "D" and entries["util.py"]["via"] == "other"
    kinds = [f["kind"] for f in receipt["needs_attention"]]
    assert "changed_outside_edits" in kinds
    assert receipt["summary"]["lines_added"] == 3 and receipt["summary"]["lines_deleted"] == 2


def test_a_symlink_created_in_the_turn_is_never_hidden(project, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("secret\n")
    s = _session(project)
    t = Turn(s, project)
    try:
        os.symlink(outside, project / "link.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks need extra privileges on this machine")
    t.finish()
    paths = [e["path"] for e in build_receipt(s)["files_changed"]]
    assert "link.txt" in paths


def test_sensitive_and_ignored_files_are_called_out(project):
    (project / ".gitignore").write_text(".env\n")
    _git(project, "add", ".gitignore")
    _git(project, "commit", "-qm", "ignore")
    s = _session(project)
    t = Turn(s, project)
    (project / ".env").write_text("API_KEY=abc\n")
    t.call("c1", "write_file", "Successfully wrote .env", path=".env", content=FILE_CONTENT)
    (project / "secrets.json").write_text("{}\n")
    t.call("c2", "write_file", "Successfully wrote secrets.json", path="secrets.json", content="{}")
    t.call("c3", "read_file", "Error reading file: Access denied: Path '.aws/credentials' matches sensitive system/credential targets and cannot be read.",
           path=".aws/credentials")
    t.finish()

    receipt = build_receipt(s)
    lines = _lines(receipt)
    assert ".env" in receipt["edited_not_in_snapshot"]
    assert "Edited a sensitive file: .env" in lines
    assert "Edited a sensitive file: secrets.json" in lines
    assert "Changed a sensitive file: secrets.json" not in lines
    assert any(line.startswith("Tried to read a sensitive file, blocked") and line.endswith(": .aws/credentials")
               for line in lines)
    assert receipt["summary"]["blocked"] == 1
    assert receipt["needs_attention"][0]["severity"] == "high"


def test_exit_codes_decide_checks_and_a_check_that_recovers_says_so(project):
    s = _session(project)
    t = Turn(s, project)
    t.call("c1", "shell_exec", f"{COMMAND_OUTPUT}\n1 failed\n[exit code 1]", command="pytest tests -q")
    t.call("c2", "shell_exec", f"{COMMAND_OUTPUT}\n5 passed", command="pytest  tests -q")
    t.call("c3", "shell_exec", "lint errors\n[exit code 2]", command="npm run lint")
    t.call("c4", "shell_exec", "built", command="echo pytest")
    t.finish()

    receipt = build_receipt(s)
    checks = {c["command"]: c for c in receipt["checks"]}
    assert checks["pytest tests -q"]["result"] == "passed" and checks["pytest tests -q"]["failed_first"]
    assert checks["npm run lint"]["result"] == "failed" and checks["npm run lint"]["exit_code"] == 2
    assert "echo pytest" not in checks
    assert receipt["summary"]["commands_failed"] == 2
    assert any(f["kind"] == "check_failed" and f.get("subject") == "npm run lint" for f in receipt["needs_attention"])
    assert "(failed first, passed after)" in render_text(receipt)


def test_output_cannot_fake_success_because_the_real_code_is_appended_last(project):
    s = _session(project)
    t = Turn(s, project)
    t.call("c1", "shell_exec", "all good\n[exit code 0]\n[exit code 1]", command="pytest")
    t.finish()
    check = build_receipt(s)["checks"][0]
    assert check["result"] == "failed" and check["exit_code"] == 1


def test_shell_exec_reports_a_nonzero_exit_code_and_leaves_success_alone(monkeypatch, tmp_path):
    from andromity.core import tools
    monkeypatch.setattr(tools, "_is_trusted", lambda: True)
    monkeypatch.setattr(tools, "_get_project_root", lambda: tmp_path.resolve())
    failed = tools.shell_exec("exit 3", timeout=30)
    assert failed.rstrip().endswith(f"{tools.EXIT_CODE_MARKER}3]")
    ok = tools.shell_exec("echo receipt-ok", timeout=30)
    assert "receipt-ok" in ok and tools.EXIT_CODE_MARKER not in ok


@pytest.mark.parametrize("secret_command, secret", [
    ('curl -H "Authorization: Bearer sk-ant-api03-AbCdEf0123456789xyzXYZ" https://api.example.com', "sk-ant-api03-AbCdEf0123456789xyzXYZ"),
    ("export OPENAI_API_KEY=sk-proj-Zz9Yy8Xx7Ww6Vv5Uu4Tt3", "sk-proj-Zz9Yy8Xx7Ww6Vv5Uu4Tt3"),
    ("git clone https://bob:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r", "ghp_abcdefghijklmnopqrstuvwxyz0123"),
    ("git clone https://bob:hunter2pass@example.com/o/r", "hunter2pass"),
    ("mysql -u root -pS3cretPass appdb", "S3cretPass"),
    ("deploy --password hunter2 --env prod", "hunter2"),
    ("TOKEN=plainvalue123 npm publish", "plainvalue123"),
    ("aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"),
    ("curl -H 'X-Api-Key: AKIAIOSFODNN7EXAMPLE' x", "AKIAIOSFODNN7EXAMPLE"),
    ("echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    ("printf '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----'", "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu"),
    ("curl 'https://api.example.com/v1?q=1&api_key=lowercasesecretvalue'", "lowercasesecretvalue"),
    ("curl https://api.example.com/v1?url=https://x?access_token=nestedsecretvalue", "nestedsecretvalue"),
    ("docker login -u bob --password-stdin <<< hunter2 && echo password: plainsecret99", "plainsecret99"),
])
def test_secrets_never_reach_the_receipt(project, secret_command, secret):
    assert secret not in safe_command(secret_command)
    s = _session(project)
    t = Turn(s, project)
    t.call("c1", "shell_exec", "ok", command=secret_command)
    t.call("c2", "fetch_url", "page", url=f"https://user:{secret}@example.com/path?token={secret}")
    t.finish()
    assert secret not in _everything(build_receipt(s))


HOSTILE_SHAPES = {
    "dotted": lambda n: "a." * (n // 2),
    "dash keywords": lambda n: "--token" * (n // 7),
    "keyword soup": lambda n: "token=" * (n // 6),
    "spaces": lambda n: " " * n,
    "ambiguous rm flags": lambda n: "rm " + "--aaa " * (n // 6) + "x",
    "alternating git": lambda n: "-x git " * (n // 7),
    "mysql words": lambda n: "mysql " * (n // 6),
    "jwt prefixes": lambda n: "eyJ" * (n // 3),
}


@pytest.mark.parametrize("shape", sorted(HOSTILE_SHAPES))
def test_hostile_commands_cannot_stall_receipt_analysis(shape):
    import time
    command = HOSTILE_SHAPES[shape](300_000)
    start = time.perf_counter()
    safe_command(command)
    redact(command[:16_000])
    is_destructive_command(command)
    is_check_command(command)
    assert time.perf_counter() - start < 3.0


def test_padded_or_argument_stuffed_commands_are_flagged_and_stay_fast(project):
    import time
    s = _session(project)
    t = Turn(s, project)
    t.call("c1", "shell_exec", "ok", command="echo " + "x " * 15_000 + "&& cat .env")
    t.call("c2", "shell_exec", "ok", command="cp " + " ".join(f"f{i}" for i in range(3_000)) + " dest")
    t.finish()
    start = time.perf_counter()
    receipt = build_receipt(s)
    assert time.perf_counter() - start < 10.0
    long_findings = [f for f in receipt["needs_attention"] if f["kind"] == "long_command"]
    assert len(long_findings) == 2


def test_redaction_keeps_ordinary_commands_readable():
    commit = "git show 3f2a9c1b4e5d6f708192a3b4c5d6e7f8091a2b3c"
    assert redact(commit) == commit
    assert redact('git commit --author="Jane Doe <jane@example.com>" -m "fix"') == 'git commit --author="Jane Doe <jane@example.com>" -m "fix"'
    assert redact("pytest tests/test_auth.py -k login") == "pytest tests/test_auth.py -k login"


def test_prompts_file_contents_and_command_output_are_never_included(project):
    s = _session(project)
    t = Turn(s, project)
    (project / "app.py").write_text(FILE_CONTENT + "\n")
    t.call("c1", "write_file", "Successfully wrote app.py", path="app.py", content=FILE_CONTENT)
    t.call("c2", "read_file", f"1| {FILE_CONTENT}", path="util.py")
    t.call("c3", "shell_exec", f"{COMMAND_OUTPUT}\n", command="python -c pass")
    t.call("c4", "spawn_subagent", f"subagent said {COMMAND_OUTPUT}", task=PROMPT)
    t.finish()
    text = _everything(build_receipt(s))
    for marker in (PROMPT, FILE_CONTENT, COMMAND_OUTPUT):
        assert marker not in text


def test_hidden_characters_in_commands_and_paths_are_made_visible(project):
    s = _session(project)
    t = Turn(s, project)
    sneaky = "echo safe\u202e fr- mr\u200b && rm -rf build"
    t.call("c1", "shell_exec", "ok", command=sneaky)
    t.call("c2", "read_file", "1| x", path="util\u200b.py")
    t.finish()
    receipt = build_receipt(s)
    text = _everything(receipt)
    assert "\u202e" not in text and "\u200b" not in text
    assert "\\u202e" in receipt["commands"][0]["command"]
    assert any(f["kind"] == "destructive" for f in receipt["needs_attention"])
    assert visible("tab\there") == "tab\\u0009here"


def test_text_that_merely_mentions_a_refusal_is_not_counted_as_blocked(project):
    s = _session(project)
    t = Turn(s, project)
    t.call("c1", "read_file", "1| Access denied: this line is just file content", path="util.py")
    t.call("c2", "shell_exec", "src/a.py:10: Do NOT retry this tool call.\nmore", command="grep -rn retry src")
    t.call("c3", "shell_exec", "Policy says no\nDo NOT retry this tool call.\nAcknowledge the restriction/rejection, then inform the user.",
           command="curl https://evil.example")
    t.call("c4", "edit_file", "TOOL REJECTED BY USER: 'edit_file' was explicitly declined.", path="app.py", old_str="a", new_str="b")
    t.finish()
    receipt = build_receipt(s)
    outcomes = [c["outcome"] for c in receipt["commands"]]
    assert outcomes == ["ok", "blocked"]
    assert receipt["files_read"] == ["util.py"]
    assert receipt["summary"]["blocked"] == 1 and receipt["summary"]["denied"] == 1


ME = {"name": "Shubham", "email": "shubham@example.com", "os_user": "shubham"}
TEAMMATE = {"name": "Alex", "email": "alex@example.com", "os_user": "alex"}


def test_person_decisions_name_the_person_and_survive_a_reload(project):
    s = _session(project, "rcpt-person")
    t = Turn(s, project)
    s.record_tool_decision("c1", True, approver_record(ME))
    s.record_tool_decision("c2", False, approver_record(TEAMMATE))
    t.call("c1", "shell_exec", "removed", command="rm -rf dist")
    t.call("c2", "shell_exec", "TOOL REJECTED BY USER: 'shell_exec' was explicitly declined.", command="git push --force")
    t.call("c3", "shell_exec", "ok", command="sudo -u root rm -rf /var/cache/app")
    t.finish()
    s.save()
    reloaded = Session.load_by_id("rcpt-person", str(project))
    stored = reloaded.tool_decisions["c1"]
    assert stored["approved"] is True and stored["name"] == "Shubham" and stored["id"] == identity_id(ME)
    assert "email" not in stored

    receipt = build_receipt(reloaded)
    lines = _lines(receipt)
    assert "Destructive command, approved: rm -rf dist" in lines
    assert "Destructive command, declined: git push --force" in lines
    assert "Destructive command, ran without asking: sudo -u root rm -rf /var/cache/app" in lines
    approvers = {f["subject"]: f.get("approver") for f in receipt["needs_attention"]}
    assert approvers["rm -rf dist"] == identity_id(ME) and approvers["git push --force"] == identity_id(TEAMMATE)
    assert not any("Shubham" in f["detail"] or "Alex" in f["detail"] for f in receipt["needs_attention"])
    assert receipt["summary"]["approved_by_person"] == 1 and receipt["summary"]["denied_by_person"] == 1
    assert receipt["approvers"] == [{"id": identity_id(ME), "name": "Shubham"},
                                    {"id": identity_id(TEAMMATE), "name": "Alex"}]
    assert "example.com" not in json.dumps(receipt)

    mine = render_text(receipt, ME)
    assert '! Destructive command, approved by "Shubham" (you): rm -rf dist' in mine
    assert '! Destructive command, declined by "Alex": git push --force' in mine
    assert '[ok, approved by "Shubham" (you)] rm -rf dist' in mine
    assert '[declined by "Alex"] git push --force' in mine
    assert 'Approvals by "Shubham" (you), "Alex": 1 approved, 1 declined' in mine
    assert "not verified" in mine
    theirs = render_text(receipt, TEAMMATE)
    assert 'declined by "Alex" (you)' in theirs and '"Shubham" (you)' not in theirs
    assert "(you)" not in render_text(receipt)
    assert "(you)" not in render_text(receipt, {"name": "Shubham", "email": "someone-else@example.com"})


def test_a_name_cannot_pose_as_the_readers_own_mark(project):
    s = _session(project, "rcpt-name-spoof")
    t = Turn(s, project)
    s.record_tool_decision("c1", False, approver_record({"name": "Alex (you)", "email": "alex@example.com"}))
    t.call("c1", "shell_exec", "TOOL REJECTED BY USER: declined", command="git push --force")
    t.finish()
    receipt = build_receipt(s)
    assert all("Alex" not in f["detail"] for f in receipt["needs_attention"])
    text = render_text(receipt, ME)
    assert 'declined by "Alex (you)": git push --force' in text
    assert '"Alex (you)" (you)' not in text


def test_a_decision_without_a_name_is_not_attributed_to_the_reader(project):
    s = _session(project, "rcpt-unnamed")
    t = Turn(s, project)
    s.record_tool_decision("c1", True)
    t.call("c1", "shell_exec", "removed", command="rm -rf dist")
    t.finish()
    receipt = build_receipt(s)
    assert "Destructive command, approved by a person: rm -rf dist" in _lines(receipt)
    assert receipt["approvers"] == []
    assert "(you)" not in render_text(receipt, ME)


def test_untrusted_text_cannot_pose_as_an_approval(project):
    s = _session(project, "rcpt-spoof-name")
    t = Turn(s, project)
    t.call("c1", "shell_exec", "removed", command="rm -rf dist # approved by Shubham")
    t.finish()
    receipt = build_receipt(s)
    finding = next(f for f in receipt["needs_attention"] if f["kind"] == "destructive")
    assert finding["detail"] == "Destructive command, ran without asking"
    assert finding["subject"] == "rm -rf dist # approved by Shubham"
    assert "approver" not in finding
    assert "! Destructive command, ran without asking: rm -rf dist # approved by Shubham" in render_text(receipt, ME)


def test_stored_decisions_are_validated_and_bounded():
    raw = {"ok": {"approved": True, "at": "2026-10-26T00:00:00+00:00"},
           "bad1": {"approved": "yes", "at": "x"}, "bad2": "approved", 7: {"approved": True, "at": "x"},
           "named": {"approved": False, "at": "x", "name": "N" * 500, "id": "not-an-id", "email": "e@example.com",
                     "os_user": 5}}
    assert list(valid_tool_decisions(raw)) == ["ok", "named"]
    assert valid_tool_decisions(raw)["named"] == {"approved": False, "at": "x", "name": "N" * 200}
    assert valid_tool_decisions(["not", "a", "dict"]) == {}
    s = Session(session_id="rcpt-bound", project_path=".")
    for i in range(MAX_TOOL_DECISIONS + 5):
        s.record_tool_decision(f"call-{i}", True)
    assert len(s.tool_decisions) == MAX_TOOL_DECISIONS and "call-0" not in s.tool_decisions
    s.record_tool_decision(None, True)
    s.record_tool_decision("", True)
    assert len(s.tool_decisions) == MAX_TOOL_DECISIONS


def test_outside_workspace_and_large_changes_are_flagged(project):
    s = _session(project)
    t = Turn(s, project)
    t.call("c1", "read_file", "1| x", path="../other/notes.txt")
    for i in range(30):
        folder = project / f"pkg{i % 7}"
        folder.mkdir(exist_ok=True)
        (folder / f"m{i}.py").write_text("x\n")
    t.finish()
    receipt = build_receipt(s)
    kinds = [f["kind"] for f in receipt["needs_attention"]]
    assert "outside_workspace" in kinds and "large_change" in kinds


def test_same_turn_gives_the_same_receipt_and_hash_on_every_run(project):
    s = _session(project)
    t = Turn(s, project)
    (project / "app.py").write_text("changed\n")
    t.call("c1", "edit_file", "ok", path="app.py", old_str="a", new_str="b")
    t.call("c2", "shell_exec", "ok", command="cat .env FOO=.env.local id_rsa")
    t.finish(started_at="2026-10-26T10:00:00+00:00", ended_at="2026-10-26T10:05:00+00:00",
             cost_start=0.5, cost_end=0.92, tokens_start=100, tokens_end=1100, mode="trust")
    first, second = build_receipt(s), build_receipt(s)
    assert first == second
    assert first["record_hash"] == record_hash(first)
    assert first["cost_usd"] == pytest.approx(0.42) and first["tokens"] == 1000
    assert first["duration_seconds"] == 300 and first["mode"] == "trust"
    first["files_changed"][0]["path"] = "tampered.py"
    assert record_hash(first) != first["record_hash"]


def test_receipt_hash_does_not_depend_on_python_hash_seed(tmp_path):
    script = (
        "import json,sys;from andromity.core.receipt import build_receipt\n"
        "class S: pass\n"
        "s=S();s.id='seed';s.project_path=sys.argv[1];s.provider='p';s.model='m';s.tool_decisions={}\n"
        "s.messages=[{'role':'user','content':'x','ts':'2026-10-26T10:00:00+00:00'},"
        "{'role':'assistant','tool_calls':[{'id':'c','function':{'name':'shell_exec','arguments':json.dumps({'command':'cp secret.key=token.json credentials.txt=password.yml secrets.env=tokens.cfg'})}}]},"
        "{'role':'tool','tool_call_id':'c','content':'ok'}]\n"
        "s.undo_stack=[{'snapshot_hash':'a'*40,'after_hash':'b'*40,'msg_count':0,'turn_index':0}]\n"
        "print(build_receipt(s)['record_hash'])\n"
    )
    hashes = set()
    for seed in ("1", "2", "3"):
        env = {**os.environ, "PYTHONHASHSEED": seed}
        out = subprocess.run([sys.executable, "-c", script, str(tmp_path)], env=env, capture_output=True, text=True, check=True)
        hashes.add(out.stdout.strip())
    assert len(hashes) == 1


def test_compacted_turn_still_reports_file_changes(project):
    s = _session(project)
    t = Turn(s, project)
    (project / "app.py").write_text("changed\n")
    t.call("c1", "edit_file", "ok", path="app.py", old_str="a", new_str="b")
    record = t.finish()
    record["msg_count"] = 1
    receipt = build_receipt(s)
    assert [e["path"] for e in receipt["files_changed"]] == ["app.py"]
    assert receipt["commands"] == [] and any("compacted" in n for n in receipt["notes"])


def test_unfinished_missing_and_latest_turns(project):
    s = _session(project)
    with pytest.raises(ReceiptUnavailable):
        build_receipt(s)
    first = Turn(s, project)
    first.finish(turn_index=0)
    second = Turn(s, project)
    s.undo_stack.append({"snapshot_hash": second.before, "msg_count": second.msg_count, "turn_index": 1})
    assert build_receipt(s)["turn_index"] == 0
    with pytest.raises(ReceiptUnavailable, match="not finished"):
        build_receipt(s, 1)
    with pytest.raises(ReceiptUnavailable, match="no file checkpoint"):
        build_receipt(s, 5)


def test_building_a_receipt_never_runs_repository_configured_programs(project, tmp_path):
    marker = tmp_path / "PWNED"
    script = tmp_path / "evil.py"
    script.write_text(f"import sys\nopen({str(marker)!r}, 'w').write('x')\nprint(open(sys.argv[1]).read() if len(sys.argv) > 1 else '')\n")
    command = f'"{Path(sys.executable).as_posix()}" "{script.as_posix()}"'
    _git(project, "config", "diff.evil.textconv", command)
    _git(project, "config", "diff.evil.command", command)
    _git(project, "config", "core.fsmonitor", command)
    (project / ".git" / "info").mkdir(exist_ok=True)
    (project / ".git" / "info" / "attributes").write_text("* diff=evil\n")

    s = _session(project)
    t = Turn(s, project)
    (project / "app.py").write_text("changed\n")
    record = t.finish()
    if marker.exists():
        marker.unlink()

    subprocess.run(["git", "-c", "core.fsmonitor=false", "diff", record["snapshot_hash"], record["after_hash"]],
                   cwd=project, capture_output=True)
    assert marker.exists(), "the trap should fire for a plain git diff, otherwise this test proves nothing"
    marker.unlink()

    receipt = build_receipt(s)
    assert [e["path"] for e in receipt["files_changed"]] == ["app.py"]
    assert not marker.exists()


@pytest.mark.parametrize("command, expected", [
    ("pytest", True), ("python -m pytest -q", True), ("py -m unittest", True), ("npm test", True),
    ("npm run test:unit", True), ("pnpm lint", True), ("npx vitest run", True), ("cd web && npm run build", True),
    ("CI=1 pytest tests", True), ("go test ./...", True), ("cargo clippy", True), ("./gradlew check", True),
    ("echo pytest", False), ("git commit -m 'run pytest'", False), ("npm install", False), ("python app.py", False),
])
def test_check_commands_are_recognised(command, expected):
    assert is_check_command(command) is expected


@pytest.mark.parametrize("command, expected", [
    ("rm -rf build", True), ("rm -r old", True), ("sudo -u root rm -rf /", True), ("sudo -E rm -rf /tmp/x", True),
    ("find . -name '*.o' | xargs rm -f", True), ("Remove-Item -Recurse -Force dist", True), ("git push --force", True),
    ("git push -f origin main", True), ("git reset --hard HEAD~3", True), ("sqlite3 app.db 'DROP TABLE users'", True),
    ("terraform destroy", True), ("kubectl delete ns prod", True), ("rmdir /s /q build", True),
    ("echo rm -rf /", False), ("git push origin main", False), ("rm notes.txt", False), ("grep -rn 'git reset --hard' docs", False),
    ("npm run build", False), ("git status", False),
])
def test_destructive_commands_are_recognised(command, expected):
    assert is_destructive_command(command) is expected


async def test_rpc_receipt_refuses_bad_input_and_never_creates_sessions(project, tmp_path, monkeypatch):
    from andromity.server.rpc_handler import JsonRpcHandler
    handler = JsonRpcHandler()

    missing = await handler.rpc_session_receipt({"session_id": "does-not-exist"})
    assert missing["success"] is False and Session.load_by_id("does-not-exist") is None
    assert (await handler.rpc_session_receipt({}))["success"] is False
    for bad in ("2", -1, True, 1.5):
        result = await handler.rpc_session_receipt({"session_id": "x", "turn_index": bad})
        assert result["success"] is False and "turn" in result["error"].lower()

    s = _session(project, "rcpt-rpc")
    t = Turn(s, project)
    (project / "app.py").write_text("changed\n")
    t.call("c1", "edit_file", "ok", path="app.py", old_str="a", new_str="b")
    t.finish()
    s.save()
    ok = await handler.rpc_session_receipt({"session_id": "rcpt-rpc", "project_path": str(project)})
    assert ok["success"] is True and ok["receipt"]["files_changed"][0]["path"] == "app.py"
    assert ok["text"].startswith("Andromity receipt - turn 1")

    monkeypatch.setattr(config, "is_trusted", lambda *a, **k: False)
    untrusted = await handler.rpc_session_receipt({"session_id": "rcpt-rpc", "project_path": str(project)})
    assert untrusted["success"] is False and "Trust" in untrusted["error"]


async def test_only_a_person_answer_is_marked_as_a_person_decision():
    from andromity.server.rpc_handler import JsonRpcHandler
    handler = JsonRpcHandler()
    loop = asyncio.get_running_loop()

    answered = loop.create_future()
    handler._pending_approvals["a1"] = ("sess", answered, "shell_exec", {"command": "ls"})
    await handler.rpc_agent_approve_tool({"approval_id": "a1", "approved": False})
    assert answered.result() == {"approved": False, "by": "person"}

    cancelled = loop.create_future()
    handler._pending_approvals["a2"] = ("sess", cancelled, "shell_exec", {"command": "ls"})
    await handler.rpc_agent_cancel({"session_id": "sess"})
    assert cancelled.result() is False

    for malformed in ("false", "true", 1, None):
        pending = loop.create_future()
        handler._pending_approvals["a3"] = ("sess", pending, "shell_exec", {"command": "ls"})
        await handler.rpc_agent_approve_tool({"approval_id": "a3", "approved": malformed})
        assert pending.result() == {"approved": False, "by": "person"}


def test_cli_prints_the_latest_receipt_and_json(project, monkeypatch):
    from click.testing import CliRunner
    from andromity.cli import main

    s = _session(project, "rcpt-cli")
    t = Turn(s, project)
    (project / "app.py").write_text("changed\n")
    t.call("c1", "edit_file", "ok", path="app.py", old_str="a", new_str="b")
    t.finish()
    s.save()
    monkeypatch.setattr("andromity.core.network_policy.activate", lambda: None)
    runner = CliRunner()
    text = runner.invoke(main, ["receipt", "--project", str(project)])
    assert text.exit_code == 0, text.output
    assert "Files changed" in text.output and "app.py" in text.output
    as_json = runner.invoke(main, ["receipt", "rcpt-cli", "--project", str(project), "--json", "--turn", "1"])
    assert as_json.exit_code == 0 and json.loads(as_json.output)["files_changed"][0]["path"] == "app.py"
    missing = runner.invoke(main, ["receipt", "--project", str(project), "--turn", "9"])
    assert missing.exit_code != 0 and "no file checkpoint" in missing.output
