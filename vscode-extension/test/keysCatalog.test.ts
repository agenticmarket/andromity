import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const notices: Array<{ kind: string; text: string; items: string[] }> = [];
let warningChoice: string | undefined;
const Module = require("module");
const originalRequire = Module.prototype.require;
const mockVscode: any = {
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: "D:/work/repo" } }], getConfiguration: () => ({ get: (_k: string, d: any) => d }) },
  window: {
    showInformationMessage: (text: string, ...items: string[]) => { notices.push({ kind: "info", text, items }); return Promise.resolve(undefined); },
    showWarningMessage: (text: string, ...items: string[]) => { notices.push({ kind: "warn", text, items }); return Promise.resolve(warningChoice); },
    showErrorMessage: (text: string, ...items: string[]) => { notices.push({ kind: "error", text, items }); return Promise.resolve(undefined); },
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
const { element, loadChat, stub } = require("./helpers/chatHarness.js");
Module.prototype.require = originalRequire;

const XSS = `"><img src=x onerror=alert(1)>`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

type Handler = (method: string, params: any, timeout?: number) => any;

function fakeRpc(handler: Handler) {
  const calls: Array<{ method: string; params: any; timeout?: number }> = [];
  return {
    calls,
    call: async (method: string, params: any, timeout?: number) => {
      calls.push({ method, params, timeout });
      return handler(method, params, timeout);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  notices.length = 0;
  warningChoice = undefined;
});

// ── keyCheck.ts: labels, queue, timeouts, compatibility ─────────────────────────────────────

describe("key test results", () => {
  it("names each outcome the way the Settings row promises", () => {
    const label = (reply: any) => keyCheck.describeKeyCheck(reply).label;
    assert.equal(label({ success: true, latency_ms: 850 }), "Connected · 850 ms");
    assert.equal(label({ success: true, latency_ms: 1234 }), "Connected · 1.2 s");
    assert.equal(label({ success: true }), "Connected");
    assert.equal(label({ success: false, error_type: "auth_error" }), "Key rejected");
    assert.equal(label({ success: false, error_type: "rate_limit" }), "Rate limited (the key works)");
    assert.equal(label({ success: false, error_type: "quota_exceeded" }), "Rate limited (the key works)");
    assert.equal(label({ success: false, error_type: "model_not_found" }), "Model not found");
    for (const type of ["timeout", "provider_unavailable"]) assert.equal(label({ success: false, error_type: type }), "Couldn't reach provider");
  });

  it("never reports success for anything but an explicit success", () => {
    for (const reply of [null, undefined, {}, { success: "true" }, { success: 1 }, { ok: true }, { message: "Connection ready." }]) {
      const result = keyCheck.describeKeyCheck(reply as any);
      assert.equal(result.ok, false, JSON.stringify(reply));
      assert.notEqual(result.tone, "ok");
    }
  });

  it("ignores latency values that are not a positive finite number", () => {
    for (const latency of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "120", null]) {
      assert.equal(keyCheck.describeKeyCheck({ success: true, latency_ms: latency } as any).label, "Connected");
    }
  });

  it("shows a provider message as one short line of plain text", () => {
    const detail = "line one\r\n\tline\u0000two\u2028" + "x".repeat(400);
    const result = keyCheck.describeKeyCheck({ success: false, error_type: "generic", detail });
    assert.ok(result.label.length <= 120, `length ${result.label.length}`);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(result.label));
    assert.ok(result.label.startsWith("line one line two"));
    assert.equal(keyCheck.describeKeyCheck({ success: false, error_type: "generic", detail: { toString: () => "x" } } as any).label,
      "Couldn't verify the key");
  });

  it("asks the engine for the provider only, with the 20 s budget", async () => {
    const rpc = fakeRpc(() => ({ success: true }));
    await keyCheck.checkProviderKey(rpc, "groq");
    assert.deepEqual(rpc.calls, [{ method: "config.test_provider", params: { provider: "groq" }, timeout: 20_000 }]);
  });

  it("turns an RPC timeout into 'Couldn't reach provider' and other errors into an unverified result", async () => {
    const timedOut = await keyCheck.checkProviderKey(fakeRpc(() => { throw new Error("RPC timeout (20000ms) for method: config.test_provider"); }), "groq");
    assert.deepEqual([timedOut.ok, timedOut.label], [false, "Couldn't reach provider"]);
    const broken = await keyCheck.checkProviderKey(fakeRpc(() => { throw new Error("[RPC -32603] boom sk-test-FAKEfake0000FAKEfake"); }), "groq");
    assert.deepEqual([broken.ok, broken.label], [false, "Couldn't verify the key"]);
    assert.ok(!JSON.stringify(broken).includes("sk-test"));
  });

  it("runs one key test at a time, in order, and keeps results on their own provider", async () => {
    const pending: Record<string, ReturnType<typeof deferred<any>>> = {};
    const started: string[] = [];
    const rpc = fakeRpc((_method, params) => {
      started.push(params.provider);
      pending[params.provider] = deferred<any>();
      return pending[params.provider].promise;
    });
    const starts: string[] = [];
    const first = keyCheck.runKeyCheck(rpc, "groq", () => starts.push("groq"));
    const second = keyCheck.runKeyCheck(rpc, "openai", () => starts.push("openai"));
    const third = keyCheck.runKeyCheck(rpc, "google", () => starts.push("google"));
    await flush();
    assert.deepEqual(started, ["groq"]);
    assert.deepEqual(starts, ["groq"]);

    pending.groq.reject(new Error("socket closed"));
    await first;
    await flush();
    assert.deepEqual(started, ["groq", "openai"], "a failed test must not stall the queue");

    pending.openai.resolve({ success: false, error_type: "auth_error", model: "gpt-x" });
    await flush();
    pending.google.resolve({ success: true, latency_ms: 300, model: "gemini-x" });
    const results = await Promise.all([first, second, third]);
    assert.deepEqual(results.map((r: any) => [r.ok, r.label, r.model]), [
      [false, "Couldn't verify the key", undefined],
      [false, "Key rejected", "gpt-x"],
      [true, "Connected · 300 ms", "gemini-x"],
    ]);
    assert.deepEqual(starts, ["groq", "openai", "google"]);
  });

  it("words onboarding notices as Connected only on a pass", () => {
    assert.equal(keyCheck.unverifiedNotice(null), "");
    assert.equal(keyCheck.unverifiedNotice(keyCheck.describeKeyCheck({ success: true })), "");
    assert.equal(keyCheck.unverifiedNotice(keyCheck.describeKeyCheck({ success: false, error_type: "auth_error" })),
      "Saved, but couldn't verify: Key rejected");
  });

  it("accepts only connection IDs the engine accepts", () => {
    for (const ok of ["openai", "my-proxy_2", "a"]) assert.ok(keyCheck.PROVIDER_ID_PATTERN.test(ok), ok);
    for (const bad of ["", "OpenAI", "../etc", "a b", "<img>", "1abc", "a".repeat(65), "openai\n"]) {
      assert.ok(!keyCheck.PROVIDER_ID_PATTERN.test(bad), JSON.stringify(bad));
    }
  });
});

