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

import { getReviewHtml } from "../src/providers/changesReview/reviewHtml.js";
import { getReviewStyles } from "../src/providers/changesReview/reviewStyles.js";
import { getReviewClientScript } from "../src/providers/changesReview/reviewClientScript.js";

// Helper for Mock DOM environment
function createMockDOM() {
  const elementsById = new Map<string, any>();
  const allElements: any[] = [];
  const windowListeners: Record<string, Function[]> = {};
  const postedMessages: any[] = [];

  function createEl(tagName: string, id: string = "", className: string = ""): any {
    let _innerHTML = "";
    let _textContent = "";
    const listeners: Record<string, Function[]> = {};

    const el: any = {
      tagName: tagName.toUpperCase(),
      id,
      dataset: {},
      value: "",
      disabled: false,
      style: {},
      children: [],
      classList: {
        _classes: new Set<string>(),
        add: (...cls: string[]) => cls.forEach((c) => el.classList._classes.add(c)),
        remove: (...cls: string[]) => cls.forEach((c) => el.classList._classes.delete(c)),
        toggle: (c: string, force?: boolean) => {
          if (force !== undefined) {
            if (force) el.classList._classes.add(c);
            else el.classList._classes.delete(c);
            return force;
          }
          if (el.classList._classes.has(c)) {
            el.classList._classes.delete(c);
            return false;
          } else {
            el.classList._classes.add(c);
            return true;
          }
        },
        contains: (c: string) => el.classList._classes.has(c),
      },
      get className() {
        return [...el.classList._classes].join(" ");
      },
      set className(val: string) {
        el.classList._classes.clear();
        (val || "").split(/\s+/).filter(Boolean).forEach((c) => el.classList._classes.add(c));
      },
      get innerHTML() {
        return _innerHTML;
      },
      set innerHTML(val: string) {
        _innerHTML = String(val);
        _textContent = _innerHTML.replace(/<[^>]+>/g, "");
      },
      get textContent() {
        return _textContent;
      },
      set textContent(val: string) {
        _textContent = String(val);
        _innerHTML = String(val);
      },
      appendChild: (child: any) => {
        el.children.push(child);
        return child;
      },
      querySelectorAll: (sel: string) => {
        const res: any[] = [];
        const check = (node: any) => {
          if (sel.startsWith(".") && node.classList && node.classList.contains(sel.slice(1))) res.push(node);
          for (const c of node.children || []) check(c);
        };
        check(el);
        return res;
      },
      getAttribute: (attr: string) => el.dataset[attr] || el[attr] || null,
      setAttribute: (attr: string, v: string) => {
        if (attr.startsWith("data-")) el.dataset[attr.slice(5)] = v;
        el[attr] = v;
      },
      addEventListener: (evt: string, cb: Function) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(cb);
      },
      dispatchEvent: (evt: any) => {
        if (typeof evt === "string") evt = { type: evt };
        evt.target = el;
        evt.preventDefault = () => {};
        evt.stopPropagation = () => {};
        for (const cb of listeners[evt.type] || []) cb(evt);
      },
      click: () => el.dispatchEvent({ type: "click" }),
    };

    if (id) elementsById.set(id, el);
    allElements.push(el);
    return el;
  }

  // Pre-seed known elements from HTML
  createEl("div", "branch-label");
  createEl("div", "total-files");
  createEl("div", "total-additions");
  createEl("div", "total-deletions");
  createEl("div", "scope-toggles");
  createEl("button", "btn-scope-turn");
  createEl("button", "btn-scope-all");
  createEl("span", "turn-files-count");
  createEl("span", "all-files-count");
  createEl("div", "tree-scroll-area");
  createEl("input", "search-input");
  createEl("div", "diff-container");
  createEl("button", "refresh-btn");
  createEl("button", "btn-unified");
  createEl("button", "btn-split");
  createEl("div", "review-sidebar");
  createEl("div", "sidebar-resizer");
  createEl("button", "action-open-editor");
  createEl("button", "action-native-diff");
  createEl("button", "action-revert-file");

  const documentMock: any = {
    body: createEl("body"),
    getElementById: (id: string) => elementsById.get(id) || null,
    createElement: (tag: string) => createEl(tag),
    querySelectorAll: (sel: string) => allElements.filter((e) => sel.startsWith(".") && e.classList.contains(sel.slice(1))),
    addEventListener: (evt: string, cb: Function) => {
      windowListeners[evt] = windowListeners[evt] || [];
      windowListeners[evt].push(cb);
    },
  };

  const windowMock: any = {
    addEventListener: (evt: string, cb: Function) => {
      windowListeners[evt] = windowListeners[evt] || [];
      windowListeners[evt].push(cb);
    },
    dispatchEvent: (evt: any) => {
      for (const cb of windowListeners[evt.type] || []) cb(evt);
    },
  };

  const vscodeApiMock = {
    postMessage: (msg: any) => postedMessages.push(msg),
    getState: () => null,
    setState: () => {},
  };

  return {
    elementsById,
    allElements,
    postedMessages,
    document: documentMock,
    window: windowMock,
    acquireVsCodeApi: () => vscodeApiMock,
    dispatchMessage: (data: any) => {
      for (const cb of windowListeners["message"] || []) {
        cb({ data });
      }
    },
  };
}

