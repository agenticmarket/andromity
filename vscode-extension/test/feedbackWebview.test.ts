import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import Module from "node:module";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import type { FeedbackPayload } from "../src/engagement/feedbackSubmit.js";

let airGapOn = false;
const opened: string[] = [];
const copied: string[] = [];
const mockVscode = {
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => (key === "airGap.enabled" ? { globalValue: airGapOn } : undefined),
    }),
  },
  env: {
    clipboard: { writeText: async (text: string) => { copied.push(text); } },
    openExternal: async (uri: { url: string }) => { opened.push(uri.url); return true; },
  },
  Uri: { parse: (url: string) => ({ url }) },
};
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (id, ...args) {
  return id === "vscode" ? mockVscode : originalLoad.call(this, id, ...args);
};
const { handleFeedbackMessage } = require("../src/engagement/feedbackWebview.js");
loader._load = originalLoad;

const context = { extension: { packageJSON: { version: "0.2.24" } } };

function recorder(result: boolean) {
  const sent: FeedbackPayload[] = [];
  return { sent, submit: async (payload: FeedbackPayload) => { sent.push(payload); return result; } };
}

it("sends the trimmed note with the client, OS family and version", async () => {
  airGapOn = false;
  const r = recorder(true);
  const reply = await handleFeedbackMessage({ type: "submit_feedback", message: "  The diff view is great  " }, context, r.submit);
  assert.deepEqual(reply, { type: "feedback_result", ok: true });
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].message, "The diff view is great");
  assert.equal(r.sent[0].client, "vscode");
  assert.equal(r.sent[0].version, "0.2.24");
});

it("refuses empty and over-long notes without sending", async () => {
  airGapOn = false;
  const r = recorder(true);
  const empty = await handleFeedbackMessage({ type: "submit_feedback", message: "   " }, context, r.submit);
  const long = await handleFeedbackMessage({ type: "submit_feedback", message: "x".repeat(2001) }, context, r.submit);
  assert.equal(empty.ok, false);
  assert.equal(long.ok, false);
  assert.match(long.error, /2000/);
  assert.equal(r.sent.length, 0);
});

it("does not send while air-gap mode is on", async () => {
  airGapOn = true;
  const r = recorder(true);
  const reply = await handleFeedbackMessage({ type: "submit_feedback", message: "hello" }, context, r.submit);
  airGapOn = false;
  assert.equal(reply.ok, false);
  assert.match(reply.error, /air-gap/i);
  assert.equal(r.sent.length, 0);
});

it("offers a GitHub issue when delivery fails, and copies the note when it is opened", async () => {
  airGapOn = false;
  const reply = await handleFeedbackMessage({ type: "submit_feedback", message: "hello" }, context, recorder(false).submit);
  assert.equal(reply.ok, false);
  assert.equal(reply.canOpenIssue, true);
  assert.equal(await handleFeedbackMessage({ type: "feedback_issue", message: " my note " }, context), null);
  assert.deepEqual(copied, ["my note"]);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /github\.com\/agenticmarket\/andromity\/issues\/new/);
});

it("ignores messages that are not about feedback", async () => {
  assert.equal(await handleFeedbackMessage({ type: "open_external_url" }, context), null);
});

function formHarness() {
  const script = getChatClientScript("icon.svg", { currentSessionId: "s", currentModel: "m",
    currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" });
  const block = script.slice(script.indexOf("    const feedbackDockBtn ="), script.indexOf("    function handleBackendMessage(msg) {"));
  const nodes = new Map<string, any>();
  const docListeners: Record<string, (event: any) => void> = {};
  const make = (id: string) => {
    const listeners: Record<string, (event?: any) => void> = {};
    const attrs: Record<string, string> = {};
    const el: any = { id, hidden: id === "feedback-popover" || id === "btn-feedback-issue", value: "", textContent: "",
      className: "", disabled: false, listeners, attrs,
      addEventListener: (type: string, fn: (event?: any) => void) => { listeners[type] = fn; },
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
      focus: () => { document.activeElement = el; },
      contains: (other: any) => id === "feedback-popover" && !!other && ["feedback-text", "btn-feedback-send"].includes(other.id) };
    nodes.set(id, el);
    return el;
  };
  const document: any = { activeElement: null, getElementById: (id: string) => nodes.get(id) || make(id),
    addEventListener: (type: string, fn: (event: any) => void) => { docListeners[type] = fn; } };
  const posted: any[] = [];
  const context = vm.createContext({ document, vscode: { postMessage: (msg: unknown) => posted.push(msg) },
    setTimeout: (fn: () => void) => { fn(); return 1; }, clearTimeout() {} });
  vm.runInContext(block + "\nthis.handleFeedbackResult = handleFeedbackResult;", context);
  return { nodes, posted, docListeners, result: (msg: unknown) => (context as any).handleFeedbackResult(msg) };
}

it("opens the form from the bug button, sends the note and closes after a thank-you", () => {
  const h = formHarness();
  const popover = h.nodes.get("feedback-popover");
  const send = h.nodes.get("btn-feedback-send");
  const text = h.nodes.get("feedback-text");
  h.nodes.get("btn-feedback-dock").listeners.click();
  assert.equal(popover.hidden, false);
  assert.equal(h.nodes.get("btn-feedback-dock").attrs["aria-expanded"], "true");
  assert.equal(send.disabled, true, "Send waits for a note");
  text.value = "Session tabs are confusing";
  text.listeners.input();
  assert.equal(send.disabled, false);
  assert.equal(h.nodes.get("feedback-count").textContent, "26/2000");
  send.listeners.click();
  assert.equal(JSON.stringify(h.posted.at(-1)), JSON.stringify({ type: "submit_feedback", message: "Session tabs are confusing" }));
  assert.equal(send.disabled, true, "no double send while waiting");
  h.result({ type: "feedback_result", ok: true });
  assert.equal(text.value, "");
  assert.equal(popover.hidden, true);
});

it("keeps the note and offers a GitHub issue when sending fails", () => {
  const h = formHarness();
  const text = h.nodes.get("feedback-text");
  h.nodes.get("btn-feedback-dock").listeners.click();
  text.value = "Crash on start";
  text.listeners.input();
  h.nodes.get("btn-feedback-send").listeners.click();
  h.result({ type: "feedback_result", ok: false, error: "Could not send.", canOpenIssue: true });
  assert.equal(text.value, "Crash on start");
  assert.equal(h.nodes.get("feedback-status").className, "feedback-status error");
  assert.equal(h.nodes.get("btn-feedback-issue").hidden, false);
  h.nodes.get("btn-feedback-issue").listeners.click();
  assert.equal(JSON.stringify(h.posted.at(-1)), JSON.stringify({ type: "feedback_issue", message: "Crash on start" }));
  assert.equal(h.nodes.get("feedback-popover").hidden, true);
});
