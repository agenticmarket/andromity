"""Skills catalog — categories, tags and trust flags layered over GitHub registries.

Skill files are never hosted by Andromity. They stay in the upstream GitHub
repositories listed in ``skills.REGISTRY_SOURCES`` and are installed from there,
pinned to the commit the catalog was built against. The catalog is a single
static ``catalog.json`` (built by ``scripts/build_skills_catalog.py``) that adds
what GitHub cannot give us: descriptions without one request per skill, a
category, tags, and verified/featured flags.
"""
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

CATALOG_VERSION = 1
CATALOG_URL = "https://raw.githubusercontent.com/agenticmarket/andromity/main/skills-catalog/catalog.json"
CATALOG_URL_ENV = "ANDROMITY_SKILLS_CATALOG_URL"
CATALOG_TTL_SECONDS = 6 * 3600
OTHER = "other"
MAX_TAGS = 6
MAX_DESCRIPTION = 400

# (id, label, keywords). Order is the tie-break priority. Keywords match whole
# words (base form; a trailing "s" is tolerated) or multi-word phrases. A hit
# scores NAME_WEIGHT in the skill name, FOLDER_WEIGHT in its parent folders and
# DESCRIPTION_WEIGHT in the opening of the description.
CATEGORIES: List[Tuple[str, str, Tuple[str, ...]]] = [
    ("documents", "Documents", (
        "pdf", "docx", "xlsx", "pptx", "excel", "spreadsheet", "powerpoint", "slide",
        "presentation", "document", "documentation", "readme", "csv", "ocr", "markdown",
    )),
    ("design", "Design & Frontend", (
        "ui", "ux", "css", "tailwind", "figma", "canvas", "visual", "brand", "theme", "animation",
        "logo", "graphic", "svg", "typography", "landing page", "frontend", "web design",
        "design system", "interface", "gif",
    )),
    ("testing", "Code Review & Testing", (
        "test", "testing", "qa", "lint", "coverage", "tdd", "e2e", "playwright", "pytest", "jest",
        "code review", "pull request", "regression",
    )),
    ("security", "Security & Compliance", (
        "security", "vulnerability", "pentest", "threat", "secret", "encryption", "owasp",
        "compliance", "cve", "malware", "forensics", "regulatory", "fda", "iso", "gdpr", "hipaa",
        "soc2", "qms", "privacy", "red team",
    )),
    ("data", "Data & Analytics", (
        "data", "analytics", "sql", "database", "dataset", "pandas", "statistics", "visualization",
        "chart", "dashboard", "bigquery", "etl", "notebook", "machine learning",
    )),
    ("devops", "Pipelines & DevOps", (
        "pipeline", "ci", "cd", "deploy", "deployment", "docker", "kubernetes", "terraform",
        "infrastructure", "devops", "github actions", "monitoring", "incident", "aws",
        "cloudflare", "sre", "observability",
    )),
    ("api", "APIs & Integrations", (
        "api", "rest", "graphql", "webhook", "integration", "sdk", "mcp", "openapi", "endpoint",
        "oauth",
    )),
    ("agents", "Agents & Automation", (
        "agent", "subagent", "orchestration", "orchestrator", "autonomous", "multi agent",
        "automation", "loop", "spawn", "harness", "cma", "managed agent",
    )),
    ("memory", "Memory & Notes", (
        "memory", "knowledge", "note", "recall", "persistent", "remember", "handoff", "obsidian",
        "notion", "wiki",
    )),
    ("business", "Business & Product", (
        "product", "strategy", "startup", "founder", "ceo", "cto", "cfo", "cmo", "advisor",
        "management", "manager", "roadmap", "prd", "scrum", "agile", "sprint", "finance",
        "financial", "sales", "customer", "hiring", "legal", "counsel", "risk", "okr", "business",
        "stakeholder", "coach", "pricing", "revenue", "operations", "c level", "executive",
        "board", "commercial",
    )),
    ("writing", "Marketing & Writing", (
        "research", "writing", "blog", "content", "copywriting", "seo", "marketing", "email",
        "editor", "translation", "communication", "social", "linkedin", "campaign", "growth",
        "newsletter", "press", "audience", "conversion", "cro",
    )),
    ("engineering", "Engineering", (
        "engineering", "software", "architecture", "refactor", "debug", "algorithm", "codebase",
        "implementation", "code", "coding", "programming", "developer", "typescript", "python",
        "javascript", "rust", "golang", "java", "react", "backend", "microservice",
        "system design", "tech debt", "git",
    )),
]
CATEGORY_LABELS: Dict[str, str] = {cid: label for cid, label, _ in CATEGORIES}
CATEGORY_LABELS[OTHER] = "Other"

