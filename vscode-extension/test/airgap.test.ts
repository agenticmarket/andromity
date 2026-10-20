import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Settings as VS Code's inspect() reports them, per key.
let settings: Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }> = {};
const updates: Array<[string, unknown, unknown]> = [];
const notices: string[] = [];
let warningAnswer: string | undefined;
const terminals: any[] = [];
const fetchCalls: string[] = [];

const vscodeMock: any = {
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  Uri: { joinPath: (...parts: any[]) => ({ fsPath: parts.map((p) => (typeof p === "object" ? p.fsPath : String(p))).join("/") }), file: (p: string) => ({ fsPath: p }) },
  env: { shell: "", isTelemetryEnabled: false },
  window: {
    activeTextEditor: undefined,
    showErrorMessage: async (m: string) => { notices.push(m); return undefined; },
    showWarningMessage: async (m: string) => { notices.push(m); return warningAnswer; },
    showInformationMessage: async (m: string) => { notices.push(m); return undefined; },
    createTerminal: (options: any) => { const t = { options, show() {}, sendText() {} }; terminals.push(t); return t; },
    withProgress: async () => { throw new Error("installer must not run"); },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/repo" } }],
    getWorkspaceFolder: () => undefined,
    getConfiguration: (section?: string) => ({
      inspect: (key: string) => settings[`${section}.${key}`],
      get: (key: string, fallback?: unknown) => {
        const s = settings[`${section}.${key}`];
        return s?.workspaceFolderValue ?? s?.workspaceValue ?? s?.globalValue ?? fallback;
      },
      update: async (key: string, value: unknown, target: unknown) => {
        updates.push([key, value, target]);
        settings[`${section}.${key}`] = { ...(settings[`${section}.${key}`] || {}), globalValue: value };
      },
    }),
  },
  commands: { executeCommand: async () => {} },
};

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments);
};
const { resolveAirGap, daemonAirGapEnv, terminalAirGapEnv, airGapStatusLine } = require("../src/airgap.js");
const { currentAirGap, airGapPillMessage } = require("../src/airgapState.js");
const { runCodeBlockInTerminal } = require("../src/integrations/TerminalRunner.js");
const { PythonBridge } = require("../src/server/PythonBridge.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
Module.prototype.require = originalRequire;

const originalFetch = globalThis.fetch;
beforeEach(() => {
  settings = {};
  updates.length = 0;
  notices.length = 0;
  terminals.length = 0;
  fetchCalls.length = 0;
  warningAnswer = undefined;
  delete process.env.ANDROMITY_AIRGAP;
  delete process.env.ANDROMITY_AIRGAP_ALLOW;
  (globalThis as any).fetch = async (url: string) => { fetchCalls.push(String(url)); throw new Error("network"); };
});
afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  delete process.env.ANDROMITY_AIRGAP;
  delete process.env.ANDROMITY_AIRGAP_ALLOW;
});

function airGapOn(hosts: string[] = []) {
  settings["andromity.airGap.enabled"] = { globalValue: true };
  settings["andromity.airGap.allowedHosts"] = { globalValue: hosts };
}

describe("air-gap setting resolution", () => {
  it("is off by default", () => {
    assert.deepEqual(resolveAirGap(undefined, undefined, {}), { enabled: false, source: "off", locked: false, allowedHosts: [] });
  });

  it("the environment turns it on and locks it", () => {
    const state = resolveAirGap({ globalValue: false }, undefined, { ANDROMITY_AIRGAP: "1", ANDROMITY_AIRGAP_ALLOW: "10.0.0.5" });
    assert.equal(state.enabled, true);
    assert.equal(state.source, "organization");
    assert.equal(state.locked, true);
    assert.deepEqual(state.allowedHosts, ["10.0.0.5"]);
  });

  it("a project can turn it on but not off", () => {
    assert.equal(resolveAirGap({ workspaceValue: true }, undefined, {}).source, "workspace");
    const userOn = resolveAirGap({ globalValue: true, workspaceValue: false, workspaceFolderValue: false }, undefined, {});
    assert.equal(userOn.enabled, true, "a repository's false cannot override the user's true");
  });

  it("only user settings and the organization can add allowed hosts", () => {
    const state = resolveAirGap({ globalValue: true },
      { globalValue: ["10.0.0.5", " gpu-box.lan "], workspaceValue: ["0.0.0.0/0"], workspaceFolderValue: ["evil.example"] },
      { ANDROMITY_AIRGAP_ALLOW: "10.1.0.0/16, 10.0.0.5" });
    assert.deepEqual(state.allowedHosts, ["10.1.0.0/16", "10.0.0.5", "gpu-box.lan"]);
  });

  it("builds the engine and terminal environments", () => {
    const state = resolveAirGap({ globalValue: true }, { globalValue: ["10.0.0.5"] }, {});
    assert.deepEqual(daemonAirGapEnv(state), { ANDROMITY_AIRGAP: "1", ANDROMITY_AIRGAP_ALLOW: "10.0.0.5" });
    const env = terminalAirGapEnv(state);
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      assert.equal(env[name], "http://127.0.0.1:9", name);
    }
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,10.0.0.5");
    assert.equal(env.NODE_USE_ENV_PROXY, "1");
    assert.equal(env.GIT_SSH_COMMAND, "false");
    assert.deepEqual(daemonAirGapEnv(resolveAirGap(undefined, undefined, {})), {});
    assert.deepEqual(terminalAirGapEnv(resolveAirGap(undefined, undefined, {})), {});
  });

  it("the status line says what can be reached and why", () => {
    const line = airGapStatusLine(resolveAirGap({ workspaceValue: true }, { globalValue: ["10.0.0.5"] }, {}), 2);
    assert.match(line, /turned on by this project/);
    assert.match(line, /this machine and 10\.0\.0\.5/);
    assert.match(line, /Blocked 2 connection attempts/);
  });
});

