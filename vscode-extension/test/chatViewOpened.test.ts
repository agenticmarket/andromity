import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

const vscodeMock: any = {
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined, update: async () => {} }),
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
  env: { isTelemetryEnabled: true },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join("/"), parse: (value: string) => value, file: (fsPath: string) => ({ fsPath }) },
};

const Module = require("module");
const compiledSrc = path.resolve(__dirname, "..", "src") + path.sep;

interface VsCodeWindow {
  ChatViewProvider: any;
  usage: any;
}

function newWindow(telemetryAllowed: () => boolean = () => true): VsCodeWindow {
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(compiledSrc)) delete require.cache[id];
  }
  const original = Module.prototype.require;
  Module.prototype.require = function (name: string) {
    return name === "vscode" ? vscodeMock : original.apply(this, arguments);
  };
  try {
    const usage = require("../src/telemetry/featureUsage.js");
    usage.setFeatureUsageGate(telemetryAllowed);
    return { ChatViewProvider: require("../src/providers/ChatViewProvider.js").ChatViewProvider, usage };
  } finally {
    Module.prototype.require = original;
  }
}

function fakeClient(options: { reject?: boolean } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const telemetry = () => calls.filter((c) => c.method === "telemetry.recordFeature").map((c) => c.params);
  return {
    calls,
    telemetry,
    opened: () => telemetry().filter((params) => params?.feature === "chat_view_opened"),
    call: async (method: string, params?: any): Promise<any> => {
      calls.push({ method, params });
      if (options.reject) throw new Error("engine connection closed");
      return method === "agent.approve_tool" ? { success: true } : {};
    },
    on() {},
    off() {},
  };
}
type FakeClient = ReturnType<typeof fakeClient>;

