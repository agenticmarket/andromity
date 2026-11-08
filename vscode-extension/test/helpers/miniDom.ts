// A deliberately small DOM for running webview client code in Node: enough HTML parsing (innerHTML), lookup,
// attributes, form fields and bubbling events for the Create pull request side panel. No scripts ever run, so any
// <script>, <img> or on* attribute that appears in the tree is evidence of an escaping bug.
const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "source", "col", "wbr", "area", "base", "embed", "param", "track"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", times: "×", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") return String.fromCodePoint(body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function encodeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class MiniEvent {
  target: MiniElement | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  constructor(public readonly type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

type Listener = (event: any) => void;

export class MiniNode {
  parent: MiniElement | null = null;
}

export class MiniText extends MiniNode {
  constructor(public data: string) { super(); }
}

export class MiniElement extends MiniNode {
  readonly tagName: string;
  attributes = new Map<string, string>();
  children: MiniNode[] = [];
  style: Record<string, string> = {};
  value = "";
  checked = false;
  private listeners = new Map<string, Listener[]>();
  readonly ownerDocument: MiniDocument;

  constructor(tag: string, doc: MiniDocument) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
  }

  get type(): string { return this.getAttribute("type") || (this.tagName === "INPUT" ? "text" : ""); }
  get id(): string { return this.getAttribute("id") || ""; }
  get hidden(): boolean { return this.attributes.has("hidden"); }
  set hidden(v: boolean) { if (v) this.attributes.set("hidden", ""); else this.attributes.delete("hidden"); }
  get disabled(): boolean { return this.attributes.has("disabled"); }
  set disabled(v: boolean) { if (v) this.attributes.set("disabled", ""); else this.attributes.delete("disabled"); }
  get title(): string { return this.getAttribute("title") || ""; }
  set title(v: string) { this.setAttribute("title", v); }
  get className(): string { return this.getAttribute("class") || ""; }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => { if (!list().includes(c)) el.setAttribute("class", [...list(), c].join(" ")); },
      remove: (c: string) => el.setAttribute("class", list().filter((x) => x !== c).join(" ")),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !list().includes(c);
        if (on) el.classList.add(c);
        else el.classList.remove(c);
        return on;
      },
    };
  }

  getAttribute(name: string): string | null { return this.attributes.has(name) ? (this.attributes.get(name) as string) : null; }
  setAttribute(name: string, value: string) { this.attributes.set(name.toLowerCase(), String(value)); }
  hasAttribute(name: string) { return this.attributes.has(name.toLowerCase()); }
  removeAttribute(name: string) { this.attributes.delete(name.toLowerCase()); }

  get elementChildren(): MiniElement[] { return this.children.filter((c): c is MiniElement => c instanceof MiniElement); }

  get textContent(): string {
    return this.children.map((c) => (c instanceof MiniText ? c.data : (c as MiniElement).textContent)).join("");
  }
  set textContent(text: string) {
    this.children = [];
    const node = new MiniText(String(text ?? ""));
    node.parent = this;
    this.children.push(node);
  }

  get innerHTML(): string {
    return this.children.map((c) => (c instanceof MiniText ? encodeText(c.data) : (c as MiniElement).outerHTML)).join("");
  }
  set innerHTML(html: string) {
    this.children = [];
    parseInto(this, String(html));
    if (this.tagName === "SELECT") this.syncSelect();
  }

  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attrs = [...this.attributes].map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)).join("");
    return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }

  syncSelect() {
    const options = this.descendants().filter((e) => e.tagName === "OPTION");
    if (options.length && !options.some((o) => o.textContent === this.value)) this.value = options[0].textContent;
  }

  descendants(): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (el: MiniElement) => {
      for (const child of el.elementChildren) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const s = part.trim();
      const attr = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(s);
      if (attr) return this.hasAttribute(attr[1]) && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]);
      if (s.startsWith(".")) return this.classList.contains(s.slice(1));
      if (s.startsWith("#")) return this.id === s.slice(1);
      return this.tagName === s.toUpperCase();
    });
  }

  closest(selector: string): MiniElement | null {
    let el: MiniElement | null = this;
    while (el) {
      if (el.matches(selector)) return el;
      el = el.parent;
    }
    return null;
  }

  /** Supports "a", ".cls", "#id", "[attr]", "[attr=\"v\"]" and the descendant form ".cls tag:last-child". */
  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MiniElement[] {
    const parts = selector.trim().split(/\s+/);
    let scope: MiniElement[] = [this];
    for (const part of parts) {
      const lastChild = part.endsWith(":last-child");
      const simple = lastChild ? part.slice(0, -":last-child".length) : part;
      const next: MiniElement[] = [];
      for (const root of scope) {
        for (const el of root.descendants()) {
          if (!el.matches(simple)) continue;
          if (lastChild && el.parent && el.parent.elementChildren.at(-1) !== el) continue;
          if (!next.includes(el)) next.push(el);
        }
      }
      scope = next;
    }
    return scope;
  }

  getElementById(id: string): MiniElement | null {
    return this.descendants().find((el) => el.id === id) ?? null;
  }

  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }

  dispatchEvent(event: MiniEvent): boolean {
    if (!event.target) event.target = this;
    let el: MiniElement | null = this;
    while (el && !event.propagationStopped) {
      for (const fn of el.listeners.get(event.type) || []) fn(event);
      el = el.parent;
    }
    return !event.defaultPrevented;
  }

  click() {
    if (this.tagName === "INPUT" && this.type === "checkbox") {
      if (this.disabled) return;
      this.checked = !this.checked;
      this.dispatchEvent(new MiniEvent("click"));
      this.dispatchEvent(new MiniEvent("change"));
      return;
    }
    if (this.disabled) return;
    this.dispatchEvent(new MiniEvent("click"));
  }

  /** The user typing: sets the value and fires input. */
  type_(text: string) {
    this.value = text;
    this.dispatchEvent(new MiniEvent("input"));
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: 44, width: 100, height: 44 };
  }
}

