import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import * as fs from "node:fs";
import * as path from "node:path";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

declare let currentReasoning: any;
declare let lastManualReasoning: any;
declare function updateReasoningUI(): void;

type Cap = Record<string, any>;

const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "on"];

function levelIds(cap: Cap | null): string[] {
  if (!cap || !Array.isArray(cap.supported_efforts)) return [];
  const out: string[] = [];
  for (const value of cap.supported_efforts) {
    if (typeof value !== "string") continue;
    const id = value === "none" ? "off" : value;
    if (cap.is_mandatory && id === "off") continue;
    if (id === "auto") continue;
    if (!out.includes(id)) out.push(id);
  }
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  return out.sort((a, b) => rank(a) - rank(b));
}

function budgetCapable(cap: Cap | null): boolean {
  return !!cap && cap.supports_max_tokens === true && Number.isInteger(cap.budget_min) && Number.isInteger(cap.budget_max);
}

function hasControls(cap: Cap | null): boolean {
  if (!cap) return false;
  return (Array.isArray(cap.supported_efforts) && cap.supported_efforts.length > 0) || budgetCapable(cap);
}

function budgetAllowed(cap: Cap | null, value: unknown): boolean {
  if (!cap || typeof value !== "string" || !/^budget:[0-9]+$/.test(value)) return false;
  if (!budgetCapable(cap) || !["google_budget", "anthropic_budget"].includes(cap.request_format)) return false;
  const n = Number(value.slice(7));
  if (!Number.isInteger(n) || n < cap.budget_min || n > cap.budget_max) return false;
  return n !== 0 || levelIds(cap).includes("off");
}

function allowed(cap: Cap | null, value: unknown): boolean {
  if (value === "auto") return true;
  if (typeof value !== "string") return false;
  if (levelIds(cap).includes(value)) return true;
  return budgetAllowed(cap, value);
}

function normalizedDefault(cap: Cap | null): string | null {
  if (!cap || typeof cap.default_effort !== "string") return null;
  const id = cap.default_effort === "none" ? "off" : cap.default_effort;
  return id !== "auto" && allowed(cap, id) ? id : null;
}

function restoreTarget(cap: Cap, last: unknown): string | null {
  if (typeof last === "string" && last !== "auto" && allowed(cap, last)) return last;
  const fallback = normalizedDefault(cap);
  if (fallback) return fallback;
  const scale = levelIds(cap);
  if (scale.includes("medium")) return "medium";
  return scale.length ? "*" : null;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* vm harness with a stricter mock DOM than test/effortControls.test.ts */
/* ------------------------------------------------------------------ */

function slice(script: string, from: string, to: string): string {
  const start = script.indexOf(from);
  const end = script.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `could not slice client script between "${from}" and "${to}"`);
  return script.slice(start, end);
}

function vmHarness() {
  const script = getChatClientScript("icon", {
    currentSessionId: "test", currentProvider: "openrouter", currentModel: "custom",
    currentMode: "safe", currentProfile: "builder", currentReasoning: "auto",
  });
  const discovery = slice(script, "    let REASONING_LEVELS =", "    let attachedImages =");
  const controls = slice(script, "    function getReasoningLevelIndex", "    function updateReasoningBadge");
  const wiring = slice(script, "    const btnReasoningClose = document.getElementById('btn-reasoning-close');", "    function appendHelpCard");
  const wiringHead = "    const btnReasoningEl = document.getElementById('btn-prompt-reasoning');\n";
  const registry = new Map<string, any>();
  const state: { active: any } = { active: null };
  const markup: string[] = [];

  const create = (id = ""): any => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const listeners: Record<string, Function[]> = {};
    const props: Record<string, string> = {};
    let children: any[] = [];
    const el: any = {
      id, hidden: false, disabled: false, textContent: "", value: "", min: "", max: "", title: "", placeholder: "", type: "",
      attrs, classes, props,
      style: { display: "", setProperty(key: string, value: string) { props[key] = value; } },
      classList: {
        add: (...c: string[]) => c.forEach(x => classes.add(x)),
        remove: (...c: string[]) => c.forEach(x => classes.delete(x)),
        toggle: (c: string, force?: boolean) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
        contains: (c: string) => classes.has(c),
      },
      setAttribute(key: string, value: unknown) { attrs.set(key, String(value)); },
      getAttribute(key: string) { return attrs.has(key) ? attrs.get(key)! : null; },
      removeAttribute(key: string) { attrs.delete(key); },
      addEventListener(type: string, fn: Function) { (listeners[type] = listeners[type] || []).push(fn); },
      fire(type: string, extra: any = {}) { for (const fn of listeners[type] || []) fn({ target: el, stopPropagation() {}, preventDefault() {}, ...extra }); },
      appendChild(child: any) { children.push(child); return child; },
      contains() { return true; },
      focus() { if (!el.disabled) state.active = el; },
      checkValidity() {
        const n = Number(el.value);
        return el.value !== "" && Number.isFinite(n) && Number.isInteger(n) && n >= Number(el.min) && n <= Number(el.max);
      },
    };
    Object.defineProperty(el, "children", { get: () => children });
    Object.defineProperty(el, "className", {
      get: () => [...classes].join(" "),
      set: (value: string) => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    });
    Object.defineProperty(el, "innerHTML", {
      get: () => "",
      set: (value: string) => { if (value !== "") markup.push(String(value)); children = []; },
    });
    return el;
  };

  const posts: any[] = [];
  const popover = create("reasoning-popover");
  popover.style.display = "none";
  registry.set("reasoning-popover", popover);
  const context: any = {
    currentModel: "custom", currentProvider: "openrouter", currentReasoning: "auto", allModels: [],
    document: {
      getElementById(id: string) { if (!registry.has(id)) registry.set(id, create(id)); return registry.get(id); },
      createElement: () => create(),
    },
    vscode: { postMessage(message: any) { posts.push(message); } },
    reasoningPopover: popover,
  };
  vm.createContext(context);
  vm.runInContext(discovery + controls + wiringHead + wiring, context, { timeout: 5000 });
  const el = (id: string) => context.document.getElementById(id);
  const run = (code: string, timeout = 8000) => vm.runInContext(code, context, { timeout });
  const useCap = (cap: Cap | null) => {
    context.allModels = cap ? [{ id: "custom", provider: "openrouter", reasoning: cap }] : [];
    run("currentModelReasoningCapability = null");
  };
  const reasoningPosts = () => posts.filter(p => p && p.type === "update_config" && p.key === "reasoningEffort").map(p => p.value);
  return { context, el, run, posts, reasoningPosts, state, markup, useCap, popover };
}

const NON_THROWING_CAPS: Record<string, Cap> = {
  proto: { supported_efforts: ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "low"], default_effort: "constructor" },
  htmlIds: { supported_efforts: ["<img src=x onerror=window.__pwn=1>", "\"><svg onload=window.__pwn=2>", "low"], default_effort: "<b>" },
  nonString: { supported_efforts: [null, 5, {}, [], ["high"], true, "low", "low", "none", "off", "auto", "AUTO", ""] },
  unicode: { supported_efforts: ["\u0000", "\u202eevil", "\ud83d\udd25", " ", "a\nb", "low"] },
  longId: { supported_efforts: ["x".repeat(100000), "low"] },
  emptyList: { supported_efforts: [] },
  nulls: { supported_efforts: null, default_effort: null, supports_max_tokens: null, budget_min: null },
  budgetNullEfforts: { supported_efforts: null, supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 128, budget_max: 1000 },
  budgetFloats: { supported_efforts: ["low"], supports_max_tokens: true, request_format: "google_budget", budget_min: 1.5, budget_max: 1000.5 },
  budgetHuge: { supported_efforts: ["on"], supports_max_tokens: true, request_format: "google_budget", budget_min: 0, budget_max: Number.MAX_SAFE_INTEGER },
  budgetInverted: { supported_efforts: ["on"], supports_max_tokens: true, request_format: "google_budget", budget_min: 100, budget_max: 10 },
  budgetZeroNoOff: { supported_efforts: ["on"], supports_max_tokens: true, request_format: "google_budget", budget_min: 0, budget_max: 100 },
  budgetZeroOff: { supported_efforts: ["off", "on"], supports_max_tokens: true, request_format: "google_budget", budget_min: 0, budget_max: 100 },
  budgetBadFormat: { supported_efforts: ["on"], supports_max_tokens: true, request_format: "openai_effort", budget_min: 1, budget_max: 100 },
  budgetLevelIdLookalike: { supported_efforts: ["low", "budget:5", "budget:9999"], supports_max_tokens: true, request_format: "google_budget", budget_min: 1, budget_max: 50 },
  stringDefault: { supported_efforts: ["low", "high"], default_effort: "__proto__" },
  objectDefault: { supported_efforts: ["low", "high"], default_effort: { toString: "x" } },
  numberDefault: { supported_efforts: ["low", "high"], default_effort: 7 },
  mandatoryOnlyOff: { supported_efforts: ["off", "low"], is_mandatory: true },
  duplicatesCase: { supported_efforts: ["Low", "low", "LOW", "High"] },
};

const HOSTILE_EFFORTS: any[] = [
  "auto", "off", "none", "low", "high", "xhigh", "weird", "__proto__", "constructor", "toString", "", " ", " high", "high ", "HIGH",
  "budget:", "budget:-1", "budget:1.5", "budget:1e3", "budget:0x10", "budget:007", "budget:5\n", "budget: 5", "budget:50", "budget:5", "budget:99999999999999999999",
  null, undefined, 0, 1, true, false, {}, [], ["high"], ["budget:5"], [["budget:5"]], { id: "high" }, "\u0000",
];

