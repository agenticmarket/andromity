import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
let inputs: Array<string | undefined> = [];
let picks: Array<string | undefined> = [];
let confirmation: string | undefined = "Remove";
let infoPick: string | undefined;
const opened: string[] = [];
const mockVscode = {
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: "D:/test/workspace" } }] },
  window: {
    showInputBox: async () => inputs.shift(),
    showQuickPick: async () => picks.shift(),
    showWarningMessage: async () => confirmation,
    showErrorMessage: () => {},
    showInformationMessage: async () => infoPick,
  },
  env: { openExternal: async (uri: { toString(): string }) => { opened.push(uri.toString()); return true; } },
  Uri: { joinPath: () => ({ fsPath: "icon.svg" }), parse: (value: string) => ({ toString: () => value }) },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments);
};
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
const { CONNECTOR_ICONS } = require("../src/panels/connectorIcons.js");
Module.prototype.require = originalRequire;

function panelHarness() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const posts: unknown[] = [];
  let refreshes = 0;
  let changes = 0;
  const panel = Object.create(SettingsPanel.prototype);
  panel._rpcClient = { call: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "mcp.list") return [];
    if (method === "connectors.list") return [{ ...NOTION, connected: true }, GMAIL];
    return { success: true, status: "running" };
  } };
  panel._panel = { webview: { cspSource: "vscode-webview:", asWebviewUri: () => "icon.svg", postMessage: (post: unknown) => posts.push(post) } };
  panel._extensionUri = { fsPath: "D:/extension" };
  panel.loadData = async () => { refreshes++; };
  panel._onConfigChangeCallback = () => { changes++; };
  return { panel, calls, posts, refreshes: () => refreshes, changes: () => changes };
}

const NOTION = { id: "notion", name: "Notion", category: "Productivity", url: "https://mcp.notion.com/mcp",
  description: "Search and edit pages.", needs_client: false, setup_url: "", connected: false };
const GMAIL = { id: "gmail", name: "Gmail", category: "Google", url: "https://gmailmcp.googleapis.com/mcp/v1",
  description: "Read email.", needs_client: true, setup_url: "https://console.cloud.google.com/apis/credentials", connected: false };

interface McpRender { html: string; context: Record<string, any>; elements: Record<string, any> }

/** Runs the webview's MCP render functions against stub elements. */
function runMcpScript(call: string, state: { servers?: unknown[]; connectors?: unknown[]; query?: string }): McpRender {
  const html: string = panelHarness().panel._getHtmlForWebview();
  const start = html.indexOf("    function renderConnectors() {");
  const end = html.indexOf("    let allCrons", start);
  assert.ok(start >= 0 && end > start);
  const elements: Record<string, any> = {};
  const element = (id: string) => elements[id] ??= {
    innerHTML: "", textContent: "", style: { display: "" }, classList: { toggle(name: string, on: boolean) { elements[id].active = on; } },
  };
  const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const context: Record<string, any> = {
    allMcpServers: state.servers ?? [], allConnectors: state.connectors ?? [], connectorQuery: state.query ?? "",
    mcpView: "", CONNECTOR_ICONS, escapeHtml, document: { getElementById: element },
  };
  vm.runInNewContext(html.slice(start, end) + "\n" + call, context);
  return { html: elements["connectors-list"]?.innerHTML ?? elements["mcp-grid"]?.innerHTML ?? "", context, elements };
}

const renderConnectorTiles = (connectors: unknown[], query = "") =>
  runMcpScript("renderConnectors();", { connectors, query }).html;
const renderMcpCards = (servers: unknown[], connectors: unknown[] = []) =>
  runMcpScript("renderMcp();", { servers, connectors }).html;

