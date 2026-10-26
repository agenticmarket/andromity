import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { checkSessionForNavigation } from "../src/sessionNavigation.js";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

const rpcWith = (ids: string[] | Error) => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (ids instanceof Error) throw ids;
    return ids.map((id) => ({ id })) as T;
  },
});

it("allows a session that still exists and reports a deleted one as missing", async () => {
  const rpc = rpcWith(["a", "b"]);
  assert.deepEqual(await checkSessionForNavigation(rpc, "b", "/repo"), { type: "session_nav_result", sessionId: "b", status: "ok" });
  assert.deepEqual(await checkSessionForNavigation(rpc, "gone", "/repo"), { type: "session_nav_result", sessionId: "gone", status: "missing" });
  assert.deepEqual(rpc.calls[0], { method: "session.list", params: { project_path: "/repo", include_subagents: true } });
});

it("reports an error instead of switching when the check cannot run", async () => {
  assert.equal((await checkSessionForNavigation(rpcWith(new Error("offline")), "a", "/repo")).status, "error");
  assert.equal((await checkSessionForNavigation(null, "a", "/repo")).status, "error");
  assert.equal((await checkSessionForNavigation(rpcWith(["a"]), 42, "/repo")).status, "error");
});

function navHarness(initialSession: string) {
  const script = getChatClientScript("icon.svg", { currentSessionId: initialSession, currentModel: "m",
    currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" });
  const block = script.slice(script.indexOf("    // Back and forward through the sessions"), script.indexOf("    const feedbackDockBtn ="));
  const buttons = new Map<string, any>();
  for (const id of ["btn-session-back", "btn-session-forward"]) {
    const listeners: Record<string, () => void> = {};
    buttons.set(id, { disabled: true, listeners, addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; } });
  }
  let keydown: (event: any) => void = () => {};
  const posted: any[] = [];
  const notes: string[] = [];
  const context = vm.createContext({
    currentSessionId: initialSession,
    document: { getElementById: (id: string) => buttons.get(id), addEventListener: (_type: string, fn: (event: any) => void) => { keydown = fn; } },
    vscode: { postMessage: (msg: unknown) => posted.push(msg) },
    appendSystemNote: (text: string) => notes.push(text),
  });
  vm.runInContext(block + "\nthis.api = { noteSessionShown, handleSessionNavResult, clearSessionNavPending, sessionHistory };", context);
  const api = (context as any).api;
  const back = buttons.get("btn-session-back");
  const forward = buttons.get("btn-session-forward");
  return {
    api, back, forward, posted, notes,
    show: (id: string) => api.noteSessionShown(id),
    press: (key: string, target: any = { tagName: "DIV" }) => {
      let prevented = false;
      keydown({ key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, target, preventDefault: () => { prevented = true; } });
      return prevented;
    },
    entries: () => JSON.parse(JSON.stringify(api.sessionHistory.entries)),
  };
}

it("goes back and forward like a browser and mutes the buttons at either end", () => {
  const h = navHarness("a");
  assert.equal(h.back.disabled, true);
  assert.equal(h.forward.disabled, true);
  h.show("b");
  h.show("c");
  assert.equal(h.back.disabled, false);
  assert.equal(h.forward.disabled, true);

  h.back.listeners.click();
  assert.equal(JSON.stringify(h.posted.at(-1)), JSON.stringify({ type: "navigate_session", sessionId: "b" }));
  assert.equal(h.back.disabled, true, "buttons wait while the switch is checked");
  h.api.handleSessionNavResult({ type: "session_nav_result", sessionId: "b", status: "ok" });
  h.show("b");
  assert.equal(h.back.disabled, false);
  assert.equal(h.forward.disabled, false);

  h.forward.listeners.click();
  h.show("c");
  assert.equal(h.forward.disabled, true);
  assert.deepEqual(h.entries(), ["a", "b", "c"]);
});

it("drops forward history when a new session is opened after going back", () => {
  const h = navHarness("a");
  h.show("b");
  h.back.listeners.click();
  h.show("a");
  h.show("d");
  assert.deepEqual(h.entries(), ["a", "d"]);
  assert.equal(h.forward.disabled, true);
});

it("says a deleted session was not found and removes it from the history", () => {
  const h = navHarness("a");
  h.show("gone");
  h.show("c");
  h.back.listeners.click();
  h.api.handleSessionNavResult({ type: "session_nav_result", sessionId: "gone", status: "missing" });
  assert.deepEqual(h.notes, ["Session not found. It may have been deleted."]);
  assert.deepEqual(h.entries(), ["a", "c"]);
  assert.equal(h.api.sessionHistory.index, 1);
  assert.equal(h.back.disabled, false, "the session before it is still reachable");
});

it("shows a connection error without changing the history, and recovers when a load fails", () => {
  const h = navHarness("a");
  h.show("b");
  h.back.listeners.click();
  h.api.handleSessionNavResult({ type: "session_nav_result", sessionId: "a", status: "error" });
  assert.deepEqual(h.notes, ["Could not open that session. Reconnect and try again."]);
  assert.deepEqual(h.entries(), ["a", "b"]);
  assert.equal(h.back.disabled, false);

  h.back.listeners.click();
  h.api.handleSessionNavResult({ type: "session_nav_result", sessionId: "a", status: "ok" });
  h.api.clearSessionNavPending("a");
  assert.equal(h.back.disabled, false, "a failed load releases the buttons");
});

it("supports Alt+Left and Alt+Right outside text fields", () => {
  const h = navHarness("a");
  h.show("b");
  assert.equal(h.press("ArrowLeft", { tagName: "TEXTAREA" }), false, "typing keeps Alt+Left");
  assert.equal(h.posted.length, 0);
  assert.equal(h.press("ArrowLeft"), true);
  assert.equal(JSON.stringify(h.posted.at(-1)), JSON.stringify({ type: "navigate_session", sessionId: "a" }));
});
