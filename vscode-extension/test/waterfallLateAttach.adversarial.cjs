/**
 * Adversarial tests: the Waterfall opened while a turn is running.
 *
 * Drives the real WaterfallPanel (host side: session.get, trace replay, live queue) wired to the real
 * Waterfall webview script, with a fixed clock and hand-run animation frames.
 * Build first (npm run test:build or npx tsc -p tsconfig.test.json), then: node test/waterfallLateAttach.adversarial.cjs
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const Module = require("module");

const panels = [];
const mockVscode = {
  Uri: {
    joinPath: (...parts) => ({ fsPath: parts.map(p => typeof p === "object" ? (p.fsPath || p.path || "") : p).join("/") }),
    file: (p) => ({ fsPath: p }),
    parse: (s) => ({ toString: () => s }),
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  window: {
    createWebviewPanel: () => { const p = fakePanel(); panels.push(p); return p; },
    showInformationMessage: () => {}, showErrorMessage: () => {}, showSaveDialog: async () => undefined,
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { writeFile: async () => {} } },
  commands: { executeCommand: async () => {} },
  env: { appRoot: "C:/fake/vscode", clipboard: { writeText: async () => {} }, openExternal: async () => true },
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name) {
  if (name === "vscode") return mockVscode;
  return originalRequire.apply(this, arguments);
};
const { WaterfallPanel, WaterfallTraceStore } = require("../dist-test/src/panels/WaterfallPanel.js");
Module.prototype.require = originalRequire;

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const S = 1000;
const sec = (ms) => ms / 1000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const formatMs = (ms) => (!ms || isNaN(ms)) ? "0.00s" : ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(2) + "s";

// ── A webview panel whose page runs the real Waterfall script ───────────────────────────────────────────────────

function fakePanel() {
  let receive = null;
  let onDispose = null;
  const panel = {
    title: "", iconPath: null, posted: [], page: null,
    webview: {
      cspSource: "vscode-webview:",
      asWebviewUri: (u) => "vscode-resource://" + (u.fsPath || String(u)),
      onDidReceiveMessage: (cb) => { receive = cb; return { dispose() {} }; },
      postMessage: (msg) => { panel.posted.push(msg); if (panel.page) panel.page.dispatch(msg); return Promise.resolve(true); },
      set html(value) { setImmediate(() => { panel.page = bootPage(value, panel.clock, (m) => receive && receive(m)); }); },
      get html() { return ""; },
    },
    onDidDispose: (cb) => { onDispose = cb; return { dispose() {} }; },
    reveal() {},
    dispose() { if (panel.disposed) return; panel.disposed = true; if (onDispose) onDispose(); },
  };
  return panel;
}

const pages = [];

function bootPage(html, clock, toHost) {
  const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(match, "the Waterfall page has its script");
  const byId = new Map();
  const listeners = {};
  const frames = [];
  function element(tag, id = "", classes = "") {
    let inner = "";
    let text = "";
    const handlers = {};
    const attrs = {};
    const set = new Set();
    const el = {
      tagName: tag.toUpperCase(), id, dataset: {}, style: {}, children: [], parentNode: null,
      classList: {
        add: (...c) => c.forEach(x => set.add(x)),
        remove: (...c) => c.forEach(x => set.delete(x)),
        toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
        contains: (c) => set.has(c),
      },
      get className() { return [...set].join(" "); },
      set className(v) { set.clear(); String(v || "").split(/\s+/).filter(Boolean).forEach(c => set.add(c)); },
      get innerHTML() { return inner; },
      set innerHTML(v) {
        inner = String(v);
        text = inner.replace(/<[^>]+>/g, "");
        const ids = /id=["']([^"']+)["']/gi;
        let m;
        while ((m = ids.exec(inner)) !== null) if (!byId.has(m[1])) element("div", m[1]);
      },
      get textContent() { return text; },
      set textContent(v) { text = String(v); inner = String(v); },
      addEventListener: (type, cb) => { (handlers[type] = handlers[type] || []).push(cb); },
      removeEventListener: () => {},
      dispatchEvent: (evt) => { for (const cb of handlers[evt.type || evt] || []) cb(evt); },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      removeAttribute: (k) => { delete attrs[k]; },
      appendChild: (child) => { if (child && typeof child === "object") { child.parentNode = el; el.children.push(child); } return child; },
      insertBefore: (child) => { if (child && typeof child === "object") { child.parentNode = el; el.children.push(child); } return child; },
      removeChild: (child) => { el.children = el.children.filter(c => c !== child); return child; },
      remove: () => {},
      querySelectorAll: () => [],
      querySelector: (sel) => element("div", "", String(sel || "").replace(/^[.#]/, "")),
      closest: () => null,
      scrollIntoView: () => {},
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
      scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    };
    String(classes || "").split(/\s+/).filter(Boolean).forEach(c => set.add(c));
    if (id) byId.set(id, el);
    return el;
  }
  const tags = /<([a-z0-9-]+)([^>]*)>/gi;
  let tag;
  while ((tag = tags.exec(html)) !== null) {
    if (/^(script|style)$/i.test(tag[1])) continue;
    const idMatch = tag[2].match(/id=["']([^"']+)["']/i);
    const classMatch = tag[2].match(/class=["']([^"']+)["']/i);
    element(tag[1], idMatch ? idMatch[1] : "", classMatch ? classMatch[1] : "");
  }
  class ClockDate extends Date {
    constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
    static now() { return clock.now; }
  }
  const sandbox = {
    window: {
      addEventListener: (type, cb) => { (listeners[type] = listeners[type] || []).push(cb); },
      removeEventListener: () => {}, innerWidth: 1200, innerHeight: 800,
    },
    document: {
      getElementById: (id) => byId.get(id) || null,
      createElement: (t) => element(t),
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener: () => {}, removeEventListener: () => {},
      body: element("body"),
    },
    acquireVsCodeApi: () => ({ postMessage: (m) => toHost(m), getState: () => ({}), setState: () => {} }),
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date: ClockDate, Math, JSON, Array, Object, Map, Set, String, Number, Boolean, RegExp, Promise,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  new vm.Script(match[1], { filename: "waterfallScript.js" }).runInContext(sandbox);
  const errors = [];
  pages.push(errors);
  return {
    state: () => sandbox.window.__waterfallState,
    byId,
    errors,
    dispatch: (msg) => {
      for (const cb of listeners.message || []) {
        try { cb({ data: msg }); } catch (err) { errors.push(msg.type + ": " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err)); }
      }
    },
    frame: () => { const due = frames.splice(0); for (const cb of due) cb(clock.now); },
  };
}

// ── An engine: RPC events, session.get and the trace store ──────────────────────────────────────────────────────

let sessionCounter = 0;

function engine() {
  const sid = "sess_late_" + (++sessionCounter);
  const clock = { now: T0 };
  const handlers = new Map();
  const db = { id: sid, name: "late", status: "running", model: "m", provider: "p", token_total: 0, messages: [], runtime: { event_seq: 0, is_running: true, tools: [], interactions: [], processes: [], text: "", thinking: "" } };
  let gate = null;
  const snapshots = [];
  const rpc = {
    on: (ev, h) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(h); },
    off: (ev, h) => { handlers.set(ev, (handlers.get(ev) || []).filter(x => x !== h)); },
    call: async (method) => {
      if (method !== "session.get") return {};
      if (gate) await gate.promise;
      return JSON.parse(JSON.stringify(snapshots.length ? snapshots.shift() : db));
    },
  };
  WaterfallTraceStore.init(rpc);
  const env = {
    sid, clock, db, rpc, snapshots,
    emit: (method, params) => { for (const h of [...(handlers.get(method) || [])]) h({ session_id: sid, ...params }); },
    holdSessionGet: () => { let release; const promise = new Promise(r => { release = r; }); gate = { promise, release }; return () => { gate = null; release(); }; },
    async open() {
      const context = { globalState: { get: () => true, update: async () => {} } };
      const before = panels.length;
      const host = WaterfallPanel.createOrShow({ fsPath: "/ext" }, sid, "late", rpc, context);
      const panel = panels[before];
      panel.clock = clock;
      await settle();
      return { host, panel, page: panel.page, state: () => panel.page.state() };
    },
  };
  return env;
}

const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

function priorTurn(env) {
  env.db.messages.push(
    { role: "user", content: "an earlier turn", ts: iso(T0 - 600 * S) },
    { role: "assistant", content: "done", turn_id: "0_1_1", duration: 2, ts: iso(T0 - 598 * S) },
  );
}

/** One finished turn, then a turn that read a file and has run `npm test` since T0+4s. */
function reportedTurn(env, opts = {}) {
  if (!opts.skipPrior) priorTurn(env);
  const record = opts.record !== false;
  const argsA = JSON.stringify({ path: "README.md" });
  const argsX = JSON.stringify({ command: "npm test" });
  const A = call("tA", "read_file", { path: "README.md" });
  const X = call("tX", "shell_exec", { command: "npm test" });
  const t = (s) => sec(T0 + s * S);
  env.db.messages.push(
    { role: "user", content: "fix the build", ts: iso(T0) },
    { role: "assistant", content: null, tool_calls: [A], turn_id: "1_1_1", duration: 2.5, ts: iso(T0 + 2500) },
    { role: "tool", tool_call_id: "tA", content: "readme", ts: iso(T0 + 2600) },
    { role: "assistant", content: null, tool_calls: [X], turn_id: "1_2_1", duration: 4.5, ts: iso(T0 + 4500) },
  );
  env.db.runtime.tools = [{ session_id: env.sid, event_seq: 12, tool_id: "tX", tool_name: "shell_exec", ts: opts.xTs !== undefined ? opts.xTs : t(4), args_json: argsX }];
  if (record) {
    env.emit("agent/started", { prompt: "fix the build", ts: t(0) });
    env.emit("waterfall/llmStart", { turn_id: "1_1_1", model: "m", ts: t(1) });
    env.emit("agent/toolStart", { tool_id: "tA", tool_name: "read_file", ts: t(2) });
    env.emit("agent/toolDelta", { tool_id: "tA", chunk: argsA, ts: t(2) });
    env.emit("agent/toolEnd", { tool_id: "tA", ts: t(2.1) });
    env.emit("waterfall/llmEnd", { turn_id: "1_1_1", duration_ms: 1500, ttfb_ms: 200, total_tokens: 10, ts: t(2.5), tool_calls: [A] });
    env.emit("agent/toolResult", { tool_id: "tA", result: "readme", duration_ms: 30, success: true, ts: t(2.6) });
    env.emit("waterfall/llmStart", { turn_id: "1_2_1", model: "m", ts: t(3) });
    env.emit("agent/toolStart", { tool_id: "tX", tool_name: "shell_exec", ts: t(4) });
    env.emit("agent/toolDelta", { tool_id: "tX", chunk: argsX, ts: t(4) });
    env.emit("agent/toolEnd", { tool_id: "tX", ts: t(4.2) });
    env.emit("waterfall/llmEnd", { turn_id: "1_2_1", duration_ms: 1200, ttfb_ms: 200, total_tokens: 10, ts: t(4.5), tool_calls: [X] });
  }
  return { argsA, argsX };
}

