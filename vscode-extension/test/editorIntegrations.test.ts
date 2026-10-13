import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments as any);
};

import { runAgentTurn } from "../src/integrations/agentTurn.js";
import { buildInlineEditPrompt, extractReplacement } from "../src/integrations/InlineEdit.js";

function fakeRpc(onPrompt: (rpc: any, params: any) => void) {
  const rpc: any = new EventEmitter();
  rpc.calls = [] as Array<{ method: string; params: any }>;
  rpc.call = async (method: string, params: any) => {
    rpc.calls.push({ method, params });
    if (method === "session.create") return { id: "s1" };
    if (method === "agent.prompt") setImmediate(() => onPrompt(rpc, params));
    return {};
  };
  return rpc;
}

describe("agent turn runner", () => {
  it("streams only its own session's events and resolves on done", async () => {
    const texts: string[] = [];
    const rpc = fakeRpc((r) => {
      r.emit("agent/textDelta", { session_id: "other", text: "ignored" });
      r.emit("agent/textDelta", { session_id: "s1", text: "Hello " });
      r.emit("agent/textDelta", { session_id: "s1", text: "world" });
      r.emit("agent/done", { session_id: "s1", turn_files: ["src/a.ts", 3] });
    });
    const result = await runAgentTurn(rpc, { prompt: "hi", sessionName: "t", mode: "safe" }, { onText: (t) => texts.push(t) });
    assert.deepEqual(texts, ["Hello ", "world"]);
    assert.equal(result.outcome, "done");
    assert.equal(result.text, "Hello world");
    assert.deepEqual(result.turnFiles, ["src/a.ts"]);
    assert.equal(rpc.calls.find((c: any) => c.method === "agent.prompt").params.mode, "safe");
    assert.equal(rpc.listenerCount("agent/textDelta"), 0, "listeners are removed after the turn");
  });

  it("continues an existing session instead of creating one", async () => {
    const rpc = fakeRpc((r, params) => r.emit("agent/done", { session_id: params.session_id }));
    const result = await runAgentTurn(rpc, { prompt: "more", sessionId: "existing", sessionName: "t", mode: "safe" }, {});
    assert.equal(result.sessionId, "existing");
    assert.ok(!rpc.calls.some((c: any) => c.method === "session.create"));
  });

  it("reports errors and forwards approvals", async () => {
    const approvals: string[] = [];
    const rpc = fakeRpc((r) => {
      r.emit("agent/toolApprovalRequired", { session_id: "s1", approval_id: "a1", tool_name: "shell_exec", args: {} });
      r.emit("agent/error", { session_id: "s1", error: "boom" });
    });
    const result = await runAgentTurn(rpc, { prompt: "x", sessionName: "t", mode: "safe" }, { onApproval: (e) => approvals.push(e.approval_id) });
    assert.deepEqual(approvals, ["a1"]);
    assert.equal(result.outcome, "error");
    assert.equal(result.error, "boom");
  });

  it("cancels through the daemon when the token fires", async () => {
    let fire: () => void = () => {};
    const token = { isCancellationRequested: false, onCancellationRequested(listener: () => void) { fire = listener; return { dispose() {} }; } };
    const rpc = fakeRpc((r) => {
      fire();
      setImmediate(() => r.emit("agent/cancelled", { session_id: "s1" }));
    });
    const result = await runAgentTurn(rpc, { prompt: "x", sessionName: "t", mode: "safe" }, {}, token);
    assert.equal(result.outcome, "cancelled");
    assert.ok(rpc.calls.some((c: any) => c.method === "agent.cancel" && c.params.session_id === "s1"));
  });
});

describe("inline edit helpers", () => {
  const fence = "`".repeat(3);

  it("takes the first fenced block from the reply", () => {
    assert.equal(extractReplacement(`Sure:\n${fence}ts\nconst a = 1;\nconst b = 2;\n${fence}\nDone.`), "const a = 1;\nconst b = 2;");
    assert.equal(extractReplacement("  return x + 1;  "), "return x + 1;");
  });

  it("builds a prompt with the instruction, context and selection", () => {
    const prompt = buildInlineEditPrompt({
      instruction: "add validation", relativePath: "src/a.ts", languageId: "typescript",
      before: "function f(x) {\n", selection: "  return x;\n", after: "}\n",
    });
    assert.match(prompt, /src\/a\.ts \(typescript\)/);
    assert.match(prompt, /Instruction: add validation/);
    assert.match(prompt, /<selection>\n  return x;\n<\/selection>/);
    assert.match(prompt, /Rewrite the code inside <selection>/);
  });

  it("uses the last code block when the reply came from reasoning", () => {
    const reply = ["Thinking:", fence + "go", "draft", fence, "Final answer:", fence + "go", "final()", fence].join("\n");
    assert.equal(extractReplacement(reply, true), "final()");
    assert.equal(extractReplacement(reply, false), "draft");
    assert.equal(extractReplacement("Thinking about it, no code yet", true), "");
  });

  it("asks for an insertion when nothing is selected", () => {
    const prompt = buildInlineEditPrompt({ instruction: "x", relativePath: "a.py", languageId: "python", before: "", selection: "", after: "" });
    assert.match(prompt, /Write the code to insert at <selection>/);
  });
});

describe("chat and inline edit contributions", () => {
  const root = fs.existsSync(path.resolve(__dirname, "..", "package.json")) ? path.resolve(__dirname, "..") : path.resolve(__dirname, "..", "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

  it("declares the @andromity participant and the delegate tool", () => {
    assert.equal(manifest.contributes.chatParticipants[0].id, "andromity.agent");
    assert.equal(manifest.contributes.chatParticipants[0].name, "andromity");
    assert.equal(manifest.contributes.languageModelTools[0].name, "andromity_delegate");
    assert.deepEqual(manifest.contributes.languageModelTools[0].inputSchema.required, ["task"]);
    // A tool reference named "andromity" showed up as a second @andromity entry.
    assert.equal(manifest.contributes.languageModelTools[0].toolReferenceName, undefined);
  });

  it("binds Ctrl+I only when no other inline chat provider owns it", () => {
    const binding = manifest.contributes.keybindings.find((k: any) => k.command === "andromity.inlineEdit");
    assert.equal(binding.key, "ctrl+i");
    assert.match(binding.when, /!inlineChatHasProvider/);
  });
});
