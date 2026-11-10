import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { element, loadChat } from "./helpers/chatHarness.js";
import { MiniDocument, dangerousNodes } from "./helpers/miniDom.js";

let configuredOllamaHost: string | undefined;
const vscodeMock: any = {
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: (key: string) => (key === "ollamaHost" && configuredOllamaHost ? { globalValue: configuredOllamaHost } : undefined),
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
  env: { isTelemetryEnabled: true },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join("/"), parse: (value: string) => value, file: (fsPath: string) => ({ fsPath }) },
};
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  return name === "vscode" ? vscodeMock : originalRequire.apply(this, arguments);
};
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
Module.prototype.require = originalRequire;

const BANNER_KEY = "andromity.ollamaBannerShown";

function memento(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => { store.set(key, value); },
  };
}

type Mem = ReturnType<typeof memento>;

interface Setup {
  provider?: string;
  model?: string;
  providers?: Array<{ id: string; has_key: boolean }>;
  state?: any;
  noContext?: boolean;
  realPost?: boolean;
  noView?: boolean;
  pageNotReady?: boolean;
}

const KEYLESS_ENGINE_PROVIDERS = [
  { id: "andromity", has_key: true }, { id: "ollama", has_key: true },
  { id: "openrouter", has_key: false }, { id: "openai", has_key: false }, { id: "anthropic", has_key: false },
];
const NO_KEY_PROVIDERS = [{ id: "andromity", has_key: false }, { id: "ollama", has_key: false }, { id: "openrouter", has_key: false }];

function makeProvider(setup: Setup = {}) {
  const posted: any[] = [];
  const rpc: Array<{ method: string; params: any }> = [];
  const state: Mem = setup.state ?? memento();
  const p: any = new ChatViewProvider({ fsPath: "ext" } as any, undefined);
  p._providers = setup.providers ?? NO_KEY_PROVIDERS;
  p._currentProvider = setup.provider ?? "andromity";
  p._currentModel = setup.model ?? "auto";
  p._models = [];
  p._rpcClient = { call: async (method: string, params: any) => { rpc.push({ method, params }); return {}; }, on() {}, off() {} };
  p._checkOllamaCliInstalled = async () => false;
  if (!setup.noContext) p._context = { globalState: state, subscriptions: [], secrets: { get: async () => undefined } };
  if (!setup.noView) p._view = { webview: { postMessage: () => true }, visible: true };
  p._webviewReady = !setup.pageNotReady;
  if (!setup.realPost) p._postToWebview = (msg: any) => { posted.push(msg); };
  const detections = () => posted.filter((m) => m.type === "ollama_detected");
  return { p, posted, rpc, state, detections };
}

function status(host: string, models: string[], cloudModels: string[] = [], bestModel?: string | null, bestLocalModel?: string | null) {
  const local = bestLocalModel !== undefined ? bestLocalModel : (models.find((m) => !cloudModels.includes(m)) ?? null);
  const best = bestModel !== undefined ? bestModel : (local ?? models[0] ?? null);
  return { running: true, installed: true, models, bestModel: best, bestLocalModel: local, host, cloudModels };
}

const detection = (model: string, host: string, cloudModels: string[] = [], connected = true) => ({ model, connected, status: status(host, [model], cloudModels) });

function stubProbe(p: any, s: any) {
  p.probeOllama = async () => { p._lastOllamaStatus = s; return s; };
}

const servers: http.Server[] = [];
afterEach(async () => {
  configuredOllamaHost = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); })));
});

async function tagsServer(models: any[], host = "127.0.0.1"): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, () => resolve()); });
  const { port } = server.address() as AddressInfo;
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

const entry = (name: string, extra: Record<string, unknown> = {}) => ({ name, model: name, ...extra });

