import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace: { workspaceFolders: [] },
    Uri: { joinPath: (...parts: unknown[]) => parts.join("/") },
  };
  return originalRequire.apply(this, arguments as any);
};
import { ChatViewProvider } from "../src/providers/ChatViewProvider.js";
import { SessionTabPanel } from "../src/panels/SessionTabPanel.js";
Module.prototype.require = originalRequire;

it("persists visibility from both chat surfaces and injects it before the next webview paints", async () => {
  const saved = new Map<string, unknown>();
  const broadcasts: unknown[] = [];
  const provider: any = Object.create(ChatViewProvider.prototype);
  Object.assign(provider, {
    _extensionUri: "extension",
    _context: { globalState: {
      get: (key: string) => saved.get(key),
      update: async (key: string, value: unknown) => { saved.set(key, value); },
    } },
    broadcastToWebviews: (message: unknown) => broadcasts.push(message),
    getWallpaperConfig: () => ({}),
  });
  const tab: any = Object.create(SessionTabPanel.prototype);
  tab._viewProvider = provider;
  const webview = { cspSource: "test:", asWebviewUri: (uri: unknown) => String(uri) };

  await tab._handleMessage({ type: "side_panel_visibility", off: true });
  assert.equal(saved.get("andromity.sidePanelOff"), true);
  assert.deepEqual(broadcasts.at(-1), { type: "side_panel_visibility", off: true });
  assert.match(provider._getHtmlForWebview(webview), /<body class="loading side-panel-off">/);
  const panel = { webview: { ...webview, html: "", onDidReceiveMessage() {} }, onDidDispose() {} };
  new (SessionTabPanel as any)(panel, "extension", "session", "Session", null, {}, provider);
  assert.match(panel.webview.html, /<body class="andromity-session-tab loading side-panel-off">/, "pop-outs retain their layout class when starting hidden");

  await provider._handleWebviewMessage({ type: "side_panel_visibility", off: false });
  assert.equal(saved.get("andromity.sidePanelOff"), false);
  assert.match(provider._getHtmlForWebview(webview), /<body class="loading">/);
  const count = broadcasts.length;
  await provider._handleWebviewMessage({ type: "side_panel_visibility", off: "true" });
  assert.equal(saved.get("andromity.sidePanelOff"), false);
  assert.equal(broadcasts.length, count, "invalid messages cannot alter the preference");

  await tab._handleMessage({ type: "side_panel_preferences", preferences: {
    order: ["env", "changes", "context", "mcp"], collapsed: ["mcp"], hidden: ["changes"], breakdown: true,
  } });
  assert.deepEqual(saved.get("andromity.sidePanel"), {
    order: ["env", "changes", "context", "mcp"], collapsed: ["mcp"], hidden: ["changes"], breakdown: true,
  });
  assert.match(provider._getHtmlForWebview(webview), /"order":\["env","changes","context","mcp"\]/);
  assert.equal((broadcasts.at(-1) as any).type, "side_panel_preferences");
  await provider._handleWebviewMessage({ type: "side_panel_preferences", preferences: { order: ["mcp", "invalid", "mcp"] } });
  assert.deepEqual((saved.get("andromity.sidePanel") as any).order, ["mcp", "context", "changes", "env"]);
  const layoutCount = broadcasts.length;
  await provider._handleWebviewMessage({ type: "side_panel_preferences", preferences: "invalid" });
  assert.equal(broadcasts.length, layoutCount);
});