const turnSpans = (state, turnId) => state.turns.get(turnId).spans;
const spansWithId = (state, id) => [...state.turns.values()].flatMap(t => t.spans).filter(s => s.id === id);
const running = (state) => [...state.turns.values()].flatMap(t => t.spans).filter(s => s.status === "running").map(s => s.id);

// ── 6. A tool call saved with no result, in the running turn ────────────────────────────────────────────────────

test("a command running since before the Waterfall opened shows as running from its real start and keeps updating", async () => {
  const env = engine();
  const { argsA, argsX } = reportedTurn(env);
  env.clock.now = T0 + 1120 * S;
  const { page, state, host } = await env.open();
  const x = spansWithId(state(), "tX");
  assert.equal(x.length, 1, "the command is drawn once");
  assert.equal(x[0].status, "running");
  assert.equal(x[0].startTime, T0 + 4 * S, "it started at its tool_start ts");
  assert.equal(x[0].args, argsX, "its arguments are not repeated");
  const a = spansWithId(state(), "tA");
  assert.equal(a.length, 1, "the finished read is drawn once");
  assert.equal(a[0].status, "done");
  assert.equal(a[0].args, argsA);
  assert.equal(turnSpans(state(), "turn_2").filter(s => s.type === "llm").length, 2, "one span per model call");
  page.frame();
  assert.equal(page.byId.get("wf-label-tX").textContent, "1116.00s");
  env.clock.now += 10 * S;
  page.frame();
  assert.equal(page.byId.get("wf-label-tX").textContent, "1126.00s", "the running bar keeps growing");
  host.dispose();
});

