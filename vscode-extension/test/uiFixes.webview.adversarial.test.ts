import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { readFileSync } from "node:fs";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import { MiniDocument, dangerousNodes } from "./helpers/miniDom.js";
import { element, loadChat } from "./helpers/chatHarness.js";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  return name === "vscode" ? { Uri: { joinPath: (...parts: unknown[]) => ({ fsPath: parts.join("/") }), file: (fsPath: string) => ({ fsPath }) }, workspace: {}, window: {}, commands: {} } : originalRequire.apply(this, arguments);
};
const { getChatViewHtml } = require("../src/providers/chatview/chatHtml.js");
Module.prototype.require = originalRequire;

function richEl(base: Record<string, any> = {}): any {
  const el: any = element({ style: { setProperty() {}, display: "" }, textContent: "", ...base });
  const children: any[] = [];
  const assigned: string[] = [];
  Object.defineProperty(el, "children", { get: () => children });
  Object.defineProperty(el, "innerHTML", { get: () => "", set: (value: string) => { children.length = 0; if (value) assigned.push(String(value)); } });
  el.assigned = assigned;
  el.appendChild = (child: any) => { children.push(child); return child; };
  return el;
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function state(overrides: Record<string, unknown> = {}) {
  return {
    currentSessionId: "s", currentModel: "m", currentProvider: "p",
    currentMode: "safe", currentProfile: "builder", currentReasoning: "medium", ...overrides,
  } as any;
}

describe("generated chat script still compiles and runs", () => {
  it("compiles for ordinary and hostile state values", () => {
    const hostile = ["</script><script>window.__pwn=1</script>", "'\"`\\${alert(1)}", "line\u2028sep\u2029para", "a'b\"c", "\\", "x".repeat(10000), "\u0000"];
    for (const value of ["m", ...hostile]) {
      const script = getChatClientScript(value, state({ currentModel: value, currentProvider: value, currentSessionId: value }));
      assert.doesNotThrow(() => new vm.Script(script, { filename: "chatClientScript.js" }), JSON.stringify(value).slice(0, 40));
      const html = getChatViewHtml({ cspSource: "vscode-webview:", asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || String(u)) } as any, { fsPath: "ext" } as any, state({ currentModel: value }));
      for (const match of html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)) {
        if (match[1].trim()) assert.doesNotThrow(() => new vm.Script(match[1]), "inline script");
      }
    }
  });

  it("keeps model values intact through the script's embedding (no breakout)", () => {
    for (const value of ["</script>x", "a'b", "q\"q", "\\n", "line\u2028sep"]) {
      const h = loadChat({ state: { currentModel: value, currentProvider: value } });
      assert.equal(h.eval("currentModel"), value);
      assert.equal(h.eval("currentProvider"), value);
    }
  });

  it("the apostrophes in the new copy survive into the running script", () => {
    const h = loadChat({ state: { currentModel: "m" } });
    assert.match(h.eval("turnLoaderText(31)"), /some models don't show their reasoning until they answer$/);
    const source = readFileSync("src/providers/chatview/chatClientScript.ts", "utf8");
    assert.ok(source.includes("don\\\\'t show"), "the template literal escapes the apostrophe twice, which is what produces \\' in the output");
  });
});

