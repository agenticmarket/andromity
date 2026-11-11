import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSidePanelData } from "../src/sidePanelData.js";

const workspace = { uri: { fsPath: "" }, name: "ws" };
const warnings: Array<unknown[]> = [];
let warningChoice: string | undefined = "Trust Folder";
const vscodeMock: any = {
  workspace: {
    isTrusted: true,
    get workspaceFolders() { return [workspace]; },
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined, update: async () => {} }),
    createFileSystemWatcher: () => ({ onDidCreate() { return { dispose() {} }; }, onDidDelete() { return { dispose() {} }; }, dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    activeTextEditor: undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async (...args: unknown[]) => { warnings.push(args); return warningChoice; },
    showInformationMessage: async () => undefined,
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
  },
  languages: { getDiagnostics: () => [], onDidChangeDiagnostics: () => ({ dispose() {} }) },
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
const { SidePanelFeed } = require("../src/sidePanelFeed.js");
Module.prototype.require = originalRequire;

type Handler = (params: any) => unknown | Promise<unknown>;

function rpc(handlers: Record<string, Handler | unknown>) {
  const calls: Array<{ method: string; params: any }> = [];
  return {
    calls,
    names: () => calls.map((c) => c.method),
    call: async <T = any>(method: string, params: any): Promise<T> => {
      calls.push({ method, params });
      const h = handlers[method];
      const value = typeof h === "function" ? await (h as Handler)(params) : h;
      if (value instanceof Error) throw value;
      return value as T;
    },
  };
}

const GIT = {
  "git.status": { is_git: true, branch: "main", files: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "U" }] },
  "git.diff_numstat": { files: { "a.ts": { additions: 3, deletions: 1 } } },
};