test("when the running command's result arrives it closes with the real duration, once", async () => {
  const env = engine();
  reportedTurn(env);
  env.clock.now = T0 + 1120 * S;
  const { page, state, host } = await env.open();
  env.clock.now = T0 + 1130 * S;
  env.emit("agent/toolResult", { tool_id: "tX", result: "passed", duration_ms: 1126000, success: true, ts: sec(env.clock.now) });
  const x = spansWithId(state(), "tX");
  assert.equal(x.length, 1);
  assert.equal(x[0].status, "done");
  assert.equal(x[0].durationMs, 1126000);
  assert.equal(x[0].endTime, env.clock.now);
  page.frame();
  assert.equal(page.byId.get("wf-label-tX").textContent, "1126.00s");
  env.emit("waterfall/llmStart", { turn_id: "1_3_1", model: "m", ts: sec(env.clock.now) });
  env.emit("waterfall/llmEnd", { turn_id: "1_3_1", duration_ms: 900, ts: sec(env.clock.now + 900), response: "fixed" });
  env.emit("agent/done", { ts: sec(env.clock.now + 1000) });
  assert.deepEqual(running(state()), [], "nothing is left running after the turn");
  assert.equal(state().isRunning, false);
  host.dispose();
});

test("a result for a step the Waterfall never saw start does not get an invented 400ms", async () => {
  const env = engine();
  reportedTurn(env);
  env.clock.now = T0 + 1120 * S;
  const { page, state, host } = await env.open();
  env.emit("agent/toolResult", { tool_id: "ghost1", tool_name: "read_file", result: "x", success: true, ts: sec(env.clock.now) });
  env.emit("agent/toolResult", { tool_id: "ghost2", tool_name: "read_file", result: "x", success: true, duration_ms: 0, ts: sec(env.clock.now) });
  for (const id of ["ghost1", "ghost2"]) {
    const g = spansWithId(state(), id)[0];
    assert.ok(g, id + " is drawn");
    assert.notEqual(g.durationMs, 400, id + " has no invented duration");
    page.frame();
    assert.notEqual(page.byId.get("wf-label-" + id).textContent, "400ms");
  }
  host.dispose();
});

