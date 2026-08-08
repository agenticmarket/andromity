import asyncio
import ast
import json
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from andromity.config import config, get_shell
from andromity.core.debug_log import get_logger
from andromity.core.git_ops import create_pre_edit_snapshot, get_repo

log = get_logger("tools")

_PLAN_CALLBACKS: List[Callable] = []  # list of callables(plan) to notify on plan write/update
_TODO_CALLBACKS: List[Callable] = []  # list of callables() to notify on todo changes
_current_session = None  # set by agent before tool execution
_mcp_manager = None  # global MCPClientManager instance


def register_plan_callback(cb: Callable):
    _PLAN_CALLBACKS.append(cb)


def register_todo_callback(cb: Callable):
    _TODO_CALLBACKS.append(cb)


def register_session(session):
    """Register the active session so plan tools can store plan in it."""
    global _current_session
    _current_session = session


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
    if _current_session and getattr(_current_session, "project_path", None):
        return Path(_current_session.project_path).resolve()
    return Path.cwd().resolve()


def _assert_safe_path(p: Path) -> None:
    """Raise PermissionError if path escapes the project directory."""
    root = _get_project_root()
    try:
        p.resolve().relative_to(root)
    except ValueError:
        raise PermissionError(
            f"Access denied: '{p}' is outside the project directory ({root}). "
            "Andromity can only access files within the active project directory."
        )


def _is_trusted() -> bool:
    return config.is_trusted(str(Path.cwd()))


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
    start: Optional[int] = None,
    end: Optional[int] = None,
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
        if start is not None or end is not None:
            s = max(1, start if start is not None else 1)
            e = min(total_lines, end if end is not None else total_lines)
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
                f"[NOTE: File has {total_lines} lines. Showing first {max_lines}. Use start={max_lines + 1}, end={min(total_lines, max_lines * 2)} to view more, or symbols_only=True for an outline.]"
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


# ── Directory & Shell Operations ──────────────────────────────────────────────


def shell_exec(command: str, timeout: int = 30) -> str:
    """Executes a shell command."""
    if not _is_trusted():
        return "Error: This folder is not trusted. Use /trust to allow shell commands."
    shell = get_shell()
    try:
        if shell == "powershell":
            cmd = ["powershell", "-Command", command]
        else:
            cmd = [shell, "-c", command]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=os.getcwd())
        output = result.stdout
        if result.stderr:
            output += f"\nSTDERR:\n{result.stderr}"
        return output.strip() if output.strip() else "Command executed successfully with no output."
    except subprocess.TimeoutExpired:
        return f"Error: Command timed out after {timeout} seconds."
    except Exception as e:
        return f"Error executing command: {e}"


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


def write_plan(title: str, steps: list, description: str = "") -> str:
    """
    Create a structured plan for future work.
    Automatically populates the live todo checklist and notifies UI panels.
    """
    from andromity.core.planner import Plan, PlanStep
    from andromity.core.todo import TodoItem, TodoList

    if isinstance(steps, str):
        steps = [s.strip() for s in steps.split("\n") if s.strip()]

    step_items = []
    for i, s in enumerate(steps):
        if isinstance(s, dict):
            text = s.get("text") or s.get("title") or str(s)
            raw_status = s.get("status", "pending")
            status = "active" if raw_status == "in_progress" else raw_status
        else:
            text = str(s)
            status = "pending"
        step_items.append((text, status))

    plan_steps = [PlanStep(index=i + 1, text=text) for i, (text, status) in enumerate(step_items)]
    plan = Plan(
        title=title,
        description=description,
        steps=plan_steps,
        project_path=str(_get_project_root()),
    )
    plan.save()

    if _current_session:
        _current_session.save_plan(plan.to_dict())

    # Automatically sync steps to TodoList for unified visual checklist
    todo_list = TodoList(project_path=str(_get_project_root()))
    todo_list.items = [
        TodoItem(id=f"t{i + 1}", title=text, status=status)
        for i, (text, status) in enumerate(step_items)
    ]
    todo_list.save()

    _notify_plan(plan)
    _notify_todo()

    return f"Plan '{title}' written with {len(steps)} steps. Awaiting user approval before proceeding."


