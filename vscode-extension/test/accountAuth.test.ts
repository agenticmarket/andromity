import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const errors: string[] = [];
Module.prototype.require = function (name: string) {
  if (name === "vscode") return { window: {
    showErrorMessage: (message: string) => errors.push(message),
    showInformationMessage: () => {}, showWarningMessage: () => {},
  } };
  return originalRequire.apply(this, arguments);
};
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
Module.prototype.require = originalRequire;

it("rejects failed and anonymous token validation before persisting credentials", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const response of [new Response('{}', { status: 401 }), new Response('{"plan":"anonymous"}')]) {
      const stores: string[] = [];
      const provider = Object.create(ChatViewProvider.prototype);
      provider._getGatewayBaseUrl = () => "https://gateway.example";
      provider._context = { secrets: { store: async (key: string) => stores.push(key) } };
      provider._rpcClient = { call: async () => { throw new Error("must not call daemon"); } };
      globalThis.fetch = async () => response;
      await provider.handleAuthToken("andromity_unregistered");
      assert.deepEqual(stores, []);
    }
    assert.equal(errors.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

it("a rejected saved token clears daemon credentials and broadcasts signed-out status", async () => {
  const originalFetch = globalThis.fetch;
  const deleted: string[] = [];
  const calls: string[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const provider = Object.create(ChatViewProvider.prototype);
  provider._getGatewayBaseUrl = () => "https://gateway.example";
  provider._context = { secrets: {
    get: async (key: string) => key === "andromity.authToken" ? "rejected-token" : "developer",
    delete: async (key: string) => deleted.push(key),
  } };
  provider._rpcClient = { call: async (method: string) => calls.push(method) };
  provider.broadcastToWebviews = (message: Record<string, unknown>) => posts.push(message);
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    const usage = await provider.fetchUsage(true);
    assert.equal(usage.plan, "anonymous");
    assert.ok(deleted.includes("andromity.authToken"));
    assert.deepEqual(calls, ["auth.logout"]);
    assert.ok(posts.some(message => message.isAuthenticated === false));
  } finally { globalThis.fetch = originalFetch; }
});

it("a valid sign-in is applied to the daemon before credentials are saved", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const provider = Object.create(ChatViewProvider.prototype);
  provider._getGatewayBaseUrl = () => "https://gateway.example";
  provider._context = { secrets: { store: async () => calls.push("store") } };
  provider._rpcClient = { call: async (method: string) => calls.push(method) };
  provider.broadcastToWebviews = () => {};
  provider.fetchUsage = async () => {};
  provider.refreshConfig = async () => {};
  try {
    globalThis.fetch = async () => new Response('{"plan":"authenticated"}');
    await provider.handleAuthToken("andromity_valid");
    assert.deepEqual(calls, ["config.set_api_key", "config.set", "config.set", "store"]);
  } finally { globalThis.fetch = originalFetch; }
});

it("anonymous usage lookups send the daemon's per-install ID instead of the shared fallback", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<string | null> = [];
  const calls: string[] = [];
  const provider = Object.create(ChatViewProvider.prototype);
  provider._getGatewayBaseUrl = () => "https://gateway.example";
  provider._context = { secrets: { get: async () => undefined } };
  provider._rpcClient = { call: async (method: string) => {
    calls.push(method);
    return { client_id: "anon_0123456789abcdef0123456789abcdef" };
  } };
  provider.broadcastToWebviews = () => {};
  try {
    globalThis.fetch = async (_url: any, init?: any) => {
      sent.push(new Headers(init?.headers).get("x-andromity-client-id"));
      return new Response('{"plan":"anonymous"}');
    };
    await provider.fetchUsage(true);
    await provider.fetchUsage(true);
    assert.deepEqual(sent, Array(2).fill("anon_0123456789abcdef0123456789abcdef"));
    assert.deepEqual(calls, ["gateway.clientId"]);
  } finally { globalThis.fetch = originalFetch; }
});

it("anonymous usage lookups still work when the daemon cannot report its ID", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<string | null> = [];
  const provider = Object.create(ChatViewProvider.prototype);
  provider._getGatewayBaseUrl = () => "https://gateway.example";
  provider._context = { secrets: { get: async () => undefined } };
  provider._rpcClient = { call: async () => { throw new Error("daemon starting"); } };
  provider.broadcastToWebviews = () => {};
  try {
    globalThis.fetch = async (_url: any, init?: any) => {
      sent.push(new Headers(init?.headers).get("x-andromity-client-id"));
      return new Response('{"plan":"anonymous"}');
    };
    const usage = await provider.fetchUsage(true);
    assert.equal(usage.plan, "anonymous");
    assert.deepEqual(sent, ["local_client"]);
  } finally { globalThis.fetch = originalFetch; }
});