test("opening and closing and reopening mid-turn never duplicates spans", async () => {
  const env = engine();
  const { argsX } = reportedTurn(env);
  env.clock.now = T0 + 600 * S;
  const first = await env.open();
  first.host.dispose();
  env.clock.now = T0 + 1120 * S;
  const second = await env.open();
  const x = spansWithId(second.state(), "tX");
  assert.equal(x.length, 1);
  assert.equal(x[0].status, "running");
  assert.equal(x[0].args, argsX);
  assert.equal(turnSpans(second.state(), "turn_2").length, 4, "two model calls, the read and the command");
  second.host.dispose();
});

test("a Waterfall open from the start and one opened mid-turn draw the same spans", async () => {
  const early = engine();
  priorTurn(early);
  early.db.status = "idle";
  early.db.runtime.is_running = false;
  early.clock.now = T0 - 1 * S;
  const earlyPanel = await early.open();
  early.db.status = "running";
  early.db.runtime.is_running = true;
  reportedTurn(early, { skipPrior: true });
  const late = engine();
  reportedTurn(late);
  early.clock.now = late.clock.now = T0 + 1120 * S;
  const latePanel = await late.open();
  const shape = (state) => JSON.parse(JSON.stringify(turnSpans(state, "turn_2").map(s => (s.type === "llm" ? "llm" : s.id) + ":" + s.status + (s.status === "running" ? ":" + s.startTime : ""))));
  assert.deepEqual(shape(latePanel.state()), shape(earlyPanel.state()));
  earlyPanel.host.dispose();
  latePanel.host.dispose();
});

test("cancelling or failing mid-turn closes the late-drawn running command", async () => {
  for (const [method, status] of [["agent/cancelled", "cancelled"], ["agent/error", null]]) {
    const env = engine();
    reportedTurn(env);
    env.clock.now = T0 + 1120 * S;
    const { state, host } = await env.open();
    env.emit(method, { error: "boom", ts: sec(env.clock.now) });
    const x = spansWithId(state(), "tX")[0];
    assert.notEqual(x.status, "running", method + " leaves the command running");
    if (status) assert.equal(x.status, status);
    assert.ok(x.durationMs >= 1116000, method + " keeps the real duration, got " + x.durationMs);
    host.dispose();
  }
});

// ── 7. Nothing stays running when the session is not running ────────────────────────────────────────────────────

test("a session that is not running shows no running span", async () => {
  const env = engine();
  reportedTurn(env, { record: false });
  env.db.status = "interrupted";
  env.db.runtime.is_running = false;
  env.db.runtime.tools = [];
  env.clock.now = T0 + 1120 * S;
  const { state, host } = await env.open();
  assert.deepEqual(running(state()), []);
  assert.equal(state().isRunning, false);
  host.dispose();
});

test("a session that stopped between the two session.get calls leaves nothing running", async () => {
  const env = engine();
  reportedTurn(env);
  env.clock.now = T0 + 1120 * S;
  const runningSnapshot = JSON.parse(JSON.stringify(env.db));
  env.db.status = "idle";
  env.db.runtime.is_running = false;
  env.db.runtime.tools = [];
  env.snapshots.push(runningSnapshot);
  const { state, host, page } = await env.open();
  await settle();
  page.frame();
  assert.deepEqual(running(state()), []);
  host.dispose();
});

