import { it } from "node:test";
import assert from "node:assert/strict";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

const styles = getChatStyles();
const script = getChatClientScript("icon.svg", {
  currentSessionId: "s", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
});

it("sizes skeleton placeholders only while they are still loading", () => {
  for (const name of ["skeleton-text", "skeleton-pill", "skeleton-session", "skeleton-card"]) {
    assert.ok(styles.includes(".skeleton." + name + " {"), name);
    assert.ok(!new RegExp("(^|[\\s,}])\\." + name + " \\{").test(styles), name + " must not size a loaded label");
  }
});

it("clears the session title skeleton once the name arrives", () => {
  const clear = script.slice(script.indexOf("function clearSkeletonState("), script.indexOf("window.addEventListener('message', event => handleBackendMessage"));
  assert.ok(clear.includes("'skeleton-session'"), clear);
});

it("puts a suggestion's question on its own row with the options below", () => {
  const block = (selector: string) => {
    const start = styles.indexOf(selector + " {");
    assert.ok(start >= 0, selector);
    return styles.slice(start, styles.indexOf("}", start));
  };
  assert.match(block(".next-step-card.has-choices"), /flex-direction: column/);
  assert.match(block(".next-step-card.has-choices .next-step-title"), /white-space: normal/);
  assert.match(block(".next-step-card.has-choices .next-step-actions"), /margin-left: 0/);
});
