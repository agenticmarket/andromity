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
  const el: any = {
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
    addEventListener: () => {}, removeEventListener: () => {},
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
  const sandbox: any = {
    window: { addEventListener: (type: string, cb: any) => { if (type === "message") listeners.push(cb); }, removeEventListener: () => {}, postMessage: () => {} },
    document: {
      getElementById: (id: string) => { if (!byId.has(id)) byId.set(id, element(id)); return byId.get(id); },
      createElement: () => element(), createTextNode: () => element(),
      querySelector: () => element(), querySelectorAll: () => [],
      addEventListener: () => {}, removeEventListener: () => {}, body: element(),
    },
    acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} }),
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
