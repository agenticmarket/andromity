import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { loadChat, stub } from "./helpers/chatHarness.js";

const Module = require("module");
const originalRequire = Module.prototype.require;
const vscodeMock: any = {
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: "D:/work/repo" } }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  window: { activeTextEditor: undefined, visibleTextEditors: [] },
  commands: { executeCommand: async () => {} },
  extensions: { getExtension: () => undefined },
  Uri: { joinPath: (...parts: any[]) => ({ fsPath: parts.map(p => typeof p === "object" ? p.fsPath : String(p)).join("/") }) },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? vscodeMock : originalRequire.apply(this, arguments as any);
};
const { handleInputMessage } = require("../src/server/inputBridge.js");
const { getWaterfallHtml } = require("../src/providers/waterfall/waterfallHtml.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
const { SessionTabPanel } = require("../src/panels/SessionTabPanel.js");
const { WaterfallPanel, WaterfallTraceStore } = require("../src/panels/WaterfallPanel.js");
Module.prototype.require = originalRequire;

const IMAGE = "data:image/png;base64,AA==";
const PLACEHOLDER = "Please inspect attached image";
const ONE = "This model can't read images, so your image wasn't sent. Switch to a model that supports images to include it.";
const MANY = "This model can't read images, so your images weren't sent. Switch to a model that supports images to include them.";

// ── A small DOM: enough tree, class and attribute behaviour for the chat's own code to run on ──

type Node = any;

function parseCompound(text: string) {
  const parts = { tag: "", id: "", classes: [] as string[], attrs: [] as Array<[string, string | null]>, nots: [] as string[], unknown: false };
  const re = /(#[\w-]+)|(\.[\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]|:not\(([^)]*)\)|(:[\w-]+(?:\([^)]*\))?)|(^[\w*-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) parts.id = m[1].slice(1);
    else if (m[2]) parts.classes.push(m[2].slice(1));
    else if (m[3]) parts.attrs.push([m[3], m[4] === undefined ? null : m[4]]);
    else if (m[5] !== undefined) parts.nots.push(m[5]);
    else if (m[6]) parts.unknown = true;
    else if (m[7]) parts.tag = m[7] === "*" ? "" : m[7].toUpperCase();
  }
  return parts;
}

function matchesCompound(el: Node, text: string): boolean {
  if (!el || !el.__fake) return false;
  const p = parseCompound(text);
  if (p.unknown) return false;
  if (p.tag && el.tagName !== p.tag) return false;
  if (p.id && el.id !== p.id) return false;
  if (p.classes.some(c => !el.classList.contains(c))) return false;
  for (const [name, value] of p.attrs) {
    const actual = el.getAttribute(name);
    if (actual === null || (value !== null && actual !== value)) return false;
  }
  return !p.nots.some(n => matchesCompound(el, n));
}

function matchesSelector(el: Node, selector: string): boolean {
  return selector.split(",").some(one => {
    const chain = one.trim().replace(/\s*>\s*/g, " ").split(/\s+/).filter(Boolean);
    if (!chain.length || !matchesCompound(el, chain[chain.length - 1])) return false;
    let at = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (at && !matchesCompound(at, chain[i])) at = at.parentNode;
      if (!at) return false;
      at = at.parentNode;
    }
    return true;
  });
}

function descendants(el: Node): Node[] {
  const out: Node[] = [];
  for (const child of el.children) { out.push(child, ...descendants(child)); }
  return out;
}

