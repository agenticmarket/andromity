import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

// Adversarial tests for a chat view that attaches to a session while a turn is running.
// They drive the real webview script on a small DOM with a fixed clock and hand-ticked timers.

const Module = require("module");
const originalRequire = Module.prototype.require;
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  Uri: { joinPath: (...parts: any[]) => ({ fsPath: parts.map(p => typeof p === "object" ? p.fsPath : String(p)).join("/") }) },
};
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeStub;
  return originalRequire.apply(this, arguments as any);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
const { getChatActivityScript } = require("../src/providers/chatview/chatActivityRow.js");
Module.prototype.require = originalRequire;

const STATE = {
  currentSessionId: "s", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
};

// ── A small DOM: enough tree, selectors, events and markup parsing to run the chat webview's own code ───────────

function stub(): any {
  const fn: any = function () { return stub(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "length") return 0;
      if (prop === "then") return undefined;
      return stub();
    },
    set: () => true,
  });
}

type Listener = { fn: Function; capture: boolean };
type Compound = { tag?: string; id?: string; classes: string[]; attrs: Array<{ name: string; value?: string }>; nots: Compound[]; never?: boolean };
type Part = { compound: Compound; combinator: " " | ">" };

function splitTop(text: string, separator: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", current = "";
  for (const ch of text) {
    if (quote) { current += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && separator(ch)) { out.push(current); current = ""; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

function parseCompound(text: string): Compound {
  const compound: Compound = { classes: [], attrs: [], nots: [] };
  let rest = text.trim();
  const tag = /^(\*|[a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (tag) { if (tag[1] !== "*") compound.tag = tag[1].toUpperCase(); rest = rest.slice(tag[0].length); }
  while (rest) {
    let m: RegExpExecArray | null;
    if ((m = /^#([\w-]+)/.exec(rest))) compound.id = m[1];
    else if ((m = /^\.([\w-]+)/.exec(rest))) compound.classes.push(m[1]);
    else if ((m = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/.exec(rest))) {
      compound.attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] });
    } else if ((m = /^:not\(/.exec(rest))) {
      let depth = 1, i = m[0].length;
      for (; i < rest.length && depth; i++) { if (rest[i] === "(") depth++; if (rest[i] === ")") depth--; }
      compound.nots.push(parseCompound(rest.slice(m[0].length, i - 1)));
      rest = rest.slice(i);
      continue;
    } else if ((m = /^:[\w-]+(\([^)]*\))?/.exec(rest))) compound.never = true;
    else throw new Error("unsupported selector: " + text);
    rest = rest.slice(m[0].length);
  }
  return compound;
}

function parseSelector(selector: string): Part[][] {
  return splitTop(selector, ch => ch === ",").map(group => {
    const parts: Part[] = [];
    let combinator: " " | ">" = " ";
    for (const token of splitTop(group.replace(/\s*>\s*/g, " > "), ch => /\s/.test(ch)).filter(Boolean)) {
      if (token === ">") { combinator = ">"; continue; }
      parts.push({ compound: parseCompound(token), combinator });
      combinator = " ";
    }
    return parts;
  });
}

function matchesCompound(el: FakeElement, c: Compound): boolean {
  if (!(el instanceof FakeElement) || el.tagName.startsWith("#")) return false;
  if (c.never) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  if (c.classes.some(cls => !el.classList.contains(cls))) return false;
  for (const attr of c.attrs) {
    if (!el.hasAttribute(attr.name)) return false;
    if (attr.value !== undefined && el.getAttribute(attr.name) !== attr.value) return false;
  }
  return !c.nots.some(not => matchesCompound(el, not));
}

function matchesParts(el: FakeElement, parts: Part[], index: number): boolean {
  if (!matchesCompound(el, parts[index].compound)) return false;
  if (index === 0) return true;
  if (parts[index].combinator === ">") return !!el.parentNode && matchesParts(el.parentNode, parts, index - 1);
  for (let p = el.parentNode; p; p = p.parentNode) if (matchesParts(p, parts, index - 1)) return true;
  return false;
}

const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link", "source", "wbr"]);

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&times;/g, "×").replace(/&amp;/g, "&");
}

class FakeElement {
  [key: string]: any;
  tagName: string;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  listeners: Record<string, Listener[]> = {};
  attrs = new Map<string, string>();
  ownText = "";
  markup = "";
  value = "";
  disabled = false;
  checked = false;
  scrollHeight = 20; scrollTop = 0; scrollWidth = 0; clientHeight = 100; clientWidth = 100; offsetWidth = 0; offsetHeight = 0;
  selectionStart = 0; selectionEnd = 0;
  style: any;
  classList: any;
  dataset: any;

  constructor(public dom: FakeDom, tag: string) {
    this.tagName = tag.startsWith("#") ? tag : tag.toUpperCase();
    const styles: Record<string, string> = {};
    this.style = new Proxy(styles, {
      get: (t, p: string) => p === "setProperty" ? (k: string, v: string) => { t[k] = v; }
        : p === "removeProperty" ? (k: string) => { delete t[k]; }
        : p === "getPropertyValue" ? (k: string) => t[k] ?? ""
        : t[p] ?? "",
      set: (t, p: string, v) => { t[p] = String(v); return true; },
    });
    const self = this;
    const classes = () => new Set((self.attrs.get("class") || "").split(/\s+/).filter(Boolean));
    const save = (set: Set<string>) => self.attrs.set("class", [...set].join(" "));
    this.classList = {
      add: (...names: string[]) => { const s = classes(); names.forEach(n => s.add(n)); save(s); },
      remove: (...names: string[]) => { const s = classes(); names.forEach(n => s.delete(n)); save(s); },
      toggle: (name: string, force?: boolean) => {
        const s = classes(); const on = force ?? !s.has(name);
        if (on) s.add(name); else s.delete(name);
        save(s); return on;
      },
      contains: (name: string) => classes().has(name),
    };
    this.dataset = new Proxy({}, {
      get: (_t, p: string) => self.attrs.get("data-" + p.replace(/[A-Z]/g, c => "-" + c.toLowerCase())),
      set: (_t, p: string, v) => { self.attrs.set("data-" + p.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), String(v)); return true; },
      deleteProperty: (_t, p: string) => { self.attrs.delete("data-" + p.replace(/[A-Z]/g, c => "-" + c.toLowerCase())); return true; },
    });
  }

  get nodeType() { return this.tagName === "#text" ? 3 : 1; }
  get nodeName() { return this.tagName; }
  get id() { return this.attrs.get("id") || ""; }
  set id(v: string) { this.attrs.set("id", String(v)); }
  get className() { return this.attrs.get("class") || ""; }
  set className(v: string) { this.attrs.set("class", String(v)); }
  get hidden() { return this.attrs.has("hidden"); }
  set hidden(v: boolean) { if (v) this.attrs.set("hidden", ""); else this.attrs.delete("hidden"); }
  get src() { return this.attrs.get("src") || ""; }
  set src(v: string) { this.attrs.set("src", String(v)); }
  get alt() { return this.attrs.get("alt") || ""; }
  set alt(v: string) { this.attrs.set("alt", String(v)); }
  get title() { return this.attrs.get("title") || ""; }
  set title(v: string) { this.attrs.set("title", String(v)); }
  get type() { return this.attrs.get("type") || ""; }
  set type(v: string) { this.attrs.set("type", String(v)); }
  get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join(""); }
  set textContent(v: string) { this.detachChildren(); this.ownText = String(v ?? ""); this.markup = ""; }
  get innerText() { return this.textContent; }
  set innerText(v: string) { this.textContent = v; }
  get innerHTML() { return this.markup; }
  set innerHTML(html: string) { this.detachChildren(); this.ownText = ""; this.markup = String(html ?? ""); parseMarkupInto(this, this.markup); }
  get outerHTML() { return this.markup; }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get childElementCount() { return this.children.length; }
  get parentElement() { return this.parentNode; }
  get previousElementSibling(): FakeElement | null { const s = this.parentNode?.children || []; return s[s.indexOf(this) - 1] || null; }
  get nextElementSibling(): FakeElement | null { const s = this.parentNode?.children || []; const i = s.indexOf(this); return i >= 0 ? s[i + 1] || null : null; }
  get nextSibling(): FakeElement | null { return this.nextElementSibling; }
  get isConnected(): boolean { let n: FakeElement | null = this; while (n && n !== this.dom.html) n = n.parentNode; return n === this.dom.html; }
  get ownerDocument() { return this.dom.document; }

  detachChildren() { this.children.forEach(c => { c.parentNode = null; }); this.children = []; }
  appendChild(child: FakeElement) {
    if (!(child instanceof FakeElement)) return child;
    if (child.tagName === "#fragment") { [...child.children].forEach(c => this.appendChild(c)); return child; }
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: any[]) { nodes.forEach(n => this.appendChild(typeof n === "string" ? this.dom.text(n) : n)); }
  prepend(node: FakeElement) { this.insertBefore(node, this.children[0] || null); }
  insertBefore(child: FakeElement, ref: FakeElement | null) {
    if (!(child instanceof FakeElement)) return child;
    if (!ref || !this.children.includes(ref)) return this.appendChild(child);
    child.remove();
    child.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  replaceChildren(...nodes: FakeElement[]) { this.detachChildren(); nodes.forEach(n => this.appendChild(n)); }
  removeChild(child: FakeElement) { child.remove(); return child; }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  insertAdjacentHTML(where: string, html: string) {
    const holder = new FakeElement(this.dom, "div");
    holder.innerHTML = html;
    const nodes = [...holder.children];
    if (where === "beforeend") nodes.forEach(n => this.appendChild(n));
    else if (where === "afterbegin") nodes.reverse().forEach(n => this.prepend(n));
    else if (where === "afterend" && this.parentNode) { const next = this.nextElementSibling; nodes.forEach(n => this.parentNode!.insertBefore(n, next)); }
    else if (where === "beforebegin" && this.parentNode) nodes.forEach(n => this.parentNode!.insertBefore(n, this));
  }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name)! : null; }
  setAttribute(name: string, value: unknown) { this.attrs.set(name, String(value)); }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  toggleAttribute(name: string, force?: boolean) { const on = force ?? !this.attrs.has(name); if (on) this.attrs.set(name, ""); else this.attrs.delete(name); return on; }
  matches(selector: string) { return parseSelector(selector).some(parts => matchesParts(this, parts, parts.length - 1)); }
  closest(selector: string) {
    const groups = parseSelector(selector);
    for (let n: FakeElement | null = this; n; n = n.parentNode) if (groups.some(parts => matchesParts(n!, parts, parts.length - 1))) return n;
    return null;
  }
  descendants(): FakeElement[] { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelectorAll(selector: string) { const groups = parseSelector(selector); return this.descendants().filter(n => groups.some(parts => matchesParts(n, parts, parts.length - 1))); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  getElementsByClassName(name: string) { return this.querySelectorAll("." + name); }
  getElementsByTagName(name: string) { return this.querySelectorAll(name); }
  contains(other: any) { for (let n = other; n instanceof FakeElement; n = n.parentNode) if (n === this) return true; return false; }
  addEventListener(type: string, fn: Function, options?: any) {
    (this.listeners[type] = this.listeners[type] || []).push({ fn, capture: options === true || !!options?.capture });
  }
  removeEventListener(type: string, fn: Function) { this.listeners[type] = (this.listeners[type] || []).filter(l => l.fn !== fn); }
  dispatchEvent(event: any) { this.dom.dispatch(event.type, this, event); return true; }
  focus() { if (this.dom.activeElement === this) return; this.dom.activeElement = this; this.dom.dispatch("focusin", this); }
  blur() { if (this.dom.activeElement === this) this.dom.activeElement = this.dom.body; }
  click() { this.dom.dispatch("click", this); }
  select() {}
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  getClientRects() { return []; }
  scrollIntoView() {}
  scrollTo() {}
  scrollBy() {}
  animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null }; }
  cloneNode() { const copy = new FakeElement(this.dom, this.tagName.toLowerCase()); copy.attrs = new Map(this.attrs); copy.ownText = this.ownText; return copy; }
  attachShadow() { return new FakeElement(this.dom, "div"); }
}

