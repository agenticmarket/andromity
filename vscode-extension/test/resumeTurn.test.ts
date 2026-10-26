import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

const script = getChatClientScript("icon.svg", { currentSessionId: "s", currentModel: "m",
  currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" });
const start = script.indexOf("    function resumeAssistantTurn(");
const helper = script.slice(start, script.indexOf("    function getLangBadgeHtml(", start));

function node(classes: string[], children: any[] = []): any {
  const el: any = {
    classes: new Set(classes), children, removed: false,
    classList: { contains: (c: string) => el.classes.has(c) },
    appendChild: (child: any) => { el.children.push(child); child.parent = el; },
    remove: () => { el.removed = true; if (el.parent) el.parent.children = el.parent.children.filter((c: any) => c !== el); },
    querySelector: (sel: string) => el.children.find((c: any) => sel === "#turn-loading-indicator" && c.id === "turn-loading-indicator") || null,
    querySelectorAll: (sel: string) => sel === ":scope > .message-footer" ? el.children.filter((c: any) => c.classes?.has("message-footer")) : [],
  };
  children.forEach((c) => { c.parent = el; });
  return el;
}

function harness(last: any) {
  const chatContainer = node([], last ? [last] : []);
  Object.defineProperty(chatContainer, "lastElementChild", { get: () => chatContainer.children.at(-1) || null });
  const context: any = vm.createContext({ chatContainer, currentTurnAssistantDiv: null, currentTurnStartTime: 0, accumulatedAssistantText: "",
    startAssistantTurn() {
      const loader = node([]); loader.id = "turn-loading-indicator";
      const fresh = node(["message-wrap", "assistant"], [loader]);
      chatContainer.appendChild(fresh);
      context.currentTurnAssistantDiv = fresh;
      context.currentTurnStartTime = 999;
    } });
  vm.runInContext(helper + "\nthis.resume = resumeAssistantTurn;", context);
  return { chatContainer, context };
}

it("continues a running turn in the reply drawn from history instead of opening a second reply", () => {
  const footer = node(["message-footer"]);
  const previous = node(["message-wrap", "assistant"], [node(["assistant-text"]), footer]);
  previous._rawMarkdown = "I will start with the layout.";
  const { chatContainer, context } = harness(previous);
  context.resume(1234);
  assert.equal(context.currentTurnAssistantDiv, previous);
  assert.equal(chatContainer.children.length, 1, "no second Andromity block");
  assert.ok(!previous.children.includes(footer), "the finished-turn footer is removed while the turn runs");
  assert.ok(previous.children.some((c: any) => c.id === "turn-loading-indicator"), "the progress indicator moves into the reply");
  assert.equal(context.currentTurnStartTime, 1234, "duration counts from the turn's prompt");
  assert.equal(context.accumulatedAssistantText, "I will start with the layout.\n\n");
});

it("starts a fresh reply when the chat ends with the prompt", () => {
  const prompt = node(["message-wrap", "user"]);
  const { chatContainer, context } = harness(prompt);
  context.resume(0);
  assert.equal(chatContainer.children.length, 2);
  assert.ok(context.currentTurnAssistantDiv.classList.contains("assistant"));
  assert.equal(context.currentTurnStartTime, 999, "no prompt time keeps the default start");
});
