from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional, List, Union, TYPE_CHECKING

if TYPE_CHECKING:
    from git import Repo

log = logging.getLogger("andromity.git_ops")
SNAPSHOT_BRANCH = "andromity-snapshots"


def get_repo(path: Optional[Path] = None) -> Optional["Repo"]:
    from git import Repo, InvalidGitRepositoryError, NoSuchPathError  # lazy
    if path is None:
        path = Path.cwd()
    try:
        return Repo(path, search_parent_directories=True)
    except (InvalidGitRepositoryError, NoSuchPathError):
        return None


def ensure_git_tracking(project_path: Path) -> tuple["Repo", bool]:
    """
    Ensure the project folder has a git repo.
    If none exists, initialise one with a sensible .gitignore and an
    initial 'andromity: baseline' commit so snapshots always work.

    Returns (repo, was_just_created).
    """
    from git import Repo, InvalidGitRepositoryError, NoSuchPathError

    # Already inside a git repo — nothing to do.
    try:
        repo = Repo(project_path, search_parent_directories=True)
        return repo, False
    except (InvalidGitRepositoryError, NoSuchPathError):
        pass

    # Init a new repo and create an initial commit as the baseline.
    repo = Repo.init(project_path)

    # Write a sensible .gitignore so large build/cache dirs aren't tracked.
    gitignore = project_path / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text(
            "# Andromity — auto-generated .gitignore\n"
            "__pycache__/\n*.pyc\n*.pyo\n"
            "venv/\n.venv/\nenv/\n"
            "node_modules/\n.next/\ndist/\nbuild/\n"
            ".env\n.env.*\n"
            "*.db\n*.sqlite\n"
            ".DS_Store\n",
            encoding="utf-8",
        )

    # Stage everything and create baseline commit.
    try:
        repo.git.add("-A")
        repo.index.commit("andromity: baseline snapshot")
    except Exception:
        pass

    return repo, True


def create_pre_edit_snapshot(repo_or_path: Union["Repo", Path, str]) -> Optional[str]:
    """
    Snapshot the FULL working tree state (tracked + untracked) before any
    file modifications, using a temporary git index so the user's staging
    area is never touched.

    Returns a commit hash stored on the andromity-snapshots shadow branch,
    or None on failure.
    """
    import os, tempfile
    from git.exc import GitCommandError
    try:
        if isinstance(repo_or_path, (str, Path)):
            repo = get_repo(Path(repo_or_path))
        else:
            repo = repo_or_path

        if not repo:
            return None

        # Need at least one commit for commit-tree to work.
        try:
            head_commit = repo.head.commit.hexsha
        except (ValueError, AttributeError):
            return None  # brand new empty repo with no commits yet

        work_dir = Path(repo.working_tree_dir)

        # ── Build a tree that includes untracked files ──────────────────────
        # We use a temp index file so the user's real staging area is untouched.
        tmp_fd, tmp_index = tempfile.mkstemp(prefix="andromity-idx-")
        try:
            os.close(tmp_fd)
            # Remove the 0-byte file so git initializes a fresh index without 'smaller than expected' error
            try:
                os.unlink(tmp_index)
            except OSError:
                pass
            env = {**os.environ, "GIT_INDEX_FILE": tmp_index}
            # Stage everything (tracked + untracked) into the temp index.
            repo.git.execute(["git", "add", "-A"], env=env)
            # Write the tree from the temp index.
            tree_hash = repo.git.execute(["git", "write-tree"], env=env).strip()
        finally:
            try:
                os.unlink(tmp_index)
            except OSError:
                pass

        # ── Create a real commit object on the shadow branch ────────────────
        # Ensure shadow branch exists.
        try:
            repo.git.rev_parse(SNAPSHOT_BRANCH)
        except GitCommandError:
            repo.git.update_ref(f"refs/heads/{SNAPSHOT_BRANCH}", head_commit)

        snap_hash = repo.git.commit_tree(
            tree_hash,
            "-p", head_commit,
            "-m", "andromity: pre-turn snapshot",
        ).strip()

        repo.git.update_ref(f"refs/heads/{SNAPSHOT_BRANCH}", snap_hash)
        return snap_hash

    except Exception as e:
        log.warning("Failed to create snapshot: %s", e)
        return None


