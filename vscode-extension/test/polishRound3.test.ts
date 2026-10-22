import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { element, loadChat } from "./helpers/chatHarness.js";

const clipboard: string[] = [];
const notices: string[] = [];
let diagnostics: Array<[any, any[]]> = [];
let activeUri: any;
let gitRepos: any[] = [];

const uri = (fsPath: string) => ({ fsPath, scheme: "file", toString: () => fsPath });
const vscodeMock: any = {
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  env: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
  window: {
    get activeTextEditor() { return activeUri ? { document: { uri: activeUri } } : undefined; },
    showInformationMessage: async (m: string) => { notices.push(m); },
    showWarningMessage: async (m: string) => { notices.push(m); },
    showErrorMessage: async (m: string) => { notices.push(m); },
  },
  languages: {
    getDiagnostics: (target?: any) => target ? (diagnostics.find(([u]) => u.fsPath === target.fsPath)?.[1] || []) : diagnostics,
  },
  workspace: {
    workspaceFolders: [{ uri: uri("/repo") }],
    getWorkspaceFolder: (u: any) => (u.fsPath.startsWith("/repo") ? { uri: uri("/repo") } : undefined),
    asRelativePath: (u: any) => u.fsPath.replace(/^\/repo\//, ""),
  },
  extensions: {
    getExtension: (id: string) => id === "vscode.git"
      ? { isActive: true, exports: { getAPI: () => ({ repositories: gitRepos }) } }
      : undefined,
  },
  Uri: { joinPath: (...p: any[]) => ({ fsPath: p.map((x) => (typeof x === "object" ? x.fsPath : String(x))).join("/") }) },
};

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments);
};
const { AwayBadge } = require("../src/awayBadge.js");
const { collectStarterContext } = require("../src/smartStarters.js");
const { formatChatMarkdown, copySessionAsMarkdown } = require("../src/chatMarkdown.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
Module.prototype.require = originalRequire;

beforeEach(() => {
  clipboard.length = 0;
  notices.length = 0;
  diagnostics = [];
  activeUri = undefined;
  gitRepos = [];
});

describe("badge on the Andromity icon", () => {
  it("counts replies and shows when the agent needs you", () => {
    const badge = new AwayBadge();
    assert.equal(badge.badge(), undefined);
    badge.note("reply");
    badge.note("reply");
    assert.deepEqual(badge.badge(), { value: 2, tooltip: "2 replies finished" });
    badge.note("question");
    badge.note("approval");
    badge.note("question");
    assert.deepEqual(badge.badge(), { value: 3, tooltip: "Andromity needs your approval · 2 replies finished" });
    badge.clear();
    assert.equal(badge.badge(), undefined);
  });

  it("only badges while the chat view is hidden, and skips scheduled runs", () => {
    const provider: any = Object.create(ChatViewProvider.prototype);
    provider._awayBadge = new AwayBadge();
    provider._view = { visible: true, badge: undefined };
    provider._noteWhileAway("reply");
    assert.equal(provider._view.badge, undefined);

    provider._view.visible = false;
    provider._noteWhileAway("reply", { scheduled: true });
    assert.equal(provider._view.badge, undefined);
    provider._noteWhileAway("approval", { session_id: "s" });
    assert.deepEqual(provider._view.badge, { value: 1, tooltip: "Andromity needs your approval" });
  });
});

describe("smart starter buttons", () => {
  it("finds the open file's errors, else the workspace file with the most", () => {
    const err = { severity: 0 }, warn = { severity: 1 };
    diagnostics = [[uri("/repo/src/a.ts"), [err]], [uri("/repo/src/auth.ts"), [err, err, warn, err]], [uri("/elsewhere/x.ts"), [err, err, err, err, err]]];
    assert.deepEqual(collectStarterContext().errors, { file: "auth.ts", path: "src/auth.ts", count: 3 });
    activeUri = uri("/repo/src/a.ts");
    assert.deepEqual(collectStarterContext().errors, { file: "a.ts", path: "src/a.ts", count: 1 });
  });

  it("counts uncommitted files once across staged, unstaged and untracked", () => {
    gitRepos = [{
      rootUri: uri("/repo"),
      state: {
        workingTreeChanges: [{ uri: uri("/repo/a.ts") }, { uri: uri("/repo/b.ts") }],
        indexChanges: [{ uri: uri("/repo/a.ts") }],
        untrackedChanges: [{ uri: uri("/repo/new.ts") }],
        onDidChange: () => ({ dispose() {} }),
      },
    }];
    assert.equal(collectStarterContext().changedFiles, 3);
    gitRepos = [];
    assert.equal(collectStarterContext().changedFiles, 0, "no git means no button, not an error");
  });

  function starterRow(h: ReturnType<typeof loadChat>) {
    const chip = (prompt: string, title: string, description: string) => {
      const titleEl: any = element(); titleEl.textContent = title;
      const descEl: any = element(); descEl.textContent = description;
      const c: any = element({ tagName: "BUTTON" });
      c.attrs["data-prompt"] = prompt;
      c.attrs["aria-label"] = title;
      c.querySelector = (sel: string) => sel === ".starter-title" ? titleEl : sel === ".starter-description" ? descEl : null;
      return { c, titleEl, descEl };
    };
    const chips = [chip("Explain", "Explore the code", "Understand"), chip("Fix any errors", "Fix a problem", "Find and resolve errors"), chip("Write tests", "Add tests", "Cover the edge cases")];
    const row: any = element();
    row.querySelectorAll = () => chips.map((x) => x.c);
    const doc = h.sandbox.document;
    const original = doc.querySelector;
    doc.querySelector = (sel: string) => (sel === ".minimal-starters-row" ? row : original(sel));
    return chips;
  }

  it("turns generic starters into specific ones, and back", () => {
    const h = loadChat();
    const chips = starterRow(h);
    h.post({ type: "starter_context", errors: { file: "auth.ts", path: "src/auth.ts", count: 3 }, changedFiles: 5 });
    assert.equal(chips[1].titleEl.textContent, "Fix 3 errors");
    assert.equal(chips[1].descEl.textContent, "in auth.ts");
    assert.match(chips[1].c.attrs["data-prompt"], /Fix the 3 errors reported in src\/auth\.ts/);
    assert.ok(chips[1].c.classList.contains("is-smart"));
    assert.equal(chips[2].titleEl.textContent, "Review my changes");
    assert.equal(chips[2].descEl.textContent, "5 changed files");
    assert.equal(chips[0].titleEl.textContent, "Explore the code", "other starters are untouched");

    h.post({ type: "starter_context", errors: null, changedFiles: 0 });
    assert.equal(chips[1].titleEl.textContent, "Fix a problem");
    assert.equal(chips[1].c.attrs["data-prompt"], "Fix any errors");
    assert.equal(chips[2].titleEl.textContent, "Add tests");
    assert.ok(!chips[1].c.classList.contains("is-smart"));
  });
});

describe("copy chat as Markdown", () => {
  const session = {
    name: "Fix login",
    messages: [
      { role: "system", content: "You are Andromity" },
      { role: "user", content: "Why does login redirect twice?\n\n---\n[Active Document: src/auth.ts (Language: typescript), Line: 3]" },
      { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
      { role: "tool", content: "file contents" },
      { role: "assistant", content: "Because `next` is read twice." },
      { role: "user", content: [{ type: "text", text: "Fix it" }, { type: "image_url", image_url: { url: "data:" } }] },
    ],
  };

  it("keeps prompts and replies, without tool output or attached editor context", () => {
    const { markdown, count } = formatChatMarkdown(session);
    assert.equal(count, 3);
    assert.equal(markdown,
      "# Fix login\n\n### You\n\nWhy does login redirect twice?\n\n### Andromity\n\nBecause `next` is read twice.\n\n### You\n\nFix it\n\n[image]\n");
    assert.ok(!markdown.includes("Active Document"));
    assert.ok(!markdown.includes("file contents"));
  });

  it("copies to the clipboard, and says when there is nothing to copy", async () => {
    await copySessionAsMarkdown({ call: async () => session } as any, "s1");
    assert.equal(clipboard.length, 1);
    assert.equal(notices.at(-1), "Copied 3 messages as Markdown.");
    await copySessionAsMarkdown({ call: async () => ({ messages: [] }) } as any, "s1");
    assert.equal(clipboard.length, 1);
    assert.match(notices.at(-1)!, /Nothing to copy yet/);
    await copySessionAsMarkdown(null, "s1");
    assert.match(notices.at(-1)!, /Open a chat/);
  });

  it("the chat top bar button asks the extension to copy the current session", () => {
    const h = loadChat();
    h.eval("currentSessionId = 'abc';");
    const button: any = element({ tagName: "BUTTON" });
    button.attrs["data-action"] = "copy-chat-markdown";
    button.closest = (sel: string) => (sel.includes("[data-action]") ? button : null);
    h.posted.length = 0;
    const click = { target: button, preventDefault() {}, stopPropagation() {} };
    for (const fn of h.docListeners.click || []) fn(click);
    assert.ok(h.posted.some((m: any) => m.type === "copy_chat_markdown" && m.sessionId === "abc"));
  });
});
