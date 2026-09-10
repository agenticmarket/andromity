import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

import { parseFileEditStats, getChatActivityScript } from "../src/providers/chatview/chatActivityRow.js";
import { getChatActivityStyles } from "../src/providers/chatview/chatActivityStyles.js";

describe("Antigravity Activity Row Unit Tests", () => {
  it("parseFileEditStats should correctly compute additions and deletions for replace_file_content", () => {
    const args = {
      TargetFile: "d:/saas/agent/scripts/show-all-servers.ts",
      TargetContent: "const x = 1;\nconst y = 2;",
      ReplacementContent: "const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nconst k = 5;",
    };

    const stats = parseFileEditStats("replace_file_content", args);
    assert.ok(stats, "Stats should be returned");
    assert.equal(stats.filename, "show-all-servers.ts");
    assert.equal(stats.badgeText, "TS");
    assert.equal(stats.badgeClass, "badge-ts");
    assert.equal(stats.deletions, 2);
    assert.equal(stats.additions, 5);
  });

  it("parseFileEditStats should correctly compute stats for multi_replace_file_content", () => {
    const args = {
      TargetFile: "src/andromity/server/enterprise_test.py",
      ReplacementChunks: [
        {
          TargetContent: "assert r.status_code == 200\nj = r.json()",
          ReplacementContent: "if r.status_code != 200:\n  log('error')\n  return",
        },
        {
          TargetContent: "old_call()",
          ReplacementContent: "new_call_step_one()\nnew_call_step_two()",
        },
      ],
    };

    const stats = parseFileEditStats("multi_replace_file_content", args);
    assert.ok(stats);
    assert.equal(stats.filename, "enterprise_test.py");
    assert.equal(stats.badgeText, "PY");
    assert.equal(stats.badgeClass, "badge-py");
    assert.equal(stats.deletions, 3); // 2 + 1
    assert.equal(stats.additions, 5); // 3 + 2
  });

  it("parseFileEditStats should count whole file additions for write_to_file", () => {
    const args = {
      TargetFile: "docs/Walkthrough.md",
      CodeContent: "# Walkthrough\n\nLine 1\nLine 2\nLine 3",
    };

    const stats = parseFileEditStats("write_to_file", args);
    assert.ok(stats);
    assert.equal(stats.filename, "Walkthrough.md");
    assert.equal(stats.badgeText, "MD");
    assert.equal(stats.badgeClass, "badge-md");
    assert.equal(stats.additions, 5);
    assert.equal(stats.deletions, 0);
  });

  it("parseFileEditStats should return null for non-writing tools", () => {
    assert.equal(parseFileEditStats("view_file", { AbsolutePath: "foo.ts" }), null);
    assert.equal(parseFileEditStats("run_command", { CommandLine: "ls" }), null);
  });

  it("getChatActivityScript should compile in Node vm.Script with zero syntax errors", () => {
    const script = getChatActivityScript();
    assert.ok(script.length > 200);

    const sandbox: any = {
      window: {},
      document: {
        addEventListener: () => {},
      },
      escapeHtml: (s: string) => s,
      vscode: { postMessage: () => {} },
    };
    vm.createContext(sandbox);

    assert.doesNotThrow(() => {
      new vm.Script(script, { filename: "chatActivityRow.js" }).runInContext(sandbox);
    });

    assert.equal(typeof sandbox.window.parseFileEditStats, "function");
    assert.equal(typeof sandbox.window.renderAntigravityActivityRow, "function");
    assert.equal(typeof sandbox.window.renderCommandActivityRow, "function");
  });

  it("getChatActivityStyles should return valid CSS tokens adhering to theme guidelines", () => {
    const css = getChatActivityStyles();
    assert.ok(css.includes(".activity-row"));
    assert.ok(css.includes("#09f994")); // Emerald glow
    assert.ok(css.includes("#f85149")); // Coral crimson
    assert.ok(css.includes("JetBrains Mono"));
  });
});
