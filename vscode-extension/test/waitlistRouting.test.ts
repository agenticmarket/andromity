import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const commands: string[] = [];
const errors: string[] = [];
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
    showErrorMessage: (message: string) => { errors.push(message); return Promise.resolve(undefined); },
  },
  extensions: { getExtension: () => ({ packageJSON: { version: "0.2.25" } }) },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0 },
  commands: { executeCommand: async (command: string) => { commands.push(command); } },
  env: { machineId: "machine", openExternal: async () => true },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments as any);
};
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
const { SessionTabPanel } = require("../src/panels/SessionTabPanel.js");
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");

/** Stands in for WaitlistController and records what reaches it. */
function fakeWaitlist(joined = false) {
  const handled: any[] = [];
  let shown = 0;
  return {
    handled,
    get shown() { return shown; },
    joined: () => joined,
    stateMessage: () => ({ type: "waitlist_state", joined }),
    offerShown: () => { shown++; },
    handleMessage: async (message: any, post: (reply: unknown) => void) => {
      handled.push(message);
      if (message.type === "waitlist_join") post({ type: "waitlist_result", ok: true });
      if (message.type === "waitlist_open") post({ type: "waitlist_form", joined, wants: [], heardFrom: [] });
      return true;
    },
  };
}

beforeEach(() => {
  commands.length = 0;
  errors.length = 0;
});

