import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
let trusted = true;
let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined = [{ uri: { fsPath: "D:/test/workspace" } }];
const warnings: string[] = [];
const mockVscode = {
  workspace: {
    get isTrusted() { return trusted; },
    get workspaceFolders() { return workspaceFolders; },
  },
  window: {
    showWarningMessage: async (message: string) => { warnings.push(message); return undefined; },
    showErrorMessage: () => {},
    showInformationMessage: () => {},
  },
  Uri: { joinPath: () => ({ fsPath: "icon.svg" }) },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments);
};
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
Module.prototype.require = originalRequire;

function panelHarness(rpc?: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const posts: any[] = [];
  const panel = Object.create(SettingsPanel.prototype);
  panel._rpcClient = { call: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return rpc ? rpc(method, params) : { success: true };
  } };
  panel._panel = { webview: { cspSource: "vscode-webview:", asWebviewUri: () => "icon.svg", postMessage: (post: unknown) => posts.push(post) } };
  panel._extensionUri = { fsPath: "D:/extension" };
  panel.loadData = async () => {};
  panel._onConfigChangeCallback = () => {};
  return { panel, calls, posts };
}

const html: string = panelHarness().panel._getHtmlForWebview();

interface Remote {
  name: string; description?: string; source_id: string; source_label?: string; repo?: string; dir?: string;
  category?: string; category_label?: string; tags?: string[]; commit?: string; version?: string;
  verified?: boolean; featured?: boolean;
}
interface Installed { name: string; description?: string; path: string; scope: string; source?: string; version?: string }

interface Page {
  run(code: string): any;
  grid: { innerHTML: string };
  overlay: { innerHTML: string; style: { display: string } };
  chips: Record<string, { innerHTML: string; style: { display: string } }>;
  posts: unknown[];
}

function skillsPage(remote: Remote[], installed: Installed[], tab: "installed" | "registry" = "registry"): Page {
  const start = html.indexOf("    function skillSourceName(");
  const end = html.indexOf("    function renderMcp() {");
  assert.ok(start >= 0 && end > start);
  const elements: Record<string, any> = {
    "skills-grid": { innerHTML: "" },
    "skill-detail-overlay": { innerHTML: "", style: { display: "none" } },
    "skills-category-chips": { innerHTML: "", style: { display: "none" } },
    "skills-source-chips": { innerHTML: "", style: { display: "none" } },
    "skills-scope-chips": { innerHTML: "", style: { display: "none" } },
  };
  const posts: unknown[] = [];
  const escapeHtml = (value: unknown) => value ? String(value).replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!) : "";
  const context = vm.createContext({
    document: { getElementById: (id: string) => elements[id] },
    escapeHtml, vscode: { postMessage: (post: unknown) => posts.push(post) },
    allSkills: installed, allRemoteSkills: remote,
  });
  vm.runInContext(`
    const SKILLS_PAGE_SIZE = 60;
    var activeSkillsTab = ${JSON.stringify(tab)};
    var skillsQuery = ""; var skillsCategory = "all"; var skillsSource = "all";
    var skillsInstallScope = "user"; var skillsLimit = SKILLS_PAGE_SIZE;
    var skillDetail = null; const skillDocs = {};
  ` + html.slice(start, end), context);
  return {
    run: (code: string) => vm.runInContext(code, context),
    grid: elements["skills-grid"], overlay: elements["skill-detail-overlay"],
    chips: { category: elements["skills-category-chips"], source: elements["skills-source-chips"], scope: elements["skills-scope-chips"] },
    posts,
  };
}

const pdf: Remote = { name: "pdf", description: "Extract text and fill forms in PDF files", source_id: "anthropic",
  source_label: "Anthropic — official skills", repo: "anthropics/skills", dir: "skills/pdf", category: "documents",
  category_label: "Documents", tags: ["pdf", "forms"], commit: "a".repeat(40), version: "v2", verified: true, featured: true };
