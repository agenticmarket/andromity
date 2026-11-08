"""Turn receipts: a deterministic record of what one agent turn read, changed, ran and was stopped from doing.

Every fact comes from the session's tool-call log and the git snapshots taken around
the turn, never from the model's own account. Prompts, file contents and command
output are never included.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import os
import re
import shlex
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, Tuple

from andromity.core.git_ops import NO_REPO_PROGRAMS
from andromity.core.security import get_domain, is_sensitive_path
from andromity.core.session import is_compaction_summary

RECEIPT_VERSION = 1
MAX_LISTED = 200
MAX_COMMAND_CHARS = 2000
BRIEF_COMMAND_CHARS = 300
LEGACY_COMMAND_CHARS = 300
MAX_REDACTED_CHARS = 4096
MAX_SCANNED_CHARS = 20000
MAX_PREFIX_TOKENS = 32
MAX_ARGUMENT_TOKENS = 512
MAX_SCANNED_ARGUMENTS = 256
MAX_SENSITIVE_CHECKS = 2000
LARGE_CHANGE_FILES = 25
LARGE_CHANGE_FOLDERS = 5
TEXT_FILE_LINES = 15
TEXT_COMMAND_LINES = 12

EDIT_TOOLS = frozenset({"write_file", "edit_file", "edit_file_multi"})
READ_TOOLS = frozenset({"read_file", "view_file"})
SEARCH_TOOLS = frozenset({"grep_search", "find_files", "list_dir"})
SHELL_TOOLS = frozenset({"shell_exec", "shell_bg"})

_EXIT_LINE = re.compile(r"\[exit code (-?\d+)\]\s*$")
_REFUSAL_MARKERS = ("Access denied:", "blocked by air-gap policy", "not trusted", "untrusted")
_GATE_OUTCOMES = {"blocked": "blocked", "declined": "denied", "skipped": "skipped", "dry_run": "dry_run",
                  "timeout": "timeout", "cancelled": "cancelled"}
_OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_PERSON_ID = re.compile(r"[0-9a-f]{16}")
_TURN_KEY = re.compile(r"[0-9a-f]{32}")
_ROLE = re.compile(r"[a-z0-9_]{1,32}")
SEALED_SUMMARY = ("files_changed", "commands", "commands_failed")
SEAL_FORMAT = 2
_legacy_commands: contextvars.ContextVar[bool] = contextvars.ContextVar("receipt_legacy_commands", default=False)
# Blank or joining characters that are not in the control and format categories but still hide or disguise text.
_INVISIBLE = frozenset({0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0x034F, 0x180B, 0x180C, 0x180D, 0x180F,
                        0x0334, 0x0335, 0x0336, 0x0337, 0x0338})
_SHA256 = re.compile(r"[0-9a-f]{64}")
MAX_PERSON_CHARS = 80
_OWN_RECORDS = (".andromity", "andromity.db", "andromity-snapshots")
_SENSITIVE_BASENAMES = frozenset({
    "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "authorized_keys", "known_hosts",
})
_FILE_EXTENSION = re.compile(r"[a-z0-9]{1,8}")
MAX_WATCHED_FILES = 100
WATCHED_READ_BYTES = 1_000_000
WATCHED_MAX_DIRS = 2000
WATCHED_MAX_DEPTH = 8
_WATCHED_NAMES = frozenset({".env", ".npmrc", ".pypirc", ".netrc", ".dockercfg", "id_rsa", "id_ed25519", "id_ecdsa",
                            "id_dsa", "credentials"})
_WATCHED_PREFIXES = (".env.", "credentials.", "secrets.")
_WATCHED_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
_WATCHED_PARENTS = frozenset({".aws", ".ssh"})
_WATCHED_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache",
                                ".pytest_cache", ".ruff_cache", ".gradle", ".next", "target"})
QUIET_TOOLS = frozenset({
    "write_plan", "update_plan_step", "ask_questions", "ask_question", "list_tools", "suggest_next_step",
    "shell_read", "shell_list", "read_handoff",
})
_RUNS_CODE_NAMES = frozenset({
    "conftest.py", ".pre-commit-config.yaml", ".gitlab-ci.yml", "jenkinsfile", "azure-pipelines.yml",
    "bitbucket-pipelines.yml", ".envrc", ".mcp.json", ".gitmodules", ".gitattributes",
})
_RUNS_CODE_DIRS = (
    ".github/workflows/", ".circleci/", ".claude/", ".cursor/", ".devcontainer/", ".vscode/", ".husky/",
    ".andromity/", ".git/",
)
_SAFE_GIT = ("git", *NO_REPO_PROGRAMS, "-c", "diff.external=", "-c", "core.quotePath=false")

_SECRET_PATTERNS: Tuple[Tuple[re.Pattern, str], ...] = (
    (re.compile(r"-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)", re.S), "[redacted private key]"),
    (re.compile(r"(?i)\b([a-z][a-z0-9+.\-]{0,30}://[^/\s:@]{1,256}:)[^/\s@]{1,512}@"), r"\1***@"),
    (re.compile(r"(?i)(authorization[ \t]{0,8}[:=][ \t]{0,8})((?:bearer|basic|token)[ \t]{1,8})?[^\s'\"]+"), r"\1\2***"),
    (re.compile(
        r"(?i)(--?(?:token|password|passwd|pass|pw|passphrase|secret|secret-?key|key|api-?key|api-?token|access-?key"
        r"|access-?token|auth|auth-?token|client-?secret|private-?key|pat)\b)"
        r"([ \t]{1,8}|=)(?:\"[^\"\n]{0,512}\"?|'[^'\n]{0,512}'?|(?!-)[^\s'\"]+)"
    ), r"\1\2***"),
    (re.compile(r"(?i)((?:^|\s)(?:-u|--user)(?:[ \t]{1,8}|=)([\"'])[^:\"'\n]{1,128}:)[^\"'\n]{1,512}"), r"\1***"),
    (re.compile(r"(?i)((?:^|\s)(?:-u|--user)(?:[ \t]{1,8}|=)[^:\s'\"]{1,128}:)(?:\"[^\"\n]{0,512}\"?|'[^'\n]{0,512}'?|[^\s'\"]+)"),
     r"\1***"),
    (re.compile(r"(?i)(\bsshpass[ \t]{1,8}-p[ \t]{0,8})(['\"]?)[^\s'\"]+"), r"\1\2***"),
    (re.compile(r"(?i)(\blogin\b[^\n|;&]{0,200}?\s-p[ \t]{1,8})(['\"]?)[^\s'\"]+"), r"\1\2***"),
    (re.compile(r"(?i)(\b(?:mysql|mysqldump|mariadb)\b[^\n]{0,200}?\s-p)(?!\s)\S+"), r"\1***"),
    (re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_\-]{16,}"), "***"),
    (re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}"), "***"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "***"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), "***"),
    (re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}"), "***"),
    (re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}"), "***"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "***"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{35}"), "***"),
    (re.compile(r"\b(?:hf|npm)_[A-Za-z0-9]{30,}"), "***"),
    (re.compile(r"\bpypi-[A-Za-z0-9_\-]{50,}"), "***"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "***"),
)
_HIGH_ENTROPY = re.compile(r"[A-Za-z0-9+/_=\-]{32,}")
_KEY_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")
_VALUE_STOP = frozenset(" \t\r\n'\"&")
_SECRET_KEY = re.compile(
    r"token|secret|passw(?:or)?d|pwd|api[_\-]?key|apikey|access[_\-]?key|private[_\-]?key"
    r"|client[_\-]?secret|auth(?!or)|credential|session[_\-]?id|cookie", re.I)

_DESTRUCTIVE_SEGMENT = tuple(re.compile(p, re.I) for p in (
    r"^rm\s+(?:--?[a-z][a-z\-]*\s+)*--?[a-z]*[rf]",
    r"^(?:rmdir|rd)\s+(?:/[a-z]\s+)*/s\b",
    r"^find\b.*\s-delete\b",
    r"^find\b.*\s-exec(?:dir)?\s+rm\b",
    r"^git\s+push\b.*\s\+\S",
    r"^(?:del|erase)\s+(?:/[a-z]\s+)*/s\b",
    r"^(?:remove-item|ri)\b.*-recurse",
    r"^git\s+reset\s+--hard\b",
    r"^git\s+clean\s+-[a-z]*f",
    r"^git\s+push\b.*(?:--force\b|--force-with-lease\b|\s-f\b)",
    r"^git\s+checkout\s+--\s+\.",
    r"^git\s+branch\s+-D\b",
    r"^git\s+stash\s+(?:drop|clear)\b",
    r"^terraform\s+destroy\b",
    r"^terraform\s+apply\b.*-auto-approve",
    r"^kubectl\s+delete\b",
    r"^helm\s+(?:uninstall|delete)\b",
    r"^docker\s+(?:rm|rmi|system\s+prune|volume\s+(?:rm|prune))\b",
    r"^mkfs(?:\.\w+)?\b",
    r"^dd\b.*\bof=",
    r"^format\s+[a-z]:",
    r"^chmod\s+-R\s+0?777\b",
    r"^(?:npm|pnpm|yarn)\s+unpublish\b",
    r"^gh\s+repo\s+delete\b",
))
_DESTRUCTIVE_ANYWHERE = tuple(re.compile(p, re.I) for p in (
    r"\bdrop\s+(?:table|database|schema)\b",
    r"\btruncate\s+table\b",
    r"\bshutil\.rmtree\s*\(",
    r"\brimraf\b",
    r"\bfs\.rm(?:sync)?\s*\(",
))
_WRAPPERS = frozenset({"sudo", "env", "xargs", "nohup", "time", "command", "exec", "doas", "&", "nice", "ionice",
                       "timeout", "stdbuf", "if", "then", "do", "else", "elif", "while", "until", "!"})
_DURATION = re.compile(r"\d+(?:\.\d+)?[smhd]?")
# Programs that run a command given to them as a string: the string is checked as a command of its own.
_INLINE_RUNNERS = {"cmd": ("/c", "/k"), "bash": ("-c",), "sh": ("-c",), "zsh": ("-c",), "dash": ("-c",),
                   "powershell": ("-c", "-command"), "pwsh": ("-c", "-command")}
_EVALUATORS = frozenset({"iex", "invoke-expression"})
MAX_NESTED_COMMANDS = 3
MAX_TOKENIZED_CHARS = 8192
_DESTRUCTIVE_PROGRAMS = frozenset({
    "rm", "rmdir", "rd", "del", "erase", "remove-item", "ri", "git", "terraform", "kubectl", "helm", "docker", "find",
    "mkfs", "dd", "format", "chmod", "npm", "pnpm", "yarn", "gh",
}) | frozenset({f"mkfs.{fs}" for fs in ("ext2", "ext3", "ext4", "xfs", "btrfs", "vfat", "fat", "ntfs")})
_PIPELINE_SPLIT = re.compile(r"&&|\|\||;|\||&|\r\n?|\n")
# A second reading that also opens subshells, groups and substitutions, so "(rm -rf x)" or "$(rm -rf x)" is seen.
_SUBSHELL_SPLIT = re.compile(r"&&|\|\||;|\||&|\$\(|[()`{}]|\r\n?|\n")

_CHECK_PROGRAMS = frozenset({
    "pytest", "py.test", "tox", "nox", "vitest", "jest", "mocha", "tsc", "eslint", "ruff", "mypy",
    "pyright", "flake8", "pylint", "rspec", "phpunit", "ctest", "golangci-lint", "biome",
})
_CHECK_PY_MODULES = frozenset({"pytest", "unittest", "mypy", "ruff", "pyright", "flake8", "pylint", "tox"})
_CHECK_SUBCOMMANDS = {
    "go": {"test", "vet", "build"},
    "cargo": {"test", "check", "clippy", "build"},
    "mvn": {"test", "verify"},
    "mvnw": {"test", "verify"},
    "gradle": {"test", "check", "build"},
    "gradlew": {"test", "check", "build"},
    "dotnet": {"test", "build"},
    "make": {"test", "check", "lint"},
}
_CHECK_SCRIPT = re.compile(r"^(?:test|lint|check|typecheck|type-check|verify|build)(?::[\w\-]+)?$", re.I)
_SEGMENT_SPLIT = re.compile(r"&&|\|\||;|\r\n?|\n")


class ReceiptUnavailable(Exception):
    """A receipt cannot be produced; the message is safe to show to a person."""


def open_turn_record(session: Any) -> Dict[str, Any]:
    """Fields stored on a turn's checkpoint when it starts."""
    record = {
        "gates": True,
        "mode": str(getattr(session, "permission_mode", "") or ""),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "cost_start": float(getattr(session, "cost_usd", 0.0) or 0.0),
        "tokens_start": int(getattr(session, "token_total", 0) or 0),
    }
    project = str(getattr(session, "project_path", "") or "")
    fingerprint = git_internals_fingerprint(project)
    if fingerprint:
        record["git_start"] = fingerprint
    record["watched_start"] = watched_files(project)
    return record


