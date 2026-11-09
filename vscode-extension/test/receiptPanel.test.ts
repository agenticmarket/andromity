import { describe, it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const panels: any[] = [];
const opened: string[] = [];
const policyAsked: string[] = [];
const warnings: string[] = [];
const clipboard: string[] = [];
const written: Array<{ path: string; text: string }> = [];
let saveTarget: any = { fsPath: "/ws/receipt.json" };
let saveSuggested = "";

const plain = (p: string) => p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
/** Links in the fake disk: anything under the key resolves to the value. */
const links: Record<string, string> = { "/ws/link": "/outside", "/ws/inner-link": "/ws/src", "/alias-ws": "/ws" };

const fsMock = {
  promises: {
    realpath: async (p: string) => {
      let at = plain(p);
      if (at.includes("missing")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      for (let hops = 0; hops < 8; hops++) {
        const link = Object.entries(links).find(([from]) => at === from || at.startsWith(from + "/"));
        if (!link) return at;
        at = link[1] + at.slice(link[0].length);
      }
      throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
    },
  },
};

const vscodeMock: any = {
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/") }),
    file: (p: string) => ({ fsPath: p }),
  },
  window: {
    createWebviewPanel: () => {
      let html = "";
      const panel: any = {
        title: "",
        closed: false,
        writesAfterClose: 0,
        reveal() {},
        onDidDispose: (handler: any) => {
          panel.dispose = () => { panel.closed = true; handler(); };
          return { dispose() {} };
        },
        webview: {
          cspSource: "vscode-webview:",
          get html() { return html; },
          set html(value: string) {
            if (panel.closed) panel.writesAfterClose++;
            html = value;
          },
          onDidReceiveMessage: (handler: any) => { panel.receive = handler; return { dispose() {} }; },
        },
      };
      panels.push(panel);
      return panel;
    },
    showTextDocument: async (doc: any) => { opened.push(doc.path); },
    showSaveDialog: async (options: any) => { saveSuggested = options?.defaultUri?.fsPath || ""; return saveTarget; },
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: (text: string) => { warnings.push(text); return Promise.resolve(undefined); },
    showErrorMessage: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/ws" } }] as any,
    openTextDocument: async (uri: any) => ({ path: uri.fsPath }),
    fs: { writeFile: async (uri: any, data: Buffer) => { written.push({ path: uri.fsPath, text: data.toString("utf8") }); } },
  },
  env: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
};
const policyMock = {
  allowOpenPath: async (p: string) => {
    policyAsked.push(plain(p));
    const roots: string[] = (vscodeMock.workspace.workspaceFolders || []).map((f: any) => plain(f.uri.fsPath));
    return roots.some((root) => plain(p) === root || plain(p).startsWith(root + "/"));
  },
};

/** A fresh copy of the panel module, optionally drawing with a stand-in for the receipt view. */
function loadPanel(view?: unknown) {
  const panelPath = require.resolve("../src/panels/ReceiptPanel.js");
  delete require.cache[panelPath];
  Module.prototype.require = function (name: string) {
    if (name === "vscode") return vscodeMock;
    if (name === "node:fs") return fsMock;
    if (name.endsWith("securityPolicy.js")) return policyMock;
    if (view && name.endsWith("receiptView.js")) return view;
    return originalRequire.apply(this, arguments);
  };
  try {
    return require(panelPath).ReceiptPanel;
  } finally {
    Module.prototype.require = originalRequire;
  }
}
const ReceiptPanel = loadPanel();

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function receipt(turn: number, overrides: Record<string, unknown> = {}) {
  return {
    version: 1, session_id: "s", turn_index: turn, started_at: null, ended_at: null, duration_seconds: null,
    models: [], mode: null, snapshot: {}, files_changed: [], edited_not_in_snapshot: [], files_read: [],
    commands: [], checks: [], web_hosts: [], mcp_servers: [], other_tools: {}, needs_attention: [], approvers: [],
    cost_usd: null, tokens: null, notes: [], record_hash: "e".repeat(64),
    summary: { files_changed: 0, lines_added: 0, lines_deleted: 0, files_read: 0, searches: 0, commands: 0, commands_failed: 0,
      blocked: 0, denied: 0, approved_by_person: 0, denied_by_person: 0, subagents: 0, web_searches: 0 },
    ...overrides,
  };
}

const answer = (turn: number, turns = [0, 4]) =>
  ({ success: true, receipt: receipt(turn), text: `receipt text ${turn}`, markdown: `### receipt ${turn}`, viewer_id: null, turns });

function fakeRpc(reply?: (params: any) => any) {
  const handlers = new Map<string, Array<(params: any) => void>>();
  const calls: any[] = [];
  return {
    calls,
    on(event: string, handler: (params: any) => void) { handlers.set(event, [...(handlers.get(event) || []), handler]); },
    off(event: string, handler: (params: any) => void) { handlers.set(event, (handlers.get(event) || []).filter((h) => h !== handler)); },
    emit(event: string, params: any) { (handlers.get(event) || []).forEach((handler) => handler(params)); },
    async call(method: string, params: any) {
      calls.push({ method, params });
      return reply ? reply(params) : answer(params.turn_index ?? 4);
    },
  };
}

/** An engine whose answers wait until the test releases them, in any order. */
function heldRpc() {
  const pending: Array<{ params: any; resolve: (value: any) => void }> = [];
  const rpc = fakeRpc((params) => new Promise((resolve) => pending.push({ params, resolve })));
  return { rpc, pending };
}

function open(id: string, rpc: any, turn: number | null = null) {
  ReceiptPanel.createOrShow({ fsPath: "/ext" }, id, id.toUpperCase(), rpc, turn);
  return panels[panels.length - 1];
}

describe("receipt panel", () => {
  it("follows the latest turn until a turn is picked, and ignores bad turn numbers", async () => {
    const rpc = fakeRpc();
    const panel = open("sess-a", rpc);
    await settle();
    assert.deepEqual(rpc.calls.map((c) => c.params.turn_index), [undefined]);
    assert.match(panel.webview.html, /Turn 5/);

    for (const bad of [-1, "x", "1", 1.5, null, NaN, Infinity, 2 ** 53]) await panel.receive({ type: "turn", turnIndex: bad });
    assert.equal(rpc.calls.length, 1);

    await panel.receive({ type: "turn", turnIndex: 0 });
    assert.equal(rpc.calls[1].params.turn_index, 0);
    assert.equal(rpc.calls[1].params.session_id, "sess-a");

    rpc.emit("receipt/ready", { session_id: "sess-a", turn_index: 4, attention: 1, high: 0 });
    rpc.emit("receipt/ready", { session_id: "other", turn_index: 0, attention: 1, high: 0 });
    await settle();
    assert.equal(rpc.calls.length, 2, "a pinned older turn is not replaced by a newer receipt");

    await panel.receive({ type: "latest" });
    assert.equal(rpc.calls[2].params.turn_index, undefined);
    panel.dispose();
  });

  it("refreshes when the turn it follows finishes, and stops listening once closed", async () => {
    const rpc = fakeRpc();
    const panel = open("sess-b", rpc);
    await settle();
    rpc.emit("receipt/ready", { session_id: "sess-b", turn_index: 5, attention: 0, high: 0 });
    await settle();
    assert.equal(rpc.calls.length, 2);
    panel.dispose();
    rpc.emit("receipt/ready", { session_id: "sess-b", turn_index: 6, attention: 0, high: 0 });
    await settle();
    assert.equal(rpc.calls.length, 2);
  });

  it("shows the newest answer when an older request returns late", async () => {
    const { rpc, pending } = heldRpc();
    const panel = open("sess-c", rpc);
    await settle();
    const second = panel.receive({ type: "turn", turnIndex: 1 });
    await settle();
    pending[1].resolve(answer(1, [0, 1, 9]));
    await second;
    pending[0].resolve(answer(9, [0, 1, 9]));
    await settle();
    assert.match(panel.webview.html, /<option value="1" selected>/);
    panel.dispose();
  });

  it("never offers or copies a receipt for a turn other than the one being loaded", async () => {
    const { rpc, pending } = heldRpc();
    const panel = open("sess-i", rpc);
    await settle();
    pending[0].resolve(answer(4));
    await settle();
    assert.match(panel.webview.html, /data-action="copy-text"/);

    const switching = panel.receive({ type: "turn", turnIndex: 0 });
    await settle();
    assert.match(panel.webview.html, /Building the receipt/);
    assert.doesNotMatch(panel.webview.html, /Receipt for turn 5|data-action="copy-text"/);
    clipboard.length = 0;
    written.length = 0;
    await panel.receive({ type: "copy_text" });
    await panel.receive({ type: "copy_markdown" });
    await panel.receive({ type: "export_json" });
    assert.deepEqual(clipboard, []);
    assert.deepEqual(written, []);

    pending[1].resolve(answer(0));
    await switching;
    await panel.receive({ type: "copy_text" });
    assert.deepEqual(clipboard, ["receipt text 0"]);

    const refreshing = panel.receive({ type: "refresh" });
    await settle();
    assert.match(panel.webview.html, /Receipt for turn 1/, "the same turn stays on screen while it refreshes");
    assert.doesNotMatch(panel.webview.html, /data-action="copy-text"/);
    await panel.receive({ type: "copy_text" });
    assert.equal(clipboard.length, 1);
    pending[2].resolve(answer(0));
    await refreshing;
    panel.dispose();
  });

  it("keeps the turn list and a way back to the latest turn after an error", async () => {
    let fail = false;
    const rpc = fakeRpc((params) => (fail ? { success: false, error: "The engine stopped." } : answer(params.turn_index ?? 4)));
    const panel = open("sess-j", rpc, 0);
    await settle();
    fail = true;
    await panel.receive({ type: "refresh" });
    assert.match(panel.webview.html, /The engine stopped\./);
    assert.match(panel.webview.html, /<option value="4">Turn 5<\/option>/);
    assert.match(panel.webview.html, /data-action="latest"/);
    fail = false;
    await panel.receive({ type: "latest" });
    assert.equal(rpc.calls.at(-1).params.turn_index, undefined);
    assert.match(panel.webview.html, /<option value="4" selected>Turn 5<\/option>/);
    assert.doesNotMatch(panel.webview.html, /data-action="latest"/);
    panel.dispose();
  });

  it("refuses a receipt it cannot read, and keeps nothing from it", async () => {
    const rpc = fakeRpc(() => ({ success: true, receipt: receipt(4, { sealed: { hash: "x", matches: "true" } }),
      text: "all clean", markdown: "all clean", turns: [0, 4] }));
    const panel = open("sess-k", rpc);
    await settle();
    assert.match(panel.webview.html, /in a format this version can(&#39;|')t show/);
    assert.doesNotMatch(panel.webview.html, /Matches the record|Nothing in this turn/);
    clipboard.length = 0;
    written.length = 0;
    await panel.receive({ type: "copy_text" });
    await panel.receive({ type: "export_json" });
    assert.deepEqual(clipboard, []);
    assert.deepEqual(written, []);
    panel.dispose();
  });

  it("does nothing more once closed mid-load", async () => {
    const { rpc, pending } = heldRpc();
    const panel = open("sess-l", rpc);
    await settle();
    panel.dispose();
    pending[0].resolve(answer(4));
    await settle();
    assert.equal(panel.writesAfterClose, 0);
    void panel.receive({ type: "refresh" });
    await settle();
    assert.equal(rpc.calls.length, 1);
    assert.equal(panel.writesAfterClose, 0);
  });

  it("opens files by their real path, so links can't leave the workspace", async () => {
    const panel = open("sess-d", fakeRpc());
    await settle();
    opened.length = 0;
    policyAsked.length = 0;
    for (const bad of [undefined, 5, "", "a\0b", "x".repeat(5000)]) await panel.receive({ type: "open_file", path: bad });
    assert.deepEqual(opened, []);
    assert.deepEqual(policyAsked, []);

    await panel.receive({ type: "open_file", path: "src/app.py" });
    assert.deepEqual(opened.map(plain), ["/ws/src/app.py"]);
    assert.deepEqual(policyAsked, ["/ws/src/app.py"]);

    await panel.receive({ type: "open_file", path: "link/secrets.env" });
    assert.equal(policyAsked.at(-1), "/outside/secrets.env", "the policy sees where the link leads");
    assert.equal(opened.length, 1);

    await panel.receive({ type: "open_file", path: "../../.ssh/id_rsa" });
    assert.equal(opened.length, 1);

    await panel.receive({ type: "open_file", path: "inner-link/app.py" });
    assert.deepEqual(opened.map(plain).at(-1), "/ws/src/app.py");

    warnings.length = 0;
    const asked = policyAsked.length;
    await panel.receive({ type: "open_file", path: "src/missing.py" });
    assert.equal(policyAsked.length, asked, "a path that does not resolve never reaches the policy");
    assert.match(warnings[0], /Could not open src\/missing\.py/);
    panel.dispose();
  });

  it("opens no relative path without a workspace to anchor it", async () => {
    const folders = vscodeMock.workspace.workspaceFolders;
    vscodeMock.workspace.workspaceFolders = undefined;
    try {
      const panel = open("sess-m", fakeRpc());
      await settle();
      opened.length = 0;
      policyAsked.length = 0;
      await panel.receive({ type: "open_file", path: "src/app.py" });
      assert.deepEqual(opened, []);
      assert.deepEqual(policyAsked, []);
      await panel.receive({ type: "open_file", path: "/elsewhere/notes.md" });
      assert.deepEqual(policyAsked, ["/elsewhere/notes.md"]);
      assert.deepEqual(opened, []);
      panel.dispose();
    } finally {
      vscodeMock.workspace.workspaceFolders = folders;
    }
  });

  it("treats a workspace opened through a link as the workspace", async () => {
    const folders = vscodeMock.workspace.workspaceFolders;
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: "/alias-ws" } }];
    try {
      const panel = open("sess-n", fakeRpc());
      await settle();
      opened.length = 0;
      policyAsked.length = 0;
      await panel.receive({ type: "open_file", path: "src/app.py" });
      assert.deepEqual(policyAsked, ["/alias-ws/src/app.py"], "the policy is asked about the path in the open folder");
      assert.deepEqual(opened.map(plain), ["/ws/src/app.py"]);
      await panel.receive({ type: "open_file", path: "link/secrets.env" });
      assert.equal(policyAsked.at(-1), "/outside/secrets.env");
      assert.equal(opened.length, 1);
      panel.dispose();
    } finally {
      vscodeMock.workspace.workspaceFolders = folders;
    }
  });

  it("copies and saves only a receipt that loaded", async () => {
    const failing = fakeRpc(() => ({ success: false, error: "No finished turn with a file checkpoint in this session yet." }));
    const failed = open("sess-e", failing);
    await settle();
    assert.match(failed.webview.html, /No finished turn/);
    clipboard.length = 0;
    written.length = 0;
    await failed.receive({ type: "copy_text" });
    await failed.receive({ type: "export_json" });
    assert.equal(clipboard.length, 0);
    assert.equal(written.length, 0);
    failed.dispose();

    const panel = open("sess/../f", fakeRpc());
    await settle();
    await panel.receive({ type: "copy_text" });
    await panel.receive({ type: "copy_markdown" });
    assert.deepEqual(clipboard, ["receipt text 4", "### receipt 4"]);
    await panel.receive({ type: "export_json" });
    assert.equal(written.length, 1);
    assert.equal(JSON.parse(written[0].text).turn_index, 4);
    assert.match(saveSuggested, /\/ws\/receipt-sessf-turn-5\.json$/);
    saveTarget = undefined;
    await panel.receive({ type: "export_json" });
    assert.equal(written.length, 1);
    saveTarget = { fsPath: "/ws/receipt.json" };
    panel.dispose();
  });

  it("recovers when drawing a receipt fails, instead of jamming", async () => {
    const realView = require("../src/providers/receipt/receiptView.js");
    let failures = 1;
    const FlakyPanel = loadPanel({
      ...realView,
      getReceiptHtml: (webview: any, state: any) => {
        if (state.response?.success && failures > 0) {
          failures--;
          throw new TypeError("draw failed");
        }
        return realView.getReceiptHtml(webview, state);
      },
    });
    const rpc = fakeRpc();
    FlakyPanel.createOrShow({ fsPath: "/ext" }, "sess-o", "O", rpc);
    const panel = panels[panels.length - 1];
    await settle();
    assert.match(panel.webview.html, /could not be shown/);
    assert.match(panel.webview.html, /data-action="refresh"/);
    assert.doesNotMatch(panel.webview.html, /draw failed/);
    await panel.receive({ type: "refresh" });
    assert.equal(rpc.calls.length, 2, "Try again still reaches the engine");
    assert.match(panel.webview.html, /Receipt for turn 5/);
    panel.dispose();
  });

  it("explains an engine that is down or failing instead of breaking", async () => {
    const throwing = fakeRpc(() => { throw new Error("socket closed"); });
    const panel = open("sess-g", throwing);
    await settle();
    assert.match(panel.webview.html, /could not be loaded/);
    assert.doesNotMatch(panel.webview.html, /socket closed/);
    panel.dispose();

    const offline = open("sess-h", null);
    await settle();
    assert.match(offline.webview.html, /engine is not running/);
    offline.dispose();
  });
});
