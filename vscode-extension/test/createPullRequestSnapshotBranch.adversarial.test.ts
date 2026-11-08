// Adversarial tests for the guards against working on `andromity-snapshots` (Andromity's undo-snapshot branch):
// the flow's plan check and the once-per-repository warning. Controller tests are in createPullRequestController.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installVscodeStub, resetState, state, vscodeStub } from "./helpers/prVscodeStub.js";
import { FakeGit, FakeGitHub } from "./helpers/prFakes.js";

installVscodeStub();
const { runPlan, fingerprintOf } = require("../src/integrations/pullRequest/flow.js") as typeof import("../src/integrations/pullRequest/flow.js");
const { parseRemoteUrl } = require("../src/integrations/pullRequest/remotes.js") as typeof import("../src/integrations/pullRequest/remotes.js");
const { warnIfOnSnapshotBranch } = require("../src/integrations/snapshotBranchWarning.js") as typeof import("../src/integrations/snapshotBranchWarning.js");

beforeEach(() => resetState());

describe("flow: the snapshot branch is never a branch or base of a plan", () => {
  const plan = (overrides: Record<string, unknown>) => ({
    mode: "pull_request", remote: "origin", parsed: parseRemoteUrl("https://github.com/acme/orders.git"), target: { owner: "acme", repo: "orders" },
    headOwner: "acme", base: "main", branch: "andromity/x", createBranch: true, files: ["a.ts"], unstageFirst: [],
    fingerprints: { "a.ts": fingerprintOf(Buffer.from("v1")) }, commitMessage: "fix: x", signoff: false, title: "t", bodyFor: () => "",
    draft: false, reviewers: [], teams: [], existingPull: null, commentFor: null, ...overrides,
  }) as any;
  const deps = (git: FakeGit) => ({ git, github: new FakeGitHub().client(), readFile: async () => Buffer.from("v1"), fileDiff: async () => null, airGap: { enabled: false, allowedHosts: [] }, enterpriseHosts: [] });

  for (const overrides of [{ branch: "andromity-snapshots" }, { branch: "Andromity-Snapshots" }, { base: "andromity-snapshots" },
    { base: "ANDROMITY-SNAPSHOTS" }, { branch: "andromity-snapshots", createBranch: false }]) {
    it(`refuses ${JSON.stringify(overrides)} before touching git`, async () => {
      const git = new FakeGit();
      if (overrides.createBranch === false) git.branch = "andromity-snapshots";
      await assert.rejects(runPlan(deps(git), plan(overrides), {}));
      assert.deepEqual(git.mutating(), []);
    });
  }

  it("allows lookalike names", async () => {
    for (const branch of ["andromity-snapshots2", "my/andromity-snapshots", "andromity/snapshots"]) {
      const git = new FakeGit();
      await runPlan(deps(git), plan({ branch }), {});
      assert.ok(git.mutating().includes("push"), branch);
    }
  });
});

describe("warning when a repository is on the snapshot branch", () => {
  let batch = 0;
  const api = (names: (string | undefined)[], keepRoots = false) => {
    if (!keepRoots) batch++;
    const exportsApi = { enabled: true, getAPI: () => ({ repositories: names.map((name, i) => ({ rootUri: { fsPath: `/b${batch}/r${i}` }, state: { HEAD: name === undefined ? undefined : { type: 0, name }, remotes: [], indexChanges: [] } })) }) };
    state.gitExtension = { isActive: true, exports: exportsApi, activate: async () => exportsApi };
  };

  it("warns once per repository per window, offers the picker, and never switches by itself", async () => {
    api(["andromity-snapshots", "main", undefined, "andromity-snapshots"]);
    const original = vscodeStub.window.showWarningMessage;
    let answer: string | undefined;
    (vscodeStub.window as any).showWarningMessage = async (text: string) => { state.warnings.push(text); return answer; };
    try {
      await warnIfOnSnapshotBranch();
      assert.equal(state.warnings.length, 2, "one warning for each repository on the branch");
      assert.deepEqual(state.commands, [], "dismissing the warning must not run anything");
      await warnIfOnSnapshotBranch();
      assert.equal(state.warnings.length, 2, "warned again in the same window");
      answer = "Switch branch";
      api(["main", "main", "main", "main", "andromity-snapshots"], true);
      await warnIfOnSnapshotBranch();
      const commands = state.commands as { command: string }[];
      assert.deepEqual(commands.map((c) => c.command), ["git.checkout"], "only VS Code's own picker, chosen by the user");
    } finally {
      (vscodeStub.window as any).showWarningMessage = original;
    }
  });

  it("also warns when the branch is checked out under another case (Windows and macOS open the same ref)", async () => {
    api(["Andromity-Snapshots"]);
    await warnIfOnSnapshotBranch();
    assert.equal(state.warnings.length, 1, "no warning for Andromity-Snapshots, which on a case-insensitive file system is the snapshot branch");
  });

  it("Git off or missing: no warning, no error", async () => {
    state.gitExtension = undefined;
    await warnIfOnSnapshotBranch();
    const disabled = { enabled: false, getAPI: () => ({ repositories: [] }) };
    state.gitExtension = { isActive: true, exports: disabled, activate: async () => disabled };
    await warnIfOnSnapshotBranch();
    assert.deepEqual(state.warnings, []);
  });
});
