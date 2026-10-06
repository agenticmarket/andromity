"""Open an idempotent README-only release PR using the GitHub API, without an LLM."""

from __future__ import annotations

import base64
import json
import os
import re
import sys
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

START = "<!-- andromity:latest-release:start -->"
END = "<!-- andromity:latest-release:end -->"
BOT_EMAIL = "333054755+andromity-bot@users.noreply.github.com"


def release_section(release: dict[str, Any]) -> str:
    tag = release["tag_name"]
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Only stable vMAJOR.MINOR.PATCH releases are supported.")
    url = release["html_url"]
    if not url.startswith("https://github.com/") or any(c in url for c in "\n\r()"):
        raise ValueError("Invalid GitHub release URL.")
    bullets = []
    for line in release.get("body", "").splitlines():
        if line.startswith("- "):
            bullets.append(line)
        if len(bullets) == 3:
            break
    highlights = "\n".join(bullets) or "See the release notes for changes and fixes."
    return (
        f"{START}\n## Latest release: {tag}\n\n{highlights}\n\n"
        f"[Release notes]({url}) · [Full changelog](CHANGELOG.md)\n{END}"
    )


def update_readme(readme: str, release: dict[str, Any]) -> str:
    section = release_section(release)
    if readme.count(START) != readme.count(END) or readme.count(START) > 1:
        raise ValueError("README release markers are missing or duplicated.")
    if START in readme:
        start = readme.index(START)
        end = readme.index(END)
        if end < start:
            raise ValueError("README release markers are reversed.")
        return readme[:start] + section + readme[end + len(END):]
    heading = "## Changelog"
    if heading not in readme:
        raise ValueError("README needs a Changelog heading or release markers.")
    return readme.replace(heading, section + "\n\n" + heading, 1)


class GitHub:
    def __init__(self, repository: str, token: str) -> None:
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or not token:
            raise ValueError("GITHUB_REPOSITORY and GH_TOKEN are required.")
        self.repository = repository
        self.token = token

    def request(self, path: str, method: str = "GET", data: Any = None) -> Any:
        request = Request(
            f"https://api.github.com/repos/{self.repository}/{path}",
            data=json.dumps(data).encode() if data is not None else None,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "Andromity-release-notes",
            },
        )
        with urlopen(request, timeout=30) as response:
            return json.load(response)


def open_release_pr(api: GitHub) -> str | None:
    release = api.request("releases/latest")
    if release.get("draft") or release.get("prerelease"):
        return None
    # Validate before any API mutation.
    release_section(release)
    tag = release["tag_name"]
    base = "main"
    branch = f"andromity/release-notes-{tag}"
    owner = api.repository.split("/")[0]
    main_file = api.request("contents/README.md?ref=main")
    original = base64.b64decode(main_file["content"]).decode("utf-8")
    updated = update_readme(original, release)
    if updated == original:
        print(f"README already describes {tag}; no changes needed.")
        return None
    query = urlencode({"state": "all", "head": f"{owner}:{branch}", "base": base})
    existing = api.request("pulls?" + query)
    if existing and existing[0]["state"] == "closed":
        print("The release PR was already closed; leaving the maintainer decision intact.")
        return existing[0]["html_url"]
    try:
        api.request(f"git/ref/heads/{quote(branch, safe='')}")
    except HTTPError as error:
        if error.code != 404:
            raise
        ref = api.request("git/ref/heads/main")
        api.request("git/refs", "POST", {"ref": f"refs/heads/{branch}", "sha": ref["object"]["sha"]})
    branch_file = api.request("contents/README.md?" + urlencode({"ref": branch}))
    branch_readme = base64.b64decode(branch_file["content"]).decode("utf-8")
    updated = update_readme(branch_readme, release)
    if branch_readme != updated:
        api.request("contents/README.md", "PUT", {
            "message": f"docs: update release notes for {tag}\n\nCo-authored-by: Andromity <{BOT_EMAIL}>",
            "content": base64.b64encode(updated.encode()).decode(),
            "sha": branch_file["sha"], "branch": branch,
            "author": {"name": "Andromity", "email": BOT_EMAIL},
        })
    if existing:
        print(f"Release PR already exists ({existing[0]['state']}).")
        return existing[0]["html_url"]
    pull = api.request("pulls", "POST", {
        "title": f"docs: latest Andromity release {tag}", "head": branch, "base": base,
        "body": (
            f"Update the README latest-release section from [the published {tag} notes]({release['html_url']}).\n\n"
            "Generated by the Andromity release workflow using a deterministic script. "
            "No AI inference or model tokens were used. The full changelog is retained. "
            "Please review and merge manually."
        ),
    })
    return pull["html_url"]


def main() -> int:
    try:
        api = GitHub(os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GH_TOKEN", ""))
        url = open_release_pr(api)
        if url:
            print(f"Release README PR: {url}")
        return 0
    except HTTPError as error:
        print(f"GitHub API rejected the release update (HTTP {error.code}). "
              "Check token permissions and Settings > Actions > General > "
              "Allow GitHub Actions to create and approve pull requests.", file=sys.stderr)
    except (ValueError, OSError, KeyError) as error:
        print(f"Release README update failed: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
