import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import {
  RECEIPT_FEEDBACK_KEY,
  RECEIPT_FEEDBACK_RULES,
  RECEIPT_NOTE_PREFIX_MAX,
  afterReceiptAnswered,
  afterReceiptAsked,
  afterReceiptNever,
  afterReceiptOpened,
  initialReceiptFeedbackState,
  isReceiptRating,
  normalizeReceiptFeedbackState,
  receiptNoteMessage,
  receiptRatingMessage,
  shouldAskReceiptFeedback,
  validateReceiptNote,
} from "../src/engagement/receiptFeedback.js";
import { FEEDBACK_ENDPOINT, MAX_FEEDBACK_LENGTH } from "../src/engagement/feedbackSubmit.js";

const nodeRequire: NodeRequire = require;
const Module = nodeRequire("module");
const originalRequire = Module.prototype.require;

const EXT = fs.existsSync(path.join(process.cwd(), "src/panels/ReceiptPanel.ts")) ? process.cwd() : path.resolve(__dirname, "../..");
const readSource = (rel: string) => fs.readFileSync(path.join(EXT, rel), "utf8");

/* ------------------------------------------------------------------ */
/* Fakes                                                                */
/* ------------------------------------------------------------------ */

const ALLOWED = [
  "receipt_line_shown", "receipt_opened", "receipt_opened_cmd", "receipt_copy_text", "receipt_copy_markdown",
  "receipt_export_json", "receipt_open_file", "receipt_rating_shown", "receipt_rating_off",
];
const REMOVED = ["receipt_rating_answered", "receipt_note_sent"];
const NAME_RE = /^[a-z0-9_]{1,31}$/;

interface Raw { feature: string; options: any; at: number }
const rawFeatures: Raw[] = [];
const spyModule = { recordFeatureUse: (feature: string, options?: any) => { rawFeatures.push({ feature, options, at: performance.now() }); } };

const opened: string[] = [];
const warnings: string[] = [];
const clipboard: string[] = [];
const written: Array<{ path: string; text: string }> = [];
const plain = (p: string) => p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
const links: Record<string, string> = { "/ws/link": "/outside" };

const ctl = {
  clipboardFails: false,
  saveTarget: { fsPath: "/ws/receipt.json" } as any,
  saveDialogThrows: false,
  writeFails: false,
  openDocFails: false,
  showDocFails: false,
  policy: "workspace" as "workspace" | "deny",
};
const resetCtl = () => {
  ctl.clipboardFails = false; ctl.saveTarget = { fsPath: "/ws/receipt.json" }; ctl.saveDialogThrows = false;
  ctl.writeFails = false; ctl.openDocFails = false; ctl.showDocFails = false; ctl.policy = "workspace";
};

const fsMock = {
  promises: {
    realpath: async (p: string) => {
      let at = plain(p);
      if (at.includes("missing")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      for (let hops = 0; hops < 8; hops++) {
        const link = Object.entries(links).find(([from]) => at === from || at.startsWith(from + "/"));
        if (!link) return at;
        at = link[1] + at.slice(link[0].length);
      }
      throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
    },
  },
};

const createdPanels: any[] = [];
const vscodeMock: any = {
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/") }),
    file: (p: string) => ({ fsPath: p }),
  },
  window: {
    createWebviewPanel: () => {
      let html = "";
      const panel: any = {
        title: "", closed: false, posted: [] as any[], htmlWrites: 0, onPost: undefined as undefined | ((m: any) => void),
        reveal() {},
        onDidDispose: (handler: any) => {
          panel.dispose = () => { panel.closed = true; handler(); };
          return { dispose() {} };
        },
        webview: {
          cspSource: "vscode-webview:",
          get html() { return html; },
          set html(value: string) { if (panel.closed) throw new Error("Webview is disposed"); html = value; panel.htmlWrites++; },
          onDidReceiveMessage: (handler: any) => { panel.receive = handler; return { dispose() {} }; },
          postMessage: (message: any) => {
            if (panel.closed) throw new Error("Webview is disposed");
            panel.posted.push(message);
            panel.onPost?.(message);
            return Promise.resolve(true);
          },
        },
      };
      createdPanels.push(panel);
      return panel;
    },
    showTextDocument: async (doc: any) => { if (ctl.showDocFails) throw new Error("show failed"); opened.push(doc.path); },
    showSaveDialog: async () => { if (ctl.saveDialogThrows) throw new Error("dialog failed"); return ctl.saveTarget; },
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: (text: string) => { warnings.push(text); return Promise.resolve(undefined); },
    showErrorMessage: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/ws" } }] as any,
    openTextDocument: async (uri: any) => { if (ctl.openDocFails) throw new Error("open failed"); return { path: uri.fsPath }; },
    fs: { writeFile: async (uri: any, data: Buffer) => { if (ctl.writeFails) throw new Error("disk full"); written.push({ path: uri.fsPath, text: data.toString("utf8") }); } },
  },
  env: { clipboard: { writeText: async (text: string) => { if (ctl.clipboardFails) throw new Error("clipboard locked"); clipboard.push(text); } } },
};
const policyMock = {
  allowOpenPath: async (p: string) => {
    if (ctl.policy === "deny") return false;
    const roots: string[] = (vscodeMock.workspace.workspaceFolders || []).map((f: any) => plain(f.uri.fsPath));
    return roots.some((root) => plain(p) === root || plain(p).startsWith(root + "/"));
  },
};

interface Post { url: string; init: any; body: any; raw: string; at: number }
const posts: Post[] = [];
const fetchCtl = { mode: "ok" as "ok" | "notok" | "throw" | "hold", held: [] as Array<(ok: boolean) => void> };
const realFetch = globalThis.fetch;
const fakeFetch: any = async (url: string, init: any) => {
  const raw = String(init?.body ?? "");
  let body: any = null;
  try { body = JSON.parse(raw); } catch { /* keep null */ }
  posts.push({ url, init, body, raw, at: performance.now() });
  if (fetchCtl.mode === "throw") throw new TypeError("fetch failed: ECONNRESET at secret/stack/line.js:1");
  if (fetchCtl.mode === "notok") return { ok: false };
  if (fetchCtl.mode === "hold") return new Promise((resolve) => fetchCtl.held.push((ok: boolean) => resolve({ ok })));
  return { ok: true };
};

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memento(initial: Record<string, unknown> = {}, flags: { updateThrows?: boolean; updateRejects?: boolean; getThrows?: boolean } = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const writes: unknown[] = [];
  return {
    data, writes,
    get(key: string, fallback?: unknown) {
      if (flags.getThrows) throw new Error("memento get failed");
      return data.has(key) ? data.get(key) : fallback;
    },
    update(key: string, value: unknown) {
      if (flags.updateThrows) throw new Error("memento update failed");
      writes.push(value);
      data.set(key, value);
      if (flags.updateRejects) return Promise.reject(new Error("memento update rejected"));
      return Promise.resolve();
    },
    keys: () => [] as readonly string[],
    snapshot(): Record<string, unknown> { return JSON.parse(JSON.stringify(Object.fromEntries(data))); },
    state(): any { return data.get(RECEIPT_FEEDBACK_KEY); },
  };
}
const withState = (value: unknown, flags = {}) => memento({ [RECEIPT_FEEDBACK_KEY]: value }, flags);

function fresh(opts: { storage?: any; spy?: boolean; version?: string; configure?: boolean } = {}): any {
  const panelPath = nodeRequire.resolve("../src/panels/ReceiptPanel.js");
  delete nodeRequire.cache[panelPath];
  Module.prototype.require = function (this: any, name: string) {
    if (name === "vscode") return vscodeMock;
    if (name === "node:fs") return fsMock;
    if (name.endsWith("securityPolicy.js")) return policyMock;
    if (opts.spy !== false && name.endsWith("telemetry/featureUsage.js")) return spyModule;
    return originalRequire.apply(this, arguments);
  };
  let RP: any;
  try { RP = nodeRequire(panelPath).ReceiptPanel; } finally { Module.prototype.require = originalRequire; }
  if (opts.configure !== false) RP.configureFeedback("storage" in opts ? opts.storage : memento(), opts.version ?? "9.9.9");
  return RP;
}

function receipt(turn: number, overrides: Record<string, unknown> = {}) {
  return {
    version: 1, session_id: "s", turn_index: turn, started_at: null, ended_at: null, duration_seconds: null,
    models: [], mode: null, snapshot: {}, files_changed: [{ path: "src/app.py", status: "M", added: 1, deleted: 0, via: "edit" }],
    edited_not_in_snapshot: [], files_read: [],
    commands: [], checks: [], web_hosts: [], mcp_servers: [], other_tools: {}, needs_attention: [], approvers: [],
    cost_usd: null, tokens: null, notes: [], record_hash: "e".repeat(64),
    summary: { files_changed: 1, lines_added: 1, lines_deleted: 0, files_read: 0, searches: 0, commands: 0, commands_failed: 0,
      blocked: 0, denied: 0, approved_by_person: 0, denied_by_person: 0, subagents: 0, web_searches: 0 },
    ...overrides,
  };
}
const answer = (turn: number, turns = [0, 4]) =>
  ({ success: true, receipt: receipt(turn), text: `receipt text ${turn}`, markdown: `### receipt ${turn}`, viewer_id: null, turns });

function fakeRpc(reply?: (params: any) => any) {
  const handlers = new Map<string, Array<(params: any) => void>>();
  const calls: any[] = [];
  return {
    calls,
    on(event: string, handler: (params: any) => void) { handlers.set(event, [...(handlers.get(event) || []), handler]); },
    off(event: string, handler: (params: any) => void) { handlers.set(event, (handlers.get(event) || []).filter((h) => h !== handler)); },
    emit(event: string, params: any) { (handlers.get(event) || []).forEach((handler) => handler(params)); },
    async call(method: string, params: any) {
      calls.push({ method, params });
      return reply ? reply(params) : answer(params.turn_index ?? 4);
    },
  };
}
function heldRpc() {
  const pending: Array<{ params: any; resolve: (value: any) => void }> = [];
  const rpc = fakeRpc((params) => new Promise((resolve) => pending.push({ params, resolve })));
  return { rpc, pending };
}

interface Handle { instance: any; vs: any; send(message: any): Promise<void>; html(): string; close(): void }
function openReceipt(RP: any, id: string, rpc: any = fakeRpc(), turn: number | null = null, name: string = id): Handle {
  const instance = RP.createOrShow({ fsPath: "/ext" }, id, name, rpc, turn);
  const vs = instance._panel;
  return { instance, vs, send: (message: any) => vs.receive(message), html: () => vs.webview.html, close: () => { if (!vs.closed) vs.dispose(); } };
}

type Strip = "absent" | "ask" | "note-up" | "note-down";
function stripOf(html: string): Strip {
  if (!html.includes('id="rc-feedback"')) return "absent";
  if (/data-step="ask">/.test(html)) return "ask";
  if (html.includes(">What was useful? (optional)</label>")) return "note-up";
  return "note-down";
}

const names = () => rawFeatures.map((c) => c.feature);
const countOf = (name: string) => rawFeatures.filter((c) => c.feature === name).length;
const rated = () => posts.map((p) => p.body?.message);

/** Opens a receipt, answers the question if it is asked, closes the panel. Returns what the strip showed. */
async function receiptOnce(RP: any, id: string, how?: "up" | "down" | "never"): Promise<Strip> {
  const h = openReceipt(RP, id);
  await settle();
  const seen = stripOf(h.html());
  if (seen === "ask" && how === "never") await h.send({ type: "receipt_feedback_never" });
  else if (seen === "ask" && how) await h.send({ type: "receipt_rate", rating: how });
  h.close();
  return seen;
}

before(() => { (globalThis as any).fetch = fakeFetch; });
after(() => { (globalThis as any).fetch = realFetch; });
afterEach(() => {
  for (const panel of createdPanels.splice(0)) { try { if (!panel.closed) panel.dispose(); } catch { /* ignore */ } }
  rawFeatures.length = 0; posts.length = 0; opened.length = 0; warnings.length = 0; clipboard.length = 0; written.length = 0;
  fetchCtl.mode = "ok"; fetchCtl.held.length = 0;
  resetCtl();
  delete process.env.ANDROMITY_AIRGAP;
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: "/ws" } }];
});

async function watchRejections(run: () => Promise<void>): Promise<unknown[]> {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const seen: unknown[] = [];
  const handler = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", handler);
  try { await run(); await nap(30); } finally {
    process.off("unhandledRejection", handler);
    for (const listener of saved) process.on("unhandledRejection", listener as any);
  }
  return seen;
}

/* ------------------------------------------------------------------ */
/* 1. Privacy                                                           */
/* ------------------------------------------------------------------ */

