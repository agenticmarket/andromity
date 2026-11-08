/**
 * Adversarial tests for the suggested-next-step draft card. They drive the real
 * webview code (next-step section, click cases, prompt keydown, session reload)
 * against a small DOM that parses the card markup, and try to make Send, Edit,
 * Tab and Dismiss act on something other than what the card shows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
const { getChatStyles } = require("../src/providers/chatview/chatStyles.js");
Module.prototype.require = originalRequire;

const script: string = getChatClientScript("icon.svg", {
  currentSessionId: "s1", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
}).replace(/\r\n/g, "\n");

function between(from: string, to: string): string {
  const start = script.indexOf(from);
  if (start < 0) throw new Error("webview script no longer contains: " + from);
  const end = script.indexOf(to, start + from.length);
  if (end < 0) throw new Error("webview script no longer contains: " + to);
  return script.slice(start, end);
}

// ── A small DOM: enough HTML parsing and selector matching to inspect the card ──

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", times: "×", middot: "·", hellip: "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(cp);
    }
    return e in NAMED_ENTITIES ? NAMED_ENTITIES[e] : m;
  });
}

class FText {
  readonly nodeType = 3;
  parentNode: FEl | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
}
type FNode = FEl | FText;

class FDoc {
  readonly documentElement: FEl;
  readonly body: FEl;
  private active: FEl | null = null;
  layout: (el: FEl) => { scrollHeight: number; clientHeight: number } = () => ({ scrollHeight: 0, clientHeight: 0 });
  constructor() {
    this.documentElement = new FEl(this, "html");
    this.body = new FEl(this, "body");
    this.documentElement.appendChild(this.body);
  }
  get activeElement(): FEl { return this.active && this.active.isConnected ? this.active : this.body; }
  setActive(el: FEl): void { this.active = el; }
  createElement(tag: string): FEl { return new FEl(this, tag); }
  getElementById(id: string): FEl | null { return this.documentElement.descendants().find(e => e.id === id) || null; }
  querySelector(sel: string): FEl | null { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel: string): FEl[] { return this.documentElement.querySelectorAll(sel); }
}

class FEl {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  childNodes: FNode[] = [];
  parentNode: FEl | null = null;
  style: Record<string, string> = {};
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  private rawHtml = "";
  constructor(readonly ownerDocument: FDoc, tag: string) { this.tagName = tag.toUpperCase(); }

  get id(): string { return this.getAttribute("id") || ""; }
  set id(v: string) { this.setAttribute("id", v); }
  get className(): string { return this.getAttribute("class") || ""; }
  set className(v: string) { this.setAttribute("class", v); }
  get hidden(): boolean { return this.hasAttribute("hidden"); }
  set hidden(v: boolean) { if (v) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get disabled(): boolean { return this.hasAttribute("disabled"); }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      add: (...cs: string[]) => { const l = list(); for (const c of cs) if (!l.includes(c)) l.push(c); this.className = l.join(" "); },
      remove: (...cs: string[]) => { this.className = list().filter(c => !cs.includes(c)).join(" "); },
      toggle: (c: string, force?: boolean) => {
        const want = force === undefined ? !list().includes(c) : force;
        if (want) this.classList.add(c); else this.classList.remove(c);
        return want;
      },
    };
  }
  getAttribute(k: string): string | null { const v = this.attributes.get(k.toLowerCase()); return v === undefined ? null : v; }
  setAttribute(k: string, v: unknown): void { this.attributes.set(k.toLowerCase(), String(v)); }
  removeAttribute(k: string): void { this.attributes.delete(k.toLowerCase()); }
  hasAttribute(k: string): boolean { return this.attributes.has(k.toLowerCase()); }

  get children(): FEl[] { return this.childNodes.filter((n): n is FEl => n.nodeType === 1); }
  appendChild<T extends FNode>(child: T): T {
    detach(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends FNode>(child: T, ref: FNode | null): T {
    if (!ref) return this.appendChild(child);
    detach(child);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error("NotFoundError: reference node is not a child");
    child.parentNode = this;
    this.childNodes.splice(i, 0, child);
    return child;
  }
  removeChild(child: FNode): FNode { detach(child); return child; }
  remove(): void { detach(this); }
  get isConnected(): boolean {
    let n: FEl = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }
  isHiddenInTree(): boolean {
    for (let n: FEl | null = this; n; n = n.parentNode) if (n.hidden) return true;
    return false;
  }
  get innerHTML(): string { return this.rawHtml; }
  set innerHTML(html: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.rawHtml = String(html);
    parseHtmlInto(this, this.rawHtml);
  }
  get textContent(): string { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.rawHtml = "";
    if (v) this.appendChild(new FText(String(v)));
  }
  descendants(): FEl[] {
    const out: FEl[] = [];
    const walk = (n: FEl) => { for (const c of n.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  matches(sel: string): boolean { return parseSelectorList(sel).some(cx => matchComplex(this, cx, NO_STATES)); }
  closest(sel: string): FEl | null {
    for (let n: FEl | null = this; n; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel: string): FEl[] { return this.descendants().filter(e => e.matches(sel)); }
  querySelector(sel: string): FEl | null { return this.querySelectorAll(sel)[0] || null; }
  focus(): void {
    if (!this.isConnected || this.isHiddenInTree() || this.disabled) return;
    this.ownerDocument.setActive(this);
  }
  get scrollHeight(): number { return this.ownerDocument.layout(this).scrollHeight; }
  get clientHeight(): number { return this.ownerDocument.layout(this).clientHeight; }
}

function detach(n: FNode): void {
  const p = n.parentNode;
  if (!p) return;
  const i = p.childNodes.indexOf(n);
  if (i >= 0) p.childNodes.splice(i, 1);
  n.parentNode = null;
}

function appendText(parent: FEl, raw: string, decode = true): void {
  if (!raw) return;
  const text = decode ? decodeEntities(raw) : raw;
  const last = parent.childNodes[parent.childNodes.length - 1];
  if (last && last.nodeType === 3) (last as FText).data += text;
  else parent.appendChild(new FText(text));
}

function parseHtmlInto(root: FEl, html: string): void {
  const stack: FEl[] = [root];
  const cur = () => stack[stack.length - 1];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { appendText(cur(), html.slice(i)); break; }
    const next = html[lt + 1] || "";
    if (html.startsWith("<!--", lt)) {
      appendText(cur(), html.slice(i, lt));
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (next === "/" && /[a-zA-Z]/.test(html[lt + 2] || "")) {
      appendText(cur(), html.slice(i, lt));
      const end = html.indexOf(">", lt);
      const name = html.slice(lt + 2, end < 0 ? n : end).trim().split(/\s/)[0].toUpperCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tagName === name) { stack.length = k; break; }
      }
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) { appendText(cur(), html.slice(i, lt + 1)); i = lt + 1; continue; }
    appendText(cur(), html.slice(i, lt));
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(html[j])) j++;
    const el = new FEl(root.ownerDocument, html.slice(lt + 1, j));
    let selfClosing = false;
    for (;;) {
      while (j < n && (/\s/.test(html[j]) || (html[j] === "/" && html[j + 1] !== ">"))) j++;
      if (j >= n) break;
      if (html[j] === ">") { j++; break; }
      if (html.startsWith("/>", j)) { selfClosing = true; j += 2; break; }
      const nameStart = j;
      j++;
      while (j < n && !/[\s/>=]/.test(html[j])) j++;
      const name = html.slice(nameStart, j).toLowerCase();
      while (j < n && /\s/.test(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === "\"" || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const vs = j;
          while (j < n && !/[\s>]/.test(html[j])) j++;
          value = html.slice(vs, j);
        }
      }
      if (!el.hasAttribute(name)) el.setAttribute(name, decodeEntities(value));
    }
    cur().appendChild(el);
    const tag = el.tagName.toLowerCase();
    if (RAW_TEXT_TAGS.has(tag) && !selfClosing) {
      const close = html.toLowerCase().indexOf("</" + tag, j);
      appendText(el, html.slice(j, close < 0 ? n : close), tag === "textarea" || tag === "title");
      const end = close < 0 ? n : html.indexOf(">", close);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(el);
    i = j;
  }
}

// ── Selectors (shared by the DOM above and the CSS checks below) ──

interface AttrSel { name: string; op: string; value: string }
interface Compound { tag: string | null; id: string | null; classes: string[]; attrs: AttrSel[]; nots: Complex[][]; pseudos: string[]; pseudoElement: boolean }
interface Complex { parts: Compound[]; combs: string[] }

const NO_STATES: ReadonlySet<string> = new Set();
const STATE_PSEUDOS = new Set(["hover", "focus", "focus-visible", "focus-within", "active"]);
const selectorCache = new Map<string, Complex[]>();

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "\"" || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

function readIdent(s: string, i: number): [string, number] {
  const re = /-?-?[_a-zA-Z -￿][-\w -￿]*/y;
  re.lastIndex = i;
  const m = re.exec(s);
  if (!m) throw new Error("bad selector near: " + s.slice(i));
  return [m[0], i + m[0].length];
}

