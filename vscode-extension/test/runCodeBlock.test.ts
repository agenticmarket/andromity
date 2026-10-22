import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const created: any[] = [];
const warnings: string[] = [];
const vscodeMock: any = {
  env: { shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
  window: {
    activeTextEditor: undefined,
    createTerminal(options: any) {
      const terminal = { options, shown: false, sent: [] as Array<[string, boolean]>, show() { this.shown = true; }, sendText(text: string, run: boolean) { this.sent.push([text, run]); } };
      created.push(terminal);
      return terminal;
    },
    showWarningMessage(message: string) { warnings.push(message); return Promise.resolve(undefined); },
  },
  workspace: { workspaceFolders: [{ uri: { fsPath: "/repo" } }], getWorkspaceFolder: () => undefined },
  Uri: { joinPath: (...parts: any[]) => ({ fsPath: parts.map(p => typeof p === "object" ? p.fsPath : String(p)).join("/") }) },
};

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments);
};
const { normalizeShellCommand, resolveShellPath, shellFamilyForLanguage } = require("../src/integrations/shellLanguages.js");
const { runCodeBlockInTerminal, outputTail } = require("../src/integrations/TerminalRunner.js");
const { getChatClientScript } = require("../src/providers/chatview/chatClientScript.js");
Module.prototype.require = originalRequire;

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

function loadRenderer(): (md: string) => string {
  const sandbox: any = {
    acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} }),
    document: stub(), window: stub(), navigator: stub(), localStorage: stub(),
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(__dirname, "..", "..", "media", "marked.min.js"), "utf8"), sandbox);
  vm.runInContext(getChatClientScript("icon.svg", {
    currentSessionId: "s", currentModel: "m", currentProvider: "p",
    currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
  }), sandbox);
  return sandbox.renderMarkdown;
}

