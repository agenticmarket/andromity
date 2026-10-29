import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Module from "node:module";

const MACHINE_ID = "machine-id-8f14e45fceea167a";
const VSCODE_SESSION = "vscode-session-6512bd43d9caa6e0";
let airGap: Record<string, unknown> | undefined;
const toasts: string[] = [];
const mockVscode = {
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => (key === "airGap.enabled" ? airGap : undefined),
      get: (_key: string, fallback: unknown) => fallback,
    }),
  },
  window: { showInformationMessage: async (message: string) => { toasts.push(message); return undefined; } },
  env: { machineId: MACHINE_ID, sessionId: VSCODE_SESSION, uriScheme: "vscode" },
  Uri: { parse: (url: string) => ({ url }) },
};
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (id, ...args) {
  return id === "vscode" ? mockVscode : originalLoad.call(this, id, ...args);
};
const { WaitlistController } = require("../src/engagement/waitlistController.js");
const {
  MAX_HEARD_NOTE, MAX_WANTS_NOTE, WAITLIST_ENDPOINT, WAITLIST_HEARD_FROM, WAITLIST_WANTS,
  cleanWaitlistAnswer, submitWaitlist, waitlistPayload,
} = require("../src/engagement/waitlist.js");
const { airGapOffMessage } = require("../src/airgap.js");
const { onFeatureUse, setFeatureUsageClient, setFeatureUsageGate } = require("../src/telemetry/featureUsage.js");
const { osFamily } = require("../src/engagement/feedbackSubmit.js");
loader._load = originalLoad;

const JOINED_KEY = "andromity.waitlistJoined";
const ANSWER = { wants: ["faster", "higher_limit"], wants_note: "  more turns\r\nplease ", heard_from: "reddit", heard_note: " r/vscode " };
const EXPECTED_PAYLOAD = {
  wants: ["higher_limit", "faster"], wants_note: "more turns\nplease", heard_from: "reddit", heard_note: "r/vscode",
  client: "vscode", os: osFamily(process.platform), version: "0.2.25",
};
const AIR_GAP_ERROR = airGapOffMessage("joining the waitlist");
const OFFERED_KEY = "andromity.waitlistOffered";

function context(initial: Record<string, unknown> = {}, options: { failUpdate?: boolean } = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        if (options.failUpdate) throw new Error("globalState is read-only");
        store.set(key, value);
      },
      keys: () => [...store.keys()],
      setKeysForSync: () => {},
    },
    extension: { packageJSON: { version: "0.2.25" } },
  };
}

const features: string[] = [];
onFeatureUse((feature: string) => features.push(feature));
const rpc: { method: string; params: Record<string, unknown> }[] = [];
setFeatureUsageClient({ call: async (method: string, params: Record<string, unknown>) => { rpc.push({ method, params }); return {}; } });
setFeatureUsageGate(() => true);
const sentEvents = (name?: string) => rpc.filter((c) => c.method === "telemetry.recordFeature" && (!name || c.params.feature === name));

