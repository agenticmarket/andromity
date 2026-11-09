// Independent adversarial tests for the Create pull request webview client (prFormClient), run in a tiny DOM.
// Spec: private/design/create-pr/DESIGN.md 3 (form), 3.1 / 3.4 (a late draft never overwrites the user's text),
// 4.2 / 4.3 (steps, done), 5 (failure views), and the webview being an untrusted renderer of host data.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prFormClient } from "../src/providers/changesReview/prFormClient.js";
import { getReviewClientScript } from "../src/providers/changesReview/reviewClientScript.js";
import { MiniDocument, MiniElement, MiniEvent, MiniWindow, dangerousNodes } from "./helpers/miniDom.js";

const EVIL = `"><img src=x onerror=alert(1)><script>alert(2)</script>'&`;

// The real escapeHtml the review webview passes in, taken from the shipped script.
const escapeSource = /function escapeHtml\(text\) \{[\s\S]*?\n    \}/.exec(getReviewClientScript())![0];
const escapeHtml = new Function(`${escapeSource}; return escapeHtml;`)() as (t: string) => string;

let doc: MiniDocument;
let win: MiniWindow;
let sent: any[];
let selected: string[];

function boot() {
  doc = new MiniDocument('<header id="review-header"></header><button id="pr-open-btn" hidden></button><aside id="pr-sheet" hidden></aside>');
  win = new MiniWindow();
  (globalThis as any).document = doc;
  (globalThis as any).window = win;
  sent = [];
  selected = [];
  prFormClient({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) }, {
    escapeHtml,
    scope: () => "turn",
    selectFile: (p) => selected.push(p),
  });
}

const $ = (id: string) => doc.getElementById(id) as MiniElement;
const sheet = () => $("pr-sheet");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formView(overrides: Record<string, unknown> = {}): any {
  return {
    title: "Create pull request",
    repo: { display: "github.com/acme/orders", visibility: "public" },
    account: { kind: "signed_in", login: "ada" },
    accountNote: null,
    update: null,
    base: "main",
    baseOptions: ["main", "develop"],
    branch: { current: "main", mustCreate: true, create: true, note: "You're on main, so this goes on a new branch.", nameProblem: null },
    latest: null,
    notes: [],
    scope: "turn",
    hasTurn: true,
    turnCount: 2,
    allCount: 3,
    files: [
      { path: "orders/totals.py", status: "M", additions: 3, deletions: 1, binary: false, checked: true, tags: [], notOpened: true },
      { path: ".env", status: "M", additions: 1, deletions: 1, binary: false, checked: false, tags: [{ text: "sensitive · left out", tone: "danger" }], notOpened: false },
    ],
    sizeLine: { text: "4 lines changed in 1 file.", tone: "muted" },
    leftOverLine: null,
    stagedOutside: null,
    drafting: false,
    draftNote: null,
    commitAi: false,
    coAuthor: true,
    showPullFields: true,
    descriptionLabel: "",
    descriptionHint: null,
    chips: [],
    reviewers: { show: true, suggestions: ["priya"], problems: [] },
    receipt: { show: true, available: true, reason: null, attach: true, label: "Add an AI change record", summary: "Receipt · turn 1", preview: "### Receipt" },
    publicNote: null,
    draft: { show: true, on: false },
    checks: null,
    primary: { label: "Create pull request", enabled: true },
    secondary: [{ id: "commit_only", label: "Commit only" }],
    disabledReason: null,
    plan: "Commits 1 file to the new branch andromity/x, pushes it to origin and opens a pull request into main on acme/orders.",
    ...overrides,
  };
}

const showForm = (overrides: Record<string, unknown> = {}) => win.message({ type: "pr_view", view: { phase: "form", form: formView(overrides) } });

beforeEach(boot);

