import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { cleanPromptForDisplay, getPromptDisplayScript } from "../src/providers/promptDisplay.js";
import { getWaterfallScript } from "../src/providers/waterfall/waterfallScript.js";

describe("IDE context presentation", () => {
  it("cleans full prompts and truncated saved titles without removing ordinary separators", () => {
    const user = "hi what is in this file fix it";
    for (const text of [
      user + "\n\n---\n[Active Document: index.html]\nprivate content",
      user + " --- [Active Document...",
      user + "\n---\n[Active Diagnostics]\nprivate content",
    ]) assert.equal(cleanPromptForDisplay(text), user);
    assert.equal(cleanPromptForDisplay("compare a --- b"), "compare a --- b");
    assert.equal(cleanPromptForDisplay("My renamed session"), "My renamed session");
  });

  it("cleans Waterfall turn creation and later label updates, including tooltip text", () => {
    const script = getWaterfallScript("session");
    const ensure = script.slice(script.indexOf("      function ensureTurn("), script.indexOf("      function renderTurn("));
    const label = { textContent: "", title: "" };
    const turns = new Map();
    const context = vm.createContext({ state: { turns }, Date,
      renderTurn: (turn: { element: unknown }) => { turn.element = { querySelector: () => label }; },
    });
    vm.runInContext(getPromptDisplayScript() + ensure + '\nensureTurn("turn_1", "Agent Turn", 1);', context);
    context.prompt = "fix file\n---\n[Active Document: index.html]\nprivate context";
    vm.runInContext('ensureTurn("turn_1", prompt, 1); ensureTurn("turn_2", prompt, 1);', context);
    assert.equal(turns.get("turn_1").query, "fix file");
    assert.equal(turns.get("turn_2").query, "fix file");
    assert.equal(label.textContent, "fix file");
    assert.equal(label.title, "fix file");
    assert.ok(script.includes("const turnQuery = cleanPromptForDisplay(m.content)"));
    assert.ok(script.includes("const query = cleanPromptForDisplay(msg.prompt"));
  });
});
