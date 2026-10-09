import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

import { getChatActivityScript } from "../src/providers/chatview/chatActivityRow.js";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function loadActivityWindow(): any {
  const sandbox: any = {
    window: {},
    document: {
      addEventListener: () => {},
      createElement: (tag: string) => {
        const el: any = {
          tagName: tag.toUpperCase(), className: "", attributes: {}, innerHTML: "", style: {},
          setAttribute: (k: string, v: string) => { el.attributes[k] = v; },
          getAttribute: (k: string) => el.attributes[k],
        };
        return el;
      },
    },
  };
  vm.createContext(sandbox);
  new vm.Script(getChatActivityScript(), { filename: "chatActivityRow.js" }).runInContext(sandbox);
  return sandbox.window;
}

const clientScript = getChatClientScript("icon", {
  currentSessionId: "tab", currentModel: "model", currentProvider: "provider",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "auto",
} as any);

describe("file edit result status", () => {
  const win = loadActivityWindow();

  it("treats tool error text as failure even when the call completed", () => {
    assert.equal(win.classifyFileEditResult("Error: 'old_str' not found in a.py.", true), "error");
    assert.equal(win.classifyFileEditResult("Error writing file: denied", undefined), "error");
    assert.equal(win.classifyFileEditResult("Successfully edited a.py", true), "done");
    assert.equal(win.classifyFileEditResult("anything", false), "error");
    assert.equal(win.classifyFileEditResult(undefined, undefined), "done");
    assert.equal(
      win.classifyFileEditResult("Applied 1 edits successfully, but 2 edits failed:\nEdit 2: Error", true),
      "partial",
    );
  });

  it("labels failed edits without diff controls and partial edits with them", () => {
    const args = { path: "src/main.py", old_str: "a", new_str: "b" };
    const failed = win.renderAntigravityActivityRow("edit_file", args, "error");
    assert.ok(failed.innerHTML.startsWith('<span class="activity-action">Edit failed</span>'));
    assert.ok(failed.className.includes("activity-row-failed"));
    assert.ok(!failed.innerHTML.includes("activity-diff-btn"));
    assert.ok(!failed.innerHTML.includes("activity-stats"));

    const partial = win.renderAntigravityActivityRow("edit_file_multi", { path: "src/main.py", edits: [args] }, "partial");
    assert.ok(partial.innerHTML.includes("Partly edited"));
    assert.ok(partial.innerHTML.includes("activity-diff-btn"));

    const done = win.renderAntigravityActivityRow("edit_file", args, "done");
    assert.ok(done.innerHTML.includes(">Edited<"));
  });
});

