"""Build skills-catalog/catalog.json from the registries in andromity.core.skills.

    python scripts/build_skills_catalog.py

Set GITHUB_TOKEN to avoid the unauthenticated GitHub API rate limit. Categories
come from keyword rules; run scripts/classify-skills-catalog.mjs afterwards to
re-categorize skills with the OpenRouter Decisions model. A skill whose files
haven't changed keeps its earlier LLM category. Category, tag, featured,
verified and hidden fixes live in skills-catalog/overrides.json, keyed by
"<source_id>/<skill-name>", and always win.
"""
import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict

from andromity.core.skill_catalog import build_catalog
from andromity.core.skills import REGISTRY_SOURCES, USER_AGENT

ROOT = Path(__file__).resolve().parents[1]
CATALOG_DIR = ROOT / "skills-catalog"


def fetch(url: str, timeout: int = 30) -> str:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=CATALOG_DIR / "catalog.json")
    parser.add_argument("--overrides", type=Path, default=CATALOG_DIR / "overrides.json")
    args = parser.parse_args()

    overrides: Dict[str, Dict[str, Any]] = {}
    if args.overrides.exists():
        overrides = json.loads(args.overrides.read_text(encoding="utf-8"))

    previous_doc: Dict[str, Any] = {}
    if args.out.exists():
        previous_doc = json.loads(args.out.read_text(encoding="utf-8"))
    previous = {e["id"]: e for e in previous_doc.get("skills", []) if isinstance(e, dict) and "id" in e}

    catalog = build_catalog(REGISTRY_SOURCES, fetch, overrides, previous=previous)

    if previous_doc.get("skills") == catalog["skills"] and previous_doc.get("categories") == catalog["categories"]:
        print(f"No changes ({len(catalog['skills'])} skills); {args.out} left untouched.")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    counts: Dict[str, int] = {}
    methods: Dict[str, int] = {}
    for skill in catalog["skills"]:
        counts[skill["category"]] = counts.get(skill["category"], 0) + 1
        methods[skill["classified_by"]] = methods.get(skill["classified_by"], 0) + 1
    print(f"Wrote {len(catalog['skills'])} skills to {args.out} (classified by: {methods})")
    for category, count in sorted(counts.items(), key=lambda item: -item[1]):
        print(f"  {category:<12} {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
