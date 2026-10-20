import * as vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getChatClientScript } from "../../src/providers/chatview/chatClientScript.js";

/** A fake page for running the real chat webview script under node. */
export function stub(): any {
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

/** An object that keeps what is assigned to it and answers stub() for anything else. */
export function recording(base: Record<string, any> = {}): any {
  return new Proxy(base, {
    get(t, prop) { return prop in t ? t[prop as any] : stub(); },
    set(t, prop, value) { t[prop as any] = value; return true; },
  });
}

export function classList() {
  const set = new Set<string>();
  return {
    add: (...c: string[]) => c.forEach(x => set.add(x)),
    remove: (...c: string[]) => c.forEach(x => set.delete(x)),
    toggle: (c: string, force?: boolean) => { const on = force ?? !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
    contains: (c: string) => set.has(c),
  };
}

export function element(base: Record<string, any> = {}): any {
  const listeners: Record<string, Function[]> = {};
  const attrs: Record<string, string> = {};
  return recording({
    hidden: false, clicks: 0, style: {}, value: "", selectionStart: 0, selectionEnd: 0, scrollHeight: 20,
    tagName: "DIV", classList: classList(), listeners, attrs,
    addEventListener(type: string, fn: Function) { (listeners[type] = listeners[type] || []).push(fn); },
    getAttribute(name: string) { return name in attrs ? attrs[name] : null; },
    setAttribute(name: string, value: unknown) { attrs[name] = String(value); },
    removeAttribute(name: string) { delete attrs[name]; },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    isConnected: true, innerHTML: "", nextElementSibling: null, inserted: [] as string[],
    hasAttribute(name: string) { return name in attrs; },
    matches: () => false,
    insertAdjacentHTML(_where: string, html: string) { this.inserted.push(html); },
    focus() {}, click() { this.clicks = (this.clicks || 0) + 1; },
    ...base,
  });
}

export function loadChat() {
  const docListeners: Record<string, Function[]> = {};
  const observers: Function[] = [];
  const byId: Record<string, any> = {
    "prompt-input": element({ tagName: "TEXTAREA" }),
    "btn-send": element({ tagName: "BUTTON" }),
    "mode-popover": element({ style: { display: "none" } }),
    "slash-palette": element({ style: { display: "none" } }),
    "mention-palette": element({ style: { display: "none" } }),
    "questions-carousel-card": null,
    "image-lightbox-overlay": null,
  };
  const promptBox = element();
  const body = element({ tagName: "BODY" });
  const document = recording({
    body,
    addEventListener(type: string, fn: Function) { (docListeners[type] = docListeners[type] || []).push(fn); },
    getElementById: (id: string) => id in byId ? byId[id] : stub(),
    querySelector: (sel: string) => sel === ".prompt-box" ? promptBox : stub(),
  });
  const posted: any[] = [];
  const windowListeners: Record<string, Function[]> = {};
  const window: any = recording({
    getComputedStyle: (el: any) => ({ display: el.style.display ?? "" }),
    addEventListener(type: string, fn: Function) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
  });
  const sandbox: any = {
    acquireVsCodeApi: () => ({ postMessage: (m: any) => posted.push(m), getState: () => ({}), setState: () => {} }),
    document, window, navigator: { platform: "Win32", clipboard: stub() }, localStorage: stub(),
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { constructor(fn: Function) { observers.push(fn); } observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    Event: class { constructor(public type: string, public init?: any) {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(__dirname, "..", "..", "..", "media", "marked.min.js"), "utf8"), sandbox);
  vm.runInContext(getChatClientScript("icon.svg", {
    currentSessionId: "s", currentModel: "m", currentProvider: "p",
    currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
  }), sandbox);

  const decisions: string[] = [];
  window.approveTool = (_id: string, scope: string) => decisions.push("approve:" + scope);
  window.rejectTool = () => decisions.push("reject");
  const keydown = (event: Record<string, any>) => {
    const e: any = { key: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, defaultPrevented: false, target: body, ...event };
    e.preventDefault = () => { e.defaultPrevented = true; };
    for (const fn of docListeners.keydown || []) fn(e);
    return e;
  };
  const promptKey = (event: Record<string, any>) => {
    const e: any = { key: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, defaultPrevented: false, target: byId["prompt-input"], ...event };
    e.preventDefault = () => { e.defaultPrevented = true; };
    for (const fn of byId["prompt-input"].listeners.keydown || []) fn(e);
    return e;
  };
  return {
    byId, promptBox, observers, decisions, keydown, promptKey, posted, sandbox, docListeners,
    /** Delivers a message from the extension host. */
    post: (data: any) => (windowListeners.message || []).forEach(fn => fn({ data })),
    eval: (code: string) => vm.runInContext(code, sandbox),
  };
}