function parseSelectorList(sel: string): Complex[] {
  const cached = selectorCache.get(sel);
  if (cached) return cached;
  const list = splitTopLevel(sel, ",").map(parseComplex);
  selectorCache.set(sel, list);
  return list;
}

function parseComplex(s: string): Complex {
  const parts: Compound[] = [];
  const combs: string[] = [];
  let i = 0;
  for (;;) {
    const [c, ni] = parseCompound(s, i);
    parts.push(c);
    i = ni;
    let ws = false;
    while (i < s.length && /\s/.test(s[i])) { i++; ws = true; }
    if (i >= s.length) break;
    if (">+~".includes(s[i])) {
      combs.push(s[i]);
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
    } else if (ws) combs.push(" ");
    else throw new Error("bad selector: " + s);
  }
  return { parts, combs };
}

function parseCompound(s: string, i: number): [Compound, number] {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [], nots: [], pseudos: [], pseudoElement: false };
  const start = i;
  if (s[i] === "*") i++;
  else if (/[a-zA-Z]/.test(s[i] || "")) { const [t, ni] = readIdent(s, i); c.tag = t.toLowerCase(); i = ni; }
  for (;;) {
    const ch = s[i];
    if (ch === "#") { const [v, ni] = readIdent(s, i + 1); c.id = v; i = ni; }
    else if (ch === ".") { const [v, ni] = readIdent(s, i + 1); c.classes.push(v); i = ni; }
    else if (ch === "[") {
      let j = i + 1;
      let quote = "";
      for (; j < s.length; j++) {
        const cj = s[j];
        if (quote) { if (cj === quote) quote = ""; continue; }
        if (cj === "\"" || cj === "'") quote = cj;
        else if (cj === "]") break;
      }
      const m = /^([-\w:]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(?:[iIsS])?)?$/.exec(s.slice(i + 1, j).trim());
      if (!m) throw new Error("bad attribute selector: " + s.slice(i, j + 1));
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || "", value: m[3] ?? m[4] ?? m[5] ?? "" });
      i = j + 1;
    } else if (ch === ":") {
      if (s[i + 1] === ":") { const [, ni] = readIdent(s, i + 2); c.pseudoElement = true; i = ni; continue; }
      const [name, ni] = readIdent(s, i + 1);
      i = ni;
      let arg = "";
      if (s[i] === "(") {
        let depth = 0;
        let j = i;
        for (; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")") { depth--; if (depth === 0) break; }
        }
        arg = s.slice(i + 1, j);
        i = j + 1;
      }
      const lname = name.toLowerCase();
      if (lname === "not") c.nots.push(parseSelectorList(arg));
      else if (lname === "before" || lname === "after") c.pseudoElement = true;
      else c.pseudos.push(arg ? lname + "(" + arg + ")" : lname);
    } else break;
  }
  if (i === start) throw new Error("bad selector: " + s.slice(start));
  return [c, i];
}

function matchCompound(el: FEl, c: Compound, states: ReadonlySet<string>): boolean {
  if (c.pseudoElement) return false;
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id !== null && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
    if (a.op === "|=" && v !== a.value && !v.startsWith(a.value + "-")) return false;
  }
  for (const not of c.nots) if (not.some(cx => matchComplex(el, cx, states))) return false;
  for (const p of c.pseudos) {
    if (STATE_PSEUDOS.has(p)) { if (!states.has(p)) return false; }
    else if (p === "disabled") { if (!el.disabled) return false; }
    else if (p === "enabled") { if (el.disabled) return false; }
    else if (p === "first-child") { if (!el.parentNode || el.parentNode.children[0] !== el) return false; }
    else if (p === "last-child") { const k = el.parentNode ? el.parentNode.children : []; if (k[k.length - 1] !== el) return false; }
    else return false;
  }
  return true;
}

function matchComplex(el: FEl, cx: Complex, states: ReadonlySet<string>): boolean {
  const rec = (node: FEl, idx: number): boolean => {
    if (!matchCompound(node, cx.parts[idx], states)) return false;
    if (idx === 0) return true;
    const comb = cx.combs[idx - 1];
    if (comb === ">") return Boolean(node.parentNode) && rec(node.parentNode as FEl, idx - 1);
    if (comb === " ") {
      for (let p = node.parentNode; p; p = p.parentNode) if (rec(p, idx - 1)) return true;
      return false;
    }
    const sibs = node.parentNode ? node.parentNode.children : [];
    const at = sibs.indexOf(node);
    if (comb === "+") return at > 0 && rec(sibs[at - 1], idx - 1);
    for (let k = at - 1; k >= 0; k--) if (rec(sibs[k], idx - 1)) return true;
    return false;
  };
  return rec(el, cx.parts.length - 1);
}

function specificity(cx: Complex): number {
  let a = 0, b = 0, c = 0;
  for (const p of cx.parts) {
    if (p.id) a++;
    b += p.classes.length + p.attrs.length + p.pseudos.length;
    if (p.tag) c++;
    if (p.pseudoElement) c++;
    for (const n of p.nots) {
      const best = Math.max(0, ...n.map(specificity));
      a += Math.floor(best / 1e6);
      b += Math.floor(best / 1e3) % 1e3;
      c += best % 1e3;
    }
  }
  return a * 1e6 + b * 1e3 + c;
}

// ── CSS ──

interface CssRule { selectors: string[]; decls: [string, string][]; order: number; media: string | null }

function parseCss(css: string): CssRule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  let order = 0;
  const findClose = (s: string, open: number): number => {
    let depth = 0;
    let quote = "";
    for (let j = open; j < s.length; j++) {
      const ch = s[j];
      if (quote) { if (ch === quote && s[j - 1] !== "\\") quote = ""; continue; }
      if (ch === "\"" || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return j; }
    }
    return s.length;
  };
  const walk = (s: string, media: string | null) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf("{", i);
      if (open < 0) return;
      let prelude = s.slice(i, open);
      const semi = prelude.lastIndexOf(";");
      if (semi >= 0) prelude = prelude.slice(semi + 1);
      prelude = prelude.trim();
      const close = findClose(s, open);
      const body = s.slice(open + 1, close);
      if (prelude.startsWith("@")) {
        if (/^@(media|supports|container|layer)\b/.test(prelude)) walk(body, prelude);
      } else {
        const decls = splitTopLevel(body, ";").map(d => {
          const k = d.indexOf(":");
          return k < 0 ? null : [d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim().replace(/\s*!important$/i, "")];
        }).filter(Boolean) as [string, string][];
        rules.push({ selectors: splitTopLevel(prelude, ","), decls, order: order++, media });
      }
      i = close + 1;
    }
  };
  walk(src, null);
  return rules;
}

function cascade(el: FEl, rules: CssRule[], states: ReadonlySet<string> = NO_STATES): Map<string, string> {
  const hits: { spec: number; order: number; decls: [string, string][] }[] = [];
  for (const r of rules) {
    if (r.media) continue;
    let best = -1;
    for (const sel of r.selectors) {
      let list: Complex[];
      try { list = parseSelectorList(sel); } catch { continue; }
      for (const cx of list) if (matchComplex(el, cx, states)) best = Math.max(best, specificity(cx));
    }
    if (best >= 0) hits.push({ spec: best, order: r.order, decls: r.decls });
  }
  hits.sort((x, y) => x.spec - y.spec || x.order - y.order);
  const out = new Map<string, string>();
  for (const h of hits) for (const [k, v] of h.decls) { out.delete(k); out.set(k, v); }
  return out;
}

const INHERITED = new Set(["white-space", "overflow-wrap", "word-wrap", "word-break"]);
function computed(el: FEl, prop: string, rules: CssRule[]): string {
  const own = cascade(el, rules).get(prop);
  if (own !== undefined && own !== "inherit") return own;
  if ((INHERITED.has(prop) || own === "inherit") && el.parentNode) return computed(el.parentNode, prop, rules);
  return "";
}