describe("privacy: usage telemetry", () => {
  const SECRET_NAME = "Quarterly-Layoff-Plan";
  const NOTE = "my-private-note-xyz";
  const FILE = "src/secret_payroll.py";

  it("records only documented names, each with just a session id, and nothing from the receipt", { timeout: 20000 }, async () => {
    const RP = fresh({ storage: memento() });
    const a = openReceipt(RP, "sess-priv-1", fakeRpc(), null, SECRET_NAME);
    await settle();
    openReceipt(RP, "sess-priv-1", fakeRpc(), null, SECRET_NAME);
    await settle();
    await a.send({ type: "copy_text" });
    await a.send({ type: "copy_markdown" });
    await a.send({ type: "export_json" });
    await a.send({ type: "open_file", path: FILE });
    await a.send({ type: "receipt_rate", rating: "up" });
    await a.send({ type: "receipt_note", message: NOTE });
    a.close();

    const RP2 = fresh({ storage: memento() });
    const b = openReceipt(RP2, "sess-priv-2", fakeRpc(), null, SECRET_NAME);
    await settle();
    await b.send({ type: "receipt_feedback_never" });
    b.close();

    const RP3 = fresh({ storage: memento() });
    const c = openReceipt(RP3, "sess-priv-3", fakeRpc(), null, SECRET_NAME);
    await settle();
    await c.send({ type: "receipt_rate", rating: "down" });
    await c.send({ type: "receipt_note_skip" });
    c.close();

    assert.ok(rawFeatures.length > 8, "the scenario must have recorded events");
    for (const call of rawFeatures) {
      assert.ok(ALLOWED.includes(call.feature), `unexpected feature name ${call.feature}`);
      assert.match(call.feature, NAME_RE);
      assert.deepEqual(Object.keys(call.options || {}).sort(), ["sessionId"], `options for ${call.feature}`);
      assert.match(call.options.sessionId, /^sess-priv-[123]$/);
    }
    const seen = new Set(names());
    for (const expected of ["receipt_opened", "receipt_copy_text", "receipt_copy_markdown", "receipt_export_json", "receipt_open_file",
      "receipt_rating_shown", "receipt_rating_off"]) {
      assert.ok(seen.has(expected), `${expected} was never recorded`);
    }
    for (const removed of REMOVED) assert.ok(!seen.has(removed), `${removed} must no longer be recorded`);
    const dump = JSON.stringify(rawFeatures);
    for (const leak of [SECRET_NAME, NOTE, FILE, "secret_payroll", "receipt text", "/ws", "app.py"]) {
      assert.ok(!dump.includes(leak), `feature events leak ${leak}`);
    }
  });

  it("a useful and a not-useful answer, with or without a note, leave identical usage telemetry", { timeout: 20000 }, async () => {
    const sequence = async (rating: "up" | "down") => {
      rawFeatures.length = 0;
      const RP = fresh({ storage: memento() });
      const h = openReceipt(RP, "same-session", fakeRpc());
      await settle();
      await h.send({ type: "receipt_rate", rating });
      if (rating === "up") await h.send({ type: "receipt_note", message: "a note" });
      else await h.send({ type: "receipt_note_skip" });
      h.close();
      return rawFeatures.map((c) => [c.feature, JSON.stringify(c.options)]);
    };
    const up = await sequence("up");
    const down = await sequence("down");
    assert.deepEqual(up, down);
    for (const [name] of up) assert.ok(!/(^|_)(up|down|useful|not|good|bad|yes|no)(_|$)/.test(name.replace("receipt_", "")), name);
  });

  it("anonymous answers carry exactly message, client, os and version, and nothing that identifies a session", { timeout: 20000 }, async () => {
    const RP = fresh({ storage: memento(), version: "1.2.3" });
    const h = openReceipt(RP, "sess-priv-9", fakeRpc(), null, SECRET_NAME);
    await settle();
    await h.send({ type: "receipt_rate", rating: "down" });
    await h.send({ type: "receipt_note", message: `  ${NOTE}  ` });
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map((p) => p.body.message), ["[receipt down]", `[receipt note down] ${NOTE}`]);
    for (const post of posts) {
      assert.equal(post.url, FEEDBACK_ENDPOINT);
      assert.deepEqual(Object.keys(post.body).sort(), ["client", "message", "os", "version"]);
      assert.equal(post.body.client, "vscode");
      assert.equal(post.body.version, "1.2.3");
      assert.ok(["windows", "darwin", "linux", "unknown"].includes(post.body.os));
      assert.deepEqual(Object.keys(post.init).sort(), ["body", "headers", "method", "signal"]);
      assert.deepEqual(Object.keys(post.init.headers), ["Content-Type"]);
      for (const leak of ["sess-priv-9", SECRET_NAME, "receipt text", "/ws", "session"]) assert.ok(!post.raw.includes(leak), `POST leaks ${leak}`);
    }
  });

  it("answering, sending a note, skipping and failing to send record no usage event at all, so nothing can be joined to the unlinked rows", { timeout: 20000 }, async () => {
    const RP = fresh({ storage: memento() });
    const h = openReceipt(RP, "sess-timing", fakeRpc());
    await settle();
    const before = rawFeatures.length;
    fetchCtl.mode = "hold";
    const rate = h.send({ type: "receipt_rate", rating: "up" });
    await settle();
    assert.equal(rawFeatures.length, before, "no event while the answer is in flight");
    fetchCtl.held.splice(0).forEach((release) => release(true));
    await rate;
    assert.equal(rawFeatures.length, before, "no event when the answer has been sent");
    fetchCtl.mode = "notok";
    await h.send({ type: "receipt_note", message: "fails" });
    fetchCtl.mode = "ok";
    await h.send({ type: "receipt_note", message: "works" });
    assert.equal(posts.length, 3);
    assert.equal(rawFeatures.length, before, "no event for the note, failed or sent");
    assert.deepEqual(names().filter((n) => REMOVED.includes(n)), []);
    const body = readSource("src/panels/ReceiptPanel.ts");
    for (const fn of ["_rate", "_sendNote"]) {
      const start = body.indexOf(`private async ${fn}(`);
      const end = body.indexOf("\n  }\n", start);
      assert.ok(start > 0 && end > start);
      assert.ok(!/recordFeatureUse/.test(body.slice(start, end)), `${fn} must not record usage events`);
    }
  });

  it("source scan: only the documented names are ever passed to recordFeatureUse from receipt code", () => {
    const panel = readSource("src/panels/ReceiptPanel.ts");
    for (const removed of REMOVED) for (const file of ["src/panels/ReceiptPanel.ts", "src/extension.ts", "src/providers/chatview/chatClientScript.ts", "../TELEMETRY.md"]) {
      assert.ok(!readSource(file).includes(removed), `${removed} is still mentioned in ${file}`);
    }
    const literals = [...panel.matchAll(/recordFeatureUse\(\s*"([^"]+)"/g)].map((m) => m[1]);
    const ternary = /recordFeatureUse\(markdown \? "(receipt_copy_markdown)" : "(receipt_copy_text)"/.exec(panel);
    assert.ok(ternary, "the copy event is the only computed name");
    for (const name of [...literals, ternary![1], ternary![2]]) assert.ok(ALLOWED.includes(name), name);
    for (const call of panel.matchAll(/recordFeatureUse\(([^;]*);/g)) {
      assert.match(call[1], /\{ sessionId(: this\._sessionId)? \}\)$/, `unexpected options in recordFeatureUse(${call[1]}`);
    }
    for (const call of panel.matchAll(/submitFeedback\(([^;]*);/g)) {
      assert.match(call[1], /^feedbackPayload\((receiptRatingMessage\(rating\)|receiptNoteMessage\(rating, text as string\)), ReceiptPanel\._version, process\.platform\)\)/, call[1]);
    }
    const extension = readSource("src/extension.ts");
    for (const m of extension.matchAll(/recordFeatureUse\("(receipt_[a-z0-9_]+)"([^)]*)\)/g)) {
      assert.ok(ALLOWED.includes(m[1]), m[1]);
      assert.equal(m[2].replace(/\s/g, ""), ",{sessionId}");
    }
    const chat = readSource("src/providers/chatview/chatClientScript.ts");
    for (const m of chat.matchAll(/feature: '(receipt_[a-z0-9_]+)'/g)) assert.ok(ALLOWED.includes(m[1]), m[1]);
    for (const name of ALLOWED) assert.match(name, NAME_RE);
  });
});