function fakeBridge(mode: "timeout" | "later") {
  const waits: number[] = [];
  const waiting: Array<(client: FakeClient | null) => void> = [];
  let live: FakeClient | null = null;
  return {
    waits,
    connect: (client: FakeClient) => {
      live = client;
      for (const resolve of waiting.splice(0)) resolve(client);
    },
    disconnect: () => { live = null; },
    getClient: (): FakeClient | null => live,
    waitForClient: (timeoutMs: number): Promise<FakeClient | null> => {
      waits.push(timeoutMs);
      if (live || mode === "timeout") return Promise.resolve(live);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}
type FakeBridge = ReturnType<typeof fakeBridge>;

function chatView(win: VsCodeWindow, engine: { client?: FakeClient; bridge?: FakeBridge | null } = {}) {
  const provider: any = new win.ChatViewProvider({ fsPath: "/extension" });
  const posted: any[] = [];
  let startupLoads = 0;
  Object.assign(provider, {
    _view: { visible: true, webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } },
    _diffManager: { setRpcClient() {} },
    _refreshSidePanel() {},
    getWorkspaceIndex: async () => ({ files: [], dirs: [] }),
    _loadStartupState: async () => { startupLoads++; },
  });
  const bridge = engine.bridge === undefined ? fakeBridge("timeout") : engine.bridge;
  if (bridge) provider.setPythonBridge(bridge);
  const connect = (client: FakeClient) => {
    bridge?.connect(client);
    provider.setRpcClient(client);
  };
  if (engine.client) connect(engine.client);
  return {
    provider,
    bridge,
    posted,
    connect,
    startupLoads: () => startupLoads,
    ready: (type = "ready"): Promise<void> => provider._handleWebviewMessage({ type }),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("chat_view_opened telemetry", () => {
  it("records only the event name when the chat view is ready and the engine is connected", async () => {
    const client = fakeClient();
    const view = chatView(newWindow(), { client });
    view.provider._currentSessionId = "session-named-after-a-private-repo";
    await view.ready();
    assert.deepEqual(client.opened(), [{ feature: "chat_view_opened" }]);
    assert.ok(view.posted.some((message) => message.type === "backend_ready"));
    assert.ok(view.startupLoads() >= 1, "the chat still loads its startup state");
  });

  it("records it once per window however many times a chat view reports ready", async () => {
    const win = newWindow();
    const client = fakeClient();
    const view = chatView(win, { client });
    await view.ready();
    await view.ready("webview_ready");
    await view.ready();
    await chatView(win, { client }).ready();
    const restarted = fakeClient();
    view.connect(restarted);
    await view.ready();
    assert.equal(client.opened().length, 1);
    assert.equal(restarted.opened().length, 0, "a restarted engine is still the same window");
    const nextWindowClient = fakeClient();
    await chatView(newWindow(), { client: nextWindowClient }).ready();
    assert.equal(nextWindowClient.opened().length, 1, "a new window counts again");
  });

  it("never records while telemetry is off or its setting cannot be read, and still loads the chat", async () => {
    let allowed: () => boolean = () => false;
    const client = fakeClient();
    const view = chatView(newWindow(() => allowed()), { client });
    await view.ready();
    await view.ready("webview_ready");
    allowed = () => { throw new Error("setting unreadable"); };
    await view.ready();
    assert.deepEqual(client.telemetry(), []);
    assert.ok(view.posted.some((message) => message.type === "backend_ready"));
    assert.ok(view.startupLoads() >= 1);
  });

  it("fails nothing and sends nothing while the engine is not connected", async () => {
    const win = newWindow();
    const alone = chatView(win, { bridge: null });
    await assert.doesNotReject(alone.ready());
    const starting = fakeBridge("timeout");
    const waiting = chatView(win, { bridge: starting });
    await assert.doesNotReject(waiting.ready());
    assert.deepEqual(starting.waits, [3000]);
    for (const view of [alone, waiting]) {
      assert.ok(!view.posted.some((message) => message.type === "backend_ready"));
      assert.equal(view.startupLoads(), 0);
    }
    const dropped = fakeClient({ reject: true });
    const view = chatView(win, { client: dropped });
    await assert.doesNotReject(view.ready());
    await settle();
    assert.equal(dropped.opened().length, 1);
    assert.ok(view.startupLoads() >= 1, "a failed telemetry call does not stop the chat loading");
  });

  it("records once when the engine connects while two ready messages wait for it", async () => {
    const engine = fakeBridge("later");
    const view = chatView(newWindow(), { bridge: engine });
    const waiting = [view.ready(), view.ready("webview_ready")];
    const client = fakeClient();
    engine.connect(client);
    await Promise.all(waiting);
    assert.equal(client.opened().length, 1);
    assert.equal(view.provider._rpcClient, client);
  });

  it("records the open when the engine connects after the ready wait gave up", async () => {
    const view = chatView(newWindow(), { bridge: fakeBridge("timeout") });
    await view.ready();
    const client = fakeClient();
    view.connect(client);
    await settle();
    assert.ok(view.posted.some((message) => message.type === "backend_ready"), "the chat did connect");
    assert.equal(client.opened().length, 1, "an engine slower than 3 s to start (first-run install, cold start) loses the event");
  });

  it("does not count an engine connection as an open when no chat view reported ready", async () => {
    const client = fakeClient();
    chatView(newWindow()).connect(client);
    await settle();
    assert.equal(client.opened().length, 0);
  });

  for (const bridgeReports of ["no client", "a different client"] as const) {
    it(`sends nothing to a dead engine when the bridge reports ${bridgeReports}, then sends it once to the engine that replaces it`, async () => {
      const view = chatView(newWindow());
      const dead = fakeClient();
      view.connect(dead);
      const interim = fakeClient();
      if (bridgeReports === "no client") view.bridge!.disconnect();
      else view.bridge!.connect(interim);
      await assert.doesNotReject(view.ready());
      await view.ready("webview_ready");
      await settle();
      assert.equal(dead.opened().length, 0, "the event would be lost on a client that can't deliver it");
      assert.equal(interim.opened().length, 0, "the chat isn't bound to that client yet");
      const replacement = fakeClient();
      view.connect(replacement);
      await view.ready();
      await settle();
      assert.deepEqual(replacement.opened(), [{ feature: "chat_view_opened" }]);
      assert.equal(dead.opened().length + interim.opened().length, 0);
    });
  }

  it("does not record it again after the user has worked in many sessions in the same window", async () => {
    const client = fakeClient();
    const view = chatView(newWindow(), { client });
    await view.ready();
    for (let i = 0; i < 250; i++) {
      view.provider._currentSessionId = `session-${i}`;
      await view.provider._handleWebviewMessage({ type: "approve_tool", approvalId: `approval-${i}`, scope: "once" });
    }
    assert.equal(client.telemetry().filter((params) => params.feature === "tool_approved").length, 250);
    await view.ready();
    assert.equal(client.opened().length, 1);
  });
});
