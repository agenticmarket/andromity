import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace: { workspaceFolders: [{ uri: { fsPath: "D:/repo" } }] },
    window: { showInformationMessage: () => {}, showErrorMessage: () => {} },
    commands: { executeCommand: async () => {} },
  };
  if (["/ChatViewProvider.js", "/SettingsPanel.js", "/WaterfallPanel.js", "/PlanEditorPanel.js", "/BackgroundTaskPanel.js"]
    .some(suffix => name.endsWith(suffix))) return {};
  return originalRequire.apply(this, arguments as any);
};
const { SessionTabPanel } = require("../src/panels/SessionTabPanel.js");
Module.prototype.require = originalRequire;

function tab(logout: () => Promise<void>) {
  const steps: string[] = [];
  const calls: Array<{ method: string; params: any }> = [];
  const posts: any[] = [];
  const value: any = Object.create(SessionTabPanel.prototype);
  Object.assign(value, {
    _sessionId: "active", _currentModel: "auto", _currentProvider: "andromity", _extensionUri: "extension",
    _viewProvider: { logout: async () => { steps.push("logout"); await logout(); steps.push("logged out"); } },
    _rpcClient: { call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "agent.retry") steps.push("retry");
      return { success: true };
    } },
    _postMessage: (message: any) => posts.push(message),
  });
  return { value, steps, calls, posts };
}

const message = { type: "sign_out_and_retry", sessionId: "active", stripImages: false, model: "auto",
  provider: "andromity", reasoningEffort: "auto" };

it("a pop-out tab signs out first and retries the same turn only after the sign-out finished", async () => {
  const { value, steps, calls, posts } = tab(() => new Promise(resolve => setTimeout(resolve, 20)));
  await value._handleMessage(message);
  assert.deepEqual(steps, ["logout", "logged out", "retry"]);
  assert.deepEqual(calls.find(c => c.method === "agent.retry")?.params, {
    session_id: "active", strip_images: false, model: "auto", provider: "andromity", reasoning_effort: "auto",
  });
  assert.equal(posts.filter(p => p.type === "retry_result" && p.success).length, 1);
});

it("a failed sign-out does not retry the turn with the rejected sign-in", async () => {
  const { value, steps } = tab(async () => { throw new Error("secret storage unavailable"); });
  await value._handleMessage(message).catch(() => {});
  assert.ok(!steps.includes("retry"), steps.join(","));
});

it("a disconnected tab reports the retry as failed instead of signing out", async () => {
  const { value, steps, posts } = tab(async () => {});
  value._rpcClient = null;
  await value._handleMessage(message);
  assert.deepEqual(steps, []);
  assert.deepEqual(posts.map(p => [p.type, p.success]), [["retry_result", false]]);
});
