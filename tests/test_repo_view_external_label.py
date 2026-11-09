"""Independent adversarial test: the label the engine stores for a chat that holds GitHub text.

The VS Code side reads a review's pull request back from this label after a restart ("Edit and post"), so cutting it
must never turn "#12345" into "#12" (another pull request). Spec: private/design/repo-view/DESIGN.md 1, 5.
"""
import re

from andromity.core.tools import read_external_context


def test_long_review_label_is_never_cut_inside_the_number():
    # GitHub allows 39-character owners and 100-character repository names.
    for owner, repo, number in (("o" * 39, "r" * 70, 12345), ("o" * 39, "r" * 75, 4567890123), ("acme", "orders", 7)):
        source = f"github:{owner}/{repo}#{number}"
        label, _ = read_external_context({"source": source, "text": "x"})
        match = re.search(r"#(\d+)$", label)
        assert label == source or not match, f"stored {label[-12:]!r} for {source[-12:]!r}"


def test_question_labels_stay_questions():
    label, _ = read_external_context({"source": "github:acme/orders/pull-question#7", "text": "x"})
    assert label == "github:acme/orders/pull-question#7"
