import { it, mock } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const panels: any[] = [];
const vscodeMock: any = {
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath: (...parts: any[]) => ({ fsPath: parts.map((p) => (typeof p === "object" ? p.fsPath : String(p))).join("/") }),
    file: (p: string) => ({ fsPath: p }),
  },
  window: {
    createWebviewPanel: () => {
      const panel: any = {
        visible: true,
        posted: [] as any[],
        reveal() {},
        onDidDispose: () => ({ dispose() {} }),
        webview: {
          html: "",
          cspSource: "vscode-webview:",
          asWebviewUri: (u: any) => u,
          postMessage: (message: any) => {
            panel.posted.push(message);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: (handler: any) => {
            panel.receive = handler;
            return { dispose() {} };
          },
        },
      };
      panels.push(panel);
      return panel;
    },
  },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  env: { isTelemetryEnabled: false },
};
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments);
};
const { FingerprintPanel } = require("../src/panels/FingerprintPanel.js");
Module.prototype.require = originalRequire;

function fakeRpc() {
  const handlers = new Map<string, Array<(params: any) => void>>();
  const calls: string[] = [];
  return {
    calls,
    on(event: string, handler: (params: any) => void) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
    off() {},
    emit(event: string, params: any) {
      (handlers.get(event) || []).forEach((handler) => handler(params));
    },
    async call(method: string) {
      calls.push(method);
      return { id: "fp-sess", status: "running", messages: [{ role: "user", content: "Go" }] };
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

it("re-reads the session at most once per interval during a burst of live events, and not while hidden", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const rpc = fakeRpc();
    const context: any = { globalState: { get: () => false, update: async () => {} } };
    FingerprintPanel.createOrShow({ fsPath: "/ext" }, "fp-sess", "Session", rpc, context);
    const panel = panels[panels.length - 1];

    await panel.receive({ type: "fingerprint_ready" });
    assert.equal(rpc.calls.length, 1);
    assert.equal(panel.posted[0].type, "fingerprint_init");

    for (let i = 0; i < 40; i++) rpc.emit("agent/toolStart", { session_id: "fp-sess", tool_id: `t${i}`, tool_name: "read_file" });
    mock.timers.tick(800);
    await settle();
    assert.equal(rpc.calls.length, 2, "a burst of events triggers one refresh");

    panel.visible = false;
    rpc.emit("agent/toolResult", { session_id: "fp-sess", tool_id: "t1", result: "ok" });
    mock.timers.tick(800);
    await settle();
    assert.equal(rpc.calls.length, 2, "a hidden panel does not re-read the session");

    rpc.emit("agent/toolStart", { session_id: "other-session", tool_id: "x", tool_name: "read_file" });
    panel.visible = true;
    mock.timers.tick(800);
    await settle();
    assert.equal(rpc.calls.length, 2, "events from other sessions are ignored");
  } finally {
    mock.timers.reset();
  }
});

it("tells the webview when the session could not be loaded instead of posting an empty trace as no activity", async () => {
  const context: any = { globalState: { get: () => false, update: async () => {} } };
  const failing = { ...fakeRpc(), async call() { throw new Error("daemon gone"); } };
  FingerprintPanel.createOrShow({ fsPath: "/ext" }, "fp-fail", "Session", failing, context);
  const failedPanel = panels[panels.length - 1];
  await failedPanel.receive({ type: "fingerprint_ready" });
  assert.equal(failedPanel.posted.at(-1).type, "fingerprint_init");
  assert.equal(failedPanel.posted.at(-1).loadFailed, true);

  FingerprintPanel.createOrShow({ fsPath: "/ext" }, "fp-ok", "Session", fakeRpc(), context);
  const okPanel = panels[panels.length - 1];
  await okPanel.receive({ type: "fingerprint_ready" });
  assert.equal(okPanel.posted.at(-1).loadFailed, false);
});

it("renders a Retry button for a failed load and keeps an already loaded trace on a failed refresh", () => {
  const { getFingerprintScript } = require("../src/providers/fingerprint/fingerprintScript.js");
  assert.equal(typeof getFingerprintScript, "function");
  const script: string = getFingerprintScript("fp-sess");
  assert.ok(script.includes("Couldn't load this session"));
  assert.ok(script.includes("if (msg.loadFailed && traceData && (traceData.nodes || []).length) return;"));
  assert.ok(script.includes("vscode.postMessage({ type: 'fingerprint_ready' })"));
});
