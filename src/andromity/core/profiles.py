import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import List
from andromity.config import get_shell

def _get_git_branch() -> str:
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"], 
            capture_output=True, 
            text=True, 
            timeout=1
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return "unknown"

PROFILES = {
    "builder": {"tools": ["read_file", "write_file", "edit_file", "shell_exec", "list_dir", "write_plan", "update_plan_step", "create_todo", "update_todo", "list_todos"]},
    "coder": {"tools": ["read_file", "write_file", "edit_file", "shell_exec", "list_dir", "create_todo", "update_todo", "list_todos"]},
    "reviewer": {"tools": ["read_file", "list_dir"]},
    "planner":  {"tools": ["read_file", "list_dir", "write_plan", "update_plan_step"]},
}


def get_system_prompt(profile: str) -> str:
    cwd = Path.cwd()
    os_name = platform.system()
    shell = get_shell()
    
    python_ver = sys.version.split()[0]
    home_dir = str(Path.home())
    git_branch = _get_git_branch()
    venv = os.environ.get("VIRTUAL_ENV") or os.environ.get("CONDA_DEFAULT_ENV") or "none"
    is_wsl = "WSL" in platform.uname().release if os_name == "Linux" else False
    
    base = f"""You are Andromity, a world-class AI coding assistant running on the user's machine.

## Environment
- OS: {os_name}{" (WSL)" if is_wsl else ""}
- Shell: {shell}
- Python: {python_ver}
- Home: {home_dir}
- CWD: {cwd}
- Git branch: {git_branch}
- Virtualenv: {venv}

## Rules
- Always use the correct shell syntax for {shell} on {os_name}.
- Never assume Unix paths on Windows unless in WSL.
- Plan before acting. Be concise.
- CRITICAL: Always send a short text message BEFORE calling any tool.
  Say what you are about to do in plain language. Example: "Creating the project structure..."
  Then call the tool. Never chain tools without text in between.
- After completing all tasks, send a brief summary of what was done.
"""
    if profile == "reviewer":
        extra = """
[PROFILE: SWE Reviewer]
Your role is to act as a security and code quality auditor.
- You have READ-ONLY access. Do not use tools to modify files.
- Focus on finding bugs, security vulnerabilities (SQLi, XSS, etc.), and anti-patterns.
- Output a list of issues with severity badges: [HIGH], [MED], [LOW].
- Do not apply fixes directly. Explain the issue and wait for the user to ask for a fix.
- Always explain what you are looking at before listing findings.
"""
    elif profile == "planner":
        extra = """
[PROFILE: Planner]
Your role is to act as an architect and system designer.
- You have READ-ONLY access. You may only output plan files like PLAN.md.
- Think in phases. Break complex tasks into small, verifiable steps.
- Provide step-by-step checklists with [ ] checkboxes.
- Ask clarifying questions before suggesting implementations.
- Always describe your reasoning before writing a plan file.
"""
    elif profile == "coder":
        extra = """
[PROFILE: Fast Coder]
Your role is to execute code changes as fast as possible without asking for permission.
- You have full access to read, write, edit files, and execute commands.
- Do NOT make plans. Just write or edit the code directly.
- Send a short text message before each tool call explaining what you will do.
- After all changes, send a brief summary of what was done.
"""
    else:
        extra = """
[PROFILE: Builder]
Your role is to act as the primary implementer.
- You have full access to read, write, edit files, and execute commands.
- Use `edit_file` for targeted changes, and `write_file` for new files.
"""
    return base + "\n" + extra


def get_allowed_tools(profile: str) -> List[str]:
    return PROFILES.get(profile, PROFILES["builder"])["tools"]


def filter_tools_for_profile(tools: list, profile: str) -> list:
    allowed = set(get_allowed_tools(profile))
    return [t for t in tools if t["function"]["name"] in allowed]
