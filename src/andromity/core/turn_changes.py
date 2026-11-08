"""What one turn changed, read from the snapshots taken before and after it, so a turn stays reviewable after its
files are committed, pushed or edited again."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from andromity.core.git_ops import repository_path, safe_git_command, uses_disabled_filter

_OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
MAX_FILES = 500
MAX_DIFF = 2_000_000


class TurnChangesUnavailable(Exception):
    """A plain reason the turn's changes can't be shown."""


def _record(session: Any, turn_index: int) -> Dict[str, Any]:
    records = [r for r in (getattr(session, "undo_stack", None) or [])
               if isinstance(r, dict) and r.get("turn_index") == turn_index and not isinstance(r.get("turn_index"), bool)]
    if not records:
        raise TurnChangesUnavailable("This turn's snapshots are gone: it was undone, or it changed no files in a git repository.")
    record = records[-1]
    if not isinstance(record.get("after_hash"), str) or not record["after_hash"]:
        raise TurnChangesUnavailable("This turn hasn't finished yet.")
    for key in ("snapshot_hash", "after_hash"):
        if not _OBJECT_ID.fullmatch(str(record.get(key) or "")):
            raise TurnChangesUnavailable("This turn's snapshot record is damaged, so its changes can't be shown.")
    return record


def _scope(repo: Any, project: Path) -> List[str]:
    root = Path(repo.working_tree_dir).resolve()
    return [] if project == root else ["--", ":(literal)" + project.relative_to(root).as_posix()]


def _names(repo: Any, git: List[str], a: str, b: str, scope: List[str]) -> set:
    raw = repo.git.execute([*git, "diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", a, b, *scope])
    return {name for name in raw.split("\0") if name}


def _working_tree(repo: Any, git: List[str], scope: List[str]) -> str:
    """A tree of the files as they are now, built in a temporary index so the real staging area is untouched."""
    fd, index = tempfile.mkstemp(prefix="andromity-idx-")
    os.close(fd)
    try:
        os.unlink(index)
        env = {**os.environ, "GIT_INDEX_FILE": index}
        repo.git.execute([*git, "read-tree", "HEAD"], env=env)
        paths = scope[1:] if scope else ["."]
        repo.git.execute([*git, "add", "-A", "--", *paths], env=env)
        return repo.git.execute([*git, "write-tree"], env=env).strip()
    finally:
        try:
            os.unlink(index)
        except OSError:
            pass


def _counts(raw: str) -> Dict[str, tuple]:
    counts = {}
    for chunk in raw.split("\0"):
        fields = chunk.strip("\n").split("\t", 2)
        if len(fields) == 3 and fields[2]:
            counts[fields[2]] = (int(fields[0]) if fields[0].isdigit() else None, int(fields[1]) if fields[1].isdigit() else None)
    return counts


def turn_changes(session: Any, turn_index: int, repo: Any) -> Dict[str, Any]:
    """The files one turn changed, with line counts and where each stands now:
    "uncommitted" (still as the turn left it, not committed), "committed" (as the turn left it and committed),
    or "changed" (edited again since the turn)."""
    record = _record(session, turn_index)
    before, after = record["snapshot_hash"], record["after_hash"]
    project = Path(str(getattr(session, "project_path", "") or ".")).resolve()
    git = safe_git_command(repo)
    scope = _scope(repo, project)
    flags = ["--no-renames", "--no-ext-diff", "--no-textconv", "-z"]
    try:
        status_raw = repo.git.execute([*git, "diff", "--name-status", *flags, before, after, *scope])
        numstat_raw = repo.git.execute([*git, "diff", "--numstat", *flags, before, after, *scope])
    except Exception as exc:
        raise TurnChangesUnavailable("This turn's snapshots are no longer in the repository.") from exc
    parts = status_raw.split("\0")
    statuses = [(parts[i + 1], parts[i].strip()[:1]) for i in range(0, len(parts) - 1, 2) if parts[i].strip() and parts[i + 1]]
    counts = _counts(numstat_raw)
    try:
        now = _working_tree(repo, git, scope)
        changed_since = _names(repo, git, after, now, scope)
    except Exception:
        changed_since = None
    try:
        not_committed = _names(repo, git, after, "HEAD", scope)
    except Exception:
        not_committed = None
    files = []
    for path, status in statuses[:MAX_FILES]:
        added, deleted = counts.get(path, (None, None))
        if changed_since is None or not_committed is None:
            where = "unknown"
        elif path in changed_since:
            where = "changed"
        elif path in not_committed:
            where = "uncommitted"
        else:
            where = "committed"
        files.append({"path": path, "status": status, "additions": added, "deletions": deleted,
                      "binary": added is None and deleted is None, "now": where})
    files.sort(key=lambda entry: entry["path"])
    return {"turn_index": turn_index, "files": files, "truncated": len(statuses) > MAX_FILES}


def _turn_path(session: Any, turn_index: int, path: Any, repo: Any) -> tuple:
    """The turn's record and git command, after checking the path is one this turn changed."""
    record = _record(session, turn_index)
    if not isinstance(path, str) or not path or "\0" in path or len(path) > 4096:
        raise TurnChangesUnavailable("Choose a file this turn changed.")
    git = safe_git_command(repo)
    project = Path(str(getattr(session, "project_path", "") or ".")).resolve()
    if path not in _names(repo, git, record["snapshot_hash"], record["after_hash"], _scope(repo, project)):
        raise TurnChangesUnavailable("This turn didn't change that file.")
    return record, git


