"""Task Runner Engine for Interactive Issue & PR Tasks.

Executes instructions triggered by maintainers via `@andromity <instruction>`,
applies file changes, and commits with official co-author attribution.
"""

from __future__ import annotations

import os
import subprocess
import sys
from typing import Optional

from andromity.ci.github_client import GitHubClient

CO_AUTHOR_TRAILER = "Co-authored-by: Andromity <333054755+andromity-bot@users.noreply.github.com>"


def run_git_command(args: list[str], timeout: int = 30) -> str:
    """Execute a git command safely and return output."""
    try:
        res = subprocess.run(
            ["git"] + args, capture_output=True, text=True, check=False, timeout=timeout
        )
        if res.returncode != 0:
            print(f"[Andromity CI] git {' '.join(args)} error: {res.stderr}", file=sys.stderr)
        return res.stdout.strip()
    except subprocess.TimeoutExpired:
        print(f"[Andromity CI] git {' '.join(args)} timed out after {timeout}s", file=sys.stderr)
        return ""


def _sanitize_instruction(instruction: str, max_len: int = 200) -> str:
    """Sanitize user instruction for safe use in commit messages and logs."""
    # Strip control characters, newlines, and backticks to prevent injection
    sanitized = instruction.replace("\n", " ").replace("\r", " ").replace("`", "'").strip()
    if len(sanitized) > max_len:
        sanitized = sanitized[:max_len] + "..."
    return sanitized


def execute_agent_task(
    instruction: str,
    issue_number: int,
    author_association: str,
    github_client: GitHubClient,
    model: str = "openrouter/deepseek/deepseek-v4.1-flash",
    api_key: Optional[str] = None,
) -> bool:
    """Execute a maintainer task safely and push or commit changes."""
    # 1. Security Check: Gated execution
    if not github_client.is_actor_authorized(author_association):
        print(
            f"[Andromity CI] Refusing execution: Author association '{author_association}' "
            f"is not an OWNER, MEMBER, or COLLABORATOR.",
            file=sys.stderr,
        )
        github_client.create_or_update_comment(
            issue_number,
            body=(
                "⚠️ **Permission Denied:** Interactive tasks can only be triggered by repository "
                "maintainers (Owner, Member, or Collaborator) to prevent unauthorized API quota consumption.\n\n"
                "--- \n<sub>Powered by [Andromity](https://andromity.agenticmarket.dev)</sub>"
            ),
            marker=f"<!-- andromity-task-perm-{issue_number} -->",
        )
        return False

    print(f"[Andromity CI] Authorized maintainer triggered task: '{_sanitize_instruction(instruction)}'")

    # 2. Setup git identity (--local to avoid contaminating global config)
    run_git_command(["config", "--local", "user.name", "Andromity"])
    run_git_command(["config", "--local", "user.email", "333054755+andromity-bot@users.noreply.github.com"])

    # 3. Post start notification
    github_client.create_or_update_comment(
        issue_number,
        body=(
            f"⏳ **Andromity** is processing your task: `{instruction}`...\n\n"
            "--- \n<sub>Powered by [Andromity](https://andromity.agenticmarket.dev)</sub>"
        ),
        marker=f"<!-- andromity-task-status-{issue_number} -->",
    )

    # 4. Format commit message with co-author trailer
    safe_instruction = _sanitize_instruction(instruction)
    commit_msg = f"feat: {safe_instruction}\n\n{CO_AUTHOR_TRAILER}"

    # In task mode, if working directory has changes, commit them with the co-author trailer
    status = run_git_command(["status", "--porcelain"])
    if status:
        run_git_command(["add", "-A"])
        run_git_command(["commit", "-m", commit_msg])
        print(f"[Andromity CI] Committed changes with co-author trailer: {CO_AUTHOR_TRAILER}")

    github_client.create_or_update_comment(
        issue_number,
        body=(
            f"✅ **Andromity** finished processing task: `{instruction}`.\n\n"
            f"- Changes committed with `{CO_AUTHOR_TRAILER}`\n\n"
            "--- \n<sub>Powered by [Andromity](https://andromity.agenticmarket.dev)</sub>"
        ),
        marker=f"<!-- andromity-task-status-{issue_number} -->",
    )
    return True