function el(tag = "div"): Node {
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Function[]> = {};
  let text = "";
  let html = "";
  const base: Record<string | symbol, any> = {
    __fake: true, tagName: tag.toUpperCase(), nodeType: 1, children: [] as Node[], parentNode: null, attrs,
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    dataset: {}, listeners, scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, clientWidth: 0, scrollWidth: 0,
    classList: {
      add: (...c: string[]) => c.forEach(x => classes.add(x)),
      remove: (...c: string[]) => c.forEach(x => classes.delete(x)),
      toggle: (c: string, force?: boolean) => { const on = force ?? !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
      contains: (c: string) => classes.has(c),
    },
    get className() { return [...classes].join(" "); },
    set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    get id() { return attrs.id || ""; },
    set id(v: string) { attrs.id = String(v); },
    get textContent(): string { return text + base.children.map((c: Node) => c.textContent).join(""); },
    set textContent(v: string) { detachAll(); text = String(v ?? ""); html = ""; },
    get innerText() { return base.textContent; },
    get innerHTML() { return html; },
    set innerHTML(v: string) { detachAll(); html = String(v ?? ""); text = html.replace(/<[^>]*>/g, ""); },
    get firstElementChild() { return base.children[0] || null; },
    get lastElementChild() { return base.children[base.children.length - 1] || null; },
    get firstChild() { return base.children[0] || null; },
    get lastChild() { return base.children[base.children.length - 1] || null; },
    get childNodes() { return base.children; },
    get parentElement() { return base.parentNode; },
    get nextElementSibling() { const s = base.parentNode?.children; return s ? s[s.indexOf(self) + 1] || null : null; },
    get previousElementSibling() { const s = base.parentNode?.children; return s ? s[s.indexOf(self) - 1] || null : null; },
    get isConnected() { let at: Node = self; while (at.parentNode) at = at.parentNode; return at.__root === true; },
    setAttribute(k: string, v: unknown) { attrs[k] = String(v); },
    getAttribute(k: string) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k: string) { return k in attrs; },
    removeAttribute(k: string) { delete attrs[k]; },
    appendChild(child: Node) { if (!child || !child.__fake) return child; detach(child); child.parentNode = self; base.children.push(child); return child; },
    append(...nodes: Node[]) { nodes.forEach(n => typeof n === "string" ? (text += n) : base.appendChild(n)); },
    prepend(...nodes: Node[]) { nodes.reverse().forEach(n => base.insertBefore(n, base.children[0] || null)); },
    insertBefore(child: Node, ref: Node) {
      detach(child);
      child.parentNode = self;
      const i = ref ? base.children.indexOf(ref) : -1;
      if (i < 0) base.children.push(child); else base.children.splice(i, 0, child);
      return child;
    },
    removeChild(child: Node) { detach(child); return child; },
    remove() { detach(self); },
    replaceWith(other: Node) { const parent = base.parentNode; if (!parent) return; parent.insertBefore(other, self); detach(self); },
    contains(other: Node) { for (let at = other; at; at = at.parentNode) if (at === self) return true; return false; },
    matches(selector: string) { return matchesSelector(self, selector); },
    closest(selector: string) { for (let at: Node = self; at; at = at.parentNode) if (matchesSelector(at, selector)) return at; return null; },
    querySelectorAll(selector: string) { return descendants(self).filter(d => matchesSelector(d, selector)); },
    querySelector(selector: string) { return descendants(self).find(d => matchesSelector(d, selector)) || null; },
    addEventListener(type: string, fn: Function) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    scrollIntoView() {}, scrollTo() {}, focus() {}, blur() {}, click() {},
    insertAdjacentHTML() {}, insertAdjacentElement(_w: string, n: Node) { return n; },
  };
  function detach(child: Node) {
    const parent = child.parentNode;
    if (parent) { const i = parent.children.indexOf(child); if (i >= 0) parent.children.splice(i, 1); }
    child.parentNode = null;
  }
  function detachAll() { for (const c of [...base.children]) detach(c); }
  const self: Node = new Proxy(base, {
    get(t, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => "";
      return prop in t ? t[prop] : stub();
    },
    set(t, prop, value) { t[prop] = value; return true; },
  });
  return self;
}

function chat() {
  const root = el("div");
  root.__root = true;
  const h = loadChat({ elements: { "chat-messages": root } });
  const doc = h.sandbox.document;
  const byId = doc.getElementById;
  doc.createElement = (tag: string) => el(tag);
  doc.getElementById = (id: string) => root.querySelector("#" + id) || byId(id);
  h.eval("queueSupported = true; currentSessionId = 's';");
  const prompts = () => root.querySelectorAll(".message-wrap.user:not([data-steering])");
  const notices = () => root.querySelectorAll(".images-skipped-notice");
  const turn = (inputId: string, prompt: string, images: string[] = []) =>
    h.post({ type: "agent_started", session_id: "s", input_id: inputId, prompt, image_uris: images, turn_index: prompts().length });
  const done = () => h.post({ type: "agent_done", session_id: "s", outcome: "success", turn_files: [] });
  const skipped = (msg: Record<string, unknown>) => h.post({ type: "images_skipped", session_id: "s", count: 1, prompt_added: true, steering: false, ...msg });
  return { h, root, prompts, notices, turn, done, skipped };
}