describe("refreshing one provider's models", () => {
  it("passes the engine's reason through as plain text", async () => {
    const reply = await keyCheck.refreshProviderModels(fakeRpc(() => ({ ok: false, message: "Key rejected.\n", models: [{ id: "m" }] })), "groq");
    assert.deepEqual(reply, { provider: "groq", ok: false, message: "Key rejected.", models: [{ id: "m" }] });
    const ok = await keyCheck.refreshProviderModels(fakeRpc(() => ({ ok: true, message: "ignored", models: "nope" })), "groq");
    assert.deepEqual(ok, { provider: "groq", ok: true, message: "", models: null });
  });

  it("falls back to config.refresh_models on an engine without the new RPC", async () => {
    const rpc = fakeRpc((method) => {
      if (method === "config.refresh_provider_models") throw new Error("[RPC -32601] Method 'config.refresh_provider_models' not found");
      return [{ id: "old-engine-model", provider: "groq" }];
    });
    const reply = await keyCheck.refreshProviderModels(rpc, "groq");
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.models, [{ id: "old-engine-model", provider: "groq" }]);
    assert.deepEqual(rpc.calls.map((c) => [c.method, c.params]), [
      ["config.refresh_provider_models", { provider: "groq" }],
      ["config.refresh_models", { provider: "groq" }],
    ]);
  });

  it("reports a timeout as unreachable and hides other engine errors", async () => {
    const timeout = await keyCheck.refreshProviderModels(fakeRpc(() => { throw new Error("RPC timeout (12000ms) for method: x"); }), "groq");
    assert.equal(timeout.message, "Couldn't reach provider.");
    const internal = await keyCheck.refreshProviderModels(fakeRpc(() => { throw new Error("[RPC -32603] C:\\Users\\me\\secret.py line 9"); }), "groq");
    assert.equal(internal.message, "Couldn't refresh models.");
    assert.equal(internal.models, null);
  });
});

// ── Settings webview: Test button, inline result, catalog bar, badges ───────────────────────

function settingsHtml(): string {
  const panel = Object.create(SettingsPanel.prototype);
  panel._panel = { webview: { cspSource: "vscode-webview:", asWebviewUri: () => "icon.svg", postMessage: () => {} } };
  panel._extensionUri = { fsPath: "D:/extension" };
  return panel._getHtmlForWebview();
}

const html = settingsHtml();

function slice(start: string, end: string, from = 0): string {
  const a = html.indexOf(start, from);
  const b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `script section ${start} … ${end} not found`);
  return html.slice(a, b);
}

