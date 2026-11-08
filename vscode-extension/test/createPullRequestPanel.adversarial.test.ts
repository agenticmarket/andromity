// Independent adversarial tests for the Changes Review panel's Create pull request wiring.
// Spec: private/design/create-pr/DESIGN.md 2 (button), 3.5 (the receipt belongs to the reviewed turn), 7.2 rule 1.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installVscodeStub, resetState } from "./helpers/prVscodeStub.js";

installVscodeStub();
const { ChangesReviewPanel } = require("../src/panels/ChangesReviewPanel.js") as typeof import("../src/panels/ChangesReviewPanel.js");

function fakePanel(formOpen = true) {
  const panel: any = Object.create(ChangesReviewPanel.prototype);
  const pr = { turnChanged: 0, refreshed: 0, running: false };
  const posts: any[] = [];
  Object.assign(panel, {
    _panel: { reveal() {} },
    _pr: {
      isRunning: () => pr.running, isOpen: () => formOpen, turnChanged: () => { pr.turnChanged++; }, refreshView: () => { pr.refreshed++; },
    },
    _turn: { sessionId: "s1", turnIndex: 2 },
    _turnFiles: ["a.ts"],
    _isGit: true,
    _files: [{ path: "a.ts" }],
    _gitAvailable: true,
    _isDisposed: false,
  });
  panel._postMessage = (m: any) => posts.push(m);
  panel.loadChanges = async () => {};
  panel.selectFile = () => {};
  (ChangesReviewPanel as any).currentPanel = panel;
  return { panel, pr, posts };
}

beforeEach(() => resetState());

describe("panel: the turn behind an open form", () => {
  it("re-showing the panel for another turn reloads the receipt in an open form (a PR must not carry another turn's receipt)", () => {
    const { panel, pr } = fakePanel(true);
    ChangesReviewPanel.createOrShow({} as any, null, undefined, ["b.ts"], { sessionId: "s1", turnIndex: 5 });
    assert.deepEqual(panel._turn, { sessionId: "s1", turnIndex: 5 });
    assert.ok(pr.turnChanged > 0, "the open form kept the old turn's receipt after the panel switched to turn 6");
  });

  it("a running flow keeps its turn when the panel is re-shown", () => {
    const { panel, pr } = fakePanel(true);
    pr.running = true;
    ChangesReviewPanel.createOrShow({} as any, null, undefined, ["b.ts"], { sessionId: "s1", turnIndex: 5 });
    assert.deepEqual(panel._turn, { sessionId: "s1", turnIndex: 2 });
    assert.deepEqual(panel._turnFiles, ["a.ts"]);
  });

  it("turn references from outside are checked", () => {
    const { panel } = fakePanel(true);
    for (const turn of [{ sessionId: "../../x", turnIndex: 1 }, { sessionId: "s".repeat(200), turnIndex: 1 }, { sessionId: 5, turnIndex: 1 }]) {
      ChangesReviewPanel.createOrShow({} as any, null, undefined, ["b.ts"], turn as any);
      assert.equal(panel._turn, null, JSON.stringify(turn));
    }
    ChangesReviewPanel.createOrShow({} as any, null, undefined, ["b.ts"], { sessionId: "ok", turnIndex: -1 });
    assert.deepEqual(panel._turn, { sessionId: "ok", turnIndex: null });
    ChangesReviewPanel.createOrShow({} as any, null, undefined, ["b.ts"], { sessionId: "ok", turnIndex: 1.5 });
    assert.deepEqual(panel._turn, { sessionId: "ok", turnIndex: null });
  });

  it("the turn number from receipt/ready only fills a missing number for the same session", () => {
    const { panel, pr } = fakePanel(true);
    panel._turn = { sessionId: "s1", turnIndex: null };
    panel.updateTurnIndex("other", 3);
    assert.equal(panel._turn.turnIndex, null);
    panel.updateTurnIndex("s1", -1);
    assert.equal(panel._turn.turnIndex, null);
    panel.updateTurnIndex("s1", 3);
    assert.equal(panel._turn.turnIndex, 3);
    assert.equal(pr.turnChanged, 1);
    panel.updateTurnIndex("s1", 9);
    assert.equal(panel._turn.turnIndex, 3, "a later number must not replace the reviewed turn");
  });

  it("a running agent disables the button with the spec's reason (2)", async () => {
    const { posts } = fakePanel(true);
    ChangesReviewPanel.setAgentRunning(true);
    await new Promise((r) => setTimeout(r, 10));
    const button = posts.filter((m) => m.type === "pr_button").at(-1);
    assert.equal(button.state.enabled, false);
    assert.equal(button.state.reason, "Wait for the turn to finish. Files are still changing.");
    ChangesReviewPanel.setAgentRunning(false);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.filter((m) => m.type === "pr_button").at(-1).state.enabled, true);
  });
});
