"""Tests for the skills manager: registry browsing, install, uninstall, prompt."""
import asyncio
import json
import tempfile
from pathlib import Path

from andromity.core.skills import SkillsManager, attach_skill_mentions, parse_frontmatter


def _fake_fetch(tree_paths, files):
    """Return a fetcher that answers GitHub tree + raw file requests from memory."""
    tree_json = json.dumps({
        "tree": [
            {"path": p, "type": "blob" if not p.endswith("/") else "tree"}
            for p in tree_paths
        ],
        "truncated": False,
    })

    def fetch(url: str) -> str:
        if "/git/trees/" in url:
            return tree_json
        # raw URL: https://raw.githubusercontent.com/{repo}/{branch}/{path...}
        path = "/".join(url.split("/")[6:])
        if path in files:
            return files[path]
        raise FileNotFoundError(url)

    return fetch


DOCX_SKILL = """---
name: docx
description: Create and edit .docx documents with python-docx.
---
# docx skill

Follow the steps in this skill to build Word documents.
"""

SCRIPT = '#!/usr/bin/env python3\nprint("hi")\n'


def _tree_paths():
    return [
        "skills/docx/SKILL.md",
        "skills/docx/scripts/make_docx.py",
        "skills/pdf/SKILL.md",
    ]


def _files():
    return {
        "skills/docx/SKILL.md": DOCX_SKILL,
        "skills/docx/scripts/make_docx.py": SCRIPT,
        "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Merge and annotate PDFs.\n---\n# pdf skill\n",
    }


def test_parse_frontmatter():
    assert parse_frontmatter(DOCX_SKILL)["name"] == "docx"
    assert parse_frontmatter(DOCX_SKILL)["description"].startswith("Create and edit")
    assert parse_frontmatter("no frontmatter here")["name"] == ""


def test_browse_lists_all_skills_without_descriptions():
    proj = tempfile.mkdtemp()
    user = tempfile.mkdtemp()
    manager = SkillsManager(proj, fetch=_fake_fetch(_tree_paths(), _files()), user_dir=Path(user))

    skills = manager.browse(source_id="anthropic")
    names = {s.name for s in skills}
    assert names == {"docx", "pdf"}
    # Descriptions are lazy — browsing must not prefetch them
    assert all(s.description == "" for s in skills)
    docx = next(s for s in skills if s.name == "docx")
    assert docx.source_id == "anthropic"
    assert docx.dir == "skills/docx"


def test_browse_respects_max_skills_per_source(monkeypatch):
    """Huge community registries are capped so the skills screen stays usable."""
    import andromity.core.skills as sk_mod

    paths = [f"skills/s{i}/SKILL.md" for i in range(5)]
    manager = SkillsManager(tempfile.mkdtemp(),
                            fetch=_fake_fetch(paths, {}),
                            user_dir=Path(tempfile.mkdtemp()))

    # No cap -> all 5 returned
    monkeypatch.setattr(sk_mod, "REGISTRY_SOURCES", [{
        "id": "community", "label": "Community", "repo": "r", "branch": "main", "path": "",
    }])
    assert len(manager.browse()) == 5

    # Cap of 2 -> only the first 2 (alphabetical) skills returned
    monkeypatch.setattr(sk_mod, "REGISTRY_SOURCES", [{
        "id": "community", "label": "Community", "repo": "r", "branch": "main", "path": "",
        "max_skills": 2,
    }])
    skills = manager.browse()
    assert len(skills) == 2
    assert [s.name for s in skills] == ["s0", "s1"]


def test_fetch_description_lazy():
    proj = tempfile.mkdtemp()
    user = tempfile.mkdtemp()
    manager = SkillsManager(proj, fetch=_fake_fetch(_tree_paths(), _files()), user_dir=Path(user))

    skills = manager.browse(source_id="anthropic")
    docx = next(s for s in skills if s.name == "docx")
    desc = manager.fetch_description(docx)
    assert desc.startswith("Create and edit")


def test_install_writes_files_and_shows_in_prompt():
    proj = tempfile.mkdtemp()
    user = tempfile.mkdtemp()
    manager = SkillsManager(proj, fetch=_fake_fetch(_tree_paths(), _files()), user_dir=Path(user))

    info = manager.install("docx", "anthropic")
    assert info is not None
    assert info.name == "docx"
    assert info.scope == "user"

    skill_dir = Path(user) / "docx"
    assert (skill_dir / "SKILL.md").exists()
    assert (skill_dir / "scripts" / "make_docx.py").read_text(encoding="utf-8") == SCRIPT

    installed = manager.installed()
    assert [s.name for s in installed] == ["docx"]
    assert "docx" in manager.installed_names()

    block = manager.prompt_block()
    assert "## Installed Skills" in block
    assert "docx" in block and "python-docx" in block