const sqlSkill: Remote = { name: "sql-helper", description: "Write SQL queries", source_id: "community",
  source_label: "Community — claude-skills library", repo: "x/y", dir: "data/sql-helper", category: "data",
  category_label: "Data & Analytics", tags: ["sql"], commit: "b".repeat(40), version: "s1" };

describe("Skills hub extension messages", () => {
  beforeEach(() => { trusted = true; workspaceFolders = [{ uri: { fsPath: "D:/test/workspace" } }]; warnings.length = 0; });

  it("installs pinned to the catalog commit with the chosen scope and always re-renders the panel", async () => {
    const h = panelHarness();
    await h.panel._handleMessage({ type: "install_skill", name: "pdf", sourceId: "anthropic", ref: "a".repeat(40), scope: "project" });
    assert.deepEqual(h.calls[0], { method: "skills.install", params: {
      name: "pdf", source_id: "anthropic", ref: "a".repeat(40), scope: "project", project_path: "D:/test/workspace" } });
    assert.deepEqual(h.posts, [{ type: "skill_install_finished" }]);
  });

  it("defaults to a user-wide install and omits an empty ref", async () => {
    const h = panelHarness();
    await h.panel._handleMessage({ type: "install_skill", name: "pdf", sourceId: "anthropic", ref: "" });
    assert.equal(h.calls[0].params.scope, "user");
    assert.equal(h.calls[0].params.ref, undefined);
  });

  it("refuses project-only installs without a folder or in an untrusted workspace", async () => {
    const h = panelHarness();
    trusted = false;
    await h.panel._handleMessage({ type: "install_skill", name: "pdf", sourceId: "anthropic", scope: "project" });
    trusted = true;
    workspaceFolders = undefined;
    await h.panel._handleMessage({ type: "install_skill", name: "pdf", sourceId: "anthropic", scope: "project" });
    assert.equal(h.calls.length, 0);
    assert.equal(warnings.length, 2);
    assert.equal(h.posts.length, 2);
  });

  it("loads a skill's instructions for the detail view, and reports failures without a stack trace", async () => {
    const ok = panelHarness(() => ({ content: "# pdf" }));
    await ok.panel._handleMessage({ type: "skill_read", key: "k", name: "pdf", sourceId: "anthropic" });
    assert.deepEqual(ok.calls[0], { method: "skills.read", params: {
      name: "pdf", source_id: "anthropic", path: undefined, project_path: "D:/test/workspace" } });
    assert.deepEqual(ok.posts[0], { type: "skill_detail_loaded", key: "k", content: "# pdf", error: undefined });

    const failing = panelHarness(() => { throw new Error("socket hang up at Object.<anonymous> (node:net:1)"); });
    await failing.panel._handleMessage({ type: "skill_read", key: "k", name: "pdf" });
    assert.ok(!String(failing.posts[0].error).includes("socket"));
    assert.ok(failing.posts[0].error);
  });
});

