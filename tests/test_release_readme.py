import base64
import importlib.util
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import MagicMock

import pytest

spec = importlib.util.spec_from_file_location("release_readme", Path(__file__).parents[1] / "scripts/release-readme.py")
release_readme = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_readme)

RELEASE = {
    "tag_name": "v0.2.15", "html_url": "https://github.com/agenticmarket/andromity/releases/tag/v0.2.15",
    "body": "### Fixed\n- First fix\n- Second fix\n- Third fix\n- Fourth fix",
}


def test_update_replaces_only_latest_section_and_is_idempotent():
    original = "# Product\n\n## Changelog\n\nHistory link\n"
    updated = release_readme.update_readme(original, RELEASE)
    assert "First fix" in updated and "Fourth fix" not in updated
    assert updated.startswith("# Product\n") and updated.endswith("History link\n")
    assert release_readme.update_readme(updated, RELEASE) == updated
    newer = dict(RELEASE, tag_name="v0.2.16")
    assert "v0.2.15\n" not in release_readme.update_readme(updated, newer)
    assert updated.count(release_readme.START) == 1


@pytest.mark.parametrize("text", [release_readme.START, release_readme.END,
    release_readme.END + release_readme.START, release_readme.START * 2 + release_readme.END * 2])
def test_rejects_malformed_markers(text):
    with pytest.raises(ValueError):
        release_readme.update_readme(text, RELEASE)


def test_rejects_unsafe_release_before_mutation():
    api = MagicMock()
    api.request.return_value = dict(RELEASE, tag_name="../../main")
    with pytest.raises(ValueError):
        release_readme.open_release_pr(api)
    api.request.assert_called_once_with("releases/latest")


def test_current_readme_performs_no_api_mutations():
    api = MagicMock()
    readme = release_readme.update_readme("## Changelog\n", RELEASE)
    api.request.side_effect = [RELEASE, {"content": base64.b64encode(readme.encode()).decode()}]
    assert release_readme.open_release_pr(api) is None
    assert all(len(call.args) == 1 for call in api.request.call_args_list)


def test_create_readme_only_pr_and_reuse_existing_branch():
    api = MagicMock(repository="owner/repo")
    readme = "# Product\n\n## Changelog\n"
    encoded = base64.b64encode(readme.encode()).decode()
    state = {"branch": False, "content": encoded, "pull": None}

    def request(path, method="GET", data=None):
        if path == "releases/latest":
            return RELEASE
        if path == "contents/README.md?ref=main":
            return {"content": encoded}
        if path.startswith("git/ref/heads/andromity"):
            if not state["branch"]:
                raise HTTPError(path, 404, "missing", {}, None)
            return {}
        if path == "git/ref/heads/main":
            return {"object": {"sha": "main-sha"}}
        if path == "git/refs":
            state["branch"] = True
            return {}
        if path.startswith("contents/README.md?"):
            return {"sha": "file-sha", "content": state["content"]}
        if path == "contents/README.md":
            assert method == "PUT" and data["sha"] == "file-sha"
            state["content"] = data["content"]
            return {}
        if path.startswith("pulls?"):
            return [state["pull"]] if state["pull"] else []
        if path == "pulls":
            assert method == "POST" and data["base"] == "main"
            assert "No AI inference" in data["body"]
            state["pull"] = {"html_url": "https://github.com/owner/repo/pull/1", "state": "open"}
            return state["pull"]
        raise AssertionError(path)

    api.request.side_effect = request
    assert release_readme.open_release_pr(api).endswith("/pull/1")
    api.request.reset_mock()
    assert release_readme.open_release_pr(api).endswith("/pull/1")
    assert all(len(call.args) == 1 for call in api.request.call_args_list)
