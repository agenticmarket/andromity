import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
let inspected: Record<string, unknown> = {};
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace: { getConfiguration: () => ({ inspect: () => inspected }) },
  };
  return originalRequire.apply(this, arguments);
};
const { accountUrl, normalizeAccountUrl, DEFAULT_GATEWAY_URL, DEFAULT_WEB_APP_URL } = require("../src/providers/accountEndpoints.js");
Module.prototype.require = originalRequire;

it("ignores workspace and folder overrides so a cloned repo cannot redirect the sign-in token", () => {
  inspected = { workspaceValue: "https://evil.example", workspaceFolderValue: "https://evil.example" };
  assert.equal(accountUrl("gatewayUrl"), DEFAULT_GATEWAY_URL);
  assert.equal(accountUrl("webAppUrl"), DEFAULT_WEB_APP_URL);
});

it("honours a user-level override on an allowed host", () => {
  inspected = { globalValue: "https://staging.gateway.agenticmarket.dev/" };
  assert.equal(accountUrl("gatewayUrl"), "https://staging.gateway.agenticmarket.dev");
  inspected = { globalValue: "http://127.0.0.1:8787" };
  assert.equal(accountUrl("gatewayUrl"), "http://127.0.0.1:8787");
});

it("rejects hosts and schemes that could receive the token", () => {
  for (const value of [
    "https://evil.example",
    "https://agenticmarket.dev.evil.example",
    "http://gateway.agenticmarket.dev",
    "https://user:pw@gateway.agenticmarket.dev",
    "https://gateway.agenticmarket.dev/?x=1",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(normalizeAccountUrl(value), undefined, value);
  }
});
