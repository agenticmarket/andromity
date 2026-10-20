import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
const vscodeMock: any = {
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: "D:/work/repo" } }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  window: { activeTextEditor: undefined, visibleTextEditors: [] },
  commands: { executeCommand: async () => {} },
  extensions: { getExtension: () => undefined },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? vscodeMock : originalRequire.apply(this, arguments as any);
};
const { handleInputMessage } = require("../src/server/inputBridge.js");
const { SCHEDULED_RUN_BUSY_TEXT } = require("../src/cronNotifications.js");
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
Module.prototype.require = originalRequire;

const DAEMON_BUSY = "This scheduled run is still in progress. You can continue the chat when it finishes.";

function loadNotice() {
  const script: string = getChatClientScript("icon.svg", {} as any);
  const start = script.indexOf("    function updateScheduledRunNotice(info, running) {");
  const end = script.indexOf("    function appendSystemNote(text) {", start);
  assert.ok(start > 0 && end > start, "notice function present");
  const inserted: any[] = [];
  const promptBox = { parentNode: { insertBefore: (el: any) => { inserted.push(el); } } };
  const byId: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (byId[id] && !byId[id].removed ? byId[id] : null),
    querySelector: (sel: string) => (sel === ".prompt-box" ? promptBox : null),
    createElement: () => {
      const el: any = {
        textContent: "", className: "", removed: false, attrs: {} as Record<string, string>,
        classes: new Set<string>(),
        setAttribute(k: string, v: string) { el.attrs[k] = v; },
        remove() { el.removed = true; },
        classList: { toggle(name: string, on: boolean) { if (on) el.classes.add(name); else el.classes.delete(name); } },
      };
      Object.defineProperty(el, "id", { set(v: string) { byId[v] = el; el._id = v; }, get() { return el._id; } });
      return el;
    },
  };
  const context: any = { document };
  vm.runInNewContext(script.slice(start, end) + "\nthis.update = updateScheduledRunNotice;", context);
  return { update: context.update, inserted, byId };
}

describe("scheduled run chat", () => {
  it("shows the job and its real mode while running, then how to continue", () => {
    const { update, inserted, byId } = loadNotice();
    const info = { job_id: "a1", job_name: "hii", mode: "safe", running: true };
    update(info, true);
    assert.equal(inserted.length, 1);
    const el = byId["scheduled-run-notice"];
    assert.ok(el.textContent.includes("hii") && el.textContent.includes("SAFE"));
    assert.ok(el.textContent.includes("still in progress"));
    assert.ok(el.classes.has("running"));
    assert.equal(el.attrs.role, "status");

    update(info, false);
    assert.equal(inserted.length, 1, "the notice is reused, not duplicated");
    assert.ok(el.textContent.includes("ran in SAFE mode"));
    assert.ok(el.textContent.includes("your own permission mode"));
    assert.ok(!el.classes.has("running"));

    update(null, false);
    assert.equal(el.removed, true, "normal chats have no notice");
  });

  it("explains a refused message instead of a generic failure", async () => {
    const posts: any[] = [];
    const rpc: any = { call: async () => { throw new Error(DAEMON_BUSY); } };
    await handleInputMessage(rpc, { type: "submit_input", prompt: "hello?", requestId: "r1" } as any, "cron-a1-1", (m: any) => posts.push(m), "safe");
    const rejected = posts.find((p) => p.type === "input_rejected");
    assert.equal(rejected.error, SCHEDULED_RUN_BUSY_TEXT);
    assert.equal(rejected.request_id, "r1");
  });

  it("keeps the generic message for other failures", async () => {
    const posts: any[] = [];
    const rpc: any = { call: async () => { throw new Error("socket hang up"); } };
    await handleInputMessage(rpc, { type: "submit_input", prompt: "hello?", requestId: "r2" } as any, "s1", (m: any) => posts.push(m), "safe");
    assert.ok(posts.find((p) => p.type === "input_rejected").error.includes("Your draft is preserved"));
  });

  it("wires the notice into session load and every finish signal", () => {
    const script: string = getChatClientScript("icon.svg", {} as any);
    assert.ok(script.includes("sessionsState[currentSessionId].scheduledRun = (msg.session && msg.session.scheduled_run) || null;"));
    const calls = script.split("updateScheduledRunNotice(").length - 1;
    assert.ok(calls >= 5, "declared once, called on load, done, cancelled and error");
    assert.ok(script.includes("if (msg.scheduled_busy) {"));
    new vm.Script(script, { filename: "chatClientScript.js" });
  });
});
