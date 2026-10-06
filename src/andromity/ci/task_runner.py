"""Task Runner Engine for Interactive Issue & PR Tasks.

Keeps the legacy task entry point explicit about unsupported execution.
"""

from __future__ import annotations

import sys
from typing import Optional

from andromity.ci.github_client import GitHubClient

CO_AUTHOR_TRAILER = "Co-authored-by: Andromity <333054755+andromity-bot@users.noreply.github.com>"


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
    """Reject unsupported task execution without mutating the workspace."""
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

    github_client.create_or_update_comment(
        issue_number,
        body=(
            "Andromity task mode is unavailable: this Action supports PR reviews, "
            "but does not execute coding tasks or create pull requests. No files "
            "were changed and no model tokens were spent. For release README "
            "updates, use the Andromity Release Notes workflow."
        ),
        marker=f"<!-- andromity-task-status-{issue_number} -->",
    )
    return False
