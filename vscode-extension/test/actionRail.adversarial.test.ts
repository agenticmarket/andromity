import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import * as fs from "node:fs";
import * as path from "node:path";

const nodeRequire: NodeRequire = require;
const Module = nodeRequire("module");
const originalRequire = Module.prototype.require;

/* ------------------------------------------------------------------ */
/* vscode stand-in. Records commands and error messages.               */
/* ------------------------------------------------------------------ */

const executed: Array<{ command: string; args: unknown[] }> = [];
const shownErrors: string[] = [];
let executeBehaviour: (command: string) => unknown = () => undefined;

const uri = (p: string): any => ({ path: p, fsPath: p, toString: () => p });
const vscodeStub: any = {
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined, update: async () => {} }),
  },
  window: {
    activeTextEditor: undefined,
    showErrorMessage: (message: string) => { shownErrors.push(String(message)); return Promise.resolve(undefined); },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    createWebviewPanel: () => { throw new Error("createWebviewPanel is replaced per test"); },
  },
  languages: { getDiagnostics: () => [] },
  extensions: { getExtension: () => undefined },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      return executeBehaviour(command);
    },
  },
  env: { isTelemetryEnabled: true },
  ViewColumn: { One: 1, Two: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1 },
  Uri: {
    joinPath: (base: any, ...parts: string[]) => uri([typeof base === "string" ? base : base.path ?? base.fsPath, ...parts].join("/")),
    file: (p: string) => uri(p),
    parse: (p: string) => uri(p),
  },
};
Module.prototype.require = function (this: any, name: string) {
  if (name === "vscode") return vscodeStub;
  return originalRequire.apply(this, arguments as any);
};

const EXT_DIR = path.resolve(__dirname, "../..");
const chatHtml = nodeRequire("../src/providers/chatview/chatHtml.js");
const railModule = nodeRequire("../src/providers/chatview/actionRail.js");
const { getChatClientScript } = nodeRequire("../src/providers/chatview/chatClientScript.js");
const { getChatStyles } = nodeRequire("../src/providers/chatview/chatStyles.js");
const { getChatPolishStyles } = nodeRequire("../src/providers/chatview/chatPolishStyles.js");

const BASE_STATE = {
  currentSessionId: "s1", currentModel: "m", currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
  models: [], pinnedModels: [], workspaceFiles: [], workspaceFolders: [], extensionVersion: "0.2.26",
};
const fakeWebview = { cspSource: "http://127.0.0.1:8781", asWebviewUri: (u: any) => uri(u.path ?? String(u)) };

function pageHtml(state: Record<string, unknown> = {}): string {
  return chatHtml.getChatViewHtml(fakeWebview, uri(EXT_DIR), { ...BASE_STATE, ...state });
}

const RAIL_MARKUP = [/<nav class="action-rail"/, /id="action-rail"/, /id="rail-menu"/, /id="rail-toggle"/, /id="rail-more"/, /<button[^>]*data-rail-action=/, /class="rail-menu"/];
const railRendered = (html: string) => /<nav class="action-rail"/.test(html);
const railScripted = (html: string) => html.includes("andromity.actionRail.expanded");

/* ------------------------------------------------------------------ */
/* 1. Rail is rendered only for the tab                                */
/* ------------------------------------------------------------------ */

describe("Action rail: sidebar stays untouched", () => {
  it("absent or false actionRail renders no rail markup, no rail script and no body class", () => {
    for (const state of [{}, { actionRail: false }, { actionRail: undefined }]) {
      const html = pageHtml(state);
      for (const marker of RAIL_MARKUP) assert.ok(!marker.test(html), `${marker} present for ${JSON.stringify(state)}`);
      assert.ok(!railScripted(html), `rail script present for ${JSON.stringify(state)}`);
      assert.ok(!/<body class="[^"]*\bhas-action-rail\b/.test(html));
    }
  });

  it("actionRail true renders the nav, the menu and the script exactly once", () => {
    const html = pageHtml({ actionRail: true });
    assert.ok(railRendered(html) && railScripted(html));
    for (const id of ["action-rail", "rail-menu", "rail-toggle", "rail-more"]) {
      assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `id ${id} must appear once`);
    }
    assert.equal((html.match(/<button[^>]*data-rail-action="/g) || []).length, 5 + 1 + 5);
    assert.equal(html.split("const RAIL_EXPANDED_KEY").length - 1, 1);
  });

  it("ChatViewProvider enables the rail only for a strict boolean true", () => {
    const { ChatViewProvider } = nodeRequire("../src/providers/ChatViewProvider.js");
    const provider: any = new ChatViewProvider(uri(EXT_DIR));
    const render = (custom?: any) => provider._getHtmlForWebview(fakeWebview, custom);
    const truthyNonBooleans: unknown[] = ["true", "false", "1", 1, 2, {}, [], ["x"], "yes", () => true, Symbol("x")];
    for (const value of truthyNonBooleans) {
      const html = render({ actionRail: value });
      assert.ok(!railRendered(html) && !railScripted(html), `provider enabled the rail for ${String(value)}`);
    }
    for (const custom of [undefined, {}, { actionRail: false }, { actionRail: null }, { actionRail: undefined }]) {
      const html = render(custom);
      assert.ok(!railRendered(html) && !railScripted(html), `provider enabled the rail for ${JSON.stringify(custom)}`);
    }
    const on = render({ actionRail: true });
    assert.ok(railRendered(on) && railScripted(on));
  });

  it("getChatViewHtml itself never renders the rail without its script, and ignores truthy non-booleans", () => {
    const enabled: string[] = [];
    for (const value of ["true", "false", 1, 2, {}, [], "yes"]) {
      const html = pageHtml({ actionRail: value });
      if (railRendered(html) || railScripted(html)) enabled.push(`${JSON.stringify(value)} -> markup ${railRendered(html)}, script ${railScripted(html)}`);
    }
    assert.deepEqual(enabled, [], `chatHtml.ts gates the markup on truthiness but chatClientScript.ts gates the script on === true: ${enabled.join("; ")}`);
  });

  it("every rail selector is namespaced so it cannot match any element without the rail markup", () => {
    const css: string = railModule.getActionRailStyles();
    const selectors: string[] = [];
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat))) {
      const head = m[1].trim();
      if (head.startsWith("@")) continue;
      for (const part of head.split(",")) {
        const sel = part.trim();
        if (sel) selectors.push(sel);
      }
    }
    assert.ok(selectors.length > 20, "expected to parse the rail stylesheet");
    const ok = (sel: string) => /^(\.action-rail|\.rail-|body:has\(> \.action-rail|body\.has-action-rail)/.test(sel);
    assert.deepEqual(selectors.filter(sel => !ok(sel)), [], "rail rule with a selector that is not rail-scoped");
    const others = (getChatStyles() + "\n" + getChatPolishStyles()).split(css).join("");
    assert.ok(getChatStyles().includes(css), "rail stylesheet is not part of the chat styles");
    for (const cls of [".rail-btn", ".rail-menu", ".rail-label", ".rail-sep", ".rail-grow", ".rail-toggle", ".action-rail", "has-action-rail"]) {
      const count = others.split(cls).length - 1;
      assert.equal(count, 0, `${cls} already used by other chat styles (${count}x)`);
    }
  });

  it("the rail script is injected once for the tab and never for the sidebar; the flyout-trigger selector is extended", () => {
    const rail: string = railModule.getActionRailScript();
    const tab: string = getChatClientScript("icon", { ...BASE_STATE, actionRail: true });
    const sidebar: string = getChatClientScript("icon", BASE_STATE);
    assert.equal(tab.split(rail).length - 1, 1, "rail script must be injected exactly once for the tab");
    assert.equal(sidebar.split(rail).length - 1, 0, "rail script leaked into the sidebar script");
    assert.ok(sidebar.includes(`e.target.closest('#btn-session-picker, [data-rail-action="sessions"]')`));
  });
});

/* ------------------------------------------------------------------ */
/* 2. Host allowlist                                                   */
/* ------------------------------------------------------------------ */

const ALLOWED: Record<string, string> = {
  prs: "andromity.openPullRequestsView",
  diffs: "andromity.viewGitDiff",
  setup: "andromity.checkSetup",
  restart: "andromity.restartServer",
  welcome: "andromity.welcome",
};

const BAD_ACTIONS: Array<[string, unknown]> = [
  ["missing", undefined], ["null", null], ["zero", 0], ["number 1", 1], ["NaN", NaN], ["true", true], ["false", false],
  ["empty string", ""], ["array of valid", ["prs"]], ["empty array", []], ["nested array", [["prs"]]],
  ["object", {}], ["object with toString", { toString: () => "prs" }], ["object with valueOf", { valueOf: () => "prs" }],
  ["String object", new String("prs")], ["null-proto object", Object.create(null)],
  ["upper case", "PRS"], ["title case", "Prs"], ["mixed case welcome", "wElCoMe"], ["leading space", " prs"], ["trailing space", "prs "],
  ["newline", "prs\n"], ["tab", "\tprs"], ["nul suffix", "prs\u0000"], ["unicode lookalike", "prs\u200b"], ["fullwidth", "ｐｒｓ"],
  ["__proto__", "__proto__"], ["constructor", "constructor"], ["toString", "toString"], ["hasOwnProperty", "hasOwnProperty"],
  ["valueOf", "valueOf"], ["isPrototypeOf", "isPrototypeOf"], ["__defineGetter__", "__defineGetter__"], ["prototype", "prototype"],
  ["size", "size"], ["get", "get"], ["has", "has"], ["keys", "keys"], ["entries", "entries"], ["forEach", "forEach"],
  ["webview-handled new", "new"], ["webview-handled sessions", "sessions"], ["webview-handled review", "review"],
  ["webview-handled settings", "settings"], ["webview-handled undo", "undo"], ["webview-handled compact", "compact"],
  ["real command id settings", "andromity.openSettings"], ["real command id terminal", "workbench.action.terminal.new"],
  ["real mapped command id", "andromity.checkSetup"], ["command with args", "andromity.welcome ?x"], ["path traversal", "../prs"],
  ["comma list", "prs,diffs"], ["semicolon list", "prs;diffs"], ["very long", "p".repeat(1_000_000)], ["very long valid prefix", "prs".repeat(100_000)],
  ["function", () => "prs"], ["symbol", Symbol("prs")], ["bigint", BigInt(1)], ["date", new Date(0)],
];

function fakeTab(provider?: any, sessionId?: string): { handler: (message: any) => Promise<void>; posts: any[]; panel: any; instance: any } {
  const { SessionTabPanel } = nodeRequire("../src/panels/SessionTabPanel.js");
  const posts: any[] = [];
  let handler: (message: any) => Promise<void> = async () => {};
  const webview: any = {
    html: "", cspSource: fakeWebview.cspSource, asWebviewUri: fakeWebview.asWebviewUri,
    onDidReceiveMessage: (fn: any) => { handler = fn; return { dispose() {} }; },
    postMessage: async (m: any) => { posts.push(m); return true; },
  };
  const panel: any = {
    webview, title: "", iconPath: undefined,
    onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
    reveal() {}, dispose() {},
  };
  const created: { state?: any } = {};
  vscodeStub.window.createWebviewPanel = () => panel;
  const viewProvider: any = provider ?? {
    _getHtmlForWebview: (_w: any, state: any) => { created.state = state; return "<html><head></head><body class=\"loading\"></body></html>"; },
    isSoundEnabled: () => false, isViewVisible: () => false, getWorkspaceIndex: async () => ({ files: [], dirs: [] }),
    saveSidePanelVisibility: async () => {}, saveSidePanelPreferences: async () => {}, waitlist: undefined,
  };
  const id = sessionId ?? "tab-" + Math.random().toString(36).slice(2);
  const instance = SessionTabPanel.createOrShow(uri(EXT_DIR), id, "name", null, { globalState: { get: () => undefined, update: async () => {} } }, viewProvider);
  return Object.assign({ handler: (m: any) => handler(m), posts, panel, instance }, { created }) as any;
}