describe("quick model picker tooltip", () => {
  function picker(models: any[], options: { current?: [string, string]; pinned?: any[] } = {}) {
    const list = element();
    const [currentModel, currentProvider] = options.current ?? ["safe-current", "openrouter"];
    const h = loadChat({ state: { currentModel, currentProvider }, elements: { "flyout-list": list } });
    h.sandbox.__models = [{ id: "safe-current", name: "Safe Current", provider: "openrouter" }, ...models];
    h.sandbox.__pinned = options.pinned ?? [];
    h.eval("allModels = __models; pinnedModels = __pinned;");
    const render = (query = "") => {
      h.eval(`renderFlyoutList(${JSON.stringify(query)})`);
      const doc = new MiniDocument(`<div id="root">${list.innerHTML}</div>`);
      return { doc, html: list.innerHTML as string, items: doc.querySelectorAll(".flyout-item") };
    };
    return { render, h };
  }

  const expectedTitle = (m: any) => `${m.name || m.id} (${m.provider || "openrouter"} · ${m.id})${m.pricing ? " · " + m.pricing : ""}`;

  it("shows name (provider · id) · pricing on every row", () => {
    const models = [
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", pricing: "$1/M" },
      { id: "vendor/free", name: "Vendor: Free (free)", provider: "openrouter", pricing: "Free" },
    ];
    const view = picker(models).render();
    const titles = view.items.map((i) => i.getAttribute("title"));
    assert.ok(titles.includes(expectedTitle(models[0])));
    assert.ok(titles.includes(expectedTitle(models[1])));
    assert.ok(view.items.every((i) => i.hasAttribute("title")));
  });

  it("keeps hostile names, ids, providers and prices out of the markup and in the title exactly", () => {
    const bad = [
      "\"><img src=x onerror=window.__pwn=1>", "' onmouseover='window.__pwn=2", "a<b>c&d&amp;e&lt;f", "line1\nline2\r\nline3", "tab\tsep",
      "</div><script>window.__pwn=3</script>", "x\" title=\"spoofed\" data-model-id=\"evil", "\u202eRLO", "\u0000nul", "javascript:alert(1)",
    ];
    const models = bad.flatMap((text, i) => [
      { id: `n${i}`, name: text, provider: "p-n", pricing: "$1" },
      { id: `i${i}-${text}`, name: `id${i}`, provider: "p-i", pricing: "$1" },
      { id: `p${i}`, name: `prov${i}`, provider: text, pricing: "$1" },
      { id: `c${i}`, name: `price${i}`, provider: "p-c", pricing: text },
    ]).slice(0, 44);
    const view = picker(models).render();
    assert.deepEqual(dangerousNodes(view.doc).filter((n) => n !== "SVG"), []);
    assert.equal(view.doc.querySelectorAll("svg").length, view.doc.querySelectorAll(".flyout-pin-btn").length + view.doc.querySelectorAll(".catalog").length, "only the icons the picker draws itself");
    const byId = new Map(view.items.map((i) => [i.getAttribute("data-model-id"), i]));
    for (const m of models) {
      const item = byId.get(m.id);
      assert.ok(item, `row for ${JSON.stringify(m.id).slice(0, 60)}`);
      assert.equal(item!.getAttribute("title"), expectedTitle(m));
      assert.equal(item!.getAttribute("data-provider"), m.provider);
    }
    assert.equal(view.items.length, models.length + 1, "no extra row was injected");
    assert.ok(view.items.every((i) => [...i.attributes.keys()].every((k) => ["class", "title", "data-action", "data-model-id", "data-provider", "aria-current"].includes(k))));
  });

  it("does not choke on very long fields", () => {
    const long = "L".repeat(200000);
    const models = [{ id: "long-id", name: long, provider: "p", pricing: long }, { id: long, name: "n", provider: "p" }];
    const started = Date.now();
    const view = picker(models).render();
    assert.ok(Date.now() - started < 5000);
    const item = view.items.find((i) => i.getAttribute("data-model-id") === "long-id");
    assert.equal(item?.getAttribute("title"), expectedTitle(models[0]));
  });

  it("never prints undefined, null or [object Object] when fields are missing", () => {
    const models: any[] = [
      { id: "m-a", provider: "p" }, { id: "m-b", name: "No Provider" }, { id: "m-c", name: "E", provider: "p", pricing: "" },
      { id: "m-d", name: "Z", provider: "p", pricing: 0 }, { id: "m-e", name: "N", provider: "p", pricing: null },
      { id: "m-f", name: null, provider: "p" },
    ];
    const view = picker(models).render();
    for (const item of view.items) {
      const title = item.getAttribute("title") as string;
      assert.ok(!/undefined|null|\[object/.test(title), title);
      assert.ok(!/ · $/.test(title), `no dangling separator: ${title}`);
      assert.ok(title.length > 0);
    }
    assert.equal(view.items.find((i) => i.getAttribute("data-model-id") === "m-b")?.getAttribute("title"), "No Provider (openrouter · m-b)");
  });

  it("has the tooltip on pinned, searched, active and needs-key rows too", () => {
    const models = [
      { id: "pin-me", name: "Pinned Model", provider: "anthropic", pricing: "$3/M" },
      { id: "key-me", name: "Keyed", provider: "openai", pricing: "$5/M", needs_key: true },
      { id: "cat-me", name: "Catalog", provider: "groq", pricing: "Free", source: "catalog" },
    ];
    const { render } = picker(models, { pinned: [{ id: "pin-me", provider: "anthropic", name: "Pinned Model" }] });
    for (const query of ["", "model", "keyed", "catalog", "safe"]) {
      const view = render(query);
      assert.ok(view.items.length > 0, query);
      for (const item of view.items) assert.match(item.getAttribute("title") ?? "", /\(.+ · .+\)/, `query=${query}`);
    }
  });

  it("tooltips for the active row use the active model, even when it is not in the list", () => {
    const view = picker([], { current: ["ghost-model", "andromity"] }).render();
    const active = view.items.find((i) => i.hasAttribute("aria-current"));
    assert.match(active?.getAttribute("title") ?? "", /\(andromity · ghost-model\)$/);
  });
});

describe("turn loader text", () => {
  function turn(models: any[], currentModel = "m", currentProvider = "p") {
    const h = loadChat({ state: { currentModel, currentProvider } });
    const created: any[] = [];
    const timers: Function[] = [];
    h.sandbox.document.createElement = () => { const el = richEl(); created.push(el); return el; };
    h.sandbox.setInterval = (fn: Function) => { timers.push(fn); return timers.length; };
    h.sandbox.__models = models;
    h.eval("allModels = __models");
    const text = (elapsed: number) => h.eval(`turnLoaderText(${elapsed})`) as string;
    const start = () => {
      h.eval("startAssistantTurn()");
      const loader = created.find((e) => e.id === "turn-loading-indicator");
      return loader;
    };
    return { h, text, start, created, timers };
  }

  it("uses the model's display name and counts the seconds", () => {
    const t = turn([{ id: "m", name: "Anthropic: Claude Haiku 4.5 (free)", provider: "p" }]);
    assert.equal(t.text(0), "Claude Haiku 4.5 is thinking… 0s");
    assert.equal(t.text(7), "Claude Haiku 4.5 is thinking… 7s");
    assert.equal(t.text(29), "Claude Haiku 4.5 is thinking… 29s");
  });

  it("switches to the still-thinking note at 30 seconds and keeps it", () => {
    const t = turn([{ id: "m", name: "Claude Haiku 4.5", provider: "p" }]);
    const note = "Claude Haiku 4.5 is still thinking… ";
    assert.equal(t.text(30), note + "30s · some models don't show their reasoning until they answer");
    assert.equal(t.text(31), note + "31s · some models don't show their reasoning until they answer");
    assert.equal(t.text(3600), note + "3600s · some models don't show their reasoning until they answer");
  });

  it("falls back to the formatted id when the model is not in the list", () => {
    const t = turn([], "anthropic/claude-3.7-sonnet");
    assert.equal(t.text(1), "Claude 3.7 Sonnet is thinking… 1s");
    const plain = turn([{ id: "other", name: "Other" }], "gpt-4o");
    assert.equal(plain.text(1), "Gpt 4o is thinking… 1s".replace("Gpt", "GPT"));
  });

  it("falls back to the id when the listed model has no name", () => {
    const t = turn([{ id: "m", provider: "p" }]);
    assert.equal(t.text(2), "m is thinking… 2s");
  });

  it("does not invent a model name when none is chosen", () => {
    for (const current of ["", "Loading model...", null, undefined]) {
      const t = turn([], "m");
      t.h.sandbox.__c = current;
      t.h.eval("currentModel = __c");
      assert.equal(t.text(0), "The model is thinking… 0s", JSON.stringify(current));
      assert.equal(t.text(45), "The model is still thinking… 45s · some models don't show their reasoning until they answer");
    }
  });

  it("does not render a blank or vendor-only catalog name as the model", () => {
    for (const name of [" ", "   ", "\n", "Vendor: ", "Vendor:  (free)"]) {
      const t = turn([{ id: "real-id", name, provider: "p" }], "real-id");
      const text = t.text(0);
      assert.ok(/^[A-Za-z0-9]/.test(text) && !/^[^\s:]+:\s+is thinking/.test(text), JSON.stringify(name) + " -> " + JSON.stringify(text));
    }
  });

  it("finds the model by provider first and falls back to the id alone when that provider has no entry", () => {
    const models = [{ id: "shared", name: "One", provider: "one" }, { id: "shared", name: "Two", provider: "two" }, { id: "bare", name: "Bare" }];
    assert.equal(turn(models, "shared", "two").text(1), "Two is thinking… 1s");
    assert.equal(turn(models, "shared", "one").text(1), "One is thinking… 1s");
    assert.equal(turn(models, "shared", "three").text(1), "One is thinking… 1s");
    assert.equal(turn(models, "bare", "openrouter").text(1), "Bare is thinking… 1s");
    assert.equal(turn(models, "bare", "andromity").text(1), "Bare is thinking… 1s");
  });

  it("names the model of the provider in use when two providers share an id", () => {
    const t = turn([{ id: "shared", name: "Alpha Edition", provider: "one" }, { id: "shared", name: "Beta Edition", provider: "two" }], "shared", "two");
    assert.equal(t.text(1), "Beta Edition is thinking… 1s");
  });

  it("escapes a hostile model name in the first paint and in the ticking text", () => {
    const hostile = ["<img src=x onerror=window.__pwn=1>", "\"><script>window.__pwn=2</script>", "a&b'c\"d", "</span><b>x"];
    for (const name of hostile) {
      const t = turn([{ id: "m", name, provider: "p" }]);
      const loader = t.start();
      assert.ok(loader, "loader created");
      const doc = new MiniDocument(`<div id="root">${loader.assigned.at(-1)}</div>`);
      assert.deepEqual(dangerousNodes(doc), [], name);
      assert.ok(doc.getElementById("root")!.textContent.includes("is thinking"), name);
      assert.ok(doc.getElementById("root")!.textContent.includes(name.replace(/^[^:]{1,40}:[ ]+/, "")), `shown literally: ${name}`);
    }
  });

  it("the first paint carries the same wording as the ticking text, and the ticker follows the clock", () => {
    const t = turn([{ id: "m", name: "Model M", provider: "p" }]);
    h_assertTicks(t);
  });

  it("keeps the model name accurate if the model changes mid-turn", () => {
    const t = turn([{ id: "m", name: "First", provider: "p" }, { id: "n", name: "Second", provider: "p" }]);
    assert.equal(t.text(1), "First is thinking… 1s");
    t.h.eval("currentModel = 'n'");
    assert.equal(t.text(1), "Second is thinking… 1s");
  });

  it("a name that looks like markup is not interpreted by the tick either", () => {
    const t = turn([{ id: "m", name: "<b>bold</b>", provider: "p" }]);
    const loader = t.start();
    const span = richEl();
    loader.querySelector = () => span;
    t.h.byId["turn-loading-indicator"] = loader;
    t.h.eval("currentTurnStartTime = Date.now() - 31000");
    for (const tick of t.timers) tick();
    assert.match(span.textContent, /^<b>bold<\/b> is still thinking… 31s/);
    assert.equal(span.assigned.length, 0, "text, not HTML, was written on each tick");
  });
});

function h_assertTicks(t: { start: () => any; timers: Function[]; h: any }) {
  const loader = t.start();
  const span = richEl();
  loader.querySelector = () => span;
  t.h.byId["turn-loading-indicator"] = loader;
  assert.match(String(loader.assigned.at(-1)), /Model M is thinking… 0s/);
  t.h.eval("currentTurnStartTime = Date.now() - 12000");
  for (const tick of t.timers) tick();
  assert.equal(span.textContent, "Model M is thinking… 12s");
  t.h.eval("currentTurnStartTime = Date.now() - 45000");
  for (const tick of t.timers) tick();
  assert.equal(span.textContent, "Model M is still thinking… 45s · some models don't show their reasoning until they answer");
  t.h.byId["turn-loading-indicator"] = null;
  const before = span.textContent;
  t.h.eval("currentTurnStartTime = Date.now() - 99000");
  for (const tick of t.timers) tick();
  assert.equal(span.textContent, before, "a removed loader stops updating");
}

const CUSTOM_EFFORTS = ["low", "medium", "high", "xhigh"];

function rail(options: { provider?: string; model?: string; efforts?: string[]; current?: string; extra?: Record<string, unknown> } = {}) {
  const provider = options.provider ?? "mycorp";
  const model = options.model ?? "m1";
  const ids = ["reasoning-slider-range", "reasoning-auto", "reasoning-popover", "btn-prompt-reasoning", "btn-reasoning-close", "reasoning-slider-labels", "reasoning-slider-ticks",
    "prompt-reasoning-label", "reasoning-bubble", "reasoning-hint", "reasoning-slider-wrap", "effort-glyph", "reasoning-budget-input", "reasoning-budget-row", "reasoning-budget-apply"];
  const elements: Record<string, any> = {};
  for (const id of ids) elements[id] = richEl();
  elements["reasoning-popover"].style.display = "none";
  const h = loadChat({ state: { currentModel: model, currentProvider: provider, currentReasoning: options.current ?? "medium" }, elements });
  h.sandbox.document.createElement = () => richEl();
  const use = (p: string, m: string, efforts: string[] | null, extra: Record<string, unknown> = {}) => {
    h.sandbox.__m = efforts === null ? [] : [{ id: m, provider: p, reasoning: { supported_efforts: efforts, ...extra } }];
    h.eval(`currentProvider = ${JSON.stringify(p)}; currentModel = ${JSON.stringify(m)}; allModels = __m; currentModelReasoningCapability = null; updateReasoningUI();`);
  };
  use(provider, model, options.efforts ?? CUSTOM_EFFORTS, options.extra ?? {});
  const posts = () => h.posted.filter((m: any) => m.type === "update_config" && m.key === "reasoningEffort").map((m: any) => m.value);
  const labels = () => elements["reasoning-slider-labels"].children.map((c: any) => c.textContent);
  return { h, elements, use, posts, labels, set: (v: unknown) => { h.sandbox.__v = v; h.eval("setReasoningLevel(__v, true)"); }, current: () => h.eval("currentReasoning") };
}

describe("effort rail for a custom provider with declared efforts", () => {
  it("labels low, medium, high, xhigh as Low, Medium, High, X-High", () => {
    const r = rail();
    assert.deepEqual(r.labels(), ["Low", "Medium", "High", "X-High"]);
    assert.deepEqual(plain(r.h.eval("getReasoningChoices(getActiveModelReasoningCapability()).map(l => l.label)")), ["Auto", "Low", "Medium", "High", "X-High"]);
    assert.deepEqual(plain(r.h.eval("REASONING_SCALE.map(l => l.id)")), ["low", "medium", "high", "xhigh"]);
  });

  it("orders and labels the rail regardless of the order the provider declared", () => {
    const r = rail({ efforts: ["xhigh", "low", "high", "medium"] });
    assert.deepEqual(r.labels(), ["Low", "Medium", "High", "X-High"]);
  });

  it("offers no rail with a single declared effort or none, and does not post", () => {
    for (const efforts of [[], ["high"]]) {
      const r = rail({ efforts });
      r.set("high");
      r.set("auto");
      assert.deepEqual(r.posts().filter((v: string) => v !== "high" && v !== "auto"), []);
    }
    const none = rail({ efforts: [] });
    none.set("auto"); none.set("low");
    assert.deepEqual(none.posts(), [], "a model with no declared efforts has no controls, so nothing is sent");
  });

  it("only ever posts an effort the provider declared (or auto), whatever is requested", () => {
    const hostile: any[] = [
      "off", "none", "minimal", "max", "ultra", "on", "XHIGH", "Low", " low", "low ", "x-high", "X-High", "extra-high", "", "budget:100", "budget:0", "budget:",
      "__proto__", "constructor", "toString", "hasOwnProperty", "length", "0", "1", null, undefined, 0, 1, true, {}, [], ["low"], { toString: () => "low" },
      "low\u0000", "low\n", "\u200blow", "<img src=x onerror=1>", "xhigh,low",
    ];
    const allowed = new Set(["auto", ...CUSTOM_EFFORTS]);
    for (const value of hostile) {
      const r = rail();
      const before = r.current();
      r.set(value);
      assert.ok(r.posts().every((v: unknown) => allowed.has(v as string)), `posted ${JSON.stringify(r.posts())} for ${JSON.stringify(value)}`);
      if (r.posts().length === 0) assert.equal(r.current(), before, `state changed without a post for ${JSON.stringify(value)}`);
    }
    const ok = rail();
    for (const v of ["auto", ...CUSTOM_EFFORTS]) ok.set(v);
    assert.deepEqual(ok.posts(), ["auto", ...CUSTOM_EFFORTS]);
  });

  it("only posts declared efforts from the rail labels and from the slider, including out-of-range input", () => {
    const r = rail({ efforts: ["low", "high"] });
    const allowed = new Set(["auto", "low", "high"]);
    for (const button of r.elements["reasoning-slider-labels"].children) for (const fn of button.listeners.click || []) fn({ target: button, stopPropagation() {} });
    for (const value of ["-1", "2", "99", "NaN", "", "1e1", "1.5", "0", "1", "abc", "1abc", " 1", "9007199254740993", "__proto__"]) {
      for (const fn of r.elements["reasoning-slider-range"].listeners.input || []) fn({ target: { value } });
    }
    assert.ok(r.posts().length > 0);
    assert.ok(r.posts().every((v: string) => allowed.has(v)), JSON.stringify(r.posts()));
  });

  it("does not offer a level the new model lacks after switching models on the same provider", () => {
    const r = rail({ efforts: CUSTOM_EFFORTS, current: "xhigh" });
    r.set("xhigh");
    r.h.posted.length = 0;
    r.use("mycorp", "m2", ["low", "high"]);
    assert.ok(["auto", "low", "high"].includes(r.current()), `current effort ${r.current()} is not one m2 supports`);
    assert.deepEqual(r.labels(), ["Low", "High"]);
  });

  it("restores a manual level only from the current model's own set when Auto is switched off", () => {
    const r = rail({ efforts: CUSTOM_EFFORTS });
    r.set("xhigh");
    r.set("auto");
    r.use("mycorp", "m2", ["low", "high"]);
    r.h.posted.length = 0;
    r.h.eval("toggleReasoningAuto()");
    assert.ok(r.posts().length <= 1);
    for (const v of r.posts()) assert.ok(["low", "high"].includes(v), `restored ${v}`);
  });

  it("picking another custom-provider model never leaves an effort that model does not declare", () => {
    for (const before of ["off", "xhigh", "medium", "auto", "high", "low"]) {
      const r = rail({ efforts: CUSTOM_EFFORTS, current: before });
      r.h.sandbox.__m = [
        { id: "m1", provider: "mycorp", reasoning: { supported_efforts: CUSTOM_EFFORTS } },
        { id: "m2", provider: "mycorp", reasoning: { supported_efforts: ["low", "high"] } },
        { id: "m3", provider: "mycorp", reasoning: { supported_efforts: ["minimal", "max"] } },
        { id: "m4", provider: "mycorp", reasoning: { mode: "configurable", supported_efforts: ["low", "high"], default_effort: "xhigh" } },
      ];
      r.h.eval("allModels = __m; currentReasoning = " + JSON.stringify(before));
      for (const [id, set] of [["m2", ["auto", "low", "high"]], ["m3", ["auto", "minimal", "max"]], ["m4", ["auto", "low", "high"]], ["m1", ["auto", ...CUSTOM_EFFORTS]]] as const) {
        r.h.eval("window.pickModel('" + id + "', 'mycorp')");
        assert.ok(set.includes(r.current()), "after switching from " + before + " to " + id + " the effort is " + r.current());
      }
    }
  });

  it("the prompt that is sent carries only an effort the selected custom model declares", () => {
    const r = rail({ efforts: CUSTOM_EFFORTS, current: "xhigh" });
    r.h.sandbox.__m = [{ id: "m1", provider: "mycorp", reasoning: { supported_efforts: CUSTOM_EFFORTS } }, { id: "m2", provider: "mycorp", reasoning: { supported_efforts: ["low", "high"] } }];
    r.h.eval("allModels = __m; window.pickModel('m2', 'mycorp')");
    r.h.byId["prompt-input"].value = "hello";
    r.h.posted.length = 0;
    for (const fn of r.h.byId["btn-send"].listeners.click || []) fn({});
    const sent = r.h.posted.filter((m: any) => "reasoningEffort" in m && m.type !== "update_config");
    assert.ok(sent.length > 0, "a prompt was posted");
    for (const m of sent) assert.ok(["auto", "low", "high"].includes(m.reasoningEffort), "sent " + m.reasoningEffort);
  });

  it("turning Auto off on a model with no controls sends nothing", () => {
    const r = rail({ efforts: [] });
    r.h.eval("toggleReasoningAuto()");
    assert.deepEqual(r.posts(), []);
  });

  it("does not reuse another provider's declared efforts for the same model id", () => {
    const r = rail();
    r.use("otherco", "m1", null);
    r.h.eval("currentModelReasoningCapability = { _modelId: 'm1', _providerId: 'mycorp', supported_efforts: ['low','medium','high','xhigh'] }");
    r.h.eval("updateReasoningUI()");
    r.set("xhigh");
    assert.deepEqual(r.posts(), []);
  });

  it("changing provider drops the previous capability and uses the new provider's entry for the same model", () => {
    const r = rail({ provider: "mycorp", efforts: CUSTOM_EFFORTS });
    r.h.sandbox.__m = [
      { id: "m1", provider: "mycorp", reasoning: { supported_efforts: CUSTOM_EFFORTS } },
      { id: "m1", provider: "narrow", reasoning: { supported_efforts: ["low", "high"] } },
    ];
    r.h.eval("allModels = __m");
    r.h.post({ type: "config_updated", key: "provider", value: "narrow", reasoningCapability: { supported_efforts: ["minimal", "max", "ultra"] } });
    assert.equal(r.h.eval("currentModelReasoningCapability"), null, "a capability that came with the message is not trusted for another provider");
    r.h.posted.length = 0;
    r.set("medium");
    r.set("ultra");
    r.set("high");
    assert.deepEqual(r.posts(), ["high"]);
    assert.deepEqual(r.labels(), ["Low", "High"]);
  });

  it("changing to a provider that has no entry for the model locks the controls", () => {
    const r = rail({ provider: "mycorp", efforts: CUSTOM_EFFORTS });
    r.h.post({ type: "config_updated", key: "provider", value: "nobody" });
    r.h.posted.length = 0;
    for (const v of ["auto", "low", "xhigh"]) r.set(v);
    assert.deepEqual(r.posts(), []);
  });

  it("the page never asks the host to change the provider through update_config", () => {
    const script = readFileSync("src/providers/chatview/chatClientScript.ts", "utf8");
    assert.ok(!/type: 'update_config', key: 'provider'/.test(script));
    const r = rail();
    r.h.eval("window.pickModel('m1', 'mycorp')");
    assert.ok(r.h.posted.every((m: any) => !(m.type === "update_config" && m.key === "provider")));
  });

  it("a stale saved effort from the host is coerced into the model's set at startup", () => {
    const r = rail({ efforts: ["low", "high"] });
    r.h.post({ type: "init_state", sessionId: "s", model: "m1", provider: "mycorp", reasoningEffort: "xhigh", models: plain(r.h.eval("allModels")), providers: [], sessions: [], skills: [],
      modelReasoningCapability: { supported_efforts: ["low", "high"] } });
    assert.ok(["auto", "low", "high"].includes(r.current()), `current effort ${r.current()}`);
  });

  it("treats declared efforts that look like markup as text, never as HTML", () => {
    const r = rail({ efforts: ["<img src=x onerror=window.__pwn=1>", "\"><svg onload=window.__pwn=2>", "low", "__proto__", "constructor"] });
    for (const el of Object.values(r.elements) as any[]) {
      for (const html of el.assigned) assert.ok(!/<img|<svg|onerror|onload/i.test(html), html);
    }
    r.set("<img src=x onerror=window.__pwn=1>");
    assert.ok(r.posts().every((v: string) => ["auto", "low", "__proto__", "constructor", "<img src=x onerror=window.__pwn=1>", "\"><svg onload=window.__pwn=2>"].includes(v)));
  });

  it("does not post when the capability only declares a budget the model cannot take", () => {
    const r = rail({ efforts: ["on"], extra: { supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 1024, budget_max: 8000 } });
    for (const v of ["budget:0", "budget:1023", "budget:8001", "budget:1e3", "budget:1024.5", "budget:-5", "budget:9999999999999999999999"]) r.set(v);
    assert.deepEqual(r.posts(), []);
    r.set("budget:2048");
    assert.deepEqual(r.posts(), ["budget:2048"]);
  });

  it("a provider that declares efforts but a model entry without a reasoning block keeps controls locked", () => {
    const r = rail({ efforts: null as any });
    r.h.eval("allModels = [{ id: 'm1', provider: 'mycorp' }]; updateReasoningUI();");
    r.set("high"); r.set("auto");
    assert.deepEqual(r.posts(), []);
  });
});

describe("provider editor: supported reasoning efforts field", () => {
  const source = readFileSync("src/panels/SettingsPanel.ts", "utf8");
  const editor = source.slice(source.indexOf("    function editProvider(id) {"), source.indexOf("    function renderProviders() {"));

  function edit(provider: any) {
    const fields: Record<string, any> = new Proxy({}, { get: (t: any, k: string) => (t[k] ??= { value: "", style: {}, disabled: false, textContent: "", focus() {} }) });
    const context = vm.createContext({ allProviders: provider ? [provider] : [], document: { getElementById: (id: string) => fields[id] } });
    vm.runInContext(editor + `\neditProvider(${JSON.stringify(provider?.id ?? "")});`, context);
    return fields;
  }

  it("shows saved efforts as a comma-separated list and clears the field for a provider without any", () => {
    assert.equal(edit({ id: "x", reasoning_efforts: ["low", "medium", "xhigh"] })["connection-reasoning-efforts"].value, "low, medium, xhigh");
    assert.equal(edit({ id: "x" })["connection-reasoning-efforts"].value, "");
    assert.equal(edit({ id: "x", reasoning_efforts: null })["connection-reasoning-efforts"].value, "");
    assert.equal(edit({ id: "x", reasoning_efforts: "low, high" })["connection-reasoning-efforts"].value, "low, high");
  });

  it("starting a new connection leaves no efforts from the previously edited one", () => {
    const fields = edit(null);
    assert.equal(fields["connection-reasoning-efforts"].value, "");
  });

  it("sends what the field holds in the saved connection", () => {
    assert.ok(/reasoning_efforts: value\("connection-reasoning-efforts"\)/.test(source));
  });
});
