/**
 * Feature tips end to end without VS Code: the webview reports what a turn did,
 * the controller picks and remembers tips, and the card's buttons report back.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

let tipsEnabled = true;
const configUpdates: Array<[string, unknown]> = [];
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") {
    return {
      workspace: {
        getConfiguration: () => ({
          get: (_key: string, fallback: unknown) => (tipsEnabled ? fallback : false),
          update: async (key: string, value: unknown) => { configUpdates.push([key, value]); },
        }),
      },
      ConfigurationTarget: { Global: 1 },
    };
  }
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
const { getChatStyles } = require("../src/providers/chatview/chatStyles.js");
const { FeatureTipsController } = require("../src/engagement/featureTipsController.js");
const { recordFeatureUse } = require("../src/telemetry/featureUsage.js");
Module.prototype.require = originalRequire;

const script: string = getChatClientScript("icon.svg", {
  currentSessionId: "s1", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
}).replace(/\r\n/g, "\n");

function section(): string {
  const start = script.indexOf("// ── Feature tips");
  const end = script.indexOf("// ── End feature tips");
  assert.ok(start > -1 && end > start, "feature tips section must exist");
  return script.slice(start, end);
}

function node(classes: string[] = [], inner: any[] = []): any {
  return {
    matches: (sel: string) => sel.split(",").some((s) => classes.includes(s.trim().replace(/^\./, ""))),
    querySelectorAll: () => inner,
    nextElementSibling: null,
  };
}

function load() {
  let card: any = null;
  const chat: any = {
    appendChild: (child: any) => { card = child; child.removed = false; child.remove = () => { child.removed = true; }; return child; },
    querySelectorAll: () => chat.prompts,
    prompts: [] as any[],
  };
  const sandbox: any = {
    posted: [] as any[],
    currentSessionId: "s1",
    sessionsState: { s1: {} },
    turnEditedFiles: new Set<string>(),
    chatContainer: chat,
    escapeHtml: (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    scrollToBottomIfNeeded() {},
    document: {
      getElementById: (id: string) => (id === "feature-tip-card" && card && !card.removed ? card : null),
      createElement: () => ({ dataset: {}, setAttribute() {}, innerHTML: "" }),
      addEventListener() {},
    },
  };
  sandbox.vscode = { postMessage: (m: any) => sandbox.posted.push(m) };
  vm.createContext(sandbox);
  vm.runInContext(section(), sandbox);
  return { sandbox, chat, card: () => (card && !card.removed ? card : null), run: (code: string) => vm.runInContext(code, sandbox) };
}

function memento() {
  const store = new Map<string, unknown>();
  return { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => { store.set(k, v); } };
}

describe("Feature tips in the chat", () => {
  it("reports what the finished turn did", () => {
    const rt = load();
    const prompt = node(["message-wrap"]);
    const reply = node([], [{}, {}, {}]);
    const activity = node(["activity-row", "activity-row-command"]);
    prompt.nextElementSibling = reply;
    reply.nextElementSibling = activity;
    rt.chat.prompts = [prompt];
    rt.sandbox.turnEditedFiles.add("src/limiter.ts");
    rt.sandbox.turnEditedFiles.add("src/store.ts");
    const facts = JSON.parse(JSON.stringify(rt.run("finishedTurnFacts({ session_id: 's1' })")));
    assert.deepEqual(facts, { type: "turn_finished", sessionId: "s1", editedFiles: ["src/limiter.ts", "src/store.ts"], toolCalls: 4, shellCommands: 4, scheduled: false });
    rt.chat.prompts = [];
    assert.equal(rt.run("finishedTurnFacts({})"), null, "nothing to report without a prompt");
  });

  it("draws one card with the tip, its action and a dismiss menu", () => {
    const rt = load();
    rt.run("renderFeatureTip('fingerprint', '')");
    const html = rt.card().innerHTML;
    assert.ok(html.includes("Did you know") && html.includes("<strong>Fingerprint</strong>"));
    assert.ok(html.includes('data-action="feature-tip-run">Open Fingerprint<'));
    assert.ok(html.includes('data-action="feature-tip-hide"') && html.includes('data-action="feature-tip-off"'));
    rt.run("renderFeatureTip('inline_edit', 'src/a<b>.ts')");
    assert.ok(rt.card().innerHTML.includes(">Open a&lt;b>.ts<"), "the file name is escaped");
    rt.run("renderFeatureTip('generate_tests', 'src/limiter.ts')");
    assert.ok(rt.card().innerHTML.includes(">Write tests for limiter.ts<"));
    for (const id of ["fix_terminal_error", "air_gap", "mcp_servers"]) {
      rt.run("renderFeatureTip(" + JSON.stringify(id) + ", '')");
      assert.ok(rt.card().innerHTML.includes('data-action="feature-tip-run"'), id + " has an action");
    }
    rt.run("renderFeatureTip('inline_edit', 'src/a<b>.ts')");
    rt.run("renderFeatureTip('waterfall', '')");
    assert.ok(rt.card().innerHTML.includes("edit it in place"), "an unknown tip leaves the current card alone");
  });

  it("sends the click to the extension and removes the card", () => {
    const rt = load();
    rt.run("renderFeatureTip('cron_jobs', '')");
    rt.run("featureTipAction('feature-tip-run')");
    assert.equal(rt.card(), null);
    assert.deepEqual(JSON.parse(JSON.stringify(rt.sandbox.posted.at(-1))), { type: "feature_tip_run", tip: "cron_jobs", file: "" });
    rt.run("renderFeatureTip('fingerprint', '')");
    rt.run("featureTipAction('feature-tip-off')");
    assert.deepEqual(JSON.parse(JSON.stringify(rt.sandbox.posted.at(-1))), { type: "feature_tip_off" });
  });

  it("clears the tip when the next turn starts and keeps it under the next-step card", () => {
    const start = script.slice(script.indexOf("function startAssistantTurn("), script.indexOf("function startAssistantTurn(") + 200);
    assert.ok(start.includes("removeFeatureTip()"));
    const render = script.slice(script.indexOf("function renderNextStep("), script.indexOf("function runNextStep("));
    assert.ok(render.includes("chatContainer.insertBefore(card, tipCard)"));
    const done = script.slice(script.indexOf("case 'agent_done': {"), script.indexOf("case 'agent_cancelled': {"));
    assert.ok(done.indexOf("finishedTurnFacts(msg)") < done.indexOf("endAssistantTurn()"), "facts are read before the turn state is cleared");
    assert.ok(getChatStyles().includes(".feature-tip-card {"));
  });
});

describe("Feature tips controller", () => {
  const facts = (sessionId: string) => ({
    sessionId, filesEdited: 3, sourceFilesEdited: 2, testFilesEdited: 1, toolCalls: 6, shellCommands: 0,
    inGitRepo: true, scheduled: false, localModel: false, airGapOn: false, mcpServers: -1,
  });

  it("shows the early tip from the first session and remembers what it showed", async () => {
    tipsEnabled = true;
    const tips = new FeatureTipsController(memento());
    assert.equal(await tips.onTurnFinished(facts("a")), "fingerprint");
    assert.equal(await tips.onTurnFinished(facts("b")), null, "one tip a day");
    tips.dispose();
  });

  it("retires a tip when its feature is used anywhere, telemetry or not", async () => {
    tipsEnabled = true;
    const store = memento();
    const tips = new FeatureTipsController(store);
    recordFeatureUse("fingerprint");
    await tips.onTurnFinished(facts("a"));
    await tips.onTurnFinished(facts("b"));
    assert.equal(await tips.onTurnFinished(facts("c")), "commit_message");
    tips.dispose();
  });

  it("shows nothing when tips are turned off, and Don't show tips turns them off", async () => {
    tipsEnabled = false;
    const tips = new FeatureTipsController(memento());
    for (const s of ["a", "b", "c"]) assert.equal(await tips.onTurnFinished(facts(s)), null);
    await tips.turnOff();
    assert.deepEqual(configUpdates.at(-1), ["featureTips", false]);
    tips.dispose();
    tipsEnabled = true;
  });
});
