import { it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    Uri: { joinPath: (...parts: any[]) => ({ fsPath: parts.map(p => typeof p === "object" ? p.fsPath : String(p)).join("/") }) },
  };
  return originalRequire.apply(this, arguments);
};
const { getWaterfallHtml } = require("../src/providers/waterfall/waterfallHtml.js");
Module.prototype.require = originalRequire;

function element(id = ""): any {
  const classes = new Set<string>();
  let text = "";
  const listeners: Record<string, (event?: unknown) => void> = {};
  const el: any = {
    listeners,
    id, dataset: {}, style: {}, children: [],
    classList: {
      add: (...c: string[]) => c.forEach(x => classes.add(x)),
      remove: (...c: string[]) => c.forEach(x => classes.delete(x)),
      toggle: (c: string, force?: boolean) => ((force ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)),
      contains: (c: string) => classes.has(c),
    },
    get innerHTML() { return text; },
    set innerHTML(value: string) { text = String(value); },
    get textContent() { return text; },
    set textContent(value: string) { text = String(value); },
    addEventListener: (type: string, cb: (event?: unknown) => void) => { listeners[type] = cb; }, removeEventListener: () => {},
    setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {},
    appendChild: (child: any) => child, insertBefore: (child: any) => child, removeChild: (child: any) => child, remove: () => {},
    querySelector: () => element(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    scrollTo: () => {},
  };
  return el;
}

function loadWaterfall() {
  const html: string = getWaterfallHtml({ cspSource: "vscode-webview:", asWebviewUri: (u: any) => String(u.fsPath || u) }, "sess", "Session");
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const byId = new Map<string, any>();
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const posted: any[] = [];
  const sandbox: any = {
    window: { addEventListener: (type: string, cb: any) => { if (type === "message") listeners.push(cb); }, removeEventListener: () => {}, postMessage: () => {} },
    document: {
      getElementById: (id: string) => { if (!byId.has(id)) byId.set(id, element(id)); return byId.get(id); },
      createElement: () => element(), createTextNode: () => element(),
      querySelector: () => element(), querySelectorAll: () => [],
      addEventListener: () => {}, removeEventListener: () => {}, body: element(),
    },
    acquireVsCodeApi: () => ({ postMessage: (msg: unknown) => posted.push(msg), getState: () => ({}), setState: () => {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    marked: { parse: (s: string) => s, use: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(script!, sandbox);
  return {
    send: (data: Record<string, unknown>) => listeners.forEach(cb => cb({ data })),
    tokens: () => byId.get("wf-total-tokens")?.textContent,
    byId: (id: string) => byId.get(id),
    exportData: () => {
      byId.get("btn-export").listeners.click();
      return JSON.parse(JSON.stringify(posted.filter(m => m.type === "export_waterfall").at(-1).data));
    },
  };
}

const llmCall = (turnId: string, total: number, ts: number) => [
  { type: "waterfall_llm_start", turn_id: turnId, model: "auto", ts },
  { type: "waterfall_llm_end", turn_id: turnId, duration_ms: 1000, ttfb_ms: 200, prompt_tokens: total - 100, completion_tokens: 100, total_tokens: total, ts: ts + 1 },
];

it("counts tokens from live LLM calls in the waterfall total", () => {
  const wf = loadWaterfall();
  for (const msg of [...llmCall("a", 12850, 1000), ...llmCall("b", 4000, 1010)]) wf.send(msg);
  assert.equal(wf.tokens(), (16850).toLocaleString());
});

it("adds live calls on top of the history total without double counting a later history load", () => {
  const wf = loadWaterfall();
  const history = (tokenTotal: number, users: number) => ({
    type: "session_history",
    session: {
      id: "sess", status: "running", model: "auto", provider: "andromity", token_total: tokenTotal, context_tokens: 0,
      messages: Array.from({ length: users }, (_, i) => [
        { role: "user", content: "q" + i, ts: "2026-10-15T00:0" + i + ":00Z" },
        { role: "assistant", content: "a" + i, duration: 1, ts: "2026-10-15T00:0" + i + ":02Z" },
      ]).flat(),
    },
  });
  wf.send(history(15420, 2));
  assert.equal(wf.tokens(), (15420).toLocaleString());
  for (const msg of llmCall("live", 12850, Date.parse("2026-10-15T00:05:00Z") / 1000)) wf.send(msg);
  assert.equal(wf.tokens(), (28270).toLocaleString());
  wf.send(history(28270, 3));
  assert.equal(wf.tokens(), (28270).toLocaleString());
});

const bgStart = (toolId: string, processId: string, ts: number) => ({
  type: "tool_start", tool_id: toolId, tool_name: "shell_bg", args: JSON.stringify({ command: "x", process_id: processId }), ts,
});

it("keeps a background command that failed at startup failed when its result arrives after the exit", () => {
  const wf = loadWaterfall();
  wf.send(bgStart("t1", "ticker", 1000));
  wf.send({ type: "process_started", process_id: "ticker", pid: 1 });
  wf.send({ type: "process_exited", process_id: "ticker", exit_code: 1, duration: 0.6 });
  wf.send({ type: "tool_result", tool_id: "t1", tool_name: "shell_bg", success: true, ts: 1000.6,
    result: "Background process started with id 'ticker' (PID 1), but it exited after 0.6s with code 1, so nothing is running in the background." });
  assert.equal(wf.byId("wf-bar-t1").classList.contains("running"), false);
});

it("keeps a renamed background process running until its own exit", () => {
  const wf = loadWaterfall();
  wf.send(bgStart("t2", "ticker", 2000));
  wf.send({ type: "process_started", process_id: "ticker-b198", pid: 2 });
  wf.send({ type: "tool_result", tool_id: "t2", tool_name: "shell_bg", success: true, ts: 2002,
    result: "Background process started with id 'ticker-b198' (PID 2).\nUse shell_read('ticker-b198') to see live output." });
  assert.equal(wf.byId("wf-bar-t2").classList.contains("running"), true);
  wf.send({ type: "process_exited", process_id: "ticker-b198", exit_code: 0, duration: 60 });
  assert.equal(wf.byId("wf-bar-t2").classList.contains("running"), false);
});

it("exports prompt and completion totals and keeps the part without a split as history tokens", () => {
  const wf = loadWaterfall();
  const history = {
    type: "session_history",
    session: { id: "sess", status: "idle", model: "auto", provider: "andromity", token_total: 1000, context_tokens: 400,
      messages: [{ role: "user", content: "q", ts: "2026-10-15T00:00:00Z" }, { role: "assistant", content: "a", duration: 1, ts: "2026-10-15T00:00:02Z" }] },
  };
  wf.send(history);
  for (const msg of [...llmCall("a", 300, 2000), ...llmCall("b", 500, 2010)]) wf.send(msg);
  const data = wf.exportData();
  assert.deepEqual(
    [data.totals.promptTokens, data.totals.completionTokens, data.totals.historyTokens, data.totals.totalTokens],
    [600, 200, 1000, 1800],
  );
  const live = data.turns.flatMap((t: any) => t.spans).filter((s: any) => s.tokens === 300);
  assert.deepEqual([live[0].promptTokens, live[0].completionTokens], [200, 100]);
});

it("starts a new turn when a message sent during a turn is applied", () => {
  const wf = loadWaterfall();
  wf.send({ type: "agent_started", prompt: "Explain the architecture", ts: 1000 });
  for (const msg of llmCall("a", 300, 1001)) wf.send(msg);
  wf.send({ type: "input_applied", prompt: "what is good about this", turn_index: 1, ts: 1005 });
  for (const msg of llmCall("b", 500, 1006)) wf.send(msg);
  wf.send({ type: "agent_done", ts: 1010 });
  const turns = wf.exportData().turns;
  assert.deepEqual(turns.map((t: any) => t.query), ["Explain the architecture", "what is good about this"]);
  assert.deepEqual(turns.map((t: any) => t.spans.map((s: any) => s.tokens)), [[300], [500]]);
  assert.equal(turns[0].durationMs, 5000);
  assert.equal(turns[1].durationMs, 5000);
});
