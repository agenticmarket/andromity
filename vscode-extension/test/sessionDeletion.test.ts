import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const errors: string[] = [];
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace: { workspaceFolders: [{ uri: { fsPath: "D:/repo" } }] },
    window: { showErrorMessage: (message: string) => errors.push(message) },
    commands: { executeCommand: () => {} },
  };
  return originalRequire.apply(this, arguments as any);
};
import { ChatViewProvider } from "../src/providers/ChatViewProvider.js";
import { SessionTabPanel } from "../src/panels/SessionTabPanel.js";

it("failed deletion preserves the active chat and never creates a replacement", async () => {
  for (const failure of ["running", "connection"]) {
    const provider: any = Object.create(ChatViewProvider.prototype);
    const calls: string[] = [];
    let refreshed = false;
    Object.assign(provider, {
      _currentSessionId: "active", _waterfallAutoOpenedSessions: new Set(["active"]),
      fetchAndPostSessions: async () => { refreshed = true; },
      _rpcClient: { call: async (method: string) => {
        calls.push(method);
        if (failure === "connection") throw new Error("private internal error");
        return { success: false, error: "This chat is running. Stop it before deleting it." };
      } },
    });
    await provider._handleWebviewMessage({ type: "delete_session", sessionId: "active" });
    assert.deepEqual(calls, ["session.delete"]);
    assert.equal(provider._currentSessionId, "active");
    assert.equal(provider._waterfallAutoOpenedSessions.has("active"), true);
    assert.equal(refreshed, false);
    assert.ok(errors.at(-1)?.includes(failure === "running" ? "running" : "connection"));
    assert.ok(!errors.at(-1)?.includes("private internal"));
  }
});

it("successful deletion refreshes history and selects the replacement chat", async () => {
  const provider: any = Object.create(ChatViewProvider.prototype);
  const calls: string[] = [];
  let refreshed = false;
  Object.assign(provider, {
    _currentSessionId: "active", _waterfallAutoOpenedSessions: new Set(["active"]),
    fetchAndPostSessions: async () => { refreshed = true; },
    setCurrentSessionId: (id: string) => { provider._currentSessionId = id; },
    _rpcClient: { call: async (method: string) => {
      calls.push(method);
      return method === "session.create" ? { id: "new" } : { success: true };
    } },
  });
  await provider._handleWebviewMessage({ type: "delete_session", sessionId: "active" });
  assert.deepEqual(calls, ["session.delete", "session.create"]);
  assert.equal(provider._currentSessionId, "new");
  assert.equal(provider._waterfallAutoOpenedSessions.has("active"), false);
  assert.equal(refreshed, true);
});

it("pop-out stays open when deletion fails and closes only after successful deletion", async () => {
  for (const outcome of ["running", "connection", "success"]) {
    const panel: any = Object.create(SessionTabPanel.prototype);
    let closed = false;
    Object.assign(panel, {
      _sessionId: "active", dispose: () => { closed = true; },
      _rpcClient: { call: async () => {
        if (outcome === "connection") throw new Error("private internal error");
        return { success: outcome === "success", error: "This chat is running. Stop it before deleting it." };
      } },
    });
    await panel._handleMessage({ type: "delete_session", sessionId: "active" });
    assert.equal(closed, outcome === "success");
  }
});
