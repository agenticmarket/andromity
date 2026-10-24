import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_TIPS, MAX_SHOWS_PER_TIP, initialFeatureTipsState, isFeatureTipId, isSourcePath, isTestPath, markTipShown,
  normalizeFeatureTipsState, pickTip, recordTurn, retireTip, tipsUsedBy, wantsMcpCount, type FeatureTipId, type FeatureTipsState, type TurnFacts,
} from "../src/engagement/featureTips.js";
import { featureName } from "../src/telemetry/featureUsage.js";

const quiet: TurnFacts = {
  sessionId: "s3", filesEdited: 0, sourceFilesEdited: 0, testFilesEdited: 0, toolCalls: 0, shellCommands: 0,
  inGitRepo: false, scheduled: false, localModel: false, airGapOn: false, mcpServers: -1,
};
const edit: TurnFacts = { ...quiet, filesEdited: 4, sourceFilesEdited: 3, testFilesEdited: 1, toolCalls: 9, inGitRepo: true };
const smallEdit: TurnFacts = { ...edit, filesEdited: 1, toolCalls: 2 };
const report: TurnFacts = { ...edit, filesEdited: 0, toolCalls: 5 };

function seasoned(days = 1): FeatureTipsState {
  let state = initialFeatureTipsState();
  state = recordTurn(state, "s1", "2026-10-01");
  state = recordTurn(state, "s2", "2026-10-02");
  state = recordTurn(state, "s3", "2026-10-03");
  return { ...state, activeDays: days };
}