function parseInto(root: MiniElement, html: string) {
  const doc = root.ownerDocument;
  const stack: MiniElement[] = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const tag = m[1].toUpperCase();
      const at = stack.map((e) => e.tagName).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    if (m[2]) {
      const el = new MiniElement(m[2], doc);
      const attrRe = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[3] || "")) !== null) {
        el.attributes.set(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
      }
      if (el.tagName === "INPUT" && el.hasAttribute("checked")) el.checked = true;
      if (el.tagName === "INPUT" && el.hasAttribute("value")) el.value = el.getAttribute("value") as string;
      el.parent = top;
      top.children.push(el);
      if (!VOID.has(m[2].toLowerCase()) && !m[0].endsWith("/>")) stack.push(el);
      continue;
    }
    const text = new MiniText(decode(m[0]));
    text.parent = top;
    top.children.push(text);
  }
}

export class MiniDocument {
  readonly documentElement: MiniElement;
  readonly body: MiniElement;
  activeElement: MiniElement | null = null;
  constructor(bodyHtml: string) {
    this.documentElement = new MiniElement("html", this);
    this.body = new MiniElement("body", this);
    this.body.parent = this.documentElement;
    this.documentElement.children.push(this.body);
    this.body.innerHTML = bodyHtml;
  }
  getElementById(id: string) { return this.body.getElementById(id); }
  querySelector(s: string) { return this.body.querySelector(s); }
  querySelectorAll(s: string) { return this.body.querySelectorAll(s); }
  createElement(tag: string) { return new MiniElement(tag, this); }
}

export class MiniWindow {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  dispatch(type: string, event: Record<string, unknown>) { for (const fn of this.listeners.get(type) || []) fn(event); }
  /** A message from the extension host. */
  message(data: unknown) { this.dispatch("message", { data }); }
}

/** Elements or attributes that would execute or load something in a real browser. */
export function dangerousNodes(doc: MiniDocument): string[] {
  const bad: string[] = [];
  for (const el of doc.body.descendants()) {
    if (["SCRIPT", "IMG", "IFRAME", "OBJECT", "EMBED", "SVG", "STYLE", "LINK", "META", "A", "FORM"].includes(el.tagName)) bad.push(el.tagName);
    for (const [name, value] of el.attributes) {
      if (name.startsWith("on") || name === "src" || name === "href" || name === "srcdoc" || /javascript:/i.test(value) && name !== "title" && !name.startsWith("data-") && name !== "aria-label") {
        bad.push(`${el.tagName}[${name}]`);
      }
    }
  }
  return bad;
}