def restore_snapshot(repo: "Repo", commit_hash: str, files: Optional[List[str]] = None) -> bool:
    """
    Restore working tree to snapshot state.

    If `files` is provided, only those relative paths are restored (surgical).
    Otherwise ALL files tracked in the snapshot are restored.

    Uses restore_file_snapshot per-file so newly-created files (which
    git checkout cannot restore) are deleted rather than left on disk.
    NEVER runs git-clean, which would nuke unrelated files.
    """
    from git.exc import GitCommandError
    try:
        if files:
            for rel in files:
                restore_file_snapshot(repo, commit_hash, rel)
            return True

        # Restore all files that exist in the snapshot tree.
        try:
            changed = repo.git.diff(
                "--name-only", commit_hash, "HEAD"
            ).splitlines()
        except (GitCommandError, Exception):
            changed = []

        if changed:
            for rel in changed:
                restore_file_snapshot(repo, commit_hash, rel)
        else:
            # Nothing tracked changed — just do a fast checkout.
            repo.git.checkout("--force", commit_hash, "--", ".")
        return True
    except Exception as e:
        log.warning("Failed to restore snapshot: %s", e)
        return False


def restore_file_snapshot(repo: Repo, commit_hash: str, rel_path: str) -> bool:
    """Restores a single file from a snapshot. If it didn't exist then, deletes it."""
    from git.exc import GitCommandError
    try:
        norm_path = rel_path.replace("\\", "/")
        try:
            repo.git.checkout("--force", commit_hash, "--", norm_path)
            return True
        except GitCommandError:
            # File likely didn't exist in the snapshot (it was newly created).
            # git checkout fails for untracked paths, so we must manually delete it.
            full_path = Path(repo.working_tree_dir) / norm_path
            if full_path.exists():
                full_path.unlink(missing_ok=True)
            return True
    except Exception as e:
        log.warning("Failed to restore file %s from snapshot: %s", rel_path, e)
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
        # Unstaged changes (Index vs Working tree)
        for item in repo.index.diff(None):
            if item.a_path:
                status[item.a_path.replace("\\", "/")] = item.change_type
        # Staged changes (HEAD vs Index)
        try:
            for item in repo.head.commit.diff():
                path = item.b_path or item.a_path
                if path:
                    status[path.replace("\\", "/")] = item.change_type
        except (ValueError, AttributeError):
            # Brand new repo with no commits yet — all staged files are 'A'
            for entry in getattr(repo.index, "entries", {}).keys():
                path = entry[0] if isinstance(entry, tuple) else str(entry)
                if path:
                    status[path.replace("\\", "/")] = "A"
        for path in repo.untracked_files:
            if path:
                status[path.replace("\\", "/")] = "U"
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


def ensure_gitignore_entry(project_path: str, pattern: str) -> None:
    """Idempotently add `pattern` to <project_path>/.gitignore.
    Never raises — best-effort only."""
    try:
        gi = Path(project_path) / ".gitignore"
        existing = gi.read_text(encoding="utf-8") if gi.exists() else ""
        lines = existing.splitlines()
        # Already present (exact or trailing slash variants)
        normalised = pattern.rstrip("/")
        for line in lines:
            if line.strip().rstrip("/") == normalised:
                return
        # Append with a blank separator if file is non-empty and doesn't end with newline
        sep = "\n" if existing and not existing.endswith("\n") else ""
        with gi.open("a", encoding="utf-8") as f:
            f.write(f"{sep}{pattern}\n")
    except Exception:
        pass
