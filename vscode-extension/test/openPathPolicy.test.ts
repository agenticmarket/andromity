import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const Module = require("module");
const originalRequire = Module.prototype.require;

const dialogs: Array<{ message: string; detail?: string }> = [];
const notices: string[] = [];
const opened: string[] = [];
const searched: string[] = [];
const panels: any[] = [];
let answer: string | undefined;
let searchResults: string[] = [];

const vscodeMock: any = {
  ViewColumn: { Active: -1, One: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  TextEditorRevealType: { InCenter: 2 },
  Position: class {},
  Range: class {},
  Selection: class {},
  Uri: {
    file: (p: string) => ({ fsPath: p }),
    joinPath: (...parts: any[]) => ({ fsPath: parts.map((p) => (typeof p === "object" ? p.fsPath : String(p))).join("/") }),
  },
  env: { isTelemetryEnabled: false },
  window: {
    showWarningMessage: async (message: string, options?: { modal?: boolean; detail?: string }) => {
      if (!options?.modal) {
        notices.push(message);
        return undefined;
      }
      dialogs.push({ message, detail: options.detail });
      return answer;
    },
    showErrorMessage: async (message: string) => {
      notices.push(message);
      return undefined;
    },
    showInformationMessage: async () => undefined,
    showTextDocument: async () => ({ revealRange() {} }),
    createWebviewPanel: () => {
      const panel: any = {
        visible: true,
        reveal() {},
        onDidDispose: () => ({ dispose() {} }),
        webview: {
          html: "",
          cspSource: "vscode-webview:",
          asWebviewUri: (u: any) => u,
          postMessage: async () => true,
          onDidReceiveMessage: (handler: any) => {
            panel.receive = handler;
            return { dispose() {} };
          },
        },
      };
      panels.push(panel);
      return panel;
    },
  },
  workspace: {
    workspaceFolders: undefined as any,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    openTextDocument: async (uri: { fsPath: string }) => {
      opened.push(uri.fsPath);
      return {};
    },
    findFiles: async (glob: string) => {
      searched.push(glob);
      return searchResults.map((fsPath) => ({ fsPath }));
    },
  },
  commands: { executeCommand: async () => undefined },
};

Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments);
};
const { allowOpenPath, checkOpenPath } = require("../src/server/securityPolicy.js");
const { FingerprintPanel } = require("../src/panels/FingerprintPanel.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
Module.prototype.require = originalRequire;

/** A separate copy of the policy that sees fakeFs instead of the disk. */
function policyWithFs(fakeFs: unknown) {
  const file = require.resolve("../src/server/securityPolicy.js");
  const cached = require.cache[file];
  delete require.cache[file];
  Module.prototype.require = function (name: string) {
    if (name === "vscode") return vscodeMock;
    if (name === "fs" || name === "node:fs") return fakeFs;
    return originalRequire.apply(this, arguments);
  };
  try {
    return require(file);
  } finally {
    Module.prototype.require = originalRequire;
    require.cache[file] = cached;
  }
}

function useFolders(...folders: string[]) {
  vscodeMock.workspace.workspaceFolders = folders.length ? folders.map((fsPath) => ({ uri: { fsPath } })) : undefined;
}

const real = (p: string) => fs.realpathSync.native(p);
const NETWORK_REFUSAL = "Andromity does not open files on network shares from chat links.";
const NO_FOLDER = "Open a folder to follow relative file links.";

let base = "";
let ws = "";
let source = "";
let secret = "";

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-open-"));
  ws = path.join(base, "ws");
  source = path.join(ws, "src", "a.ts");
  secret = path.join(base, "outside", "secret.txt");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(secret));
  fs.writeFileSync(source, "");
  fs.writeFileSync(secret, "");
  fs.symlinkSync(path.dirname(secret), path.join(ws, "out"), "junction");
  fs.symlinkSync(ws, path.join(base, "alias"), "junction");
  const gone = path.join(base, "gone");
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(ws, "dangling"), "junction");
  fs.rmdirSync(gone);
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

beforeEach(() => {
  dialogs.length = 0;
  notices.length = 0;
  opened.length = 0;
  searched.length = 0;
  answer = undefined;
  searchResults = [];
  useFolders(ws);
});