function unescapeHtml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function parseTags(markup: string, test: (attrs: Record<string, string>) => boolean) {
  const found: any[] = [];
  for (const tag of markup.matchAll(/<(button|div|span)\b([^>]*)>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of tag[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeHtml(a[2]);
    if (!test(attrs)) continue;
    const dataset: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("data-")) dataset[k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = v;
    }
    found.push({ attrs, dataset, className: attrs.class || "", disabled: "disabled" in attrs, textContent: "", title: attrs.title || "" });
  }
  return found;
}

function loadSettings(providers: any[], models: any[] = []) {
  const posted: any[] = [];
  let testButtons: any[] = [];
  let statuses: any[] = [];
  const keysGrid: any = {
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(value: string) {
      this._html = value;
      testButtons = parseTags(value, (a) => a["data-action"] === "test-key");
      statuses = parseTags(value, (a) => (a.class || "").split(" ").includes("key-test-status"));
    },
  };
  const elements: Record<string, any> = {
    "keys-grid": keysGrid,
    "models-grid": { innerHTML: "" },
    "models-source-bar": { innerHTML: "", hidden: true },
    "model-count-badge": { textContent: "" },
  };
  const timers: Function[] = [];
  const context: any = {
    allProviders: providers, allModels: models, pinnedModels: [], activeProvider: "all", activeCategory: "all", searchQuery: "",
    activeModelId: "", activeModelProvider: "", ollamaStatus: { running: false, models: [] }, ollamaChecked: true,
    currentAccount: { isAuthenticated: false }, updateActiveBanner: () => {}, formatCtx: () => "",
    renderMcp: () => {}, vscode: { postMessage: (m: any) => posted.push(m) },
    setTimeout: (fn: Function) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      querySelectorAll: (selector: string) => {
        if (selector === '[data-action="test-key"]') return testButtons;
        if (selector === ".key-test-status[data-provider]") return statuses;
        return [];
      },
    },
  };
  const escape = slice("    function escapeHtml(str) {", "\n    }\n") + "\n    }\n";
  const state = "const keyTests = Object.create(null); const modelRefresh = Object.create(null); let keyTestRunning = \"\"; let keyTestTimer = 0;\n";
  const hub = slice("    function providerName(pid) {", "    function editProvider(id) {");
  const keys = slice("    function renderProviders() {", "    function finishKeyTest(msg) {");
  const finish = slice("    function finishKeyTest(msg) {", "\n    }\n") + "\n    }\n";
  const click = slice('      } else if (action === "test-key") {', '      } else if (action === "add-provider"');
  const messages = slice('        case "providers_updated": {', '        case "mcp_refreshed": {');
  vm.runInNewContext(
    escape + state + hub + keys + finish +
    "function onClick(action, btn) { if (false) {\n" + click + "} }\n" +
    "function onMessage(msg) { switch (msg.type) {\n" + messages + "} }\n" +
    "this.api = { renderProviders, renderModels, onClick, onMessage, keyTests, getRunning: () => keyTestRunning };",
    context,
  );
  const api = context.api;
  api.renderProviders();
  return {
    api, posted, elements, timers, context,
    button: (pid: string) => testButtons.find((b) => b.dataset.id === pid),
    status: (pid: string) => statuses.find((s) => s.dataset.provider === pid),
    buttons: () => testButtons,
  };
}

const PROVIDERS = [
  { id: "andromity", name: "Andromity", has_key: true },
  { id: "openai", name: "OpenAI", has_key: true, key_required: true },
  { id: "groq", name: "Groq", has_key: false, key_required: true },
  { id: "selfhost", name: "Self Host", has_key: false, custom: true, type: "openai", base_url: "http://localhost:8000/v1" },
  { id: "ollama", name: "Ollama", has_key: true },
];

describe("Settings API keys: Test button", () => {
  it("shows Test only on preset key rows, disabled with a hint until a key is saved", () => {
    const s = loadSettings(PROVIDERS);
    assert.deepEqual(s.buttons().map((b) => b.dataset.id).sort(), ["groq", "openai"]);
    assert.equal(s.button("openai").disabled, false);
    assert.equal(s.button("groq").disabled, true);
    assert.equal(s.button("groq").title, "Save an API key first");
  });

  it("does not post a test for a disabled or busy button", () => {
    const s = loadSettings(PROVIDERS);
    s.api.onClick("test-key", s.button("groq"));
    assert.deepEqual(plain(s.posted), []);
    s.api.onClick("test-key", s.button("openai"));
    s.api.onClick("test-key", s.button("openai"));
    assert.deepEqual(plain(s.posted), [{ type: "test_key", provider: "openai" }]);
    assert.equal(s.button("openai").textContent, "Testing…");
  });

  it("puts each result on its own row and renders provider text as text", () => {
    const providers = PROVIDERS.map((p) => p.id === "groq" ? { ...p, has_key: true } : p);
    const s = loadSettings(providers);
    s.api.onMessage({ type: "key_test_started", provider: "openai" });
    s.api.onMessage({ type: "key_test_result", provider: "groq", ok: false, tone: "error", label: XSS, detail: XSS });
    assert.equal(s.status("groq").textContent, XSS);
    assert.equal(s.status("openai").textContent, "Testing…");
    assert.equal(s.api.getRunning(), "openai");
    s.api.onMessage({ type: "key_test_result", provider: "openai", ok: true, tone: "ok", label: "Connected · 120 ms", model: "gpt-x" });
    assert.equal(s.status("openai").textContent, "Connected · 120 ms");
    assert.equal(s.status("openai").title, "Tested with gpt-x");
    assert.equal(s.status("groq").textContent, XSS);
    assert.equal(s.api.getRunning(), "");
  });

  it("a stuck test is released by the webview timer instead of locking every Test button", () => {
    const s = loadSettings(PROVIDERS);
    s.api.onClick("test-key", s.button("openai"));
    assert.ok(s.buttons().every((b) => b.disabled));
    s.timers.forEach((fn) => fn());
    assert.equal(s.api.getRunning(), "");
    assert.equal(s.status("openai").textContent, "Couldn't reach provider");
    assert.equal(s.button("openai").disabled, false);
  });

  it("saving a new key clears that row's old result", () => {
    const s = loadSettings(PROVIDERS);
    s.api.onMessage({ type: "key_test_result", provider: "openai", ok: false, tone: "error", label: "Key rejected" });
    s.api.onMessage({ type: "providers_updated", providers: PROVIDERS, savedProvider: "openai" });
    assert.equal(s.status("openai").textContent, "");
  });
});

