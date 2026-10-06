from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Callable, Optional, List, Union, TYPE_CHECKING

if TYPE_CHECKING:
    from git import Repo

log = logging.getLogger("andromity.git_ops")
SNAPSHOT_BRANCH = "andromity-snapshots"


async def run_restoration(function: Callable[..., Any], *args: Any) -> Any:
    """Keep restoration ownership until the underlying filesystem worker finishes."""
    import asyncio
    worker = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if worker.done() and not worker.cancelled():
            worker.exception()
        raise


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


def create_pre_edit_snapshot(
    repo_or_path: Union["Repo", Path, str],
    target_files: Optional[List[str]] = None,
) -> Optional[str]:
    """
    Snapshot the working tree state before file modifications, using a temporary
    git index so the user's staging area is never touched.

    If target_files is provided, stages only those specific files to avoid
    scanning the entire workspace (reducing write latency and isolating edits and unwanted tracking).

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
        scope = Path(repo_or_path).resolve() if isinstance(repo_or_path, (str, Path)) else work_dir.resolve()

        # Base commit: use latest snapshot on shadow branch if present, else HEAD
        try:
            snap_base = repo.git.rev_parse(f"refs/heads/{SNAPSHOT_BRANCH}").strip()
        except (GitCommandError, Exception):
            snap_base = head_commit

        # ── Build a tree (targeted or full) ────────────────────────────────
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
            if target_files:
                repo.git.execute(["git", "read-tree", head_commit], env=env)
                rel_targets = []
                resolved_work = work_dir.resolve()
                for tf in target_files:
                    try:
                        p = Path(tf)
                        if not p.is_absolute():
                            p = (resolved_work / p).resolve()
                        else:
                            p = p.resolve()
                        rel_targets.append(p.relative_to(resolved_work).as_posix())
                    except (ValueError, Exception):
                        continue
                if rel_targets:
                    repo.git.execute(["git", "add", "-A", "--"] + [":(literal)" + name for name in rel_targets], env=env)
            else:
                # A workspace can be a subfolder of a larger repository.
                if scope != work_dir.resolve():
                    repo.git.execute(["git", "read-tree", head_commit], env=env)
                    repo.git.execute(["git", "add", "-A", "--", ":(literal)" + scope.relative_to(work_dir.resolve()).as_posix()], env=env)
                else:
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
            "-p", snap_base,
            "-m", "andromity: pre-turn snapshot",
        ).strip()

        repo.git.update_ref(f"refs/heads/{SNAPSHOT_BRANCH}", snap_hash)
        return snap_hash

    except Exception as e:
        log.warning("Failed to create snapshot: %s", e)
        return None


def repository_path(repo: "Repo", file_path: str) -> tuple[Path, str]:
    """Resolve one repository file, rejecting traversal, metadata and symlink escapes."""
    root = Path(repo.working_tree_dir).resolve()
    candidate = Path(file_path)
    if not file_path or candidate == Path("."):
        raise ValueError("Choose a repository file.")
    if not candidate.is_absolute():
        candidate = root / candidate
    lexical = Path(os.path.abspath(candidate))
    try:
        rel = lexical.relative_to(root)
        lexical.parent.resolve().relative_to(root)
    except ValueError as exc:
        raise ValueError("File must be inside the repository.") from exc
    if not rel.parts or any(part.lower() == ".git" for part in rel.parts):
        raise ValueError("Git metadata cannot be reviewed or reverted.")
    if lexical.is_symlink():
        raise ValueError("Symbolic links cannot be reverted through Changes Review.")
    return lexical, rel.as_posix()


def status_entries(repo: "Repo") -> list[dict]:
    raw = repo.git.execute(["git", "status", "--porcelain=v1", "-z", "-uall"], stdout_as_string=False)
    parts = raw.decode("utf-8", errors="surrogateescape").split("\0")
    entries = []
    i = 0
    while i < len(parts):
        item = parts[i]
        i += 1
        if len(item) < 4:
            continue
        code, name = item[:2], item[3:]
        entry = {"path": name, "status": "!" if code in ("UU", "AA", "DD", "AU", "UA", "DU", "UD") else "U" if code == "??" else
                 "D" if "D" in code else "R" if "R" in code else
                 "A" if "A" in code else "C" if "C" in code else
                 "M",
                 "index_status": code[0], "worktree_status": code[1]}
        if "R" in code or "C" in code:
            entry["original_path"] = parts[i]
            i += 1
        entries.append(entry)
    return entries


def restore_snapshot(repo: "Repo", commit_hash: str, files: Optional[List[str]] = None) -> bool:
    """Restore worktree files only; preserve HEAD and the user's staging area."""
    try:
        commit = repo.commit(commit_hash)
        if files is None:
            # Compatibility for explicit full restores. Session undo passes recorded paths.
            current = [entry["path"] for entry in status_entries(repo)]
            snapshot = repo.git.ls_tree("-rz", "--name-only", commit.hexsha).split("\0")
            files = list(dict.fromkeys([*current, *(name for name in snapshot if name)]))
        paths = [repository_path(repo, name)[1] for name in files]
        # Validate every path before modifying any file.
        for rel in paths:
            if not restore_file_snapshot(repo, commit.hexsha, rel):
                return False
        return True
    except Exception as exc:
        log.warning("Failed to restore snapshot: %s", exc)
        return False


