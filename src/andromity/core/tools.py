import os
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional

from andromity.core.git_ops import get_repo, create_pre_edit_snapshot
from andromity.config import config, get_shell
from andromity.core.debug_log import get_logger

log = get_logger("tools")


def _is_trusted() -> bool:
    return config.is_trusted(str(Path.cwd()))


def _ensure_snapshot():
    repo = get_repo()
    if repo:
        create_pre_edit_snapshot(repo)


def read_file(path: str, start: Optional[int] = None, end: Optional[int] = None) -> str:
    p = Path(path).resolve()
    if not p.is_file():
        return f"Error: File '{path}' does not exist."
    try:
        with open(p, "r", encoding="utf-8") as f:
            lines = f.readlines()
        if start is not None and end is not None:
            lines = lines[start - 1 : end]
        return "".join(lines)
    except Exception as e:
        return f"Error reading file: {e}"


def write_file(path: str, content: str) -> str:
    if not _is_trusted():
        return "Error: This folder is not trusted. Use /trust to allow file writes."
    p = Path(path).resolve()
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
    if not p.is_dir():
        return f"Error: Directory '{path}' does not exist."
    try:
        items = []
        for item in p.iterdir():

            kind = "DIR " if item.is_dir() else "FILE"
            items.append(f"{kind}\t{item.name}")
        return "\n".join(sorted(items))
    except Exception as e:
        return f"Error listing directory: {e}"


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
    else:
        result = f"Error: Unknown tool {name}"
    log.debug("TOOL RESULT: %s -> %s chars: %s", name, len(result), result[:120])
    return result
