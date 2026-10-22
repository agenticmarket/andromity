import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const watchers: any[] = [];
const panels: any[] = [];
function emitter() {
  const listeners: Function[] = [];
  const on = (fn: Function) => { listeners.push(fn); return { dispose() {} }; };
  return { on, fire: (value?: any) => listeners.forEach((fn) => fn(value)) };
}
const vscodeMock: any = {
  ViewColumn: { Active: -1, One: 1 },
  Uri: {
    joinPath: (...parts: any[]) => ({ fsPath: parts.map((p) => (typeof p === "object" ? p.fsPath : String(p))).join("/") }),
    file: (p: string) => ({ fsPath: p }),
  },
  window: {
    activeTextEditor: undefined,
    createWebviewPanel: () => {
      const viewState = emitter();
      const panel: any = {
        visible: true,
        reveal() {},
        dispose() {},
        onDidDispose: () => ({ dispose() {} }),
        onDidChangeViewState: viewState.on,
        fireViewState: viewState.fire,
        webview: {
          html: "", cspSource: "vscode-webview:",
          asWebviewUri: (u: any) => u,
          postMessage: async () => true,
          onDidReceiveMessage: () => ({ dispose() {} }),
        },
      };
      panels.push(panel);
      return panel;
    },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "D:/repo" } }],
    getWorkspaceFolder: () => undefined,
    createFileSystemWatcher: () => {
      const change = emitter(), create = emitter(), del = emitter();
      const watcher = { onDidChange: change.on, onDidCreate: create.on, onDidDelete: del.on, change, create, del, dispose() {} };
      watchers.push(watcher);
      return watcher;
    },
  },
  commands: { executeCommand: async () => {} },
};

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments as any);
};
const { ChangesReviewPanel, isReviewRelevantChange, AUTO_REFRESH_DELAY_MS } = require("../src/panels/ChangesReviewPanel.js");
Module.prototype.require = originalRequire;

function openPanel() {
  ChangesReviewPanel.currentPanel?.dispose();
  const review = ChangesReviewPanel.createOrShow({ fsPath: "/ext" }, null);
  const refreshes: Array<[string | undefined, boolean]> = [];
  review.loadChanges = async (select?: string, auto = false) => { refreshes.push([select, auto]); };
  return { review, refreshes, watcher: watchers.at(-1), panel: panels.at(-1) };
}

describe("Changes Review auto-refresh", () => {
  it("ignores node_modules and git internals other than HEAD, the index and branch refs", () => {
    assert.equal(isReviewRelevantChange("D:\\repo\\src\\app.ts"), true);
    assert.equal(isReviewRelevantChange("D:/repo/node_modules/x/index.js"), false);
    assert.equal(isReviewRelevantChange("D:/repo/.git/objects/ab/cdef"), false);
    assert.equal(isReviewRelevantChange("D:/repo/.git/index.lock"), false);
    assert.equal(isReviewRelevantChange("D:/repo/.git/index"), true);
    assert.equal(isReviewRelevantChange("D:/repo/.git/HEAD"), true);
    assert.equal(isReviewRelevantChange("D:/repo/.git/refs/heads/main"), true);
  });

  it("a burst of file changes causes one background refresh", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { refreshes, watcher } = openPanel();
      for (let i = 0; i < 20; i++) watcher.change.fire({ fsPath: `D:/repo/src/file${i}.ts` });
      watcher.create.fire({ fsPath: "D:/repo/src/new.ts" });
      mock.timers.tick(AUTO_REFRESH_DELAY_MS - 1);
      assert.equal(refreshes.length, 0);
      mock.timers.tick(1);
      assert.deepEqual(refreshes, [[undefined, true]], "one refresh, marked automatic so the view keeps its place");
    } finally {
      mock.timers.reset();
    }
  });

  it("ignored paths never trigger a refresh", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { refreshes, watcher } = openPanel();
      watcher.change.fire({ fsPath: "D:/repo/node_modules/pkg/a.js" });
      watcher.change.fire({ fsPath: "D:/repo/.git/objects/aa/bb" });
      mock.timers.tick(AUTO_REFRESH_DELAY_MS * 2);
      assert.equal(refreshes.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  it("while hidden it only marks itself stale, and refreshes once when shown", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { refreshes, watcher, panel } = openPanel();
      panel.visible = false;
      watcher.change.fire({ fsPath: "D:/repo/src/a.ts" });
      mock.timers.tick(AUTO_REFRESH_DELAY_MS);
      watcher.del.fire({ fsPath: "D:/repo/src/b.ts" });
      mock.timers.tick(AUTO_REFRESH_DELAY_MS);
      assert.equal(refreshes.length, 0, "no work while you are not looking");

      panel.visible = true;
      panel.fireViewState();
      panel.fireViewState();
      assert.deepEqual(refreshes, [[undefined, true]]);
    } finally {
      mock.timers.reset();
    }
  });
});
