import asyncio
import ast
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import collections
import threading
import time as _time

from andromity.config import config, get_shell
from andromity.core.debug_log import get_logger
from andromity.core.git_ops import create_pre_edit_snapshot, get_repo

log = get_logger("tools")

import contextvars

_PLAN_CALLBACKS: List[Callable] = []  # list of callables(plan) to notify on plan write/update
_TODO_CALLBACKS: List[Callable] = []  # list of callables() to notify on todo changes
_SUBAGENT_PROGRESS_CALLBACKS: List[Callable] = []  # list of callables(StreamEvent) for subagent activity
_current_session_var: contextvars.ContextVar[Any] = contextvars.ContextVar("current_session", default=None)
_mcp_manager = None  # global MCPClientManager instance

# ── Background process registry ────────────────────────────────────────────────
# Maps process_id → {"proc": Popen, "buf": deque, "cmd": str, "started": float}
_bg_processes: Dict[str, Any] = {}
_bg_lock = threading.Lock()


def register_plan_callback(cb: Callable):
    _PLAN_CALLBACKS.append(cb)


def register_todo_callback(cb: Callable):
    _TODO_CALLBACKS.append(cb)


def register_subagent_progress_callback(cb: Callable):
    if cb not in _SUBAGENT_PROGRESS_CALLBACKS:
        _SUBAGENT_PROGRESS_CALLBACKS.append(cb)


def unregister_subagent_progress_callback(cb: Callable):
    if cb in _SUBAGENT_PROGRESS_CALLBACKS:
        _SUBAGENT_PROGRESS_CALLBACKS.remove(cb)


def register_session(session):
    """Register the active session in contextvars so tool executions are thread-safe and isolated."""
    _current_session_var.set(session)


def get_current_session():
    """Retrieve the active session for the current execution context."""
    return _current_session_var.get()


def register_mcp_manager(manager):
    """Register the active MCPClientManager for MCP tool execution."""
    global _mcp_manager
    _mcp_manager = manager


def _notify_plan(plan):
    for cb in _PLAN_CALLBACKS:
        try:
            cb(plan)
        except Exception:
            pass


def _notify_todo():
    for cb in _TODO_CALLBACKS:
        try:
            cb()
        except Exception:
            pass


def _get_project_root() -> Path:
    session = _current_session_var.get()
    if session and getattr(session, "project_path", None):
        return Path(session.project_path).resolve()
    return Path.cwd().resolve()


def _assert_safe_path(p: Path) -> Path:
    """Raise PermissionError if path escapes the project directory. Returns resolved path."""
    root = _get_project_root()
    resolved = p.resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        raise PermissionError(
            f"Access denied: '{p}' is outside the project directory ({root}). "
            "Andromity can only access files within the active project directory."
        )
    return resolved


def _is_trusted() -> bool:
    return config.is_trusted(str(_get_project_root()))


def _ensure_snapshot():
    repo = get_repo()
    if repo:
        create_pre_edit_snapshot(repo)


# ── AST & Code Symbol Extraction ──────────────────────────────────────────────


def extract_code_symbols(file_path: str, content: str) -> str:
    """
    Extract high-level outline of classes, methods, and functions with line numbers.
    Drastically cuts token consumption (50 tokens vs 5,000 tokens) on large files.
    """
    lines = content.splitlines()
    total_lines = len(lines)
    is_python = file_path.endswith(".py")

    symbols: List[str] = []

    if is_python:
        try:
            tree = ast.parse(content)
            for node in tree.body:
                if isinstance(node, ast.ClassDef):
                    end = getattr(node, "end_lineno", node.lineno)
                    doc = ast.get_docstring(node)
                    doc_snippet = f" — {doc.splitlines()[0]}" if doc else ""
                    symbols.append(f"• class {node.name} (lines {node.lineno}-{end}){doc_snippet}")
                    for item in node.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            m_end = getattr(item, "end_lineno", item.lineno)
                            prefix = "async def" if isinstance(item, ast.AsyncFunctionDef) else "def"
                            m_doc = ast.get_docstring(item)
                            m_snippet = f" — {m_doc.splitlines()[0]}" if m_doc else ""
                            symbols.append(f"    ├─ {prefix} {item.name}() (lines {item.lineno}-{m_end}){m_snippet}")
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    end = getattr(node, "end_lineno", node.lineno)
                    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
                    doc = ast.get_docstring(node)
                    doc_snippet = f" — {doc.splitlines()[0]}" if doc else ""
                    symbols.append(f"• {prefix} {node.name}() (lines {node.lineno}-{end}){doc_snippet}")
        except Exception:
            is_python = False  # fallback to regex if syntax error

    if not is_python or not symbols:
        # Generic regex symbol extraction for JS/TS/Go/Rust/HTML/CSS
        func_patterns = [
            (r"^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)", "function"),
            (r"^(?:export\s+)?class\s+([a-zA-Z0-9_$]+)", "class"),
            (r"^(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)", "interface"),
            (r"^(?:export\s+)?type\s+([a-zA-Z0-9_$]+)", "type"),
            (r"^func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)", "func"),
            (r"^fn\s+([a-zA-Z0-9_]+)", "fn"),
            (r"^\s*(?:def|async def)\s+([a-zA-Z0-9_]+)", "def"),
        ]
        for idx, line in enumerate(lines, 1):
            sline = line.strip()
            for pat, kind in func_patterns:
                m = re.match(pat, sline)
                if m:
                    symbols.append(f"• {kind} {m.group(1)} (line {idx})")
                    break

    if not symbols:
        return f"File: {file_path} | Total Lines: {total_lines}\n[No top-level class/function definitions found]"

    header = f"File: {file_path} | Total Lines: {total_lines} | Symbol Outline ({len(symbols)} items):\n"
    return header + "\n".join(symbols)


# ── File Operations ───────────────────────────────────────────────────────────


def read_file(
    path: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
    max_lines: int = 500,
    symbols_only: bool = False,
) -> str:
    """
    Reads the contents of a file with line numbers.
    If symbols_only=True, returns an outline of classes and functions with line ranges.
    """
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error reading file: {e}"
    if not p.is_file():
        return f"Error: File '{path}' does not exist."
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        if symbols_only:
            return extract_code_symbols(path, content)

        all_lines = content.splitlines(keepends=True)
        total_lines = len(all_lines)
        if total_lines == 0:
            return f"File '{path}' is empty."

        # Range specified
        if start_line is not None or end_line is not None:
            s = max(1, start_line if start_line is not None else 1)
            e = min(total_lines, end_line if end_line is not None else total_lines)
            if s > total_lines:
                return f"Error: start line {s} exceeds total lines ({total_lines})."
            if s > e:
                return f"Error: start line {s} is greater than end line {e}."
            selected = all_lines[s - 1 : e]
            numbered = [f"{s + i}: {line}" for i, line in enumerate(selected)]
            header = f"File: {path} | Total Lines: {total_lines} | Showing lines {s} to {e}"
            return header + "\n" + "".join(numbered)

        # Default bounded view if file is large
        if total_lines > max_lines:
            selected = all_lines[:max_lines]
            numbered = [f"{1 + i}: {line}" for i, line in enumerate(selected)]
            header = (
                f"File: {path} | Total Lines: {total_lines} | Showing lines 1 to {max_lines}\n"
                f"[NOTE: File has {total_lines} lines. Showing first {max_lines}. Use start_line={max_lines + 1}, end_line={min(total_lines, max_lines * 2)} to view more, or symbols_only=True for an outline.]"
            )
            return header + "\n" + "".join(numbered)
        else:
            numbered = [f"{1 + i}: {line}" for i, line in enumerate(all_lines)]
            return "".join(numbered)
    except Exception as e:
        return f"Error reading file: {e}"


