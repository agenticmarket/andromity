import { it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

const script = getChatClientScript("icon", { currentSessionId: "a", currentModel: "model",
  currentProvider: "provider", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" });

function executeCase(type: string, next: string, context: vm.Context) {
  const section = script.slice(script.indexOf("        case '" + type + "':"), script.indexOf("        case '" + next + "':"));
  vm.runInContext("switch ('" + type + "') {" + section + "}", context);
}

it("runtime snapshot restores tools, questions and shell tasks in the selected session", () => {
  const replay: any[] = [];
  const processes = new Map();
  const context = vm.createContext({ currentSessionId: "a", sessionsState: {}, isRunning: false,
    activeBgProcesses: processes, cancelBtn: { style: {} }, sendBtn: { style: {} },
    document: { querySelector: () => ({ classList: { toggle: () => {} } }) }, removeTurnLoader: () => {},
    updateBgProcessStripUI: () => {}, handleBackendMessage: (event: any) => replay.push(event),
    msg: { session_id: "a", runtime: { is_running: true, tools: [{ tool_id: "tool", tool_name: "shell_exec", args_json: '{"command":"python"}' }],
      processes: [{ process_id: "timer", session_id: "a" }], interactions: [{ type: "ask_questions", question_id: "q" }] } },
  });
  executeCase("session_runtime", "session_load_failed", context);
  assert.equal(context.isRunning, true);
  assert.deepEqual(replay.map(event => event.type), ["tool_start", "tool_delta", "process_started", "ask_questions"]);
  assert.equal(context.cancelBtn.style.display, "flex");
  replay.length = 0;
  context.msg.session_id = "b";
  executeCase("session_runtime", "session_load_failed", context);
  assert.equal(replay.length, 0);
});

it("resolving one prompt does not dismiss a different pending request", () => {
  const next: any[] = [];
  const pending = { p: { type: "tool_approval_required", approval_id: "p" }, q: { type: "ask_questions", question_id: "q" } };
  const slot = { dataset: { interactionId: "q" } as Record<string, string>, innerHTML: "question draft" };
  const context = vm.createContext({ currentSessionId: "a", sessionsState: { a: { interactions: pending } },
    interactiveSlot: slot, activePendingApprovalId: "p", activePendingToolName: "shell", activePendingPlan: false,
    handleBackendMessage: (event: any) => next.push(event), msg: { session_id: "a", interaction_id: "p" } });
  executeCase("interaction_resolved", "interaction_failed", context);
  assert.equal(slot.innerHTML, "question draft");
  assert.equal(Object.keys(pending).includes("p"), false);
  assert.equal(Object.keys(pending).includes("q"), true);
  assert.equal(next.length, 0);
});

it("background process events from another session cannot appear in this pop-out", () => {
  const processes = new Map();
  const context = vm.createContext({ currentSessionId: "a", activeBgProcesses: processes,
    updateBgProcessStripUI: () => {}, msg: { session_id: "b", process_id: "timer" } });
  executeCase("process_started", "process_exited", context);
  assert.equal(processes.size, 0);
  context.msg.session_id = "a";
  executeCase("process_started", "process_exited", context);
  assert.equal(processes.size, 1);
});
