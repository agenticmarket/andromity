import * as vscode from "vscode";

export const IMPROVE_INSTRUCTION =
  "Improve this code's readability and robustness without changing its behaviour.";

export class AndromityCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorExtract,
    vscode.CodeActionKind.RefactorRewrite,
  ];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const action = (title: string, kind: vscode.CodeActionKind, command: string, args?: unknown[]) => {
      const codeAction = new vscode.CodeAction(title, kind);
      codeAction.command = { command, title, arguments: args };
      actions.push(codeAction);
      return codeAction;
    };

    if (context.diagnostics.length > 0) {
      action("Fix with Andromity", vscode.CodeActionKind.QuickFix, "andromity.fixErrors", [document.uri, context.diagnostics]).isPreferred = true;
      action("Explain Error with Andromity", vscode.CodeActionKind.QuickFix, "andromity.fixErrors", [document.uri, context.diagnostics]);
    }

    // Available on any line, like other agents' lightbulb actions; they act on
    // the selection or the line under the cursor.
    action("Add to Andromity", vscode.CodeActionKind.QuickFix, "andromity.addToChat", [document.uri, range]);
    action("Explain with Andromity", vscode.CodeActionKind.RefactorExtract, "andromity.explainCode");
    action("Improve with Andromity", vscode.CodeActionKind.RefactorRewrite, "andromity.inlineEdit", [IMPROVE_INSTRUCTION]);
    if (!range.isEmpty) {
      action("Generate Unit Tests with Andromity", vscode.CodeActionKind.RefactorExtract, "andromity.generateTests");
    }
    return actions;
  }
}
