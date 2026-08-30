import * as vscode from "vscode";

export interface EditorContext {
  filePath?: string;
  relativePath?: string;
  languageId?: string;
  selectedText?: string;
  selectionRange?: { startLine: number; endLine: number };
  diagnostics?: Array<{
    line: number;
    message: string;
    severity: "error" | "warning" | "info";
  }>;
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

    return {
      filePath: doc.fileName,
      relativePath,
      languageId: doc.languageId,
      selectedText,
      selectionRange: !selection.isEmpty
        ? {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
          }
        : undefined,
      diagnostics: diags.length > 0 ? diags : undefined,
    };
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
