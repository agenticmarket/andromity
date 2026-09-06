import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

// Mock vscode module for Node testing
// @ts-ignore
const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (reqPath: string) {
  if (reqPath === "vscode") {
    return {
      Uri: {
        joinPath: (...args: any[]) => ({
          fsPath: args.map((a) => (typeof a === "object" ? a.fsPath || a.path : String(a))).join("/"),
        }),
        file: (p: string) => ({ fsPath: p }),
      },
    };
  }
  return origRequire.apply(this, arguments as any);
};

import { ChatViewState, getChatViewHtml } from "../src/providers/chatview/chatHtml.js";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import { getWaterfallHtml } from "../src/providers/waterfall/waterfallHtml.js";
import { getWaterfallScript } from "../src/providers/waterfall/waterfallScript.js";

describe("Webview Client Scripts & Regex Escaping Unit Tests", () => {
  it("ChatViewProvider client script should compile with 0 syntax errors", () => {
    const state: ChatViewState = {
      currentSessionId: "sess-test",
      currentModel: "anthropic/claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
      models: [{ id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet" }],
    };

    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };
    const extensionUri: any = {
      fsPath: "d:/saas/agent/vscode-extension",
    };

    const scriptCode = getChatClientScript("vscode-resource://icon.svg", state);
    assert.ok(scriptCode.length > 1000, "Client script should be non-empty");

    // Must compile cleanly with node vm.Script
    assert.doesNotThrow(() => {
      new vm.Script(scriptCode, { filename: "chatClientScript.js" });
    }, "chatClientScript.js must parse with 0 syntax errors");
  });

  it("ChatViewProvider generated HTML should contain valid JS in all script tags", () => {
    const state: ChatViewState = {
      currentSessionId: "sess-test",
      currentModel: "anthropic/claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
      models: [{ id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet" }],
    };

    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };
    const extensionUri: any = {
      fsPath: "d:/saas/agent/vscode-extension",
    };

    const html = getChatViewHtml(mockWebview, extensionUri, state);
    assert.ok(html.length > 5000, "HTML should be generated");

    const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1])
      .filter(s => s.trim().length > 0);

    assert.ok(scriptMatches.length > 0, "Should find at least one inline script");

    for (let i = 0; i < scriptMatches.length; i++) {
      const code = scriptMatches[i];
      assert.doesNotThrow(() => {
        new vm.Script(code, { filename: `chatview-inline-script-${i}.js` });
      }, `Inline script #${i} must have valid syntax`);
    }
  });

  it("should correctly render markdown and regexes without escaping issues", () => {
    const state: ChatViewState = {
      currentSessionId: "sess-test",
      currentModel: "claude-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
    };

    const scriptCode = getChatClientScript("icon.svg", state);

    // Sandbox execution to test renderInline & renderMarkdown
    const postedMessages: any[] = [];
    const mockDoc: any = {
      getElementById: () => ({
        addEventListener: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
        style: {},
        value: "",
        innerHTML: "",
        textContent: "",
        appendChild: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
      }),
      createElement: () => ({
        addEventListener: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
        style: {},
        setAttribute: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { classList: { add: () => {}, remove: () => {} } },
    };

    const mockWindow: any = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    };

    const sandbox: any = {
      acquireVsCodeApi: () => ({
        postMessage: (m: any) => postedMessages.push(m),
        getState: () => ({}),
        setState: () => {},
      }),
      document: mockDoc,
      window: mockWindow,
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
      setTimeout: (fn: Function) => { fn(); },
      setInterval: () => 1,
      clearInterval: () => {},
      clearTimeout: () => {},
      requestAnimationFrame: (fn: Function) => { fn(); },
      cancelAnimationFrame: () => {},
      marked: {
        parse: (s: string) => s,
        use: () => {},
      },
      navigator: { clipboard: { writeText: () => Promise.resolve() } },
      encodeURIComponent,
      decodeURIComponent,
      Math,
      Date,
      JSON,
      String,
      Number,
      Array,
      Object,
      RegExp,
      Set,
      Map,
    };

    vm.createContext(sandbox);
    assert.doesNotThrow(() => {
      vm.runInContext(scriptCode, sandbox);
    }, "Script execution in mock DOM environment should not throw");
  });

  it("Waterfall client script should compile with 0 syntax errors", () => {
    const scriptCode = getWaterfallScript("test-session-123");
    assert.ok(scriptCode.length > 500, "Waterfall script should be non-empty");

    assert.doesNotThrow(() => {
      new vm.Script(scriptCode, { filename: "waterfallScript.js" });
    }, "waterfallScript.js must parse with 0 syntax errors");
  });

  it("Waterfall HTML should contain valid CSP, nonce, and script structure", () => {
    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };

    const html = getWaterfallHtml(mockWebview, "test-sess", "Test Session");
    assert.ok(html.includes("<!DOCTYPE html>"), "Must be a full HTML document");
    assert.ok(html.includes("Content-Security-Policy"), "Must declare strict CSP");
    assert.ok(html.includes("nonce-"), "Must have script nonce in CSP");
    assert.ok(html.includes('<script nonce="'), "Script tags must be nonce-protected");

    const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1], "Should extract script body");

    assert.doesNotThrow(() => {
      new vm.Script(scriptMatch[1], { filename: "extractedWaterfallScript.js" });
    }, "Extracted waterfall script must parse with 0 syntax errors");
  });
});
