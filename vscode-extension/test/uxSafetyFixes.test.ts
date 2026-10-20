import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const warnings: Array<{ message: string; modal: boolean }> = [];
const executedCommands: string[] = [];
const errors: string[] = [];
let warningAnswer: string | undefined;
const vscodeMock: any = {
  Uri: {
    joinPath: (...parts: any[]) => ({ fsPath: parts.map(p => typeof p === "object" ? p.fsPath : String(p)).join("/") }),
    parse: (u: string) => ({ toString: () => u }),
    file: (p: string) => ({ fsPath: p }),
  },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: async (message: string, options?: any) => {
      warnings.push({ message, modal: options?.modal === true });
      return warningAnswer;
    },
    showErrorMessage: async (message: string) => { errors.push(message); return undefined; },
    showInformationMessage: async () => undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/repo" } }],
    textDocuments: [],
    isTrusted: true,
    getConfiguration: () => ({ get: (_k: string, fallback: unknown) => fallback, update: async () => {} }),
  },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  commands: { executeCommand: async (command: string) => { executedCommands.push(command); } },
  env: { isTelemetryEnabled: false, shell: "" },
};

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments);
};
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");
Module.prototype.require = originalRequire;

import { element, loadChat } from "./helpers/chatHarness.js";


function optionRow(action: string) {
  const row: any = element({ tagName: "DIV" });
  row.attrs.role = "button";
  row.attrs["data-action"] = action;
  row.closest = (sel: string) => sel.includes('[role="button"]') ? row : null;
  return row;
}

describe("approval card keyboard handling", () => {
  it("Enter on a focused Deny row activates Deny and never approves", () => {
    const h = loadChat();
    h.eval("activePendingApprovalId = 'a1'; activePendingToolName = 'shell_exec';");
    const deny = optionRow("reject-tool");
    h.keydown({ key: "Enter", target: deny });
    assert.equal(deny.clicks, 1);
    assert.deepEqual(h.decisions, []);
  });

  it("Space on a focused option row activates that row", () => {
    const h = loadChat();
    h.eval("activePendingApprovalId = 'a1';");
    const always = optionRow("approve-tool-always");
    h.keydown({ key: " ", target: always });
    assert.equal(always.clicks, 1);
    assert.deepEqual(h.decisions, []);
  });

  it("Enter with nothing focused still allows once", () => {
    const h = loadChat();
    h.eval("activePendingApprovalId = 'a1';");
    h.keydown({ key: "Enter" });
    assert.deepEqual(h.decisions, ["approve:once"]);
  });

  it("Esc closes an open menu or palette instead of denying the tool", () => {
    const h = loadChat();
    h.eval("activePendingApprovalId = 'a1';");
    h.byId["mode-popover"].style.display = "flex";
    h.keydown({ key: "Escape" });
    assert.deepEqual(h.decisions, []);

    h.byId["mode-popover"].style.display = "none";
    h.keydown({ key: "Escape", defaultPrevented: true });
    assert.deepEqual(h.decisions, [], "a palette that already handled Esc keeps it");

    h.keydown({ key: "Escape" });
    assert.deepEqual(h.decisions, ["reject"]);
  });
});

describe("prompt box", () => {
  it("ArrowDown moves the cursor inside a recalled prompt and only leaves history at the end", () => {
    const h = loadChat();
    const input = h.byId["prompt-input"];
    h.eval("sentPromptsHistory.length = 0; sentPromptsHistory.push('first', 'second'); promptHistoryIndex = 0; tempPromptDraft = '';");
    input.value = "first\nedited line";
    input.selectionStart = input.selectionEnd = 2;
    const e = h.promptKey({ key: "ArrowDown" });
    assert.equal(e.defaultPrevented, false);
    assert.equal(input.value, "first\nedited line");

    input.selectionStart = input.selectionEnd = input.value.length;
    h.promptKey({ key: "ArrowDown" });
    assert.equal(input.value, "second");
  });

  it("while a turn runs, the placeholder explains queueing and steering, then restores", () => {
    const h = loadChat();
    const input = h.byId["prompt-input"];
    input.setAttribute("placeholder", "Ask Andromity…");
    h.eval("queueSupported = true;");
    h.promptBox.classList.add("is-generating");
    h.observers.forEach(fn => fn([]));
    assert.match(input.getAttribute("placeholder"), /Queue a follow-up \(Enter\) · Ctrl\+Enter to steer now/);
    assert.equal(h.byId["btn-send"].attrs["data-tip"], "Queue follow-up (Enter)\nCtrl+Enter to steer now");

    h.promptBox.classList.remove("is-generating");
    h.observers.forEach(fn => fn([]));
    assert.equal(input.getAttribute("placeholder"), "Ask Andromity…");
    assert.equal(h.byId["btn-send"].attrs["data-tip"], "Send (Enter)");
  });
});

describe("settings safety", () => {
  function settingsPanel(calls: string[]) {
    const panel: any = Object.create(SettingsPanel.prototype);
    panel._rpcClient = { call: async (method: string) => { calls.push(method); return method === "config.list_providers" ? [] : { provider: "acme", providers: [] }; } };
    panel._panel = { webview: { postMessage: async () => true } };
    return panel;
  }

  it("Save with an empty key leaves the stored key alone", async () => {
    const calls: string[] = [];
    warnings.length = 0;
    await settingsPanel(calls)._handleMessage({ type: "set_api_key", provider: "openai", apiKey: "   " });
    assert.deepEqual(calls, []);
    assert.match(warnings.at(-1)!.message, /not changed/);
  });

  it("removing a custom provider asks first and does nothing on cancel", async () => {
    const calls: string[] = [];
    warnings.length = 0;
    warningAnswer = undefined;
    await settingsPanel(calls)._handleMessage({ type: "delete_provider", provider: "acme" });
    assert.deepEqual(calls, []);
    assert.equal(warnings.at(-1)!.modal, true);

    warningAnswer = "Remove";
    await settingsPanel(calls)._handleMessage({ type: "delete_provider", provider: "acme" });
    assert.ok((calls as string[]).includes("config.delete_provider"));
    warningAnswer = undefined;
  });
});