def close_turn_record(session: Any) -> Dict[str, Any]:
    """Fields stored on a turn's checkpoint when it ends."""
    record = {
        "ended_at": datetime.now(timezone.utc).isoformat(),
        "cost_end": float(getattr(session, "cost_usd", 0.0) or 0.0),
        "tokens_end": int(getattr(session, "token_total", 0) or 0),
        "msg_end": len(getattr(session, "messages", None) or []),
    }
    if hasattr(session, "turn_key"):
        session.turn_key = None
    project = str(getattr(session, "project_path", "") or "")
    fingerprint = git_internals_fingerprint(project)
    if fingerprint:
        record["git_end"] = fingerprint
    record["watched_end"] = watched_files(project)
    return record


def next_turn_index(session: Any) -> int:
    """The new turn's number: never reused, even after compaction rewrites the messages."""
    numbers = [record["turn_index"] for record in (getattr(session, "undo_stack", None) or [])
               if isinstance(record, dict) and isinstance(record.get("turn_index"), int)
               and not isinstance(record["turn_index"], bool)]
    return max(len(session.get_user_turn_indices()), max(numbers, default=-1) + 1)


def start_turn_record(session: Any, snapshot_hash: str) -> Dict[str, Any]:
    """Begin a turn's record in the session so the turn gets a receipt. Every message added until
    close_turn_record carries the record's key, so the receipt finds them however the history is rewritten."""
    key = uuid.uuid4().hex
    record = {"snapshot_hash": snapshot_hash, "msg_count": len(getattr(session, "messages", None) or []),
              "turn_index": next_turn_index(session), "turn_key": key, "anchored": True,
              **open_turn_record(session)}
    if not isinstance(getattr(session, "undo_stack", None), list):
        session.undo_stack = []
    session.undo_stack.append(record)
    session.turn_key = key
    return record


def turn_started(session: Any, record: Dict[str, Any]) -> bool:
    """Whether the turn's prompt reached the session, so the turn really ran."""
    key = record.get("turn_key")
    if isinstance(key, str) and _TURN_KEY.fullmatch(key):
        return any(isinstance(m, dict) and m.get("turn_key") == key and m.get("role") == "user"
                   for m in getattr(session, "messages", None) or [])
    return len(session.get_user_turn_indices()) > record["turn_index"]


