import * as vscode from "vscode";
import { loadGitApi } from "./pullRequest/vscodeGit.js";
import { SNAPSHOT_BRANCH } from "./pullRequest/branchName.js";

export { SNAPSHOT_BRANCH };

const warned = new Set<string>();

/** Warns once per repository and window when a repository is checked out on the snapshot branch,
 *  and offers VS Code's own branch picker. Never switches branches itself. */
export async function warnIfOnSnapshotBranch(): Promise<void> {
  const git = await loadGitApi();
  if ("problem" in git) return;
  for (const repo of git.api.repositories) {
    const root = repo.rootUri.fsPath;
    if (repo.state.HEAD?.name?.toLowerCase() !== SNAPSHOT_BRANCH || warned.has(root)) continue;
    warned.add(root);
    const choice = await vscode.window.showWarningMessage(
      `This repository is on ${SNAPSHOT_BRANCH}, the branch where Andromity keeps undo snapshots. Work there gets mixed into the snapshots. Switch to your own branch or main.`,
      "Switch branch",
    );
    if (choice === "Switch branch") void vscode.commands.executeCommand("git.checkout");
  }
}
