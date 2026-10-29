import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    Uri: { joinPath: (...parts: any[]) => ({ fsPath: parts.map(p => typeof p === "object" ? p.fsPath : String(p)).join("/") }) },
  };
  return originalRequire.apply(this, arguments as any);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
const { getChatViewHtml } = require("../src/providers/chatview/chatHtml.js");
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

function overlayMarkup(): string {
  const webview: any = { cspSource: "vscode-resource:", asWebviewUri: (u: any) => u };
  const html: string = getChatViewHtml(webview, { fsPath: "/ext", path: "/ext", scheme: "file", with: () => ({}) } as any, STATE as any);
  const start = html.indexOf('<div id="image-lightbox-overlay"');
  const end = html.indexOf('<div class="top-bar">', start);
  assert.ok(start > -1 && end > start, "the chat page has the image viewer");
  return html.slice(start, end);
}

function loadWebview() {
  const dom = new FakeDom();
  for (const id of PAGE_IDS) dom.body.appendChild(dom.el(id === "prompt-input" ? "textarea" : id === "btn-send" ? "button" : "div", { id }));
  for (const id of ["mode-popover", "slash-palette", "mention-palette", "reasoning-popover", "collab-inbox-popover",
    "profile-popover", "sp-menu"]) {
    const el = dom.body.appendChild(dom.el("div", { id }));
    el.style.display = "none";
  }
  const holder = dom.body.appendChild(dom.el("div"));
  holder.innerHTML = overlayMarkup();
  const nullIds = new Set(["questions-carousel-card"]);
  const posted: any[] = [];
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
  const sandbox: any = {
    acquireVsCodeApi: () => ({ postMessage: (m: any) => posted.push(m), getState: () => ({}), setState: () => {} }),
    document, window, navigator: { platform: "Win32", clipboard: stub(), userAgent: "node" }, localStorage: stub(),
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout: (fn: Function) => { dom.timers.push(() => fn()); return dom.timers.length; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (fn: Function) => { dom.timers.push(() => fn(0)); return 0; }, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Event: class { constructor(public type: string, public init?: any) {} },
    HTMLElement: FakeElement, Element: FakeElement, Node: FakeElement,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(__dirname, "..", "..", "media", "marked.min.js"), "utf8"), sandbox);
  vm.runInContext(getChatClientScript("icon.svg", STATE), sandbox);
  dom.timers.length = 0;

  const byId = (id: string) => dom.byId(id)!;
  return {
    dom, posted, sandbox, byId,
    input: byId("prompt-input"),
    chat: byId("chat-messages"),
    eval: (code: string) => vm.runInContext(code, sandbox),
    post: (data: any) => (dom.windowListeners.message || []).forEach(l => l.fn({ data })),
    key: (key: string, init: Record<string, any> = {}) => dom.dispatch("keydown", dom.activeElement, { key, ...init }),
    click: (el: FakeElement) => dom.dispatch("click", el),
    json: (code: string) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, sandbox)),
  };
}

type Webview = ReturnType<typeof loadWebview>;

// ── Images ───────────────────────────────────────────────────────────────────────────────────────────────────────

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const PNG = "data:image/png;base64," + b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = "data:image/jpeg;base64," + b64([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const GIF = "data:image/gif;base64," + b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 7]);
const WEBP = "data:image/webp;base64," + b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const thumb = (n: number) => "data:image/jpeg;base64," + b64([0xff, 0xd8, 0xff, n]);
const full = (n: number) => "data:image/png;base64," + b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n]);
const fileName = (n: number) => n.toString(16).padStart(16, "0") + ".jpg";

function noActiveMarkup(root: FakeElement): string[] {
  const problems: string[] = [];
  for (const el of [root, ...root.descendants()]) {
    if (["SCRIPT", "IFRAME", "OBJECT", "EMBED"].includes(el.tagName)) problems.push("<" + el.tagName + ">");
    for (const [name, value] of el.attrs) {
      if (/^on/i.test(name)) problems.push(`${el.tagName} ${name}=${value}`);
      if (["src", "href"].includes(name) && /^\s*javascript:/i.test(value)) problems.push(`${el.tagName} ${name}=${value}`);
    }
  }
  return problems;
}