describe("Ollama notice: where the model runs (loopback classification)", () => {
  function announceFor(host: string | undefined, model = "llama3.2:3b", cloudModels: string[] = []) {
    const { p } = makeProvider();
    const d = detection(model, host as string, cloudModels);
    return p._ollamaAnnouncement(d, "andromity");
  }

  it("treats every real loopback spelling as this computer", () => {
    const wrong = [
      "http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434", "http://LOCALHOST:11434", "http://127.0.0.2:11434",
      "http://ollama.localhost:11434", "http://127.1:11434", "https://localhost", "http://127.0.0.1:11434/", "http://127.0.0.1:11434/x/y",
      "http://[0:0:0:0:0:0:0:1]:11434",
      "http://2130706433:11434", "http://0x7f.0.0.1:11434", "http://127.0.0.1.:11434", "http://127.255.255.254:11434",
    ].filter((host) => announceFor(host)?.cloud !== false);
    assert.deepEqual(wrong, [], "these loopback hosts were announced as leaving the computer");
  });

  it("never claims a remote machine is this computer", () => {
    const spoofed = [
      "http://127.0.0.1.evil.com:11434", "http://127.evil.com:11434", "http://127.0.0.1.nip.io:11434", "http://localhost.attacker:11434",
      "http://notlocalhost:11434", "http://[::2]:11434", "http://10.0.0.5:11434", "http://192.168.1.2:11434", "http://169.254.169.254",
      "https://ollama.com", "http://user:pass@evil.com:11434", "http://localhost@evil.com:11434", "http://127.0.0.1@evil.com:11434",
      "http://evil.com/localhost", "http://evil.com?h=127.0.0.1", "http://evil.com#127.0.0.1", "http://128.0.0.1", "http://[::ffff:8.8.8.8]:11434",
      "http://localhost.evil.com", "http://127.0.0.1.:11434.evil.com", "http://127.0.0.256:11434", "http://1270.0.0.1:11434", "http://0127.0.0.1.evil.com",
      "http://127.0.0.1.evil.localhost.evil.com", "http://0.0.0.0:11434", "http://[::]:11434", "http://[::127.0.0.1]:11434",
    ].filter((host) => announceFor(host)?.cloud !== true);
    assert.deepEqual(spoofed, [], "these non-loopback hosts were announced as running on this computer");
  });

  it("does not claim local when the host is unknown, empty or not a URL", () => {
    for (const host of ["", "garbage", "localhost", "127.0.0.1:11434", "   "]) {
      assert.equal(announceFor(host)?.cloud, true, JSON.stringify(host));
    }
    assert.equal(announceFor(undefined)?.cloud, true, "no host at all");
  });

  it("calls a model cloud when the probe lists it as cloud even on a loopback host", () => {
    assert.equal(announceFor("http://127.0.0.1:11434", "gpt-oss:120b-cloud", ["gpt-oss:120b-cloud"])?.cloud, true);
    assert.equal(announceFor("http://127.0.0.1:11434", "llama3.2:3b", ["gpt-oss:120b-cloud"])?.cloud, false);
  });

  it("does not mix up the model that was connected with another model that is cloud", () => {
    for (const [model, cloud] of [["a:7b", false], ["b:7b-cloud", true], ["B:7B-CLOUD", false]] as const) {
      const { p } = makeProvider();
      const d = { model, connected: true, status: status("http://127.0.0.1:11434", ["a:7b", "b:7b-cloud"], ["b:7b-cloud"]) };
      assert.equal(p._ollamaAnnouncement(d, "andromity")?.cloud, cloud, model);
    }
  });
});

