import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Module from "node:module";

let airGapOn = false;
const opened: string[] = [];
const toasts: string[] = [];
const mockVscode = {
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => (key === "airGap.enabled" ? { globalValue: airGapOn } : undefined),
      get: (_key: string, fallback: unknown) => fallback,
    }),
  },
  window: { showInformationMessage: async (message: string) => { toasts.push(message); return undefined; } },
  env: { uriScheme: "vscode", openExternal: async (uri: { url: string }) => { opened.push(uri.url); return true; } },
  Uri: { parse: (url: string) => ({ url }) },
  ProgressLocation: { Notification: 15 },
};
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (id, ...args) {
  return id === "vscode" ? mockVscode : originalLoad.call(this, id, ...args);
};
const { FeedbackNotifications } = require("../src/engagement/feedbackNotifications.js");
const { ANNOYANCES, cleanCheckIn } = require("../src/engagement/checkIn.js");
const { initialEngagementState, MARKETPLACE_REVIEW_URL } = require("../src/engagement/feedbackPrompt.js");
const { onFeatureUse } = require("../src/telemetry/featureUsage.js");
loader._load = originalLoad;

function context(state: unknown) {
  const store = new Map<string, unknown>([["andromity.engagement", state]]);
  return {
    store,
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => { store.set(key, value); },
      setKeysForSync: () => {},
    },
    extension: { packageJSON: { version: "0.2.25" } },
  };
}

/** Experienced enough that the feedback ask is due today. */
function dueState() {
  return { ...initialEngagementState(), activeDays: 5, completedTurns: 30, lastActiveDay: "2000-01-01" };
}

const features: string[] = [];
onFeatureUse((feature: string) => features.push(feature));

beforeEach(() => {
  airGapOn = false;
  opened.length = 0;
  toasts.length = 0;
  features.length = 0;
});

describe("when the check-in appears", () => {
  it("shows in the chat after a turn that went well, once, and never as a toast", async () => {
    const ctx = context(dueState());
    const notifications = new FeedbackNotifications(ctx);
    let shown = 0;
    notifications.setCheckInPresenter(() => { shown++; return true; });
    await notifications.onTurnCompleted({ outcome: "success" });
    assert.equal(shown, 1);
    assert.deepEqual(toasts, []);
    assert.equal((ctx.store.get("andromity.engagement") as any).feedback.asks, 1);
    await notifications.onTurnCompleted({ outcome: "success" });
    assert.equal(shown, 1, "at most one ask a day");
  });

  it("stays away after errors, scheduled runs, in air-gap mode, or when the chat is hidden", async () => {
    for (const [done, airGap, visible] of [
      [{ outcome: "error" }, false, true],
      [{ outcome: "success", scheduled: true }, false, true],
      [{ outcome: "success" }, true, true],
      [{ outcome: "success" }, false, false],
    ] as const) {
      airGapOn = airGap;
      const ctx = context(dueState());
      const notifications = new FeedbackNotifications(ctx);
      let shown = 0;
      notifications.setCheckInPresenter(() => { if (visible) shown++; return visible; });
      await notifications.onTurnCompleted(done);
      assert.equal((ctx.store.get("andromity.engagement") as any).feedback.asks, 0, JSON.stringify({ done, airGap, visible }));
      assert.equal(shown, visible && !airGap && done.outcome === "success" && !("scheduled" in done) ? 1 : 0);
      assert.deepEqual(toasts, []);
    }
  });

  it("does not ask people who are new or who said not to", async () => {
    const fresh = new FeedbackNotifications(context(initialEngagementState()));
    let shown = 0;
    fresh.setCheckInPresenter(() => { shown++; return true; });
    await fresh.onTurnCompleted({ outcome: "success" });
    const declined = new FeedbackNotifications(context({ ...dueState(), feedback: { status: "never", asks: 1, nextAtActiveDay: 0 } }));
    declined.setCheckInPresenter(() => { shown++; return true; });
    await declined.onTurnCompleted({ outcome: "success" });
    assert.equal(shown, 0);
  });
});