function undoneNote(w: Webview): FakeElement {
  const note = w.chat.querySelectorAll(".system-note").at(-1);
  assert.ok(note, "an undo note is shown");
  return note;
}

const PROMPT_TEXT = "[Attached File: src/app.ts]\n[Attached File: docs/read me.md]\nFix the login bug\nand keep [brackets]" +
  "\n\n---\n[Active Document: src/app.ts (Language: typescript), Line: 3]\n[Other Open Documents: src/a.ts, src/b.ts]";

function turnUndone(w: Webview, undonePrompt: any, extra: Record<string, any> = {}) {
  w.post({ type: "turn_undone", turnsUndone: 1, undonePrompt, ...extra });
}

// ── Undo puts the prompt back ────────────────────────────────────────────────────────────────────────────────────

describe("undo puts the undone prompt back in the input box", () => {
  it("restores the text, the attached files and the images when the input box is empty", () => {
    const w = loadWebview();
    turnUndone(w, { text: PROMPT_TEXT, images: [PNG, JPEG] });
    assert.equal(w.input.value, "Fix the login bug\nand keep [brackets]", "without the editor context sent with it");
    assert.deepEqual(w.json("attachedImages"), [PNG, JPEG]);
    assert.deepEqual(w.json("attachedFiles"), [{ name: "app.ts", path: "src/app.ts" }, { name: "read me.md", path: "docs/read me.md" }]);
    const chips = w.byId("image-attachments-container").querySelectorAll("img.image-attachment-thumb");
    assert.deepEqual(chips.map((img: FakeElement) => img.getAttribute("src")), [PNG, JPEG]);
    assert.equal(w.dom.activeElement, w.input, "the input box has focus");
    assert.equal(w.input.selectionStart, w.input.value.length);
    assert.match(undoneNote(w).textContent, /Your prompt is back in the input box/);
    assert.equal(w.chat.querySelector('[data-action="restore-undone-prompt"]'), null);
  });

  it("keeps a draft's text, offers the prompt back, and puts it back once when asked", () => {
    const w = loadWebview();
    w.input.value = "my half-written idea";
    turnUndone(w, { text: PROMPT_TEXT, images: [PNG] });
    assert.equal(w.input.value, "my half-written idea");
    assert.deepEqual(w.json("attachedImages"), []);
    assert.deepEqual(w.json("attachedFiles"), []);
    const button = w.chat.querySelector('[data-action="restore-undone-prompt"]');
    assert.ok(button, "the undo note offers the prompt back");
    assert.equal(button.textContent, "Put the prompt back");
    assert.equal(button.tagName, "BUTTON");
    assert.match(undoneNote(w).textContent, /Your draft was kept/);

    w.click(button);
    assert.equal(w.input.value, "Fix the login bug\nand keep [brackets]");
    assert.deepEqual(w.json("attachedImages"), [PNG]);
    assert.equal(w.json("attachedFiles").length, 2);
    assert.equal(w.chat.querySelector('[data-action="restore-undone-prompt"]'), null, "the button goes once used");

    w.input.value = "typed again";
    w.click(button);
    assert.equal(w.input.value, "typed again", "a detached button does nothing");
  });

  it("keeps a draft that is only images or only files", () => {
    for (const draft of ["attachedImages = [" + JSON.stringify(GIF) + "]", "attachedFiles = [{ name: 'x.py', path: 'x.py' }]"]) {
      const w = loadWebview();
      w.eval(draft);
      const before = w.json("[attachedImages, attachedFiles]");
      turnUndone(w, { text: "do it", images: [PNG] });
      assert.deepEqual(w.json("[attachedImages, attachedFiles]"), before, draft);
      assert.equal(w.input.value, "");
      assert.ok(w.chat.querySelector('[data-action="restore-undone-prompt"]'), draft);
    }
  });

  it("treats a draft of only spaces as empty", () => {
    const w = loadWebview();
    w.input.value = "   \n ";
    turnUndone(w, { text: "do it", images: [] });
    assert.equal(w.input.value, "do it");
  });

  it("each undo note puts back its own prompt", () => {
    const w = loadWebview();
    w.input.value = "draft";
    turnUndone(w, { text: "first prompt", images: [] });
    turnUndone(w, { text: "second prompt", images: [PNG] });
    const [first, second] = w.chat.querySelectorAll('[data-action="restore-undone-prompt"]');
    w.click(second);
    assert.equal(w.input.value, "second prompt");
    assert.deepEqual(w.json("attachedImages"), [PNG]);
    w.click(first);
    assert.equal(w.input.value, "first prompt");
    assert.deepEqual(w.json("attachedImages"), []);
  });

  it("drops anything that is not image data and keeps at most five images", () => {
    const w = loadWebview();
    const huge = "data:image/png;base64," + "A".repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4);
    turnUndone(w, {
      text: "shots",
      images: ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "https://example.com/x.png", "data:text/html;base64,PGI+",
        "data:image/png,rawbytes", huge, 42, null, { src: PNG }, PNG, JPEG, GIF, WEBP, full(1), full(2), full(3)],
    });
    assert.deepEqual(w.json("attachedImages"), [PNG, JPEG, GIF, WEBP, full(1)]);
  });

  it("accepts an image of exactly 8 MB as the engine sends it", () => {
    const w = loadWebview();
    const eightMb = "data:image/webp;base64," + "A".repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4);
    turnUndone(w, { text: "", images: [eightMb] });
    assert.equal(w.json("attachedImages.length"), 1);
  });

  it("never turns restored text, file names or image data into markup", () => {
    const w = loadWebview();
    const text = '[Attached File: src/"><img src=x onerror=alert(1)>.ts]\n<img src=x onerror=alert(2)><script>alert(3)</script>';
    const image = PNG + '" onerror="alert(4)';
    turnUndone(w, { text, images: [image] });
    assert.equal(w.input.value, "<img src=x onerror=alert(2)><script>alert(3)</script>");
    for (const id of ["drag-dropped-files-bar", "image-attachments-container", "chat-messages"]) {
      assert.deepEqual(noActiveMarkup(w.byId(id)), [], id);
    }
    const chip = w.byId("image-attachments-container").querySelector("img");
    assert.equal(chip.getAttribute("src"), image, "the image stays one attribute value");
    const fileChip = w.byId("drag-dropped-files-bar").querySelector(".chip-name");
    assert.equal(fileChip.textContent, '"><img src=x onerror=alert(1)>.ts');

    const drafted = loadWebview();
    drafted.input.value = "draft";
    turnUndone(drafted, { text, images: [image] });
    assert.deepEqual(noActiveMarkup(drafted.chat), []);
    drafted.click(drafted.chat.querySelector('[data-action="restore-undone-prompt"]'));
    assert.deepEqual(noActiveMarkup(drafted.byId("drag-dropped-files-bar")), []);
  });

  it("gives back an empty input for a prompt that was only images", () => {
    const w = loadWebview();
    turnUndone(w, { text: "Please inspect attached image", images: [PNG] });
    assert.equal(w.input.value, "");
    assert.deepEqual(w.json("attachedImages"), [PNG]);
  });

  it("leaves the input alone when the engine could not read the prompt back", () => {
    for (const undonePrompt of [undefined, null, { text: "  ", images: [] }, { text: 5, images: "x" }, "text"]) {
      const w = loadWebview();
      w.input.value = "";
      turnUndone(w, undonePrompt);
      assert.equal(w.input.value, "", JSON.stringify(undonePrompt));
      assert.deepEqual(w.json("attachedImages"), []);
      assert.equal(w.chat.querySelector('[data-action="restore-undone-prompt"]'), null);
      assert.match(undoneNote(w).textContent, /Last turn undone/);
    }
  });

  it("keeps the restored prompt when the session already shown is reloaded, and still switches drafts", () => {
    const w = loadWebview();
    w.eval("sessionsState['s'] = { draftInput: 'stale draft' }; sessionsState['other'] = { draftInput: 'other draft' };");
    const loaded = (id: string) => w.post({ type: "session_loaded", session: { id, messages: [] } });
    const switchTo = (id: string) => { w.post({ type: "session_switched", sessionId: id }); loaded(id); };
    loaded("s");
    turnUndone(w, { text: "the undone prompt", images: [] });
    assert.equal(w.input.value, "the undone prompt");
    loaded("s");
    assert.equal(w.input.value, "the undone prompt", "a reload of the shown session keeps the input");
    switchTo("other");
    assert.equal(w.input.value, "other draft");
    switchTo("s");
    assert.equal(w.input.value, "the undone prompt", "the restored prompt became this session's draft");
  });
});