describe("air-gap mode in the extension", () => {
  it("reads VS Code settings", () => {
    airGapOn(["10.0.0.5"]);
    assert.equal(currentAirGap().enabled, true);
    assert.deepEqual(airGapPillMessage(), {
      type: "config_updated", key: "airgap", value: true,
      title: "Air-gap mode is on: Andromity can reach only this machine and 10.0.0.5.",
    });
  });

  it("does not download the engine package", async () => {
    airGapOn();
    const bridge: any = new PythonBridge({ appendLine() {}, show() {} } as any);
    assert.equal(await bridge._installPackage("python", "/repo", null), false);
    assert.match(notices.at(-1)!, /Air-gap mode is on, so downloading the Andromity engine is turned off/);
  });

  it("Run terminals get the blocked network environment", async () => {
    airGapOn(["10.0.0.5"]);
    await runCodeBlockInTerminal("npm test", "bash");
    const options = terminals[0].options;
    assert.equal(options.name, "Andromity: Run (air-gap)");
    assert.equal(options.env.HTTPS_PROXY, "http://127.0.0.1:9");
    assert.match(options.env.NO_PROXY, /10\.0\.0\.5/);
  });

  it("Run terminals are unchanged when air-gap mode is off", async () => {
    await runCodeBlockInTerminal("npm test", "bash");
    assert.equal(terminals[0].options.env, undefined);
  });

  it("sign-in, usage and model downloads make no network calls", async () => {
    airGapOn();
    const provider: any = Object.create(ChatViewProvider.prototype);
    const posted: any[] = [];
    Object.assign(provider, {
      _context: { secrets: { get: async () => undefined, delete: async () => {} } },
      _getGatewayBaseUrl: () => "https://gateway.example",
      _lastUsageData: null, _lastUsageFetchedAt: 0, _usageInFlight: null,
      broadcastToWebviews: (m: any) => posted.push(m),
      _checkOllamaCliInstalled: async () => { throw new Error("ollama must not run"); },
    });
    await provider.openLogin();
    await provider.handleAuthToken("token");
    await provider.pullOllamaModel("llama3");
    const usage = await provider.fetchUsage(true);
    assert.deepEqual(fetchCalls, []);
    assert.equal(usage.status, "unavailable");
    assert.equal(notices.filter((n) => n.includes("Air-gap mode is on")).length, 3);
  });
});

describe("air-gap card in Settings", () => {
  function panel() {
    const value: any = Object.create(SettingsPanel.prototype);
    const posted: any[] = [];
    Object.assign(value, { _panel: { webview: { postMessage: async (m: any) => posted.push(m) } }, _rpcClient: null });
    return { value, posted };
  }

  it("turning it on needs no confirmation; turning it off does", async () => {
    const { value, posted } = panel();
    await value._handleMessage({ type: "toggle_airgap", value: true });
    assert.deepEqual(updates.at(-1), ["airGap.enabled", true, 1]);
    assert.equal(posted.at(-1).airGap.enabled, true);

    warningAnswer = undefined;
    await value._handleMessage({ type: "toggle_airgap", value: false });
    assert.equal(updates.length, 1, "cancelled, so still on");
    assert.equal(posted.at(-1).airGap.enabled, true, "the checkbox is put back");

    warningAnswer = "Turn Off";
    await value._handleMessage({ type: "toggle_airgap", value: false });
    assert.deepEqual(updates.at(-1), ["airGap.enabled", false, 1]);
  });

  it("cannot be turned off when the organization or the project turned it on", async () => {
    const { value } = panel();
    process.env.ANDROMITY_AIRGAP = "1";
    await value._handleMessage({ type: "toggle_airgap", value: false });
    assert.match(notices.at(-1)!, /turned on by your organization/);
    delete process.env.ANDROMITY_AIRGAP;

    settings["andromity.airGap.enabled"] = { workspaceValue: true };
    await value._handleMessage({ type: "toggle_airgap", value: false });
    assert.match(notices.at(-1)!, /This project's settings turn air-gap mode on/);
    assert.equal(updates.length, 0);
  });

  it("saves allowed hosts to user settings, deduplicated", async () => {
    const { value } = panel();
    await value._handleMessage({ type: "save_airgap_hosts", hosts: "10.0.0.5, gpu-box.lan\n10.0.0.5;  " });
    assert.deepEqual(updates.at(-1), ["airGap.allowedHosts", ["10.0.0.5", "gpu-box.lan"], 1]);
  });

  it("reports when the self-test cannot reach the engine", async () => {
    const { value, posted } = panel();
    await value._handleMessage({ type: "airgap_self_test" });
    assert.deepEqual(posted.at(-1), { type: "airgap_self_test_result", result: null });
  });
});

describe("air-gap contributions", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
  const props = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration[0].properties : pkg.contributes.configuration.properties;

  it("declares the settings, with allowed hosts limited to user scope", () => {
    assert.equal(props["andromity.airGap.enabled"].default, false);
    assert.equal(props["andromity.airGap.allowedHosts"].scope, "machine");
    assert.match(props["andromity.airGap.enabled"].markdownDescription, /also use your firewall/);
    assert.ok(!/guarantee|certified|compliant/i.test(props["andromity.airGap.enabled"].markdownDescription));
  });

  it("offers the toggle and self-test commands", () => {
    const ids = pkg.contributes.commands.map((c: any) => c.command);
    assert.ok(ids.includes("andromity.toggleAirGap"));
    assert.ok(ids.includes("andromity.airGapSelfTest"));
  });
});