describe("chat view: images a model can't read", () => {
  it("drops the prompt and empty reply of a message of only images, so undo still counts the real turns", () => {
    const c = chat();
    c.turn("in-1", "make the button blue");
    c.h.post({ type: "text_delta", session_id: "s", text: "Done." });
    c.done();
    c.turn("in-2", PLACEHOLDER, [IMAGE]);
    assert.equal(c.prompts().length, 2, "the chat showed the prompt while it ran");

    c.skipped({ input_id: "in-2", prompt_added: false });
    c.done();

    assert.equal(c.prompts().length, 1);
    assert.equal(c.prompts()[0].getAttribute("data-input-id"), "in-1");
    assert.equal(c.root.querySelectorAll("[data-input-id=\"in-2\"]").length, 0);
    const assistants = c.root.querySelectorAll(".message-wrap.assistant");
    assert.equal(assistants.length, 1, "no empty reply is left behind");
    const [notice] = c.notices();
    assert.ok(notice, "the notice shows");
    assert.equal(c.root.children[c.root.children.length - 1], notice, "below the last real turn");
    const request = c.h.eval("undoRequestFor")(c.prompts()[0]);
    assert.deepEqual({ ...request }, { turnIndex: 0, totalTurns: 1, turnsToUndo: 1 });
  });

  it("does not report a message of only images as a finished turn", () => {
    const c = chat();
    c.turn("in-1", "run the tests");
    c.done();
    const before = c.h.posted.filter((m: any) => m.type === "turn_finished").length;
    c.turn("in-2", PLACEHOLDER, [IMAGE]);
    c.skipped({ input_id: "in-2", prompt_added: false });
    c.done();
    const after = c.h.posted.filter((m: any) => m.type === "turn_finished").length;
    assert.equal(after, before, "feature tips count turns; the previous turn's facts must not be counted again");
  });

  it("is a status notice with a Switch model button, not an error card", () => {
    const c = chat();
    c.turn("in-1", "why is this red?", [IMAGE]);
    c.skipped({ input_id: "in-1", count: 1 });
    const [notice] = c.notices();
    assert.equal(notice.getAttribute("role"), "status");
    assert.equal(notice.querySelector(".images-skipped-text").textContent, ONE);
    const button = notice.querySelector("button");
    assert.equal(button.getAttribute("data-action"), "switch-model-flyout");
    assert.match(button.innerHTML, /Switch model$/);
    assert.equal(c.root.querySelectorAll(".andromity-error-card, .error-card").length, 0);
    assert.equal(c.prompts().length, 1, "the prompt was sent, so it stays");
  });

  it("puts the notice between the prompt and its reply", () => {
    const c = chat();
    c.turn("in-1", "why is this red?", [IMAGE, IMAGE]);
    c.skipped({ input_id: "in-1", count: 2 });
    c.h.post({ type: "text_delta", session_id: "s", text: "I can't see the images." });
    const kids = c.root.children;
    const prompt = c.prompts()[0];
    const notice = c.notices()[0];
    const reply = c.root.querySelector(".message-wrap.assistant");
    assert.ok(kids.indexOf(prompt) < kids.indexOf(notice) && kids.indexOf(notice) < kids.indexOf(reply));
    assert.equal(notice.querySelector(".images-skipped-text").textContent, MANY);
  });

  it("leaves the chat alone for a notice from another session", () => {
    const c = chat();
    c.turn("in-1", PLACEHOLDER, [IMAGE]);
    c.h.post({ type: "images_skipped", session_id: "other", count: 1, prompt_added: false, steering: false, input_id: "in-1" });
    assert.equal(c.prompts().length, 1);
    assert.equal(c.notices().length, 0);
  });

  it("shows a steering message of only images inside the running reply and removes no prompt", () => {
    const c = chat();
    c.turn("in-1", "fix the button");
    c.h.post({ type: "text_delta", session_id: "s", text: "Working on it." });
    c.skipped({ input_id: "steer-1", prompt_added: false, steering: true });
    const reply = c.root.querySelector(".message-wrap.assistant");
    assert.equal(c.prompts().length, 1);
    assert.equal(reply.querySelectorAll(".images-skipped-notice").length, 1);
    c.h.post({ type: "text_delta", session_id: "s", text: "Still working." });
    const notice = reply.querySelector(".images-skipped-notice");
    const later = reply.children.slice(reply.children.indexOf(notice) + 1);
    const blockText = (n: Node) => (typeof n._blockText === "string" ? n._blockText : "");
    assert.ok(later.some((n: Node) => blockText(n).includes("Still working.")), "what the model says next goes below the notice");
    assert.ok(!reply.children.slice(0, reply.children.indexOf(notice)).some((n: Node) => blockText(n).includes("Still working.")));
  });

  it("puts a steering message's notice above the reply that follows it", () => {
    const c = chat();
    c.turn("in-1", "fix the button");
    c.h.post({ type: "input_applied", session_id: "s", input_id: "steer-1", prompt: "and the footer", image_uris: [IMAGE], turn_index: 0 });
    c.skipped({ input_id: "steer-1", prompt_added: true, steering: true });
    const kids = c.root.children;
    const steer = c.root.querySelector("[data-steering]");
    const notice = c.notices()[0];
    const replies = c.root.querySelectorAll(".message-wrap.assistant");
    assert.ok(kids.indexOf(steer) < kids.indexOf(notice) && kids.indexOf(notice) < kids.indexOf(replies[replies.length - 1]));
    assert.equal(c.prompts().length, 1, "a steering message is not a turn");
  });

  it("rebuilds the notice from the saved count after a reload, and ignores anything that is not a count", () => {
    const c = chat();
    c.h.post({ type: "session_loaded", session: { id: "s", name: "x", messages: [
      { role: "user", content: "why is this red?", images: [IMAGE], images_skipped: 2, ts: "2026-10-01T00:00:00Z" },
      { role: "assistant", content: "I can't see them." },
      { role: "user", content: "and this?", images_skipped: "<img src=x onerror=alert(1)>", ts: "2026-10-01T00:01:00Z" },
      { role: "assistant", content: "Sure." },
      { role: "user", content: "steer", steering: true, images_skipped: 1, ts: "2026-10-01T00:02:00Z" },
      { role: "user", content: "old message", ts: "2026-10-01T00:03:00Z" },
    ] } });
    const notices = c.notices();
    assert.equal(notices.length, 2);
    assert.equal(notices[0].querySelector(".images-skipped-text").textContent, MANY);
    assert.equal(notices[1].querySelector(".images-skipped-text").textContent, ONE);
    const kids = c.root.children;
    const users = c.root.querySelectorAll(".message-wrap.user");
    assert.equal(kids.indexOf(notices[0]), kids.indexOf(users[0]) + 1, "right below its prompt");
    assert.equal(kids.indexOf(notices[1]), kids.indexOf(users[2]) + 1);
    assert.ok(!JSON.stringify(c.root.querySelectorAll("*").map((n: Node) => n.innerHTML)).includes("onerror"));
  });

  it("sends the image-only flag only when the message holds nothing but images", () => {
    const send = (text: string, images: string[], files: unknown[] = []) => {
      const c = chat();
      c.h.byId["prompt-input"].value = text;
      c.h.sandbox.__images = images;
      c.h.sandbox.__files = files;
      c.h.eval("attachedImages = __images; attachedFiles = __files; sendCurrentPrompt('queue');");
      return c.h.posted.filter((m: any) => m.type === "submit_input").pop();
    };
    const imageOnly = send("", [IMAGE]);
    assert.equal(imageOnly.imageOnly, true);
    assert.equal(imageOnly.prompt, PLACEHOLDER);
    assert.equal(send("   ", [IMAGE]).imageOnly, true);
    assert.equal(send("why is this red?", [IMAGE]).imageOnly, false);
    assert.equal(send("", [IMAGE], [{ path: "src/a.ts", name: "a.ts" }]).imageOnly, false, "a file is something to read");
    assert.equal(send("hello", []).imageOnly, false);
  });
});

