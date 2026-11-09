"""Consistent HEAD-to-worktree review data and bounded file operations."""
from pathlib import Path
from typing import Any

from andromity.core.git_ops import (
    NO_REPO_PROGRAMS,
    list_snapshots,
    repository_path,
    safe_git_command,
    status_entries,
    uses_disabled_filter,
)

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


def review_base(repo: Any) -> str:
    from git.exc import GitCommandError
    try:
        repo.git.rev_parse("--verify", "HEAD")
        return "HEAD"
    except GitCommandError:
        return EMPTY_TREE


def show_file(repo: Any, path: str, ref: str = "HEAD") -> str:
    _, rel = repository_path(repo, path)
    if ref == "EMPTY" or (ref == "HEAD" and not repo.head.is_valid()):
        return ""
    if ref == "INDEX":
        return repo.git.execute(["git", *NO_REPO_PROGRAMS, "show", ":" + rel])
    if ref == "SNAPSHOT":
        snapshots = list_snapshots(repo, limit=1)
        if not snapshots:
            return ""
        ref = snapshots[0]["hash"]
    commit = repo.commit(ref)
    try:
        return (commit.tree / rel).data_stream.read().decode("utf-8", errors="replace")
    except KeyError:
        return ""


def file_diff(repo: Any, path: str) -> dict:
    full, rel = repository_path(repo, path)
    if full.is_file() and full.stat().st_size > 1_000_000:
        return {"diff": "", "notice": "Large file. Open the native diff to review it."}
    diff = repo.git.execute([*_worktree_diff(repo), review_base(repo), "--", ":(literal)" + rel])
    if not diff and any(e["path"] == rel and e["status"] == "U" for e in status_entries(repo)):
        data = full.read_bytes()
        if b"\0" in data[:4096]:
            return {"diff": "", "notice": "Binary file. Text preview is unavailable."}
        lines = data.decode("utf-8", errors="replace").splitlines()
        if lines:
            diff = f"--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{len(lines)} @@\n" + "\n".join("+" + line for line in lines)
        else:
            return {"diff": "", "notice": "Empty new file."}
    if "GIT binary patch" in diff or "Binary files " in diff:
        return {"diff": "", "notice": "Binary file changed. Open the native diff to review it."}
    if len(diff) > 2_000_000:
        return {"diff": "", "notice": "Large diff. Open the native diff to review it."}
    if diff and "@@ " not in diff:
        return {"diff": "", "notice": "Git metadata or submodule changed. Open the native diff to review it."}
    return {"diff": diff, "base": "HEAD"}


def _worktree_diff(repo: Any) -> list[str]:
    return [*safe_git_command(repo), "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=dirty"]


def full_diff(repo: Any) -> str:
    """Every working-tree change against HEAD, for "view all changes" and commit messages."""
    return repo.git.execute([*_worktree_diff(repo), review_base(repo)])


def numstat(repo: Any) -> dict:
    raw = repo.git.execute([*_worktree_diff(repo), "--numstat", "-z", review_base(repo)], stdout_as_string=False)
    stats: dict[str, dict] = {}
    for item in raw.decode("utf-8", errors="surrogateescape").split("\0"):
        if not item:
            continue
        add, delete, name = item.split("\t", 2)
        stats[name] = {"additions": int(add) if add.isdigit() else 0,
                       "deletions": int(delete) if delete.isdigit() else 0, "binary": add == "-"}
    for entry in status_entries(repo):
        if entry["status"] != "U":
            continue
        try:
            full, rel = repository_path(repo, entry["path"])
        except ValueError:
            stats[entry["path"]] = {"additions": 0, "deletions": 0, "omitted": True}
            continue
        value: dict[str, Any] = {"additions": 0, "deletions": 0}
        if full.is_file():
            if full.stat().st_size > 500_000:
                value["omitted"] = True
            else:
                data = full.read_bytes()
                if b"\0" in data[:4096]:
                    value["binary"] = True
                else:
                    value["additions"] = len(data.splitlines())
        stats[rel] = value
    return stats


def revert_file(repo: Any, path: str) -> dict:
    full, rel = repository_path(repo, path)
    if full.is_dir():
        raise ValueError("Choose a file. Directory deletion is not supported.")
    entry = next((e for e in status_entries(repo) if e["path"] == rel), None)
    if entry and entry["status"] == "!":
        raise ValueError("Resolve this merge conflict in Git before discarding changes.")
    original = repository_path(repo, entry["original_path"])[1] if entry and entry.get("original_path") else None
    for name in filter(None, (rel, original)):
        driver = uses_disabled_filter(repo, name)
        if driver:
            raise ValueError(f"This file uses the git filter '{driver}'. Andromity doesn't run git filter "
                             "programs, so discard this change with git.")
    git = safe_git_command(repo)
    if original:
        repo.git.execute([*git, "restore", "--source=HEAD", "--staged", "--worktree", "--", ":(literal)" + original])
    try:
        in_head = repo.head.is_valid() and (repo.head.commit.tree / rel) is not None
    except KeyError:
        in_head = False
    if in_head:
        repo.git.execute([*git, "restore", "--source=HEAD", "--staged", "--worktree", "--", ":(literal)" + rel])
        return {"success": True, "action": "checkout", "path": rel}
    if repo.git.execute(["git", *NO_REPO_PROGRAMS, "ls-files", "--", ":(literal)" + rel]).strip():
        repo.git.execute([*git, "rm", "--cached", "--force", "--", ":(literal)" + rel])
    full.unlink(missing_ok=True)
    return {"success": True, "action": "deleted", "path": rel}
