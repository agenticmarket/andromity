// A small DOM for running the Pull Requests and Issues webview client (repoViewClient) in Node, inside a fresh
// vm context so the injected function can only see what a webview gives it. Built only from createElement and
// createTextNode like the client itself; there is no HTML parser here, so any markup that shows up as an element
// came from the client creating it.
import * as vm from "node:vm";

type Listener = (event: any) => void;

export class RNode {
  parentNode: RElement | null = null;
  get textContent(): string { return ""; }
}

export class RText extends RNode {
  constructor(public data: string) { super(); }
  get textContent(): string { return this.data; }
}

export class RElement extends RNode {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  childNodes: RNode[] = [];
  readonly style: Record<string, string> = {};
  /** Every style property the client set, in order, to catch style injection. */
  readonly styleWrites: [string, string][] = [];
  value = "";
  scrollTop = 0;
  selectionStart: number | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(tag: string, readonly ownerDocument: RDocument) {
    super();
    this.tagName = tag.toUpperCase();
    const el = this;
    this.style = new Proxy({} as Record<string, string>, {
      set(target, key, value) {
        el.styleWrites.push([String(key), String(value)]);
        target[String(key)] = String(value);
        return true;
      },
    });
  }

  get id(): string { return this.attrs.get("id") ?? ""; }
  get className(): string { return this.attrs.get("class") ?? ""; }
  set className(v: string) { this.attrs.set("class", String(v)); }
  get hidden(): boolean { return this.attrs.has("hidden"); }
  set hidden(v: boolean) { if (v) this.attrs.set("hidden", ""); else this.attrs.delete("hidden"); }
  get disabled(): boolean { return this.attrs.has("disabled"); }
  set disabled(v: boolean) { if (v) this.attrs.set("disabled", ""); else this.attrs.delete("disabled"); }
  get title(): string { return this.attrs.get("title") ?? ""; }
  get children(): RElement[] { return this.childNodes.filter((c): c is RElement => c instanceof RElement); }

  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(text: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (String(text ?? "")) this.appendChild(new RText(String(text)));
  }