describe("feature tips", () => {
  it("stays quiet during a user's first two sessions", () => {
    let state = initialFeatureTipsState();
    state = recordTurn(state, "s1", "2026-10-01");
    assert.equal(pickTip(state, edit, "2026-10-01"), null);
    state = recordTurn(state, "s2", "2026-10-02");
    assert.equal(pickTip(state, edit, "2026-10-02"), null);
    state = recordTurn(state, "s3", "2026-10-03");
    assert.equal(pickTip(state, edit, "2026-10-03"), "fingerprint");
  });

  it("matches the tip to what the turn did", () => {
    assert.equal(pickTip(seasoned(), edit, "d"), "fingerprint");
    assert.equal(pickTip(seasoned(), { ...edit, filesEdited: 0, toolCalls: 0 }, "d"), null);
    assert.equal(pickTip(seasoned(1), report, "d"), null, "cron waits for a few active days");
    assert.equal(pickTip(seasoned(3), report, "d"), "cron_jobs");
    const known = retireTip(retireTip(seasoned(), "fingerprint"), "commit_message");
    assert.equal(pickTip(known, edit, "d"), null, "a large edit is not an inline-edit moment");
    assert.equal(pickTip(known, smallEdit, "d"), "inline_edit");
    assert.equal(pickTip(retireTip(seasoned(), "fingerprint"), { ...edit, inGitRepo: false }, "d"), null);
  });

  it("shows at most one tip a day and rotates to the least shown one", () => {
    const today = "2026-10-05";
    const first = markTipShown(seasoned(), "fingerprint", today);
    assert.equal(pickTip(first, edit, today), null);
    assert.equal(pickTip(first, edit, "2026-10-06"), "commit_message");
  });

  it("retires a tip after two showings or once dismissed", () => {
    let state = seasoned();
    for (let i = 0; i < MAX_SHOWS_PER_TIP; i++) state = markTipShown(state, "fingerprint", "day" + i);
    assert.notEqual(pickTip(state, edit, "later"), "fingerprint");
    assert.notEqual(pickTip(retireTip(seasoned(), "fingerprint"), edit, "later"), "fingerprint");
  });

  it("suggests tests only when code changed without them", () => {
    const only = (state: FeatureTipsState, keep: FeatureTipId) =>
      FEATURE_TIPS.reduce((s, tip) => (tip.id === keep ? s : retireTip(s, tip.id)), state);
    const state = only(seasoned(), "generate_tests");
    assert.equal(pickTip(state, { ...edit, testFilesEdited: 0 }, "d"), "generate_tests");
    assert.equal(pickTip(state, edit, "d"), null, "the turn already touched tests");
    assert.equal(pickTip(state, { ...edit, sourceFilesEdited: 0, testFilesEdited: 0 }, "d"), null, "docs or config only");
  });

  it("matches the terminal, air-gap and MCP tips to the turn", () => {
    const only = (keep: FeatureTipId, days = 1) =>
      FEATURE_TIPS.reduce((s, tip) => (tip.id === keep ? s : retireTip(s, tip.id)), seasoned(days));
    assert.equal(pickTip(only("fix_terminal_error"), { ...quiet, toolCalls: 2, shellCommands: 1 }, "d"), "fix_terminal_error");
    assert.equal(pickTip(only("fix_terminal_error"), { ...quiet, toolCalls: 2 }, "d"), null);
    assert.equal(pickTip(only("air_gap"), { ...quiet, localModel: true }, "d"), "air_gap");
    assert.equal(pickTip(only("air_gap"), { ...quiet, localModel: true, airGapOn: true }, "d"), null, "already on");
    assert.equal(pickTip(only("air_gap"), quiet, "d"), null, "cloud model");
    assert.equal(pickTip(only("mcp_servers", 5), { ...quiet, mcpServers: 0 }, "d"), "mcp_servers");
    assert.equal(pickTip(only("mcp_servers", 4), { ...quiet, mcpServers: 0 }, "d"), null, "waits for regular use");
    assert.equal(pickTip(only("mcp_servers", 5), { ...quiet, mcpServers: 2 }, "d"), null, "already has servers");
    assert.equal(pickTip(only("mcp_servers", 5), quiet, "d"), null, "unknown count");
  });

  it("only asks for the MCP server count when that tip could show", () => {
    assert.equal(wantsMcpCount(seasoned(5), "d"), true);
    assert.equal(wantsMcpCount(seasoned(4), "d"), false);
    assert.equal(wantsMcpCount(markTipShown(seasoned(5), "fingerprint", "d"), "d"), false, "today's tip is used up");
    assert.equal(wantsMcpCount(retireTip(seasoned(5), "mcp_servers"), "d"), false);
  });

  it("tells test files from source files", () => {
    for (const test of ["src/__tests__/a.ts", "tests/test_api.py", "pkg/limiter_test.go", "web/app.spec.tsx", "test\\unit\\x.js", "lib/user.test.ts"]) {
      assert.ok(isTestPath(test) && !isSourcePath(test), test);
    }
    for (const source of ["src/limiter.ts", "app/models/user.rb", "cmd\\main.go", "contest.py"]) {
      assert.ok(isSourcePath(source) && !isTestPath(source), source);
    }
    for (const other of ["README.md", "package.json", ".env", "styles.css"]) assert.ok(!isSourcePath(other), other);
  });

  it("never interrupts a scheduled run", () => {
    assert.equal(pickTip(seasoned(5), { ...edit, scheduled: true }, "d"), null);
  });

  it("maps recorded feature names to the tips they retire", () => {
    for (const tip of FEATURE_TIPS) {
      for (const name of tip.usedBy) assert.equal(featureName(name), name, name + " must survive featureName()");
    }
    assert.deepEqual(tipsUsedBy(featureName("cmd_" + "andromity.openFingerprint".replace(/^andromity\./, ""))), ["fingerprint"]);
    assert.deepEqual(tipsUsedBy(featureName("cmd_generateCommitMessage")), ["commit_message"]);
    assert.deepEqual(tipsUsedBy("inline_edit"), ["inline_edit"]);
    assert.deepEqual(tipsUsedBy("cron_created"), ["cron_jobs"]);
    assert.deepEqual(tipsUsedBy(featureName("cmd_generateTests")), ["generate_tests"]);
    assert.deepEqual(tipsUsedBy(featureName("cmd_fixTerminalError")), ["fix_terminal_error"]);
    assert.deepEqual(tipsUsedBy(featureName("cmd_toggleAirGap")), ["air_gap"]);
    assert.deepEqual(tipsUsedBy("mcp_added"), ["mcp_servers"]);
    assert.deepEqual(tipsUsedBy("settings_opened"), []);
  });

  it("reads partial or broken stored state without throwing", () => {
    assert.deepEqual(normalizeFeatureTipsState(null), initialFeatureTipsState());
    const state = normalizeFeatureTipsState({ tips: { fingerprint: { shown: 1, retired: true } }, sessionsSeen: ["a", 3, "b"], activeDays: -2 });
    assert.equal(state.tips.fingerprint.retired, true);
    assert.equal(state.tips.cron_jobs.shown, 0);
    assert.deepEqual(state.sessionsSeen, ["a", "b"]);
    assert.equal(state.activeDays, 0);
    assert.ok(isFeatureTipId("cron_jobs") && !isFeatureTipId("waterfall"));
  });
});