function withoutVarFallbacks(v: string): string {
  let out = "";
  let i = 0;
  while (i < v.length) {
    if (v.startsWith("var(", i)) {
      let depth = 0;
      let comma = -1;
      let j = i + 3;
      for (; j < v.length; j++) {
        const ch = v[j];
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) break; }
        else if (ch === "," && depth === 1 && comma < 0) comma = j;
      }
      out += "var(" + v.slice(i + 4, comma > 0 ? comma : j).trim() + ")";
      i = j + 1;
      continue;
    }
    out += v[i++];
  }
  return out;
}

// ── The webview code under test, loaded into a sandbox ──

const DEFAULT_PLACEHOLDER = "Ask Andromity…";
const TAB_HINT = "  ·  Tab to use";
const EVENTS = new Set(["shown", "run", "new_session", "tab", "dismissed"]);

function webviewSources() {
  const escape = between("    function escapeHtml(str) {", "    function isImageDataUri");
  const section = between("// ── Next-step suggestion", "// ── End next-step suggestion");
  const runCase = between("        case 'next-step-run':", "        case 'secret-redact-send':");
  const otherCases = between("        case 'next-step-new-session':", "        case 'feature-tip-run':");
  const keyStart = "      promptInput.addEventListener('keydown', (e) => {\n";
  const keyBody = between(keyStart, "        // Prompt history navigation").slice(keyStart.length);
  const reloadBlock = between("          if (currentSessionId && !nextStepBySession[currentSessionId] && !sessionIsRunning &&", "          if (msg.session) {");
  const hint = between("    const promptBaseEl = document.querySelector('.prompt-box');", "    if (promptInput) {\n      promptInput.addEventListener('keydown'");
  return {
    core: [
      escape,
      "function dispatchPrompt(text, attachContext, images, delivery) {\n" +
        "  setNextStep(currentSessionId, null);\n" +
        "  __dispatched.push({ text: text, delivery: delivery === undefined ? null : delivery });\n" +
        "}",
      section,
      "function __click(target) {\n  const e = { stopPropagation() {}, preventDefault() {} };\n  switch (target.getAttribute('data-action')) {\n" + runCase + otherCases + "  }\n}",
      "function __keydown(e) {\n" + keyBody + "}",
      "function __reload(allMessages, sessionIsRunning) {\n  chatContainer.innerHTML = '';\n  const historyNextStep = nextStepFromHistory(allMessages);\n" + reloadBlock + "  renderNextStep();\n}",
    ].join("\n"),
    hint,
  };
}

function countLines(text: string, perLine: number): number {
  return text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

interface RtOptions { queue?: boolean; running?: boolean; withHint?: boolean; tipCard?: boolean }

function makeRuntime(opts: RtOptions = {}) {
  const doc = new FDoc();
  const env = { visible: true, charsPerLine: 50, lineHeight: 19.5 };
  doc.layout = (el: FEl) => {
    if (!env.visible || !el.isConnected) return { scrollHeight: 0, clientHeight: 0 };
    if (el.tagName === "TEXTAREA") return { scrollHeight: 40, clientHeight: 40 };
    if (el.classList.contains("next-step-prompt")) {
      const full = Math.round(countLines(el.textContent, env.charsPerLine) * env.lineHeight);
      const clamp = Math.round(Math.min(countLines(el.textContent, env.charsPerLine), 3) * env.lineHeight);
      return { scrollHeight: full, clientHeight: el.classList.contains("expanded") ? Math.min(full, 240) : clamp };
    }
    return { scrollHeight: 0, clientHeight: 0 };
  };
  const chat = doc.createElement("div");
  chat.id = "chat-messages";
  chat.className = "chat-container";
  doc.body.appendChild(chat);
  const promptBox = doc.createElement("div");
  promptBox.className = "prompt-box";
  const input = doc.createElement("textarea");
  input.id = "prompt-input";
  input.setAttribute("placeholder", DEFAULT_PLACEHOLDER);
  promptBox.appendChild(input);
  const sendBtn = doc.createElement("button");
  sendBtn.id = "btn-send";
  promptBox.appendChild(sendBtn);
  doc.body.appendChild(promptBox);
  if (opts.tipCard) {
    const tip = doc.createElement("div");
    tip.id = "feature-tip-card";
    chat.appendChild(tip);
  }

  const observers: { targets: Set<FEl>; cb: (entries: any[]) => void }[] = [];
  class FakeResizeObserver {
    targets = new Set<FEl>();
    constructor(public cb: (entries: any[]) => void) { observers.push(this); }
    observe(t: FEl) { this.targets.add(t); }
    unobserve(t: FEl) { this.targets.delete(t); }
    disconnect() { this.targets.clear(); }
  }
  const mutationCallbacks: (() => void)[] = [];
  class FakeMutationObserver {
    constructor(private cb: () => void) {}
    observe() { mutationCallbacks.push(this.cb); }
    disconnect() {}
  }

  const posted: any[] = [];
  const dispatched: any[] = [];
  const sandbox: any = {
    document: doc, ResizeObserver: FakeResizeObserver, MutationObserver: FakeMutationObserver, navigator: { platform: "Win32" },
    vscode: { postMessage: (m: any) => posted.push(JSON.parse(JSON.stringify(m))) },
    currentSessionId: "s1",
    sessionsState: { s1: { isRunning: Boolean(opts.running) } },
    queueSupported: opts.queue !== false, isRunning: Boolean(opts.running),
    promptQueue: [] as any[], renderQueue() {}, promptInput: input, sendBtn, chatContainer: chat,
    extractMessageText: (c: any) => (typeof c === "string" ? c : ""),
    scrollToBottomIfNeeded() {},
    mentionPalette: null, slashPalette: null, currentMentionMatches: [], currentSlashMatches: [],
    sendCurrentPrompt() { throw new Error("the composer's own send must not run"); },
    appendSystemNote() {},
    __dispatched: dispatched,
  };
  vm.createContext(sandbox);
  const src = webviewSources();
  vm.runInContext(src.core, sandbox);
  if (opts.withHint) vm.runInContext(src.hint, sandbox);

  const q = (s: string) => JSON.stringify(s);
  const rt = {
    sandbox, doc, env, input, chat, promptBox, posted, dispatched, observers,
    run: (code: string): any => vm.runInContext(code, sandbox),
    card: (): FEl | null => doc.getElementById("next-step-card"),
    q: (sel: string): FEl | null => { const c = rt.card(); return c ? c.querySelector(sel) : null; },
    shown: (): string | null => { const p = rt.q(".next-step-prompt"); return p ? p.textContent : null; },
    step: (): any => rt.run("currentNextStep()"),
    events: (): string[] => posted.filter(m => m.type === "next_step_event").map(m => m.event),
    starts: (): any[] => posted.filter(m => m.type === "start_next_step_session"),
    suggest(raw: any, sid = "s1") { sandbox.__raw = raw; rt.run("receiveNextStep(" + q(sid) + ", __raw)"); },
    click(el: FEl | null) {
      if (!el) throw new Error("nothing to click");
      if (!el.isConnected) throw new Error("cannot click a detached element");
      if (el.isHiddenInTree()) throw new Error("cannot click a hidden element");
      const target = el.closest("[data-action]");
      if (target) sandbox.__click(target);
    },
    act(action: string) { rt.click(rt.q("[data-action=\"" + action + "\"]")); },
    select(i: number) { rt.click(rt.q(".next-step-option[data-opt-idx=\"" + i + "\"]")); },
    key(key: string, extra: Record<string, unknown> = {}) {
      const e: any = {
        key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 0, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra,
      };
      sandbox.__keydown(e);
      return e;
    },
    reload(history: any[], running = false) { sandbox.__history = history; rt.run("__reload(__history, " + running + ")"); },
    switchTo(sid: string, history: any[] = [], running = false) {
      sandbox.currentSessionId = sid;
      sandbox.sessionsState[sid] = sandbox.sessionsState[sid] || {};
      sandbox.sessionsState[sid].isRunning = running;
      sandbox.isRunning = running;
      rt.reload(history, running);
    },
    startTurn(sid = "s1") {
      rt.run("setNextStep(" + q(sid) + ", null); sessionsState[" + q(sid) + "] = sessionsState[" + q(sid) + "] || {}; sessionsState[" + q(sid) + "].isRunning = true;");
      if (sid === sandbox.currentSessionId) {
        sandbox.isRunning = true;
        promptBox.classList.add("is-generating");
        rt.fireMutations();
      }
    },
    endTurn(sid = "s1") {
      sandbox.sessionsState[sid].isRunning = false;
      if (sid === sandbox.currentSessionId) {
        sandbox.isRunning = false;
        promptBox.classList.remove("is-generating");
        rt.run("renderNextStep()");
        rt.fireMutations();
      }
    },
    fireResize() {
      for (const o of observers) {
        const entries = [...o.targets].map(target => ({ target }));
        if (entries.length) o.cb(entries);
      }
    },
    fireMutations() { for (const cb of mutationCallbacks) cb(); },
    liveObservers: () => observers.filter(o => o.targets.size > 0),
  };
  return rt;
}
type Rt = ReturnType<typeof makeRuntime>;

const SINGLE = { title: "Add tests", prompt: "Add tests for parse() covering empty input" };
const CHOICE = {
  question: "Which fix first?",
  options: [
    { title: "Fix parser", prompt: "Fix the parser null check in src/parser.ts" },
    { title: "Fix tests", prompt: "Fix the flaky test in test/parse.test.ts\nthen rerun the suite", new_session: true },
    { title: "Write docs", prompt: "Document the parse() edge cases in docs/parse.md" },
  ],
};
const LONG = Array.from({ length: 8 }, (_, i) => "Line " + (i + 1) + " of a long suggested prompt").join("\n");

function historyWith(raw: any, closedByUser = false): any[] {
  const msgs: any[] = [
    { role: "user", content: "why does parse crash?" },
    { role: "assistant", content: "", tool_calls: [{ id: "n1", function: { name: "suggest_next_step", arguments: JSON.stringify(raw) } }] },
    { role: "tool", tool_call_id: "n1", content: "ok" },
    { role: "assistant", content: "Found it." },
  ];
  if (closedByUser) msgs.push({ role: "user", content: "thanks" });
  return msgs;
}

/** The card must agree with itself: one selected option, and Send, Edit, the shown prompt and the placeholder all name it. */
function checkConsistent(rt: Rt, label: string): number {
  const card = rt.card();
  assert.ok(card, label + ": the card is still showing");
  const step = rt.step();
  assert.ok(step, label + ": a suggestion is current");
  const send = card.querySelector("[data-action=\"next-step-run\"]");
  const edit = card.querySelector("[data-action=\"next-step-edit\"]");
  assert.ok(send && edit, label + ": Send and Edit are drawn");
  let idx = 0;
  if (step.options.length > 1) {
    const pressed = card.querySelectorAll(".next-step-option[aria-pressed=\"true\"]");
    assert.equal(pressed.length, 1, label + ": exactly one option is selected");
    idx = Number(pressed[0].getAttribute("data-opt-idx"));
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < step.options.length, label + ": the selected index is a real option");
    assert.ok(pressed[0].textContent.startsWith(step.options[idx].title), label + ": the selected button shows that option");
  }
  assert.equal(send.getAttribute("data-opt-idx"), String(idx), label + ": Send targets the selected option");
  assert.equal(edit.getAttribute("data-opt-idx"), String(idx), label + ": Edit targets the selected option");
  assert.equal(rt.shown(), step.options[idx].prompt, label + ": the card shows the selected option's prompt");
  assert.equal(rt.input.getAttribute("placeholder"), step.options[idx].title + TAB_HINT, label + ": the placeholder names the selected option");
  const elsewhere = step.options.length > 1 && step.options[idx].new_session;
  assert.equal(send.textContent.trim(), elsewhere ? "Start session" : "Send", label + ": the Send label says where it runs");
  return idx;
}