  getAttribute(name: string): string | null { return this.attrs.has(name.toLowerCase()) ? this.attrs.get(name.toLowerCase())! : null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name.toLowerCase(), String(value)); }
  hasAttribute(name: string): boolean { return this.attrs.has(name.toLowerCase()); }
  removeAttribute(name: string): void { this.attrs.delete(name.toLowerCase()); }

  appendChild<T extends RNode>(child: T): T {
    if (!(child instanceof RNode)) throw new TypeError("appendChild: not a node");
    if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter((c) => c !== child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  contains(node: RNode | null): boolean {
    let at: RNode | null = node;
    while (at) {
      if (at === this) return true;
      at = at.parentNode;
    }
    return false;
  }

  descendants(): RElement[] {
    const out: RElement[] = [];
    const walk = (el: RElement) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchCompound(this, part.trim()));
  }

  closest(selector: string): RElement | null {
    let el: RElement | null = this;
    while (el) {
      if (el.matches(selector)) return el;
      el = el.parentNode;
    }
    return null;
  }

  querySelectorAll(selector: string): RElement[] {
    const groups = selector.split(",").map((s) => s.trim().split(/\s+/));
    const found = new Set<RElement>();
    for (const parts of groups) {
      let scope: RElement[] = [this];
      for (const part of parts) {
        const next: RElement[] = [];
        for (const root of scope) for (const el of root.descendants()) if (matchCompound(el, part) && !next.includes(el)) next.push(el);
        scope = next;
      }
      scope.forEach((el) => found.add(el));
    }
    return this.descendants().filter((el) => found.has(el));
  }

  querySelector(selector: string): RElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  getElementById(id: string): RElement | null { return this.descendants().find((el) => el.id === id) ?? null; }

  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  listenersFor(type: string): Listener[] { return this.listeners.get(type) ?? []; }

  dispatchEvent(event: REvent): boolean {
    if (!event.target) event.target = this;
    let el: RElement | null = this;
    while (el && !event.propagationStopped) {
      for (const fn of el.listenersFor(event.type)) fn(event);
      el = el.parentNode;
    }
    if (!event.propagationStopped && this.ownerDocument.body.contains(this)) this.ownerDocument.fire(event);
    return !event.defaultPrevented;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent(new REvent("click"));
  }

  focus(): void { this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  scrollIntoView(): void {}
  setSelectionRange(start: number): void { this.selectionStart = start; }

  /** The user typing into an input or textarea. */
  type_(text: string): void {
    this.value = text;
    this.dispatchEvent(new REvent("input"));
  }

  key(key: string, init: Record<string, unknown> = {}): REvent {
    const event = new REvent("keydown", { key, ...init });
    this.dispatchEvent(event);
    return event;
  }
}

function matchCompound(el: RElement, part: string): boolean {
  if (!part) return false;
  const re = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|#[\w-]+|\[[^\]]+\])*)$/;
  const m = re.exec(part);
  if (!m) throw new Error(`selector not supported by the test DOM: ${part}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const bits = m[2].match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) ?? [];
  return bits.every((bit) => {
    if (bit[0] === ".") return el.className.split(/\s+/).includes(bit.slice(1));
    if (bit[0] === "#") return el.id === bit.slice(1);
    const attr = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(bit);
    if (!attr) return false;
    const want = attr[2] ?? attr[3] ?? attr[4];
    return el.hasAttribute(attr[1]) && (want === undefined || el.getAttribute(attr[1]) === want);
  });
}

export class REvent {
  target: RElement | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  key?: string;
  shiftKey = false;
  ctrlKey = false;
  metaKey = false;
  constructor(public readonly type: string, init: Record<string, unknown> = {}) { Object.assign(this, init); }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

export class RDocument {
  readonly documentElement: RElement;
  readonly body: RElement;
  activeElement: RElement | null;
  private listeners = new Map<string, Listener[]>();
  constructor() {
    this.documentElement = new RElement("html", this);
    this.body = this.documentElement.appendChild(new RElement("body", this));
    this.activeElement = this.body;
  }
  createElement(tag: string): RElement { return new RElement(tag, this); }
  createTextNode(text: string): RText { return new RText(String(text)); }
  getElementById(id: string): RElement | null { return this.body.getElementById(id); }
  querySelector(s: string): RElement | null { return this.body.querySelector(s); }
  querySelectorAll(s: string): RElement[] { return this.body.querySelectorAll(s); }
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(event: REvent): void { for (const fn of this.listeners.get(event.type) ?? []) fn(event); }
}

export class RWindow {
  private listeners = new Map<string, Listener[]>();
  [key: string]: unknown;
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  /** A message from the extension host. */
  message(data: unknown): void { for (const fn of this.listeners.get("message") ?? []) fn({ data }); }
}

export interface RepoViewPage {
  doc: RDocument;
  win: RWindow;
  sent: any[];
  errors: unknown[];
  $(id: string): RElement | null;
  /** Sends a host message and lets the client's timers (live region) run. */
  post(message: unknown): void;
}

/** Boots the client source (a function's toString()) in a fresh context that has only a webview's globals. */
export function bootRepoView(source: string): RepoViewPage {
  return bootRepoViewScript(`(${source})(acquireVsCodeApi());`);
}

/** Runs a whole inline script, as the webview would, with acquireVsCodeApi() and DOM globals only. */
export function bootRepoViewScript(script: string): RepoViewPage {
  const doc = new RDocument();
  for (const [tag, id, hidden] of [["div", "app", false], ["div", "sheet-back", true], ["div", "sheet", true], ["div", "live", false]] as const) {
    const el = doc.createElement(tag);
    el.setAttribute("id", id);
    if (hidden) el.hidden = true;
    if (id === "sheet") { el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "sheet-title"); }
    if (id === "live") el.setAttribute("aria-live", "polite");
    doc.body.appendChild(el);
  }
  const win = new RWindow();
  const sent: any[] = [];
  const errors: unknown[] = [];
  const sandbox: Record<string, unknown> = {
    document: doc, window: win, Node: RNode, setTimeout, clearTimeout, URL, console,
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => sent.push(JSON.parse(JSON.stringify(m))) }),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(script, context);
  return {
    doc, win, sent, errors,
    $: (id) => doc.getElementById(id),
    post: (message) => win.message(JSON.parse(JSON.stringify(message))),
  };
}

/** Elements or attributes that would run, load or style something in a real webview. */
export function dangerous(root: RElement): string[] {
  const allowed = new Set(["DIV", "SPAN", "BUTTON", "CODE", "PRE", "P", "UL", "OL", "LI", "BLOCKQUOTE", "B", "I", "H1", "H2", "H3", "SELECT", "OPTION",
    "INPUT", "TEXTAREA", "LABEL", "DETAILS", "SUMMARY"]);
  const bad: string[] = [];
  for (const el of root.descendants()) {
    if (!allowed.has(el.tagName)) bad.push(el.tagName);
    for (const [name, value] of el.attrs) {
      if (name.startsWith("on") || ["src", "href", "srcdoc", "style", "action", "formaction", "xlink:href"].includes(name)) bad.push(`${el.tagName}[${name}=${value}]`);
    }
    for (const [prop, value] of el.styleWrites) {
      if (!(prop === "background" && /^#[0-9a-f]{6}$/.test(value))) bad.push(`${el.tagName}.style.${prop}=${value}`);
    }
  }
  return bad;
}