describe("settings: the Andromity card on API keys", () => {
  const settingsHtml: string = (SettingsPanel.prototype as any)._getHtmlForWebview.call({
    _panel: { webview: { cspSource: "vscode-webview:", asWebviewUri: (u: any) => `vscode-resource://${u.fsPath || u}` } },
    _extensionUri: { fsPath: "d:/ext", path: "/d:/ext" },
    _initialTab: "keys",
    _getNonce: () => "nonce",
  });

  function slice(start: string, end: string): string {
    const from = settingsHtml.indexOf(start);
    assert.ok(from !== -1, start);
    const to = settingsHtml.indexOf(end, from);
    assert.ok(to !== -1, end);
    return settingsHtml.slice(from, to + end.length);
  }

  const renderProviders = slice("function renderProviders() {", "\n      noteWaitlistOffer();\n    }");
  const noteWaitlistOffer = slice("function noteWaitlistOffer() {", "\n    }");
  const escapeHtml = slice("function escapeHtml(str) {", "\n    }");
  const stateCase = slice('case "waitlist_state": {', "break;");

  function settingsPage(options: { joined?: boolean; keysActive?: boolean } = {}) {
    const posted: any[] = [];
    const grid = { innerHTML: "" };
    const pane = {
      classList: { contains: (c: string) => c === "active" && options.keysActive !== false },
      querySelector: (selector: string) => (selector === ".waitlist-offer" && grid.innerHTML.includes("waitlist-offer") ? {} : null),
    };
    const sandbox: any = {
      document: { getElementById: (id: string) => (id === "keys-grid" ? grid : id === "pane-keys" ? pane : null), querySelectorAll: () => [] },
      vscode: { postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))) },
      allProviders: [{ id: "andromity", has_key: true }, { id: "openai", has_key: false }, { id: "ollama", has_key: true }],
      currentAccount: { isAuthenticated: false },
      waitlistJoined: options.joined === true,
      waitlistOfferNoted: false,
      ollamaStatus: null, ollamaChecked: false, activeProvider: "", renderModels() {},
      msg: null,
    };
    vm.createContext(sandbox);
    vm.runInContext(`${escapeHtml}\n${noteWaitlistOffer}\n${renderProviders}`, sandbox);
    const cards = () => grid.innerHTML.split('<div class="item-card">').slice(1);
    return { sandbox, posted, grid, cards, render: () => vm.runInContext("renderProviders()", sandbox) };
  }

  it("offers the waitlist on the Andromity card only, and notes the offer once", () => {
    const page = settingsPage();
    page.render();
    page.render();
    const cards = page.cards();
    assert.ok(cards[0].includes("Andromity Cloud Gateway"));
    assert.match(cards[0], /<button class="btn btn-secondary waitlist-offer" data-action="join-waitlist" title="Opens a short form in the chat">Need more\? Join the waitlist<\/button>/);
    assert.ok(cards.slice(1).every((card) => !card.includes("join-waitlist")));
    assert.deepEqual(page.posted, [{ type: "waitlist_offer_shown" }]);
  });

  it("shows 'On the waitlist ✓' disabled for people who joined and notes nothing", () => {
    const page = settingsPage({ joined: true });
    page.render();
    assert.match(page.cards()[0], /data-action="join-waitlist" disabled>On the waitlist ✓<\/button>/);
    assert.deepEqual(page.posted, []);
  });

  it("does not note the offer while the API keys tab is hidden", () => {
    const page = settingsPage({ keysActive: false });
    page.render();
    assert.ok(page.cards()[0].includes("Need more? Join the waitlist"));
    assert.deepEqual(page.posted, []);
  });

  it("redraws the card when the joined state changes", () => {
    const page = settingsPage();
    page.render();
    page.sandbox.msg = { type: "waitlist_state", joined: true };
    vm.runInContext(`switch (msg.type) { ${stateCase} } }`, page.sandbox);
    assert.equal(page.sandbox.waitlistJoined, true);
    assert.match(page.cards()[0], /disabled>On the waitlist ✓/);
    page.sandbox.msg = { type: "waitlist_state", joined: "yes" };
    vm.runInContext(`switch (msg.type) { ${stateCase} } }`, page.sandbox);
    assert.equal(page.sandbox.waitlistJoined, false, "only a real true counts");
  });

  it("asks the extension to open the chat form, but not after joining", () => {
    const branch = slice('} else if (action === "join-waitlist") {', "\n      }");
    const page = settingsPage();
    page.sandbox.action = "join-waitlist";
    vm.runInContext(`if (false) {${branch}`, page.sandbox);
    assert.deepEqual(page.posted, [{ type: "open_waitlist" }]);
    page.sandbox.waitlistJoined = true;
    vm.runInContext(`if (false) {${branch}`, page.sandbox);
    assert.equal(page.posted.length, 1);
  });

  it("the extension side opens the chat form, notes the offer and pushes the joined state", async () => {
    const waitlist = fakeWaitlist(true);
    let opened = 0;
    SettingsPanel.waitlist = waitlist;
    SettingsPanel.chatProvider = { openWaitlistForm: async () => { opened++; } };
    const panelPosts: any[] = [];
    SettingsPanel.currentPanel = { _panel: { webview: { postMessage: (m: unknown) => panelPosts.push(m) } } };
    SettingsPanel._cachedState = { waitlistJoined: false };
    try {
      const self = Object.create(SettingsPanel.prototype);
      await self._handleMessage({ type: "open_waitlist" });
      await self._handleMessage({ type: "waitlist_offer_shown" });
      assert.equal(opened, 1);
      assert.equal(waitlist.shown, 1);
      SettingsPanel.postWaitlistState();
      assert.deepEqual(panelPosts, [{ type: "waitlist_state", joined: true }]);
      assert.equal(SettingsPanel._cachedState.waitlistJoined, true);
      SettingsPanel.waitlist = undefined;
      SettingsPanel.postWaitlistState();
      assert.deepEqual(panelPosts.at(-1), { type: "waitlist_state", joined: false });
    } finally {
      SettingsPanel.waitlist = undefined;
      SettingsPanel.chatProvider = undefined;
      SettingsPanel.currentPanel = undefined;
      SettingsPanel._cachedState = null;
    }
  });
});