describe("Settings Model Hub: Needs API key and Catalog bar", () => {
  const models = [
    { id: "gpt-x", name: "GPT X", provider: "openai", source: "live", has_key: true, needs_key: false },
    { id: "groq-a", name: "Groq A", provider: "groq", source: "catalog", has_key: false, needs_key: true },
    { id: "auto", name: "Auto", provider: "andromity", source: "catalog", has_key: true, needs_key: false },
    { id: "m1", name: "Self", provider: "selfhost", source: "catalog", has_key: false, needs_key: false },
  ];

  function cards(s: ReturnType<typeof loadSettings>) {
    const grid: string = s.elements["models-grid"].innerHTML;
    return grid.split('<div class="model-card ').slice(1).map((card) => ({
      id: (card.match(/class="model-id">([^<]*)</) || [])[1],
      needsKey: card.includes(">Needs API key<"),
      html: card,
    }));
  }

  it("tags only models whose provider needs a key it does not have", () => {
    const s = loadSettings(PROVIDERS, models);
    s.api.renderModels();
    assert.deepEqual(cards(s).filter((c) => c.needsKey).map((c) => c.id), ["groq-a"]);
  });

  it("lists only catalog-sourced preset providers in the Catalog bar", () => {
    const s = loadSettings(PROVIDERS, models);
    s.api.renderModels();
    const bar = s.elements["models-source-bar"];
    assert.equal(bar.hidden, false);
    const ids = [...bar.innerHTML.matchAll(/data-provider="([^"]*)"/g)].map((m: any) => m[1]);
    assert.deepEqual(ids, ["groq"]);
  });

  it("escapes provider names and refresh reasons from the engine", () => {
    const evil = PROVIDERS.map((p) => p.id === "groq" ? { ...p, name: XSS } : p);
    const s = loadSettings(evil, models);
    s.api.onMessage({ type: "provider_models_refreshed", provider: "groq", ok: false, message: XSS, models: null });
    const markup = s.elements["models-source-bar"].innerHTML + s.elements["models-grid"].innerHTML;
    assert.ok(!markup.includes("<img"), markup);
    assert.ok(!markup.includes('"><img'), "an attribute was closed early");
    assert.ok(markup.includes("&quot;&gt;&lt;img"), "the hostile name and reason must still be shown, escaped");
  });

  it("a refresh replaces only that provider's models", () => {
    const s = loadSettings(PROVIDERS, models);
    s.api.onMessage({ type: "provider_models_refreshed", provider: "groq", ok: true, message: "",
      models: [{ id: "groq-live", name: "Groq Live", provider: "groq", source: "live", has_key: true, needs_key: false }] });
    const ids = cards(s).map((c) => c.id).sort();
    assert.deepEqual(ids, ["auto", "gpt-x", "groq-live", "m1"]);
    assert.equal(s.elements["models-source-bar"].hidden, true);
  });

  it("refresh button posts once until the answer arrives", () => {
    const s = loadSettings(PROVIDERS, models);
    s.api.renderModels();
    s.api.onClick("refresh-provider-models", { dataset: { provider: "groq" } });
    s.api.onClick("refresh-provider-models", { dataset: { provider: "groq" } });
    assert.deepEqual(plain(s.posted), [{ type: "refresh_provider_models", provider: "groq" }]);
    assert.ok(s.elements["models-source-bar"].innerHTML.includes("Refreshing…"));
  });
});

// ── Settings host: test on save, test button, model choice ──────────────────────────────────

function settingsPanel(handler: Handler) {
  const rpc = fakeRpc(handler);
  const posts: any[] = [];
  const panel = Object.create(SettingsPanel.prototype);
  panel._rpcClient = rpc;
  panel._panel = { webview: { postMessage: (m: any) => { posts.push(m); return Promise.resolve(true); } } };
  panel._disposed = false;
  let changes = 0;
  panel._onConfigChangeCallback = () => { changes += 1; };
  const tabs: string[] = [];
  panel.setInitialTab = (tab: string) => tabs.push(tab);
  return { panel, rpc, posts, tabs, changes: () => changes };
}

