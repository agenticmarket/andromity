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
        self.assertIn("andromity.agenticmarket.dev", result)

    def test_pr_reviewer_footer_attribution(self):
        """Verify review footer points to andromity.agenticmarket.dev and uses Andromity branding."""
        self.assertIn("https://andromity.agenticmarket.dev", REVIEW_FOOTER)
        self.assertIn("https://andromity.agenticmarket.dev/docs", REVIEW_FOOTER)
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

    def test_list_comments_uses_per_page_100(self):
        """Verify comment listing requests 100 items per page to prevent missing previous comments."""
        client = GitHubClient(token="fake-token", repository="agenticmarket/andromity")
        with patch.object(client, "_request", return_value=[]) as mock_req:
            client.list_comments(issue_or_pr_number=99)
            mock_req.assert_called_once_with("issues/99/comments?per_page=100", method="GET")

    def test_models_catalog_has_deepseek_flash_v4_1(self):
        """Verify OpenRouter models catalog includes deepseek-v4.1-flash."""
        from andromity.core.models import MODEL_CATALOG
        openrouter_models = MODEL_CATALOG.get("openrouter", {}).get("models", [])
        model_ids = [m["id"] for m in openrouter_models]
        self.assertIn("deepseek/deepseek-v4.1-flash", model_ids)

    def test_action_yml_declares_github_action_path(self):
        """Verify action.yml references github.action_path for third-party composite runs."""
        with open("action.yml", "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("${{ github.action_path }}", content)
        self.assertIn("openrouter/deepseek/deepseek-v4.1-flash", content)

    def test_github_client_rejects_empty_token(self):
        """Verify constructor rejects empty or whitespace tokens."""
        with self.assertRaises(ValueError):
            GitHubClient(token="", repository="owner/repo")
        with self.assertRaises(ValueError):
            GitHubClient(token="   ", repository="owner/repo")

    def test_github_client_rejects_empty_repository(self):
        """Verify constructor rejects empty or whitespace repository."""
        with self.assertRaises(ValueError):
            GitHubClient(token="valid-token", repository="")

    def test_instruction_sanitization(self):
        """Verify instruction sanitization strips newlines, control chars, and caps length."""
        from andromity.ci.task_runner import _sanitize_instruction
        # Newlines should be replaced with spaces
        self.assertNotIn("\n", _sanitize_instruction("line1\nline2\rline3"))
        # Backticks should be replaced with single quotes
        self.assertNotIn("`", _sanitize_instruction("run `rm -rf /`"))
        # Long instructions should be truncated
        long_input = "a" * 300
        result = _sanitize_instruction(long_input)
        self.assertLessEqual(len(result), 204)  # 200 + "..."
        self.assertTrue(result.endswith("..."))

    def test_review_marker_is_html_comment(self):
        """Verify review marker is a valid HTML comment that won't render visibly."""
        self.assertTrue(REVIEW_MARKER.startswith("<!--"))
        self.assertTrue(REVIEW_MARKER.endswith("-->"))


if __name__ == "__main__":
    unittest.main()

