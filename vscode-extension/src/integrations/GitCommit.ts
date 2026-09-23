import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { ChatViewProvider } from "../providers/ChatViewProvider.js";

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
        // Build file change summary from Git API
        const changedFiles: string[] = [];
        for (const c of repo.state.indexChanges || []) {
          changedFiles.push(`staged: ${vscode.workspace.asRelativePath(c.uri)}`);
        }
        for (const c of repo.state.workingTreeChanges || []) {
          changedFiles.push(`unstaged: ${vscode.workspace.asRelativePath(c.uri)}`);
        }
        const fileListSummary = changedFiles.length > 0
          ? `Changed files (${changedFiles.length}):\n${changedFiles.slice(0, 40).map(f => `- ${f}`).join("\n")}\n\n`
          : "";

        // Prefer staged changes; fallback to working tree diff via daemon git.diff
        let diff = "";
        const hasStaged = (repo.state.indexChanges || []).length > 0;
        // Try git extension diff (staged if any, else all)
        try {
          // vscode.git API: repo.diff(true) = staged, diff(false)= unstaged
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

        // Retrieve active model and provider selected by the user in the IDE
        const chat = ChatViewProvider.currentProvider;
        const activeModel = chat?.getCurrentModel();
        const activeProvider = chat?.getCurrentProvider();

        const prompt = 
        `Write a concise conventional commit message for git (type(scope): subject) for the following git diff.\n${fileListSummary}Return ONLY the commit message (one-line conventional summary, plus optional bullet points for key changes). No code blocks, no quotes, max 72 chars for subject:\n\n${diff.slice(0, 8000)}`;

        // Use daemon quickPrompt with the user's active model & provider
        let commitMessage = "";
        try {
          const res = await rpcClient.call<any>(
            "agent.quickPrompt",
            {
              prompt,
              project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
              model: activeModel,
              provider: activeProvider,
            },
            35000
          );
          commitMessage = typeof res === "string" ? res : res?.message || res?.result || res?.commitMessage || "";
        } catch (e: any) {
          // Fallback: open chat with the diff prompt if quickPrompt unavailable
          if (String(e.message || e).includes("not found")) {
            vscode.window.showInformationMessage("Quick commit requires daemon update. Opening chat with diff prompt instead.");
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