function parseMarkupInto(parent: FakeElement, html: string) {
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|</g;
  const stack: FakeElement[] = [parent];
  let m: RegExpExecArray | null;
  while ((m = token.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const closing = m[1].toUpperCase();
      const at = stack.map(el => el.tagName).lastIndexOf(closing);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const el = new FakeElement(parent.dom, m[2]);
      const attrRe = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[3] || ""))) el.attrs.set(a[1].toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
      top.appendChild(el);
      if (!m[4] && !VOID_TAGS.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[5] !== undefined || m[0] === "<") {
      top.ownText += decodeEntities(m[5] ?? m[0]);
    }
  }
}

class FakeDom {
  html: FakeElement;
  body: FakeElement;
  activeElement: FakeElement;
  documentListeners: Record<string, Listener[]> = {};
  windowListeners: Record<string, Listener[]> = {};
  timers: Array<() => void> = [];
  document: any;
  window: any;

  constructor() {
    this.html = new FakeElement(this, "html");
    this.body = this.html.appendChild(new FakeElement(this, "body"));
    this.activeElement = this.body;
  }
  el(tag: string, attrs: Record<string, string> = {}) {
    const el = new FakeElement(this, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  text(value: string) { const t = new FakeElement(this, "#text"); t.ownText = value; return t; }
  byId(id: string) { return [this.html, ...this.html.descendants()].find(n => n.getAttribute("id") === id) || null; }

  dispatch(type: string, target: FakeElement, init: Record<string, any> = {}) {
    const event: any = {
      key: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, button: 0,
      ...init, type, target, defaultPrevented: false, stopped: false, immediate: false,
    };
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopPropagation = () => { event.stopped = true; };
    event.stopImmediatePropagation = () => { event.stopped = true; event.immediate = true; };
    const run = (listeners: Listener[] | undefined, phase: "capture" | "bubble" | "target", current: any) => {
      for (const l of [...(listeners || [])]) {
        if (phase === "capture" && !l.capture) continue;
        if (phase === "bubble" && l.capture) continue;
        event.currentTarget = current;
        l.fn.call(current, event);
        if (event.immediate) return;
      }
    };
    const path: FakeElement[] = [];
    for (let n: FakeElement | null = target; n; n = n.parentNode) path.push(n);
    run(this.windowListeners[type], "capture", this.window);
    if (event.stopped) return event;
    run(this.documentListeners[type], "capture", this.document);
    if (event.stopped) return event;
    for (const n of [...path].reverse().slice(0, -1)) { run(n.listeners[type], "capture", n); if (event.stopped) return event; }
    run(target.listeners[type], "target", target);
    if (event.stopped) return event;
    for (const n of path.slice(1)) { run(n.listeners[type], "bubble", n); if (event.stopped) return event; }
    run(this.documentListeners[type], "bubble", this.document);
    if (event.stopped) return event;
    run(this.windowListeners[type], "bubble", this.window);
    return event;
  }
  flushTimers() { while (this.timers.length) this.timers.shift()!(); }
}

function recording(base: Record<string, any>): any {
  return new Proxy(base, {
    get(t, prop) { return prop in t ? t[prop as any] : stub(); },
    set(t, prop, value) { t[prop as any] = value; return true; },
  });
}

const PAGE_IDS = ["chat-messages", "prompt-input", "btn-send", "image-attachments-container", "drag-dropped-files-bar"];

// Streaming text appends to a text node.
(FakeElement.prototype as any).appendData = function (this: FakeElement, text: string) { this.ownText += String(text); };
// Browsers resolve :scope to the element queried from; the fake page must too or adoption code silently matches nothing.
const queryAllWithoutScope = FakeElement.prototype.querySelectorAll;
FakeElement.prototype.querySelectorAll = function (this: FakeElement, selector: string) {
  if (!selector.includes(":scope")) return queryAllWithoutScope.call(this, selector);
  this.attrs.set("data-fake-scope", "");
  try {
    return queryAllWithoutScope.call(this, selector.replace(/:scope/g, "[data-fake-scope]"));
  } finally {
    this.attrs.delete("data-fake-scope");
  }
};
(FakeElement.prototype as any).replaceWith = function (this: FakeElement, node: FakeElement) {
  const parent = this.parentNode;
  if (!parent) return;
  parent.insertBefore(node, this);
  this.remove();
};
Object.defineProperty(FakeElement.prototype, "data", {
  get(this: FakeElement) { return this.ownText; },
  set(this: FakeElement, value: string) { this.ownText = String(value); },
});

// ── Fixed clock, hand-ticked timers ───────────────────────────────────────────────────────────────────────────────

type Clock = { now: number };

const CLOCK_PRELUDE = `(function () {
  var RealDate = Date;
  var clock = __clock;
  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!new.target) return new RealDate(clock.now).toString();
    return Reflect.construct(RealDate, args.length ? args : [clock.now]);
  }
  FakeDate.now = function () { return clock.now; };
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  globalThis.Date = FakeDate;
  var seed = 7;
  Math.random = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
})();`;

const CURRENT_SCRIPT = getChatClientScript("icon.svg", STATE);
const ACTIVITY_SCRIPT = getChatActivityScript();
const MARKED = readFileSync(join(__dirname, "..", "..", "media", "marked.min.js"), "utf8");

function loadWebview(clock: Clock, script: string = CURRENT_SCRIPT) {
  const dom = new FakeDom();
  for (const id of PAGE_IDS) dom.body.appendChild(dom.el(id === "prompt-input" ? "textarea" : id === "btn-send" ? "button" : "div", { id }));
  dom.body.appendChild(dom.el("button", { id: "btn-cancel" }));
  dom.body.appendChild(dom.el("div", { id: "interactive-slot" }));
  for (const id of ["mode-popover", "slash-palette", "mention-palette", "reasoning-popover", "collab-inbox-popover",
    "profile-popover", "sp-menu"]) {
    const el = dom.body.appendChild(dom.el("div", { id }));
    el.style.display = "none";
  }
  const nullIds = new Set(["questions-carousel-card", "image-lightbox-overlay"]);
  const posted: any[] = [];
  const errors: unknown[] = [];
  const timeouts = new Map<number, Function>();
  const intervals = new Map<number, { fn: Function; every: number; next: number }>();
  let nextTimerId = 1;
  const document = recording({
    body: dom.body, documentElement: dom.html, head: dom.el("head"),
    get activeElement() { return dom.activeElement; },
    set activeElement(_v: any) { /* read-only in browsers */ },
    getElementById: (id: string) => dom.byId(id) || (nullIds.has(id) ? null : stub()),
    querySelector: (selector: string) => dom.html.querySelector(selector) || stub(),
    querySelectorAll: (selector: string) => dom.html.querySelectorAll(selector),
    createElement: (tag: string) => new FakeElement(dom, tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(dom, tag),
    createTextNode: (text: string) => dom.text(String(text)),
    createDocumentFragment: () => new FakeElement(dom, "#fragment"),
    addEventListener(type: string, fn: Function, options?: any) {
      (dom.documentListeners[type] = dom.documentListeners[type] || []).push({ fn, capture: options === true || !!options?.capture });
    },
    removeEventListener() {},
    hasFocus: () => true,
    execCommand: () => false,
  });
  const window: any = recording({
    addEventListener(type: string, fn: Function, options?: any) {
      (dom.windowListeners[type] = dom.windowListeners[type] || []).push({ fn, capture: options === true || !!options?.capture });
    },
    removeEventListener() {},
    getComputedStyle: (el: any) => ({ display: el?.style?.display ?? "", getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    innerWidth: 420, innerHeight: 900,
  });
  dom.document = document;
  dom.window = window;
  const later = (fn: Function) => { const id = nextTimerId++; timeouts.set(id, fn); return id; };
  const sandbox: any = {
    acquireVsCodeApi: () => ({ postMessage: (m: any) => posted.push(m), getState: () => ({}), setState: () => {} }),
    document, window, navigator: { platform: "Win32", clipboard: stub(), userAgent: "node" }, localStorage: stub(),
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout: (fn: Function) => later(fn),
    clearTimeout: (id: number) => { timeouts.delete(id); },
    setInterval: (fn: Function, every?: number) => {
      const id = nextTimerId++;
      const ms = Math.max(50, Number(every) || 1000);
      intervals.set(id, { fn, every: ms, next: clock.now + ms });
      return id;
    },
    clearInterval: (id: number) => { intervals.delete(id); },
    requestAnimationFrame: (fn: Function) => later(() => fn(clock.now)), cancelAnimationFrame: (id: number) => { timeouts.delete(id); },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Event: class { constructor(public type: string, public init?: any) {} },
    HTMLElement: FakeElement, Element: FakeElement, Node: FakeElement,
    performance: { now: () => clock.now },
    __clock: clock,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CLOCK_PRELUDE, sandbox);
  vm.runInContext(MARKED, sandbox);
  vm.runInContext(ACTIVITY_SCRIPT, sandbox);
  vm.runInContext(script, sandbox);
  timeouts.clear();

  const flush = () => {
    for (let round = 0; round < 20 && timeouts.size; round++) {
      const due = [...timeouts.entries()];
      timeouts.clear();
      for (const [, fn] of due) {
        try { fn(); } catch (err) { errors.push(err); }
      }
    }
  };
  const post = (data: any) => {
    for (const l of [...(dom.windowListeners.message || [])]) l.fn({ data });
    flush();
  };
  const tick = (seconds = 1) => {
    for (let s = 0; s < seconds; s++) {
      clock.now += 1000;
      for (const [id, timer] of [...intervals.entries()]) {
        let runs = 0;
        while (intervals.get(id) === timer && timer.next <= clock.now && runs++ < 40) {
          timer.next += timer.every;
          try { timer.fn(); } catch (err) { errors.push(err); }
        }
      }
      flush();
    }
  };
  return {
    dom, posted, errors, sandbox, post, tick,
    chat: dom.byId("chat-messages")!,
    byId: (id: string) => dom.byId(id),
  };
}

type Webview = ReturnType<typeof loadWebview>;

// ── Sessions as session.get returns them ──────────────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const SECOND = 1000;
const sec = (ms: number) => ms / 1000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function user(content: string, at: number, extra: Record<string, unknown> = {}) {
  return { role: "user", content, ts: iso(at), ...extra };
}
function reply(at: number, opts: { content?: string; thinking?: string; calls?: any[]; turnStart?: number; turnId?: string } = {}) {
  const m: any = { role: "assistant", content: opts.content ?? null, ts: iso(at) };
  if (opts.thinking) m.thinking = opts.thinking;
  if (opts.calls) m.tool_calls = opts.calls;
  if (opts.turnStart !== undefined) m.duration = Math.round((at - opts.turnStart) / 10) / 100;
  if (opts.turnId) m.turn_id = opts.turnId;
  return m;
}
function result(id: string, content: string, at: number) {
  return { role: "tool", tool_call_id: id, content, ts: iso(at) };
}
function liveTool(c: any, ts: unknown, seq = 1) {
  return { session_id: "s", event_seq: seq, tool_id: c.id, tool_name: c.function.name, ts, args_json: c.function.arguments };
}
type Runtime = { tools?: any[]; interactions?: any[]; processes?: any[]; text?: string } | null;
function session(messages: any[], runtime: Runtime = {}, running = true, id = "s") {
  const s: any = { id, name: "late attach", status: running ? "running" : "idle", is_running: running, messages };
  if (runtime !== null) {
    s.runtime = { event_seq: 50, is_running: running, tools: runtime.tools || [], interactions: runtime.interactions || [],
      processes: runtime.processes || [], text: runtime.text || "", thinking: "" };
  }
  return s;
}

/** The reported case: an earlier finished turn, then a turn that edited files and has run `npm test` for a long time. */
function reportedCase() {
  const earlier = T0 - 600 * SECOND;
  const a = call("w1", "write_file", { path: "src/a.ts", content: "a" });
  const b = call("w2", "write_file", { path: "src/b.ts", content: "b" });
  const c = call("e1", "edit_file", { path: "src/c.ts", old_string: "x", new_string: "y" });
  const r = call("r1", "read_file", { path: "README.md" });
  const sh = call("sh1", "shell_exec", { command: "npm test" });
  const shellStart = T0 + 84 * SECOND;
  const messages = [
    user("an earlier turn", earlier),
    reply(earlier + 10 * SECOND, { calls: [call("old1", "write_file", { path: "src/old.ts", content: "o" })], turnStart: earlier }),
    result("old1", "ok", earlier + 11 * SECOND),
    reply(earlier + 20 * SECOND, { content: "The earlier turn is done.", turnStart: earlier }),
    user("fix the build", T0),
    reply(T0 + 5 * SECOND, { calls: [a, b], turnStart: T0 }),
    result("w1", "ok", T0 + 6 * SECOND), result("w2", "ok", T0 + 6.5 * SECOND),
    reply(T0 + 20 * SECOND, { calls: [c, r], turnStart: T0 }),
    result("e1", "ok", T0 + 21 * SECOND), result("r1", "readme", T0 + 21.5 * SECOND),
    reply(shellStart, { calls: [sh], turnStart: T0 }),
  ];
  return { messages, sh, shellStart, runtime: { tools: [liveTool(sh, sec(shellStart))] } };
}

// ── Reading the page ──────────────────────────────────────────────────────────────────────────────────────────────

const replies = (w: Webview): FakeElement[] => w.chat.querySelectorAll(".message-wrap.assistant");
const lastReply = (w: Webview): FakeElement => replies(w).at(-1)!;
const groupsIn = (el: FakeElement): FakeElement[] => el.querySelectorAll(".tool-sequence");
const titleOf = (seq: FakeElement): string => seq.querySelector(".tool-seq-title").textContent;
const bodyRows = (seq: FakeElement): FakeElement[] => seq.querySelector(".tool-seq-body").children;
const elapsedOf = (w: Webview, toolId: string): string | null => {
  const row = w.byId("tool-" + toolId);
  const el = row ? row.querySelector(".tool-elapsed") : null;
  return el ? el.textContent : null;
};
const headerSeconds = (title: string): number => {
  const m = /\((-?\d+)s\)|worked for (-?\d+)s/.exec(title);
  return m ? Number(m[1] ?? m[2]) : NaN;
};
const cardFiles = (card: FakeElement): string[] =>
  card.querySelectorAll(".files-changed-row").map((row: FakeElement) => String(row.getAttribute("data-file-path"))).sort();

function attach(clock: Clock, messages: any[], runtime: Runtime = {}, running = true): Webview {
  const w = loadWebview(clock);
  w.post({ type: "session_loaded", session: session(messages, runtime, running) });
  return w;
}

function liveEdit(w: Webview, id: string, name: string, args: Record<string, unknown>, clock: Clock) {
  w.post({ type: "tool_start", session_id: "s", tool_id: id, tool_name: name, ts: sec(clock.now) });
  w.post({ type: "tool_delta", session_id: "s", tool_id: id, chunk: JSON.stringify(args) });
  w.post({ type: "tool_end", session_id: "s", tool_id: id });
  w.post({ type: "tool_result", session_id: "s", tool_id: id, tool_name: name, result: "ok", success: true, duration_ms: 40 });
}

// ── 1. Running tools show time since they really started ─────────────────────────────────────────────────────────

describe("a view opened mid-turn times running tools from their real start", () => {
  it("shows the command that has run for 1116s as 1116s, not the time since the view opened", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, c.runtime);
    w.tick(1);
    assert.equal(elapsedOf(w, "sh1"), "1117s");
  });

  // A rejected start time falls back to the moment the row was drawn, so two ticks later it reads 2s.
  // The group was started by the saved reply at T0+5s, so its header reads 1197s.
  const fallsBackToNow: Array<[string, (now: number) => unknown]> = [
    ["59s in the future (clamped)", now => sec(now) + 59],
    ["exactly 60s in the future (clamped)", now => sec(now) + 60],
    ["61s in the future", now => sec(now) + 61],
    ["500s in the future", now => sec(now) + 500],
    ["missing", () => undefined],
    ["zero", () => 0],
    ["negative", () => -5],
    ["a word", () => "soon"],
    ["NaN", () => NaN],
    ["null", () => null],
    ["huge", () => 1e300],
    ["infinite as text", () => "1e400"],
    ["milliseconds instead of seconds", now => now],
    ["one second after the epoch", () => 1],
    ["just under 1e9", () => 1e9 - 1],
    ["a number written as text", () => "1"],
    ["true", () => true],
    ["real seconds written as text", now => String(sec(now) - 1116)],
    ["real seconds in an array", now => [sec(now) - 1116]],
  ];
  for (const [label, make] of fallsBackToNow) {
    it(`falls back to now, never a negative, NaN or absurd timer, when ts is ${label}`, () => {
      const clock = { now: T0 + 1200 * SECOND };
      const c = reportedCase();
      const w = attach(clock, c.messages, { tools: [liveTool(c.sh, make(clock.now))] });
      w.tick(2);
      assert.equal(elapsedOf(w, "sh1"), "2s");
      assert.equal(w.byId("tool-sh1")!.getAttribute("data-start-ts"), String(T0 + 1200 * SECOND));
      assert.equal(titleOf(groupsIn(lastReply(w)).at(-1)!), "5 tools · shell_exec working... (1197s)");
    });
  }

  it("accepts a real start up to 60s ahead of the view's clock as now", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, { tools: [liveTool(c.sh, sec(clock.now) + 30.5)] });
    w.tick(1);
    assert.equal(elapsedOf(w, "sh1"), "1s");
  });

  it("never shows a tool as older than its turn when ts is before the turn's own prompt",
    { todo: "known older bug, not fixed in this branch: a ts earlier than the turn's prompt is not clamped" }, () => {
      const clock = { now: T0 + 1200 * SECOND };
      const c = reportedCase();
      const w = attach(clock, c.messages, { tools: [liveTool(c.sh, sec(T0 - 3600 * SECOND))] });
      w.tick(1);
      const shown = parseInt(String(elapsedOf(w, "sh1")), 10);
      assert.ok(shown <= 1201, `the row says ${shown}s but the turn started 1201s ago`);
    });
});

// ── 2. Events buffered while the session was in the background ───────────────────────────────────────────────────

describe("events buffered in the background keep their real start", () => {
  it("replays a buffered tool_start with its ts and puts it in the turn's group", () => {
    const clock = { now: T0 + 600 * SECOND };
    const w = loadWebview(clock);
    w.post({ type: "session_switched", sessionId: "other" });
    w.post({ type: "session_loaded", session: session([user("hi", T0 - 10 * SECOND), reply(T0 - 9 * SECOND, { content: "hello" })], {}, false, "other") });
    const startedAt = T0 + 300 * SECOND;
    w.post({ type: "tool_start", session_id: "s", tool_id: "bg1", tool_name: "shell_exec", ts: sec(startedAt) });
    w.post({ type: "tool_delta", session_id: "s", tool_id: "bg1", chunk: '{"command":"npm test"}' });
    w.post({ type: "session_switched", sessionId: "s" });
    const r1 = call("r1", "read_file", { path: "a.ts" });
    w.post({ type: "session_loaded", session: session([user("go", T0), reply(T0 + 5 * SECOND, { calls: [r1], turnStart: T0 }),
      result("r1", "x", T0 + 6 * SECOND)], null, true) });
    const row = w.byId("tool-bg1");
    assert.ok(row, "the buffered tool is drawn");
    assert.equal(row!.getAttribute("data-start-ts"), String(startedAt));
    const groups = groupsIn(lastReply(w));
    assert.equal(groups.length, 1, "one tool group for the turn");
    assert.equal(titleOf(groups[0]), "2 tools · shell_exec working... (595s)", "timed from the reply that started the group, at T0+5s");
    w.tick(1);
    assert.ok(row!.classList.contains("stuck"), "a command running for 301s is flagged as long-running like in a live view");
  });
});

// ── 3. No turn-end card or footer while the turn runs; the full card when it ends ─────────────────────────────────

describe("the running turn's Files Changed card and footer", () => {
  it("draws neither while the turn runs, and keeps both for the finished turn before it", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, c.runtime);
    const [earlier, running] = replies(w);
    assert.equal(replies(w).length, 2);
    assert.equal(earlier.querySelectorAll(".files-changed-card").length, 1, "the finished turn keeps its card");
    assert.equal(earlier.querySelectorAll(".message-footer").length, 1, "the finished turn keeps its footer");
    assert.equal(running.querySelectorAll(".files-changed-card").length, 0, "no card while the turn runs");
    assert.equal(running.querySelectorAll(".message-footer").length, 0, "no footer while the turn runs");
  });

