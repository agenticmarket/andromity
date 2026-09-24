/**
 * collabInbox.test.ts
 * Unit tests for the Collaboration Inbox visibility rules and theme parity.
 *
 * The inbox runtime lives inside the generated webview client script, so it is
 * extracted and evaluated in a Node VM — the same approach already used by
 * messageFooter.test.ts and webviewScripts.test.ts. The entry point must stay
 * hidden until collaboration is actually happening (messages exchanged or an
 * active co-agent link), and every surface must use the zinc/violet theme.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

// Mock vscode module for Node testing (same pattern as webviewScripts.test.ts)
// @ts-ignore
const Module = require("module");
const origRequire = Module.prototype.require;
const mockVscode: any = {
  Uri: {
    joinPath: (...args: any[]) => ({
      fsPath: args.map((a) => (typeof a === "object" ? a.fsPath || a.path : String(a))).join("/"),
    }),
    file: (p: string) => ({ fsPath: p }),
  },
  window: {},
  workspace: {},
  commands: {},
};
Module.prototype.require = function (reqPath: string) {
  if (reqPath === "vscode") {
    return mockVscode;
  }
  return origRequire.apply(this, arguments as any);
};

import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";
import { ChatViewState, getChatViewHtml } from "../src/providers/chatview/chatHtml.js";

const TEST_STATE: ChatViewState = {
  currentSessionId: "session-a",
  currentModel: "anthropic/claude-3.7-sonnet",
  currentProvider: "anthropic",
  currentMode: "safe",
  currentProfile: "builder",
  currentReasoning: "medium",
  models: [],
};

const mockWebview: any = {
  cspSource: "vscode-webview:",
  asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
};

const extensionUri: any = { fsPath: "d:/saas/agent/vscode-extension" };

/** Minimal DOM node stub mirroring the inline `display:none` chrome. */
function makeEl(id: string, initialDisplay: string = ""): any {
  const el: any = {
    id,
    style: { display: initialDisplay },
    textContent: "",
    innerHTML: "",
    className: "",
    children: [] as any[],
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    },
    addEventListener: () => {},
    appendChild: (child: any) => {
      el.children.push(child);
      return child;
    },
    contains: () => false,
    querySelector: () => null,
  };
  return el;
}

interface InboxRuntime {
  elements: Record<string, any>;
  tabsEl: any;
  evalIn: (expr: string) => any;
}

/**
 * Extracts the inbox runtime (state, add/badge/render/toggle helpers and event
 * wiring) plus `updateSessionCollabBadge` and runs it in a VM sandbox.
 */
function loadInboxRuntime(): InboxRuntime {
  const script = getChatClientScript("vscode-resource://icon.svg", TEST_STATE);
  const start = script.indexOf("// ── Collaboration Inbox State & Event Listeners");
  const end = script.indexOf("let selectedOnboardingProvider");
  assert.ok(start > -1, "inbox runtime must exist in the generated client script");
  assert.ok(end > start, "inbox runtime must be emitted before the onboarding state");

  const badgeStart = script.indexOf("function updateSessionCollabBadge(data) {");
  const badgeEnd = script.indexOf("function copyMessageText(btn) {");
  assert.ok(badgeStart > -1, "updateSessionCollabBadge must exist in the generated client script");
  assert.ok(badgeEnd > badgeStart, "updateSessionCollabBadge must be emitted before copyMessageText");

  const elements: Record<string, any> = {
    "btn-top-collab-inbox": makeEl("btn-top-collab-inbox", "none"),
    "collab-inbox-popover": makeEl("collab-inbox-popover", "none"),
    "btn-close-collab-inbox": makeEl("btn-close-collab-inbox"),
    "btn-collab-clear-all": makeEl("btn-collab-clear-all", "none"),
    "collab-inbox-badge": makeEl("collab-inbox-badge", "none"),
    "collab-inbox-status-pill": makeEl("collab-inbox-status-pill", "none"),
    "collab-inbox-list": makeEl("collab-inbox-list"),
    "session-collab-badge": makeEl("session-collab-badge", "none"),
  };
  const tabsEl = makeEl("collab-inbox-tabs", "none");

  const sandbox: any = {
    document: {
      getElementById: (id: string) => elements[id] || null,
      querySelector: (sel: string) => (sel === ".collab-inbox-tabs" ? tabsEl : null),
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => makeEl("created"),
    },
  };
  sandbox.escapeHtml = (s: any) => String(s == null ? "" : s);
  sandbox.renderMarkdown = (s: any) => "<p>" + String(s || "") + "</p>";
  sandbox.formatSessionShort = (s: any, n: number) => String(s || "").slice(0, n);

  const runtime =
    "let currentSessionId = 'session-a';\n" +
    script.substring(start, end) +
    "\n" +
    script.substring(badgeStart, badgeEnd);

  vm.createContext(sandbox);
  new vm.Script(runtime, { filename: "collabInboxRuntime.js" }).runInContext(sandbox);

  return {
    elements,
    tabsEl,
    evalIn: (expr: string) => vm.runInContext(expr, sandbox),
  };
}

