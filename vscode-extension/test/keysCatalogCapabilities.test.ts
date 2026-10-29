import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const notices: Array<{ kind: string; text: string }> = [];
const Module = require("module");
const originalRequire = Module.prototype.require;
const mockVscode: any = {
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: "D:/work/repo" } }], getConfiguration: () => ({ get: (_k: string, d: any) => d }) },
  window: {
    showInformationMessage: (text: string) => { notices.push({ kind: "info", text }); return Promise.resolve(undefined); },
    showWarningMessage: (text: string) => { notices.push({ kind: "warn", text }); return Promise.resolve(undefined); },
    showErrorMessage: (text: string) => { notices.push({ kind: "error", text }); return Promise.resolve(undefined); },
  },
  commands: { executeCommand: () => {} },
  Uri: { joinPath: () => ({ fsPath: "icon.svg" }), parse: (value: string) => ({ toString: () => value }), file: (p: string) => ({ fsPath: p }) },
  env: { openExternal: () => {} },
  ConfigurationTarget: { Global: 1 },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments);
};
const keyCheck = require("../src/server/keyCheck.js");
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
const { SessionTabPanel } = require("../src/panels/SessionTabPanel.js");
Module.prototype.require = originalRequire;

type Handler = (method: string, params: any) => any;
const OLD_ENGINE = new Error("[RPC -32601] Method 'config.capabilities' not found");

function fakeRpc(handler: Handler) {
  const calls: Array<{ method: string; params: any }> = [];
  return { calls, call: async (method: string, params: any) => { calls.push({ method, params }); return handler(method, params); } };
}

function engine(capabilities: () => any, test: any = { success: false, error_type: "auth_error" }): Handler {
  return (method) => {
    if (method === "config.capabilities") return capabilities();
    if (method === "config.test_provider") return test;
    if (method === "config.refresh_models") return [{ id: "gpt-x", name: "GPT X", provider: "openai" }];
    if (method === "config.list_providers") return [];
    return { success: true };
  };
}

beforeEach(() => { notices.length = 0; });

describe("engine support for key tests", () => {
  it("an engine without config.capabilities is remembered as unsupported", async () => {
    const rpc = fakeRpc(() => { throw OLD_ENGINE; });
    assert.equal(await keyCheck.supportsKeyTests(rpc), false);
    assert.equal(await keyCheck.supportsKeyTests(rpc), false);
    assert.equal(rpc.calls.length, 1);
  });

  it("follows the engine's answer and assumes support only when it cannot tell", async () => {
    assert.equal(await keyCheck.supportsKeyTests(fakeRpc(() => ({ key_tests: false }))), false);
    assert.equal(await keyCheck.supportsKeyTests(fakeRpc(() => ({ key_tests: true }))), true);
    let timeouts = 0;
    const flaky = fakeRpc(() => { timeouts += 1; throw new Error("RPC timeout (5000ms) for method: config.capabilities"); });
    assert.equal(await keyCheck.supportsKeyTests(flaky), true);
    await keyCheck.supportsKeyTests(flaky);
    assert.equal(timeouts, 2, "a timeout must not be cached as an answer");
  });

  it("reads support from a provider list without asking the engine", async () => {
    const newer = fakeRpc(() => { throw new Error("must not be called"); });
    assert.equal(await keyCheck.supportsKeyTests(newer, [{ id: "groq", key_required: true }, { id: "selfhost", key_required: false }]), true);
    const older = fakeRpc(() => { throw new Error("must not be called"); });
    assert.equal(await keyCheck.supportsKeyTests(older, [{ id: "groq", has_key: true }]), false);
    const empty = fakeRpc(() => ({ key_tests: true }));
    assert.equal(await keyCheck.supportsKeyTests(empty, []), true);
    assert.deepEqual(empty.calls.map((c) => c.method), ["config.capabilities"]);
  });

  it("names a 403 for an accepted key without blaming the key", () => {
    const result = keyCheck.describeKeyCheck({ success: false, error_type: "model_forbidden" });
    assert.deepEqual([result.ok, result.label], [false, "This account can't use that model"]);
  });
});

function settingsPanel(handler: Handler) {
  const rpc = fakeRpc(handler);
  const posts: any[] = [];
  const panel = Object.create(SettingsPanel.prototype);
  Object.assign(panel, { _rpcClient: rpc, _disposed: false, _onConfigChangeCallback: () => {},
    _panel: { webview: { postMessage: (m: any) => { posts.push(m); return Promise.resolve(true); } } } });
  return { panel, rpc, posts };
}

