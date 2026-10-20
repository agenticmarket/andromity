/**
 * Suggested next step: the card under a finished reply, the input placeholder,
 * Tab to fill the input, and the extension-side actions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
const { getChatStyles } = require("../src/providers/chatview/chatStyles.js");
Module.prototype.require = originalRequire;

const SRC = path.resolve(__dirname, "..", "..", "src");
const script: string = getChatClientScript("icon.svg", {
  currentSessionId: "s1", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
}).replace(/\r\n/g, "\n");

function section(): string {
  const start = script.indexOf("// ── Next-step suggestion");
  const end = script.indexOf("// ── End next-step suggestion");
  assert.ok(start > -1 && end > start, "next-step section must exist");
  return script.slice(start, end);
}

function el(id = ""): any {
  const attrs: Record<string, string> = {};
  const node: any = {
    id, className: "", innerHTML: "", value: "", style: {}, children: [] as any[],
    setAttribute: (k: string, v: string) => { attrs[k] = String(v); },
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    classList: { add() {}, remove() {}, toggle() {} },
    remove() { node.removed = true; },
    focus() {},
    attrs,
  };
  return node;
}

function load(opts: { running?: boolean; queue?: boolean } = {}) {
  const input = el("prompt-input");
  input.setAttribute("placeholder", "Ask Andromity…");
  input.scrollHeight = 40;
  const chat = el("chat");
  let card: any = null;
  chat.appendChild = (child: any) => { if (child.id === "next-step-card") card = child; return child; };
  const sandbox: any = {
    posted: [] as any[], dispatched: [] as any[], queued: [] as any[],
    currentSessionId: "s1",
    sessionsState: { s1: { isRunning: Boolean(opts.running) } },
    queueSupported: Boolean(opts.queue), isRunning: Boolean(opts.running),
    promptQueue: [] as any[], renderQueue() {},
    promptInput: input, sendBtn: el("send"), chatContainer: chat,
    escapeHtml: (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    extractMessageText: (c: any) => (typeof c === "string" ? c : ""),
    scrollToBottomIfNeeded() {},
    document: {
      getElementById: (id: string) => (id === "prompt-input" ? input : id === "next-step-card" && card && !card.removed ? card : null),
      createElement: () => el(),
    },
  };
  sandbox.vscode = { postMessage: (m: any) => sandbox.posted.push(m) };
  sandbox.dispatchPrompt = (text: string, attach: boolean, images: any[], delivery?: string) => sandbox.dispatched.push({ text, delivery });
  vm.createContext(sandbox);
  vm.runInContext(section(), sandbox);
  return { sandbox, input, card: () => (card && !card.removed ? card : null), run: (code: string) => vm.runInContext(code, sandbox) };
}

const STEP = { title: "Fix the null check", prompt: "Fix the null check in parser.ts", new_session: false };

describe("Suggested next step card", () => {
  it("shows one card with Do it and dismiss, and puts the title in the input placeholder", () => {
    const rt = load();
    rt.sandbox.step = STEP;
    rt.run("setNextStep('s1', normalizeNextStep(step))");
    const card = rt.card();
    assert.ok(card, "card is rendered when the turn is over");
    assert.ok(card.innerHTML.includes(">Fix the null check<"));
    assert.ok(card.innerHTML.includes('title="Fix the null check in parser.ts"'), "the full prompt is visible on hover");
    assert.ok(card.innerHTML.includes('data-action="next-step-run">Do it<'));
    assert.ok(card.innerHTML.includes('data-action="next-step-dismiss"'));
    assert.ok(!card.innerHTML.includes("New session"), "New session only when the agent marked the work independent");
    assert.equal(rt.input.getAttribute("placeholder"), "Fix the null check  ·  Tab to use");
    assert.deepEqual(rt.sandbox.posted.map((m: any) => m.event), ["shown"]);
  });

  it("offers New session only for independent work", () => {
    const rt = load();
    rt.sandbox.step = { ...STEP, new_session: true };
    rt.run("setNextStep('s1', normalizeNextStep(step))");
    assert.ok(rt.card().innerHTML.includes('data-action="next-step-new-session"'));
    rt.run("startNextStepInNewSession()");
    assert.equal(rt.card(), null);
    assert.deepEqual(JSON.parse(JSON.stringify(rt.sandbox.posted.at(-1))), { type: "start_next_step_session", title: STEP.title, prompt: STEP.prompt, sessionId: "s1" });
  });

  it("waits for the turn to finish before showing anything", () => {
    const rt = load({ running: true });
    rt.sandbox.step = STEP;
    rt.run("setNextStep('s1', normalizeNextStep(step))");
    assert.equal(rt.card(), null);
    assert.equal(rt.input.getAttribute("placeholder"), "Ask Andromity…");
    rt.run("sessionsState.s1.isRunning = false; renderNextStep()");
    assert.ok(rt.card());
  });

  it("Do it sends the prompt without touching what is typed", () => {
    const rt = load({ queue: true });
    rt.sandbox.step = STEP;
    rt.run("setNextStep('s1', normalizeNextStep(step))");
    rt.input.value = "my draft";
    rt.run("runNextStep()");
    assert.deepEqual(rt.sandbox.dispatched, [{ text: STEP.prompt, delivery: "queue" }]);
    assert.equal(rt.input.value, "my draft");
    assert.equal(rt.card(), null);
    assert.equal(rt.input.getAttribute("placeholder"), "Ask Andromity…", "placeholder goes back to normal");
  });

  it("Tab puts the prompt in the input for editing; Esc dismisses for good", () => {
    const rt = load();
    rt.sandbox.step = STEP;
    rt.run("setNextStep('s1', normalizeNextStep(step))");
    assert.equal(rt.run("acceptNextStepIntoInput()"), true);
    assert.equal(rt.input.value, STEP.prompt);
    assert.equal(rt.sandbox.dispatched.length, 0, "Tab never sends");
    assert.equal(rt.card(), null);

    const esc = load();
    esc.sandbox.step = STEP;
    esc.run("setNextStep('s1', normalizeNextStep(step))");
    esc.run("dismissNextStep('dismissed')");
    assert.equal(esc.card(), null);
    assert.equal(esc.run("nextStepDismissed.has(normalizeNextStep(step).key)"), true, "a dismissed suggestion is not restored on reload");
  });

  it("shows the same suggestion again when a later turn repeats it", () => {
    const rt = load();
    rt.sandbox.step = STEP;
    rt.run("receiveNextStep('s1', step)");
    assert.equal(rt.run("acceptNextStepIntoInput()"), true);
    assert.equal(rt.card(), null);
    rt.input.value = "";
    rt.run("receiveNextStep('s1', step)");
    assert.ok(rt.card(), "a repeat after Tab must not be swallowed");
    rt.run("dismissNextStep('dismissed')");
    rt.run("receiveNextStep('s1', step)");
    assert.ok(rt.card(), "a repeat after dismissing must not be swallowed either");
    assert.ok(script.includes("receiveNextStep(msg.session_id, msg);"));
  });

  it("restores an open suggestion from history and hides its tool call", () => {
    const rt = load();
    const args = JSON.stringify(STEP);
    rt.sandbox.history = [
      { role: "user", content: "why does parse crash?" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }, { id: "c2", function: { name: "suggest_next_step", arguments: args } }] },
      { role: "tool", tool_call_id: "c1", content: "file" },
      { role: "tool", tool_call_id: "c2", content: "ok" },
      { role: "assistant", content: "", tool_calls: [{ id: "c3", function: { name: "suggest_next_step", arguments: args } }] },
      { role: "tool", tool_call_id: "c3", content: "ok" },
      { role: "assistant", content: "Found it." },
    ];
    assert.equal(rt.run("nextStepFromHistory(history).title"), STEP.title);
    const shown = rt.run("withoutNextStepCalls(history)");
    assert.equal(shown.length, 4, "the suggestion-only message and both tool results are gone");
    assert.deepEqual(shown[1].tool_calls.map((t: any) => t.id), ["c1"]);
    assert.ok(!shown.some((m: any) => m.tool_call_id === "c2" || m.tool_call_id === "c3"));

    rt.sandbox.answered = [...rt.sandbox.history, { role: "user", content: "thanks" }];
    assert.equal(rt.run("nextStepFromHistory(answered)"), null, "a later message closes the suggestion");
  });
});

describe("Background sessions", () => {
  function loadRows(userTurns = 0) {
    const nodes: any[] = [];
    const turns = Array.from({ length: userTurns }, (_, i) => ({ id: "turn-" + i, parentNode: null as any }));
    const chat: any = {
      appendChild: (n: any) => { n.parentNode = chat; nodes.push(n); return n; },
      insertBefore: (n: any, ref: any) => { n.parentNode = chat; const i = ref ? nodes.indexOf(ref) : -1; nodes.splice(i < 0 ? nodes.length : i, 0, n); return n; },
      querySelectorAll: () => turns,
      get firstChild() { return nodes[0] || null; },
    };
    turns.forEach(t => { t.parentNode = chat; nodes.push(t); });
    const sandbox: any = {
      currentSessionId: "parent", chatContainer: chat,
      escapeHtml: (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
      document: {
        getElementById: (id: string) => nodes.find(n => n.id === id) || null,
        createElement: () => ({ id: "", className: "", innerHTML: "", setAttribute() {} }),
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(section(), sandbox);
    return { nodes, run: (code: string) => vm.runInContext(code, sandbox) };
  }

  it("shows one line in the parent that follows the run to its end", () => {
    const rt = loadRows();
    rt.run("trackBackgroundRun('parent', { session_id: 'child', title: 'Fix the null check', status: 'running' })");
    const row = rt.nodes.find(n => n.id === "bg-run-child");
    assert.ok(row.className.includes("status-running"));
    assert.ok(row.innerHTML.includes(">Running in background<") && row.innerHTML.includes(">Fix the null check<"));
    assert.ok(row.innerHTML.includes('data-action="switch-session" data-session-id="child"'), "Open goes to the background session");

    rt.run("setBackgroundRunWaiting('child', true)");
    assert.ok(row.className.includes("status-waiting") && row.innerHTML.includes(">Needs your input<"));
    rt.run("setBackgroundRunWaiting('child', false)");
    assert.ok(row.className.includes("status-running"));

    rt.run("trackBackgroundRun('parent', { session_id: 'child', title: 'Fix the null check', status: 'finished', summary: 'Added the guard. 12 tests pass.' })");
    assert.equal(rt.nodes.filter(n => n.id === "bg-run-child").length, 1, "the same line updates");
    assert.ok(row.innerHTML.includes(">Background session finished<") && row.innerHTML.includes(">Added the guard. 12 tests pass.<"));
    rt.run("setBackgroundRunWaiting('child', true)");
    assert.ok(row.className.includes("status-finished"), "a finished run never goes back to waiting");
  });

  it("only draws the line in the session that started it", () => {
    const rt = loadRows();
    rt.run("trackBackgroundRun('other', { session_id: 'child', title: 'x', status: 'running' })");
    assert.equal(rt.nodes.length, 0);
  });

  it("puts saved lines back after the turn that started them, and links a child to its origin", () => {
    const rt = loadRows(3);
    rt.run("restoreBackgroundRuns({ id: 'parent', background_runs: [{ session_id: 'c1', title: 'Fix it', status: 'finished', summary: 'Done.', turn_index: 1 }, { session_id: 'c2', title: 'Later', status: 'running', turn_index: 3 }] })");
    assert.deepEqual(rt.nodes.map(n => n.id), ["turn-0", "bg-run-c1", "turn-1", "turn-2", "bg-run-c2"]);

    const child = loadRows(1);
    child.run("renderBackgroundOrigin({ id: 'c1', started_from: { session_id: 'parent', name: 'Parser crash' } })");
    assert.equal(child.nodes[0].className, "bg-origin-row");
    assert.ok(child.nodes[0].innerHTML.includes('data-session-id="parent"') && child.nodes[0].innerHTML.includes(">Parser crash<"));
  });

  it("is wired to the extension and the server", () => {
    const provider = fs.readFileSync(path.join(SRC, "providers/ChatViewProvider.ts"), "utf8");
    assert.ok(provider.includes('"session.startBackground"'), "New session runs in the background");
    assert.ok(!/startNextStepSession[\s\S]{0,900}sendPromptFromExternal/.test(provider), "New session no longer switches away");
    for (const file of ["providers/ChatViewProvider.ts", "panels/SessionTabPanel.ts"]) {
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      assert.ok(source.includes('bind("session/backgroundStarted"') && source.includes('bind("session/backgroundFinished"'), file);
    }
    assert.ok(script.includes("case 'background_session_started':") && script.includes("case 'background_session_finished':"));
    assert.ok(script.includes("restoreBackgroundRuns(msg.session);") && script.includes("setBackgroundRunWaiting(sid, true);"));
  });

  it("hides the context it adds to prompts", () => {
    const { cleanPromptForDisplay } = require("../src/providers/promptDisplay.js");
    assert.equal(cleanPromptForDisplay('Fix it\n\n---\n[Started from session "Parser crash"]\nIts last request: why'), "Fix it");
    assert.equal(cleanPromptForDisplay('What next?\n\n---\n[Background sessions]\n- "Fix it" finished: Fixed.'), "What next?");
    assert.ok(script.includes("Other Open Documents|Started from session|Background sessions"));
  });
});

describe("Suggested next step wiring", () => {
  it("hooks into input keys, sending, turn start and end, and session load", () => {
    assert.ok(script.includes("promptInput.value === '' && document.getElementById('next-step-card')"), "Tab and Esc only while the input is empty and a card shows");
    assert.ok(script.includes("if (e.key === 'Tab') acceptNextStepIntoInput();"));
    assert.ok(/function dispatchPrompt\(text, attachContext, images, delivery, requestId\) \{\n\s+try \{\n\s+setNextStep\(currentSessionId, null\);/.test(script), "sending anything clears the suggestion");
    assert.ok(script.includes("if (msg.tool_name === 'suggest_next_step') break;"), "no tool card for the suggestion");
    const started = script.slice(script.indexOf("case 'agent_started':"), script.indexOf("case 'agent_started':") + 200);
    assert.ok(started.includes("setNextStep(msg.session_id, null);"));
    const done = script.slice(script.indexOf("case 'agent_done': {"), script.indexOf("case 'agent_cancelled': {"));
    assert.ok(done.includes("flushQueue();\n          renderNextStep();"));
    assert.ok(script.includes("allMessages = withoutNextStepCalls(allMessages);"));
  });

  it("is handled by the sidebar and the editor tab", () => {
    for (const file of ["providers/ChatViewProvider.ts", "panels/SessionTabPanel.ts"]) {
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      assert.ok(source.includes('bind("agent/nextStepSuggested"'), file);
      assert.ok(source.includes('case "start_next_step_session": {') && source.includes("startNextStepSession("), file);
      assert.ok(source.includes('case "next_step_event": {') && source.includes("recordNextStepEvent("), file);
    }
    const settings = fs.readFileSync(path.join(SRC, "panels/SettingsPanel.ts"), "utf8");
    assert.ok(settings.includes('key: "next_step_suggestions"') && settings.includes('id="setting-next-steps"'));
  });

  it("follows the editor theme", () => {
    const css: string = getChatStyles();
    const block = css.slice(css.indexOf(".next-step-card {"), css.indexOf(".next-step-dismiss:hover"));
    assert.ok(block.includes("background: var(--chat-surface, var(--card-bg));"));
    assert.ok(block.includes("background: var(--vscode-button-background, var(--accent));"));
    assert.ok(!/rgba\(255, 255, 255|#18181b/.test(block), "no fixed dark colours");
  });

  it("records only which action was used", () => {
    const featureUsage = require("../src/telemetry/featureUsage.js");
    const calls: any[] = [];
    featureUsage.setFeatureUsageClient({ call: async (method: string, params: any) => { calls.push(params); } });
    featureUsage.setFeatureUsageGate(() => true);
    const { recordNextStepEvent } = require("../src/nextSteps.js");
    recordNextStepEvent("run", "s1");
    recordNextStepEvent("Fix the null check in parser.ts", "s1");
    featureUsage.setFeatureUsageClient(null);
    assert.deepEqual(calls.map(c => c.feature), ["next_step_run"]);
  });
});
