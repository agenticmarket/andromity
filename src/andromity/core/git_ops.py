from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, List, TYPE_CHECKING

if TYPE_CHECKING:
    from git import Repo

SNAPSHOT_BRANCH = "andromity-snapshots"


def get_repo(path: Optional[Path] = None) -> Optional[Repo]:
    from git import Repo, InvalidGitRepositoryError, NoSuchPathError  # lazy
    if path is None:
        path = Path.cwd()
    try:
        return Repo(path, search_parent_directories=True)
    except (InvalidGitRepositoryError, NoSuchPathError):
        return None


def create_pre_edit_snapshot(repo: Repo) -> Optional[str]:
    """
    Snapshot working tree state to shadow branch BEFORE any file modifications.
    Returns commit hash of snapshot, or None on failure.
    """
    from git.exc import GitCommandError
    try:
        # Check if repo has any commits
        try:
            head_commit = repo.head.commit.hexsha
        except (ValueError, AttributeError):
            # No commits yet - can't snapshot
            return None

        # Capture current state: if dirty, create stash commit; otherwise use head commit
        snapshot_hash = head_commit
        try:
            stash_hash = repo.git.stash("create")
            if stash_hash and "No local changes" not in stash_hash:
                snapshot_hash = stash_hash.strip()
        except (GitCommandError, Exception):
            snapshot_hash = head_commit

        # Ensure shadow branch exists
        try:
            repo.git.rev_parse(SNAPSHOT_BRANCH)
        except GitCommandError:
            repo.git.update_ref(f"refs/heads/{SNAPSHOT_BRANCH}", head_commit)

        # Point shadow branch to snapshot
        repo.git.update_ref(
            f"refs/heads/{SNAPSHOT_BRANCH}",
            snapshot_hash,
            m="andromity: pre-edit snapshot"
        )
        return snapshot_hash
    except (GitCommandError, Exception) as e:
        print(f"Warning: Failed to create git snapshot: {e}")
        return None


def restore_snapshot(repo: Repo, commit_hash: str) -> bool:
    from git.exc import GitCommandError
    try:
        repo.git.checkout("--force", commit_hash, "--", ".")
        repo.git.clean("-fd")
        return True
    except (GitCommandError, Exception) as e:
        print(f"Warning: Failed to restore snapshot: {e}")
        return False


def list_snapshots(repo: Repo, limit: int = 20) -> List[dict]:
    from git.exc import GitCommandError
    try:
        repo.git.rev_parse(SNAPSHOT_BRANCH)
    except (GitCommandError, Exception):
        return []
    try:
        log_output = repo.git.log(SNAPSHOT_BRANCH, f"-{limit}", "--format=%H|%ai|%s")
        snapshots = []
        for line in log_output.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split("|", 2)
            if len(parts) == 3:
                snapshots.append({"hash": parts[0], "date": parts[1], "message": parts[2]})
        return snapshots
    except (GitCommandError, Exception):
        return []


def get_git_status(repo: Repo) -> dict:
    from git.exc import GitCommandError
    try:
        status = {}
        for item in repo.index.diff(None):
            status[item.a_path] = item.change_type
        for item in repo.index.diff("HEAD"):
            status[item.a_path] = item.change_type
        for path in repo.untracked_files:
            status[path] = "U"
        return status
    except (GitCommandError, Exception):
        return {}


def get_current_branch(repo: Repo) -> str:
    try:
        return repo.active_branch.name
    except Exception:
        return "HEAD"


def get_file_diff(repo: Repo, rel_path: str) -> str:
    """Get git diff for a specific relative file path vs HEAD or unstaged changes."""
    from git.exc import GitCommandError
    try:
        norm_path = rel_path.replace("\\", "/")
        # Try diff vs HEAD first
        try:
            diff = repo.git.diff("HEAD", "--", norm_path)
            if diff:
                return diff
        except (GitCommandError, Exception):
            pass

        # Try unstaged diff
        diff = repo.git.diff("--", norm_path)
        if diff:
            return diff

        # If untracked, read current content
        if norm_path in repo.untracked_files:
            try:
                full_path = Path(repo.working_tree_dir) / norm_path
                with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                return f"--- /dev/null\n+++ b/{norm_path}\n@@ -0,0 +1,{len(content.splitlines())} @@\n" + "\n".join(f"+{line}" for line in content.splitlines())
            except Exception:
                pass
        return ""
    except Exception:
        return ""