describe("TELEMETRY.md against the code", () => {
  const doc = fs.readFileSync(path.resolve(EXT, "..", "TELEMETRY.md"), "utf8");
  const section = (title: string) => (doc.split(title)[1] || "").split(/\n#{2,3} /)[0];

  it("documents exactly the nine names and the four anonymous message formats", () => {
    const turn = section("### Turn receipts");
    const documented = [...turn.matchAll(/`(receipt_[a-z0-9_]+)`/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(documented)].sort(), [...ALLOWED].sort());
    const feedback = section("## Feedback you send");
    for (const message of [receiptRatingMessage("up"), receiptRatingMessage("down"), receiptNoteMessage("up", "x").trim().replace(" x", ""), receiptNoteMessage("down", "x").trim().replace(" x", "")]) {
      assert.ok(feedback.includes("`" + message + "`"), `${message} is not documented`);
    }
  });

  it("states the question limits that the rules enforce", () => {
    const feedback = section("## Feedback you send");
    assert.match(feedback, /shown at most five times until you answer/);
    assert.match(feedback, /opened a receipt ten more times/);
    assert.match(feedback, /again at most five times/);
    assert.match(feedback, /never after your third answer/);
    assert.equal(RECEIPT_FEEDBACK_RULES.maxAsksPerAnswer, 5);
    assert.equal(RECEIPT_FEEDBACK_RULES.reaskAfterOpens, 10);
    assert.equal(RECEIPT_FEEDBACK_RULES.maxAnswers, 3);
    assert.match(feedback, /not linked to your telemetry ID/);
  });

  it("claim: 'at most five times' holds in every answer cycle, and the cycle restarts after an answer", { timeout: 90000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    let n = 0;
    const ignoreAll = async (opens: number) => {
      let shown = 0;
      for (let i = 0; i < opens; i++) { n++; if ((await receiptOnce(RP, `claim-${n}`)) === "ask") shown++; }
      return shown;
    };
    assert.equal(await ignoreAll(40), 5, "first cycle: five showings, then none");
    n++;
    storage.data.set(RECEIPT_FEEDBACK_KEY, { ...storage.state(), asks: 4 });
    assert.equal(await receiptOnce(RP, `claim-${n}`, "up"), "ask");
    assert.equal(storage.state().answers, 1);
    assert.equal(storage.state().asks, 0, "an answer resets the cycle");
    assert.equal(await ignoreAll(40), 5, "second cycle: ten opens later, five more showings, then none");
    assert.equal(storage.state().answers, 1);
  });

  it("claim: 'ten more receipts' means ten different receipts, not ten opens of one", { timeout: 60000, todo: "product decision: the count is opens, and TELEMETRY.md says so (a receipt opened ten more times)" }, async () => {
    const RP = fresh({ storage: memento() });
    const h = openReceipt(RP, "same-receipt");
    await settle();
    await h.send({ type: "receipt_rate", rating: "up" });
    let askedAfter = 0;
    for (let i = 1; i <= 10; i++) {
      openReceipt(RP, "same-receipt");
      await settle();
      if (stripOf(h.html()) === "ask") { askedAfter = i; break; }
    }
    assert.equal(askedAfter, 0, `the same receipt re-opened ${askedAfter} times counted as ten more receipts`);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Counting                                                          */
/* ------------------------------------------------------------------ */

describe("counting: events fire once per real action and never for a failed one", () => {
  it("a failed clipboard write is not counted", { timeout: 20000 }, async () => {
    const h = openReceipt(fresh(), "cnt-clip");
    await settle();
    ctl.clipboardFails = true;
    await h.send({ type: "copy_text" }).catch(() => {});
    await h.send({ type: "copy_markdown" }).catch(() => {});
    assert.equal(countOf("receipt_copy_text") + countOf("receipt_copy_markdown"), 0);
    ctl.clipboardFails = false;
    await h.send({ type: "copy_text" });
    assert.equal(countOf("receipt_copy_text"), 1);
    assert.equal(countOf("receipt_copy_markdown"), 0);
  });

  it("copy while loading, on an error view or for an unreadable receipt is not counted", { timeout: 20000 }, async () => {
    const { rpc, pending } = heldRpc();
    const h = openReceipt(fresh(), "cnt-load", rpc);
    await settle();
    await h.send({ type: "copy_text" });
    await h.send({ type: "export_json" });
    assert.equal(rawFeatures.filter((c) => /copy|export/.test(c.feature)).length, 0, "while loading");
    pending[0].resolve({ success: false, error: "No finished turn" });
    await settle();
    await h.send({ type: "copy_markdown" });
    await h.send({ type: "export_json" });
    assert.equal(rawFeatures.filter((c) => /copy|export/.test(c.feature)).length, 0, "on an error view");
  });

  it("a cancelled or failed Save JSON is not counted, a saved one is counted once", { timeout: 20000 }, async () => {
    const h = openReceipt(fresh(), "cnt-save");
    await settle();
    ctl.saveTarget = undefined;
    await h.send({ type: "export_json" });
    ctl.saveTarget = { fsPath: "/ws/r.json" };
    ctl.writeFails = true;
    await h.send({ type: "export_json" });
    ctl.writeFails = false;
    ctl.saveDialogThrows = true;
    await h.send({ type: "export_json" }).catch(() => {});
    assert.equal(countOf("receipt_export_json"), 0);
    assert.equal(written.length, 0);
    ctl.saveDialogThrows = false;
    await h.send({ type: "export_json" });
    assert.equal(countOf("receipt_export_json"), 1);
    assert.equal(written.length, 1);
  });

  it("a file open that is refused, missing, failed or malformed is not counted", { timeout: 20000 }, async () => {
    const h = openReceipt(fresh(), "cnt-open");
    await settle();
    for (const bad of [undefined, null, 5, "", "a\0b", "x".repeat(5000), {}, ["src/app.py"]]) await h.send({ type: "open_file", path: bad });
    await h.send({ type: "open_file", path: "link/secrets.env" });
    await h.send({ type: "open_file", path: "../../.ssh/id_rsa" });
    await h.send({ type: "open_file", path: "src/missing.py" });
    ctl.policy = "deny";
    await h.send({ type: "open_file", path: "src/app.py" });
    ctl.policy = "workspace";
    ctl.openDocFails = true;
    await h.send({ type: "open_file", path: "src/app.py" });
    ctl.openDocFails = false;
    ctl.showDocFails = true;
    await h.send({ type: "open_file", path: "src/app.py" });
    ctl.showDocFails = false;
    assert.equal(countOf("receipt_open_file"), 0, "no refused open may count");
    assert.deepEqual(opened, []);
    await h.send({ type: "open_file", path: "src/app.py" });
    await h.send({ type: "open_file", path: "src/app.py" });
    assert.equal(countOf("receipt_open_file"), 2);
  });

  it("receipt_opened fires once per createOrShow, also for an existing panel; re-renders never add one", { timeout: 20000 }, async () => {
    const RP = fresh();
    const rpc = fakeRpc();
    const h = openReceipt(RP, "cnt-opened", rpc);
    await settle();
    assert.equal(countOf("receipt_opened"), 1);
    openReceipt(RP, "cnt-opened", rpc);
    openReceipt(RP, "cnt-opened", rpc, 0);
    await settle();
    assert.equal(countOf("receipt_opened"), 3);
    for (let i = 0; i < 4; i++) await h.send({ type: "refresh" });
    for (let i = 0; i < 4; i++) rpc.emit("receipt/ready", { session_id: "cnt-opened", turn_index: 0, attention: 0, high: 0 });
    await h.send({ type: "turn", turnIndex: 4 });
    await h.send({ type: "latest" });
    await settle();
    assert.equal(countOf("receipt_opened"), 3);
    assert.equal(countOf("receipt_opened_cmd"), 0, "only the command records its own name");
  });

  it("re-renders within one open do not re-count or re-ask the question", { timeout: 20000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    const rpc = fakeRpc();
    const h = openReceipt(RP, "cnt-rerender", rpc);
    await settle();
    assert.equal(stripOf(h.html()), "ask");
    for (let i = 0; i < 5; i++) await h.send({ type: "refresh" });
    for (let i = 0; i < 5; i++) rpc.emit("receipt/ready", { session_id: "cnt-rerender", turn_index: 4, attention: 0, high: 0 });
    await h.send({ type: "turn", turnIndex: 0 });
    await h.send({ type: "latest" });
    await settle();
    assert.equal(countOf("receipt_rating_shown"), 1);
    assert.equal(storage.state().asks, 1);
    assert.equal(stripOf(h.html()), "ask", "the same open keeps showing the same question");
  });

  it("with the telemetry gate off no usage event reaches the client, yet a rating and a note still go out", { timeout: 20000 }, async () => {
    const featureUsage = nodeRequire("../src/telemetry/featureUsage.js");
    const calls: any[] = [];
    featureUsage.setFeatureUsageClient({ call: async (method: string, params: unknown) => { calls.push({ method, params }); return {}; } });
    let gate: () => boolean = () => false;
    featureUsage.setFeatureUsageGate(() => gate());
    try {
      const run = async (id: string) => {
        const RP = fresh({ storage: memento(), spy: false });
        const h = openReceipt(RP, id);
        await settle();
        await h.send({ type: "copy_text" });
        await h.send({ type: "copy_markdown" });
        await h.send({ type: "export_json" });
        await h.send({ type: "open_file", path: "src/app.py" });
        await h.send({ type: "receipt_rate", rating: "up" });
        await h.send({ type: "receipt_note", message: "gate note" });
        h.close();
      };
      await run("gate-off-1");
      assert.deepEqual(calls, [], "gate off: nothing may reach the client");
      assert.deepEqual(rated(), ["[receipt up]", "[receipt note up] gate note"], "the user's own answer is still sent");

      gate = () => { throw new Error("setting unreadable"); };
      await run("gate-throws");
      assert.deepEqual(calls, [], "an unreadable gate counts as off");

      gate = () => true;
      await run("gate-on");
      assert.ok(calls.length >= 6, "gate on: events flow");
      for (const call of calls as any[]) {
        assert.equal(call.method, "telemetry.recordFeature");
        assert.deepEqual(Object.keys(call.params).sort(), ["feature", "session_id"]);
        assert.match(call.params.feature, NAME_RE);
        assert.ok(ALLOWED.includes(call.params.feature));
        assert.equal(call.params.session_id, "gate-on");
      }
    } finally {
      featureUsage.setFeatureUsageClient(null);
      featureUsage.setFeatureUsageGate(() => true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. When the question is asked                                        */
/* ------------------------------------------------------------------ */

const label = (raw: unknown): string => { try { return JSON.stringify(raw) ?? typeof raw; } catch { return typeof raw; } };

describe("question rules (pure)", () => {
  const rawStates: unknown[] = [
    undefined, null, "never", 7, true, [], [1, 2, 3], {}, { opens: "9" }, { opens: -5, asks: -1, answers: -1 }, { opens: NaN, asks: NaN },
    { opens: Infinity, asks: Infinity, answers: Infinity, lastAnswerAtOpen: Infinity }, { opens: 1e308, asks: 1e308, answers: 1e308, lastAnswerAtOpen: 1e308 },
    { asks: 4.9 }, { status: "never" }, { status: {} }, { status: ["never"] }, { status: "NEVER" }, { answers: 3 }, { answers: "3" },
    JSON.parse('{"__proto__":{"status":"never","answers":9},"opens":1}'), { constructor: { prototype: { status: "never" } } },
    { toString: 5, valueOf: 5, opens: 2 }, { opens: 5, lastAnswerAtOpen: 99 }, { opens: 2 ** 53, asks: 2 ** 53 }, { opens: -0, asks: -0 },
    Object.freeze({ opens: 3, asks: 1, answers: 0, lastAnswerAtOpen: 0, status: "active" }), new Date(0), /x/, () => 1, Symbol("s"), 10n,
  ];

  it("normalises any stored value to a safe state and never pollutes the prototype", () => {
    for (const raw of rawStates) {
      const state = normalizeReceiptFeedbackState(raw);
      assert.deepEqual(Object.keys(state).sort(), ["answers", "asks", "lastAnswerAtOpen", "opens", "status"], label(raw));
      assert.ok(state.status === "active" || state.status === "never");
      for (const field of ["opens", "asks", "answers", "lastAnswerAtOpen"] as const) {
        assert.ok(Number.isInteger(state[field]) && state[field] >= 0 && state[field] <= 1_000_000, `${field} of ${label(raw)}`);
      }
      assert.ok(state.lastAnswerAtOpen <= state.opens);
      assert.ok(JSON.parse(JSON.stringify(state)).opens === state.opens);
    }
    assert.equal(({} as any).status, undefined);
    assert.equal(({} as any).opens, undefined);
    assert.equal(({} as any).answers, undefined);
    assert.equal(normalizeReceiptFeedbackState({ status: "never" }).status, "never");
    assert.equal(normalizeReceiptFeedbackState({ status: "NEVER" }).status, "active");
  });

  it("transitions are pure, bounded and never mutate their input", () => {
    const base = Object.freeze(initialReceiptFeedbackState());
    const next = afterReceiptAnswered(afterReceiptAsked(afterReceiptOpened(base)));
    assert.deepEqual(base, initialReceiptFeedbackState());
    assert.deepEqual(next, { status: "active", opens: 1, asks: 0, answers: 1, lastAnswerAtOpen: 1 });
    const big = { ...base, opens: 1_000_000, asks: 1_000_000, answers: 1_000_000 };
    assert.equal(afterReceiptOpened(big).opens, 1_000_000);
    assert.equal(afterReceiptAsked(big).asks, 1_000_000);
    assert.equal(afterReceiptNever(base).status, "never");
  });

  it("randomised walks never ask more than the rules allow", () => {
    let seed = 20261111;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let run = 0; run < 300; run++) {
      let state = initialReceiptFeedbackState();
      let answers = 0;
      let asksSinceAnswer = 0;
      let lastAnswerOpen = 0;
      for (let step = 0; step < 60; step++) {
        state = afterReceiptOpened(state);
        if (shouldAskReceiptFeedback(state)) {
          assert.ok(state.answers < 3);
          if (answers > 0) assert.ok(state.opens - lastAnswerOpen >= 10, "re-ask came too soon");
          assert.ok(asksSinceAnswer < 5, "a sixth showing in one answer cycle");
          state = afterReceiptAsked(state);
          asksSinceAnswer++;
          const dice = rnd();
          if (dice < 0.25) { state = afterReceiptAnswered(state); answers++; asksSinceAnswer = 0; lastAnswerOpen = state.opens; }
          else if (dice < 0.28) { state = afterReceiptNever(state); }
        }
        if (state.status === "never") assert.equal(shouldAskReceiptFeedback(state), false);
      }
      assert.ok(state.answers <= 3);
    }
  });

  it("rating and note messages are exactly the documented strings, and validation counts the prefix", () => {
    assert.equal(receiptRatingMessage("up"), "[receipt up]");
    assert.equal(receiptRatingMessage("down"), "[receipt down]");
    assert.equal(receiptNoteMessage("up", "  hi  "), "[receipt note up] hi");
    assert.equal(receiptNoteMessage("down", "hi"), "[receipt note down] hi");
    assert.equal(RECEIPT_NOTE_PREFIX_MAX, "[receipt note down] ".length);
    for (const value of ["up", "down"]) assert.ok(isReceiptRating(value));
    for (const value of ["UP", " up", "up ", "", null, undefined, 1, true, {}, [], ["up"], "__proto__", "constructor", "toString", { toString: () => "up" }]) {
      assert.equal(isReceiptRating(value), false, String(value));
    }
    for (const rating of ["up", "down"] as const) {
      const room = MAX_FEEDBACK_LENGTH - ("[receipt note " + rating + "] ").length;
      assert.equal(validateReceiptNote(rating, "a".repeat(room)), null);
      assert.match(validateReceiptNote(rating, "a".repeat(room + 1)) || "", /^Please keep it shorter/);
      assert.equal(validateReceiptNote(rating, ` \n${"a".repeat(room)}\t `), null, "whitespace around the note does not count");
    }
  });
});

describe("question rules (through the panel)", () => {
  it("is asked on the first five opens and then never, until answered", { timeout: 60000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    const seen: Strip[] = [];
    for (let i = 0; i < 12; i++) seen.push(await receiptOnce(RP, `five-${i}`));
    assert.deepEqual(seen, [...Array(5).fill("ask"), ...Array(7).fill("absent")]);
    assert.equal(countOf("receipt_rating_shown"), 5);
    assert.equal(storage.state().asks, 5);
    assert.equal(storage.state().opens, 12);
  });

  it("after an answer waits ten more opens, stops after three answers, and a restart keeps the counts", { timeout: 90000 }, async () => {
    let storage = memento();
    let RP = fresh({ storage });
    assert.equal(await receiptOnce(RP, "r-0", "up"), "ask");
    for (let i = 1; i <= 9; i++) assert.equal(await receiptOnce(RP, `r-a${i}`), "absent", `open ${i} after the answer`);
    storage = memento(storage.snapshot());
    RP = fresh({ storage });
    assert.equal(await receiptOnce(RP, "r-10", "down"), "ask", "the tenth receipt after the answer asks again, across a restart");
    for (let i = 1; i <= 9; i++) assert.equal(await receiptOnce(RP, `r-b${i}`), "absent");
    assert.equal(await receiptOnce(RP, "r-20", "up"), "ask");
    for (let i = 1; i <= 40; i++) assert.equal(await receiptOnce(RP, `r-c${i}`), "absent", `after three answers, open ${i}`);
    assert.equal(storage.state().answers, 3);
    assert.equal(posts.filter((p) => /^\[receipt (up|down)\]$/.test(p.body?.message)).length, 3);
  });

  it("'Don't ask again' is permanent across a restart and survives later opens", { timeout: 60000 }, async () => {
    let storage = memento();
    let RP = fresh({ storage });
    assert.equal(await receiptOnce(RP, "n-0", "never"), "ask");
    storage = memento(storage.snapshot());
    RP = fresh({ storage });
    for (let i = 1; i <= 25; i++) assert.equal(await receiptOnce(RP, `n-${i}`), "absent");
    assert.equal(storage.state().status, "never");
    assert.equal(countOf("receipt_rating_off"), 1);
  });

  it("copes with hostile stored state: opens, renders, writes back clean numbers", { timeout: 90000 }, async () => {
    const hostile: unknown[] = [
      undefined, null, "never", 7, [], [1, 2], { opens: "9" }, { opens: -5, asks: -1 }, { opens: NaN }, { opens: Infinity, asks: Infinity },
      { opens: 1e308, asks: 1e308, answers: 1e308 }, { asks: 4.9 }, { status: {} }, { status: ["never"] }, { answers: "3" },
      JSON.parse('{"__proto__":{"status":"never"},"opens":1}'), { constructor: { prototype: { status: "never" } } },
    ];
    for (const [index, value] of hostile.entries()) {
      const storage = withState(value);
      const RP = fresh({ storage });
      const h = openReceipt(RP, `host-${index}`);
      await settle();
      assert.match(h.html(), /Receipt for turn 5/, `renders with stored ${JSON.stringify(value)}`);
      assert.ok(["ask", "absent"].includes(stripOf(h.html())));
      for (const written of storage.writes) {
        for (const field of ["opens", "asks", "answers", "lastAnswerAtOpen"]) {
          const n = (written as any)[field];
          assert.ok(Number.isInteger(n) && n >= 0 && n <= 1_000_000, `${field}=${n} written for ${JSON.stringify(value)}`);
        }
      }
      h.close();
    }
    assert.equal(({} as any).status, undefined);
  });

  it("a stored 'never' or three answers wins over every other field", async () => {
    for (const value of [{ status: "never", opens: 0, asks: 0 }, { answers: 3, opens: 100, lastAnswerAtOpen: 0 }, { status: "never", answers: 0 }]) {
      assert.equal(await receiptOnce(fresh({ storage: withState(value) }), "win-" + JSON.stringify(value).length), "absent", JSON.stringify(value));
    }
  });

  it("never asks without storage, whether it is undefined or was never configured, and everything else still works", { timeout: 20000 }, async () => {
    for (const RP of [fresh({ storage: undefined }), fresh({ configure: false })]) {
      const h = openReceipt(RP, "nostore-" + Math.random());
      await settle();
      assert.equal(stripOf(h.html()), "absent");
      assert.equal(countOf("receipt_rating_shown"), 0);
      await h.send({ type: "copy_text" });
      await h.send({ type: "receipt_rate", rating: "up" });
      await h.send({ type: "receipt_note", message: "x" });
      await h.send({ type: "receipt_feedback_never" });
      assert.deepEqual(posts, [], "no question was asked, so no answer can be sent");
      assert.equal(countOf("receipt_rating_off"), 0);
      assert.equal(countOf("receipt_copy_text") > 0, true);
      rawFeatures.length = 0;
    }
  });

  it("never shows the question while loading, on an error, for an engine that is down, for a receipt that cannot be read, or in air-gap mode", { timeout: 30000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    const { rpc, pending } = heldRpc();
    const loading = openReceipt(RP, "never-1", rpc);
    await settle();
    assert.equal(stripOf(loading.html()), "absent", "while loading");
    assert.equal(countOf("receipt_rating_shown"), 0);
    pending[0].resolve(answer(4));
    await settle();
    assert.equal(stripOf(loading.html()), "ask");
    loading.close();

    const failing = openReceipt(RP, "never-2", fakeRpc(() => ({ success: false, error: "No finished turn with a file checkpoint" })));
    await settle();
    assert.equal(stripOf(failing.html()), "absent", "error view");
    const down = openReceipt(RP, "never-3", null);
    await settle();
    assert.equal(stripOf(down.html()), "absent", "engine not running");
    const unreadable = openReceipt(RP, "never-4", fakeRpc(() => ({ success: true, receipt: receipt(4, { sealed: { hash: "x", matches: "true" } }), text: "t", markdown: "m", turns: [0, 4] })));
    await settle();
    assert.equal(stripOf(unreadable.html()), "absent", "unreadable receipt");
    const throwing = openReceipt(RP, "never-5", fakeRpc(() => { throw new Error("socket closed"); }));
    await settle();
    assert.equal(stripOf(throwing.html()), "absent", "rpc throws");
    assert.equal(storage.state().asks, 1, "only the one real showing used up an ask");
    assert.equal(countOf("receipt_rating_shown"), 1);

    process.env.ANDROMITY_AIRGAP = "1";
    const airgapped = openReceipt(RP, "never-6");
    await settle();
    assert.equal(stripOf(airgapped.html()), "absent", "air-gap on");
    assert.equal(storage.state().asks, 1);
    assert.equal(countOf("receipt_rating_shown"), 1);
    for (const handle of [failing, down, unreadable, throwing, airgapped]) handle.close();
  });

  it("a pinned turn whose answer is another turn never shows the question", { timeout: 20000 }, async () => {
    const RP = fresh();
    const h = openReceipt(RP, "mismatch", fakeRpc(() => answer(4)), 0);
    await settle();
    assert.equal(stripOf(h.html()), "absent");
    assert.equal(countOf("receipt_rating_shown"), 0);
  });

  it("a panel closed while loading consumes no ask", { timeout: 20000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    const { rpc, pending } = heldRpc();
    const h = openReceipt(RP, "close-early", rpc);
    await settle();
    h.close();
    pending[0].resolve(answer(4));
    await settle();
    assert.equal(storage.state().asks ?? 0, 0);
    assert.equal(countOf("receipt_rating_shown"), 0);
  });

  it("two panels opened together cannot both take the last ask", { timeout: 20000 }, async () => {
    const storage = withState({ status: "active", opens: 4, asks: 4, answers: 0, lastAnswerAtOpen: 0 });
    const RP = fresh({ storage });
    const a = openReceipt(RP, "conc-a");
    const b = openReceipt(RP, "conc-b");
    await settle();
    const asking = [a, b].filter((h) => stripOf(h.html()) === "ask").length;
    assert.ok(asking <= 1, `${asking} panels asked with one ask left`);
    assert.equal(storage.state().asks, 5);
  });

  it("rapid open/close of the same session counts every open but asks at most five times", { timeout: 60000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    let asked = 0;
    for (let i = 0; i < 20; i++) if ((await receiptOnce(RP, "rapid")) === "ask") asked++;
    assert.equal(asked, 5);
    assert.equal(storage.state().opens, 20);
    assert.equal(countOf("receipt_opened"), 20);
  });

  it("a storage that rejects, throws on update, or throws on read does not stop a receipt from opening", { timeout: 30000 }, async () => {
    const rejected = await watchRejections(async () => {
      const h = openReceipt(fresh({ storage: memento({}, { updateRejects: true }) }), "store-reject");
      await settle();
      assert.match(h.html(), /Receipt for turn 5/);
      await h.send({ type: "receipt_rate", rating: "up" });
      await h.send({ type: "receipt_feedback_never" });
      h.close();
    });
    assert.deepEqual(rejected, [], "update() rejections must be swallowed");

    for (const flags of [{ updateThrows: true }, { getThrows: true }]) {
      let handle: Handle | undefined;
      const unhandled = await watchRejections(async () => {
        assert.doesNotThrow(() => { handle = openReceipt(fresh({ storage: memento({}, flags) }), "store-throw-" + Object.keys(flags)[0]); },
          `createOrShow must not throw when the memento ${Object.keys(flags)[0]}`);
        await settle();
        if (handle) {
          await handle.send({ type: "receipt_rate", rating: "up" });
          await handle.send({ type: "receipt_feedback_never" });
          await handle.send({ type: "receipt_feedback_sync" });
        }
      });
      assert.deepEqual(unhandled, [], `no unhandled rejection with ${JSON.stringify(flags)}`);
      assert.match(handle?.html() || "", /Receipt for turn 5/, `the receipt still renders when the memento ${Object.keys(flags)[0]}`);
    }
  });

  it("a storage that cannot remember cannot make the question nag: at most five showings over many opens", { timeout: 60000 }, async () => {
    for (const flags of [{ updateThrows: true }, { getThrows: true }]) {
      rawFeatures.length = 0;
      const RP = fresh({ storage: memento({}, flags) });
      let asked = 0;
      for (let i = 0; i < 12; i++) if ((await receiptOnce(RP, `broken-${Object.keys(flags)[0]}-${i}`)) === "ask") asked++;
      assert.ok(asked <= 5, `${JSON.stringify(flags)}: the question was shown ${asked} times in 12 opens, and 'Don't ask again' cannot be remembered either`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. Host message handling                                             */
/* ------------------------------------------------------------------ */

describe("host messages", () => {
  async function asking(id = "host-" + Math.random().toString(36).slice(2), storage: any = memento(), rpc: any = fakeRpc()) {
    const RP = fresh({ storage });
    const h = openReceipt(RP, id, rpc);
    await settle();
    assert.equal(stripOf(h.html()), "ask");
    return { RP, h, storage };
  }
  const states = (h: Handle) => h.vs.posted.filter((m: any) => m.type === "receipt_feedback_state");
  const last = (h: Handle) => states(h).at(-1);
  const RATING_FAILED = "Your answer couldn't be sent right now. Try again in a moment.";
  const NOTE_FAILED = "Your note couldn't be sent right now. Try again in a moment.";
  const THANKS = "Thanks, your note was sent.";
  const expectState = (h: Handle, step: string, busy = false, message?: string) => {
    const s = last(h);
    assert.ok(s, "the panel must reply with its state");
    assert.equal(s.step, step);
    assert.equal(s.busy, busy);
    assert.deepEqual(Object.keys(s).filter((k) => s[k] !== undefined).sort().filter((k) => !["type", "step", "busy"].includes(k)), message === undefined ? [] : [message === THANKS ? "notice" : "error"]);
  };
  const ratingPosts = () => posts.filter((p) => /^\[receipt (up|down)\]$/.test(p.body?.message)).length;

  it("receipt_rate accepts exactly 'up' or 'down'; anything else is answered with the unchanged state and sends nothing", { timeout: 30000 }, async () => {
    const { h, storage } = await asking();
    const junk: unknown[] = [undefined, null, "UP", "Up", "up ", " up", "down\0", "up\n", 1, 0, true, false, {}, [], ["up"], { toString: () => "up" },
      "__proto__", "constructor", "toString", "hasOwnProperty", "sideways", "u", "", "up".repeat(1000)];
    for (const rating of junk) {
      const before = states(h).length;
      await h.send({ type: "receipt_rate", rating });
      assert.equal(states(h).length, before + 1, `no reply for ${label(rating)}`);
      expectState(h, "ask");
    }
    const before = states(h).length;
    await h.send({ type: "receipt_rate" });
    assert.equal(states(h).length, before + 1);
    assert.equal(posts.length, 0, "no malformed rating may be sent");
    assert.equal(storage.state().answers, 0);
    await h.send({ type: "refresh" });
    assert.equal(stripOf(h.html()), "ask", "junk must not have moved the question on");
    await h.send({ type: "receipt_rate", rating: "down", extra: "up" });
    assert.deepEqual(rated(), ["[receipt down]"]);
    expectState(h, "note-down");
    assert.equal(storage.state().answers, 1);
    assert.equal(storage.state().asks, 0);
    for (const again of ["up", "down"]) {
      await h.send({ type: "receipt_rate", rating: again });
      expectState(h, "note-down");
    }
    assert.equal(posts.length, 1, "a second rating of the same question is ignored");
    assert.equal(storage.state().answers, 1);
  });

  it("racing ratings send one answer and the others hear that the panel is busy", { timeout: 30000 }, async () => {
    const { h, storage } = await asking();
    fetchCtl.mode = "hold";
    const all = Promise.all([h.send({ type: "receipt_rate", rating: "up" }), h.send({ type: "receipt_rate", rating: "down" }), h.send({ type: "receipt_rate", rating: "up" })]);
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(states(h).map((s: any) => [s.step, s.busy]), [["ask", true], ["ask", true]], "the two losers hear busy");
    fetchCtl.held.splice(0).forEach((release) => release(true));
    await all;
    assert.equal(posts.length, 1);
    expectState(h, "note-up");
    assert.equal(storage.state().answers, 1);
  });

  it("a rating that could not be sent is not counted, keeps the question, and can be retried", { timeout: 30000 }, async () => {
    const { h, storage } = await asking();
    for (const mode of ["notok", "throw", "notok"] as const) {
      fetchCtl.mode = mode;
      await h.send({ type: "receipt_rate", rating: "up" });
      expectState(h, "ask", false, RATING_FAILED);
      assert.equal(last(h).error, RATING_FAILED);
      assert.doesNotMatch(JSON.stringify(last(h)), /ECONNRESET|secret|stack|TypeError/);
      assert.equal(storage.state().answers, 0, "a failed send must not count as an answer");
      assert.equal(storage.state().asks, 1, "and must not use up another ask or reset the cycle");
      await h.send({ type: "refresh" });
      assert.equal(stripOf(h.html()), "ask");
    }
    fetchCtl.mode = "ok";
    await h.send({ type: "receipt_rate", rating: "down" });
    expectState(h, "note-down");
    assert.equal(storage.state().answers, 1);
    assert.equal(storage.state().asks, 0);
    assert.equal(posts.length, 4);
    assert.equal(countOf("receipt_rating_shown"), 1, "retries are not new showings");
  });

  it("air-gap switched on between showing and clicking: nothing is sent or counted and the step ends", { timeout: 30000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    const h = openReceipt(RP, "airgap-click");
    await settle();
    assert.equal(stripOf(h.html()), "ask");
    process.env.ANDROMITY_AIRGAP = "1";
    await h.send({ type: "receipt_rate", rating: "up" });
    assert.equal(posts.length, 0);
    assert.equal(last(h).step, "none");
    assert.match(last(h).error, /Air-gap mode is on/);
    assert.equal(storage.state().answers, 0);
    assert.equal(storage.state().asks, 1);
    await h.send({ type: "refresh" });
    assert.equal(stripOf(h.html()), "absent", "the question does not come back while air-gap is on");
    await h.send({ type: "receipt_rate", rating: "down" });
    assert.equal(posts.length, 0);
    delete process.env.ANDROMITY_AIRGAP;
    const again = openReceipt(RP, "airgap-click");
    await settle();
    assert.equal(stripOf(again.html()), "ask", "a later open with air-gap off asks again");
    assert.equal(storage.state().answers, 0);
  });

  it("air-gap switched on between the rating and the note: the note is refused and the step ends", { timeout: 30000 }, async () => {
    const { h } = await asking();
    await h.send({ type: "receipt_rate", rating: "up" });
    posts.length = 0;
    process.env.ANDROMITY_AIRGAP = "1";
    await h.send({ type: "receipt_note", message: "offline" });
    assert.equal(posts.length, 0);
    assert.equal(last(h).step, "none");
    assert.match(last(h).error, /Air-gap mode is on/);
    delete process.env.ANDROMITY_AIRGAP;
    await h.send({ type: "receipt_note", message: "back online" });
    assert.equal(posts.length, 0, "the note step is over");
  });

  it("a rating in flight while the receipt is re-opened still counts once it was sent, and the page learns the new state", { timeout: 30000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    const rpc = fakeRpc();
    const h = openReceipt(RP, "race-open", rpc);
    await settle();
    fetchCtl.mode = "hold";
    const rating = h.send({ type: "receipt_rate", rating: "up" });
    await settle();
    openReceipt(RP, "race-open", rpc);
    await settle();
    assert.equal(stripOf(h.html()), "ask", "the re-open asked again");
    fetchCtl.held.splice(0).forEach((release) => release(true));
    await rating;
    assert.equal(posts.length, 1);
    assert.equal(storage.state().answers, 1, "a sent answer counts whatever happened to the panel");
    assert.equal(storage.state().asks, 0);
    expectState(h, "note-up");

    const storage2 = memento();
    const RP2 = fresh({ storage: storage2 });
    const slow = heldRpc();
    const h2 = openReceipt(RP2, "race-open-2", slow.rpc);
    slow.pending[0].resolve(answer(4));
    await settle();
    assert.equal(stripOf(h2.html()), "ask");
    const rating2 = h2.send({ type: "receipt_rate", rating: "down" });
    await settle();
    openReceipt(RP2, "race-open-2", slow.rpc);
    await settle();
    fetchCtl.held.splice(0).forEach((release) => release(true));
    await rating2;
    assert.equal(storage2.state().answers, 1);
    slow.pending[1].resolve(answer(4));
    await settle();
    assert.equal(stripOf(h2.html()), "absent", "after a counted answer the re-open does not ask again at once");
    expectState(h2, "none");
    assert.equal(posts.length, 2);
  });

  it("a failing rating while the receipt is re-opened leaves the question in place and counts nothing", { timeout: 30000 }, async () => {
    const storage = memento();
    const RP = fresh({ storage });
    const rpc = fakeRpc();
    const h = openReceipt(RP, "race-fail", rpc);
    await settle();
    fetchCtl.mode = "hold";
    const rating = h.send({ type: "receipt_rate", rating: "up" });
    await settle();
    openReceipt(RP, "race-fail", rpc);
    await settle();
    fetchCtl.held.splice(0).forEach((release) => release(false));
    await rating;
    assert.equal(storage.state().answers, 0);
    expectState(h, "ask", false, RATING_FAILED);
  });

  it("receipt_note works only in a note step, and the direction comes from the host, not the message", { timeout: 30000 }, async () => {
    const { h } = await asking();
    await h.send({ type: "receipt_note", message: "too early" });
    assert.equal(posts.length, 0, "no note before a rating");
    expectState(h, "ask");
    await h.send({ type: "receipt_rate", rating: "up" });
    posts.length = 0;
    await h.send({ type: "receipt_note", message: "from the host state", rating: "down", direction: "down", step: "note-down" });
    assert.deepEqual(rated(), ["[receipt note up] from the host state"]);
    expectState(h, "none", false, THANKS);
    assert.equal(last(h).notice, THANKS);
    await h.send({ type: "receipt_note", message: "after success" });
    assert.equal(posts.length, 1, "nothing more after a note was sent");
    expectState(h, "none");
  });

  it("rejects empty, whitespace, non-string and oversized notes with a friendly reply and sends nothing", { timeout: 30000 }, async () => {
    for (const rating of ["up", "down"] as const) {
      const { h } = await asking();
      await h.send({ type: "receipt_rate", rating });
      posts.length = 0;
      const room = MAX_FEEDBACK_LENGTH - ("[receipt note " + rating + "] ").length;
      const bad: unknown[] = ["", "   ", "\n\t\r", "  ", null, undefined, 5, true, {}, ["a"], { toString: () => "x" }, "a".repeat(room + 1), "a".repeat(room + 500), " " + "a".repeat(room + 1)];
      for (const message of bad) {
        const before = states(h).length;
        await h.send({ type: "receipt_note", message });
        assert.equal(states(h).length, before + 1, `a reply for ${label(message).slice(0, 20)}`);
        const reply = last(h);
        assert.equal(reply.step, `note-${rating}`);
        assert.equal(reply.busy, false);
        assert.match(reply.error, /^(Write a note first\.|Please keep it shorter \(now \d+ of 2000 characters\)\.)$/);
        assert.doesNotMatch(JSON.stringify(reply), /Error|stack|undefined|\[object|at .*:\d+/);
      }
      assert.equal(posts.length, 0);
      for (const length of [room, room - 1, 1]) {
        await h.send({ type: "receipt_note", message: ` \n${"b".repeat(length)}\t ` });
        const sentNote = posts.at(-1)!;
        assert.ok(sentNote.body.message.length <= MAX_FEEDBACK_LENGTH, `${rating} ${length}: ${sentNote.body.message.length}`);
        assert.ok(sentNote.raw.length < 16 * 1024);
        h.instance._feedbackStep = "note-" + rating;
      }
      assert.equal(posts.at(-3)!.body.message.length, MAX_FEEDBACK_LENGTH, "the boundary note is accepted exactly at the limit");
    }
  });

  it("a note made of characters that JSON escapes still fits the worker's body limit", { timeout: 30000 }, async () => {
    const { h } = await asking();
    await h.send({ type: "receipt_rate", rating: "down" });
    posts.length = 0;
    await h.send({ type: "receipt_note", message: "\u0001".repeat(1980) });
    assert.equal(posts.length, 1);
    assert.ok(posts[0].raw.length < 16 * 1024, `body is ${posts[0].raw.length} bytes`);
  });

  it("quick repeats of the same note send once, each hears the panel is busy, and the thanks arrives once", { timeout: 30000 }, async () => {
    const { h } = await asking();
    await h.send({ type: "receipt_rate", rating: "up" });
    posts.length = 0;
    const baseline = states(h).length;
    fetchCtl.mode = "hold";
    const first = h.send({ type: "receipt_note", message: "once" });
    const second = h.send({ type: "receipt_note", message: "once" });
    const third = h.send({ type: "receipt_note", message: "once" });
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(states(h).slice(baseline).map((s: any) => [s.step, s.busy]), [["note-up", true], ["note-up", true]]);
    fetchCtl.held.splice(0).forEach((release) => release(true));
    await Promise.all([first, second, third]);
    await h.send({ type: "receipt_note", message: "once" });
    assert.equal(posts.length, 1);
    assert.equal(states(h).filter((s: any) => s.notice === THANKS).length, 1);
    expectState(h, "none");
  });

  it("a failing note keeps the note step, reports a friendly failure, and a retry can succeed", { timeout: 30000 }, async () => {
    const { h } = await asking();
    await h.send({ type: "receipt_rate", rating: "down" });
    posts.length = 0;
    for (const mode of ["notok", "throw"] as const) {
      fetchCtl.mode = mode;
      await h.send({ type: "receipt_note", message: "retry me" });
      expectState(h, "note-down", false, NOTE_FAILED);
      assert.equal(last(h).error, NOTE_FAILED);
      assert.doesNotMatch(JSON.stringify(last(h)), /ECONNRESET|secret|stack|TypeError/);
      await h.send({ type: "refresh" });
      assert.equal(stripOf(h.html()), "note-down");
    }
    fetchCtl.mode = "ok";
    await h.send({ type: "receipt_note", message: "retry me" });
    expectState(h, "none", false, THANKS);
    assert.equal(posts.length, 3);
    await h.send({ type: "refresh" });
    assert.equal(stripOf(h.html()), "absent");
  });

  it("'Don't ask again' is honoured from the question step only, once, and always answered", { timeout: 30000 }, async () => {
    const storage = memento();
    const { h } = await asking(undefined, storage);
    await h.send({ type: "receipt_note_skip" });
    expectState(h, "ask");
    await h.send({ type: "receipt_feedback_never" });
    expectState(h, "none");
    await h.send({ type: "receipt_feedback_never" });
    expectState(h, "none");
    assert.equal(countOf("receipt_rating_off"), 1);
    assert.equal(storage.state().status, "never");
    await h.send({ type: "receipt_rate", rating: "up" });
    assert.equal(posts.length, 0, "a rating after 'Don't ask again' is ignored");
    expectState(h, "none");

    const second = await asking(undefined, memento());
    await second.h.send({ type: "receipt_rate", rating: "up" });
    await second.h.send({ type: "receipt_feedback_never" });
    expectState(second.h, "note-up");
    assert.equal(countOf("receipt_rating_off"), 1, "never is ignored once the note step is reached");
    assert.notEqual(second.storage.state().status, "never");

    const unknown = openReceipt(fresh(), "never-unknown", heldRpc().rpc);
    await settle();
    await unknown.send({ type: "receipt_feedback_never" });
    assert.equal(countOf("receipt_rating_off"), 1, "never is ignored while loading");
    expectState(unknown, "none");
  });

  it("'Don't ask again' while a rating is in flight keeps both honest: the answer counts, the question stays off", { timeout: 30000 }, async () => {
    const { h, storage } = await asking();
    fetchCtl.mode = "hold";
    const rating = h.send({ type: "receipt_rate", rating: "up" });
    await settle();
    await h.send({ type: "receipt_feedback_never" });
    fetchCtl.held.splice(0).forEach((release) => release(true));
    await rating;
    assert.equal(posts.length, 1);
    assert.equal(storage.state().status, "never");
    expectState(h, "none");
    await h.send({ type: "refresh" });
    assert.equal(stripOf(h.html()), "absent");
  });

  it("skip sends nothing more, not even a usage event, and always gets an answer", { timeout: 30000 }, async () => {
    const { h } = await asking();
    await h.send({ type: "receipt_rate", rating: "down" });
    posts.length = 0; rawFeatures.length = 0;
    await h.send({ type: "receipt_note_skip" });
    expectState(h, "none");
    await h.send({ type: "receipt_note", message: "after skip" });
    expectState(h, "none");
    assert.deepEqual(posts, []);
    assert.deepEqual(rawFeatures, []);
    await h.send({ type: "refresh" });
    assert.equal(stripOf(h.html()), "absent");
  });

  it("receipt_feedback_sync reports the real step, changes nothing, and cannot be used to flood storage or telemetry", { timeout: 30000 }, async () => {
    const { h, storage } = await asking();
    const writes = storage.writes.length;
    const events = rawFeatures.length;
    await h.send({ type: "receipt_feedback_sync" });
    expectState(h, "ask");
    for (let i = 0; i < 200; i++) await h.send({ type: "receipt_feedback_sync", step: "none", busy: true, rating: "up" });
    expectState(h, "ask");
    assert.equal(storage.writes.length, writes);
    assert.equal(rawFeatures.length, events);
    assert.equal(posts.length, 0);
    await h.send({ type: "receipt_rate", rating: "up" });
    await h.send({ type: "receipt_feedback_sync" });
    expectState(h, "note-up");
    fetchCtl.mode = "hold";
    const note = h.send({ type: "receipt_note", message: "busy note" });
    await settle();
    await h.send({ type: "receipt_feedback_sync" });
    expectState(h, "note-up", true);
    fetchCtl.held.splice(0).forEach((release) => release(true));
    await note;
    await h.send({ type: "receipt_feedback_sync" });
    expectState(h, "none");
  });

  it("receipt_feedback_sync before a receipt is shown, on an error view or while a refresh is loading says 'none', never 'ask'", { timeout: 30000 }, async () => {
    const RP = fresh({ storage: memento() });
    const slow = heldRpc();
    const loading = openReceipt(RP, "sync-loading", slow.rpc);
    await settle();
    await loading.send({ type: "receipt_feedback_sync" });
    expectState(loading, "none");
    slow.pending[0].resolve({ success: false, error: "No finished turn" });
    await settle();
    await loading.send({ type: "receipt_feedback_sync" });
    expectState(loading, "none");

    const pend: Array<(value: any) => void> = [];
    let hold = false;
    const rpc = fakeRpc((params) => (hold ? new Promise((resolve) => pend.push(resolve)) : answer(params.turn_index ?? 4)));
    const { h } = await asking(undefined, memento(), rpc);
    hold = true;
    const refreshing = h.send({ type: "refresh" });
    await settle();
    await h.send({ type: "receipt_feedback_sync" });
    expectState(h, "none");
    pend[0](answer(4));
    await refreshing;
    await h.send({ type: "receipt_feedback_sync" });
    expectState(h, "ask");
  });

  it("every message that carries no valid question gets a reply or is ignored, and none ever throws", { timeout: 30000 }, async () => {
    const { h } = await asking();
    for (const message of [null, undefined, "receipt_rate", 5, [], {}, { type: null }, { type: {} }, { type: ["receipt_rate"] }, { type: "__proto__" }, { type: "constructor" },
      { type: "toString" }, { type: "receipt_rate", rating: Symbol.iterator }, JSON.parse('{"type":"receipt_note","__proto__":{"message":"x"}}')]) {
      await h.send(message);
    }
    assert.equal(posts.length, 0);
    for (const reply of states(h)) {
      assert.deepEqual(Object.keys(reply).filter((k) => reply[k] !== undefined).sort(), ["busy", "step", "type"]);
    }
  });

  it("messages after the panel is closed never throw and never post to the page, and an answer already in flight is still counted", { timeout: 30000 }, async () => {
    const { h, storage } = await asking();
    fetchCtl.mode = "hold";
    const inflight = h.send({ type: "receipt_rate", rating: "up" });
    await settle();
    h.close();
    fetchCtl.held.splice(0).forEach((release) => release(true));
    await inflight;
    assert.equal(storage.state().answers, 1, "it was sent, so it counts");
    fetchCtl.mode = "ok";
    for (const message of [{ type: "receipt_rate", rating: "up" }, { type: "receipt_note", message: "late" }, { type: "receipt_note_skip" },
      { type: "receipt_feedback_never" }, { type: "receipt_feedback_sync" }, { type: "refresh" }, { type: "copy_text" }, { type: "export_json" }, { type: "open_file", path: "src/app.py" }]) {
      await h.send(message);
    }
    assert.equal(h.vs.posted.length, 0, "nothing may be posted to a closed page");
  });

  it("a webview whose postMessage throws or rejects never breaks the handler", { timeout: 30000 }, async () => {
    const { h } = await asking();
    const original = h.vs.webview.postMessage;
    h.vs.webview.postMessage = () => { throw new Error("Webview is disposed"); };
    await h.send({ type: "receipt_feedback_sync" });
    await h.send({ type: "receipt_rate", rating: "up" });
    h.vs.webview.postMessage = () => Promise.reject(new Error("rejected"));
    const unhandled = await watchRejections(async () => { await h.send({ type: "receipt_feedback_sync" }); await h.send({ type: "receipt_note", message: "x" }); });
    assert.deepEqual(unhandled, [], "a rejected postMessage must be swallowed");
    h.vs.webview.postMessage = original;
  });
});

/* ------------------------------------------------------------------ */
/* 5. The strip's markup (no browser)                                   */
/* ------------------------------------------------------------------ */

describe("strip markup", () => {
  const view = (() => {
    Module.prototype.require = function (this: any, name: string) { return name === "vscode" ? {} : originalRequire.apply(this, arguments); };
    try { return nodeRequire("../src/providers/receipt/receiptView.js"); } finally { Module.prototype.require = originalRequire; }
  })();

  it("is built from constants only and appears only for the ask and note steps", () => {
    for (const step of [undefined, "none", "unknown", "", "ASK", "ask ", "note", "note-up\"><img src=x onerror=alert(1)>", "__proto__", 5, null, {}, ["ask"]]) {
      assert.equal(view.renderFeedbackStrip(step), "", String(step));
    }
    for (const step of ["ask", "note-up", "note-down"]) {
      const html: string = view.renderFeedbackStrip(step);
      assert.match(html, /^<section class="rc-feedback" id="rc-feedback" aria-label="Receipt feedback">/);
      assert.equal((html.match(/<script/g) || []).length, 0);
      assert.doesNotMatch(html, /on\w+\s*=|javascript:|\$\{|undefined|\[object/);
      assert.match(html, /maxlength="1980"/);
      assert.match(html, /role="status" aria-live="polite"/);
    }
    assert.equal(view.renderFeedbackStrip("note-up").includes('data-step="ask" hidden'), true);
    assert.equal(view.renderFeedbackStrip("ask").includes('data-step="note" hidden'), true);
  });

  it("every feedback step leaves the rest of the page intact", () => {
    const base = { sessionName: "S", loading: false, turns: [0, 2], pinned: false,
      response: { success: true, receipt: receipt(2), text: "t", markdown: "m", viewer_id: null, turns: [0, 2] } };
    const plainHtml = view.renderReceiptBody({ ...base, feedback: "none" });
    for (const step of ["ask", "note-up", "note-down", "unknown", undefined, "bogus", "ask\"><script>1</script>"]) {
      const html: string = view.renderReceiptBody({ ...base, feedback: step });
      for (const action of ["copy-text", "copy-markdown", "export-json", "pick-turn", "open-file"]) assert.ok(html.includes(`data-action="${action}"`), `${action} with step ${String(step)}`);
      const stripped = html.replace(/<section class="rc-feedback"[\s\S]*?<\/section>/, "");
      assert.equal(stripped, plainHtml, `step ${String(step)} must change nothing but the strip`);
      assert.doesNotMatch(html, /<script>1<\/script>/);
    }
    const loading = view.renderReceiptBody({ ...base, loading: true, feedback: "ask" });
    assert.doesNotMatch(loading, /rc-feedback/, "never while loading");
    const failed = view.renderReceiptBody({ ...base, response: { success: false, error: "No" }, feedback: "ask" });
    assert.doesNotMatch(failed, /rc-feedback/, "never on an error view");
    const empty = view.renderReceiptBody({ ...base, response: null, feedback: "ask" });
    assert.doesNotMatch(empty, /rc-feedback/, "never on an empty view");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Chat page: receipt_line_shown                                     */
/* ------------------------------------------------------------------ */

class DomNode {
  classes: Set<string>;
  attrs: Record<string, string>;
  children: DomNode[] = [];
  parent: DomNode | null = null;
  previousElementSibling: DomNode | null = null;
  nextElementSibling: DomNode | null = null;
  textContent = "";
  title = "";
  hidden = false;
  type = "";
  constructor(classes: string[], attrs: Record<string, string> = {}) { this.classes = new Set(classes); this.attrs = { ...attrs }; }
  add(...children: DomNode[]) {
    for (const child of children) {
      child.parent = this;
      const last = this.children[this.children.length - 1];
      if (last) { last.nextElementSibling = child; child.previousElementSibling = last; }
      this.children.push(child);
    }
    return this;
  }
  get parentNode() { return this.parent; }
  get className() { return [...this.classes].join(" "); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  set innerHTML(html: string) {
    this.children = [];
    for (const match of html.matchAll(/<span class="([^"]+)"[^>]*>([^<]*)/g)) {
      const child = new DomNode(match[1].split(" "));
      child.textContent = match[2];
      this.add(child);
    }
  }
  insertBefore(node: DomNode, ref: DomNode) { node.parent = this; this.children.splice(this.children.indexOf(ref), 0, node); this.relink(); return node; }
  remove() { const parent = this.parent; if (!parent) return; parent.children = parent.children.filter((c) => c !== this); this.parent = null; parent.relink(); }
  relink() { this.children.forEach((child, i) => { child.previousElementSibling = this.children[i - 1] || null; child.nextElementSibling = this.children[i + 1] || null; }); }
  getAttribute(name: string) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name: string, value: string) { this.attrs[name] = String(value); }
  matches(selector: string): boolean {
    if (selector === ".message-wrap.user:not([data-steering])") return this.classes.has("message-wrap") && this.classes.has("user") && !("data-steering" in this.attrs);
    return selector.startsWith(".") && selector.slice(1).split(".").every((name) => this.classes.has(name));
  }
  closest(selector: string): DomNode | null { for (let node: DomNode | null = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector: string): DomNode[] {
    const found: DomNode[] = [];
    const walk = (node: DomNode) => node.children.forEach((child) => { if (child.matches(selector)) found.push(child); walk(child); });
    walk(this);
    return found;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  compareDocumentPosition(other: DomNode) {
    let root: DomNode = this;
    while (root.parent) root = root.parent;
    const order: DomNode[] = [];
    const walk = (node: DomNode) => { order.push(node); node.children.forEach(walk); };
    walk(root);
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
  get classList() { return { toggle: (name: string, force: boolean) => (force ? this.classes.add(name) : this.classes.delete(name)), contains: (name: string) => this.classes.has(name) }; }
}

describe("chat page: receipt_line_shown", () => {
  const chatScript: string = (() => {
    Module.prototype.require = function (this: any, name: string) {
      return name === "vscode" ? { workspace: { getConfiguration: () => ({ get: (_k: string, f: unknown) => f }) } } : originalRequire.apply(this, arguments);
    };
    try {
      return nodeRequire("../src/providers/chatview/chatClientScript.js").getChatClientScript("icon.svg", {
        currentSessionId: "s1", currentModel: "m", currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
      }).replace(/\r\n/g, "\n");
    } finally { Module.prototype.require = originalRequire; }
  })();
  const key = (n: number) => n.toString(16).padStart(32, "a");
  const worked = (turn: number, extra: Record<string, unknown> = {}) => ({ turn_index: turn, turn_key: key(turn), attention: 0, high: 0, files_changed: 2, commands: 1, commands_failed: 0, ...extra });
  const idle = (turn: number) => ({ turn_index: turn, turn_key: key(turn), attention: 0, high: 0, files_changed: 0, commands: 0, commands_failed: 0 });

  function page(opts: { vscode?: any | null; sessionId?: string; turns?: number } = {}) {
    const container = new DomNode(["chat"]);
    const replies: DomNode[] = [];
    for (let i = 0; i < (opts.turns ?? 3); i++) {
      const button = new DomNode(["msg-copy-btn", "msg-receipt-btn"], { "data-turn-key": key(i) }).add(new DomNode(["msg-action-label"]));
      button.hidden = true;
      const reply = new DomNode(["message-wrap", "assistant"]).add(new DomNode(["message-footer"]).add(button));
      container.add(new DomNode(["message-wrap", "user"], { "data-turn-index": String(i) }), reply);
      replies.push(reply);
    }
    const sent: any[] = [];
    const sandbox: any = {
      chatContainer: container, sessionsState: {}, currentSessionId: opts.sessionId ?? "s1",
      Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, Array, Number, Math, Object, String, Boolean, parseInt, isNaN,
      document: { createElement: () => new DomNode([]) }, FOOTER_RECEIPT_ICON: "<svg></svg>",
    };
    if (opts.vscode !== null) sandbox.vscode = opts.vscode ?? { postMessage: (m: any) => sent.push(m) };
    const start = chatScript.indexOf("function turnIndexForElement");
    const end = chatScript.indexOf("/** Pins the meta strip");
    const readyCase = /case 'receipt_ready': \{[\s\S]*?break; \}/.exec(chatScript);
    assert.ok(start > -1 && end > start && readyCase, "the receipt helpers and the receipt_ready handler must exist");
    vm.createContext(sandbox);
    vm.runInContext(chatScript.slice(start, end) + `\nfunction __onReady(msg) { switch (msg.type) { ${readyCase![0]} } }`, sandbox);
    const lineShown = () => sent.filter((m) => m.feature === "receipt_line_shown");
    return { ctx: sandbox, sent, replies, lineShown };
  }
  const line = (reply: DomNode) => reply.querySelector(".receipt-line");

  it("posts once per session id however many lines, replays and live receipts there are", () => {
    const { ctx, sent, lineShown } = page();
    ctx.rememberReceiptTurns("s1", [worked(0), worked(1, { attention: 2, high: 1 }), worked(2)]);
    for (let i = 0; i < 5; i++) ctx.applyStoredReceiptBadges();
    ctx.rememberReceiptReady({ session_id: "s1", ...worked(2, { commands: 4 }) });
    for (let i = 0; i < 3; i++) ctx.__onReady({ type: "receipt_ready", session_id: "s1", ...worked(1) });
    assert.equal(lineShown().length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(lineShown()[0])), { type: "telemetry_feature", feature: "receipt_line_shown", once: true }, "nothing else rides along");
    assert.equal(sent.filter((m) => m.type !== "telemetry_feature").length, 0, "no other message type is introduced");
  });

  it("posts nothing for a turn that did nothing, a turn not on screen, a receipt for another session, or malformed input", () => {
    const { ctx, sent } = page();
    ctx.rememberReceiptTurns("s1", [idle(0), idle(1), worked(9, { turn_key: key(9) })]);
    ctx.applyStoredReceiptBadges();
    ctx.__onReady({ type: "receipt_ready", session_id: "s1", ...idle(2) });
    ctx.__onReady({ type: "receipt_ready", session_id: "other", ...worked(2) });
    ctx.__onReady({ type: "receipt_ready", session_id: "s1", turn_index: -1 });
    ctx.__onReady({ type: "receipt_ready", session_id: "s1" });
    ctx.__onReady({ type: "receipt_ready" });
    assert.equal(sent.length, 0);
  });

  it("a line that goes away again does not post, and a later real line does", () => {
    const { ctx, replies, lineShown } = page();
    ctx.__onReady({ type: "receipt_ready", session_id: "s1", ...worked(0) });
    assert.equal(lineShown().length, 1);
    ctx.__onReady({ type: "receipt_ready", session_id: "s1", ...idle(0) });
    assert.equal(line(replies[0]), null);
    ctx.__onReady({ type: "receipt_ready", session_id: "s1", ...idle(1) });
    assert.equal(lineShown().length, 1);
  });

  it("posts once more after switching to another session, and not again when switching back", () => {
    const { ctx, lineShown } = page();
    ctx.rememberReceiptTurns("s1", [worked(0)]);
    ctx.rememberReceiptTurns("s2", [worked(1)]);
    ctx.applyStoredReceiptBadges();
    assert.equal(lineShown().length, 1);
    ctx.currentSessionId = "s2";
    ctx.applyStoredReceiptBadges();
    assert.equal(lineShown().length, 2);
    ctx.currentSessionId = "s1";
    ctx.applyStoredReceiptBadges();
    ctx.currentSessionId = "s2";
    ctx.applyStoredReceiptBadges();
    ctx.__onReady({ type: "receipt_ready", session_id: "s2", ...worked(2) });
    assert.equal(lineShown().length, 2);
  });

  it("hostile or empty session ids neither throw nor pollute anything", () => {
    for (const id of ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "", "a".repeat(5000), "x\"y"]) {
      const { ctx, lineShown } = page({ sessionId: id });
      ctx.sessionsState[id === "__proto__" ? "__x" : id] = { receipts: Object.create(null) };
      assert.doesNotThrow(() => { ctx.rememberReceiptReady({ session_id: id, ...worked(0) }); ctx.applyStoredReceiptBadges(); ctx.__onReady({ type: "receipt_ready", session_id: id, ...worked(1) }); }, id);
      assert.ok(lineShown().length <= 1, id);
    }
    assert.equal(({} as any).true, undefined);
    assert.equal((Object.prototype as any).polluted, undefined);
  });

  it("does not throw when vscode is absent, as in a partial sandbox that only runs applyStoredReceiptBadges", () => {
    const { ctx, replies } = page({ vscode: null });
    ctx.rememberReceiptTurns("s1", [worked(0), worked(1), worked(2)]);
    assert.doesNotThrow(() => ctx.applyStoredReceiptBadges());
    for (const reply of replies) assert.ok(line(reply), "every badge is still drawn");
  });

  it("a failing postMessage never stops the receipt lines from being drawn", () => {
    const { ctx, replies } = page({ vscode: { postMessage: () => { throw new Error("channel closed"); } } });
    ctx.rememberReceiptTurns("s1", [worked(0), worked(1), worked(2)]);
    assert.doesNotThrow(() => ctx.applyStoredReceiptBadges());
    for (const reply of replies) assert.ok(line(reply), "every badge is still drawn");
  });

  it("the host counts the event once per session however often the page asks", () => {
    const featureUsage = nodeRequire("../src/telemetry/featureUsage.js");
    const sent: any[] = [];
    const client = { call: async (m: string, p: unknown) => { sent.push({ m, p }); return {}; } };
    featureUsage.setFeatureUsageGate(() => true);
    const host = (message: any, current: string) => featureUsage.recordFeatureUse(String(message.feature), { client, sessionId: message.sessionId || current, oncePerSession: message.once === true });
    const message = { type: "telemetry_feature", feature: "receipt_line_shown", once: true };
    for (let i = 0; i < 4; i++) host(message, "once-s1");
    host(message, "once-s2");
    host(message, "once-s1");
    assert.deepEqual(sent.map((s) => [s.p.feature, s.p.session_id]), [["receipt_line_shown", "once-s1"], ["receipt_line_shown", "once-s2"]]);
  });

  it("the post sits in one helper and is reached only when a line is drawn", () => {
    const posts = [...chatScript.matchAll(/feature: 'receipt_line_shown'/g)].length;
    assert.equal(posts, 1);
    const callers = [...chatScript.matchAll(/noteReceiptLineShown\(\);/g)].length;
    assert.equal(callers, 2, "one call for stored badges and one for the live receipt_ready event");
    for (const m of chatScript.matchAll(/[^\n]*noteReceiptLineShown\(\);/g)) assert.match(m[0], /if \(applyReceiptBadge\(/, "never called unless a line was drawn");
  });
});

describe("documentation claims about where receipts open", () => {
  it("receipt_opened_cmd is recorded in one place only, next to the open, and TELEMETRY.md names the command as it is titled", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk(path.join(EXT, "src"));
    const where = (name: string) => files.filter((f) => { const text = fs.readFileSync(f, "utf8"); return text.includes(`"${name}"`) || text.includes(`'${name}'`); }).map((f) => path.basename(f));
    assert.deepEqual(where("receipt_opened_cmd"), ["extension.ts"]);
    assert.deepEqual(where("receipt_line_shown"), ["chatClientScript.ts"]);
    const callers = files.filter((f) => /ReceiptPanel\.createOrShow\(/.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f)).sort();
    assert.deepEqual(callers, ["ChatViewProvider.ts", "SessionTabPanel.ts", "extension.ts"]);
    const extension = readSource("src/extension.ts");
    assert.match(extension, /recordFeatureUse\("receipt_opened_cmd", \{ sessionId \}\);\s*ReceiptPanel\.createOrShow\(/, "the command records both names: its own, then receipt_opened through createOrShow");

    const doc = fs.readFileSync(path.resolve(EXT, "..", "TELEMETRY.md"), "utf8");
    const claim = /`receipt_opened_cmd` \(([^)]*)\)/.exec(doc)?.[1] || "";
    const pkg = JSON.parse(readSource("package.json"));
    const command = pkg.contributes.commands.find((c: any) => c.command === "andromity.openReceipt");
    assert.ok(command);
    assert.ok(claim.includes(`${command.category}: ${command.title}`), `TELEMETRY.md says "${claim}" but the command is titled "${command.category}: ${command.title}"`);
    assert.ok(!/session list/.test(claim), "the session list no longer claims to open receipts");
    const menus = JSON.stringify(pkg.contributes.menus || {});
    assert.ok(!/session list/.test(claim) || menus.includes("andromity.openReceipt"));
  });

  it("TELEMETRY.md says copy, save and open are counted only on success, and says answers are not usage telemetry", () => {
    const doc = fs.readFileSync(path.resolve(EXT, "..", "TELEMETRY.md"), "utf8");
    assert.match(doc, /Copying, saving and opening a file are counted only when they succeed/);
    assert.match(doc, /Whether anyone answered, and which way, is not sent as usage telemetry/);
    assert.match(doc, /An answer counts only once it has been sent; if it could not be sent, the question stays/);
    assert.match(doc, /Air-gap mode turns the feedback box, the check-in and the receipt question off/);
    assert.match(doc, /Notes, check-ins and receipt answers are sent whether or not telemetry is on/);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Real browser                                                      */
/* ------------------------------------------------------------------ */

function loadPlaywright(): any | null {
  const roaming = process.env.APPDATA || "";
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    path.join(roaming, "npm/node_modules/@playwright/cli/node_modules/playwright-core"),
    path.join(roaming, "npm/node_modules/openclaw/node_modules/playwright-core"),
    "playwright-core",
    "playwright",
  ].filter((value): value is string => !!value);
  for (const candidate of candidates) { try { return nodeRequire(candidate); } catch { /* next */ } }
  return null;
}
function findChromium(): string | undefined {
  if (process.env.EFFORT_CHROME && fs.existsSync(process.env.EFFORT_CHROME)) return process.env.EFFORT_CHROME;
  const local = process.env.LOCALAPPDATA || "";
  const roots = [path.join(local, "ms-playwright"), path.join(process.env.HOME || "", ".cache/ms-playwright")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const dir of dirs) {
      for (const rel of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const candidate = path.join(root, dir, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
const pw = loadPlaywright();
const chromePath = findChromium();
const browserSkip = !pw ? "playwright-core not found (set PLAYWRIGHT_CORE)" : !chromePath ? "no Chromium found (set EFFORT_CHROME)" : false;

const THEMES: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "--vscode-font-family": "'Segoe UI', system-ui, sans-serif", "--vscode-font-size": "13px", "--vscode-editor-font-family": "Consolas, monospace",
    "--vscode-focusBorder": "#0078d4", "--vscode-foreground": "#cccccc", "--vscode-editor-background": "#1f1f1f", "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-panel-border": "#2b2b2b", "--vscode-textLink-foreground": "#4daafc", "--vscode-errorForeground": "#f85149", "--vscode-textCodeBlock-background": "#2b2b2b",
    "--vscode-button-background": "#0078d4", "--vscode-button-foreground": "#ffffff", "--vscode-button-secondaryBackground": "#313131",
    "--vscode-input-background": "#313131", "--vscode-input-foreground": "#cccccc", "--vscode-input-border": "#3c3c3c",
  },
  light: {
    "--vscode-font-family": "'Segoe UI', system-ui, sans-serif", "--vscode-font-size": "13px", "--vscode-editor-font-family": "Consolas, monospace",
    "--vscode-focusBorder": "#005fb8", "--vscode-foreground": "#3b3b3b", "--vscode-editor-background": "#ffffff", "--vscode-descriptionForeground": "#717171",
    "--vscode-panel-border": "#e5e5e5", "--vscode-textLink-foreground": "#005fb8", "--vscode-errorForeground": "#f85149", "--vscode-textCodeBlock-background": "#f2f2f2",
    "--vscode-button-background": "#005fb8", "--vscode-button-foreground": "#ffffff", "--vscode-button-secondaryBackground": "#e5e5e5",
    "--vscode-input-background": "#ffffff", "--vscode-input-foreground": "#3b3b3b", "--vscode-input-border": "#cecece",
  },
};

describe("receipt page in a real browser", { skip: browserSkip }, () => {
  let browser: any;
  const view = (() => {
    Module.prototype.require = function (this: any, name: string) { return name === "vscode" ? {} : originalRequire.apply(this, arguments); };
    try { return nodeRequire("../src/providers/receipt/receiptView.js"); } finally { Module.prototype.require = originalRequire; }
  })();
  before(async () => { browser = await pw.chromium.launch({ executablePath: chromePath, headless: true }); }, { timeout: 90000 });
  after(async () => { if (browser) await browser.close(); }, { timeout: 30000 });

  const state = (feedback: unknown, extra: Record<string, unknown> = {}) => ({
    sessionName: "Fix order rounding", loading: false, turns: [0, 1, 2], pinned: false, feedback,
    response: { success: true, receipt: receipt(2), text: "t", markdown: "m", viewer_id: null, turns: [0, 1, 2] }, ...extra,
  });
  const UP = "What was useful? (optional)";
  const DOWN = "What was missing or confusing? (optional)";
  const THANKS = "Thanks, your note was sent.";

  async function newPage(theme: "dark" | "light" = "dark") {
    const context = await browser.newContext({ viewport: { width: 900, height: 800 }, colorScheme: theme });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
    await page.addInitScript(`window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>{window.__posted.push(JSON.parse(JSON.stringify(m)));if(window.__toHost)window.__toHost(m);}});`);
    let current = "";
    await page.route("http://receipt.test/**", (route: any) => route.fulfill({ contentType: "text/html", body: current }));
    const render = async (html: string) => {
      const css = `<style>:root{${Object.entries(THEMES[theme]).map(([k, v]) => `${k}:${v}`).join(";")}}</style>`;
      current = html.replace("<head>", "<head>" + css).replace("<body>", `<body class="${theme === "dark" ? "vscode-dark" : "vscode-light"}">`);
      await page.goto("http://receipt.test/r?" + Math.random(), { waitUntil: "load" });
    };
    const posted = (): Promise<any[]> => page.evaluate(() => (window as any).__posted);
    const send = (data: unknown) => page.evaluate((d: unknown) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
    return { page, context, errors, render, posted, send, close: () => context.close() };
  }
  type Page = Awaited<ReturnType<typeof newPage>>;
  const renderState = (h: Page, feedback: unknown, extra: Record<string, unknown> = {}) => h.render(view.getReceiptHtml({ cspSource: "vscode-webview:" }, state(feedback, extra)));
  const sans = (messages: any[]) => messages.filter((m) => m.type !== "receipt_feedback_sync");
  const shape = (h: Page) => h.page.evaluate(() => {
    const root = document.getElementById("rc-feedback");
    if (!root) return { present: false } as any;
    const shows = (selector: string) => { const el = root.querySelector(selector) as HTMLElement | null; return !!el && !el.hidden && getComputedStyle(el).display !== "none"; };
    const controls = Array.from(root.querySelectorAll("button, input")) as Array<HTMLButtonElement | HTMLInputElement>;
    return {
      present: true, ask: shows('[data-step="ask"]'), note: shows('[data-step="note"]'),
      label: (document.getElementById("rc-fb-label")?.textContent || "").trim(), status: document.getElementById("rc-fb-status")?.textContent || "",
      allDisabled: controls.every((c) => c.disabled), allEnabled: controls.every((c) => !c.disabled),
      active: document.activeElement?.id || document.activeElement?.getAttribute("data-action") || document.activeElement?.tagName || "",
    };
  });
  async function until(h: Page, check: (s: any) => boolean, what: string, ms = 3000) {
    const end = Date.now() + ms;
    let s: any;
    while (Date.now() < end) { s = await shape(h); if (check(s)) return s; await nap(40); }
    assert.fail(`${what}; last seen ${JSON.stringify(s)}`);
  }

  it("renders and keeps every action working with each feedback step, including bogus ones", { timeout: 120000 }, async () => {
    for (const step of ["ask", "note-up", "note-down", "none", "unknown", undefined, "bogus", "ask\"><script>window.__x=1</script>"]) {
      const h = await newPage();
      try {
        await renderState(h, step);
        const tag = JSON.stringify(step);
        const present = ["ask", "note-up", "note-down"].includes(step as string);
        assert.equal(await h.page.locator("#rc-feedback").count(), present ? 1 : 0, tag);
        assert.equal(await h.page.evaluate(() => (window as any).__x), undefined, tag);
        await h.page.click('[data-action="copy-text"]');
        await h.page.click('[data-action="copy-markdown"]');
        await h.page.click('[data-action="export-json"]');
        await h.page.click('[data-action="open-file"]');
        await h.page.selectOption('[data-action="pick-turn"]', "0");
        await h.page.click('[data-action="turn"]:not([disabled])');
        const messages = await h.posted();
        assert.deepEqual(sans(messages).map((m) => m.type), ["copy_text", "copy_markdown", "export_json", "open_file", "turn", "turn"], tag);
        assert.deepEqual(messages.filter((m) => m.type === "receipt_feedback_sync").length, present ? 1 : 0, `sync is asked for exactly when a strip exists: ${tag}`);
        assert.deepEqual(h.errors, [], tag);
        if (present) {
          const hiddenNow = await h.page.evaluate(() => Array.from(document.querySelectorAll(".rc-fb-step")).map((s) => getComputedStyle(s).display === "none"));
          assert.deepEqual(hiddenNow, step === "ask" ? [false, true] : [true, false], `only one step shows for ${tag}`);
        }
      } finally { await h.close(); }
    }
  });

  it("names every control, announces status politely and orders focus: Useful, Not useful, Don't ask again", { timeout: 60000 }, async () => {
    const h = await newPage();
    try {
      await renderState(h, "ask");
      for (const name of ["Useful", "Not useful", "Don't ask again"]) assert.equal(await h.page.getByRole("button", { name, exact: true }).count(), 1, name);
      assert.equal(await h.page.getByRole("region", { name: "Receipt feedback" }).count(), 1);
      assert.equal(await h.page.locator("#rc-fb-status[role=status][aria-live=polite]").count(), 1);
      await h.page.focus('[data-action="rate-up"]');
      const order: string[] = [];
      for (let i = 0; i < 3; i++) {
        order.push(await h.page.evaluate(() => document.activeElement?.getAttribute("data-action") || document.activeElement?.tagName || ""));
        await h.page.keyboard.press("Tab");
      }
      assert.deepEqual(order, ["rate-up", "rate-down", "rate-never"]);
      assert.equal(await h.page.evaluate(() => (document.activeElement as HTMLElement)?.closest("#rc-feedback") !== null), false, "focus leaves the strip, it does not enter the hidden note step");
      await renderState(h, "note-down");
      assert.equal(await h.page.getByLabel(DOWN).count(), 1, "the note box has a visible label");
      await h.page.focus("#rc-fb-note");
      const noteOrder: string[] = [];
      for (let i = 0; i < 3; i++) {
        noteOrder.push(await h.page.evaluate(() => document.activeElement?.getAttribute("data-action") || document.activeElement?.id || ""));
        await h.page.keyboard.press("Tab");
      }
      assert.deepEqual(noteOrder, ["rc-fb-note", "send-note", "skip-note"]);
    } finally { await h.close(); }
  });

  it("Useful posts one rating and waits for the panel: the strip is disabled, says Sending..., and moves only when told", { timeout: 60000 }, async () => {
    for (const [action, rating, prompt, step] of [["rate-up", "up", UP, "note-up"], ["rate-down", "down", DOWN, "note-down"]]) {
      const h = await newPage();
      try {
        await renderState(h, "ask");
        await h.page.click(`[data-action="${action}"]`);
        assert.deepEqual(sans(await h.posted()), [{ type: "receipt_rate", rating }]);
        let s = await shape(h);
        assert.equal(s.ask, true, "the page must not move on before the panel says so");
        assert.equal(s.note, false);
        assert.equal(s.allDisabled, true);
        assert.equal(s.status, "Sending...");
        await h.page.click(`[data-action="${action}"]`, { force: true }).catch(() => {});
        await h.page.keyboard.press("Enter");
        assert.equal(sans(await h.posted()).length, 1, "a second click or Enter while sending posts nothing");
        await h.send({ type: "receipt_feedback_state", step, busy: false });
        s = await shape(h);
        assert.equal(s.ask, false);
        assert.equal(s.note, true);
        assert.equal(s.label, prompt);
        assert.equal(s.allEnabled, true);
        assert.equal(s.active, "rc-fb-note", "focus moves to the note box once the rating went through");
        assert.equal(s.status, "");
        assert.equal(await h.page.getAttribute("#rc-fb-note", "maxlength"), String(MAX_FEEDBACK_LENGTH - RECEIPT_NOTE_PREFIX_MAX));
        assert.deepEqual(h.errors, []);
      } finally { await h.close(); }
    }
  });

  it("a failed rating puts the question back, enabled, with the reason as plain text", { timeout: 60000 }, async () => {
    const h = await newPage();
    try {
      await renderState(h, "ask");
      await h.page.click('[data-action="rate-up"]');
      const attack = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
      await h.send({ type: "receipt_feedback_state", step: "ask", busy: false, error: attack });
      const s = await shape(h);
      assert.equal(s.ask, true);
      assert.equal(s.allEnabled, true);
      assert.equal(s.status, attack);
      assert.equal(await h.page.locator("#rc-fb-status img, #rc-fb-status b").count(), 0);
      assert.equal(await h.page.evaluate(() => (window as any).__pwned), undefined);
      assert.notEqual(s.active, "BODY", "after a failure the keyboard focus is back inside the strip, not lost on the page body");
    } finally { await h.close(); }
  });

  it("Enter sends the note once however often it is pressed, and after a failure the box is usable again", { timeout: 60000 }, async () => {
    const h = await newPage();
    try {
      await renderState(h, "note-up");
      await h.page.fill("#rc-fb-note", "  hello there  ");
      await h.page.focus("#rc-fb-note");
      await h.page.keyboard.press("Enter");
      await h.page.keyboard.press("Enter");
      await h.page.keyboard.press("Enter");
      const notes = sans(await h.posted()).filter((m) => m.type === "receipt_note");
      assert.equal(notes.length, 1, `Enter pressed three times posted ${notes.length} notes`);
      assert.equal(notes[0].message, "hello there");
      let s = await shape(h);
      assert.equal(s.status, "Sending...");
      assert.equal(s.allDisabled, true);
      await h.send({ type: "receipt_feedback_state", step: "note-up", busy: false, error: "Your note couldn't be sent right now. Try again in a moment." });
      s = await shape(h);
      assert.equal(s.allEnabled, true);
      assert.equal(s.status, "Your note couldn't be sent right now. Try again in a moment.");
      assert.equal(await h.page.inputValue("#rc-fb-note"), "  hello there  ");
      const activeAfterFailure = s.active;
      await h.page.focus("#rc-fb-note");
      await h.page.keyboard.press("Enter");
      assert.equal(sans(await h.posted()).filter((m) => m.type === "receipt_note").length, 2);
      assert.equal(activeAfterFailure, "rc-fb-note", "after a failed send the keyboard focus is back in the note box, not lost on the page body");
    } finally { await h.close(); }
  });

  it("double-clicking Send posts once and an empty note posts nothing", { timeout: 60000 }, async () => {
    const h = await newPage();
    try {
      await renderState(h, "note-down");
      await h.page.click('[data-action="send-note"]');
      await h.page.fill("#rc-fb-note", "   ");
      await h.page.keyboard.press("Enter");
      assert.deepEqual(sans(await h.posted()).filter((m) => m.type === "receipt_note"), []);
      assert.match((await h.page.textContent("#rc-fb-status")) || "", /Write a note first/);
      await h.page.fill("#rc-fb-note", "real note");
      await h.page.dblclick('[data-action="send-note"]');
      assert.equal(sans(await h.posted()).filter((m) => m.type === "receipt_note").length, 1);
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });

  it("shows host text as text only and shrugs off odd or stray state messages", { timeout: 60000 }, async () => {
    const h = await newPage();
    try {
      await renderState(h, "note-up");
      await h.page.fill("#rc-fb-note", "keep me");
      const attack = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
      await h.send({ type: "receipt_feedback_state", step: "note-up", busy: false, error: attack });
      assert.equal((await shape(h)).status, attack);
      assert.equal(await h.page.locator("#rc-fb-status img, #rc-fb-status b").count(), 0);
      assert.equal(await h.page.evaluate(() => (window as any).__pwned), undefined);
      assert.equal(await h.page.inputValue("#rc-fb-note"), "keep me");
      await h.send({ type: "receipt_feedback_state", step: "note-up", busy: false, error: { toString: "x" } });
      assert.equal((await shape(h)).status, "");
      await h.send({ type: "receipt_feedback_state", step: "note-down", busy: "true" });
      let s = await shape(h);
      assert.equal(s.allEnabled, true, "only a real true means busy");
      assert.equal(s.label, DOWN);
      for (const odd of [null, undefined, "receipt_feedback_state", 5, [], {}, { type: "other" }, { type: "receipt_note_result", ok: true }, { type: "receipt_feedback_sync" }]) await h.send(odd);
      assert.deepEqual(h.errors, []);
      s = await shape(h);
      assert.equal(s.present, true, "only a state message may change the strip");
      assert.equal(s.label, DOWN);
    } finally { await h.close(); }
  });

  it("a state message with no strip on the page throws nothing", { timeout: 60000 }, async () => {
    const h = await newPage();
    try {
      await renderState(h, "none");
      for (const step of ["ask", "note-up", "note-down", "none", "weird", null]) await h.send({ type: "receipt_feedback_state", step, busy: true, error: "x", notice: "y" });
      assert.deepEqual(h.errors, []);
      assert.equal(await h.page.locator("#rc-feedback").count(), 0);
      assert.equal((await h.posted()).length, 0, "no sync is asked for when there is no strip");
    } finally { await h.close(); }
  });

  it("'Don't ask again' and Skip close the strip, post once, and leave focus on the receipt, not lost", { timeout: 60000 }, async () => {
    const h = await newPage();
    try {
      await renderState(h, "ask");
      await h.page.focus('[data-action="rate-never"]');
      await h.page.keyboard.press("Enter");
      assert.deepEqual(sans(await h.posted()).map((m) => m.type), ["receipt_feedback_never"]);
      assert.equal(await h.page.locator("#rc-feedback").count(), 0);
      assert.equal(await h.page.evaluate(() => document.activeElement?.classList.contains("rc-main")), true, "focus lands on the receipt");
    } finally { await h.close(); }
    const g = await newPage();
    try {
      await renderState(g, "note-up");
      await g.page.click('[data-action="skip-note"]');
      assert.deepEqual(sans(await g.posted()).map((m) => m.type), ["receipt_note_skip"]);
      assert.equal(await g.page.textContent("#rc-fb-status"), "Thanks for the feedback.");
      await g.page.waitForSelector("#rc-feedback", { state: "detached", timeout: 4000 });
      assert.equal(await g.page.evaluate(() => document.activeElement?.classList.contains("rc-main")), true);
    } finally { await g.close(); }
  });

  it("the muted hint and the link-style buttons are readable in light and dark themes", { timeout: 60000 }, async () => {
    const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a: number[], b: number[]) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    for (const theme of ["dark", "light"] as const) {
      const h = await newPage(theme);
      try {
        await renderState(h, "ask");
        const colors = await h.page.evaluate(() => {
          const rgb = (value: string) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
          const pick = (selector: string) => getComputedStyle(document.querySelector(selector) as Element).color;
          return { bg: rgb(getComputedStyle(document.body).backgroundColor), hint: rgb(pick(".rc-fb-hint")), link: rgb(pick('[data-action="rate-never"]')), question: rgb(pick(".rc-fb-q")), status: rgb(pick("#rc-fb-status")) };
        });
        for (const part of ["hint", "link", "question", "status"] as const) {
          assert.ok(ratio(colors[part], colors.bg) >= 4.5, `${theme}: ${part} contrast ${ratio(colors[part], colors.bg).toFixed(2)}`);
        }
        await h.page.click('[data-action="rate-up"]');
        const dimmed = await h.page.evaluate(() => Array.from(document.querySelectorAll("#rc-feedback button")).map((b) => getComputedStyle(b).opacity));
        assert.ok(dimmed.every((o: string) => Number(o) < 1), `${theme}: disabled strip buttons look disabled (${dimmed.join(",")})`);
        const dimmedColor = await h.page.evaluate(() => { const b = document.querySelector('[data-action="rate-never"]') as HTMLElement; return getComputedStyle(b).color; });
        assert.ok(dimmedColor, "link-style button has a colour while disabled");
      } finally { await h.close(); }
    }
  });

  /** A page wired to a real panel. */
  async function connected(id: string, opts: { dropSync?: boolean; html?: string } = {}) {
    const RP = fresh({ storage: memento() });
    const rpc = fakeRpc();
    const handle = openReceipt(RP, id, rpc);
    await settle();
    const h = await newPage();
    await h.page.exposeFunction("__toHost", (m: any) => { if (opts.dropSync && m?.type === "receipt_feedback_sync") return; void handle.send(m); });
    handle.vs.onPost = (m: unknown) => { void h.send(m); };
    await h.render(opts.html ?? handle.html());
    /** What VS Code does when a hidden, non-retained webview is shown again: rebuild it from the last html the panel set. */
    const rehydrate = async (html?: string) => { await h.render(html ?? handle.html()); };
    return { handle, rpc, h, rehydrate };
  }

  it("works end to end with the real panel: rate, note, failure, retry, thanks", { timeout: 90000 }, async () => {
    const { h, handle } = await connected("e2e-1");
    try {
      await until(h, (s) => s.ask && s.allEnabled, "the question shows");
      await h.page.click('[data-action="rate-up"]');
      await until(h, (s) => s.note && s.allEnabled && s.active === "rc-fb-note", "the note step shows after the rating was sent");
      assert.deepEqual(rated(), ["[receipt up]"]);
      await h.page.fill("#rc-fb-note", "the file list helped");
      fetchCtl.mode = "notok";
      await h.page.keyboard.press("Enter");
      await until(h, (s) => /couldn't be sent/.test(s.status) && s.allEnabled, "the failure shows and the strip comes back");
      fetchCtl.mode = "ok";
      await h.page.click('[data-action="send-note"]');
      await until(h, (s) => s.status === THANKS && !s.note && !s.ask, "thanks shows");
      assert.deepEqual(rated(), ["[receipt up]", "[receipt note up] the file list helped", "[receipt note up] the file list helped"]);
      await h.page.waitForSelector("#rc-feedback", { state: "detached", timeout: 4000 });
      assert.equal(handle.instance._feedbackStep, "none");
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });

  it("over the real panel, Enter pressed three times while the note is being sent reaches the panel once", { timeout: 90000 }, async () => {
    const { h } = await connected("e2e-enter");
    try {
      await until(h, (s) => s.ask && s.allEnabled, "ready");
      await h.page.click('[data-action="rate-up"]');
      await until(h, (s) => s.note && s.allEnabled, "note step");
      await h.page.fill("#rc-fb-note", "enter enter enter");
      await h.page.focus("#rc-fb-note");
      fetchCtl.mode = "hold";
      await h.page.keyboard.press("Enter");
      await h.page.keyboard.press("Enter");
      await h.page.keyboard.press("Enter");
      await nap(150);
      assert.equal(rated().filter((m) => m.startsWith("[receipt note")).length, 1);
      assert.equal(sans(await h.posted()).filter((m) => m.type === "receipt_note").length, 1, "the page itself posts once");
      fetchCtl.held.splice(0).forEach((release) => release(true));
      await until(h, (s) => s.status === THANKS, "thanks");
      assert.equal(rated().filter((m) => m.startsWith("[receipt note")).length, 1);
    } finally { await h.close(); }
  });

  it("a failed rating over the real panel keeps the question and counts nothing; the retry works", { timeout: 90000 }, async () => {
    const { h, handle } = await connected("e2e-2");
    try {
      fetchCtl.mode = "notok";
      await until(h, (s) => s.ask && s.allEnabled, "the question shows");
      await h.page.click('[data-action="rate-down"]');
      await until(h, (s) => s.ask && s.allEnabled && /couldn't be sent/.test(s.status), "the question is back with the reason");
      fetchCtl.mode = "ok";
      await h.page.click('[data-action="rate-down"]');
      await until(h, (s) => s.note && s.label === DOWN, "the note step for Not useful");
      assert.deepEqual(rated(), ["[receipt down]", "[receipt down]"]);
      assert.equal(handle.instance._feedbackStep, "note-down");
    } finally { await h.close(); }
  });

  it("after an answer, rebuilding the page from the panel's older html catches up and shows the note step, not the question", { timeout: 90000 }, async () => {
    const { h, rehydrate, handle } = await connected("hyd-1");
    try {
      await until(h, (s) => s.ask && s.allEnabled, "ready");
      await h.page.click('[data-action="rate-up"]');
      await until(h, (s) => s.note, "answered");
      assert.equal(stripOf(handle.html()), "ask", "the panel's html is older than its state");
      await rehydrate();
      const s = await until(h, (x) => x.note && !x.ask, "the rebuilt page shows the note step");
      assert.equal(s.label, UP);
      assert.equal(s.allEnabled, true);
      await h.page.fill("#rc-fb-note", "still the same direction");
      await h.page.click('[data-action="send-note"]');
      await until(h, (x) => x.status === THANKS, "thanks");
      assert.deepEqual(rated(), ["[receipt up]", "[receipt note up] still the same direction"]);
    } finally { await h.close(); }
  });

  it("after 'Don't ask again', a rebuilt page closes its stale strip", { timeout: 90000 }, async () => {
    const { h, rehydrate, handle } = await connected("hyd-2");
    try {
      await until(h, (s) => s.ask, "ready");
      await h.page.click('[data-action="rate-never"]');
      await h.page.waitForSelector("#rc-feedback", { state: "detached", timeout: 3000 });
      await rehydrate();
      await until(h, (s) => !s.present, "the stale strip is closed after the sync");
      assert.equal(handle.instance._feedbackStep, "none");
      assert.equal(countOf("receipt_rating_off"), 1);
    } finally { await h.close(); }
  });

  it("after a sent note, a rebuilt page closes its stale strip and a click before the sync cannot resend", { timeout: 90000 }, async () => {
    const { h, rehydrate } = await connected("hyd-3");
    try {
      await until(h, (s) => s.ask, "ready");
      await h.page.click('[data-action="rate-down"]');
      await until(h, (s) => s.note, "answered");
      await h.page.fill("#rc-fb-note", "done");
      await h.page.click('[data-action="send-note"]');
      await until(h, (s) => s.status === THANKS, "thanks");
      await rehydrate();
      await until(h, (s) => !s.present, "closed");
      assert.equal(rated().length, 2);
    } finally { await h.close(); }
  });

  it("every older-html and panel-step combination ends on the panel's step, with its direction, and notes go out with that direction", { timeout: 240000 }, async () => {
    const htmlSteps = ["ask", "note-up", "note-down"];
    const hostSteps = ["ask", "note-up", "note-down", "none"];
    for (const htmlStep of htmlSteps) {
      for (const hostStep of hostSteps) {
        posts.length = 0;
        const RP = fresh({ storage: memento() });
        const handle = openReceipt(RP, `mx-${htmlStep}-${hostStep}`);
        await settle();
        handle.instance._feedbackStep = hostStep;
        const h = await newPage();
        try {
          await h.page.exposeFunction("__toHost", (m: any) => { void handle.send(m); });
          handle.vs.onPost = (m: unknown) => { void h.send(m); };
          await renderState(h, htmlStep);
          const tag = `html ${htmlStep} / panel ${hostStep}`;
          if (hostStep === "none") {
            await until(h, (s) => !s.present, `${tag}: the strip closes`);
            continue;
          }
          const want = (s: any) => (hostStep === "ask" ? s.ask && !s.note : s.note && !s.ask && s.label === (hostStep === "note-up" ? UP : DOWN)) && s.allEnabled;
          await until(h, want, `${tag}: the page shows the panel's step`);
          if (hostStep !== "ask") {
            await h.page.fill("#rc-fb-note", "matrix note");
            await h.page.click('[data-action="send-note"]');
            await until(h, (s) => s.status === THANKS, `${tag}: thanks`);
            assert.deepEqual(rated(), [`[receipt note ${hostStep === "note-up" ? "up" : "down"}] matrix note`], tag);
          } else {
            await h.page.click('[data-action="rate-up"]');
            await until(h, (s) => s.note && s.label === UP, `${tag}: rating moves on`);
            assert.deepEqual(rated(), ["[receipt up]"], tag);
          }
          assert.deepEqual(h.errors, [], tag);
        } finally { await h.close(); handle.close(); }
      }
    }
  });

  it("a click made before the sync reply cannot send the opposite direction: the panel's answer wins", { timeout: 90000 }, async () => {
    const { h, handle } = await connected("hyd-race", { dropSync: true });
    try {
      await until(h, (s) => s.ask, "ready");
      handle.instance._feedbackStep = "note-down";
      await h.page.click('[data-action="rate-up"]');
      await until(h, (s) => s.note && s.label === DOWN && s.allEnabled, "the page is corrected to the panel's step");
      assert.deepEqual(rated(), [], "no rating was sent for the stale click");
      await h.page.fill("#rc-fb-note", "which way?");
      await h.page.click('[data-action="send-note"]');
      await until(h, (s) => s.status === THANKS, "thanks");
      assert.deepEqual(rated(), ["[receipt note down] which way?"]);
    } finally { await h.close(); }
  });

  it("a page rebuilt while a rating is in flight is shown disabled, then moves on when it lands", { timeout: 90000 }, async () => {
    const { h, rehydrate, handle } = await connected("hyd-busy");
    try {
      await until(h, (s) => s.ask, "ready");
      fetchCtl.mode = "hold";
      await h.page.click('[data-action="rate-up"]');
      await until(h, (s) => s.allDisabled, "sending");
      await rehydrate();
      await until(h, (s) => s.ask && s.allDisabled, "the rebuilt page is told the panel is busy");
      fetchCtl.held.splice(0).forEach((release) => release(true));
      await until(h, (s) => s.note && s.allEnabled && s.label === UP, "it moves on when the answer lands");
      assert.equal(rated().length, 1);
      assert.equal(handle.instance._busy, false);
    } finally { await h.close(); }
  });

  it("a stale strip on a panel that is loading is closed by the sync", { timeout: 90000 }, async () => {
    const { h, handle } = await connected("hyd-loading");
    try {
      await until(h, (s) => s.ask, "ready");
      handle.instance._loading = true;
      await h.render(handle.html());
      await until(h, (s) => !s.present, "no question for a receipt that is not on screen");
      handle.instance._loading = false;
    } finally { await h.close(); }
  });

  it("a half typed note is lost when the panel re-renders (accepted), but the old text is never sent for the new receipt", { timeout: 90000 }, async () => {
    const { h, handle, rpc, rehydrate } = await connected("hyd-6");
    try {
      await until(h, (s) => s.ask, "ready");
      await h.page.click('[data-action="rate-down"]');
      await until(h, (s) => s.note, "note step");
      await h.page.fill("#rc-fb-note", "half typed note");
      rpc.emit("receipt/ready", { session_id: "hyd-6", turn_index: 4, attention: 0, high: 0 });
      await settle();
      await rehydrate();
      await until(h, (s) => s.note && s.label === DOWN, "the note step comes back");
      assert.equal(await h.page.inputValue("#rc-fb-note"), "");
      await h.page.fill("#rc-fb-note", "fresh note");
      await h.page.click('[data-action="send-note"]');
      await until(h, (s) => s.status === THANKS, "thanks");
      assert.deepEqual(rated(), ["[receipt down]", "[receipt note down] fresh note"]);
      assert.equal(handle.instance._feedbackStep, "none");
    } finally { await h.close(); }
  });

  it("with the real panel Skip still shows its thanks for a moment", { timeout: 90000 }, async () => {
    const { h } = await connected("skip-thanks");
    try {
      await until(h, (s) => s.ask, "ready");
      await h.page.click('[data-action="rate-up"]');
      await until(h, (s) => s.note, "note step");
      await h.page.click('[data-action="skip-note"]');
      await nap(300);
      const s = await shape(h);
      assert.equal(s.present && s.status, "Thanks for the feedback.", "the panel's reply wiped the thanks at once");
    } finally { await h.close(); }
  });
});

describe("the feedback worker accepts what the panel sends", () => {
  it("a rating and the longest note pass the worker's own validation and keep their text", { timeout: 30000 }, async () => {
    const file = path.resolve(EXT, "..", "telemetry-worker", "feedback.js");
    if (!fs.existsSync(file)) return;
    const worker = await import(nodeRequire("node:url").pathToFileURL(file).href);
    const RP = fresh({ storage: memento(), version: "0.2.27" });
    const h = openReceipt(RP, "worker-1");
    await settle();
    await h.send({ type: "receipt_rate", rating: "down" });
    await h.send({ type: "receipt_note", message: "n".repeat(1980) });
    assert.equal(posts.length, 2);
    for (const post of posts) {
      const cleaned = worker.cleanFeedback(post.body, "DE");
      assert.ok(!cleaned.error, `worker rejected ${post.body.message.slice(0, 30)}: ${cleaned.error}`);
      assert.equal(cleaned.values.message, post.body.message, "the worker must store exactly what was sent");
      assert.equal(cleaned.values.version, "0.2.27");
      assert.equal(cleaned.values.client, "vscode");
      assert.ok(post.raw.length < 16 * 1024);
    }
  });
});
