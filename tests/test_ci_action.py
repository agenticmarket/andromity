"""Unit tests for Andromity GitHub Action CI Subsystem."""

import unittest
from unittest.mock import MagicMock, patch

from andromity.ci.github_client import GitHubClient, REVIEW_MARKER
from andromity.ci.pr_reviewer import (
    DEFAULT_MODEL,
    REVIEW_FOOTER,
    generate_pr_review,
)
from andromity.ci.task_runner import CO_AUTHOR_TRAILER, execute_agent_task


class TestCIAction(unittest.TestCase):
    def test_default_model_is_openrouter_deepseek_flash(self):
        """Verify default model is OpenRouter DeepSeek Flash v4.1."""
        self.assertEqual(DEFAULT_MODEL, "openrouter/deepseek/deepseek-v4.1-flash")

    def test_co_author_trailer_format(self):
        """Verify co-author trailer strictly adheres to Andromity <noreply@agenticmarket.dev>."""
        self.assertEqual(CO_AUTHOR_TRAILER, "Co-authored-by: Andromity <noreply@agenticmarket.dev>")
        self.assertIn("agenticmarket.dev", CO_AUTHOR_TRAILER)
        self.assertNotIn("Andromity AI", CO_AUTHOR_TRAILER)
        self.assertIn("Andromity", CO_AUTHOR_TRAILER)

    def test_actor_authorization(self):
        """Verify least-privilege maintainer gating."""
        self.assertTrue(GitHubClient.is_actor_authorized("OWNER"))
        self.assertTrue(GitHubClient.is_actor_authorized("MEMBER"))
        self.assertTrue(GitHubClient.is_actor_authorized("COLLABORATOR"))
        self.assertTrue(GitHubClient.is_actor_authorized("owner"))

        self.assertFalse(GitHubClient.is_actor_authorized("NONE"))
        self.assertFalse(GitHubClient.is_actor_authorized("FIRST_TIME_CONTRIBUTOR"))
        self.assertFalse(GitHubClient.is_actor_authorized("CONTRIBUTOR"))
        self.assertFalse(GitHubClient.is_actor_authorized(""))

    def test_create_or_update_comment_creates_new(self):
        """Verify GitHubClient issues POST when no existing review comment exists."""
        client = GitHubClient(token="fake-token", repository="agenticmarket/andromity")

        with patch.object(client, "find_existing_comment", return_value=None):
            with patch.object(client, "_request", return_value={"id": 12345}) as mock_req:
                res_id = client.create_or_update_comment(
                    issue_or_pr_number=42,
                    body="Review content",
                    marker=REVIEW_MARKER,
                )
                self.assertEqual(res_id, 12345)
                mock_req.assert_called_once()
                args, kwargs = mock_req.call_args
                self.assertEqual(args[0], "issues/42/comments")
                self.assertEqual(kwargs["method"], "POST")
                self.assertIn(REVIEW_MARKER, kwargs["data"]["body"])

    def test_create_or_update_comment_updates_in_place(self):
        """Verify GitHubClient issues PATCH on existing comment to avoid PR thread spam."""
        client = GitHubClient(token="fake-token", repository="agenticmarket/andromity")

        with patch.object(client, "find_existing_comment", return_value=98765):
            with patch.object(client, "_request", return_value={"id": 98765}) as mock_req:
                res_id = client.create_or_update_comment(
                    issue_or_pr_number=42,
                    body="Updated review content",
                    marker=REVIEW_MARKER,
                )
                self.assertEqual(res_id, 98765)
                mock_req.assert_called_once()
                args, kwargs = mock_req.call_args
                self.assertEqual(args[0], "issues/comments/98765")
                self.assertEqual(kwargs["method"], "PATCH")
                self.assertIn(REVIEW_MARKER, kwargs["data"]["body"])

    def test_pr_reviewer_empty_diff(self):
        """Verify empty diff is handled gracefully without triggering model inference."""
        result = generate_pr_review(
            diff_text="",
            pr_title="Empty PR",
            pr_body="No changes",
        )
        self.assertIn("No changes detected in PR diff", result)
        self.assertIn("agenticmarket.dev", result)

    def test_pr_reviewer_footer_attribution(self):
        """Verify review footer points to agenticmarket.dev and uses Andromity branding."""
        self.assertIn("agenticmarket.dev", REVIEW_FOOTER)
        self.assertIn("Andromity", REVIEW_FOOTER)
        self.assertNotIn("Andromity AI", REVIEW_FOOTER)

    def test_task_runner_blocks_unauthorized_actor(self):
        """Verify untrusted users cannot trigger arbitrary tasks."""
        mock_client = MagicMock()
        mock_client.is_actor_authorized.return_value = False

        success = execute_agent_task(
            instruction="rm -rf /",
            issue_number=10,
            author_association="NONE",
            github_client=mock_client,
        )
        self.assertFalse(success)
        mock_client.create_or_update_comment.assert_called_once()
        args, kwargs = mock_client.create_or_update_comment.call_args
        self.assertIn("Permission Denied", kwargs["body"])


if __name__ == "__main__":
    unittest.main()
