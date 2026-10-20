/**
 * Session collaboration presentation: woken turns, inbox entries, the session
 * badge and the "Answer now" action.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { buildSync } from "esbuild";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
const { getChatStyles } = require("../src/providers/chatview/chatStyles.js");
const { cleanPromptForDisplay, parseCollabWakePrompt, getPromptDisplayScript } = require("../src/providers/promptDisplay.js");
const { wakeSessionForQuestion } = require("../src/collabActions.js");
Module.prototype.require = originalRequire;

const SRC = path.resolve(__dirname, "..", "..", "src");
const script: string = getChatClientScript("icon.svg", {
  currentSessionId: "session-a", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
}).replace(/\r\n/g, "\n");

// Exactly what andromity.core.session_bus.question_wake_prompt / handoff_wake_prompt write.
const QUESTION_PROMPT = "[Incoming Question from co-agent 'architect' (ID: q_1760000000000)]:\n" +
  "\"Who owns the \"orders\" schema?\"\n\n" +
  "Please address this question, perform any required actions or tools, and provide an answer using " +
  "session_answer_question(question_id='q_1760000000000', answer='...').";
const HANDOFF_PROMPT = "[Incoming Task Handoff from co-agent 'architect' (Phase: api)]:\n" +
  "Summary: Phase 'api' marked done by session 'architect'\n\n" +
  "Please review the handoff details with read_handoff(phase='api'), take any necessary actions, and report progress.";

function makeEl(id: string, display = ""): any {
  const el: any = {
    id, title: "", textContent: "", innerHTML: "", className: "", children: [] as any[],
    style: { display },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    appendChild(child: any) { el.children.push(child); return child; },
    contains: () => false,
    querySelector: () => null,
  };
  return el;
}

function loadCollabRuntime(sessions: any[] = []) {
  const start = script.indexOf("// ── Collaboration Inbox State & Event Listeners");
  const end = script.indexOf("let selectedOnboardingProvider");
  const badgeStart = script.indexOf("function updateSessionCollabBadge(data) {");
  const badgeEnd = script.indexOf("function copyMessageText(btn) {");
  assert.ok(start > -1 && end > start && badgeStart > -1 && badgeEnd > badgeStart);
  const ids = ["btn-top-collab-inbox", "collab-inbox-popover", "btn-close-collab-inbox", "btn-collab-clear-all",
    "collab-inbox-badge", "collab-inbox-status-pill", "collab-inbox-list", "session-collab-badge"];
  const elements: Record<string, any> = Object.fromEntries(ids.map(id => [id, makeEl(id, "none")]));
  const sandbox: any = {
    allSessions: sessions,
    document: {
      getElementById: (id: string) => elements[id] || null,
      querySelector: () => makeEl("tabs"),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => makeEl("created"),
    },
    escapeHtml: (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    renderMarkdown: (s: any) => "<p>" + String(s || "") + "</p>",
    formatSessionShort: (s: any) => String(s || "Another session"),
  };
  vm.createContext(sandbox);
  vm.runInContext("let currentSessionId = 'session-a';\n" + script.substring(start, end) + "\n" + script.substring(badgeStart, badgeEnd), sandbox);
  return { elements, run: (expr: string) => vm.runInContext(expr, sandbox) };
}

function caseBody(name: string): string {
  const start = script.indexOf(`case '${name}': {`);
  assert.ok(start > -1, `${name} handler missing`);
  return script.slice(start, script.indexOf("\n        }\n", start));
}

describe("Woken turns", () => {
  it("shows who asked and what, never the instructions written for the model", () => {
    assert.deepEqual(parseCollabWakePrompt(QUESTION_PROMPT), { kind: "question", from: "architect", body: "Who owns the \"orders\" schema?" });
    assert.deepEqual(parseCollabWakePrompt(HANDOFF_PROMPT), { kind: "handoff", from: "architect", body: "Phase 'api' marked done by session 'architect'" });
    assert.deepEqual(parseCollabWakePrompt(QUESTION_PROMPT.replace(/\n/g, "\r\n"))?.from, "architect");
    assert.equal(cleanPromptForDisplay(QUESTION_PROMPT), "Question from architect: Who owns the \"orders\" schema?");
    assert.equal(parseCollabWakePrompt("Please answer [Incoming Question from co-agent 'x' (ID: 1)]"), null);
    assert.equal(cleanPromptForDisplay("fix the bug"), "fix the bug");
  });

  it("keeps working in the minified production bundle", () => {
    const out = buildSync({
      entryPoints: [path.join(SRC, "providers", "promptDisplay.ts")],
      bundle: true, minify: true, format: "cjs", platform: "node", write: false,
    }).outputFiles[0].text;
    const mod: any = { exports: {} };
    new Function("module", "exports", out)(mod, mod.exports);
    const context = vm.createContext({ prompt: QUESTION_PROMPT });
    vm.runInContext(mod.exports.getPromptDisplayScript() + "\nvar shown = cleanPromptForDisplay(prompt);", context);
    assert.equal(context.shown, "Question from architect: Who owns the \"orders\" schema?");
    const devContext = vm.createContext({});
    vm.runInContext(getPromptDisplayScript() + "\nvar plain = cleanPromptForDisplay('hi\\n---\\n[Active Document: a.ts]');", devContext);
    assert.equal(devContext.plain, "hi");
  });

  it("renders the woken turn with a heading in the chat", () => {
    const start = script.indexOf("    function appendUserMessage(");
    const body = script.slice(start, script.indexOf("    function appendCompactionSummaryCard(", start));
    assert.ok(body.includes("parseCollabWakePrompt(rawText)"));
    assert.ok(body.includes("textContent.textContent = displayText;"));
    assert.ok(body.includes("'Question from ' : 'Handoff from '"));
  });
});

describe("Collaboration inbox entries", () => {
  it("names the sender plainly and offers working actions", () => {
    const rt = loadCollabRuntime();
    rt.run("addCollabInboxItem({ id: 'q_1', type: 'question', fromSession: 'architect', fromSessionId: 's-arch', content: 'Who owns the schema?', questionId: 'q_1760000000000', unread: true })");
    const html = String(rt.elements["collab-inbox-list"].children[0].innerHTML);
    assert.ok(html.includes(">architect<"), html);
    assert.ok(!html.includes("[architect]"), "no debug-style brackets around names");
    assert.ok(!html.includes("q_1760000000000<") && !html.includes("ID:"), "question IDs are not shown");
    assert.ok(html.includes(">Question<") && html.includes('class="collab-type-badge question"'));
    assert.ok(!/style="/.test(html), "colours come from the stylesheet, not inline styles");
    assert.ok(html.includes("Open session</button>") && !html.includes("↗"));
    assert.ok(html.includes('data-action="wake-agent-question"') && html.includes("Answer now</button>"));
  });

  it("labels broadcasts and shared state instead of echoing backend values", () => {
    const rt = loadCollabRuntime();
    rt.run("addCollabInboxItem({ id: 'b', type: 'message', messageType: 'broadcast', fromSession: 'architect', content: 'x', unread: true })");
    rt.run("addCollabInboxItem({ id: 's', type: 'message', messageType: 'shared_state', fromSession: 'architect', content: 'x', unread: true })");
    rt.run("addCollabInboxItem({ id: 'm', type: 'message', messageType: 'message', fromSession: 'architect', content: 'x', unread: true })");
    const html = rt.elements["collab-inbox-list"].children.map((c: any) => c.innerHTML).join("\n");
    for (const label of [">Broadcast<", ">Shared state<", ">Message<"]) assert.ok(html.includes(label), label);
    assert.ok(!html.includes(">broadcast<") && !html.includes(">shared_state<"));
  });

  it("does not add a session's own shared-state writes or handoffs to its inbox", () => {
    const rt = loadCollabRuntime([{ id: "session-a", name: "worker" }]);
    assert.equal(rt.run("isOwnCollabEvent('worker')"), true);
    assert.equal(rt.run("isOwnCollabEvent('architect')"), false);
    assert.ok(caseBody("session_shared_state_changed").includes("if (isOwnCollabEvent(msg.author_session)) break;"));
    assert.ok(caseBody("session_handoff_written").includes("if (!msg.to_session_id && isOwnCollabEvent(msg.from_session)) break;"));
  });

  it("files a handoff sent to one session in that session's inbox", () => {
    const handoff = caseBody("session_handoff_written");
    assert.ok(handoff.includes("sessionId: msg.to_session_id || undefined"));
    assert.ok(handoff.includes("fromSessionId: msg.from_session_id || undefined"), "targeted handoffs link back to their author");
  });

  it("shows handoffs as their summary and shared state without double escaping", () => {
    const handoff = caseBody("session_handoff_written");
    assert.ok(!handoff.includes("**Phase**"), "no empty 'Phase: ()' line");
    assert.ok(handoff.includes("content: msg.task_summary || msg.summary || phaseLine"));
    assert.ok(!handoff.includes("=== currentSessionId"), "handoff names are never compared with session ids");
    const state = caseBody("session_shared_state_changed");
    assert.ok(!state.includes("escapeHtml("), "renderMarkdown escapes the content once");
    assert.ok(state.includes("messageType: 'shared_state'"));
  });

  it("asks the extension to wake the session instead of typing an internal prompt", () => {
    const start = script.indexOf("case 'wake-agent-question': {");
    const body = script.slice(start, script.indexOf("case 'resume-auto-wake':", start));
    assert.ok(body.includes("type: 'wake_for_question'"));
    assert.ok(!body.includes("agent_prompt") && !body.includes("session_answer_question") && !body.includes("chat-input"));
  });

  it("removes the unused chat card renderers", () => {
    for (const fn of ["appendSessionMessageCard", "appendSessionQuestionCard", "appendSessionAnswerCard", "appendSharedStateCard", "appendHandoffCard"]) {
      assert.ok(!script.includes(fn), fn);
    }
  });
});

describe("Session collaboration badge", () => {
  it("keeps the link badge through partial session updates", () => {
    const rt = loadCollabRuntime();
    const badge = rt.elements["session-collab-badge"];
    rt.run("updateSessionCollabBadge({ status: 'running', collaborators: ['architect', 'reviewer'] })");
    assert.equal(badge.style.display, "inline-flex");
    assert.ok(badge.innerHTML.includes("architect +1") && !badge.innerHTML.includes("Linked:"));
    assert.equal(badge.title, "Working with architect, reviewer");
    rt.run("updateSessionCollabBadge({ name: 'Renamed', status: undefined, collaborators: undefined })");
    assert.equal(badge.style.display, "inline-flex", "a rename must not hide the badge");
    rt.run("updateSessionCollabBadge({ status: 'idle', collaborators: [] })");
    assert.equal(badge.style.display, "none");
  });

  it("explains the paused and watching states in plain words", () => {
    const rt = loadCollabRuntime();
    const badge = rt.elements["session-collab-badge"];
    rt.run("updateSessionCollabBadge({ status: 'paused_limit_reached', collaborators: [] })");
    assert.ok(badge.innerHTML.includes("Auto-replies paused"));
    assert.ok(badge.innerHTML.includes('data-action="resume-auto-wake"'));
    assert.ok(!badge.innerHTML.includes("⚠") && !badge.innerHTML.includes("style="));
    rt.run("updateSessionCollabBadge({ status: 'watching', watching_for: { target_session: 'architect' } })");
    assert.ok(badge.innerHTML.includes("Waiting on architect") && !badge.innerHTML.includes("[architect]"));
    assert.ok(!badge.innerHTML.includes("style="));
  });

  it("lets Resume work without opening the inbox", () => {
    const start = script.indexOf("sessionCollabBadgeEl?.addEventListener('click'");
    const body = script.slice(start, script.indexOf("});", start));
    assert.ok(body.includes("closest('[data-action=\"resume-auto-wake\"]')"));
  });
});

describe("Collaboration theming", () => {
  it("follows the editor theme in light and dark", () => {
    const css: string = getChatStyles();
    const popover = css.slice(css.indexOf(".collab-inbox-popover {"), css.indexOf(".collab-inbox-header {"));
    assert.ok(popover.includes("background: var(--popover-bg);"), popover);
    assert.ok(!popover.includes("rgba(24, 24, 27"), "no fixed dark panel behind theme-coloured text");
    const collab = css.slice(css.indexOf("/* Session collaboration badge"), css.indexOf(".waterfall-callout-popover .popover-header"));
    assert.ok(!collab.includes("rgba(255, 255, 255"), "no white-on-white tints in light themes");
    assert.ok(!/#38bdf8|#d29922|rgba\(188, 140, 255/.test(collab), "accents use theme tokens");
    assert.ok(css.includes("--collab-violet: var(--vscode-charts-purple, var(--purple, #bc8cff));"));
    assert.ok(!css.includes(".session-question-card") && !css.includes(".session-card-badge"), "dead card styles removed");
  });
});

describe("Answer now", () => {
  it("reports why a question can't be answered and stays quiet on success", async () => {
    const calls: any[] = [];
    const ok = { call: async (method: string, params: any) => { calls.push([method, params]); return { success: true }; } };
    assert.equal(await wakeSessionForQuestion(ok, "s1", "q_1"), null);
    assert.deepEqual(calls, [["session.wakeForQuestion", { session_id: "s1", question_id: "q_1" }]]);
    const gone = { call: async () => ({ success: false, reason: "not_pending" }) };
    assert.equal(await wakeSessionForQuestion(gone, "s1", "q_1"), "This question was already answered or has expired.");
    const broken = { call: async () => { throw new Error("litellm.RateLimitError: internal"); } };
    const originalError = console.error;
    console.error = () => {};
    try {
      const notice = await wakeSessionForQuestion(broken, "s1", "q_1");
      assert.ok(notice && !notice.includes("litellm"), "internal errors stay out of the UI");
    } finally {
      console.error = originalError;
    }
    assert.ok(await wakeSessionForQuestion(null, "s1", "q_1"));
  });

  it("is handled by both the sidebar chat and the editor tab", () => {
    for (const file of ["providers/ChatViewProvider.ts", "panels/SessionTabPanel.ts"]) {
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      assert.ok(source.includes('case "wake_for_question": {') && source.includes("wakeSessionForQuestion("), file);
    }
  });
});
