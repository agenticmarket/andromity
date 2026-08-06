import os
from pathlib import Path
from typing import Optional, List

from git import Repo, InvalidGitRepositoryError, GitCommandError, NoSuchPathError

SNAPSHOT_BRANCH = "andromity-snapshots"


def get_repo(path: Optional[Path] = None) -> Optional[Repo]:
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
    try:
        # Check if repo has any commits
        try:
            repo.head.commit.hexsha
        except (ValueError, AttributeError):
            # No commits yet - can't snapshot
            return None

        # Create a temporary index to capture current state
        import tempfile
        with tempfile.NamedTemporaryFile(delete=False) as tmp_index:
            tmp_index_path = tmp_index.name

        try:
            # Write current index to temp file
            repo.git.write_tree()
            # Use stash to capture state
            stash_hash = repo.git.stash("create")
            if not stash_hash or "No local changes" in stash_hash:
                snapshot_hash = repo.head.commit.hexsha
            else:
                snapshot_hash = stash_hash
        finally:
            try:
                os.unlink(tmp_index_path)
            except OSError:
                pass

        # Ensure shadow branch exists
        try:
            repo.git.rev_parse(SNAPSHOT_BRANCH)
        except GitCommandError:
            repo.git.update_ref(f"refs/heads/{SNAPSHOT_BRANCH}", repo.head.commit.hexsha)

        # Point shadow branch to snapshot
        repo.git.update_ref(
            f"refs/heads/{SNAPSHOT_BRANCH}",
            snapshot_hash,
            m="andromity: pre-edit snapshot"
        )
        return snapshot_hash
    except GitCommandError as e:
        print(f"Warning: Failed to create git snapshot: {e}")
        return None


def restore_snapshot(repo: Repo, commit_hash: str) -> bool:
    try:
        repo.git.checkout("--force", commit_hash, "--", ".")
        repo.git.clean("-fd")
        return True
    except GitCommandError as e:
        print(f"Warning: Failed to restore snapshot: {e}")
        return False


def list_snapshots(repo: Repo, limit: int = 20) -> List[dict]:
    try:
        repo.git.rev_parse(SNAPSHOT_BRANCH)
    except GitCommandError:
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
    except GitCommandError:
        return []


def get_git_status(repo: Repo) -> dict:
    try:
        status = {}
        for item in repo.index.diff(None):
            status[item.a_path] = item.change_type
        for item in repo.index.diff("HEAD"):
            status[item.a_path] = item.change_type
        for path in repo.untracked_files:
            status[path] = "U"
        return status
    except GitCommandError:
        return {}


def get_current_branch(repo: Repo) -> str:
    try:
        return repo.active_branch.name
    except TypeError:
        return "HEAD"
