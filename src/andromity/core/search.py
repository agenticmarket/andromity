import fnmatch
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import List, Optional, Set

from andromity.core.debug_log import get_logger

log = get_logger("search")

DEFAULT_EXCLUDED_DIRS: Set[str] = {
    "node_modules",
    ".venv",
    "venv",
    "env",
    ".env",
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    "target",
    "vendor",
    "coverage",
    ".tox",
    ".idea",
    ".vscode",
    ".andromity",
    "site-packages",
}

DEFAULT_EXCLUDED_EXTENSIONS: Set[str] = {
    ".pyc", ".pyo", ".pyd", ".exe", ".dll", ".so", ".dylib", ".bin",
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf",
    ".zip", ".tar", ".gz", ".7z", ".rar", ".db", ".sqlite", ".sqlite3",
    ".wasm", ".map", ".min.js", ".min.css", ".bundle.js",
}

DEFAULT_EXCLUDED_FILES: Set[str] = {
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "poetry.lock",
    "Cargo.lock",
    "composer.lock",
}

MAX_LINE_CHARS = 250


def _truncate_line(line: str, max_chars: int = MAX_LINE_CHARS) -> str:
    """Truncate long single-line matches to prevent token overflow."""
    line = line.rstrip("\r\n")
    if len(line) > max_chars:
        return line[:max_chars] + f" ... [truncated {len(line) - max_chars} chars]"
    return line


def _is_excluded_path(p: Path, root: Path) -> bool:
    """Check whether a given path should be skipped."""
    try:
        rel = p.relative_to(root)
    except ValueError:
        rel = p

    for part in rel.parts:
        if part in DEFAULT_EXCLUDED_DIRS:
            return True
        if part.startswith(".") and part not in (".", "..", ".andromity"):
            return True

    name = p.name
    if name in DEFAULT_EXCLUDED_FILES:
        return True

    suffix = p.suffix.lower()
    if suffix in DEFAULT_EXCLUDED_EXTENSIONS:
        return True

    if name.endswith(".min.js") or name.endswith(".min.css") or name.endswith(".bundle.js"):
        return True

    return False


def grep_search(
    query: str,
    path: str = ".",
    case_sensitive: bool = False,
    file_pattern: Optional[str] = None,
    max_results: int = 50,
    multiline: bool = False,
) -> str:
    """
    Search for a text pattern across the codebase.
    Uses ripgrep (`rg`) -> `git grep` -> Python fallback.
    Automatically respects .gitignore and ignores heavy/cache folders.
    """
    if not query.strip():
        return "Error: query cannot be empty."

    search_path = Path(path).resolve()
    if not search_path.exists():
        return f"Error: Path '{path}' does not exist."

    # 1. Try ripgrep (Tier 1 - fastest)
    if shutil.which("rg"):
        try:
            cmd = [
                "rg",
                "--line-number",
                "--no-heading",
                "--color=never",
                f"--max-count={max_results * 2}",
            ]
            if multiline:
                cmd.append("-U")
                cmd.append("--multiline-dotall")
            if not case_sensitive:
                cmd.append("-i")
            for exc in DEFAULT_EXCLUDED_DIRS:
                cmd.extend(["--glob", f"!**/{exc}/**"])
                cmd.extend(["--glob", f"!{exc}"])
            for exc_f in DEFAULT_EXCLUDED_FILES:
                cmd.extend(["--glob", f"!**/{exc_f}"])
            for ext in DEFAULT_EXCLUDED_EXTENSIONS:
                cmd.extend(["--glob", f"!*{ext}"])
            if file_pattern:
                cmd.extend(["--glob", file_pattern])

            cmd.extend([query, str(search_path)])
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10, errors="replace")
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().splitlines()
                return _format_grep_output(lines, search_path, max_results)
            elif result.returncode == 1:
                return f"No matches found for '{query}' in {path}."
        except Exception as e:
            log.warning("rg search failed, falling back: %s", e)

    # 2. Try git grep (Tier 2 - fast git index)
    if shutil.which("git") and ((search_path / ".git").exists() or _is_git_worktree(search_path)):
        try:
            cmd = ["git", "grep", "-n", "-I"]
            if not case_sensitive:
                cmd.append("-i")
            cmd.extend([query, "--"])
            if file_pattern:
                cmd.append(file_pattern)
            else:
                cmd.append(".")
            result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(search_path), timeout=10, errors="replace")
            if result.returncode == 0 and result.stdout.strip():
                raw_lines = result.stdout.strip().splitlines()
                filtered = []
                for line in raw_lines:
                    parts = line.split(":", 2)
                    if len(parts) >= 2:
                        file_part = parts[0]
                        if not _is_excluded_path(Path(file_part), search_path):
                            filtered.append(line)
                if filtered:
                    return _format_grep_output(filtered, search_path, max_results)
            elif result.returncode == 1:
                return f"No matches found for '{query}' in {path}."
        except Exception as e:
            log.warning("git grep failed, falling back: %s", e)

    # 3. Pure Python fallback (Tier 3)
    return _python_grep(query, search_path, case_sensitive, file_pattern, max_results)