def test_install_scope_project_writes_to_project():
    proj = tempfile.mkdtemp()
    user = tempfile.mkdtemp()
    manager = SkillsManager(proj, fetch=_fake_fetch(_tree_paths(), _files()), user_dir=Path(user))

    info = manager.install("pdf", "anthropic", scope="project")
    assert info is not None
    assert info.scope == "project"
    assert (Path(proj) / ".andromity" / "skills" / "pdf" / "SKILL.md").exists()
    assert manager.installed()[0].scope == "project"


def test_install_unknown_skill_returns_none():
    proj = tempfile.mkdtemp()
    user = tempfile.mkdtemp()
    manager = SkillsManager(proj, fetch=_fake_fetch(_tree_paths(), _files()), user_dir=Path(user))
    assert manager.install("does-not-exist", "anthropic") is None


def test_uninstall_removes_skill():
    proj = tempfile.mkdtemp()
    user = tempfile.mkdtemp()
    manager = SkillsManager(proj, fetch=_fake_fetch(_tree_paths(), _files()), user_dir=Path(user))
    manager.install("docx", "anthropic")
    assert manager.uninstall("docx") is True
    assert manager.installed() == []
    assert manager.prompt_block() == ""
    assert manager.uninstall("docx") is False  # already gone


def test_attach_skill_mentions():
    proj = tempfile.mkdtemp()
    user = tempfile.mkdtemp()
    manager = SkillsManager(proj, fetch=_fake_fetch(_tree_paths(), _files()), user_dir=Path(user))
    manager.install("docx", "anthropic")

    # Installed mention -> explicit attach directive appended
    out = attach_skill_mentions("create a report with @docx", manager)
    assert "Attached skills: docx" in out
    assert "SKILL.md" in out

    # Unknown mention -> left untouched
    assert attach_skill_mentions("use @unknown here", manager) == "use @unknown here"

    # No mention -> unchanged
    assert attach_skill_mentions("plain message", manager) == "plain message"


def test_skills_ui_lazy_description_and_project_scope():
    """Selecting a skill lazy-loads its description; the scope checkbox makes
    installs go to the current project only."""
    import andromity.tui.overlays.skills as sk_mod
    from andromity.core.skills import RemoteSkill, SkillInfo

    class StubManager:
        def __init__(self, *a, **k):
            self.calls = []
            self.installed_list = []

        def browse(self, source_id=None):
            return [
                RemoteSkill(name="docx", description="", source_id="anthropic",
                            source_label="A", repo="r", branch="main", dir="skills/docx"),
                RemoteSkill(name="pdf", description="", source_id="anthropic",
                            source_label="A", repo="r", branch="main", dir="skills/pdf"),
            ]

        def fetch_description(self, remote):
            self.calls.append(f"fetch:{remote.name}")
            return "Create Word documents"

        def installed(self):
            return list(self.installed_list)

        def installed_names(self):
            return set()

        def install(self, name, source_id, scope="user"):
            self.calls.append(f"install:{name}:{scope}")
            self.installed_list.append(SkillInfo(name=name, description="ok", scope=scope))
            return self.installed_list[-1]

        def uninstall(self, name):
            return True

    sk_mod.SkillsManager = StubManager

    async def _run():
        from textual.app import App, ComposeResult
        from textual.widgets import Static

        from andromity.tui.overlays.skills import SkillsScreen

        class T(App):
            def compose(self) -> ComposeResult:
                yield Static("host")

        app = T()
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause()
            app.push_screen(SkillsScreen(tempfile.mkdtemp()))
            for _ in range(12):
                await pilot.pause()
            m = app.screen
            mgr = m._manager
            # Both skills listed (full registry, no prefetch)
            assert len(m.query(".sk-row")) == 2
            assert not any("fetch:" in c for c in mgr.calls)

            # Selecting lazy-loads the description and renders it
            await pilot.press("down")
            await pilot.pause()
            for _ in range(6):
                await pilot.pause()
            assert any(c.startswith("fetch:docx") for c in mgr.calls)
            assert "Word documents" in str(m.query(".sk-row")[0].render())

            # Toggle project scope, then install -> install called with project
            m.query_one("#sk-scope-project").value = True
            await pilot.pause()
            await pilot.press("enter")
            for _ in range(8):
                await pilot.pause()
            assert any(c.startswith("install:docx:project") for c in mgr.calls), mgr.calls

    asyncio.run(_run())
