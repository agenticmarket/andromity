import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_TIPS, initialFeatureTipsState, markTipShown, normalizeFeatureTipsState, pickTip, recordTurn, retireTip,
  tipsUsedBy, wantsMcpCount, type FeatureTipId, type FeatureTipsState, type TurnFacts,
} from "../src/engagement/featureTips.js";
import { featureName, noteFeatureUse, recordFeatureUse, setFeatureUsageClient, setFeatureUsageGate } from "../src/telemetry/featureUsage.js";

let tipsEnabled = true;
const vscodeMock: any = {
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => (tipsEnabled ? fallback : false),
      inspect: () => undefined,
      update: async () => {},
    }),
  },
  extensions: { getExtension: () => undefined },
  commands: { executeCommand: async () => undefined },
  window: { showErrorMessage: async () => undefined },
  ConfigurationTarget: { Global: 1 },
};
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments);
};
const { FeatureTipsController } = require("../src/engagement/featureTipsController.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
Module.prototype.require = originalRequire;

const STATE_KEY = "andromity.featureTips.state";
const NONE: TurnFacts = {
  sessionId: "s1", filesEdited: 0, sourceFilesEdited: 0, testFilesEdited: 0, toolCalls: 0, shellCommands: 0,
  inGitRepo: false, scheduled: false, localModel: false, airGapOn: false, mcpServers: -1,
};
const EDIT: TurnFacts = { ...NONE, filesEdited: 1, sourceFilesEdited: 1, toolCalls: 2 };
const TRIGGERS: Partial<Record<FeatureTipId, TurnFacts>> = {
  fingerprint: { ...NONE, filesEdited: 1 },
  commit_message: { ...NONE, filesEdited: 1, inGitRepo: true },
  inline_edit: { ...NONE, filesEdited: 1, toolCalls: 1 },
  cron_jobs: { ...NONE, toolCalls: 3 },
  generate_tests: { ...NONE, filesEdited: 1, sourceFilesEdited: 1, toolCalls: 6 },
  fix_terminal_error: { ...NONE, toolCalls: 1, shellCommands: 1 },
  air_gap: { ...NONE, localModel: true },
  mcp_servers: { ...NONE, mcpServers: 0 },
};

function trigger(id: FeatureTipId): TurnFacts {
  const facts = TRIGGERS[id];
  assert.ok(facts, `add a trigger for the ${id} tip`);
  return facts;
}

function withSessions(count: number, activeDays = 30): FeatureTipsState {
  let state = initialFeatureTipsState();
  for (let i = 1; i <= count; i++) state = recordTurn(state, `s${i}`, `2026-10-0${i}`);
  return { ...state, activeDays };
}

function onlyTip(state: FeatureTipsState, keep: FeatureTipId): FeatureTipsState {
  return FEATURE_TIPS.reduce((s, tip) => (tip.id === keep ? s : retireTip(s, tip.id)), state);
}

const noonOn = (day: number) => new Date(2026, 9, day, 12, 0, 0).getTime();
const DAY: Record<number, number> = { 1: noonOn(1), 2: noonOn(2), 3: noonOn(3), 4: noonOn(4), 5: noonOn(5) };
const dayKey = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;
const turn = (sessionId: string, extra: Partial<TurnFacts> = {}): TurnFacts => ({ ...EDIT, sessionId, ...extra });

function memento(initial?: unknown, options: { failWrites?: boolean } = {}) {
  const store = new Map<string, unknown>();
  if (initial !== undefined) store.set(STATE_KEY, initial);
  return {
    saved: (): any => store.get(STATE_KEY),
    get: (key: string) => store.get(key),
    update: async (key: string, value: unknown) => {
      if (options.failWrites) throw new Error("storage unavailable");
      store.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

function vscodeMemento() {
  const store = new Map<string, unknown>();
  let failing = false;
  return {
    saved: (): any => store.get(STATE_KEY),
    failSaves: (fail: boolean) => { failing = fail; },
    get: (key: string) => store.get(key),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, JSON.parse(JSON.stringify(value)));
      return failing ? Promise.reject(new Error("disk full")) : Promise.resolve();
    },
  };
}

describe("early fingerprint tip: rules", () => {
  it("shows the fingerprint tip in each of a user's first two sessions after a turn that edited a file", () => {
    assert.equal(pickTip(initialFeatureTipsState(), EDIT, "2026-10-01"), "fingerprint", "before any session is recorded");
    let state = recordTurn(initialFeatureTipsState(), "s1", "2026-10-01");
    assert.equal(pickTip(state, EDIT, "2026-10-01"), "fingerprint", "first session");
    state = recordTurn(state, "s2", "2026-10-02");
    assert.equal(pickTip(state, EDIT, "2026-10-02"), "fingerprint", "second session");
  });

  it("shows nothing in the first sessions after a turn that edited no file", () => {
    const busy: TurnFacts = { ...NONE, toolCalls: 40, shellCommands: 6, inGitRepo: true, localModel: true, mcpServers: 0 };
    for (const sessions of [0, 1, 2]) {
      assert.equal(pickTip(withSessions(sessions), busy, "2026-10-29"), null, `${sessions} session(s) seen`);
    }
    for (const filesEdited of [0, -1, Number.NaN]) {
      assert.equal(pickTip(withSessions(1), { ...EDIT, filesEdited }, "2026-10-29"), null, `filesEdited ${filesEdited}`);
    }
  });

  it("holds every other tip back until the third session, whatever the turn did", () => {
    for (const tip of FEATURE_TIPS) {
      const facts = trigger(tip.id);
      assert.equal(pickTip(onlyTip(withSessions(3), tip.id), facts, "2026-10-29"), tip.id, `${tip.id} applies from the third session`);
      for (const sessions of [0, 1, 2]) {
        assert.equal(
          pickTip(onlyTip(withSessions(sessions), tip.id), facts, "2026-10-29"),
          tip.id === "fingerprint" ? "fingerprint" : null,
          `${tip.id} with ${sessions} session(s) seen`,
        );
      }
    }
  });

  it("counts sessions, not days: one long session or turns without a session id stay in the quiet period", () => {
    let long = initialFeatureTipsState();
    let anonymous = initialFeatureTipsState();
    for (let day = 10; day <= 21; day++) {
      long = recordTurn(long, "only-session", `2026-10-${day}`);
      anonymous = recordTurn(anonymous, "", `2026-10-${day}`);
    }
    assert.deepEqual(long.sessionsSeen, ["only-session"]);
    assert.equal(long.activeDays, 12);
    assert.deepEqual(anonymous.sessionsSeen, []);
    for (const state of [long, anonymous]) {
      for (const tip of FEATURE_TIPS) {
        if (tip.id !== "fingerprint") assert.equal(pickTip(onlyTip(state, tip.id), trigger(tip.id), "2026-10-22"), null, tip.id);
      }
      assert.equal(pickTip(state, EDIT, "2026-10-22"), "fingerprint");
    }
  });

  it("shows the early tip at most once a day and twice in all", () => {
    const gitEdit: TurnFacts = { ...EDIT, inGitRepo: true };
    let state = recordTurn(initialFeatureTipsState(), "s1", "2026-10-01");
    assert.equal(pickTip(state, EDIT, "2026-10-01"), "fingerprint");
    state = markTipShown(state, "fingerprint", "2026-10-01");
    state = recordTurn(state, "s2", "2026-10-01");
    assert.equal(pickTip(state, EDIT, "2026-10-01"), null, "a new session the same day gets no second tip");
    state = recordTurn(state, "s2", "2026-10-02");
    assert.equal(pickTip(state, EDIT, "2026-10-02"), "fingerprint", "it may show once more on a later day");
    state = markTipShown(state, "fingerprint", "2026-10-02");
    state = recordTurn(state, "s2", "2026-10-03");
    assert.equal(pickTip(state, EDIT, "2026-10-03"), null, "never a third time");
    state = recordTurn(state, "s3", "2026-10-04");
    assert.equal(pickTip(state, gitEdit, "2026-10-04"), "commit_message");
    state = markTipShown(state, "commit_message", "2026-10-04");
    for (const day of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]) {
      const tip = pickTip(recordTurn(state, "s3", day), gitEdit, day);
      assert.notEqual(tip, "fingerprint", day);
      if (tip) state = markTipShown(state, tip, day);
    }
  });

  it("counts an early showing when it later prefers the least shown tip", () => {
    let state = markTipShown(recordTurn(initialFeatureTipsState(), "s1", "2026-10-01"), "fingerprint", "2026-10-01");
    state = recordTurn(recordTurn(state, "s2", "2026-10-02"), "s3", "2026-10-03");
    assert.equal(pickTip(state, { ...EDIT, inGitRepo: true }, "2026-10-03"), "commit_message");
  });

  it("keeps the first sessions silent once the fingerprint tip is retired", () => {
    for (const sessions of [0, 1, 2]) {
      const state = retireTip(withSessions(sessions), "fingerprint");
      for (const tip of FEATURE_TIPS) {
        assert.equal(pickTip(state, trigger(tip.id), "2026-10-29"), null, `${tip.id}, ${sessions} session(s) seen`);
      }
    }
  });

  it("never shows the early tip on a scheduled run", () => {
    for (const sessions of [0, 1, 2]) {
      assert.equal(pickTip(withSessions(sessions), { ...EDIT, scheduled: true }, "2026-10-29"), null, `${sessions} session(s) seen`);
    }
  });

  it("is not retired by opening the chat view or by its own shown event", () => {
    assert.deepEqual(tipsUsedBy(featureName("chat_view_opened")), []);
    for (const tip of FEATURE_TIPS) assert.deepEqual(tipsUsedBy(featureName("tip_shown_" + tip.id)), [], tip.id);
  });

  it("reads stored state of any older, partial or broken shape without throwing", () => {
    const everyTip = (record: unknown) => Object.fromEntries(FEATURE_TIPS.map((tip) => [tip.id, record]));
    const polluted = JSON.parse('{"__proto__":{"lastTipDay":"2026-10-29","sessionsSeen":["a","b","c"]},"tips":{"__proto__":{"retired":true}}}');
    const shapes: unknown[] = [
      undefined, null, 0, 7, "", "corrupt", true, [], ["a", "b", "c"], {}, new Date(0), Object.create(null),
      { tips: null }, { tips: "fingerprint" }, { tips: 3 }, { tips: [] }, { tips: [{ shown: 2, retired: true }] },
      { tips: everyTip(null) }, { tips: everyTip("x") }, { tips: everyTip(2) }, { tips: everyTip([]) }, { tips: everyTip({}) },
      { tips: everyTip({ shown: "2", retired: "true" }) }, { tips: everyTip({ shown: -4, retired: 1 }) }, { tips: everyTip({ shown: 1.5 }) },
      { sessionsSeen: "s1" }, { sessionsSeen: null }, { sessionsSeen: { 0: "a", length: 1 } },
      { sessionsSeen: [null, 3, {}, "", ["s"], "a"] }, { sessionsSeen: ["a", "b", "c", "d", "e", "f"] },
      { activeDays: "9", lastActiveDay: 20261001, lastTipDay: { day: "2026-10-29" } },
      { activeDays: Number.NaN, lastActiveDay: null, lastTipDay: undefined }, { activeDays: Number.POSITIVE_INFINITY }, { activeDays: -3 },
      polluted,
    ];
    for (const raw of shapes) {
      const label = (() => { try { return JSON.stringify(raw) ?? String(raw); } catch { return String(raw); } })();
      let state = initialFeatureTipsState();
      assert.doesNotThrow(() => { state = normalizeFeatureTipsState(raw); }, label);
      for (const tip of FEATURE_TIPS) {
        const record = state.tips[tip.id];
        assert.ok(Number.isInteger(record.shown) && record.shown >= 0, `${label}: ${tip.id}.shown`);
        assert.equal(typeof record.retired, "boolean", `${label}: ${tip.id}.retired`);
      }
      assert.ok(state.sessionsSeen.every((s) => typeof s === "string" && s.length > 0), label);
      assert.ok(Number.isInteger(state.activeDays) && state.activeDays >= 0, label);
      assert.equal(typeof state.lastTipDay, "string", label);
      assert.doesNotThrow(() => {
        const next = recordTurn(state, "new-session", "2026-10-29");
        pickTip(next, EDIT, "2026-10-29");
        wantsMcpCount(next, "2026-10-29");
      }, label);
    }
    const fromPolluted = normalizeFeatureTipsState(polluted);
    assert.equal(fromPolluted.lastTipDay, "");
    assert.deepEqual(fromPolluted.sessionsSeen, []);
    assert.equal(pickTip(recordTurn(fromPolluted, "a", "2026-10-29"), EDIT, "2026-10-29"), "fingerprint");
    assert.equal(({} as any).lastTipDay, undefined, "a stored key never reaches Object.prototype");
  });

  it("picks up where the previous release left off", () => {
    const records = (shown: number, retired = false) => Object.fromEntries(FEATURE_TIPS.map((tip) => [tip.id, { shown, retired }]));
    const midQuiet = { sessionsSeen: ["a", "b"], activeDays: 2, lastActiveDay: "2026-10-27", lastTipDay: "", tips: records(0) };
    const resumed = recordTurn(normalizeFeatureTipsState(JSON.parse(JSON.stringify(midQuiet))), "b", "2026-10-29");
    assert.equal(pickTip(resumed, EDIT, "2026-10-29"), "fingerprint", "a user still in their second session now gets the tip");
    assert.equal(pickTip(resumed, { ...EDIT, filesEdited: 0, shellCommands: 2 }, "2026-10-29"), null);
    const tippedToday = recordTurn(normalizeFeatureTipsState({ ...midQuiet, lastTipDay: "2026-10-29" }), "b", "2026-10-29");
    assert.equal(pickTip(tippedToday, EDIT, "2026-10-29"), null);
    const veteran = {
      sessionsSeen: ["a", "b", "c"], activeDays: 40, lastActiveDay: "2026-10-27", lastTipDay: "2026-10-27",
      tips: { ...records(0), fingerprint: { shown: 2, retired: false }, commit_message: { shown: 1, retired: true } },
    };
    const next = recordTurn(normalizeFeatureTipsState(veteran), "d", "2026-10-29");
    assert.equal(pickTip(next, { ...EDIT, inGitRepo: true, toolCalls: 9 }, "2026-10-29"), "generate_tests");
    const quitter = { ...veteran, tips: records(0, true) };
    assert.equal(pickTip(recordTurn(normalizeFeatureTipsState(quitter), "d", "2026-10-29"), EDIT, "2026-10-29"), null);
  });
});

describe("early fingerprint tip: controller", () => {
  it("shows the tip on a brand-new user's first editing turn, saves it and reports it", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
    const sent: any[] = [];
    setFeatureUsageGate(() => true);
    setFeatureUsageClient({ call: async (method: string, params?: unknown): Promise<any> => { sent.push({ method, params }); return {}; } });
    const store = memento();
    const tips = new FeatureTipsController(store);
    try {
      assert.equal(await tips.onTurnFinished(turn("first")), "fingerprint");
      assert.deepEqual(store.saved().sessionsSeen, ["first"]);
      assert.equal(store.saved().tips.fingerprint.shown, 1);
      assert.equal(store.saved().lastTipDay, dayKey(1));
      assert.deepEqual(sent, [{ method: "telemetry.recordFeature", params: { feature: "tip_shown_fingerprint", session_id: "first" } }]);
    } finally {
      setFeatureUsageClient(null);
      tips.dispose();
    }
  });

  it("waits for an editing turn without spending the day's tip", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
    const store = memento();
    const tips = new FeatureTipsController(store);
    try {
      const noEdit = turn("a", { filesEdited: 0, sourceFilesEdited: 0, toolCalls: 12, shellCommands: 3, inGitRepo: true });
      assert.equal(await tips.onTurnFinished(noEdit), null);
      assert.deepEqual(store.saved().sessionsSeen, ["a"]);
      assert.equal(store.saved().lastTipDay, "");
      assert.equal(await tips.onTurnFinished(turn("a")), "fingerprint");
    } finally {
      tips.dispose();
    }
  });

  it("shows one tip when several first-day turns finish at once", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
    const store = memento();
    const tips = new FeatureTipsController(store);
    try {
      const results = await Promise.all(["a", "b", "a", "c"].map((sessionId) => tips.onTurnFinished(turn(sessionId))));
      assert.deepEqual(results.filter(Boolean), ["fingerprint"]);
      assert.equal(store.saved().tips.fingerprint.shown, 1);
    } finally {
      tips.dispose();
    }
  });

  it("shows the early tip again on a later day but never a third time, across restarts", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
    const store = memento();
    let tips = new FeatureTipsController(store);
    try {
      assert.equal(await tips.onTurnFinished(turn("a")), "fingerprint");
      assert.equal(await tips.onTurnFinished(turn("b")), null, "one tip a day");
      tips.dispose();
      tips = new FeatureTipsController(store);
      t.mock.timers.setTime(DAY[2]);
      assert.equal(await tips.onTurnFinished(turn("b")), "fingerprint", "second showing");
      t.mock.timers.setTime(DAY[3]);
      assert.equal(await tips.onTurnFinished(turn("b")), null, "two showings at most, and other tips still wait");
      t.mock.timers.setTime(DAY[4]);
      assert.equal(await tips.onTurnFinished(turn("c", { inGitRepo: true })), "commit_message", "the third session opens the other tips");
      t.mock.timers.setTime(DAY[5]);
      assert.notEqual(await tips.onTurnFinished(turn("c", { inGitRepo: true })), "fingerprint");
      assert.equal(store.saved().tips.fingerprint.shown, 2);
    } finally {
      tips.dispose();
    }
  });

  for (const action of ["acted", "hide"] as const) {
    it(`retires the early tip for good when it is ${action === "acted" ? "clicked" : "hidden"}`, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
      const store = memento();
      const tips = new FeatureTipsController(store);
      try {
        assert.equal(await tips.onTurnFinished(turn("a")), "fingerprint");
        await tips[action]("fingerprint");
        t.mock.timers.setTime(DAY[2]);
        assert.equal(await tips.onTurnFinished(turn("b")), null);
        t.mock.timers.setTime(DAY[3]);
        assert.notEqual(await tips.onTurnFinished(turn("c")), "fingerprint");
        assert.equal(store.saved().tips.fingerprint.retired, true);
      } finally {
        tips.dispose();
      }
    });
  }

  it("retires the early tip before it shows when Fingerprint is used another way, telemetry off", async () => {
    const uses: Array<[string, () => void]> = [
      ["panel opened", () => noteFeatureUse("fingerprint")],
      ["command run", () => recordFeatureUse("cmd_" + "andromity.openFingerprint".replace(/^andromity\./, ""))],
      ["webview event", () => recordFeatureUse("fingerprint", { sessionId: "a", oncePerSession: true })],
    ];
    setFeatureUsageGate(() => false);
    try {
      for (const [label, use] of uses) {
        const store = memento();
        const tips = new FeatureTipsController(store);
        try {
          use();
          assert.equal(await tips.onTurnFinished(turn("a")), null, label);
          assert.equal(store.saved().tips.fingerprint.retired, true, label);
        } finally {
          tips.dispose();
        }
      }
    } finally {
      setFeatureUsageGate(() => true);
    }
  });

  it("never tips on a scheduled run, and the run does not use up the day's tip", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
    const store = memento();
    const tips = new FeatureTipsController(store);
    try {
      assert.equal(await tips.onTurnFinished(turn("cron", { scheduled: true })), null);
      assert.equal(store.saved().lastTipDay, "");
      assert.equal(store.saved().tips.fingerprint.shown, 0);
      assert.equal(await tips.onTurnFinished(turn("a")), "fingerprint");
    } finally {
      tips.dispose();
    }
  });

  it("shows nothing in the first sessions while tips are turned off", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
    const store = memento();
    const tips = new FeatureTipsController(store);
    tipsEnabled = false;
    try {
      assert.equal(await tips.onTurnFinished(turn("a")), null);
      assert.equal(await tips.onTurnFinished(turn("b")), null);
      assert.equal(store.saved().tips.fingerprint.shown, 0);
      assert.equal(store.saved().lastTipDay, "");
    } finally {
      tipsEnabled = true;
      tips.dispose();
    }
  });

  it("shows at most one tip a day even when saving tip state fails", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
    const tips = new FeatureTipsController(memento(undefined, { failWrites: true }));
    try {
      const shown: Array<FeatureTipId | null> = [];
      for (const sessionId of ["a", "a", "b", "b"]) shown.push(await tips.onTurnFinished(turn(sessionId)));
      assert.ok(shown.filter(Boolean).length <= 1, `tips shown on one day: ${JSON.stringify(shown)}`);
    } finally {
      tips.dispose();
    }
  });

  it("does not count a showing whose save failed, so a later save carries no phantom showing", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: DAY[1] });
    const sent: string[] = [];
    setFeatureUsageGate(() => true);
    setFeatureUsageClient({ call: async (_method: string, params?: any): Promise<any> => { sent.push(params?.feature); return {}; } });
    const store = vscodeMemento();
    const tips = new FeatureTipsController(store);
    try {
      store.failSaves(true);
      assert.equal(await tips.onTurnFinished(turn("a")), null, "a showing that could not be saved is not shown");
      const rolledBack = normalizeFeatureTipsState(store.saved());
      assert.equal(rolledBack.tips.fingerprint.shown, 0, "the in-memory value is rolled back");
      assert.equal(rolledBack.lastTipDay, "", "the day's tip is not used up");
      assert.deepEqual(sent, [], "no tip_shown event for a tip that was not shown");

      store.failSaves(false);
      assert.equal(await tips.onTurnFinished(turn("a")), "fingerprint");
      assert.equal(store.saved().tips.fingerprint.shown, 1);
      assert.equal(store.saved().lastTipDay, dayKey(1));

      t.mock.timers.setTime(DAY[2]);
      store.failSaves(true);
      assert.equal(await tips.onTurnFinished(turn("b")), null);
      assert.equal(store.saved().tips.fingerprint.shown, 1, "no phantom second showing");
      assert.equal(store.saved().lastTipDay, dayKey(1));

      store.failSaves(false);
      assert.equal(await tips.onTurnFinished(turn("b")), "fingerprint", "the second showing is still available");
      assert.equal(store.saved().tips.fingerprint.shown, 2);
      t.mock.timers.setTime(DAY[3]);
      assert.equal(await tips.onTurnFinished(turn("b")), null, "and there is no third");
      assert.deepEqual(sent, ["tip_shown_fingerprint", "tip_shown_fingerprint"]);
    } finally {
      setFeatureUsageClient(null);
      tips.dispose();
    }
  });

  it("starts from broken stored state without throwing", async () => {
    for (const raw of [null, "corrupt", 5, [], { tips: null, sessionsSeen: "a" }, { tips: { fingerprint: "x" } }, { lastTipDay: 20261029 }]) {
      const tips = new FeatureTipsController(memento(raw));
      try {
        assert.doesNotThrow(() => tips.wantsMcpCount(), JSON.stringify(raw));
        assert.equal(await tips.onTurnFinished(turn("a")), "fingerprint", JSON.stringify(raw));
      } finally {
        tips.dispose();
      }
    }
  });
});

