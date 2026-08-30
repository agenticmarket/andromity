import * as vscode from "vscode";

export class AndromityCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Refactor,
  ];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // If there are diagnostics (errors/warnings) at this location
    if (context.diagnostics.length > 0) {
      const fixAction = new vscode.CodeAction(
        "Fix with Andromity AI",
        vscode.CodeActionKind.QuickFix
      );
      fixAction.command = {
        command: "andromity.fixErrors",
        title: "Fix with Andromity AI",
        arguments: [document.uri, context.diagnostics],
      };
      fixAction.isPreferred = true;
      actions.push(fixAction);
    }

    // If text is selected, offer Explain and Refactor
    if (!range.isEmpty) {
      const explainAction = new vscode.CodeAction(
        "Explain with Andromity AI",
        vscode.CodeActionKind.Refactor
      );
      explainAction.command = {
        command: "andromity.explainCode",
        title: "Explain with Andromity",
      };
      actions.push(explainAction);

      const testAction = new vscode.CodeAction(
        "Generate Unit Tests with Andromity AI",
        vscode.CodeActionKind.Refactor
      );
      testAction.command = {
        command: "andromity.generateTests",
        title: "Generate Unit Tests with Andromity",
      };
      actions.push(testAction);
    }

    return actions;
  }
}
