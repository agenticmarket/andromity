"""Tests for the skills catalog: categorizer, builder, parsing and SkillsManager integration."""
import json
import os
import tempfile
import time
from pathlib import Path

import pytest

from andromity.core import skill_catalog
from andromity.core.skill_catalog import build_catalog, categorize, parse_catalog
from andromity.core.skills import REGISTRY_SOURCES, SkillsManager, parse_frontmatter

COMMIT = "a" * 40
NEW_COMMIT = "b" * 40
SOURCE = {"id": "anthropic", "label": "Anthropic", "repo": "anthropics/skills", "branch": "main", "path": "",
          "verified": True}


def _repo_fetch(skills, commit=COMMIT, extra=None, folder_sha="f1"):
    """Fake GitHub: commits API, recursive tree and raw files for ``skills`` {dir: SKILL.md text}."""
    tree = [{"path": d, "type": "tree", "sha": f"{folder_sha}-{d}"} for d in skills]
    for d in skills:
        tree.append({"path": f"{d}/SKILL.md", "type": "blob"})
    hits = []

    def fetch(url):
        hits.append(url)
        if "/commits/" in url:
            return json.dumps({"sha": commit})
        if "/git/trees/" in url:
            return json.dumps({"tree": tree, "truncated": False})
        if "raw.githubusercontent.com" in url:
            path = "/".join(url.split("/")[6:])
            for d, text in skills.items():
                if path == f"{d}/SKILL.md":
                    return text
        if extra and url in extra:
            return extra[url]
        raise FileNotFoundError(url)

    fetch.hits = hits
    return fetch


def _md(name, description, extra=""):
    return f"---\nname: {name}\ndescription: {description}\n{extra}---\n# {name}\n"


SKILLS = {
    "skills/pdf": _md("pdf", "Extract text and fill forms in PDF documents."),
    "skills/frontend-design": _md("frontend-design", "Build polished UI with Tailwind and CSS."),
    "skills/mystery": _md("mystery", "Does a thing."),
}


@pytest.mark.parametrize("name,description,expected", [
    ("pdf", "Merge and annotate PDF files", "documents"),
    ("xlsx", "Edit spreadsheets", "documents"),
    ("frontend-design", "Create distinctive UI", "design"),
    ("webapp-testing", "Test web apps with Playwright", "testing"),
    ("mcp-builder", "Build MCP servers for external APIs", "api"),
    ("ci-pipeline", "Set up deploy pipelines with Docker", "devops"),
    ("sql-analytics", "Query datasets and build dashboards", "data"),
    ("pentest", "Find vulnerabilities (OWASP)", "security"),
    ("session-memory", "Persistent notes and recall across sessions", "memory"),
    ("blog-writer", "Draft blog posts and marketing copy", "writing"),
    ("refactor-helper", "Refactor Python codebase architecture", "engineering"),
    ("mystery", "Does a thing.", "other"),
])
def test_categorize(name, description, expected):
    assert categorize(name, description)[0] == expected


def test_categorize_tags_include_declared_and_matched_without_category_id():
    category, tags = categorize("pdf", "Extract text from PDF documents", ["forms"])
    assert category == "documents"
    assert tags[0] == "forms"
    assert "pdf" in tags and "documents" not in tags
    assert len(tags) <= skill_catalog.MAX_TAGS


def test_split_tags_formats():
    assert skill_catalog.split_tags("[a, B, c]") == ["a", "b", "c"]
    assert skill_catalog.split_tags("- one - two") == ["one", "two"]
    assert skill_catalog.split_tags("") == []


def test_parse_frontmatter_folded_description_and_nested_keys():
    md = ("---\nname: x\ndescription: >\n  First line\n  second line\n"
          "metadata:\n  name: nested\n  version: 1\ntags:\n  - alpha\n  - beta\n---\nbody")
    fm = parse_frontmatter(md)
    assert fm["name"] == "x"
    assert fm["description"] == "First line second line"
    assert fm["tags"] == "alpha beta"