test("a tool that finished before the Waterfall opened, whose result the trace store no longer has, does not run forever", async () => {
  const env = engine();
  const A2 = call("tA2", "write_file", { path: "src/a.ts", content: "a" });
  const X = call("tX", "shell_exec", { command: "npm test" });
  env.db.messages.push(
    { role: "user", content: "fix the build", ts: iso(T0) },
    { role: "assistant", content: null, tool_calls: [A2, X], turn_id: "1_1_1", duration: 3, ts: iso(T0 + 3 * S) },
  );
  env.db.runtime.tools = [{ session_id: env.sid, event_seq: 9, tool_id: "tX", tool_name: "shell_exec", ts: sec(T0 + 2 * S), args_json: X.function.arguments }];
  env.clock.now = T0 + 1120 * S;
  const { state, host, page } = await env.open();
  env.emit("agent/toolResult", { tool_id: "tX", result: "passed", duration_ms: 1117000, success: true, ts: sec(env.clock.now) });
  env.emit("agent/done", { ts: sec(env.clock.now) });
  env.clock.now += 60 * S;
  page.frame();
  assert.deepEqual(running(state()), [], "the turn is over, yet these spans still run: " + running(state()).join(", "));
  host.dispose();
});

test("a running turn whose session status is not \"running\" (watching after session_watch) keeps its running tool", async () => {
  const env = engine();
  reportedTurn(env);
  env.db.status = "watching";
  env.clock.now = T0 + 1120 * S;
  const { state, host, page } = await env.open();
  await settle();
  page.frame();
  const x = spansWithId(state(), "tX")[0];
  assert.equal(x.status, "running", "runtime says the turn runs, but the command reads " + x.status + " / " + JSON.stringify(x.result));
  env.emit("agent/toolResult", { tool_id: "tX", result: "passed", duration_ms: 1116000, success: true, ts: sec(env.clock.now) });
  assert.equal(x.durationMs, 1116000);
  host.dispose();
});

// ── Races between session.get and the live stream ───────────────────────────────────────────────────────────────

test("a command that finishes while session.get is in flight closes once with its real duration", async () => {
  const env = engine();
  reportedTurn(env);
  env.clock.now = T0 + 1120 * S;
  const release = env.holdSessionGet();
  const opening = env.open();
  await settle();
  env.emit("agent/toolResult", { tool_id: "tX", result: "passed", duration_ms: 1116000, success: true, ts: sec(env.clock.now) });
  release();
  const { state, host } = await opening;
  await settle();
  const x = spansWithId(state(), "tX");
  assert.equal(x.length, 1);
  assert.equal(x[0].status, "done");
  assert.equal(x[0].durationMs, 1116000);
  host.dispose();
});

test("events that arrive while session.get is in flight are applied once", { todo: "known older bug, not fixed in this branch: events arriving while session.get is in flight are applied twice (fails on dev too)" }, async () => {
  const env = engine();
  reportedTurn(env);
  const resultAt = T0 + 1100 * S;
  env.db.messages.push({ role: "tool", tool_call_id: "tX", content: "passed", ts: iso(resultAt) });
  env.db.runtime.tools = [];
  env.emit("agent/toolResult", { tool_id: "tX", result: "passed", duration_ms: 1096000, success: true, ts: sec(resultAt) });
  env.clock.now = T0 + 1120 * S;
  const release = env.holdSessionGet();
  const opening = env.open();
  await settle();
  env.emit("waterfall/llmStart", { turn_id: "1_3_1", model: "m", ts: sec(env.clock.now) });
  env.emit("agent/textDelta", { text: "Fixed it.", ts: sec(env.clock.now) });
  env.emit("agent/toolStart", { tool_id: "tY", tool_name: "grep_search", ts: sec(env.clock.now) });
  env.emit("agent/toolDelta", { tool_id: "tY", chunk: '{"query":"TODO"}', ts: sec(env.clock.now) });
  release();
  const { state, host } = await opening;
  await settle();
  const y = spansWithId(state(), "tY");
  const llm = spansWithId(state(), "llm_1_3_1");
  const problems = [];
  if (y.length !== 1) problems.push(y.length + " spans for the search");
  else if (y[0].args !== '{"query":"TODO"}') problems.push("search arguments read " + JSON.stringify(y[0].args));
  if (llm.length !== 1) problems.push(llm.length + " spans for the model call");
  else if (llm[0].response !== "Fixed it.") problems.push("model text reads " + JSON.stringify(llm[0].response));
  assert.deepEqual(problems, [], "events streamed during the load were applied twice");
  host.dispose();
});

