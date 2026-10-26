import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { element, loadChat } from "./helpers/chatHarness.js";

describe("recent sessions on the home screen", () => {
  function render(sessions: any[]) {
    const section = element({ style: { display: "" } });
    const list = element();
    const chat = loadChat({
      state: { currentSessionId: "current" },
      elements: { "recent-sessions-section": section, "recent-sessions-list": list },
    });
    chat.eval("currentSessionId = 'current'");
    chat.sandbox.__sessions = sessions;
    chat.eval("renderHomeRecentSessions(__sessions)");
    return { section, html: String(list.innerHTML || "") };
  }

  it("leaves out sessions that hold only the system prompt", () => {
    const { section, html } = render([
      { id: "a", name: "new-session", message_count: 1, conversation_count: 0 },
      { id: "b", name: "Fix the login bug", message_count: 5, conversation_count: 4, updated_at: new Date().toISOString() },
    ]);
    assert.equal(section.style.display, "flex");
    assert.ok(html.includes("Fix the login bug"));
    assert.ok(!html.includes('data-session-id="a"'));
    assert.ok(html.includes("4 msgs"), "counts the conversation, not the system prompt");
  });

  it("hides the section when every past session is empty, and falls back for older servers", () => {
    assert.equal(render([{ id: "a", name: "x", message_count: 1, conversation_count: 0 }]).section.style.display, "none");
    const older = render([{ id: "b", name: "Older server", message_count: 3 }]);
    assert.ok(older.html.includes("3 msgs"));
  });
});