/** Clicks Send and checks that what went out is exactly what the card showed. */
function sendMatchesShown(rt: Rt, label: string): void {
  const shown = rt.shown();
  const step = rt.step();
  const idx = checkConsistent(rt, label);
  const before = rt.posted.length;
  rt.act("next-step-run");
  const starts = rt.posted.slice(before).filter(m => m.type === "start_next_step_session");
  if (step.options.length > 1 && step.options[idx].new_session) {
    assert.equal(rt.dispatched.length, 0, label + ": a new-session option dispatches nothing here");
    assert.equal(starts.length, 1, label + ": a new-session option starts exactly one session");
    assert.equal(starts[0].prompt, shown, label + ": the new session gets the shown prompt");
    assert.equal(starts[0].title, step.options[idx].title, label + ": the new session gets the shown option's title");
  } else {
    assert.equal(starts.length, 0, label + ": a local option starts no session");
    assert.equal(rt.dispatched.length, 1, label + ": Send dispatches exactly once");
    assert.equal(rt.dispatched[0].text, shown, label + ": Send dispatches exactly the shown text");
  }
  assert.ok(rt.card() === null, label + ": the card is gone after Send");
}

// ── Tests ──

describe("Draft card: Send delivers exactly what the card shows", () => {
  it("a single step shows and sends the same text for awkward prompts", () => {
    const prompts = [
      "  Fix it\n\n  then   run the tests  \n",
      "Use `a && b`, <b>bold</b>, &amp; \"double\" and 'single' quotes\tand a tab",
      "&lt;already escaped&gt; &#60;i&#62; &times; &nbsp;",
      "x".repeat(2600),
      "a".repeat(400) + "\n" + "b ".repeat(300),
    ];
    for (const prompt of prompts) {
      const rt = makeRuntime();
      rt.suggest({ title: "Do it", prompt });
      const expected = prompt.trim().slice(0, 2000);
      assert.equal(rt.shown(), expected, "shown text for " + JSON.stringify(prompt.slice(0, 30)));
      sendMatchesShown(rt, "single " + JSON.stringify(prompt.slice(0, 30)));
    }
  });

  it("a choice sends the shown prompt of whichever option is selected", () => {
    for (let k = 0; k < CHOICE.options.length; k++) {
      const rt = makeRuntime();
      rt.suggest(CHOICE);
      if (k !== 0) rt.select(k);
      assert.equal(rt.shown(), CHOICE.options[k].prompt);
      sendMatchesShown(rt, "option " + k);
    }
  });

  it("the first option is selected by default", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    assert.equal(checkConsistent(rt, "default"), 0);
  });

  it("stays consistent through rapid re-selection", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    for (const k of [2, 0, 1, 2, 1, 1, 0, 2]) {
      rt.select(k);
      assert.equal(checkConsistent(rt, "after selecting " + k), k);
    }
    sendMatchesShown(rt, "after rapid re-selection");
  });

  it("keeps the selection through expand, turn-end re-render, session switch and session reload", () => {
    const rt = makeRuntime();
    rt.reload(historyWith(CHOICE));
    rt.select(2);
    rt.run("toggleNextStepPrompt(); toggleNextStepPrompt(); toggleNextStepPrompt();");
    rt.run("renderNextStep(); renderNextStep();");
    assert.equal(checkConsistent(rt, "after re-renders"), 2);
    rt.switchTo("s2", []);
    assert.ok(rt.card() === null, "another session shows no card");
    assert.equal(rt.input.getAttribute("placeholder"), DEFAULT_PLACEHOLDER);
    rt.switchTo("s1", historyWith(CHOICE));
    assert.equal(checkConsistent(rt, "after switching back"), 2);
    rt.reload(historyWith(CHOICE));
    assert.equal(checkConsistent(rt, "after reloading the session"), 2);
    sendMatchesShown(rt, "after re-renders");
  });

  it("leaves typed text alone, with and without queue delivery", () => {
    for (const queue of [true, false]) {
      const rt = makeRuntime({ queue });
      rt.suggest(CHOICE);
      rt.select(2);
      rt.input.value = "my half-written draft";
      rt.act("next-step-run");
      assert.equal(rt.input.value, "my half-written draft", "queue=" + queue);
      assert.deepEqual(JSON.parse(JSON.stringify(rt.dispatched)), [{ text: CHOICE.options[2].prompt, delivery: queue ? "queue" : null }], "queue=" + queue);
    }
  });

  it("does not dispatch twice when Send is activated twice", () => {
    const rt = makeRuntime();
    rt.suggest(SINGLE);
    const send = rt.q("[data-action=\"next-step-run\"]") as FEl;
    rt.click(send);
    rt.sandbox.__click(send);
    rt.run("runNextStep('0')");
    assert.equal(rt.dispatched.length, 1);
  });
});

