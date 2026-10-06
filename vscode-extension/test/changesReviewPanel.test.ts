import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const notices: string[] = [];
const workspace = { workspaceFolders: [{ uri: { fsPath: "D:/repo" } }], textDocuments: [] as any[] };
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace, window: {
      showErrorMessage: (text: string) => notices.push(text),
      showWarningMessage: async (text: string) => { notices.push(text); return "Discard Changes"; },
    }, commands: { executeCommand: async () => {} },
  };
  return originalRequire.apply(this, arguments as any);
};
import { ChangesReviewPanel } from "../src/panels/ChangesReviewPanel.js";

function panel(rpc: any) {
  const value: any = Object.create(ChangesReviewPanel.prototype);
  Object.assign(value, { _rpcClient: rpc, _knownFiles: new Set(["file.txt"]), _repositoryRoot: "D:/repo",
    _isDisposed: false, _refreshVersion: 0, _diffVersion: 0, _turnFiles: undefined });
  const posts: any[] = [];
  value._postMessage = (message: any) => posts.push(message);
  value.loadChanges = async () => {};
  return { value, posts };
}

it("discard cannot delete a tracked file when the daemon is unavailable or reports failure", async () => {
  const offline = panel(null);
  await offline.value._revertFile("file.txt");
  assert.ok(notices.some(text => text.includes("Reconnect")));
  const calls: string[] = [];
  const connected = panel({ call: async (method: string) => { calls.push(method); return { success: false }; } });
  await connected.value._revertFile("file.txt");
  assert.deepEqual(calls, ["git.revert_file"]);
  assert.ok(notices.some(text => text.includes("Could not discard")));
});

it("only the latest file selection may publish its diff", async () => {
  const resolve: Array<(result: any) => void> = [];
  const { value, posts } = panel({ call: () => new Promise(done => resolve.push(done)) });
  value._knownFiles.add("other.txt");
  const first = value.loadFileDiff("file.txt");
  const second = value.loadFileDiff("other.txt");
  resolve[1]({ diff: "second" });
  await second;
  resolve[0]({ diff: "stale" });
  await first;
  assert.deepEqual(posts.map(message => message.filePath), ["other.txt"]);
});