// ── Edit and resend ──────────────────────────────────────────────────────────────────────────────────────────────

function promptWithImages(w: Webview, opts: { steering?: boolean; count?: number; named?: boolean } = {}) {
  const count = opts.count ?? 3;
  w.post({ type: "session_loaded", session: { id: "s", messages: [
    { role: "user", content: "turn 0", ts: "2026-01-01T00:00:00Z" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "look at these", ts: "2026-01-01T00:01:00Z", images: Array.from({ length: count }, (_, i) => thumb(i)),
      image_files: opts.named === false ? undefined : Array.from({ length: count }, (_, i) => fileName(i)) },
    ...(opts.steering ? [{ role: "user", content: "and these", steering: true, ts: "2026-01-01T00:01:30Z",
      images: Array.from({ length: count }, (_, i) => thumb(10 + i)) }] : []),
    { role: "assistant", content: "seen" },
  ] } });
  const wraps = w.chat.querySelectorAll(".message-wrap.user");
  return wraps[wraps.length - 1];
}

function openEditor(w: Webview, wrap: FakeElement) {
  w.click(wrap.querySelector('[data-action="edit-prompt"]'));
  const box = wrap.querySelector(".prompt-edit-box");
  assert.ok(box, "the editor opens");
  return box;
}

function resend(w: Webview, box: FakeElement, text: string) {
  box.querySelector(".prompt-edit-input").value = text;
  w.click(box.querySelector('[data-action="resend-prompt"]'));
  const request = w.posted.filter(m => m.type === "undo_turn").at(-1);
  assert.equal(request?.resendPrompt, text);
  return request;
}

