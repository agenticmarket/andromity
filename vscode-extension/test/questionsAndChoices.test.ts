/**
 * Clarifying questions can be answered in your own words or closed, and the
 * next-step card can offer a short choice.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
const { getChatStyles } = require("../src/providers/chatview/chatStyles.js");
const { handleInteractionMessage } = require("../src/server/interactionBridge.js");
Module.prototype.require = originalRequire;

const script: string = getChatClientScript("icon.svg", {
  currentSessionId: "s1", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
}).replace(/\r\n/g, "\n");

function slice(from: string, to: string): string {
  const start = script.indexOf(from);
  const end = script.indexOf(to, start);
  assert.ok(start > -1 && end > start, from);
  return script.slice(start, end);
}

function questionsRuntime(slides: { prompt: string; checked?: string[]; other?: string; multi?: boolean; text?: string }[]) {
  const posted: any[] = [];
  const disabled: any[] = [];
  const slot: any = { dataset: {}, querySelectorAll: () => [{ set disabled(v: boolean) { disabled.push(v); } }] };
  const sandbox: any = {
    posted, window: {}, interactiveSlot: slot,
    vscode: { postMessage: (m: any) => posted.push(JSON.parse(JSON.stringify(m))) },
    document: {
      querySelectorAll: (sel: string) => {
        const i = Number(/q_(\d+)/.exec(sel)?.[1]);
        return (slides[i]?.checked || []).map(value => ({ value }));
      },
      getElementById: (id: string) => {
        const other = /^q_other_(\d+)$/.exec(id);
        if (other) {
          const s = slides[Number(other[1])];
          return s && s.other !== undefined ? { value: s.other, getAttribute: () => (s.multi ? "1" : "") } : null;
        }
        const text = /^q_input_(\d+)$/.exec(id);
        if (text) {
          const s = slides[Number(text[1])];
          return s && s.text !== undefined ? { value: s.text } : null;
        }
        return null;
      },
      querySelector: (sel: string) => {
        const i = Number(/q-slide-(\d+)/.exec(sel)?.[1]);
        return slides[i] ? { textContent: slides[i].prompt } : null;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(slice("    window.submitQuestions = function", "    function escapeHtml(str)"), sandbox);
  return { posted, run: (code: string) => vm.runInContext(code, sandbox) };
}

describe("Clarifying questions", () => {
  it("offers a line for answering in your own words under every list of options", () => {
    const render = slice("        case 'ask_questions': {", "interactiveSlot.innerHTML = qHtml;");
    assert.ok(render.includes('class="question-other-input"') && render.includes('placeholder="Something else…"'));
    assert.ok(render.includes('data-action="dismiss-questions"') && render.includes('aria-label="Close without answering"'));
  });

  it("sends typed text instead of a single choice and alongside a multiple choice", () => {
    const rt = questionsRuntime([
      { prompt: "Which database?", checked: ["Postgres"], other: "SQLite for tests" },
      { prompt: "Which targets?", checked: ["web"], other: "cli", multi: true },
      { prompt: "Anything else?", text: "" },
    ]);
    rt.run("window.submitQuestions('q1', 3)");
    assert.deepEqual(rt.posted, [{
      type: "answer_question", questionId: "q1", dismissed: false,
      answers: "User answers:\n1. Which database?: SQLite for tests\n2. Which targets?: web, cli",
    }]);
  });

  it("treats closing, or sending nothing, as no answer", () => {
    const closed = questionsRuntime([{ prompt: "Which database?", checked: ["Postgres"] }]);
    closed.run("window.dismissQuestions('q1')");
    assert.deepEqual(closed.posted, [{ type: "answer_question", questionId: "q1", answers: "", dismissed: true }]);

    const empty = questionsRuntime([{ prompt: "Which database?", other: "" }]);
    empty.run("window.submitQuestions('q2', 1)");
    assert.equal(empty.posted[0].dismissed, true);
  });

  it("closes with Esc and keeps a typed answer and a picked option exclusive", () => {
    const keys = slice("      // ── Questions Card Keyboard Handling ──", "if (!isInput && e.key >= '1' && e.key <= '9')");
    assert.ok(keys.includes("if (e.key === 'Escape')") && keys.includes("window.dismissQuestions("));
    assert.ok(script.includes("document.querySelectorAll('input[name=\"q_' + other.getAttribute('data-q-idx') + '\"]:checked').forEach(r => { r.checked = false; });"));
    assert.ok(script.includes("const other = document.getElementById('q_other_' + choice.name.slice(2));"));
    const css: string = getChatStyles();
    assert.ok(css.includes(".question-other-input {") && css.includes(".questions-close-btn {"));
  });

  it("tells the server the questions were closed", async () => {
    const calls: any[] = [];
    const rpc: any = { call: async (method: string, params: any) => { calls.push([method, params]); return { success: true }; } };
    await handleInteractionMessage(rpc, { type: "answer_question", questionId: "q1", answers: "", dismissed: true } as any, "s1", () => {});
    assert.deepEqual(calls[0], ["agent.answer_question", { session_id: "s1", question_id: "q1", answers: "", dismissed: true }]);
  });
});

describe("Next-step choices", () => {
  function cardRuntime() {
    let card: any = null;
    const input: any = { value: "", getAttribute: () => "Ask Andromity…", setAttribute() {}, style: {} };
    const sandbox: any = {
      posted: [] as any[], dispatched: [] as any[], currentSessionId: "s1", sessionsState: { s1: {} },
      queueSupported: true, isRunning: false, promptQueue: [], renderQueue() {}, promptInput: input, sendBtn: { classList: { add() {} } },
      chatContainer: { appendChild: (c: any) => { card = c; } },
      escapeHtml: (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
      extractMessageText: () => "", scrollToBottomIfNeeded() {},
      document: {
        getElementById: (id: string) => (id === "prompt-input" ? input : id === "next-step-card" && card && !card.removed ? card : null),
        createElement: () => {
          const el: any = { id: "", className: "", innerHTML: "", setAttribute() {}, remove() { el.removed = true; } };
          el.classList = { add: (c: string) => { el.className += " " + c; } };
          return el;
        },
      },
    };
    sandbox.vscode = { postMessage: (m: any) => sandbox.posted.push(JSON.parse(JSON.stringify(m))) };
    sandbox.dispatchPrompt = (text: string, attach: boolean, images: any[], delivery?: string) => sandbox.dispatched.push({ text, delivery });
    vm.createContext(sandbox);
    vm.runInContext(slice("// ── Next-step suggestion", "// ── End next-step suggestion"), sandbox);
    return { sandbox, card: () => card, run: (code: string) => vm.runInContext(code, sandbox) };
  }

  const CHOICE = {
    question: "Which fix first?",
    options: [
      { title: "Fix parser", prompt: "Fix the parser null check" },
      { title: "Fix tests", prompt: "Fix the flaky test", new_session: true },
    ],
  };

  it("shows the question with one button per option, the recommended one first", () => {
    const rt = cardRuntime();
    rt.sandbox.raw = CHOICE;
    rt.run("receiveNextStep('s1', raw)");
    const html = rt.card().innerHTML;
    assert.ok(html.includes(">Which fix first?<"));
    assert.ok(html.includes('class="next-step-btn primary" data-action="next-step-run" data-opt-idx="0"') && html.includes(">Fix parser<"));
    assert.ok(html.includes('data-opt-idx="1"') && html.includes('<span class="next-step-new-tag">new session</span>'));
    assert.ok(!html.includes(">Do it<"), "a choice names its options instead");
    assert.ok(rt.card().className.includes("has-choices"));
  });

  it("runs the option picked, here or in a new session", () => {
    const here = cardRuntime();
    here.sandbox.raw = CHOICE;
    here.run("receiveNextStep('s1', raw); runNextStep('0')");
    assert.deepEqual(here.sandbox.dispatched, [{ text: "Fix the parser null check", delivery: "queue" }]);

    const away = cardRuntime();
    away.sandbox.raw = CHOICE;
    away.run("receiveNextStep('s1', raw); runNextStep('1')");
    assert.equal(away.sandbox.dispatched.length, 0);
    assert.deepEqual(away.sandbox.posted.at(-1), { type: "start_next_step_session", title: "Fix tests", prompt: "Fix the flaky test", sessionId: "s1" });
  });

  it("keeps the single-step card unchanged and reads both shapes from history", () => {
    const rt = cardRuntime();
    rt.sandbox.raw = { title: "Add tests", prompt: "Add tests for parse()" };
    rt.run("receiveNextStep('s1', raw)");
    assert.ok(rt.card().innerHTML.includes('data-action="next-step-run">Do it<'));
    assert.equal(rt.run("normalizeNextStep({ options: [{ title: 'A', prompt: 'a' }, { title: '', prompt: 'x' }] }).options.length"), 1);
    assert.equal(rt.run("normalizeNextStep({ options: [{ title: 'A', prompt: 'a' }], question: 'Q?' }).question"), "", "one option needs no question");
    assert.ok(script.includes("runNextStep(target.getAttribute('data-opt-idx'));"));
  });
});
