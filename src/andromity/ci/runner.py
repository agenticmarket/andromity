"""Headless CLI Entrypoint for Andromity GitHub Action (`andromity-ci`).

Parses GitHub Actions runner context, dispatches review or task execution,
and handles errors with strict exit codes and clean logging.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

from andromity.ci.github_client import GitHubClient, REVIEW_MARKER
from andromity.ci.pr_reviewer import DEFAULT_MODEL, generate_pr_review
from andromity.ci.task_runner import execute_agent_task


def load_event_payload(event_path: str) -> Dict[str, Any]:
    """Load GitHub event JSON payload safely."""
    if not event_path or not os.path.exists(event_path):
        return {}
    try:
        with open(event_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[Andromity CI] Warning: Could not parse event payload at {event_path}: {e}", file=sys.stderr)
        return {}


def main() -> int:
    """Main execution function for andromity-ci CLI."""
    print("=" * 60)
    print("🤖 Andromity GitHub Action Runner")
    print("=" * 60)

    # 1. Extract inputs from environment variables
    api_key = os.environ.get("INPUT_API_KEY", "").strip() or os.environ.get("OPENROUTER_API_KEY", "").strip()
    github_token = os.environ.get("INPUT_GITHUB_TOKEN", "").strip() or os.environ.get("GITHUB_TOKEN", "").strip()
    mode = os.environ.get("INPUT_MODE", "review").strip().lower()
    model = os.environ.get("INPUT_MODEL", "").strip() or DEFAULT_MODEL
    custom_prompt = os.environ.get("INPUT_PROMPT", "").strip()

    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    event_path = os.environ.get("GITHUB_EVENT_PATH", "").strip()
    event_name = os.environ.get("GITHUB_EVENT_NAME", "").strip()

    print(f"📦 Repository: {repository or 'Local/Unknown'}")
    print(f"⚡ Mode: {mode}")
    print(f"🧠 Model: {model}")

    if not github_token:
        print("❌ Error: GITHUB_TOKEN or input.github-token is required to run Andromity CI.", file=sys.stderr)
        return 1

    payload = load_event_payload(event_path)
    client = GitHubClient(token=github_token, repository=repository)

    # 2. Review Mode: Pull Request Code Review
    if mode == "review":
        pr_data = payload.get("pull_request")
        if not pr_data:
            print("⚠️ Notice: Event is not a pull_request; checking if PR number was passed directly...")
            pr_number = payload.get("issue", {}).get("number") or payload.get("number")
            if not pr_number:
                print("ℹ️ No pull request found in event context. Skipping PR review.", file=sys.stderr)
                return 0
            pr_title = payload.get("issue", {}).get("title", "Pull Request")
            pr_body = payload.get("issue", {}).get("body", "")
        else:
            pr_number = pr_data.get("number")
            pr_title = pr_data.get("title", "Pull Request")
            pr_body = pr_data.get("body", "")

        print(f"🔍 Fetching diff for PR #{pr_number}: '{pr_title}'...")
        try:
            diff_text = client.get_pr_diff(pr_number)
        except Exception as e:
            print(f"❌ Failed to fetch PR diff: {e}", file=sys.stderr)
            return 1

        print(f"📝 Analyzing diff ({len(diff_text)} chars) with {model}...")
        review_markdown = generate_pr_review(
            diff_text=diff_text,
            pr_title=pr_title,
            pr_body=pr_body,
            model=model,
            api_key=api_key,
            custom_prompt=custom_prompt,
        )

        print(f"💬 Posting review to PR #{pr_number}...")
        try:
            comment_id = client.create_or_update_comment(
                issue_or_pr_number=pr_number,
                body=review_markdown,
                marker=REVIEW_MARKER,
            )
            print(f"✅ Successfully posted/updated review comment (ID: {comment_id})!")
        except Exception as e:
            print(f"❌ Failed to post review comment: {e}", file=sys.stderr)
            return 1

        return 0

    # 3. Task Mode: Interactive Issue Solving (@andromity)
    elif mode == "task":
        comment_data = payload.get("comment", {})
        comment_body = comment_data.get("body", "") or custom_prompt
        issue_number = payload.get("issue", {}).get("number") or payload.get("number", 0)
        author_assoc = comment_data.get("author_association", "NONE")

        # Strip @andromity prefix
        cleaned_instruction = comment_body.replace("@andromity", "").strip()
        if not cleaned_instruction:
            print("ℹ️ No instruction found for Andromity task.", file=sys.stderr)
            return 0

        success = execute_agent_task(
            instruction=cleaned_instruction,
            issue_number=issue_number,
            author_association=author_assoc,
            github_client=client,
            model=model,
            api_key=api_key,
        )
        return 0 if success else 1

    else:
        print(f"❌ Unknown mode: '{mode}'. Valid modes are 'review' or 'task'.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
