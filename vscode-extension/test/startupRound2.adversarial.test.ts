/**
 * Independent adversarial tests for the round-2 startup changes in the extension:
 *   A. RpcClient: waitForDaemon / markDaemonReady, the 120 s ready limit, slow-call log, close()
 *   B. PythonBridge: first daemon output marks the stdio client ready, the TCP client does not wait
 *   C. ChatViewProvider._loadInitialConfig: late model / provider / skill lists and startup_lists
 *   D. the chat webview's startup_lists handler
 *   E. model picker rows: the hover / focus-within rule that hides the provider badge
 *
 * Written to break the new behaviour, not to pass. Fake timers and fake processes only; no network.
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_READY_WAIT_LIMIT_MS, RpcClient, SLOW_CALL_LOG_MS } from "../src/server/RpcClient.js";
import { loadChat } from "./helpers/chatHarness.js";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";

const vscodeMock: any = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/repo" }, name: "repo" }],
    getWorkspaceFolder: () => undefined,
    isTrusted: true,
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: () => undefined,
      update: async () => {},
    }),
  },
  window: {
    activeTextEditor: undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  languages: { getDiagnostics: () => [] },
  extensions: { getExtension: () => undefined },
  commands: { executeCommand: async () => undefined },
  env: { isTelemetryEnabled: false, appRoot: "", shell: "" },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join("/"), parse: (value: string) => value, file: (fsPath: string) => ({ fsPath }) },
};
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  return name === "vscode" ? vscodeMock : originalRequire.apply(this, arguments);
};
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
const { PythonBridge } = require("../src/server/PythonBridge.js");
Module.prototype.require = originalRequire;
const childProcess = require("child_process");

const flush = async (rounds = 3) => { for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r)); };
const timeoutsAlive = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

function watch<T>(promise: Promise<T>) {
  const state: { status: "pending" | "resolved" | "rejected"; value?: T; error?: any } = { status: "pending" };
  promise.then((value) => { state.status = "resolved"; state.value = value; }, (error) => { state.status = "rejected"; state.error = error; });
  return state;
}

// ---------------------------------------------------------------------------
// A. RpcClient
// ---------------------------------------------------------------------------

function rig(options: { waitForDaemon?: boolean } = {}) {
  const sent: any[] = [];
  const logs: string[] = [];
  const client = new RpcClient((raw) => sent.push(JSON.parse(raw)), { log: (m) => logs.push(m), ...options });
  const reply = (id: any, body: Record<string, unknown>) =>
    client.handleIncomingMessage(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  return { client, sent, logs, reply };
}

describe("RpcClient waitForDaemon (fake timers)", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("sends at once, starts no timer before markDaemonReady, then gives the call its full timeout from that moment", () => {
    const { client, sent } = rig({ waitForDaemon: true });
    const call = watch(client.call("a.b", {}, 1000));
    assert.equal(sent.length, 1, "the request must be written immediately");
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS - 1000);
    assert.equal(call.status, "pending");
    client.markDaemonReady();
    mock.timers.tick(999);
    assert.equal(call.status, "pending");
    mock.timers.tick(1);
    return flush().then(() => {
      assert.equal(call.status, "rejected");
      assert.match(call.error.message, /RPC timeout \(1000ms\) for method: a\.b/);
    });
  });

  it("gives every pending call its own full timeout, not the time left on a shared clock", async () => {
    const { client } = rig({ waitForDaemon: true });
    const short = watch(client.call("short", {}, 500));
    const long = watch(client.call("long", {}, 5000));
    mock.timers.tick(30000);
    client.markDaemonReady();
    mock.timers.tick(499);
    await flush();
    assert.deepEqual([short.status, long.status], ["pending", "pending"]);
    mock.timers.tick(1);
    await flush();
    assert.deepEqual([short.status, long.status], ["rejected", "pending"]);
    mock.timers.tick(4500);
    await flush();
    assert.equal(long.status, "rejected");
  });

  it("a second markDaemonReady does not restart timers that are already running", async () => {
    const { client } = rig({ waitForDaemon: true });
    const first = watch(client.call("first", {}, 1000));
    client.markDaemonReady();
    mock.timers.tick(600);
    const late = watch(client.call("late", {}, 1000));
    client.markDaemonReady();
    client.markDaemonReady();
    mock.timers.tick(400);
    await flush();
    assert.equal(first.status, "rejected", "the first call's timer was pushed back by a repeated markDaemonReady");
    assert.equal(late.status, "pending");
    mock.timers.tick(600);
    await flush();
    assert.equal(late.status, "rejected");
  });

  it("a response that arrives before markDaemonReady resolves the call and leaves nothing to fire afterwards", async () => {
    const { client, sent, reply } = rig({ waitForDaemon: true });
    const call = watch(client.call("fast", {}, 1000));
    reply(sent[0].id, { result: { ok: 1 } });
    await flush();
    assert.deepEqual(call.value, { ok: 1 });
    client.markDaemonReady();
    mock.timers.tick(10 * 60 * 1000);
    await flush();
    assert.equal(call.status, "resolved");
  });

  it("an error response before markDaemonReady rejects with the RPC code and message", async () => {
    const { client, sent, reply } = rig({ waitForDaemon: true });
    const call = watch(client.call("bad", {}, 1000));
    reply(sent[0].id, { error: { code: -32601, message: "Method not found" } });
    await flush();
    assert.equal(call.status, "rejected");
    assert.match(call.error.message, /\[RPC -32601\] Method not found/);
  });

  it("starts the timers anyway after the ready limit, logs it once, and a later markDaemonReady is silent", async () => {
    const { client, logs } = rig({ waitForDaemon: true });
    const call = watch(client.call("m", {}, 1000));
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS - 1);
    assert.equal(logs.filter((l) => l.includes("has not answered")).length, 0);
    mock.timers.tick(1);
    assert.equal(logs.filter((l) => l.includes("has not answered")).length, 1);
    assert.match(logs.find((l) => l.includes("has not answered"))!, /120s/);
    mock.timers.tick(999);
    await flush();
    assert.equal(call.status, "pending");
    mock.timers.tick(1);
    await flush();
    assert.equal(call.status, "rejected");
    client.markDaemonReady();
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS * 2);
    assert.equal(logs.filter((l) => l.includes("has not answered")).length, 1);
  });

  it("calls sent after the ready limit fired get their timer at send time", async () => {
    const { client } = rig({ waitForDaemon: true });
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS);
    const call = watch(client.call("late", {}, 700));
    mock.timers.tick(699);
    await flush();
    assert.equal(call.status, "pending");
    mock.timers.tick(1);
    await flush();
    assert.equal(call.status, "rejected");
  });

  it("markDaemonReady before the limit cancels the limit: no log is written when it would have fired", () => {
    const { client, logs } = rig({ waitForDaemon: true });
    mock.timers.tick(1000);
    client.markDaemonReady();
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS * 3);
    assert.deepEqual(logs, []);
  });

  it("close() before ready rejects every waiting call with the reason, and markDaemonReady afterwards is harmless", async () => {
    const { client, logs } = rig({ waitForDaemon: true });
    const calls = [watch(client.call("a", {}, 1000)), watch(client.call("b", {}, 2000)), watch(client.call("c", {}, 3000))];
    client.close("Daemon exited with code 1");
    await flush();
    assert.deepEqual(calls.map((c) => c.status), ["rejected", "rejected", "rejected"]);
    assert.ok(calls.every((c) => c.error.message === "Daemon exited with code 1"));
    assert.doesNotThrow(() => client.markDaemonReady());
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS * 2);
    assert.deepEqual(logs, [], "the ready-limit timer survived close()");
  });

  it("close() on a ready client rejects calls once and leaves no timeout to reject them again", async () => {
    const { client } = rig();
    const calls = [watch(client.call("a", {}, 1000)), watch(client.call("b", {}, 2000))];
    client.close("bye");
    mock.timers.tick(10000);
    await flush();
    assert.ok(calls.every((c) => c.status === "rejected" && c.error.message === "bye"));
  });

  it("a call made after close() on a client that never became ready still times out instead of hanging forever", async () => {
    const { client } = rig({ waitForDaemon: true });
    client.close("Daemon process error: spawn ENOENT");
    const call = watch(client.call("config.get", {}, 1000));
    mock.timers.tick(1001);
    await flush();
    assert.equal(call.status, "rejected", "the call is still pending: no timer was ever started for it");
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS * 3);
    await flush();
    assert.equal(call.status, "rejected", "still pending after 6 minutes");
  });

  it("the same call on a client without waitForDaemon times out as before (control)", async () => {
    const { client } = rig();
    client.close("closed");
    const call = watch(client.call("config.get", {}, 1000));
    mock.timers.tick(1001);
    await flush();
    assert.equal(call.status, "rejected");
  });

  it("a response for an id whose timer already fired is ignored: no throw, no slow-call log", async () => {
    const { client, sent, reply, logs } = rig();
    const call = watch(client.call("slow", {}, 1000));
    mock.timers.tick(1000);
    await flush();
    assert.equal(call.status, "rejected");
    assert.doesNotThrow(() => reply(sent[0].id, { result: { late: true } }));
    assert.doesNotThrow(() => reply(sent[0].id, { result: { late: true } }));
    assert.deepEqual(logs, []);
  });

  it("responses with a null, unknown or duplicate id never throw or resolve the wrong call", async () => {
    const { client, sent, reply } = rig();
    const call = watch(client.call("x", {}, 1000));
    reply(null, { result: 1 });
    reply(9999, { result: 1 });
    reply("1", { result: "string id" });
    await flush();
    assert.equal(call.status, "pending");
    reply(sent[0].id, { result: "ok" });
    reply(sent[0].id, { result: "again" });
    await flush();
    assert.equal(call.value, "ok");
  });

  it("logs a call that took 5 s or more, from send time, and not one that took less", async () => {
    const { client, sent, reply, logs } = rig();
    const quick = watch(client.call("quick.call", {}, 60000));
    const slow = watch(client.call("slow.call", {}, 60000));
    mock.timers.tick(SLOW_CALL_LOG_MS - 1);
    reply(sent[0].id, { result: 1 });
    assert.deepEqual(logs, []);
    mock.timers.tick(1);
    reply(sent[1].id, { result: 2 });
    await flush();
    assert.deepEqual(logs, ["[Andromity RPC] slow.call took 5.0s."]);
    assert.equal(quick.status, "resolved");
    assert.equal(slow.status, "resolved");
  });

  it("the slow-call time includes the wait for the daemon", async () => {
    const { client, sent, reply, logs } = rig({ waitForDaemon: true });
    watch(client.call("first.call", {}, 30000));
    mock.timers.tick(4000);
    client.markDaemonReady();
    mock.timers.tick(1200);
    reply(sent[0].id, { result: 1 });
    await flush();
    assert.deepEqual(logs, ["[Andromity RPC] first.call took 5.2s."]);
  });

  it("an error response that was slow is logged as slow and still rejects", async () => {
    const { client, sent, reply, logs } = rig();
    const call = watch(client.call("slow.error", {}, 60000));
    mock.timers.tick(6000);
    reply(sent[0].id, { error: { code: -1, message: "nope" } });
    await flush();
    assert.equal(call.status, "rejected");
    assert.deepEqual(logs, ["[Andromity RPC] slow.error took 6.0s."]);
  });

  it("a method name cannot split the slow-call log into several lines", async () => {
    const { client, sent, reply, logs } = rig();
    watch(client.call("evil\n[Andromity] Daemon engine ready\n\u001b[31mred", {}, 60000));
    mock.timers.tick(6000);
    reply(sent[0].id, { result: 1 });
    await flush();
    assert.equal(logs.length, 1);
    assert.ok(!/[\n\r\u001b]/.test(logs[0]), JSON.stringify(logs[0]));
  });

  it("two thousand calls waiting for the daemon each time out exactly once, at their own deadline", async () => {
    const { client } = rig({ waitForDaemon: true });
    const calls = Array.from({ length: 2000 }, (_, i) => watch(client.call(`m${i}`, {}, 100 + i)));
    mock.timers.tick(1000);
    client.markDaemonReady();
    mock.timers.tick(100 + 999);
    await flush();
    assert.equal(calls.filter((c) => c.status === "rejected").length, 1000);
    mock.timers.tick(1000);
    await flush();
    assert.ok(calls.every((c) => c.status === "rejected"));
  });

  it("a client without waitForDaemon starts the timer at send, ignores markDaemonReady, and has no ready limit", async () => {
    const { client, logs } = rig();
    const call = watch(client.call("m", {}, 500));
    client.markDaemonReady();
    mock.timers.tick(499);
    await flush();
    assert.equal(call.status, "pending");
    mock.timers.tick(1);
    await flush();
    assert.equal(call.status, "rejected");
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS * 2);
    assert.deepEqual(logs, []);
  });
});

describe("RpcClient timers do not leak (real timers)", () => {
  it("construct, call, answer, ready and close leave no timer behind in any order", () => {
    const base = timeoutsAlive();
    const scenarios: Array<(r: ReturnType<typeof rig>) => void> = [
      (r) => r.client.markDaemonReady(),
      (r) => r.client.close(),
      (r) => { void r.client.call("a", {}, 60000).catch(() => {}); r.client.close(); },
      (r) => { void r.client.call("a", {}, 60000).catch(() => {}); r.client.markDaemonReady(); r.client.close(); },
      (r) => { void r.client.call("a", {}, 60000).catch(() => {}); r.reply(r.sent[0].id, { result: 1 }); r.client.markDaemonReady(); },
      (r) => { r.client.close(); r.client.markDaemonReady(); r.client.close(); },
      (r) => { void r.client.call("a", {}, 60000).catch(() => {}); r.reply(r.sent[0].id, { error: { code: 1, message: "x" } }); r.client.close(); },
    ];
    for (const scenario of scenarios) {
      const r = rig({ waitForDaemon: true });
      scenario(r);
      assert.equal(timeoutsAlive(), base, `a timer outlived scenario ${scenario}`);
    }
  });

  it("a client without waitForDaemon never holds the process open", () => {
    const base = timeoutsAlive();
    const r = rig();
    assert.equal(timeoutsAlive(), base);
    r.client.close();
  });
});

// ---------------------------------------------------------------------------
// B. PythonBridge
// ---------------------------------------------------------------------------

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinWrites: string[] = [];
  stdin = { destroyed: false, write: (m: string) => { this.stdinWrites.push(m); return true; } };
  pid = 4242;
  killed = false;
  kill() { this.killed = true; return true; }
}

describe("PythonBridge stdio client readiness", () => {
  let realSpawn: any;
  let proc: FakeProcess;
  let bridge: any;
  const log: string[] = [];

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    realSpawn = childProcess.spawn;
    proc = new FakeProcess();
    childProcess.spawn = () => proc;
    log.length = 0;
    bridge = new PythonBridge({ appendLine: (m: string) => log.push(m), append: () => {}, show() {} } as any);
    bridge._isDisposed = true;
  });

  afterEach(() => {
    proc.emit("exit", 0, null);
    childProcess.spawn = realSpawn;
    mock.timers.reset();
  });

  const spawn = async () => bridge._spawnDaemon("python", ["--stdio"], "/repo", {}) as Promise<RpcClient>;

  it("keeps request timeouts waiting while the daemon is silent", async () => {
    const client = await spawn();
    const call = watch(client.call("config.get", {}, 1000));
    mock.timers.tick(60000);
    await flush();
    assert.equal(call.status, "pending");
    assert.equal(proc.stdinWrites.length, 1, "the request was not written to the daemon");
  });

  it("the first stdout bytes start the timeouts", async () => {
    const client = await spawn();
    const call = watch(client.call("config.get", {}, 1000));
    proc.stdout.emit("data", Buffer.from("not even json yet"));
    mock.timers.tick(1000);
    await flush();
    assert.equal(call.status, "rejected");
  });

  it("the first stderr bytes start the timeouts", async () => {
    const client = await spawn();
    const call = watch(client.call("config.get", {}, 1000));
    proc.stderr.emit("data", Buffer.from("2026 [INFO] andromity.server: Starting\n"));
    mock.timers.tick(1000);
    await flush();
    assert.equal(call.status, "rejected");
  });

  it("a reply that is the very first output resolves the call and is not rejected later", async () => {
    const client = await spawn();
    const call = watch(client.call("config.get", {}, 1000));
    const id = JSON.parse(proc.stdinWrites[0]).id;
    proc.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { fine: true } }) + "\n"));
    mock.timers.tick(60000);
    await flush();
    assert.equal(call.status, "resolved");
  });

  it("a multi-byte character split across the first chunks does not break readiness or the reply", async () => {
    const client = await spawn();
    const call = watch(client.call("config.get", {}, 1000));
    const id = JSON.parse(proc.stdinWrites[0]).id;
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { name: "héllo 世界" } }) + "\n");
    const cut = bytes.indexOf(0xc3) + 1;
    proc.stdout.emit("data", bytes.subarray(0, cut));
    proc.stdout.emit("data", bytes.subarray(cut));
    await flush();
    assert.deepEqual(call.value, { name: "héllo 世界" });
  });

  it("an engine that has said nothing for the whole ready limit stops being waited for", async () => {
    const client = await spawn();
    const call = watch(client.call("config.get", {}, 1000));
    mock.timers.tick(DAEMON_READY_WAIT_LIMIT_MS);
    await flush();
    assert.ok(log.some((l) => l.includes("has not answered after 120s")));
    assert.equal(call.status, "pending");
    mock.timers.tick(999);
    await flush();
    assert.equal(call.status, "pending");
    mock.timers.tick(1);
    await flush();
    assert.equal(call.status, "rejected");
  });

  it("a daemon that dies before printing anything rejects what was waiting", async () => {
    const client = await spawn();
    const call = watch(client.call("config.get", {}, 1000));
    proc.emit("error", new Error("spawn ENOENT"));
    await flush();
    assert.equal(call.status, "rejected");
    assert.match(call.error.message, /Daemon process error: spawn ENOENT/);
  });

  it("after the daemon died silently, later calls on that client do not hang for ever", async () => {
    const client = await spawn();
    proc.emit("exit", 1, null);
    const call = watch(client.call("config.get", {}, 1000));
    mock.timers.tick(1001);
    await flush();
    assert.equal(call.status, "rejected", "a call on the dead client never settles");
  });

  it("after a spawn error, later calls on that client do not hang for ever", async () => {
    const client = await spawn();
    proc.emit("error", new Error("spawn EACCES"));
    const call = watch(client.call("config.get", {}, 1000));
    mock.timers.tick(1001);
    await flush();
    assert.equal(call.status, "rejected", "a call on the dead client never settles");
  });

  it("only the stdio client waits; the TCP client is built without waitForDaemon", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "server", "PythonBridge.ts"), "utf8");
    const constructions = source.match(/new RpcClient\([\s\S]*?\}\);/g) || [];
    assert.equal(constructions.length, 2, "expected exactly the stdio and TCP clients");
    const waiting = constructions.filter((c) => c.includes("waitForDaemon"));
    assert.equal(waiting.length, 1);
    assert.ok(waiting[0].includes("proc.stdin"), "waitForDaemon must only be on the stdio client");
    assert.ok(source.includes("client.markDaemonReady()"));
  });
});

// ---------------------------------------------------------------------------
// C. ChatViewProvider._loadInitialConfig
// ---------------------------------------------------------------------------

const LATE_MS = 2500;

interface Waiter { resolve: (v: any) => void; reject: (e: any) => void }

class FakeRpc {
  calls: Array<{ method: string; params: any }> = [];
  held = new Set<string>();
  waiters = new Map<string, Waiter[]>();
  results: Record<string, any> = {
    "config.get": { default_provider: "andromity", default_model: "auto", pinned_models: [] },
    "session.list": [{ id: "s1", name: "Session one", message_count: 2 }],
    "trust.status": { is_trusted: true },
    "session.get": { id: "s1", name: "Session one", messages: [], runtime: { event_seq: 0 } },
    "config.list_models": [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
    "config.list_providers": [{ id: "openai", name: "OpenAI", has_key: true }],
    "skills.list": [{ name: "review", description: "Review code" }],
  };

  call = (method: string, params: any) => {
    this.calls.push({ method, params });
    if (this.held.has(method)) {
      return new Promise<any>((resolve, reject) => {
        const list = this.waiters.get(method) ?? [];
        list.push({ resolve, reject });
        this.waiters.set(method, list);
      });
    }
    return Promise.resolve(this.results[method] ?? {});
  };
  on() {}
  off() {}

  release(method: string, value?: any) {
    const list = this.waiters.get(method) ?? [];
    this.waiters.delete(method);
    for (const w of list) w.resolve(value === undefined ? this.results[method] : value);
  }
  fail(method: string, error: Error = new Error("RPC timeout (30000ms)")) {
    const list = this.waiters.get(method) ?? [];
    this.waiters.delete(method);
    for (const w of list) w.reject(error);
  }
  count(method: string) { return this.calls.filter((c) => c.method === method).length; }
}

function memento(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => { store.set(key, value); },
  };
}

function makeProvider(rpc: FakeRpc = new FakeRpc()) {
  const posted: any[] = [];
  const p: any = new ChatViewProvider({ fsPath: "ext" } as any, undefined);
  p._context = { globalState: memento(), workspaceState: memento(), subscriptions: [], secrets: { get: async () => undefined } };
  p._view = { webview: { postMessage: () => true }, visible: true };
  p._webviewReady = true;
  p._rpcClient = rpc;
  p._postToWebview = (m: any) => { posted.push(m); };
  p._refreshOllamaDetection = () => Promise.resolve();
  p.fetchUsage = async () => ({});
  p._persistLastActiveSession = () => {};
  return { p, rpc, posted, of: (type: string) => posted.filter((m) => m.type === type) };
}

describe("ChatViewProvider startup lists", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  async function loadSlow(h: ReturnType<typeof makeProvider>, hold = ["config.list_models", "config.list_providers", "skills.list"]) {
    for (const m of hold) h.rpc.held.add(m);
    const load = h.p._loadInitialConfig(true) as Promise<void>;
    await flush();
    mock.timers.tick(LATE_MS - 1);
    await flush();
    assert.equal(h.of("init_state").length, 0, "init_state was posted before the lists wait ran out");
    mock.timers.tick(1);
    await load;
    return load;
  }

  it("control: fast lists are in init_state and no startup_lists follows", async () => {
    const h = makeProvider();
    await h.p._loadInitialConfig(true);
    await flush();
    const init = h.of("init_state")[0];
    assert.deepEqual(init.models.map((m: any) => m.id), ["auto", "gpt-4o"]);
    assert.deepEqual(init.providers.map((p: any) => p.id), ["andromity", "openai"]);
    assert.deepEqual(init.skills, [{ name: "review", description: "Review code" }]);
    assert.equal(h.of("startup_lists").length, 0);
  });

  it("late lists: init_state still goes out at 2.5 s with the Andromity Auto defaults, then startup_lists follows", async () => {
    const h = makeProvider();
    await loadSlow(h);
    await flush();
    const init = h.of("init_state")[0];
    assert.ok(init, "init_state was never posted");
    assert.deepEqual(init.models.map((m: any) => `${m.provider}/${m.id}`), ["andromity/auto"]);
    assert.deepEqual(init.providers.map((p: any) => p.id), ["andromity"]);
    assert.deepEqual(init.skills, []);
    assert.equal(h.of("startup_lists").length, 0);

    h.rpc.release("config.list_models");
    h.rpc.release("config.list_providers");
    h.rpc.release("skills.list");
    await flush();
    const late = h.of("startup_lists");
    assert.equal(late.length, 1);
    assert.deepEqual(late[0].models.map((m: any) => `${m.provider}/${m.id}`), ["andromity/auto", "openai/gpt-4o"]);
    assert.deepEqual(late[0].providers.map((p: any) => p.id), ["andromity", "openai"]);
    assert.deepEqual(late[0].skills, [{ name: "review", description: "Review code" }]);
    const order = h.posted.map((m) => m.type);
    assert.ok(order.indexOf("init_state") < order.indexOf("startup_lists"));
  });

  it("design: one slow list (models) must not discard the other two lists that had already arrived", async () => {
    const h = makeProvider();
    h.rpc.held.add("config.list_models");
    const load = h.p._loadInitialConfig(true) as Promise<void>;
    await flush();
    mock.timers.tick(LATE_MS);
    await load;
    const init = h.of("init_state")[0];
    assert.deepEqual(init.providers.map((p: any) => p.id), ["andromity", "openai"], "the finished provider list was thrown away instead of used");
    assert.deepEqual(init.skills, [{ name: "review", description: "Review code" }], "the finished skills list was thrown away instead of used");
  });

  it("lists that arrive before init_state is posted must not be undone by init_state", async () => {
    const h = makeProvider();
    h.rpc.held.add("session.get");
    for (const m of ["config.list_models", "config.list_providers", "skills.list"]) h.rpc.held.add(m);
    const load = h.p._loadInitialConfig(true) as Promise<void>;
    await flush();
    mock.timers.tick(LATE_MS);
    await flush();
    h.rpc.release("config.list_models");
    h.rpc.release("config.list_providers");
    h.rpc.release("skills.list");
    await flush();
    assert.equal(h.rpc.count("session.get"), 1, "the session load should be in flight");
    assert.equal(h.of("startup_lists").length, 0, "late lists are only posted after init_state");
    assert.equal(h.of("init_state").length, 0);
    h.rpc.release("session.get");
    await load;

    const page = loadChat();
    for (const m of h.posted) page.post(m);
    const skills = page.eval("allSkills") as any[];
    const models = page.eval("allModels") as any[];
    const providers = page.eval("allProviders") as any[];
    assert.deepEqual(models.map((m: any) => m.id), ["auto", "gpt-4o"]);
    assert.deepEqual(providers.map((p: any) => p.id), ["andromity", "openai"]);
    assert.deepEqual(skills.map((s: any) => s.name), ["review"], "the skills list arrived, then init_state replaced it with an empty one");
  });

  it("a newer load supersedes the lists of an older one that arrive later", async () => {
    const h = makeProvider();
    await loadSlow(h);
    h.rpc.held.clear();
    h.rpc.results["config.list_models"] = [{ id: "fresh-model", name: "Fresh", provider: "openai" }];
    h.rpc.results["config.list_providers"] = [{ id: "openai", name: "OpenAI", has_key: true }, { id: "groq", name: "Groq", has_key: true }];
    await h.p._loadInitialConfig(true);
    await flush();
    const before = h.posted.length;
    const modelsAfterSecondLoad = h.p._models.map((m: any) => m.id);
    h.rpc.release("config.list_models", [{ id: "stale-model", name: "Stale", provider: "openai" }]);
    h.rpc.release("config.list_providers", [{ id: "stale", name: "Stale", has_key: false }]);
    h.rpc.release("skills.list", [{ name: "stale-skill" }]);
    await flush();
    assert.equal(h.posted.slice(before).filter((m) => m.type === "startup_lists").length, 0);
    assert.deepEqual(h.p._models.map((m: any) => m.id), modelsAfterSecondLoad);
    assert.ok(!h.p._providers.some((p: any) => p.id === "stale"));
  });

  it("while a newer load is itself still waiting, the older late lists are ignored and the newer ones are applied", async () => {
    const h = makeProvider();
    await loadSlow(h);
    const second = h.p._loadInitialConfig(true) as Promise<void>;
    await flush();
    mock.timers.tick(LATE_MS);
    await second;
    const before = h.posted.length;
    h.rpc.waiters.get("config.list_models")![0].resolve([{ id: "from-first", provider: "openai", name: "first" }]);
    h.rpc.waiters.get("config.list_providers")![0].resolve([{ id: "first", name: "first", has_key: true }]);
    h.rpc.waiters.get("skills.list")![0].resolve([{ name: "first" }]);
    await flush();
    assert.equal(h.posted.slice(before).filter((m) => m.type === "startup_lists").length, 0, "a superseded load posted its lists");
    h.rpc.waiters.get("config.list_models")![1].resolve([{ id: "from-second", provider: "openai", name: "second" }]);
    h.rpc.waiters.get("config.list_providers")![1].resolve([{ id: "second", name: "second", has_key: true }]);
    h.rpc.waiters.get("skills.list")![1].resolve([{ name: "second" }]);
    await flush();
    const late = h.posted.slice(before).filter((m) => m.type === "startup_lists");
    assert.equal(late.length, 1);
    assert.ok(late[0].models.some((m: any) => m.id === "from-second"));
    assert.ok(!late[0].models.some((m: any) => m.id === "from-first"));
  });

  it("lists from a client that has since been replaced are dropped", async () => {
    const h = makeProvider();
    await loadSlow(h);
    const before = h.posted.length;
    const replacement = new FakeRpc();
    h.p._rpcClient = replacement;
    const modelsBefore = h.p._models.map((m: any) => m.id);
    h.rpc.release("config.list_models");
    h.rpc.release("config.list_providers");
    h.rpc.release("skills.list");
    await flush();
    assert.equal(h.posted.slice(before).filter((m) => m.type === "startup_lists").length, 0);
    assert.deepEqual(h.p._models.map((m: any) => m.id), modelsBefore);
  });

  it("lists from a client that was replaced and then put back are still posted only once", async () => {
    const h = makeProvider();
    await loadSlow(h);
    const original = h.p._rpcClient;
    h.p._rpcClient = new FakeRpc();
    h.p._rpcClient = original;
    h.rpc.release("config.list_models");
    h.rpc.release("config.list_providers");
    h.rpc.release("skills.list");
    await flush();
    assert.equal(h.of("startup_lists").length, 1);
  });

  for (const how of ["rejects", "returns an empty list"] as const) {
    it(`a late list call that ${how} must not replace a model and provider list that was already known`, async () => {
      const h = makeProvider();
      await h.p._loadInitialConfig(true);
      await flush();
      assert.ok(h.p._models.some((m: any) => m.id === "gpt-4o"));
      const rememberedModels = h.p._models.map((m: any) => m.id);
      const rememberedProviders = h.p._providers.map((p: any) => p.id);

      for (const m of ["config.list_models", "config.list_providers", "skills.list"]) h.rpc.held.add(m);
      const load = h.p._loadInitialConfig(true) as Promise<void>;
      await flush();
      mock.timers.tick(LATE_MS);
      await load;
      const before = h.posted.length;
      for (const m of ["config.list_models", "config.list_providers", "skills.list"]) {
        if (how === "rejects") h.rpc.fail(m); else h.rpc.release(m, []);
      }
      await flush();
      assert.deepEqual(h.p._models.map((m: any) => m.id), rememberedModels, "the known model list was replaced by an empty result");
      assert.deepEqual(h.p._providers.map((p: any) => p.id), rememberedProviders);
      const late = h.posted.slice(before).filter((m) => m.type === "startup_lists");
      for (const message of late) {
        assert.ok(message.models.some((m: any) => m.id === "gpt-4o"), "startup_lists carried a list without the known models");
      }
    });
  }

  it("an empty late result still leaves Andromity Auto in both lists", async () => {
    const h = makeProvider();
    await loadSlow(h);
    h.rpc.release("config.list_models", []);
    h.rpc.release("config.list_providers", []);
    h.rpc.release("skills.list", []);
    await flush();
    assert.deepEqual(h.p._models.map((m: any) => `${m.provider}/${m.id}`), ["andromity/auto"]);
    assert.deepEqual(h.p._providers.map((p: any) => p.id), ["andromity"]);
  });

  it("an Ollama model found before the late lists is put back after them", async () => {
    const h = makeProvider();
    h.p._lastOllamaStatus = { running: true, installed: true, models: ["llama3.2:3b"], bestModel: "llama3.2:3b", bestLocalModel: "llama3.2:3b", host: "http://127.0.0.1:11434" };
    await loadSlow(h);
    assert.ok(h.of("init_state")[0].models.some((m: any) => m.id === "llama3.2:3b"), "known Ollama model missing from init_state");
    h.rpc.release("config.list_models");
    h.rpc.release("config.list_providers");
    h.rpc.release("skills.list");
    await flush();
    const late = h.of("startup_lists")[0];
    assert.ok(late.models.some((m: any) => m.id === "llama3.2:3b" && m.provider === "ollama"));
    assert.equal(late.models.filter((m: any) => m.id === "llama3.2:3b").length, 1, "the Ollama model was listed twice");
  });

  it("the Ollama model the user is actually on survives the late lists even when it is not the best model", async () => {
    const h = makeProvider();
    h.rpc.results["config.get"] = { default_provider: "ollama", default_model: "mistral:7b", pinned_models: [] };
    h.p._lastOllamaStatus = { running: true, installed: true, models: ["mistral:7b", "llama3.2:3b"], bestModel: "llama3.2:3b", bestLocalModel: "llama3.2:3b", host: "http://127.0.0.1:11434" };
    await loadSlow(h);
    h.p._addOllamaModel("mistral:7b");
    h.rpc.release("config.list_models");
    h.rpc.release("config.list_providers");
    h.rpc.release("skills.list");
    await flush();
    const late = h.of("startup_lists")[0];
    assert.equal(h.p._currentProvider, "ollama");
    assert.ok(late.models.some((m: any) => m.id === "mistral:7b" && m.provider === "ollama"), "the Ollama model in use disappeared from the picker");
  });

  it("a provider-model refresh the user triggered before the late lists arrived is not overwritten by them", async () => {
    const h = makeProvider();
    await loadSlow(h);
    h.rpc.results["config.refresh_provider_models"] = { ok: true, models: [{ id: "gpt-brand-new", name: "Brand New", provider: "openai" }] };
    await h.p._handleWebviewMessage({ type: "refresh_provider_models", provider: "openai" });
    assert.ok(h.p._models.some((m: any) => m.id === "gpt-brand-new"));
    h.rpc.release("config.list_models", [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }]);
    h.rpc.release("config.list_providers");
    h.rpc.release("skills.list");
    await flush();
    assert.ok(h.p._models.some((m: any) => m.id === "gpt-brand-new"), "the refreshed model list was replaced by the stale startup list");
    for (const message of h.of("startup_lists")) {
      assert.ok(message.models.some((m: any) => m.id === "gpt-brand-new"), "startup_lists would wipe the refreshed models in the page");
    }
  });

  it("the key a user saved while the lists were late is not shown as missing again by the late provider list", async () => {
    const h = makeProvider();
    await loadSlow(h);
    h.rpc.held.delete("config.list_providers");
    h.rpc.results["config.capabilities"] = { key_tests: false };
    h.rpc.results["config.refresh_models"] = [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }];
    h.rpc.results["config.list_providers"] = [{ id: "andromity", name: "Andromity Auto", has_key: true }, { id: "openai", name: "OpenAI", has_key: true }];
    await h.p._handleWebviewMessage({ type: "set_api_key", provider: "openai", apiKey: "test-key-not-real" });
    assert.equal(h.p._providers.find((p: any) => p.id === "openai")?.has_key, true, "the key flow itself did not record the key");
    h.rpc.release("config.list_models");
    h.rpc.release("config.list_providers", [{ id: "openai", name: "OpenAI", has_key: false }]);
    h.rpc.release("skills.list");
    await flush();
    assert.equal(h.p._providers.find((p: any) => p.id === "openai")?.has_key, true, "the late provider list undid the key the user had just saved");
    for (const message of h.of("startup_lists")) {
      assert.equal(message.providers.find((p: any) => p.id === "openai")?.has_key, true, "startup_lists told the page the key was missing");
    }
  });

  it("applying lists never mutates the arrays it is given or hands them back", () => {
    const { p } = makeProvider();
    const models = Object.freeze([Object.freeze({ id: "x", name: "X", provider: "openai" })]) as any;
    const providers = Object.freeze([Object.freeze({ id: "openai", name: "OpenAI", has_key: true })]) as any;
    const snapshot = JSON.stringify([models, providers]);
    p._applyModelLists(models, providers);
    assert.equal(JSON.stringify([models, providers]), snapshot);
    assert.notEqual(p._models, models);
    assert.notEqual(p._providers, providers);
    assert.equal(p._models[0].id, "auto");
    assert.equal(p._providers[0].id, "andromity");
    p._models.push({ id: "later" });
    assert.equal(models.length, 1);
  });

  it("applying lists adds Andromity Auto exactly once, whatever shape the lists have", () => {
    const { p } = makeProvider();
    const cases: Array<[any, any]> = [
      [undefined, undefined],
      [null, null],
      [[], []],
      [[{ id: "auto", name: "Auto", provider: "openrouter" }], [{ id: "andromity", name: "A", has_key: false }]],
      [[{ id: "auto", name: "Andromity Auto", provider: "andromity" }], [{ id: "andromity", name: "A", has_key: true }]],
    ];
    for (const [m, pr] of cases) {
      p._applyModelLists(m, pr);
      assert.equal(p._models.filter((x: any) => x.id === "auto" && x.provider === "andromity").length, 1, JSON.stringify([m, pr]));
      assert.equal(p._providers.filter((x: any) => x.id === "andromity").length, 1, JSON.stringify([m, pr]));
    }
  });

  it("applying the same lists twice gives equal, independent results", () => {
    const { p } = makeProvider();
    const models = [{ id: "x", name: "X", provider: "openai" }] as any;
    const providers = [{ id: "openai", name: "OpenAI", has_key: true }] as any;
    p._applyModelLists(models, providers);
    const first = JSON.parse(JSON.stringify(p._models));
    p._applyModelLists(models, providers);
    assert.deepEqual(JSON.parse(JSON.stringify(p._models)), first);
  });

  it("a late payload that is not a list is contained instead of becoming an unhandled rejection", async () => {
    const h = makeProvider();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      await loadSlow(h);
      h.rpc.release("config.list_models", { error: "boom" });
      h.rpc.release("config.list_providers");
      h.rpc.release("skills.list");
      await flush(6);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    assert.deepEqual(rejections.map(String), []);
  });

  it("the wait timer is cleared when the lists are fast, and again when the load ends", async () => {
    mock.timers.reset();
    const h = makeProvider();
    const base = timeoutsAlive();
    await h.p._loadInitialConfig(true);
    await flush();
    assert.equal(timeoutsAlive(), base, "a 2.5 s timer was left running after a load with fast lists");
  });

  it("lists that never arrive leave the page usable and never post startup_lists", async () => {
    const h = makeProvider();
    await loadSlow(h);
    mock.timers.tick(10 * 60 * 1000);
    await flush();
    assert.equal(h.of("init_state").length, 1);
    assert.equal(h.of("startup_lists").length, 0);
    assert.equal(h.of("init_state")[0].sessionId, "s1");
  });

  it("the non-list calls are still awaited: a slow config.get delays init_state rather than being replaced by defaults", async () => {
    const h = makeProvider();
    h.rpc.held.add("config.get");
    const load = h.p._loadInitialConfig(true) as Promise<void>;
    await flush();
    mock.timers.tick(10000);
    await flush();
    assert.equal(h.of("init_state").length, 0);
    h.rpc.release("config.get", { default_provider: "openai", default_model: "gpt-4o", pinned_models: [] });
    await load;
    assert.equal(h.of("init_state")[0].provider, "openai");
  });

  it("init_state carries the model and provider the user had chosen, even when the lists were late", async () => {
    const h = makeProvider();
    h.rpc.results["config.get"] = { default_provider: "openai", default_model: "gpt-4o", pinned_models: [] };
    await loadSlow(h);
    const init = h.of("init_state")[0];
    assert.equal(init.model, "gpt-4o");
    assert.equal(init.provider, "openai");
    const page = loadChat();
    page.post(init);
    page.post({ type: "startup_lists", models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }], providers: [{ id: "openai", name: "OpenAI", has_key: true }], skills: [] });
    assert.equal(page.eval("currentModel"), "gpt-4o");
    assert.equal(page.eval("currentProvider"), "openai");
  });
});

// ---------------------------------------------------------------------------
// D. the webview's startup_lists handler
// ---------------------------------------------------------------------------

describe("chat webview: startup_lists", () => {
  const model = (id: string, provider = "openai") => ({ id, name: id, provider });
  const lists = (page: ReturnType<typeof loadChat>) => ({
    models: (page.eval("allModels") as any[]).map((m) => m.id),
    providers: (page.eval("allProviders") as any[]).map((p) => p.id),
    skills: (page.eval("allSkills") as any[]).map((s) => s.name),
  });

  it("replaces models, providers and skills", () => {
    const page = loadChat();
    page.post({ type: "init_state", sessionId: "s", models: [model("old")], providers: [{ id: "old" }], skills: [{ name: "old" }] });
    page.post({ type: "startup_lists", models: [model("new")], providers: [{ id: "new" }], skills: [{ name: "new" }] });
    assert.deepEqual(lists(page), { models: ["new"], providers: ["new"], skills: ["new"] });
  });

  it("ignores an empty model list but takes the other two", () => {
    const page = loadChat();
    page.post({ type: "init_state", sessionId: "s", models: [model("keep")], providers: [{ id: "old" }], skills: [{ name: "old" }] });
    page.post({ type: "startup_lists", models: [], providers: [{ id: "new" }], skills: [{ name: "new" }] });
    assert.deepEqual(lists(page), { models: ["keep"], providers: ["new"], skills: ["new"] });
  });

  it("ignores values that are not arrays", () => {
    const page = loadChat();
    page.post({ type: "init_state", sessionId: "s", models: [model("keep")], providers: [{ id: "keep" }], skills: [{ name: "keep" }] });
    for (const bad of [undefined, null, "x", 7, { length: 3 }, true]) {
      page.post({ type: "startup_lists", models: bad, providers: bad, skills: bad });
    }
    assert.deepEqual(lists(page), { models: ["keep"], providers: ["keep"], skills: ["keep"] });
  });

  it("does not wipe the skills when the late message carries no skills field", () => {
    const page = loadChat();
    page.post({ type: "init_state", sessionId: "s", models: [model("m")], providers: [{ id: "p" }], skills: [{ name: "keep" }] });
    page.post({ type: "startup_lists", models: [model("m2")], providers: [{ id: "p" }] });
    assert.deepEqual(lists(page).skills, ["keep"]);
  });

  it("arrives before init_state without leaving the page worse than init_state alone would", { todo: "not reachable: the host attaches the late-list handler only after init_state is posted, and init_state leaves skills out while they are still loading" }, () => {
    const page = loadChat();
    page.post({ type: "startup_lists", models: [model("late")], providers: [{ id: "late" }], skills: [{ name: "late" }] });
    page.post({ type: "init_state", sessionId: "s", models: [model("late")], providers: [{ id: "late" }], skills: [] });
    assert.deepEqual(lists(page).skills, ["late"], "init_state with an empty skills list erased the late skills");
  });

  it("refreshes the model badge for the current model", () => {
    const page = loadChat({ state: { currentModel: "late-model", currentProvider: "openai" } });
    page.post({ type: "startup_lists", models: [{ id: "late-model", name: "Late Model Name", provider: "openai" }], providers: [{ id: "openai", has_key: true }], skills: [] });
    const rendered = JSON.stringify(page.byId["current-model-name"] ?? {});
    assert.ok(typeof rendered === "string");
    assert.equal(page.eval("allModels")[0].name, "Late Model Name");
  });
});

// ---------------------------------------------------------------------------
// E. model picker rows
// ---------------------------------------------------------------------------

interface CssRule { selectors: string[]; body: string }

function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const selectors = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
    rules.push({ selectors, body: m[2] });
  }
  return rules;
}

const hides = (body: string) =>
  /display\s*:\s*none/.test(body) || /visibility\s*:\s*hidden/.test(body) || /(^|;|\s)opacity\s*:\s*0\s*(;|!|$)/.test(body) ||
  /(^|;|\s)width\s*:\s*0(px)?\s*(;|!|$)/.test(body) || /pointer-events\s*:\s*none/.test(body) || /font-size\s*:\s*0/.test(body);

describe("model picker rows: the hover and focus rule", () => {
  const rules = cssRules(getChatStyles());

  it("hides the provider badge on hover and on focus-within, and only the badge", () => {
    const hover = rules.find((r) => r.selectors.includes(".flyout-item:hover .flyout-item-meta"));
    assert.ok(hover, "the hover rule is missing");
    assert.ok(hover!.selectors.includes(".flyout-item:focus-within .flyout-item-meta"));
    assert.match(hover!.body, /display\s*:\s*none/);
    assert.deepEqual(hover!.selectors.sort(), [".flyout-item:focus-within .flyout-item-meta", ".flyout-item:hover .flyout-item-meta"]);
  });

  it("does not hide the badge in the resting state", () => {
    const base = rules.filter((r) => r.selectors.includes(".flyout-item-meta"));
    assert.ok(base.length >= 1);
    for (const r of base) assert.ok(!hides(r.body), r.body);
  });

  for (const klass of ["flyout-pin-btn", "flyout-active-label", "flyout-active-dot", "flyout-tag", "flyout-tag.key", "flyout-tag.catalog", "flyout-item-name", "flyout-item-info", "flyout-item-actions"]) {
    it(`never hides .${klass} when the row is hovered or focused`, () => {
      const offenders = rules.filter((r) => r.selectors.some((s) => {
        if (!/:(hover|focus-within|focus|focus-visible)/.test(s) || !s.includes("flyout-item")) return false;
        const target = s.split(/[ >+~]/).filter(Boolean).pop() || "";
        if (target.includes("flyout-item-meta")) return false;
        const isMatch = target.includes("." + klass) || target === "*" || /^:not\(/.test(target) || target === ".flyout-item" + "" || /^\*/.test(target);
        return isMatch;
      }) && hides(r.body));
      assert.deepEqual(offenders.map((r) => r.selectors.join(", ")), []);
    });
  }

  it("no rule hides the actions of a hovered row wholesale", () => {
    const wholesale = rules.filter((r) => r.selectors.some((s) => /flyout-item(:hover|:focus-within)[^,]*(>|\s)\s*\*/.test(s) || /flyout-item-actions\s*>\s*\*/.test(s)) && hides(r.body));
    assert.deepEqual(wholesale.map((r) => r.selectors.join(", ")), []);
  });

  it("no rule with !important re-shows the badge on hover", () => {
    const rescuers = rules.filter((r) => r.selectors.some((s) => s.includes("flyout-item-meta")) && /display\s*:\s*(inline|block|flex|inline-block|inline-flex)[^;]*!important/.test(r.body));
    assert.deepEqual(rescuers, []);
  });

  it("the row keeps its title tooltip with provider, id and price", () => {
    const script = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatClientScript.ts"), "utf8");
    assert.match(script, /const fullName = \(m\.name \|\| m\.id\) \+ ' \(' \+ \(m\.provider \|\| 'openrouter'\) \+ ' · ' \+ m\.id \+ '\)' \+ \(m\.pricing \? ' · ' \+ m\.pricing : ''\);/);
    assert.match(script, /title="' \+ escapeHtml\(fullName\) \+ '" data-action="pick-model"/);
  });

  it("every row still renders the pin button, the badge, the Active label and the tags in the same container", () => {
    const script = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatClientScript.ts"), "utf8");
    const start = script.indexOf("function renderFlyoutItem(m)");
    const end = script.indexOf("if (!query) {", start);
    const row = script.slice(start, end);
    const actions = row.slice(row.indexOf('<div class="flyout-item-actions">'));
    for (const needle of ["flyout-active-label", "flyout-tag key", "flyout-tag catalog", "flyout-item-meta", "flyout-pin-btn"]) {
      assert.ok(actions.includes(needle), needle + " is not inside the row actions");
    }
  });

  it("badge text never reaches the page unescaped", () => {
    const script = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatClientScript.ts"), "utf8");
    const line = script.split("\n").find((l) => l.includes("flyout-item-meta") && l.includes("<span"))!;
    assert.ok(line.includes("escapeHtml(m.provider") && line.includes("escapeHtml(m.pricing"));
  });
});