describe("Draft card: new sessions", () => {
  it("Send on a new-session option starts a session with exactly that option and runs nothing here", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    rt.select(1);
    rt.input.value = "draft";
    rt.act("next-step-run");
    assert.equal(rt.dispatched.length, 0);
    assert.deepEqual(rt.starts(), [{ type: "start_next_step_session", title: "Fix tests", prompt: CHOICE.options[1].prompt, sessionId: "s1" }]);
    assert.ok(!rt.events().includes("run"), "running elsewhere is not counted as a run here");
    assert.equal(rt.input.value, "draft");
    assert.ok(rt.card() === null);
  });

  it("moving the selection off a new-session option makes Send run here again", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    rt.select(1);
    rt.select(0);
    sendMatchesShown(rt, "back to option 0");
    assert.equal(rt.starts().length, 0);
  });

  it("a first option marked new_session is honoured when it is the default selection", () => {
    const rt = makeRuntime();
    rt.suggest({ question: "Where?", options: [{ title: "Elsewhere", prompt: "Do it elsewhere", new_session: true }, { title: "Here", prompt: "Do it here" }] });
    sendMatchesShown(rt, "default new-session option");
  });

  it("a single step marked new_session runs here on Send and has its own New session button", () => {
    const here = makeRuntime();
    here.suggest({ ...SINGLE, new_session: true });
    assert.ok(here.q("[data-action=\"next-step-new-session\"]"), "New session button is drawn");
    sendMatchesShown(here, "single new_session");
    assert.equal(here.starts().length, 0);

    const away = makeRuntime();
    away.suggest({ ...SINGLE, new_session: true });
    away.act("next-step-new-session");
    assert.equal(away.dispatched.length, 0);
    assert.deepEqual(away.starts(), [{ type: "start_next_step_session", title: SINGLE.title, prompt: SINGLE.prompt, sessionId: "s1" }]);
  });

  it("a choice never shows the separate New session button", () => {
    const rt = makeRuntime();
    rt.suggest({ question: "Q", options: [{ title: "A", prompt: "a", new_session: true }, { title: "B", prompt: "b", new_session: true }] });
    assert.ok(rt.q("[data-action=\"next-step-new-session\"]") === null);
  });

  it("a suggestion started in a new session does not come back from history", () => {
    const rt = makeRuntime();
    rt.reload(historyWith(CHOICE));
    rt.select(1);
    rt.act("next-step-run");
    rt.reload(historyWith(CHOICE));
    assert.ok(rt.card() === null);
  });
});

describe("Draft card: Edit and Tab", () => {
  it("Edit puts the selected option's prompt in the input, never sends, and removes the card", () => {
    for (const k of [0, 1, 2]) {
      const rt = makeRuntime();
      rt.suggest(CHOICE);
      if (k) rt.select(k);
      rt.act("next-step-edit");
      assert.equal(rt.input.value, CHOICE.options[k].prompt, "option " + k);
      assert.equal(rt.dispatched.length, 0, "Edit never sends (option " + k + ")");
      assert.equal(rt.starts().length, 0, "Edit never starts a session (option " + k + ")");
      assert.ok(rt.card() === null);
      assert.ok(rt.doc.activeElement === rt.input, "focus moves to the input");
      assert.equal(rt.input.getAttribute("placeholder"), DEFAULT_PLACEHOLDER);
    }
  });

  it("Tab in the empty input takes the selected option, not the first one", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    rt.select(2);
    const e = rt.key("Tab");
    assert.equal(e.defaultPrevented, true, "Tab is taken while the card shows");
    assert.equal(rt.input.value, CHOICE.options[2].prompt);
    assert.equal(rt.dispatched.length, 0);
    assert.equal(rt.starts().length, 0);
    assert.ok(rt.card() === null);
  });

  it("Tab on a new-session option fills the input and starts nothing", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    rt.select(1);
    rt.key("Tab");
    assert.equal(rt.input.value, CHOICE.options[1].prompt);
    assert.equal(rt.starts().length, 0);
    assert.equal(rt.dispatched.length, 0);
  });

  it("Tab and Esc are left alone unless the input is empty and the card shows", () => {
    const cases: [string, (rt: Rt) => void, Record<string, unknown>][] = [
      ["typed text", rt => { rt.input.value = "x"; }, {}],
      ["only a space", rt => { rt.input.value = " "; }, {}],
      ["Shift", () => {}, { shiftKey: true }],
      ["Ctrl", () => {}, { ctrlKey: true }],
      ["Alt", () => {}, { altKey: true }],
      ["Meta", () => {}, { metaKey: true }],
      ["IME composing", () => {}, { isComposing: true }],
      ["IME keyCode 229", () => {}, { keyCode: 229 }],
    ];
    for (const key of ["Tab", "Escape"]) {
      for (const [label, setup, extra] of cases) {
        const rt = makeRuntime();
        rt.suggest(CHOICE);
        setup(rt);
        const before = rt.input.value;
        const e = rt.key(key, extra);
        assert.equal(e.defaultPrevented, false, key + " with " + label + " must not be taken");
        assert.ok(rt.card(), key + " with " + label + " keeps the card");
        assert.equal(rt.input.value, before, key + " with " + label + " leaves the input");
        assert.deepEqual(rt.events(), ["shown"], key + " with " + label + " reports nothing");
      }
    }
  });

  it("Tab and Esc are left alone with no card and while the session runs", () => {
    const none = makeRuntime();
    assert.equal(none.key("Tab").defaultPrevented, false);
    assert.equal(none.key("Escape").defaultPrevented, false);

    const busy = makeRuntime();
    busy.suggest(CHOICE);
    busy.startTurn();
    assert.equal(busy.key("Tab").defaultPrevented, false, "Tab moves focus as usual while running");
    assert.equal(busy.input.value, "");

    const flagged = makeRuntime();
    flagged.suggest(CHOICE);
    flagged.sandbox.sessionsState.s1.isRunning = true;
    flagged.run("renderNextStep()");
    assert.ok(flagged.card() === null);
    assert.equal(flagged.key("Tab").defaultPrevented, false);
  });

  it("Esc in the empty input dismisses the card", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    rt.select(2);
    const e = rt.key("Escape");
    assert.equal(e.defaultPrevented, true);
    assert.ok(rt.card() === null);
    assert.equal(rt.input.value, "");
    assert.deepEqual(rt.events(), ["shown", "dismissed"]);
  });
});

describe("Draft card: dismissing", () => {
  it("× removes the card and the suggestion does not return when the session reloads", () => {
    const rt = makeRuntime();
    rt.reload(historyWith(SINGLE));
    assert.ok(rt.card());
    rt.act("next-step-dismiss");
    assert.ok(rt.card() === null);
    assert.ok(rt.doc.activeElement === rt.input, "focus goes back to the input");
    rt.reload(historyWith(SINGLE));
    assert.ok(rt.card() === null);
    rt.switchTo("s2", []);
    rt.switchTo("s1", historyWith(SINGLE));
    assert.ok(rt.card() === null, "switching away and back does not bring it back");
  });

  it("a dismissed choice stays dismissed whichever option was selected", () => {
    const rt = makeRuntime();
    rt.reload(historyWith(CHOICE));
    rt.select(2);
    rt.run("toggleNextStepPrompt()");
    rt.act("next-step-dismiss");
    rt.reload(historyWith(CHOICE));
    assert.ok(rt.card() === null);
  });

  it("Edit and Tab do not leave the suggestion to come back from history either", () => {
    const rt = makeRuntime();
    rt.reload(historyWith(CHOICE));
    rt.act("next-step-edit");
    rt.input.value = "";
    rt.reload(historyWith(CHOICE));
    assert.ok(rt.card() === null);
  });

  it("a later turn that suggests the same thing shows it again, and it then survives a reload", () => {
    const rt = makeRuntime();
    rt.reload(historyWith(CHOICE));
    rt.act("next-step-dismiss");
    rt.startTurn();
    rt.suggest(CHOICE);
    rt.endTurn();
    assert.ok(rt.card(), "a repeat in a new turn is shown");
    assert.equal(checkConsistent(rt, "repeat"), 0, "a repeat starts from the first option");
    rt.reload(historyWith(CHOICE));
    assert.ok(rt.card(), "and is still there after a reload");
  });

  it("dismissing in one session does not hide a different session's suggestion", () => {
    const rt = makeRuntime();
    rt.suggest(SINGLE, "s2");
    rt.suggest(CHOICE, "s1");
    rt.act("next-step-dismiss");
    rt.switchTo("s2", historyWith(SINGLE));
    assert.ok(rt.card());
    assert.equal(rt.shown(), SINGLE.prompt);
  });

  it("a dismissed suggestion does not come back after the webview itself is reloaded", { todo: "also on dev: dismissals live only in webview memory" }, () => {
    const first = makeRuntime();
    first.reload(historyWith(SINGLE));
    first.act("next-step-dismiss");
    const second = makeRuntime();
    second.reload(historyWith(SINGLE));
    assert.ok(second.card() === null, "the dismissal lives only in the webview's memory, so a reloaded webview shows the suggestion again");
  });
});

