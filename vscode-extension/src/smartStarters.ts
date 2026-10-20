import * as vscode from "vscode";

/** What the empty chat's starter buttons react to. */
export interface StarterContext {
  /** The open file's errors, or the workspace file with the most errors. */
  errors: { file: string; path: string; count: number } | null;
  /** Files with uncommitted changes in the first workspace repository. */
  changedFiles: number;
}

function errorCount(diagnostics: readonly vscode.Diagnostic[]): number {
  return diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
}

function inWorkspace(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && !!vscode.workspace.getWorkspaceFolder(uri);
}

export function collectErrors(): StarterContext["errors"] {
  const active = vscode.window.activeTextEditor?.document.uri;
  let best: { uri: vscode.Uri; count: number } | null = null;
  if (active && inWorkspace(active)) {
    const count = errorCount(vscode.languages.getDiagnostics(active));
    if (count) best = { uri: active, count };
  }
  if (!best) {
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (!inWorkspace(uri)) continue;
      const count = errorCount(diagnostics);
      if (count && (!best || count > best.count)) best = { uri, count };
    }
  }
  if (!best) return null;
  const path = vscode.workspace.asRelativePath(best.uri, false);
  return { file: path.split(/[\\/]/).pop() || path, path, count: best.count };
}

interface GitRepositoryLike {
  rootUri: vscode.Uri;
  state: {
    workingTreeChanges: Array<{ uri: vscode.Uri }>;
    indexChanges: Array<{ uri: vscode.Uri }>;
    untrackedChanges?: Array<{ uri: vscode.Uri }>;
    onDidChange: vscode.Event<void>;
  };
}

/** The built-in Git extension's repository for the first workspace folder, if it is active. */
function gitRepository(): GitRepositoryLike | undefined {
  try {
    const git = vscode.extensions.getExtension<any>("vscode.git");
    if (!git?.isActive) return undefined;
    const repositories: GitRepositoryLike[] = git.exports.getAPI(1).repositories || [];
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase();
    return repositories.find((r) => folder && folder.startsWith(r.rootUri.fsPath.toLowerCase())) || repositories[0];
  } catch {
    return undefined;
  }
}

export function collectChangedFiles(): number {
  const state = gitRepository()?.state;
  if (!state) return 0;
  const paths = new Set<string>();
  for (const change of [...state.workingTreeChanges, ...state.indexChanges, ...(state.untrackedChanges || [])]) {
    paths.add(change.uri.fsPath);
  }
  return paths.size;
}

export function collectStarterContext(): StarterContext {
  return { errors: collectErrors(), changedFiles: collectChangedFiles() };
}

/** Calls onChange (debounced) whenever errors or uncommitted changes change. */
export function watchStarterContext(onChange: (context: StarterContext) => void): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const context = collectStarterContext();
      const key = JSON.stringify(context);
      if (key === last) return;
      last = key;
      onChange(context);
    }, 500);
  };
  const disposables: vscode.Disposable[] = [
    vscode.languages.onDidChangeDiagnostics(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
  ];
  const repository = gitRepository();
  if (repository) disposables.push(repository.state.onDidChange(schedule));
  schedule();
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      disposables.forEach((d) => d.dispose());
    },
  };
}