def test_build_catalog_entries_are_pinned_and_categorized():
    catalog = build_catalog([SOURCE], _repo_fetch(SKILLS), generated_at="now")
    assert catalog["version"] == 1
    by_name = {s["name"]: s for s in catalog["skills"]}
    assert set(by_name) == {"pdf", "frontend-design", "mystery"}
    pdf = by_name["pdf"]
    assert pdf["id"] == "anthropic/pdf"
    assert pdf["category"] == "documents"
    assert pdf["commit"] == COMMIT
    assert pdf["version"] == "f1-skills/pdf"
    assert pdf["verified"] is True and pdf["featured"] is False
    assert by_name["mystery"]["category"] == "other"
    assert {c["id"] for c in catalog["categories"]} >= {"documents", "design", "other"}


def test_build_catalog_overrides():
    overrides = {
        "anthropic/mystery": {"category": "engineering", "tags": ["x"], "featured": True},
        "pdf": {"hidden": True},
    }
    catalog = build_catalog([SOURCE], _repo_fetch(SKILLS), overrides)
    by_name = {s["name"]: s for s in catalog["skills"]}
    assert "pdf" not in by_name
    assert by_name["mystery"]["category"] == "engineering"
    assert by_name["mystery"]["tags"] == ["x"]
    assert by_name["mystery"]["featured"] is True

    with pytest.raises(ValueError):
        build_catalog([SOURCE], _repo_fetch(SKILLS), {"mystery": {"category": "nope"}})


def test_build_catalog_rejects_truncated_tree():
    fetch = _repo_fetch(SKILLS)

    def truncated(url):
        text = fetch(url)
        return json.dumps({**json.loads(text), "truncated": True}) if "/git/trees/" in url else text

    with pytest.raises(RuntimeError):
        build_catalog([SOURCE], truncated)


def test_build_catalog_keeps_going_when_a_description_fetch_fails():
    skills = dict(SKILLS)
    fetch = _repo_fetch(skills)

    def flaky(url):
        if url.endswith("skills/pdf/SKILL.md"):
            raise OSError("boom")
        return fetch(url)

    entry = next(s for s in build_catalog([SOURCE], flaky)["skills"] if s["name"] == "pdf")
    assert entry["description"] == ""


def test_parse_catalog_validates_and_filters():
    allowed = {"anthropic": "anthropics/skills"}
    good = {k: "x" for k in ("name", "dir", "source_id", "repo", "branch")}
    good.update(source_id="anthropic", repo="anthropics/skills", category="bogus", verified=True, tags=["a", 1])
    foreign = dict(good, repo="evil/skills")
    broken = {"name": "no-dir"}
    doc = json.dumps({"version": 1, "skills": [good, foreign, broken, "junk"]})

    entries = parse_catalog(doc, allowed)
    assert [e["name"] for e in entries] == ["x"]
    assert entries[0]["category"] == "other"
    assert entries[0]["tags"] == ["a"]
    assert entries[0]["verified"] is True

    assert parse_catalog("not json") is None
    assert parse_catalog(json.dumps({"version": 99, "skills": []})) is None
    assert parse_catalog(json.dumps({"version": 1, "skills": "nope"})) is None


def _manager(fetch):
    return SkillsManager(tempfile.mkdtemp(), fetch=fetch, user_dir=Path(tempfile.mkdtemp()))


def _catalog_text(skills=SKILLS, commit=COMMIT, **kw):
    return json.dumps(build_catalog([SOURCE], _repo_fetch(skills, commit=commit, **kw), generated_at="now"))


def _catalog_fetch(catalog_text, base=None):
    """Serve catalog.json and, optionally, the GitHub fake behind it."""
    def fetch(url):
        if url == skill_catalog.CATALOG_URL:
            if catalog_text is None:
                raise OSError("offline")
            return catalog_text
        if base is None:
            raise FileNotFoundError(url)
        return base(url)
    return fetch