function exerciseAllEntryPoints(h: ReturnType<typeof vmHarness>, cap: Cap | null, hostileValues = true) {
  const failures: string[] = [];
  const check = (where: string) => {
    const effective = h.context.currentReasoning;
    if (!allowed(cap, effective)) failures.push(`${where}: currentReasoning=${JSON.stringify(effective)} not allowed`);
    for (const value of h.reasoningPosts()) {
      if (!allowed(cap, value)) failures.push(`${where}: posted ${JSON.stringify(value)} not allowed`);
    }
  };
  h.useCap(cap);
  h.run("updateReasoningUI()");
  check("init");
  const labels = h.el("reasoning-slider-labels").children as any[];
  const slider = h.el("reasoning-slider-range");
  labels.slice(0, 40).forEach((btn: any, i: number) => { btn.fire("click"); check(`label click #${i}`); });
  const max = Math.min(labels.length + 3, 60);
  for (let i = -2; i <= max; i++) { slider.value = String(i); slider.fire("input", { target: slider }); check(`slider input ${i}`); }
  for (const raw of ["", "abc", "NaN", "1e999", "-1", "0.5"]) { slider.value = raw; slider.fire("input", { target: slider }); check(`slider raw ${raw}`); }
  for (let i = 0; i < 6; i++) { h.el("reasoning-auto").fire("click"); check(`auto toggle #${i}`); }
  const apply = h.el("reasoning-budget-apply");
  const budgetInput = h.el("reasoning-budget-input");
  const lo = cap && Number.isInteger(cap.budget_min) ? cap.budget_min : 0;
  const hi = cap && Number.isInteger(cap.budget_max) ? cap.budget_max : 0;
  const candidates = ["", "0", "-1", "1e3", "1.5", "abc", String(lo), String(lo - 1), String(hi), String(hi + 1), String(Math.floor((lo + hi) / 2)), "9999999999999999999", "007", " 5 "];
  for (const raw of candidates) { budgetInput.value = raw; apply.fire("click"); check(`apply ${JSON.stringify(raw)}`); }
  if (hostileValues) {
    for (const value of HOSTILE_EFFORTS) {
      try { h.run("setReasoningLevel(" + (value === undefined ? "undefined" : `JSON.parse(${JSON.stringify(JSON.stringify(value))})`) + ", true)"); } catch (error) { failures.push(`setReasoningLevel(${JSON.stringify(value)}) threw ${(error as Error).message}`); }
      check(`setReasoningLevel ${JSON.stringify(value)}`);
    }
    for (const value of HOSTILE_EFFORTS) {
      h.context.currentReasoning = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      try { h.run("updateReasoningUI()"); } catch (error) { failures.push(`updateReasoningUI with currentReasoning=${JSON.stringify(value)} threw ${(error as Error).message}`); continue; }
      check(`init_state currentReasoning=${JSON.stringify(value)}`);
    }
  }
  return failures;
}

describe("Effort rail: hostile capability data (vm, mock DOM)", () => {
  for (const [name, cap] of Object.entries(NON_THROWING_CAPS)) {
    it(`never throws, never posts or holds an out-of-set value: ${name}`, { timeout: 30000 }, () => {
      const h = vmHarness();
      const failures = exerciseAllEntryPoints(h, cap);
      assert.deepEqual(failures.slice(0, 8), [], `${name}: ${failures.length} violations`);
    });
  }

  it("ids and labels never reach innerHTML and data-level is the raw id", () => {
    const h = vmHarness();
    const cap = NON_THROWING_CAPS.htmlIds;
    h.useCap(cap);
    h.run("updateReasoningUI()");
    assert.deepEqual(h.markup, [], "innerHTML was assigned markup");
    const labels = h.el("reasoning-slider-labels").children as any[];
    assert.deepEqual(labels.map((b: any) => b.getAttribute("data-level")), levelIds(cap));
    for (const btn of labels) assert.equal(btn.textContent.length > 0, true);
    const attrNames = labels.flatMap((b: any) => [...b.attrs.keys()]);
    assert.deepEqual([...new Set(attrNames)].sort(), ["data-level", "tabindex"]);
  });

  it("hint text for Object.prototype-named ids is empty, not an inherited function", () => {
    for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      const h = vmHarness();
      h.useCap({ supported_efforts: [id, "low"] });
      h.run("updateReasoningUI()");
      h.run(`setReasoningLevel(${JSON.stringify(id)}, true)`);
      assert.equal(h.context.currentReasoning, id);
      assert.equal(h.el("reasoning-hint").textContent, "", `hint for ${id}`);
      assert.equal(typeof h.el("prompt-reasoning-label").textContent, "string");
      assert.ok(!/function|native code/.test(h.el("reasoning-bubble").textContent), `bubble for ${id}`);
    }
  });

  it("does not pollute prototypes", () => {
    const h = vmHarness();
    const hostHost = Object.keys(Object.prototype).length;
    for (const cap of Object.values(NON_THROWING_CAPS)) exerciseAllEntryPoints(h, cap, false);
    assert.equal(h.run("Object.keys(Object.prototype).length"), 0);
    assert.equal(h.run("({}).polluted"), undefined);
    assert.equal(Object.keys(Object.prototype).length, hostHost);
    assert.equal(h.run("Object.prototype.hasOwnProperty.call(REASONING_LABELS, '__proto__')"), false);
  });

  it("supported_efforts that is not an array must not throw (string, object, number, boolean)", () => {
    const failures: string[] = [];
    for (const bad of ["high", { length: 2, 0: "low" }, 5, true, { 0: "low" }]) {
      const h = vmHarness();
      h.useCap({ supported_efforts: bad, default_effort: "low" });
      try { h.run("updateReasoningUI()"); } catch (error) { failures.push(`${JSON.stringify(bad)} -> ${(error as Error).message}`); }
    }
    assert.deepEqual(failures, []);
  });

  it("typed-field confusion: truthy-but-not-true supports_max_tokens must not enable budgets", () => {
    const failures: string[] = [];
    for (const flag of ["false", "no", 1, "0", [], {}]) {
      const h = vmHarness();
      const cap = { supported_efforts: ["low"], supports_max_tokens: flag, request_format: "anthropic_budget", budget_min: 1, budget_max: 10 };
      h.useCap(cap);
      h.run("updateReasoningUI()");
      h.run("setReasoningLevel('budget:5', true)");
      if (h.reasoningPosts().includes("budget:5")) failures.push(`supports_max_tokens=${JSON.stringify(flag)} accepted budget:5`);
    }
    assert.deepEqual(failures, []);
  });

  it("budget:0 is refused when thinking is mandatory (off is not offered)", () => {
    const h = vmHarness();
    const cap = { supported_efforts: ["off", "on"], is_mandatory: true, supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 0, budget_max: 8000 };
    h.useCap(cap);
    h.run("updateReasoningUI()");
    h.el("reasoning-budget-input").value = "0";
    h.el("reasoning-budget-apply").fire("click");
    assert.deepEqual(h.reasoningPosts(), [], "budget:0 would switch thinking off on a mandatory-thinking model");
  });

  it("budget:0 is accepted when off is offered as none (spec: 0 only if off is supported)", () => {
    const h = vmHarness();
    const cap = { supported_efforts: ["none", "on"], supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 0, budget_max: 8000 };
    h.useCap(cap);
    h.run("updateReasoningUI()");
    h.el("reasoning-budget-input").value = "0";
    h.el("reasoning-budget-apply").fire("click");
    assert.deepEqual(h.reasoningPosts(), ["budget:0"]);
  });

  it("budget with supported_efforts missing and budget 0 does not throw", () => {
    const h = vmHarness();
    h.useCap({ supports_max_tokens: true, request_format: "google_budget", budget_min: 0, budget_max: 10 });
    assert.doesNotThrow(() => {
      h.run("updateReasoningUI()");
      h.el("reasoning-budget-input").value = "0";
      h.el("reasoning-budget-apply").fire("click");
      h.run("currentReasoning = 'budget:0'; updateReasoningUI()");
    });
  });
});

describe("Effort rail: scale performance and shape (vm)", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `level-${i}`);

  it("300 levels finish quickly, render 300 buttons and 300 ticks, and every one is selectable", { timeout: 20000 }, () => {
    const h = vmHarness();
    h.useCap({ supported_efforts: many(300) });
    const started = Date.now();
    h.run("updateReasoningUI()");
    const labels = h.el("reasoning-slider-labels").children as any[];
    labels.forEach((b: any) => b.fire("click"));
    const elapsed = Date.now() - started;
    assert.equal(labels.length, 300);
    assert.equal(h.el("reasoning-slider-ticks").children.length, 300);
    assert.equal(h.el("reasoning-slider-labels").classes.has("dense"), true);
    assert.ok(elapsed < 1500, `took ${elapsed}ms`);
    assert.equal(h.reasoningPosts().length, 300);
  });

  it("20000 levels do not take unbounded time (quadratic de-duplication)", { timeout: 60000 }, () => {
    const small = vmHarness();
    small.useCap({ supported_efforts: many(2000) });
    const smallStarted = Date.now();
    small.run("updateReasoningUI()", 30000);
    const baseline = Math.max(Date.now() - smallStarted, 20);
    const h = vmHarness();
    h.useCap({ supported_efforts: many(20000) });
    const started = Date.now();
    h.run("updateReasoningUI()", 30000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < Math.max(2000, baseline * 60), `20000 levels took ${elapsed}ms against ${baseline}ms for 2000`);
  });

  it("5 repeated redraws of a 2000-level scale reuse the rail (no rebuild when unchanged)", { timeout: 30000 }, () => {
    const h = vmHarness();
    h.useCap({ supported_efforts: many(2000) });
    h.run("updateReasoningUI()");
    const first = h.el("reasoning-slider-labels").children[0];
    for (let i = 0; i < 5; i++) h.run("updateReasoningUI()");
    assert.equal(h.el("reasoning-slider-labels").children[0], first);
  });

  it("rail signature does not collide for different scales (exhaustive over a small alphabet)", { timeout: 60000 }, () => {
    const alphabet = ["a", "A", ":", "|"];
    const ids: string[] = [];
    const build = (prefix: string, depth: number) => {
      if (prefix) ids.push(prefix);
      if (depth === 0) return;
      for (const ch of alphabet) build(prefix + ch, depth - 1);
    };
    build("", 3);
    const sig = (list: string[]) => list.map(id => id + ":" + id.charAt(0).toUpperCase() + id.slice(1)).join("|");
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    const record = (list: string[]) => {
      const unique = [...new Set(list)];
      if (unique.length !== list.length) return;
      const key = sig(list);
      const label = JSON.stringify(list);
      const prior = seen.get(key);
      if (prior && prior !== label) collisions.push(`${prior} vs ${label}`);
      else seen.set(key, label);
    };
    for (const a of ids) record([a]);
    for (const a of ids) for (const b of ids) record([a, b]);
    assert.deepEqual(collisions.slice(0, 3), []);
  });
});

