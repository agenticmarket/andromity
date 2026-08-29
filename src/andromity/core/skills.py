"""Skills — installable instruction packs in the open Agent Skills format.

A skill is a folder named after the skill containing a SKILL.md file (YAML
frontmatter: name + description, then markdown instructions) and optional
helper scripts. Skills are installed from public GitHub registries into:

    ~/.andromity/skills/<name>/      (available in every project)
    <project>/.andromity/skills/     (available in this project only)
    ~/.agent/skills/<name>/      (available in all )

Installed skills are injected into the agent's system prompt so it knows what
is available and can follow a skill's SKILL.md when the user asks for it by
name (or when its task clearly matches). The registry is a curated list of
trusted open-source sources, so installing is a single click.
"""
import json
import re
import shutil
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional

from andromity.config import get_config_dir

USER_AGENT = "andromity-skills/0.1"

# Curated, trusted open-source registries. `path` is optional: when empty the
# whole repo is scanned for `<skill-name>/SKILL.md` folders (layout-agnostic).
# `max_skills` caps how many skills browse() returns per source so huge
# community libraries don't flood the skills screen.
REGISTRY_SOURCES: List[Dict[str, str]] = [
    {
        "id": "anthropic",
        "label": "Anthropic — official skills",
        "repo": "anthropics/skills",
        "branch": "main",
        "path": "",
        "max_skills": 200,
    },
    {
        "id": "community",
        "label": "Community — claude-skills library",
        "repo": "alirezarezvani/claude-skills",
        "branch": "main",
        "path": "",
        "max_skills": 50,
    },
]

GITHUB_API = "https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1"
RAW_URL = "https://raw.githubusercontent.com/{repo}/{branch}/{path}"

MENTION_RE = re.compile(r"@([A-Za-z0-9_-]+)")


def attach_skill_mentions(prompt: str, manager: "SkillsManager") -> str:
    """Append an explicit attach note for every @skill mention in the prompt.

    The agent's system prompt already lists installed skills, but an explicit
    directive is more reliable than hoping the model maps "@docx" to a skill.
    Mentions that don't match an installed skill are left untouched.
    """
    if not prompt:
        return prompt
    try:
        installed_map = {s.name: s for s in manager.installed()}
    except Exception:
        return prompt
    matched_names = sorted({m for m in MENTION_RE.findall(prompt) if m in installed_map})
    if not matched_names:
        return prompt
    skill_lines = "\n".join(
        f"- {name}: {Path(installed_map[name].path) / 'SKILL.md'}"
        for name in matched_names
    )
    note = (
        "\n\n[Attached skills: " + ", ".join(matched_names) + "]\n"
        "Skill instructions file(s):\n" + skill_lines + "\n"
        "The user explicitly attached the skill(s) above. Read each skill's SKILL.md file directly "
        "and follow its instructions for this task."
    )
    return prompt + note


def parse_frontmatter(md: str) -> Dict[str, str]:
    """Pull name/description out of the YAML frontmatter of a SKILL.md."""
    info = {"name": "", "description": ""}
    m = re.match(r"^---\s*\n(.*?)\n---", md, re.S)
    if not m:
        return info
    for line in m.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            info[key.strip().lower()] = value.strip().strip("\"'")
    return info