CATEGORY_DESCRIPTIONS: Dict[str, str] = {
    "documents": "Creating, reading or editing files and documents: PDF, Word, Excel, PowerPoint, slides, Markdown, reports.",
    "design": "Visual and UI work: frontend design, CSS, branding, themes, graphics, animation, creative art.",
    "testing": "Testing and code review: unit, integration and end-to-end tests, QA, linting, coverage, reviewing changes.",
    "security": "Security, privacy, risk and regulatory compliance: vulnerabilities, threat detection, audits, GDPR, ISO, medical-device quality.",
    "data": "Data work: SQL, databases, analytics, statistics, data science, dashboards, ETL, machine learning.",
    "devops": "Pipelines and infrastructure: CI/CD, deployment, Docker, Kubernetes, cloud, monitoring, incident response.",
    "api": "APIs and integrations: building or using REST/GraphQL APIs, SDKs, MCP servers, webhooks, third-party services.",
    "agents": "Building, orchestrating or running AI agents: multi-agent systems, subagents, autonomous loops, automation harnesses.",
    "memory": "Memory, notes and knowledge: persisting context, remembering across sessions, handoffs, wikis, note-taking.",
    "business": "Business, product and management: strategy, executives, roadmaps, project management, finance, sales, hiring, legal.",
    "writing": "Writing, research and marketing: blog posts, copywriting, SEO, social media, email, communications, research.",
    "engineering": "General software engineering: writing, debugging, refactoring and architecting code, languages and frameworks, git.",
    OTHER: "Does not clearly fit any other category.",
}

NAME_WEIGHT = 4
FOLDER_WEIGHT = 3
DESCRIPTION_WEIGHT = 1
DESCRIPTION_SCAN_CHARS = 240

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def category_label(category_id: str) -> str:
    return CATEGORY_LABELS.get(category_id, CATEGORY_LABELS[OTHER])


def _tokens(text: str, singulars: bool = True) -> str:
    """Normalize text to a space-padded string of lowercase word tokens.

    With ``singulars`` each plural-looking word is also emitted without its
    trailing "s" so keywords can be written in their base form.
    """
    words = _TOKEN_RE.findall(text.lower())
    expanded: List[str] = []
    for w in words:
        expanded.append(w)
        if singulars and len(w) > 3 and w.endswith("s"):
            expanded.append(w[:-1])
    return " " + " ".join(expanded) + " "


def _hits(keyword: str, haystack: str) -> int:
    return haystack.count(f" {keyword} ")


def split_tags(raw: str) -> List[str]:
    """Parse a frontmatter ``tags`` value (``[a, b]``, ``a, b`` or ``a b``)."""
    out: List[str] = []
    for part in re.split(r"[,\[\]\s]+", raw or ""):
        part = part.strip().strip("-").strip("\"'").lower()
        if part and part not in out:
            out.append(part)
    return out