describe("Side panel changes: trust is checked before git runs", () => {
  it("asks trust.status first, for the folder it is loading, and then loads as before when trusted", async () => {
    const client = rpc({ "trust.status": { is_trusted: true }, ...GIT });
    const data = await loadSidePanelData(client, "/repo", ["changes"]);
    assert.equal(client.names()[0], "trust.status");
    assert.deepEqual(client.calls.map((c) => c.params), [{ project_path: "/repo" }, { project_path: "/repo" }, { project_path: "/repo" }]);
    assert.deepEqual([...client.names().slice(1)].sort(), ["git.diff_numstat", "git.status"]);
    assert.equal(data.changes?.branch, "main");
    assert.equal(data.changes?.additions, 3);
    assert.equal(data.changes?.files.length, 2);
  });

  it("does not call git.status or git.diff_numstat for an untrusted folder", async () => {
    const client = rpc({ "trust.status": { is_trusted: false }, ...GIT });
    const data = await loadSidePanelData(client, "/repo", ["changes"]);
    assert.deepEqual(client.names(), ["trust.status"]);
    assert.equal(data.changes, null);
  });

  it("does not start git until trust.status has answered", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const client = rpc({ "trust.status": () => gate, ...GIT });
    const pending = loadSidePanelData(client, "/repo", ["changes"]);
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(client.names(), ["trust.status"], "git must not run while trust is still unknown");
    release({ is_trusted: false });
    const data = await pending;
    assert.deepEqual(client.names(), ["trust.status"]);
    assert.equal(data.changes, null);
  });

  it("does not run git when trust.status fails, and does not throw", async () => {
    for (const failure of [new Error("RPC timeout"), "string rejection"]) {
      const client = rpc({
        "trust.status": () => (typeof failure === "string" ? Promise.reject(failure) : Promise.reject(failure)),
        ...GIT,
      });
      const data = await loadSidePanelData(client, "/repo", ["changes"]);
      assert.deepEqual(client.names(), ["trust.status"]);
      assert.equal(data.changes, null);
    }
  });

  it("still reports no changes when trusted but git.status fails, and tolerates a failing numstat", async () => {
    const failing = rpc({ "trust.status": { is_trusted: true }, "git.status": new Error("not a repo"), "git.diff_numstat": { files: {} } });
    assert.equal((await loadSidePanelData(failing, "/repo", ["changes"])).changes, null);
    const noStats = rpc({ "trust.status": { is_trusted: true }, "git.status": GIT["git.status"], "git.diff_numstat": new Error("numstat failed") });
    const data = await loadSidePanelData(noStats, "/repo", ["changes"]);
    assert.equal(data.changes?.files.length, 2);
    assert.equal(data.changes?.additions, 0);
  });

  it("does not run git when the folder's trust is anything other than an explicit yes", async () => {
    const failOpen: Array<[string, unknown]> = [
      ["no is_trusted field", {}], ["null response", null], ["undefined response", undefined], ["is_trusted undefined", { is_trusted: undefined }],
      ["is_trusted null", { is_trusted: null }], ["is_trusted 0", { is_trusted: 0 }], ["is_trusted the string false", { is_trusted: "false" }],
      ["is_trusted empty string", { is_trusted: "" }], ["is_trusted an object", { is_trusted: {} }], ["response is a string", "false"],
    ];
    const ranGit: string[] = [];
    for (const [name, response] of failOpen) {
      const client = rpc({ "trust.status": response, ...GIT });
      await loadSidePanelData(client, "/repo", ["changes"]);
      if (client.names().some((m) => m.startsWith("git."))) ranGit.push(name);
    }
    assert.deepEqual(ranGit, [], "git ran although trust was not confirmed; running git in an untrusted repository can execute its configured hooks");
  });

  it("treats only a boolean true as trusted", async () => {
    for (const trusted of [true]) {
      const client = rpc({ "trust.status": { is_trusted: trusted }, ...GIT });
      await loadSidePanelData(client, "/repo", ["changes"]);
      assert.ok(client.names().includes("git.status"));
    }
  });

  it("does not let the trust check hold back MCP data or call mcp.list when only changes are wanted", async () => {
    const both = rpc({ "trust.status": { is_trusted: false }, "mcp.list": [{ name: "m", status: "running", tools_count: 1 }], ...GIT });
    const data = await loadSidePanelData(both, "/repo", ["mcp", "changes"]);
    assert.deepEqual(data.mcp, [{ name: "m", status: "running", tools: 1, remote: false }]);
    assert.equal(data.changes, null);
    assert.ok(!both.names().some((m) => m.startsWith("git.")));

    const onlyChanges = rpc({ "trust.status": { is_trusted: true }, "mcp.list": [], ...GIT });
    await loadSidePanelData(onlyChanges, "/repo", ["changes"]);
    assert.ok(!onlyChanges.names().includes("mcp.list"));

    const onlyMcp = rpc({ "mcp.list": [], "trust.status": { is_trusted: false }, ...GIT });
    await loadSidePanelData(onlyMcp, "/repo", ["mcp"]);
    assert.deepEqual(onlyMcp.names(), ["mcp.list"], "no trust or git call for an MCP-only refresh");

    const none = rpc({});
    assert.deepEqual(await loadSidePanelData(none, "/repo", []), {});
    assert.deepEqual(none.names(), []);
  });

  it("a failing trust check does not erase the MCP list", async () => {
    const client = rpc({ "trust.status": new Error("down"), "mcp.list": [{ name: "m", status: "running", tools_count: 2, remote: true }] });
    const data = await loadSidePanelData(client, "/repo", ["mcp", "changes"]);
    assert.equal(data.mcp?.length, 1);
    assert.equal(data.changes, null);
  });

  it("does not run git after the response says untrusted even if a later field claims otherwise", async () => {
    const client = rpc({ "trust.status": { is_trusted: false, trusted_projects: [{ key: "x", path: "/repo" }], project_path: "/repo" }, ...GIT });
    await loadSidePanelData(client, "/repo", ["changes"]);
    assert.deepEqual(client.names(), ["trust.status"]);
  });

  it("handles paths that look like options or contain odd characters without changing the call shape", async () => {
    for (const projectPath of ["--upload-pack=evil", "C:\\Users\\x y\\repo", "/repo\u0000x", "", "a".repeat(5000)]) {
      const client = rpc({ "trust.status": { is_trusted: false }, ...GIT });
      await loadSidePanelData(client, projectPath, ["changes"]);
      assert.deepEqual(client.calls, [{ method: "trust.status", params: { project_path: projectPath } }]);
    }
  });
});

