import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";

export interface InlineEditDeps {
  waitForClient(timeoutMs: number): Promise<RpcClient | null>;
  getTurnDefaults(): { model: string; provider: string };
}

interface PendingEdit {
  uri: vscode.Uri;
  /** Offsets of the inserted text; shifted as the user edits above it. */
  start: number;
  length: number;
  original: string;
  /** Whole document before the edit, for the Compare view. */
  snapshot: string;
}

const CONTEXT_KEY = "andromity.inlineEditPending";
const ORIGINAL_SCHEME = "andromity-inline-original";
const CONTEXT_LINES_BEFORE = 60;
const CONTEXT_LINES_AFTER = 40;
const FENCE = "`".repeat(3);

function fencedBlocks(reply: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const open = reply.indexOf(FENCE, from);
    if (open === -1) break;
    const bodyStart = reply.indexOf("\n", open);
    const close = bodyStart === -1 ? -1 : reply.indexOf(FENCE, bodyStart + 1);
    if (close === -1) break;
    blocks.push(reply.slice(bodyStart + 1, close).trimEnd());
    from = close + FENCE.length;
  }
  return blocks;
}

/** Code from the model's reply: the first fenced block of a normal answer, or
 *  the last one when the answer came from reasoning (earlier blocks are
 *  drafts). A reasoning reply without any block has no usable code. */
export function extractReplacement(reply: string, fromReasoning = false): string {
  const blocks = fencedBlocks(reply);
  if (blocks.length) return fromReasoning ? blocks[blocks.length - 1] : blocks[0];
  return fromReasoning ? "" : reply.trim();
}

export function buildInlineEditPrompt(opts: {
  instruction: string;
  relativePath: string;
  languageId: string;
  before: string;
  selection: string;
  after: string;
}): string {
  const action = opts.selection.trim()
    ? "Rewrite the code inside <selection> so it satisfies the instruction."
    : "Write the code to insert at <selection> so it satisfies the instruction.";
  return [
    `You are editing ${opts.relativePath} (${opts.languageId}).`,
    action,
    `Reply with ONLY the replacement code in a single ${FENCE} fenced block. Keep the surrounding indentation, do not repeat code from <before> or <after>, and add no explanation.`,
    "",
    `Instruction: ${opts.instruction}`,
    "",
    `<before>\n${opts.before}</before>`,
    `<selection>\n${opts.selection}</selection>`,
    `<after>\n${opts.after}</after>`,
  ].join("\n");
}

/** Ctrl+I: describe a change to the selection (or current line), apply the
 *  model's rewrite in place, and keep it or roll it back from code lenses. */