describe("shell code block languages", () => {
  it("maps bash, PowerShell and CMD fences to their shell family", () => {
    assert.equal(shellFamilyForLanguage("bash"), "posix");
    assert.equal(shellFamilyForLanguage(" Shell "), "posix");
    assert.equal(shellFamilyForLanguage("PowerShell"), "powershell");
    assert.equal(shellFamilyForLanguage("ps1"), "powershell");
    assert.equal(shellFamilyForLanguage("cmd"), "cmd");
    assert.equal(shellFamilyForLanguage("bat"), "cmd");
    assert.equal(shellFamilyForLanguage("python"), undefined);
    assert.equal(shellFamilyForLanguage("constructor"), undefined);
    assert.equal(shellFamilyForLanguage(undefined), undefined);
  });

  it("strips prompts only when every line has one", () => {
    assert.equal(normalizeShellCommand("$ npm install\n$ npm test\n", "posix"), "npm install\nnpm test");
    assert.equal(normalizeShellCommand("$ ls\nfile.txt", "posix"), "$ ls\nfile.txt");
    assert.equal(normalizeShellCommand("PS C:\\repo> Get-ChildItem", "powershell"), "Get-ChildItem");
    assert.equal(normalizeShellCommand("C:\\repo> dir", "cmd"), "dir");
    assert.equal(normalizeShellCommand("\r\n  echo hi\r\n\r\n", "posix"), "  echo hi");
  });

  it("uses the default terminal when it already matches, and the right shell otherwise", () => {
    assert.equal(resolveShellPath("posix", "linux", "/bin/zsh"), undefined);
    assert.equal(resolveShellPath("powershell", "win32", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"), undefined);
    assert.equal(resolveShellPath("powershell", "win32", "C:\\Windows\\System32\\cmd.exe"), "powershell.exe");
    assert.equal(resolveShellPath("powershell", "darwin", "/bin/zsh"), "pwsh");
    assert.equal(resolveShellPath("cmd", "win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "cmd.exe");
    assert.equal(resolveShellPath("cmd", "win32", "C:\\Windows\\System32\\cmd.exe"), undefined);
    assert.equal(resolveShellPath("cmd", "linux", "/bin/bash"), null);
  });
});

describe("Run button on chat code blocks", () => {
  const render = loadRenderer();

  it("adds a Run button to shell fences only", () => {
    const bash = render("```bash\nnpm test\n```");
    assert.ok(bash.includes('data-action="run-code"'), bash);
    assert.ok(bash.includes('data-lang="bash"'), bash);
    assert.ok(bash.includes('data-code="npm%20test'), bash);

    const ps = render("```PowerShell\nGet-Process\n```");
    assert.ok(ps.includes('data-lang="powershell"'), ps);

    const py = render("```python\nprint(1)\n```");
    assert.ok(!py.includes('data-action="run-code"'), py);
    assert.ok(py.includes('data-action="copy-code"'), py);
  });

  it("skips the Run button for an empty shell block", () => {
    const html = render("```bash\n\n```");
    assert.ok(!html.includes('data-action="run-code"'), html);
  });
});

describe("runCodeBlockInTerminal", () => {
  beforeEach(() => { created.length = 0; warnings.length = 0; });

  it("opens a new terminal in the workspace and runs the command", async () => {
    await runCodeBlockInTerminal("$ npm install\n$ npm test", "bash");
    assert.equal(created.length, 1);
    const terminal = created[0];
    assert.equal(terminal.options.name, "Andromity: Run");
    assert.equal(terminal.options.cwd.fsPath, "/repo");
    assert.equal(terminal.options.shellPath, undefined);
    assert.ok(terminal.shown);
    assert.deepEqual(terminal.sent, [["npm install\nnpm test", true]]);
  });

  it("opens a fresh terminal on every run", async () => {
    await runCodeBlockInTerminal("echo one", "sh");
    await runCodeBlockInTerminal("echo two", "sh");
    assert.equal(created.length, 2);
  });

  it("ignores non-shell languages and blank commands", async () => {
    await runCodeBlockInTerminal("print(1)", "python");
    await runCodeBlockInTerminal("   \n", "bash");
    await runCodeBlockInTerminal({ evil: true }, "bash");
    assert.equal(created.length, 0);
  });

  it("starts CMD blocks in cmd.exe on Windows and warns elsewhere", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      await runCodeBlockInTerminal("dir", "cmd");
      assert.equal(created[0].options.shellPath, "cmd.exe");

      Object.defineProperty(process, "platform", { value: "linux" });
      await runCodeBlockInTerminal("dir", "cmd");
      assert.equal(created.length, 1);
      assert.equal(warnings.length, 1);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("tracked runs (shell integration)", () => {
  beforeEach(() => { created.length = 0; warnings.length = 0; });

  function withShellIntegration(fn: (ctx: { endListeners: Function[]; executions: any[] }) => Promise<void>) {
    const endListeners: Function[] = [];
    const executions: any[] = [];
    const originalCreate = vscodeMock.window.createTerminal;
    vscodeMock.window.onDidChangeTerminalShellIntegration = () => ({ dispose() {} });
    vscodeMock.window.onDidEndTerminalShellExecution = (listener: Function) => { endListeners.push(listener); return { dispose() {} }; };
    vscodeMock.window.createTerminal = (options: any) => {
      const terminal = originalCreate(options);
      terminal.shellIntegration = {
        executeCommand(command: string) {
          const execution = { command, async *read() { yield "\x1b[31mError: boom\x1b[0m\r\n"; } };
          executions.push(execution);
          return execution;
        },
      };
      return terminal;
    };
    return fn({ endListeners, executions }).finally(() => {
      vscodeMock.window.createTerminal = originalCreate;
      delete vscodeMock.window.onDidChangeTerminalShellIntegration;
      delete vscodeMock.window.onDidEndTerminalShellExecution;
    });
  }

  it("reports running, then the exit code and cleaned output when the command fails", () => withShellIntegration(async ({ endListeners, executions }) => {
    const statuses: any[] = [];
    await runCodeBlockInTerminal("$ npm test", "bash", (s: any) => statuses.push(s));
    assert.deepEqual(statuses, [{ state: "running", command: "npm test" }]);
    assert.equal(executions[0].command, "npm test");
    assert.deepEqual(created[0].sent, [], "the command is run once, through shell integration");

    endListeners.forEach((listener) => listener({ execution: executions[0], exitCode: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(statuses[1], { state: "failed", command: "npm test", exitCode: 1, outputTail: "Error: boom" });
  }));

  it("reports success for exit code 0", () => withShellIntegration(async ({ endListeners, executions }) => {
    const statuses: any[] = [];
    await runCodeBlockInTerminal("npm test", "bash", (s: any) => statuses.push(s));
    endListeners.forEach((listener) => listener({ execution: executions[0], exitCode: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(statuses[1].state, "succeeded");
  }));

  it("runs untracked on VS Code builds without shell integration", async () => {
    const statuses: any[] = [];
    await runCodeBlockInTerminal("npm test", "bash", (s: any) => statuses.push(s));
    assert.deepEqual(statuses, [{ state: "untracked", command: "npm test" }]);
    assert.deepEqual(created[0].sent, [["npm test", true]]);
  });

  it("keeps the last 100 lines of output without terminal escape codes", () => {
    const raw = Array.from({ length: 150 }, (_, i) => "\x1b[32mline " + i + "\x1b[0m").join("\r\n") + "\r\n\r\n";
    const tail = outputTail(raw);
    assert.equal(tail.split("\n").length, 100);
    assert.ok(tail.startsWith("line 50"));
    assert.ok(tail.endsWith("line 149"));
    assert.ok(!tail.includes("\x1b"));
  });
});
