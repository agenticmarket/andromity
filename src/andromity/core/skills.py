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
import logging
import os
import re
import shutil
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

from andromity.config import get_config_dir
from andromity.core import skill_catalog

log = logging.getLogger(__name__)

if TYPE_CHECKING:
    from andromity.core.session import Session

USER_AGENT = "andromity-skills/0.1"

# Curated, trusted open-source registries. `path` is optional: when empty the
# whole repo is scanned for `<skill-name>/SKILL.md` folders (layout-agnostic).
# `max_skills` caps how many skills browse() returns per source so huge
# community libraries don't flood the skills screen.
REGISTRY_SOURCES: List[Dict[str, Any]] = [
    {
        "id": "anthropic",
        "label": "Anthropic — official skills",
        "repo": "anthropics/skills",
        "branch": "main",
        "path": "",
        "max_skills": 200,
        "verified": True,
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
COMMIT_API = "https://api.github.com/repos/{repo}/commits/{branch}"
RAW_URL = "https://raw.githubusercontent.com/{repo}/{branch}/{path}"

MENTION_RE = re.compile(r"@([A-Za-z0-9_-]+)")
COMMIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
INSTALL_MARKER = ".andromity-skill.json"
MAX_SKILL_DOC_CHARS = 60_000


SYMLINK_MODE = "120000"


def skill_dirs(tree: dict, base: str = "") -> List[str]:
    """Sorted, de-duplicated skill folders (each holding a SKILL.md) under ``base``.

    Symlinked SKILL.md files are skipped: registries mirror skills for other
    tools that way, and their blob content is just a relative path.
    """
    base = (base or "").strip("/")
    found = set()
    for entry in tree.get("tree", []):
        p = entry.get("path", "")
        if not p.endswith("/SKILL.md") or entry.get("mode") == SYMLINK_MODE:
            continue
        d = p[: -len("/SKILL.md")]
        if not base or d == base or d.startswith(base + "/"):
            found.add(d)
    return sorted(found)


def get_approved_skill_roots(project_path: Optional[Path] = None) -> List[Path]:
    """Return canonical directories where skills can be safely installed or read from."""
    roots: List[Path] = []
    if project_path:
        p = Path(project_path).resolve()
        for candidate in (p / ".agents" / "skills", p / ".andromity" / "skills", p / "skills"):
            # A repository can ship these folders as links; one pointing outside the
            # project would make everything it reaches readable as a "skill".
            resolved = candidate.resolve()
            if resolved == p or not resolved.is_relative_to(p):
                continue
            roots.append(resolved)
    
    roots.append((get_config_dir() / "skills").resolve())
    roots.append((Path.home() / ".andromity" / "skills").resolve())
    roots.append((Path.home() / ".claude" / "skills").resolve())
    roots.append((Path.home() / ".gemini" / "config" / "skills").resolve())
    roots.append((Path.home() / ".gemini" / "antigravity-ide" / "builtin" / "skills").resolve())
    
    seen = set()
    valid_roots = []
    for r in roots:
        if r not in seen:
            seen.add(r)
            valid_roots.append(r)
    return valid_roots


def attach_skill_mentions(prompt: str, manager: "SkillsManager", session: Optional["Session"] = None) -> str:
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

    from andromity.core.tools import _current_session_var
    active_session = session or _current_session_var.get()

    skill_lines = []
    for name in matched_names:
        skill_file = (Path(installed_map[name].path) / "SKILL.md").resolve()
        skill_lines.append(f"- {name}: {skill_file}")
        if active_session and hasattr(active_session, "allow_external_file"):
            active_session.allow_external_file(skill_file)

    note = (
        "\n\n[Attached skills: " + ", ".join(matched_names) + "]\n"
        "Skill instructions file(s):\n" + "\n".join(skill_lines) + "\n"
        "The user explicitly attached the skill(s) above. Read each skill's SKILL.md file directly "
        "and follow its instructions for this task."
    )
    return prompt + note


def parse_frontmatter(md: str) -> Dict[str, str]:
    """Pull top-level keys (name, description, tags, ...) out of a SKILL.md's YAML frontmatter.

    Indented lines and ``- item`` lines continue the previous key, so folded
    (``>``) and literal (``|``) descriptions and block lists come back as one
    space-joined string instead of leaking nested keys into the top level.
    """
    info = {"name": "", "description": ""}
    m = re.match(r"^---\s*\n(.*?)\n---", md, re.S)
    if not m:
        return info
    key = ""
    for line in m.group(1).splitlines():
        continuation = line[:1] in (" ", "\t") or line.startswith("- ")
        if continuation and key:
            text = line.strip()
            if text.startswith("- "):
                text = text[2:].strip()
            if text:
                info[key] = f"{info[key]} {text}".strip()
        elif ":" in line:
            name, _, value = line.partition(":")
            key = name.strip().lower()
            value = value.strip()
            if value[:1] in (">", "|") and not value[1:].strip("+-"):
                value = ""
            info[key] = value.strip("\"'")
    return info


def _default_fetch(url: str, timeout: int = 20) -> str:
    from andromity.core import network_policy
    network_policy.require_url(url, "the online skills catalog", "Installed skills keep working.")
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
    version: str = ""  # git tree SHA of the skill folder when it was installed


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
    category: str = skill_catalog.OTHER
    tags: List[str] = field(default_factory=list)
    commit: str = ""  # pinned commit to install from; empty means the branch head
    version: str = ""  # git tree SHA of the skill folder at that commit
    verified: bool = False
    featured: bool = False

    @property
    def category_label(self) -> str:
        return skill_catalog.category_label(self.category)


class SkillsManager:
    """Installs, lists, and removes skills; feeds the agent its prompt block."""

    def __init__(self, project_path: Optional[str] = None, fetch: Callable[[str], str] = _default_fetch,
                 user_dir: Optional[Path] = None):
        self._project_path = Path(project_path) if project_path else Path.cwd()
        self._user_dir = Path(user_dir) if user_dir else get_config_dir() / "skills"
        self._user_dir_override = bool(user_dir)
        self._project_dir = self._project_path / ".andromity" / "skills"
        self._fetch = fetch
        self._trees: Dict[tuple, dict] = {}
        self._catalog_entries: Optional[List[Dict[str, Any]]] = None
        self._catalog_loaded = False

    # ── Installed skills ───────────────────────────────────────────────────

    def installed(self, include_project: bool = True) -> List[SkillInfo]:
        found: Dict[str, SkillInfo] = {}
        roots = [
            ("project", self._project_path / ".agents" / "skills"),
            ("project", self._project_path / ".andromity" / "skills"),
            ("project", self._project_path / "skills"),
        ] if include_project else []
        roots.append(("user", self._user_dir))
        # Add IDE-specific paths if active config dir is ~/.gemini or ~/.andromity (not a test temp dir)
        if not self._user_dir_override and not any(part.startswith("pytest-") or "temp" in part.lower() or "tmp" in part.lower() for part in self._user_dir.parts):
            gemini_skills = Path.home() / ".gemini" / "config" / "skills"
            if gemini_skills.is_dir() and gemini_skills.resolve() != self._user_dir.resolve():
                roots.append(("user", gemini_skills))
            builtin_skills = Path.home() / ".gemini" / "antigravity-ide" / "builtin" / "skills"
            if builtin_skills.is_dir() and builtin_skills.resolve() != self._user_dir.resolve():
                roots.append(("builtin", builtin_skills))
        for scope, base in roots:
            if not base.is_dir():
                continue
            for d in sorted(base.iterdir()):
                skill_md = d / "SKILL.md"
                if not (d.is_dir() and skill_md.exists()):
                    continue
                if d.name not in found:
                    info = parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
                    marker = self._read_marker(d)
                    found[d.name] = SkillInfo(
                        name=d.name,
                        description=info.get("description", ""),
                        source=marker.get("source_id", ""),
                        scope=scope,
                        path=str(d),
                        version=marker.get("version", ""),
                    )
        return sorted(found.values(), key=lambda s: s.name)

    @staticmethod
    def _read_marker(skill_dir: Path) -> Dict[str, str]:
        try:
            data = json.loads((skill_dir / INSTALL_MARKER).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {k: v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}

    def installed_names(self) -> set:
        return {s.name for s in self.installed()}

    def prompt_block(self) -> str:
        """Markdown section appended to the agent's system prompt."""
        # An untrusted repository's skill descriptions must not reach the prompt before trust is granted.
        from andromity.config import config
        skills = self.installed(include_project=config.is_trusted(str(self._project_path)))
        if not skills:
            return ""
        
        safe_lines = []
        for s in skills:
            # Strip newlines and sanitize prompt escape tags
            desc = (s.description or "no description").replace("\n", " ").replace("\r", "").strip()
            desc = re.sub(r"[<>]", "", desc)[:200]
            safe_lines.append(f"- {s.name} (file: {Path(s.path) / 'SKILL.md'}): {desc}")

        lines = "\n".join(safe_lines)
        return (
            "## Installed Skills\n"
            f"{lines}\n\n"
            "The skills above are available on request. When the user names a skill "
            "(or a task clearly matches one), read its SKILL.md directly and follow its "
            "instructions exactly."
        )

    # ── Registry browsing ─────────────────────────────────────────────────

    def _tree(self, source: Dict[str, Any], ref: Optional[str] = None) -> dict:
        ref = ref or source["branch"]
        key = (source["repo"], ref)
        if key not in self._trees:
            self._trees[key] = json.loads(self._fetch(GITHUB_API.format(repo=source["repo"], branch=ref)))
        return self._trees[key]

    def _catalog(self) -> Optional[List[Dict[str, Any]]]:
        """Catalog entries from the hosted catalog.json, or None when unavailable.

        Fresh disk cache wins; otherwise the catalog is fetched and cached. A
        stale cache is used if the fetch fails, so browsing keeps working
        offline once the catalog has been seen.
        """
        if self._catalog_loaded:
            return self._catalog_entries
        self._catalog_loaded = True
        allowed = {s["id"]: s["repo"] for s in REGISTRY_SOURCES}
        cache = self._user_dir / ".catalog-cache.json"
        text = skill_catalog.read_cache(cache, skill_catalog.CATALOG_TTL_SECONDS)
        entries = skill_catalog.parse_catalog(text, allowed) if text else None
        if entries is None:
            url = os.environ.get(skill_catalog.CATALOG_URL_ENV) or skill_catalog.CATALOG_URL
            try:
                text = self._fetch(url)
            except Exception as e:
                log.info("Skills catalog unavailable (%s); falling back to registry scan", e)
                text = None
            entries = skill_catalog.parse_catalog(text, allowed) if text else None
            if entries is not None:
                skill_catalog.write_cache(cache, text)
            else:
                stale = skill_catalog.read_cache(cache, None)
                entries = skill_catalog.parse_catalog(stale, allowed) if stale else None
        self._catalog_entries = entries
        return entries

    def browse(self, source_id: Optional[str] = None) -> List[RemoteSkill]:
        """List skills available in the registries.

        Uses the hosted catalog (descriptions, categories, tags, trust flags,
        no per-source cap) and falls back to scanning the GitHub registries
        directly when it can't be reached. The fallback has no descriptions —
        large registries would need one request per skill; call
        fetch_description() lazily instead — and categorizes by name only.
        """
        entries = self._catalog()
        if entries is not None:
            remotes = [
                RemoteSkill(
                    name=e["name"], description=e["description"], source_id=e["source_id"],
                    source_label=e["source_label"], repo=e["repo"], branch=e["branch"], dir=e["dir"],
                    category=e["category"], tags=e["tags"], commit=e["commit"], version=e["version"],
                    verified=e["verified"], featured=e["featured"],
                )
                for e in entries
                if not source_id or e["source_id"] == source_id
            ]
            remotes.sort(key=lambda s: (not s.featured, not s.verified, s.source_id, s.name))
            return remotes
        return self._browse_registries(source_id)

    def _browse_registries(self, source_id: Optional[str] = None) -> List[RemoteSkill]:
        """Each source is capped at its ``max_skills`` limit (when set) so large
        community libraries don't flood the list."""
        results: List[RemoteSkill] = []
        for src in REGISTRY_SOURCES:
            if source_id and src["id"] != source_id:
                continue
            tree = self._tree(src)
            per_source = [
                RemoteSkill(
                    name=d.rsplit("/", 1)[-1],
                    description="",
                    source_id=src["id"],
                    source_label=src["label"],
                    repo=src["repo"],
                    branch=src["branch"],
                    dir=d,
                    category=skill_catalog.categorize(d.rsplit("/", 1)[-1], folder=d.rpartition("/")[0])[0],
                    verified=bool(src.get("verified")),
                )
                for d in skill_dirs(tree, src.get("path", ""))
            ]
            per_source.sort(key=lambda s: s.name)
            max_skills = int(src.get("max_skills") or 0)
            if max_skills:
                per_source = per_source[:max_skills]
            results.extend(per_source)
        results.sort(key=lambda s: (s.source_id, s.name))
        return results

    def read_skill_md(self, name: str, source_id: Optional[str] = None, path: Optional[str] = None) -> Optional[str]:
        """The SKILL.md body (frontmatter removed) of an installed skill (by path) or a registry skill."""
        if path:
            skill = next((s for s in self.installed() if s.name == name and s.path == path), None)
            if skill is None:
                return None
            text = (Path(skill.path) / "SKILL.md").read_text(encoding="utf-8", errors="replace")
        else:
            remote = next((r for r in self.browse(source_id) if r.name == name), None)
            if remote is None:
                return None
            raw = f"{remote.dir}/SKILL.md"
            try:
                text = self._fetch(RAW_URL.format(repo=remote.repo, branch=remote.commit or remote.branch, path=raw))
            except Exception:
                if not remote.commit:
                    raise
                text = self._fetch(RAW_URL.format(repo=remote.repo, branch=remote.branch, path=raw))
        body = re.sub(r"^---\s*\n.*?\n---[ \t]*\n?", "", text, count=1, flags=re.S)
        return body.strip()[:MAX_SKILL_DOC_CHARS]

    def fetch_description(self, remote: RemoteSkill) -> str:
        """Lazily fetch and parse a skill's SKILL.md description."""
        try:
            md = self._fetch(RAW_URL.format(repo=remote.repo, branch=remote.branch, path=f"{remote.dir}/SKILL.md"))
            return parse_frontmatter(md).get("description", "")
        except Exception:
            return ""

    # ── Install / uninstall ───────────────────────────────────────────────

    def install(self, name: str, source_id: str, scope: str = "user", ref: Optional[str] = None) -> Optional[SkillInfo]:
        """One-click install: copy the skill's files from its registry into place.

        ``ref`` pins the install to a commit SHA (as published in the catalog);
        if that commit can't be read the branch head is used instead.
        """
        from concurrent.futures import ThreadPoolExecutor, as_completed

        src = next((s for s in REGISTRY_SOURCES if s["id"] == source_id), None)
        if src is None:
            return None
        if ref and not COMMIT_SHA_RE.match(ref):
            raise ValueError("Invalid commit reference")
        try:
            tree = self._tree(src, ref)
        except Exception:
            if not ref:
                raise
            ref = None
            tree = self._tree(src)
        checkout = ref or src["branch"]

        skill_dir = next(
            (d for d in skill_dirs(tree, src.get("path", "")) if d.rsplit("/", 1)[-1] == name), None
        )
        if skill_dir is None:
            return None
        version = next(
            (e.get("sha", "") for e in tree.get("tree", []) if e.get("type") == "tree" and e.get("path") == skill_dir),
            "",
        )

        files = [
            e["path"]
            for e in tree.get("tree", [])
            if e.get("type") == "blob" and e.get("mode") != SYMLINK_MODE and e["path"].startswith(skill_dir + "/")
        ]
        if not files:
            return None

        target = (self._user_dir if scope == "user" else self._project_dir) / name
        target_resolved = target.resolve()

        # Fetch all files in parallel for speed
        def _fetch_file(f: str) -> tuple:
            rel = f[len(skill_dir) + 1:]
            if not rel:
                return (None, None)
            out = target / rel
            try:
                if not out.resolve().is_relative_to(target_resolved):
                    return (None, None)
            except ValueError:
                return (None, None)
            content = self._fetch(RAW_URL.format(repo=src["repo"], branch=checkout, path=f))
            return (out, content)

        with ThreadPoolExecutor(max_workers=min(len(files), 8)) as pool:
            futures = {pool.submit(_fetch_file, f): f for f in files}
            fetched = [future.result() for future in as_completed(futures)]

        # Nothing on disk is touched until every file downloaded, and an update
        # replaces the folder so files removed upstream don't linger.
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        target.mkdir(parents=True, exist_ok=True)
        for out, content in fetched:
            if out is not None and content is not None:
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(content, encoding="utf-8")

        (target / INSTALL_MARKER).write_text(
            json.dumps({"source_id": source_id, "repo": src["repo"], "dir": skill_dir, "commit": ref or "", "version": version}),
            encoding="utf-8",
        )
        info = parse_frontmatter((target / "SKILL.md").read_text(encoding="utf-8", errors="replace"))
        return SkillInfo(name=name, description=info.get("description", ""), source=source_id, scope=scope,
                         path=str(target), version=version)

    def uninstall(self, name: str, path: Optional[str] = None) -> bool:
        """Remove a skill from every scope it is installed in."""
        if not name or name in (".", "..") or "/" in name or "\\" in name:
            raise ValueError("Invalid skill name")
        if path is not None:
            skill = next((s for s in self.installed() if s.name == name and s.path == path), None)
            if skill is None or skill.scope == "builtin":
                raise ValueError("Skill is not removable")
            target = Path(skill.path)
            if target.is_symlink() or target.resolve().parent != target.parent.resolve():
                raise ValueError("Linked skills cannot be removed")
            shutil.rmtree(target)
            return True
        removed = False
        for base in (self._user_dir, self._project_dir):
            d = base / name
            if d.is_symlink() or d.resolve().parent != base.resolve():
                raise ValueError("Linked skills cannot be removed")
            if d.is_dir():
                shutil.rmtree(d)
                removed = True
        return removed

    def skills_dir(self, scope: str = "user") -> Path:
        return self._user_dir if scope == "user" else self._project_dir
