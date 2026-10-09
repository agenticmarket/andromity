import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
Module.prototype.require = originalRequire;

const script: string = getChatClientScript("icon.svg", {
  currentSessionId: "s", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
});

it("handles session_updated in exactly one switch case so collaborator badges and per-session renames run", () => {
  assert.equal(script.split("case 'session_updated':").length - 1, 1);
});

it("keeps inter-session messages for sessions that are not on screen", () => {
  for (const kind of ["session_message_received", "session_question_received", "session_answer_received"]) {
    const start = script.indexOf(`case '${kind}':`);
    const body = script.slice(start, script.indexOf("break;", start));
    assert.ok(!body.includes("=== currentSessionId"), `${kind} must not drop items for other sessions`);
    assert.ok(body.includes("sessionId: msg.to_session_id"), `${kind} must tag the item with its target session`);
  }
});