describe("Effort rail: Auto switch semantics (vm)", () => {
  const A = { supported_efforts: ["low", "medium", "high"], default_effort: "high" };

  it("turning Auto off with no history restores default_effort", () => {
    const h = vmHarness();
    h.useCap(A);
    h.run("updateReasoningUI()");
    assert.equal(h.context.currentReasoning, "auto");
    h.el("reasoning-auto").fire("click");
    assert.equal(h.context.currentReasoning, "high");
    assert.deepEqual(h.reasoningPosts(), ["high"]);
  });

  it("round trip restores the last manual level and posts auto in between", () => {
    const h = vmHarness();
    h.useCap(A);
    h.run("updateReasoningUI(); setReasoningLevel('low', true)");
    h.el("reasoning-auto").fire("click");
    assert.equal(h.context.currentReasoning, "auto");
    h.el("reasoning-auto").fire("click");
    assert.deepEqual(h.reasoningPosts(), ["low", "auto", "low"]);
  });

  it("never restores a level that is invalid after switching models", () => {
    const h = vmHarness();
    h.useCap({ supported_efforts: ["low", "medium", "high", "max"], default_effort: "auto" });
    h.run("updateReasoningUI(); setReasoningLevel('max', true); setReasoningLevel('auto', true)");
    const next = { supported_efforts: ["low", "medium"], default_effort: "low" };
    h.useCap(next);
    h.run("updateReasoningUI()");
    h.el("reasoning-auto").fire("click");
    assert.equal(allowed(next, h.context.currentReasoning), true);
    assert.equal(h.context.currentReasoning, "low");
    assert.ok(h.reasoningPosts().every(v => v !== "max" || h.reasoningPosts().indexOf(v) === 0));
  });

  it("never restores a budget outside the new model's range", () => {
    const h = vmHarness();
    const first = { supported_efforts: ["on"], supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 1024, budget_max: 8000 };
    h.useCap(first);
    h.run("updateReasoningUI()");
    h.el("reasoning-budget-input").value = "2048";
    h.el("reasoning-budget-apply").fire("click");
    h.run("setReasoningLevel('auto', true)");
    const second = { supported_efforts: ["on"], supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 4096, budget_max: 8000 };
    h.useCap(second);
    h.run("updateReasoningUI()");
    h.el("reasoning-auto").fire("click");
    assert.equal(allowed(second, h.context.currentReasoning), true);
    assert.notEqual(h.context.currentReasoning, "budget:2048");
    assert.ok(h.reasoningPosts().slice(3).every(v => allowed(second, v)));
  });

  it("falls back to medium, then to a level from the scale, when there is no default", () => {
    const withMedium = vmHarness();
    withMedium.useCap({ supported_efforts: ["low", "medium", "high", "max"] });
    withMedium.run("updateReasoningUI()");
    withMedium.el("reasoning-auto").fire("click");
    assert.equal(withMedium.context.currentReasoning, "medium");
    const noMedium = vmHarness();
    noMedium.useCap({ supported_efforts: ["low", "high", "max"] });
    noMedium.run("updateReasoningUI()");
    noMedium.el("reasoning-auto").fire("click");
    assert.ok(["low", "high", "max"].includes(noMedium.context.currentReasoning));
  });

  it("default_effort 'none' (shown as off) is honoured as off, not skipped", () => {
    const h = vmHarness();
    const cap = { supported_efforts: ["none", "low", "high"], default_effort: "none" };
    h.useCap(cap);
    h.run("updateReasoningUI()");
    h.el("reasoning-auto").fire("click");
    assert.equal(h.context.currentReasoning, "off");
  });

  it("initial coercion honours default_effort 'none' as off", () => {
    const h = vmHarness();
    h.context.currentReasoning = "xhigh";
    h.useCap({ supported_efforts: ["none", "low", "high"], default_effort: "none" });
    h.run("updateReasoningUI()");
    assert.equal(h.context.currentReasoning, "off");
  });

  it("the Auto switch is disabled exactly when there is nothing to restore", () => {
    const h = vmHarness();
    h.useCap({ supported_efforts: [], supports_max_tokens: true, request_format: "google_budget", budget_min: 128, budget_max: 1000 });
    h.run("updateReasoningUI()");
    assert.equal(h.el("reasoning-auto").disabled, true);
    h.el("reasoning-auto").fire("click");
    assert.deepEqual(h.reasoningPosts(), []);
    h.el("reasoning-budget-input").value = "256";
    h.el("reasoning-budget-apply").fire("click");
    assert.deepEqual(h.reasoningPosts(), ["budget:256"]);
    assert.equal(h.el("reasoning-auto").disabled, false);
    h.el("reasoning-auto").fire("click");
    assert.equal(h.el("reasoning-auto").disabled, false, "switch must stay usable: budget:256 is restorable");
    h.el("reasoning-auto").fire("click");
    assert.deepEqual(h.reasoningPosts(), ["budget:256", "auto", "budget:256"]);
  });

  it("an array default_effort is never restored or posted", () => {
    const h = vmHarness();
    const cap = { supported_efforts: ["off", "on"], supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 0, budget_max: 100, default_effort: ["budget:5"] };
    h.useCap(cap);
    h.run("updateReasoningUI()");
    h.el("reasoning-auto").fire("click");
    for (const value of h.reasoningPosts()) assert.equal(typeof value, "string");
    assert.equal(typeof h.context.currentReasoning, "string");
  });

  it("an array currentReasoning from init_state is normalised to a string value", () => {
    const h = vmHarness();
    const cap = { supported_efforts: ["off", "on"], supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 0, budget_max: 100 };
    h.useCap(cap);
    h.context.currentReasoning = ["budget:5"];
    h.run("updateReasoningUI()");
    assert.equal(typeof h.context.currentReasoning, "string");
    assert.equal(allowed(cap, h.context.currentReasoning), true);
  });

  it("budget on a scale without an 'on' level still lights the glyph and shows the budget on the rail", () => {
    const h = vmHarness();
    const cap = { supported_efforts: ["low", "medium", "high"], default_effort: "medium", supports_max_tokens: true, request_format: "google_budget", budget_min: 128, budget_max: 24576 };
    h.useCap(cap);
    h.run("updateReasoningUI()");
    h.el("reasoning-budget-input").value = "4096";
    h.el("reasoning-budget-apply").fire("click");
    assert.equal(h.context.currentReasoning, "budget:4096");
    assert.notEqual(h.el("effort-glyph").attrs.get("data-lit"), "0", "glyph shows no bars for an active token budget");
  });
});

