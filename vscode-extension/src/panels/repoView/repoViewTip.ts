import * as vscode from "vscode";
import { recordFeatureUse } from "../../telemetry/featureUsage.js";
import { parseRemoteUrl } from "../../integrations/pullRequest/remotes.js";
import { loadGitApi } from "../../integrations/pullRequest/vscodeGit.js";

const TIP_KEY = "andromity.tip.pullRequestsView";
let asking = false;

/** Whether a workspace repository has a github.com remote. */
async function hasGitHubRemote(): Promise<boolean> {
  try {
    const git = await loadGitApi();
    if ("problem" in git) return false;
    return git.api.repositories.some((repo) => repo.state.remotes.some((remote) => parseRemoteUrl(remote.fetchUrl || remote.pushUrl)?.kind === "github"));
  } catch {
    return false;
  }
}

/** Once per install, after a turn finishes in a GitHub repository, points at the Pull Requests and Issues view. */
export async function maybeShowPullRequestsTip(context: vscode.ExtensionContext | undefined): Promise<void> {
  if (!context || asking || context.globalState.get<boolean>(TIP_KEY, false)) return;
  asking = true;
  try {
    if (!(await hasGitHubRemote())) return;
    await context.globalState.update(TIP_KEY, true);
    recordFeatureUse("prv_tip_shown");
    const choice = await vscode.window.showInformationMessage(
      "Your repository's pull requests and issues are in Andromity: review a pull request or ask about an issue without leaving VS Code.",
      "Open Pull Requests and Issues",
      "Not now",
    );
    if (choice === "Open Pull Requests and Issues") {
      recordFeatureUse("prv_tip_opened");
      await vscode.commands.executeCommand("andromity.openPullRequestsView");
    }
  } finally {
    asking = false;
  }
}