def _is_git_worktree(path: Path) -> bool:
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            cwd=str(path),
            timeout=2,
        )
        return res.returncode == 0 and res.stdout.strip() == "true"
    except Exception:
        return False


def _python_grep(
    query: str,
    root: Path,
    case_sensitive: bool,
    file_pattern: Optional[str],
    max_results: int,
) -> str:
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        regex = re.compile(query, flags)
    except re.error:
        regex = re.compile(re.escape(query), flags)

    matches: List[str] = []

    for dirpath, dirnames, filenames in os.walk(root):
        current_dir = Path(dirpath)
        # Prune excluded directories in-place
        dirnames[:] = [
            d for d in dirnames
            if d not in DEFAULT_EXCLUDED_DIRS and not (d.startswith(".") and d != ".andromity")
        ]

        for fname in filenames:
            file_path = current_dir / fname
            if _is_excluded_path(file_path, root):
                continue
            if file_pattern and not fnmatch.fnmatch(fname, file_pattern):
                continue

            try:
                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    for line_num, line in enumerate(f, 1):
                        if regex.search(line):
                            try:
                                rel_file = file_path.relative_to(root)
                            except ValueError:
                                rel_file = file_path
                            trunc = _truncate_line(line)
                            matches.append(f"{rel_file}:{line_num}: {trunc.strip()}")
                            if len(matches) >= max_results:
                                break
            except Exception:
                continue

            if len(matches) >= max_results:
                break
        if len(matches) >= max_results:
            break

    if not matches:
        return f"No matches found for '{query}'."

    count_msg = f"Found {len(matches)} match{'es' if len(matches) != 1 else ''}"
    if len(matches) >= max_results:
        count_msg += f" (capped at {max_results})"
    return f"{count_msg}:\n" + "\n".join(matches)


def _format_grep_output(lines: List[str], root: Path, max_results: int) -> str:
    formatted: List[str] = []
    for raw_line in lines[:max_results]:
        parts = raw_line.split(":", 2)
        if len(parts) >= 3:
            file_part, line_no, content = parts[0], parts[1], parts[2]
            try:
                rel = Path(file_part).relative_to(root)
            except ValueError:
                rel = Path(file_part)
            formatted.append(f"{rel}:{line_no}: {_truncate_line(content).strip()}")
        else:
            formatted.append(_truncate_line(raw_line).strip())

    total = len(lines)
    count_msg = f"Found {min(total, max_results)} match{'es' if min(total, max_results) != 1 else ''}"
    if total > max_results:
        count_msg += f" (showing first {max_results} of {total})"
    return f"{count_msg}:\n" + "\n".join(formatted)


def find_files(pattern: str = "*", path: str = ".", max_results: int = 50, contains: Optional[str] = None) -> str:
    """
    Find files matching a glob pattern (e.g. `*.py`, `*test*`, `src/**/*.tsx`).
    If 'contains' is provided, only files containing that exact string will be returned.
    Excludes node_modules, .venv, .git, and other blacklisted directories.
    """
    root = Path(path).resolve()
    if not root.exists():
        return f"Error: Path '{path}' does not exist."

    matched_files: List[str] = []

    for dirpath, dirnames, filenames in os.walk(root):
        current_dir = Path(dirpath)
        # Prune excluded directories
        dirnames[:] = [
            d for d in dirnames
            if d not in DEFAULT_EXCLUDED_DIRS and not (d.startswith(".") and d != ".andromity")
        ]

        for fname in filenames:
            file_path = current_dir / fname
            if _is_excluded_path(file_path, root):
                continue

            try:
                rel_path = str(file_path.relative_to(root)).replace("\\", "/")
            except ValueError:
                rel_path = str(file_path).replace("\\", "/")

            if fnmatch.fnmatch(fname, pattern) or fnmatch.fnmatch(rel_path, pattern):
                matched_files.append(str(file_path))
                if len(matched_files) >= max_results:
                    break

        if len(matched_files) >= max_results:
            break

    # Apply contains filter
    if contains:
        filtered_files = []
        for f in matched_files:
            try:
                with open(f, "r", encoding="utf-8", errors="ignore") as file_handle:
                    if contains in file_handle.read():
                        filtered_files.append(f)
            except Exception:
                pass
        matched_files = filtered_files

    if not matched_files:
        msg = f"No files found matching pattern '{pattern}'"
        if contains:
            msg += f" and containing '{contains}'"
        return msg + f" in '{path}'."

    # Convert absolute paths back to relative for output
    results = []
    for f in matched_files:
        try:
            results.append(str(Path(f).relative_to(root)).replace("\\", "/"))
        except ValueError:
            results.append(f)

    count_msg = f"Found {len(results)} file{'s' if len(results) != 1 else ''}"
    if len(results) >= max_results:
        count_msg += f" (capped at {max_results})"
    return f"{count_msg}:\n" + "\n".join(sorted(results))
