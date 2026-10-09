import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace: { workspaceFolders: [{ uri: { fsPath: "D:/repo" } }] },
    window: {},
    commands: { executeCommand: () => {} },
  };
  return originalRequire.apply(this, arguments as any);
};
import { ChatViewProvider } from "../src/providers/ChatViewProvider.js";

function openWith(turnFiles: string[] | null | undefined): unknown[] {
  const provider: any = Object.create(ChatViewProvider.prototype);
  const calls: unknown[][] = [];
  Object.assign(provider, {
    _latestTurnFiles: new Set(["previous-turn.ts"]),
    _diffManager: { openReviewWebview: (...args: unknown[]) => calls.push(args) },
  });
  provider.openReviewWebview("src/main.py", turnFiles);
  return calls[0];
}

it("uses the caller's turn files when given", () => {
  assert.deepEqual(openWith(["src/main.py"]), ["src/main.py", ["src/main.py"]]);
});

it("falls back to the latest turn only when no scope was provided", () => {
  assert.deepEqual(openWith(undefined), ["src/main.py", ["previous-turn.ts"]]);
});

it("does not substitute the latest turn for an explicit null scope", () => {
  assert.deepEqual(openWith(null), ["src/main.py", undefined]);
});
