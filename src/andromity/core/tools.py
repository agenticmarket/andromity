import os
import subprocess
from pathlib import Path
from typing import Dict, Any, List, Optional

from andromity.core.git_ops import get_repo, create_pre_edit_snapshot
from andromity.config import config, get_shell
from andromity.core.debug_log import get_logger

log = get_logger("tools")

_PLAN_CALLBACKS = []  # list of callables(plan) to notify on plan write/update
_TODO_CALLBACKS = []  # list of callables() to notify on todo changes
_current_session = None  # set by agent before tool execution


def register_plan_callback(cb):
    _PLAN_CALLBACKS.append(cb)


def register_todo_callback(cb):
    _TODO_CALLBACKS.append(cb)


def register_session(session):
    """Register the active session so plan tools can store plan in it."""
    global _current_session
    _current_session = session


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


def read_file(path: str, start: Optional[int] = None, end: Optional[int] = None) -> str:
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error reading file: {e}"
    if not p.is_file():
        return f"Error: File '{path}' does not exist."
    try:
        with open(p, "r", encoding="utf-8") as f:
            lines = f.readlines()
        if start is not None and end is not None:
            lines = lines[start - 1 : end]
        content = "".join(lines)
        return content if content else f"File '{path}' is empty."
    except Exception as e:
        return f"Error reading file: {e}"


def write_file(path: str, content: str) -> str:
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


def edit_file(path: str, old_str: str, new_str: str) -> str:
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
        if old_str not in content:
            return "Error: old_str not found in the file."
        _ensure_snapshot()
        new_content = content.replace(old_str, new_str, 1)
        with open(p, "w", encoding="utf-8") as f:
            f.write(new_content)
        return f"Successfully edited {path}"
    except Exception as e:
        return f"Error editing file: {e}"


def shell_exec(command: str, timeout: int = 30) -> str:
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


def list_dir(path: str = ".") -> str:
    p = Path(path).resolve()
    try:
        _assert_safe_path(p)
    except Exception as e:
        return f"Error listing directory: {e}"
    if not p.is_dir():
        return f"Error: Directory '{path}' does not exist."
    try:
        items = []
        for item in p.iterdir():

            kind = "DIR " if item.is_dir() else "FILE"
            items.append(f"{kind}\t{item.name}")
        if not items:
            return f"Directory '{path}' is empty."
        return "\n".join(sorted(items))
    except Exception as e:
        return f"Error listing directory: {e}"


def write_plan(title: str, steps: list, description: str = "") -> str:
    """Create a plan with the given title and list of step strings. Stored in session."""
    from andromity.core.planner import Plan, PlanStep
    if isinstance(steps, str):
        steps = [s.strip() for s in steps.split('\n') if s.strip()]
    plan = Plan(
        title=title,
        description=description,
        steps=[PlanStep(index=i + 1, text=s) for i, s in enumerate(steps)],
    )
    if _current_session:
        _current_session.save_plan(plan.to_dict())
    _notify_plan(plan)
    return f"Plan '{title}' written with {len(steps)} steps. Awaiting user approval before proceeding."


def update_plan_step(step_index: int, status: str) -> str:
    """No-op — plan steps are reference only, use update_todo for progress tracking."""
    return f"Plan step {step_index} noted. Use update_todo to track progress."


def _get_todo_list():
    from andromity.core.todo import TodoList
    project_path = str(Path.cwd())
    if _current_session and _current_session.project_path:
        project_path = _current_session.project_path
    return TodoList.load(project_path)


def create_todo(title: str) -> str:
    todo_list = _get_todo_list()
    item = todo_list.add(title)
    _notify_todo()
    return f"Created todo {item.id}: {item.title}"


def update_todo(todo_id: str, status: str) -> str:
    from andromity.core.todo import TodoItem
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
    todo_list = _get_todo_list()
    if not todo_list.items:
        return "No todos yet."
    done, total = todo_list.progress()
    parts = []
    for item in todo_list.items:
        parts.append(f"{item.icon} {item.id}. {item.title}")
    return f"{done}/{total} done:\n" + "\n".join(parts)


CORE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Reads the contents of a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "start": {"type": "integer", "description": "Starting line number (1-indexed)"},
                    "end": {"type": "integer", "description": "Ending line number (inclusive)"},
                },
                "required": ["path"],
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
            "description": "Replaces old_str with new_str in the file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "old_str": {"type": "string", "description": "Exact string to replace"},
                    "new_str": {"type": "string", "description": "Replacement string"},
                },
                "required": ["path", "old_str", "new_str"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_exec",
            "description": "Executes a shell command.",
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
            "description": "Lists contents of a directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the directory (default is current directory)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_plan",
            "description": "Create a structured plan for future work, that you need to do. ALWAYS call this before starting complex work or when asked. The user must approve the plan before you proceed.",
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
            "description": "Update the status of a plan step. Call with 'active' when starting, 'done' when finished, 'failed' on error.",
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
            "name": "create_todo",
            "description": "Create a todo checklist item. Call after plan approval to break work into trackable items.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "What needs to be done"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_todo",
            "description": "Update todo status. Use 'active' when starting, 'done' when finished, 'failed' on error.",
            "parameters": {
                "type": "object",
                "properties": {
                    "todo_id": {"type": "string", "description": "The todo ID (e.g. t1, t2)"},
                    "status": {"type": "string", "enum": ["pending", "active", "done", "failed", "skipped"]},
                },
                "required": ["todo_id", "status"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_todos",
            "description": "List all todos and their progress.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
]


def execute_tool(name: str, args: Dict[str, Any]) -> str:
    log.debug("TOOL CALL: %s(%s)", name, {k: (str(v)[:80] + '...' if isinstance(v, str) and len(v) > 80 else v) for k, v in args.items()})
    if name == "read_file":
        result = read_file(**args)
    elif name == "write_file":
        result = write_file(**args)
    elif name == "edit_file":
        result = edit_file(**args)
    elif name == "shell_exec":
        result = shell_exec(**args)
    elif name == "list_dir":
        result = list_dir(**args)
    elif name == "write_plan":
        result = write_plan(**args)
    elif name == "update_plan_step":
        result = update_plan_step(**args)
    elif name == "create_todo":
        result = create_todo(**args)
    elif name == "update_todo":
        result = update_todo(**args)
    elif name == "list_todos":
        result = list_todos()
    else:
        result = f"Error: Unknown tool {name}"
    log.debug("TOOL RESULT: %s -> %s chars: %s", name, len(result), result[:120])
    return result