def test_browse_prefers_catalog_and_sorts_featured_then_verified():
    overrides = {"mystery": {"featured": True}}
    text = json.dumps(build_catalog([SOURCE], _repo_fetch(SKILLS), overrides))
    mgr = _manager(_catalog_fetch(text))
    remotes = mgr.browse()
    assert [r.name for r in remotes][0] == "mystery"
    pdf = next(r for r in remotes if r.name == "pdf")
    assert pdf.category == "documents" and pdf.category_label == "Documents"
    assert pdf.description.startswith("Extract text")
    assert pdf.commit == COMMIT and pdf.verified
    assert [r.name for r in mgr.browse(source_id="community")] == []


def test_browse_catalog_is_not_capped_by_max_skills():
    many = {f"skills/s{i}": _md(f"s{i}", "x") for i in range(60)}
    mgr = _manager(_catalog_fetch(_catalog_text(many)))
    assert len(mgr.browse()) == 60


def test_browse_falls_back_to_registry_scan_with_name_categories():
    base = _repo_fetch(SKILLS)
    mgr = _manager(_catalog_fetch(None, base))
    remotes = {r.name: r for r in mgr.browse(source_id="anthropic")}
    assert set(remotes) == {"pdf", "frontend-design", "mystery"}
    assert remotes["pdf"].category == "documents"
    assert remotes["pdf"].description == ""
    assert remotes["pdf"].verified is True


def test_catalog_is_cached_on_disk_and_stale_cache_survives_offline():
    user = Path(tempfile.mkdtemp())
    text = _catalog_text()
    SkillsManager(tempfile.mkdtemp(), fetch=_catalog_fetch(text), user_dir=user).browse()
    cache = user / ".catalog-cache.json"
    assert cache.exists()

    # Fresh cache: no network needed at all
    def no_network(url):
        raise AssertionError("fetched despite fresh cache")
    assert len(SkillsManager(tempfile.mkdtemp(), fetch=no_network, user_dir=user).browse()) == 3

    # Expired cache + offline: stale copy still served
    old = time.time() - skill_catalog.CATALOG_TTL_SECONDS - 60
    os.utime(cache, (old, old))
    offline = SkillsManager(tempfile.mkdtemp(), fetch=_catalog_fetch(None), user_dir=user)
    assert len(offline.browse()) == 3


def test_catalog_url_env_override(monkeypatch):
    monkeypatch.setenv(skill_catalog.CATALOG_URL_ENV, "https://example.test/catalog.json")
    seen = []

    def fetch(url):
        seen.append(url)
        return _catalog_text()

    _manager(fetch).browse()
    assert seen == ["https://example.test/catalog.json"]


def test_catalog_entries_for_unlisted_repos_are_ignored():
    doc = json.loads(_catalog_text())
    doc["skills"][0]["repo"] = "evil/skills"
    mgr = _manager(_catalog_fetch(json.dumps(doc)))
    assert len(mgr.browse()) == 2


def test_install_pinned_records_version_and_detects_update():
    github = _repo_fetch(SKILLS)
    mgr = _manager(_catalog_fetch(_catalog_text(), github))
    remote = next(r for r in mgr.browse() if r.name == "pdf")

    info = mgr.install("pdf", "anthropic", ref=remote.commit)
    assert info.version == remote.version == "f1-skills/pdf"
    assert any(COMMIT in u and "raw.githubusercontent.com" in u for u in github.hits)

    installed = mgr.installed()[0]
    assert installed.source == "anthropic"
    assert installed.version == remote.version

    cache = mgr._user_dir / ".catalog-cache.json"
    expired = time.time() - skill_catalog.CATALOG_TTL_SECONDS - 60
    os.utime(cache, (expired, expired))
    updated = _repo_fetch(SKILLS, commit=NEW_COMMIT, folder_sha="f2")
    mgr2 = SkillsManager(mgr._project_path, fetch=_catalog_fetch(_catalog_text(commit=NEW_COMMIT, folder_sha="f2"), updated),
                         user_dir=mgr._user_dir)
    fresh = next(r for r in mgr2.browse() if r.name == "pdf")
    assert fresh.version == "f2-skills/pdf" != mgr2.installed()[0].version


