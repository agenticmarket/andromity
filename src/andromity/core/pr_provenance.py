"""Which Andromity turns produced the files of a pull request, matched by file contents.

A file counts as covered only when an unbroken chain of turns leads from the file as it is on the base branch to
the file as it is now: the first turn started from the base version, each later turn started from the previous
turn's result, and the last turn left the file exactly as the pull request has it. A break means someone or
something else changed the file in between, so the file is only partly covered."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from andromity.core.git_ops import safe_git_command
from andromity.core.turn_changes import MAX_STATS, turn_file_stats

_REF = re.compile(r"[^\x00-\x20\x7f~^:?*\[\\\-./][^\x00-\x20\x7f~^:?*\[\\]{0,250}")
_OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_ZERO_ID = re.compile(r"0+")
MAX_FILES = 3000
MAX_RECORDS = 400
MAX_BACKFILL = 60
MAX_CHAIN = 50
MAX_SEARCH = 2000


class ProvenanceUnavailable(Exception):
    """A plain reason the pull request's files can't be matched to turns."""


def _blob(value: str) -> Optional[str]:
    return None if _ZERO_ID.fullmatch(value) else value


def _pr_files(repo: Any, git: List[str], base: str, head: str) -> Tuple[List[Dict[str, Any]], bool]:
    """The files GitHub lists for base...head (renames detected), with their blobs and line counts, and whether
    the list was cut at MAX_FILES."""
    raw = repo.git.execute([*git, "diff", "--raw", "--no-abbrev", "-M", "--no-ext-diff", "--no-textconv", "-z", base, head])
    numstat = repo.git.execute([*git, "diff", "--numstat", "-M", "--no-ext-diff", "--no-textconv", "-z", base, head])
    counts: Dict[str, Tuple[Optional[int], Optional[int]]] = {}
    parts = numstat.split("\0")
    i = 0
    while i < len(parts):
        fields = parts[i].strip("\n").split("\t", 2)
        if len(fields) == 3 and fields[2]:
            counts[fields[2]] = (int(fields[0]) if fields[0].isdigit() else None, int(fields[1]) if fields[1].isdigit() else None)
            i += 1
        elif len(fields) == 3 and not fields[2] and i + 2 < len(parts):
            counts[parts[i + 2]] = (int(fields[0]) if fields[0].isdigit() else None, int(fields[1]) if fields[1].isdigit() else None)
            i += 3
        else:
            i += 1
    files: List[Dict[str, Any]] = []
    tokens = raw.split("\0")
    i = 0
    while i < len(tokens) - 1 and len(files) <= MAX_FILES:
        head_field = tokens[i]
        if not head_field.startswith(":"):
            i += 1
            continue
        fields = head_field[1:].split()
        if len(fields) != 5:
            i += 1
            continue
        _, _, old_id, new_id, status = fields
        kind = status[:1]
        if kind in ("R", "C") and i + 2 < len(tokens):
            old_path, path = tokens[i + 1], tokens[i + 2]
            i += 3
        else:
            old_path, path = None, tokens[i + 1]
            i += 2
        added, deleted = counts.get(path, (None, None))
        files.append({
            "path": path, "old_path": old_path if kind == "R" else None, "status": kind,
            "base_blob": _blob(old_id), "head_blob": _blob(new_id),
            "additions": added, "deletions": deleted, "binary": added is None and deleted is None,
        })
    return files[:MAX_FILES], len(files) > MAX_FILES


class _Index:
    """Turn changes keyed by (repository path, blob the turn left)."""

    def __init__(self) -> None:
        self.by_after: Dict[Tuple[str, Optional[str]], List[Tuple[int, Dict[str, Any], Dict[str, Any]]]] = {}
        self.by_path: Dict[str, List[Tuple[int, Dict[str, Any]]]] = {}

    def add(self, order: int, turn: Dict[str, Any], change: Dict[str, Any], path: str) -> None:
        self.by_after.setdefault((path, change.get("after_blob")), []).append((order, turn, change))
        self.by_path.setdefault(path, []).append((order, turn))

    def touched(self, path: str) -> List[Dict[str, Any]]:
        """Turns that changed this path at some point, newest first."""
        out: List[Dict[str, Any]] = []
        for _, turn in sorted(self.by_path.get(path, []), key=lambda entry: entry[0]):
            if turn not in out:
                out.append(turn)
        return out[:5]

    def chain(self, path: str, now: Optional[str], base: Optional[str]) -> Tuple[str, List[Dict[str, Any]]]:
        """(covered | partial | none, turns newest first) for one path from its base blob to its blob now. The
        newest turn at each step is tried first; when that leads to a break, the other turns that left the same
        contents are tried before the file is called partial."""
        coverage, used = self._newest_chain(path, now, base)
        if coverage == "covered":
            return coverage, used
        found = self._any_chain(path, now, base, [], set(), [MAX_SEARCH])
        return ("covered", found) if found else (coverage, used)

    def _any_chain(self, path: str, current: Optional[str], base: Optional[str], used: List[Dict[str, Any]],
                   seen: set, budget: List[int]) -> Optional[List[Dict[str, Any]]]:
        if current == base and used:
            return list(used)
        if len(used) >= MAX_CHAIN:
            return None
        for _, turn, change in sorted(self.by_after.get((path, current), []), key=lambda entry: entry[0]):
            if id(turn) in seen or budget[0] <= 0:
                continue
            budget[0] -= 1
            seen.add(id(turn))
            used.append(turn)
            found = self._any_chain(path, change.get("before_blob"), base, used, seen, budget)
            used.pop()
            seen.discard(id(turn))
            if found:
                return found
        return None

    def _newest_chain(self, path: str, now: Optional[str], base: Optional[str]) -> Tuple[str, List[Dict[str, Any]]]:
        used: List[Dict[str, Any]] = []
        seen = set()
        current = now
        for _ in range(MAX_CHAIN):
            if current == base and used:
                return "covered", used
            candidates = [entry for entry in self.by_after.get((path, current), []) if id(entry[1]) not in seen]
            if not candidates:
                break
            _, turn, change = min(candidates, key=lambda entry: entry[0])
            seen.add(id(turn))
            used.append(turn)
            current = change.get("before_blob")
        if used and current == base:
            return "covered", used
        return ("partial" if used else "none"), used


def _repo_relative(root: Path, project: str, path: str) -> Optional[str]:
    try:
        return Path(os.path.normpath(Path(project).resolve() / path)).relative_to(root).as_posix()
    except (ValueError, OSError):
        return None


def provenance(repo: Any, base_ref: str, sessions: Iterable[Any]) -> Dict[str, Any]:
    """Per-file coverage of HEAD against the merge base with base_ref, from the turn records of the given chats
    (newest chat first). Only turns whose snapshots are in this repository take part."""
    if (not isinstance(base_ref, str) or not _REF.fullmatch(base_ref) or ".." in base_ref or "@{" in base_ref
            or "//" in base_ref or "/." in base_ref or base_ref.endswith((".", "/", ".lock")) or base_ref == "@"):
        raise ProvenanceUnavailable("That base branch name isn't valid.")
    git = safe_git_command(repo)
    try:
        head = repo.git.execute([*git, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).strip()
        base_tip = repo.git.execute([*git, "rev-parse", "--verify", "--quiet", f"{base_ref}^{{commit}}"]).strip()
        merge_base = repo.git.execute([*git, "merge-base", base_tip, head]).strip()
    except Exception as exc:
        raise ProvenanceUnavailable("The base branch isn't known here, so the pull request's files can't be listed.") from exc
    if not (_OBJECT_ID.fullmatch(head) and _OBJECT_ID.fullmatch(merge_base)):
        raise ProvenanceUnavailable("The base branch isn't known here, so the pull request's files can't be listed.")
    root = Path(repo.working_tree_dir).resolve()
    files, truncated = _pr_files(repo, git, merge_base, head)

    index = _Index()
    turns: Dict[Tuple[str, int], Dict[str, Any]] = {}
    order = 0
    backfilled = 0
    records_seen = 0
    for session in sessions:
        project = str(getattr(session, "project_path", "") or "")
        if not project:
            continue
        for record in reversed(getattr(session, "undo_stack", None) or []):
            if records_seen >= MAX_RECORDS:
                break
            if not (isinstance(record, dict) and isinstance(record.get("turn_index"), int) and not isinstance(record["turn_index"], bool)
                    and _OBJECT_ID.fullmatch(str(record.get("snapshot_hash") or "")) and _OBJECT_ID.fullmatch(str(record.get("after_hash") or ""))):
                continue
            records_seen += 1
            stored = record.get("file_stats")
            stats = stored if isinstance(stored, list) else None
            if (stats is None or len(stats) >= MAX_STATS) and backfilled < MAX_BACKFILL:
                backfilled += 1
                try:
                    stats = turn_file_stats(repo, record, project, MAX_FILES)
                except Exception:
                    pass
            if stats is None:
                continue
            key = (str(getattr(session, "id", "")), record["turn_index"])
            turn = turns.setdefault(key, {
                "session_id": key[0], "turn_index": key[1],
                "turn_key": record.get("turn_key") if isinstance(record.get("turn_key"), str) else None,
                "attention_high": record.get("attention_high") if isinstance(record.get("attention_high"), int) else None,
            })
            for change in stats[:MAX_FILES]:
                if not isinstance(change, dict) or not isinstance(change.get("path"), str):
                    continue
                path = _repo_relative(root, project, change["path"])
                if path:
                    index.add(order, turn, change, path)
            order += 1

    rows: List[Dict[str, Any]] = []
    used_turns: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for file in files:
        if file["status"] == "R" and file["old_path"]:
            new_cover, new_turns = index.chain(file["path"], file["head_blob"], None)
            old_cover, old_turns = index.chain(file["old_path"], None, file["base_blob"])
            chain_turns = new_turns + [turn for turn in old_turns if turn not in new_turns]
            coverage = "covered" if new_cover == "covered" and old_cover == "covered" else ("partial" if chain_turns else "none")
        else:
            coverage, chain_turns = index.chain(file["path"], file["head_blob"], file["base_blob"])
        if coverage == "none":
            chain_turns = index.touched(file["path"])
            if chain_turns:
                coverage = "edited"
        for turn in chain_turns:
            used_turns[(turn["session_id"], turn["turn_index"])] = turn
        rows.append({**{k: file[k] for k in ("path", "old_path", "status", "additions", "deletions", "binary")},
                     "coverage": coverage,
                     "turns": [{"session_id": turn["session_id"], "turn_index": turn["turn_index"]} for turn in chain_turns]})
    totals = {"files": len(rows), "covered": sum(1 for row in rows if row["coverage"] == "covered"),
              "partial": sum(1 for row in rows if row["coverage"] == "partial"),
              "edited": sum(1 for row in rows if row["coverage"] == "edited")}
    return {"head": head, "base": merge_base, "files": rows, "totals": totals, "turns": list(used_turns.values()),
            "truncated": truncated}