def write_file(path: str, content: str) -> str:
    """Writes full content to a new or existing file."""
    if not _is_trusted():
        return "Error: This folder is not trusted. Use /trust to allow file writes."
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error writing file: {e}"
    _ensure_snapshot()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Successfully wrote to {path}"
    except Exception as e:
        return f"Error writing file: {e}"


def edit_file(
    path: str,
    old_str: str,
    new_str: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
) -> str:
    """
    Replaces old_str with new_str in the file using a 3-tier resilient matching engine:
    1. Exact string match
    2. Whitespace & indentation-tolerant matching
    3. Line-bounded window search
    """
    if not _is_trusted():
        return "Error: This folder is not trusted. Use /trust to allow file edits."
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error editing file: {e}"
    if not p.is_file():
        return f"Error: File '{path}' does not exist."

    try:
        with open(p, "r", encoding="utf-8") as f:
            content = f.read()

        file_lines = content.splitlines(keepends=True)
        total_lines = len(file_lines)

        # Normalize line endings in input strings
        old_normalized = old_str.replace("\r\n", "\n")
        new_normalized = new_str.replace("\r\n", "\n")

        # ── Tier 1: Exact Match ───────────────────────────────────────────────
        if start_line is None and end_line is None:
            # Check exact occurrence count
            exact_count = content.count(old_str)
            if exact_count == 1:
                _ensure_snapshot()
                new_content = content.replace(old_str, new_str, 1)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(new_content)
                return f"Successfully edited {path}"
            elif exact_count > 1:
                # Disambiguation: find line numbers of matches
                matched_line_nums = []
                idx = 0
                while True:
                    idx = content.find(old_str, idx)
                    if idx == -1:
                        break
                    line_no = content[:idx].count("\n") + 1
                    matched_line_nums.append(line_no)
                    idx += len(old_str)
                return (
                    f"Error: 'old_str' matches {exact_count} times in {path} at lines: {matched_line_nums}.\n"
                    "Please provide 1-2 lines of surrounding context or use start_line/end_line to disambiguate."
                )

        # ── Tier 2: Line-by-Line Trimmed & Indentation-Tolerant Match ────────
        old_lines = [l.rstrip("\r\n") for l in old_normalized.split("\n")]
        # Drop trailing empty line if multiline string ended with \n
        if len(old_lines) > 1 and not old_lines[-1]:
            old_lines = old_lines[:-1]

        target_search_range = range(
            max(0, (start_line - 1) if start_line is not None else 0),
            min(total_lines, end_line if end_line is not None else total_lines),
        )

        match_start_idx = None
        match_end_idx = None
        trimmed_old = [l.strip() for l in old_lines]

        # Scan for matching line block
        old_len = len(trimmed_old)
        for i in target_search_range:
            if i + old_len <= total_lines:
                window = [file_lines[i + j].strip() for j in range(old_len)]
                if window == trimmed_old:
                    if match_start_idx is None:
                        match_start_idx = i
                        match_end_idx = i + old_len
                    else:
                        # Ambiguous match in range
                        return (
                            f"Error: Multiple whitespace-tolerant matches found for 'old_str' in {path}.\n"
                            "Please specify more surrounding context."
                        )

        if match_start_idx is not None and match_end_idx is not None:
            _ensure_snapshot()
            # Determine indentation from the original matched block
            original_indent = ""
            m_indent = re.match(r"^(\s*)", file_lines[match_start_idx])
            if m_indent:
                original_indent = m_indent.group(1)

            # Reconstruct new lines
            new_lines = new_normalized.split("\n")
            # Preserve file line ending style (\r\n or \n)
            le = "\r\n" if "\r\n" in content else "\n"
            replacement_block = [line + le for line in new_lines]

            final_lines = file_lines[:match_start_idx] + replacement_block + file_lines[match_end_idx:]
            with open(p, "w", encoding="utf-8") as f:
                f.writelines(final_lines)
            return f"Successfully edited {path} (lines {match_start_idx + 1}-{match_end_idx})"

        return f"Error: 'old_str' not found in {path}. Check line numbers with read_file."

    except Exception as e:
        return f"Error editing file: {e}"


def edit_file_multi(path: str, edits: list) -> str:
    """
    Applies multiple non-contiguous edits to a file sequentially.
    Each edit in the list must be a dict with 'old_str' and 'new_str'.
    Optional 'start_line' and 'end_line' can be provided per edit.
    """
    if not _is_trusted():
        return "Error: This folder is not trusted. Use /trust to allow file edits."
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error editing file: {e}"
    if not p.is_file():
        return f"Error: File '{path}' does not exist."

    successes = []
    errors = []
    
    for i, edit in enumerate(edits):
        old_str = edit.get("old_str")
        new_str = edit.get("new_str")
        start_line = edit.get("start_line")
        end_line = edit.get("end_line")
        
        if old_str is None or new_str is None:
            errors.append(f"Edit {i+1} missing old_str or new_str.")
            continue
            
        res = edit_file(path, old_str, new_str, start_line, end_line)
        if res.startswith("Error"):
            errors.append(f"Edit {i+1}: {res}")
        else:
            successes.append(f"Edit {i+1}: Success.")
            
    if not errors:
        return f"Successfully applied all {len(successes)} edits to {path}."
    
    msg = [f"Applied {len(successes)} edits successfully, but {len(errors)} edits failed:"]
    msg.extend(errors)
    return "\n".join(msg)


# ── Directory & Shell Operations ──────────────────────────────────────────────