test("a tool call saved while session.get was in flight keeps its arguments once", { todo: "known older bug, not fixed in this branch: events arriving while session.get is in flight are applied twice (fails on dev too)" }, async () => {
  const env = engine();
  reportedTurn(env, { record: false });
  env.db.messages.pop();
  env.db.runtime.tools = [];
  env.emit("agent/started", { prompt: "fix the build", ts: sec(T0) });
  env.clock.now = T0 + 3 * S;
  const release = env.holdSessionGet();
  const opening = env.open();
  await settle();
  const X = call("tX", "shell_exec", { command: "npm test" });
  env.emit("waterfall/llmStart", { turn_id: "1_2_1", model: "m", ts: sec(T0 + 3 * S) });
  env.emit("agent/toolStart", { tool_id: "tX", tool_name: "shell_exec", ts: sec(T0 + 4 * S) });
  env.emit("agent/toolDelta", { tool_id: "tX", chunk: X.function.arguments, ts: sec(T0 + 4 * S) });
  env.emit("agent/toolEnd", { tool_id: "tX", ts: sec(T0 + 4.2 * S) });
  env.emit("waterfall/llmEnd", { turn_id: "1_2_1", duration_ms: 1200, ts: sec(T0 + 4.5 * S), tool_calls: [X] });
  env.db.messages.push({ role: "assistant", content: null, tool_calls: [X], turn_id: "1_2_1", duration: 4.5, ts: iso(T0 + 4500) });
  env.db.runtime.tools = [{ session_id: env.sid, event_seq: 12, tool_id: "tX", tool_name: "shell_exec", ts: sec(T0 + 4 * S), args_json: X.function.arguments }];
  release();
  const { state, host } = await opening;
  await settle();
  const x = spansWithId(state(), "tX");
  assert.equal(x.length, 1);
  assert.equal(x[0].args, X.function.arguments, "arguments streamed during the load are not doubled");
  assert.equal(x[0].status, "running");
  host.dispose();
});

// ── Odd timestamps and ids ──────────────────────────────────────────────────────────────────────────────────────

for (const [label, xTs] of [
  ["59s ahead of the page's clock", sec(T0 + 1179 * S)],
  ["61s ahead of the page's clock", sec(T0 + 1181 * S)],
  ["real seconds written as text", String(sec(T0 + 4 * S))],
  ["true", true],
  ["just under 1e9", 1e9 - 1],
  ["in the future", sec(T0 + 5000 * S)],
  ["in milliseconds", T0 + 4 * S],
  ["a number written as text", "1"],
  ["negative", -5],
  ["missing", undefined],
  ["a word", "soon"],
]) {
  test(`a running tool whose ts is ${label} still gets a sane start and duration`, async () => {
    const env = engine();
    reportedTurn(env, { xTs, record: false });
    env.clock.now = T0 + 1120 * S;
    const { state, page, host } = await env.open();
    page.frame();
    const x = spansWithId(state(), "tX")[0];
    assert.equal(x.status, "running");
    assert.ok(Number.isFinite(x.startTime), "start " + x.startTime);
    assert.ok(x.startTime >= T0 && x.startTime <= env.clock.now, "start " + new Date(x.startTime).toISOString() + " is outside the turn");
    const label = page.byId.get("wf-label-tX").textContent;
    const shownMs = label.endsWith("ms") ? parseFloat(label) : parseFloat(label) * 1000;
    assert.ok(shownMs >= 0 && shownMs <= 1120 * S, "the bar reads " + label);
    const turnLabel = page.byId.get("wf-turn-dur-turn_2").textContent;
    assert.ok(parseFloat(turnLabel) <= 1121, "the turn reads " + turnLabel);
    host.dispose();
  });
}