describe("Effort rail: popover guards (vm)", () => {
  it("cannot be opened and trigger stays disabled without thinking controls", () => {
    for (const cap of [null, { supported_efforts: [] }, { supports_max_tokens: true }, { supported_efforts: null }]) {
      const h = vmHarness();
      h.useCap(cap);
      h.run("updateReasoningUI()");
      assert.equal(h.el("btn-prompt-reasoning").disabled, true, JSON.stringify(cap));
      h.run("toggleReasoningPopover(true)");
      assert.equal(h.popover.style.display, "none", JSON.stringify(cap));
      h.run("toggleReasoningPopover()");
      assert.equal(h.popover.style.display, "none");
      assert.equal(h.el("btn-prompt-reasoning").getAttribute("aria-expanded"), "false");
    }
  });

  it("closes when the model loses its controls while open", () => {
    const h = vmHarness();
    h.useCap({ supported_efforts: ["low", "high"] });
    h.run("updateReasoningUI(); toggleReasoningPopover(true)");
    assert.equal(h.popover.style.display, "flex");
    h.useCap(null);
    h.run("updateReasoningUI()");
    assert.equal(h.popover.style.display, "none");
    assert.equal(h.el("btn-prompt-reasoning").disabled, true);
  });

  it("focus goes to the slider, or to the Auto switch when there is no rail", () => {
    const rail = vmHarness();
    rail.useCap({ supported_efforts: ["low", "high"] });
    rail.run("updateReasoningUI(); toggleReasoningPopover(true)");
    assert.equal(rail.state.active, rail.el("reasoning-slider-range"));
    const single = vmHarness();
    single.useCap({ supported_efforts: ["high"] });
    single.run("updateReasoningUI(); toggleReasoningPopover(true)");
    assert.equal(single.state.active, single.el("reasoning-auto"));
  });

  it("dead popover: a trigger must not be enabled when nothing is selectable", () => {
    const failures: string[] = [];
    const dead: Cap[] = [
      { supported_efforts: [null, 5] },
      { supported_efforts: ["auto"] },
      { supported_efforts: ["off"], is_mandatory: true },
      { supported_efforts: [], supports_max_tokens: true, request_format: "openai_effort", budget_min: 1, budget_max: 100 },
    ];
    for (const cap of dead) {
      const h = vmHarness();
      h.useCap(cap);
      h.run("updateReasoningUI()");
      const scale = levelIds(cap).length;
      const budget = budgetCapable(cap) && ["google_budget", "anthropic_budget"].includes(cap.request_format);
      if (!scale && !budget && h.el("btn-prompt-reasoning").disabled === false) failures.push(JSON.stringify(cap));
    }
    assert.deepEqual(failures, []);
  });

  it("stale rail: 3 -> 8 -> 2 -> none -> 8 leaves exactly the current ticks and labels", () => {
    const h = vmHarness();
    const caps: (Cap | null)[] = [
      { supported_efforts: ["low", "medium", "high"] },
      { supported_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
      { supported_efforts: ["on", "off"] },
      null,
      { supported_efforts: ["low", "medium", "high", "max", "ultra", "xhigh", "minimal", "none"] },
      { supported_efforts: ["high"] },
    ];
    for (const cap of caps) {
      h.useCap(cap);
      h.run("updateReasoningUI()");
      const expected = levelIds(cap);
      assert.deepEqual((h.el("reasoning-slider-labels").children as any[]).map((b: any) => b.getAttribute("data-level")), expected);
      assert.equal(h.el("reasoning-slider-ticks").children.length, expected.length);
      assert.equal(h.el("reasoning-slider-labels").classes.has("dense"), expected.length > 6);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Real browser                                                         */
/* ------------------------------------------------------------------ */

const ORIGIN = "http://127.0.0.1:8770";
const nodeRequire: NodeRequire = require;

function loadPlaywright(): any | null {
  const roaming = process.env.APPDATA || "";
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    path.join(roaming, "npm/node_modules/@playwright/cli/node_modules/playwright-core"),
    path.join(roaming, "npm/node_modules/openclaw/node_modules/playwright-core"),
    "playwright-core",
    "playwright",
  ].filter((value): value is string => !!value);
  for (const candidate of candidates) {
    try { return nodeRequire(candidate); } catch { /* try next */ }
  }
  return null;
}

function findChromium(): string | undefined {
  if (process.env.EFFORT_CHROME && fs.existsSync(process.env.EFFORT_CHROME)) return process.env.EFFORT_CHROME;
  const local = process.env.LOCALAPPDATA || "";
  const roots = [path.join(local, "ms-playwright"), path.join(process.env.HOME || "", ".cache/ms-playwright")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const dir of dirs) {
      for (const rel of ["chrome-win64/chrome.exe", "chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const candidate = path.join(root, dir, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function buildPageHtml(theme: "dark" | "light"): string {
  const Module = nodeRequire("module");
  const original = Module.prototype.require;
  const uri = (p: string): any => ({ path: p, fsPath: p, toString: () => p });
  const vscodeStub = {
    Uri: { joinPath: (base: any, ...parts: string[]) => uri([base.path, ...parts].join("/")), file: (p: string) => uri(p), parse: (p: string) => uri(p) },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  };
  Module.prototype.require = function (this: any, name: string) { return name === "vscode" ? vscodeStub : original.apply(this, arguments); };
  let chatHtml: any;
  try { chatHtml = nodeRequire("../src/providers/chatview/chatHtml.js"); } finally { Module.prototype.require = original; }
  const common = {
    "--vscode-font-family": "'Segoe WPC', 'Segoe UI', system-ui, sans-serif", "--vscode-font-size": "13px",
    "--vscode-editor-font-family": "Consolas, 'Courier New', monospace",
  };
  const vars: Record<string, string> = theme === "dark"
    ? { ...common, "--vscode-foreground": "#CCCCCC", "--vscode-descriptionForeground": "#9D9D9D", "--vscode-errorForeground": "#F85149", "--vscode-focusBorder": "#0078D4", "--vscode-widget-border": "#313131", "--vscode-panel-border": "#2B2B2B", "--vscode-sideBar-background": "#181818", "--vscode-editor-background": "#1F1F1F", "--vscode-input-background": "#313131", "--vscode-input-border": "#3C3C3C", "--vscode-button-background": "#0078D4", "--vscode-button-foreground": "#FFFFFF", "--vscode-list-hoverBackground": "#2A2D2E", "--vscode-editorWidget-background": "#202020" }
    : { ...common, "--vscode-foreground": "#3B3B3B", "--vscode-descriptionForeground": "#717171", "--vscode-errorForeground": "#F85149", "--vscode-focusBorder": "#005FB8", "--vscode-widget-border": "#E5E5E5", "--vscode-panel-border": "#E5E5E5", "--vscode-sideBar-background": "#F8F8F8", "--vscode-editor-background": "#FFFFFF", "--vscode-input-background": "#FFFFFF", "--vscode-input-border": "#CECECE", "--vscode-button-background": "#005FB8", "--vscode-button-foreground": "#FFFFFF", "--vscode-list-hoverBackground": "#F2F2F2", "--vscode-editorWidget-background": "#FFFFFF" };
  const extensionDir = path.resolve(__dirname, "../..");
  let html: string = chatHtml.getChatViewHtml(
    { cspSource: ORIGIN, asWebviewUri: (u: any) => uri(ORIGIN + "/" + path.relative(extensionDir, u.path).split(path.sep).join("/")) },
    uri(extensionDir),
    { currentSessionId: "s1", currentModel: "m", currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "medium", models: [], pinnedModels: [], workspaceFiles: [], workspaceFolders: [], extensionVersion: "0.2.26" },
  );
  const nonce = /nonce-([0-9A-Za-z+/=]+)/.exec(html)![1];
  const style = `<style>:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}</style>`;
  const boot = `<script nonce="${nonce}">document.body.classList.add(${JSON.stringify(theme === "dark" ? "vscode-dark" : "vscode-light")});window.__posted=[];` +
    `window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>undefined,setState:()=>{}});` +
    `window.__send=(data)=>window.dispatchEvent(new MessageEvent('message',{data}));` +
    `window.__init=(model,cap,effort)=>window.__send({type:'init_state',sessionId:'s1',model:model,provider:'p',models:[],modelReasoningCapability:cap===null?undefined:Object.assign({mode:'configurable'},cap),reasoningEffort:effort});` +
    `window.__switch=(model,cap)=>window.__send({type:'config_updated',key:'model',value:model,provider:'p',reasoningCapability:cap===null?undefined:Object.assign({mode:'configurable'},cap)});` +
    `window.addEventListener('load',()=>{window.__send({type:'auth_state_changed',isAuthenticated:true,plan:'free'});});</script>`;
  html = html.replace(/<head>/, "<head>" + style).replace(/<body([^>]*)>/, (m) => m + boot);
  return html;
}

const pw = loadPlaywright();
const chromePath = findChromium();
const browserSkip = !pw ? "playwright-core not found (set PLAYWRIGHT_CORE)" : !chromePath ? "no Chromium found (set EFFORT_CHROME)" : false;

interface Snap {
  current: any; last: any; popDisplay: string; ariaExpanded: string | null; btnDisabled: boolean; btnVisible: boolean; btnLabel: string;
  labels: { text: string; level: string | null; active: boolean; visible: boolean }[]; ticks: number; litTicks: boolean[];
  lit: string | null; popP: string; popHue: string; popAuto: boolean; popOff: boolean; btnAuto: boolean; btnOff: boolean; btnP: string;
  autoChecked: string | null; autoDisabled: boolean; autoOn: boolean;
  slider: { min: string; max: string; value: string; disabled: boolean; valuetext: string | null };
  wrapHidden: boolean; labelsHidden: boolean; dense: boolean; bubble: string; hint: string; budgetRowHidden: boolean; budgetValue: string;
  active: string; scrollW: number; vw: number;
}

function snapshotInPage(): Snap {
  const q = (id: string) => document.getElementById(id) as HTMLElement;
  const labels = Array.from(document.querySelectorAll<HTMLElement>("#reasoning-slider-labels .reasoning-step-btn"));
  const ticks = Array.from(document.querySelectorAll<HTMLElement>("#reasoning-slider-ticks .reasoning-tick-point"));
  const slider = q("reasoning-slider-range") as HTMLInputElement;
  const btn = q("btn-prompt-reasoning") as HTMLButtonElement;
  const pop = q("reasoning-popover");
  const sw = q("reasoning-auto") as HTMLButtonElement;
  const input = q("reasoning-budget-input") as HTMLInputElement;
  return {
    current: currentReasoning, last: lastManualReasoning, popDisplay: pop.style.display, ariaExpanded: btn.getAttribute("aria-expanded"),
    btnDisabled: btn.disabled, btnVisible: getComputedStyle(btn).display !== "none", btnLabel: q("prompt-reasoning-label").textContent || "",
    labels: labels.map(l => ({ text: l.textContent || "", level: l.getAttribute("data-level"), active: l.classList.contains("active"), visible: getComputedStyle(l).visibility !== "hidden" })),
    ticks: ticks.length, litTicks: ticks.map(t => t.classList.contains("lit")),
    lit: q("effort-glyph").getAttribute("data-lit"), popP: pop.style.getPropertyValue("--effort-p"), popHue: pop.style.getPropertyValue("--effort-hue"),
    popAuto: pop.classList.contains("is-auto"), popOff: pop.classList.contains("is-off"), btnAuto: btn.classList.contains("is-auto"), btnOff: btn.classList.contains("is-off"),
    btnP: btn.style.getPropertyValue("--effort-p"),
    autoChecked: sw.getAttribute("aria-checked"), autoDisabled: sw.disabled, autoOn: sw.classList.contains("on"),
    slider: { min: slider.min, max: slider.max, value: slider.value, disabled: slider.disabled, valuetext: slider.getAttribute("aria-valuetext") },
    wrapHidden: q("reasoning-slider-wrap").hidden, labelsHidden: q("reasoning-slider-labels").hidden, dense: q("reasoning-slider-labels").classList.contains("dense"),
    bubble: q("reasoning-bubble").textContent || "", hint: q("reasoning-hint").textContent || "",
    budgetRowHidden: q("reasoning-budget-row").hidden, budgetValue: input.value,
    active: (document.activeElement as HTMLElement | null)?.id || (document.activeElement as HTMLElement | null)?.tagName || "",
    scrollW: document.documentElement.scrollWidth, vw: window.innerWidth,
  };
}

async function newPage(browser: any, theme: "dark" | "light", options: { width?: number; height?: number; forcedColors?: string; reducedMotion?: string } = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 400, height: options.height ?? 800 }, forcedColors: options.forcedColors, reducedMotion: options.reducedMotion });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(String(error.message)));
  const html = buildPageHtml(theme);
  const media = path.resolve(__dirname, "../../media");
  await page.route(ORIGIN + "/**", (route: any) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/page.html") return route.fulfill({ body: html, contentType: "text/html" });
    const file = path.join(media, "..", decodeURIComponent(url.pathname));
    if (url.pathname.startsWith("/media/") && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".png": "image/png", ".jpg": "image/jpeg" };
      return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || "application/octet-stream" });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(ORIGIN + "/page.html");
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof (window as any).__init === "function" && typeof updateReasoningUI === "function", null, { timeout: 15000 });
  await page.waitForTimeout(400);
  return { context, page, errors };
}

const snap = (page: any): Promise<Snap> => page.evaluate(snapshotInPage);
const initModel = (page: any, id: string, cap: Cap | null, effort?: unknown) => page.evaluate(([i, c, e]: any) => (window as any).__init(i, c, e), [id, cap, effort === undefined ? null : effort]);
const switchModel = (page: any, id: string, cap: Cap | null) => page.evaluate(([i, c]: any) => (window as any).__switch(i, c), [id, cap]);
const posted = (page: any): Promise<any[]> => page.evaluate(() => (window as any).__posted.filter((m: any) => m.type === "update_config" && m.key === "reasoningEffort").map((m: any) => m.value));
const popoverOpen = async (page: any) => (await snap(page)).popDisplay !== "none";
async function openPopover(page: any) {
  if (await popoverOpen(page)) return;
  await page.click("#btn-prompt-reasoning", { timeout: 3000 });
}

describe("Effort rail: real browser", { skip: browserSkip }, () => {
  let browser: any;
  before(async () => {
    browser = await pw.chromium.launch({ executablePath: chromePath, headless: true });
  }, { timeout: 90000 });
  after(async () => { if (browser) await browser.close(); }, { timeout: 30000 });

  const catalogue: Record<string, Cap | null> = {
    noData: null,
    empty: { supported_efforts: [] },
    three: { supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
    eight: { supported_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "high" },
    onoff: { supported_efforts: ["on", "off"], default_effort: "on" },
    noneDefault: { supported_efforts: ["none", "low", "high"], default_effort: "none" },
    budgetOn: { supported_efforts: ["on"], supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 1024, budget_max: 8191 },
    budgetLevels: { supported_efforts: ["low", "medium", "high"], default_effort: "medium", supports_max_tokens: true, request_format: "google_budget", budget_min: 128, budget_max: 24576 },
    budgetOnly: { supported_efforts: [], supports_max_tokens: true, request_format: "google_budget", budget_min: 128, budget_max: 2048 },
    budgetZero: { supported_efforts: ["off", "on"], supports_max_tokens: true, request_format: "google_budget", budget_min: 0, budget_max: 4096 },
    single: { supported_efforts: ["high"], default_effort: "high" },
    mandatory: { supported_efforts: ["off", "low", "high"], is_mandatory: true, default_effort: "low" },
    reversed: { supported_efforts: ["ultra", "weird", "max", "low", "alpha"] },
    proto: { supported_efforts: ["__proto__", "constructor", "low"] },
    dupes: { supported_efforts: [null, 5, "low", "low", "none", "off", "auto"] },
    onlyOff: { supported_efforts: ["none"] },
  };
  const effortPool = [
    "auto", "off", "none", "low", "medium", "high", "xhigh", "max", "ultra", "on", "budget:0", "budget:5", "budget:128", "budget:1024", "budget:2048",
    "budget:5000", "budget:99999", "weird", "__proto__", "constructor", "", "budget:", "budget:-1",
  ];

  for (const [theme, seed] of [["dark", 11], ["light", 4242], ["dark", 777], ["light", 31337], ["dark", 9001]] as const) {
    it(`random walk over models, rail, Auto, budget and init_state keeps every invariant (${theme}, seed ${seed})`, { timeout: 240000 }, async () => {
      const { page, context, errors } = await newPage(browser, theme);
      try {
        const rand = mulberry32(seed);
        const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)];
        const names = Object.keys(catalogue);
        const failures = new Map<string, string>();
        const ops: string[] = [];
        let modelCounter = 0;
        let activeId = "m";
        let cap: Cap | null = null;
        let shadowLast: any = null;
        let postedSeen = 0;
        let lastStep = "";

        const fail = (name: string, detail: string) => { if (!failures.has(name)) failures.set(name, `${detail} | after ops: ${ops.slice(-7).join(" ; ")}`); };

        const verify = async (step: string) => {
          const s = await snap(page);
          lastStep = step;
          const scale = levelIds(cap);
          const ctrl = hasControls(cap);
          const cur = s.current;
          const isAuto = cur === "auto";
          if (!isAuto) shadowLast = cur;
          const newPosts = (await posted(page)).slice(postedSeen);
          postedSeen += newPosts.length;
          for (const value of newPosts) if (!allowed(cap, value)) fail("posted-value-allowed", `posted ${JSON.stringify(value)} (cap ${JSON.stringify(cap)})`);
          if (!allowed(cap, cur)) fail("effective-value-allowed", `currentReasoning=${JSON.stringify(cur)} (cap ${JSON.stringify(cap)})`);
          if (s.btnDisabled !== !ctrl) fail("trigger-disabled-iff-no-controls", `btnDisabled=${s.btnDisabled} ctrl=${ctrl}`);
          if (!ctrl && s.popDisplay !== "none") fail("popover-hidden-without-controls", `display=${s.popDisplay}`);
          if (!ctrl && cur !== "auto") fail("no-controls-means-auto", `current=${JSON.stringify(cur)}`);
          if (JSON.stringify(s.labels.map(l => l.level)) !== JSON.stringify(scale)) fail("rail-labels-match-scale", `labels=${JSON.stringify(s.labels.map(l => l.level))} scale=${JSON.stringify(scale)}`);
          if (s.ticks !== scale.length) fail("tick-count-matches-scale", `ticks=${s.ticks} scale=${scale.length}`);
          if (new Set(s.labels.map(l => l.level)).size !== s.labels.length) fail("labels-unique", "duplicate data-level");
          if (s.autoChecked !== (isAuto ? "true" : "false")) fail("aria-checked-tracks-state", `aria-checked=${s.autoChecked} current=${JSON.stringify(cur)}`);
          if (s.autoOn !== isAuto) fail("switch-on-class-tracks-state", `on=${s.autoOn}`);
          if (cap && ctrl) {
            const restore = isAuto ? restoreTarget(cap, shadowLast) : "n/a";
            const expectDisabled = isAuto && restore === null;
            if (s.autoDisabled !== expectDisabled) fail("auto-disabled-iff-nothing-to-restore", `disabled=${s.autoDisabled} expected=${expectDisabled} last=${JSON.stringify(shadowLast)}`);
          }
          if (s.popAuto !== isAuto || s.btnAuto !== isAuto) fail("is-auto-class", `pop=${s.popAuto} btn=${s.btnAuto} auto=${isAuto}`);
          const isOff = !isAuto && cur === "off";
          if (s.popOff !== isOff || s.btnOff !== isOff) fail("is-off-class", `pop=${s.popOff} btn=${s.btnOff} off=${isOff}`);
          const k = scale.indexOf(cur);
          if (isAuto || isOff) {
            if (s.lit !== "0") fail("glyph-dark-for-auto-and-off", `data-lit=${s.lit} current=${cur}`);
          } else if (ctrl) {
            const bars = Number(s.lit);
            if (!(bars >= 1 && bars <= 4)) fail("glyph-lit-for-active-thinking", `data-lit=${s.lit} current=${JSON.stringify(cur)} scale=${JSON.stringify(scale)}`);
            else if (k >= 0 && k === scale.length - 1 && bars !== 4) fail("glyph-top-level-is-full", `data-lit=${s.lit} current=${cur}`);
          }
          if (k >= 0 && !isAuto) {
            const p = scale.length > 1 ? k / (scale.length - 1) : 1;
            if (Math.abs(parseFloat(s.popP) - p) > 1e-6 || Math.abs(parseFloat(s.btnP) - p) > 1e-6) fail("effort-p-matches-position", `popP=${s.popP} btnP=${s.btnP} expected=${p}`);
            if (s.slider.value !== String(k)) fail("thumb-at-effective-level", `value=${s.slider.value} expected=${k}`);
            const hue = Number(s.popHue);
            if (!(hue >= 195 && hue <= 285) && hue !== 230) fail("hue-in-range", `hue=${s.popHue}`);
            const activeLabels = s.labels.filter(l => l.active).map(l => l.level);
            if (activeLabels.length !== 1 || activeLabels[0] !== cur) fail("exactly-one-active-label", `active=${JSON.stringify(activeLabels)} current=${cur}`);
            const expectLit = scale.map((id, i) => !isOff && id !== "off" && i <= k);
            if (JSON.stringify(s.litTicks) !== JSON.stringify(expectLit)) fail("lit-ticks-match-position", `lit=${JSON.stringify(s.litTicks)} expected=${JSON.stringify(expectLit)}`);
          }
          if (isAuto && s.labels.some(l => l.active)) fail("no-active-label-in-auto", "a label is active while Auto is on");
          if (s.slider.max !== String(Math.max(0, scale.length - 1)) || s.slider.min !== "0") fail("slider-bounds", `min=${s.slider.min} max=${s.slider.max} n=${scale.length}`);
          if (s.slider.disabled !== scale.length < 2) fail("slider-disabled-iff-fewer-than-2", `disabled=${s.slider.disabled} n=${scale.length}`);
          if (Number(s.slider.value) < 0 || Number(s.slider.value) > Math.max(0, scale.length - 1)) fail("slider-value-in-range", `value=${s.slider.value}`);
          if (!s.slider.valuetext) fail("aria-valuetext-present", "empty");
          else if (isAuto && !/Auto/.test(s.slider.valuetext)) fail("aria-valuetext-mentions-auto", s.slider.valuetext);
          else if (!isAuto && s.slider.valuetext !== s.btnLabel) fail("aria-valuetext-equals-label", `${s.slider.valuetext} vs ${s.btnLabel}`);
          if (s.wrapHidden !== scale.length < 2 || s.labelsHidden !== scale.length < 2) fail("rail-hidden-iff-fewer-than-2", `wrap=${s.wrapHidden} labels=${s.labelsHidden} n=${scale.length}`);
          if (s.dense !== scale.length > 6) fail("dense-iff-more-than-6", `dense=${s.dense} n=${scale.length}`);
          if (s.bubble !== (isAuto ? "Auto" : s.btnLabel)) fail("bubble-text", `bubble=${s.bubble} label=${s.btnLabel}`);
          const wantBudgetRow = budgetCapable(cap);
          if (s.budgetRowHidden !== !wantBudgetRow) fail("budget-row-visibility", `hidden=${s.budgetRowHidden} want=${wantBudgetRow}`);
          if (errors.length) fail("no-page-errors", errors.join(" / "));
        };

        const act = async () => {
          const choice = Math.floor(rand() * 9);
          const s = await snap(page);
          const scale = levelIds(cap);
          const ctrl = hasControls(cap);
          switch (choice) {
            case 0: case 1: {
              const name = pick(names); cap = catalogue[name]; modelCounter++; activeId = `m${modelCounter}`;
              ops.push(`switch->${name}`);
              await switchModel(page, activeId, cap);
              return;
            }
            case 2: {
              const effort = pick(effortPool);
              ops.push(`init_state(${JSON.stringify(effort)})`);
              await initModel(page, activeId, cap, effort);
              return;
            }
            case 3: {
              if (!ctrl || s.btnDisabled) return;
              ops.push(s.popDisplay === "none" ? "open" : "close");
              await page.click("#btn-prompt-reasoning", { timeout: 3000 });
              return;
            }
            case 4: case 5: {
              if (!ctrl) return;
              if (s.popDisplay === "none") { ops.push("open"); await page.click("#btn-prompt-reasoning", { timeout: 3000 }); }
              if (scale.length < 2) return;
              const i = Math.floor(rand() * scale.length);
              const label = (await snap(page)).labels[i];
              if (label && label.visible) { ops.push(`label(${scale[i]})`); await page.click(`.reasoning-step-btn[data-level="${scale[i]}"]`, { timeout: 3000 }); }
              else {
                const pt = await page.evaluate((idx: number) => { const t = document.querySelectorAll("#reasoning-slider-ticks .reasoning-tick-point")[idx].getBoundingClientRect(); return [t.left + t.width / 2, t.top + t.height / 2]; }, i);
                ops.push(`track-click(${scale[i]})`);
                await page.mouse.click(pt[0], pt[1]);
              }
              return;
            }
            case 6: {
              if (!ctrl) return;
              if (s.popDisplay === "none") { ops.push("open"); await page.click("#btn-prompt-reasoning", { timeout: 3000 }); }
              if (s.autoDisabled) { ops.push("auto(disabled)"); return; }
              ops.push("auto");
              await page.click("#reasoning-auto", { timeout: 3000 });
              const after = await snap(page);
              if (s.current === "auto" && cap) {
                const want = restoreTarget(cap, shadowLast);
                if (want && want !== "*" && after.current !== want) fail("auto-off-restores-spec-target", `restored ${JSON.stringify(after.current)} expected ${want} last=${JSON.stringify(shadowLast)} default=${cap.default_effort}`);
                if (want === "*" && !scale.includes(after.current)) fail("auto-off-restores-scale-level", `restored ${JSON.stringify(after.current)}`);
              } else if (s.current !== "auto" && after.current !== "auto") fail("auto-on-sets-auto", `current=${after.current}`);
              if (popoverOpenFlag(after) === false) fail("popover-stays-open-after-auto", `display=${after.popDisplay}`);
              return;
            }
            case 7: {
              if (!ctrl || s.slider.disabled || s.popDisplay === "none") return;
              const key = pick(["ArrowLeft", "ArrowRight", "Home", "End"]);
              ops.push(`key(${key})`);
              await page.focus("#reasoning-slider-range");
              const before = Number(s.slider.value);
              await page.keyboard.press(key);
              const after = await snap(page);
              const moved = Number(after.slider.value) - before;
              if (key === "ArrowRight" && before < scale.length - 1 && s.current !== "auto" && moved !== 1) fail("arrow-moves-one-step", `moved ${moved} from ${before}`);
              if (key === "ArrowLeft" && before > 0 && s.current !== "auto" && moved !== -1) fail("arrow-moves-one-step", `moved ${moved} from ${before}`);
              return;
            }
            default: {
              if (!ctrl || s.budgetRowHidden || !cap || s.popDisplay === "none") return;
              const lo = cap.budget_min, hi = cap.budget_max;
              const raw = pick([String(lo - 1), String(lo), String(Math.floor((lo + hi) / 2)), String(hi), String(hi + 1), "", "1.5", "1e2", "-1", "0", "abc"]);
              ops.push(`apply(${raw})`);
              await page.evaluate((value: string) => { (document.getElementById("reasoning-budget-input") as HTMLInputElement).value = value; (document.getElementById("reasoning-budget-apply") as HTMLButtonElement).click(); }, raw);
              return;
            }
          }
        };
        const popoverOpenFlag = (x: Snap) => x.popDisplay !== "none";

        cap = null;
        await initModel(page, "m", null, "auto");
        await verify("start");
        for (let i = 0; i < 320; i++) {
          await act();
          await verify(`step ${i}`);
        }
        const summary = [...failures.entries()].map(([name, detail]) => `${name}: ${detail}`);
        assert.deepEqual(summary, [], `last step ${lastStep}\n` + summary.join("\n"));
      } finally { await context.close(); }
    });
  }

  it("clicking a tick label or the Auto switch keeps the popover open; outside click and Escape close it", { timeout: 60000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark");
    try {
      await initModel(page, "m", catalogue.three, "medium");
      await page.click("#btn-prompt-reasoning");
      assert.equal((await snap(page)).active, "reasoning-slider-range");
      for (const level of ["low", "high", "medium"]) {
        await page.click(`.reasoning-step-btn[data-level="${level}"]`);
        assert.equal(await popoverOpen(page), true, `closed after clicking ${level}`);
      }
      await page.click("#reasoning-auto");
      assert.equal(await popoverOpen(page), true);
      await page.click("#reasoning-auto .reasoning-auto-switch");
      assert.equal(await popoverOpen(page), true);
      await page.click("#reasoning-hint");
      assert.equal(await popoverOpen(page), true);
      await page.keyboard.press("Escape");
      assert.equal(await popoverOpen(page), false);
      assert.equal((await snap(page)).ariaExpanded, "false");
      await page.click("#btn-prompt-reasoning");
      await page.click("#prompt-input");
      assert.equal(await popoverOpen(page), false);
      await page.click("#btn-prompt-reasoning");
      await page.click("#btn-prompt-reasoning");
      assert.equal(await popoverOpen(page), false);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("dragging the thumb and releasing outside the popover leaves it open", { timeout: 60000 }, async () => {
    const { page, context } = await newPage(browser, "dark");
    try {
      await initModel(page, "m", catalogue.eight, "low");
      await page.click("#btn-prompt-reasoning");
      const thumb = await page.evaluate(() => { const r = document.getElementById("reasoning-slider-range")!.getBoundingClientRect(); return [r.left + 9 + (r.width - 18) * (Number((document.getElementById("reasoning-slider-range") as HTMLInputElement).value) / 7), r.top + r.height / 2]; });
      await page.mouse.move(thumb[0], thumb[1]);
      await page.mouse.down();
      await page.mouse.move(thumb[0] + 60, thumb[1] + 5);
      await page.mouse.move(thumb[0] + 60, 20);
      await page.mouse.up();
      assert.equal(await popoverOpen(page), true, "popover closed after a drag released outside it");
    } finally { await context.close(); }
  });

  it("keyboard arrows move exactly one step and aria state stays correct", { timeout: 60000 }, async () => {
    const { page, context } = await newPage(browser, "light");
    try {
      await initModel(page, "m", catalogue.eight, "medium");
      await page.click("#btn-prompt-reasoning");
      const order = levelIds(catalogue.eight);
      const idx = () => page.evaluate(() => Number((document.getElementById("reasoning-slider-range") as HTMLInputElement).value));
      assert.equal(await idx(), order.indexOf("medium"), "initial thumb index");
      await page.keyboard.press("ArrowRight");
      assert.equal(await idx(), order.indexOf("medium") + 1, "after ArrowRight");
      await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
      assert.equal(await idx(), order.indexOf("medium") - 1, "after two ArrowLeft");
      const s = await snap(page);
      assert.equal(s.slider.valuetext, s.btnLabel);
      assert.equal(s.autoChecked, "false");
      assert.equal((await posted(page)).every(v => order.includes(v)), true);
      await page.keyboard.press("Tab");
      const focusAfterTab = await page.evaluate(() => (document.activeElement as HTMLElement).id);
      assert.ok(focusAfterTab, "Tab from the slider must land on an identifiable control");
    } finally { await context.close(); }
  });

  it("Auto on keeps a visible thumb; clicking the ghost thumb position or its label leaves Auto", { timeout: 60000 }, async () => {
    const { page, context } = await newPage(browser, "dark");
    try {
      await initModel(page, "m", catalogue.three, "auto");
      await page.click("#btn-prompt-reasoning");
      const before = await snap(page);
      assert.equal(before.current, "auto");
      const k = Number(before.slider.value);
      const pt = await page.evaluate((idx: number) => { const t = document.querySelectorAll("#reasoning-slider-ticks .reasoning-tick-point")[idx].getBoundingClientRect(); return [t.left + t.width / 2, t.top + t.height / 2]; }, k);
      await page.mouse.click(pt[0], pt[1]);
      const after = await snap(page);
      assert.notEqual(after.current, "auto", "clicking the Auto ghost level on the rail leaves Auto selected");
    } finally { await context.close(); }
  });

  it("init_state with hostile reasoningEffort values is coerced to the active model's set", { timeout: 120000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark");
    try {
      const caps: [string, Cap][] = [["budgetZero", catalogue.budgetZero!], ["three", catalogue.three!], ["mandatory", catalogue.mandatory!], ["budgetLevels", catalogue.budgetLevels!]];
      const failures: string[] = [];
      for (const [name, cap] of caps) {
        for (const effort of ["xhigh", "budget:5", "budget:99999", "budget:0", "off", "none", "__proto__", "constructor", ["budget:5"], ["high"], { id: "high" }, 7, true, "budget:007", "budget:5\n", " low", "LOW"]) {
          await initModel(page, "m", cap, effort);
          const s = await snap(page);
          if (!allowed(cap, s.current)) failures.push(`${name}: init effort ${JSON.stringify(effort)} left currentReasoning=${JSON.stringify(s.current)}`);
          if (typeof s.current !== "string") failures.push(`${name}: init effort ${JSON.stringify(effort)} left a ${typeof s.current}`);
        }
      }
      assert.deepEqual(failures, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("a malformed capability must not throw out of the init_state handler (session list still renders)", { timeout: 60000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark");
    try {
      await page.evaluate(() => (window as any).__send({
        type: "init_state", sessionId: "s1", model: "m", provider: "p", models: [], modelReasoningCapability: { supported_efforts: "high" }, reasoningEffort: "medium",
        workspaceName: "MARKER_WS", sessions: [{ id: "s1", name: "MARKER_SESS" }],
      }));
      const name = await page.evaluate(() => document.getElementById("active-session-name")!.textContent);
      assert.deepEqual(errors, []);
      assert.match(name || "", /MARKER_SESS/);
    } finally { await context.close(); }
  });

  it("untrusted ids never become DOM: no elements, no handlers, no stray attributes", { timeout: 60000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark");
    try {
      const ids = ["<img src=x onerror=window.__pwn=1>", "\"><svg onload=window.__pwn=2>", "' onmouseover='window.__pwn=3", "javascript:window.__pwn=4", "low"];
      await initModel(page, "m", { supported_efforts: ids, default_effort: ids[0] }, "auto");
      await page.click("#btn-prompt-reasoning");
      const info = await page.evaluate(() => ({
        pwn: (window as any).__pwn,
        extra: document.querySelectorAll("#reasoning-popover img, #reasoning-popover svg, #reasoning-popover script, #reasoning-popover iframe").length,
        attrs: [...new Set(Array.from(document.querySelectorAll("#reasoning-slider-labels button")).flatMap(b => b.getAttributeNames()))].sort(),
        levels: Array.from(document.querySelectorAll("#reasoning-slider-labels button")).map(b => b.getAttribute("data-level")),
        texts: Array.from(document.querySelectorAll("#reasoning-slider-labels button")).map(b => b.textContent),
        title: document.getElementById("btn-prompt-reasoning")!.title,
      }));
      assert.equal(info.pwn, undefined);
      assert.equal(info.extra, 0);
      assert.deepEqual(info.attrs, ["class", "data-level", "style", "tabindex", "type"]);
      assert.deepEqual([...info.levels].sort(), [...ids].sort());
      for (const button of await page.$$("#reasoning-slider-labels button")) await button.dispatchEvent("click");
      await page.mouse.move(10, 10);
      assert.equal(await page.evaluate(() => (window as any).__pwn), undefined);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("a 300-level catalogue renders, stays dense and does not overflow or hang the page", { timeout: 90000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark", { width: 320 });
    try {
      const levels = Array.from({ length: 300 }, (_, i) => `lv${i}`);
      const baseline = (await snap(page)).scrollW;
      const started = Date.now();
      await initModel(page, "m", { supported_efforts: levels }, "lv150");
      await page.click("#btn-prompt-reasoning");
      const s = await snap(page);
      assert.ok(Date.now() - started < 5000, "rendering took too long");
      assert.equal(s.labels.length, 300);
      assert.equal(s.dense, true);
      assert.equal(s.labels.filter(l => l.visible).length, 1);
      assert.ok(s.scrollW <= Math.max(s.vw, baseline), `horizontal overflow ${s.scrollW} > ${Math.max(s.vw, baseline)}`);
      const geometry = await page.evaluate(() => {
        const ticks = Array.from(document.querySelectorAll("#reasoning-slider-ticks .reasoning-tick-point")).map(t => t.getBoundingClientRect());
        const pop = document.getElementById("reasoning-popover")!.getBoundingClientRect();
        return { inside: ticks.every(t => t.left >= pop.left && t.right <= pop.right), pop: pop.width };
      });
      assert.equal(geometry.inside, true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("an extremely long level id cannot widen the page or push the popover out of the viewport", { timeout: 60000 }, async () => {
    for (const label of ["x".repeat(5000), "an_unusually_long_level_name_from_a_catalog"]) {
      const { page, context } = await newPage(browser, "dark", { width: 320 });
      try {
        const baseline = (await snap(page)).scrollW;
        await initModel(page, "m", { supported_efforts: [label, "low"] }, label);
        await page.click("#btn-prompt-reasoning");
        const geo = await page.evaluate(() => {
          const pop = document.getElementById("reasoning-popover")!.getBoundingClientRect();
          const out = (r: DOMRect) => r.left < pop.left - 0.5 || r.right > pop.right + 0.5;
          return {
            popLeft: pop.left, popRight: pop.right, vw: window.innerWidth, scrollW: document.documentElement.scrollWidth,
            bubbleOut: out(document.getElementById("reasoning-bubble")!.getBoundingClientRect()),
            labelsOut: Array.from(document.querySelectorAll(".reasoning-step-btn")).some(b => out(b.getBoundingClientRect())),
            hintOut: out(document.getElementById("reasoning-hint")!.getBoundingClientRect()),
          };
        });
        assert.ok(geo.popLeft >= 0 && geo.popRight <= geo.vw, `popover outside viewport for ${label.length}-char id`);
        assert.ok(geo.scrollW <= Math.max(geo.vw, baseline), `page widened to ${geo.scrollW} (limit ${Math.max(geo.vw, baseline)}) by a ${label.length}-char id`);
        assert.equal(geo.bubbleOut, false, `bubble leaves the popover for a ${label.length}-char id`);
        assert.equal(geo.labelsOut, false, `labels leave the popover for a ${label.length}-char id`);
      } finally { await context.close(); }
    }
  });

  it("budget on a level scale without 'on': thumb, glyph and rail reflect the budget", { timeout: 60000, todo: "product decision: a token count has no position on a Low/Medium/High rail, so the rail dims and the bubble shows the tokens" }, async () => {
    const { page, context } = await newPage(browser, "dark");
    try {
      await initModel(page, "m", catalogue.budgetLevels, "high");
      await page.click("#btn-prompt-reasoning");
      await page.evaluate(() => { (document.getElementById("reasoning-budget-input") as HTMLInputElement).value = "4096"; (document.getElementById("reasoning-budget-apply") as HTMLButtonElement).click(); });
      const s = await snap(page);
      assert.equal(s.current, "budget:4096");
      assert.notEqual(s.lit, "0", "glyph shows no bars while a token budget is active");
      assert.notEqual(s.slider.value, "0", "thumb sits on the lowest level while a 4096-token budget is active");
    } finally { await context.close(); }
  });

  it("budget apply: only in-range integers are posted and normalised", { timeout: 60000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark");
    try {
      const cap = catalogue.budgetOn!;
      await initModel(page, "m", cap, "auto");
      await page.click("#btn-prompt-reasoning");
      for (const raw of ["", "1023", "1024", "8191", "8192", "1e3", "2e3", "2048.0", "2048.5", "-0", "0", "007", "1e400", "9".repeat(30), "\u0661\u0662\u0663", "2048e0"]) {
        await page.evaluate((value: string) => { (document.getElementById("reasoning-budget-input") as HTMLInputElement).value = value; (document.getElementById("reasoning-budget-apply") as HTMLButtonElement).click(); }, raw);
      }
      const values = await posted(page);
      assert.ok(values.length > 0);
      for (const v of values) assert.equal(allowed(cap, v), true, `posted ${JSON.stringify(v)}`);
      for (const v of values) assert.match(v, /^budget:[1-9][0-9]*$/);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("Auto switch round trip with real clicks, across a model switch", { timeout: 60000 }, async () => {
    const { page, context } = await newPage(browser, "dark");
    try {
      await initModel(page, "m", { supported_efforts: ["low", "medium", "high", "max"], default_effort: "auto" }, "auto");
      await page.click("#btn-prompt-reasoning");
      await page.click('.reasoning-step-btn[data-level="max"]');
      await page.click("#reasoning-auto");
      assert.equal((await snap(page)).current, "auto");
      const next = { supported_efforts: ["low", "medium"], default_effort: "low" };
      await switchModel(page, "m2", next);
      await page.click("#reasoning-auto");
      const s = await snap(page);
      assert.equal(s.current, "low");
      for (const v of await posted(page)) if (v === "max") assert.equal((await posted(page)).indexOf(v), 0);
      assert.equal(s.popDisplay !== "none", true);
    } finally { await context.close(); }
  });

  it("pickModel and provider changes keep the effective value inside the new model's set", { timeout: 120000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark");
    try {
      const withMode = (cap: Cap | null) => (cap ? Object.assign({ mode: "configurable" }, cap) : undefined);
      const targets: [string, Cap | null][] = [["three", catalogue.three], ["noneDefault", catalogue.noneDefault], ["budgetOn", catalogue.budgetOn], ["mandatory", catalogue.mandatory], ["single", catalogue.single], ["empty", catalogue.empty], ["proto", catalogue.proto], ["budgetZero", catalogue.budgetZero]];
      const models = [{ id: "start", provider: "p", name: "Start", reasoning: withMode(catalogue.eight) }, ...targets.map(([id, cap]) => ({ id, provider: "p", name: id, reasoning: withMode(cap) })), { id: "ghost", provider: "p", name: "Ghost" }];
      const failures: string[] = [];
      for (const before of ["off", "xhigh", "auto", "high", "budget:2048", "max", "ultra"]) {
        for (const [target, cap] of [...targets, ["ghost", null] as [string, Cap | null]]) {
          await page.evaluate(([list, effort]: any) => (window as any).__send({ type: "init_state", sessionId: "s1", model: "start", provider: "p", models: list, reasoningEffort: effort }), [models, before]);
          const mark = (await posted(page)).length;
          await page.evaluate((id: string) => (window as any).pickModel(id, "p"), target);
          const s = await snap(page);
          if (!allowed(cap, s.current)) failures.push(`${before} -> ${target}: currentReasoning=${JSON.stringify(s.current)}`);
          for (const value of (await posted(page)).slice(mark)) if (!allowed(cap, value)) failures.push(`${before} -> ${target}: posted ${JSON.stringify(value)}`);
          if (s.btnDisabled !== !hasControls(cap)) failures.push(`${before} -> ${target}: trigger disabled=${s.btnDisabled}`);
        }
      }
      await page.evaluate((list: any) => (window as any).__send({ type: "init_state", sessionId: "s1", model: "start", provider: "p", models: list, reasoningEffort: "high" }), models);
      await page.evaluate(() => (window as any).__send({ type: "config_updated", key: "provider", value: "other" }));
      const orphan = await snap(page);
      if (!orphan.btnDisabled || orphan.current !== "auto") failures.push(`provider switch to a provider with no models left controls enabled / current=${JSON.stringify(orphan.current)}`);
      assert.deepEqual(failures, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("after clicking a tick label or the Auto switch the arrow keys still drive the slider", { timeout: 60000, todo: "product decision: focus stays on the Auto switch after it is toggled; Tab reaches the slider" }, async () => {
    const { page, context } = await newPage(browser, "dark");
    try {
      await initModel(page, "m", catalogue.three, "medium");
      await page.click("#btn-prompt-reasoning");
      await page.click('.reasoning-step-btn[data-level="low"]');
      await page.keyboard.press("ArrowRight");
      assert.equal((await snap(page)).current, "medium", "ArrowRight did nothing after a label click (focus stayed on the label button)");
      await page.click("#reasoning-auto");
      await page.click("#reasoning-auto");
      await page.keyboard.press("ArrowLeft");
      const s = await snap(page);
      assert.notEqual(s.active, "reasoning-auto", "focus stayed on the Auto switch, so the arrow keys cannot reach the slider");
    } finally { await context.close(); }
  });

  for (const theme of ["dark", "light"] as const) {
    it(`rail labels stay legible while Auto dims them (${theme}); they remain clickable`, { timeout: 60000 }, async () => {
      const { page, context } = await newPage(browser, theme);
      try {
        await initModel(page, "m", catalogue.three, "auto");
        await page.click("#btn-prompt-reasoning");
        await page.waitForTimeout(450);
        const ratio = await page.evaluate(() => {
          const parse = (css: string) => (css.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
          const lum = ([r, g, b]: number[]) => { const f = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const opacity = Number(getComputedStyle(document.getElementById("reasoning-slider-labels")!).opacity);
          const fg = parse(getComputedStyle(document.querySelector(".reasoning-step-btn")!).color);
          const bg = parse(getComputedStyle(document.getElementById("reasoning-popover")!).backgroundColor);
          const eff = fg.map((v, i) => v * opacity + bg[i] * (1 - opacity));
          const a = lum(eff), d = lum(bg);
          return (Math.max(a, d) + 0.05) / (Math.min(a, d) + 0.05);
        });
        assert.ok(ratio >= 3, `effective contrast of the clickable tick labels in Auto is ${ratio.toFixed(2)}:1`);
      } finally { await context.close(); }
    });
  }

  for (const theme of ["dark", "light"] as const) {
    it(`layout (${theme}): popover inside viewport 260-700px, labels centred under ticks, no overlap, dense above 6 steps`, { timeout: 180000 }, async () => {
      const { page, context } = await newPage(browser, theme, { reducedMotion: "reduce" });
      try {
        const all = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
        const problems: string[] = [];
        await initModel(page, "m", { supported_efforts: ["low", "high"] }, "low");
        await page.click("#btn-prompt-reasoning");
        for (const width of [260, 300, 340, 400, 500, 600, 700]) {
          await page.setViewportSize({ width, height: 800 });
          for (let n = 2; n <= 8; n++) {
            const levels = n === 8 ? all : all.slice(all.length - n);
            await initModel(page, "m", { supported_efforts: levels }, levels[0]);
            const baselineScroll = await page.evaluate(() => { const p = document.getElementById("reasoning-popover")!; const d = p.style.display; p.style.display = "none"; const w = document.documentElement.scrollWidth; p.style.display = d; return w; });
            const m = await page.evaluate(() => {
              const pop = document.getElementById("reasoning-popover")!.getBoundingClientRect();
              const labels = Array.from(document.querySelectorAll<HTMLElement>(".reasoning-step-btn"));
              const ticks = Array.from(document.querySelectorAll<HTMLElement>(".reasoning-tick-point"));
              const offs = labels.map((l, i) => { const a = l.getBoundingClientRect(), t = ticks[i].getBoundingClientRect(); return Math.abs(a.left + a.width / 2 - (t.left + t.width / 2)); });
              const visible = labels.filter(l => getComputedStyle(l).visibility !== "hidden");
              const rects = visible.map(l => l.getBoundingClientRect());
              let overlaps = 0;
              for (let i = 1; i < rects.length; i++) if (rects[i].left < rects[i - 1].right) overlaps++;
              return {
                popLeft: pop.left, popRight: pop.right, vw: window.innerWidth, sw: document.documentElement.scrollWidth, maxOff: Math.max(...offs), overlaps,
                hiddenCount: labels.length - visible.length, labelCount: labels.length,
                labelsInside: labels.every(l => { const r = l.getBoundingClientRect(); return r.left >= pop.left && r.right <= pop.right; }),
              };
            });
            const tag = `${theme} w=${width} n=${n}`;
            if (m.popLeft < 0) problems.push(`${tag}: popover clipped on the left (${m.popLeft})`);
            if (m.popRight > m.vw + 0.5) problems.push(`${tag}: popover clipped on the right`);
            if (m.sw > Math.max(m.vw, baselineScroll)) problems.push(`${tag}: horizontal overflow ${m.sw}`);
            if (m.maxOff > 1) problems.push(`${tag}: label off tick by ${m.maxOff.toFixed(2)}px`);
            if (m.overlaps) problems.push(`${tag}: ${m.overlaps} overlapping labels`);
            if (!m.labelsInside) problems.push(`${tag}: a label leaves the popover`);
            if (n > 6 ? m.hiddenCount !== n - 1 : m.hiddenCount !== 0) problems.push(`${tag}: ${m.hiddenCount} labels hidden of ${n}`);
          }
        }
        assert.deepEqual(problems, []);
      } finally { await context.close(); }
    });

    it(`bubble stays inside the popover at every step (${theme}, labels from real ids and budgets)`, { timeout: 120000 }, async () => {
      const { page, context } = await newPage(browser, theme, { width: 260, reducedMotion: "reduce" });
      try {
        const problems: string[] = [];
        const scenarios: [string, Cap][] = [
          ["standard 3", { supported_efforts: ["low", "medium", "high"] }],
          ["xhigh first", { supported_efforts: ["xhigh", "max", "ultra"] }],
          ["medium first", { supported_efforts: ["medium", "high", "xhigh", "max", "ultra"] }],
          ["minimal first", { supported_efforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }],
          ["budget off/on", { supported_efforts: ["off", "on"], supports_max_tokens: true, request_format: "google_budget", budget_min: 0, budget_max: 24576 }],
        ];
        await initModel(page, "m", scenarios[0][1], "low");
        await page.click("#btn-prompt-reasoning");
        for (const [name, cap] of scenarios) {
          const scale = levelIds(cap);
          const values = [...scale, ...(budgetCapable(cap) ? ["budget:24576", "budget:128"] : [])];
          for (const value of values) {
            await initModel(page, "m", cap, value);
            const r = await page.evaluate(() => {
              const pop = document.getElementById("reasoning-popover")!.getBoundingClientRect();
              const b = document.getElementById("reasoning-bubble")!.getBoundingClientRect();
              return { left: b.left - pop.left, right: pop.right - b.right };
            });
            if (r.left < 0 || r.right < 0) problems.push(`${name} @ ${value}: bubble leaves the popover (left ${r.left.toFixed(1)}px, right ${r.right.toFixed(1)}px)`);
          }
        }
        assert.deepEqual(problems, []);
      } finally { await context.close(); }
    });

    it(`bubble text meets WCAG AA contrast (${theme}) at every step of an 8-level scale`, { timeout: 120000 }, async () => {
      const { page, context } = await newPage(browser, theme, { reducedMotion: "reduce" });
      try {
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
        const failures: string[] = [];
        for (const count of [2, 3, 5, 8]) {
          const scale = count === 8 ? levels : levels.slice(levels.length - count);
          for (const value of scale) {
            await initModel(page, "m", { supported_efforts: scale }, value);
            await page.click("#btn-prompt-reasoning").catch(() => undefined);
            const ratio = await page.evaluate(() => {
              const parse = (css: string) => (css.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
              const lum = ([r, g, b]: number[]) => { const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
              const el = document.getElementById("reasoning-bubble")!;
              const cs = getComputedStyle(el);
              const a = lum(parse(cs.color)), b = lum(parse(cs.backgroundColor));
              return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            });
            if (ratio < 4.5) failures.push(`${theme} n=${count} value=${value}: contrast ${ratio.toFixed(2)}:1`);
          }
        }
        assert.deepEqual(failures, []);
      } finally { await context.close(); }
    });
  }

  it("fill end and the native thumb centre agree within 1px at every step (2..8 levels, 260 and 400px, both themes)", { timeout: 300000 }, async () => {
    const problems: string[] = [];
    const all = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    const helper = await browser.newPage();
    const thumbCentre = async (png: Buffer, rowY: number, offsetX: number): Promise<number | null> => {
      const data = png.toString("base64");
      const run: { start: number; len: number } = await helper.evaluate(async ([b64, y]: [string, number]) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const row = ctx.getImageData(0, y, img.width, 1).data;
        let best = { start: -1, len: 0 }, start = -1;
        for (let x = 0; x <= img.width; x++) {
          const white = x < img.width && row[x * 4] >= 250 && row[x * 4 + 1] >= 250 && row[x * 4 + 2] >= 250;
          if (white && start < 0) start = x;
          if (!white && start >= 0) { if (x - start > best.len) best = { start, len: x - start }; start = -1; }
        }
        return best;
      }, [data, rowY]);
      return run.len >= 8 ? offsetX + run.start + run.len / 2 : null;
    };
    try {
      for (const theme of ["dark", "light"] as const) {
        const { page, context } = await newPage(browser, theme, { reducedMotion: "reduce" });
        try {
          await initModel(page, "m", { supported_efforts: ["low", "high"] }, "low");
          await page.click("#btn-prompt-reasoning");
          for (const width of [260, 340, 400, 700]) {
            await page.setViewportSize({ width, height: 800 });
            for (let n = 2; n <= 8; n++) {
              const levels = n === 8 ? all : all.slice(all.length - n);
              const centres = new Set<number>();
              for (let step = 0; step < n; step++) {
                await initModel(page, "m", { supported_efforts: levels }, levels[step]);
                await page.mouse.move(2, 2);
                const g = await page.evaluate(() => {
                  const r = document.getElementById("reasoning-slider-range")!.getBoundingClientRect();
                  const f = document.getElementById("reasoning-slider-fill")!.getBoundingClientRect();
                  const p = parseFloat(document.getElementById("reasoning-popover")!.style.getPropertyValue("--effort-p"));
                  return { x: r.left, y: r.top, w: r.width, h: r.height, fillEnd: f.left + f.width * p };
                });
                const x0 = Math.floor(g.x), y0 = Math.floor(g.y);
                const png: Buffer = await page.screenshot({ clip: { x: x0, y: y0, width: Math.ceil(g.w) + 2, height: Math.ceil(g.h) + 2 } });
                const centre = await thumbCentre(png, Math.round(g.h / 2) + (g.y - y0 > 0 ? Math.round(g.y - y0) : 0), x0);
                const tag = `${theme} w=${width} n=${n} step=${step}`;
                if (centre === null) problems.push(`${tag}: thumb not found in pixels`);
                else if (Math.abs(centre - g.fillEnd) > 1) problems.push(`${tag}: thumb centre ${centre.toFixed(2)} vs fill end ${g.fillEnd.toFixed(2)}`);
                if (centre !== null) centres.add(Math.round(centre));
              }
              if (centres.size !== n) problems.push(`${theme} w=${width} n=${n}: pixel scan saw ${centres.size} distinct thumb positions (scan is not tracking the thumb)`);
            }
          }
        } finally { await context.close(); }
      }
      assert.deepEqual(problems.slice(0, 12), [], `${problems.length} mismatches`);
    } finally { await helper.close(); }
  });

  it("prefers-reduced-motion: no popover animation and no running transitions on the switch knob or thumb", { timeout: 60000 }, async () => {
    const { page, context } = await newPage(browser, "dark", { reducedMotion: "reduce" });
    try {
      await initModel(page, "m", catalogue.three, "medium");
      await page.click("#btn-prompt-reasoning");
      const r = await page.evaluate(() => {
        const dur = (el: Element, pseudo?: string) => getComputedStyle(el, pseudo).transitionDuration.split(",").map((x: string) => x.trim());
        return {
          anim: getComputedStyle(document.getElementById("reasoning-popover")!).animationName,
          knob: dur(document.querySelector(".reasoning-auto-switch")!, "::after"),
          thumb: dur(document.getElementById("reasoning-slider-range")!, "::-webkit-slider-thumb"),
          glyph: dur(document.querySelector(".effort-glyph i")!),
        };
      });
      assert.equal(r.anim, "none");
      assert.ok(r.knob.every((d: string) => d === "0s"), `switch knob transitions ${r.knob}`);
      assert.ok(r.thumb.every((d: string) => d === "0s"), `thumb transitions ${r.thumb}`);
      assert.ok(r.glyph.every((d: string) => d === "0s"), `glyph transitions ${r.glyph}`);
    } finally { await context.close(); }
  });

  it("forced-colors: the Auto state and the rail stay distinguishable without colour", { timeout: 60000 }, async () => {
    const { page, context } = await newPage(browser, "dark", { forcedColors: "active" });
    try {
      await initModel(page, "m", catalogue.three, "medium");
      await page.click("#btn-prompt-reasoning");
      await page.mouse.move(2, 2);
      const probe = async () => page.evaluate(() => {
        const pop = getComputedStyle(document.getElementById("reasoning-popover")!);
        const visible = (el: Element, pseudo?: string) => {
          const cs = getComputedStyle(el, pseudo);
          const bgVisible = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== pop.backgroundColor && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\.\d+\)/.test(cs.backgroundColor);
          const borderVisible = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
          const outlineVisible = parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== "none";
          return bgVisible || borderVisible || outlineVisible || cs.backgroundImage !== "none";
        };
        return {
          matches: matchMedia("(forced-colors: active)").matches,
          track: visible(document.querySelector(".reasoning-slider-track")!),
          tick: visible(document.querySelector(".reasoning-tick-point")!),
          switchTrack: visible(document.querySelector(".reasoning-auto-switch")!),
          switchKnob: visible(document.querySelector(".reasoning-auto-switch")!, "::after"),
        };
      });
      const r = await probe();
      assert.equal(r.matches, true);
      assert.ok(r.track, "rail track is invisible in forced-colors mode");
      assert.ok(r.tick, "tick dots are invisible in forced-colors mode");
      assert.ok(r.switchTrack, "Auto switch track is invisible in forced-colors mode");
    } finally { await context.close(); }
  });

  it("no thinking controls: trigger is hidden, popover cannot be opened by click, keyboard or Escape-toggle", { timeout: 60000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark");
    try {
      await initModel(page, "m", catalogue.three, "high");
      await page.click("#btn-prompt-reasoning");
      assert.equal(await popoverOpen(page), true);
      await switchModel(page, "m2", { supported_efforts: [] });
      let s = await snap(page);
      assert.equal(s.popDisplay, "none");
      assert.equal(s.btnDisabled, true);
      assert.equal(s.ariaExpanded, "false");
      await page.evaluate(() => (document.getElementById("btn-prompt-reasoning") as HTMLButtonElement).click());
      await page.evaluate(() => { const b = document.getElementById("btn-prompt-reasoning") as HTMLButtonElement; b.disabled = false; b.click(); });
      s = await snap(page);
      assert.equal(s.popDisplay, "none", "popover opened for a model without controls after the button was force-clicked");
      await switchModel(page, "m3", null);
      s = await snap(page);
      assert.equal(s.btnDisabled, true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("repeated model churn leaves one rail, correct glyph and no stale classes (deterministic sequence)", { timeout: 120000 }, async () => {
    const { page, context, errors } = await newPage(browser, "dark");
    try {
      const order = ["three", "eight", "onoff", "budgetOn", "noData", "single", "eight", "three", "mandatory", "budgetOnly", "eight", "onlyOff", "three"];
      for (let round = 0; round < 6; round++) {
        for (const name of order) {
          const cap = catalogue[name];
          await switchModel(page, `${name}-${round}`, cap);
          const s = await snap(page);
          const scale = levelIds(cap);
          assert.deepEqual(s.labels.map(l => l.level), scale, `${name} round ${round}`);
          assert.equal(s.ticks, scale.length);
          assert.equal(allowed(cap, s.current), true, `${name} round ${round}: ${JSON.stringify(s.current)}`);
          if (s.current === "auto" || s.current === "off") assert.equal(s.lit, "0", `${name} round ${round}`);
          assert.equal(s.btnAuto, s.current === "auto");
          assert.equal(s.btnOff, s.current === "off");
        }
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