describe("Settings integration management", () => {
  beforeEach(() => {
    inputs = []; picks = []; confirmation = "Remove"; infoPick = undefined; opened.length = 0;
    mockVscode.workspace.isTrusted = true;
    SettingsPanel._cachedState = { connectors: [NOTION, GMAIL] };
  });

  it("connects a catalog app in one step and refreshes servers and connectors", async () => {
    const h = panelHarness();
    await h.panel._handleMessage({ type: "connector_connect", id: "notion" });
    assert.deepEqual(h.calls[0], { method: "connectors.connect",
      params: { id: "notion", project_path: "D:/test/workspace", client_id: "", client_secret: "", access_token: "" } });
    assert.deepEqual(h.calls.slice(1).map(c => c.method).sort(), ["connectors.list", "mcp.list"]);
    assert.equal(h.changes(), 1);
    const refreshed = h.posts.find((p: any) => p.type === "connectors_refreshed") as any;
    assert.equal(refreshed.connectors[0].connected, true);
    assert.equal(SettingsPanel._cachedState.connectors[0].connected, true);
  });

  it("collects the Google OAuth client in the host before signing in", async () => {
    const h = panelHarness();
    infoPick = "Enter client";
    inputs = [" client-id ", "client-secret"];
    await h.panel._handleMessage({ type: "connector_connect", id: "gmail" });
    assert.equal(h.calls[0].method, "connectors.connect");
    assert.equal(h.calls[0].params.client_id, " client-id ");
    assert.equal(h.calls[0].params.client_secret, "client-secret");
  });

  it("asks for an access token in the host for token connectors, or opens the token page", async () => {
    const GITHUB = { ...NOTION, id: "github", name: "GitHub", auth: "token", setup_url: "https://github.com/settings/personal-access-tokens/new" };
    SettingsPanel._cachedState = { connectors: [GITHUB] };
    const h = panelHarness();
    infoPick = "Create a token";
    await h.panel._handleMessage({ type: "connector_connect", id: "github" });
    assert.deepEqual(opened, [GITHUB.setup_url]);
    assert.ok(!h.calls.some(c => c.method === "connectors.connect"));
    SettingsPanel._cachedState = { connectors: [GITHUB] };
    infoPick = "Enter token";
    inputs = ["ghp_test"];
    await h.panel._handleMessage({ type: "connector_connect", id: "github" });
    const connect = h.calls.find(c => c.method === "connectors.connect")!;
    assert.equal(connect.params.access_token, "ghp_test");
    assert.ok(renderConnectorTiles([GITHUB]).includes("Connects with an access token."));
  });

  it("opens Google Cloud or stops without connecting when the client step is not finished", async () => {
    const h = panelHarness();
    infoPick = "Open Google Cloud";
    await h.panel._handleMessage({ type: "connector_connect", id: "gmail" });
    assert.deepEqual(opened, [GMAIL.setup_url]);
    infoPick = "Enter client";
    inputs = ["client-id", undefined];
    await h.panel._handleMessage({ type: "connector_connect", id: "gmail" });
    mockVscode.workspace.isTrusted = false;
    await h.panel._handleMessage({ type: "connector_connect", id: "notion" });
    await h.panel._handleMessage({ type: "connector_connect", id: "unknown" });
    assert.ok(!h.calls.some(c => c.method === "connectors.connect"));
    assert.ok(h.posts.every((p: any) => p.type !== "connectors_refreshed" || Array.isArray(p.connectors)));
  });

  it("renders connectors by category with escaped text and connected badges", () => {
    const html = renderConnectorTiles([{ ...NOTION, name: "<b>Notion</b>" }, { ...GMAIL, connected: true }]);
    assert.ok(html.indexOf("Productivity") < html.indexOf("Google"));
    assert.ok(html.includes("&lt;b&gt;Notion&lt;/b&gt;"));
    assert.ok(html.includes('data-action="connector_connect" data-id="notion"'));
    assert.ok(!html.includes('data-id="gmail"'));
    assert.ok(html.includes("Connected"));
    assert.ok(renderConnectorTiles([]).includes("updated Andromity server"));
  });

  it("draws bundled brand icons with contrasting glyphs and letters for apps without one", () => {
    const html = renderConnectorTiles([NOTION, GMAIL, { ...NOTION, id: "canva", name: "Canva" }]);
    assert.ok(html.includes("background:#" + CONNECTOR_ICONS.notion.hex));
    assert.ok(html.includes('fill="#ffffff"'), "dark Notion tile gets a white glyph");
    assert.ok(html.includes('connector-icon-letter" aria-hidden="true">C</span>'));
    assert.ok(!html.includes("http"), "icons are inline, never fetched");
  });

  it("filters Discover by name, description, or category", () => {
    assert.ok(renderConnectorTiles([NOTION, GMAIL], "google").includes("Gmail"));
    assert.ok(!renderConnectorTiles([NOTION, GMAIL], "google").includes("Notion"));
    assert.ok(renderConnectorTiles([NOTION, GMAIL], "zzz").includes("No apps match"));
  });

  it("opens Discover first when there are no servers, and Yours once servers exist", () => {
    const empty = runMcpScript("renderMcp(); renderMcpCounts();", { connectors: [NOTION, GMAIL] });
    assert.equal(empty.context.mcpView, "discover");
    assert.equal(empty.elements["mcp-discover-num"].textContent, "2");
    assert.ok(empty.elements["mcp-grid"].innerHTML.includes('data-action="mcp_show_discover"'));
    const some = runMcpScript("renderMcpCounts();", { servers: [{ name: "notion" }], connectors: [NOTION] });
    assert.equal(some.context.mcpView, "yours");
    assert.equal(some.elements["mcp-view-discover"].style.display, "none");
    assert.ok(renderMcpCards([{ name: "notion", status: "running" }], [{ ...NOTION, connected: true }]).includes("connector-icon small"));
  });

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