describe("Ollama notice: which models count as cloud (real /api/tags parsing)", () => {
  async function probe(models: any[]) {
    const url = await tagsServer(models);
    const { p } = makeProvider();
    return p._probeOllamaHost(url);
  }

  it("marks cloud suffixes in any case and remote entries, and nothing else", async () => {
    const cloud = ["gpt-oss:120b-cloud", "qwen3-coder:480b-cloud", "kimi-k2:1t-cloud", "foo:cloud", "FOO:CLOUD", "GPT-OSS:120B-CLOUD", "Foo:Cloud", "my-cloud"];
    const local = ["cloudy-llama", "cloud-llama:latest", "llama3:latest", "mycloud:7b", "my-cloud:7b", "llama:cloudy", "cloud:7b", "notcloud", "cloud7b", "cloud-", "mycloud"];
    const remote = [entry("plain:7b", { remote_host: "https://ollama.com:443" }), entry("other", { remote_model: "other:120b" })];
    const notRemote = [entry("keep-a:7b", { remote_host: "" }), entry("keep-b:7b", { remote_host: null, remote_model: null }), entry("keep-c:7b", { remote_host: 0 })];
    const status = await probe([...cloud.map((n) => entry(n)), ...local.map((n) => entry(n)), ...remote, ...notRemote]);
    assert.equal(status.running, true);
    assert.deepEqual([...status.cloudModels].sort(), [...cloud, "plain:7b", "other"].sort());
  });

  it("reads cloud status from entries that have only a model field", async () => {
    const status = await probe([{ model: "alpha:cloud" }, { model: "beta:7b" }]);
    assert.deepEqual(status.cloudModels, ["alpha:cloud"]);
    assert.deepEqual(status.models, ["alpha:cloud", "beta:7b"]);
  });

  it("prefers a local model over a cloud one for the connection, whatever the name scores", async () => {
    const status = await probe([entry("qwen3-coder:480b-cloud"), entry("deepseek-coder-v2:cloud"), entry("tinyllama:1b")]);
    assert.equal(status.bestModel, "tinyllama:1b");
    const mistralOnly = await probe([entry("qwen3-coder:480b-cloud"), entry("mistral:7b")]);
    assert.equal(mistralOnly.bestModel, "mistral:7b");
  });

  it("falls back to a cloud model only when there is no local chat model", async () => {
    const onlyCloud = await probe([entry("qwen3-coder:480b-cloud"), entry("nomic-embed-text:latest")]);
    assert.equal(onlyCloud.bestModel, "qwen3-coder:480b-cloud");
    assert.deepEqual(onlyCloud.cloudModels, ["qwen3-coder:480b-cloud"]);
    assert.ok(!onlyCloud.models.includes("nomic-embed-text:latest"), "embedding models are not offered as chat models");
  });

  it("returns no best model for an empty list", async () => {
    const none = await probe([]);
    assert.equal(none.running, true);
    assert.equal(none.bestModel, null);
    assert.deepEqual(none.models, []);
  });

  it("survives hostile or malformed entries without throwing or leaking a cloud claim", async () => {
    for (const models of [[null], [{}], [{ name: 5 }], [{ name: { toString: "x" } }], [[]], "oops", { a: 1 }, [{ name: "ok:cloud" }, null]]) {
      const status = await probe(models as any);
      assert.equal(status.running, true);
      assert.ok(Array.isArray(status.models));
      assert.equal(status.bestModel === null || typeof status.bestModel === "string", true, JSON.stringify(models));
    }
  });

  it("keeps a large model list responsive (no quadratic stall)", async () => {
    const models = Array.from({ length: 6000 }, (_, i) => entry(i % 2 ? `m${i}:cloud` : `m${i}:7b`));
    const url = await tagsServer(models);
    const { p } = makeProvider();
    const started = Date.now();
    const result = await p._probeOllamaHost(url);
    assert.equal(result.models.length, 6000);
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
  });

  it("does not hang or misreport on a server that is not Ollama", async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end("<html>not json</html>"); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { p } = makeProvider();
    const result = await p._probeOllamaHost(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.equal(result.bestModel, null);
    assert.deepEqual(result.models, []);
  });
});