describe("early fingerprint tip: chat view", () => {
  function chat() {
    const posted: any[] = [];
    const provider: any = Object.create(ChatViewProvider.prototype);
    Object.assign(provider, {
      _featureTips: new FeatureTipsController(memento()),
      _currentSessionId: "s1",
      _currentProvider: "",
      _rpcClient: { call: async () => ({}), on() {}, off() {} },
      _pythonBridge: null,
      _hydration: { capture: () => false },
      _view: { visible: true, webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } },
    });
    return {
      finish: (message: Record<string, unknown>): Promise<void> => provider._handleWebviewMessage({
        type: "turn_finished", sessionId: "s1", toolCalls: 2, shellCommands: 0, scheduled: false, ...message,
      }),
      tipsPosted: () => posted.filter((message) => message.type === "feature_tip"),
      dispose: () => provider._featureTips.dispose(),
    };
  }

  it("posts the fingerprint tip after a new user's first turn that really edited a file", async () => {
    const view = chat();
    try {
      await view.finish({ editedFiles: ["", null, 7, { path: "src/a.ts" }, ["src/b.ts"]] });
      await view.finish({ editedFiles: "src/a.ts" });
      await view.finish({ editedFiles: ["src/a.ts"], scheduled: true });
      assert.deepEqual(view.tipsPosted(), [], "no real edited file, or a scheduled run");
      await view.finish({ editedFiles: ["docs/notes.md"] });
      assert.deepEqual(view.tipsPosted(), [{ type: "feature_tip", session_id: "s1", tip: "fingerprint", file: "" }]);
    } finally {
      view.dispose();
    }
  });
});