describe("Settings host: key tests", () => {
  it("saving a key stores it first, then tests it, then refreshes a passing provider's list", async () => {
    const h = settingsPanel((method) => {
      if (method === "config.list_providers") return PROVIDERS;
      if (method === "config.test_provider") return { success: true, latency_ms: 90, model: "llama-x" };
      if (method === "config.refresh_provider_models") return { ok: true, models: [{ id: "llama-x", provider: "groq", source: "live" }] };
      return { success: true };
    });
    await h.panel._handleMessage({ type: "set_api_key", provider: "groq", apiKey: "  gsk_FAKEfake0000FAKEfake0000ab  " });
    assert.deepEqual(h.rpc.calls.map((c) => c.method), ["config.set_api_key", "config.list_providers", "config.test_provider", "config.refresh_provider_models"]);
    assert.equal(h.rpc.calls[0].params.api_key, "gsk_FAKEfake0000FAKEfake0000ab");
    assert.deepEqual(h.posts.map((p) => p.type), ["providers_updated", "key_test_started", "key_test_result", "provider_models_refreshed"]);
    assert.equal(h.posts[2].label, "Connected · 90 ms");
    assert.ok(!JSON.stringify(h.posts).includes("gsk_FAKE"));
    assert.ok(!JSON.stringify(notices).includes("gsk_FAKE"));
  });

  it("a failing key stays saved and does not refresh the model list", async () => {
    const h = settingsPanel((method) => {
      if (method === "config.list_providers") return PROVIDERS;
      if (method === "config.test_provider") return { success: false, error_type: "auth_error", message: "HTTP 401" };
      return { success: true };
    });
    await h.panel._handleMessage({ type: "set_api_key", provider: "groq", apiKey: "gsk_FAKEfake0000FAKEfake0000ab" });
    assert.ok(!h.rpc.calls.some((c) => c.method === "config.refresh_provider_models"));
    assert.ok(!h.rpc.calls.some((c) => c.method === "config.set_api_key" && !c.params.api_key));
    assert.equal(h.posts.find((p) => p.type === "key_test_result").label, "Key rejected");
  });

  it("does not test when the key could not be saved", async () => {
    const h = settingsPanel((method) => { if (method === "config.set_api_key") throw new Error("disk full"); return {}; });
    await h.panel._handleMessage({ type: "set_api_key", provider: "groq", apiKey: "gsk_FAKEfake0000FAKEfake0000ab" });
    assert.deepEqual(h.rpc.calls.map((c) => c.method), ["config.set_api_key"]);
    assert.ok(!h.posts.some((p) => p.type === "key_test_started"));
  });

  it("refuses provider IDs the engine would not accept, without calling it", async () => {
    const h = settingsPanel(() => ({ success: true }));
    await h.panel._handleMessage({ type: "test_key", provider: "x".repeat(200) + XSS });
    await h.panel._handleMessage({ type: "refresh_provider_models", provider: "../../etc" });
    assert.deepEqual(h.rpc.calls, []);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].ok, false);
    assert.ok(h.posts[0].provider.length <= 64);
  });

  it("posts nothing to a closed panel", async () => {
    const gate = deferred<any>();
    const h = settingsPanel((method) => method === "config.test_provider" ? gate.promise : { ok: true, models: [] });
    const running = h.panel._handleMessage({ type: "test_key", provider: "groq" });
    await flush();
    h.panel._disposed = true;
    gate.resolve({ success: true });
    await running;
    assert.deepEqual(h.posts.map((p) => p.type), ["key_test_started"]);
  });
});

describe("Settings host: choosing a model whose provider has no key", () => {
  function withChat() {
    const notes: any[] = [];
    SettingsPanel.chatProvider = { showKeyRequiredNote: (p: any) => notes.push(p) };
    return notes;
  }

  it("switches, then shows the chat note with the engine's portal URL and offers Open API keys", async () => {
    const notes = withChat();
    warningChoice = "Open API keys";
    const h = settingsPanel((method) => method === "config.list_providers"
      ? [{ id: "groq", name: "Groq", has_key: false, key_required: true, portal: "https://console.groq.com/keys" }]
      : { success: true });
    await h.panel._handleMessage({ type: "select_model", modelId: "llama-3.3-70b-versatile", provider: "groq" });
    await flush();
    assert.deepEqual(h.rpc.calls.filter((c) => c.method === "config.set").map((c) => c.params.value), ["llama-3.3-70b-versatile", "groq"]);
    assert.deepEqual(notes, [{ id: "groq", name: "Groq", portal: "https://console.groq.com/keys" }]);
    assert.deepEqual(h.tabs, ["keys"]);
    assert.equal(notices.at(-1)?.kind, "warn");
  });

  it("stays quiet for keyed, keyless, custom and old-engine providers", async () => {
    const notes = withChat();
    const listed = [
      { id: "openai", name: "OpenAI", has_key: true, key_required: true },
      { id: "andromity", name: "Andromity", has_key: true, key_required: false },
      { id: "selfhost", name: "Self", has_key: false, key_required: false, custom: true },
      { id: "groq", name: "Groq", has_key: false },
    ];
    const h = settingsPanel((method) => method === "config.list_providers" ? listed : { success: true });
    for (const provider of ["openai", "andromity", "selfhost", "groq"]) {
      await h.panel._handleMessage({ type: "select_model", modelId: "m", provider });
    }
    assert.deepEqual(notes, []);
    assert.ok(notices.every((n) => n.kind === "info"));
  });
});