def restore_file_snapshot(repo: "Repo", commit_hash: str, rel_path: str) -> bool:
    from git.exc import GitCommandError
    try:
        full_path, rel = repository_path(repo, rel_path)
        commit = repo.commit(commit_hash)
        try:
            commit.tree / rel
        except KeyError:
            if full_path.is_dir():
                return False
            full_path.unlink(missing_ok=True)
            parent = full_path.parent
            root = Path(repo.working_tree_dir).resolve()
            while parent != root and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
        else:
            repo.git.restore("--source=" + commit.hexsha, "--worktree", "--", ":(literal)" + rel)
        return True
    except (GitCommandError, OSError, ValueError) as exc:
        log.warning("Failed to restore file %s: %s", rel_path, exc)
        return False


def rollback_recorded_turns(repo: "Repo", records: list[dict], project_path: Optional[str] = None) -> bool:
    """Restore only recorded turn changes, refusing to overwrite subsequent user edits."""
    if not records or any(not record.get("after_hash") for record in records):
        return False
    expected: dict[str, str] = {}
    for record in records:
        names = repo.git.diff("--name-only", "--no-renames", "-z", record["snapshot_hash"], record["after_hash"]).split("\0")
        for name in filter(None, names):
            if project_path and not (Path(repo.working_tree_dir) / name).resolve().is_relative_to(Path(project_path).resolve()):
                continue
            expected[name] = record["after_hash"]
    for name, after_hash in expected.items():
        full, rel = repository_path(repo, name)
        tree = repo.commit(after_hash).tree
        try:
            blob = tree / rel
        except KeyError:
            if full.exists():
                return False
        else:
            if not full.is_file():
                return False
            if full.read_bytes() != blob.data_stream.read() and repo.git.hash_object("--path=" + rel, "--", str(full)).strip() != blob.hexsha:
                return False
    return restore_snapshot(repo, records[0]["snapshot_hash"], list(expected))


def checkpoint_changed_files(repo: "Repo", record: dict, project_path: str) -> list[str]:
    project = Path(project_path).resolve()
    names = repo.git.diff("--name-only", "--no-renames", "-z", record["snapshot_hash"], record["after_hash"]).split("\0")
    return [(Path(repo.working_tree_dir) / name).resolve().relative_to(project).as_posix()
            for name in names if name and (Path(repo.working_tree_dir) / name).resolve().is_relative_to(project)]


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
    try:
        status = {}
        # Single efficient porcelain status call with -unormal (prevents crawling every single file in subdirs)
        output = repo.git.status("--porcelain", "-unormal")
        for line in output.splitlines():
            if len(line) < 4:
                continue
            x = line[0]
            y = line[1]
            path = line[3:].strip().replace("\\", "/")
            if " -> " in path:
                path = path.split(" -> ")[-1]
            if x == "?" and y == "?":
                status[path] = "U"
            elif x in ("M", "A", "D", "R", "C") or y in ("M", "A", "D", "R", "C"):
                status[path] = y if y != " " else x
        return status
    except Exception:
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
        try:
            untracked = repo.git.ls_files("--others", "--exclude-standard", "--", norm_path)
            if untracked.strip():
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


def ensure_clean_project_andromity(project_path: str) -> None:
    """Ensure .andromity/ is gitignored in the project root and create an internal
    .andromity/.gitignore to prevent transient logs and cron outputs from polluting Git."""
    try:
        p = Path(project_path).resolve()
        if not p.is_dir():
            return
        # 1. Ensure project root .gitignore ignores .andromity/
        ensure_gitignore_entry(str(p), ".andromity/")

        # 2. If .andromity exists, ensure internal .gitignore ignores temporary runtime artifacts
        andromity_dir = p / ".andromity"
        if andromity_dir.exists() and andromity_dir.is_dir():
            internal_gi = andromity_dir / ".gitignore"
            if not internal_gi.exists():
                internal_gi.write_text(
                    "# Ignore transient session and cron runtime logs\n"
                    "cron_runs/\n"
                    "handoffs/\n"
                    "*.tmp\n"
                    "*.lock\n"
                    "*.log\n"
                    "__pycache__/\n",
                    encoding="utf-8"
                )
    except Exception:
        pass