function sentImages(w: Webview, text: string) {
  const sent = w.posted.filter(m => (m.type === "send_prompt" || m.type === "submit_input") && m.prompt === text);
  assert.equal(sent.length, 1, "the edited prompt is sent once");
  return sent[0].images;
}

describe("edit and resend keeps the prompt's images", () => {
  it("shows each image with a labelled remove button", () => {
    const w = loadWebview();
    const box = openEditor(w, promptWithImages(w));
    const chips = box.querySelectorAll(".prompt-edit-images .image-attachment-chip");
    assert.deepEqual(chips.map((c: FakeElement) => c.querySelector("img").getAttribute("src")), [thumb(0), thumb(1), thumb(2)]);
    assert.deepEqual(chips.map((c: FakeElement) => c.querySelector("button").getAttribute("aria-label")),
      ["Remove image 1", "Remove image 2", "Remove image 3"]);
    assert.notEqual(box.querySelector(".prompt-edit-images").style.display, "none");
  });

  it("sends the images kept, full size, with the edited text", () => {
    const w = loadWebview();
    const box = openEditor(w, promptWithImages(w));
    w.click(box.querySelectorAll('[data-action="remove-edit-image"]')[1]);
    const chips = box.querySelectorAll(".prompt-edit-images img");
    assert.deepEqual(chips.map((img: FakeElement) => img.getAttribute("src")), [thumb(0), thumb(2)]);
    resend(w, box, "look at these again");
    turnUndone(w, { text: "look at these", images: [full(0), full(1), full(2)] }, { resendPrompt: "look at these again" });
    assert.deepEqual(sentImages(w, "look at these again"), [full(0), full(2)]);
  });

  it("sends no images once every image is removed", () => {
    const w = loadWebview();
    const box = openEditor(w, promptWithImages(w, { count: 2 }));
    w.click(box.querySelectorAll('[data-action="remove-edit-image"]')[0]);
    w.click(box.querySelectorAll('[data-action="remove-edit-image"]')[0]);
    assert.equal(box.querySelector(".prompt-edit-images").style.display, "none");
    resend(w, box, "no pictures now");
    turnUndone(w, { text: "look at these", images: [full(0), full(1)] }, { resendPrompt: "no pictures now" });
    assert.deepEqual(sentImages(w, "no pictures now"), []);
  });

  it("never pairs a message sent during a turn with the turn prompt's images", () => {
    const w = loadWebview();
    const box = openEditor(w, promptWithImages(w, { steering: true }));
    resend(w, box, "and these, edited");
    turnUndone(w, { text: "look at these", images: [full(0), full(1), full(2)] }, { resendPrompt: "and these, edited" });
    assert.deepEqual(sentImages(w, "and these, edited"), [thumb(10), thumb(11), thumb(12)]);
  });

  it("keeps images in their places when the engine could give back only some of them", () => {
    const w = loadWebview();
    const box = openEditor(w, promptWithImages(w));
    resend(w, box, "look again");
    turnUndone(w, { text: "look at these", images: [full(0), full(2)] }, { resendPrompt: "look again" });
    const images = sentImages(w, "look again");
    assert.equal(images.length, 3);
    assert.ok(!images.includes(full(2)) || images[2] === full(2), "an image is never sent in another's place");
  });

  it("removing an image never removes a different one", () => {
    const w = loadWebview();
    const box = openEditor(w, promptWithImages(w, { count: 3 }));
    for (const idx of ["7", "-1", "3", "x"]) {
      const remove = box.querySelector('[data-action="remove-edit-image"]');
      remove.setAttribute("data-idx", idx);
      w.click(remove);
      assert.deepEqual(box.querySelectorAll(".prompt-edit-images img").map((img: FakeElement) => img.getAttribute("src")),
        [thumb(0), thumb(1), thumb(2)], idx);
    }
  });
});

