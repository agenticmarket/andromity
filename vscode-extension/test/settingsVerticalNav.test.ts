import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mock vscode module for Node testing
// @ts-ignore
const Module = require("module");
const origRequire = Module.prototype.require;
const mockVscode: any = {
  Uri: {
    joinPath: (...args: any[]) => ({
      fsPath: args.map((a) => (typeof a === "object" ? a.fsPath || a.path : String(a))).join("/"),
    }),
    file: (p: string) => ({ fsPath: p }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defVal: any) => defVal,
    }),
    workspaceFolders: [{ uri: { fsPath: "D:/mock/ws" } }],
  },
  window: {
    showWarningMessage: async () => "",
    showInformationMessage: () => {},
    showErrorMessage: () => {},
  },
  extensions: {
    getExtension: () => ({ packageJSON: { version: "0.2.14" } }),
  },
  commands: {
    executeCommand: () => {},
  },
};
Module.prototype.require = function (reqPath: string) {
  if (reqPath === "vscode") {
    return mockVscode;
  }
  return origRequire.apply(this, arguments as any);
};

import { SettingsPanel } from "../src/panels/SettingsPanel.js";

describe("Settings Panel Vertical Navigation & Responsive Low-Space Tests", () => {
  const mockWebview: any = {
    cspSource: "vscode-webview:",
    asWebviewUri: (u: any) => `vscode-resource://${u.path || u.fsPath || u}`,
  };

  const mockPanel: any = {
    webview: mockWebview,
  };

  const mockExtensionUri: any = {
    fsPath: "d:/saas/agent/vscode-extension",
    path: "/d:/saas/agent/vscode-extension",
  };

  const mockContext: any = {
    _panel: mockPanel,
    _extensionUri: mockExtensionUri,
    _initialTab: "models",
    _getNonce: () => "mock-test-nonce-12345",
  };

  it("should generate HTML with vertical side-nav structure", () => {
    const html: string = (SettingsPanel.prototype as any)._getHtmlForWebview.call(mockContext);

    assert.ok(html.includes('<aside class="side-nav" id="side-nav">'), "HTML must include <aside class=\"side-nav\" id=\"side-nav\">");
    assert.ok(html.includes('class="sidebar-header"'), "HTML must include sidebar header");
    assert.ok(html.includes('class="brand-title">Andromity Hub</span>'), "HTML must include brand title");
    assert.ok(html.includes('id="nav-tabs-container"'), "HTML must include nav tabs container");
    assert.ok(html.includes('id="sidebar-toggle-btn"'), "HTML must include sidebar toggle button");
    assert.ok(html.includes('id="nav-floating-tooltip"'), "HTML must include floating tooltip element");
  });

  it("should format all tab buttons with labels, badges, and tooltip data", () => {
    const html: string = (SettingsPanel.prototype as any)._getHtmlForWebview.call(mockContext);

    const requiredTabs = [
      { id: "tab-btn-models", tab: "models", label: "Model Hub" },
      { id: "tab-btn-crons", tab: "crons", label: "Cron Jobs" },
      { id: "tab-btn-keys", tab: "keys", label: "API Keys & Connectors" },
      { id: "tab-btn-skills", tab: "skills", label: "Skills & Packs" },
      { id: "tab-btn-mcp", tab: "mcp", label: "MCP Servers" },
      { id: "tab-btn-usage", tab: "usage", label: "Usage & Costs" },
      { id: "tab-btn-trust", tab: "trust", label: "Trust & Security" },
      { id: "tab-btn-general", tab: "general", label: "Preferences" },
      { id: "tab-btn-personalisation", tab: "personalisation", label: "Personalisation" },
      { id: "tab-btn-about", tab: "about", label: "About & Diagnostics" },
    ];

    for (const tab of requiredTabs) {
      assert.ok(html.includes(`id="${tab.id}"`), `Tab ${tab.id} must be present`);
      assert.ok(html.includes(`data-tab="${tab.tab}"`), `Tab ${tab.tab} data-tab must be present`);
      assert.ok(html.includes(`data-tooltip="${tab.label}"`), `Tab ${tab.label} data-tooltip must be present`);
      assert.ok(html.includes(`<span class="nav-tab-label">${tab.label}</span>`), `Tab label span for ${tab.label} must be present`);
    }

    // Badge IDs
    assert.ok(html.includes('id="model-count-badge"'), "model-count-badge must be present");
    assert.ok(html.includes('id="crons-count-badge"'), "crons-count-badge must be present");
    assert.ok(html.includes('id="skills-count-badge"'), "skills-count-badge must be present");
  });

  it("should contain CSS rules for vertical layout, responsive collapse, and tooltips", () => {
    const html: string = (SettingsPanel.prototype as any)._getHtmlForWebview.call(mockContext);

    // Body flex direction row
    assert.ok(html.includes("flex-direction: row;"), "Body must use flex-direction: row for side-by-side layout");

    // Side nav widths
    assert.ok(html.includes(".side-nav {"), ".side-nav CSS selector must exist");
    assert.ok(html.includes("width: 228px;"), "Expanded sidebar width must be 228px");
    assert.ok(html.includes("width: 52px;"), "Collapsed sidebar width must be 52px");

    // Responsive low-space query
    assert.ok(html.includes("@media (max-width: 820px)"), "CSS must contain @media (max-width: 820px) breakpoint");

    // Tooltip styling
    assert.ok(html.includes(".nav-floating-tooltip"), "Floating tooltip CSS class must exist");
    assert.ok(html.includes(".nav-floating-tooltip.visible"), "Floating tooltip visible state class must exist");
  });

  it("should include client script logic for collapse, low-space auto-detection, and tooltips", () => {
    const html: string = (SettingsPanel.prototype as any)._getHtmlForWebview.call(mockContext);

    // Tab switching
    assert.ok(html.includes("switchTab(tab)"), "Script must contain switchTab function");

    // Sidebar collapse state
    assert.ok(html.includes("setSidebarCollapsed"), "Script must contain setSidebarCollapsed function");
    assert.ok(html.includes("sideNav.classList.add(\"collapsed\")"), "Script must toggle collapsed class");

    // Low space detection
    assert.ok(html.includes("window.innerWidth < 820"), "Script must detect low space below 820px");
    assert.ok(html.includes("sideNav.classList.add(\"auto-compact\")"), "Script must add auto-compact class in low space");

    // Tooltip handlers
    assert.ok(html.includes("navTooltip.classList.add(\"visible\")"), "Script must show floating tooltip on hover");
    assert.ok(html.includes("navTooltip.classList.remove(\"visible\")"), "Script must hide floating tooltip on mouseleave");
  });
});
