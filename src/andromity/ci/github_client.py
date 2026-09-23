"""GitHub REST API Client for Headless CI Workflows.

Provides idempotent comment updates, permission verification, and diff retrieval
using standard library urllib to avoid heavy third-party dependencies.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

REVIEW_MARKER = "<!-- andromity-pr-review -->"
AUTHORIZED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}


class GitHubClient:
    """Minimal, robust GitHub API client for CI and PR automation."""

    def __init__(self, token: str, repository: str, api_url: str = "https://api.github.com"):
        self.token = token.strip()
        self.repository = repository.strip()
        self.api_url = api_url.rstrip("/")

    def _headers(self, accept: str = "application/vnd.github+json") -> Dict[str, str]:
        return {
            "Accept": accept,
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Andromity-CI-Agent",
        }

    def _request(
        self,
        endpoint: str,
        method: str = "GET",
        data: Optional[Dict[str, Any]] = None,
        accept: str = "application/vnd.github+json",
    ) -> Any:
        url = f"{self.api_url}/repos/{self.repository}/{endpoint.lstrip('/')}"
        encoded_data = json.dumps(data).encode("utf-8") if data is not None else None
        headers = self._headers(accept)
        if data is not None:
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=encoded_data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw_body = resp.read()
                if not raw_body:
                    return None
                if accept == "application/vnd.github.v3.diff":
                    return raw_body.decode("utf-8", errors="replace")
                return json.loads(raw_body.decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_msg = e.read().decode("utf-8", errors="replace")
            print(f"[Andromity CI] GitHub API HTTPError {e.code} on {method} {url}: {err_msg}", file=sys.stderr)
            raise RuntimeError(f"GitHub API Error {e.code}: {err_msg}") from e

    def get_pr_diff(self, pr_number: int) -> str:
        """Fetch unified diff for the pull request."""
        diff = self._request(
            f"pulls/{pr_number}",
            method="GET",
            accept="application/vnd.github.v3.diff",
        )
        return diff or ""

    def list_comments(self, issue_or_pr_number: int) -> List[Dict[str, Any]]:
        """List comments on an issue or PR."""
        comments = self._request(f"issues/{issue_or_pr_number}/comments?per_page=100", method="GET")
        return comments if isinstance(comments, list) else []

    def find_existing_comment(self, issue_or_pr_number: int, marker: str = REVIEW_MARKER) -> Optional[int]:
        """Find the ID of a previous bot comment containing the unique marker tag."""
        comments = self.list_comments(issue_or_pr_number)
        for comment in comments:
            body = comment.get("body", "")
            if marker in body:
                return comment.get("id")
        return None

    def create_or_update_comment(
        self,
        issue_or_pr_number: int,
        body: str,
        marker: str = REVIEW_MARKER,
    ) -> int:
        """Post a comment idempotently: updates existing comment if found, else creates new."""
        # Ensure marker is embedded at the top of the body
        if marker not in body:
            formatted_body = f"{marker}\n{body}"
        else:
            formatted_body = body

        existing_id = self.find_existing_comment(issue_or_pr_number, marker)
        if existing_id:
            print(f"[Andromity CI] Updating existing comment ID {existing_id} in-place...")
            self._request(
                f"issues/comments/{existing_id}",
                method="PATCH",
                data={"body": formatted_body},
            )
            return existing_id
        else:
            print(f"[Andromity CI] Creating new comment on #{issue_or_pr_number}...")
            res = self._request(
                f"issues/{issue_or_pr_number}/comments",
                method="POST",
                data={"body": formatted_body},
            )
            return res.get("id", 0) if isinstance(res, dict) else 0

    @staticmethod
    def is_actor_authorized(author_association: str) -> bool:
        """Check if an author association is allowed to execute gated agent tasks."""
        return author_association.upper() in AUTHORIZED_ASSOCIATIONS