export function registerInlineEdit(context: vscode.ExtensionContext, deps: InlineEditDeps): void {
  let pending: PendingEdit | null = null;
  let applyingOwnEdit = false;
  const lensesChanged = new vscode.EventEmitter<void>();
  const highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
    isWholeLine: true,
  });

  const pendingRange = (doc: vscode.TextDocument): vscode.Range | null =>
    pending && doc.uri.toString() === pending.uri.toString()
      ? new vscode.Range(doc.positionAt(pending.start), doc.positionAt(pending.start + pending.length))
      : null;

  const refreshDecorations = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      const range = pendingRange(editor.document);
      editor.setDecorations(highlight, range ? [range] : []);
    }
    lensesChanged.fire();
  };

  const setPending = (next: PendingEdit | null) => {
    pending = next;
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, !!next);
    refreshDecorations();
  };

  const accept = () => setPending(null);

  const reject = async () => {
    if (!pending) return;
    const current = pending;
    const doc = await vscode.workspace.openTextDocument(current.uri);
    const range = pendingRange(doc);
    setPending(null);
    if (!range) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(current.uri, range, current.original);
    applyingOwnEdit = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      applyingOwnEdit = false;
    }
  };

  const run = async (presetInstruction?: string) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (pending) accept();
    const doc = editor.document;
    const sel = editor.selection;
    // Whole lines read better as a diff and avoid half-token edits.
    const range = sel.isEmpty
      ? doc.lineAt(sel.active.line).range
      : new vscode.Range(sel.start.line, 0, sel.end.line, doc.lineAt(sel.end.line).text.length);
    const original = doc.getText(range);

    const instruction = typeof presetInstruction === "string" && presetInstruction ? presetInstruction : await vscode.window.showInputBox({
      title: "Edit with Andromity",
      prompt: original.trim() ? "Describe how to change the selected code" : "Describe the code to write here",
      placeHolder: "e.g. handle the empty-list case and add a docstring",
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) return;

    const rpc = await deps.waitForClient(5000);
    if (!rpc) {
      void vscode.window.showErrorMessage("Andromity's engine isn't running. Run 'Andromity: System Setup Check'.");
      return;
    }

    const lastLine = doc.lineCount - 1;
    const prompt = buildInlineEditPrompt({
      instruction: instruction.trim(),
      relativePath: vscode.workspace.asRelativePath(doc.uri, false),
      languageId: doc.languageId,
      before: doc.getText(new vscode.Range(Math.max(0, range.start.line - CONTEXT_LINES_BEFORE), 0, range.start.line, 0)),
      selection: original ? original + "\n" : "",
      after: range.end.line >= lastLine
        ? ""
        : doc.getText(new vscode.Range(range.end.line + 1, 0, Math.min(lastLine, range.end.line + CONTEXT_LINES_AFTER), Number.MAX_SAFE_INTEGER)),
    });
    const version = doc.version;
    const defaults = deps.getTurnDefaults();

    const reply = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Andromity is editing…", cancellable: true },
      async (_progress, token) => {
        const request = rpc.call<{ message?: string; result?: string; from_reasoning?: boolean }>("agent.quickPrompt", {
          prompt,
          raw: true,
          max_tokens: 8000,
          project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          model: defaults.model || undefined,
          provider: defaults.provider || undefined,
        }, 130000);
        const cancelled = new Promise<null>((resolve) => token.onCancellationRequested(() => resolve(null)));
        return Promise.race([request, cancelled]);
      }
    ).then(
      (res) => (res ? { text: res.message || res.result || "", fromReasoning: res.from_reasoning === true } : null),
      (err: Error) => {
        // Engines before raw mode reject non-commit replies with this message.
        const unsupported = /not found|-32601|did not produce a commit message/.test(err.message);
        void vscode.window.showErrorMessage(unsupported
          ? "Inline edit needs a newer Andromity engine. Update the extension and reload."
          : "Andromity could not generate the edit. Check your model and provider in Settings, then retry.");
        return null;
      }
    );
    if (reply === null) return;

    const replacement = extractReplacement(reply.text, reply.fromReasoning);
    if (!replacement) {
      void vscode.window.showWarningMessage("The model returned no code. Try rephrasing the instruction.");
      return;
    }
    if (doc.version !== version) {
      void vscode.window.showWarningMessage("The file changed while Andromity was working. Run the edit again.");
      return;
    }

    const snapshot = doc.getText();
    const start = doc.offsetAt(range.start);
    applyingOwnEdit = true;
    let applied = false;
    try {
      applied = await editor.edit((builder) => builder.replace(range, replacement));
    } finally {
      applyingOwnEdit = false;
    }
    if (!applied) return;
    setPending({ uri: doc.uri, start, length: replacement.length, original, snapshot });
  };

  context.subscriptions.push(
    lensesChanged,
    highlight,
    vscode.commands.registerCommand("andromity.inlineEdit", (instruction?: string) => {
      recordFeatureUse("inline_edit");
      return run(instruction);
    }),
    vscode.commands.registerCommand("andromity.inlineEdit.accept", () => {
      if (pending) recordFeatureUse("inline_edit_accepted");
      return accept();
    }),
    vscode.commands.registerCommand("andromity.inlineEdit.reject", () => {
      if (pending) recordFeatureUse("inline_edit_rejected");
      return reject();
    }),
    vscode.commands.registerCommand("andromity.inlineEdit.compare", async () => {
      if (!pending) return;
      recordFeatureUse("inline_edit_compared");
      const original = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: pending.uri.path, query: String(Date.now()) });
      await vscode.commands.executeCommand("vscode.diff", original, pending.uri, "Andromity edit: before ↔ after");
    }),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
      provideTextDocumentContent: () => pending?.snapshot ?? "",
    }),
    vscode.languages.registerCodeLensProvider({ scheme: "*" }, {
      onDidChangeCodeLenses: lensesChanged.event,
      provideCodeLenses(doc) {
        const range = pendingRange(doc);
        if (!range) return [];
        const at = new vscode.Range(range.start, range.start);
        return [
          new vscode.CodeLens(at, { title: "$(check) Accept", command: "andromity.inlineEdit.accept" }),
          new vscode.CodeLens(at, { title: "$(discard) Reject", command: "andromity.inlineEdit.reject" }),
          new vscode.CodeLens(at, { title: "Compare", command: "andromity.inlineEdit.compare" }),
        ];
      },
    }),
    vscode.window.onDidChangeVisibleTextEditors(refreshDecorations),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!pending || applyingOwnEdit || event.document.uri.toString() !== pending.uri.toString()) return;
      for (const change of event.contentChanges) {
        const end = pending.start + pending.length;
        if (change.rangeOffset + change.rangeLength <= pending.start) {
          pending.start += change.text.length - change.rangeLength;
        } else if (change.rangeOffset < end) {
          // The user is editing the new code itself: treat that as keeping it.
          accept();
          return;
        }
      }
      refreshDecorations();
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (pending && doc.uri.toString() === pending.uri.toString()) accept();
    })
  );
}