/** Counts how many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Collaboration Inbox visibility & theming unit tests", () => {
  it("inbox entry point stays hidden until collaboration happens", () => {
    const rt = loadInboxRuntime();
    assert.equal(rt.evalIn("btnCollabInbox.style.display"), "none");
    assert.equal(rt.evalIn("collabInboxPopover.style.display"), "none");

    rt.evalIn("updateCollabInboxBadge()");
    assert.equal(rt.evalIn("btnCollabInbox.style.display"), "none", "no collaboration → no inbox icon");
    assert.equal(rt.elements["collab-inbox-badge"].style.display, "none");
    assert.equal(rt.elements["collab-inbox-status-pill"].style.display, "none", "0-item pill must stay hidden");
    assert.equal(rt.elements["btn-collab-clear-all"].style.display, "none");
    assert.equal(rt.tabsEl.style.display, "none", "empty filters are clutter");
  });

  it("inbox surfaces received collaboration messages with an unread count", () => {
    const rt = loadInboxRuntime();
    rt.evalIn(
      "addCollabInboxItem({ id: 'msg_1', type: 'message', fromSession: 'audit-agent', content: 'API contract updated', unread: true })"
    );

    assert.equal(rt.evalIn("btnCollabInbox.style.display"), "", "collaboration message → icon appears");
    assert.equal(rt.elements["collab-inbox-badge"].style.display, "inline-flex");
    assert.equal(rt.elements["collab-inbox-badge"].textContent, "1");
    assert.equal(rt.elements["collab-inbox-status-pill"].textContent, "1 item");
    assert.equal(rt.elements["collab-inbox-status-pill"].style.display, "");
    assert.equal(rt.tabsEl.style.display, "", "filters appear with messages");
    assert.equal(rt.evalIn("getSessionCollabInboxItems().length"), 1);
    assert.equal(rt.evalIn("getSessionCollabInboxItems()[0].sessionId"), "session-a", "items are session-scoped");

    const item = rt.elements["collab-inbox-list"].children[0];
    assert.ok(String(item.className).includes("type-message"), "message items keep their type class");
    assert.ok(String(item.className).includes("unread"), "fresh items are unread");
    assert.ok(String(item.innerHTML).includes("audit-agent"), "sender must be rendered");
    assert.ok(String(item.innerHTML).includes("API contract updated"), "payload must be rendered");

    // Duplicate ids must not double-count.
    rt.evalIn(
      "addCollabInboxItem({ id: 'msg_1', type: 'message', fromSession: 'audit-agent', content: 'API contract updated', unread: true })"
    );
    assert.equal(rt.evalIn("getSessionCollabInboxItems().length"), 1);

    // Opening the inbox marks the session's messages read but keeps the icon.
    rt.evalIn("toggleCollabInbox(true)");
    assert.equal(rt.evalIn("collabInboxPopover.style.display"), "flex");
    assert.equal(rt.elements["collab-inbox-badge"].style.display, "none");
    assert.equal(rt.evalIn("btnCollabInbox.style.display"), "");
  });

  it("inbox button appears for active co-agent links and auto-wake watching", () => {
    const linked = loadInboxRuntime();
    linked.evalIn("updateSessionCollabBadge({ status: 'running', collaborators: ['audit-agent'] })");
    assert.equal(linked.evalIn("btnCollabInbox.style.display"), "", "linked sessions expose the inbox");
    assert.equal(linked.elements["session-collab-badge"].style.display, "inline-flex");
    assert.ok(String(linked.elements["session-collab-badge"].className).includes("session-collab-badge"));
    assert.ok(!String(linked.elements["session-collab-badge"].className).includes("watching"));
    assert.ok(String(linked.elements["session-collab-badge"].innerHTML).includes("audit-agent"));

    const watching = loadInboxRuntime();
    watching.evalIn("updateSessionCollabBadge({ status: 'watching', watching_for: { target_session: 'audit-agent' } })");
    assert.equal(watching.evalIn("btnCollabInbox.style.display"), "", "watching sessions expose the inbox");
    assert.ok(String(watching.elements["session-collab-badge"].className).includes("watching"));

    const idle = loadInboxRuntime();
    idle.evalIn("updateSessionCollabBadge({ status: 'idle', collaborators: [] })");
    assert.equal(idle.evalIn("btnCollabInbox.style.display"), "none", "idle sessions stay clean");
    assert.equal(idle.elements["session-collab-badge"].style.display, "none");
  });

  it("inbox items are scoped to the active session", () => {
    const rt = loadInboxRuntime();
    rt.evalIn(
      "addCollabInboxItem({ id: 'q_1', type: 'question', fromSession: 'audit-agent', content: 'who owns the schema?', unread: true })"
    );
    assert.equal(rt.evalIn("getSessionCollabInboxItems().length"), 1);

    // Switching to a quiet session hides the icon again.
    rt.evalIn("currentSessionId = 'session-b'");
    rt.evalIn("updateCollabInboxBadge()");
    assert.equal(rt.evalIn("getSessionCollabInboxItems().length"), 0);
    assert.equal(rt.evalIn("btnCollabInbox.style.display"), "none");
    assert.equal(rt.tabsEl.style.display, "none");

    // Switching back restores the session's collaboration history.
    rt.evalIn("currentSessionId = 'session-a'");
    rt.evalIn("updateCollabInboxBadge()");
    assert.equal(rt.evalIn("getSessionCollabInboxItems().length"), 1);
    assert.equal(rt.evalIn("btnCollabInbox.style.display"), "");
  });

  it("generated inbox markup keeps chrome hidden and copy concise", () => {
    const html = getChatViewHtml(mockWebview, extensionUri, TEST_STATE);
    assert.ok(html.includes('id="btn-top-collab-inbox" style="display:none;"'), "icon starts hidden");
    assert.ok(html.includes('id="collab-inbox-status-pill" style="display:none;"'), "0-item pill starts hidden");
    assert.ok(html.includes('id="btn-collab-clear-all" style="display:none;"'), "Mark Read starts hidden");
    assert.ok(html.includes('<div class="collab-inbox-tabs" style="display:none;">'), "filters start hidden");
    assert.ok(!html.includes("Inbox is clear"), "legacy marketing copy must be gone");
    assert.ok(html.includes("No collaboration messages"), "empty state keeps a single concise line");
  });

  it("collab inbox styles match the zinc theme palette", () => {
    const css = getChatStyles();
    for (const token of [
      ".session-collab-badge",
      ".session-collab-badge.watching",
      ".session-collab-badge.paused",
      ".collab-inbox-popover",
      ".collab-inbox-header-title svg",
      ".collab-inbox-tabs::-webkit-scrollbar",
      ".collab-inbox-item.unread",
    ]) {
      assert.ok(css.includes(token), `styles must define ${token}`);
    }
    assert.ok(!css.includes("#a855f7"), "legacy off-theme purple must be replaced");
    assert.ok(css.includes("var(--purple, #bc8cff)"), "collaboration accents must use the theme violet token");
    assert.ok(!css.includes("box-shadow: 0 0 8px rgba(168, 85, 247, 0.6)"), "decorative glow removed");
    assert.equal(count(css, "{"), count(css, "}"), "generated CSS braces must balance");
  });
});
