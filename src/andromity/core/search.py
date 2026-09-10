import fnmatch
import os
import re
import shutil
import subprocess
import sys
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
    # Binary distribution folders — never search these
    "dist-server",
    "dist-test",
    "_internal",
    "bin",
    "benchmark",
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


def _expand_brace_pattern(pattern: Optional[str]) -> List[Optional[str]]:
    """Expand shell brace patterns like '*.{ts,tsx,js}' into ['*.ts', '*.tsx', '*.js'].
    If no braces, returns [pattern] unchanged."""
    if not pattern:
        return [pattern]
    import re as _re
    m = _re.match(r'^(.*?)\{([^}]+)\}(.*)$', pattern)
    if not m:
        return [pattern]
    prefix, alts, suffix = m.group(1), m.group(2), m.group(3)
    return [f"{prefix}{alt}{suffix}" for alt in alts.split(',')]


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

    # Expand brace patterns like *.{ts,tsx,js,jsx} → [*.ts, *.tsx, *.js, *.jsx]
    expanded_patterns = _expand_brace_pattern(file_pattern)

_RESOLVED_RG_PATH: Optional[str] = None
_RG_SEARCH_ATTEMPTED: bool = False


def ensure_ripgrep() -> Optional[str]:
    """
    Automatically download and install the official standalone ripgrep binary
    into ~/.andromity/bin/ so fast grep search is always available.
    """
    import platform
    import urllib.request
    import zipfile
    import tarfile

    user_bin = Path.home() / ".andromity" / "bin"
    user_bin.mkdir(parents=True, exist_ok=True)
    is_win = sys.platform == "win32"
    exe_name = "rg.exe" if is_win else "rg"
    target_exe = user_bin / exe_name

    if target_exe.is_file():
        return str(target_exe)

    machine = platform.machine().lower()
    rg_version = "14.1.1"

    if is_win:
        asset = f"ripgrep-{rg_version}-x86_64-pc-windows-msvc.zip"
    elif sys.platform == "darwin":
        arch_part = "aarch64" if "arm" in machine or "aarch64" in machine else "x86_64"
        asset = f"ripgrep-{rg_version}-{arch_part}-apple-darwin.tar.gz"
    else:
        arch_part = "aarch64" if "arm" in machine or "aarch64" in machine else "x86_64"
        asset = f"ripgrep-{rg_version}-{arch_part}-unknown-linux-musl.tar.gz"

    url = f"https://github.com/BurntSushi/ripgrep/releases/download/{rg_version}/{asset}"
    archive_path = user_bin / asset

    try:
        log.info("Downloading official ripgrep binary from %s ...", url)
        req = urllib.request.Request(url, headers={"User-Agent": "Andromity-Agent"})
        with urllib.request.urlopen(req, timeout=15) as resp, open(archive_path, "wb") as out_f:
            shutil.copyfileobj(resp, out_f)

        if asset.endswith(".zip"):
            with zipfile.ZipFile(archive_path, "r") as zf:
                for member in zf.namelist():
                    if member.endswith("rg.exe") or member == "rg.exe":
                        with zf.open(member) as src, open(target_exe, "wb") as dst:
                            shutil.copyfileobj(src, dst)
                        break
        elif asset.endswith(".tar.gz"):
            with tarfile.open(archive_path, "r:gz") as tf:
                for member in tf.getmembers():
                    if member.name.endswith("/rg") or member.name == "rg":
                        extracted = tf.extractfile(member)
                        if extracted:
                            with open(target_exe, "wb") as dst:
                                shutil.copyfileobj(extracted, dst)
                            os.chmod(target_exe, 0o755)
                        break

        if archive_path.exists():
            try:
                archive_path.unlink()
            except Exception:
                pass

        if target_exe.is_file():
            log.info("Ripgrep installed successfully to %s", target_exe)
            return str(target_exe)
    except Exception as e:
        log.warning("Could not auto-download ripgrep: %s", e)
        if archive_path.exists():
            try:
                archive_path.unlink()
            except Exception:
                pass

    return None


