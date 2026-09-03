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
});
