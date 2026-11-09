import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const backgroundCalls: unknown[][] = [];
const receiptCalls: unknown[][] = [];
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace: { workspaceFolders: [{ uri: { fsPath: "D:/repo" } }] },
    window: { showInformationMessage: () => {}, showErrorMessage: () => {} },
    commands: { executeCommand: async () => {} },
  };
  if (name.endsWith("/BackgroundTaskPanel.js")) return { BackgroundTaskPanel: { createOrShow: (...args: unknown[]) => backgroundCalls.push(args) } };
  if (name.endsWith("/ReceiptPanel.js")) return { ReceiptPanel: { createOrShow: (...args: unknown[]) => receiptCalls.push(args) } };
  if (["/ChatViewProvider.js", "/SettingsPanel.js", "/WaterfallPanel.js", "/PlanEditorPanel.js"].some(suffix => name.endsWith(suffix))) return {};
  return originalRequire.apply(this, arguments as any);
};
import { SessionTabPanel } from "../src/panels/SessionTabPanel.js";

function tab() {
  const value: any = Object.create(SessionTabPanel.prototype);
  const calls: Array<{ method: string; params: any }> = [];
  const posts: any[] = [];
  Object.assign(value, {
    _sessionId: "active", _currentModel: "old", _currentProvider: "old-provider", _extensionUri: "extension",
    _rpcClient: { call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "session.get") return { messages: ["existing"] };
      if (method === "session.create") return { id: "new" };
      return { success: true };
    } },
    _postMessage: (message: any) => posts.push(message),
  });
  return { value, calls, posts };
}

it("tab model selection persists model and provider rather than displaying a dummy selection", async () => {
  const { value, calls, posts } = tab();
  await value._handleMessage({ type: "select_model", modelId: "new-model", provider: "custom" });
  assert.deepEqual(calls.filter(call => call.method === "config.set").map(call => call.params), [
    { section: "default", key: "model", value: "new-model" },
    { section: "default", key: "provider", value: "custom" },
  ]);
  assert.equal(posts[0].provider, "custom");
  assert.equal(value._currentModel, "new-model");
});

it("tab New creates and selects a new session, and question submit reaches the daemon", async () => {
  const { value, calls } = tab();
  const switched: string[] = [];
  value._switchSession = async (id: string) => switched.push(id);
  await value._handleMessage({ type: "new_session" });
  assert.deepEqual(switched, ["new"]);
  await value._handleMessage({ type: "answer_question", questionId: "q", answers: "answer" });
  const answer = calls.filter(c => c.method !== "telemetry.recordFeature").at(-1);
  assert.equal(answer?.method, "agent.answer_question");
  assert.equal(answer?.params.session_id, "active");
});

it("background command actions work from a pop-out with its own session", async () => {
  const { value, calls } = tab();
  await value._handleMessage({ type: "open_bg_task_tab", processId: "timer", command: "python timer.py" });
  assert.equal(backgroundCalls.at(-1)?.[4], "active");
  await value._handleMessage({ type: "kill_process", processId: "timer" });
  assert.equal(calls.at(-1)?.method, "process.kill");
  assert.equal(calls.at(-1)?.params.session_id, "active");
});

it("provider setup in a tab offers actual returned models and reports empty discovery", async () => {
  const { value, calls, posts } = tab();
  const original = value._rpcClient.call;
  value._rpcClient.call = async (method: string, params: any) => {
    if (method === "config.refresh_models") return [{ id: "real-model", provider: "custom" }];
    return original(method, params);
  };
  await value._handleMessage({ type: "set_api_key", provider: "custom", apiKey: "example-test-value" });
  assert.equal(calls[0].method, "config.set_api_key");
  assert.equal(posts[0].type, "key_configured_select_model");
  assert.equal(posts[0].models[0].id, "real-model");
  value._rpcClient.call = async () => [];
  await value._handleMessage({ type: "set_api_key", provider: "custom" });
  assert.equal(posts.at(-1).type, "key_configure_failed");
});

it("a pop-out opens receipts for its own session, whatever the page asks for", async () => {
  const { value } = tab();
  value._sessionName = "Fix login";
  await value._handleMessage({ type: "open_receipt", sessionId: "someone-else", turnIndex: 2 });
  assert.deepEqual(receiptCalls.at(-1)?.slice(1), ["active", "Fix login", value._rpcClient, 2]);
  for (const turnIndex of [-1, 1.5, "2", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    await value._handleMessage({ type: "open_receipt", turnIndex });
    assert.equal(receiptCalls.at(-1)?.[4], null, String(turnIndex));
  }
  value._rpcClient = null;
  const before = receiptCalls.length;
  await value._handleMessage({ type: "open_receipt", turnIndex: 0 });
  assert.equal(receiptCalls.length, before + 1, "the receipt tab explains a stopped engine itself");
});

it("a pop-out shows receipt badges for its own session only", () => {
  const { value, posts } = tab();
  const handlers = new Map<string, (params: any) => void>();
  value._rpcDisposables = [];
  value._rpcClient = { on: (event: string, handler: (params: any) => void) => handlers.set(event, handler), off: () => {} };
  value._bindRpcEvents();
  const ready = handlers.get("receipt/ready");
  assert.ok(ready, "the tab listens for finished receipts");
  ready!({ session_id: "other", turn_index: 0, attention: 1, high: 1 });
  ready!({ turn_index: 0, attention: 1, high: 1 });
  ready!(undefined);
  assert.equal(posts.length, 0);
  ready!({ session_id: "active", turn_index: 3, turn_key: "a".repeat(32), attention: 2, high: 0 });
  assert.deepEqual(posts, [{ type: "receipt_ready", session_id: "active", turn_index: 3, turn_key: "a".repeat(32), attention: 2, high: 0 }]);
});