def categorize(
    name: str, description: str = "", declared_tags: Iterable[str] = (), folder: str = ""
) -> Tuple[str, List[str]]:
    """Pick a primary category and a handful of tags for a skill.

    ``folder`` is the skill's parent path inside its repository; registries
    often group skills by topic there (``marketing/…``, ``engineering/…``).
    """
    name_text = _tokens(name.replace("-", " ").replace("_", " "))
    folder_text = _tokens(re.sub(r"[-_/.]", " ", folder))
    desc_text = _tokens(description[:DESCRIPTION_SCAN_CHARS])
    best_id, best_score = OTHER, 0
    matched: List[Tuple[int, str]] = []
    for cid, _label, keywords in CATEGORIES:
        score = 0
        for kw in keywords:
            norm = _tokens(kw, singulars=False).strip()
            tag_weight = (
                min(_hits(norm, name_text), 1) * NAME_WEIGHT
                + min(_hits(norm, desc_text), 1) * DESCRIPTION_WEIGHT
            )
            weight = tag_weight + min(_hits(norm, folder_text), 1) * FOLDER_WEIGHT
            if weight:
                score += weight
            if tag_weight:
                matched.append((tag_weight, kw))
        if score > best_score:
            best_id, best_score = cid, score
    tags: List[str] = []
    for tag in list(declared_tags) + [kw for _w, kw in sorted(matched, key=lambda m: -m[0])]:
        tag = tag.replace(" ", "-")
        if tag and tag not in tags and tag != best_id:
            tags.append(tag)
    return best_id, tags[:MAX_TAGS]


def _clean_description(text: str) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= MAX_DESCRIPTION else text[: MAX_DESCRIPTION - 1].rstrip() + "…"


def _lookup_override(overrides: Dict[str, Dict[str, Any]], source_id: str, name: str) -> Dict[str, Any]:
    return overrides.get(f"{source_id}/{name}") or overrides.get(name) or {}