  it("lists every file the turn edited, before and after the view opened, once each", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, c.runtime);
    w.tick(1);
    w.post({ type: "tool_result", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", result: "passed", success: true, duration_ms: 1117000 });
    liveEdit(w, "e2", "edit_file", { path: "src/d.ts", old_string: "1", new_string: "2" }, clock);
    liveEdit(w, "w3", "write_file", { path: "src/a.ts", content: "again" }, clock);
    w.post({ type: "text_delta", session_id: "s", text: "Build fixed." });
    w.post({ type: "agent_done", session_id: "s", outcome: "success" });
    const running = replies(w)[1];
    const cards = running.querySelectorAll(".files-changed-card");
    assert.equal(cards.length, 1, "one card for the turn");
    assert.deepEqual(cardFiles(cards[0]), ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    assert.equal(cards[0].querySelector(".files-changed-title").textContent, "4 Files Changed");
    assert.equal(running.querySelectorAll(".message-footer").length, 1, "one footer for the turn");
  });

  it("does not list a file twice when the engine also reports the turn's files", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, c.runtime);
    w.post({ type: "tool_result", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", result: "passed", success: true, duration_ms: 5 });
    w.post({ type: "agent_done", session_id: "s", outcome: "success", turn_files: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    const cards = replies(w)[1].querySelectorAll(".files-changed-card");
    assert.equal(cards.length, 1);
    assert.deepEqual(cardFiles(cards[0]), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("cancelling mid-turn ends the turn with its files and leaves no timer counting",
    { todo: "known older bug, not fixed in this branch: cancel leaves the running row's timer counting" }, () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, c.runtime);
    w.tick(1);
    w.post({ type: "agent_cancelled", session_id: "s" });
    const running = replies(w)[1];
    const cards = running.querySelectorAll(".files-changed-card");
    assert.equal(cards.length, 1);
    assert.deepEqual(cardFiles(cards[0]), ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.equal(running.querySelectorAll(".message-footer").length, 1);
    const frozen = elapsedOf(w, "sh1");
    const header = titleOf(groupsIn(running)[0]);
    w.tick(5);
    assert.equal(elapsedOf(w, "sh1"), frozen, "the cancelled command's timer stops");
    assert.equal(titleOf(groupsIn(running)[0]), header, "the group header stops");
  });
});

// ── 4. Tools still running or still to come join the reply's last tool group ─────────────────────────────────────

describe("the running turn's tool group", () => {
  it("adds running and later tools to the group history drew, timed from the group's first step", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, c.runtime);
    const running = lastReply(w);
    assert.equal(groupsIn(running).length, 1, "one group, not a second one for the running command");
    const seq = groupsIn(running)[0];
    assert.equal(titleOf(seq), "5 tools · shell_exec working... (1195s)", "the group began with the reply saved at T0+5s");
    assert.equal(seq.classList.contains("collapsed"), false);
    w.tick(1);
    assert.equal(titleOf(seq), "5 tools · shell_exec working... (1196s)");
    w.post({ type: "tool_result", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", result: "passed", success: true, duration_ms: 1117000 });
    assert.equal(titleOf(seq), "5 tools · all done · waiting for model... (1196s)");
    w.post({ type: "tool_start", session_id: "s", tool_id: "g1", tool_name: "grep_search", ts: sec(clock.now) });
    assert.equal(groupsIn(running).length, 1, "a later tool joins the same group");
    assert.equal(titleOf(seq), "6 tools · grep_search working... (1196s)");
    w.post({ type: "tool_result", session_id: "s", tool_id: "g1", tool_name: "grep_search", result: "none", success: true, duration_ms: 5 });
    w.post({ type: "text_delta", session_id: "s", text: "All green." });
    assert.equal(titleOf(seq), "6 tools · worked for 1196s");
    assert.equal(groupsIn(running).length, 1);
  });

  it("counts tools, not the thinking shown between them", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const r1 = call("r1", "read_file", { path: "a.ts" });
    const r2 = call("r2", "read_file", { path: "b.ts" });
    const sh = call("sh1", "shell_exec", { command: "npm test" });
    const w = attach(clock, [
      user("fix it", T0),
      reply(T0 + 5 * SECOND, { thinking: "Read a first.", calls: [r1], turnStart: T0 }), result("r1", "a", T0 + 6 * SECOND),
      reply(T0 + 10 * SECOND, { thinking: "Then b.", calls: [r2], turnStart: T0 }), result("r2", "b", T0 + 11 * SECOND),
      reply(T0 + 20 * SECOND, { thinking: "Now run the tests.", calls: [sh], turnStart: T0 }),
    ], { tools: [liveTool(sh, sec(T0 + 19 * SECOND))] });
    const groups = groupsIn(lastReply(w));
    assert.equal(groups.length, 1);
    assert.equal(titleOf(groups[0]), "3 tools · shell_exec working... (1195s)", "two finished reads and the running command");
    w.post({ type: "thinking_delta", session_id: "s", text: "Waiting on the tests." });
    w.post({ type: "tool_result", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", result: "passed", success: true, duration_ms: 5 });
    w.post({ type: "tool_start", session_id: "s", tool_id: "r3", tool_name: "read_file", ts: sec(clock.now) });
    assert.equal(titleOf(groups[0]), "4 tools · read_file working... (1195s)", "live thinking in the group is not counted either");
  });

  it("counts every tool row a reloaded group holds, including thinking added live before the reload", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const r1 = call("r1", "read_file", { path: "a.ts" });
    const sh = call("sh1", "shell_exec", { command: "npm test" });
    const messages = [
      user("fix it", T0),
      reply(T0 + 5 * SECOND, { thinking: "Read a first.", calls: [r1], turnStart: T0 }), result("r1", "a", T0 + 6 * SECOND),
      reply(T0 + 20 * SECOND, { thinking: "Now run the tests.", calls: [sh], turnStart: T0 }),
    ];
    const w = attach(clock, messages, { tools: [liveTool(sh, sec(T0 + 19 * SECOND))] });
    w.post({ type: "thinking_delta", session_id: "s", text: "Still waiting." });
    w.post({ type: "session_loaded", session: session(messages, { tools: [liveTool(sh, sec(T0 + 19 * SECOND))], thinking: "" } as any) });
    assert.equal(titleOf(groupsIn(lastReply(w))[0]), "2 tools · shell_exec working... (1195s)");
  });

  it("an adopted group is never timed as younger than a running tool it holds", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const a = call("w1", "write_file", { path: "src/a.ts", content: "a" });
    const sh = call("sh1", "shell_exec", { command: "npm test" });
    const w = attach(clock, [
      user("fix it", T0),
      reply(T0 + 20 * SECOND, { calls: [a, sh], turnStart: T0 }),
    ], { tools: [liveTool(sh, sec(T0 + 17 * SECOND))] });
    w.tick(1);
    const groups = groupsIn(lastReply(w));
    assert.equal(groups.length, 1);
    const header = headerSeconds(titleOf(groups[0]));
    const row = parseInt(String(elapsedOf(w, "sh1")), 10);
    assert.ok(header >= row, `the group says ${header}s while the command in it has run ${row}s`);
  });

  it("starts a new group after text, timed from its first tool's engine ts", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const r1 = call("r1", "read_file", { path: "a.ts" });
    const sh = call("sh1", "shell_exec", { command: "npm test" });
    const w = attach(clock, [
      user("fix it", T0),
      reply(T0 + 5 * SECOND, { calls: [r1], turnStart: T0 }), result("r1", "a", T0 + 6 * SECOND),
      reply(T0 + 30 * SECOND, { content: "Now I'll run the tests.", calls: [sh], turnStart: T0 }),
    ], { tools: [liveTool(sh, sec(T0 + 29 * SECOND))] });
    w.tick(1);
    const groups = groupsIn(lastReply(w));
    assert.equal(groups.length, 2, "text ends the drawn reply, so the running tool gets its own group");
    assert.equal(titleOf(groups[1]), "1 tool · shell_exec working... (1172s)");
    assert.equal(elapsedOf(w, "sh1"), "1172s");
  });
});

// ── 5. Finished turns and idle sessions render as before ─────────────────────────────────────────────────────────

function loadBaseScript(): string | null {
  const ref = process.env.LATE_ATTACH_BASE_REF || "dev";
  let source: string;
  try {
    source = execFileSync("git", ["show", ref + ":vscode-extension/src/providers/chatview/chatClientScript.ts"],
      { cwd: join(__dirname, "..", ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  const ts = require("typescript");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const filename = join(__dirname, "..", "src", "providers", "chatview", "chatClientScript.base.js");
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(dirname(filename));
  Module.prototype.require = function (name: string) {
    if (name === "vscode") return vscodeStub;
    return originalRequire.apply(this, arguments as any);
  };
  try {
    m._compile(output, filename);
  } finally {
    Module.prototype.require = originalRequire;
  }
  return m.exports.getChatClientScript("icon.svg", STATE);
}

function serialize(el: FakeElement, opts: { unpinFooters?: boolean; skipFileStats?: boolean } = {}, depth = 0, out: string[] = []): string[] {
  const attrs = [...el.attrs.entries()]
    .map(([k, v]): [string, string] => {
      if (opts.unpinFooters && k === "class" && /\bmessage-footer\b/.test(v)) return [k, v.split(/\s+/).filter(c => c !== "visible").join(" ")];
      return [k, v];
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  const style = JSON.stringify(Object.entries(el.style).sort());
  out.push(`${"  ".repeat(depth)}<${el.tagName} ${attrs} style=${style}>${JSON.stringify(el.ownText)}`);
  if (opts.skipFileStats && el.classList.contains("files-changed-row-stats")) return out;
  for (const child of el.children) serialize(child, opts, depth + 1, out);
  return out;
}

function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A random but repeatable history: turns of thinking, text and tool calls of many kinds, some failed or unanswered. */
function generatedSession(seed: number, running: boolean) {
  const r = prng(seed);
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)];
  const messages: any[] = [];
  const liveTools: any[] = [];
  let t = T0 - 7200 * SECOND;
  let n = 0;
  const turns = 1 + Math.floor(r() * 5);
  for (let k = 0; k < turns; k++) {
    const last = k === turns - 1;
    t += 30 * SECOND;
    const turnStart = t;
    messages.push(user("prompt " + k, t, k > 0 && r() < 0.15 ? { steering: true } : {}));
    const iterations = Math.floor(r() * 4);
    for (let it = 0; it < iterations; it++) {
      t += Math.floor(1 + r() * 20) * SECOND;
      const calls: any[] = [];
      const count = r() < 0.7 ? 1 + Math.floor(r() * 3) : 0;
      for (let i = 0; i < count; i++) {
        const name = pick(["write_file", "edit_file", "shell_exec", "read_file", "shell_bg", "spawn_subagent", "grep_search", "edit_file_multi"]);
        const id = "c" + seed + "_" + n++;
        const args: Record<string, unknown> =
          name === "write_file" ? { path: pick(["src/a.ts", "src/b.ts", "lib/a.ts", "docs/readme.md"]), content: "x" } :
          name === "edit_file" ? { path: pick(["src/a.ts", "src/c.ts"]), old_string: "a", new_string: "b" } :
          name === "edit_file_multi" ? { edits: [{ path: "src/m1.ts", old_string: "a", new_string: "b" }, { path: "src/m2.ts", old_string: "a", new_string: "b" }] } :
          name === "shell_exec" || name === "shell_bg" ? { command: pick(["npm test", "npm run dev", "ls"]) } :
          name === "spawn_subagent" ? { role: "tester", task: "check" } : { path: "x" };
        calls.push(call(id, name, args));
      }
      const thinking = r() < 0.5 ? "thinking " + it : undefined;
      const content = r() < 0.4 ? "text " + it : undefined;
      messages.push(reply(t, { thinking, content, calls: calls.length ? calls : undefined, turnStart: r() < 0.7 ? turnStart : undefined }));
      for (const c of calls) {
        if (last && running && it === iterations - 1 && r() < 0.6) {
          liveTools.push(liveTool(c, sec(t - Math.floor(r() * 5) * SECOND)));
          continue;
        }
        t += 500;
        const outcome = c.function.name === "shell_bg" ? "Started background process with id 'p" + n + "'" : pick(["ok", "ok", "Error: failed"]);
        messages.push(result(c.id, outcome, t));
      }
    }
    if (!(last && running) && r() < 0.6) {
      t += 2 * SECOND;
      messages.push(reply(t, { content: "turn " + k + " done", turnStart }));
    }
  }
  return session(messages, { tools: liveTools, text: running && r() < 0.2 ? "streaming" : "" }, running);
}

function renderWith(script: string, s: any): FakeElement {
  const w = loadWebview({ now: T0 }, script);
  w.post({ type: "session_loaded", session: s });
  return w.chat;
}

/** The chat up to and including the running turn's prompt. */
function beforeRunningTurn(chat: FakeElement, opts: { unpinFooters?: boolean; skipFileStats?: boolean }): string {
  const children = chat.children;
  let cut = -1;
  children.forEach((child: FakeElement, i: number) => { if (child.classList.contains("message-wrap") && child.classList.contains("user")) cut = i; });
  return children.slice(0, cut + 1).flatMap((child: FakeElement) => serialize(child, opts)).join("\n");
}

describe("finished turns and idle sessions render exactly as before", () => {
  const base = loadBaseScript();
  const skip = base ? false : "the base branch could not be read from git";

  it("an idle session draws the same page as the base branch", { skip }, () => {
    for (let seed = 1; seed <= 60; seed++) {
      const s = generatedSession(seed, false);
      const now = serialize(renderWith(CURRENT_SCRIPT, s), { skipFileStats: true }).join("\n");
      const before = serialize(renderWith(base!, s), { skipFileStats: true }).join("\n");
      assert.equal(now, before, "seed " + seed);
    }
  });

  it("a running session draws its finished turns the same as the base branch", { skip }, () => {
    for (let seed = 1; seed <= 60; seed++) {
      const s = generatedSession(seed, true);
      const now = beforeRunningTurn(renderWith(CURRENT_SCRIPT, s), { unpinFooters: true, skipFileStats: true });
      const before = beforeRunningTurn(renderWith(base!, s), { unpinFooters: true, skipFileStats: true });
      assert.equal(now, before, "seed " + seed);
    }
  });

  it("an idle session whose reply ends in a tool group keeps the finished header and starts no timer", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const messages = [...c.messages, result("sh1", "passed", T0 + 1100 * SECOND)];
    const w = attach(clock, messages, {}, false);
    const seq = groupsIn(lastReply(w))[0];
    const before = titleOf(seq);
    assert.match(before, /^5 tools · worked for \d+(\.\d+)?s$/);
    assert.ok(seq.classList.contains("collapsed"));
    assert.equal(lastReply(w).querySelectorAll(".message-footer").length, 1);
    assert.equal(lastReply(w).querySelectorAll(".files-changed-card").length, 1);
    w.tick(3);
    assert.equal(titleOf(seq), before);
  });
});

// ── Probes ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("probes: several views, switching, races, approvals and odd histories", () => {
  it("a view open from the start and a view opened mid-turn agree on the group, timers and files", () => {
    const clock = { now: T0 };
    const c = reportedCase();
    const live = attach(clock, c.messages.slice(0, 5), {});
    clock.now = T0 + 4 * SECOND;
    for (const [id, name, args] of [["w1", "write_file", { path: "src/a.ts", content: "a" }], ["w2", "write_file", { path: "src/b.ts", content: "b" }]] as const) {
      live.post({ type: "tool_start", session_id: "s", tool_id: id, tool_name: name, ts: sec(clock.now) });
      live.post({ type: "tool_delta", session_id: "s", tool_id: id, chunk: JSON.stringify(args) });
    }
    clock.now = T0 + 6 * SECOND;
    for (const id of ["w1", "w2"]) live.post({ type: "tool_result", session_id: "s", tool_id: id, result: "ok", success: true, duration_ms: 20 });
    clock.now = T0 + 19 * SECOND;
    for (const [id, name, args] of [["e1", "edit_file", { path: "src/c.ts", old_string: "x", new_string: "y" }], ["r1", "read_file", { path: "README.md" }]] as const) {
      live.post({ type: "tool_start", session_id: "s", tool_id: id, tool_name: name, ts: sec(clock.now) });
      live.post({ type: "tool_delta", session_id: "s", tool_id: id, chunk: JSON.stringify(args) });
    }
    clock.now = T0 + 21 * SECOND;
    for (const id of ["e1", "r1"]) live.post({ type: "tool_result", session_id: "s", tool_id: id, result: "ok", success: true, duration_ms: 20 });
    clock.now = c.shellStart;
    live.post({ type: "tool_start", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", ts: sec(clock.now) });
    live.post({ type: "tool_delta", session_id: "s", tool_id: "sh1", chunk: '{"command":"npm test"}' });
    live.tick(1);
    clock.now = T0 + 1200 * SECOND;
    const late = attach({ now: clock.now }, c.messages, c.runtime);
    live.tick(1);
    late.tick(1);
    assert.equal(elapsedOf(late, "sh1"), elapsedOf(live, "sh1"), "the same command shows the same time in both views");
    assert.equal(groupsIn(lastReply(late)).length, groupsIn(lastReply(live)).length);
    assert.equal(titleOf(groupsIn(lastReply(late))[0]).split(" · ")[0], titleOf(groupsIn(lastReply(live))[0]).split(" · ")[0]);
    for (const w of [live, late]) {
      w.post({ type: "tool_result", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", result: "passed", success: true, duration_ms: 1117000 });
      w.post({ type: "text_delta", session_id: "s", text: "Done." });
      w.post({ type: "agent_done", session_id: "s", outcome: "success" });
    }
    const files = (w: Webview) => lastReply(w).querySelectorAll(".files-changed-card").map(cardFiles);
    assert.deepEqual(files(late), files(live));
    assert.equal(lastReply(late).querySelectorAll(".message-footer").length, 1);
  });

  it("when text came before the running group, both views time the group the same", () => {
    const r1 = call("r1", "read_file", { path: "a.ts" });
    const sh = call("sh1", "shell_exec", { command: "npm test" });
    const clock = { now: T0 };
    const live = attach(clock, [user("fix it", T0)], {});
    clock.now = T0 + 10 * SECOND;
    live.post({ type: "text_delta", session_id: "s", text: "Plan: read a.ts, then run the tests." });
    clock.now = T0 + 300 * SECOND;
    live.post({ type: "tool_start", session_id: "s", tool_id: "r1", tool_name: "read_file", ts: sec(clock.now) });
    live.post({ type: "tool_result", session_id: "s", tool_id: "r1", tool_name: "read_file", result: "a", success: true, duration_ms: 5 });
    clock.now = T0 + 310 * SECOND;
    live.post({ type: "tool_start", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", ts: sec(clock.now) });
    clock.now = T0 + 1200 * SECOND;
    const late = attach({ now: clock.now }, [
      user("fix it", T0),
      reply(T0 + 10 * SECOND, { content: "Plan: read a.ts, then run the tests.", turnStart: T0 }),
      reply(T0 + 300 * SECOND, { calls: [r1], turnStart: T0 }), result("r1", "a", T0 + 301 * SECOND),
      reply(T0 + 310 * SECOND, { calls: [sh], turnStart: T0 }),
    ], { tools: [liveTool(sh, sec(T0 + 310 * SECOND))] });
    live.tick(1);
    late.tick(1);
    const liveTitle = titleOf(groupsIn(lastReply(live)).at(-1)!);
    const lateTitle = titleOf(groupsIn(lastReply(late)).at(-1)!);
    assert.equal(lateTitle, liveTitle);
  });

  it("a late view times an adopted group like a live view even when its first tool's arguments streamed for long",
    { todo: "by the stated rule: history saves the reply's time, not when its first tool started streaming, so the views differ by that streaming time" }, () => {
    const clock = { now: T0 };
    const big = call("w1", "write_file", { path: "src/big.ts", content: "x".repeat(2000) });
    const sh = call("sh1", "shell_exec", { command: "npm test" });
    const live = attach(clock, [user("write it", T0)], {});
    clock.now = T0 + 5 * SECOND;
    live.post({ type: "tool_start", session_id: "s", tool_id: "w1", tool_name: "write_file", ts: sec(clock.now) });
    clock.now = T0 + 50 * SECOND;
    live.post({ type: "tool_delta", session_id: "s", tool_id: "w1", chunk: big.function.arguments });
    live.post({ type: "tool_result", session_id: "s", tool_id: "w1", tool_name: "write_file", result: "ok", success: true, duration_ms: 10 });
    clock.now = T0 + 60 * SECOND;
    live.post({ type: "tool_start", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", ts: sec(clock.now) });
    clock.now = T0 + 1200 * SECOND;
    const late = attach({ now: clock.now }, [
      user("write it", T0),
      reply(T0 + 50 * SECOND, { calls: [big], turnStart: T0 }), result("w1", "ok", T0 + 51 * SECOND),
      reply(T0 + 61 * SECOND, { calls: [sh], turnStart: T0 }),
    ], { tools: [liveTool(sh, sec(T0 + 60 * SECOND))] });
    live.tick(1);
    late.tick(1);
    assert.equal(titleOf(groupsIn(lastReply(late))[0]), titleOf(groupsIn(lastReply(live))[0]));
  });

  it("a group finished live and the same group redrawn from history say the same duration",
    { todo: "conflicts with guarantee 5: finished groups drawn from history still count from the prompt (m.duration)" }, () => {
    const clock = { now: T0 };
    const r1 = call("r1", "read_file", { path: "a.ts" });
    const live = attach(clock, [user("fix it", T0)], {});
    clock.now = T0 + 10 * SECOND;
    live.post({ type: "text_delta", session_id: "s", text: "Plan first." });
    clock.now = T0 + 300 * SECOND;
    live.post({ type: "tool_start", session_id: "s", tool_id: "r1", tool_name: "read_file", ts: sec(clock.now) });
    clock.now = T0 + 310 * SECOND;
    live.post({ type: "tool_result", session_id: "s", tool_id: "r1", tool_name: "read_file", result: "a", success: true, duration_ms: 10 });
    live.post({ type: "text_delta", session_id: "s", text: "Done." });
    live.post({ type: "agent_done", session_id: "s", outcome: "success" });
    const reloaded = attach({ now: clock.now }, [
      user("fix it", T0),
      reply(T0 + 10 * SECOND, { content: "Plan first.", turnStart: T0 }),
      reply(T0 + 300 * SECOND, { calls: [r1], turnStart: T0 }), result("r1", "a", T0 + 301 * SECOND),
      reply(T0 + 310 * SECOND, { content: "Done.", turnStart: T0 }),
    ], {}, false);
    assert.equal(titleOf(groupsIn(lastReply(reloaded))[0]), titleOf(groupsIn(lastReply(live))[0]));
  });

  it("a new group's header is never younger than a running tool in it", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const r1 = call("r1", "read_file", { path: "a.ts" });
    const x = call("x1", "grep_search", { query: "a" });
    const sh = call("sh1", "shell_exec", { command: "npm test" });
    const w = attach(clock, [
      user("fix it", T0),
      reply(T0 + 5 * SECOND, { content: "Looking.", calls: [r1], turnStart: T0 }), result("r1", "a", T0 + 6 * SECOND),
      reply(T0 + 30 * SECOND, { content: "Now the tests.", calls: [x, sh], turnStart: T0 }),
    ], { tools: [liveTool(x, undefined), liveTool(sh, sec(T0 + 29 * SECOND))] });
    w.tick(1);
    const group = groupsIn(lastReply(w)).at(-1)!;
    const header = headerSeconds(titleOf(group));
    const row = parseInt(String(elapsedOf(w, "sh1")), 10);
    assert.ok(header >= row, `the group says ${header}s while the command in it has run ${row}s`);
  });

  it("switching to another session and back mid-turn keeps one group, one row per tool and real timers", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, c.runtime);
    w.post({ type: "session_switched", sessionId: "other" });
    w.post({ type: "session_loaded", session: session([user("hi", T0), reply(T0 + SECOND, { content: "hello" })], {}, false, "other") });
    const otherPage = serialize(w.chat).join("\n");
    w.tick(3);
    assert.equal(serialize(w.chat).join("\n"), otherPage, "the other session's page is left alone while the first turn runs");
    w.post({ type: "tool_result", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", result: "passed", success: true, duration_ms: 1117000 });
    const g1 = call("g1", "grep_search", { query: "TODO" });
    const grepStart = clock.now;
    w.post({ type: "tool_start", session_id: "s", tool_id: "g1", tool_name: "grep_search", ts: sec(grepStart) });
    w.tick(10);
    w.post({ type: "session_switched", sessionId: "s" });
    const messages = [...c.messages, result("sh1", "passed", grepStart - SECOND), reply(grepStart, { calls: [g1], turnStart: T0 })];
    w.post({ type: "session_loaded", session: session(messages, { tools: [liveTool(g1, sec(grepStart))] }) });
    w.tick(1);
    const groups = groupsIn(lastReply(w));
    assert.equal(groups.length, 1);
    assert.equal(bodyRows(groups[0]).length, 6, "five finished tools and the running search");
    assert.equal(w.chat.querySelectorAll("#tool-g1").length, 1);
    assert.equal(titleOf(groups[0]), "6 tools · grep_search working... (1209s)");
    assert.equal(elapsedOf(w, "g1"), "11s");
    assert.equal(lastReply(w).querySelectorAll(".files-changed-card").length, 0);
  });

  it("loading the shown running session again redraws one group and keeps files edited live in between", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const w = attach(clock, c.messages, c.runtime);
    w.post({ type: "tool_result", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", result: "passed", success: true, duration_ms: 5 });
    const d = call("e2", "edit_file", { path: "src/d.ts", old_string: "1", new_string: "2" });
    liveEdit(w, "e2", "edit_file", { path: "src/d.ts", old_string: "1", new_string: "2" }, clock);
    const sh2 = call("sh2", "shell_exec", { command: "npm run lint" });
    w.post({ type: "tool_start", session_id: "s", tool_id: "sh2", tool_name: "shell_exec", ts: sec(clock.now) });
    w.tick(30);
    const messages = [...c.messages, result("sh1", "passed", T0 + 1200 * SECOND), reply(T0 + 1201 * SECOND, { calls: [d], turnStart: T0 }),
      result("e2", "ok", T0 + 1202 * SECOND), reply(T0 + 1203 * SECOND, { calls: [sh2], turnStart: T0 })];
    w.post({ type: "session_loaded", session: session(messages, { tools: [liveTool(sh2, sec(T0 + 1200 * SECOND))] }) });
    w.tick(1);
    const groups = groupsIn(lastReply(w));
    assert.equal(groups.length, 1);
    assert.equal(titleOf(groups[0]), "7 tools · shell_exec working... (1226s)");
    assert.equal(w.chat.querySelectorAll("#tool-sh2").length, 1);
    assert.equal(elapsedOf(w, "sh2"), "31s");
    w.post({ type: "tool_result", session_id: "s", tool_id: "sh2", tool_name: "shell_exec", result: "clean", success: true, duration_ms: 31000 });
    w.post({ type: "agent_done", session_id: "s", outcome: "success" });
    assert.deepEqual(lastReply(w).querySelectorAll(".files-changed-card").map(cardFiles), [["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]]);
  });

  it("a tool that finished between session.get and the replay is drawn once and ends done", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const messages = [...c.messages, result("sh1", "passed", clock.now - 100)];
    const w = attach(clock, messages, c.runtime);
    w.post({ type: "tool_result", session_id: "s", tool_id: "sh1", tool_name: "shell_exec", result: "passed", success: true, duration_ms: 1116000, event_seq: 51 });
    const groups = groupsIn(lastReply(w));
    assert.equal(groups.length, 1);
    assert.equal(bodyRows(groups[0]).length, 5);
    assert.equal(w.chat.querySelectorAll('[data-start-ts]').length, 0, "nothing is left counting");
    assert.equal(titleOf(groups[0]), "5 tools · all done · waiting for model... (1195s)");
  });

  it("a pending approval reads as waiting, and its timer restarts once approved", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const c = reportedCase();
    const approval = { type: "tool_approval_required", session_id: "s", approval_id: "ap1", tool_id: "sh1", tool_name: "shell_exec",
      args: { command: "npm test" }, event_seq: 2 };
    const w = attach(clock, c.messages, { tools: c.runtime.tools, interactions: [approval] });
    const seq = groupsIn(lastReply(w))[0];
    w.tick(1);
    assert.equal(titleOf(seq), "5 tools · waiting for your approval");
    assert.equal(elapsedOf(w, "sh1"), "");
    w.post({ type: "interaction_resolved", session_id: "s", interaction_id: "ap1" });
    w.tick(2);
    assert.equal(elapsedOf(w, "sh1"), "2s");
    assert.equal(titleOf(seq), "5 tools · shell_exec working... (1198s)");
  });

  it("a running sub-agent and a still-running background process keep their real state", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const bg = call("bg1", "shell_bg", { command: "npm run dev" });
    const sa = call("sa1", "spawn_subagent", { role: "tester", task: "run the suite" });
    const w = attach(clock, [
      user("start the server and test it", T0),
      reply(T0 + 5 * SECOND, { calls: [bg], turnStart: T0 }), result("bg1", "Started background process with id 'p1'", T0 + 6 * SECOND),
      reply(T0 + 10 * SECOND, { calls: [sa], turnStart: T0 }),
    ], { tools: [liveTool(sa, sec(T0 + 9 * SECOND))], processes: [{ process_id: "p1", session_id: "s", pid: 42, command: "npm run dev", status: "running" }] });
    w.tick(1);
    const groups = groupsIn(lastReply(w));
    assert.equal(groups.length, 1);
    assert.equal(titleOf(groups[0]), "2 tools · spawn_subagent working... (1196s)");
    assert.equal(elapsedOf(w, "sa1"), "1192s");
    w.post({ type: "tool_result", session_id: "s", tool_id: "sa1", tool_name: "spawn_subagent", result: JSON.stringify({ agent_id: "a1", status: "completed" }), success: true, duration_ms: 1191000 });
    assert.equal(titleOf(groups[0]), "2 tools · all done · waiting for model... (1196s)");
  });

  it("with many finished turns, only the running turn lacks its card and footer", () => {
    const clock = { now: T0 + 1200 * SECOND };
    const messages: any[] = [];
    for (let k = 0; k < 25; k++) {
      const start = T0 - (25 - k) * 120 * SECOND;
      messages.push(user("turn " + k, start), reply(start + 5 * SECOND, { calls: [call("t" + k, "write_file", { path: "src/f" + k + ".ts", content: "x" })], turnStart: start }),
        result("t" + k, "ok", start + 6 * SECOND), reply(start + 9 * SECOND, { content: "done " + k, turnStart: start }));
    }
    const c = reportedCase();
    const w = attach(clock, [...messages, ...c.messages.slice(4)], c.runtime);
    assert.equal(w.chat.querySelectorAll(".message-wrap.assistant .message-footer").length, 25);
    assert.equal(w.chat.querySelectorAll(".files-changed-card").length, 25);
    assert.equal(lastReply(w).querySelectorAll(".message-footer, .files-changed-card").length, 0);
    assert.equal(titleOf(groupsIn(lastReply(w))[0]), "5 tools · shell_exec working... (1195s)");
  });

  it("a tool id reused by the running turn does not hide an earlier turn's finished tool",
    { todo: "known older bug, not fixed in this branch: a reused tool id hides the earlier turn's row" }, () => {
    const clock = { now: T0 + 1200 * SECOND };
    const first = call("call_0", "write_file", { path: "src/x.ts", content: "x" });
    const again = call("call_0", "shell_exec", { command: "npm test" });
    const w = attach(clock, [
      user("write x", T0 - 600 * SECOND), reply(T0 - 590 * SECOND, { calls: [first], turnStart: T0 - 600 * SECOND }),
      result("call_0", "ok", T0 - 589 * SECOND), reply(T0 - 580 * SECOND, { content: "written", turnStart: T0 - 600 * SECOND }),
      user("test it", T0), reply(T0 + 5 * SECOND, { calls: [again], turnStart: T0 }),
    ], { tools: [liveTool(again, sec(T0 + 4 * SECOND))] });
    const earlier = replies(w)[0];
    assert.equal(groupsIn(earlier).length, 1, "the earlier turn still shows its tool");
    assert.deepEqual(earlier.querySelectorAll(".files-changed-card").map(cardFiles), [["src/x.ts"]]);
  });
});