describe("older engines keep the previous behaviour", () => {
  it("Settings Test says to update the engine and never probes", async () => {
    const h = settingsPanel(engine(() => { throw OLD_ENGINE; }));
    await h.panel._handleMessage({ type: "test_key", provider: "groq" });
    assert.ok(!h.rpc.calls.some((c) => c.method === "config.test_provider"));
    assert.deepEqual(h.posts.map((p) => [p.type, p.provider, p.ok, p.label]),
      [["key_test_result", "groq", false, "Update the Andromity engine to test keys"]]);
  });

  it("Settings save learns support from the provider list it already fetched", async () => {
    const old = settingsPanel((method) => method === "config.list_providers"
      ? [{ id: "groq", name: "Groq", has_key: true }] : engine(() => ({ key_tests: true }))(method, {}));
    await old.panel._handleMessage({ type: "set_api_key", provider: "groq", apiKey: "gsk_FAKEfake0000FAKEfake0000ab" });
    assert.deepEqual(old.rpc.calls.map((c) => c.method), ["config.set_api_key", "config.list_providers"]);
    assert.ok(!old.posts.some((p) => p.type === "key_test_started" || p.type === "key_test_result"));

    const current = settingsPanel((method) => method === "config.list_providers"
      ? [{ id: "groq", name: "Groq", has_key: true, key_required: true }] : engine(() => { throw OLD_ENGINE; })(method, {}));
    await current.panel._handleMessage({ type: "set_api_key", provider: "groq", apiKey: "gsk_FAKEfake0000FAKEfake0000ab" });
    assert.ok(current.rpc.calls.some((c) => c.method === "config.test_provider"));
    assert.ok(!current.rpc.calls.some((c) => c.method === "config.capabilities"));
  });

  it("sidebar onboarding saves without testing and still says Connected", async () => {
    const rpc = fakeRpc(engine(() => { throw OLD_ENGINE; }));
    const posted: any[] = [];
    const provider: any = Object.create(ChatViewProvider.prototype);
    Object.assign(provider, { _rpcClient: rpc, _currentSessionId: "s1", _currentMode: "safe", _models: [], _providers: [],
      _postToWebview: (m: any) => posted.push(m), _loadInitialConfig: async () => {},
      probeOllama: async () => ({ running: false, installed: false, models: [] }) });
    await provider._handleWebviewMessage({ type: "set_api_key", provider: "openai", apiKey: "sk-test-FAKEfake0000FAKEfake0000" });
    assert.ok(rpc.calls.some((c) => c.method === "config.set_api_key"));
    assert.ok(!rpc.calls.some((c) => c.method === "config.test_provider"));
    assert.equal(posted.find((m) => m.type === "key_configured_select_model")?.unverified, undefined);
    await provider._handleWebviewMessage({ type: "finish_onboarding_model", provider: "openai", modelId: "gpt-x" });
    assert.ok(notices.some((n) => n.kind === "info" && n.text.startsWith("Connected to openai")), JSON.stringify(notices));
  });

  it("session tab onboarding saves without testing", async () => {
    const rpc = fakeRpc(engine(() => { throw OLD_ENGINE; }));
    const posted: any[] = [];
    const panel: any = Object.create(SessionTabPanel.prototype);
    Object.assign(panel, { _rpcClient: rpc, _sessionId: "s1", _currentMode: "safe", _postMessage: (m: any) => posted.push(m) });
    await panel._handleMessage({ type: "set_api_key", provider: "openai", apiKey: "sk-test-FAKEfake0000FAKEfake0000" });
    assert.ok(!rpc.calls.some((c) => c.method === "config.test_provider"));
    assert.equal(posted.find((m) => m.type === "key_configured_select_model")?.unverified, undefined);
  });

  it("a current engine is still tested on save", async () => {
    const rpc = fakeRpc(engine(() => ({ key_tests: true })));
    const posted: any[] = [];
    const panel: any = Object.create(SessionTabPanel.prototype);
    Object.assign(panel, { _rpcClient: rpc, _sessionId: "s1", _currentMode: "safe", _postMessage: (m: any) => posted.push(m) });
    await panel._handleMessage({ type: "set_api_key", provider: "openai", apiKey: "sk-test-FAKEfake0000FAKEfake0000" });
    assert.equal(posted.find((m) => m.type === "key_configured_select_model")?.unverified, "Saved, but couldn't verify: Key rejected");
  });
});