// ── Chat webview: menu tags, note above the input, catalog refresh ─────────────────────────

function chat(providers: any[], models: any[], state: any = {}) {
  const list = element();
  const h = loadChat({ state: { currentModel: "auto", currentProvider: "andromity", ...state }, elements: { "flyout-list": list, "flyout-search": element({ value: "" }), "model-flyout": element({ style: { display: "none" } }) } });
  h.sandbox.__models = models;
  h.sandbox.__providers = providers;
  h.eval("allModels = __models; allProviders = __providers; pinnedModels = [];");
  let note: any = null;
  h.sandbox.document.createElement = (tag: string) => {
    const el = element({ tagName: tag.toUpperCase() });
    el.remove = () => { if (note === el) note = null; el.removed = true; };
    return el;
  };
  h.sandbox.document.getElementById = (id: string) => id === "key-required-note" ? note : (id in h.byId ? h.byId[id] : stub());
  h.promptBox.parentNode = { insertBefore: (node: any) => { note = node; } };
  const render = (query = "") => {
    h.eval(`renderFlyoutList(${JSON.stringify(query)})`);
    return list.innerHTML as string;
  };
  return { h, list, render, note: () => note };
}

const CHAT_PROVIDERS = [
  { id: "andromity", name: "Andromity", has_key: true, key_required: false, portal: "https://agenticmarket.dev" },
  { id: "groq", name: "Groq", has_key: false, key_required: true, portal: "https://console.groq.com/keys" },
  { id: "openai", name: "OpenAI", has_key: true, key_required: true, portal: "https://platform.openai.com/api-keys" },
  { id: "selfhost", name: "Self", has_key: false, custom: true, portal: "" },
  { id: "ollama", name: "Ollama", has_key: true, portal: "https://ollama.com" },
];
const CHAT_MODELS = [
  { id: "auto", name: "Auto", provider: "andromity", source: "catalog", needs_key: false },
  { id: "groq-a", name: "Groq A", provider: "groq", source: "catalog", needs_key: true, pricing: "$1" },
  { id: "gpt-cat", name: "GPT Catalog", provider: "openai", source: "catalog", needs_key: false, pricing: "$2" },
  { id: "gpt-live", name: "GPT Live", provider: "openai", source: "live", needs_key: false, pricing: "$3" },
  { id: "m1", name: "Self", provider: "selfhost", source: "catalog", needs_key: false },
  { id: "llama3", name: "Llama 3", provider: "ollama", source: "live", needs_key: false },
];

function rowOf(markup: string, id: string): string {
  const start = markup.indexOf(`data-model-id="${id}"`);
  assert.ok(start >= 0, `row ${id} missing`);
  const end = markup.indexOf('data-action="pick-model"', start);
  return markup.slice(start, end < 0 ? undefined : end);
}

describe("Chat model menu tags", () => {
  it("tags keyless models and labels only preset catalog lists", () => {
    const c = chat(CHAT_PROVIDERS, CHAT_MODELS);
    const markup = c.render();
    assert.ok(rowOf(markup, "groq-a").includes(">Needs API key<"));
    assert.ok(!rowOf(markup, "groq-a").includes("flyout-tag catalog"));
    assert.ok(rowOf(markup, "gpt-cat").includes('class="flyout-tag catalog" data-action="refresh-provider-models" data-provider="openai"'));
    for (const id of ["auto", "gpt-live", "m1", "llama3"]) {
      assert.ok(!rowOf(markup, id).includes("flyout-tag"), id);
    }
  });

  it("escapes model and provider names in tags and titles", () => {
    const providers = CHAT_PROVIDERS.map((p) => p.id === "groq" ? { ...p, name: XSS } : p);
    const models = [...CHAT_MODELS, { id: XSS, name: XSS, provider: "groq", source: "catalog", needs_key: true }];
    const c = chat(providers, models);
    const markup = c.render();
    assert.ok(!markup.includes("<img"), "raw markup reached the menu");
    assert.ok(markup.includes("Set your &quot;&gt;&lt;img"), "the hostile provider name must still be shown, escaped");

    c.h.eval("modelFlyout.style.display = 'flex'");
    c.h.post({ type: "provider_models_refreshed", provider: "groq", ok: false, message: XSS, models: null });
    const notice = c.list.innerHTML as string;
    assert.ok(notice.includes('class="flyout-notice"'), "the refresh failure must be shown");
    assert.ok(!notice.includes("<img"), "raw markup reached the refresh notice");
  });

  it("clicking Catalog asks for one refresh and swaps in only that provider's models", () => {
    const c = chat(CHAT_PROVIDERS, CHAT_MODELS);
    const target = element({ attrs: { "data-action": "refresh-provider-models", "data-provider": "openai" } });
    target.getAttribute = (name: string) => ({ "data-action": "refresh-provider-models", "data-provider": "openai" } as any)[name] ?? null;
    target.closest = (sel: string) => sel.includes("data-action") ? target : null;
    const click = () => (c.h.docListeners.click || []).forEach((fn: Function) => fn({ target, preventDefault() {}, stopPropagation() {} }));
    click();
    click();
    assert.deepEqual(plain(c.h.posted.filter((m: any) => m.type === "refresh_provider_models")), [{ type: "refresh_provider_models", provider: "openai" }]);
    assert.ok(!c.h.posted.some((m: any) => m.type === "update_config"), "the click must not also pick the model");

    c.h.post({ type: "provider_models_refreshed", provider: "openai", ok: true, models: [{ id: "gpt-new", provider: "openai", source: "live" }] });
    const ids = JSON.parse(c.h.eval("JSON.stringify(allModels.map(m => m.provider + '/' + m.id))"));
    assert.deepEqual(ids.sort(), ["andromity/auto", "groq/groq-a", "ollama/llama3", "openai/gpt-new", "selfhost/m1"]);
  });
});