describe("Draft card: bad option indices", () => {
  const BAD: unknown[] = [-1, 3, 99, -0.5, 1.5, NaN, Infinity, -Infinity, "abc", "2abc", "1.5", "-1", "3", "", " ", null, undefined, "-0", "0x1", "1e0", true, false, [], {}, [2], "  2  "];

  it("selecting with a bad index never breaks the card or desynchronises Send, Edit and the shown prompt", () => {
    for (const bad of BAD) {
      const rt = makeRuntime();
      rt.suggest(CHOICE);
      rt.select(2);
      rt.sandbox.__bad = bad;
      rt.run("selectNextStepOption(__bad)");
      const label = "selectNextStepOption(" + String(JSON.stringify(bad)) + ")";
      const idx = checkConsistent(rt, label);
      const n = Number(bad);
      if (!(Number.isInteger(n) && n >= 0 && n < CHOICE.options.length)) assert.equal(idx, 2, label + ": an index that names no option keeps the user's selection");
      sendMatchesShown(rt, label);
    }
  });

  it("a tampered data-opt-idx on an option button never breaks the card", () => {
    for (const bad of ["-1", "3", "NaN", "abc", "1.5", "", "1e9", "Infinity"]) {
      const rt = makeRuntime();
      rt.suggest(CHOICE);
      rt.select(2);
      const opt = rt.q(".next-step-option[data-opt-idx=\"1\"]") as FEl;
      opt.setAttribute("data-opt-idx", bad);
      rt.click(opt);
      checkConsistent(rt, "option button with data-opt-idx=" + JSON.stringify(bad));
      sendMatchesShown(rt, "option button with data-opt-idx=" + JSON.stringify(bad));
    }
    const missing = makeRuntime();
    missing.suggest(CHOICE);
    missing.select(2);
    const opt = missing.q(".next-step-option[data-opt-idx=\"1\"]") as FEl;
    opt.removeAttribute("data-opt-idx");
    missing.click(opt);
    checkConsistent(missing, "option button without data-opt-idx");
  });

  it("a corrupted selection state still draws a consistent card", () => {
    for (const bad of [7, -1, "x", 1.5, null, NaN, "2"]) {
      const rt = makeRuntime();
      rt.suggest(CHOICE);
      rt.sandbox.__bad = bad;
      rt.run("currentNextStep().selected = __bad; renderNextStep();");
      checkConsistent(rt, "selected=" + String(JSON.stringify(bad)));
      sendMatchesShown(rt, "selected=" + String(JSON.stringify(bad)));
    }
  });

  it("Send and Edit with a bad index act on the shown option (or do nothing), never on a hidden one", () => {
    const choice = {
      question: "Which?",
      options: [
        { title: "Hidden default", prompt: "Option zero, not selected", new_session: true },
        { title: "Middle", prompt: "Option one" },
        { title: "Shown", prompt: "Option two, the one on screen" },
      ],
    };
    for (const action of ["next-step-run", "next-step-edit"]) {
      for (const bad of ["9", "-1", "abc", "1.5", ""]) {
        const rt = makeRuntime();
        rt.suggest(choice);
        rt.select(2);
        const shown = rt.shown();
        const btn = rt.q("[data-action=\"" + action + "\"]") as FEl;
        btn.setAttribute("data-opt-idx", bad);
        rt.click(btn);
        const label = action + " with data-opt-idx=" + JSON.stringify(bad);
        const delivered = [
          ...rt.dispatched.map(d => d.text),
          ...rt.starts().map(s => s.prompt),
          ...(rt.input.value ? [rt.input.value] : []),
        ];
        assert.ok(delivered.every(t => t === shown), label + ": acted on " + JSON.stringify(delivered) + " while the card showed " + JSON.stringify(shown));
      }
    }
  });
});

describe("Draft card: markup in suggestions renders as text", () => {
  const PAYLOADS = [
    "\"><img src=x onerror=\"alert(1)\">",
    "<script>alert(1)</script>",
    "' onmouseover='alert(1)' x='",
    "</span></div><button data-action=\"next-step-run\" data-opt-idx=\"1\">Send</button>",
    "&lt;b&gt;pre-escaped&lt;/b&gt; &amp;amp; &#60;i&#62;",
    "<svg/onload=alert(1)>",
    "<!-- --><a href=\"javascript:alert(1)\">x</a>",
    "`${1+1}` \\\" \\' <style>*{display:none}</style>",
  ];

  function structureCheck(rt: Rt, label: string, expectActions: string[]): void {
    const card = rt.card() as FEl;
    const all = card.descendants();
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      assert.ok(["div", "span", "button", "svg", "path"].includes(tag), label + ": unexpected <" + tag + "> element");
      for (const name of el.attributes.keys()) {
        assert.ok(!name.startsWith("on"), label + ": event handler attribute " + name + " on <" + tag + ">");
        assert.notEqual(name, "href", label + ": href on <" + tag + ">");
      }
    }
    const actions = all.filter(e => e.hasAttribute("data-action")).map(e => e.getAttribute("data-action"));
    assert.deepEqual(actions, expectActions, label + ": only the card's own controls carry actions");
  }

  it("a single step with markup in title and prompt", () => {
    for (const p of PAYLOADS) {
      const rt = makeRuntime();
      rt.suggest({ title: p, prompt: p + "\n" + p, new_session: true });
      const step = rt.step();
      const label = "single " + JSON.stringify(p);
      structureCheck(rt, label, ["next-step-dismiss", "next-step-expand", "next-step-new-session", "next-step-edit", "next-step-run"]);
      const title = rt.q(".next-step-title") as FEl;
      assert.equal(title.textContent, step.title, label + ": heading text");
      assert.equal(title.getAttribute("title"), step.title, label + ": heading tooltip");
      assert.equal(rt.shown(), step.prompt, label + ": prompt text");
      assert.equal(rt.input.getAttribute("placeholder"), step.title + TAB_HINT, label + ": placeholder");
      sendMatchesShown(rt, label);
    }
  });

  it("a choice with markup in the question, option titles and prompts", () => {
    for (const p of PAYLOADS) {
      const rt = makeRuntime();
      rt.suggest({
        question: p,
        options: [
          { title: p, prompt: "zero " + p },
          { title: "b" + p, prompt: "one " + p, new_session: true },
          { title: "c" + p, prompt: "two " + p },
        ],
      });
      const step = rt.step();
      const label = "choice " + JSON.stringify(p);
      structureCheck(rt, label, ["next-step-dismiss", "next-step-select", "next-step-select", "next-step-select", "next-step-expand", "next-step-edit", "next-step-run"]);
      const title = rt.q(".next-step-title") as FEl;
      assert.equal(title.textContent, step.question, label + ": question text");
      assert.equal(title.getAttribute("title"), step.question, label + ": question tooltip");
      const opts = (rt.card() as FEl).querySelectorAll(".next-step-option");
      opts.forEach((o, i) => assert.ok(o.textContent.startsWith(step.options[i].title), label + ": option " + i + " title"));
      for (const k of [1, 2, 0]) {
        rt.select(k);
        assert.equal(rt.shown(), step.options[k].prompt, label + ": prompt of option " + k);
      }
      rt.select(2);
      sendMatchesShown(rt, label);
    }
  });
});