describe("input bridge: image-only flag", () => {
  const submit = async (message: Record<string, unknown>) => {
    const calls: any[] = [];
    const rpc: any = { call: async (method: string, params: any) => { calls.push({ method, params }); return { input_id: "i1", queue: { items: [] } }; } };
    await handleInputMessage(rpc, { type: "submit_input", requestId: "r1", sessionId: "s1", ...message } as any, "s1", () => {}, "safe");
    return calls.find(c => c.method === "agent.submit").params;
  };

  it("forwards the flag with the placeholder text and the images", async () => {
    const params = await submit({ prompt: PLACEHOLDER, images: [IMAGE], imageOnly: true });
    assert.equal(params.image_only, true);
    assert.deepEqual(params.image_uris, [IMAGE]);
    assert.ok(params.prompt.startsWith(PLACEHOLDER), "an engine that ignores the flag still gets text to answer");
  });

  it("sends false for anything but true", async () => {
    for (const imageOnly of [undefined, false, "true", 1]) {
      assert.equal((await submit({ prompt: "hi", images: [IMAGE], imageOnly })).image_only, false, String(imageOnly));
    }
  });
});

describe("hosts pass the engine's notice on to their view", () => {
  const NOTICE = { session_id: "s", count: 2, prompt_added: false, steering: false, input_id: "in-1" };

  function client() {
    const handlers = new Map<string, Function[]>();
    return {
      on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) || []), fn]),
      off: () => {},
      call: async () => ({}),
      emit: (event: string, params: unknown) => (handlers.get(event) || []).forEach(fn => fn(params)),
    };
  }

  function bound(prototype: any, fields: Record<string, unknown>, postName: string) {
    const rpc = client();
    const posts: any[] = [];
    const host: any = Object.create(prototype);
    Object.assign(host, { _rpcClient: rpc, _rpcDisposables: [], [postName]: (m: unknown) => posts.push(m) }, fields);
    host._bindRpcEvents();
    return { rpc, posts };
  }

  it("the sidebar chat", () => {
    const { rpc, posts } = bound(ChatViewProvider.prototype, {}, "_postToWebview");
    rpc.emit("agent/imagesSkipped", NOTICE);
    assert.deepEqual(posts.filter(p => p.type === "images_skipped"), [{ type: "images_skipped", ...NOTICE }]);
  });

  it("a session tab, for its own session only", () => {
    const { rpc, posts } = bound(SessionTabPanel.prototype, { _sessionId: "s" }, "_postMessage");
    rpc.emit("agent/imagesSkipped", NOTICE);
    rpc.emit("agent/imagesSkipped", { ...NOTICE, session_id: "other" });
    assert.deepEqual(posts.filter(p => p.type === "images_skipped"), [{ type: "images_skipped", ...NOTICE }]);
  });

  it("an open waterfall, and the trace kept for one opened later", () => {
    const { rpc, posts } = bound(WaterfallPanel.prototype, { _sessionId: "s" }, "_postMessage");
    rpc.emit("agent/imagesSkipped", NOTICE);
    assert.deepEqual(posts.filter(p => p.type === "images_skipped"), [{ type: "images_skipped", ...NOTICE }]);

    const store = client();
    WaterfallTraceStore.init(store);
    store.emit("agent/started", { session_id: "s", prompt: PLACEHOLDER });
    store.emit("agent/imagesSkipped", NOTICE);
    store.emit("agent/done", { session_id: "s" });
    assert.deepEqual(WaterfallTraceStore.getEvents("s").map((e: any) => e.type), ["agent_started", "images_skipped", "agent_done"]);
    WaterfallTraceStore.dispose();
  });
});

