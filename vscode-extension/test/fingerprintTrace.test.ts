import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFingerprintTrace, isSensitivePath } from "../src/providers/fingerprint/fingerprintTrace.js";
import { getFingerprintScript } from "../src/providers/fingerprint/fingerprintScript.js";

const ROOT = "D:\\proj";
let seq = 0;
const call = (name: string, args: Record<string, unknown>) => ({ id: `call_${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

function turn(messages: any[], prompt: string, calls: any[], results: string[], extra: Record<string, unknown> = {}) {
  messages.push({ role: "user", content: prompt, ts: "2026-10-15T00:40:00Z", ...extra });
  messages.push({ role: "assistant", content: "", tool_calls: calls, duration: 6.2 });
  calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: results[i] ?? "ok" }));
  messages.push({ role: "assistant", content: "Done.", duration: 14.46 });
}

function sampleSession() {
  const messages: any[] = [];
  turn(messages, "Explain the architecture of this project in detail\n\n--- [Active Document: d:\\proj\\README.md]", [
    call("list_dir", { path: ROOT }), call("find_files", { pattern: "**/*.ts" }), call("read_file", { path: `${ROOT}\\README.md` }),
    call("read_file", { path: "package.json" }), call("list_dir", { path: `${ROOT}\\src` }), call("read_file", { path: `${ROOT}\\package.json` }),
    call("read_file", { path: "src/extension.ts" }),
  ], ["src README.md", "a.ts", "# Proj", "{}", "x.ts", "{}", "export {}"]);
  turn(messages, "Fix the token counter and run the tests", [
    call("write_plan", { title: "Fix tokens", steps: ["edit", "test"] }),
    call("edit_file", { path: "src/waterfall.ts", old_str: "a", new_str: "b" }),
    call("edit_file", { path: `${ROOT}\\src\\waterfall.ts`, old_str: "c", new_str: "d" }),
    call("update_plan_step", { step_index: 0, status: "done" }),
    call("shell_exec", { command: "npm test" }),
    call("shell_read", { process_id: "p1" }),
    call("read_file", { path: ".env" }),
    call("grep_search", { query: "totalTokens", path: "src" }),
  ], ["Plan saved", "Edited", "Edited", "ok", "276 passed", "output", "Error reading file: Access denied: Path '.env' matches sensitive system/credential targets and cannot be read.", "src/waterfall.ts:1"]);
  messages.push({ role: "user", content: "also check the tests folder", steering: true });
  return { id: "s1", status: "idle", messages, created_at: "2026-10-13T08:00:00Z", updated_at: "2026-10-15T01:10:00Z" };
}

describe("fingerprint trace", () => {
  const trace = buildFingerprintTrace(sampleSession(), { sessionId: "s1", workspaceRoot: ROOT });

  it("counts unique files, real commands and working time instead of raw tool calls", () => {
    assert.deepEqual(trace.metrics, {
      durationMs: 2 * 14460,
      filesModified: 1,
      filesRead: 3,
      commandsRun: 1,
      searches: 4,
      sensitiveBlocked: 1,
      sensitiveAccessed: 0,
    });
  });

  it("keeps follow-ups inside their turn and strips IDE context from prompts", () => {
    assert.equal(trace.turns.length, 2);
    assert.equal(trace.turns[0].prompt, "Explain the architecture of this project in detail");
    assert.equal(trace.turns[1].followUps, 1);
    const hub = trace.nodes.find((n: any) => n.id === "turn-2");
    assert.deepEqual(hub.details.followUps, ["also check the tests folder"]);
  });

  it("groups repeat reads and a turn's searches into single cards with readable titles", () => {
    const titles = trace.nodes.filter((n: any) => n.turn === "turn-1" && !n.isTurnHub).map((n: any) => n.title);
    assert.deepEqual(titles, ["Explored 3 locations", "Read README.md", "Read package.json ×2", "Read extension.ts"]);
    assert.ok(trace.nodes.every((n: any) => !/: call$/.test(n.title)));
    const readme = trace.nodes.find((n: any) => n.title === "Read README.md");
    assert.equal(readme.sub, "README.md");
  });

  it("marks a refused secret read as blocked, not as protected or leaked", () => {
    const env = trace.nodes.find((n: any) => n.filePath === ".env");
    assert.equal(env.sensitive, true);
    assert.equal(env.status, "blocked");
    assert.equal(env.badge, "Blocked");
  });

  it("only joins neighbouring cards so edges never cross a card", () => {
    const byId = new Map(trace.nodes.map((n: any) => [n.id, n]));
    for (const conn of trace.connections) {
      const from: any = byId.get(conn.from);
      const to: any = byId.get(conn.to);
      if (conn.kind === "turn") assert.ok(from.isTurnHub && to.isTurnHub && to.y > from.y);
      else if (from.isTurnHub) assert.equal(to.x, 340);
      else assert.ok(to.y === from.y && to.x - from.x === 280, `${from.title} -> ${to.title}`);
    }
  });

  it("includes turns from before a compaction and skips the summary exchange", () => {
    const session = sampleSession();
    const compacted = session.messages.splice(0, 10);
    const withSummary = {
      ...session,
      compacted_history: compacted,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "[Conversation summary of earlier turns]:\nsummary" },
        { role: "assistant", content: "Understood. I have the context of our earlier discussion and will continue from here." },
        ...session.messages,
      ],
    };
    const rebuilt = buildFingerprintTrace(withSummary, { sessionId: "s1", workspaceRoot: ROOT });
    assert.deepEqual(rebuilt.turns.map((t: any) => t.prompt), trace.turns.map((t: any) => t.prompt));
  });

  it("links each spawn to its own subagent when two share a role", () => {
    const a = call("spawn_subagent", { role: "reviewer", task: "Review A" });
    const b = call("spawn_subagent", { role: "reviewer", task: "Review B" });
    const messages: any[] = [];
    turn(messages, "Review both", [a, b], ["", ""]);
    const session = { id: "s2", status: "idle", messages };
    const storeEvents = [
      { type: "subagent_spawned", agent_id: "sub_a", role: "reviewer", task: "Review A", tool_id: a.id },
      { type: "subagent_spawned", agent_id: "sub_b", role: "reviewer", task: "Review B", tool_id: b.id },
      { type: "subagent_done", agent_id: "sub_b", result: "B looks fine" },
    ];
    const result = buildFingerprintTrace(session, { sessionId: "s2", storeEvents });
    const nodeA = result.nodes.find((n: any) => n.id === a.id);
    const nodeB = result.nodes.find((n: any) => n.id === b.id);
    assert.equal(nodeA.subagentId, "sub_a");
    assert.equal(nodeB.subagentId, "sub_b");
    assert.equal(result.subagents.sub_b.summary, "B looks fine");
  });

  it("names in-flight tools from the live tool_start events", () => {
    const messages: any[] = [{ role: "user", content: "Run it", ts: "2026-10-15T00:40:00Z" }];
    const result = buildFingerprintTrace({ id: "s3", status: "running", messages }, {
      sessionId: "s3",
      activeEvents: [
        { type: "agent_started" },
        { type: "tool_start", tool_id: "t1", tool_name: "shell_exec" },
        { type: "tool_delta", tool_id: "t1", chunk: "{\"command\": \"npm " },
        { type: "tool_delta", tool_id: "t1", chunk: "test\"}" },
      ],
    });
    const node = result.nodes.find((n: any) => n.id === "t1");
    assert.equal(node.title, "npm test");
    assert.equal(node.status, "running");
    assert.equal(result.status, "running");
  });
});

describe("sensitive-path rule", () => {
  // Expected values come from andromity.core.security.is_sensitive_path.
  const core: Record<string, boolean> = {
    ".env": true, ".env.local": true, "src/secretary.ts": false, "x.keyboard.ts": false, "config/secrets.yaml": true,
    "/home/u/.ssh/config": true, "api_token.txt": true, "tokenizer.py": false, "secrets.py": true, "D:\\proj\\.git\\config": true,
    "README.md": false, "config.toml": true, "deploy/credentials": true, "passwords.json": true, "my.key": false,
    "id_rsa.pub": false, "/etc/passwd": true, "src/token-store.ts": false, "notes/token_list.md": true, ".envrc": false,
  };
  for (const [p, expected] of Object.entries(core)) {
    it(`${p} → ${expected}`, () => assert.equal(isSensitivePath(p), expected));
  }
});

it("fingerprint webview script parses", () => {
  assert.doesNotThrow(() => new Function(getFingerprintScript("s1")));
});