def seal_receipt(session: Any, record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Build a finished turn's receipt and keep its checksum on the turn record; None when it has no receipt."""
    try:
        receipt = build_receipt(session, record["turn_index"])
    except ReceiptUnavailable:
        return None
    findings = receipt["needs_attention"]
    record["receipt_hash"] = receipt["record_hash"]
    record["receipt_format"] = SEAL_FORMAT
    record["attention"] = len(findings)
    record["attention_high"] = sum(1 for finding in findings if finding["severity"] == "high")
    for key in SEALED_SUMMARY:
        record[key] = receipt["summary"][key]
    return receipt


def _count(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def sealed_counts(record: Dict[str, Any]) -> Dict[str, Optional[int]]:
    """What a turn's receipt said when it was sealed, for clients to show before anyone opens it. None when the
    turn was sealed before a count was kept, or not at all."""
    attention, high = _count(record.get("attention")), _count(record.get("attention_high"))
    counts: Dict[str, Optional[int]] = {"attention": attention if high is not None else None,
                                        "high": high if attention is not None else None}
    counts.update({key: _count(record.get(key)) for key in SEALED_SUMMARY})
    return counts


def receipt_turns(session: Any) -> List[Dict[str, Any]]:
    """Finished turns that have a receipt, with what each receipt said when it was sealed (None if unknown)."""
    turns: Dict[int, Dict[str, Any]] = {}
    for record in getattr(session, "undo_stack", None) or []:
        if not (isinstance(record, dict) and isinstance(record.get("turn_index"), int)
                and not isinstance(record["turn_index"], bool) and record["turn_index"] >= 0
                and isinstance(record.get("after_hash"), str) and record["after_hash"]):
            continue
        key = record.get("turn_key")
        turns[record["turn_index"]] = {"turn_index": record["turn_index"],
                                       "turn_key": key if isinstance(key, str) and _TURN_KEY.fullmatch(key) else None,
                                       **sealed_counts(record)}
    return [turns[index] for index in sorted(turns)]


def redact(text: str) -> str:
    """Remove credentials and tokens from a command line or URL."""
    out = text
    for pattern, replacement in _SECRET_PATTERNS:
        out = pattern.sub(replacement, out)
    out = _mask_key_values(out)
    return _HIGH_ENTROPY.sub(_mask_if_random, out)


def visible(text: str) -> str:
    """Show control, invisible and direction-changing characters as escapes so nothing can hide."""
    parts = []
    for ch in text:
        if ch in (" ",):
            parts.append(ch)
        elif (unicodedata.category(ch) in ("Cc", "Cf", "Co", "Cs", "Zl", "Zp", "Zs") or ord(ch) in _INVISIBLE
              or 0xFE00 <= ord(ch) <= 0xFE0F or 0xE0100 <= ord(ch) <= 0xE01EF):
            parts.append(f"\\u{ord(ch):04x}" if ord(ch) <= 0xFFFF else f"\\U{ord(ch):08x}")
        else:
            parts.append(ch)
    return "".join(parts)


def _command_chars() -> int:
    return LEGACY_COMMAND_CHARS if _legacy_commands.get() else MAX_COMMAND_CHARS


_PARTIAL_ESCAPE = re.compile(r"\\(?:u[0-9a-fA-F]{0,3}|U[0-9a-fA-F]{0,7})?$")
_ESCAPE = re.compile(r"\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}")
_TRAILING_WORD = re.compile(r"\S{1,256}$")


def _redacted_window(raw: str) -> str:
    """The command's first MAX_REDACTED_CHARS characters with secrets masked. When the command is longer, its last
    word there may be a secret cut in half, which masking can't recognise, so up to 256 characters of it are dropped:
    longer than any secret, short enough never to drop a whole long command."""
    redacted = redact(raw[:MAX_REDACTED_CHARS])
    return _TRAILING_WORD.sub("", redacted) if len(raw) > MAX_REDACTED_CHARS else redacted


def _shown_command(command: str) -> Tuple[str, bool]:
    """The command as a receipt shows it, and whether it was cut. Secrets are masked over a window twice the
    shown length, so a secret is never cut in half before masking and then shown."""
    raw = str(command)
    shown = visible(redact(raw[:MAX_REDACTED_CHARS]))
    if _legacy_commands.get():
        cut = len(shown) > LEGACY_COMMAND_CHARS
        return (shown[:LEGACY_COMMAND_CHARS] + "..." if cut else shown), cut
    shown = visible(_redacted_window(raw))
    if len(shown) <= MAX_COMMAND_CHARS and len(raw) <= MAX_REDACTED_CHARS:
        return shown, False
    return _PARTIAL_ESCAPE.sub("", shown[:MAX_COMMAND_CHARS - 3]) + "...", True


def safe_command(command: str) -> str:
    return _shown_command(command)[0]


def _brief(text: str) -> str:
    """A command or path shortened for the text and Markdown receipts, which must stay small enough for a pull
    request. The middle goes, so a path keeps its file name and a command keeps its destructive part."""
    if len(text) <= BRIEF_COMMAND_CHARS:
        return text
    head = _PARTIAL_ESCAPE.sub("", text[:BRIEF_COMMAND_CHARS // 2])
    start = len(text) - (BRIEF_COMMAND_CHARS - BRIEF_COMMAND_CHARS // 2 - 5)
    for escape in _ESCAPE.finditer(text, max(0, start - 9), start + 9):
        if escape.start() < start < escape.end():
            start = escape.end()
    return f"{head} ... {text[start:]}"


_WORD_SPLIT = re.compile(r"[\s;&|()]+")
_QUOTES = re.compile(r"['\"`]")


def _verified_part(command: str, part: str) -> Optional[str]:
    """The destructive part of a command, with each word kept only where the masked command has it right after the
    same word the part has before it, quotes aside; any other word becomes ***. The part is rebuilt from shell words,
    which drops quotes, so masking it on its own could reveal what masking the command hides, and a secret that
    also appears elsewhere in the command must still not show in its masked position."""
    scan = redact(command[:MAX_SCANNED_CHARS])
    if len(command) > MAX_SCANNED_CHARS:
        scan = _TRAILING_WORD.sub("", scan)
    tokens = [token for token in _WORD_SPLIT.split(_QUOTES.sub("", scan)) if token]
    singles = set(tokens)
    pairs = set(zip(tokens, tokens[1:]))
    words = [word for word in _WORD_SPLIT.split(_QUOTES.sub("", redact(part))) if word]
    raw_words = [word for word in _WORD_SPLIT.split(_QUOTES.sub("", part)) if word]
    aligned = len(raw_words) == len(words)
    kept: List[str] = []
    previous_hidden = False
    for index, word in enumerate(words):
        # Only masking's own *** hides what follows; a literal *** typed in the command is just text.
        masked_here = "***" in word and (not aligned or word != raw_words[index])
        if index == 0:
            known = word in singles
        else:
            # After a hidden word nothing is known: the pair would match after any masked value in the command.
            known = not previous_hidden and (words[index - 1], word) in pairs
        token = word if known else "***"
        hidden = not known or masked_here
        if token == "***" and not known and kept and kept[-1] == "***":
            previous_hidden = True
            continue
        kept.append(token)
        previous_hidden = hidden

    if not kept or kept[0] == "***":
        return None
    # Brackets are escaped so command text can't close the suffix early and add a fake one after it.
    return _brief(visible(" ".join(kept))).replace("[", "\\u005b").replace("]", "\\u005d")


def is_check_command(command: str) -> bool:
    return any(_segment_is_check(segment) for segment in _SEGMENT_SPLIT.split(command[:MAX_SCANNED_CHARS].strip())
               if segment)


def _tokens(segment: str) -> List[str]:
    """Shell words with quotes removed, so a quoted program path with spaces stays one word. Backslashes are kept
    for Windows paths; unbalanced quotes fall back to plain whitespace splitting."""
    lexer = shlex.shlex(segment[:MAX_TOKENIZED_CHARS], posix=True)
    lexer.whitespace_split = True
    lexer.escape = ""
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError:
        return segment[:MAX_TOKENIZED_CHARS].split()


def _inline_command(program: str, rest: List[str]) -> Optional[str]:
    """The command a shell runner or evaluator was handed as a string, if any."""
    if program in _EVALUATORS:
        return " ".join(rest)
    flags = _INLINE_RUNNERS.get(program)
    if flags:
        for position, token in enumerate(rest[:8]):
            if token.lower() in flags:
                return " ".join(rest[position + 1:])
    return None


def is_destructive_command(command: str) -> bool:
    return destructive_part(command) is not None


def destructive_part(command: str, depth: int = 0) -> Optional[str]:
    """The piece of a command that makes it destructive, or None. Checks the first MAX_SCANNED_CHARS characters."""
    command = command[:MAX_SCANNED_CHARS]
    for pattern in _DESTRUCTIVE_ANYWHERE:
        found = pattern.search(command)
        if found:
            return found.group(0)
    for splitter in (_PIPELINE_SPLIT, _SUBSHELL_SPLIT):
        for segment in splitter.split(command.strip()):
            part = _destructive_segment(_tokens(segment), depth)
            if part is not None:
                return part
    return None


def _destructive_segment(tokens: List[str], depth: int) -> Optional[str]:
    after_flag = False
    for index, token in enumerate(tokens[:MAX_PREFIX_TOKENS]):
        program = _program(token)
        if program in _DESTRUCTIVE_PROGRAMS:
            normalized = " ".join([program] + tokens[index + 1:index + 1 + MAX_ARGUMENT_TOKENS])
            if any(pattern.search(normalized) for pattern in _DESTRUCTIVE_SEGMENT):
                return " ".join(tokens[index:index + 1 + MAX_ARGUMENT_TOKENS])
        inner = _inline_command(program, tokens[index + 1:index + 1 + MAX_ARGUMENT_TOKENS])
        if inner is not None:
            return destructive_part(inner, depth + 1) if depth < MAX_NESTED_COMMANDS else None
        if program in _WRAPPERS or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", token) or _DURATION.fullmatch(token):
            after_flag = False
        elif token.startswith("-"):
            after_flag = True
        elif after_flag:
            after_flag = False
        else:
            return None
    return None


def build_receipt(session: Any, turn_index: Optional[int] = None, repo: Any = None) -> Dict[str, Any]:
    """Build the receipt for one finished turn of a session."""
    record = _pick_record(session, turn_index)
    _check_snapshot_hashes(record)
    sealed = record.get("receipt_hash")
    if record.get("receipt_format") != SEAL_FORMAT and isinstance(sealed, str) and _SHA256.fullmatch(sealed):
        # Sealed before commands were kept in full. When the seal still matches the older rule, show the receipt as it
        # was sealed: the seal covers only what that rule kept, so showing more would vouch for text it never covered.
        token = _legacy_commands.set(True)
        try:
            legacy = _build_receipt(session, record, repo)
        finally:
            _legacy_commands.reset(token)
        if legacy["sealed"]["matches"]:
            if any(len(entry["command"]) > LEGACY_COMMAND_CHARS for entry in [*legacy["commands"], *legacy["checks"]]):
                legacy["notes"].append("This turn was sealed before commands were kept in full, so its commands are "
                                       f"shown as they were sealed: cut to {LEGACY_COMMAND_CHARS} characters.")
                legacy["record_hash"] = record_hash(legacy)
            return legacy
    return _build_receipt(session, record, repo)


def _build_receipt(session: Any, record: Dict[str, Any], repo: Any) -> Dict[str, Any]:
    project = Path(str(getattr(session, "project_path", "") or ".")).resolve()
    messages = list(getattr(session, "messages", []) or [])
    notes: List[str] = []

    legacy = record.get("gates") is not True
    window = _turn_window(session, record, messages)
    calls, models, first_ts, last_ts = _turn_calls(window, valid_gates(session), legacy, "agent")
    turn_start = record.get("started_at") or first_ts
    turn_end = record.get("ended_at") or last_ts
    if any(call["name"] == "spawn_subagent" for call in calls):
        calls = calls + _subagent_calls(session, project, turn_start, turn_end, legacy)
    decisions = getattr(session, "tool_decisions", None)
    if not isinstance(decisions, dict):
        decisions = {}

    attention: List[Dict[str, str]] = []
    if window is None:
        attention.append(_finding("history_missing", "high", "This turn's tool log is gone (compacted or removed), so "
                                  "what it ran and read can't be checked"))
        notes.append("This turn's messages were compacted or removed, so only its file changes are shown.")
    files_read: List[str] = []
    edited: List[str] = []
    edited_by_subagents: List[str] = []
    commands: List[Dict[str, Any]] = []
    web_hosts: List[str] = []
    mcp_servers: List[str] = []
    other_tools: Dict[str, int] = {}
    searches = web_searches = subagents = blocked = denied = background = 0
    approved_by_person = denied_by_person = 0
    approvers: Dict[str, str] = {}

    for call in calls:
        name, args, outcome = call["name"], call["args"], call["outcome"]
        decision = decisions.get(call["id"]) if isinstance(call["id"], str) and call["by"] == "agent" else None
        if not (isinstance(decision, dict) and isinstance(decision.get("approved"), bool)):
            decision = None
        if decision is not None:
            if decision["approved"]:
                approved_by_person += 1
            else:
                denied_by_person += 1
            person, person_id = _person(decision)
            if person_id:
                approvers.setdefault(person_id, person)
        if outcome == "blocked":
            blocked += 1
        elif outcome == "denied":
            denied += 1

        if name in READ_TOOLS or name in EDIT_TOOLS:
            raw_path = str(args.get("path") or "")
            if not raw_path:
                continue
            shown, inside, leads_to = _display_path(raw_path, project)
            subject = f"{shown} -> {leads_to}" if leads_to else shown
            sensitive = is_sensitive_path(raw_path, str(project))
            verb = "read" if name in READ_TOOLS else "edit"
            what = "a sensitive file" if sensitive else "a file outside the workspace"
            if outcome in ("blocked", "denied"):
                if sensitive or not inside:
                    attention.append(_finding("blocked", "high", f"Tried to {verb} {what}, {_stopped_by(outcome)}", subject))
                continue
            if outcome != "ok":
                if sensitive or not inside:
                    attention.append(_finding("sensitive" if sensitive else "outside_workspace", "medium",
                                              f"Tried to {verb} {what}; it did not succeed", subject))
                continue
            if name in READ_TOOLS:
                _add_unique(files_read, shown)
            elif call["by"] == "agent":
                _add_unique(edited, shown)
            else:
                _add_unique(edited_by_subagents, shown)
            if sensitive:
                attention.append(_finding("sensitive", "high", f"{'Read' if verb == 'read' else 'Edited'} a sensitive file", subject))
            if not inside:
                attention.append(_finding("outside_workspace", "high",
                                          f"{'Read' if verb == 'read' else 'Edited'} a file outside the workspace", subject))
        elif name in SEARCH_TOOLS:
            searches += 1
        elif name in SHELL_TOOLS:
            command = str(args.get("command") or "")
            shown, shown_cut = _shown_command(command)
            check = is_check_command(command)
            commands.append({
                "command": shown,
                "outcome": outcome,
                "exit_code": call["exit_code"],
                "background": name == "shell_bg",
                "check": check,
                "by": call["by"],
                "decided_by_person": decision["approved"] if decision else None,
                "decided_by": _person(decision)[1] if decision else None,
            })
            approval, approver = _approval(outcome, decision)
            if call["by"] != "agent":
                approval += f" by {call['by']}"
            if name == "shell_bg" and outcome == "ok":
                background += 1
            part = destructive_part(command)
            if part is not None:
                if _legacy_commands.get():
                    subject = f"{shown} [destructive part: {safe_command(part)}]" if shown_cut else shown
                    attention.append(_finding("destructive", "high" if outcome == "ok" else "medium",
                                              f"Destructive command, {approval}", subject, approver))
                else:
                    # Also when the command's own text carries a suffix, so the engine's real one always comes last.
                    needs_suffix = shown_cut or "[destructive part:" in shown
                    found = _verified_part(command, part) if needs_suffix else None
                    if found is None and "[destructive part:" in shown:
                        found = "not shown"
                    subject = f"{shown} [destructive part: {found}]" if found else shown
                    attention.append(_finding("destructive", "high" if outcome == "ok" else "medium",
                                              f"Destructive command, {approval}", subject, approver))
            if _touches_own_records(command):
                attention.append(_finding("own_records", "high", f"Command touches Andromity's own records, {approval}",
                                          shown, approver))
            scanned = command[:MAX_SCANNED_CHARS]
            distinct = len(dict.fromkeys(scanned.split()))
            if len(command) > MAX_SCANNED_CHARS or distinct > MAX_SCANNED_ARGUMENTS:
                attention.append(_finding("long_command", "medium",
                                          f"Very long command ({len(command)} characters, {distinct} distinct arguments); "
                                          "only part of it was checked. Inspect it directly.", shown))
            for target in _sensitive_targets(scanned, project):
                attention.append(_finding("sensitive", "high" if outcome == "ok" else "medium",
                                          f"Command referenced a sensitive file, {approval}", target, approver))
        elif name == "fetch_url":
            host = get_domain(str(args.get("url") or ""))
            if host:
                _add_unique(web_hosts, visible(host))
        elif name == "web_search":
            web_searches += 1
        elif name == "spawn_subagent":
            subagents += 1
        elif name.startswith("mcp__"):
            parts = name.split("__")
            if len(parts) >= 3 and parts[1]:
                _add_unique(mcp_servers, visible(parts[1]))
                label = visible(f"{parts[1]}.{'__'.join(parts[2:])}")
                other_tools[label] = other_tools.get(label, 0) + 1
        elif name and name not in QUIET_TOOLS:
            label = visible(name)
            other_tools[label] = other_tools.get(label, 0) + 1

    if background:
        attention.append(_finding("background", "medium",
                                  f"Started {background} background command{'s' if background != 1 else ''}; "
                                  "anything they change after this turn appears in a later receipt."))

    files_changed, diff_ok = _changed_files(record, project, repo, edited, notes, edited_by_subagents)
    changed_keys = {_path_key(entry["path"]) for entry in files_changed}
    edited_untracked = [path for path in edited + edited_by_subagents if _path_key(path) not in changed_keys] if diff_ok else []
    others = [entry["path"] for entry in files_changed if entry["via"] == "other"]
    if others:
        listed = ", ".join(others[:3]) + (f" and {len(others) - 3} more" if len(others) > 3 else "")
        acted_indirectly = bool(commands) or subagents > 0
        who = ("by commands, subagents or someone else" if acted_indirectly
               else "by someone or something other than this agent")
        attention.append(_finding("changed_outside_edits", "medium",
                                  f"{len(others)} file{'s' if len(others) != 1 else ''} changed {who}, not by the agent's "
                                  "file edits", listed))
    for entry in files_changed[:MAX_SENSITIVE_CHECKS]:
        if runs_code(entry["path"], str(project)):
            attention.append(_finding("runs_code", "high", "Changed a file that runs code or controls tools automatically",
                                      entry["path"]))
    git_start, git_end = record.get("git_start"), record.get("git_end")
    if isinstance(git_start, str) and isinstance(git_end, str) and git_start != git_end:
        attention.append(_finding("git_internals", "high",
                                  "Git configuration or hooks changed during this turn; they can run code on later git commands"))
    edited_keys = {_path_key(path) for path in edited + edited_by_subagents}
    for path, what in _watched_changes(record):
        if _path_key(path) in changed_keys:
            continue
        if _path_key(path) in edited_keys:
            what = "Edited"
        attention.append(_finding("hidden_change", "high", f"{what} a file git ignores, so it is not in the diff", path))
    for entry in files_changed[:MAX_SENSITIVE_CHECKS]:
        if _path_key(entry["path"]) in edited_keys:
            continue
        if is_sensitive_path(entry["path"], str(project)):
            attention.append(_finding("sensitive", "high", "Changed a sensitive file", entry["path"]))
    if len(files_changed) > MAX_SENSITIVE_CHECKS:
        notes.append(f"Only the first {MAX_SENSITIVE_CHECKS} changed files were checked for sensitive names.")

    checks = _check_results(commands)
    for check in checks:
        if check["result"] == "failed":
            attention.append(_finding("check_failed", "high", "Check still failed at the end of the turn", check["command"]))

    folders = {PurePosixPath(entry["path"]).parts[0] for entry in files_changed if PurePosixPath(entry["path"]).parts}
    if len(files_changed) > LARGE_CHANGE_FILES or len(folders) > LARGE_CHANGE_FOLDERS:
        attention.append(_finding("large_change", "medium",
                                  f"Large change: {len(files_changed)} files across {len(folders)} top-level folders. Consider splitting it."))

    started_at = record.get("started_at") or first_ts
    ended_at = record.get("ended_at") or last_ts
    receipt: Dict[str, Any] = {
        "version": RECEIPT_VERSION,
        "session_id": str(getattr(session, "id", "")),
        "turn_index": record["turn_index"],
        "started_at": started_at,
        "ended_at": ended_at,
        "duration_seconds": _duration(started_at, ended_at),
        "models": models or _session_model(session),
        "mode": visible(record["mode"]) if isinstance(record.get("mode"), str) and record["mode"] else None,
        "snapshot": {"before": record.get("snapshot_hash"), "after": record.get("after_hash")},
        "summary": {
            "files_changed": len(files_changed),
            "lines_added": sum(entry["added"] or 0 for entry in files_changed),
            "lines_deleted": sum(entry["deleted"] or 0 for entry in files_changed),
            "files_read": len(files_read),
            "searches": searches,
            "commands": len(commands),
            "commands_failed": sum(1 for c in commands if c["outcome"] in ("failed", "error", "timeout")),
            "blocked": blocked,
            "denied": denied,
            "approved_by_person": approved_by_person,
            "denied_by_person": denied_by_person,
            "subagents": subagents,
            "web_searches": web_searches,
        },
        "files_changed": files_changed[:MAX_LISTED],
        "edited_not_in_snapshot": edited_untracked[:MAX_LISTED],
        "files_read": files_read[:MAX_LISTED],
        "commands": commands[:MAX_LISTED],
        "checks": checks,
        "web_hosts": web_hosts[:MAX_LISTED],
        "mcp_servers": mcp_servers[:MAX_LISTED],
        "other_tools": dict(sorted(other_tools.items())[:MAX_LISTED]),
        "needs_attention": _ordered(attention),
        "approvers": [{"id": person_id, "name": person} for person_id, person in approvers.items()],
        "cost_usd": _delta(record, "cost_start", "cost_end", float),
        "tokens": _delta(record, "tokens_start", "tokens_end", int),
        "notes": notes,
    }
    if approvers:
        notes.append("Approver names come from git settings on this machine and are not verified.")
    for key, full in (("files_changed", files_changed), ("files_read", files_read), ("commands", commands)):
        if len(full) > MAX_LISTED:
            notes.append(f"Only the first {MAX_LISTED} of {len(full)} {key.replace('_', ' ')} are listed.")
    if not _legacy_commands.get():
        receipt["command_chars"] = MAX_COMMAND_CHARS
    sealed = record.get("receipt_hash")
    if isinstance(sealed, str) and _SHA256.fullmatch(sealed):
        matches = sealed == record_hash(receipt)
        receipt["sealed"] = {"hash": sealed, "matches": matches}
        if not matches:
            notes.append("This receipt no longer matches the one made when the turn ended: the session's records "
                         "changed since. Treat it with care.")
    receipt["record_hash"] = record_hash(receipt)
    return receipt


def record_hash(receipt: Dict[str, Any]) -> str:
    facts = {key: value for key, value in receipt.items() if key != "record_hash"}
    canonical = json.dumps(facts, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()


def render_text(receipt: Dict[str, Any], viewer: Optional[Dict[str, Any]] = None) -> str:
    """A short plain-text receipt, readable in a few seconds. `viewer` is the reader's local identity, used only
    to mark their own approvals with "(you)"."""
    from andromity.core.identity import identity_id
    s = receipt["summary"]
    me = identity_id(viewer)
    names = {person["id"]: person["name"] for person in receipt.get("approvers", [])}
    when = _short_time(receipt.get("started_at"))
    duration = _short_duration(receipt.get("duration_seconds"))
    header = f"Andromity receipt - turn {receipt['turn_index'] + 1}"
    if when:
        header += f" - {when}"
    if duration:
        header += f" ({duration})"
    totals = [f"Changed {s['files_changed']} file{'s' if s['files_changed'] != 1 else ''} (+{s['lines_added']} -{s['lines_deleted']})",
              f"read {s['files_read']}"]
    if s["commands"]:
        failed = f", {s['commands_failed']} failed" if s["commands_failed"] else ""
        totals.append(f"{s['commands']} command{'s' if s['commands'] != 1 else ''}{failed}")
    if s["blocked"]:
        totals.append(f"{s['blocked']} blocked")
    if s["denied"]:
        totals.append(f"{s['denied']} declined")
    if receipt.get("cost_usd") is not None:
        totals.append(f"${receipt['cost_usd']:.2f}")
    lines = [header, " | ".join(totals)]

    if receipt["needs_attention"]:
        lines += ["", "Needs your eyes"]
        for item in receipt["needs_attention"]:
            person = f" by {_person_label(item['approver'], names, me)}" if item.get("approver") else ""
            subject = f": {item['subject']}" if item.get("subject") else ""
            lines.append(f"  ! {item['detail']}{person}{subject}")
    if receipt["commands"]:
        lines += ["", "Commands"]
        for command in receipt["commands"][:TEXT_COMMAND_LINES]:
            lines.append(f"  [{_command_status(command, names, me)}] {_brief(command['command'])}")
        extra = s["commands"] - min(len(receipt["commands"]), TEXT_COMMAND_LINES)
        if extra > 0:
            lines.append(f"  ... and {extra} more")
    if receipt.get("other_tools"):
        lines += ["", "Other tools: " + ", ".join(
            f"{name} x{count}" if count > 1 else name for name, count in receipt["other_tools"].items())]
    if receipt["checks"]:
        lines += ["", "Checks"]
        for check in receipt["checks"]:
            suffix = " (failed first, passed after)" if check["failed_first"] else ""
            code = f" (exit {check['exit_code']})" if check["result"] == "failed" and check["exit_code"] is not None else ""
            lines.append(f"  [{check['result']}] {_brief(check['command'])}{code}{suffix}")
    if receipt["files_changed"]:
        lines += ["", "Files changed"]
        for entry in receipt["files_changed"][:TEXT_FILE_LINES]:
            counts = f" (+{entry['added']} -{entry['deleted']})" if entry["added"] is not None else " (binary)"
            via = "" if entry["via"] == "edit" else " [not by the agent's edits]"
            lines.append(f"  {entry['status']} {entry['path']}{counts}{via}")
        extra = s["files_changed"] - min(len(receipt["files_changed"]), TEXT_FILE_LINES)
        if extra > 0:
            lines.append(f"  ... and {extra} more")

    footer = []
    if receipt["models"]:
        footer.append("Model: " + ", ".join(visible(m) for m in receipt["models"]))
    if receipt.get("mode"):
        footer.append(f"Mode: {receipt['mode']}")
    if s["approved_by_person"] or s["denied_by_person"]:
        people = ", ".join(_person_label(person_id, names, me) for person_id in names)
        footer.append(f"Approvals{' by ' + people if people else ''}: {s['approved_by_person']} approved, "
                      f"{s['denied_by_person']} declined")
    lines += ["", " | ".join(footer)] if footer else [""]
    snap = receipt["snapshot"]
    sealed = receipt.get("sealed")
    seal = " (matches the record made when the turn ended)" if isinstance(sealed, dict) and sealed.get("matches") is True else ""
    if snap.get("before") and snap.get("after"):
        lines.append(f"Snapshots {snap['before'][:7]} -> {snap['after'][:7]} | Checksum {receipt['record_hash'][:12]}{seal}")
    else:
        lines.append(f"Checksum {receipt['record_hash'][:12]}{seal}")
    lines += [f"Note: {note}" for note in receipt["notes"]]
    lines.append("Not covered: most files git ignores, and files outside this folder.")
    lines.append("No prompts, file contents or command output are included.")
    return "\n".join(lines)


def _command_status(command: Dict[str, Any], names: Optional[Dict[str, str]] = None, me: Optional[str] = None,
                    markdown: bool = False) -> str:
    outcome = command["outcome"]
    decided, person_id = command.get("decided_by_person"), command.get("decided_by")
    person = _person_label(person_id, names or {}, me, markdown)
    if outcome == "failed":
        label = f"failed {command['exit_code']}" if command["exit_code"] is not None else "failed"
    elif outcome == "denied":
        label = f"declined by {person}" if decided is False else "not run"
    elif outcome == "ok" and command.get("background"):
        label = "background"
    else:
        label = {"skipped": "not run", "dry_run": "dry run", "no_result": "no result"}.get(outcome, outcome)
    if decided is True:
        label += f", approved by {person}"
    return label if command.get("by", "agent") == "agent" else f"{label}, {command['by']}"


_MD_MARKUP = re.compile(r"([\\`*_\[\]|~])")
# GitHub finds @mentions and bare links after decoding entities, so a zero-width space is what breaks them.
_MD_LINKISH = re.compile(r"@|://|www\.|#(?=\d)|GH-(?=\d)", re.IGNORECASE)


def _md_text(value: Any) -> str:
    """Text outside code: no Markdown, HTML, links, images or @mentions can come out of it."""
    text = visible(str(value)).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = _MD_MARKUP.sub(r"\\\1", text)
    return _MD_LINKISH.sub(lambda match: match.group(0)[0] + "\u200b" + match.group(0)[1:], text)


def _md_code(value: Any, in_table: bool = False) -> str:
    """An inline code span that nothing inside can close. In a table, pipes are escaped so the row holds."""
    text = visible(str(value)) or " "
    if in_table:
        text = text.replace("|", "\\|")
    fence = "`" * (max((len(run) for run in re.findall(r"`+", text)), default=0) + 1)
    pad = " " if text[0] in "` " or text[-1] in "` " else ""
    return f"{fence}{pad}{text}{pad}{fence}"


def render_markdown(receipt: Dict[str, Any]) -> str:
    """The receipt as GitHub-flavoured Markdown for a pull request. Agent-controlled text appears only in code spans
    or escaped. There is no "(you)": the people reading a pull request are not the approver."""
    s = receipt["summary"]
    names = {person["id"]: person["name"] for person in receipt.get("approvers", [])}
    when = " · ".join(part for part in (_short_time(receipt.get("started_at")),
                                         _short_duration(receipt.get("duration_seconds"))) if part)
    totals = [f"**{s['files_changed']} file{'s' if s['files_changed'] != 1 else ''} changed** "
              f"(+{s['lines_added']} -{s['lines_deleted']})", f"{s['files_read']} read"]
    if s["commands"]:
        failed = f", {s['commands_failed']} failed" if s["commands_failed"] else ""
        totals.append(f"{s['commands']} command{'s' if s['commands'] != 1 else ''}{failed}")
    if s["blocked"]:
        totals.append(f"{s['blocked']} blocked")
    if s["denied"]:
        totals.append(f"{s['denied']} declined")
    if receipt.get("cost_usd") is not None:
        totals.append(f"${receipt['cost_usd']:.2f}")
    lines = [f"### Andromity receipt · turn {receipt['turn_index'] + 1}" + (f" · {when}" if when else ""), "",
             " · ".join(totals), ""]

    findings = receipt["needs_attention"]
    if findings:
        lines += [f"**Needs your eyes ({len(findings)})**", ""]
        for item in findings:
            label = "**High**" if item["severity"] == "high" else "Medium"
            person = f" by {_person_label(item['approver'], names, None, markdown=True)}" if item.get("approver") else ""
            subject = f": {_md_code(item['subject'])}" if item.get("subject") else ""
            lines.append(f"- {label} · {_md_text(item['detail'])}{person}{subject}")
        lines.append("")
    else:
        lines += ["Nothing in this turn needs your eyes.", ""]

    if receipt["commands"]:
        lines += [f"<details><summary>Commands ({s['commands']})</summary>", "", "| Result | Command |", "|---|---|"]
        for command in receipt["commands"]:
            status = _command_status(command, names, None, markdown=True)
            lines.append(f"| {status} | {_md_code(_brief(command['command']), in_table=True)} |")
        lines += ["", "</details>", ""]
    if receipt["checks"]:
        lines += ["**Checks**", ""]
        for check in receipt["checks"]:
            code = f" (exit {check['exit_code']})" if check["result"] == "failed" and check["exit_code"] is not None else ""
            recovered = ", failed first" if check["failed_first"] else ""
            lines.append(f"- {check['result']}{code}{recovered}: {_md_code(_brief(check['command']))}")
        lines.append("")
    if receipt["files_changed"]:
        lines += [f"<details><summary>Files changed ({s['files_changed']})</summary>", "", "| | File | Lines | |",
                  "|---|---|---|---|"]
        for entry in receipt["files_changed"]:
            counts = f"+{entry['added']} -{entry['deleted']}" if entry["added"] is not None else "binary"
            via = {"other": "not by the agent's edits", "subagent": "subagent"}.get(entry["via"], "")
            lines.append(f"| {_md_text(entry['status'])} | {_md_code(entry['path'], in_table=True)} | {counts} | "
                         f"{_md_text(via)} |")
        lines += ["", "</details>", ""]

    footer = []
    if receipt["models"]:
        footer.append("Model: " + ", ".join(_md_text(model) for model in receipt["models"]))
    if receipt.get("mode"):
        footer.append(f"Mode: {_md_text(receipt['mode'])}")
    if s["approved_by_person"] or s["denied_by_person"]:
        people = ", ".join(_person_label(person_id, names, None, markdown=True) for person_id in names)
        footer.append(f"Approvals{' by ' + people if people else ''}: {s['approved_by_person']} approved, "
                      f"{s['denied_by_person']} declined")
    if footer:
        lines += [" · ".join(footer), ""]
    sealed = receipt.get("sealed")
    seal = (" · matches the record made when the turn ended" if isinstance(sealed, dict) and sealed.get("matches") is True
            else " · **differs from the record made when the turn ended**" if isinstance(sealed, dict) else "")
    lines += [f"Checksum `{receipt['record_hash'][:12]}`{seal}", ""]
    if receipt["notes"]:
        lines += [f"> {_md_text(note)}" for note in receipt["notes"]] + [""]
    lines.append("<sub>Built by Andromity from its own records, not written by the AI. No prompts, file contents or "
                 "command output. Not covered: most files git ignores, and files outside this folder.</sub>")
    return "\n".join(lines)


def _watched_changes(record: Dict[str, Any]) -> List[Tuple[str, str]]:
    """High-risk files that changed during the turn, found by fingerprint rather than by git."""
    start, end = record.get("watched_start"), record.get("watched_end")
    if not isinstance(start, dict) or not isinstance(end, dict):
        return []
    changes = []
    for path in sorted(set(start) | set(end)):
        was, now = start.get(path), end.get(path)
        if was == now:
            continue
        changes.append((path, "Created" if was is None else "Deleted" if now is None else "Changed"))
    return changes[:MAX_WATCHED_FILES]


def _check_snapshot_hashes(record: Dict[str, Any]) -> None:
    for key in ("snapshot_hash", "after_hash"):
        if not _OBJECT_ID.fullmatch(str(record.get(key) or "")):
            raise ReceiptUnavailable(f"Turn {record['turn_index'] + 1}'s checkpoint is damaged, so it has no receipt.")


def _pick_record(session: Any, turn_index: Optional[int]) -> Dict[str, Any]:
    records = [r for r in (getattr(session, "undo_stack", None) or [])
               if isinstance(r, dict) and isinstance(r.get("turn_index"), int) and isinstance(r.get("msg_count"), int)
               and isinstance(r.get("snapshot_hash"), str)]
    if turn_index is None:
        finished = [r for r in records if isinstance(r.get("after_hash"), str) and r["after_hash"]]
        if not finished:
            raise ReceiptUnavailable("No finished turn with a file checkpoint in this session yet.")
        return max(finished, key=lambda r: r["turn_index"])
    match = next((r for r in records if r["turn_index"] == turn_index), None)
    if match is None:
        raise ReceiptUnavailable(f"Turn {turn_index + 1} has no file checkpoint, so it has no receipt.")
    if not (isinstance(match.get("after_hash"), str) and match["after_hash"]):
        raise ReceiptUnavailable(f"Turn {turn_index + 1} has not finished, so its receipt isn't ready.")
    return match


def _position_kept(record: Dict[str, Any], compacted: bool) -> bool:
    """Whether a record's position still points at its prompt: compaction keeps only `anchored` records current."""
    return not record.get("compacted") and (bool(record.get("anchored")) or not compacted)


def _turn_bounds(session: Any, record: Dict[str, Any], total: int, compacted: bool) -> Optional[Tuple[int, int]]:
    start = record["msg_count"]
    later = sorted(r["msg_count"] for r in (getattr(session, "undo_stack", None) or [])
                   if isinstance(r, dict) and _position_kept(r, compacted) and isinstance(r.get("msg_count"), int)
                   and r["msg_count"] > start)
    end = later[0] if later else total
    recorded_end = record.get("msg_end")
    if isinstance(recorded_end, int) and not isinstance(recorded_end, bool) and start < recorded_end <= end:
        end = recorded_end
    if not 0 <= start < total:
        return None
    messages = getattr(session, "messages", []) or []
    opening = messages[start] if isinstance(messages[start], dict) else {}
    if opening.get("role") == "system":
        start += 1
        opening = messages[start] if start < total and isinstance(messages[start], dict) else {}
    if opening.get("role") != "user" or opening.get("steering"):
        return None
    return (start, min(end, total))


def valid_gates(session: Any) -> Dict[str, str]:
    gates = getattr(session, "tool_gates", None)
    return gates if isinstance(gates, dict) else {}


def _subagent_role(name: Any) -> str:
    """The role a subagent's session name carries, only when it is a plain word; the model chooses roles."""
    parts = str(name or "").split("-")
    role = parts[1] if len(parts) >= 3 and parts[0] == "subagent" else ""
    return role if _ROLE.fullmatch(role) else "subagent"


def _turn_window(session: Any, record: Dict[str, Any], messages: List[Any]) -> Optional[List[Dict[str, Any]]]:
    """The turn's own messages: by its key when it has one, else by its recorded position. None when they are gone."""
    key = record.get("turn_key")
    if isinstance(key, str) and _TURN_KEY.fullmatch(key):
        window = [m for m in messages if isinstance(m, dict) and m.get("turn_key") == key and m.get("role") != "system"]
        return window or None
    compacted = any(isinstance(m, dict) and is_compaction_summary(m) for m in messages)
    if not _position_kept(record, compacted):
        return None
    bounds = _turn_bounds(session, record, len(messages), compacted)
    return None if bounds is None else [m for m in messages[bounds[0]:bounds[1]] if isinstance(m, dict)]


def _turn_calls(window: Optional[List[Dict[str, Any]]], gates: Dict[str, str], legacy: bool,
                by: str) -> Tuple[List[Dict[str, Any]], List[str], Optional[str], Optional[str]]:
    if window is None:
        return [], [], None, None
    results: Dict[Any, str] = {}
    for message in window:
        if message.get("role") == "tool":
            call_id = message.get("tool_call_id")
            if isinstance(call_id, str):
                results[call_id] = str(message.get("content") or "")
    calls: List[Dict[str, Any]] = []
    models: List[str] = []
    for message in window:
        if message.get("role") != "assistant":
            continue
        model = message.get("model")
        if isinstance(model, str) and model:
            _add_unique(models, visible(model))
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
            name = str(fn.get("name") or tc.get("name") or "")
            args = _parse_args(fn.get("arguments", tc.get("arguments")))
            call_id = tc.get("id") if isinstance(tc.get("id"), str) else None
            outcome, exit_code = _outcome(name, results.get(call_id), gates.get(call_id), legacy)
            calls.append({"id": call_id, "name": name, "args": args, "outcome": outcome,
                          "exit_code": exit_code, "by": by})
    stamps = [m.get("ts") for m in window if isinstance(m.get("ts"), str)]
    return calls, models, (stamps[0] if stamps else None), (stamps[-1] if stamps else None)


def _subagent_calls(session: Any, project: Path, started_at: Optional[str],
                    ended_at: Optional[str], legacy: bool) -> List[Dict[str, Any]]:
    """Tool calls made by subagents this turn spawned, from their own stored sessions."""
    parent_id = str(getattr(session, "id", "") or "")
    start, end = _parse_time(started_at), _parse_time(ended_at)
    if not parent_id or start is None:
        return []
    try:
        from andromity.core.session import Session
        children = Session.child_session_ids(parent_id)
    except Exception:
        return []
    calls: List[Dict[str, Any]] = []
    for child_id in children:
        try:
            loaded = Session.load_by_id(child_id, str(project))
        except Exception:
            continue
        if loaded is None or str(getattr(loaded, "parent_session", "") or "") != parent_id:
            continue
        created = _parse_time(getattr(loaded, "created_at", None))
        if created is None or created < start or (end is not None and created > end):
            continue
        child_messages = [m for m in (getattr(loaded, "messages", None) or []) if isinstance(m, dict)]
        role = _subagent_role(getattr(loaded, "name", ""))
        child_calls, _, _, _ = _turn_calls(child_messages, valid_gates(loaded), legacy,
                                           "subagent" if role == "subagent" else f"subagent {role}")
        calls.extend(child_calls)
    return calls


def _parse_args(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError, RecursionError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _outcome(name: str, result: Optional[str], gate: Optional[str], legacy: bool) -> Tuple[str, Optional[int]]:
    """What happened to one tool call. The harness's own gate record wins; tool output never decides."""
    if gate is not None:
        return _GATE_OUTCOMES[gate], None
    if result is None:
        return "no_result", None
    text = result.lstrip()
    if legacy:
        lines = text.split("\n", 3)
        first = lines[0]
        if text.startswith("TOOL REJECTED BY USER"):
            return "denied", None
        refused = first.startswith("Error") and any(marker in first for marker in _REFUSAL_MARKERS)
        policy_rejection = len(lines) > 2 and lines[1] == "Do NOT retry this tool call." and lines[2].startswith("Acknowledge")
        if text.startswith(("TOOL BLOCKED", "SECURITY BLOCKED")) or refused or policy_rejection:
            return "blocked", None
        if text.startswith("Stopped: the user cancelled"):
            return "cancelled", None
        if text.startswith("Error: Command timed out"):
            return "timeout", None
    if name in SHELL_TOOLS:
        failure = _EXIT_LINE.search(text)
        if failure:
            return "failed", int(failure.group(1))
        # A command's own output is not evidence: only the harness's own error lines count.
        return ("error", None) if text.startswith("Error executing command") else ("ok", None)
    if text.startswith(("Error", "[Error")):
        return "error", None
    return "ok", None


def _changed_files(record: Dict[str, Any], project: Path, repo: Any, edited: List[str],
                   notes: List[str], edited_by_subagents: Optional[List[str]] = None) -> Tuple[List[Dict[str, Any]], bool]:
    before, after = record.get("snapshot_hash"), record.get("after_hash")
    edited_by_subagents = edited_by_subagents or []
    fallback = ([{"path": p, "status": "?", "added": None, "deleted": None, "via": "edit"} for p in edited]
                + [{"path": p, "status": "?", "added": None, "deleted": None, "via": "subagent"} for p in edited_by_subagents])
    if repo is None:
        from andromity.core.git_ops import get_repo
        repo = get_repo(project)
    if repo is None:
        notes.append("No git repository was found, so changed files come from the agent's own edits only.")
        return fallback, False
    root = Path(repo.working_tree_dir).resolve()
    scope = [] if project == root else ["--", ":(literal)" + project.relative_to(root).as_posix()]
    base = ["--no-renames", "--no-ext-diff", "--no-textconv", "-z", before, after]
    try:
        status_raw = repo.git.execute([*_SAFE_GIT, "diff", "--name-status", *base, *scope])
        numstat_raw = repo.git.execute([*_SAFE_GIT, "diff", "--numstat", *base, *scope])
    except Exception:
        notes.append("The turn's snapshots are no longer available, so changed files come from the agent's own edits only.")
        return fallback, False

    statuses = _parse_name_status(status_raw)
    counts = _parse_numstat(numstat_raw)
    edited_keys = {_path_key(path) for path in edited}
    subagent_keys = {_path_key(path) for path in edited_by_subagents}
    entries = []
    for repo_rel, status in statuses:
        lexical = Path(os.path.abspath(root / repo_rel))
        try:
            shown = visible(lexical.relative_to(project).as_posix())
        except ValueError:
            shown = visible(lexical.as_posix())
        added, deleted = counts.get(repo_rel, (None, None))
        entries.append({
            "path": shown,
            "status": status,
            "added": added,
            "deleted": deleted,
            "via": ("edit" if _path_key(shown) in edited_keys
                    else "subagent" if _path_key(shown) in subagent_keys else "other"),
        })
    entries.sort(key=lambda e: e["path"])
    return entries, True


def _parse_name_status(raw: str) -> List[Tuple[str, str]]:
    parts = raw.split("\0")
    pairs = []
    i = 0
    while i + 1 < len(parts):
        status, path = parts[i].strip(), parts[i + 1]
        i += 2
        if status and path:
            pairs.append((path, status[0]))
    return pairs


def _parse_numstat(raw: str) -> Dict[str, Tuple[Optional[int], Optional[int]]]:
    counts: Dict[str, Tuple[Optional[int], Optional[int]]] = {}
    for chunk in raw.split("\0"):
        fields = chunk.strip("\n").split("\t", 2)
        if len(fields) != 3 or not fields[2]:
            continue
        added = int(fields[0]) if fields[0].isdigit() else None
        deleted = int(fields[1]) if fields[1].isdigit() else None
        counts[fields[2]] = (added, deleted)
    return counts


def _check_results(commands: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_command: Dict[str, Dict[str, Any]] = {}
    for command in commands:
        if not command["check"] or command["background"] or command["outcome"] not in ("ok", "failed", "timeout"):
            continue
        key = " ".join(command["command"].split())
        entry = by_command.setdefault(key, {"command": command["command"], "runs": []})
        entry["runs"].append(command)
    results = []
    for entry in by_command.values():
        runs = entry["runs"]
        last = runs[-1]
        passed = last["outcome"] == "ok"
        results.append({
            "command": entry["command"],
            "result": "passed" if passed else "failed",
            "exit_code": last["exit_code"],
            "failed_first": passed and any(run["outcome"] in ("failed", "timeout") for run in runs[:-1]),
            "runs": len(runs),
        })
    return results


def _segment_is_check(segment: str) -> bool:
    tokens = _tokens(segment)
    while tokens and (tokens[0] == "&" or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0])):
        tokens.pop(0)
    if not tokens:
        return False
    program = _program(tokens[0])
    rest = [t.lower() for t in tokens[1:]]
    if program in _CHECK_PROGRAMS:
        return True
    if program in ("python", "python3", "py") and "-m" in rest:
        index = rest.index("-m")
        return index + 1 < len(rest) and rest[index + 1] in _CHECK_PY_MODULES
    if program in ("npm", "pnpm", "yarn", "bun"):
        if rest and rest[0] in ("test", "t"):
            return True
        if len(rest) >= 2 and rest[0] == "run":
            return bool(_CHECK_SCRIPT.match(rest[1]))
        return program in ("yarn", "pnpm", "bun") and bool(rest) and bool(_CHECK_SCRIPT.match(rest[0]))
    if program == "npx" and rest:
        return _program(rest[0]) in _CHECK_PROGRAMS
    if program in _CHECK_SUBCOMMANDS:
        return bool(rest) and rest[0] in _CHECK_SUBCOMMANDS[program]
    if program == "bundle" and rest[:2] == ["exec", "rspec"]:
        return True
    return False


def _program(token: str) -> str:
    name = token.strip("'\"").replace("\\", "/").rsplit("/", 1)[-1].lower()
    for suffix in (".exe", ".cmd", ".bat"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _sensitive_targets(command: str, project: Path) -> List[str]:
    found: List[str] = []
    for token in list(dict.fromkeys(command.split()))[:MAX_SCANNED_ARGUMENTS]:
        readings = (token, token.split("=", 1)[1]) if "=" in token else (token,)
        for value in readings:
            value = value.strip("'\"();,|&<>")
            if _looks_like_path(value) and is_sensitive_path(value, str(project)):
                _add_unique(found, visible(value))
    return found


def _looks_like_path(value: str) -> bool:
    """A bare word such as `secret` is a value, not a file; a path has a separator, a dot or a known name."""
    if not value or any(ch in value for ch in "()[]{};,$`\"'+*"):
        return False
    if "/" in value or "\\" in value or value.startswith("."):
        return True
    name = value.lower()
    if name in _SENSITIVE_BASENAMES:
        return True
    stem, dot, extension = name.rpartition(".")
    return bool(dot and stem and _FILE_EXTENSION.fullmatch(extension))


def _display_path(raw: str, project: Path) -> Tuple[str, bool, Optional[str]]:
    """The path as the agent named it, whether it is inside `project` (already resolved) once links and junctions
    are followed, and where it really leads when a link takes it out."""
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = project / candidate
    lexical = Path(os.path.abspath(candidate))
    try:
        named: Optional[str] = lexical.relative_to(project).as_posix()
    except ValueError:
        named = None
    try:
        real = Path(os.path.realpath(lexical))
    except (OSError, ValueError):
        return visible(named or lexical.as_posix()), False, None
    try:
        inside = real.relative_to(project).as_posix()
    except ValueError:
        leads_to = visible(real.as_posix()) if os.path.normcase(real) != os.path.normcase(lexical) else None
        return visible(named or lexical.as_posix()), False, leads_to
    return visible(named or inside), True, None


def _person(decision: Dict[str, Any]) -> Tuple[str, Optional[str]]:
    """Display name and pseudonymous id of whoever answered an approval prompt."""
    name = decision.get("name") or decision.get("os_user")
    shown = visible(name)[:MAX_PERSON_CHARS] if isinstance(name, str) and name.strip() else "a person"
    person_id = decision.get("id")
    return shown, person_id if isinstance(person_id, str) and _PERSON_ID.fullmatch(person_id) else None


def _approval(outcome: str, decision: Optional[Dict[str, Any]]) -> Tuple[str, Optional[str]]:
    """How a call came to run or not, and the id of the person who decided. The phrase never holds a name:
    renderers add the person after it, set apart, so a name can't pass for Andromity's own words."""
    if outcome == "denied":
        if decision is not None and decision["approved"] is False:
            person_id = _person(decision)[1]
            return ("declined", person_id) if person_id else ("declined by a person", None)
        return "not run (declined or cancelled)", None
    if outcome in ("blocked", "skipped", "dry_run"):
        return _stopped_by(outcome), None
    if decision is not None and decision["approved"] is True:
        person_id = _person(decision)[1]
        return ("approved", person_id) if person_id else ("approved by a person", None)
    return "ran without asking", None


def _person_label(person_id: Optional[str], names: Dict[str, str], me: Optional[str], markdown: bool = False) -> str:
    """A person's name set apart from the words around it: quoted in text, a code span in Markdown."""
    name = names.get(person_id or "")
    if not name:
        return "a person"
    if markdown:
        return _md_code(name)
    return f'"{name}"' + (" (you)" if me and person_id == me else "")


def _stopped_by(outcome: str) -> str:
    return {"denied": "not run (declined)", "skipped": "not run (superseded)", "dry_run": "not run (dry run)"}.get(outcome, "blocked")


def _finding(kind: str, severity: str, detail: str, subject: Optional[str] = None,
             approver: Optional[str] = None) -> Dict[str, str]:
    """`detail` is Andromity's own wording and never holds a name; `approver` is the id of the person who decided.
    `subject` is the path or command it is about, which the agent controls, so it stays apart and is shown after."""
    finding = {"kind": kind, "severity": severity, "detail": detail}
    if subject:
        finding["subject"] = subject
    if approver:
        finding["approver"] = approver
    return finding


def _ordered(findings: Iterable[Dict[str, str]]) -> List[Dict[str, str]]:
    unique: List[Dict[str, str]] = []
    for item in findings:
        if item not in unique:
            unique.append(item)
    rank = {"high": 0, "medium": 1}
    return sorted(unique, key=lambda item: rank.get(item["severity"], 2))[:MAX_LISTED]


def runs_code(path: str, project: str) -> bool:
    """Files whose content runs code or steers a tool automatically, such as CI, hooks and agent settings."""
    posix = str(path).replace("\\", "/").lower()
    while posix.startswith("./"):
        posix = posix[2:]
    name = posix.rsplit("/", 1)[-1]
    if name in _RUNS_CODE_NAMES or any(posix.startswith(prefix) or f"/{prefix}" in posix for prefix in _RUNS_CODE_DIRS):
        return True
    try:
        from andromity.core.security import is_execution_control_path
        return bool(is_execution_control_path(str(path), project))
    except Exception:
        return False


def _touches_own_records(command: str) -> bool:
    lowered = command.lower()
    return any(marker in lowered for marker in _OWN_RECORDS)


def watched_files(project_path: str) -> Dict[str, str]:
    """Fingerprints of high-risk files, so changes to them show up even when git ignores them."""
    try:
        root = Path(project_path).resolve()
        if not root.is_dir():
            return {}
    except OSError:
        return {}
    found: Dict[str, str] = {}
    visited = 0
    for directory, subdirs, files in os.walk(root):
        visited += 1
        here = Path(directory)
        depth = len(here.relative_to(root).parts)
        subdirs[:] = sorted(d for d in subdirs if d not in _WATCHED_SKIP_DIRS) if depth < WATCHED_MAX_DEPTH else []
        for name in sorted(files):
            path = here / name
            relative = path.relative_to(root).as_posix()
            if not _is_watched(relative, name, here.name, depth):
                continue
            if len(found) >= MAX_WATCHED_FILES:
                return found
            try:
                if not path.is_file() or path.is_symlink():
                    continue
                found[visible(relative)] = hashlib.sha256(path.read_bytes()[:WATCHED_READ_BYTES]).hexdigest()[:16]
            except (OSError, ValueError):
                continue
        if visited >= WATCHED_MAX_DIRS:
            break
    return found


def _is_watched(relative: str, name: str, parent: str, depth: int) -> bool:
    lowered = name.lower()
    return (lowered in _WATCHED_NAMES or lowered.startswith(_WATCHED_PREFIXES) or lowered.endswith(_WATCHED_SUFFIXES)
            or parent in _WATCHED_PARENTS or (depth == 1 and parent == ".andromity")
            or relative.lower().endswith(".docker/config.json"))


def git_internals_fingerprint(project_path: str) -> Optional[str]:
    """A digest of git's config, hooks and info files, which can run code but never appear in a diff."""
    try:
        from andromity.core.git_ops import get_repo
        repo = get_repo(Path(project_path))
        if repo is None:
            return None
        common = Path(getattr(repo, "common_dir", None) or repo.git_dir)
        private = Path(repo.git_dir)
        targets = [common / "config", private / "config.worktree", common / "info" / "attributes",
                   common / "info" / "exclude", common / "info" / "sparse-checkout"]
        hooks = common / "hooks"
        if hooks.is_dir():
            targets += sorted(p for p in hooks.rglob("*") if p.is_file())[:500]
        digest = hashlib.sha256()
        for target in targets:
            if target.is_file():
                digest.update(str(target.relative_to(common) if target.is_relative_to(common) else target.name).encode())
                digest.update(hashlib.sha256(target.read_bytes()[:1_000_000]).digest())
        return digest.hexdigest()
    except Exception:
        return None


def _path_key(path: str) -> str:
    return path.lower() if os.name == "nt" else path


def _add_unique(items: List[str], value: str) -> None:
    if value not in items:
        items.append(value)


def _mask_key_values(text: str) -> str:
    parts: List[str] = []
    done = 0
    size = len(text)
    for match in _SECRET_KEY.finditer(text):
        if match.start() < done:
            continue
        end = match.end()
        limit = min(size, end + 100)
        while end < limit and text[end] in _KEY_CHARS:
            end += 1
        cursor = _skip_blanks(text, end)
        if cursor >= size or text[cursor] not in "=:":
            continue
        cursor = _skip_blanks(text, cursor + 1)
        quote = text[cursor] if cursor < size and text[cursor] in "'\"" else ""
        if quote:
            cursor += 1
        value_end = cursor
        if quote:
            limit = min(size, cursor + 512)
            while value_end < limit and text[value_end] not in (quote, "\n"):
                value_end += 1
        else:
            while value_end < size and text[value_end] not in _VALUE_STOP:
                value_end += 1
        if value_end > cursor:
            parts.append(text[done:cursor])
            parts.append("***")
            done = value_end
    parts.append(text[done:])
    return "".join(parts)


def _skip_blanks(text: str, index: int) -> int:
    limit = min(len(text), index + 8)
    while index < limit and text[index] in " \t":
        index += 1
    return index


def _mask_if_random(match: "re.Match[str]") -> str:
    token = match.group(0)
    has_upper = any(c.isupper() for c in token)
    has_lower = any(c.islower() for c in token)
    has_digit = any(c.isdigit() for c in token)
    return "***" if has_upper and has_lower and has_digit else token


def _session_model(session: Any) -> List[str]:
    provider = str(getattr(session, "provider", "") or "")
    model = str(getattr(session, "model", "") or "")
    combined = "/".join(part for part in (provider, model) if part)
    return [visible(combined)] if combined else []


def _delta(record: Dict[str, Any], start_key: str, end_key: str, kind: type) -> Any:
    start, end = record.get(start_key), record.get(end_key)
    if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or isinstance(start, bool) or isinstance(end, bool):
        return None
    value = kind(end) - kind(start)
    if value < 0:
        return None
    return round(value, 6) if kind is float else value


def _parse_time(value: Optional[str]) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.fromisoformat(value)
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def _duration(start: Optional[str], end: Optional[str]) -> Optional[int]:
    a, b = _parse_time(start), _parse_time(end)
    if a is None or b is None or b < a:
        return None
    return int((b - a).total_seconds())


def _short_time(value: Optional[str]) -> str:
    stamp = _parse_time(value)
    return stamp.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if stamp else ""


def _short_duration(seconds: Optional[int]) -> str:
    if seconds is None:
        return ""
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    return f"{minutes} min" if minutes < 60 else f"{minutes // 60} h {minutes % 60} min"
