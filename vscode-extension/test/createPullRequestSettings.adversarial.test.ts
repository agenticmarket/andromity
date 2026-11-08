// Independent adversarial tests for the "Git & Pull Requests" settings tab (src/panels/settings/gitSettings.ts).
// Spec: private/design/create-pr/DESIGN.md 3.1, 3.2, 3.5 (settings), 7.2 rule 12 (what a repository may set).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { installVscodeStub, resetState, state } from "./helpers/prVscodeStub.js";
import { MiniDocument, MiniWindow, MiniElement, dangerousNodes } from "./helpers/miniDom.js";

installVscodeStub();
const { applyGitSetting, gitSettingsState, getGitSettingsPane, gitSettingsClient } =
  require("../src/panels/settings/gitSettings.js") as typeof import("../src/panels/settings/gitSettings.js");

beforeEach(() => resetState());

describe("settings: only the five Git settings, only valid values (Git & Pull Requests tab)", () => {
  it("refuses unknown and prototype keys without writing anything", async () => {
    for (const key of ["permissionMode", "andromity.permissionMode", "airGap.enabled", "pullRequest.branchPrefix ", "PULLREQUEST.BRANCHPREFIX",
      "includeCoAuthor", "__proto__", "constructor", "toString", "pullRequest", "", null, 5, { toString: () => "includeAssistedBy" }, ["includeAssistedBy"]]) {
      const error = await applyGitSetting(key, true);
      assert.ok(error, `accepted ${JSON.stringify(key)}`);
    }
    assert.deepEqual(state.updates, []);
  });

  it("checks every value", async () => {
    const refused: [string, unknown][] = [
      ["includeAssistedBy", "true"], ["includeAssistedBy", 1], ["pullRequest.attachReceipt", null], ["pullRequest.draftWithAI", {}],
      ["pullRequest.branchPrefix", "../x/"], ["pullRequest.branchPrefix", "-x/"], ["pullRequest.branchPrefix", "a..b/"], ["pullRequest.branchPrefix", "x.lock/"],
      ["pullRequest.branchPrefix", "a b/"], ["pullRequest.branchPrefix", "@{"], ["pullRequest.branchPrefix", "a".repeat(41)], ["pullRequest.branchPrefix", 5],
      ["pullRequest.branchPrefix", "‮main/"], ["pullRequest.branchPrefix", "x\n/"],
      ["pullRequest.sizeWarningLines", "1e3"], ["pullRequest.sizeWarningLines", 1.5], ["pullRequest.sizeWarningLines", -1], ["pullRequest.sizeWarningLines", 1_000_001],
      ["pullRequest.sizeWarningLines", NaN], ["pullRequest.sizeWarningLines", Infinity], ["pullRequest.sizeWarningLines", true], ["pullRequest.sizeWarningLines", "0x10"],
      ["pullRequest.sizeWarningLines", "12345678"], ["pullRequest.sizeWarningLines", ""],
    ];
    for (const [key, value] of refused) assert.ok(await applyGitSetting(key, value), `accepted ${key} = ${JSON.stringify(value)}`);
    assert.deepEqual(state.updates, []);
  });

  it("saves valid values at user scope, trimmed and typed", async () => {
    const accepted: [string, unknown, unknown][] = [
      ["includeAssistedBy", true, true], ["pullRequest.attachReceipt", false, false], ["pullRequest.draftWithAI", false, false],
      ["pullRequest.branchPrefix", "  me/  ", "me/"], ["pullRequest.branchPrefix", "", ""], ["pullRequest.branchPrefix", "team.x-y/", "team.x-y/"],
      ["pullRequest.sizeWarningLines", " 42 ", 42], ["pullRequest.sizeWarningLines", 0, 0], ["pullRequest.sizeWarningLines", 1_000_000, 1_000_000],
    ];
    for (const [key, value, saved] of accepted) {
      assert.equal(await applyGitSetting(key, value), null, `${key} = ${JSON.stringify(value)}`);
      const last = state.updates.at(-1)!;
      assert.equal(last.section, "andromity");
      assert.equal(last.key, key);
      assert.deepEqual(last.value, saved);
      assert.equal(last.target, 1, "settings from this tab go to user (Global) scope");
    }
  });

  it("state reads hostile stored values safely and never exposes a token", async () => {
    state.workspaceConfig.andromity = { "pullRequest.branchPrefix": "--upload-pack=evil/", "pullRequest.sizeWarningLines": -5 };
    state.session = { accessToken: "gho_settings_secret_token", account: { label: "x".repeat(500), id: "1" }, scopes: ["repo"] };
    const s = await gitSettingsState();
    assert.equal(s.branchPrefix, "andromity/");
    assert.equal(s.sizeWarningLines, 300);
    assert.equal(s.github.status, "signed_in");
    assert.ok(s.github.account!.length <= 100);
    assert.ok(!JSON.stringify(s).includes("gho_settings_secret_token"));
    assert.ok(state.sessionRequests.every((r) => r.options?.silent === true && !r.options?.createIfNone), "reading the tab must not prompt");
    state.config.andromity = { "airGap.enabled": true };
    state.sessionRequests = [];
    assert.equal((await gitSettingsState()).github.status, "air_gap");
    assert.deepEqual(state.sessionRequests, [], "asked for a GitHub session in air-gap mode");
  });

  it("a repository can't turn the receipt off for everyone who opens it (7.2 rule 12 lists only prefix, size and draft)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    const sections = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
    const props = sections.reduce((all: any, c: any) => ({ ...all, ...(c.properties ?? {}) }), {});
    const receipt = props["andromity.pullRequest.attachReceipt"];
    assert.ok(receipt, "setting exists");
    assert.ok(["application", "machine"].includes(receipt.scope), `attachReceipt has scope ${receipt.scope ?? "window (default)"}, so a repository's .vscode/settings.json can switch receipts off`);
  });
});

describe("settings tab client", () => {
  it("renders the account name as text and only sends the five known keys", () => {
    const doc = new MiniDocument(getGitSettingsPane("https://docs.example/preferences") + '<button id="tab-btn-git"></button>');
    const win = new MiniWindow();
    (globalThis as any).document = doc;
    (globalThis as any).window = win;
    const sent: any[] = [];
    gitSettingsClient({ postMessage: (m) => sent.push(m) });
    assert.deepEqual(sent[0], { type: "git_settings_get" });
    win.message({ type: "git_settings", state: { includeAssistedBy: true, branchPrefix: '"><img src=x onerror=alert(1)>', attachReceipt: false, draftWithAI: true, sizeWarningLines: 300,
      github: { status: "signed_in", account: "<img src=x onerror=alert(1)>" } } });
    assert.deepEqual(dangerousNodes(doc).filter((n) => !n.startsWith("A")), []);
    assert.match((doc.getElementById("git-github-status") as MiniElement).textContent, /Signed in as <img/);
    for (const box of doc.querySelectorAll("[data-git-setting]")) {
      box.click();
    }
    const keys = sent.filter((m) => m.type === "git_settings_set").map((m) => m.key).sort();
    assert.deepEqual(keys, ["includeAssistedBy", "pullRequest.attachReceipt", "pullRequest.draftWithAI"]);
  });
});