describe("Skills hub rendering", () => {
  it("renders valid webview scripts with the new controls", () => {
    const scripts = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
    for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
    for (const id of ["skills-search", "skills-category-chips", "skills-source-chips", "skills-scope-chips", "skill-detail-overlay"]) {
      assert.ok(html.includes('id="' + id + '"'), id);
    }
  });

  it("shows category chips with counts, verified/featured badges and tag links", () => {
    const page = skillsPage([pdf, sqlSkill], []);
    page.run("renderSkills()");
    assert.ok(page.chips.category.innerHTML.includes("Documents"));
    assert.ok(page.chips.category.innerHTML.includes('data-action="skills-category" data-value="data"'));
    assert.ok(page.chips.source.innerHTML.includes("Verified"));
    assert.ok(page.grid.innerHTML.includes("Featured") && page.grid.innerHTML.includes("Verified"));
    assert.ok(page.grid.innerHTML.includes('data-action="skills-tag" data-value="forms"'));
    assert.ok(page.grid.innerHTML.includes('data-action="skill-open" data-skill-name="pdf" data-source-id="anthropic"'));
    assert.equal(page.chips.scope.style.display, "");
  });

  it("filters by search text across name, description and tags, and by category and source", () => {
    const page = skillsPage([pdf, sqlSkill], []);
    page.run('skillsQuery = "forms"; renderSkills()');
    assert.ok(page.grid.innerHTML.includes('data-skill-name="pdf"'));
    assert.ok(!page.grid.innerHTML.includes('data-skill-name="sql-helper"'));

    page.run('skillsQuery = ""; skillsCategory = "data"; renderSkills()');
    assert.ok(!page.grid.innerHTML.includes('data-skill-name="pdf"'));
    assert.ok(page.grid.innerHTML.includes('data-skill-name="sql-helper"'));

    page.run('skillsCategory = "all"; skillsSource = "verified"; renderSkills()');
    assert.ok(page.grid.innerHTML.includes('data-skill-name="pdf"'));
    assert.ok(!page.grid.innerHTML.includes('data-skill-name="sql-helper"'));

    page.run('skillsSource = "all"; skillsQuery = "nothing-matches"; renderSkills()');
    assert.ok(page.grid.innerHTML.includes("No skills match your filters."));
  });

  it("ranks a name match above a description match", () => {
    const loose: Remote = { name: "other", description: "mentions pdf in passing", source_id: "anthropic" };
    const page = skillsPage([loose, pdf], []);
    page.run('skillsQuery = "pdf"; renderSkills()');
    assert.ok(page.grid.innerHTML.indexOf('data-skill-name="pdf"') < page.grid.innerHTML.indexOf('data-skill-name="other"'));
  });

  it("pages large catalogs with a show-more footer", () => {
    const many = Array.from({ length: 130 }, (_, i): Remote => ({ name: "s" + i, source_id: "community" }));
    const page = skillsPage(many, []);
    page.run("renderSkills()");
    assert.equal((page.grid.innerHTML.match(/class="item-card"/g) || []).length, 60);
    assert.ok(page.grid.innerHTML.includes("Show more (70 remaining)"));
    page.run("skillsLimit += SKILLS_PAGE_SIZE; renderSkills()");
    assert.ok(page.grid.innerHTML.includes("Show more (10 remaining)"));
  });

  it("hides registry-only filters on the installed tab and flags available updates", () => {
    const local: Installed = { name: "pdf", path: "C:/s/pdf", scope: "user", source: "anthropic", version: "v1" };
    const page = skillsPage([pdf], [local], "installed");
    page.run("renderSkills()");
    assert.equal(page.chips.scope.style.display, "none");
    assert.equal(page.chips.category.style.display, "none");
    assert.ok(page.grid.innerHTML.includes("Update available"));
    assert.ok(page.grid.innerHTML.includes('data-action="install-skill"'));
    assert.ok(page.grid.innerHTML.includes('data-action="remove-skill"'));
  });
});