describe("Chat note for a model whose provider has no key", () => {
  it("choosing a tagged model switches to it and shows Get API key and Open API keys", () => {
    const c = chat(CHAT_PROVIDERS, CHAT_MODELS);
    c.h.eval("window.pickModel('groq-a', 'groq')");
    assert.deepEqual(c.h.posted.filter((m: any) => m.type === "update_config").map((m: any) => [m.value, m.provider]), [["groq-a", "groq"]]);
    const note = c.note();
    assert.ok(note, "no note was shown");
    assert.ok(note.innerHTML.includes('data-action="open-portal" data-url="https://console.groq.com/keys"'));
    assert.ok(note.innerHTML.includes('data-action="open-api-keys"'));
    c.h.eval("window.pickModel('gpt-live', 'openai')");
    assert.equal(c.note(), null);
  });

  it("never offers a non-https portal link and escapes the provider name", () => {
    const providers = CHAT_PROVIDERS.map((p) => p.id === "groq" ? { ...p, name: XSS, portal: "javascript:alert(1)" } : p);
    const c = chat(providers, CHAT_MODELS);
    c.h.post({ type: "key_required_note", provider: "groq", name: XSS, portal: "javascript:alert(1)" });
    const note = c.note();
    assert.ok(note);
    assert.ok(!note.innerHTML.includes("open-portal"));
    assert.ok(!note.innerHTML.includes("<img"));
  });

  it("goes away once that provider has a key", () => {
    const c = chat(CHAT_PROVIDERS, CHAT_MODELS);
    c.h.post({ type: "key_required_note", provider: "groq", name: "Groq", portal: "https://console.groq.com/keys" });
    assert.ok(c.note());
    c.h.post({ type: "init_state", sessionId: "s", model: "groq-a", provider: "groq", models: CHAT_MODELS,
      providers: CHAT_PROVIDERS.map((p) => p.id === "groq" ? { ...p, has_key: true } : p) });
    assert.equal(c.note(), null);
  });

  it("goes away when another provider's model becomes active elsewhere (Model Hub)", () => {
    const c = chat(CHAT_PROVIDERS, CHAT_MODELS);
    c.h.post({ type: "key_required_note", provider: "groq", name: "Groq", portal: "https://console.groq.com/keys" });
    assert.ok(c.note());
    c.h.post({ type: "init_state", sessionId: "s", model: "gpt-live", provider: "openai", models: CHAT_MODELS, providers: CHAT_PROVIDERS });
    assert.equal(c.note(), null, "the note still asks for a Groq key while OpenAI is active");
  });
});

// ── Onboarding: Connected only on a pass ───────────────────────────────────────────────────

function sidebar(handler: Handler) {
  const rpc = fakeRpc(handler);
  const posted: any[] = [];
  const provider: any = Object.create(ChatViewProvider.prototype);
  Object.assign(provider, {
    _rpcClient: rpc, _currentSessionId: "s1", _currentMode: "safe", _models: [], _providers: [],
    _postToWebview: (m: any) => posted.push(m),
    _loadInitialConfig: async () => {},
    probeOllama: async () => ({ running: false, installed: false, models: [] }),
  });
  return { provider, rpc, posted };
}

function onboardingRpc(test: any): Handler {
  return (method) => {
    if (method === "config.test_provider") return test;
    if (method === "config.refresh_models") return [{ id: "gpt-x", name: "GPT X", provider: "openai" }];
    if (method === "config.list_providers") return [];
    return { success: true };
  };
}