def find_ripgrep_path() -> Optional[str]:
    """
    Locate the ripgrep (`rg`) executable using multi-tier discovery:
    1. ANDROMITY_RG_PATH environment variable (injected by VS Code extension).
    2. System PATH via shutil.which("rg").
    3. User local directory ~/.andromity/bin/rg (or rg.exe).
    4. Bundled VS Code installation directories across Windows, macOS, and Linux.
    5. Auto-installer fallback (ensure_ripgrep).
    """
    global _RESOLVED_RG_PATH, _RG_SEARCH_ATTEMPTED
    if _RESOLVED_RG_PATH and os.path.isfile(_RESOLVED_RG_PATH):
        return _RESOLVED_RG_PATH

    # 1. Environment variable
    env_rg = os.environ.get("ANDROMITY_RG_PATH")
    if env_rg and os.path.isfile(env_rg):
        _RESOLVED_RG_PATH = env_rg
        return _RESOLVED_RG_PATH

    # 2. PATH
    which_rg = shutil.which("rg")
    if which_rg:
        _RESOLVED_RG_PATH = which_rg
        return _RESOLVED_RG_PATH

    # 3. User local bin (~/.andromity/bin)
    user_bin = Path.home() / ".andromity" / "bin"
    is_win = sys.platform == "win32"
    exe_name = "rg.exe" if is_win else "rg"
    local_rg = user_bin / exe_name
    if local_rg.is_file():
        _RESOLVED_RG_PATH = str(local_rg)
        return _RESOLVED_RG_PATH

    # 4. Probe known VS Code locations
    if is_win:
        import glob
        for base_env in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]:
            base = os.environ.get(base_env, "")
            if base:
                direct = (
                    Path(base)
                    / "Programs"
                    / "Microsoft VS Code"
                    / "resources"
                    / "app"
                    / "node_modules.asar.unpacked"
                    / "@vscode"
                    / "ripgrep-universal"
                    / "bin"
                    / "win32-x64"
                    / "rg.exe"
                )
                if direct.is_file():
                    _RESOLVED_RG_PATH = str(direct)
                    return _RESOLVED_RG_PATH
                pattern = os.path.join(base, "Programs", "Microsoft VS Code", "**", "node_modules.asar.unpacked", "**", "rg.exe")
                found = glob.glob(pattern, recursive=True)
                if found:
                    _RESOLVED_RG_PATH = found[0]
                    return _RESOLVED_RG_PATH
    elif sys.platform == "darwin":
        mac_candidates = [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/rg",
            "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-x64/rg",
            "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
        ]
        for mc in mac_candidates:
            if os.path.isfile(mc):
                _RESOLVED_RG_PATH = mc
                return _RESOLVED_RG_PATH
    else:
        linux_candidates = [
            "/usr/share/code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/linux-x64/rg",
            "/usr/share/code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
            "/snap/code/current/usr/share/code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
        ]
        for lc in linux_candidates:
            if os.path.isfile(lc):
                _RESOLVED_RG_PATH = lc
                return _RESOLVED_RG_PATH

    # 5. If still not found, trigger background auto-install
    if not _RG_SEARCH_ATTEMPTED:
        _RG_SEARCH_ATTEMPTED = True
        installed = ensure_ripgrep()
        if installed and os.path.isfile(installed):
            _RESOLVED_RG_PATH = installed
            return _RESOLVED_RG_PATH

    return None


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

    # Expand brace patterns like *.{ts,tsx,js,jsx} → [*.ts, *.tsx, *.js, *.jsx]
    expanded_patterns = _expand_brace_pattern(file_pattern)

    # 1. Try ripgrep (Tier 1 - fastest)
    rg_path = find_ripgrep_path()
    if rg_path:
        try:
            cmd = [
                rg_path,
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
            # Pass each expanded pattern separately (rg handles multiple --glob flags)
            for pat in expanded_patterns:
                if pat:
                    cmd.extend(["--glob", pat])

            cmd.extend(["-e", query, "--", str(search_path)])
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10,
                errors="replace",
                close_fds=True,
                stdin=subprocess.DEVNULL,
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().splitlines()
                return _format_grep_output(lines, search_path, max_results)
            elif result.returncode == 1:
                return f"No matches found for '{query}' in {path}."
        except Exception as e:
            log.warning("rg search failed, falling back: %s", e)
    else:
        log.warning(
            "ripgrep (rg) not found on system — using git grep / pure-Python "
            "fallback for grep_search. Auto-downloading ripgrep in background."
        )

    # 2. Try git grep (Tier 2 - fast git index). Only use it when the search
    # root is itself inside a repo - git grep searches from the enclosing
    # repo root.
    search_root_inside_repo = False
    git_cwd = str(search_path if search_path.is_dir() else search_path.parent)
    if shutil.which("git"):
        try:
            toplevel = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, cwd=git_cwd,
                timeout=2, errors="replace", close_fds=True,
                stdin=subprocess.DEVNULL,
            )
            if toplevel.returncode == 0 and toplevel.stdout.strip():
                repo_root = Path(toplevel.stdout.strip()).resolve()
                search_root_inside_repo = repo_root == search_path or repo_root in search_path.parents
        except Exception:
            search_root_inside_repo = False
    if ((search_path / ".git").exists() or _is_git_worktree(search_path)) and search_root_inside_repo:
        try:
            all_git_lines: List[str] = []
            no_match_count = 0
            git_env = dict(os.environ, GIT_PAGER="cat", PAGER="cat")
            # Run git grep once per expanded pattern (git grep doesn't support brace expansion)
            for pat in expanded_patterns:
                # FIX: Git explicitly forbids combining --no-index and --untracked (fatal exit 128).
                # Inside a git worktree, use --untracked without --no-index.
                cmd = ["git", "grep", "-n", "-I", "--untracked"]
                if not case_sensitive:
                    cmd.append("-i")
                cmd.extend(["-e", query, "--"])
                cmd.append(pat if pat else ".")
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=git_cwd,
                    timeout=10,
                    errors="replace",
                    close_fds=True,
                    stdin=subprocess.DEVNULL,
                    env=git_env,
                )
                if result.returncode == 0 and result.stdout.strip():
                    all_git_lines.extend(result.stdout.strip().splitlines())
                elif result.returncode == 1:
                    no_match_count += 1
                # rc >= 2 means git error — fall through silently

            if all_git_lines:
                filtered = []
                for line in all_git_lines:
                    parts = line.split(":", 2)
                    if len(parts) >= 2:
                        file_part = parts[0]
                        if not _is_excluded_path(Path(file_part), search_path):
                            filtered.append(line)
                if filtered:
                    return _format_grep_output(filtered, search_path, max_results)
            # All patterns returned no-match → definitive empty result, no need for Python fallback
            if no_match_count == len(expanded_patterns):
                return f"No matches found for '{query}' in {path}."
        except Exception as e:
            log.warning("git grep failed, falling back: %s", e)

    # 3. Pure Python fallback (Tier 3) — last resort with hard 8s timeout
    return _python_grep(query, search_path, case_sensitive, expanded_patterns, max_results)