describe("chat view routing", () => {
  function chatView(waitlist: ReturnType<typeof fakeWaitlist> | null, connected = true) {
    const provider = Object.create(ChatViewProvider.prototype);
    const posts: any[] = [];
    provider._waitlist = waitlist;
    provider._postToWebview = (message: unknown) => posts.push(message);
    provider._currentSessionId = "s1";
    provider._rpcClient = connected ? { call: async () => ({}) } : undefined;
    provider._pythonBridge = undefined;
    return { provider, posts };
  }

  it("passes the waitlist messages to the controller and its replies back to the page", async () => {
    const waitlist = fakeWaitlist();
    const { provider, posts } = chatView(waitlist);
    for (const type of ["waitlist_offer_shown", "waitlist_open", "waitlist_join"]) await provider._handleWebviewMessage({ type });
    assert.deepEqual(waitlist.handled.map((m) => m.type), ["waitlist_offer_shown", "waitlist_open", "waitlist_join"]);
    assert.deepEqual(posts.map((m) => m.type), ["waitlist_form", "waitlist_result"]);
  });

  it("sends the joined state when the chat page is ready", async () => {
    for (const waitlist of [fakeWaitlist(true), null]) {
      const { provider, posts } = chatView(waitlist, false);
      Object.assign(provider, {
        _markWebviewReady() {}, broadcastAirGapState() {}, _refreshSidePanel() {},
        getWorkspaceIndex: async () => ({ files: [], dirs: [] }),
      });
      await provider._handleWebviewMessage({ type: "ready" });
      const states = posts.filter((m) => m.type === "waitlist_state");
      assert.deepEqual(states, waitlist ? [{ type: "waitlist_state", joined: true }] : []);
    }
  });

  it("opening the form from Settings focuses the chat and asks the controller for it", async () => {
    const waitlist = fakeWaitlist();
    const { provider, posts } = chatView(waitlist);
    provider._view = { webview: {} };
    provider._webviewReady = true;
    await provider.openWaitlistForm();
    assert.deepEqual(commands, ["andromity.chatView.focus"]);
    assert.deepEqual(waitlist.handled, [{ type: "waitlist_open" }]);
    assert.equal(posts[0].type, "waitlist_form");

    const { provider: bare } = chatView(null);
    await bare.openWaitlistForm();
    assert.deepEqual(commands, ["andromity.chatView.focus"], "nothing happens without a waitlist");
  });

  it("the waitlist works while the engine daemon is not connected, since it never uses it", async () => {
    const waitlist = fakeWaitlist();
    const { provider, posts } = chatView(waitlist, false);
    for (const type of ["waitlist_offer_shown", "waitlist_open", "waitlist_join"]) await provider._handleWebviewMessage({ type });
    assert.deepEqual(errors, [], "no 'daemon is not connected' error for a waitlist click");
    assert.deepEqual(waitlist.handled.map((m) => m.type), ["waitlist_offer_shown", "waitlist_open", "waitlist_join"]);
    assert.ok(!posts.some((m) => m.type === "action_failed"), JSON.stringify(posts));
    assert.ok(posts.some((m) => m.type === "waitlist_result"), "the form gets an answer instead of staying on 'Joining…'");
  });
});

describe("session tab routing", () => {
  function sessionTab(waitlist: ReturnType<typeof fakeWaitlist> | null) {
    const tab = Object.create(SessionTabPanel.prototype);
    const posts: any[] = [];
    Object.assign(tab, {
      _sessionId: "s1",
      _postMessage: (message: unknown) => posts.push(message),
      _viewProvider: { waitlist, getWorkspaceIndex: async () => ({ files: [], dirs: [] }) },
      _sidePanelFeed: { refresh() {} },
      _loadSession: async () => {},
      _rpcClient: { call: async () => ({}) },
    });
    return { tab, posts };
  }

  it("sends the joined state when the tab's page is ready", async () => {
    const { tab, posts } = sessionTab(fakeWaitlist(true));
    await tab._handleMessage({ type: "ready" });
    assert.deepEqual(posts.filter((m) => m.type === "waitlist_state"), [{ type: "waitlist_state", joined: true }]);
    const { tab: plain, posts: plainPosts } = sessionTab(null);
    await plain._handleMessage({ type: "ready" });
    assert.ok(!plainPosts.some((m) => m.type === "waitlist_state"));
  });

  it("passes the waitlist messages to the controller and its replies back to the tab", async () => {
    const waitlist = fakeWaitlist();
    const { tab, posts } = sessionTab(waitlist);
    for (const type of ["waitlist_offer_shown", "waitlist_open", "waitlist_join"]) await tab._handleMessage({ type, wants: ["faster"] });
    assert.deepEqual(waitlist.handled.map((m) => m.type), ["waitlist_offer_shown", "waitlist_open", "waitlist_join"]);
    assert.deepEqual(posts.map((m) => m.type), ["waitlist_form", "waitlist_result"]);
  });
});
