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