describe("Ollama notice: shown once, to anyone not already on Ollama", () => {
  it("announces a fresh automatic connection once and records it", async () => {
    const h = makeProvider({ provider: "andromity" });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b", "qwen3:8b-cloud"], ["qwen3:8b-cloud"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections().length, 1);
    assert.deepEqual(h.detections()[0].announce, { model: "llama3.2:3b", cloud: false, connected: true });
    assert.equal(h.state.store.get(BANNER_KEY), true);
    assert.equal(h.p._currentProvider, "ollama");
    assert.deepEqual(h.rpc.filter((c) => c.method === "config.set").map((c) => c.params.key).sort(), ["model", "provider"]);
  });

  it("never announces a second time, in this window or a new one", async () => {
    const state = memento();
    const s = status("http://127.0.0.1:11434", ["llama3.2:3b"]);
    const first = makeProvider({ state });
    stubProbe(first.p, s);
    await first.p._refreshOllamaDetection();
    assert.ok(first.detections()[0].announce);

    first.p._currentProvider = "andromity";
    await first.p._refreshOllamaDetection();
    await first.p._refreshOllamaDetection();
    const second = makeProvider({ state });
    stubProbe(second.p, s);
    await second.p._refreshOllamaDetection();
    for (const h of [first, second]) {
      assert.ok(h.detections().slice(h === first ? 1 : 0).every((m) => m.announce === null), "later detections carry announce: null");
    }
  });

  it("does not announce or consume the once-only flag when Ollama is not running", async () => {
    const h = makeProvider();
    stubProbe(h.p, { running: false, installed: true, models: [], bestModel: null, host: "http://127.0.0.1:11434" });
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections().length, 0);
    assert.equal(h.state.store.has(BANNER_KEY), false);
    assert.ok(h.posted.some((m) => m.type === "ollama_status_updated"));
  });

  it("does not announce or consume the flag when Ollama runs with no models", async () => {
    const h = makeProvider();
    stubProbe(h.p, status("http://127.0.0.1:11434", [], [], null, null));
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections().length, 0);
    assert.equal(h.state.store.has(BANNER_KEY), false);
  });

  it("does not announce when the provider was already Ollama, and keeps the user's installed model and the flag", async () => {
    const h = makeProvider({ provider: "ollama", model: "mistral:7b" });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["qwen2.5-coder:7b", "mistral:7b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentModel, "mistral:7b");
    assert.equal(h.detections()[0].announce, null);
    assert.equal(h.state.store.has(BANNER_KEY), false, "no banner was shown, so the single showing stays available");
    assert.equal(h.rpc.filter((c) => c.method === "config.set").length, 0, "the user's saved model is not rewritten");
  });

  it("does not swap a cloud model the user already uses for a local one", async () => {
    const h = makeProvider({ provider: "ollama", model: "gpt-oss:120b-cloud" });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["gpt-oss:120b-cloud", "llama3.2:3b"], ["gpt-oss:120b-cloud"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentModel, "gpt-oss:120b-cloud");
    assert.equal(h.rpc.filter((c) => c.method === "config.set").length, 0);
  });

  it("keeps an installed model the user named without Ollama's default tag", async () => {
    const h = makeProvider({ provider: "ollama", model: "llama3" });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["qwen2.5-coder:7b", "llama3:latest"], [], "qwen2.5-coder:7b", "qwen2.5-coder:7b"));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentModel, "llama3");
    assert.equal(h.rpc.filter((c) => c.method === "config.set").length, 0, "and the saved model must not be rewritten");
  });

  it("does not treat a different model, a partial name or another tag as the installed one", async () => {
    for (const saved of ["llama", "llama3:8b", "llama3:", "llama3:LATEST", "lama3", "llama3:latest:x", ""]) {
      const h = makeProvider({ provider: "ollama", model: saved });
      stubProbe(h.p, status("http://127.0.0.1:11434", ["mistral:7b", "llama3:latest"], [], "mistral:7b", "mistral:7b"));
      await h.p._refreshOllamaDetection();
      assert.equal(h.p._currentModel, "mistral:7b", `saved ${JSON.stringify(saved)} is not installed`);
    }
  });

  it("replaces a missing saved model with a local one, never a cloud one", async () => {
    const h = makeProvider({ provider: "ollama", model: "llama3:8b" });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["gpt-oss:120b-cloud", "tiny:1b"], ["gpt-oss:120b-cloud"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentModel, "tiny:1b");
    assert.equal(h.detections()[0].announce, null, "they were already on Ollama");
  });

  it("does not quietly move a user of a local Ollama model onto a cloud model when their model is gone", async () => {
    const h = makeProvider({ provider: "ollama", model: "llama3:8b" });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["gpt-oss:120b-cloud"], ["gpt-oss:120b-cloud"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentModel, "llama3:8b");
    assert.equal(h.p._currentProvider, "ollama");
    assert.equal(h.rpc.filter((c) => c.method === "config.set").length, 0, "nothing is rewritten when only cloud models exist");
  });

  it("never switches anything when only cloud models exist, for a user with no keys either", async () => {
    const h = makeProvider({ provider: "andromity", providers: NO_KEY_PROVIDERS });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["qwen3-coder:480b-cloud"], ["qwen3-coder:480b-cloud"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentProvider, "andromity");
    assert.equal(h.p._currentModel, "auto");
    assert.equal(h.rpc.filter((c) => c.method === "config.set").length, 0);
    assert.deepEqual(h.detections()[0].announce, { model: "qwen3-coder:480b-cloud", cloud: true, connected: false });
  });

  it("tells a user with an API key that Ollama is running, once, without switching them", async () => {
    const h = makeProvider({ provider: "openrouter", providers: [{ id: "openrouter", has_key: true }] });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentProvider, "openrouter");
    assert.equal(h.rpc.filter((c) => c.method === "config.set").length, 0);
    assert.deepEqual(h.detections()[0].announce, { model: "llama3.2:3b", cloud: false, connected: false });
    assert.equal(h.state.store.get(BANNER_KEY), true);
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections()[1].announce, null);
  });

  it("with the providers the engine really reports (andromity and ollama count as having a key) it announces without switching", async () => {
    const h = makeProvider({ provider: "andromity", providers: KEYLESS_ENGINE_PROVIDERS });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentProvider, "andromity", "nobody is moved off their provider silently");
    assert.deepEqual(h.detections()[0].announce, { model: "llama3.2:3b", cloud: false, connected: false });
  });

  it("announces the cloud wording for a non-loopback host", async () => {
    const remote = makeProvider({ provider: "openrouter", providers: [{ id: "openrouter", has_key: true }] });
    stubProbe(remote.p, status("http://192.168.1.50:11434", ["llama3.2:3b"]));
    await remote.p._refreshOllamaDetection();
    assert.deepEqual(remote.detections()[0].announce, { model: "llama3.2:3b", cloud: true, connected: false });
  });

  it("never announces a spoofed loopback host as local, through the whole flow", async () => {
    for (const host of ["http://127.0.0.1.evil.com:11434", "http://127.evil.com:11434", "http://localhost.attacker:11434"]) {
      const h = makeProvider({ provider: "openrouter", providers: [{ id: "openrouter", has_key: true }] });
      stubProbe(h.p, status(host, ["llama3.2:3b"]));
      await h.p._refreshOllamaDetection();
      assert.equal(h.detections()[0].announce?.cloud, true, host);
    }
  });

  it("works end to end over HTTP: configured loopback host, local model preferred, announced as local", async () => {
    configuredOllamaHost = await tagsServer([entry("gpt-oss:120b-cloud", { remote_host: "https://ollama.com:443" }), entry("llama3.2:3b")]);
    const h = makeProvider();
    await h.p._refreshOllamaDetection();
    assert.deepEqual(h.detections()[0].announce, { model: "llama3.2:3b", cloud: false, connected: true });
    assert.equal(h.p._currentProvider, "ollama");
    assert.equal(h.p._currentModel, "llama3.2:3b");
  });

  it("works end to end over HTTP with only cloud models: announced as cloud, nothing switched", async () => {
    configuredOllamaHost = await tagsServer([entry("gpt-oss:120b-cloud", { remote_host: "https://ollama.com:443" })]);
    const h = makeProvider();
    await h.p._refreshOllamaDetection();
    assert.deepEqual(h.detections()[0].announce, { model: "gpt-oss:120b-cloud", cloud: true, connected: false });
    assert.equal(h.p._currentProvider, "andromity");
  });

  it("works end to end over IPv6 loopback", async (t) => {
    try {
      configuredOllamaHost = await tagsServer([entry("llama3.2:3b")], "::1");
    } catch {
      t.skip("IPv6 loopback unavailable");
      return;
    }
    const h = makeProvider();
    await h.p._refreshOllamaDetection();
    assert.deepEqual(h.detections()[0]?.announce, { model: "llama3.2:3b", cloud: false, connected: true });
  });

  it("does not connect or announce an embedding model when that is all that is installed", async () => {
    configuredOllamaHost = await tagsServer([entry("nomic-embed-text:latest"), entry("mxbai-embed-large:latest")]);
    const h = makeProvider();
    await h.p._refreshOllamaDetection();
    assert.notEqual(h.p._currentProvider, "ollama", "an embedding model cannot chat");
    assert.ok(!h.detections().some((m) => /embed/.test(String(m.announce?.model))), "the notice must not offer an embedding model as the one to use");
  });

  it("is robust to missing global state: still patches the model list, announces nothing", async () => {
    const h = makeProvider({ noContext: true });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections().length, 1);
    assert.equal(h.detections()[0].announce, null);
    assert.ok(h.detections()[0].models.some((m: any) => m.id === "llama3.2:3b"));
  });

  it("still patches the model list, announcing nothing, if reading the once-only flag throws", async () => {
    const state = memento();
    state.get = () => { throw new Error("storage unavailable"); };
    const h = makeProvider({ state });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections().length, 1, "a notice failure must not drop the model list update");
    assert.equal(h.detections()[0].announce, null);
  });

  it("does not leave an unhandled rejection when saving the flag fails", async () => {
    const state = memento();
    state.update = () => Promise.reject(new Error("disk full"));
    const h = makeProvider({ state });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await h.p._refreshOllamaDetection();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", listener);
    }
    assert.deepEqual(seen, []);
    assert.equal(h.detections().length, 1);
  });

  it("still patches the model list if saving the flag throws synchronously", async () => {
    const state = memento();
    state.update = (() => { throw new Error("storage closed"); }) as any;
    const h = makeProvider({ state });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections().length, 1, "the model list update must survive a failing flag write");
  });

  it("shows at most one banner across concurrent detections and across providers sharing state", async () => {
    const state = memento();
    const s = status("http://127.0.0.1:11434", ["llama3.2:3b"]);
    const windows = Array.from({ length: 4 }, () => { const h = makeProvider({ state }); stubProbe(h.p, s); return h; });
    await Promise.all(windows.flatMap((h) => [h.p._refreshOllamaDetection(), h.p._refreshOllamaDetection(), h.p._refreshOllamaDetection()]));
    const announced = windows.flatMap((h) => h.detections()).filter((m) => m.announce);
    assert.equal(announced.length, 1);
  });

  it("collapses overlapping refreshes in one window into one detection", async () => {
    const h = makeProvider();
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await Promise.all([h.p._refreshOllamaDetection(), h.p._refreshOllamaDetection(), h.p._refreshOllamaDetection()]);
    assert.equal(h.detections().length, 1);
  });

  it("allows a later refresh after a failed one", async () => {
    const h = makeProvider();
    let fail = true;
    h.p.probeOllama = async () => {
      if (fail) throw new Error("probe exploded");
      const s = status("http://127.0.0.1:11434", ["llama3.2:3b"]);
      h.p._lastOllamaStatus = s;
      return s;
    };
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections().length, 0);
    assert.equal(h.state.store.has(BANNER_KEY), false);
    fail = false;
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections().length, 1);
    assert.ok(h.detections()[0].announce);
  });

  it("describes the server that chose the model, not whatever probe finished last", async () => {
    const h = makeProvider();
    const chosen = status("http://127.0.0.1:11434", ["qwen3-coder:480b-cloud"], ["qwen3-coder:480b-cloud"]);
    const unrelated = status("http://127.0.0.1:11434", ["something-else:7b"], []);
    h.p.probeOllama = async () => {
      h.p._lastOllamaStatus = chosen;
      Promise.resolve().then(() => { h.p._lastOllamaStatus = unrelated; });
      return chosen;
    };
    await h.p._refreshOllamaDetection();
    assert.equal(h.detections()[0].announce?.cloud, true, "a cloud model must never be announced as running on this computer");
  });

  it("does not announce a model that is not in the list the page was sent", async () => {
    const h = makeProvider({ provider: "openrouter", providers: [{ id: "openrouter", has_key: true }] });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    const sent = h.detections()[0];
    assert.ok(sent.models.some((m: any) => m.id === sent.announce.model && m.provider === "ollama"), "the banner says to choose it in the picker, so it must be there");
  });
});