def update_plan_step(step_index: int, status: str) -> str:
    """
    Update step progress (e.g. 'active', 'done', 'failed', 'skipped').
    Updates both the plan and the corresponding todo checklist in real-time.
    """
    from andromity.core.planner import Plan
    from andromity.core.todo import TodoList

    valid_statuses = ("pending", "active", "done", "failed", "skipped")
    if status not in valid_statuses:
        return f"Error: status must be one of {valid_statuses}"

    project_path = str(_get_project_root())
    todo_list = TodoList.load(project_path)
    item = todo_list.update(f"t{step_index}", status)

    plan = Plan.load(project_path)
    if plan:
        _notify_plan(plan)
    _notify_todo()

    if item:
        return f"Updated Step {step_index} ({item.title}) to '{status}'."
    return f"Updated Step {step_index} status to '{status}'."


def _get_todo_list():
    from andromity.core.todo import TodoList
    return TodoList.load(str(_get_project_root()))


def create_todo(title: str) -> str:
    """Create a single todo item."""
    todo_list = _get_todo_list()
    item = todo_list.add(title)
    _notify_todo()
    return f"Created todo {item.id}: {item.title}"


def update_todo(todo_id: str, status: str) -> str:
    """Update a todo status."""
    valid = ("pending", "active", "done", "failed", "skipped")
    if status not in valid:
        return f"Error: status must be one of {valid}"
    todo_list = _get_todo_list()
    item = todo_list.update(todo_id, status)
    if not item:
        return f"Error: Todo '{todo_id}' not found."
    _notify_todo()
    return f"Updated {item.id} to {status}: {item.title}"


def list_todos() -> str:
    """List todos and progress."""
    todo_list = _get_todo_list()
    if not todo_list.items:
        return "No todos yet."
    done, total = todo_list.progress()
    parts = [f"{item.icon} {item.id}. {item.title}" for item in todo_list.items]
    return f"{done}/{total} done:\n" + "\n".join(parts)


# ── Discovery & Deferred Tools ────────────────────────────────────────────────


def tool_search(query: str) -> str:
    """
    Search available deferred tools (MCP servers, web tools, plugins)
    and return their full JSON parameter schemas on demand.
    """
    query_terms = [w for w in query.lower().strip().split() if w]
    registry = ToolRegistry.get_instance()
    deferred_tools = registry.get_deferred_tools()

    matched = []
    for tool in deferred_tools:
        name = tool.get("name", "").lower()
        desc = tool.get("description", "").lower()
        combined = f"{name} {desc}"
        if any(term in combined for term in query_terms):
            matched.append(tool)

    if not matched:
        return f"No deferred tools found matching query '{query}'."

    output_lines = [f"Found {len(matched)} matching deferred tool(s):\n"]
    for t in matched:
        output_lines.append(f"### Tool: `{t['name']}`")
        output_lines.append(f"**Description:** {t['description']}")
        output_lines.append(f"**Parameters Schema:**\n```json\n{json.dumps(t.get('parameters', {}), indent=2)}\n```\n")

    return "\n".join(output_lines)


# ── Core Tool Schemas & Tool Registry ─────────────────────────────────────────

CORE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Reads the contents of a file with line numbers. Use start/end for line ranges, or symbols_only=True to get an AST outline of classes/functions for large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "start": {"type": "integer", "description": "Starting line number (1-indexed, optional)"},
                    "end": {"type": "integer", "description": "Ending line number (inclusive, optional)"},
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
            "name": "shell_exec",
            "description": "Executes a shell command (running tests, build commands, git, etc.).",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
                },
                "required": ["command"],
            },
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
            "name": "write_plan",
            "description": "Create a structured plan for complex tasks. Steps automatically sync to the visual progress tracker. User must approve before execution.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short title for the plan"},
                    "steps": {"type": "array", "items": {"type": "string"}, "description": "List of step descriptions"},
                    "description": {"type": "string", "description": "Optional overview or notes"},
                },
                "required": ["title", "steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_plan_step",
            "description": "Update plan step progress. Call with 'active' when starting, 'done' when finished, 'failed' on error.",
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
            "name": "tool_search",
            "description": "Search available deferred tools (MCP servers, web tools, external skills) and fetch their full parameter schemas on demand.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query or tool name"},
                },
                "required": ["query"],
            },
        },
    },
]