def _default_fetch(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


@dataclass
class SkillInfo:
    """A locally installed skill."""

    name: str
    description: str = ""
    source: str = ""
    scope: str = "user"  # "user" (all projects) | "project" (this repo)
    path: str = ""


@dataclass
class RemoteSkill:
    """A skill available in a registry source."""

    name: str
    description: str = ""
    source_id: str = ""
    source_label: str = ""
    repo: str = ""
    branch: str = ""
    dir: str = ""


class SkillsManager:
    """Installs, lists, and removes skills; feeds the agent its prompt block."""

    def __init__(self, project_path: str, fetch: Callable[[str], str] = _default_fetch,
                 user_dir: Optional[Path] = None):
        self._project_path = Path(project_path)
        self._user_dir = Path(user_dir) if user_dir else get_config_dir() / "skills"
        self._project_dir = self._project_path / ".andromity" / "skills"
        self._fetch = fetch
        self._trees: Dict[str, dict] = {}

    # ── Installed skills ───────────────────────────────────────────────────

    def installed(self) -> List[SkillInfo]:
        found: Dict[str, SkillInfo] = {}
        for scope, base in (("user", self._user_dir), ("project", self._project_dir)):
            if not base.is_dir():
                continue
            for d in sorted(base.iterdir()):
                skill_md = d / "SKILL.md"
                if not (d.is_dir() and skill_md.exists()):
                    continue
                info = parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
                found[d.name] = SkillInfo(
                    name=d.name,
                    description=info.get("description", ""),
                    source="",
                    scope=scope,
                    path=str(d),
                )
        return sorted(found.values(), key=lambda s: s.name)

    def installed_names(self) -> set:
        return {s.name for s in self.installed()}

    def prompt_block(self) -> str:
        """Markdown section appended to the agent's system prompt."""
        skills = self.installed()
        if not skills:
            return ""
        lines = "\n".join(
            f"- {s.name} (file: {Path(s.path) / 'SKILL.md'}): {s.description or 'no description'}"
            for s in skills
        )
        return (
            "## Installed Skills\n"
            f"{lines}\n\n"
            "The skills above are available on request. When the user names a skill "
            "(or a task clearly matches one), read its SKILL.md directly and follow its "
            "instructions exactly."
        )

    # ── Registry browsing ─────────────────────────────────────────────────

    def _tree(self, source: Dict[str, str]) -> dict:
        key = source["repo"]
        if key not in self._trees:
            self._trees[key] = json.loads(self._fetch(GITHUB_API.format(**source)))
        return self._trees[key]

    def browse(self, source_id: Optional[str] = None) -> List[RemoteSkill]:
        """List skills available in the registries (name + dir + source).

        Each source is capped at its ``max_skills`` limit (when set) so large
        community libraries don't flood the list; the UI tells the user to
        search for anything beyond the cap. Descriptions are intentionally NOT
        fetched here — large registries would need one request per skill. Call
        fetch_description() lazily (e.g. when a skill is selected in the UI)
        instead.
        """
        results: List[RemoteSkill] = []
        for src in REGISTRY_SOURCES:
            if source_id and src["id"] != source_id:
                continue
            base = (src.get("path") or "").strip("/")
            tree = self._tree(src)
            seen: set = set()
            per_source: List[RemoteSkill] = []
            for entry in tree.get("tree", []):
                p = entry.get("path", "")
                if p.endswith("/SKILL.md"):
                    d = p[: -len("/SKILL.md")]
                    if d in seen:
                        continue
                    seen.add(d)
                    if base and not (d == base or d.startswith(base + "/")):
                        continue
                    per_source.append(
                        RemoteSkill(
                            name=d.rsplit("/", 1)[-1],
                            description="",
                            source_id=src["id"],
                            source_label=src["label"],
                            repo=src["repo"],
                            branch=src["branch"],
                            dir=d,
                        )
                    )
            per_source.sort(key=lambda s: s.name)
            max_skills = int(src.get("max_skills") or 0)
            if max_skills:
                per_source = per_source[:max_skills]
            results.extend(per_source)
        results.sort(key=lambda s: (s.source_id, s.name))
        return results

    def fetch_description(self, remote: RemoteSkill) -> str:
        """Lazily fetch and parse a skill's SKILL.md description."""
        try:
            md = self._fetch(RAW_URL.format(repo=remote.repo, branch=remote.branch, path=f"{remote.dir}/SKILL.md"))
            return parse_frontmatter(md).get("description", "")
        except Exception:
            return ""

    # ── Install / uninstall ───────────────────────────────────────────────

    def install(self, name: str, source_id: str, scope: str = "user") -> Optional[SkillInfo]:
        """One-click install: copy the skill's files from its registry into place."""
        src = next((s for s in REGISTRY_SOURCES if s["id"] == source_id), None)
        if src is None:
            return None
        base = (src.get("path") or "").strip("/")
        tree = self._tree(src)

        skill_dir: Optional[str] = None
        for entry in tree.get("tree", []):
            p = entry.get("path", "")
            if p.endswith("/SKILL.md"):
                d = p[: -len("/SKILL.md")]
                if d.rsplit("/", 1)[-1] == name and (not base or d == base or d.startswith(base + "/")):
                    skill_dir = d
                    break
        if skill_dir is None:
            return None

        files = [
            e["path"]
            for e in tree.get("tree", [])
            if e.get("type") == "blob" and e["path"].startswith(skill_dir + "/")
        ]
        if not files:
            return None

        target = (self._user_dir if scope == "user" else self._project_dir) / name
        target.mkdir(parents=True, exist_ok=True)
        target_resolved = target.resolve()
        for f in files:
            rel = f[len(skill_dir) + 1:]
            if not rel:
                continue
            out = target / rel
            try:
                if not out.resolve().is_relative_to(target_resolved):
                    raise ValueError(f"Path traversal detected in skill tree entry: {f!r}")
            except ValueError:
                continue
            content = self._fetch(RAW_URL.format(repo=src["repo"], branch=src["branch"], path=f))
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(content, encoding="utf-8")

        info = parse_frontmatter((target / "SKILL.md").read_text(encoding="utf-8", errors="replace"))
        return SkillInfo(name=name, description=info.get("description", ""), source=source_id, scope=scope, path=str(target))

    def uninstall(self, name: str) -> bool:
        """Remove a skill from every scope it is installed in."""
        removed = False
        for base in (self._user_dir, self._project_dir):
            d = base / name
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
                removed = True
        return removed

    def skills_dir(self, scope: str = "user") -> Path:
        return self._user_dir if scope == "user" else self._project_dir