// ── The image viewer ─────────────────────────────────────────────────────────────────────────────────────────────

function viewer(w: Webview) {
  const overlay = w.byId("image-lightbox-overlay");
  return {
    overlay,
    open: () => overlay.classList.contains("open"),
    src: () => w.byId("image-lightbox-img").getAttribute("src"),
    counter: () => w.byId("image-lightbox-counter"),
    prev: () => w.byId("btn-lightbox-prev"),
    next: () => w.byId("btn-lightbox-next"),
    close: () => w.byId("btn-lightbox-close"),
    title: () => w.byId("image-lightbox-title").textContent,
  };
}

function promptThumbs(w: Webview, count: number, named = true) {
  const wrap = promptWithImages(w, { count, named });
  return wrap.querySelectorAll("img.prompt-image-thumb");
}

describe("the image viewer steps through a prompt's images", () => {
  it("opens on the image clicked with a counter and labelled previous and next buttons", () => {
    const w = loadWebview();
    const v = viewer(w);
    const thumbs = promptThumbs(w, 4);
    thumbs[1].focus();
    w.click(thumbs[1]);
    assert.ok(v.open());
    assert.equal(v.src(), thumb(1));
    assert.equal(v.counter().textContent, "2 of 4");
    assert.equal(v.counter().hidden, false);
    assert.equal(v.prev().hidden, false);
    assert.equal(v.next().hidden, false);
    assert.equal(v.prev().getAttribute("aria-label"), "Previous image");
    assert.equal(v.next().getAttribute("aria-label"), "Next image");
    assert.equal(v.close().getAttribute("aria-label"), "Close image preview");
    assert.equal(w.byId("image-lightbox-img").getAttribute("alt"), "Prompt image, 2 of 4");
    assert.equal(w.dom.activeElement, v.close(), "focus moves into the viewer");
  });

  it("wraps around at both ends with the arrow keys and the buttons", () => {
    const w = loadWebview();
    const v = viewer(w);
    w.click(promptThumbs(w, 4)[3]);
    assert.equal(v.counter().textContent, "4 of 4");
    w.key("ArrowRight");
    assert.equal(v.counter().textContent, "1 of 4");
    assert.equal(v.src(), thumb(0));
    w.key("ArrowLeft");
    assert.equal(v.counter().textContent, "4 of 4");
    w.click(v.next());
    w.click(v.next());
    assert.equal(v.counter().textContent, "2 of 4");
    w.click(v.prev());
    w.click(v.prev());
    assert.equal(v.counter().textContent, "4 of 4");
    assert.equal(v.src(), thumb(3));
  });

  it("shows no arrows or counter for a single image, and the arrow keys do nothing", () => {
    const w = loadWebview();
    const v = viewer(w);
    w.click(promptThumbs(w, 1)[0]);
    assert.ok(v.open());
    assert.equal(v.prev().hidden, true);
    assert.equal(v.next().hidden, true);
    assert.equal(v.counter().hidden, true);
    assert.equal(w.byId("image-lightbox-img").getAttribute("alt"), "Prompt image");
    w.key("ArrowRight");
    w.key("ArrowLeft");
    assert.equal(v.src(), thumb(0));
  });

  it("closes on Esc, gives focus back to the image that opened it, and denies nothing", () => {
    const w = loadWebview();
    const v = viewer(w);
    const rejected: string[] = [];
    const thumbs = promptThumbs(w, 2);
    w.eval("activePendingApprovalId = 'approval-1'; activePendingToolName = 'shell_exec';");
    w.sandbox.window.rejectTool = (id: string) => rejected.push(id);
    thumbs[0].focus();
    w.click(thumbs[0]);
    const esc = w.key("Escape");
    assert.equal(v.open(), false);
    assert.ok(esc.defaultPrevented);
    assert.equal(w.dom.activeElement, thumbs[0]);
    assert.deepEqual(rejected, [], "Esc for the viewer must not deny the pending approval");
    w.key("Escape");
    assert.deepEqual(rejected, ["approval-1"], "with the viewer closed Esc denies as before");
  });

  it("owns the arrow keys while open, so Alt+arrow steps the image instead of switching chats", () => {
    const w = loadWebview();
    const v = viewer(w);
    w.post({ type: "session_switched", sessionId: "second" });
    w.post({ type: "session_loaded", session: { id: "second", messages: [
      { role: "user", content: "shots", images: [thumb(0), thumb(1), thumb(2)] }, { role: "assistant", content: "ok" }] } });
    const navigations = () => JSON.parse(JSON.stringify(w.posted.filter(m => m.type === "navigate_session")));
    const first = w.chat.querySelector("img.prompt-image-thumb");
    first.focus();
    w.click(first);
    w.key("ArrowLeft", { altKey: true });
    assert.equal(v.counter().textContent, "3 of 3");
    assert.deepEqual(navigations(), []);
    w.key("Escape");
    assert.equal(w.dom.activeElement, first);
    w.key("ArrowLeft", { altKey: true });
    assert.deepEqual(navigations(), [{ type: "navigate_session", sessionId: "s" }],
      "with the viewer closed Alt+arrow goes back a chat as before");
  });

  it("keeps focus inside while open: Tab cycles its buttons and focus elsewhere comes back", () => {
    const w = loadWebview();
    const v = viewer(w);
    w.click(promptThumbs(w, 3)[0]);
    const order = [v.close(), v.prev(), v.next()];
    assert.equal(w.dom.activeElement, order[0]);
    for (const expected of [order[1], order[2], order[0]]) {
      w.key("Tab");
      assert.equal(w.dom.activeElement, expected);
    }
    w.key("Tab", { shiftKey: true });
    assert.equal(w.dom.activeElement, order[2]);
    w.input.focus();
    assert.ok(v.overlay.contains(w.dom.activeElement), "focus is pulled back into the viewer");
  });

  it("lets Tab land only on the close button when there is one image", () => {
    const w = loadWebview();
    const v = viewer(w);
    w.click(promptThumbs(w, 1)[0]);
    w.key("Tab");
    assert.equal(w.dom.activeElement, v.close());
    w.key("Tab", { shiftKey: true });
    assert.equal(w.dom.activeElement, v.close());
  });

  it("opens from the keyboard on a focused prompt image", () => {
    const w = loadWebview();
    const thumbs = promptThumbs(w, 2);
    thumbs[1].focus();
    w.key("Enter");
    assert.ok(viewer(w).open());
    assert.equal(viewer(w).counter().textContent, "2 of 2");
  });

  it("asks once for each full-size copy and shows it only if it is image data", () => {
    const w = loadWebview();
    const v = viewer(w);
    const thumbs = promptThumbs(w, 3);
    w.click(thumbs[0]);
    w.key("ArrowRight");
    w.key("ArrowLeft");
    assert.deepEqual(w.posted.filter(m => m.type === "load_prompt_image").map(m => m.name), [fileName(0), fileName(1)]);

    w.post({ type: "prompt_image", session_id: "s", name: fileName(0), uri: "javascript:alert(1)" });
    assert.equal(v.src(), thumb(0), "a reply that is not image data is never shown");
    w.post({ type: "prompt_image", session_id: "s", name: fileName(1), uri: full(1) });
    assert.equal(v.src(), thumb(0), "a reply for another image doesn't change the one shown");
    w.key("ArrowRight");
    assert.equal(v.src(), full(1));
    w.key("ArrowRight");
    w.post({ type: "prompt_image", session_id: "s", name: fileName(2), uri: full(2) });
    assert.equal(v.src(), full(2));
  });

  it("never asks for a file the chat could not have named", () => {
    const w = loadWebview();
    w.post({ type: "session_loaded", session: { id: "s", messages: [
      { role: "user", content: "x", images: [thumb(0), thumb(1), thumb(2)],
        image_files: ["../../secret.jpg", "0123456789ABCDEF.jpg", { name: "0123456789abcdef.jpg" }] },
    ] } });
    w.click(w.chat.querySelector("img.prompt-image-thumb"));
    w.key("ArrowRight");
    w.key("ArrowRight");
    assert.deepEqual(w.posted.filter(m => m.type === "load_prompt_image"), []);
  });

  it("forgets the oldest full-size copies beyond eight", () => {
    const w = loadWebview();
    for (let n = 0; n < 12; n++) w.post({ type: "prompt_image", session_id: "s", name: fileName(n), uri: full(n) });
    assert.equal(w.eval("fullImageCache.size"), 8);
    assert.equal(w.eval(`fullImageCache.has(${JSON.stringify(fileName(0))})`), false);
    assert.equal(w.eval(`fullImageCache.has(${JSON.stringify(fileName(11))})`), true);
  });

  it("steps through the input box's attachments and never opens from the remove button", () => {
    const w = loadWebview();
    const v = viewer(w);
    turnUndone(w, { text: "x", images: [PNG, JPEG, GIF] });
    const chips = w.byId("image-attachments-container").querySelectorAll(".image-attachment-chip");
    w.click(chips[1].querySelector(".image-attachment-remove"));
    assert.equal(v.open(), false);
    assert.deepEqual(w.json("attachedImages"), [PNG, GIF]);
    const remaining = w.byId("image-attachments-container").querySelectorAll(".image-attachment-chip");
    w.click(remaining[1].querySelector("img"));
    assert.ok(v.open());
    assert.equal(v.title(), "Attachment");
    assert.equal(v.counter().textContent, "2 of 2");
    assert.equal(v.src(), GIF);
    w.key("ArrowRight");
    assert.equal(v.src(), PNG);
    assert.deepEqual(w.posted.filter(m => m.type === "load_prompt_image"), []);
  });

  it("opens the edited prompt's images from the editor", () => {
    const w = loadWebview();
    const v = viewer(w);
    const box = openEditor(w, promptWithImages(w));
    w.click(box.querySelectorAll(".prompt-edit-images .image-attachment-chip")[2]);
    assert.ok(v.open());
    assert.equal(v.counter().textContent, "3 of 3");
  });
});