describe("Draft card: telemetry", () => {
  it("next_step_event carries only an allowed event name and the session id, never text", () => {
    const texts = [CHOICE.question, ...CHOICE.options.flatMap(o => [o.title, o.prompt]), SINGLE.title, SINGLE.prompt];
    const all: any[] = [];
    const flows: ((rt: Rt) => void)[] = [
      rt => { rt.suggest(CHOICE); rt.select(2); rt.run("toggleNextStepPrompt()"); rt.act("next-step-run"); },
      rt => { rt.suggest(CHOICE); rt.select(1); rt.act("next-step-run"); },
      rt => { rt.suggest(CHOICE); rt.select(1); rt.act("next-step-edit"); },
      rt => { rt.suggest(CHOICE); rt.key("Tab"); },
      rt => { rt.suggest(CHOICE); rt.key("Escape"); },
      rt => { rt.suggest(CHOICE); rt.act("next-step-dismiss"); },
      rt => { rt.suggest({ ...SINGLE, new_session: true }); rt.act("next-step-new-session"); },
      rt => { rt.reload(historyWith(SINGLE)); rt.act("next-step-run"); },
    ];
    for (const flow of flows) {
      const rt = makeRuntime();
      flow(rt);
      all.push(...rt.posted);
    }
    for (const m of all) {
      assert.ok(m.type === "next_step_event" || m.type === "start_next_step_session", "unexpected message " + m.type);
      if (m.type !== "next_step_event") continue;
      assert.deepEqual(Object.keys(m).sort(), ["event", "sessionId", "type"], "event message has extra fields: " + JSON.stringify(m));
      assert.ok(EVENTS.has(m.event), "event outside the allowed set: " + m.event);
      assert.equal(m.sessionId, "s1");
      const json = JSON.stringify(m);
      for (const t of texts) assert.ok(!json.includes(t), "event leaks text: " + json);
    }
  });

  it("'shown' is reported once per suggestion however often the card is redrawn", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    for (const k of [1, 2, 0, 2, 1]) rt.select(k);
    rt.run("toggleNextStepPrompt(); toggleNextStepPrompt(); renderNextStep(); renderNextStep();");
    rt.fireResize();
    rt.switchTo("s2", []);
    rt.switchTo("s1", historyWith(CHOICE));
    rt.reload(historyWith(CHOICE));
    assert.deepEqual(rt.events(), ["shown"]);
    rt.startTurn();
    rt.suggest(SINGLE);
    rt.endTurn();
    assert.deepEqual(rt.events(), ["shown", "shown"], "a new turn's suggestion is reported once more");
  });

  it("'shown' waits for the turn to end, and is not reported for a session that is not on screen", () => {
    const rt = makeRuntime();
    rt.startTurn();
    rt.suggest(CHOICE);
    rt.run("renderNextStep(); renderNextStep();");
    assert.deepEqual(rt.events(), [], "nothing is shown while running");
    rt.endTurn();
    rt.run("renderNextStep()");
    assert.deepEqual(rt.events(), ["shown"]);

    const other = makeRuntime();
    other.suggest(CHOICE, "s2");
    assert.deepEqual(other.events(), []);
    other.switchTo("s2", historyWith(CHOICE));
    assert.deepEqual(other.events(), ["shown"]);
  });

  it("each action reports exactly one event, and selecting or expanding reports none", () => {
    const cases: [string, (rt: Rt) => void, string[]][] = [
      ["select and expand", rt => { rt.select(2); rt.select(0); rt.run("toggleNextStepPrompt()"); }, []],
      ["Send", rt => { rt.select(2); rt.act("next-step-run"); }, ["run"]],
      ["Edit", rt => rt.act("next-step-edit"), ["tab"]],
      ["Tab", rt => { rt.key("Tab"); }, ["tab"]],
      ["×", rt => rt.act("next-step-dismiss"), ["dismissed"]],
      ["Esc", rt => { rt.key("Escape"); }, ["dismissed"]],
      ["Start session", rt => { rt.select(1); rt.act("next-step-run"); }, []],
    ];
    for (const [label, act, expected] of cases) {
      const rt = makeRuntime();
      rt.suggest(CHOICE);
      act(rt);
      assert.deepEqual(rt.events().slice(1), expected, label);
    }
  });
});

describe("Draft card: Show all", () => {
  function moreState(rt: Rt) {
    const more = rt.q(".next-step-more") as FEl;
    const prompt = rt.q(".next-step-prompt") as FEl;
    return {
      hidden: more.hidden,
      label: more.textContent.trim(),
      expanded: more.getAttribute("aria-expanded"),
      promptExpanded: prompt.classList.contains("expanded"),
    };
  }

  it("is hidden when the clamped prompt fits and shown when it is cut off", () => {
    const cases: [string, boolean][] = [
      ["short", true],
      ["one\ntwo\nthree", true],
      ["x".repeat(150), true],
      ["one\ntwo\nthree\nfour", false],
      ["x".repeat(151), false],
      ["y".repeat(2000), false],
      [LONG, false],
    ];
    for (const [prompt, hidden] of cases) {
      const rt = makeRuntime();
      rt.suggest({ title: "T", prompt });
      assert.equal(moreState(rt).hidden, hidden, JSON.stringify(prompt.slice(0, 20)) + " hidden=" + hidden);
    }
  });

  it("toggles, and the expanded state survives selection, re-render and session switch", () => {
    const rt = makeRuntime();
    rt.reload(historyWith({ question: "Q", options: [{ title: "Long", prompt: LONG }, { title: "Also long", prompt: LONG + "\nmore" }] }));
    assert.deepEqual(moreState(rt), { hidden: false, label: "Show all", expanded: "false", promptExpanded: false });
    rt.act("next-step-expand");
    assert.deepEqual(moreState(rt), { hidden: false, label: "Show less", expanded: "true", promptExpanded: true });
    assert.ok(rt.doc.activeElement === rt.q(".next-step-more"), "focus stays on the toggle");
    rt.select(1);
    assert.equal(moreState(rt).promptExpanded, true, "after selecting another option");
    rt.run("renderNextStep()");
    assert.equal(moreState(rt).promptExpanded, true, "after a re-render");
    rt.switchTo("s2", []);
    rt.switchTo("s1", []);
    assert.equal(moreState(rt).promptExpanded, true, "after switching away and back");
    rt.act("next-step-expand");
    assert.deepEqual(moreState(rt), { hidden: false, label: "Show all", expanded: "false", promptExpanded: false });
  });

  it("re-checks on resize: a narrower view reveals it, a wider one hides it", () => {
    const rt = makeRuntime();
    rt.suggest({ title: "T", prompt: "w".repeat(120) });
    assert.equal(moreState(rt).hidden, true);
    rt.env.charsPerLine = 30;
    rt.fireResize();
    assert.equal(moreState(rt).hidden, false, "cut off after narrowing");
    rt.env.charsPerLine = 200;
    rt.fireResize();
    assert.equal(moreState(rt).hidden, true, "fits after widening");
  });

  it("a card drawn while the view is hidden shows the toggle once it is visible and cut off", () => {
    const rt = makeRuntime();
    rt.env.visible = false;
    rt.suggest({ title: "T", prompt: LONG });
    rt.env.visible = true;
    rt.fireResize();
    assert.equal(moreState(rt).hidden, false);
  });

  it("the size watcher does not pile up across re-renders and is released with the card", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    for (let i = 0; i < 60; i++) {
      rt.select(i % 3);
      rt.run("toggleNextStepPrompt(); renderNextStep();");
    }
    rt.reload(historyWith(CHOICE));
    rt.switchTo("s2", []);
    rt.switchTo("s1", historyWith(CHOICE));
    assert.equal(rt.liveObservers().length, 1, "exactly one live watcher while the card shows");
    const watched = [...rt.liveObservers()[0].targets];
    assert.ok(watched.length === 1 && watched[0] === rt.q(".next-step-prompt"), "it watches the prompt on screen");
    rt.act("next-step-dismiss");
    assert.equal(rt.liveObservers().length, 0, "none after dismissing");
    rt.fireResize();
    assert.ok(rt.card() === null, "a late resize does not bring the card back");

    const started = makeRuntime();
    started.suggest(CHOICE);
    started.startTurn();
    assert.equal(started.liveObservers().length, 0, "none once a turn starts");

    const away = makeRuntime();
    away.suggest(CHOICE);
    away.switchTo("s2", []);
    assert.equal(away.liveObservers().length, 0, "none after switching to a session without a suggestion");
  });

  it("collapsing a prompt that fits does not drop keyboard focus to the page", () => {
    const rt = makeRuntime();
    rt.suggest({ question: "Q", options: [{ title: "Long", prompt: LONG }, { title: "Short", prompt: "short" }] });
    rt.act("next-step-expand");
    rt.select(1);
    const more = rt.q(".next-step-more") as FEl;
    assert.equal(more.hidden, false, "Show less is offered while expanded");
    rt.click(more);
    assert.ok(rt.doc.activeElement !== rt.doc.body, "focus was lost after Show less hid itself");
  });
});

