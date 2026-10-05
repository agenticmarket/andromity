import { it } from "node:test";
import assert from "node:assert/strict";
import { SessionHydration } from "../src/server/sessionHydration.js";
import { handleInteractionMessage, reportDisconnectedAction } from "../src/server/interactionBridge.js";
import { RpcClient } from "../src/server/RpcClient.js";
import { SessionWebviewEvent } from "../src/server/types.js";

it("hydrates an atomic snapshot then replays newer resolutions without crossing sessions", () => {
  const hydration = new SessionHydration();
  const version = hydration.begin("a");
  assert.equal(hydration.capture({ type: "ask_questions", session_id: "a", event_seq: 5 }), true);
  assert.equal(hydration.capture({ type: "interaction_resolved", session_id: "a", event_seq: 7 }), true);
  assert.equal(hydration.capture({ type: "process_started", session_id: "b", event_seq: 9 }), false);
  const posts: SessionWebviewEvent[] = [];
  hydration.finish(version, 6, event => posts.push(event));
  assert.deepEqual(posts.map(event => event.type), ["interaction_resolved"]);
  assert.equal(hydration.capture({ type: "text_delta", session_id: "a", event_seq: 8 }), false);
});

it("a slow session load cannot replace a more recent selection", () => {
  const hydration = new SessionHydration();
  const old = hydration.begin("a");
  const current = hydration.begin("b");
  const posts: SessionWebviewEvent[] = [];
  hydration.capture({ type: "process_exited", session_id: "b", event_seq: 5 });
  hydration.finish(old, 0, event => posts.push(event));
  assert.equal(posts.length, 0);
  hydration.finish(current, 3, event => posts.push(event));
  assert.equal(posts[0].type, "process_exited");
});

it("scoped approvals and question answers use the same transport in both surfaces", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = { call: async (method: string, params: unknown) => { calls.push({ method, params }); return { success: true }; } } as unknown as RpcClient;
  const posts: SessionWebviewEvent[] = [];
  await handleInteractionMessage(rpc, { type: "approve_tool", approvalId: "p", scope: "session" }, "tab", event => posts.push(event));
  await handleInteractionMessage(rpc, { type: "answer_question", questionId: "q", answers: "Python" }, "tab", event => posts.push(event));
  assert.deepEqual(calls, [
    { method: "agent.approve_tool", params: { session_id: "tab", approval_id: "p", approved: true, scope: "session" } },
    { method: "agent.answer_question", params: { session_id: "tab", question_id: "q", answers: "Python" } },
  ]);
  assert.deepEqual(posts.map(event => event.interaction_id), ["p", "q"]);
});

it("an uncertain response leaves the pending card and draft available to retry", async () => {
  const rpc = { call: async () => { throw new Error("sensitive downstream details"); } } as unknown as RpcClient;
  const posts: SessionWebviewEvent[] = [];
  await handleInteractionMessage(rpc, { type: "answer_question", questionId: "q", answers: "draft" }, "a", event => posts.push(event));
  assert.equal(posts[0].type, "interaction_failed");
  assert.equal(JSON.stringify(posts).includes("sensitive"), false);
  assert.equal(posts.some(event => event.type === "interaction_resolved"), false);
});

it("offline responses unlock pending interaction and composer controls", () => {
  const posts: SessionWebviewEvent[] = [];
  reportDisconnectedAction({ type: "answer_question" }, "a", event => posts.push(event));
  reportDisconnectedAction({ type: "submit_input", requestId: "request" }, "a", event => posts.push(event));
  assert.deepEqual(posts.map(event => event.type), ["interaction_failed", "input_rejected"]);
  assert.equal(posts[1].request_id, "request");
});