def get_clean_subprocess_env(extra_env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Build a clean environment dictionary for subprocesses spawned from PyInstaller.

    Prevents PyInstaller's internal PYTHONHOME/PYTHONPATH/_MEIPASS from poisoning
    child python processes, pip, pytest, git hooks, and virtual environments.
    """
    env = os.environ.copy()

    # 1. Restore original variables if PyInstaller preserved them
    for var in ("PYTHONHOME", "PYTHONPATH", "PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
        orig = f"{var}_ORIG"
        if orig in env:
            env[var] = env[orig]
            env.pop(orig, None)
        elif getattr(sys, "frozen", False) and var in ("PYTHONHOME", "PYTHONPATH"):
            # When frozen, remove PYTHONHOME/PYTHONPATH completely so child python
            # uses its own installation directory.
            env.pop(var, None)

    # 2. Strip PyInstaller internal keys
    for key in ("_MEIPASS2", "_PYI_APPLICATION_HOME_DIR", "_PYI_ARCHIVE_FILE", "_PYI_SPLASH_IPC"):
        env.pop(key, None)

    # 3. Clean _MEIPASS from PATH if PATH_ORIG was not set
    if getattr(sys, "frozen", False):
        mei = getattr(sys, "_MEIPASS", None)
        if mei and "PATH" in env:
            paths = env["PATH"].split(os.pathsep)
            cleaned_paths = [p for p in paths if p and os.path.abspath(p) != os.path.abspath(mei)]
            env["PATH"] = os.pathsep.join(cleaned_paths)

    if extra_env:
        env.update(extra_env)
    return env


def _shell_invocation(shell: str, command: str) -> list[str]:
    """Build the argv that tells this shell to run `command`.

    Different shells need different flags:
      - powershell / pwsh     ->  -NoProfile -NonInteractive -Command
      - cmd (Windows)         ->  /d /c   (cmd has no -c; /d skips AutoRun)
      - bash / sh / zsh / …  ->  -c
    Handles both bare names and full paths (e.g. C:\\Windows\\System32\\cmd.exe).
    """
    name = os.path.basename(shell).lower()
    if name.endswith(".exe"):
        name = name[:-4]
    if name in ("powershell", "pwsh"):
        return [shell, "-Command", command]
    if name == "cmd":
        return [shell, "/d", "/c", command]
    return [shell, "-c", command]


def shell_exec(command: str, timeout: int = 120) -> str:
    """Executes a shell command (blocking — waits for it to finish)."""
    if not _is_trusted():
        return "Error: This folder is not trusted. Use /trust to allow shell commands."
    shell = get_shell()
    try:
        cmd = _shell_invocation(shell, command)
        try:
            cwd = str(_get_project_root())
        except Exception:
            cwd = os.getcwd()
        clean_env = get_clean_subprocess_env()
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,  # Prevent inheriting daemon stdio stream
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            cwd=cwd,
            env=clean_env,             # Prevent PYTHONHOME/PYTHONPATH poisoning
            close_fds=True,            # Prevent handle inheritance
            creationflags=flags,
        )
        output = result.stdout
        if result.stderr:
            output += f"\nSTDERR:\n{result.stderr}"
        return output.strip() if output.strip() else "Command executed successfully with no output."
    except subprocess.TimeoutExpired:
        return (
            f"Error: Command timed out after {timeout} seconds. "
            "If you need to run a long-running process (e.g. a dev server), use "
            "shell_bg instead — it starts the process in the background and lets "
            "you read its output any time with shell_read."
        )
    except Exception as e:
        return f"Error executing command: {e}"


def shell_bg(command: str, process_id: str = "") -> str:
    """Start a long-running command in the background (dev servers, watchers, etc.).

    Returns immediately with a process_id. Use shell_read(process_id) to check
    live output, shell_kill(process_id) to stop it.
    """
    if not _is_trusted():
        return "Error: This folder is not trusted. Use /trust to allow shell commands."

    import uuid
    _cmd_tokens = command.split()
    pid = process_id.strip() or (_cmd_tokens[0].split("/")[-1][:20] if _cmd_tokens else "bg")
    # Make unique if already taken
    with _bg_lock:
        if pid in _bg_processes:
            pid = f"{pid}-{uuid.uuid4().hex[:4]}"

    shell = get_shell()
    try:
        cwd = str(_get_project_root())
    except Exception:
        cwd = os.getcwd()

    try:
        cmd = _shell_invocation(shell, command)
        clean_env = get_clean_subprocess_env()
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            cwd=cwd,
            env=clean_env,
            bufsize=1,
            close_fds=True,
            creationflags=flags,
        )
    except Exception as e:
        return f"Error starting background process: {e}"

    buf: collections.deque = collections.deque(maxlen=500)  # keep last 500 lines

    def _reader():
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                buf.append(line.rstrip("\n"))
        except Exception:
            pass
        finally:
            buf.append(f"[process '{pid}' exited with code {proc.wait()}]")

    t = threading.Thread(target=_reader, daemon=True, name=f"bg-reader-{pid}")
    t.start()

    with _bg_lock:
        _bg_processes[pid] = {
            "proc": proc,
            "buf": buf,
            "cmd": command,
            "started": _time.time(),
        }

    return (
        f"Background process started with id '{pid}' (PID {proc.pid}).\n"
        f"Use shell_read('{pid}') to see live output, "
        f"shell_kill('{pid}') to stop it."
    )


def shell_read(process_id: str, lines: int = 50) -> str:
    """Read the latest output lines from a background process started with shell_bg."""
    with _bg_lock:
        entry = _bg_processes.get(process_id)
    if not entry:
        ids = list(_bg_processes.keys())
        hint = f" Running ids: {ids}" if ids else " No background processes are running."
        return f"Error: No background process with id '{process_id}'.{hint}"

    proc = entry["proc"]
    buf: collections.deque = entry["buf"]
    alive = proc.poll() is None
    status = "running" if alive else f"exited (code {proc.returncode})"
    elapsed = int(_time.time() - entry['started'])

    recent = list(buf)[-lines:]
    output = "\n".join(recent) if recent else "(no output yet)"
    return (
        f"Process '{process_id}' | {status} | {elapsed}s elapsed\n"
        f"Command: {entry['cmd']}\n"
        f"--- last {min(lines, len(recent))} lines ---\n"
        f"{output}"
    )


def shell_kill(process_id: str) -> str:
    """Kill a background process started with shell_bg."""
    with _bg_lock:
        entry = _bg_processes.pop(process_id, None)
    if not entry:
        return f"Error: No background process with id '{process_id}'."
    proc = entry["proc"]
    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        return f"Process '{process_id}' (PID {proc.pid}) terminated."
    except Exception as e:
        return f"Error killing process '{process_id}': {e}"


def shell_list() -> str:
    """List all background processes currently running (started with shell_bg)."""
    with _bg_lock:
        entries = dict(_bg_processes)
    if not entries:
        return "No background processes are running."
    lines = []
    for pid, entry in entries.items():
        proc = entry["proc"]
        alive = proc.poll() is None
        status = "running" if alive else f"exited ({proc.returncode})"
        elapsed = int(_time.time() - entry['started'])
        lines.append(f"  '{pid}' | {status} | {elapsed}s | {entry['cmd']}")
    return "Background processes:\n" + "\n".join(lines)


def list_dir(path: str = ".", show_hidden: bool = False) -> str:
    """Lists contents of a directory. Skips node_modules, .venv, and cache folders by default."""
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error listing directory: {e}"
    if not p.is_dir():
        return f"Error: Directory '{path}' does not exist."
    try:
        from andromity.core.search import DEFAULT_EXCLUDED_DIRS
        items = []
        for item in p.iterdir():
            name = item.name
            if not show_hidden:
                if name in DEFAULT_EXCLUDED_DIRS or (name.startswith(".") and name != ".andromity"):
                    continue
            if item.is_dir():
                items.append(f"[DIR]  {name}/")
            else:
                try:
                    size = item.stat().st_size
                    if size < 1024:
                        size_str = f"{size} B"
                    elif size < 1024 * 1024:
                        size_str = f"{size / 1024:.1f} KB"
                    else:
                        size_str = f"{size / (1024 * 1024):.1f} MB"
                    items.append(f"[FILE] {name} ({size_str})")
                except Exception:
                    items.append(f"[FILE] {name}")
        if not items:
            return f"Directory '{path}' is empty."
        return "\n".join(sorted(items))
    except Exception as e:
        return f"Error listing directory: {e}"


def grep_search(
    query: str,
    path: str = ".",
    case_sensitive: bool = False,
    file_pattern: Optional[str] = None,
    max_results: int = 50,
) -> str:
    """Search for text or regex patterns across the codebase."""
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error in grep_search: {e}"
    from andromity.core.search import grep_search as core_grep_search
    return core_grep_search(
        query=query,
        path=str(p),
        case_sensitive=case_sensitive,
        file_pattern=file_pattern,
        max_results=max_results,
    )


def find_files(pattern: str = "*", path: str = ".", max_results: int = 50) -> str:
    """Find files matching a glob pattern across the codebase."""
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error in find_files: {e}"
    from andromity.core.search import find_files as core_find_files
    return core_find_files(pattern=pattern, path=str(p), max_results=max_results)


# ── Unified Plan & Progress Tracking ──────────────────────────────────────────

def _sync_plan_md(plan=None, todo_list=None):
    from andromity.core.planner import Plan
    from andromity.core.todo import TodoList
    project_root = str(_get_project_root())
    
    if not plan:
        try:
            plan = Plan.load(project_root)
        except Exception:
            plan = None
            
    if not todo_list:
        try:
            todo_list = TodoList.load(project_root)
        except Exception:
            todo_list = None
            
    if not plan and not todo_list:
        return
        
    md_lines = []
    if plan:
        md_lines.append(f"# Plan: {plan.title}")
        if plan.description:
            md_lines.append(f"\n> {plan.description}\n")
        # Full markdown document written by the AI (architecture, file-by-file
        # changes, verification plan, etc.). Written verbatim, then the live
        # checklist is appended below so progress stays in sync. When the model
        # omitted plan_md, fall back to a small structured skeleton so the
        # file is still organised.
        body = getattr(plan, "body", "") or ""
        if body:
            md_lines.append(body.rstrip())
            md_lines.append("")
        else:
            md_lines.append("## Verification Plan")
            md_lines.append("*No verification plan was provided. Describe how each change will be tested before executing.*")
            md_lines.append("")
    else:
        md_lines.append("# Plan Checklist\n")

    md_lines.append("## Progress")
    if todo_list and todo_list.items:
        for item in todo_list.items:
            status_map = {
                "pending": "[ ]",
                "active": "[/]",
                "done": "[x]",
                "failed": "[!]",
                "skipped": "[-]"
            }
            checkbox = status_map.get(item.status, "[ ]")
            md_lines.append(f"- {checkbox} {item.title}")
    else:
        md_lines.append("*No steps yet.*")
        
    # Keep the human-readable mirror inside .andromity/ with the rest of
    # Andromity's internal state (plan.json, todos.md) — never in the
    # project root, and it's gitignored via ensure_gitignore_entry below.
    md_path = Path(project_root) / ".andromity" / "PLAN.md"
    try:
        md_path.parent.mkdir(parents=True, exist_ok=True)
        with open(md_path, "w", encoding="utf-8") as f:
            f.write("\n".join(md_lines))
        try:
            from andromity.core.git_ops import ensure_gitignore_entry
            ensure_gitignore_entry(project_root, ".andromity/")
        except Exception:
            pass
    except Exception as e:
        import logging
        logging.getLogger("andromity.tools").warning(f"Failed to write PLAN.md: {e}")



def write_plan(title: str, description: str = "", plan_md: str = "", steps: list = None, questions: list = None, **kwargs) -> str:
    """
    Create a plan (title + description + optional full markdown document) and
    convert steps directly into todos. Steps are NOT stored separately in the
    Plan object — todos ARE the steps. This avoids duplicating the same list
    twice. steps is optional — if omitted, the plan is created with no todos
    yet. plan_md is the full human-readable plan document (architecture, file
    changes, verification plan) written into .andromity/PLAN.md; the step
    checklist is auto-appended to it.
    """
    from andromity.core.planner import Plan
    from andromity.core.todo import TodoItem, TodoList

    if steps is None:
        steps = []

    if isinstance(steps, str):
        steps = [s.strip() for s in steps.split("\n") if s.strip()]

    # Normalise each step to (text, status)
    step_items = []
    for s in steps:
        if isinstance(s, dict):
            text = s.get("text") or s.get("title") or str(s)
            raw_status = s.get("status", "pending")
            status = "active" if raw_status == "in_progress" else raw_status
        else:
            text = str(s)
            status = "pending"
        step_items.append((text, status))

    project_root = str(_get_project_root())

    # Save plan metadata (title / description / questions / status only — no steps)
    from andromity.config import config
    mode = config.get("default", "permission_mode", "safe")
    auto_approve = mode in ("yolo", "full")

    plan = Plan(
        title=title,
        description=description,
        body=(plan_md or "").strip(),
        questions=questions or [],
        status="approved" if auto_approve else "pending",
        project_path=project_root,
    )
    plan.save()

    cur_session = _current_session_var.get()
    if cur_session:
        cur_session.save_plan(plan.to_dict())

    # Steps become todos — single source of truth
    todo_list = TodoList(project_path=project_root)
    todo_list.items = [
        TodoItem(id=f"t{i + 1}", title=text, status=status)
        for i, (text, status) in enumerate(step_items)
    ]
    todo_list.save()

    _sync_plan_md(plan, todo_list)
    _notify_plan(plan)
    _notify_todo()

    detail_hint = ""
    if not (plan_md or "").strip():
        detail_hint = (
            " Note: no plan_md was provided. For architecture-level plans, pass plan_md "
            "containing Overview, Architecture, File-by-File Changes and Verification sections."
        )
    if auto_approve:
        return f"Plan '{title}' created with {len(step_items)} steps (auto-approved in {mode.upper()} mode). A detailed PLAN.md has been generated in .andromity/. Proceeding.{detail_hint}"
    return f"Plan '{title}' created with {len(step_items)} steps. A detailed PLAN.md has been generated in .andromity/PLAN.md. Review it in the Viewer (Ctrl+D) or open the file, then confirm before making any changes.{detail_hint}"


def update_plan_step(step_index: int, status: str) -> str:
    """
    Update step progress (e.g. 'active', 'done', 'failed', 'skipped').
    Updates both the plan and the corresponding todo checklist in real-time.
    Automatically marks any previously active step as 'done' when starting a new active step.
    """
    from andromity.core.planner import Plan
    from andromity.core.todo import TodoList

    # Normalize common status aliases from various LLM models
    status_aliases = {
        "in_progress": "active",
        "running": "active",
        "working": "active",
        "started": "active",
        "completed": "done",
        "finished": "done",
        "passed": "done",
        "success": "done",
        "error": "failed",
        "skip": "skipped",
    }
    raw_status = str(status).lower().strip()
    status = status_aliases.get(raw_status, raw_status)

    valid_statuses = ("pending", "active", "done", "failed", "skipped")
    if status not in valid_statuses:
        return f"Error: status must be one of {valid_statuses}"

    project_path = str(_get_project_root())
    todo_list = TodoList.load(project_path)

    # When transitioning a step to 'active', automatically mark any
    # previously 'active' steps as 'done' so unfinished active steps don't linger.
    if status == "active":
        for item in todo_list.items:
            if item.id != f"t{step_index}" and item.status == "active":
                item.status = "done"

    item = todo_list.update(f"t{step_index}", status)

    _sync_plan_md(todo_list=todo_list)
    _notify_todo()

    if item:
        return f"Updated Step {step_index} ({item.title}) to '{status}'."
    return f"Updated Step {step_index} status to '{status}'."   





# ── Discovery & Deferred Tools ────────────────────────────────────────────────


def list_tools(limit: int = 20, offset: int = 0, include_description: bool = False, search: str = "") -> str:
    """
    List available deferred tools (MCP servers, plugins) with pagination and optional search.
    Returns lightweight catalog or full schema based on include_description.
    """
    registry = ToolRegistry.get_instance()
    deferred_tools = registry.get_deferred_tools()

    matched = []
    if search:
        query_terms = [w for w in search.lower().strip().split() if w]
        for tool in deferred_tools:
            name = tool.get("name", "").lower()
            desc = tool.get("description", "").lower()
            combined = f"{name} {desc}"
            if any(term in combined for term in query_terms):
                matched.append(tool)
    else:
        matched = deferred_tools

    total = len(matched)
    if total == 0:
        return f"No deferred tools found" + (f" matching '{search}'." if search else ".")

    # Paginate
    end_idx = min(offset + limit, total)
    page_tools = matched[offset:end_idx]

    output_lines = [f"Found {total} deferred tool(s). Showing {offset + 1}-{end_idx}:\n"]
    for t in page_tools:
        if include_description:
            output_lines.append(f"### Tool: `{t['name']}`")
            output_lines.append(f"**Description:** {t['description']}")
            output_lines.append(f"**Parameters Schema:**\n```json\n{json.dumps(t.get('parameters', {}), indent=2)}\n```\n")
        else:
            output_lines.append(f"- `{t['name']}`: {t.get('description', '')}")

    if end_idx < total:
        output_lines.append(f"\n*More tools available. Call list_tools(offset={end_idx}, search='{search}', include_description={include_description}) to see the next page.*")
    
    return "\n".join(output_lines)


# ── Sub-Agent & Session Coordination Tools ───────────────────────────────────

async def spawn_subagent_async(
    role: str,
    task: str,
    model_override: Optional[str] = None,
    provider_override: Optional[str] = None,
    tools: Optional[List[str]] = None,
    timeout: Optional[float] = None,
    wait: bool = True,
    context_snapshot: Optional[Any] = None,
    tool_id: Optional[str] = None,
) -> str:
    from andromity.core.subagent_orchestrator import SubAgentOrchestrator
    cur_sess = _current_session_var.get()
    parent_id = cur_sess.id if cur_sess else "root"
    proj_path = getattr(cur_sess, "project_path", None) if cur_sess else None
    
    orchestrator = getattr(cur_sess, "_orchestrator", None) if cur_sess else None
    if not orchestrator:
        orchestrator = SubAgentOrchestrator(parent_session_id=parent_id, project_path=proj_path)
        if cur_sess:
            cur_sess._orchestrator = orchestrator

    def _on_subagent_progress(evt):
        for cb in list(_SUBAGENT_PROGRESS_CALLBACKS):
            try:
                cb(evt)
            except Exception:
                pass

    res = await orchestrator.spawn(
        role=role,
        task=task,
        model_override=model_override,
        provider_override=provider_override,
        tools_override=tools,
        timeout=timeout,
        wait=wait,
        tool_id=tool_id,
        progress_callback=_on_subagent_progress,
        context_snapshot=context_snapshot,
    )
    cur_sess = _current_session_var.get()
    if cur_sess and hasattr(res, "tokens_used") and res.tokens_used:
        try:
            cur_sess.update_usage(res.tokens_used)
        except Exception:
            pass

    return json.dumps(res.to_dict(), indent=2)



async def session_send_message_async(to_session: str, content: str) -> str:
    from andromity.core.session_bus import SessionBus
    bus = SessionBus.get_instance()
    cur_sess = _current_session_var.get()
    sender_id = cur_sess.id if cur_sess else "anonymous"
    success = await bus.send_message(
        from_session_id=sender_id,
        to_target=to_session,
        content=content,
    )
    if success:
        return f"Message sent successfully to '{to_session}'."
    return f"Failed to send message: target session '{to_session}' was not found or is offline."


async def session_ask_question_async(to_session: str, question: str, timeout: float = 60.0) -> str:
    from andromity.core.session_bus import SessionBus
    bus = SessionBus.get_instance()
    cur_sess = _current_session_var.get()
    sender_id = cur_sess.id if cur_sess else "anonymous"
    return await bus.ask_question(
        from_session_id=sender_id,
        to_target=to_session,
        question=question,
        timeout=timeout,
    )


async def session_broadcast_async(content: str) -> str:
    from andromity.core.session_bus import SessionBus
    bus = SessionBus.get_instance()
    cur_sess = _current_session_var.get()
    sender_id = cur_sess.id if cur_sess else "anonymous"
    count = await bus.broadcast(from_session_id=sender_id, content=content)
    return f"Broadcast message delivered to {count} active session(s)."


def session_list() -> str:
    from andromity.core.session_bus import SessionBus
    bus = SessionBus.get_instance()
    cur_sess = _current_session_var.get()
    proj = getattr(cur_sess, "project_path", None) if cur_sess else None
    sessions = bus.list_sessions(project_path=proj)
    if not sessions:
        return "No other active sessions found."
    lines = ["Active Sessions:"]
    for s in sessions:
        lines.append(f"- **{s['name']}** (id: `{s['session_id'][:8]}...`, path: `{s['project_path']}`, registered: {s['registered_at']})")
    return "\n".join(lines)


def shared_state_set(key: str, value: Any) -> str:
    from andromity.core.shared_state import SharedStateBoard
    cur_sess = _current_session_var.get()
    proj = getattr(cur_sess, "project_path", None) if cur_sess else None
    author = cur_sess.name if cur_sess else "anonymous"
    board = SharedStateBoard.get_instance(project_path=proj)
    board.set(key, value, author_session=author)
    return f"Shared state updated: '{key}' = {json.dumps(value) if not isinstance(value, str) else value}"


def shared_state_get(key: str) -> str:
    from andromity.core.shared_state import SharedStateBoard
    cur_sess = _current_session_var.get()
    proj = getattr(cur_sess, "project_path", None) if cur_sess else None
    board = SharedStateBoard.get_instance(project_path=proj)
    val = board.get(key)
    if val is None:
        prefix_matches = board.snapshot(prefix=key)
        if prefix_matches:
            return json.dumps(prefix_matches, indent=2)
        return f"No value found for key '{key}'."
    return json.dumps(val, indent=2) if isinstance(val, (dict, list)) else str(val)


def write_handoff_tool(
    phase: str,
    status: str,
    produced: Optional[Dict[str, Any]] = None,
    blocked_on: Optional[List[str]] = None,
    next_steps: Optional[List[str]] = None,
    notes: str = "",
) -> str:
    from andromity.core.handoff import write_handoff
    cur_sess = _current_session_var.get()
    proj = getattr(cur_sess, "project_path", None) if cur_sess else None
    author = cur_sess.name if cur_sess else "anonymous"
    res = write_handoff(
        phase=phase,
        from_session=author,
        status=status,
        produced=produced,
        blocked_on=blocked_on,
        next_steps=next_steps,
        notes=notes,
        project_path=proj,
    )
    return f"Handoff document for phase '{phase}' ({status}) saved successfully:\n```json\n{json.dumps(res, indent=2)}\n```"


def read_handoff_tool(phase: str = "") -> str:
    from andromity.core.handoff import read_handoff, list_handoffs
    cur_sess = _current_session_var.get()
    proj = getattr(cur_sess, "project_path", None) if cur_sess else None
    if not phase or phase == "list":
        docs = list_handoffs(project_path=proj)
        if not docs:
            return "No handoff documents available."
        return json.dumps(docs, indent=2)
    doc = read_handoff(phase, project_path=proj)
    if not doc:
        return f"No handoff document found for phase '{phase}'."
    return json.dumps(doc, indent=2)


# ── Core Tool Schemas & Tool Registry ─────────────────────────────────────────

CORE_TOOLS = [

    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Reads the contents of a file with line numbers. Use start_line/end_line for line ranges, or symbols_only=True to get an AST outline of classes/functions for large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "start_line": {"type": "integer", "description": "Starting line number (1-indexed, optional)"},
                    "end_line": {"type": "integer", "description": "Ending line number (inclusive, optional)"},
                    "symbols_only": {"type": "boolean", "description": "If true, returns only an outline of classes and functions with line numbers (saves tokens on large files)."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep_search",
            "description": "Searches for text or regex patterns across the codebase. Automatically respects .gitignore and skips build folders.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The text or regex pattern to search for"},
                    "path": {"type": "string", "description": "Directory path to search in (default is current directory)"},
                    "case_sensitive": {"type": "boolean", "description": "Whether the search is case-sensitive (default false)"},
                    "file_pattern": {"type": "string", "description": "Optional glob pattern to filter files (e.g. '*.py', '*.ts')"},
                    "max_results": {"type": "integer", "description": "Maximum number of results to return (default 50)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_files",
            "description": "Finds files matching a glob pattern across the codebase (e.g. '*.py', '*config*', 'src/**/*.tsx').",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern to match file names or paths"},
                    "path": {"type": "string", "description": "Directory path to search in (default is current directory)"},
                    "max_results": {"type": "integer", "description": "Maximum number of files to return (default 50)"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Writes full content to a new or existing file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "content": {"type": "string", "description": "Content to write"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Replaces old_str with new_str in the file with automatic whitespace & indentation tolerance.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "old_str": {"type": "string", "description": "String/block to replace"},
                    "new_str": {"type": "string", "description": "Replacement string/block"},
                    "start_line": {"type": "integer", "description": "Optional starting line number to scope replacement"},
                    "end_line": {"type": "integer", "description": "Optional ending line number to scope replacement"},
                },
                "required": ["path", "old_str", "new_str"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file_multi",
            "description": "Applies multiple non-contiguous edits to a file in a single tool call. More token efficient than calling edit_file multiple times.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "edits": {
                        "type": "array",
                        "description": "List of edits to apply",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_str": {"type": "string", "description": "String/block to replace"},
                                "new_str": {"type": "string", "description": "Replacement string/block"},
                                "start_line": {"type": "integer", "description": "Optional start line"},
                                "end_line": {"type": "integer", "description": "Optional end line"}
                            },
                            "required": ["old_str", "new_str"]
                        }
                    }
                },
                "required": ["path", "edits"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_exec",
            "description": (
                "Executes a shell command (running tests, build commands, git, etc.). "
                "IMPORTANT: This is a blocking call — the command must exit before control returns. "
                "Do NOT use for long-running processes like dev servers (npm run dev, python manage.py runserver, etc.) "
                "as they will block until timeout. For such processes, use a background flag: "
                "`npm run dev &` on Unix/Mac or `Start-Process npm -ArgumentList 'run','dev'` on Windows."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 120). Increase for slow builds."},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_bg",
            "description": (
                "Start a long-running command in the background (dev servers, watchers, compilers, etc.). "
                "Returns immediately with a process_id — the process keeps running. "
                "Use shell_read(process_id) to check live output at any time. "
                "Use shell_kill(process_id) to stop it. "
                "Use this instead of shell_exec for: npm run dev, vite, webpack --watch, "
                "python manage.py runserver, pytest --watch, tail -f, etc."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to run in background"},
                    "process_id": {"type": "string", "description": "Optional friendly name for this process (e.g. 'dev-server'). Auto-generated if omitted."},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_read",
            "description": "Read the latest output from a background process started with shell_bg. Call this to check logs, errors, or status of a running server/watcher.",
            "parameters": {
                "type": "object",
                "properties": {
                    "process_id": {"type": "string", "description": "The process id returned by shell_bg"},
                    "lines": {"type": "integer", "description": "Number of recent lines to return (default 50)"},
                },
                "required": ["process_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_kill",
            "description": "Kill a background process started with shell_bg.",
            "parameters": {
                "type": "object",
                "properties": {
                    "process_id": {"type": "string", "description": "The process id to kill"},
                },
                "required": ["process_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_list",
            "description": "List all background processes currently running (started with shell_bg).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "Lists contents of a directory. Skips node_modules, .venv, .git, and cache folders by default.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the directory (default is current directory)"},
                    "show_hidden": {"type": "boolean", "description": "Whether to include hidden files (default false)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_questions",
            "description": "Ask the user structured clarifying questions when the request is ambiguous or important choices are missing. Pauses until answered — the user picks options or types an answer. Use sparingly: max 3 questions, and prefer good recommendations over asking when the request is clear enough.",
            "parameters": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "description": "Questions to ask. type='single' uses the options as exclusive choices; type='multi' allows selecting several options; type='text' expects a free-form answer.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string", "description": "The question, phrased clearly and specifically"},
                                "type": {"type": "string", "enum": ["single", "multi", "text"], "description": "single (default), multi, or text"},
                                "options": {"type": "array", "items": {"type": "string"}, "description": "Answer choices for single/multi questions (ignored for text)"},
                            },
                            "required": ["question"],
                        },
                    }
                },
                "required": ["questions"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_plan",
            "description": "Create a structured plan for complex tasks or asked to. Steps automatically sync to the visual progress tracker. User must approve before execution. For large or architecture-level work, also pass a full markdown document via plan_md.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short title for the plan"},
                    "steps": {"type": "array", "items": {"type": "string"}, "description": "List of step descriptions (optional — can be omitted and added later). Steps drive the progress tracker, so keep them short and actionable."},
                    "description": {"type": "string", "description": "Optional 1-3 sentence overview or notes"},
                    "plan_md": {"type": "string", "description": "Optional full markdown plan document. RECOMMENDED for complex or architecture-level tasks. Write a thorough document with sections like: Overview, Goals & Non-Goals, Architecture / System Design, File-by-File Proposed Changes (with concrete file paths), Data Flow, Edge Cases & Risks, and Verification / Testing Plan. Write it as raw markdown. Do NOT include a step checklist here — the tool appends the live checklist automatically from the steps argument."},
                    "questions": {"type": "array", "items": {"type": "string"}, "description": "Optional list of clarifying questions for the user before execution"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_plan_step",
            "description": "Update plan step progress. Call with 'active' when starting, 'done' must for finished, 'failed' on error. after overall process check steps status properly",
            "parameters": {
                "type": "object",
                "properties": {
                    "step_index": {"type": "integer", "description": "The 1-based step number"},
                    "status": {"type": "string", "enum": ["pending", "active", "done", "failed", "skipped"]},
                },
                "required": ["step_index", "status"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tools",
            "description": "List available deferred tools (e.g. MCP servers) with optional search, pagination, and descriptions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Max number of tools to return (default 20)"},
                    "offset": {"type": "integer", "description": "Pagination offset (default 0)"},
                    "include_description": {"type": "boolean", "description": "If true, includes full descriptions and schemas. If false, returns a lightweight list (default false)."},
                    "search": {"type": "string", "description": "Optional search term to filter tools by name or description"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for up-to-date documentation, technical solutions, and references.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query"},
                    "max_results": {"type": "integer", "description": "Max results to return (default 5)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_url",
            "description": "Fetch content from a URL via HTTP GET, sanitize HTML into clean markdown, and return safe data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL to fetch"},
                    "max_chars": {"type": "integer", "description": "Maximum characters to return (default 4000)"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spawn_subagent",
            "description": "Spawn a specialized sub-agent for a delegated subtask (e.g. search, coder, reviewer, analyst). Returns a structured, compressed summary.",
            "parameters": {
                "type": "object",
                "properties": {
                    "role": {"type": "string", "description": "Subagent role: 'search', 'coder', 'reviewer', 'analyst', or 'general'"},
                    "task": {"type": "string", "description": "Specific, actionable task instructions for the subagent"},
                    "model_override": {"type": "string", "description": "Optional model override for this subagent"},
                    "provider_override": {"type": "string", "description": "Optional provider override"},
                    "tools": {"type": "array", "items": {"type": "string"}, "description": "Optional list of tools allowed for this subagent"},
                    "timeout": {"type": "number", "description": "Optional timeout in seconds (default 180s)"},
                    "wait": {"type": "boolean", "description": "Whether to wait for completion (default true)"},
                    "context_snapshot": {"type": "object", "description": "Optional curated dictionary or key context facts to pass into the subagent"},
                },
                "required": ["role", "task"],

            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "session_send_message",
            "description": "Send an asynchronous message to another active session in the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to_session": {"type": "string", "description": "Target session name or session ID"},
                    "content": {"type": "string", "description": "Message content to send"},
                },
                "required": ["to_session", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "session_ask_question",
            "description": "Ask another active session a question and wait for its answer. Use when one session needs decisions or clarifications from another.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to_session": {"type": "string", "description": "Target session name or ID"},
                    "question": {"type": "string", "description": "Question to ask"},
                    "timeout": {"type": "number", "description": "Timeout in seconds (default 60s)"},
                },
                "required": ["to_session", "question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "session_broadcast",
            "description": "Broadcast an update or status change to all other active sessions on the project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Announcement or update message"},
                },
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "session_list",
            "description": "List all active agent sessions in the workspace, their registered names, IDs, and paths.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shared_state_set",
            "description": "Set a namespaced key-value fact on the shared state board (e.g. 'auth.endpoints', 'ui.theme', 'db.schema').",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Namespaced key name (e.g. 'auth.jwt_secret', 'db.tables')"},
                    "value": {"description": "Value to store (string, boolean, number, list, or dictionary)"},
                },
                "required": ["key", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shared_state_get",
            "description": "Get a value or prefix snapshot from the shared state board.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Key or key prefix to lookup"},
                },
                "required": ["key"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_handoff",
            "description": "Write a structured phase handoff document (e.g. 'authentication', 'database', 'frontend') for other sessions to consume without context bloat.",
            "parameters": {
                "type": "object",
                "properties": {
                    "phase": {"type": "string", "description": "Phase name (e.g. 'authentication', 'database_migration')"},
                    "status": {"type": "string", "description": "Status: 'complete', 'in_progress', or 'blocked'"},
                    "produced": {"type": "object", "description": "Dictionary of produced artifacts, endpoints, files, env vars"},
                    "blocked_on": {"type": "array", "items": {"type": "string"}, "description": "List of blockers"},
                    "next_steps": {"type": "array", "items": {"type": "string"}, "description": "Suggested next steps for other sessions"},
                    "notes": {"type": "string", "description": "Key architectural constraints or notes"},
                },
                "required": ["phase", "status"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_handoff",
            "description": "Read a structured handoff document produced by another session, or list all handoffs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "phase": {"type": "string", "description": "Phase name to read (or 'list' to see all)"},
                },
                "required": ["phase"],
            },
        },
    }
]


class ToolRegistry:
    """Dynamic, Tiered Tool Registry supporting Eager (Tier 1) and Deferred/Lazy (Tier 2) tools."""

    _instance = None

    def __init__(self):
        self._eager_tools: Dict[str, Dict[str, Any]] = {
            t["function"]["name"]: t for t in CORE_TOOLS
        }
        self._deferred_tools: Dict[str, Dict[str, Any]] = {}

    @classmethod
    def get_instance(cls) -> "ToolRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def register_deferred(self, name: str, description: str, parameters: Dict[str, Any], category: str = "custom"):
        """Register a Tier 2 deferred tool (names-only in prompt, loaded on demand)."""
        self._deferred_tools[name] = {
            "name": name,
            "description": description,
            "parameters": parameters,
            "category": category,
        }

    def get_eager_tools(self, profile: str = "builder") -> List[Dict[str, Any]]:
        """Return full schemas for active Tier 1 tools filtered by profile, plus MCP tools."""
        from andromity.core.profiles import PROFILES
        prof_obj = PROFILES.get(profile, {})
        allowed_tools = prof_obj.get("tools", [])

        filtered = []
        for name, tool_def in self._eager_tools.items():
            if name in allowed_tools or "all" in allowed_tools:
                filtered.append(tool_def)
                
        return filtered

    def get_deferred_tools(self) -> List[Dict[str, Any]]:
        """Return all registered deferred tools (including MCP)."""
        tools = list(self._deferred_tools.values())
        if _mcp_manager:
            for mcp_tool in _mcp_manager.get_all_tools():
                tools.append({
                    "name": mcp_tool.full_name,
                    "description": f"[{mcp_tool.server_name}] {mcp_tool.description}",
                    "parameters": mcp_tool.input_schema,
                })
        return tools

    def get_deferred_prompt_catalog(self) -> str:
        """Generate a compact <available-deferred-tools> prompt block (~100 tokens)."""
        deferred = self.get_deferred_tools()
        if not deferred:
            return ""
        lines = ["<available-deferred-tools>"]
        for t in deferred:
            lines.append(f"• {t['name']}: {t['description']}")
        lines.append("Use list_tools() to retrieve the full catalog or specific schemas before calling any deferred tool.")
        lines.append("</available-deferred-tools>")
        return "\n".join(lines)

    def search(self, query: str) -> str:
        """Search deferred tools matching query."""
        query_terms = [w for w in query.lower().strip().split() if w]
        matched = []
        for t in self.get_deferred_tools():
            name = t.get("name", "").lower()
            desc = t.get("description", "").lower()
            combined = f"{name} {desc}"
            if any(term in combined for term in query_terms):
                matched.append(t)
        if not matched:
            return f"No deferred tools found matching query '{query}'."
        lines = [f"Found {len(matched)} matching tools:"]
        for t in matched:
            lines.append(f"### Tool: `{t['name']}`\n{t.get('description', '')}\nParameters:\n{json.dumps(t.get('parameters', {}), indent=2)}")
        return "\n\n".join(lines)


# ── Tool Dispatcher ───────────────────────────────────────────────────────────


def _run_coro_sync(coro):
    """Run an async coroutine from a synchronous tool execution context safely."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            return executor.submit(asyncio.run, coro).result()
    else:
        return asyncio.run(coro)


def execute_tool(name: str, args: Dict[str, Any]) -> str:
    """Execute any tool (Core, Web, Coordination, or MCP) with logging and error handling."""
    log.debug("TOOL CALL: %s(%s)", name, {k: (str(v)[:80] + '...' if isinstance(v, str) and len(v) > 80 else v) for k, v in args.items()})

    # 1. Core Built-in Tools
    if name == "read_file":
        return read_file(**args)
    elif name == "grep_search":
        return grep_search(**args)
    elif name == "find_files":
        return find_files(**args)
    elif name == "write_file":
        return write_file(**args)
    elif name == "edit_file":
        return edit_file(**args)
    elif name == "edit_file_multi":
        return edit_file_multi(**args)
    elif name == "shell_exec":
        return shell_exec(**args)
    elif name == "shell_bg":
        return shell_bg(**args)
    elif name == "shell_read":
        return shell_read(**args)
    elif name == "shell_kill":
        return shell_kill(**args)
    elif name == "shell_list":
        return shell_list()
    elif name == "list_dir":
        return list_dir(**args)
    elif name == "write_plan":
        return write_plan(**args)
    elif name == "update_plan_step":
        return update_plan_step(**args)
    elif name == "list_tools":
        return list_tools(**args)
    elif name in ("ask_questions", "ask_question"):
        return "Error: ask_questions is handled interactively by the agent loop and cannot be executed directly."

    # 2. Sub-Agent and Session Coordination Tools
    elif name == "spawn_subagent":
        return _run_coro_sync(spawn_subagent_async(**args))
    elif name == "session_send_message":
        return _run_coro_sync(session_send_message_async(**args))
    elif name == "session_ask_question":
        return _run_coro_sync(session_ask_question_async(**args))
    elif name == "session_broadcast":
        return _run_coro_sync(session_broadcast_async(**args))
    elif name == "session_list":
        return session_list()
    elif name == "shared_state_set":
        return shared_state_set(**args)
    elif name == "shared_state_get":
        return shared_state_get(**args)
    elif name == "write_handoff":
        return write_handoff_tool(**args)
    elif name == "read_handoff":
        return read_handoff_tool(**args)

    # 3. Web Tools
    elif name == "web_search":
        from andromity.core.web import web_search
        return web_search(**args)
    elif name == "fetch_url":
        from andromity.core.web import fetch_url
        return fetch_url(**args)

    # 4. Model Context Protocol (MCP) Tools
    elif name.startswith("mcp__"):
        if _mcp_manager:
            import asyncio
            try:
                loop = asyncio.get_running_loop()
                if loop.is_running():
                    return f"Error: MCP tool '{name}' must be awaited via execute_tool_async."
            except RuntimeError:
                pass
            return asyncio.run(_mcp_manager.execute_mcp_tool(name, args))
        return f"Error: MCP tool '{name}' called but no MCPClientManager is active."

    return f"Error: Unknown tool '{name}'"


async def execute_tool_async(name: str, args: Dict[str, Any], tool_id: Optional[str] = None) -> str:
    """Asynchronous tool execution (natively awaits MCP tools and async coordination tools, dispatches core tools)."""
    if name.startswith("mcp__"):
        if _mcp_manager:
            return await _mcp_manager.execute_mcp_tool(name, args)
        return f"Error: MCP tool '{name}' called but no MCPClientManager is active."

    # Sub-agent and session coordination async tools
    if name == "spawn_subagent":
        return await spawn_subagent_async(tool_id=tool_id, **args)
    elif name == "session_send_message":
        return await session_send_message_async(**args)
    elif name == "session_ask_question":
        return await session_ask_question_async(**args)
    elif name == "session_broadcast":
        return await session_broadcast_async(**args)
    
    # Run blocking core tools in a background thread to prevent freezing the Textual UI
    return await asyncio.to_thread(execute_tool, name, args)

