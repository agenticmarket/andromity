import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") {
    return { workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } };
  }
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
Module.prototype.require = originalRequire;

const script: string = getChatClientScript("icon.svg", {
  currentSessionId: "s1", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
}).replace(/\r\n/g, "\n");

class Wrap {
  previousElementSibling: Wrap | null = null;
  constructor(readonly kind: "prompt" | "steering" | "answer" | "card", readonly name: string) {}
  matches(selector: string) {
    return selector === ".message-wrap.user:not([data-steering])" && this.kind === "prompt";
  }
}

function chatOf(kinds: Array<[Wrap["kind"], string]>) {
  const wraps = kinds.map(([kind, name]) => new Wrap(kind, name));
  wraps.forEach((wrap, i) => { wrap.previousElementSibling = wraps[i - 1] || null; });
  const container = {
    querySelectorAll: (selector: string) => wraps.filter((wrap) => wrap.matches(selector)),
  };
  const start = script.indexOf("function undoRequestFor(wrap)");
  const end = script.indexOf("\n    }\n", start) + 6;
  assert.ok(start > -1 && end > start, "undoRequestFor must exist");
  const sandbox: any = { chatContainer: container, Array };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(start, end), sandbox);
  const byName = (name: string) => wraps.find((wrap) => wrap.name === name) || null;
  return { request: (name: string | null) => sandbox.undoRequestFor(name === null ? null : byName(name)) };
}

describe("undo counts turns the way the engine does", () => {
  it("does not count a message sent while a turn was running as a turn", () => {
    const { request } = chatOf([
      ["prompt", "t0"], ["steering", "s0"], ["answer", "a0"],
      ["prompt", "t1"], ["answer", "a1"],
      ["prompt", "t2"], ["answer", "a2"],
    ]);
    assert.deepEqual({ ...request("t1") }, { turnIndex: 1, totalTurns: 3, turnsToUndo: 2 });
    assert.deepEqual({ ...request("t2") }, { turnIndex: 2, totalTurns: 3, turnsToUndo: 1 });
    assert.deepEqual({ ...request("s0") }, { turnIndex: 0, totalTurns: 3, turnsToUndo: 3 }, "undoing it undoes its turn");
  });

  it("counts from the newest prompt, so prompts kept from before a compaction don't shift it", () => {
    const { request } = chatOf([
      ["prompt", "old0"], ["answer", "a0"], ["prompt", "old1"], ["answer", "a1"],
      ["card", "summary"],
      ["prompt", "t2"], ["answer", "a2"], ["prompt", "t3"], ["answer", "a3"],
    ]);
    assert.equal(request("t3").turnsToUndo, 1);
    assert.equal(request("t2").turnsToUndo, 2);
    assert.equal(request("old0").turnsToUndo, 4, "the engine refuses turns it summarized");
  });

  it("asks for the last turn when there is no prompt to anchor on", () => {
    const { request } = chatOf([["answer", "a"]]);
    assert.deepEqual({ ...request(null) }, { turnIndex: undefined, totalTurns: 0, turnsToUndo: 1 });
  });

  it("is what both Undo to here and Edit and resend send", () => {
    assert.match(script, /case 'undo-turn': \{\s*vscode\.postMessage\(Object\.assign\(\{ type: 'undo_turn' \}, undoRequestFor\(target\.closest\('\.message-wrap\.user'\)\)\)\);/);
    assert.match(script, /const request = undoRequestFor\(wrap\);\s*if \(request\.turnIndex === undefined\) return;\s*vscode\.postMessage\(Object\.assign\(\{ type: 'undo_turn', resendPrompt: text \}, request\)\);/);
  });
});