describe("Ollama notice: delivery", () => {
  it("does not consume the once-only flag when there is no chat view to show it in", async () => {
    const h = makeProvider({ realPost: true, noView: true, provider: "openrouter", providers: [{ id: "openrouter", has_key: true }] });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.state.store.has(BANNER_KEY), false, "the user never saw the notice");
    h.p._view = { webview: { postMessage: () => true }, visible: true };
    h.p._webviewReady = true;
    h.p._postToWebview = (m: any) => h.posted.push(m);
    await h.p._refreshOllamaDetection();
    assert.ok(h.detections().at(-1)?.announce, "it is still available when a view exists");
  });

  it("an automatic connection whose notice could not be delivered is still announced later", async () => {
    const h = makeProvider({ realPost: true, noView: true });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.p._currentProvider, "ollama", "the connection happened");
    h.p._view = { webview: { postMessage: () => true }, visible: true };
    h.p._webviewReady = true;
    h.p._postToWebview = (m: any) => h.posted.push(m);
    await h.p._refreshOllamaDetection();
    assert.ok(h.detections().at(-1)?.announce, "the user was switched to Ollama and has never been told, and every later start sees them as already on Ollama");
  });

  it("does not consume the once-only flag while the chat page is still loading", async () => {
    const h = makeProvider({ pageNotReady: true });
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    assert.equal(h.state.store.has(BANNER_KEY), false, "a message posted before the page's script is listening is lost");
  });

  it("posts the notice to the chat view when there is one", async () => {
    const h = makeProvider({ realPost: true });
    const sent: any[] = [];
    h.p._view = { webview: { postMessage: (m: any) => { sent.push(m); return true; } }, visible: true };
    stubProbe(h.p, status("http://127.0.0.1:11434", ["llama3.2:3b"]));
    await h.p._refreshOllamaDetection();
    const detected = sent.find((m) => m.type === "ollama_detected");
    assert.deepEqual(detected?.announce, { model: "llama3.2:3b", cloud: false, connected: true });
  });

});