describe("webview: renders every phase from host messages, escaping everything", () => {
  it("hostile text in every field of every phase never becomes markup", () => {
    win.message({ type: "pr_button", state: { visible: true, enabled: true, label: EVIL, reason: EVIL } });
    win.message({ type: "pr_view", view: { phase: "loading" } });
    win.message({ type: "pr_view", view: { phase: "blocked", blocked: { title: EVIL, message: EVIL, actions: [{ id: EVIL, label: EVIL }] } } });
    assert.deepEqual(dangerousNodes(doc), []);
    showForm({
      title: EVIL, repo: { display: EVIL, visibility: "public" }, account: { kind: "signed_in", login: EVIL }, accountNote: EVIL,
      update: { number: EVIL, title: EVIL }, base: EVIL, baseOptions: [EVIL, "main"],
      branch: { current: EVIL, mustCreate: false, create: false, note: EVIL, nameProblem: EVIL },
      latest: { show: true, enabled: true, on: true, label: EVIL, note: EVIL }, notes: [{ text: EVIL, tone: "warn" }],
      turnCount: EVIL, allCount: EVIL,
      files: [{ path: EVIL, status: EVIL, additions: EVIL, deletions: EVIL, binary: false, checked: true, tags: [{ text: EVIL, tone: EVIL }], notOpened: true }],
      sizeLine: { text: EVIL, tone: "warn" }, leftOverLine: EVIL, stagedOutside: { paths: [EVIL], choice: null }, draftNote: EVIL,
      descriptionLabel: EVIL, descriptionHint: EVIL, chips: [EVIL], reviewers: { show: true, suggestions: [EVIL], problems: [EVIL] },
      receipt: { show: true, available: true, reason: EVIL, attach: true, label: EVIL, summary: EVIL, preview: EVIL }, publicNote: EVIL,
      checks: { items: [{ label: EVIL, text: EVIL, path: EVIL, line: EVIL }, { label: "High", text: EVIL, subject: EVIL }], notes: [EVIL], key: EVIL, acked: false },
      primary: { label: EVIL, enabled: true }, secondary: [{ id: EVIL, label: EVIL }], disabledReason: EVIL, plan: EVIL,
    });
    (doc.querySelector("[data-pr-preview]") as MiniElement).click();
    assert.deepEqual(dangerousNodes(doc), [], "markup injected in the form");
    assert.ok(sheet().textContent.includes(`<img src=x onerror=alert(1)>`), "hostile text is shown as text");
    const steps = [{ id: "push", label: EVIL, status: EVIL }, { id: "pull", label: EVIL, status: "failed" }];
    win.message({ type: "pr_view", view: { phase: "running", run: { title: EVIL, steps, cancellable: true, note: EVIL } } });
    assert.deepEqual(dangerousNodes(doc), []);
    win.message({ type: "pr_view", view: { phase: "done", done: { title: EVIL, heading: EVIL, url: `https://${EVIL}`, lines: [EVIL], actions: [{ id: EVIL, label: EVIL, primary: true }], steps, footnote: EVIL } } });
    assert.deepEqual(dangerousNodes(doc), []);
    win.message({ type: "pr_view", view: { phase: "failed", failed: { title: EVIL, heading: EVIL, message: EVIL, actions: [{ id: EVIL, label: EVIL }], steps } } });
    assert.deepEqual(dangerousNodes(doc), []);
    win.message({ type: "pr_view", view: { phase: "closed" } });
    assert.equal(sheet().hidden, true);
    assert.equal(sheet().innerHTML, "");
  });

  it("a path with quotes round-trips exactly through data attributes (Open, checkbox, check item)", () => {
    const tricky = `a"b'c&d<e>.ts`;
    showForm({
      files: [{ path: tricky, status: "M", additions: 1, deletions: 0, binary: false, checked: true, tags: [], notOpened: true }],
      checks: { items: [{ label: "Secret", text: "Looks like an AWS access key", path: tricky, line: 3 }], notes: [], key: "k1", acked: false },
    });
    for (const el of doc.querySelectorAll("[data-pr-show]")) el.click();
    assert.ok(selected.length >= 2 && selected.every((p) => p === tricky), JSON.stringify(selected));
    const box = doc.querySelector("[data-pr-file]") as MiniElement;
    box.click();
    assert.deepEqual(sent.at(-1), { type: "pr_update", changes: { file: { path: tricky, checked: false } } });
  });

  it("the acknowledgement sends exactly the host's key, and null when unticked", () => {
    showForm({ checks: { items: [{ label: "High", text: "x" }], notes: [], key: "abc123", acked: false } });
    const ack = doc.querySelector("[data-pr-ack]") as MiniElement;
    ack.click();
    assert.deepEqual(sent.at(-1), { type: "pr_update", changes: { ack: "abc123" } });
    ack.click();
    assert.deepEqual(sent.at(-1), { type: "pr_update", changes: { ack: null } });
  });

  it("a disabled main button doesn't submit", () => {
    showForm({ primary: { label: "Create pull request", enabled: false }, disabledReason: "Tick “I've checked these” to continue." });
    (doc.querySelector('[data-pr-submit="primary"]') as MiniElement).click();
    assert.ok(!sent.some((m) => m.type === "pr_submit"));
  });
});