describe("Draft card: running sessions and the placeholder", () => {
  it("draws nothing while the session runs and keeps the default placeholder", () => {
    const rt = makeRuntime({ running: true });
    rt.suggest(CHOICE);
    assert.ok(rt.card() === null);
    assert.equal(rt.input.getAttribute("placeholder"), DEFAULT_PLACEHOLDER);
    rt.run("selectNextStepOption(2); toggleNextStepPrompt();");
    assert.ok(rt.card() === null, "selecting or expanding while running draws nothing");
  });

  it("a turn starting removes the card and restores the placeholder", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    rt.select(2);
    assert.equal(rt.input.getAttribute("placeholder"), "Write docs" + TAB_HINT);
    rt.startTurn();
    assert.ok(rt.card() === null);
    assert.equal(rt.input.getAttribute("placeholder"), DEFAULT_PLACEHOLDER);
    rt.endTurn();
    assert.ok(rt.card() === null, "the old suggestion does not come back after the turn");
  });

  it("the placeholder follows the selected option and resets on a session without a suggestion", () => {
    const rt = makeRuntime();
    rt.suggest(CHOICE);
    for (const k of [1, 2, 0]) {
      rt.select(k);
      assert.equal(rt.input.getAttribute("placeholder"), CHOICE.options[k].title + TAB_HINT);
    }
    rt.select(2);
    rt.switchTo("s2", []);
    assert.equal(rt.input.getAttribute("placeholder"), DEFAULT_PLACEHOLDER);
    rt.switchTo("s3", [], true);
    assert.equal(rt.input.getAttribute("placeholder"), DEFAULT_PLACEHOLDER);
    rt.switchTo("s1", []);
    assert.equal(rt.input.getAttribute("placeholder"), "Write docs" + TAB_HINT);
  });

  it("the running hint in the placeholder survives a suggestion that arrives mid-turn", { todo: "also on dev: the busy branch resets the placeholder" }, () => {
    const rt = makeRuntime({ withHint: true });
    rt.reload([]);
    rt.startTurn();
    const hint = rt.input.getAttribute("placeholder");
    assert.ok(hint && hint.startsWith("Queue a follow-up"), "the running hint is up: " + hint);
    rt.suggest(SINGLE);
    assert.equal(rt.input.getAttribute("placeholder"), hint, "a suggestion during the turn replaced the running hint");
    rt.endTurn();
    assert.equal(rt.input.getAttribute("placeholder"), SINGLE.title + TAB_HINT);
  });

  it("the card goes before a feature tip", () => {
    const rt = makeRuntime({ tipCard: true });
    rt.suggest(SINGLE);
    const ids = rt.chat.children.map(c => c.id);
    assert.deepEqual(ids, ["next-step-card", "feature-tip-card"]);
  });
});

describe("Draft card: truncation", () => {
  it("cutting a long title or prompt never splits an emoji into a lone surrogate", () => {
    const rt = makeRuntime();
    rt.suggest({ title: "t".repeat(58) + "😀😀", prompt: "p".repeat(1999) + "😀 tail" });
    const step = rt.step();
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.ok(!lone.test(step.title), "title ends in a lone surrogate: " + JSON.stringify(step.title.slice(-3)));
    rt.act("next-step-run");
    assert.ok(!lone.test(rt.dispatched[0].text), "the sent prompt ends in a lone surrogate");
  });
});

describe("Draft card: styling", () => {
  const css: string = getChatStyles();
  const rules = parseCss(css);
  const nextStepRules = rules.filter(r => r.selectors.some(s => s.includes("next-step")));

  it("the next-step rules use theme variables, not colour literals", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.]|\b(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver)\b/;
    const offenders: string[] = [];
    for (const r of nextStepRules) {
      for (const [prop, value] of r.decls) {
        if (literal.test(withoutVarFallbacks(value))) offenders.push(r.selectors.join(", ") + " { " + prop + ": " + value + " }");
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("the shared button and close classes look the same outside the card as on dev", () => {
    const DEV_SHARED = `
      .next-step-btn { font-family: inherit; font-size: 11.5px; font-weight: 500; line-height: 1.4; padding: 3px 10px; border-radius: 5px; border: 1px solid var(--border); background: var(--vscode-button-secondaryBackground, var(--surface-hover)); color: var(--vscode-button-secondaryForeground, var(--fg)); cursor: pointer; white-space: nowrap; }
      .next-step-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--surface-active)); }
      .next-step-btn.primary { background: var(--vscode-button-background, var(--accent)); color: var(--vscode-button-foreground, #ffffff); border-color: transparent; }
      .next-step-btn.primary:hover { background: var(--vscode-button-hoverBackground, var(--accent)); }
      .next-step-card.has-choices .next-step-dismiss { position: absolute; top: 6px; right: 6px; }
      .next-step-btn:focus-visible, .next-step-dismiss:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 1px; }
      .next-step-dismiss { background: transparent; border: none; color: var(--muted); font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 4px; cursor: pointer; }
      .next-step-dismiss:hover { color: var(--fg); background: var(--surface-hover); }
    `;
    const devRules = parseCss(DEV_SHARED);
    const doc = new FDoc();
    const wrap = doc.createElement("div");
    wrap.className = "chat-viewport-wrapper";
    doc.body.appendChild(wrap);
    const chat = doc.createElement("div");
    chat.className = "chat-container";
    wrap.appendChild(chat);
    chat.innerHTML =
      "<div id=\"feature-tip-card\" class=\"feature-tip-card\"><div class=\"feature-tip-text\"></div>" +
        "<button class=\"next-step-btn\" data-action=\"feature-tip-run\">Try it</button>" +
        "<button class=\"next-step-dismiss\" data-action=\"feature-tip-menu\">×</button></div>" +
      "<div id=\"checkin-card\" class=\"checkin-card\"><button class=\"next-step-dismiss checkin-close\">×</button>" +
        "<div class=\"checkin-actions\"><button class=\"next-step-btn primary\">Send</button><button class=\"next-step-btn\">Skip</button>" +
        "<button class=\"next-step-btn primary\" disabled>Sending…</button></div></div>" +
      "<div id=\"waitlist-card\" class=\"checkin-card\"><button class=\"next-step-dismiss checkin-close\">×</button>" +
        "<div class=\"checkin-actions\"><button class=\"next-step-btn primary\">Join the waitlist</button></div></div>";
    const buttons = chat.querySelectorAll("button");
    assert.equal(buttons.length, 8);
    const diffs: string[] = [];
    for (const [i, b] of buttons.entries()) {
      for (const state of [[], ["hover"], ["focus-visible"]]) {
        const states = new Set(state);
        const now = Object.fromEntries(cascade(b, nextStepRules, states));
        const before = Object.fromEntries(cascade(b, devRules, states));
        const props = new Set([...Object.keys(now), ...Object.keys(before)]);
        for (const p of props) {
          if (now[p] !== before[p]) diffs.push("button " + i + " (" + b.className + ")" + (state.length ? ":" + state[0] : "") + " " + p + ": " + before[p] + " -> " + now[p]);
        }
      }
    }
    assert.deepEqual(diffs, []);
  });

  it("long unbroken text wraps or truncates inside the card instead of widening it", () => {
    const rt = makeRuntime();
    const word = "W".repeat(60);
    rt.suggest({ question: "Q".repeat(120), options: [{ title: word, prompt: "P".repeat(2000) }, { title: "x" + word, prompt: "p" }] });
    const wrap = rt.doc.createElement("div");
    wrap.className = "chat-viewport-wrapper";
    rt.doc.body.insertBefore(wrap, rt.chat);
    wrap.appendChild(rt.chat);
    rt.doc.body.classList.add("vscode-dark");
    const el = (sel: string) => rt.q(sel) as FEl;
    const breaks = (e: FEl) => {
      const ow = computed(e, "overflow-wrap", rules) || computed(e, "word-wrap", rules);
      const wb = computed(e, "word-break", rules);
      return ow === "anywhere" || wb === "break-all" || wb === "break-word";
    };
    const truncates = (e: FEl) => {
      const c = cascade(e, rules);
      return computed(e, "white-space", rules) === "nowrap" && c.get("text-overflow") === "ellipsis" && (c.get("overflow") === "hidden" || c.get("overflow-x") === "hidden");
    };
    const problems: string[] = [];
    const prompt = el(".next-step-prompt");
    if (!breaks(prompt)) problems.push(".next-step-prompt does not break long words");
    if (!["pre-wrap", "pre-line", "break-spaces"].includes(computed(prompt, "white-space", rules))) problems.push(".next-step-prompt does not keep newlines");
    const title = el(".next-step-title");
    if (!breaks(title) && !truncates(title)) problems.push("choice question neither wraps nor truncates");
    for (const opt of (rt.card() as FEl).querySelectorAll(".next-step-option")) {
      if (!breaks(opt) && !truncates(opt)) problems.push("option chip \"" + opt.textContent.slice(0, 12) + "…\" neither wraps nor truncates a long unbroken title");
    }
    const footWraps = [el(".next-step-foot"), el(".next-step-actions")].some(e => cascade(e, rules).get("flex-wrap") === "wrap");
    if (!footWraps) problems.push("the footer row (Show all, New session, Edit, Send) cannot wrap in a narrow sidebar");
    assert.deepEqual(problems, []);
  });
});
