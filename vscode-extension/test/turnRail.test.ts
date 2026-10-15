import { it } from "node:test";
import assert from "node:assert/strict";
import { getTurnRailScript, getTurnRailStyles } from "../src/providers/chatview/turnRail.js";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
Module.prototype.require = originalRequire;

const script = getChatClientScript("icon.svg", {
  currentSessionId: "s", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
});

it("injects the turn rail into the chat view script and styles", () => {
  assert.ok(script.includes(getTurnRailScript().trim().slice(0, 200)));
  assert.ok(getChatStyles().includes(getTurnRailStyles().trim().slice(0, 200)));
});

it("refreshes the rail when a turn ends so the running tick settles", () => {
  const end = script.indexOf("function endAssistantTurn(");
  const nextFn = script.indexOf("\n    function ", end + 10);
  assert.ok(script.slice(end, nextFn).includes("scheduleTurnRail()"));
});

it("keeps the reader on the turn they jumped to while a reply streams", () => {
  const rail = getTurnRailScript();
  const jump = rail.slice(rail.indexOf("function jumpToTurn("));
  assert.ok(jump.indexOf("userScrolledUp = true") < jump.indexOf("chatContainer.scrollTo("));
});

it("counts steering prompts as part of the turn they steer", () => {
  assert.ok(getTurnRailScript().includes("!el.hasAttribute('data-steering')"));
});