describe("Onboarding key save", () => {
  it("sidebar: saves the key before testing it and labels a failed test as unverified", async () => {
    const s = sidebar(onboardingRpc({ success: false, error_type: "auth_error" }));
    await s.provider._handleWebviewMessage({ type: "set_api_key", provider: "openai", apiKey: "sk-test-FAKEfake0000FAKEfake0000" });
    const methods = s.rpc.calls.map((c) => c.method);
    assert.ok(methods.indexOf("config.set_api_key") < methods.indexOf("config.test_provider"));
    assert.deepEqual(s.rpc.calls.find((c) => c.method === "config.test_provider")?.params, { provider: "openai" });
    const step = s.posted.find((m) => m.type === "key_configured_select_model");
    assert.equal(step.unverified, "Saved, but couldn't verify: Key rejected");
    assert.ok(!JSON.stringify(s.posted).includes("sk-test-FAKE"));
  });

  it("sidebar: a passing key is reported as connected and Ollama is never key-tested", async () => {
    const s = sidebar(onboardingRpc({ success: true, latency_ms: 50 }));
    await s.provider._handleWebviewMessage({ type: "set_api_key", provider: "openai", apiKey: "sk-test-FAKEfake0000FAKEfake0000" });
    assert.equal(s.posted.find((m) => m.type === "key_configured_select_model").unverified, undefined);
    const o = sidebar(onboardingRpc({ success: true }));
    await o.provider._handleWebviewMessage({ type: "set_api_key", provider: "ollama", apiKey: "anything" });
    assert.ok(!o.rpc.calls.some((c) => c.method === "config.test_provider"));
  });

  it("sidebar: finishing with an unverified key warns instead of saying Connected", async () => {
    const s = sidebar(onboardingRpc({ success: false, error_type: "rate_limit" }));
    await s.provider._handleWebviewMessage({ type: "set_api_key", provider: "openai", apiKey: "sk-test-FAKEfake0000FAKEfake0000" });
    notices.length = 0;
    await s.provider._handleWebviewMessage({ type: "finish_onboarding_model", provider: "openai", modelId: "gpt-x" });
    assert.ok(!notices.some((n) => n.text.startsWith("Connected")), JSON.stringify(notices));
    assert.equal(notices[0].kind, "warn");
    assert.equal(s.posted.at(-1).type, "key_configured_success");
    assert.equal(s.posted.at(-1).unverified, "Saved, but couldn't verify: Rate limited (the key works)");
  });

  it("sidebar: an unverified key is not shown as Connected even when finishing fails", async () => {
    const s = sidebar((method, params) => {
      if (method === "config.set" && params.key === "model") throw new Error("engine restarted");
      return onboardingRpc({ success: false, error_type: "auth_error" })(method, params);
    });
    await s.provider._handleWebviewMessage({ type: "set_api_key", provider: "openai", apiKey: "sk-test-FAKEfake0000FAKEfake0000" });
    await s.provider._handleWebviewMessage({ type: "finish_onboarding_model", provider: "openai", modelId: "gpt-x" });
    const last = s.posted.filter((m) => m.type === "key_configured_success").at(-1);
    assert.ok(last, "no completion message");
    assert.ok(last.unverified, "the onboarding button would say Connected! for a rejected key");
  });

  it("session tab: tests the saved key and passes the unverified notice to its webview", async () => {
    const rpc = fakeRpc(onboardingRpc({ success: false, error_type: "timeout" }));
    const posted: any[] = [];
    const panel: any = Object.create(SessionTabPanel.prototype);
    Object.assign(panel, { _rpcClient: rpc, _sessionId: "s1", _currentMode: "safe", _postMessage: (m: any) => posted.push(m) });
    await panel._handleMessage({ type: "set_api_key", provider: "openai", apiKey: "sk-test-FAKEfake0000FAKEfake0000" });
    const methods = rpc.calls.map((c) => c.method);
    assert.ok(methods.indexOf("config.set_api_key") < methods.indexOf("config.test_provider"));
    assert.equal(posted.find((m) => m.type === "key_configured_select_model")?.unverified, "Saved, but couldn't verify: Couldn't reach provider");
    await panel._handleMessage({ type: "refresh_provider_models", provider: "<bad>" });
    assert.ok(!rpc.calls.some((c) => c.method === "config.refresh_provider_models"));
  });

  it("the onboarding badge and button say Connected only on a pass", () => {
    const badge = element();
    const button = element();
    const hb = loadChat({ elements: { "onboarding-step2-badge": badge, "btn-onboarding-save": button } });
    hb.post({ type: "key_configured_select_model", provider: "openai", models: [{ id: "gpt-x", provider: "openai" }], defaultModel: "gpt-x",
      unverified: "Saved, but couldn't verify: Key rejected" });
    assert.equal(badge.textContent, "Saved, but couldn't verify: Key rejected");
    hb.post({ type: "key_configured_success", provider: "openai", model: "gpt-x", unverified: "Saved, but couldn't verify: Key rejected" });
    assert.ok(!String(button.innerHTML).includes("Connected"), button.innerHTML);
    hb.post({ type: "key_configured_select_model", provider: "openai", models: [{ id: "gpt-x", provider: "openai" }], defaultModel: "gpt-x" });
    assert.equal(badge.textContent, "Openai connected");
  });
});
