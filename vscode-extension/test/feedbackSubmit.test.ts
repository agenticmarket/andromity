import { it } from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_ENDPOINT,
  MAX_FEEDBACK_LENGTH,
  feedbackPayload,
  osFamily,
  submitFeedback,
  validateFeedback,
} from "../src/engagement/feedbackSubmit.js";

it("maps Node platforms to the OS families the worker accepts", () => {
  assert.equal(osFamily("win32"), "windows");
  assert.equal(osFamily("darwin"), "darwin");
  assert.equal(osFamily("linux"), "linux");
  assert.equal(osFamily("freebsd"), "unknown");
});

it("rejects notes over the length limit and accepts the rest", () => {
  assert.equal(validateFeedback("Great tool"), null);
  assert.equal(validateFeedback("x".repeat(MAX_FEEDBACK_LENGTH)), null);
  assert.match(validateFeedback("x".repeat(MAX_FEEDBACK_LENGTH + 1)) || "", /under 2000 characters/);
});

it("sends only the note, client, OS family and version", async () => {
  let sent: { url: string; body: unknown } | null = null;
  const ok = await submitFeedback(feedbackPayload("  Needs dark mode in the plan view  ", "0.2.23", "win32"), async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true };
  });
  assert.equal(ok, true);
  assert.deepEqual(sent, {
    url: FEEDBACK_ENDPOINT,
    body: { message: "Needs dark mode in the plan view", client: "vscode", os: "windows", version: "0.2.23" },
  });
});

it("reports failure for error responses and network errors", async () => {
  const payload = feedbackPayload("note", "0.2.23", "linux");
  assert.equal(await submitFeedback(payload, async () => ({ ok: false })), false);
  assert.equal(await submitFeedback(payload, async () => { throw new Error("offline"); }), false);
});
