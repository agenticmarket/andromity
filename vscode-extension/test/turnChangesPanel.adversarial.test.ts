// Independent adversarial tests for Changes Review's Turn mode on the host side (ChangesReviewPanel):
// stale answers, hostile engine data, which paths may be diffed or opened, and that the PR form keeps using
// the uncommitted files.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installVscodeStub, resetState, state, vscodeStub } from "./helpers/prVscodeStub.js";

installVscodeStub();
const { ChangesReviewPanel } = require("../src/panels/ChangesReviewPanel.js") as typeof import("../src/panels/ChangesReviewPanel.js");

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function panel(rpcCall: (method: string, params: any) => Promise<any>) {
  const p: any = Object.create(ChangesReviewPanel.prototype);
  const posts: any[] = [];
  const calls: { method: string; params: any }[] = [];
  Object.assign(p, {
    _rpcClient: { call: (method: string, params: any) => { calls.push({ method, params }); return rpcCall(method, params); } },
    _turn: { sessionId: "s1", turnIndex: 0 }, _turnView: null, _turnSeq: 0, _isDisposed: false, _projectPath: "/repo", _repositoryRoot: "/repo",
    _knownFiles: new Set(["src/a.py"]), _pr: { markOpened() {}, turnChanged() {}, filesChanged() {}, refreshView() {} },
  });
  p._postMessage = (m: any) => posts.push(m);
  return { p, posts, calls };
}

const file = (path: string, now = "uncommitted") => ({ path, status: "M", additions: 1, deletions: 1, binary: false, now });

beforeEach(() => resetState());

describe("turn view: stale answers", () => {
  it("an older turn's slow answer never replaces the newer turn's list", async () => {
    const slow = deferred<any>();
    const { p, posts } = panel(async (_m, params) => (params.turn_index === 0 ? slow.promise : { success: true, files: [file("b.py")] }));
    const first = p._loadTurnChanges();
    p._turn = { sessionId: "s1", turnIndex: 1 };
    await p._loadTurnChanges();
    slow.resolve({ success: true, files: [file("a.py")] });
    await first;
    assert.deepEqual(p._turnView.files.map((f: any) => f.path), ["b.py"]);
    assert.deepEqual(posts.filter((m) => m.type === "set_turn_changes").map((m) => m.turnView?.turnIndex), [1]);
  });

  it("a diff that arrives after the view reloaded isn't shown, and the file can be asked again", async () => {
    const slow = deferred<any>();
    const { p, posts, calls } = panel(async (method) => (method === "git.turn_changes" ? { success: true, files: [file("src/a.py")] } : slow.promise));
    await p._loadTurnChanges();
    const pending = p._loadTurnFileDiff("src/a.py");
    await p._loadTurnChanges();
    slow.resolve({ diff: "@@ -1 +1 @@\n-a\n+b" });
    await pending;
    assert.equal(posts.filter((m) => m.type === "set_turn_file_diff").length, 0);
    await p._loadTurnFileDiff("src/a.py");
    assert.equal(calls.filter((c) => c.method === "git.turn_file_diff").length, 2);
  });

  it("no turn number, no engine, or an engine error: no turn view (falls back to the uncommitted list)", async () => {
    for (const setup of [(p: any) => { p._turn = { sessionId: "s1", turnIndex: null }; }, (p: any) => { p._rpcClient = null; }, (p: any) => { p._turn = null; }]) {
      const { p } = panel(async () => ({ success: true, files: [file("a.py")] }));
      p._turnView = { turnIndex: 0, files: [] };
      setup(p);
      await p._loadTurnChanges();
      assert.equal(p._turnView, null);
    }
    const { p } = panel(async () => { throw new Error("engine down"); });
    await p._loadTurnChanges();
    assert.equal(p._turnView, null);
  });
});

describe("turn view: data from the engine is checked", () => {
  it("drops bad entries, caps the list, and never trusts 'now' or counts it doesn't understand", async () => {
    const hostile = [
      { path: "ok.py", status: "Mxx", additions: -5, deletions: 1.5, now: "uncommitted" }, { path: "a\0b" }, { path: "x".repeat(5000) }, { path: 5 },
      { path: "weird.py", now: "approved" }, { path: "<img src=x onerror=1>.py", now: "committed" },
      ...Array.from({ length: 600 }, (_, i) => ({ path: `f${i}.py` })),
    ];
    const { p } = panel(async () => ({ success: true, files: hostile }));
    await p._loadTurnChanges();
    const files = p._turnView.files;
    assert.ok(files.length <= 500);
    assert.deepEqual(files[0], { path: "ok.py", name: "ok.py", status: "M", additions: 0, deletions: 0, binary: false, now: "uncommitted" });
    assert.equal(files.find((f: any) => f.path === "weird.py").now, "unknown");
    assert.ok(!files.some((f: any) => f.path.includes("\0") || f.path.length > 4096));
  });

  it("diffs only files in the current turn's list, for the current turn", async () => {
    const { p, calls } = panel(async (method) => (method === "git.turn_changes" ? { success: true, files: [file("src/a.py")] } : { diff: "" }));
    await p._loadTurnChanges();
    for (const path of ["src/b.py", "../../etc/passwd", "SRC/A.PY", ""]) await p._loadTurnFileDiff(path);
    assert.equal(calls.filter((c) => c.method === "git.turn_file_diff").length, 0);
    p._turn = { sessionId: "s1", turnIndex: 1 };
    await p._loadTurnFileDiff("src/a.py");
    assert.equal(calls.filter((c) => c.method === "git.turn_file_diff").length, 0, "diffed the old turn's file after the turn changed");
  });

  it("opens in the editor only files inside the repository, even if the engine lists another path", async () => {
    const opened: string[] = [];
    const original = (vscodeStub.workspace as any).openTextDocument;
    (vscodeStub.workspace as any).openTextDocument = async (uri: any) => { opened.push(uri.fsPath); return { uri }; };
    try {
      const { p } = panel(async () => ({ success: true, files: [file("src/a.py"), file("../outside/secret.txt"), file("C:/Windows/win.ini")] }));
      await p._loadTurnChanges();
      await p._openFileInEditor("../outside/secret.txt");
      await p._openFileInEditor("C:/Windows/win.ini");
      assert.deepEqual(opened, [], `opened a path outside the repository: ${opened.join(", ")}`);
    } finally {
      (vscodeStub.workspace as any).openTextDocument = original;
    }
  });
});

describe("turn view: Discard and the PR form", () => {
  it("Discard still only accepts files in the uncommitted list (a committed turn file can't be discarded)", async () => {
    const { p, calls } = panel(async (method) => (method === "git.turn_changes" ? { success: true, files: [file("src/old.py", "committed")] } : { success: true }));
    await p._loadTurnChanges();
    state.answers = ["Discard Changes"];
    await p._revertFile("src/old.py");
    assert.equal(calls.filter((c) => c.method === "git.revert_file").length, 0);
  });

  it("the Discard warning says it removes all of the file's changes, not just this turn's", async () => {
    const { p } = panel(async () => ({ success: true }));
    await p._revertFile("src/a.py");
    assert.match(state.warnings.at(-1)!, /Discard all staged and unstaged changes/);
  });
});
