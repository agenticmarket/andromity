import * as vscode from "vscode";

export interface EditorContext {
  filePath?: string;
  relativePath?: string;
  languageId?: string;
  cursorLine?: number;
  cursorColumn?: number;
  selectedText?: string;
  fileText?: string;
  selectionRange?: { startLine: number; endLine: number };
  diagnostics?: Array<{
    line: number;
    message: string;
    severity: "error" | "warning" | "info";
  }>;
  openFiles?: string[];
}

export class EditorBridge {
  public static getActiveContext(): EditorContext {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {};
    }

    const doc = editor.document;
    const selection = editor.selection;
    const selectedText = !selection.isEmpty ? doc.getText(selection) : undefined;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);

    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(doc.uri, false)
      : doc.fileName;

    const diags = vscode.languages.getDiagnostics(doc.uri).map((d) => ({
      line: d.range.start.line + 1,
      message: d.message,
      severity:
        d.severity === vscode.DiagnosticSeverity.Error
          ? ("error" as const)
          : d.severity === vscode.DiagnosticSeverity.Warning
          ? ("warning" as const)
          : ("info" as const),
    }));

    const fullText = doc.getText();
    const fileText = fullText.length > 50000 ? fullText.slice(0, 50000) : fullText;

    const openFiles = vscode.workspace.textDocuments
      .filter((d) => d.uri.scheme === "file" && d.fileName !== doc.fileName)
      .map((d) => {
        const wf = vscode.workspace.getWorkspaceFolder(d.uri);
        return wf ? vscode.workspace.asRelativePath(d.uri, false) : d.fileName;
      })
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 8);

    return {
      filePath: doc.fileName,
      relativePath,
      languageId: doc.languageId,
      cursorLine: selection.active.line + 1,
      cursorColumn: selection.active.character + 1,
      selectedText,
      fileText,
      selectionRange: !selection.isEmpty
        ? {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
          }
        : undefined,
      diagnostics: diags.length > 0 ? diags : undefined,
      openFiles: openFiles.length > 0 ? openFiles : undefined,
    };
  }

  public static formatPromptWithEditorState(
    prompt: string,
    context?: EditorContext,
    attachFullSelection: boolean = true
  ): string {
    if (!context || !context.relativePath) {
      return prompt;
    }

    const parts: string[] = [];

    let docHeader = `[Active Document: ${context.relativePath}`;
    if (context.languageId) {
      docHeader += ` (Language: ${context.languageId})`;
    }
    if (context.cursorLine) {
      docHeader += `, Line: ${context.cursorLine}`;
    }
    docHeader += `]`;
    parts.push(docHeader);

    if (context.diagnostics && context.diagnostics.length > 0) {
      const errorCount = context.diagnostics.filter((d) => d.severity === "error").length;
      const warnCount = context.diagnostics.filter((d) => d.severity === "warning").length;
      const diagSummary = `[Active Diagnostics in ${context.relativePath} (${errorCount} errors, ${warnCount} warnings):`;
      const diagLines = context.diagnostics.slice(0, 8).map(
        (d) => `  - Line ${d.line} [${d.severity}]: ${d.message}`
      );
      if (context.diagnostics.length > 8) {
        diagLines.push(`  ...and ${context.diagnostics.length - 8} more issues`);
      }
      parts.push(`${diagSummary}\n${diagLines.join("\n")}\n]`);
    }

    if (attachFullSelection && context.selectedText && context.selectedText.trim()) {
      const lineRange = context.selectionRange
        ? ` (lines ${context.selectionRange.startLine}-${context.selectionRange.endLine})`
        : "";
      parts.push(`[Selection in ${context.relativePath}${lineRange}]:\n\`\`\`${context.languageId || ""}\n${context.selectedText}\n\`\`\``);
    }

    if (context.openFiles && context.openFiles.length > 0) {
      parts.push(`[Other Open Documents: ${context.openFiles.join(", ")}]`);
    }

    const contextBlock = parts.join("\n");
    return `${prompt}\n\n---\n${contextBlock}`;
  }

  public static async applySnippetToEditor(code: string, mode: "replace_selection" | "insert_at_cursor" = "insert_at_cursor"): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor to apply code snippet.");
      return false;
    }

    return editor.edit((editBuilder) => {
      const selection = editor.selection;
      if (mode === "replace_selection" && !selection.isEmpty) {
        editBuilder.replace(selection, code);
      } else {
        editBuilder.insert(selection.active, code);
      }
    });
  }
}