describe("Action rail: host allowlist", () => {
  it("SessionTabPanel asks for the rail with a boolean true", () => {
    const tab: any = fakeTab();
    assert.strictEqual(tab.created.state.actionRail, true);
    tab.instance.dispose();
  });

  it("actionRailCommand maps exactly five actions and nothing else", () => {
    for (const [action, command] of Object.entries(ALLOWED)) assert.equal(railModule.actionRailCommand(action), command);
    for (const [label, value] of BAD_ACTIONS) assert.equal(railModule.actionRailCommand(value), undefined, `${label} resolved to a command`);
  });

  it("each valid run_action runs its one command exactly once and posts nothing back", async () => {
    const tab = fakeTab();
    try {
      for (const [action, command] of Object.entries(ALLOWED)) {
        executed.length = 0; shownErrors.length = 0; tab.posts.length = 0;
        await tab.handler({ type: "run_action", action });
        assert.deepEqual(executed.map(e => e.command), [command], action);
        assert.deepEqual(executed.map(e => e.args), [[]], `${action} must run without arguments`);
        assert.deepEqual(shownErrors, []);
        assert.deepEqual(tab.posts.filter(p => p.type === "action_failed"), []);
      }
    } finally { tab.instance.dispose(); }
  });

  it("every other action value, and extra fields, run nothing and show nothing", async () => {
    const tab = fakeTab();
    try {
      for (const [label, value] of BAD_ACTIONS) {
        executed.length = 0; shownErrors.length = 0; tab.posts.length = 0;
        await tab.handler({ type: "run_action", action: value });
        assert.deepEqual(executed, [], `${label} executed ${JSON.stringify(executed.map(e => e.command))}`);
        assert.deepEqual(shownErrors, [], `${label} showed an error`);
        assert.deepEqual(tab.posts.filter(p => p.type === "action_failed"), [], `${label} failed the panel`);
      }
      executed.length = 0;
      await tab.handler({ type: "run_action" });
      await tab.handler({ type: "run_action", command: "workbench.action.terminal.new", id: "andromity.welcome", commandId: "x", args: [1] });
      await tab.handler(JSON.parse('{"type":"run_action","action":"__proto__"}'));
      await tab.handler(JSON.parse('{"type":"run_action","__proto__":{"action":"prs"}}'));
      for (const type of ["RUN_ACTION", "run_action ", "runAction", "run-action", "Run_Action"]) await tab.handler({ type, action: "prs" });
      assert.deepEqual(executed.map(e => e.command), [], "unexpected command from malformed run_action");
      await tab.handler({ type: "run_action", action: "prs", command: "workbench.action.terminal.new", args: ["--evil"] });
      assert.deepEqual(executed.map(e => e.command), ["andromity.openPullRequestsView"]);
      assert.deepEqual(executed[0].args, []);
    } finally { tab.instance.dispose(); }
  });

  it("Changes Review from a tab is scoped to the tab's own session, not the last turn of whichever session finished last", async () => {
    const { ChatViewProvider } = nodeRequire("../src/providers/ChatViewProvider.js");
    const provider: any = new ChatViewProvider(uri(EXT_DIR));
    const opened: any[][] = [];
    provider._diffManager = { openReviewWebview: (...args: any[]) => opened.push(args), setRpcClient() {} };
    provider._latestTurnFiles = new Set(["other-session/only-here.ts"]);
    provider._latestTurn = { sessionId: "session-A", turnIndex: 2 };
    provider._currentSessionId = "session-A";
    const tab = fakeTab(provider, "session-B");
    try {
      await tab.handler({ type: "open_review_tab" });
      assert.equal(opened.length, 1);
      const [, files, turn] = opened[0];
      assert.ok(!(files || []).includes("other-session/only-here.ts") && turn?.sessionId !== "session-A",
        `a tab for session-B opened the review scoped to session-A's turn: files=${JSON.stringify(files)} turn=${JSON.stringify(turn)}`);
      assert.ok(!files || files.length === 0, "a bare open_review_tab should open all changes, not a file subset");
      opened.length = 0;
      await tab.handler({ type: "open_review_tab", filePath: "a.ts", turnFiles: ["a.ts"], turnIndex: 1 });
      assert.equal(opened.length, 1);
      assert.deepEqual(opened[0][1], ["a.ts"], "an explicit turn scope must still be honoured");
      assert.deepEqual(opened[0][2], { sessionId: "session-B", turnIndex: 1 }, "explicit turn must belong to the tab's session");
      opened.length = 0;
      await tab.handler({ type: "open_review_tab", turnFiles: [] });
      assert.deepEqual(opened[0][1], [], "an explicit empty scope must not be widened");
      opened.length = 0;
      await tab.handler({ type: "open_diff", filePath: "b.ts" });
      assert.equal(opened[0][0], "b.ts");
      assert.ok(!((opened[0][1] || []) as string[]).includes("other-session/only-here.ts"));
    } finally { tab.instance.dispose(); }
  });

  it("twenty concurrent run_action messages run twenty commands, none doubled or dropped", async () => {
    const tab = fakeTab();
    try {
      executed.length = 0;
      const names = Object.keys(ALLOWED);
      await Promise.all(Array.from({ length: 20 }, (_, i) => tab.handler({ type: "run_action", action: names[i % names.length] })));
      assert.equal(executed.length, 20);
      for (const name of names) assert.equal(executed.filter(e => e.command === ALLOWED[name]).length, 4);
    } finally { tab.instance.dispose(); }
  });

  it("a failing command shows one error and does not take the panel down, whatever was thrown", async () => {
    const tab = fakeTab();
    try {
      const thrown: Array<[string, () => unknown]> = [
        ["Error", () => new Error("boom")], ["string", () => "plain string"], ["null", () => null], ["undefined", () => undefined],
        ["number", () => 42], ["object", () => ({ message: "m" })], ["error without message", () => new Error()],
        ["long message", () => new Error("x".repeat(100_000))], ["throwing toString", () => ({ toString() { throw new Error("nested"); } })],
        ["null-proto", () => Object.create(null)],
      ];
      for (const [label, make] of thrown) {
        for (const mode of ["reject", "sync"] as const) {
          executeBehaviour = () => { if (mode === "sync") throw make(); return Promise.reject(make()); };
          executed.length = 0; shownErrors.length = 0; tab.posts.length = 0;
          await tab.handler({ type: "run_action", action: "prs" });
          assert.equal(executed.length, 1, `${label}/${mode}: command not run once`);
          const directFailures = tab.posts.filter(p => p.type === "action_failed").length;
          assert.ok(shownErrors.length === 1 || directFailures === 1, `${label}/${mode}: neither an error message nor action_failed (errors=${shownErrors.length}, failed=${directFailures})`);
        }
      }
      executeBehaviour = () => undefined;
      executed.length = 0;
      await tab.handler({ type: "run_action", action: "welcome" });
      assert.deepEqual(executed.map(e => e.command), ["andromity.welcome"], "panel unusable after a failure");
    } finally { executeBehaviour = () => undefined; tab.instance.dispose(); }
  });

  it("an error from the command does not leak a stack trace into the message the user sees", async () => {
    const tab = fakeTab();
    try {
      const error = new Error("command failed");
      executeBehaviour = () => Promise.reject(error);
      shownErrors.length = 0;
      await tab.handler({ type: "run_action", action: "setup" });
      assert.equal(shownErrors.length, 1);
      assert.ok(!/\n\s+at /.test(shownErrors[0]), shownErrors[0]);
      assert.ok(!/litellm|Traceback|\.ts:\d+|\.js:\d+/.test(shownErrors[0]), shownErrors[0]);
    } finally { executeBehaviour = () => undefined; tab.instance.dispose(); }
  });

  it("_handleMessage itself never rejects for a failing command (no reliance on the outer wrapper)", async () => {
    const tab = fakeTab();
    try {
      for (const make of [() => new Error("x"), () => "s", () => null, () => undefined, () => Object.create(null)]) {
        executeBehaviour = () => Promise.reject(make());
        await assert.doesNotReject(() => tab.instance._handleMessage({ type: "run_action", action: "restart" }));
      }
    } finally { executeBehaviour = () => undefined; tab.instance.dispose(); }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Static checks of the generated markup and script                 */
/* ------------------------------------------------------------------ */

describe("Action rail: generated code", () => {
  it("markup is static: identical on every call, no scripts, handlers, template leftovers or user data", () => {
    const first: string = railModule.getActionRailHtml();
    assert.equal(first, railModule.getActionRailHtml());
    assert.ok(!/<script|\son[a-z]+\s*=|javascript:|\$\{|undefined|\[object|NaN|<style|style="/i.test(first), first.match(/<script|\son[a-z]+\s*=|javascript:|\$\{|undefined|\[object|NaN|<style|style="/i)?.[0]);
    assert.ok(!/<a\s/i.test(first) && !/\bhref=/.test(first));
    const actions = Array.from(first.matchAll(/data-rail-action="([^"]*)"/g)).map(m => m[1]);
    assert.deepEqual(actions, ["new", "sessions", "review", "prs", "diffs", "settings", "setup", "restart", "compact", "undo", "welcome"]);
    const withDifferentState = pageHtml({ actionRail: true, currentSessionId: "<img src=x onerror=alert(1)>", currentModel: "\"><script>1</script>" });
    const slice = (html: string) => html.slice(html.indexOf('<nav class="action-rail"'), html.indexOf('id="rail-menu"') + 600);
    assert.equal(slice(withDifferentState), slice(pageHtml({ actionRail: true })), "rail markup depends on state");
  });

  it("script never writes HTML, evaluates strings or sends a command id", () => {
    const script: string = railModule.getActionRailScript();
    for (const banned of [/\.innerHTML/, /\.outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /\.srcdoc/, /createContextualFragment/, /DOMParser/, /location\s*=|location\.href|window\.open/, /\bfetch\s*\(|XMLHttpRequest|WebSocket/]) {
      assert.ok(!banned.test(script), `rail script uses ${banned}`);
    }
    const types = Array.from(script.matchAll(/type:\s*'([a-z_]+)'/g)).map(m => m[1]);
    assert.deepEqual([...new Set(types)].sort(), ["compact_session", "new_session", "open_review_tab", "open_settings", "run_action", "undo_turn"]);
    assert.ok(!/\bcommand\s*:/.test(script) && !/commandId|executeCommand/.test(script));
    assert.ok(!/localStorage\.(?:getItem|setItem)\((?!RAIL_EXPANDED_KEY)/.test(script));
  });

  it("the rail script parses on its own and inside the chat script, with no name already declared there", () => {
    const rail: string = railModule.getActionRailScript();
    assert.doesNotThrow(() => new vm.Script(rail), "rail script is not valid JavaScript by itself");
    const full: string = getChatClientScript("icon", { ...BASE_STATE, actionRail: true });
    assert.ok(full.includes(rail));
    assert.doesNotThrow(() => new vm.Script(full), "chat script no longer parses");
    assert.doesNotThrow(() => new vm.Script(getChatClientScript("icon", BASE_STATE)), "sidebar chat script no longer parses");
    const rest = full.split(rail).join("");
    const names = ["railToggle", "railMore", "railMenu", "railTopBar", "railStatusBar", "syncRailInsets", "setRailExpanded", "closeRailMenu", "openRailMenu", "runRailAction", "actionRail", "railObserver", "savedExpanded", "RAIL_EXPANDED_KEY"];
    for (const name of names) assert.equal((rest.match(new RegExp(`\\b${name}\\b`, "g")) || []).length, 0, `${name} is also used elsewhere in the chat script`);
    const html = pageHtml({ actionRail: true });
    const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)).map(m => m[1]);
    for (const name of ["actionRail", "railToggle", "railMore", "railMenu"]) {
      const declaring = scripts.filter(s => new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(s));
      assert.equal(declaring.length, 1, `${name} is declared at the top level of ${declaring.length} script elements`);
    }
    const prompts = scripts.join("\n");
    for (const name of ["railToggle", "railMore", "railMenu"]) assert.equal((prompts.match(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, "g")) || []).length, 1, `${name} declared more than once across the page scripts`);
    for (const body of scripts) assert.doesNotThrow(() => new vm.Script(body));
  });

  it("the sessions flyout trigger selector still contains the original picker", () => {
    const script: string = getChatClientScript("icon", BASE_STATE);
    assert.ok(script.includes("#btn-session-picker"));
  });
});

/* ------------------------------------------------------------------ */
/* 4. Real browser                                                     */
/* ------------------------------------------------------------------ */

const ORIGIN = "http://127.0.0.1:8781";

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

const THEMES: Record<"dark" | "light", { kind: string; vars: Record<string, string> }> = {
  dark: {
    kind: "vscode-dark",
    vars: {
      "--vscode-font-family": "'Segoe WPC', 'Segoe UI', system-ui, sans-serif", "--vscode-font-size": "13px", "--vscode-editor-font-family": "Consolas, monospace",
      "--vscode-foreground": "#CCCCCC", "--vscode-descriptionForeground": "#9D9D9D", "--vscode-errorForeground": "#F85149", "--vscode-focusBorder": "#0078D4",
      "--vscode-widget-border": "#313131", "--vscode-panel-border": "#2B2B2B", "--vscode-sideBar-background": "#181818", "--vscode-editor-background": "#1F1F1F",
      "--vscode-input-background": "#313131", "--vscode-input-border": "#3C3C3C", "--vscode-button-background": "#0078D4", "--vscode-button-foreground": "#FFFFFF",
      "--vscode-list-hoverBackground": "#2A2D2E", "--vscode-editorWidget-background": "#202020",
    },
  },
  light: {
    kind: "vscode-light",
    vars: {
      "--vscode-font-family": "'Segoe WPC', 'Segoe UI', system-ui, sans-serif", "--vscode-font-size": "13px", "--vscode-editor-font-family": "Consolas, monospace",
      "--vscode-foreground": "#3B3B3B", "--vscode-descriptionForeground": "#717171", "--vscode-errorForeground": "#F85149", "--vscode-focusBorder": "#005FB8",
      "--vscode-widget-border": "#E5E5E5", "--vscode-panel-border": "#E5E5E5", "--vscode-sideBar-background": "#F8F8F8", "--vscode-editor-background": "#FFFFFF",
      "--vscode-input-background": "#FFFFFF", "--vscode-input-border": "#CECECE", "--vscode-button-background": "#005FB8", "--vscode-button-foreground": "#FFFFFF",
      "--vscode-list-hoverBackground": "#F2F2F2", "--vscode-editorWidget-background": "#FFFFFF",
    },
  },
};

interface PageOptions {
  theme?: "dark" | "light";
  actionRail?: boolean;
  tab?: boolean;
  preScript?: string;
  mutate?: (html: string) => string;
  stripRailCss?: boolean;
  width?: number;
  height?: number;
  forcedColors?: string;
  reducedMotion?: string;
}

function buildPage(options: PageOptions): string {
  const theme = THEMES[options.theme ?? "dark"];
  let html = pageHtml({ actionRail: options.actionRail ?? true });
  if (options.stripRailCss) html = html.split(railModule.getActionRailStyles()).join("");
  const nonce = /nonce-([0-9A-Za-z+/=]+)/.exec(html)![1];
  const style = `<style>:root{${Object.entries(theme.vars).map(([k, v]) => `${k}:${v}`).join(";")}}</style>`;
  const boot = `<script nonce="${nonce}">${options.preScript ?? ""};document.body.classList.add(${JSON.stringify(theme.kind)});` +
    `${options.tab === false ? "" : 'document.body.classList.add("andromity-session-tab");'}window.__posted=[];` +
    `window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>undefined,setState:()=>{}});` +
    `window.__send=(data)=>window.dispatchEvent(new MessageEvent('message',{data}));` +
    `window.addEventListener('load',()=>{window.__send({type:'auth_state_changed',isAuthenticated:true,plan:'free'});});</script>`;
  html = html.replace(/<head>/, "<head>" + style).replace(/<body([^>]*)>/, (m) => m + boot);
  return options.mutate ? options.mutate(html) : html;
}

const pw = loadPlaywright();
const chromePath = findChromium();
const browserSkip = !pw ? "playwright-core not found (set PLAYWRIGHT_CORE)" : !chromePath ? "no Chromium found (set EFFORT_CHROME)" : false;

async function openPage(browser: any, options: PageOptions = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1000, height: options.height ?? 800 },
    forcedColors: options.forcedColors, reducedMotion: options.reducedMotion,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(String(error.message)));
  const html = buildPage(options);
  const media = path.join(EXT_DIR, "media");
  await page.route(ORIGIN + "/**", (route: any) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/page.html") return route.fulfill({ body: html, contentType: "text/html" });
    const file = path.join(EXT_DIR, decodeURIComponent(url.pathname));
    if (url.pathname.startsWith("/media/") && file.startsWith(media) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".png": "image/png", ".jpg": "image/jpeg" };
      return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || "application/octet-stream" });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(ORIGIN + "/page.html");
  await page.waitForLoadState("load");
  await page.waitForTimeout(450);
  return { context, page, errors };
}

const NOISE = new Set(["ready", "telemetry_feature", "webview_ready", "get_context_breakdown", "turn_finished", "side_panel_refresh", "request_queue_snapshot", "get_file_diff_stats"]);
const posted = (page: any): Promise<string[]> => page.evaluate((noise: string[]) => (window as any).__posted
  .filter((m: any) => !noise.includes(m.type)).map((m: any) => m.type + (m.action !== undefined ? ":" + m.action : "")), [...NOISE]);
const clearPosted = (page: any) => page.evaluate(() => { (window as any).__posted.length = 0; });

async function loadConversation(page: any, name = "Session") {
  await page.evaluate((n: string) => {
    const w = window as any;
    w.__send({ type: "init_state", sessionId: "s1", model: "m", provider: "p", models: [], sessions: [{ id: "s1", name: n }] });
    const messages: any[] = [];
    for (let i = 0; i < 4; i++) {
      messages.push({ role: "user", content: "question " + i + " " + "word ".repeat(60) });
      messages.push({ role: "assistant", content: "answer " + i + " " + "text ".repeat(120) });
    }
    w.__send({ type: "session_loaded", session: { id: "s1", name: n, messages } });
  }, name);
  await page.waitForTimeout(500);
}

const railState = (page: any) => page.evaluate(() => {
  const menu = document.getElementById("rail-menu")!;
  const more = document.getElementById("rail-more")!;
  const toggle = document.getElementById("rail-toggle")!;
  const rail = document.getElementById("action-rail")!;
  const a = document.activeElement as HTMLElement | null;
  return {
    menuHidden: menu.hidden, more: more.getAttribute("aria-expanded"), toggle: toggle.getAttribute("aria-expanded"), open: rail.classList.contains("open"),
    active: a ? (a.id || a.getAttribute("data-rail-action") || a.tagName) : "", activeInMenu: !!a && menu.contains(a), flyout: document.getElementById("sessions-flyout")!.style.display,
    stored: (() => { try { return localStorage.getItem("andromity.actionRail.expanded"); } catch { return "threw"; } })(),
  };
});

const PRIMARY = ["new", "sessions", "review", "prs", "diffs", "settings"];
const MENU = ["setup", "restart", "compact", "undo", "welcome"];
const EXPECTED_POST: Record<string, string[]> = {
  new: ["new_session"], sessions: ["fetch_sessions"], review: ["open_review_tab"], settings: ["open_settings"], undo: ["undo_turn"],
  compact: ["compact_session"], prs: ["run_action:prs"], diffs: ["run_action:diffs"], setup: ["run_action:setup"], restart: ["run_action:restart"], welcome: ["run_action:welcome"],
};

const BLOCKED_WHILE_RUNNING = ["compact", "restart"];

async function startTurn(page: any) {
  await page.evaluate(() => (window as any).__send({ type: "agent_started", session_id: "s1", input_id: "i" + Math.random().toString(36).slice(2), prompt: "go" }));
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate("typeof isRunning !== 'undefined' && isRunning === true"), true, "harness failed to start a turn");
}