describe("failed send", () => {
  it("shows the error once in the chat and never puts the raw backend text in a toast", async () => {
    const provider: any = Object.create(ChatViewProvider.prototype);
    const toWebview: any[] = [];
    errors.length = 0;
    Object.assign(provider, {
      _currentSessionId: "s1", _runningSessions: new Set<string>(), _currentModel: "m", _currentProvider: "p",
      _currentMode: "safe", _currentProfile: "builder", _currentReasoning: "medium",
      _postToWebview: (m: any) => toWebview.push(m),
      _rpcClient: { call: async (method: string) => {
        if (method === "agent.prompt") throw new Error("litellm.InternalServerError: upstream 500 trace=abc");
        return {};
      } },
    });
    await provider._handleWebviewMessage({ type: "send_prompt", prompt: "hi", sessionId: "s1" });
    assert.deepEqual(errors, []);
    assert.equal(toWebview.filter(m => m.type === "agent_error").length, 1);
  });
});

describe("package contributions", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
  const hidden = new Set(pkg.contributes.menus.commandPalette.filter((m: any) => m.when === "false").map((m: any) => m.command));
  const titles = new Map(pkg.contributes.commands.map((c: any) => [c.command, c.title]));

  it("lists the everyday commands in the Command Palette", () => {
    for (const id of ["switchModel", "switchMode", "switchProfile", "openModelHub", "openCrons", "login", "logout", "undoTurn", "showSessions", "compactSession"]) {
      assert.ok(titles.has("andromity." + id), id + " is contributed");
      assert.ok(!hidden.has("andromity." + id), id + " is not hidden");
    }
  });

  it("describes each permission mode and warns about YOLO", () => {
    const setting = pkg.contributes.configuration.properties
      ? pkg.contributes.configuration.properties["andromity.permissionMode"]
      : pkg.contributes.configuration.find((c: any) => c.properties?.["andromity.permissionMode"]).properties["andromity.permissionMode"];
    assert.equal(setting.enumDescriptions.length, setting.enum.length);
    assert.match(setting.enumDescriptions[setting.enum.indexOf("yolo")], /^Warning: .*without asking/);
  });
});

describe("rewind and resend on the host", () => {
  function provider(calls: string[], posted: any[]) {
    const p: any = Object.create(ChatViewProvider.prototype);
    Object.assign(p, {
      _currentSessionId: "s1", _diffManager: undefined,
      _loadSession: async () => {},
      _postToWebview: (m: any) => posted.push(m),
      _rpcClient: { call: async (method: string) => { calls.push(method); return { success: true, turns_undone: 2, target_turn_index: 1, popped_messages: 4 }; } },
    });
    return p;
  }

  it("asks before rewinding and does nothing on cancel", async () => {
    const calls: string[] = []; const posted: any[] = [];
    warnings.length = 0;
    warningAnswer = undefined;
    await provider(calls, posted)._handleWebviewMessage({ type: "undo_turn", turnIndex: 1, totalTurns: 3, turnsToUndo: 2, resendPrompt: "Use v2" });
    assert.deepEqual(calls, []);
    assert.equal(warnings.at(-1)!.modal, true);
    assert.match(warnings.at(-1)!.message, /undoes the last 2 turns and their file changes/);
  });

  it("on confirm, undoes the turns and hands the edited message back to send", async () => {
    const calls: string[] = []; const posted: any[] = [];
    warningAnswer = "Undo and Resend";
    try {
      await provider(calls, posted)._handleWebviewMessage({ type: "undo_turn", turnIndex: 1, totalTurns: 3, turnsToUndo: 2, resendPrompt: "Use v2" });
    } finally {
      warningAnswer = undefined;
    }
    assert.ok((calls as string[]).includes("session.undo"));
    const done = posted.find((m) => m.type === "turn_undone");
    assert.equal(done.resendPrompt, "Use v2");
  });

  it("a plain undo does not ask", async () => {
    const calls: string[] = []; const posted: any[] = [];
    warnings.length = 0;
    await provider(calls, posted)._handleWebviewMessage({ type: "undo_turn", turnIndex: 2, totalTurns: 3, turnsToUndo: 1 });
    assert.equal(warnings.length, 0);
    assert.ok((calls as string[]).includes("session.undo"));
    assert.equal(posted.find((m) => m.type === "turn_undone").resendPrompt, undefined);
  });
});

describe("session panel commands", () => {
  it("runs only the branch switcher, Explorer and air-gap toggle", async () => {
    const provider: any = Object.create(ChatViewProvider.prototype);
    executedCommands.length = 0;
    for (const command of ["git.checkout", "workbench.view.explorer", "andromity.toggleAirGap", "workbench.action.terminal.sendSequence", "andromity.deleteSession", 42]) {
      await provider._handleWebviewMessage({ type: "side_panel_command", command });
    }
    assert.deepEqual(executedCommands, ["git.checkout", "workbench.view.explorer", "andromity.toggleAirGap"]);
  });
});