describe("waterfall: a message of only images", () => {
  function element(id = ""): any {
    const classes = new Set<string>();
    let text = "";
    const node: any = {
      id, dataset: {}, style: {}, children: [], removed: false, listeners: {} as Record<string, Function>,
      classList: { add: (...c: string[]) => c.forEach(x => classes.add(x)), remove: (...c: string[]) => c.forEach(x => classes.delete(x)),
        toggle: (c: string, f?: boolean) => ((f ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)), contains: (c: string) => classes.has(c) },
      get innerHTML() { return text; }, set innerHTML(v: string) { text = String(v); },
      get textContent() { return text; }, set textContent(v: string) { text = String(v); },
      addEventListener: (type: string, cb: Function) => { node.listeners[type] = cb; }, removeEventListener: () => {},
      setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {},
      appendChild: (child: any) => child, insertBefore: (child: any) => child, removeChild: (child: any) => child,
      remove: () => { node.removed = true; },
      querySelector: () => element(), querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }), scrollTo: () => {},
    };
    return node;
  }

  function load() {
    const html: string = getWaterfallHtml({ cspSource: "vscode-webview:", asWebviewUri: (u: any) => String(u.fsPath || u) }, "s", "Session");
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    const byId = new Map<string, any>();
    const created: any[] = [];
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const posted: any[] = [];
    const sandbox: any = {
      window: { addEventListener: (type: string, cb: any) => { if (type === "message") listeners.push(cb); }, removeEventListener: () => {}, postMessage: () => {} },
      document: {
        getElementById: (id: string) => { if (!byId.has(id)) byId.set(id, element(id)); return byId.get(id); },
        createElement: () => { const e = element(); created.push(e); return e; }, createTextNode: () => element(),
        querySelector: () => element(), querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {}, body: element(),
      },
      acquireVsCodeApi: () => ({ postMessage: (m: unknown) => posted.push(m), getState: () => ({}), setState: () => {} }),
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
      marked: { parse: (s: string) => s, use: () => {} },
    };
    vm.createContext(sandbox);
    vm.runInContext(script!, sandbox);
    const send = (data: Record<string, unknown>) => listeners.forEach(cb => cb({ data }));
    const turns = () => {
      byId.get("btn-export").listeners.click();
      const data = posted.filter(m => m.type === "export_waterfall").at(-1).data;
      return JSON.parse(JSON.stringify(data)).turns.map((t: any) => t.query);
    };
    return { send, turns };
  }

  const llm = (turnId: string, ts: number) => [
    { type: "waterfall_llm_start", turn_id: turnId, model: "m", ts },
    { type: "waterfall_llm_end", turn_id: turnId, duration_ms: 100, ttfb_ms: 10, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ts: ts + 1 },
  ];

  it("removes the turn it opened and numbers the next one as if it never ran", () => {
    const w = load();
    w.send({ type: "agent_started", session_id: "s", prompt: "first", ts: 100 });
    llm("t1", 101).forEach(w.send);
    w.send({ type: "agent_done", session_id: "s", ts: 103 });
    w.send({ type: "agent_started", session_id: "s", prompt: PLACEHOLDER, ts: 200 });
    w.send({ type: "images_skipped", session_id: "s", count: 1, prompt_added: false, steering: false });
    w.send({ type: "agent_done", session_id: "s", ts: 201 });
    w.send({ type: "agent_started", session_id: "s", prompt: "second", ts: 300 });
    llm("t2", 301).forEach(w.send);
    w.send({ type: "agent_done", session_id: "s", ts: 303 });
    assert.deepEqual(w.turns(), ["first", "second"]);
  });

  it("keeps the turn when the prompt was sent or the images came while it ran", () => {
    for (const msg of [{ prompt_added: true, steering: false }, { prompt_added: false, steering: true }]) {
      const w = load();
      w.send({ type: "agent_started", session_id: "s", prompt: "look", ts: 100 });
      w.send({ type: "images_skipped", session_id: "s", count: 1, ...msg });
      llm("t1", 101).forEach(w.send);
      w.send({ type: "agent_done", session_id: "s", ts: 103 });
      assert.deepEqual(w.turns(), ["look"], JSON.stringify(msg));
    }
  });

  it("never removes a turn that already has work in it", () => {
    const w = load();
    w.send({ type: "agent_started", session_id: "s", prompt: "look", ts: 100 });
    llm("t1", 101).forEach(w.send);
    w.send({ type: "images_skipped", session_id: "s", count: 1, prompt_added: false, steering: false });
    w.send({ type: "agent_done", session_id: "s", ts: 103 });
    assert.deepEqual(w.turns(), ["look"]);
  });
});