describe("webview: the user's text is theirs (3.1, 3.4)", () => {
  it("a late draft never overwrites typed text; untouched fields are filled", async () => {
    showForm();
    $("prf-commit").type_("feat: my own words");
    $("prf-title-input").type_("My title");
    win.message({ type: "pr_field", field: "commitMessage", value: "fix(orders): drafted" });
    win.message({ type: "pr_field", field: "title", value: "fix(orders): drafted" });
    win.message({ type: "pr_field", field: "description", value: "Drafted description" });
    win.message({ type: "pr_field", field: "branchName", value: "andromity/drafted" });
    assert.equal($("prf-commit").value, "feat: my own words");
    assert.equal($("prf-title-input").value, "My title");
    assert.equal($("prf-desc").value, "Drafted description");
    assert.equal($("prf-branch").value, "andromity/drafted");
    await sleep(300);
    assert.ok(sent.some((m) => m.type === "pr_update" && m.changes.commitMessage === "feat: my own words"));
  });

  it("typed text survives a layout change (signing in adds reviewers, an open pull request hides fields)", () => {
    showForm({ reviewers: { show: false, suggestions: [], problems: [] } });
    $("prf-commit").type_("typed commit");
    $("prf-desc").type_("typed description");
    showForm({ reviewers: { show: true, suggestions: ["priya"], problems: [] } });
    assert.equal($("prf-commit").value, "typed commit");
    assert.equal($("prf-desc").value, "typed description");
  });

  it("submit sends only fields the user typed in, so the host's own values aren't clobbered by stale DOM text", () => {
    showForm();
    win.message({ type: "pr_field", field: "commitMessage", value: "fix: drafted" });
    $("prf-title-input").type_("Typed title");
    (doc.querySelector('[data-pr-submit="primary"]') as MiniElement).click();
    const submit = sent.find((m) => m.type === "pr_submit");
    assert.deepEqual(submit, { type: "pr_submit", action: "primary", form: { reviewers: [], title: "Typed title" } });
  });

  it("'Create a new branch instead' shows the suggested branch name in the new field (host sends the field, then the view)", () => {
    showForm({ branch: { current: "feature/x", mustCreate: false, create: false, note: "Commits onto feature/x, your current branch.", nameProblem: null } });
    (doc.querySelector("[data-pr-new-branch]") as MiniElement).click();
    assert.deepEqual(sent.at(-1), { type: "pr_update", changes: { createBranch: true } });
    // PullRequestController.applyUpdate posts pr_field(branchName) and only afterwards the new pr_view.
    win.message({ type: "pr_field", field: "branchName", value: "andromity/update-totals" });
    showForm({ branch: { current: "feature/x", mustCreate: false, create: true, note: "A new branch from feature/x.", nameProblem: null } });
    assert.equal($("prf-branch").value, "andromity/update-totals", "the new branch field is empty although the plan names a branch");
  });

  it("reviewer chips: split on spaces and commas, no duplicates, capped, removable", () => {
    showForm();
    const input = $("prf-reviewer-input");
    input.value = "@alice, bob  BOB acme/backend";
    input.dispatchEvent(new MiniEvent("keydown", { key: "Enter" }));
    assert.deepEqual(sent.at(-1).changes.reviewers, ["@alice", "bob", "acme/backend"]);
    input.value = Array.from({ length: 40 }, (_, i) => `u${i}`).join(",");
    input.dispatchEvent(new MiniEvent("keydown", { key: "Enter" }));
    assert.equal(sent.at(-1).changes.reviewers.length, 30);
    (doc.querySelector('[data-pr-remove-reviewer="0"]') as MiniElement).click();
    assert.equal(sent.at(-1).changes.reviewers[0], "bob");
  });

  it("Escape closes the form, but not while running; closing while running asks to cancel", () => {
    showForm();
    win.dispatch("keydown", { key: "Escape" });
    assert.deepEqual(sent.at(-1), { type: "pr_close" });
    win.message({ type: "pr_view", view: { phase: "running", run: { title: "Create pull request", steps: [], cancellable: true, note: null } } });
    const before = sent.length;
    win.dispatch("keydown", { key: "Escape" });
    assert.equal(sent.length, before);
    (doc.querySelector('[data-pr-action="cancel"]') as MiniElement).click();
    assert.deepEqual(sent.at(-1), { type: "pr_action", action: "cancel" });
    win.message({ type: "pr_view", view: { phase: "running", run: { title: "x", steps: [], cancellable: false, note: "The push has started" } } });
    const n = sent.length;
    (doc.querySelector('[data-pr-action="cancel"]') as MiniElement).click();
    assert.equal(sent.length, n, "cancel is disabled once the push has started");
  });

  it("host messages with junk shapes don't throw", () => {
    for (const msg of [null, 5, "x", { type: 5 }, { type: "pr_view" }, { type: "pr_view", view: null }, { type: "pr_field", field: "__proto__", value: "x" },
      { type: "pr_field", field: "commitMessage", value: { toString: () => "x" } }, { type: "pr_button", state: null }]) {
      assert.doesNotThrow(() => win.message(msg));
    }
  });
});