class ToolRegistry:
    """Dynamic, Tiered Tool Registry supporting Eager (Tier 1) and Deferred/Lazy (Tier 2) tools."""

    _instance = None

    def __init__(self):
        self._eager_tools: Dict[str, Dict[str, Any]] = {
            t["function"]["name"]: t for t in CORE_TOOLS
        }
        self._deferred_tools: Dict[str, Dict[str, Any]] = {}
        self._register_default_deferred()

    @classmethod
    def get_instance(cls) -> "ToolRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _register_default_deferred(self):
        """Register built-in deferred tools (web_search, fetch_url)."""
        self.register_deferred(
            name="web_search",
            description="Search the web for up-to-date documentation, technical solutions, and references.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query"},
                    "max_results": {"type": "integer", "description": "Max results to return (default 5)"},
                },
                "required": ["query"],
            },
        )
        self.register_deferred(
            name="fetch_url",
            description="Fetch content from a URL via HTTP GET, sanitize HTML into clean markdown, and return safe data.",
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL to fetch"},
                    "max_chars": {"type": "integer", "description": "Maximum characters to return (default 4000)"},
                },
                "required": ["url"],
            },
        )

    def register_deferred(self, name: str, description: str, parameters: Dict[str, Any], category: str = "custom"):
        """Register a Tier 2 deferred tool (names-only in prompt, loaded on demand)."""
        self._deferred_tools[name] = {
            "name": name,
            "description": description,
            "parameters": parameters,
            "category": category,
        }

    def get_eager_tools(self, profile: str = "builder") -> List[Dict[str, Any]]:
        """Return full schemas for active Tier 1 tools filtered by profile."""
        from andromity.core.profiles import PROFILES
        prof_obj = PROFILES.get(profile)
        if not prof_obj:
            return list(self._eager_tools.values())

        filtered = []
        for name, tool_def in self._eager_tools.items():
            if name in prof_obj.tools or "all" in prof_obj.tools:
                filtered.append(tool_def)
        return filtered

    def get_deferred_tools(self) -> List[Dict[str, Any]]:
        """Return all registered deferred tools (including MCP tools)."""
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
        lines.append("Use tool_search(query) to retrieve the full schema before calling any deferred tool.")
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


def execute_tool(name: str, args: Dict[str, Any]) -> str:
    """Execute any tool (Core, Web, or MCP) with logging and error handling."""
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
    elif name == "shell_exec":
        return shell_exec(**args)
    elif name == "list_dir":
        return list_dir(**args)
    elif name == "write_plan":
        return write_plan(**args)
    elif name == "update_plan_step":
        return update_plan_step(**args)
    elif name == "create_todo":
        return create_todo(**args)
    elif name == "update_todo":
        return update_todo(**args)
    elif name == "list_todos":
        return list_todos()
    elif name == "tool_search":
        return tool_search(**args)

    # 2. Web Tools
    elif name == "web_search":
        from andromity.core.web import web_search
        return web_search(**args)
    elif name == "fetch_url":
        from andromity.core.web import fetch_url
        return fetch_url(**args)

    # 3. Model Context Protocol (MCP) Tools
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


async def execute_tool_async(name: str, args: Dict[str, Any]) -> str:
    """Asynchronous tool execution (natively awaits MCP tools, dispatches core tools)."""
    if name.startswith("mcp__"):
        if _mcp_manager:
            return await _mcp_manager.execute_mcp_tool(name, args)
        return f"Error: MCP tool '{name}' called but no MCPClientManager is active."
    
    # Run blocking core tools in a background thread to prevent freezing the Textual UI
    return await asyncio.to_thread(execute_tool, name, args)