describe("approval edit preview", () => {
  const win = loadActivityWindow();

  it("shows removed and added lines, escaped", () => {
    const preview = win.renderEditApprovalPreview("edit_file", {
      path: "a.html", old_str: "<b>old</b>\nkeep", new_str: "<script>x</script>\n",
    });
    assert.equal(preview.additions, 1);
    assert.equal(preview.deletions, 2);
    assert.ok(preview.html.includes('<div class="perm-diff-line perm-diff-del">- &lt;b&gt;old&lt;/b&gt;</div>'));
    assert.ok(preview.html.includes('<div class="perm-diff-line perm-diff-add">+ &lt;script&gt;x&lt;/script&gt;</div>'));
    assert.ok(!preview.html.includes("<script>"));
  });

  it("covers write_file and every edit in edit_file_multi", () => {
    const write = win.renderEditApprovalPreview("write_file", { path: "a.py", content: "one\ntwo\n" });
    assert.equal(write.additions, 2);
    assert.equal(write.deletions, 0);

    const multi = win.renderEditApprovalPreview("edit_file_multi", {
      path: "a.py", edits: [{ old_str: "a", new_str: "b" }, { old_str: "c", new_str: "d" }],
    });
    assert.equal(multi.editCount, 2);
    assert.ok(multi.html.includes("@@ edit 1 of 2 @@"));
    assert.ok(multi.html.includes("@@ edit 2 of 2 @@"));
    assert.ok(multi.html.includes("+ d"));
  });

  it("caps very large changes instead of rendering them all", () => {
    const content = Array.from({ length: 5000 }, (_, i) => "line " + i).join("\n");
    const preview = win.renderEditApprovalPreview("write_file", { path: "big.txt", content });
    assert.equal(preview.additions, 5000);
    assert.equal((preview.html.match(/class="perm-diff-line /g) || []).length, 200);
    assert.ok(preview.html.includes("4800 more lines not shown"));
  });

  it("returns null for tools that do not modify files", () => {
    assert.equal(win.renderEditApprovalPreview("read_file", { path: "a.py" }), null);
  });
});

describe("approval card", () => {
  const start = clientScript.indexOf("    function renderPermissionCard(msg) {");
  const end = clientScript.indexOf("\n    }\n", clientScript.indexOf("permission-option-row option-deny", start)) + 6;
  const source = clientScript.slice(start, end);

  function render(toolName: string, args: any): string {
    const context = vm.createContext({ window: loadActivityWindow(), escapeHtml, zeroWorkspaceLabel: null });
    vm.runInContext(source, context);
    return context.renderPermissionCard({ tool_name: toolName, approval_id: "ap1", args });
  }

  it("shows what write_file will write instead of a generic execute title", () => {
    const html = render("write_file", { path: "src/app.ts", content: "export const x = 1;\n" });
    assert.ok(html.includes('<span class="permission-title">Write file</span>'));
    assert.ok(!html.includes("Execute write_file"));
    assert.ok(html.includes("permission-diff-box"));
    assert.ok(html.includes("+ export const x = 1;"));
    assert.ok(html.includes("replaces its entire content"));
  });

  it("shows every edit of edit_file_multi", () => {
    const html = render("edit_file_multi", {
      path: "src/app.ts", edits: [{ old_str: "a", new_str: "b" }, { old_str: "c", new_str: "d" }],
    });
    assert.ok(html.includes('<span class="permission-title">Edit file</span>'));
    assert.ok(html.includes("2 edits"));
    assert.ok(html.includes("- c"));
  });

  it("keeps command approvals unchanged", () => {
    const html = render("shell_exec", { command: "npm test" });
    assert.ok(html.includes("Running command"));
    assert.ok(!html.includes("permission-diff-box"));
  });
});

describe("edit row review click", () => {
  const caseSource = clientScript.slice(
    clientScript.indexOf("        case 'open-review-tab':"),
    clientScript.indexOf("        case 'toggle-timeline':"),
  );

  function click(target: any): any {
    const posts: any[] = [];
    const context = vm.createContext({ target, vscode: { postMessage: (m: any) => posts.push(m) } });
    vm.runInContext("switch ('open-review-tab') {" + caseSource + "}", context);
    assert.equal(posts.length, 1);
    return JSON.parse(JSON.stringify(posts[0]));
  }

  function editRowTarget(turnCard: any) {
    const wrap = { querySelector: (sel: string) => (sel.startsWith(".files-changed-card") ? turnCard : null) };
    return {
      getAttribute: (k: string) => (k === "data-file-path" ? "src/main.py" : null),
      closest: (sel: string) => {
        if (sel === ".activity-row-file") return {};
        if (sel === ".message-wrap") return wrap;
        return null;
      },
    };
  }

  it("scopes an edit row to its own turn's files", () => {
    const card = { getAttribute: () => JSON.stringify(["src/main.py", "README.md"]) };
    assert.deepEqual(click(editRowTarget(card)), {
      type: "open_review_tab", filePath: "src/main.py", turnFiles: ["src/main.py", "README.md"],
    });
  });

  it("sends an explicit null scope while the row's turn is still running", () => {
    assert.deepEqual(click(editRowTarget(null)), {
      type: "open_review_tab", filePath: "src/main.py", turnFiles: null,
    });
  });
});