def build_catalog(
    sources: List[Dict[str, Any]],
    fetch: Callable[[str], str],
    overrides: Optional[Dict[str, Dict[str, Any]]] = None,
    generated_at: Optional[str] = None,
    workers: int = 16,
    previous: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Crawl the registry sources and produce the catalog document.

    Each source is pinned to its current commit; ``version`` is the git tree
    SHA of the skill folder so it only changes when that skill's files do.

    Categories come from, in order of precedence: ``overrides``, an earlier LLM
    classification and the keyword rules. ``previous`` maps entry id to the prior
    catalog entry; a skill whose version is unchanged keeps the category that
    ``scripts/classify-skills-catalog.mjs`` gave it (``classified_by: "llm"``).
    """
    from andromity.core.skills import COMMIT_API, GITHUB_API, RAW_URL, parse_frontmatter, skill_dirs

    overrides = overrides or {}
    entries: List[Dict[str, Any]] = []
    for src in sources:
        commit = json.loads(fetch(COMMIT_API.format(repo=src["repo"], branch=src["branch"])))["sha"]
        tree = json.loads(fetch(GITHUB_API.format(repo=src["repo"], branch=commit)))
        if tree.get("truncated"):
            raise RuntimeError(f"Git tree for {src['repo']} is truncated; the catalog would be incomplete.")
        folder_shas = {e["path"]: e.get("sha", "") for e in tree.get("tree", []) if e.get("type") == "tree"}
        dirs = skill_dirs(tree, src.get("path", ""))

        def _frontmatter(d: str, repo: str = src["repo"], ref: str = commit) -> Dict[str, str]:
            try:
                return parse_frontmatter(fetch(RAW_URL.format(repo=repo, branch=ref, path=f"{d}/SKILL.md")))
            except Exception:
                return {"name": "", "description": ""}

        with ThreadPoolExecutor(max_workers=workers) as pool:
            frontmatters = list(pool.map(_frontmatter, dirs))

        seen: set = set()
        for d, fm in zip(dirs, frontmatters):
            name = d.rsplit("/", 1)[-1]
            if name in seen:
                continue
            seen.add(name)
            override = _lookup_override(overrides, src["id"], name)
            if override.get("hidden"):
                continue
            description = _clean_description(fm.get("description", ""))
            category, tags = categorize(name, description, split_tags(fm.get("tags", "")), d.rpartition("/")[0])
            category = override.get("category", category)
            if category not in CATEGORY_LABELS:
                raise ValueError(f"Unknown category '{category}' for {src['id']}/{name} in overrides")
            if "tags" in override:
                tags = [str(t) for t in override["tags"]][:MAX_TAGS]
            entries.append({
                "id": f"{src['id']}/{name}",
                "name": name,
                "description": description,
                "category": category,
                "tags": tags,
                "source_id": src["id"],
                "source_label": src["label"],
                "repo": src["repo"],
                "branch": src["branch"],
                "dir": d,
                "commit": commit,
                "version": folder_shas.get(d, ""),
                "verified": bool(override.get("verified", src.get("verified", False))),
                "featured": bool(override.get("featured", False)),
                "classified_by": "override" if "category" in override else "rules",
            })
            if "tags" in override:
                entries[-1]["tags_locked"] = True

    _keep_llm_categories(entries, previous or {})
    for entry in entries:
        entry.pop("tags_locked", None)

    entries.sort(key=lambda e: (e["source_id"], e["name"]))
    return {
        "version": CATALOG_VERSION,
        "generated_at": generated_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "categories": [
            {"id": cid, "label": label, "description": CATEGORY_DESCRIPTIONS[cid]}
            for cid, label in CATEGORY_LABELS.items()
        ],
        "skills": entries,
    }


def _keep_llm_categories(entries: List[Dict[str, Any]], previous: Dict[str, Dict[str, Any]]) -> None:
    for entry in entries:
        prior = previous.get(entry["id"])
        if (
            entry["classified_by"] != "override"
            and prior
            and prior.get("classified_by") == "llm"
            and entry["version"]
            and prior.get("version") == entry["version"]
            and prior.get("category") in CATEGORY_LABELS
        ):
            entry["category"] = prior["category"]
            entry["classified_by"] = "llm"
            if not entry.get("tags_locked"):
                entry["tags"] = list(prior.get("tags") or [])


_REQUIRED_STR_FIELDS = ("name", "dir", "source_id", "repo", "branch")


def parse_catalog(text: str, allowed_repos: Optional[Dict[str, str]] = None) -> Optional[List[Dict[str, Any]]]:
    """Validate a catalog document; return its skill entries or None if unusable.

    ``allowed_repos`` maps source id → repo. Entries pointing anywhere else are
    dropped so a catalog can never redirect an install to an unlisted repository.
    """
    try:
        doc = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("version") != CATALOG_VERSION or not isinstance(doc.get("skills"), list):
        return None
    out: List[Dict[str, Any]] = []
    for raw in doc["skills"]:
        if not isinstance(raw, dict) or not all(isinstance(raw.get(f), str) and raw[f] for f in _REQUIRED_STR_FIELDS):
            continue
        if allowed_repos is not None and allowed_repos.get(raw["source_id"]) != raw["repo"]:
            continue
        category = raw.get("category") if raw.get("category") in CATEGORY_LABELS else OTHER
        tags = raw.get("tags")
        out.append({
            "name": raw["name"],
            "description": raw["description"] if isinstance(raw.get("description"), str) else "",
            "category": category,
            "tags": [t for t in tags if isinstance(t, str)] if isinstance(tags, list) else [],
            "source_id": raw["source_id"],
            "source_label": raw["source_label"] if isinstance(raw.get("source_label"), str) else raw["source_id"],
            "repo": raw["repo"],
            "branch": raw["branch"],
            "dir": raw["dir"],
            "commit": raw["commit"] if isinstance(raw.get("commit"), str) else "",
            "version": raw["version"] if isinstance(raw.get("version"), str) else "",
            "verified": raw.get("verified") is True,
            "featured": raw.get("featured") is True,
        })
    return out


def read_cache(path: Path, max_age: Optional[float]) -> Optional[str]:
    """Return cached catalog text, or None if missing or older than ``max_age``."""
    try:
        if max_age is not None and time.time() - path.stat().st_mtime > max_age:
            return None
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def write_cache(path: Path, text: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    except OSError:
        pass