def test_install_replaces_folder_so_removed_files_do_not_linger():
    fetch = _repo_fetch(SKILLS)
    mgr = _manager(fetch)
    mgr.install("pdf", "anthropic")
    stale = mgr.skills_dir() / "pdf" / "old-script.py"
    stale.write_text("x", encoding="utf-8")
    mgr.install("pdf", "anthropic")
    assert not stale.exists()
    assert (mgr.skills_dir() / "pdf" / "SKILL.md").exists()


def test_failed_download_leaves_existing_install_untouched():
    mgr = _manager(_repo_fetch(SKILLS))
    mgr.install("pdf", "anthropic")
    good = (mgr.skills_dir() / "pdf" / "SKILL.md").read_text(encoding="utf-8")
    base = _repo_fetch(SKILLS)

    def failing(url):
        if "raw.githubusercontent.com" in url:
            raise OSError("network down")
        return base(url)

    mgr._fetch = failing
    mgr._trees.clear()
    with pytest.raises(OSError):
        mgr.install("pdf", "anthropic")
    assert (mgr.skills_dir() / "pdf" / "SKILL.md").read_text(encoding="utf-8") == good


def test_install_falls_back_to_branch_when_pinned_commit_is_gone():
    base = _repo_fetch(SKILLS)

    def fetch(url):
        if f"/git/trees/{COMMIT}" in url:
            raise OSError("404")
        return base(url)

    info = _manager(fetch).install("pdf", "anthropic", ref=COMMIT)
    assert info is not None
    assert not any(COMMIT in u and "raw.githubusercontent.com" in u for u in base.hits)


def test_install_rejects_non_sha_ref():
    with pytest.raises(ValueError):
        _manager(_repo_fetch(SKILLS)).install("pdf", "anthropic", ref="../../main")


def test_registry_sources_have_verified_flag_only_for_anthropic():
    flags = {s["id"]: bool(s.get("verified")) for s in REGISTRY_SOURCES}
    assert flags["anthropic"] is True and flags["community"] is False


def test_categorize_uses_parent_folder_but_not_for_tags():
    category, tags = categorize("retention", "Plan it.", folder="marketing/growth-team")
    assert category == "writing"
    assert "marketing" not in tags

    assert categorize("retention", "Plan it.")[0] == "other"


def test_symlinked_skill_files_are_not_skills_and_not_installed():
    from andromity.core.skills import skill_dirs

    tree = {"tree": [
        {"path": "real/pdf/SKILL.md", "type": "blob", "mode": "100644"},
        {"path": ".gemini/skills/pdf/SKILL.md", "type": "blob", "mode": "120000"},
    ]}
    assert skill_dirs(tree) == ["real/pdf"]

    files = {"real/pdf/SKILL.md": _md("pdf", "PDF tools"), "real/pdf/link.md": "../elsewhere"}
    full_tree = {"tree": tree["tree"] + [
        {"path": "real/pdf", "type": "tree", "sha": "t"},
        {"path": "real/pdf/link.md", "type": "blob", "mode": "120000"},
    ], "truncated": False}

    def fetch(url):
        if "/git/trees/" in url:
            return json.dumps(full_tree)
        return files["/".join(url.split("/")[6:])]

    mgr = _manager(fetch)
    mgr.install("pdf", "anthropic")
    assert not (mgr.skills_dir() / "pdf" / "link.md").exists()
    assert (mgr.skills_dir() / "pdf" / "SKILL.md").exists()