describe("opening a path from a webview", () => {
  it("asks before following a junction out of the workspace, naming the real file", async () => {
    assert.deepEqual(await checkOpenPath("out/secret.txt"), { status: "refused" });
    assert.deepEqual(dialogs, [{ message: "Open a file outside this workspace?", detail: real(secret) }]);
    answer = "Open";
    assert.deepEqual(await checkOpenPath(path.join(ws, "out", "secret.txt")), { status: "open", path: real(secret) });
  });

  it("counts files as inside a workspace folder opened through a link", async () => {
    useFolders(path.join(base, "alias"));
    assert.deepEqual(await checkOpenPath("src/a.ts"), { status: "open", path: real(source) });
    assert.deepEqual(await checkOpenPath(source), { status: "open", path: real(source) });
    assert.equal(dialogs.length, 0);
  });

  it("refuses relative paths with no folder open instead of resolving them from the working directory", async () => {
    useFolders();
    const cwd = process.cwd();
    process.chdir(ws);
    try {
      assert.ok(fs.existsSync("../outside/secret.txt"));
      assert.deepEqual(await checkOpenPath("../outside/secret.txt"), { status: "refused" });
      assert.deepEqual(await checkOpenPath("src/a.ts"), { status: "refused" });
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(notices, [NO_FOLDER, NO_FOLDER]);
    assert.equal(dialogs.length, 0);
    answer = "Open";
    assert.deepEqual(await checkOpenPath(secret), { status: "open", path: real(secret) });
    assert.equal(dialogs.length, 1);
  });

  it("reports a missing file or a dangling junction as missing and never allows it", async () => {
    answer = "Open";
    for (const p of ["src/missing.ts", path.join(base, "outside", "missing.txt"), "dangling/a.ts"]) {
      assert.deepEqual(await checkOpenPath(p), { status: "missing" }, p);
      assert.equal(await allowOpenPath(p), false, p);
    }
    assert.equal(dialogs.length, 0);
  });
});

describe("links to network shares", () => {
  const share = "\\\\203.0.113.9\\share\\";
  const links: Record<string, string> = {
    "/ws/share": share,
    "/ws/docs": "/hop",
    "/hop": share,
    "/ws/loop": "/ws/again",
    "/ws/again": "/ws/loop",
  };
  const touched: string[] = [];
  const plain = (p: string) => p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  /** Every path a real realpath would open on its way to the answer. */
  function reach(p: string): string {
    let at = plain(p);
    for (let hops = 0; hops < 8; hops++) {
      touched.push(at);
      const from = Object.keys(links).find((link) => at === link || at.startsWith(link + "/"));
      if (!from) return at;
      at = plain(links[from]).replace(/\/$/, "") + at.slice(from.length);
    }
    throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
  }
  const policy = policyWithFs({
    promises: {
      lstat: async (p: string) => {
        touched.push(plain(p));
        return { isSymbolicLink: () => plain(p) in links };
      },
      readlink: async (p: string) => links[plain(p)],
      realpath: async (p: string) => reach(p),
    },
  });

  it("refuses a link, or a chain of links, to a share without touching the share", async () => {
    useFolders("/ws");
    answer = "Open";
    for (const p of ["share/a.txt", "/ws/share/a.txt", "docs/a.txt"]) {
      assert.deepEqual(await policy.checkOpenPath(p), { status: "refused" }, p);
    }
    assert.deepEqual(notices, [NETWORK_REFUSAL, NETWORK_REFUSAL, NETWORK_REFUSAL]);
    assert.equal(dialogs.length, 0);
    assert.deepEqual(touched.filter((p) => p.includes("203.0.113.9")), []);
  });

  it("gives up on links that loop", async () => {
    useFolders("/ws");
    assert.deepEqual(await policy.checkOpenPath("loop/a.txt"), { status: "missing" });
  });
});

describe("callers open the real path they checked", () => {
  it("the fingerprint view and the chat open the file a junction leads to", async () => {
    answer = "Open";
    FingerprintPanel.createOrShow({ fsPath: "/ext" }, "open-path", "Session", null, { globalState: { get: () => false } });
    await panels[panels.length - 1].receive({ command: "open_file", filePath: "out/secret.txt", line: 1 });
    await Object.create(ChatViewProvider.prototype).openFile("out/secret.txt");
    assert.deepEqual(opened, [real(secret), real(secret)]);
    assert.equal(dialogs.length, 2);
  });

  it("the chat stops at a refusal and checks a search result like any other path", async () => {
    const chat = Object.create(ChatViewProvider.prototype);
    await chat.openFile("out/secret.txt");
    assert.deepEqual(searched, []);
    searchResults = [path.join(ws, "out", "secret.txt")];
    await chat.openFile("secret.txt");
    assert.deepEqual(searched, ["**/secret.txt"]);
    assert.equal(dialogs.length, 2);
    assert.deepEqual(opened, []);
  });
});
