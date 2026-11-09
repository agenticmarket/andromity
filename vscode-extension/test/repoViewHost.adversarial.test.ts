// Independent adversarial tests for where the Pull Requests and Issues view's Review and Ask land in the chat:
// questions must never become postable reviews (also after the engine reloads the chat's label), and a review's
// label must still name the same pull request after the engine stores it.
// Spec: private/design/repo-view/DESIGN.md 1 (every GitHub write), 5 (Review/Ask); engine: read_external_context.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installVscodeStub } from "./helpers/prVscodeStub.js";

installVscodeStub();
const review = require("../src/integrations/pullRequest/reviewPullRequest.js") as typeof import("../src/integrations/pullRequest/reviewPullRequest.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");

/** The engine's label rule (src/andromity/core/tools.py read_external_context): unsafe characters removed, then cut at 120. */
function engineLabel(source: string): string | null {
  const cleaned = source.replace(/[^A-Za-z0-9_.:/#@-]/g, "");
  const label = cleaned.length > 200 ? "github:" : cleaned;
  return label.startsWith("github:") ? label : null;
}

function provider(calls: any[]) {
  const p: any = Object.create(ChatViewProvider.prototype);
  let created = 0;
  Object.assign(p, {
    _currentSessionId: "s1", _runningSessions: new Set<string>(), _currentModel: "m", _currentProvider: "p",
    _currentMode: "yolo", _currentProfile: "builder", _currentReasoning: "medium",
    _pendingExternal: new Map(), _reviewSessions: new Map(), _sessionNames: new Map(),
    _postToWebview: () => {},
    _rpcClient: { call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "session.create") return { id: `r${++created}`, name: params.name };
      if (method === "session.get") return p.engineSessions?.[params.session_id] ?? null;
      return {};
    } },
  });
  p.fetchAndPostSessions = async () => {};
  p.sendPromptFromExternal = async (_prompt: string, _ctx: unknown, options: any) => { p._currentSessionId = options.targetSessionId; };
  return p;
}

describe("a question is a read-only chat, never a review that can be posted", () => {
  it("Ask's chat gets the GitHub text once and isn't registered as a review", async () => {
    const calls: any[] = [];
    const p = provider(calls);
    const prompt = "About pull request #7 in acme/orders (attached): What could this break?";
    const external = { source: "github:acme/orders/pull-question#7", text: "material" };
    await p.reviewHost().startExternalTask(prompt, external, "Ask about #7", null);
    await p._handleWebviewMessage({ type: "send_prompt", prompt, sessionId: "r1" });
    const sent = calls.filter((c) => c.method === "agent.prompt").map((c) => c.params);
    assert.deepEqual(sent.map((s) => [s.session_id, s.external_context?.source]), [["r1", "github:acme/orders/pull-question#7"]]);
    assert.equal(await p.reviewHost().reviewIn("r1"), null);
  });

  it("after a restart, the engine's stored question label is not read as a review target", async () => {
    const p = provider([]);
    const long = "b".repeat(100);
    p.engineSessions = {
      pr: { external_review: engineLabel("github:acme/orders/pull-question#7") },
      issue: { external_review: engineLabel("github:acme/orders/issue-question#9") },
      long: { external_review: engineLabel(`github:acme/${long}/pull-question#7`) },
    };
    for (const sid of ["pr", "issue", "long"]) assert.equal(await p.reviewHost().reviewIn(sid), null, sid);
  });
});

describe("a review's label after the engine stores it (Edit and post after a restart)", () => {
  async function reviewSource(owner: string, repo: string, number: number): Promise<{ source: string; target: any }> {
    const started: any[] = [];
    const host = { startExternalTask: async (...args: any[]) => { started.push(args); }, reviewIn: async () => null, lastAnswer: async () => null };
    const github = {
      pullDetail: async () => ({ number, title: "t", author: "mallory", draft: false, headRef: "f", baseRef: "main", body: "", additions: 1, deletions: 1, changedFiles: 1 }),
      pullDiff: async () => ({ diff: "", cut: false }),
    };
    await review.startReview(host as any, github as any, { owner, repo }, number, "");
    return { source: started[0][1].source, target: started[0][3] };
  }

  it("the stored label names the same pull request, or none, for the longest owner and repository names GitHub allows", async () => {
    for (const [owner, repo, number] of [["acme", "orders", 7], ["o".repeat(39), "r".repeat(70), 12345], ["o".repeat(39), "r".repeat(100), 1], ["o".repeat(39), "r".repeat(75), 4567890123]] as const) {
      const { source, target } = await reviewSource(owner, repo, number);
      const after = review.reviewTargetFromLabel(engineLabel(source));
      if (after) assert.deepEqual([after.owner, after.repo, after.number], [target.owner, target.repo, target.number], `${source.length} chars: ${source.slice(-20)} became ...${engineLabel(source)!.slice(-20)}`);
    }
  });
});