test("a tool id reused by the running turn closes the running span, not the earlier turn's", async () => {
  const env = engine();
  const first = call("call_0", "read_file", { path: "a.ts" });
  const again = call("call_0", "shell_exec", { command: "npm test" });
  env.db.messages.push(
    { role: "user", content: "read a", ts: iso(T0 - 600 * S) },
    { role: "assistant", content: null, tool_calls: [first], turn_id: "0_1_1", duration: 1, ts: iso(T0 - 599 * S) },
    { role: "tool", tool_call_id: "call_0", content: "a", ts: iso(T0 - 598 * S) },
    { role: "assistant", content: "read", turn_id: "0_2_1", duration: 3, ts: iso(T0 - 597 * S) },
    { role: "user", content: "test it", ts: iso(T0) },
    { role: "assistant", content: null, tool_calls: [again], turn_id: "1_1_1", duration: 2, ts: iso(T0 + 2 * S) },
  );
  env.db.runtime.tools = [{ session_id: env.sid, event_seq: 4, tool_id: "call_0", tool_name: "shell_exec", ts: sec(T0 + S), args_json: again.function.arguments }];
  env.clock.now = T0 + 1120 * S;
  const { state, host } = await env.open();
  const before = turnSpans(state(), "turn_1").find(s => s.id === "call_0");
  const now = turnSpans(state(), "turn_2").find(s => s.id === "call_0");
  assert.equal(before.status, "done");
  assert.equal(now.status, "running");
  const earlierDuration = before.durationMs;
  env.emit("agent/toolResult", { tool_id: "call_0", result: "passed", duration_ms: 1119000, success: true, ts: sec(env.clock.now) });
  assert.equal(now.status, "done");
  assert.equal(now.durationMs, 1119000);
  assert.equal(before.durationMs, earlierDuration, "the earlier turn's span is untouched");
  host.dispose();
});

test("a running sub-agent opened late shows the same rows as a Waterfall open from the start", async () => {
  const build = (env) => {
    const sub = call("tS", "spawn_subagent", { role: "tester", task: "run the suite" });
    env.db.messages.push(
      { role: "user", content: "test it", ts: iso(T0) },
      { role: "assistant", content: null, tool_calls: [sub], turn_id: "1_1_1", duration: 2, ts: iso(T0 + 2 * S) },
    );
    env.db.runtime.tools = [{ session_id: env.sid, event_seq: 5, tool_id: "tS", tool_name: "spawn_subagent", ts: sec(T0 + S), args_json: sub.function.arguments }];
    env.emit("agent/started", { prompt: "test it", ts: sec(T0) });
    env.emit("waterfall/llmStart", { turn_id: "1_1_1", model: "m", ts: sec(T0 + 0.5 * S) });
    env.emit("agent/toolStart", { tool_id: "tS", tool_name: "spawn_subagent", ts: sec(T0 + S) });
    env.emit("agent/toolDelta", { tool_id: "tS", chunk: sub.function.arguments, ts: sec(T0 + S) });
    env.emit("agent/toolEnd", { tool_id: "tS", ts: sec(T0 + 1.5 * S) });
    env.emit("waterfall/llmEnd", { turn_id: "1_1_1", duration_ms: 1500, ts: sec(T0 + 2 * S), tool_calls: [sub] });
    env.emit("subagent/spawned", { agent_id: "ag1", role: "tester", model: "m", task: "run the suite", ts: sec(T0 + 2.5 * S) });
  };
  const early = engine();
  early.db.status = "idle";
  early.clock.now = T0 - S;
  const earlyPanel = await early.open();
  early.db.status = "running";
  build(early);
  const late = engine();
  build(late);
  early.clock.now = late.clock.now = T0 + 1120 * S;
  const latePanel = await late.open();
  const shape = (state) => JSON.parse(JSON.stringify(turnSpans(state, "turn_1").map(s => (s.type === "llm" ? "llm" : s.id) + ":" + s.status + (s.status === "running" ? ":" + s.startTime : ""))));
  assert.deepEqual(shape(latePanel.state()), shape(earlyPanel.state()));
  earlyPanel.host.dispose();
  latePanel.host.dispose();
});

test("a running tool whose ts is before the turn's prompt is not drawn before the turn",
  { todo: "known older bug, not fixed in this branch: a ts earlier than the turn's prompt is not clamped" }, async () => {
  const env = engine();
  reportedTurn(env, { xTs: 1e9, record: false });
  env.clock.now = T0 + 1120 * S;
  const { state, host } = await env.open();
  const x = spansWithId(state(), "tX")[0];
  assert.ok(x.startTime >= T0, "start " + new Date(x.startTime).toISOString());
  host.dispose();
});