describe("Skill detail view", () => {
  const actionsOf = (page: Page) => page.overlay.innerHTML;

  it("offers Install, with a scope choice, for a skill that is not installed and requests its instructions", () => {
    const page = skillsPage([pdf], []);
    page.run('openSkillDetail("pdf", "anthropic", "")');
    const view = actionsOf(page);
    assert.equal(page.overlay.style.display, "flex");
    assert.ok(view.includes("Extract text and fill forms in PDF files"));
    assert.ok(view.includes("Documents") && view.includes("#forms") && view.includes("anthropics/skills/skills/pdf"));
    assert.ok(view.includes("Loading instructions..."));
    assert.ok(view.includes('data-action="install-skill"') && view.includes(">Install<"));
    assert.ok(view.includes('data-skill-ref="' + "a".repeat(40) + '"'));
    assert.ok(view.includes('data-action="skills-scope"'));
    assert.ok(!view.includes('data-action="remove-skill"'));
    assert.deepEqual(JSON.parse(JSON.stringify(page.posts[0])), { type: "skill_read", key: "pdf|anthropic|", name: "pdf", sourceId: "anthropic", path: "" });
  });

  it("shows the SKILL.md text (escaped) once it arrives, and retries after an error", () => {
    const page = skillsPage([pdf], []);
    page.run('openSkillDetail("pdf", "anthropic", ""); skillDocs["pdf|anthropic|"] = { content: "# Use <b>pdf</b>" }; renderSkillDetail()');
    assert.ok(page.overlay.innerHTML.includes("# Use &lt;b&gt;pdf&lt;/b&gt;"));
    assert.ok(!page.overlay.innerHTML.includes("<b>pdf</b>"));

    page.run('skillDocs["pdf|anthropic|"] = { error: "offline" }; openSkillDetail("pdf", "anthropic", "")');
    assert.equal(page.posts.length, 2);
  });

  it("offers Remove, and no Install, for an installed skill that is up to date", () => {
    const local: Installed = { name: "pdf", path: "C:/s/pdf", scope: "user", source: "anthropic", version: "v2" };
    const page = skillsPage([pdf], [local]);
    page.run('openSkillDetail("pdf", "anthropic", "")');
    const view = actionsOf(page);
    assert.ok(view.includes('data-action="remove-skill" data-skill-name="pdf" data-skill-path="C:/s/pdf"'));
    assert.ok(!view.includes('data-action="install-skill"'));
    assert.ok(!view.includes('data-action="skills-scope"'));
    assert.ok(view.includes("Installed (user)"));
  });

  it("offers Update and Remove when the catalog has a newer version", () => {
    const local: Installed = { name: "pdf", path: "C:/s/pdf", scope: "project", source: "anthropic", version: "v1" };
    const page = skillsPage([pdf], [local]);
    page.run('openSkillDetail("pdf", "anthropic", "C:/s/pdf")');
    const view = actionsOf(page);
    assert.ok(view.includes(">Update<") && view.includes('data-skill-scope="project"'));
    assert.ok(view.includes('data-action="remove-skill"'));
  });

  it("offers only Remove for a local skill the catalog does not know, and Replace for one from another source", () => {
    const custom: Installed = { name: "mine", path: "C:/s/mine", scope: "project", description: "My workflow" };
    const page = skillsPage([pdf], [custom], "installed");
    page.run('openSkillDetail("mine", "", "C:/s/mine")');
    assert.ok(page.overlay.innerHTML.includes('data-action="remove-skill"'));
    assert.ok(!page.overlay.innerHTML.includes('data-action="install-skill"'));

    const other: Installed = { name: "pdf", path: "C:/s/pdf", scope: "user", source: "community", version: "x" };
    const second = skillsPage([pdf], [other]);
    second.run('openSkillDetail("pdf", "anthropic", "")');
    assert.ok(second.overlay.innerHTML.includes("Replace with this version"));
  });

  it("closes itself when the skill it shows is removed and nothing else describes it", () => {
    const custom: Installed = { name: "mine", path: "C:/s/mine", scope: "project" };
    const page = skillsPage([], [custom], "installed");
    page.run('openSkillDetail("mine", "", "C:/s/mine")');
    assert.equal(page.overlay.style.display, "flex");
    page.run("allSkills.length = 0; renderSkills()");
    assert.equal(page.overlay.style.display, "none");
    assert.equal(page.overlay.innerHTML, "");
  });

  it("switches from Remove to Install once an installed catalog skill is removed", () => {
    const local: Installed = { name: "pdf", path: "C:/s/pdf", scope: "user", source: "anthropic", version: "v2" };
    const page = skillsPage([pdf], [local]);
    page.run('openSkillDetail("pdf", "anthropic", "C:/s/pdf")');
    assert.ok(page.overlay.innerHTML.includes('data-action="remove-skill"'));
    page.run("allSkills.length = 0; renderSkills()");
    assert.ok(page.overlay.innerHTML.includes(">Install<"));
    assert.ok(!page.overlay.innerHTML.includes('data-action="remove-skill"'));
  });
});
