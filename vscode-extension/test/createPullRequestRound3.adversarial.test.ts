// Round 3 (commit b8e1b57): git identity through vscode.git's local-only getConfig, the description draft against the
// engine's real agent.quickPrompt handler, and the "Use another account" button.
// Spec: DESIGN.md 3.4, 3.5, 4.1, 5.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installVscodeStub } from "./helpers/prVscodeStub.js";
import { CliApiRepository, gitOk, makeSandbox } from "./helpers/prRealGit.js";
import { MiniDocument, MiniElement, MiniWindow, dangerousNodes } from "./helpers/miniDom.js";

installVscodeStub();
const { VscodeGitPort } = require("../src/integrations/pullRequest/vscodeGit.js") as typeof import("../src/integrations/pullRequest/vscodeGit.js");
const { draftCommitAndDescription } = require("../src/integrations/GitCommit.js") as typeof import("../src/integrations/GitCommit.js");
const { prFormClient } = require("../src/providers/changesReview/prFormClient.js") as typeof import("../src/providers/changesReview/prFormClient.js");

describe("VscodeGitPort.config: local, then global (4.1)", () => {
  const port = (local: Record<string, unknown>, global?: Record<string, unknown>, throwLocal = false) => new VscodeGitPort({
    rootUri: { fsPath: "/r" }, state: { remotes: [], indexChanges: [] }, status: async () => {},
    getConfig: async (key: string) => { if (throwLocal) throw new Error("x"); return (local[key] as string) ?? ""; },
    ...(global ? { getGlobalConfig: async (key: string) => (global[key] as string) ?? "" } : {}),
  } as any, "/r");

  it("prefers the repository's value, falls back to the global one, ignores blanks, survives an old API", async () => {
    assert.equal(await port({ "user.name": "Local" }, { "user.name": "Global" }).config("user.name"), "Local");
    assert.equal(await port({}, { "user.name": "Global" }).config("user.name"), "Global");
    assert.equal(await port({ "user.name": "   " }, { "user.name": " Global " }).config("user.name"), "Global");
    assert.equal(await port({}, {}).config("user.name"), undefined);
    assert.equal(await port({}, undefined).config("user.name"), undefined, "VS Code builds without getGlobalConfig");
    assert.equal(await port({}, { "user.name": "Global" }, true).config("user.name"), "Global");
  });

  it("real git: local-only and global-only identities are both seen; an includeIf identity isn't (git commits with it anyway)", async () => {
    const sb = makeSandbox("orders");
    try {
      const repo = new CliApiRepository(sb.work, sb.env);
      const p = new VscodeGitPort(repo as any, sb.work);
      assert.equal(await p.config("user.name"), "Ada Tester");
      gitOk(sb.work, sb.env, ["config", "--local", "--unset", "user.name"]);
      gitOk(sb.work, sb.env, ["config", "--global", "user.name", "Global Ada"]);
      assert.equal(await p.config("user.name"), "Global Ada");
      gitOk(sb.work, sb.env, ["config", "--global", "--unset", "user.name"]);
      const inc = path.join(sb.dir, "work.gitconfig").replace(/\\/g, "/");
      fs.writeFileSync(inc, "[user]\n\tname = Work Ada\n");
      gitOk(sb.work, sb.env, ["config", "--global", `includeIf.gitdir:${sb.work.replace(/\\/g, "/")}/.path`, inc]);
      assert.equal(gitOk(sb.work, sb.env, ["config", "user.name"]), "Work Ada", "git itself resolves the includeIf identity");
      const seen = await p.config("user.name");
      // Documented, not asserted as a failure: vscode.git's getGlobalConfig runs `git config --global --get`,
      // which doesn't follow includes, so this identity is invisible to the form (only a muted note now).
      assert.equal(seen, undefined);
    } finally {
      sb.cleanup();
    }
  });
});

