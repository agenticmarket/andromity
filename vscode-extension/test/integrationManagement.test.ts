import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
let inputs: Array<string | undefined> = [];
let picks: Array<string | undefined> = [];
let confirmation: string | undefined = "Remove";
const mockVscode = {
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: "D:/test/workspace" } }] },
  window: {
    showInputBox: async () => inputs.shift(),
    showQuickPick: async () => picks.shift(),
    showWarningMessage: async () => confirmation,
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

function panelHarness() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const posts: unknown[] = [];
  let refreshes = 0;
  let changes = 0;
  const panel = Object.create(SettingsPanel.prototype);
  panel._rpcClient = { call: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return method === "mcp.list" ? [] : { success: true };
  } };
  panel._panel = { webview: { cspSource: "vscode-webview:", asWebviewUri: () => "icon.svg", postMessage: (post: unknown) => posts.push(post) } };
  panel._extensionUri = { fsPath: "D:/extension" };
  panel.loadData = async () => { refreshes++; };
  panel._onConfigChangeCallback = () => { changes++; };
  return { panel, calls, posts, refreshes: () => refreshes, changes: () => changes };
}

function renderMcpCards(servers: unknown[]): string {
  const html: string = panelHarness().panel._getHtmlForWebview();
  const start = html.indexOf("    function renderMcp() {");
  const end = html.indexOf("    let allCrons", start);
  assert.ok(start >= 0 && end > start);
  const grid = { innerHTML: "" };
  const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  vm.runInNewContext(html.slice(start, end) + "\nrenderMcp();", {
    allMcpServers: servers, escapeHtml, document: { getElementById: () => grid },
  });
  return grid.innerHTML;
}

describe("Settings integration management", () => {
  beforeEach(() => { inputs = []; picks = []; confirmation = "Remove"; mockVscode.workspace.isTrusted = true; });

  it("adds a remote HTTP server to the current workspace once", async () => {
    const h = panelHarness();
    inputs = ["supabase", "https://mcp.supabase.com/mcp?project_ref=test", ""];
    picks = ["Remote HTTP (OAuth or access token)"];
    await h.panel._handleMessage({ type: "mcp_add" });
    assert.deepEqual(h.calls, [{ method: "mcp.add", params: { name: "supabase", project_path: "D:/test/workspace", config: { url: "https://mcp.supabase.com/mcp?project_ref=test", type: "http" } } }]);
    assert.equal(h.refreshes(), 1);
    assert.equal(h.changes(), 1);
  });

  it("preserves local command argument boundaries", async () => {
    const h = panelHarness();
    inputs = ["files", "npx", '["-y","server","D:/folder with spaces"]'];
    picks = ["Local command (stdio)"];
    await h.panel._handleMessage({ type: "mcp_add" });
    assert.deepEqual(h.calls[0].params.config, { command: "npx", args: ["-y", "server", "D:/folder with spaces"] });
  });

  it("does not mutate MCP configuration when the wizard is cancelled or workspace untrusted", async () => {
    const h = panelHarness();
    inputs = ["test"];
    await h.panel._handleMessage({ type: "mcp_add" });
    mockVscode.workspace.isTrusted = false;
    await h.panel._handleMessage({ type: "mcp_remove", name: "test" });
    assert.equal(h.calls.length, 0);
  });

  it("removes only the selected installed skill and refreshes available skills", async () => {
    const h = panelHarness();
    await h.panel._handleMessage({ type: "remove_skill", name: "docx", path: "D:/test/workspace/.agents/skills/docx" });
    assert.deepEqual(h.calls[0], { method: "skills.remove", params: { name: "docx", path: "D:/test/workspace/.agents/skills/docx", project_path: "D:/test/workspace" } });
    assert.equal(h.changes(), 1);
    assert.equal(h.refreshes(), 1);
  });

  it("honors cancellation when removing a server or skill", async () => {
    const h = panelHarness();
    confirmation = undefined;
    await h.panel._handleMessage({ type: "mcp_remove", name: "test" });
    await h.panel._handleMessage({ type: "remove_skill", name: "test", path: "path" });
    assert.equal(h.calls.length, 0);
  });

  it("authenticates with a PAT entered in the host, then refreshes MCP status", async () => {
    const h = panelHarness();
    picks = ["Use access token / PAT"];
    inputs = ["test-token"];
    await h.panel._handleMessage({ type: "mcp_auth", name: "supabase" });
    assert.equal(h.calls[0].method, "mcp.authenticate");
    assert.equal(h.calls[0].params.access_token, "test-token");
    assert.equal(h.calls[1].method, "mcp.list");
  });

  it("renders valid settings scripts and management controls", () => {
    const h = panelHarness();
    const html: string = h.panel._getHtmlForWebview();
    const scripts = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
    assert.ok(scripts.length);
    for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
    assert.ok(html.includes('data-action="mcp_add"'));
    assert.ok(html.includes('data-action="mcp_remove"'));
    assert.ok(html.includes('data-action="remove-skill"'));
    assert.ok(!html.includes('mcpGrid.addEventListener'));
    assert.ok(!html.includes('skillsGrid.addEventListener'));
  });

  it("replaces sign-in with collapsible tools and a re-authenticate action when connected", () => {
    const card = renderMcpCards([{ name: "supabase", remote: true, status: "running", tools_count: 1,
      command: "https://mcp.supabase.com/mcp?project_ref=" + "x".repeat(100),
      tools: [{ name: "list_tables", description: "List project tables" }] }]);
    assert.ok(card.includes("Connected"));
    assert.ok(card.includes('<details class="mcp-tools"><summary>View tools (1)</summary>'));
    assert.ok(!card.includes("<details open"));
    assert.ok(card.includes("list_tables"));
    assert.ok(card.includes("List project tables"));
    assert.ok(card.includes("Re-authenticate"));
    assert.ok(!card.includes("Connect / Authenticate"));
    assert.ok(card.includes('class="item-card-desc mcp-endpoint"'));
  });

  it("shows authentication while disconnected and safely escapes server tool content", () => {
    const offline = renderMcpCards([{ name: "supabase", remote: true, status: "needs_auth" }]);
    assert.ok(offline.includes("Connect / Authenticate"));
    assert.ok(!offline.includes("View tools"));
    const connected = renderMcpCards([{ name: "test", status: "running", tools_count: 1,
      tools: [{ name: '<script>alert(1)</script>', description: '<img src=x onerror="bad()">' }] }]);
    assert.ok(!connected.includes("<script>"));
    assert.ok(!connected.includes("<img"));
    assert.ok(connected.includes("&lt;script&gt;"));
  });
});
