import { it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

it("image retry sends a session-specific text-only retry and restores the button after rejection", () => {
  const script = getChatClientScript("icon", { currentSessionId: "tab", currentModel: "model",
    currentProvider: "provider", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" });
  const click = script.slice(script.indexOf("        case 'retry-without-image':"), script.indexOf("        case 'switch-model-flyout':"));
  const response = script.slice(script.indexOf("        case 'retry_result':"), script.indexOf("        case 'input_session':"));
  const button = { innerHTML: "Retry without Image", textContent: "", dataset: { action: "retry-without-image" } };
  const card = { style: { opacity: "" }, dataset: {} as Record<string, string>, querySelector: () => button };
  const posts: unknown[] = [];
  const notes: string[] = [];
  const context = vm.createContext({
    currentSessionId: "tab", currentModel: "model", currentProvider: "provider", currentReasoning: "auto",
    target: { closest: () => card }, vscode: { postMessage: (message: unknown) => posts.push(message) },
    document: { querySelectorAll: () => [card] }, appendSystemNote: (message: string) => notes.push(message),
  });
  vm.runInContext("switch ('retry-without-image') {" + click + "}", context);
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0])), {
    type: "retry_turn", sessionId: "tab", stripImages: true, model: "model", provider: "provider", reasoningEffort: "auto",
  });
  vm.runInContext("switch ('retry-without-image') {" + click + "}", context);
  assert.equal(posts.length, 1, "double click must not create another turn");
  context.msg = { session_id: "tab", success: false, error: "Reconnect and try again." };
  vm.runInContext("switch ('retry_result') {" + response + "}", context);
  assert.equal(card.style.opacity, "");
  assert.equal(card.dataset.retryPending, undefined);
  assert.equal(button.textContent, "Retry without Image");
  assert.deepEqual(notes, ["Reconnect and try again."]);
});