describe("Changes Review Webview Unit Tests", () => {
  it("reviewClientScript should parse with 0 syntax errors in VM", () => {
    const scriptCode = getReviewClientScript();
    assert.ok(scriptCode.length > 500, "Review client script must be non-empty");

    assert.doesNotThrow(() => {
      new vm.Script(scriptCode, { filename: "reviewClientScript.js" });
    }, "reviewClientScript.js must parse with 0 syntax errors");
  });

  it("reviewStyles should provide all required theme and diff variables", () => {
    const styles = getReviewStyles();
    assert.ok(styles.includes("--diff-add-bg"), "Must define --diff-add-bg");
    assert.ok(styles.includes("--diff-del-bg"), "Must define --diff-del-bg");
    assert.ok(styles.includes(".review-header"), "Must define .review-header");
    assert.ok(styles.includes(".review-sidebar"), "Must define .review-sidebar");
    assert.ok(styles.includes(".diff-table"), "Must define .diff-table");
    assert.ok(styles.includes(".unmodified-banner"), "Must define .unmodified-banner");
  });

  it("getReviewHtml should produce a complete HTML document with CSP and nonces", () => {
    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };
    const extensionUri: any = {
      fsPath: "d:/saas/agent/vscode-extension",
    };

    const html = getReviewHtml(mockWebview, extensionUri);
    assert.ok(html.includes("<!DOCTYPE html>"), "Must be a valid HTML5 doctype");
    assert.ok(html.includes("Content-Security-Policy"), "Must include CSP");
    assert.ok(html.includes("nonce-"), "Must have script nonce");
    assert.ok(html.includes("review-header"), "Must include review header");
    assert.ok(html.includes("review-sidebar"), "Must include sidebar");
    assert.ok(html.includes("diff-container"), "Must include diff container");
  });

  it("reviewClientScript executes cleanly in DOM and posts webview_ready", () => {
    const dom = createMockDOM();
    const sandbox = {
      document: dom.document,
      window: dom.window,
      acquireVsCodeApi: dom.acquireVsCodeApi,
      console: console,
    };

    const scriptCode = getReviewClientScript();
    assert.doesNotThrow(() => {
      vm.runInNewContext(scriptCode, sandbox);
    });

    assert.ok(
      dom.postedMessages.some((m) => m.type === "webview_ready"),
      "Must emit webview_ready on initialization"
    );
  });

  it("renders file changes and triggers diff fetch when set_changes is received", () => {
    const dom = createMockDOM();
    const sandbox = {
      document: dom.document,
      window: dom.window,
      acquireVsCodeApi: dom.acquireVsCodeApi,
      console: console,
    };

    vm.runInNewContext(getReviewClientScript(), sandbox);

    // Dispatch changes from extension host
    dom.dispatchMessage({
      type: "set_changes",
      branch: "feature/review-panel",
      files: [
        { path: "src/andromity/core/cron.py", name: "cron.py", status: "M", additions: 195, deletions: 32 },
        { path: "tests/test_cron.py", name: "test_cron.py", status: "A", additions: 42, deletions: 0 },
      ],
      totalAdditions: 237,
      totalDeletions: 32,
      selectFile: "src/andromity/core/cron.py",
    });

    // Check header updates
    const branchLabel = dom.elementsById.get("branch-label");
    assert.equal(branchLabel.textContent, "feature/review-panel");

    const totalFiles = dom.elementsById.get("total-files");
    assert.equal(totalFiles.textContent, "2 Files Changed");

    const totalAdditions = dom.elementsById.get("total-additions");
    assert.equal(totalAdditions.textContent, "+237");

    const totalDeletions = dom.elementsById.get("total-deletions");
    assert.equal(totalDeletions.textContent, "-32");

    // Check that diff was requested for selected file
    assert.ok(
      dom.postedMessages.some((m) => m.type === "get_file_diff" && m.filePath === "src/andromity/core/cron.py"),
      "Must request diff for selected file"
    );

    // Supply diff
    dom.dispatchMessage({
      type: "set_file_diff",
      filePath: "src/andromity/core/cron.py",
      diff: "@@ -18,3 +18,3 @@\n-def parse_interval():\n+def parse_cron():\n",
    });

    const diffContainer = dom.elementsById.get("diff-container");
    assert.ok(diffContainer.innerHTML.includes("diff-table"), "Must render diff table");
    assert.ok(diffContainer.innerHTML.includes("parse_interval"), "Must render deleted line");
    assert.ok(diffContainer.innerHTML.includes("parse_cron"), "Must render added line");
  });

  it("toggles view modes between unified and split", () => {
    const dom = createMockDOM();
    const sandbox = {
      document: dom.document,
      window: dom.window,
      acquireVsCodeApi: dom.acquireVsCodeApi,
      console: console,
    };

    vm.runInNewContext(getReviewClientScript(), sandbox);

    const btnSplit = dom.elementsById.get("btn-split");
    const btnUnified = dom.elementsById.get("btn-unified");

    btnSplit.click();
    assert.ok(btnSplit.classList.contains("active"), "Split button should be active");
    assert.ok(!btnUnified.classList.contains("active"), "Unified button should not be active");

    btnUnified.click();
    assert.ok(btnUnified.classList.contains("active"), "Unified button should be active");
    assert.ok(!btnSplit.classList.contains("active"), "Split button should not be active");
  });

  it("clicking refresh button posts refresh message to extension host", () => {
    const dom = createMockDOM();
    const sandbox = {
      document: dom.document,
      window: dom.window,
      acquireVsCodeApi: dom.acquireVsCodeApi,
      console: console,
    };

    vm.runInNewContext(getReviewClientScript(), sandbox);

    const refreshBtn = dom.elementsById.get("refresh-btn");
    refreshBtn.click();

    assert.ok(
      dom.postedMessages.some((m) => m.type === "refresh"),
      "Clicking refresh must post { type: 'refresh' }"
    );
  });

  it("switches scope between Turn Changes and All Changes correctly", () => {
    const dom = createMockDOM();
    const sandbox = {
      document: dom.document,
      window: dom.window,
      acquireVsCodeApi: dom.acquireVsCodeApi,
      console: console,
    };

    vm.runInNewContext(getReviewClientScript(), sandbox);

    // Send 21 files with 4 turnFiles (simulating user's workspace with multiple index.html in different folders)
    const allFiles = [
      { path: "fake/index.html", name: "index.html", status: "U", additions: 171, deletions: 0 },
      { path: "fake/snake.html", name: "snake.html", status: "U", additions: 693, deletions: 0 },
      { path: "fake/memory.html", name: "memory.html", status: "U", additions: 335, deletions: 11 },
      { path: "fake/click-rush.html", name: "click-rush.html", status: "U", additions: 272, deletions: 0 },
      { path: "counter-strike/index.html", name: "index.html", status: "U", additions: 115, deletions: 0 },
      { path: "flappy-bird/index.html", name: "index.html", status: "U", additions: 47, deletions: 0 },
      { path: "flipflop/index.html", name: "index.html", status: "U", additions: 233, deletions: 0 },
      { path: "himanshu-portfolio/index.html", name: "index.html", status: "U", additions: 449, deletions: 0 },
      { path: "chicken-vs-road.txt", name: "chicken-vs-road.txt", status: "U", additions: 4, deletions: 0 },
      { path: "spaghetti-in-the-matrix.txt", name: "spaghetti-in-the-matrix.txt", status: "U", additions: 4, deletions: 0 },
      { path: ".gitignore", name: ".gitignore", status: "M", additions: 1, deletions: 0 },
    ];

    dom.dispatchMessage({
      type: "set_changes",
      branch: "master",
      files: allFiles,
      totalAdditions: 2324,
      totalDeletions: 11,
      turnFiles: ["fake/index.html", "fake/snake.html", "fake/memory.html", "fake/click-rush.html"],
    });

    const totalFiles = dom.elementsById.get("total-files");
    const scopeToggles = dom.elementsById.get("scope-toggles");
    const btnScopeTurn = dom.elementsById.get("btn-scope-turn");
    const btnScopeAll = dom.elementsById.get("btn-scope-all");
    const turnCountEl = dom.elementsById.get("turn-files-count");
    const allCountEl = dom.elementsById.get("all-files-count");

    // Scope toggle should be visible
    assert.equal(scopeToggles.style.display, "inline-flex");
    // MUST NOT match counter-strike/index.html, flappy-bird/index.html, etc.
    assert.equal(turnCountEl.textContent, "4", "Must strictly match 4 turn files without false positives");
    assert.equal(allCountEl.textContent, "11");

    // By default, turn scope should be active (4 files)
    assert.ok(btnScopeTurn.classList.contains("active"));
    assert.equal(totalFiles.textContent, "4 Files Changed");

    // Switch to all changes
    btnScopeAll.click();
    assert.ok(btnScopeAll.classList.contains("active"));
    assert.equal(totalFiles.textContent, "11 Files Changed");

    // Switch back to turn changes
    btnScopeTurn.click();
    assert.ok(btnScopeTurn.classList.contains("active"));
    assert.equal(totalFiles.textContent, "4 Files Changed");
  });

  it("renders true side-by-side split view with aligned rows", () => {
    const dom = createMockDOM();
    const sandbox = {
      document: dom.document,
      window: dom.window,
      acquireVsCodeApi: dom.acquireVsCodeApi,
      console: console,
    };

    vm.runInNewContext(getReviewClientScript(), sandbox);

    dom.dispatchMessage({
      type: "set_changes",
      branch: "master",
      files: [{ path: "fake/snake.html", name: "snake.html", status: "M", additions: 2, deletions: 1 }],
      selectFile: "fake/snake.html",
    });

    // Provide diff for fake/snake.html with deletions and additions
    dom.dispatchMessage({
      type: "set_file_diff",
      filePath: "fake/snake.html",
      diff: "@@ -10,3 +10,4 @@\n context line\n-old line\n+new line 1\n+new line 2\n end context\n",
    });

    const btnSplit = dom.elementsById.get("btn-split");
    btnSplit.click();

    const diffContainer = dom.elementsById.get("diff-container");
    assert.ok(diffContainer.innerHTML.includes("split-diff-header"), "Split view must render split-diff-header");
    assert.ok(diffContainer.innerHTML.includes("left-pane-header"), "Split view must render Base (HEAD) left-pane-header");
    assert.ok(diffContainer.innerHTML.includes("right-pane-header"), "Split view must render Working Tree right-pane-header");
    assert.ok(diffContainer.innerHTML.includes("split-row"), "Split view must render split-row elements");
    assert.ok(diffContainer.innerHTML.includes("left-pane del"), "Split view must render left-pane del cell");
    assert.ok(diffContainer.innerHTML.includes("right-pane add"), "Split view must render right-pane add cell");
    assert.ok(diffContainer.innerHTML.includes("new line 1"), "Must render added line");
    assert.ok(diffContainer.innerHTML.includes("old line"), "Must render deleted line");
  });

  it("clicking revert file button posts revert_file message to extension host", () => {
    const dom = createMockDOM();
    const sandbox = {
      document: dom.document,
      window: dom.window,
      acquireVsCodeApi: dom.acquireVsCodeApi,
      console: console,
    };

    vm.runInNewContext(getReviewClientScript(), sandbox);

    dom.dispatchMessage({
      type: "set_changes",
      branch: "master",
      files: [{ path: "fake/snake.html", name: "snake.html", status: "M", additions: 1, deletions: 0 }],
      selectFile: "fake/snake.html",
    });

    dom.dispatchMessage({
      type: "set_file_diff",
      filePath: "fake/snake.html",
      diff: "@@ -1,1 +1,2 @@\n context\n+new line\n",
    });

    const revertBtn = dom.elementsById.get("action-revert-file");
    assert.ok(revertBtn, "Action revert button must exist in file header");
    revertBtn.click();

    assert.ok(
      dom.postedMessages.some((m) => m.type === "revert_file" && m.filePath === "fake/snake.html"),
      "Clicking revert button must post { type: 'revert_file', filePath: 'fake/snake.html' }"
    );
  });

  it("updates turnFiles dynamically across multiple turns without showing stale counts", () => {
    const dom = createMockDOM();
    const sandbox = {
      document: dom.document,
      window: dom.window,
      acquireVsCodeApi: dom.acquireVsCodeApi,
      console: console,
    };

    vm.runInNewContext(getReviewClientScript(), sandbox);

    const allFiles = [
      { path: "fake/file1.ts", name: "file1.ts", status: "M", additions: 10, deletions: 2 },
      { path: "fake/file2.ts", name: "file2.ts", status: "M", additions: 5, deletions: 1 },
      { path: "fake/file3.ts", name: "file3.ts", status: "M", additions: 8, deletions: 0 },
    ];

    // Turn 1
    dom.dispatchMessage({
      type: "set_changes",
      branch: "main",
      files: allFiles,
      turnFiles: ["fake/file1.ts"],
    });

    const totalFiles = dom.elementsById.get("total-files");
    const turnCountEl = dom.elementsById.get("turn-files-count");
    const allCountEl = dom.elementsById.get("all-files-count");
    const scopeToggles = dom.elementsById.get("scope-toggles");

    assert.equal(turnCountEl.textContent, "1");
    assert.equal(totalFiles.textContent, "1 File Changed");
    assert.equal(allCountEl.textContent, "3");

    // Turn 2 arrives with 2 different files
    dom.dispatchMessage({
      type: "set_changes",
      branch: "main",
      files: allFiles,
      turnFiles: ["fake/file2.ts", "fake/file3.ts"],
    });

    assert.equal(turnCountEl.textContent, "2", "Turn 2 must update count to 2, never keeping stale Turn 1 count");
    assert.equal(totalFiles.textContent, "2 Files Changed");

    // Turn 3 arrives with no files changed (e.g. read-only or empty turn)
    dom.dispatchMessage({
      type: "set_changes",
      branch: "main",
      files: allFiles,
      turnFiles: [],
    });

    assert.equal(scopeToggles.style.display, "none", "Scope toggle should hide when turn has no edited files");
    assert.equal(totalFiles.textContent, "3 Files Changed", "Scope should fall back to all files");
  });
});

