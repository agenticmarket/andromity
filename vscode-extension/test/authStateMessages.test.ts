import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { element, loadChat } from "./helpers/chatHarness.js";

function chatWithAuthTargets() {
  const appended: unknown[] = [];
  const signIn = element({ tagName: "BUTTON" });
  const badge = element();
  const sub = element();
  const chat = loadChat({
    storage: {},
    elements: {
      "chat-messages": element({ appendChild: (node: unknown) => { appended.push(node); return node; } }),
      "zero-gateway-signin-btn": signIn,
      "zero-gateway-active-badge": badge,
      "zero-gateway-sub": sub,
    },
  });
  return { chat, appended, signIn, badge, sub };
}

describe("auth_state_changed", () => {
  it("applies the initial state without throwing or posting a sign-in note", () => {
    const { chat, appended, signIn, badge } = chatWithAuthTargets();
    chat.post({ type: "auth_state_changed", isAuthenticated: false, plan: "anonymous", username: "Anonymous" });
    assert.equal(signIn.style.display, "inline-flex");
    assert.equal(badge.style.display, "none");
    assert.equal(appended.length, 0, "the state the page starts with is not news");
    assert.equal(chat.posted.filter(m => m.type === "webview_error").length, 0);
  });

  it("notes a sign-in once, and only when the state actually changes", () => {
    const { chat, appended, signIn, badge } = chatWithAuthTargets();
    chat.post({ type: "auth_state_changed", isAuthenticated: false });
    chat.post({ type: "auth_state_changed", isAuthenticated: true, username: "dev" });
    assert.equal(signIn.style.display, "none");
    assert.equal(badge.style.display, "inline-flex");
    assert.equal(appended.length, 1);
    chat.post({ type: "auth_state_changed", isAuthenticated: true, username: "dev" });
    assert.equal(appended.length, 1, "a repeated broadcast of the same state adds nothing");
    chat.post({ type: "auth_state_changed", isAuthenticated: false });
    assert.equal(signIn.style.display, "inline-flex");
    assert.equal(appended.length, 2);
  });
});