def _as_classified(catalog, **categories):
    """What scripts/classify-skills-catalog.mjs does to a catalog: stamp LLM categories onto entries."""
    for entry in catalog["skills"]:
        if entry["name"] in categories:
            entry["category"] = categories[entry["name"]]
            entry["classified_by"] = "llm"
    return {e["id"]: e for e in catalog["skills"]}


def test_catalog_categories_carry_descriptions_for_the_classifier():
    categories = build_catalog([SOURCE], _repo_fetch(SKILLS))["categories"]
    assert {c["id"] for c in categories} == set(skill_catalog.CATEGORY_LABELS)
    assert all(c["label"] and c["description"] for c in categories)


def test_rebuild_keeps_llm_categories_for_unchanged_skills_only():
    first = build_catalog([SOURCE], _repo_fetch(SKILLS))
    assert {s["classified_by"] for s in first["skills"]} == {"rules"}
    previous = _as_classified(first, mystery="memory", pdf="engineering")

    again = {s["name"]: s for s in build_catalog([SOURCE], _repo_fetch(SKILLS), previous=previous)["skills"]}
    assert again["mystery"]["category"] == "memory" and again["mystery"]["classified_by"] == "llm"
    assert again["pdf"]["category"] == "engineering"
    assert again["frontend-design"]["classified_by"] == "rules"

    changed = {s["name"]: s for s in
               build_catalog([SOURCE], _repo_fetch(SKILLS, folder_sha="f9"), previous=previous)["skills"]}
    assert changed["mystery"]["category"] == "other" and changed["mystery"]["classified_by"] == "rules"
    assert changed["pdf"]["category"] == "documents"


def test_overrides_beat_earlier_llm_categories_and_locked_tags_survive():
    first = build_catalog([SOURCE], _repo_fetch(SKILLS))
    previous = _as_classified(first, mystery="memory", pdf="engineering")
    overrides = {"anthropic/pdf": {"category": "documents"}, "mystery": {"tags": ["mine"]}}
    rebuilt = {s["name"]: s for s in build_catalog([SOURCE], _repo_fetch(SKILLS), overrides, previous=previous)["skills"]}
    assert rebuilt["pdf"]["category"] == "documents" and rebuilt["pdf"]["classified_by"] == "override"
    assert rebuilt["mystery"]["category"] == "memory" and rebuilt["mystery"]["tags"] == ["mine"]
    assert "tags_locked" not in rebuilt["mystery"]


def test_an_llm_category_that_is_no_longer_valid_is_ignored():
    first = build_catalog([SOURCE], _repo_fetch(SKILLS))
    previous = _as_classified(first, mystery="retired-category")
    rebuilt = {s["name"]: s for s in build_catalog([SOURCE], _repo_fetch(SKILLS), previous=previous)["skills"]}
    assert rebuilt["mystery"]["category"] == "other" and rebuilt["mystery"]["classified_by"] == "rules"


def test_read_skill_md_for_registry_and_installed_skills_strips_frontmatter():
    mgr = _manager(_repo_fetch(SKILLS))
    remote_doc = mgr.read_skill_md("pdf", "anthropic")
    assert remote_doc == "# pdf"
    assert mgr.read_skill_md("nope", "anthropic") is None

    mgr.install("pdf", "anthropic")
    installed = mgr.installed()[0]
    assert mgr.read_skill_md("pdf", path=installed.path) == "# pdf"
    # A path that isn't an installed skill is never read
    assert mgr.read_skill_md("pdf", path=str(Path(installed.path).parent)) is None


def test_read_skill_md_falls_back_to_branch_when_pinned_commit_missing():
    base = _repo_fetch(SKILLS)

    def fetch(url):
        if skill_catalog.CATALOG_URL == url:
            return _catalog_text()
        if f"/{COMMIT}/" in url and "raw.githubusercontent.com" in url:
            raise OSError("gone")
        return base(url)

    assert _manager(fetch).read_skill_md("pdf", "anthropic") == "# pdf"