def turn_file_diff(session: Any, turn_index: int, path: str, repo: Any) -> Dict[str, Any]:
    """One file's change in one turn: the diff between the turn's before and after snapshots."""
    record, git = _turn_path(session, turn_index, path, repo)
    diff = repo.git.execute([*git, "diff", "--no-renames", "--no-ext-diff", "--no-textconv",
                             record["snapshot_hash"], record["after_hash"], "--", ":(literal)" + path])
    if "GIT binary patch" in diff or "Binary files " in diff:
        return {"diff": "", "notice": "Binary file changed in this turn. Text preview is unavailable."}
    if len(diff) > MAX_DIFF:
        return {"diff": "", "notice": "This turn's diff of the file is too large to show here."}
    if diff and "@@ " not in diff:
        return {"diff": "", "notice": "Only the file's mode or type changed in this turn."}
    return {"diff": diff}


def _blob(repo: Any, git: List[str], commit: str, path: str) -> Optional[str]:
    try:
        return repo.git.execute([*git, "rev-parse", "--verify", "--quiet", f"{commit}:{path}"]).strip() or None
    except Exception:
        return None


def turn_revert_file(session: Any, turn_index: int, path: str, repo: Any) -> Dict[str, Any]:
    """Undoes one turn's change to one file: the file goes back to the turn's before snapshot, so edits made before
    the turn stay. Only while the file is still exactly as the turn left it; the staging area is not touched."""
    record, git = _turn_path(session, turn_index, path, repo)
    full, rel = repository_path(repo, path)
    if full.is_dir():
        raise TurnChangesUnavailable("Choose a file.")
    driver = uses_disabled_filter(repo, rel)
    if driver:
        raise TurnChangesUnavailable(f"This file uses the git filter '{driver}'. Andromity doesn't run git filter programs, so undo this change with git.")
    after_blob = _blob(repo, git, record["after_hash"], rel)
    if after_blob is None:
        if full.exists() or full.is_symlink():
            raise TurnChangesUnavailable("This file changed after the turn, so undoing the turn's change could lose later work.")
    else:
        if not full.is_file():
            raise TurnChangesUnavailable("This file changed after the turn, so undoing the turn's change could lose later work.")
        now_blob = repo.git.execute([*git, "hash-object", f"--path={rel}", "--", str(full)]).strip()
        if now_blob != after_blob:
            raise TurnChangesUnavailable("This file changed after the turn, so undoing the turn's change could lose later work.")
    if _blob(repo, git, record["snapshot_hash"], rel) is not None:
        repo.git.execute([*git, "restore", f"--source={record['snapshot_hash']}", "--worktree", "--", ":(literal)" + rel])
        return {"success": True, "action": "restored", "path": rel}
    full.unlink(missing_ok=True)
    return {"success": True, "action": "removed", "path": rel}
