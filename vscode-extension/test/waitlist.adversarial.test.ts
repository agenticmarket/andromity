import { describe, it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const mockVscode: any = {
  Uri: {
    joinPath: (...args: any[]) => ({ fsPath: args.map((a) => (typeof a === "object" ? a.fsPath || a.path : String(a))).join("/") }),
    file: (p: string) => ({ fsPath: p }),
    parse: (url: string) => ({ url }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined }),
    workspaceFolders: [{ uri: { fsPath: "D:/mock/ws" } }],
  },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  extensions: { getExtension: () => ({ packageJSON: { version: "0.2.25" } }) },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0 },
  commands: { executeCommand: async () => undefined },
  env: { machineId: "machine", openExternal: async () => true },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments as any);
};
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
const { WaitlistController } = require("../src/engagement/waitlistController.js");
const { EventEmitter } = require("node:events");

const OFFERED_KEY = "andromity.waitlistOffered";
const JOINED_KEY = "andromity.waitlistJoined";

/** The real extension host binding for engine events, with the real controller on an in-memory globalState. */
function engineChat(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const controller = new WaitlistController({
    globalState: { get: (key: string) => store.get(key), update: async (key: string, value: unknown) => { store.set(key, value); } },
    extension: { packageJSON: { version: "0.2.25" } },
  });
  const client: any = new EventEmitter();
  client.off = client.removeListener.bind(client);
  client.call = async () => ({});
  const provider = Object.create(ChatViewProvider.prototype);
  const posts: any[] = [];
  Object.assign(provider, {
    _rpcClient: client, _rpcDisposables: [], _waitlist: controller, _postToWebview: (m: unknown) => posts.push(m),
    _currentSessionId: "s1", _runningSessions: new Set(), _sessionNames: new Map(),
    _noteWhileAway() {}, _refreshSidePanel() {}, isSoundEnabled: () => false,
  });
  provider._bindRpcEvents();
  const emit = async (event: string, params: Record<string, unknown>) => {
    client.emit(event, { session_id: "s1", ...params });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { store, controller, emit, posts };
}

describe("the offered flag follows the daily limit only", () => {
  it("a daily-limit turn result with the action marks it (control)", async () => {
    const chat = engineChat();
    await chat.emit("agent/done", { outcome: "error", error_type: "quota_exceeded", error_action: "join_waitlist" });
    assert.equal(chat.controller.offered(), true);
  });

  for (const error_type of ["service_busy", "service_unavailable", "access_denied", "model_unavailable", "sign_in_invalid", "gateway_auth_error", "generic"]) {
    it(`a ${error_type} turn result that carries join_waitlist does not mark it`, async () => {
      const chat = engineChat();
      await chat.emit("agent/done", { outcome: "error", error_type, error_action: "join_waitlist" });
      assert.equal(chat.store.get(OFFERED_KEY), undefined, `${error_type} set the permanent offered flag`);
      assert.equal(chat.controller.offered(), false);
    });
  }

  it("a turn result without an error type does not mark it", async () => {
    const chat = engineChat();
    await chat.emit("agent/done", { outcome: "error", error_action: "join_waitlist" });
    assert.equal(chat.controller.offered(), false, "the action alone, with no daily-limit type, set the offered flag");
  });

  it("a turn that finished normally does not mark it, whatever fields it carries", async () => {
    const chat = engineChat();
    await chat.emit("agent/done", { outcome: "success", error_type: "quota_exceeded", error_action: "join_waitlist" });
    await chat.emit("agent/done", { error_action: "join_waitlist" });
    assert.equal(chat.controller.offered(), false, "a successful turn set the offered flag");
  });
});

describe("switching the offer off in the gateway", () => {
  it("a later daily-limit refusal without the action stops the offer for people who have not joined", { todo: "product decision pending: whether switching the offer off clears it" }, async () => {
    const chat = engineChat();
    await chat.emit("agent/done", { outcome: "error", error_type: "quota_exceeded", error_action: "join_waitlist" });
    assert.equal(chat.controller.offered(), true);
    await chat.emit("agent/done", { outcome: "error", error_type: "quota_exceeded" });
    assert.equal(chat.controller.offered(), false,
      "the gateway no longer offers the waitlist, yet onboarding and Settings keep showing 'Need more? Join the waitlist'");
    assert.deepEqual(chat.controller.stateMessage(), { type: "waitlist_state", joined: false, offered: false });
  });

  it("people who joined still see that they are on the waitlist", async () => {
    const chat = engineChat({ [JOINED_KEY]: true, [OFFERED_KEY]: true });
    await chat.emit("agent/done", { outcome: "error", error_type: "quota_exceeded" });
    assert.equal(chat.controller.joined(), true);
    assert.equal(chat.controller.stateMessage().joined, true);
  });
});
