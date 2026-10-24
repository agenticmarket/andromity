import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadChat } from "./helpers/chatHarness.js";

describe("Andromity gateway models in the chat model list", () => {
  it("keeps every model the gateway lists, not only Auto", () => {
    const h = loadChat();
    h.post({
      type: "init_state",
      models: [
        { id: "auto", name: "Andromity Auto", provider: "andromity" },
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "andromity", pricing: "Free for signed-in users" },
        { id: "gpt-5", name: "GPT-5", provider: "openai" },
      ],
    });
    assert.deepEqual(
      JSON.parse(h.eval("JSON.stringify(allModels.map(m => m.provider + '/' + m.id))")),
      ["andromity/auto", "andromity/claude-haiku-5-5", "openai/gpt-5"],
    );
  });
});
