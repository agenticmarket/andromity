import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mock vscode module for Node test environment
// @ts-ignore
const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (reqPath: string) {
  if (reqPath === "vscode") {
    return {
      window: { activeTextEditor: undefined },
      workspace: { workspaceFolders: [], textDocuments: [] },
      languages: { getDiagnostics: () => [] },
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
      Uri: {
        joinPath: (...args: any[]) => ({ fsPath: args.join("/") }),
        file: (p: string) => ({ fsPath: p }),
      },
    };
  }
  return origRequire.apply(this, arguments as any);
};

import { EditorBridge, EditorContext } from "../src/integrations/EditorBridge.js";

describe("EditorBridge & Ambient IDE Context Tests", () => {
  it("should return prompt unchanged when no editor context is provided", () => {
    const formatted = EditorBridge.formatPromptWithEditorState("fix this file", {});
    assert.equal(formatted, "fix this file");
  });

  it("should inject active document and cursor line even without selected text", () => {
    const ctx: EditorContext = {
      relativePath: "src/services/auth.ts",
      languageId: "typescript",
      cursorLine: 42,
      cursorColumn: 10,
    };
    const formatted = EditorBridge.formatPromptWithEditorState("fix this file", ctx);

    assert.ok(formatted.startsWith("fix this file\n\n---"));
    assert.ok(formatted.includes("[Active Document: src/services/auth.ts (Language: typescript), Line: 42]"));
  });

  it("should format active diagnostics including error and warning counts", () => {
    const ctx: EditorContext = {
      relativePath: "src/utils/math.py",
      languageId: "python",
      cursorLine: 15,
      diagnostics: [
        { line: 15, severity: "error", message: "NameError: name 'total' is not defined" },
        { line: 20, severity: "warning", message: "Unused import 'math'" },
      ],
    };
    const formatted = EditorBridge.formatPromptWithEditorState("what is wrong with this code?", ctx);

    assert.ok(formatted.includes("[Active Diagnostics in src/utils/math.py (1 errors, 1 warnings):"));
    assert.ok(formatted.includes("- Line 15 [error]: NameError: name 'total' is not defined"));
    assert.ok(formatted.includes("- Line 20 [warning]: Unused import 'math'"));
  });

  it("should include code selection when text is selected", () => {
    const ctx: EditorContext = {
      relativePath: "src/components/Button.tsx",
      languageId: "typescriptreact",
      cursorLine: 8,
      selectedText: "export const Button = () => <button />;",
      selectionRange: { startLine: 8, endLine: 8 },
    };
    const formatted = EditorBridge.formatPromptWithEditorState("refactor this component", ctx);

    assert.ok(formatted.includes("[Selection in src/components/Button.tsx (lines 8-8)]:"));
    assert.ok(formatted.includes("```typescriptreact\nexport const Button = () => <button />;\n```"));
  });

  it("should list other open editor tabs in ambient context", () => {
    const ctx: EditorContext = {
      relativePath: "src/controllers/user.ts",
      languageId: "typescript",
      cursorLine: 1,
      openFiles: ["src/models/user.ts", "src/routes/api.ts"],
    };
    const formatted = EditorBridge.formatPromptWithEditorState("explain this flow", ctx);

    assert.ok(formatted.includes("[Other Open Documents: src/models/user.ts, src/routes/api.ts]"));
  });

  it("should omit selection text when attachFullSelection is false but preserve document metadata", () => {
    const ctx: EditorContext = {
      relativePath: "src/largeFile.ts",
      languageId: "typescript",
      cursorLine: 100,
      selectedText: "console.log('secret');",
    };
    const formatted = EditorBridge.formatPromptWithEditorState("check this file", ctx, false);

    assert.ok(formatted.includes("[Active Document: src/largeFile.ts (Language: typescript), Line: 100]"));
    assert.ok(!formatted.includes("console.log('secret')"));
  });
});