function stubFetch(respond: (url: string, init: any) => Promise<Response> | Response) {
  const calls: { url: string; init: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => { calls.push({ url: String(url), init }); return respond(String(url), init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

beforeEach(() => {
  airGap = undefined;
  delete process.env.ANDROMITY_AIRGAP;
  toasts.length = 0;
  features.length = 0;
  rpc.length = 0;
});

describe("waitlist answers", () => {
  it("keeps only known choices, deduplicated, in the order of the form", () => {
    const cleaned = cleanWaitlistAnswer({
      wants: ["other", "faster", "faster", "made_up", 1, null, { id: "faster" }, "__proto__", "FASTER"],
      heard_from: "friend",
    });
    assert.deepEqual(cleaned, { answer: { wants: ["faster", "other"], wantsNote: "", heardFrom: "friend", heardNote: "" } });
  });

  it("refuses answers without a known choice and never throws on odd input", () => {
    for (const input of [
      undefined, null, "faster", 42, true, [], ["faster"], {},
      { wants: "faster", heard_from: "friend" },
      { wants: [], heard_from: "friend" },
      { wants: ["made_up"], heard_from: "friend" },
      { wants: ["faster"] },
      { wants: ["faster"], heard_from: "Friend" },
      { wants: ["faster"], heard_from: ["friend"] },
      { wants: ["faster"], heard_from: "constructor" },
      { wants: ["faster"], heard_from: "__proto__" },
      { wants: ["faster"], heard_from: "toString" },
      JSON.parse('{"__proto__":{"wants":["faster"],"heard_from":"friend"}}'),
    ]) {
      const cleaned = cleanWaitlistAnswer(input);
      assert.ok("error" in cleaned, JSON.stringify(input) ?? String(input));
      assert.equal(typeof cleaned.error, "string");
    }
  });

  it("trims notes and refuses notes longer than the worker accepts", () => {
    const base = { wants: ["faster"], heard_from: "friend" };
    assert.equal(cleanWaitlistAnswer({ ...base, wants_note: "  a\r\nb\rc  " }).answer.wantsNote, "a\nb\nc");
    assert.equal(cleanWaitlistAnswer({ ...base, wants_note: 42, heard_note: { text: "x" } }).answer.wantsNote, "");
    assert.equal(cleanWaitlistAnswer({ ...base, wants_note: " " + "w".repeat(MAX_WANTS_NOTE) + " " }).answer.wantsNote.length, MAX_WANTS_NOTE);
    assert.equal(cleanWaitlistAnswer({ ...base, heard_note: "h".repeat(MAX_HEARD_NOTE) }).answer.heardNote.length, MAX_HEARD_NOTE);
    const longWants = cleanWaitlistAnswer({ ...base, wants_note: "w".repeat(MAX_WANTS_NOTE + 1) });
    assert.match(longWants.error, /under 300 characters \(now 301\)/);
    const longHeard = cleanWaitlistAnswer({ ...base, heard_note: "h".repeat(MAX_HEARD_NOTE + 1) });
    assert.match(longHeard.error, /under 200 characters \(now 201\)/);
  });

  it("offers exactly the ids and note limits the telemetry worker accepts", () => {
    const worker = readFileSync(join(__dirname, "..", "..", "..", "telemetry-worker", "waitlist.js"), "utf8");
    const ids = (name: string) => [...(new RegExp(`export const ${name} = \\[([^\\]]+)\\]`).exec(worker)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const limit = (name: string) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(worker)?.[1]);
    assert.deepEqual(WAITLIST_WANTS.map((c: { id: string }) => c.id), ids("WANTS"));
    assert.deepEqual(WAITLIST_HEARD_FROM.map((c: { id: string }) => c.id), ids("HEARD_FROM"));
    assert.equal(MAX_WANTS_NOTE, limit("MAX_WANTS_NOTE"));
    assert.equal(MAX_HEARD_NOTE, limit("MAX_HEARD_NOTE"));
  });

  it("builds a payload of only the answers, the client, the OS family and the version", () => {
    const answer = { ...cleanWaitlistAnswer(ANSWER).answer, machineId: MACHINE_ID, sessionId: "s-1", email: "a@b.c" };
    assert.deepEqual(waitlistPayload(answer, "0.2.25", process.platform), EXPECTED_PAYLOAD);
    const bare = waitlistPayload(cleanWaitlistAnswer({ wants: ["other"], heard_from: "x", wants_note: "   " }).answer, "0.2.25", "freebsd");
    assert.deepEqual(bare, { wants: ["other"], heard_from: "x", client: "vscode", os: "unknown", version: "0.2.25" });
    assert.equal(waitlistPayload(answer, "1", "win32").os, "windows");
    assert.equal(waitlistPayload(answer, "1", "darwin").os, "darwin");
    assert.equal(waitlistPayload(answer, "1", "linux").os, "linux");
  });
});

describe("sending to the worker", () => {
  it("posts JSON to the worker's /waitlist route over HTTPS with a timeout", async () => {
    const calls: { url: string; init: any }[] = [];
    const result = await submitWaitlist(EXPECTED_PAYLOAD, async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 201 };
    });
    assert.equal(result, "joined");
    assert.equal(calls.length, 1);
    const target = new URL(calls[0].url);
    assert.equal(calls[0].url, WAITLIST_ENDPOINT);
    assert.equal(target.protocol, "https:");
    assert.equal(target.hostname, "telemetry.agenticmarket.dev");
    assert.equal(target.pathname, "/waitlist");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(calls[0].init.body), EXPECTED_PAYLOAD);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  it("maps worker answers to joined, unavailable or failed", async () => {
    const answer = (ok: boolean, status: number) => submitWaitlist(EXPECTED_PAYLOAD, async () => ({ ok, status }));
    assert.equal(await answer(true, 200), "joined");
    assert.equal(await answer(true, 201), "joined");
    assert.equal(await answer(false, 503), "unavailable");
    for (const status of [400, 401, 404, 405, 413, 429, 500, 502]) assert.equal(await answer(false, status), "failed", String(status));
    assert.equal(await submitWaitlist(EXPECTED_PAYLOAD, async () => { throw new TypeError("fetch failed"); }), "failed");
    assert.equal(await submitWaitlist(EXPECTED_PAYLOAD, () => Promise.reject(new DOMException("timed out", "TimeoutError"))), "failed");
  });
});

describe("the waitlist controller", () => {
  it("joins once with the cleaned answers, remembers it and tells every page", async () => {
    const ctx = context();
    const controller = new WaitlistController(ctx);
    let notified = 0;
    controller.onDidChange(() => notified++);
    controller.onDidChange(() => notified++);
    const sent: unknown[] = [];
    const submit = async (payload: unknown) => { sent.push(payload); return "joined"; };
    assert.deepEqual(await controller.join(ANSWER, submit), { type: "waitlist_result", ok: true });
    assert.deepEqual(sent, [EXPECTED_PAYLOAD]);
    assert.equal(ctx.store.get(JOINED_KEY), true);
    assert.equal(notified, 2);
    assert.deepEqual(sentEvents(), [], "joining records no usage event");

    const reopened = new WaitlistController(ctx);
    assert.equal(reopened.joined(), true, "the joined state survives a restart");
    assert.deepEqual(reopened.stateMessage(), { type: "waitlist_state", joined: true, offered: true });
    assert.deepEqual(await controller.join(ANSWER, submit), { type: "waitlist_result", ok: true });
    assert.equal(sent.length, 1, "joining again sends nothing");
    assert.equal(notified, 2);
  });

  it("only a stored true counts as joined", () => {
    for (const stored of [false, "true", 1, {}, null]) {
      assert.equal(new WaitlistController(context({ [JOINED_KEY]: stored })).joined(), false, JSON.stringify(stored));
    }
    assert.deepEqual(new WaitlistController(context()).stateMessage(), { type: "waitlist_state", joined: false, offered: false });
  });

  it("sends no telemetry id, machine id, session or workspace data on the real request path", async () => {
    const network = stubFetch(() => new Response('{"received":true}', { status: 201 }));
    try {
      const replies: unknown[] = [];
      const handled = await new WaitlistController(context()).handleMessage({
        type: "waitlist_join", ...ANSWER,
        machineId: MACHINE_ID, sessionId: "sess-123", session_id: "sess-123", user_id: "user-abc", telemetry_id: "tid-xyz",
        email: "someone@example.com", workspace: "D:/secret/project", client: "cursor", os: "beos", version: "9.9.9",
      }, (reply: unknown) => replies.push(reply));
      assert.equal(handled, true);
      assert.deepEqual(replies, [{ type: "waitlist_result", ok: true }]);
      assert.equal(network.calls.length, 1);
      assert.equal(network.calls[0].url, WAITLIST_ENDPOINT);
      assert.deepEqual(JSON.parse(network.calls[0].init.body), EXPECTED_PAYLOAD);
      assert.deepEqual(Object.keys(network.calls[0].init.headers), ["Content-Type"]);
      const wire = JSON.stringify(network.calls[0].init);
      for (const value of [MACHINE_ID, VSCODE_SESSION, "sess-123", "user-abc", "tid-xyz", "someone@example.com", "secret/project", "cursor"]) {
        assert.ok(!wire.includes(value), `${value} must not be sent`);
      }
    } finally {
      network.restore();
    }
  });

  it("keeps the answers out of usage telemetry", async () => {
    const controller = new WaitlistController(context());
    await controller.handleMessage({ type: "waitlist_open" }, () => {});
    await controller.join(ANSWER, async () => "joined");
    await controller.handleMessage({ type: "waitlist_offered" }, () => {});
    assert.deepEqual(sentEvents(), [], "opening the form, joining and the offer flag record nothing");
    assert.deepEqual(features.filter((f) => f.startsWith("waitlist")), [], "not even locally");
    const recorded = JSON.stringify(rpc) + JSON.stringify(features);
    for (const answer of ["reddit", "faster", "higher_limit", "more turns", "r/vscode"]) {
      assert.ok(!recorded.includes(answer), `${answer} leaked into telemetry`);
    }
  });

  it("records the offer at most once per VS Code session and never for people who joined", async () => {
    new WaitlistController(context({ [JOINED_KEY]: true })).offerShown();
    assert.equal(sentEvents("waitlist_offer_shown").length, 0);
    const controller = new WaitlistController(context());
    controller.offerShown();
    controller.offerShown();
    await controller.handleMessage({ type: "waitlist_offer_shown" }, () => {});
    new WaitlistController(context()).offerShown();
    assert.equal(sentEvents("waitlist_offer_shown").length, 1);
  });

  it("opening the form sends the choices and records nothing", async () => {
    const posted: any[] = [];
    assert.equal(await new WaitlistController(context()).handleMessage({ type: "waitlist_open" }, (r: unknown) => posted.push(r)), true);
    assert.deepEqual([...posted], [{
      type: "waitlist_form",
      joined: false,
      wants: WAITLIST_WANTS.map(({ id, label }: { id: string; label: string }) => ({ id, label })),
      heardFrom: WAITLIST_HEARD_FROM.map(({ id, label }: { id: string; label: string }) => ({ id, label })),
    }]);
    assert.equal(sentEvents().length, 0);
    await new WaitlistController(context({ [JOINED_KEY]: true })).handleMessage({ type: "waitlist_open" }, (r: unknown) => posted.push(r));
    assert.equal(posted[1].joined, true);
    assert.equal(sentEvents().length, 0);
  });

  it("air-gap mode shows a notice instead of the form and refuses to send, whatever turned it on", async () => {
    const sources: Array<() => void> = [
      () => { airGap = { globalValue: true }; },
      () => { airGap = { workspaceValue: true }; },
      () => { airGap = { workspaceFolderValue: true }; },
      () => { process.env.ANDROMITY_AIRGAP = "1"; },
    ];
    const network = stubFetch(() => new Response("{}", { status: 201 }));
    try {
      for (const [i, turnOn] of sources.entries()) {
        airGap = undefined;
        delete process.env.ANDROMITY_AIRGAP;
        toasts.length = 0;
        turnOn();
        const ctx = context();
        const controller = new WaitlistController(ctx);
        const posted: unknown[] = [];
        await controller.handleMessage({ type: "waitlist_open" }, (r: unknown) => posted.push(r));
        assert.equal(posted.length, 0, `source ${i}: no form`);
        assert.deepEqual(toasts, [AIR_GAP_ERROR], `source ${i}: a notice instead`);
        let submits = 0;
        const reply = await controller.join(ANSWER, async () => { submits++; return "joined"; });
        assert.deepEqual(reply, { type: "waitlist_result", ok: false, error: AIR_GAP_ERROR });
        await controller.handleMessage({ type: "waitlist_join", ...ANSWER }, (r: unknown) => posted.push(r));
        assert.equal(submits, 0);
        assert.equal(ctx.store.has(JOINED_KEY), false);
      }
      assert.equal(network.calls.length, 0, "nothing reached the network");
      assert.equal(sentEvents().length, 0);
    } finally {
      network.restore();
      delete process.env.ANDROMITY_AIRGAP;
    }
  });

  it("refused answers send nothing and leave the offer in place", async () => {
    const ctx = context();
    const controller = new WaitlistController(ctx);
    let submits = 0;
    for (const bad of [{}, { wants: ["faster"] }, { heard_from: "friend" }, { wants: ["faster"], heard_from: "friend", wants_note: "w".repeat(301) }]) {
      const reply = await controller.join(bad, async () => { submits++; return "joined"; });
      assert.equal(reply.ok, false, JSON.stringify(bad).slice(0, 60));
      assert.equal(typeof reply.error, "string");
    }
    assert.equal(submits, 0);
    assert.equal(controller.joined(), false);
    assert.equal(sentEvents("waitlist_joined").length, 0);
  });

  it("a worker without the table says the waitlist isn't available; other failures ask to try again", async () => {
    const ctx = context();
    const controller = new WaitlistController(ctx);
    let notified = 0;
    controller.onDidChange(() => notified++);
    const unavailable = await controller.join(ANSWER, async () => "unavailable");
    assert.deepEqual(unavailable, { type: "waitlist_result", ok: false, error: "The waitlist isn't available right now. Please try again later." });
    const failed = await controller.join(ANSWER, async () => "failed");
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Check your connection and try again/);
    assert.equal(ctx.store.has(JOINED_KEY), false);
    assert.equal(notified, 0);
    assert.equal(sentEvents("waitlist_joined").length, 0);

    const network = stubFetch(() => new Response('{"error":"Waitlist is not available yet"}', { status: 503 }));
    try {
      const replies: any[] = [];
      await controller.handleMessage({ type: "waitlist_join", ...ANSWER }, (r: unknown) => replies.push(r));
      assert.equal(replies[0].error, "The waitlist isn't available right now. Please try again later.");
    } finally {
      network.restore();
    }
  });

  it("a double click sends one request and both clicks hear the result", async () => {
    const controller = new WaitlistController(context());
    const pending: Array<(value: string) => void> = [];
    const submit = () => new Promise<string>((resolve) => { pending.push(resolve); });
    const first = controller.join(ANSWER, submit);
    const second = controller.join({ ...ANSWER, heard_from: "x" }, submit);
    const submits = pending.length;
    for (const release of pending) release("joined");
    assert.deepEqual(await first, { type: "waitlist_result", ok: true });
    assert.deepEqual(await second, { type: "waitlist_result", ok: true });
    assert.equal(submits, 1);
  });

  it("a failed join can be retried", async () => {
    const ctx = context();
    const controller = new WaitlistController(ctx);
    assert.equal((await controller.join(ANSWER, async () => "failed")).ok, false);
    assert.equal((await controller.join(ANSWER, async () => "joined")).ok, true);
    assert.equal(ctx.store.get(JOINED_KEY), true);
  });

  it("a lost joined flag still reports success and updates every page", async () => {
    const controller = new WaitlistController(context({}, { failUpdate: true }));
    let notified = 0;
    controller.onDidChange(() => notified++);
    assert.deepEqual(await controller.join(ANSWER, async () => "joined"), { type: "waitlist_result", ok: true });
    assert.equal(notified, 1);
    assert.equal(sentEvents().length, 0);
  });

  it("one page failing to update does not fail the join, and a disposed page is not told", async () => {
    const controller = new WaitlistController(context());
    let told = 0;
    let disposedTold = 0;
    controller.onDidChange(() => { throw new Error("webview disposed"); });
    controller.onDidChange(() => told++);
    controller.onDidChange(() => disposedTold++).dispose();
    assert.equal((await controller.join(ANSWER, async () => "joined")).ok, true);
    assert.equal(told, 1);
    assert.equal(disposedTold, 0);
  });

  it("is not offered until the gateway has offered it once, and then remembers it", async () => {
    const ctx = context();
    const controller = new WaitlistController(ctx);
    let changes = 0;
    controller.onDidChange(() => changes++);
    assert.equal(controller.offered(), false);
    assert.equal(await controller.handleMessage({ type: "waitlist_offered" }, () => { throw new Error("no reply expected"); }), true);
    assert.equal(ctx.store.get(OFFERED_KEY), true);
    assert.equal(controller.offered(), true);
    assert.equal(changes, 1, "every page hears about it");
    await controller.markOffered();
    await controller.handleMessage({ type: "waitlist_offered" }, () => {});
    assert.equal(changes, 1, "only the first offer is a change");
    const reopened = new WaitlistController(ctx);
    assert.equal(reopened.offered(), true, "survives a restart");
    assert.deepEqual(reopened.stateMessage(), { type: "waitlist_state", joined: false, offered: true });
    assert.equal(reopened.joined(), false, "being offered is not joining");
    assert.deepEqual(sentEvents(), [], "the flag records no usage event");
  });

  it("counts people who joined as offered, and only a stored true as offered", async () => {
    assert.equal(new WaitlistController(context({ [JOINED_KEY]: true })).offered(), true);
    for (const stored of ["true", 1, {}, false]) {
      assert.equal(new WaitlistController(context({ [OFFERED_KEY]: stored })).offered(), false, JSON.stringify(stored));
    }
    let changes = 0;
    const joined = new WaitlistController(context({ [JOINED_KEY]: true }));
    joined.onDidChange(() => changes++);
    await joined.markOffered();
    assert.equal(changes, 0);
  });

  it("a flag that cannot be saved is not announced and does not throw", async () => {
    const controller = new WaitlistController(context({}, { failUpdate: true }));
    let changes = 0;
    controller.onDidChange(() => changes++);
    await controller.markOffered();
    assert.equal(changes, 0);
    assert.equal(controller.offered(), false);
  });

  it("the offered flag works in air-gap mode, because it only stores a local flag", async () => {
    airGap = { globalValue: true };
    const ctx = context();
    const network = stubFetch(() => new Response("{}", { status: 201 }));
    try {
      await new WaitlistController(ctx).handleMessage({ type: "waitlist_offered" }, () => {});
      assert.equal(ctx.store.get(OFFERED_KEY), true);
      assert.equal(network.calls.length, 0);
    } finally {
      network.restore();
    }
  });

  it("lists exactly the chat messages it handles, so routing can skip the engine for them", () => {
    const { WAITLIST_MESSAGES } = require("../src/engagement/waitlistController.js");
    assert.deepEqual([...WAITLIST_MESSAGES].sort(), ["waitlist_join", "waitlist_offer_shown", "waitlist_offered", "waitlist_open"]);
  });

  it("ignores messages that are not about the waitlist", async () => {
    const controller = new WaitlistController(context());
    const posted: unknown[] = [];
    for (const message of [{}, { type: "checkin_send" }, { type: "WAITLIST_OPEN" }, { type: "waitlist" }, { type: ["waitlist_open"] }]) {
      assert.equal(await controller.handleMessage(message, (r: unknown) => posted.push(r)), false, JSON.stringify(message));
    }
    assert.deepEqual(posted, []);
    assert.equal(sentEvents().length, 0);
  });
});