def _is_git_worktree(path: Path) -> bool:
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            cwd=str(path),
            timeout=2,
            close_fds=True,  # frozen-build safety: see core/tools.py shell_exec
        )
        return res.returncode == 0 and res.stdout.strip() == "true"
    except Exception:
        return False


def _python_grep(
    query: str,
    root: Path,
    case_sensitive: bool,
    patterns: Optional[List[Optional[str]]] = None,
    max_results: int = 50,
    timeout_s: float = 8.0,
    file_pattern: Optional[str] = None,
) -> str:
    """Pure-Python grep fallback. `patterns` is a list of fnmatch-style globs
    (already brace-expanded). Uses a wall-clock timeout to avoid hanging."""
    import time as _time
    deadline = _time.monotonic() + timeout_s

    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        regex = re.compile(query, flags)
    except re.error:
        regex = re.compile(re.escape(query), flags)

    # Normalise patterns: None / empty list → match everything.
    # `file_pattern` is the legacy single-glob kwarg kept for backwards compat.
    _raw_patterns = list(patterns) if patterns else []
    if file_pattern and file_pattern not in _raw_patterns:
        _raw_patterns.append(file_pattern)
    if not _raw_patterns:
        active_patterns: Optional[List[str]] = None
    else:
        active_patterns = [p for p in _raw_patterns if p] or None

    matches: List[str] = []
    timed_out = False

    for dirpath, dirnames, filenames in os.walk(root):
        if _time.monotonic() > deadline:
            timed_out = True
            break

        current_dir = Path(dirpath)
        # Prune excluded directories in-place
        dirnames[:] = [
            d for d in dirnames
            if d not in DEFAULT_EXCLUDED_DIRS and not (d.startswith(".") and d != ".andromity")
        ]

        for fname in filenames:
            if _time.monotonic() > deadline:
                timed_out = True
                break

            file_path = current_dir / fname
            if _is_excluded_path(file_path, root):
                continue
            # Skip files larger than 5MB in pure Python fallback to prevent memory/CPU stalls
            try:
                if file_path.stat().st_size > 5 * 1024 * 1024:
                    continue
            except Exception:
                continue

            # Check expanded patterns — file must match at least one
            if active_patterns and not any(fnmatch.fnmatch(fname, p) for p in active_patterns):
                continue

            try:
                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    for line_num, line in enumerate(f, 1):
                        if line_num % 500 == 0 and _time.monotonic() > deadline:
                            timed_out = True
                            break
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

            if timed_out or len(matches) >= max_results:
                break
        if timed_out or len(matches) >= max_results:
            break

    if not matches:
        if timed_out:
            return f"Search timed out (>{timeout_s:.0f}s). No matches found for '{query}' — try a more specific path or file_pattern."
        return f"No matches found for '{query}'."

    count_msg = f"Found {len(matches)} match{'es' if len(matches) != 1 else ''}"
    if timed_out:
        count_msg += " (search timed out, results may be incomplete)"
    elif len(matches) >= max_results:
        count_msg += f" (capped at {max_results})"
    return f"{count_msg}:\n" + "\n".join(matches)


def _matches_glob_pattern(rel_path: str, fname: str, pattern: str) -> bool:
    """Match a file path against a glob pattern, supporting **/ (0 or more dirs) and standard wildcards."""
    # 1. Direct match on filename or relative path
    if fnmatch.fnmatch(fname, pattern) or fnmatch.fnmatch(rel_path, pattern):
        return True
    # 2. Leading **/ matches 0 directories (i.e. file at current root)
    if pattern.startswith("**/"):
        sub = pattern[3:]
        if fnmatch.fnmatch(fname, sub) or fnmatch.fnmatch(rel_path, sub):
            return True
    # 3. Middle /**/ matches 0 directories
    if "/**/" in pattern:
        sub = pattern.replace("/**/", "/")
        if fnmatch.fnmatch(fname, sub) or fnmatch.fnmatch(rel_path, sub):
            return True
    return False


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

    # Expand brace patterns (e.g. `*.{ts,js}`) if present
    expanded_patterns = _expand_brace_pattern(pattern) if ("{" in pattern and "}" in pattern) else [pattern]

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

            if any(_matches_glob_pattern(rel_path, fname, p) for p in expanded_patterns):
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