const PY = process.env.ANDROMITY_E2E_PYTHON || "D:\\saas\\agent\\.venv\\Scripts\\python.exe";
const ENGINE_SRC = path.resolve(__dirname, "..", "..", "..", "src");
const PROBE = String.raw`import asyncio, json, sys, types
sys.path.insert(0, sys.argv[1])
params = json.loads(sys.argv[2])
answer = json.loads(sys.argv[3])
seen = {}
class Msg:
    def __init__(self, content, reasoning):
        self.content = content
        self.reasoning_content = reasoning
class Choice:
    def __init__(self, content, reasoning):
        self.message = Msg(content, reasoning)
class Resp:
    def __init__(self, content, reasoning):
        self.choices = [Choice(content, reasoning)]
def completion(**kwargs):
    seen["max_tokens"] = kwargs.get("max_tokens")
    return Resp(answer.get("content", ""), answer.get("reasoning"))
try:
    import litellm
    litellm.completion = completion
except Exception:
    fake = types.ModuleType("litellm")
    fake.completion = completion
    sys.modules["litellm"] = fake
from andromity.server.rpc_handler import JsonRpcHandler
async def main():
    try:
        result = await JsonRpcHandler.rpc_agent_quickPrompt(None, params)
        print("@@" + json.dumps({"ok": True, "result": result, "max_tokens": seen.get("max_tokens")}))
    except Exception as e:
        print("@@" + json.dumps({"ok": False, "error": str(e), "max_tokens": seen.get("max_tokens")}))
asyncio.run(main())
`;