test("a batch-mate that finished before the Waterfall opened takes its real duration from the replayed result", async () => {
  const env = engine();
  const A2 = call("tA2", "write_file", { path: "src/a.ts", content: "a" });
  const X = call("tX", "shell_exec", { command: "npm test" });
  env.db.messages.push(
    { role: "user", content: "fix the build", ts: iso(T0) },
    { role: "assistant", content: null, tool_calls: [A2, X], turn_id: "1_1_1", duration: 3, ts: iso(T0 + 3 * S) },
  );
  env.db.runtime.tools = [{ session_id: env.sid, event_seq: 9, tool_id: "tX", tool_name: "shell_exec", ts: sec(T0 + 2 * S), args_json: X.function.arguments }];
  env.emit("agent/started", { prompt: "fix the build", ts: sec(T0) });
  env.emit("waterfall/llmStart", { turn_id: "1_1_1", model: "m", ts: sec(T0 + 0.5 * S) });
  env.emit("agent/toolStart", { tool_id: "tA2", tool_name: "write_file", ts: sec(T0 + S) });
  env.emit("agent/toolDelta", { tool_id: "tA2", chunk: A2.function.arguments, ts: sec(T0 + S) });
  env.emit("agent/toolEnd", { tool_id: "tA2", ts: sec(T0 + 1.5 * S) });
  env.emit("agent/toolStart", { tool_id: "tX", tool_name: "shell_exec", ts: sec(T0 + 2 * S) });
  env.emit("agent/toolDelta", { tool_id: "tX", chunk: X.function.arguments, ts: sec(T0 + 2 * S) });
  env.emit("agent/toolEnd", { tool_id: "tX", ts: sec(T0 + 2.5 * S) });
  env.emit("waterfall/llmEnd", { turn_id: "1_1_1", duration_ms: 2500, ts: sec(T0 + 3 * S), tool_calls: [A2, X] });
  env.emit("agent/toolResult", { tool_id: "tA2", result: "ok", duration_ms: 3000, success: true, ts: sec(T0 + 6 * S) });
  env.clock.now = T0 + 1120 * S;
  const { state, host } = await env.open();
  const a2 = spansWithId(state(), "tA2");
  assert.equal(a2.length, 1);
  assert.equal(a2[0].status, "done");
  assert.equal(a2[0].durationMs, 3000, "the replayed result says 3000ms, the span says " + a2[0].durationMs + "ms");
  host.dispose();
});

test("an earlier turn's unanswered call that shares an id with the running command does not run forever", async () => {
  const env = engine();
  const first = call("call_0", "read_file", { path: "a.ts" });
  const again = call("call_0", "shell_exec", { command: "npm test" });
  env.db.messages.push(
    { role: "user", content: "read a", ts: iso(T0 - 600 * S) },
    { role: "assistant", content: null, tool_calls: [first], turn_id: "0_1_1", duration: 1, ts: iso(T0 - 599 * S) },
    { role: "user", content: "test it", ts: iso(T0) },
    { role: "assistant", content: null, tool_calls: [again], turn_id: "1_1_1", duration: 2, ts: iso(T0 + 2 * S) },
  );
  env.db.runtime.tools = [{ session_id: env.sid, event_seq: 4, tool_id: "call_0", tool_name: "shell_exec", ts: sec(T0 + S), args_json: again.function.arguments }];
  env.clock.now = T0 + 1120 * S;
  const { state, host, page } = await env.open();
  env.emit("agent/toolResult", { tool_id: "call_0", result: "passed", duration_ms: 1119000, success: true, ts: sec(env.clock.now) });
  env.emit("agent/done", { ts: sec(env.clock.now) });
  env.clock.now += 60 * S;
  page.frame();
  const stillRunning = [...state().turns.values()].flatMap(turn => turn.spans.filter(s => s.status === "running").map(s => turn.id + "/" + s.id));
  assert.deepEqual(stillRunning, [], "the turn is over, yet these spans still run");
  host.dispose();
});

test("a stale running status with a runtime that says idle draws nothing as running", async () => {
  const env = engine();
  reportedTurn(env, { record: false });
  env.db.status = "running";
  env.db.runtime.is_running = false;
  env.clock.now = T0 + 1120 * S;
  const { state, host, page, panel } = await env.open();
  page.frame();
  assert.deepEqual(running(state()), []);
  assert.equal(state().isRunning, false);
  assert.deepEqual(panel.posted.filter(m => m.type === "replay_complete").map(m => m.is_running), [false]);
  host.dispose();
});

test("an engine without runtime keeps the old drawing and closes nothing it should not", async () => {
  const env = engine();
  reportedTurn(env);
  delete env.db.runtime;
  env.clock.now = T0 + 1120 * S;
  const { state, host, panel } = await env.open();
  const x = spansWithId(state(), "tX");
  assert.equal(x.length, 1);
  assert.equal(x[0].status, "done", "no runtime, so nothing says the command still runs");
  const replay = panel.posted.filter(m => m.type === "replay_complete");
  assert.equal(replay.length, 1);
  assert.equal(replay[0].is_running, true, "status running still counts as running without a runtime");
  host.dispose();
});

test("no Waterfall page threw while handling a message", () => {
  assert.deepEqual(pages.flat(), []);
});