describe("Side panel feed around granting and revoking trust", () => {
  it("shows the newest answer when an older refresh finishes after a newer one", async () => {
    const posts: any[] = [];
    let trustCalls = 0;
    const client = rpc({
      "trust.status": () => {
        trustCalls += 1;
        if (trustCalls === 1) return new Promise((resolve) => setTimeout(() => resolve({ is_trusted: false }), 700));
        return { is_trusted: true };
      },
      ...GIT,
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-sp-"));
    workspace.uri.fsPath = root;
    const feed = new SidePanelFeed(() => client, (m: any) => posts.push(m));
    try {
      feed.refresh(["changes"]);
      await new Promise((r) => setTimeout(r, 360));
      feed.refresh(["changes"]);
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      feed.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
    const last = posts.filter((m) => m.type === "side_panel_data").at(-1);
    assert.ok(last, "something was posted");
    assert.notEqual(last.changes, null, "the panel ended up showing the pre-trust answer after trust was granted");
  });
});

describe("Side panel refresh after the trust decision in the chat", () => {
  function provider() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-trust-"));
    workspace.uri.fsPath = root;
    const p: any = new ChatViewProvider({ fsPath: "ext" } as any, undefined);
    const refreshes: unknown[] = [];
    const client = rpc({ "trust.set": { is_trusted: true }, "trust.revoke": { success: true }, "trust.status": { is_trusted: true } });
    p._rpcClient = client;
    p._sidePanelFeed = { refresh: (parts: unknown) => refreshes.push(parts), dispose() {} };
    p._postToWebview = () => {};
    return { p, refreshes, client, root };
  }

  it("refreshes the changes card after the user trusts the folder", async () => {
    warningChoice = "Trust Folder";
    const { p, refreshes, client, root } = provider();
    try {
      await p._handleWebviewMessage({ type: "trust_workspace" });
      assert.ok(client.names().includes("trust.set"));
      assert.deepEqual(refreshes, [["changes"]]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("does not refresh or trust anything when the user declines", async () => {
    warningChoice = undefined;
    const { p, refreshes, client, root } = provider();
    try {
      await p._handleWebviewMessage({ type: "trust_workspace" });
      assert.ok(!client.names().includes("trust.set"));
      assert.deepEqual(refreshes, []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); warningChoice = "Trust Folder"; }
  });

  it("refreshes the changes card after trust is revoked, so it stops listing a folder the agent may no longer read", async () => {
    const { p, refreshes, client, root } = provider();
    try {
      await p._handleWebviewMessage({ type: "untrust_workspace" });
      assert.ok(client.names().includes("trust.revoke"));
      assert.deepEqual(refreshes, [["changes"]]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Side panel feed: newer refreshes win, per part", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function feedWith(handlers: Record<string, Handler | unknown>) {
    const posts: any[] = [];
    const client = rpc(handlers);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-feed-"));
    workspace.uri.fsPath = root;
    const feed = new SidePanelFeed(() => client, (m: any) => posts.push(m));
    const cleanup = () => { feed.dispose(); fs.rmSync(root, { recursive: true, force: true }); };
    return { feed, posts, client, cleanup };
  }

  const gitFor = (branch: string) => ({
    "git.status": { is_git: true, branch, files: [{ path: `${branch}.ts`, status: "M" }] },
    "git.diff_numstat": { files: {} },
  });

  it("delivers the older refresh's other part but not the part a newer refresh replaced", async () => {
    let trustCalls = 0;
    let branch = "A";
    const h = feedWith({
      "trust.status": async () => {
        trustCalls += 1;
        if (trustCalls === 1) { await sleep(700); return { is_trusted: true }; }
        return { is_trusted: true };
      },
      "git.status": () => ({ is_git: true, branch: trustCalls === 1 ? "A" : "B", files: [] }),
      "git.diff_numstat": { files: {} },
      "mcp.list": [{ name: "m", status: "running", tools_count: 1 }],
    });
    try {
      h.feed.refresh(["mcp", "changes"]);
      await sleep(380);
      branch = "B";
      h.feed.refresh(["changes"]);
      await sleep(1500);
    } finally { h.cleanup(); }
    const withMcp = h.posts.filter((m) => m.mcp);
    assert.equal(withMcp.length, 1, "the MCP list from the older refresh still arrives");
    const changePosts = h.posts.filter((m) => m.changes !== undefined);
    assert.ok(changePosts.length >= 1);
    assert.equal(changePosts.at(-1).changes?.branch, "B", "the last changes the page received are the newest refresh's");
    assert.ok(!changePosts.some((m) => m.changes?.branch === "A"), "the older answer for the replaced part is dropped");
  });

  it("a newer refresh of one part does not discard an older refresh of another part", async () => {
    let trustCalls = 0;
    const h = feedWith({
      "trust.status": async () => { trustCalls += 1; await sleep(600); return { is_trusted: true }; },
      ...gitFor("A"),
      "mcp.list": [{ name: "m", status: "running", tools_count: 1 }],
    });
    try {
      h.feed.refresh(["changes"]);
      await sleep(380);
      h.feed.refresh(["mcp"]);
      await sleep(1500);
    } finally { h.cleanup(); }
    assert.ok(h.posts.some((m) => m.changes?.branch === "A"), "the changes refresh was not replaced by anything newer");
    assert.ok(h.posts.some((m) => m.mcp), "the MCP refresh was delivered");
  });

  it("merges refreshes requested within the debounce window into one load", async () => {
    const h = feedWith({ "trust.status": { is_trusted: true }, ...gitFor("A"), "mcp.list": [] });
    try {
      for (let i = 0; i < 6; i++) h.feed.refresh(i % 2 ? ["mcp"] : ["changes"]);
      await sleep(700);
    } finally { h.cleanup(); }
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.client.names().filter((n) => n === "trust.status").length, 1);
    assert.ok(h.posts[0].mcp && h.posts[0].changes !== undefined);
  });

  it("does not post an empty update when every part was superseded", async () => {
    let trustCalls = 0;
    const h = feedWith({
      "trust.status": async () => { trustCalls += 1; if (trustCalls === 1) await sleep(900); return { is_trusted: true }; },
      ...gitFor("A"),
    });
    try {
      h.feed.refresh(["changes"]);
      await sleep(380);
      h.feed.refresh(["changes"]);
      await sleep(1700);
    } finally { h.cleanup(); }
    for (const post of h.posts) assert.ok(post.changes !== undefined || post.mcp !== undefined, "no empty side_panel_data message");
    assert.equal(h.posts.length, 1, "only the newest answer is posted");
  });

  it("keeps working after a refresh when the engine is not connected yet", async () => {
    const posts: any[] = [];
    let client: any = null;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-feed-"));
    workspace.uri.fsPath = root;
    const feed = new SidePanelFeed(() => client, (m: any) => posts.push(m));
    try {
      feed.refresh(["changes"]);
      await sleep(400);
      assert.equal(posts.length, 0);
      client = rpc({ "trust.status": { is_trusted: true }, ...gitFor("A") });
      feed.refresh(["changes"]);
      await sleep(600);
    } finally { feed.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
    assert.equal(posts.at(-1)?.changes?.branch, "A");
  });
});
