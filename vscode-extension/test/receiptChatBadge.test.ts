import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") {
    return { workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } };
  }
  return originalRequire.apply(this, arguments);
};
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
Module.prototype.require = originalRequire;

const script: string = getChatClientScript("icon.svg", {
  currentSessionId: "s1", currentModel: "m", currentProvider: "p",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
}).replace(/\r\n/g, "\n");

const key = (n: number) => n.toString(16).padStart(32, "a");

class Node {
  classes: Set<string>;
  attrs: Record<string, string>;
  children: Node[] = [];
  parent: Node | null = null;
  previousElementSibling: Node | null = null;
  nextElementSibling: Node | null = null;
  textContent = "";
  title = "";
  hidden = false;
  constructor(classes: string[], attrs: Record<string, string> = {}) {
    this.classes = new Set(classes);
    this.attrs = { ...attrs };
  }
  add(...children: Node[]) {
    for (const child of children) {
      child.parent = this;
      const last = this.children[this.children.length - 1];
      if (last) {
        last.nextElementSibling = child;
        child.previousElementSibling = last;
      }
      this.children.push(child);
    }
    return this;
  }
  get parentNode() { return this.parent; }
  get className() { return [...this.classes].join(" "); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  /** Enough HTML for the receipt line: one child per span, keeping its classes and plain text. */
  set innerHTML(html: string) {
    this.children = [];
    for (const match of html.matchAll(/<span class="([^"]+)"[^>]*>([^<]*)/g)) {
      const child = new Node(match[1].split(" "));
      child.textContent = match[2];
      this.add(child);
    }
  }
  insertBefore(node: Node, ref: Node) {
    node.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, node);
    this.relink();
    return node;
  }
  remove() {
    const parent = this.parent;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parent = null;
    parent.relink();
  }
  relink() {
    this.children.forEach((child, i) => {
      child.previousElementSibling = this.children[i - 1] || null;
      child.nextElementSibling = this.children[i + 1] || null;
    });
  }
  getAttribute(name: string) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name: string, value: string) { this.attrs[name] = String(value); }
  matches(selector: string): boolean {
    if (selector === ".message-wrap.user:not([data-steering])") {
      return this.classes.has("message-wrap") && this.classes.has("user") && !("data-steering" in this.attrs);
    }
    return selector.startsWith(".") && selector.slice(1).split(".").every((name) => this.classes.has(name));
  }
  closest(selector: string): Node | null {
    for (let node: Node | null = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): Node[] {
    const found: Node[] = [];
    const walk = (node: Node) => node.children.forEach((child) => { if (child.matches(selector)) found.push(child); walk(child); });
    walk(this);
    return found;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  compareDocumentPosition(other: Node) {
    let root: Node = this;
    while (root.parent) root = root.parent;
    const order: Node[] = [];
    const walk = (node: Node) => { order.push(node); node.children.forEach(walk); };
    walk(root);
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
  get classList() {
    return {
      toggle: (name: string, force: boolean) => (force ? this.classes.add(name) : this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name),
    };
  }
}

function receiptButton(turnKey?: string) {
  const button = new Node(["msg-copy-btn", "msg-receipt-btn"], turnKey ? { "data-turn-key": turnKey } : {})
    .add(new Node(["msg-action-label"]));
  button.hidden = true;
  return button;
}

function prompt(index: number) {
  return new Node(["message-wrap", "user"], { "data-turn-index": String(index) });
}

function answer(turnKey?: string) {
  return new Node(["message-wrap", "assistant"]).add(new Node(["message-footer"]).add(receiptButton(turnKey)));
}

/** Three finished turns; the second was steered once. `keys` gives each replayed footer its turn key. */
function chat(keys: Array<string | undefined> = []) {
  const container = new Node(["chat"]);
  const turns: Node[] = [];
  for (let i = 0; i < 3; i++) {
    const steering = new Node(["message-wrap", "user"], { "data-steering": "true", "data-turn-index": String(i) });
    const reply = answer(keys[i]);
    container.add(prompt(i), ...(i === 1 ? [steering] : []), reply);
    turns.push(reply);
  }
  return { container, turns };
}

function load(container: Node, sessionsState: Record<string, any> = {}) {
  const start = script.indexOf("function turnIndexForElement");
  const end = script.indexOf("/** Pins the meta strip");
  assert.ok(start > -1 && end > start, "receipt badge helpers must exist");
  const sandbox: any = {
    chatContainer: container, sessionsState, currentSessionId: "s1",
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, Array, Number, Math, Object, String, Boolean, parseInt, isNaN,
    document: { createElement: () => new Node([]) }, FOOTER_RECEIPT_ICON: "<svg></svg>",
  };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(start, end), sandbox);
  return sandbox;
}

const button = (reply: Node) => reply.querySelector(".msg-receipt-btn") as Node;
const label = (reply: Node) => button(reply).querySelector(".msg-action-label")!.textContent;
const line = (reply: Node) => reply.querySelector(".receipt-line");
const part = (reply: Node, name: string) => line(reply)!.querySelector(`.receipt-line-${name}`)!.textContent;
/** How a reader gets into the turn's receipt: the visible line, the footer link, or not at all. */
const way = (reply: Node) => (line(reply) ? "line" : button(reply).hidden ? "none" : "link");

describe("receipt badge in the chat", () => {
  it("finds the turn of a footer button, skipping steering prompts", () => {
    const { container, turns } = chat();
    const ctx = load(container);
    turns.forEach((reply, index) => assert.equal(ctx.turnIndexForElement(button(reply)), index));
  });

  it("badges the answer whose turn key matches, whatever the prompt count says", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    ctx.rememberReceiptTurns("s1", [{ turn_index: 7, turn_key: key(1), attention: 2, high: 1 }]);
    ctx.applyStoredReceiptBadges();
    assert.equal(way(turns[1]), "line");
    assert.equal(line(turns[1])!.getAttribute("data-turn"), "7");
    assert.equal(button(turns[1]).getAttribute("data-turn"), "7");
    assert.equal(part(turns[1], "status"), "2 to check");
    assert.equal(label(turns[1]), "Receipt · 2 to check");
    assert.equal(way(turns[0]), "none");
    assert.equal(way(turns[2]), "none");
  });

  it("never falls back to counting prompts for a turn whose key is not on screen", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    ctx.rememberReceiptTurns("s1", [{ turn_index: 1, turn_key: key(9), attention: 4, high: 4 }]);
    ctx.applyStoredReceiptBadges();
    turns.forEach((reply) => assert.equal(button(reply).hidden, true));
  });

  it("counts prompts only for turns recorded before turn keys existed", () => {
    const { container, turns } = chat();
    const ctx = load(container);
    ctx.rememberReceiptTurns("s1", [{ turn_index: 2, attention: 1, high: 0 }]);
    ctx.applyStoredReceiptBadges();
    assert.equal(label(turns[2]), "Receipt · 1 to check");
    assert.equal(button(turns[2]).title, "1 thing in this turn needs your eyes");
    assert.equal(button(turns[1]).hidden, true);
  });

  it("labels how much needs a look and clears it again", () => {
    const { container, turns } = chat();
    const ctx = load(container);
    const target = ctx.receiptButtonForTurn(1);
    ctx.applyReceiptBadge(target, ctx.receiptEntry({ turn_index: 1, attention: 3, high: 1 }));
    assert.equal(label(turns[1]), "Receipt · 3 to check");
    assert.ok(target.classList.contains("has-attention") && target.classList.contains("has-high"));
    assert.equal(target.title, "3 things in this turn need your eyes");
    assert.equal(label(turns[0]), "");

    ctx.applyReceiptBadge(target, ctx.receiptEntry({ turn_index: 1, attention: 0, high: 5 }));
    assert.equal(label(turns[1]), "Receipt");
    assert.ok(!target.classList.contains("has-attention") && !target.classList.contains("has-high"));
  });

  it("drops malformed turns, counts and keys from the engine", () => {
    const ctx = load(chat().container);
    for (const raw of [null, undefined, "1", { turn_index: "1" }, { turn_index: -1 }, { turn_index: 1.5 }, { turn_index: NaN }, { turn_index: Infinity }]) {
      assert.equal(ctx.receiptEntry(raw), null, JSON.stringify(raw));
    }
    const counts = (attention: unknown, high: unknown) => {
      const entry = ctx.receiptEntry({ turn_index: 0, attention, high });
      return [entry.attention, entry.high];
    };
    assert.deepEqual(counts("<b>x</b>", 1), [null, null]);
    assert.deepEqual(counts(1000, 0), [null, null]);
    assert.deepEqual(counts(-1, 0), [null, null]);
    assert.deepEqual(counts(2.5, 0), [null, null]);
    assert.deepEqual(counts(3, -4), [3, null]);
    assert.deepEqual(counts(999, 2), [999, 2]);
    for (const bad of [key(1).toUpperCase(), "x".repeat(32), key(1) + "0", key(1).slice(1), `${key(1).slice(2)}"x`, 7]) {
      assert.equal(ctx.receiptEntry({ turn_index: 0, turn_key: bad }).turn_key, null, String(bad));
    }

    const { container, turns } = chat();
    const fresh = load(container);
    fresh.applyReceiptBadge(fresh.receiptButtonForTurn(0), fresh.receiptEntry({ turn_index: 0, attention: "<img src=x>", high: 9 }));
    assert.equal(label(turns[0]), "Receipt");
    assert.equal(button(turns[0]).classList.contains("has-high"), false);
    fresh.applyReceiptBadge(null, fresh.receiptEntry({ turn_index: 0, attention: 2 }));
  });

  it("never writes through to the object prototype", () => {
    const sessionsState: Record<string, any> = {};
    const ctx = load(chat().container, sessionsState);
    for (const id of ["__proto__", "constructor", "prototype", "", 42]) {
      ctx.rememberReceiptTurns(id, [{ turn_index: 0, attention: 1, high: 1 }]);
      assert.equal(ctx.rememberReceiptReady({ session_id: id, turn_index: 0, attention: 1, high: 1 }), null);
    }
    for (const id of ["hasOwnProperty", "toString", "valueOf"]) {
      ctx.rememberReceiptReady({ session_id: id, turn_index: 0, attention: 1, high: 0 });
      assert.ok(Object.prototype.hasOwnProperty.call(sessionsState, id));
    }
    assert.equal(Object.getPrototypeOf(sessionsState), Object.prototype);
    assert.equal(({} as any).receipts, undefined);
    assert.equal((Object.prototype.hasOwnProperty as any).receipts, undefined);
    assert.equal((Object.prototype.toString as any).receipts, undefined);
    assert.equal(Object.keys(sessionsState).sort().join(","), "hasOwnProperty,toString,valueOf");
  });

  it("ignores session state inherited from a polluted prototype", () => {
    const inherited = { receipts: { [key(0)]: { turn_index: 0, turn_key: null, attention: 9, high: 9 } } };
    const sessionsState = Object.create({ s2: inherited });
    const { container, turns } = chat();
    const ctx = load(container, sessionsState);
    ctx.currentSessionId = "s2";
    ctx.applyStoredReceiptBadges();
    assert.equal(button(turns[0]).hidden, true);

    ctx.rememberReceiptReady({ session_id: "s2", turn_index: 1, attention: 1, high: 0 });
    assert.deepEqual(Object.keys(inherited.receipts), [key(0)]);
    assert.ok(Object.prototype.hasOwnProperty.call(sessionsState, "s2"));
    ctx.applyStoredReceiptBadges();
    assert.equal(button(turns[0]).hidden, true);
    assert.equal(label(turns[1]), "Receipt · 1 to check");
  });

  it("keeps only the turns the engine still has", () => {
    const sessionsState: Record<string, any> = {};
    const ctx = load(chat().container, sessionsState);
    ctx.rememberReceiptReady({ session_id: "s1", turn_index: 1, turn_key: key(1), attention: 1, high: 0 });
    ctx.rememberReceiptReady({ session_id: "s1", turn_index: 2, turn_key: key(2), attention: 5, high: 5 });
    ctx.rememberReceiptTurns("s1", [{ turn_index: 1, turn_key: key(1), attention: null, high: null }]);
    assert.deepEqual(Object.keys(sessionsState.s1.receipts), [key(1)]);
    ctx.rememberReceiptTurns("s1", "not a list");
    assert.deepEqual(Object.keys(sessionsState.s1.receipts), [key(1)]);
  });

  it("keeps counts seen live only while the engine has none", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    ctx.rememberReceiptReady({ session_id: "s1", turn_index: 1, turn_key: key(1), attention: 2, high: 1 });
    ctx.rememberReceiptTurns("s1", [{ turn_index: 1, turn_key: key(1), attention: null, high: null }]);
    ctx.applyStoredReceiptBadges();
    assert.equal(label(turns[1]), "Receipt · 2 to check");

    ctx.rememberReceiptTurns("s1", [{ turn_index: 1, turn_key: key(1), attention: 0, high: 0 }]);
    ctx.applyStoredReceiptBadges();
    assert.equal(label(turns[1]), "Receipt");
  });

  it("gives a live receipt to the newest answer of the newest prompt, once", () => {
    const { container, turns } = chat([key(0), key(1), undefined]);
    const ctx = load(container);
    const entry = ctx.rememberReceiptReady({ session_id: "s1", turn_index: 2, turn_key: key(2), attention: 1, high: 0 });
    assert.equal(ctx.receiptButtonForEntry(entry), null);
    const live = ctx.newestUnclaimedReceiptButton();
    assert.equal(live, button(turns[2]));
    ctx.applyReceiptBadge(live, entry);
    assert.equal(live.getAttribute("data-turn-key"), key(2));
    assert.equal(live.getAttribute("data-turn"), "2");
    assert.equal(ctx.newestUnclaimedReceiptButton(), null);
    assert.equal(ctx.receiptButtonForEntry(entry), live);
  });

  it("does not hand a live receipt to an older answer", () => {
    const { container, turns } = chat();
    container.add(prompt(3));
    const ctx = load(container);
    assert.equal(ctx.newestUnclaimedReceiptButton(), null, "the newest prompt has no answer yet");
    assert.equal(button(turns[2]).hidden, true);

    const claimed = chat([undefined, undefined, undefined]);
    const claimedCtx = load(claimed.container);
    button(claimed.turns[2]).setAttribute("data-turn", "2");
    assert.equal(claimedCtx.newestUnclaimedReceiptButton(), null, "a claimed answer is never reused");
  });

  it("stamps a replayed answer with its turn key, and only a well-formed one", () => {
    const start = script.indexOf("function buildMessageFooter");
    const end = script.indexOf("function turnIndexForElement");
    const sandbox: any = {
      document: { createElement: () => ({ className: "", innerHTML: "" }) },
      FOOTER_CLOCK_ICON: "", FOOTER_COPY_ICON: "", FOOTER_RECEIPT_ICON: "",
      formatTime: () => "10:00", formatDuration: () => "1s", isFinite,
    };
    vm.createContext(sandbox);
    vm.runInContext(script.slice(start, end), sandbox);
    const html = (receiptTurnKey: unknown) => sandbox.buildMessageFooter({ receiptAction: true, receiptTurnKey }).innerHTML;
    assert.match(html(key(4)), new RegExp(`data-action="open-receipt" data-turn-key="${key(4)}" `));
    for (const bad of [`" onmouseover="alert(1)`, key(4).toUpperCase(), key(4) + "a", null, undefined, 12]) {
      assert.doesNotMatch(html(bad), /data-turn-key/, String(bad));
      assert.doesNotMatch(html(bad), /onmouseover/);
    }
  });

  it("wires replay, live events and clicks to turn keys", () => {
    assert.match(script, /if \(!m\.steering\) currentTurnKey = typeof m\.turn_key === 'string' \? m\.turn_key : null;/);
    assert.match(script, /startsWith\('\[Previous context summary'\)\) \{\s*currentTurnKey = null;/);
    assert.match(script, /receiptAction: true,\s*receiptTurnKey: currentTurnKey,/);
    assert.match(script, /case 'receipt_ready': \{\s*const readyEntry = rememberReceiptReady\(msg\);\s*if \(readyEntry && msg\.session_id === currentSessionId\) \{\s*applyReceiptBadge\(receiptButtonForEntry\(readyEntry\) \|\| newestUnclaimedReceiptButton\(\), readyEntry\);/);
    assert.match(script, /case 'open-receipt': \{\s*const receiptTurn = parseInt\(target\.getAttribute\('data-turn'\) \|\| '', 10\);/);
    assert.match(script, /rememberReceiptTurns\(currentSessionId, msg\.session && msg\.session\.receipt_turns\);\s*applyStoredReceiptBadges\(\);/);
  });

  it("shows a visible receipt line for a turn that did work, in place of the footer link", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    ctx.rememberReceiptTurns("s1", [{ turn_index: 0, turn_key: key(0), attention: 0, high: 0, files_changed: 2, commands: 1, commands_failed: 0 }]);
    ctx.applyStoredReceiptBadges();
    const shown = line(turns[0])!;
    assert.equal(way(turns[0]), "line");
    assert.equal(button(turns[0]).hidden, true, "one way in per answer");
    assert.equal(shown.nextElementSibling, turns[0].querySelector(".message-footer"), "just above the footer");
    assert.equal(shown.getAttribute("data-action"), "open-receipt");
    assert.equal(shown.getAttribute("data-turn"), "0");
    assert.equal(shown.getAttribute("data-turn-key"), key(0));
    assert.equal(part(turns[0], "title"), "Receipt");
    assert.equal(part(turns[0], "summary"), "· 2 files changed · 1 command");
    assert.equal(part(turns[0], "status"), "Nothing flagged");
    assert.equal(shown.getAttribute("aria-label"), "Open the receipt for this turn: 2 files changed · 1 command, nothing flagged");
    assert.ok(!shown.classList.contains("has-attention") && !shown.classList.contains("has-high"));
  });

  it("makes a risky turn stand out", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    ctx.rememberReceiptTurns("s1", [
      { turn_index: 1, turn_key: key(1), attention: 2, high: 1, files_changed: 0, commands: 2, commands_failed: 1 },
      { turn_index: 2, turn_key: key(2), attention: 1, high: 0, files_changed: 1, commands: 0, commands_failed: 0 },
    ]);
    ctx.applyStoredReceiptBadges();
    assert.equal(part(turns[1], "summary"), "· 2 commands, 1 failed");
    assert.equal(part(turns[1], "status"), "2 to check");
    assert.ok(line(turns[1])!.classList.contains("has-attention") && line(turns[1])!.classList.contains("has-high"));
    assert.equal(part(turns[2], "summary"), "· 1 file changed");
    assert.ok(line(turns[2])!.classList.contains("has-attention") && !line(turns[2])!.classList.contains("has-high"));
  });

  it("adds nothing to a turn that only talked, and keeps its footer link", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    ctx.rememberReceiptTurns("s1", [{ turn_index: 0, turn_key: key(0), attention: 0, high: 0, files_changed: 0, commands: 0, commands_failed: 0 },
      { turn_index: 1, turn_key: key(1), attention: 0, high: 0 }]);
    ctx.applyStoredReceiptBadges();
    assert.equal(way(turns[0]), "link");
    assert.equal(way(turns[1]), "link", "a turn sealed before counts were kept");
    assert.equal(label(turns[0]), "Receipt");
  });

  it("keeps one line per answer and takes it away when the turn turns out to have done nothing", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    const entry = (files: number, attention: number) =>
      ctx.receiptEntry({ turn_index: 0, turn_key: key(0), attention, high: 0, files_changed: files, commands: 0, commands_failed: 0 });
    ctx.applyReceiptBadge(button(turns[0]), entry(1, 0));
    ctx.applyReceiptBadge(button(turns[0]), entry(3, 1));
    assert.equal(turns[0].querySelectorAll(".receipt-line").length, 1);
    assert.equal(part(turns[0], "summary"), "· 3 files changed");
    assert.equal(part(turns[0], "status"), "1 to check");
    ctx.applyReceiptBadge(button(turns[0]), entry(0, 0));
    assert.equal(way(turns[0]), "link");
  });

  it("ignores junk work counts from the engine", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    for (const junk of ["3", -1, 2.5, 1e7, true, null, "<img src=x>", [4]]) {
      const entry = ctx.receiptEntry({ turn_index: 0, turn_key: key(0), attention: 0, high: 0, files_changed: junk, commands: junk, commands_failed: junk });
      assert.deepEqual([entry.files, entry.commands, entry.failed], [null, null, null], String(junk));
      ctx.applyReceiptBadge(button(turns[0]), entry);
      assert.equal(way(turns[0]), "link", String(junk));
    }
    const big = ctx.receiptEntry({ turn_index: 0, attention: 0, high: 0, files_changed: 999999, commands: 0 });
    assert.equal(big.files, 999999);
  });

  it("keeps the work counts seen live when a reload has none", () => {
    const { container, turns } = chat([key(0), key(1), key(2)]);
    const ctx = load(container);
    ctx.rememberReceiptReady({ session_id: "s1", turn_index: 0, turn_key: key(0), attention: 0, high: 0, files_changed: 4, commands: 2, commands_failed: 1 });
    ctx.rememberReceiptTurns("s1", [{ turn_index: 0, turn_key: key(0), attention: 0, high: 0, files_changed: null, commands: null, commands_failed: null }]);
    ctx.applyStoredReceiptBadges();
    assert.equal(part(turns[0], "summary"), "· 4 files changed · 2 commands, 1 failed");
    ctx.rememberReceiptTurns("s1", [{ turn_index: 0, turn_key: key(0), attention: 0, high: 0, files_changed: 1, commands: 0, commands_failed: 0 }]);
    ctx.applyStoredReceiptBadges();
    assert.equal(part(turns[0], "summary"), "· 1 file changed", "the engine's own counts win");
  });

  it("really hides a footer link the chat marks hidden", () => {
    const { getChatStyles } = require("../src/providers/chatview/chatStyles.js");
    const css = getChatStyles().replace(/\s+/g, " ");
    assert.match(css, /\.msg-receipt-btn\[hidden\] \{ display: none; \}/);
    assert.match(css, /\.receipt-line \{[^}]*display: flex;/);
  });

  it("hides every compaction acknowledgement the engine writes, so none gets an answer footer", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const core = path.resolve(__dirname, "../../../src/andromity/core");
    const engine = ["agent.py", "session.py"].map((name) => fs.readFileSync(path.join(core, name), "utf8")).join("\n");
    const written = engine.match(/"Understood\. I have the context[^"]*"/g) || [];
    assert.equal(written.length, 2);
    const list = /const COMPACTION_ACKNOWLEDGEMENTS = \[([\s\S]*?)\];/.exec(script)?.[1] || "";
    for (const text of written) assert.ok(list.includes(`'${text.slice(1, -1)}'`), text);
    assert.match(script, /COMPACTION_ACKNOWLEDGEMENTS\.indexOf\(extractMessageText\(m\.content\)\.trim\(\)\) !== -1/);
  });

  it("puts a receipt button on finished answers only, beside Copy", () => {
    const footer = script.slice(script.indexOf("function buildMessageFooter"), script.indexOf("function turnIndexForElement"));
    assert.match(footer, /if \(opts\.receiptAction\)/);
    assert.match(footer, /aria-label="Open the receipt for this turn" hidden>/);
    const receiptCalls = script.match(/receiptAction: true/g) || [];
    assert.equal(receiptCalls.length, 2, "live and replayed answers");
  });
});