describe("answering the check-in", () => {
  it("sends the sentiment and choices with the note, and retires the ask", async () => {
    const ctx = context(dueState());
    const notifications = new FeedbackNotifications(ctx);
    const sent: any[] = [];
    const reply = await notifications.sendCheckIn(
      { sentiment: "bad", annoyances: ["errors_limits", "slow", "made_up", "slow"], message: "  limits by noon  " },
      async (payload: unknown) => { sent.push(payload); return true; },
    );
    assert.deepEqual(reply, { type: "checkin_result", ok: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sentiment, "bad");
    assert.deepEqual(sent[0].annoyances, ["slow", "errors_limits"]);
    assert.equal(sent[0].message, "limits by noon");
    assert.equal(sent[0].client, "vscode");
    assert.equal(sent[0].version, "0.2.25");
    assert.equal((ctx.store.get("andromity.engagement") as any).feedback.status, "done");
  });

  it("keeps the answer out of usage telemetry so it stays unlinked", async () => {
    const notifications = new FeedbackNotifications(context(dueState()));
    await notifications.sendCheckIn({ sentiment: "love" }, async () => true);
    assert.deepEqual(features, ["feedback_checkin_sent"]);
    assert.ok(!features.some((f) => /love|bad|ok|slow|limits/.test(f)));
  });

  it("refuses answers it can't trust and keeps the ask open when delivery fails", async () => {
    const ctx = context(dueState());
    const notifications = new FeedbackNotifications(ctx);
    let calls = 0;
    const submit = async () => { calls++; return false; };
    for (const bad of [{}, { sentiment: "great" }, { sentiment: ["love"] }, { sentiment: "ok", message: "x".repeat(2001) }]) {
      const reply = await notifications.sendCheckIn(bad, submit);
      assert.equal(reply.ok, false, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(calls, 0);
    const failed = await notifications.sendCheckIn({ sentiment: "ok" }, submit);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /couldn't be sent/);
    assert.equal((ctx.store.get("andromity.engagement") as any).feedback.status, "pending");
    airGapOn = true;
    const offline = await notifications.sendCheckIn({ sentiment: "ok" }, async () => { calls++; return true; });
    assert.equal(offline.ok, false);
    assert.equal(calls, 1, "air-gap mode sends nothing");
  });

  it("remembers 'don't ask again' and opens the review page for everyone who asks", async () => {
    const ctx = context(dueState());
    const notifications = new FeedbackNotifications(ctx);
    await notifications.dismissCheckIn(false);
    assert.equal((ctx.store.get("andromity.engagement") as any).feedback.status, "pending");
    await notifications.dismissCheckIn(true);
    assert.equal((ctx.store.get("andromity.engagement") as any).feedback.status, "never");
    await notifications.reviewFromCheckIn();
    assert.deepEqual(opened, [MARKETPLACE_REVIEW_URL]);
  });
});

describe("check-in choices", () => {
  it("match the ids the feedback worker accepts", () => {
    const worker = readFileSync(join(__dirname, "..", "..", "..", "telemetry-worker", "feedback.js"), "utf8");
    const listed = /export const ANNOYANCES = \[([^\]]+)\]/.exec(worker)?.[1] ?? "";
    const workerIds = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(ANNOYANCES.map((a: { id: string }) => a.id), workerIds);
  });

  it("cleanCheckIn trims, dedupes and orders choices", () => {
    assert.deepEqual(cleanCheckIn({ sentiment: "ok", annoyances: ["missing_feature", "slow", "slow"], message: " hi " }),
      { answer: { sentiment: "ok", annoyances: ["slow", "missing_feature"], message: "hi" } });
    assert.deepEqual(cleanCheckIn({ sentiment: "love", annoyances: "slow" }), { answer: { sentiment: "love", annoyances: [], message: "" } });
    assert.ok("error" in cleanCheckIn(null));
  });
});