/** Runs the engine's real rpc_agent_quickPrompt with litellm stubbed and a throwaway config dir. */
function engineQuickPrompt(params: unknown, answer: { content: string; reasoning?: string }): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-qp-"));
  try {
    const script = path.join(dir, "probe.py");
    fs.writeFileSync(script, PROBE);
    const env: NodeJS.ProcessEnv = { ...process.env, ANDROMITY_CONFIG_DIR: path.join(dir, "cfg"), APPDATA: dir, LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir };
    delete env.ANDROMITY_AIRGAP;
    const r = spawnSync(PY, ["-I", script, ENGINE_SRC, JSON.stringify(params), JSON.stringify(answer)], { env, encoding: "utf8", timeout: 90_000, windowsHide: true });
    const line = (r.stdout || "").split("\n").find((l) => l.startsWith("@@"));
    if (!line) throw new Error(`engine probe failed: ${r.stderr?.slice(-1500)}`);
    return JSON.parse(line.slice(2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function draftThroughEngine(withDescription: boolean, answer: { content: string; reasoning?: string }, rewrite?: (p: any) => any) {
  let sent: any = null;
  const rpc = { call: async (_method: string, params: any) => {
    sent = rewrite ? rewrite(params) : params;
    const out = engineQuickPrompt(sent, answer);
    if (!out.ok) throw new Error(out.error);
    return out.result;
  } };
  const draft = await draftCommitAndDescription(rpc as any, { diff: "+x\n", files: ["a.ts"], projectPath: "/p", withDescription });
  return { draft, sent };
}

describe("drafting against the engine's real agent.quickPrompt (3.4, 3.5)", { timeout: 300_000 }, () => {
  const tagged = "Some preamble the model wrote.\n<commit_message>\nfix(orders): round totals\n\n- Quantize\n</commit_message>\n<pr_description>\nRounds order totals to cents.\n\n- Adds tests\n</pr_description>";

  it("the parameters the extension sends make the engine return the description, and it is extracted", { skip: !fs.existsSync(PY) && `no engine Python at ${PY}` }, async () => {
    const { draft, sent } = await draftThroughEngine(true, { content: tagged });
    assert.equal(sent.raw, true);
    assert.equal(draft.commitMessage, "fix(orders): round totals\n\n- Quantize");
    assert.equal(draft.description, "Rounds order totals to cents.\n\n- Adds tests");
  });

  it("the old non-raw call loses the description in the engine (the founder's bug), so raw is required", { skip: !fs.existsSync(PY) && `no engine Python at ${PY}` }, async () => {
    const { draft } = await draftThroughEngine(true, { content: tagged }, (p) => { const { raw, max_tokens, ...rest } = p; return rest; });
    assert.equal(draft.description, "");
  });

  it("commit-only drafts stay on the engine's commit-message path", { skip: !fs.existsSync(PY) && `no engine Python at ${PY}` }, async () => {
    const { draft, sent } = await draftThroughEngine(false, { content: "<commit_message>feat: add x</commit_message>" });
    assert.equal(sent.raw, undefined);
    assert.equal(draft.commitMessage, "feat: add x");
  });

  it("raw mode: a model that echoes the format instructions before answering still gives the real blocks", { skip: !fs.existsSync(PY) && `no engine Python at ${PY}` }, async () => {
    const echo = "I must wrap the commit message in a <commit_message> opening tag and a matching closing tag, and the description in <pr_description> and </pr_description>.\n" + tagged;
    const { draft } = await draftThroughEngine(true, { content: echo });
    assert.equal(draft.commitMessage, "fix(orders): round totals\n\n- Quantize");
    assert.equal(draft.description, "Rounds order totals to cents.\n\n- Adds tests");
  });

  it("raw mode: a reasoning model that puts everything in its reasoning still gives the final blocks", { skip: !fs.existsSync(PY) && `no engine Python at ${PY}` }, async () => {
    const reasoning = "Let me think. Draft: <commit_message>chore: wrong first try</commit_message>\nBetter:\n" + tagged;
    const { draft } = await draftThroughEngine(true, { content: "", reasoning });
    assert.equal(draft.commitMessage, "fix(orders): round totals\n\n- Quantize");
    assert.equal(draft.description, "Rounds order totals to cents.\n\n- Adds tests");
  });

  it("raw mode: the description never ends up inside the commit message", { skip: !fs.existsSync(PY) && `no engine Python at ${PY}` }, async () => {
    const swapped = "<pr_description>\nDescription first.\n</pr_description>\n<commit_message>\nfeat: second\n</commit_message>";
    const { draft } = await draftThroughEngine(true, { content: swapped });
    assert.equal(draft.commitMessage, "feat: second");
    assert.equal(draft.description, "Description first.");
    const untagged = "feat: no tags at all\n\nDescription paragraph the model wrote without tags.";
    const second = await draftThroughEngine(true, { content: untagged });
    assert.ok(!/Description paragraph/.test(second.draft.commitMessage) || second.draft.description === "", JSON.stringify(second.draft));
  });
});

describe("webview: Use another account", () => {
  it("is shown only when switchable, escapes the login, and sends pr_switch_account", () => {
    const doc = new MiniDocument('<header id="review-header"></header><button id="pr-open-btn" hidden></button><aside id="pr-sheet" hidden></aside>');
    const win = new MiniWindow();
    (globalThis as any).document = doc;
    (globalThis as any).window = win;
    const sent: any[] = [];
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    prFormClient({ postMessage: (m) => sent.push(m) }, { escapeHtml: esc, scope: () => "all", selectFile: () => {} });
    const form = (account: unknown) => ({
      title: "Create pull request", repo: { display: "github.com/a/b", visibility: "private" }, account, accountNote: null, update: null, base: "main", baseOptions: ["main"],
      branch: { current: "main", mustCreate: true, create: true, note: "", nameProblem: null }, latest: null, notes: [], scope: "all", hasTurn: false, turnCount: 0, allCount: 1,
      files: [], sizeLine: { text: "", tone: "muted" }, leftOverLine: null, stagedOutside: null, drafting: false, draftNote: null, commitAi: false, coAuthor: false,
      showPullFields: true, descriptionLabel: "", descriptionHint: null, chips: [], reviewers: { show: false, suggestions: [], problems: [] },
      receipt: { show: false, available: false, reason: null, attach: false, label: "", summary: null, preview: null }, publicNote: null, draft: { show: false, on: false },
      checks: null, primary: { label: "Create pull request", enabled: true }, secondary: [], disabledReason: null, plan: "",
    });
    win.message({ type: "pr_view", view: { phase: "form", form: form({ kind: "signed_in", login: "<img src=x onerror=1>", switchable: false }) } });
    assert.equal(doc.querySelector("[data-pr-switch-account]"), null);
    win.message({ type: "pr_view", view: { phase: "form", form: form({ kind: "signed_in", login: "<img src=x onerror=1>", switchable: true }) } });
    assert.deepEqual(dangerousNodes(doc), []);
    (doc.querySelector("[data-pr-switch-account]") as MiniElement).click();
    assert.deepEqual(sent.at(-1), { type: "pr_switch_account" });
  });
});