describe("Ollama notice: old plumbing is gone", () => {
  it("init_state no longer carries the detected model, and nothing reads it", () => {
    const host = readFileSync("src/providers/ChatViewProvider.ts", "utf8");
    const client = readFileSync("src/providers/chatview/chatClientScript.ts", "utf8");
    assert.ok(!host.includes("ollamaDetectedModel") && !client.includes("ollamaDetectedModel"));
    assert.ok(!/100% privacy|0 API keys &amp; 100%/.test(client), "the old unconditional privacy claim is gone from the client");
  });
});

describe("Ollama notice in the chat webview", () => {
  function chat() {
    const h = loadChat();
    const inserted: any[] = [];
    h.byId["ollama-detected-banner"] = null;
    h.promptBox.parentElement = {
      insertBefore: (banner: any) => {
        inserted.push(banner);
        h.byId["ollama-detected-banner"] = banner;
      },
    };
    h.sandbox.document.createElement = () => {
      const el: any = element();
      el.remove = () => {
        const i = inserted.indexOf(el);
        if (i >= 0) inserted.splice(i, 1);
        if (h.byId["ollama-detected-banner"] === el) h.byId["ollama-detected-banner"] = null;
      };
      return el;
    };
    return { h, inserted, text: () => (inserted[0]?.innerHTML as string) ?? "" };
  }

  it("shows nothing when the host sends no announcement", () => {
    for (const announce of [null, undefined, {}, { model: "" }, { model: null }, { model: 0 }, "llama", [], 7]) {
      const c = chat();
      c.h.post({ type: "ollama_detected", model: "llama3:8b", models: [], status: null, announce });
      assert.equal(c.inserted.length, 0, JSON.stringify(announce));
    }
  });

  it("ignores the old message shape that carried only a model", () => {
    const c = chat();
    c.h.post({ type: "ollama_detected", model: "llama3:8b", models: [] });
    assert.equal(c.inserted.length, 0);
  });

  it("init_state no longer produces a banner, even from a host that still sends the old field", () => {
    const c = chat();
    c.h.post({ type: "init_state", sessionId: "s", model: "llama3:8b", provider: "ollama", ollamaDetectedModel: "llama3:8b", models: [], providers: [], sessions: [], skills: [] });
    assert.equal(c.inserted.length, 0);
  });

  it("says a local model runs here and prompts sent to it stay here, connected or not", () => {
    for (const connected of [true, false]) {
      const c = chat();
      c.h.post({ type: "ollama_detected", models: [], announce: { model: "llama3.2:3b", cloud: false, connected } });
      assert.equal(c.inserted.length, 1);
      const text = c.text();
      assert.match(text, /llama3.2:3b/);
      assert.match(text, /runs on this computer, so prompts sent to it stay here./);
      assert.doesNotMatch(text, /leave this computer|cloud|100%|privacy/i);
    }
  });

  it("says a cloud model runs on Ollama's cloud and prompts sent to it leave this computer, connected or not", () => {
    for (const connected of [true, false]) {
      const c = chat();
      c.h.post({ type: "ollama_detected", models: [], announce: { model: "gpt-oss:120b-cloud", cloud: true, connected } });
      const text = c.text();
      assert.match(text, /runs on Ollama(?:'|&#39;)s cloud, so prompts sent to it leave this computer./);
      assert.doesNotMatch(text, /stay here|on this computer|100%|privacy|0 API keys/i);
    }
  });

  it("a connection says Connected to Ollama and offers no choice; a plain detection says Ollama is running and tells where to choose it", () => {
    const connected = chat();
    connected.h.post({ type: "ollama_detected", models: [], announce: { model: "m:1b", cloud: false, connected: true } });
    assert.match(connected.text(), /Connected to Ollama/);
    assert.doesNotMatch(connected.text(), /Ollama is running|model picker/);

    for (const announce of [{ model: "m:1b", cloud: false, connected: false }, { model: "m:1b", cloud: false }, { model: "m:1b", cloud: true, connected: null }, { model: "m:1b", cloud: false, connected: 0 }]) {
      const c = chat();
      c.h.post({ type: "ollama_detected", models: [], announce });
      assert.match(c.text(), /Ollama is running/, JSON.stringify(announce));
      assert.match(c.text(), /Choose it in the model picker to use it./, JSON.stringify(announce));
      assert.doesNotMatch(c.text(), /Connected to Ollama/, JSON.stringify(announce));
    }
  });

  it("escapes hostile model names in the banner", () => {
    const names = [
      "<img src=x onerror=window.__pwn=1>", "\"><script>window.__pwn=2</script>", "'><svg onload=window.__pwn=3>", "a&b<c>d\"e'f",
      "</span><button onclick=window.__pwn=4>x</button>", "javascript:alert(1)", "x\u2028y\n<b>", "{{constructor}}", "${alert(1)}",
      "&lt;already&gt;", "&#60;script&#62;",
    ];
    for (const cloud of [false, true]) for (const connected of [false, true]) {
      for (const model of names) {
        const c = chat();
        c.h.post({ type: "ollama_detected", models: [], announce: { model, cloud, connected } });
        assert.equal(c.inserted.length, 1, model);
        const doc = new MiniDocument(`<div id="root">${c.text()}</div>`);
        assert.deepEqual(dangerousNodes(doc), [], `${model} (cloud=${cloud})`);
        assert.equal(doc.getElementById("root")!.querySelectorAll("button").length, 1, "only the dismiss button exists");
        assert.ok(doc.getElementById("root")!.textContent.includes(model), `the name is shown literally: ${model}`);
      }
    }
  });

  it("replaces an earlier banner rather than stacking, and a long name does not break it", () => {
    const c = chat();
    c.h.post({ type: "ollama_detected", models: [], announce: { model: "a:7b", cloud: false } });
    c.h.post({ type: "ollama_detected", models: [], announce: { model: "b".repeat(5000) + ":cloud", cloud: true } });
    assert.equal(c.inserted.length, 1);
    assert.match(c.text(), /leave this computer/);
  });

  it("treats a missing prompt box as a no-op rather than an error", () => {
    const h = loadChat();
    h.byId["ollama-detected-banner"] = null;
    h.promptBox.parentElement = null;
    h.sandbox.document.createElement = () => element();
    assert.doesNotThrow(() => h.post({ type: "ollama_detected", models: [], announce: { model: "m", cloud: false } }));
  });

  it("applies the model list from the same message even when there is no announcement", () => {
    const c = chat();
    c.h.post({ type: "ollama_detected", models: [{ id: "llama3:8b", name: "llama3:8b", provider: "ollama" }], announce: null });
    assert.deepEqual(c.h.eval("allModels.map(m => m.id)"), ["llama3:8b"]);
  });

  it("dismiss removes the banner", () => {
    const c = chat();
    c.h.post({ type: "ollama_detected", models: [], announce: { model: "a:7b", cloud: false } });
    assert.equal(c.inserted.length, 1);
    const banner = c.inserted[0];
    const dismiss = { closest: (sel: string) => (sel.includes("dismiss-ollama-banner") ? dismiss : null), dataset: {}, getAttribute: () => "dismiss-ollama-banner" };
    const event = { target: dismiss, preventDefault() {}, stopPropagation() {} };
    for (const fn of c.h.docListeners.click || []) fn(event);
    assert.equal(c.inserted.includes(banner), false);
  });
});
