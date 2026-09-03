import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("EditorBridge & Context Formatting Unit Tests", () => {
  function formatPromptWithContext(prompt: string, context?: {
    relativePath: string;
    languageId?: string;
    selectedText?: string;
    selectionRange?: { startLine: number; endLine: number };
  }): string {
    if (!context || !context.selectedText) {
      return prompt;
    }
    const lines = context.selectionRange
      ? ` (lines ${context.selectionRange.startLine}-${context.selectionRange.endLine})`
      : "";
    return `${prompt}\n\n--- Context from ${context.relativePath}${lines} ---\n\`\`\`${context.languageId || ""}\n${context.selectedText}\n\`\`\``;
  }

  it("should return prompt unchanged when no selected text exists", () => {
    const formatted = formatPromptWithContext("Explain this code", {
      relativePath: "src/main.ts",
      selectedText: "",
    });
    assert.equal(formatted, "Explain this code");
  });

  it("should append markdown-fenced code context with line numbers", () => {
    const formatted = formatPromptWithContext("Optimize this algorithm", {
      relativePath: "src/algorithms.py",
      languageId: "python",
      selectedText: "def binary_search(arr, target):\n    pass",
      selectionRange: { startLine: 10, endLine: 12 },
    });

    assert.ok(formatted.startsWith("Optimize this algorithm\n\n--- Context from src/algorithms.py (lines 10-12) ---"));
    assert.ok(formatted.includes("```python\ndef binary_search(arr, target):\n    pass\n```"));
  });
});
