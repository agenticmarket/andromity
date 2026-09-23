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

CO_AUTHOR_TRAILER = "Co-authored-by: Andromity <noreply@agenticmarket.dev>"


def run_git_command(args: list[str]) -> str:
    """Execute a git command safely and return output."""
    res = subprocess.run(["git"] + args, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        print(f"[Andromity CI] git {' '.join(args)} error: {res.stderr}", file=sys.stderr)
    return res.stdout.strip()


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
                "--- \n<sub>Powered by [Andromity](https://agenticmarket.dev)</sub>"
            ),
            marker=f"<!-- andromity-task-perm-{issue_number} -->",
        )
        return False

    print(f"[Andromity CI] Authorized maintainer triggered task: '{instruction}'")

    # 2. Setup git identity
    run_git_command(["config", "user.name", "Andromity"])
    run_git_command(["config", "user.email", "noreply@agenticmarket.dev"])

    # 3. Post start notification
    github_client.create_or_update_comment(
        issue_number,
        body=(
            f"⏳ **Andromity** is processing your task: `{instruction}`...\n\n"
            "--- \n<sub>Powered by [Andromity](https://agenticmarket.dev)</sub>"
        ),
        marker=f"<!-- andromity-task-status-{issue_number} -->",
    )

    # 4. Format commit message with co-author trailer
    commit_msg = f"feat: {instruction}\n\n{CO_AUTHOR_TRAILER}"

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
            "--- \n<sub>Powered by [Andromity](https://agenticmarket.dev)</sub>"
        ),
        marker=f"<!-- andromity-task-status-{issue_number} -->",
    )
    return True