async function endTurn(page: any) {
  await page.evaluate(() => (window as any).__send({ type: "agent_done", session_id: "s1", outcome: "success" }));
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate("typeof isRunning !== 'undefined' && isRunning === false"), true, "harness failed to end a turn");
}

async function activate(page: any, action: string, how: "click" | "enter" | "space") {
  const inMenu = MENU.includes(action);
  if (inMenu) {
    await page.click("#rail-more");
  }
  const selector = `${inMenu ? "#rail-menu" : "#action-rail"} [data-rail-action="${action}"]`;
  if (how === "click") await page.click(selector, { timeout: 3000 });
  else {
    await page.focus(selector);
    await page.keyboard.press(how === "enter" ? "Enter" : "Space");
  }
}

describe("Action rail: real browser", { skip: browserSkip }, () => {
  let browser: any;
  before(async () => { browser = await pw.chromium.launch({ executablePath: chromePath, headless: true }); }, { timeout: 90000 });
  after(async () => { if (browser) await browser.close(); }, { timeout: 30000 });

  /* ---------------- behaviour ---------------- */

  for (const how of ["click", "enter", "space"] as const) {
    it(`each action posts exactly its one message per activation by ${how}, and nothing else`, { timeout: 120000 }, async () => {
      const { page, context, errors } = await openPage(browser);
      try {
        for (const state of ["before-load", "loaded"]) {
          if (state === "loaded") await loadConversation(page);
          for (const action of [...PRIMARY, ...MENU]) {
            await clearPosted(page);
            await activate(page, action, how);
            await page.waitForTimeout(60);
            assert.deepEqual(await posted(page), EXPECTED_POST[action], `${how}/${state}/${action}`);
            const s = await railState(page);
            assert.ok(s.menuHidden && s.more === "false", `${how}/${action}: menu still open after activation`);
            if (action === "sessions") {
              assert.equal(s.flyout, "flex", "sessions flyout must be open after the click");
              await page.waitForTimeout(250);
              assert.equal((await railState(page)).flyout, "flex", "sessions flyout closed itself");
              await activate(page, action, how);
              assert.equal((await railState(page)).flyout, "none", "second activation must close the flyout");
            }
          }
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }

  it("toggle, More, outside click, Escape and Tab post nothing; only the toggle writes the preference", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      await clearPosted(page);
      await page.click("#rail-toggle");
      assert.deepEqual((await railState(page)).stored, "1");
      await page.click("#rail-toggle");
      assert.equal((await railState(page)).stored, "0");
      await page.click("#rail-more");
      assert.equal((await railState(page)).stored, "0", "opening More changed the stored preference");
      await page.keyboard.press("Escape");
      await page.click("#rail-more");
      await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      assert.equal((await railState(page)).menuHidden, true);
      await page.click("#rail-more");
      await page.keyboard.press("Tab");
      assert.deepEqual(await posted(page), []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("More menu: focus on first item, arrows wrap, Home/End, Escape returns focus, Tab and outside click close, More toggles", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      await page.click("#rail-more");
      let s = await railState(page);
      assert.deepEqual([s.menuHidden, s.more, s.active], [false, "true", "setup"]);
      await page.keyboard.press("ArrowUp"); assert.equal((await railState(page)).active, "welcome", "ArrowUp must wrap to the last item");
      await page.keyboard.press("ArrowDown"); assert.equal((await railState(page)).active, "setup", "ArrowDown must wrap to the first item");
      await page.keyboard.press("End"); assert.equal((await railState(page)).active, "welcome");
      await page.keyboard.press("Home"); assert.equal((await railState(page)).active, "setup");
      for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowDown");
      assert.equal((await railState(page)).active, MENU[12 % 5]);
      await page.keyboard.press("Escape");
      s = await railState(page);
      assert.deepEqual([s.menuHidden, s.more, s.active], [true, "false", "rail-more"]);
      await page.keyboard.press("ArrowUp");
      s = await railState(page);
      assert.deepEqual([s.menuHidden, s.more, s.active], [false, "true", "welcome"], "ArrowUp on More opens on the last item");
      await page.keyboard.press("Tab");
      s = await railState(page);
      assert.deepEqual([s.menuHidden, s.more], [true, "false"]);
      assert.notEqual(s.active, "BODY", "Tab out of the menu dropped focus to the document");
      await page.click("#rail-more");
      await page.click("#rail-more");
      s = await railState(page);
      assert.deepEqual([s.menuHidden, s.more], [true, "false"], "clicking More again must close");
      await page.click("#rail-more");
      await page.mouse.click(700, 300);
      s = await railState(page);
      assert.deepEqual([s.menuHidden, s.more], [true, "false"], "outside click must close");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("Escape inside the menu stays inside it: no document or window keydown handler sees it, other popovers survive", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.__esc = { doc: 0, win: 0, capture: 0 };
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") w.__esc.doc++; });
        window.addEventListener("keydown", (e) => { if (e.key === "Escape") w.__esc.win++; });
      });
      await page.focus("#rail-more");
      await page.keyboard.press("Enter");
      await page.evaluate(() => { (document.getElementById("reasoning-popover") as HTMLElement).style.display = "block"; });
      await page.keyboard.press("Escape");
      const after = await page.evaluate(() => ({ esc: (window as any).__esc, pop: (document.getElementById("reasoning-popover") as HTMLElement).style.display }));
      assert.deepEqual(after.esc, { doc: 0, win: 0, capture: 0 }, "the global Escape handlers ran");
      assert.equal(after.pop, "block", "Escape in the menu closed an unrelated popover");
      assert.equal((await railState(page)).active, "rail-more");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("focus is not dropped on the document after a menu item is picked", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser);
    try {
      for (const how of ["click", "enter"] as const) {
        await clearPosted(page);
        await activate(page, "restart", how);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const s = await railState(page);
        assert.ok(s.menuHidden);
        assert.ok(!s.activeInMenu && s.active !== "BODY", `after picking a menu item by ${how}, focus is on ${s.active}: a keyboard user loses their place (it should return to More or the rail)`);
      }
    } finally { await context.close(); }
  });

  it("aria-expanded and the menu stay in sync through a seeded random walk of clicks and keys", { timeout: 240000 }, async () => {
    for (const seed of (process.env.RAIL_FUZZ_SEEDS ? process.env.RAIL_FUZZ_SEEDS.split(",").map(Number) : [1, 2, 3])) {
      const { page, context, errors } = await openPage(browser, { theme: seed === 2 ? "light" : "dark", width: seed === 3 ? 820 : 1000 });
      try {
        let a = seed * 7919;
        const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)];
        const steps = ["toggle", "more", "outside", "Escape", "ArrowDown", "ArrowUp", "Home", "End", "Tab", "Enter", "Space", "new", "sessions", "review", "prs", "diffs", "settings", "menu-item", "blocked-item", "focus-prompt", "turn", "resize"];
        const trace: string[] = [];
        await loadConversation(page);
        await clearPosted(page);
        let seen = 0;
        for (let i = 0; i < 110; i++) {
          const step = pick(steps);
          trace.push(step);
          const runningBefore = (await page.evaluate("isRunning === true")) as boolean;
          const press = (selector: string) => page.evaluate((sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; if (el && el.getClientRects().length > 0 && document.getElementById("action-rail")!.getClientRects().length > 0) { el.focus(); el.click(); } }, selector);
          if (step === "toggle") await press("#rail-toggle");
          else if (step === "more") await press("#rail-more");
          else if (step === "outside") await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })));
          else if (step === "resize") await page.setViewportSize({ width: pick([480, 520, 760, 820, 1000, 1200, 1500, 2000]), height: pick([500, 800]) });
          else if (step === "focus-prompt") await page.focus("#prompt-input");
          else if (step === "turn") await page.evaluate((run: boolean) => (window as any).__send(run ? { type: "agent_done", session_id: "s1", outcome: "success" } : { type: "agent_started", session_id: "s1", input_id: "i" + Math.random().toString(36).slice(2), prompt: "go" }), runningBefore);
          else if (step === "blocked-item") await press(`#rail-menu [data-rail-action="${pick(BLOCKED_WHILE_RUNNING)}"]`);
          else if (step === "menu-item") {
            if (await page.evaluate(() => !(document.getElementById("rail-menu") as HTMLElement).hidden)) await press(`#rail-menu [data-rail-action="${pick(MENU)}"]`);
          } else if (PRIMARY.includes(step)) await press(`#action-rail [data-rail-action="${step}"]`);
          else if (await page.evaluate(() => document.getElementById("action-rail")!.getClientRects().length === 0)) { /* rail not rendered below 481px: nothing to press */ }
          else {
            const inside = await page.evaluate(() => { const a = document.activeElement; return !!a && (!!a.closest("#action-rail") || !!a.closest("#rail-menu")); });
            if (!inside) await page.focus("#rail-more");
            await page.keyboard.press(step === "Space" ? "Space" : step);
          }
          await page.waitForTimeout(12);
          const s = await railState(page);
          const where = `seed ${seed} step ${i} (${trace.slice(-6).join(" > ")})`;
          if (process.env.RAIL_FUZZ_TRACE) console.log(`#${i} ${step} running=${runningBefore} menuHidden=${s.menuHidden} focus=${s.active} w=${await page.evaluate(() => innerWidth)}`);
          const all = await posted(page);
          const fresh = all.slice(seen);
          seen = all.length;
          if (runningBefore) assert.deepEqual(fresh.filter(t => t === "compact_session" || t === "run_action:restart"), [], `${where}: a blocked action posted while a turn was running`);
          assert.equal(s.menuHidden, s.more !== "true", `${where}: menu.hidden=${s.menuHidden} but aria-expanded=${s.more}`);
          assert.equal(s.toggle === "true", s.open, `${where}: toggle aria-expanded=${s.toggle} but class open=${s.open}`);
          if (!s.menuHidden) assert.ok(s.activeInMenu || s.active === "rail-more", `${where}: menu open but focus on ${s.active}`);
          assert.ok(["0", "1", null].includes(s.stored), `${where}: stored ${s.stored}`);
        }
        const types = (await posted(page));
        const allowed = new Set([...Object.values(EXPECTED_POST).flat()]);
        for (const t of types) assert.ok(allowed.has(t), `unexpected message ${t} (trace ${trace.join(">")})`);
        assert.deepEqual(errors, [], `page errors in walk ${seed}`);
      } finally { await context.close(); }
    }
  });

  it("Sessions opens the flyout and it stays open across a settle; clicking the picker still works as before", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser);
    try {
      await loadConversation(page);
      await clearPosted(page);
      await page.click('#action-rail [data-rail-action="sessions"]');
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(120);
        assert.equal((await railState(page)).flyout, "flex", `flyout closed after ${(i + 1) * 120}ms`);
      }
      assert.deepEqual(await posted(page), ["fetch_sessions"]);
      await page.click("#btn-session-picker");
      assert.equal((await railState(page)).flyout, "none", "picker click must toggle it closed");
      await page.click("#btn-session-picker");
      assert.equal((await railState(page)).flyout, "flex");
      await page.mouse.click(900, 600);
      assert.equal((await railState(page)).flyout, "none", "outside click must still close the flyout");
    } finally { await context.close(); }
  });

  it("rapid double clicks, activation while a turn is running and before the session loads never throw", { timeout: 120000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      for (const action of PRIMARY) await page.dblclick(`#action-rail [data-rail-action="${action}"]`);
      for (const action of MENU) { await page.click("#rail-more"); await page.dblclick(`#rail-menu [data-rail-action="${action}"]`, { timeout: 2000 }).catch(() => {}); }
      await page.click("#rail-more"); await page.click("#rail-more"); await page.dblclick("#rail-more"); await page.dblclick("#rail-toggle");
      await loadConversation(page, "S");
      await startTurn(page);
      await clearPosted(page);
      for (const action of [...PRIMARY, ...MENU]) {
        if (BLOCKED_WHILE_RUNNING.includes(action)) {
          await page.click("#rail-more");
          assert.equal(await page.evaluate((a: string) => (document.querySelector(`#rail-menu [data-rail-action="${a}"]`) as HTMLButtonElement).disabled, action), true, `${action} must be disabled while a turn runs`);
          await page.keyboard.press("Escape");
        } else await activate(page, action, "click");
      }
      assert.deepEqual(await posted(page), [...PRIMARY, ...MENU].filter(a => !BLOCKED_WHILE_RUNNING.includes(a)).flatMap(a => EXPECTED_POST[a]));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  const itemState = (page: any) => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("#rail-menu .rail-menu-item")).map(el => [el.getAttribute("data-rail-action"), { disabled: (el as HTMLButtonElement).disabled, title: (el as HTMLElement).title }])));
  const focusedAction = (page: any): Promise<string | null> => page.evaluate(() => (document.activeElement as HTMLElement).getAttribute("data-rail-action"));

  it("while a turn runs, Compact and Restart are disabled with an explanation and cannot be activated by mouse, forced click, synthetic click or keyboard", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      await loadConversation(page);
      await startTurn(page);
      await page.click("#rail-more");
      const items = await itemState(page);
      for (const action of BLOCKED_WHILE_RUNNING) {
        assert.equal(items[action].disabled, true, `${action} not disabled`);
        assert.ok(/turn is running/i.test(items[action].title), `${action} has no explanation: ${JSON.stringify(items[action].title)}`);
      }
      for (const action of MENU.filter(a => !BLOCKED_WHILE_RUNNING.includes(a))) assert.equal(items[action].disabled, false, `${action} must stay enabled`);
      await clearPosted(page);
      for (const action of BLOCKED_WHILE_RUNNING) {
        const sel = `#rail-menu [data-rail-action="${action}"]`;
        await page.click(sel, { force: true, timeout: 2000 }).catch(() => {});
        await page.dispatchEvent(sel, "click").catch(() => {});
        await page.evaluate((s: string) => {
          const el = document.querySelector(s) as HTMLElement;
          el.click();
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          el.focus();
        }, sel);
        assert.notEqual(await focusedAction(page), action, `${action} took focus although disabled`);
        await page.dblclick(sel, { force: true, timeout: 2000 }).catch(() => {});
      }
      assert.deepEqual((await posted(page)).filter(t => t === "compact_session" || t === "run_action:restart"), [], "a disabled item posted");
      if (await page.evaluate(() => (document.getElementById("rail-menu") as HTMLElement).hidden)) await page.click("#rail-more");
      await page.focus('#rail-menu [data-rail-action="setup"]');
      for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp", "End", "Home", "ArrowUp"]) {
        await page.keyboard.press(key);
        const at = await focusedAction(page);
        assert.ok(at && !BLOCKED_WHILE_RUNNING.includes(at), `${key} moved focus to ${at}`);
      }
      await page.keyboard.press("End");
      assert.equal(await focusedAction(page), "welcome");
      await page.keyboard.press("Home");
      assert.equal(await focusedAction(page), "setup");
      await page.keyboard.press("ArrowDown");
      assert.equal(await focusedAction(page), "undo", "arrow must skip the disabled items");
      assert.deepEqual((await posted(page)).filter(t => t === "compact_session" || t === "run_action:restart"), []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("Enter and Space on a script-focused disabled item activate nothing", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser);
    try {
      await loadConversation(page);
      await startTurn(page);
      for (const key of ["Enter", "Space"]) {
        await page.click("#rail-more");
        await clearPosted(page);
        await page.evaluate(() => (document.querySelector('#rail-menu [data-rail-action="compact"]') as HTMLElement).focus());
        const at = await focusedAction(page);
        await page.keyboard.press(key);
        const types = await posted(page);
        assert.ok(!types.includes("compact_session"), `${key} on disabled Compact posted compact_session`);
        assert.ok(!types.includes("run_action:restart"));
        if (at === "setup") assert.deepEqual(types, ["run_action:setup"], "focus stayed on the first item, so only it may fire");
        await page.keyboard.press("Escape");
      }
    } finally { await context.close(); }
  });

  it("items re-enable on the next open once the turn has ended, and the explanation goes away", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      await loadConversation(page);
      await startTurn(page);
      await page.click("#rail-more");
      assert.equal((await itemState(page)).compact.disabled, true);
      await endTurn(page);
      await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      assert.equal((await railState(page)).menuHidden, true);
      await page.click("#rail-more");
      const items = await itemState(page);
      for (const action of BLOCKED_WHILE_RUNNING) {
        assert.equal(items[action].disabled, false, `${action} still disabled after the turn ended`);
        assert.equal(items[action].title, "", `${action} still carries the running explanation`);
      }
      await page.keyboard.press("Escape");
      await clearPosted(page);
      await activate(page, "compact", "click");
      assert.deepEqual(await posted(page), ["compact_session"]);
      for (let i = 0; i < 3; i++) { await startTurn(page); await page.click("#rail-more"); assert.equal((await itemState(page)).restart.disabled, true); await endTurn(page); await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }))); }
      await page.click("#rail-more");
      assert.equal((await itemState(page)).restart.disabled, false);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("a turn that ends while the menu is open does not strand it: Escape still closes it", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser);
    try {
      await loadConversation(page);
      await startTurn(page);
      await page.click("#rail-more");
      await endTurn(page);
      const afterEnd = await railState(page);
      await page.keyboard.press("Escape");
      const s = await railState(page);
      assert.equal(s.menuHidden, true, `after the turn ended with the menu open, focus was on ${afterEnd.active} and Escape left the menu open (menu hidden=${s.menuHidden}, focus ${s.active})`);
    } finally { await context.close(); }
  });

  it("focus returns to the More button after picking an item by mouse, Enter or Space, and Tab from More goes on to the chat", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser);
    try {
      for (const how of ["click", "enter", "space"] as const) {
        for (const action of ["setup", "undo", "welcome"]) {
          await clearPosted(page);
          await activate(page, action, how);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const s = await railState(page);
          assert.equal(s.active, "rail-more", `after ${how} on ${action} focus is on ${s.active}`);
          assert.ok(s.menuHidden && s.more === "false");
          assert.deepEqual(await posted(page), EXPECTED_POST[action]);
        }
      }
      await page.keyboard.press("Enter");
      assert.equal((await railState(page)).menuHidden, false, "Enter on the returned-to More must reopen the menu");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      assert.notEqual((await railState(page)).active, "rail-more");
    } finally { await context.close(); }
  });

  /* ---------------- robustness ---------------- */

  const KEY = "andromity.actionRail.expanded";
  const robustness: Array<[string, Partial<PageOptions>, string]> = [
    ["getItem throws for the rail key", { preScript: `const g=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='${KEY}')throw new DOMException('x','SecurityError');return g.apply(this,arguments)}` }, "works"],
    ["setItem throws for the rail key", { preScript: `const s=Storage.prototype.setItem;Storage.prototype.setItem=function(k){if(k==='${KEY}')throw new DOMException('x','QuotaExceededError');return s.apply(this,arguments)}` }, "works"],
    ["stored value is an object that throws on conversion", { preScript: `const g=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='${KEY}')return {toString(){throw 1}};return g.apply(this,arguments)}` }, "works"],
    ["stored value is garbage", { preScript: `localStorage.setItem('${KEY}','maybe')` }, "works"],
    ["ResizeObserver undefined", { preScript: "window.ResizeObserver=undefined" }, "works"],
    ["top bar missing", { mutate: (h) => h.replace('<div class="top-bar">', '<div class="x-top-bar">') }, "works"],
    ["status bar missing", { mutate: (h) => h.replace(/<div class="status-bar"/, '<div class="x-status-bar"') }, "works"],
    ["both bars missing", { mutate: (h) => h.replace('<div class="top-bar">', '<div class="x-top-bar">').replace(/<div class="status-bar"/, '<div class="x-status-bar"') }, "works"],
    ["nav missing", { mutate: (h) => h.replace(/<nav class="action-rail"[\s\S]*?<\/nav>/, "") }, "absent"],
  ];
  for (const [name, extra, expectation] of robustness) {
    it(`robust: ${name}`, { timeout: 60000 }, async () => {
      const baseline = await openPage(browser, { ...extra, actionRail: false });
      const withRail = await openPage(browser, extra);
      try {
        const extraErrors = withRail.errors.filter(e => !baseline.errors.includes(e));
        assert.deepEqual(extraErrors, [], `errors only with the rail: ${extraErrors.join(" | ")}`);
        for (const p of [baseline.page, withRail.page]) {
          await p.evaluate(() => (window as any).__send({ type: "init_state", sessionId: "s1", model: "m", provider: "p", models: [], sessions: [{ id: "s1", name: "AfterInit" }] }));
        }
        await withRail.page.waitForTimeout(150);
        const name1 = await baseline.page.evaluate(() => document.getElementById("active-session-name")!.textContent);
        const name2 = await withRail.page.evaluate(() => document.getElementById("active-session-name")!.textContent);
        assert.equal(name2, name1, "rail changed how much of the chat script ran");
        if (expectation === "works") {
          await withRail.page.click("#rail-toggle");
          assert.equal((await railState(withRail.page)).toggle, "true");
          await withRail.page.click("#rail-more");
          assert.equal((await railState(withRail.page)).menuHidden, false);
          await withRail.page.keyboard.press("Escape");
        }
        assert.deepEqual(withRail.errors.filter(e => !baseline.errors.includes(e)), []);
      } finally { await baseline.context.close(); await withRail.context.close(); }
    });
  }

  it("hardening: a missing child of the rail (menu, More or toggle) must not stop the rest of the chat script", { timeout: 60000 }, async () => {
    const variants: Array<[string, (h: string) => string]> = [
      ["menu", (h) => h.replace(/<div class="rail-menu"[\s\S]*?<\/div>/, "")],
      ["more", (h) => h.replace(/<button[^>]*id="rail-more"[\s\S]*?<\/button>/, "")],
      ["toggle", (h) => h.replace(/<button[^>]*id="rail-toggle"[\s\S]*?<\/button>/, "")],
    ];
    const failures: string[] = [];
    for (const [name, mutate] of variants) {
      const { page, context, errors } = await openPage(browser, { mutate });
      try {
        await page.evaluate(() => (window as any).__send({ type: "init_state", sessionId: "s1", model: "m", provider: "p", models: [], sessions: [{ id: "s1", name: "AfterInit" }] }));
        await page.waitForTimeout(150);
        const name1 = await page.evaluate(() => document.getElementById("active-session-name")!.textContent);
        if (errors.length || name1 !== "AfterInit") failures.push(`${name}: errors=${JSON.stringify(errors)} name=${JSON.stringify(name1)}`);
      } finally { await context.close(); }
    }
    assert.deepEqual(failures, [], "a missing rail child threw during init and stopped every later part of the chat script");
  });

  /* ---------------- layout ---------------- */

  const measure = (page: any) => page.evaluate(() => {
    const R = (selector: string) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom };
    };
    const rects: { sel: string; l: number; r: number }[] = [];
    for (const sel of [".prompt-box", ".message-wrap", ".message"]) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) rects.push({ sel, l: b.left, r: b.right });
      }
    }
    const sp = document.querySelector(".side-panel") as HTMLElement;
    const sb = getComputedStyle(sp).display === "none" ? null : sp.getBoundingClientRect();
    const rail = document.getElementById("action-rail") as HTMLElement;
    const labels = Array.from(rail.querySelectorAll(".rail-label")).map(l => getComputedStyle(l).display);
    return {
      rail: R("#action-rail"), top: R(".top-bar"), status: R(".status-bar"), chat: R(".chat-container"), prompt: R(".prompt-box"),
      side: sb ? { l: sb.left, t: sb.top, r: sb.right, b: sb.bottom } : null,
      contentL: rects.length ? Math.min(...rects.map((r: { l: number }) => r.l)) : null, contentR: rects.length ? Math.max(...rects.map(r => r.r)) : null,
      railDisplay: getComputedStyle(rail).display, bodyPadLeft: getComputedStyle(document.body).paddingLeft, bodyPadRight: getComputedStyle(document.body).paddingRight, topMarginLeft: getComputedStyle(document.querySelector(".top-bar")!).marginLeft,
      scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth, scrollX: window.scrollX, vw: window.innerWidth, labels,
      toggleDisplay: getComputedStyle(document.getElementById("rail-toggle")!).display,
    };
  });
  type Metrics = Awaited<ReturnType<typeof measure>>;
  const WIDTHS = [481, 520, 600, 759, 760, 800, 899, 900, 1000, 1099, 1100, 1200, 1499, 1500, 1550, 1600, 1650, 1700, 1750, 2000];
  const railMode = (expanded: boolean, w: number) => !expanded || w < 760 ? "collapsed" : w < 900 ? "overlay-narrow" : "push";

  for (const theme of ["dark", "light"] as const) {
    it(`layout (${theme}): bars full width, rail exactly between them, no overlap with chat, no horizontal scroll, 481px to 2000px`, { timeout: 240000 }, async () => {
      const { page, context, errors } = await openPage(browser, { theme, reducedMotion: "reduce", width: 1200 });
      const failures: string[] = [];
      const collapsedRef = new Map<string, Metrics>();
      try {
        await loadConversation(page, "A session");
        for (const expanded of [false, true]) {
          for (const panelOff of [false, true]) {
            for (const w of WIDTHS) {
              await page.setViewportSize({ width: w, height: 800 });
              await page.evaluate(([ex, off]: [boolean, boolean]) => {
                const toggle = document.getElementById("rail-toggle")!;
                if ((toggle.getAttribute("aria-expanded") === "true") !== ex) toggle.click();
                document.body.classList.toggle("side-panel-off", off);
              }, [expanded, panelOff]);
              await page.waitForTimeout(90);
              const m: Metrics = await measure(page);
              const tag = `${theme} expanded=${expanded} panelOff=${panelOff} w=${w}`;
              const issues: string[] = [];
              if (Math.abs(m.top!.l) > 0.6 || Math.abs(m.top!.r - w) > 0.6) issues.push(`top bar ${m.top!.l}..${m.top!.r}`);
              if (Math.abs(m.status!.l) > 0.6 || Math.abs(m.status!.r - w) > 0.6) issues.push(`status bar ${m.status!.l}..${m.status!.r}`);
              if (Math.abs(m.rail!.t - m.top!.b) > 0.6) issues.push(`rail top ${m.rail!.t} != top bar bottom ${m.top!.b}`);
              if (Math.abs(m.rail!.b - m.status!.t) > 0.6) issues.push(`rail bottom ${m.rail!.b} != status top ${m.status!.t}`);
              const mode = railMode(expanded, w);
              const railRight = expanded && w >= 760 ? 224 : 46;
              const containerLeft = mode === "push" ? 224 : 46;
              if (Math.abs(m.rail!.r - railRight) > 0.6) issues.push(`rail right ${m.rail!.r}, expected ${railRight} (${mode})`);
              if (Math.abs(m.chat!.l - containerLeft) > 0.6) issues.push(`chat container starts at ${m.chat!.l}, expected ${containerLeft} (${mode})`);
              if (mode !== "overlay-narrow") {
                if (m.contentL! < railRight - 0.6) issues.push(`chat content starts at ${m.contentL} under the rail (${railRight}, ${mode})`);
                if (m.prompt!.l < railRight - 0.6) issues.push(`prompt box starts at ${m.prompt!.l} under the rail (${railRight}, ${mode})`);
              }
              if (m.side && m.contentR! > m.side.l + 0.6) issues.push(`chat content ends ${m.contentR!.toFixed(0)} inside the session panel starting ${m.side.l.toFixed(0)}`);
              if (m.scrollW > w || m.bodyScrollW > w || m.scrollX !== 0) issues.push(`horizontal scroll ${m.scrollW}/${m.bodyScrollW}`);
              if (!expanded) collapsedRef.set(`${panelOff}|${w}`, m);
              else if (w >= 1500) {
                const c = collapsedRef.get(`${panelOff}|${w}`)!;
                const moved = [["content left", m.contentL! - c.contentL!], ["content right", m.contentR! - c.contentR!], ["prompt left", m.prompt!.l - c.prompt!.l], ["prompt right", m.prompt!.r - c.prompt!.r]].filter(([, d]) => Math.abs(d as number) > 1);
                if (moved.length) issues.push(`expanded column moved against its collapsed position: ${moved.map(([n, d]) => `${n} ${(d as number).toFixed(1)}px`).join(", ")}`);
                if (Math.abs(parseFloat(m.bodyPadRight) - 178) > 0.6) issues.push(`body padding-right ${m.bodyPadRight}, expected 178px at >=1500 expanded`);
              }
              if (w < 760 && m.labels.some((d: string) => d !== "none")) issues.push("labels visible below 760px");
              if (w < 760 && m.toggleDisplay !== "none") issues.push("toggle visible below 760px");
              if (issues.length) failures.push(`${tag}: ${issues.join("; ")}`);
            }
          }
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
      assert.deepEqual(failures, [], failures.slice(0, 12).join("\n"));
    });
  }

  it("below 481px there is no rail, no left padding and no horizontal scroll; at 481px both rail and chat are usable", { timeout: 120000 }, async () => {
    for (const theme of ["dark", "light"] as const) {
      const { page, context } = await openPage(browser, { theme, reducedMotion: "reduce", width: 481 });
      const base = await openPage(browser, { theme, actionRail: false, reducedMotion: "reduce", width: 481 });
      try {
        await loadConversation(page);
        for (const w of [320, 400, 480, 481, 482]) {
          await page.setViewportSize({ width: w, height: 700 });
          await base.page.setViewportSize({ width: w, height: 700 });
          await page.waitForTimeout(80);
          const m: Metrics = await measure(page);
          const baseScroll: number = await base.page.evaluate(() => document.documentElement.scrollWidth);
          if (w < 481) {
            assert.equal(m.railDisplay, "none", `${w}: rail visible`);
            assert.equal(m.bodyPadLeft, "0px", `${w}: body still padded`);
            assert.equal(m.topMarginLeft, "0px", `${w}: top bar still shifted`);
            assert.ok(Math.abs(m.top!.l) < 0.6 && Math.abs(m.top!.r - w) < 0.6, `${w}: top bar ${m.top!.l}..${m.top!.r}`);
            assert.ok(m.prompt!.l < 40, `${w}: prompt box indented ${m.prompt!.l}`);
          } else {
            assert.equal(m.railDisplay, "flex", `${w}: rail missing`);
            assert.ok(m.prompt!.r - m.prompt!.l >= 340, `${w}: prompt box only ${m.prompt!.r - m.prompt!.l}px wide`);
            assert.ok(m.contentL! >= 46 && m.contentR! <= w, `${w}: content ${m.contentL}..${m.contentR}`);
          }
          assert.ok(m.scrollW <= Math.max(w, baseScroll), `${w}: horizontal scroll ${m.scrollW}, the sidebar page without the rail scrolls ${baseScroll}`);
        }
        await page.setViewportSize({ width: 481, height: 700 });
        await page.waitForTimeout(80);
        await clearPosted(page);
        await page.click('#action-rail [data-rail-action="new"]');
        assert.deepEqual(await posted(page), ["new_session"]);
        await page.click("#prompt-input");
        assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).id), "prompt-input");
      } finally { await context.close(); await base.context.close(); }
    }
  });

  it("overlay and push breakpoints at 759/760, 899/900 and 1499/1500, collapsed and expanded, with and without motion", { timeout: 240000 }, async () => {
    const failures: string[] = [];
    for (const reduced of [true, false]) {
      const { page, context, errors } = await openPage(browser, { reducedMotion: reduced ? "reduce" : "no-preference", width: 1200 });
      try {
        await loadConversation(page);
        const collapsedRef = new Map<number, Metrics>();
        for (const expanded of [false, true]) {
          for (const w of [759, 760, 899, 900, 1499, 1500, 1499, 900, 899, 760, 759, 1500, 2000]) {
            await page.setViewportSize({ width: w, height: 800 });
            await page.evaluate((ex: boolean) => {
              const toggle = document.getElementById("rail-toggle")!;
              if (getComputedStyle(toggle).display !== "none" && (toggle.getAttribute("aria-expanded") === "true") !== ex) toggle.click();
            }, expanded);
            await page.waitForTimeout(reduced ? 70 : 320);
            const m: Metrics = await measure(page);
            const mode = railMode(expanded, w);
            const tag = `${reduced ? "reduced" : "motion"} expanded=${expanded} w=${w} (${mode})`;
            const wantRail = expanded && w >= 760 ? 224 : 46;
            const wantPad = mode === "push" ? 224 : 46;
            const pad = parseFloat(m.bodyPadLeft);
            if (Math.abs(m.rail!.r - wantRail) > 0.6) failures.push(`${tag}: rail right ${m.rail!.r}, expected ${wantRail}`);
            if (Math.abs(pad - wantPad) > 0.6) failures.push(`${tag}: body padding ${pad}, expected ${wantPad}`);
            if (Math.abs(m.chat!.l - wantPad) > 0.6) failures.push(`${tag}: chat container at ${m.chat!.l}, expected ${wantPad}`);
            if (Math.abs(m.top!.l) > 0.6 || Math.abs(m.top!.r - w) > 0.6 || Math.abs(m.status!.l) > 0.6 || Math.abs(m.status!.r - w) > 0.6) failures.push(`${tag}: bars not full width (${m.top!.l}..${m.top!.r}, ${m.status!.l}..${m.status!.r})`);
            if (w >= 1500) {
              const wantRight = expanded ? 178 : 0;
              if (Math.abs(parseFloat(m.bodyPadRight) - wantRight) > 0.6) failures.push(`${tag}: body padding-right ${m.bodyPadRight}, expected ${wantRight}px`);
              if (!expanded) collapsedRef.set(w, m);
              else {
                const c = collapsedRef.get(w)!;
                const moved = [["content left", m.contentL! - c.contentL!], ["content right", m.contentR! - c.contentR!], ["prompt left", m.prompt!.l - c.prompt!.l], ["prompt right", m.prompt!.r - c.prompt!.r]].filter(([, d]) => Math.abs(d as number) > 1);
                if (moved.length) failures.push(`${tag}: the chat column moved against its collapsed position: ${moved.map(([n, d]) => `${n} ${(d as number).toFixed(1)}px`).join(", ")}`);
              }
            }
            const hit = await page.evaluate(() => {
              const rail = document.getElementById("action-rail")!.getBoundingClientRect();
              const box = document.querySelector(".prompt-box")!.getBoundingClientRect();
              const at = (x: number, y: number) => document.elementFromPoint(x, y);
              const underRail = at(rail.right - 3, rail.top + 200);
              const underPrompt = at(box.left + box.width / 2, box.top + box.height / 2);
              return { railOwnsItsEdge: !!underRail && !!underRail.closest("#action-rail"), promptReachable: !!underPrompt && !!underPrompt.closest(".prompt-box") };
            });
            if (!hit.railOwnsItsEdge) failures.push(`${tag}: something else sits on the rail's right edge`);
            if (!hit.promptReachable) failures.push(`${tag}: the prompt box centre is covered`);
            if (m.scrollW > w) failures.push(`${tag}: horizontal scroll ${m.scrollW}`);
          }
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
    assert.deepEqual(failures, [], failures.slice(0, 12).join("\n"));
  });

  const menuProbe = (page: any) => page.evaluate(() => {
    const menu = document.getElementById("rail-menu") as HTMLElement;
    const rail = document.getElementById("action-rail")!;
    const more = document.getElementById("rail-more")!;
    const a = document.activeElement as HTMLElement | null;
    return {
      hidden: menu.hidden, expanded: more.getAttribute("aria-expanded"), menuL: menu.getBoundingClientRect().left, menuBottom: menu.getBoundingClientRect().bottom,
      menuShown: getComputedStyle(menu).display !== "none", railR: rail.getBoundingClientRect().right, railShown: getComputedStyle(rail).display !== "none",
      active: a ? (a.id || a.getAttribute("data-rail-action") || a.tagName) : "", moreBottom: more.getBoundingClientRect().bottom, vh: innerHeight,
    };
  });

  for (const reduced of [true, false]) {
    for (const expanded of [false, true]) {
      it(`an open More menu follows a resize 900 > 700 > 480 > 900 and closes when the rail is gone (${reduced ? "reduced motion" : "motion"}, ${expanded ? "expanded" : "collapsed"})`, { timeout: 120000 }, async () => {
        const { page, context, errors } = await openPage(browser, { reducedMotion: reduced ? "reduce" : "no-preference", width: 900, height: 800 });
        const settle = () => page.waitForTimeout(reduced ? 90 : 420);
        try {
          if (expanded) { await page.click("#rail-toggle"); await settle(); }
          await page.click("#rail-more");
          let r = await menuProbe(page);
          assert.equal(r.hidden, false);
          assert.ok(Math.abs(r.menuL - (r.railR + 6)) <= 1, `open at 900: menu ${r.menuL}, rail ${r.railR}`);
          for (const [w, h] of [[700, 800], [759, 800], [1000, 500], [1600, 800], [700, 800]] as Array<[number, number]>) {
            await page.setViewportSize({ width: w, height: h });
            await settle();
            r = await menuProbe(page);
            assert.equal(r.hidden, false, `${w}x${h}: menu closed although the rail is still shown`);
            assert.equal(r.expanded, "true");
            assert.ok(Math.abs(r.menuL - (r.railR + 6)) <= 1, `${w}x${h}: menu at ${r.menuL}, rail ends at ${r.railR}`);
            assert.ok(r.menuBottom <= r.vh + 0.5 && r.menuBottom <= r.moreBottom + 1, `${w}x${h}: menu bottom ${r.menuBottom}, More bottom ${r.moreBottom}, viewport ${r.vh}`);
          }
          await page.setViewportSize({ width: 480, height: 800 });
          await settle();
          r = await menuProbe(page);
          assert.deepEqual([r.hidden, r.expanded, r.railShown], [true, "false", false], "menu must close when the rail is not rendered");
          await page.setViewportSize({ width: 900, height: 800 });
          await settle();
          r = await menuProbe(page);
          assert.deepEqual([r.hidden, r.expanded], [true, "false"], "the menu reopened itself after the rail came back");
          await page.click("#rail-more");
          r = await menuProbe(page);
          assert.equal(r.hidden, false);
          assert.ok(Math.abs(r.menuL - (r.railR + 6)) <= 1, `reopened: menu ${r.menuL}, rail ${r.railR}`);
          assert.equal(r.active, "setup");
          await page.setViewportSize({ width: 480, height: 800 });
          await settle();
          await page.setViewportSize({ width: 481, height: 800 });
          await settle();
          r = await menuProbe(page);
          assert.deepEqual([r.hidden, r.expanded], [true, "false"]);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }
  }

  it("with the menu open, clicking the toggle closes it once, flips the rail once and posts nothing; the next open is positioned for the new width", { timeout: 60000 }, async () => {
    for (const reduced of [true, false]) {
      const { page, context, errors } = await openPage(browser, { reducedMotion: reduced ? "reduce" : "no-preference", width: 1000, height: 800 });
      try {
        await clearPosted(page);
        for (const wantExpanded of ["true", "false", "true"]) {
          await page.click("#rail-more");
          assert.equal((await menuProbe(page)).hidden, false);
          await page.click("#rail-toggle");
          await page.waitForTimeout(reduced ? 80 : 400);
          const s = await railState(page);
          const r = await menuProbe(page);
          assert.deepEqual([r.hidden, r.expanded, s.toggle], [true, "false", wantExpanded], `${reduced ? "reduced" : "motion"}: toggle with the menu open`);
          await page.click("#rail-more");
          const r2 = await menuProbe(page);
          assert.ok(Math.abs(r2.menuL - (r2.railR + 6)) <= 1, `menu at ${r2.menuL}, rail ends at ${r2.railR}`);
          await page.keyboard.press("Escape");
        }
        assert.deepEqual(await posted(page), []);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  });

  it("moving focus away while the menu is open closes it: prompt, blur, other controls, and Escape afterwards does nothing odd", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser, { width: 1000, height: 800 });
    try {
      await loadConversation(page);
      const open = async () => { if ((await menuProbe(page)).hidden) await page.click("#rail-more"); assert.equal((await menuProbe(page)).hidden, false); };
      await open();
      await page.focus("#prompt-input");
      let r = await menuProbe(page);
      assert.deepEqual([r.hidden, r.expanded, r.active], [true, "false", "prompt-input"], "focus moved to the prompt but the menu stayed open");
      await clearPosted(page);
      await page.keyboard.press("Escape");
      r = await menuProbe(page);
      assert.deepEqual([r.hidden, r.expanded], [true, "false"], "Escape in the prompt reopened or desynced the menu");
      await page.keyboard.type("hello");
      assert.equal(await page.evaluate(() => (document.getElementById("prompt-input") as HTMLTextAreaElement).value), "hello", "typing in the prompt was swallowed");
      assert.deepEqual(await posted(page), []);
      await open();
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      r = await menuProbe(page);
      assert.deepEqual([r.hidden, r.expanded], [true, "false"], "blur left the menu open");
      await open();
      await page.focus("#btn-top-waterfall");
      assert.equal((await menuProbe(page)).hidden, true, "focus on a top-bar control left the menu open");
      await open();
      await page.focus("#rail-toggle");
      assert.equal((await menuProbe(page)).hidden, true, "focus on another rail button left the menu open");
      await open();
      await page.focus("#rail-more");
      r = await menuProbe(page);
      assert.deepEqual([r.hidden, r.expanded], [false, "true"], "focusing More itself must not close the menu");
      await page.keyboard.press("Escape");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("a turn ending while the menu is open closes it cleanly and Escape from the prompt afterwards leaves it closed", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      await loadConversation(page);
      await startTurn(page);
      await page.click("#rail-more");
      await endTurn(page);
      let r = await menuProbe(page);
      assert.deepEqual([r.hidden, r.expanded], [true, "false"], `the menu is still open after the turn ended (focus on ${r.active})`);
      await page.keyboard.press("Escape");
      r = await menuProbe(page);
      assert.deepEqual([r.hidden, r.expanded], [true, "false"]);
      await page.click("#rail-more");
      r = await menuProbe(page);
      assert.equal(r.hidden, false);
      assert.equal(r.active, "setup");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("clicking a disabled item or the menu's padding with the mouse posts nothing and leaves menu state and aria consistent", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      await loadConversation(page);
      await startTurn(page);
      for (const target of ['#rail-menu [data-rail-action="compact"]', '#rail-menu [data-rail-action="restart"]', "#rail-menu"]) {
        await page.click("#rail-more");
        await clearPosted(page);
        if (target === "#rail-menu") await page.click(target, { position: { x: 2, y: 2 } });
        else await page.click(target, { force: true });
        await page.waitForTimeout(60);
        assert.deepEqual(await posted(page), [], `${target} posted`);
        const r = await menuProbe(page);
        assert.equal(r.expanded, String(!r.hidden), `${target}: aria-expanded ${r.expanded} vs hidden ${r.hidden}`);
        assert.ok(r.hidden ? r.active === "rail-more" : r.active !== "BODY", `${target}: a mouse click inside the menu ${r.hidden ? "closed it and left focus on " + r.active + " (it should return to More)" : "left it open with focus on " + r.active}`);
        if (!(await menuProbe(page)).hidden) await page.keyboard.press("Escape");
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("Compact and Restart cannot be fired by a click that lands after a turn started mid-menu, even if the menu has already auto-closed", { timeout: 60000 }, async () => {
    const { page, context, errors } = await openPage(browser);
    try {
      await loadConversation(page);
      for (const how of ["flip", "message"] as const) {
        await page.click("#rail-more");
        assert.equal((await itemState(page)).compact.disabled, false);
        if (how === "flip") await page.evaluate("isRunning = true"); else await startTurn(page);
        await clearPosted(page);
        await page.evaluate(() => {
          for (const a of ["compact", "restart"]) {
            const el = document.querySelector(`#rail-menu [data-rail-action="${a}"]`) as HTMLElement;
            el.click();
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
        });
        await page.waitForTimeout(60);
        assert.deepEqual((await posted(page)).filter(t => t === "compact_session" || t === "run_action:restart"), [], `${how}: a blocked action posted`);
        const r = await menuProbe(page);
        assert.equal(r.expanded, String(!r.hidden));
        if (how === "flip") await page.evaluate("isRunning = false"); else await endTurn(page);
        await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      }
      await clearPosted(page);
      await activate(page, "compact", "click");
      assert.deepEqual(await posted(page), ["compact_session"], "Compact stopped working after the turn ended");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  it("turn-rail ticks hit-test to the tick, not to the rail, from 900 to 2000px expanded or collapsed, with the session panel on and off", { timeout: 180000 }, async () => {
    const { page, context } = await openPage(browser, { reducedMotion: "reduce", width: 1200 });
    const failures: string[] = [];
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.__send({ type: "init_state", sessionId: "s1", model: "m", provider: "p", models: [], sessions: [{ id: "s1", name: "S" }] });
        const messages: any[] = [];
        for (let i = 0; i < 6; i++) { messages.push({ role: "user", content: "question " + i }); messages.push({ role: "assistant", content: "answer " + i + " " + "text ".repeat(40) }); }
        w.__send({ type: "session_loaded", session: { id: "s1", name: "S", messages } });
      });
      await page.waitForTimeout(700);
      for (const panelOff of [false, true]) {
        for (const expanded of [false, true]) {
          for (const w of [900, 1100, 1300, 1499, 1500, 1600, 1800, 2000]) {
            await page.setViewportSize({ width: w, height: 800 });
            await page.evaluate(([ex, off]: [boolean, boolean]) => {
              const toggle = document.getElementById("rail-toggle")!;
              if ((toggle.getAttribute("aria-expanded") === "true") !== ex) toggle.click();
              document.body.classList.toggle("side-panel-off", off);
            }, [expanded, panelOff]);
            await page.waitForTimeout(260);
            const r = await page.evaluate(() => {
              const rail = document.getElementById("action-rail")!.getBoundingClientRect();
              const marks = Array.from(document.querySelectorAll(".turn-rail:not([hidden]) .turn-rail-mark")) as HTMLElement[];
              let notTick = 0, leftOfRailEdge = 0;
              for (const mark of marks) {
                const b = mark.getBoundingClientRect();
                const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                if (!top || !top.closest(".turn-rail-tick")) notTick++;
                if (b.left < rail.right - 0.5) leftOfRailEdge++;
              }
              return { marks: marks.length, notTick, leftOfRailEdge };
            });
            const tag = `panelOff=${panelOff} expanded=${expanded} w=${w}`;
            if (w >= 1500 && r.marks === 0) failures.push(`${tag}: no turn-rail ticks at all (gutter should be wide)`);
            if (r.notTick > 0) failures.push(`${tag}: ${r.notTick} of ${r.marks} ticks hit-test to something other than the tick`);
            if (r.leftOfRailEdge > 0) failures.push(`${tag}: ${r.leftOfRailEdge} ticks start left of the rail's right edge`);
          }
        }
      }
    } finally { await context.close(); }
    assert.deepEqual(failures, [], failures.slice(0, 10).join("\n"));
  });


  it("rail follows the top bar and status bar when their height changes (long name, extra buttons, padding)", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser, { reducedMotion: "reduce", width: 481 });
    try {
      const check = async (label: string) => {
        await page.waitForTimeout(120);
        const m: Metrics = await measure(page);
        assert.ok(Math.abs(m.rail!.t - m.top!.b) < 0.6, `${label}: rail top ${m.rail!.t} vs top bar bottom ${m.top!.b}`);
        assert.ok(Math.abs(m.rail!.b - m.status!.t) < 0.6, `${label}: rail bottom ${m.rail!.b} vs status top ${m.status!.t}`);
      };
      await page.evaluate(() => {
        (window as any).__send({ type: "init_state", sessionId: "s1", model: "m", provider: "p", models: [], sessions: [{ id: "s1", name: "A very long session name that goes on and on " + "x".repeat(400) }] });
        for (const id of ["btn-top-collab-inbox", "btn-top-timeline", "btn-top-compact"]) (document.getElementById(id) as HTMLElement).style.display = "inline-flex";
      });
      await check("long name and all buttons");
      await page.evaluate(() => { (document.querySelector(".top-bar") as HTMLElement).style.padding = "30px 10px"; });
      await check("taller top bar");
      await page.evaluate(() => { (document.querySelector(".status-bar") as HTMLElement).style.height = "60px"; });
      await check("taller status bar");
      for (const w of [481, 700, 1000, 1400]) { await page.setViewportSize({ width: w, height: 600 }); await check(`resize ${w}`); }
    } finally { await context.close(); }
  });

  it("sidebar page is laid out identically with and without the rail stylesheet", { timeout: 120000 }, async () => {
    for (const theme of ["dark", "light"] as const) {
      const a = await openPage(browser, { theme, actionRail: false, reducedMotion: "reduce", tab: false });
      const b = await openPage(browser, { theme, actionRail: false, stripRailCss: true, reducedMotion: "reduce", tab: false });
      try {
        const snap = (page: any) => page.evaluate(() => {
          const o: Record<string, number[]> = {};
          for (const e of Array.from(document.querySelectorAll("[id]"))) {
            if (e.closest("#mascot-drag-layer") || e.id.startsWith("mascot")) continue;
            const r = e.getBoundingClientRect();
            o[e.id] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          }
          return { o, pad: getComputedStyle(document.body).paddingLeft, rail: !!document.querySelector("#action-rail, .action-rail, .rail-menu") };
        });
        for (const w of [400, 481, 700, 900, 1200, 1600]) {
          for (const p of [a.page, b.page]) await p.setViewportSize({ width: w, height: 800 });
          await a.page.waitForTimeout(100);
          const [sa, sb] = [await snap(a.page), await snap(b.page)];
          assert.equal(sa.rail, false);
          assert.equal(sa.pad, sb.pad);
          const diffs = Object.keys(sa.o).filter(k => JSON.stringify(sa.o[k]) !== JSON.stringify(sb.o[k]));
          assert.deepEqual(diffs, [], `${theme} ${w}: rail CSS changes layout of ${diffs.slice(0, 5).join(", ")}`);
        }
        assert.deepEqual(a.errors, []);
      } finally { await a.context.close(); await b.context.close(); }
    }
  });

  it("More menu stays inside the viewport and the rail scrolls rather than clips, heights 300 to 900", { timeout: 240000 }, async () => {
    const failures: string[] = [];
    for (const theme of ["dark", "light"] as const) {
      const { page, context } = await openPage(browser, { theme, reducedMotion: "reduce", width: 1000, height: 800 });
      try {
        for (const w of [481, 760, 1000, 1500]) {
          for (const expanded of [false, true]) {
            for (const h of [300, 350, 400, 500, 600, 800, 900]) {
              await page.setViewportSize({ width: w, height: h });
              await page.evaluate((ex: boolean) => {
                const t = document.getElementById("rail-toggle")!;
                if (getComputedStyle(t).display !== "none" && (t.getAttribute("aria-expanded") === "true") !== ex) t.click();
                (document.getElementById("rail-menu") as HTMLElement).hidden = true;
                (document.getElementById("action-rail") as HTMLElement).scrollTop = 99999;
              }, expanded);
              await page.waitForTimeout(60);
              const pre = await page.evaluate(() => {
                const r = document.getElementById("action-rail")!;
                const b = r.getBoundingClientRect();
                const more = document.getElementById("rail-more")!.getBoundingClientRect();
                return { sh: r.scrollHeight, ch: r.clientHeight, ov: getComputedStyle(r).overflowY, top: b.top, bottom: b.bottom, moreT: more.top, moreB: more.bottom };
              });
              await page.click("#rail-more", { timeout: 2000 });
              const m = await page.evaluate(() => { const b = document.getElementById("rail-menu")!.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, vw: innerWidth, vh: innerHeight }; });
              const tag = `${theme} w=${w} h=${h} expanded=${expanded}`;
              if (m.l < 0 || m.t < 0 || m.r > m.vw || m.b > m.vh) failures.push(`${tag}: menu ${JSON.stringify(m)}`);
              if (pre.sh > pre.ch && pre.ov !== "auto" && pre.ov !== "scroll") failures.push(`${tag}: rail clips (${pre.sh}>${pre.ch}, overflow-y ${pre.ov})`);
              if (pre.moreB > pre.bottom + 0.5 || pre.moreT < pre.top - 0.5) failures.push(`${tag}: More cannot be scrolled into view`);
              if (h >= 900 && pre.sh > pre.ch) failures.push(`${tag}: rail scrolls although the window is tall`);
              await page.keyboard.press("Escape");
            }
          }
        }
      } finally { await context.close(); }
    }
    assert.deepEqual(failures, [], failures.slice(0, 10).join("\n"));
  });

  it("opening More right after a width change lands next to the settled rail (not mid-transition)", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser, { width: 1100, height: 800 });
    try {
      await page.evaluate(() => { (document.getElementById("rail-toggle") as HTMLElement).click(); (document.getElementById("rail-more") as HTMLElement).click(); });
      await page.waitForTimeout(400);
      const a = await page.evaluate(() => ({ menuL: document.getElementById("rail-menu")!.getBoundingClientRect().left, railR: document.getElementById("action-rail")!.getBoundingClientRect().right }));
      assert.ok(Math.abs(a.menuL - (a.railR + 6)) <= 1, `menu at ${a.menuL}, rail ends at ${a.railR}`);
    } finally { await context.close(); }
  });

  /* ---------------- accessibility ---------------- */

  const channel = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
  const luminance = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a: number[], b: number[]) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

  it("expanded labels and menu items are never clipped, even with a wider UI font", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser, { reducedMotion: "reduce", width: 1000 });
    try {
      await page.click("#rail-toggle");
      for (const font of ["'Segoe WPC', 'Segoe UI', system-ui, sans-serif", "Georgia, serif", "'Courier New', monospace"]) {
        await page.evaluate((f: string) => { document.documentElement.style.setProperty("--vscode-font-family", f); }, font);
        await page.click("#rail-more");
        const clipped = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll("#action-rail .rail-btn, #rail-menu .rail-menu-item")) as HTMLElement[]) {
            if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${(el.textContent || "").trim()}: ${el.scrollWidth} > ${el.clientWidth}`);
          }
          return out;
        });
        await page.keyboard.press("Escape");
        assert.deepEqual(clipped, [], `clipped text with font ${font}`);
      }
    } finally { await context.close(); }
  });

  it("roles, names and states: nav landmark, named buttons, menu and menuitems, aria-expanded", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser);
    try {
      const info = await page.evaluate(() => {
        const nav = document.getElementById("action-rail")!;
        const buttons = Array.from(nav.querySelectorAll("button")).map(b => ({ id: b.id, action: b.getAttribute("data-rail-action"), name: b.getAttribute("aria-label"), text: (b.textContent || "").trim(), type: b.getAttribute("type") }));
        const menu = document.getElementById("rail-menu")!;
        return {
          tag: nav.tagName, label: nav.getAttribute("aria-label"), buttons,
          menuRole: menu.getAttribute("role"), menuLabel: menu.getAttribute("aria-label"), menuInNav: nav.contains(menu),
          items: Array.from(menu.querySelectorAll("button")).map(b => ({ role: b.getAttribute("role"), tab: (b as HTMLButtonElement).tabIndex, text: (b.textContent || "").trim() })),
          more: { popup: document.getElementById("rail-more")!.getAttribute("aria-haspopup"), controls: document.getElementById("rail-more")!.getAttribute("aria-controls"), expanded: document.getElementById("rail-more")!.getAttribute("aria-expanded") },
          toggleExpanded: document.getElementById("rail-toggle")!.getAttribute("aria-expanded"), svgHidden: Array.from(nav.querySelectorAll("svg")).every(s => s.getAttribute("aria-hidden") === "true"),
        };
      });
      assert.equal(info.tag, "NAV");
      assert.ok(info.label && info.label.length > 3);
      for (const b of info.buttons) { assert.ok(b.name && b.name.trim().length > 0, `button ${b.id || b.action} has no accessible name`); assert.equal(b.type, "button"); }
      assert.equal(info.menuRole, "menu"); assert.ok(info.menuLabel);
      assert.equal(info.items.length, 5);
      for (const item of info.items) { assert.equal(item.role, "menuitem"); assert.equal(item.tab, -1); }
      assert.deepEqual([info.more.popup, info.more.controls, info.more.expanded, info.toggleExpanded], ["menu", "rail-menu", "false", "false"]);
      assert.ok(info.svgHidden, "icons must be aria-hidden");
    } finally { await context.close(); }
  });

  it("when labels are shown, every button's accessible name contains its visible label (WCAG 2.5.3)", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser, { width: 1000 });
    try {
      await page.click("#rail-toggle");
      await page.waitForTimeout(250);
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll("#action-rail button")).map(b => ({
        id: b.id || b.getAttribute("data-rail-action"), name: b.getAttribute("aria-label") || "", visible: ((b.querySelector(".rail-label") as HTMLElement | null)?.innerText || "").trim(),
      })));
      const bad = rows.filter((r: { visible: string; name: string }) => r.visible && !r.name.toLowerCase().includes(r.visible.toLowerCase()));
      assert.deepEqual(bad, [], `visible label not contained in the accessible name: ${JSON.stringify(bad)}`);
    } finally { await context.close(); }
  });

  it("tab order runs top bar, then rail from top to bottom, then the chat; hidden menu items are skipped", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser, { width: 1000 });
    try {
      await page.focus("#btn-top-waterfall");
      const order: string[] = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        order.push(await page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.id || a.getAttribute("data-rail-action") || a.tagName; }));
      }
      const first = order.indexOf("rail-toggle");
      assert.ok(first >= 0 && first <= 2, `rail not reached right after the top bar: ${order.join(" > ")}`);
      assert.deepEqual(order.slice(first, first + 8), ["rail-toggle", "new", "sessions", "review", "prs", "diffs", "settings", "rail-more"], order.join(" > "));
      assert.ok(!order.some(o => MENU.includes(o)), "hidden menu items were focusable");
      assert.ok(order.length > first + 8 && !["new", "sessions", "settings"].includes(order[first + 8]), "focus did not move on into the chat");
      await page.setViewportSize({ width: 700, height: 800 });
      await page.focus("#btn-top-waterfall");
      await page.keyboard.press("Tab");
      const narrow = await page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.id || a.getAttribute("data-rail-action") || a.tagName; });
      assert.ok(narrow === "new" || narrow === "btn-top-timeline" || narrow === "btn-top-compact" || narrow !== "rail-toggle", `hidden toggle was focused at 700px: ${narrow}`);
    } finally { await context.close(); }
  });

  for (const theme of ["dark", "light"] as const) {
    it(`contrast (${theme}): muted icons and labels on the rail, focus ring, menu text`, { timeout: 60000 }, async () => {
      const { page, context } = await openPage(browser, { theme });
      try {
        await page.click("#rail-toggle");
        await page.mouse.move(600, 300);
        await page.waitForTimeout(200);
        await page.focus('#action-rail [data-rail-action="new"]');
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        const c = await page.evaluate(() => {
          const cs = (e: Element) => getComputedStyle(e);
          const rail = document.getElementById("action-rail")!;
          const btn = rail.querySelector('[data-rail-action="new"]') as HTMLElement;
          const menu = document.getElementById("rail-menu") as HTMLElement;
          menu.hidden = false;
          const item = menu.querySelector(".rail-menu-item") as HTMLElement;
          return { rail: cs(rail).backgroundColor, color: cs(btn).color, outlineColor: cs(btn).outlineColor, outlineStyle: cs(btn).outlineStyle, outlineWidth: cs(btn).outlineWidth, menuBg: cs(menu).backgroundColor, itemColor: cs(item).color, icon: cs(item.querySelector("svg")!).color, fs: cs(btn).fontSize };
        });
        const bg = channel(c.rail);
        const muted = ratio(channel(c.color), bg);
        assert.ok(muted >= 4.5, `muted label/icon contrast on the rail is ${muted.toFixed(2)}:1 (${c.color} on ${c.rail}), AA text needs 4.5`);
        assert.equal(c.outlineStyle, "solid", "focused rail button has no visible outline");
        assert.ok(parseFloat(c.outlineWidth) >= 1);
        const ring = ratio(channel(c.outlineColor), bg);
        assert.ok(ring >= 3, `focus ring contrast ${ring.toFixed(2)}:1 (${c.outlineColor} on ${c.rail})`);
        assert.ok(ratio(channel(c.itemColor), channel(c.menuBg)) >= 4.5);
        assert.ok(ratio(channel(c.icon), channel(c.menuBg)) >= 3, `menu icon contrast ${ratio(channel(c.icon), channel(c.menuBg)).toFixed(2)}`);
        console.log(`contrast ${theme}: muted ${muted.toFixed(2)}:1, focus ring ${ring.toFixed(2)}:1, menu text ${ratio(channel(c.itemColor), channel(c.menuBg)).toFixed(2)}:1`);
      } finally { await context.close(); }
    });
  }

  it("forced-colors: the focus ring survives and an expanded toggle does not look permanently focused", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser, { forcedColors: "active", width: 1000 });
    try {
      await page.click("#rail-toggle");
      await page.mouse.move(600, 300);
      await page.focus('#action-rail [data-rail-action="new"]');
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      const r = await page.evaluate(() => {
        const cs = (e: Element) => getComputedStyle(e);
        return { focused: cs(document.activeElement!).outlineStyle, toggle: cs(document.getElementById("rail-toggle")!).outlineStyle, border: cs(document.getElementById("action-rail")!).borderRightWidth };
      });
      assert.equal(r.focused, "solid", "no focus indicator in forced colors");
      assert.equal(r.toggle, "none", "expanded toggle keeps an outline in forced colors although it is neither hovered nor focused, it reads as a focus ring on the wrong control");
      assert.notEqual(r.border, "0px");
    } finally { await context.close(); }
  });

  it("prefers-reduced-motion removes every rail transition", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser, { reducedMotion: "reduce", width: 1000 });
    try {
      const r = await page.evaluate(() => {
        const cs = (e: Element) => getComputedStyle(e);
        return [cs(document.getElementById("action-rail")!).transitionDuration, cs(document.querySelector("#rail-toggle svg")!).transitionDuration];
      });
      assert.deepEqual(r, ["0s", "0s"]);
    } finally { await context.close(); }
  });

  it("the preference survives a reload and expanded state matches the toggle's name and state", { timeout: 60000 }, async () => {
    const { page, context } = await openPage(browser, { preScript: `localStorage.setItem('${KEY}','1')`, width: 1000 });
    try {
      const s = await railState(page);
      assert.deepEqual([s.toggle, s.open], ["true", true]);
      const name = await page.evaluate(() => ({ label: document.getElementById("rail-toggle")!.getAttribute("aria-label"), title: (document.getElementById("rail-toggle") as HTMLElement).title }));
      assert.equal(name.label, "Hide labels");
      assert.equal(name.title, "Hide labels");
      await page.click("#rail-toggle");
      const collapsed = await page.evaluate(() => ({ label: document.getElementById("rail-toggle")!.getAttribute("aria-label"), title: (document.getElementById("rail-toggle") as HTMLElement).title, state: document.getElementById("rail-toggle")!.getAttribute("aria-expanded") }));
      assert.deepEqual(collapsed, { label: "Show labels", title: "Show labels", state: "false" });
      await page.click("#rail-toggle");
      assert.equal(await page.evaluate(() => document.getElementById("rail-toggle")!.getAttribute("aria-label")), "Hide labels");
    } finally { await context.close(); }
  });
});
