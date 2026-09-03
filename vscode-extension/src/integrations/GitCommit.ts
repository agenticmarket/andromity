import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";

/**
 * Generate AI commit message via Andromity daemon.
 * Uses vscode.git API to get diff, then asks daemon for Conventional Commit.
 */
export async function generateCommitMessage(rpcClient: RpcClient | null): Promise<void> {
  if (!rpcClient) {
    vscode.window.showErrorMessage("Andromity engine not connected. Try: Andromity: Restart Server");
    return;
  }

  const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
  if (!gitExtension) {
    vscode.window.showErrorMessage("Git extension not available. Ensure VS Code Git is enabled.");
    return;
  }

  const git = gitExtension.getAPI(1);
  const repo = git.repositories?.[0];
  if (!repo) {
    vscode.window.showErrorMessage("No Git repository found in workspace.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Andromity: Generating commit message...",
      cancellable: false,
    },
    async () => {
      try {
        // Prefer staged changes; fallback to working tree diff via daemon git.diff
        let diff = "";
        const hasStaged = repo.state.indexChanges.length > 0;
        // Try git extension diff (staged if any, else all)
        try {
          // vscode.git API: repo.diff(true) = staged, diff(false)= unstaged
          // We combine both for full picture; fallback to daemon if needed
          const staged = hasStaged ? await repo.diff(true) : "";
          const unstaged = await repo.diff(false);
          diff = (staged || "") + "\n" + (unstaged || "");
        } catch {
          // ignore, fallback below
        }

        // Fallback to daemon git.diff which returns HEAD diff
        if (!diff || diff.trim().length < 10) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const res = await rpcClient.call<{ diff: string }>("git.diff", {
            project_path: workspaceFolder,
          }, 15000);
          diff = res.diff || "";
        }

        if (!diff || diff.trim().length === 0) {
          vscode.window.showInformationMessage("No changes detected to generate a commit message.");
          return;
        }

        const prompt = 
        `Write a concise conventional commit message for git (type(scope): subject) for the following git diff. Return ONLY the commit message human readable explanation if needed imp things and major things included and what files are changed and in which directory, no quotes, max 300 chars subject, body optional bullet points if needed:\n\n${diff.slice(0, 6000)}`;

        // Use daemon quickPrompt (single LLM call) — added in rpc_handler.py: rpc_agent_quickPrompt
        let commitMessage = "";
        try {
          const res = await rpcClient.call<any>("agent.quickPrompt", { prompt, project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath }, 60000);
          commitMessage = typeof res === "string" ? res : res?.message || res?.result || res?.commitMessage || "";
        } catch (e: any) {
          // Fallback: open chat with the diff prompt if quickPrompt unavailable
          if (String(e.message || e).includes("not found")) {
            vscode.window.showInformationMessage("Quick commit requires daemon update. Opening chat with diff prompt instead.");
            // Copy prompt to clipboard and focus chat
            await vscode.env.clipboard.writeText(prompt);
            vscode.commands.executeCommand("andromity.chatView.focus");
            return;
          }
          throw e;
        }

        if (!commitMessage || commitMessage.trim().length < 5) {
          vscode.window.showWarningMessage("Daemon did not return commit message. Try again or check Output > Andromity.");
          return;
        }

        commitMessage = commitMessage.trim().replace(/^["'`]+|["'`]+$/g, "").trim();

        // Inject into SCM inputBox (VS Code Git API)
        repo.inputBox.value = commitMessage;
        vscode.window.showInformationMessage("Andromity: Commit message generated!");
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to generate commit message: ${err.message || err}`);
      }
    }
  );
}

export async function explainTerminalSelection(): Promise<void> {
  vscode.commands.executeCommand("andromity.chatView.focus");
  vscode.window.showInformationMessage("Paste the terminal error here, Andromity will explain and fix it.");
}
