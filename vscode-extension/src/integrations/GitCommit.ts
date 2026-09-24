import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { ChatViewProvider } from "../providers/ChatViewProvider.js";

/**
 * Extract commit message from AI response.
 * Handles <commit_message> tags, <think> tags, markdown code blocks, and reasoning leaks.
 * Priority order:
 *   1. Strip <think>...</think> reasoning blocks (DeepSeek-R1, Qwen, etc.)
 *   2. Extract from <commit_message>...</commit_message> tag
 *   3. Fallback: scan for first conventional commit header line
 *   4. Strip any remaining markdown code fences or wrapping quotes
 */
export function extractCommitMessage(raw: string): string {
  if (!raw) return "";
  let text = raw.trim();

  // 1. Strip any <think>...</think> reasoning blocks
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. Extract content from <commit_message>...</commit_message> tag if present
  const tagMatch = text.match(/<commit_message>([\s\S]*?)(?:<\/commit_message>|$)/i);
  if (tagMatch && tagMatch[1].trim()) {
    text = tagMatch[1].trim();
  } else {
    // 3. Fallback: model ignored tags â€” find the first conventional commit header line
    //    and take everything from there onward (skips any preceding thinking/preamble)
    const lines = text.split("\n");
    const commitLineIndex = lines.findIndex(line =>
      /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9_./\\-]+\))?!?:\s*.+/i.test(line.trim())
    );
    if (commitLineIndex > 0) {
      text = lines.slice(commitLineIndex).join("\n").trim();
    }
  }

  // 4. Strip markdown code fences (```git, ```text, ```) and wrapping quotes
  text = text.replace(/^```[a-zA-Z0-9_-]*\n?/gm, "").replace(/```$/gm, "").trim();
  text = text.replace(/^["'`]+|["'`]+$/g, "").trim();

  return text;
}

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
          // vscode.git API: repo.diff(true) = staged, diff(false) = unstaged
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
`Write a concise professional commit message for git following Conventional Commits (type(scope): subject <= 72 chars, plus optional bullet points for key changes) for the following git diff.
${fileListSummary}
STRICT FORMAT RULES:
1. You MUST enclose your final commit message strictly inside <commit_message> and </commit_message> tags.
2. Put ONLY the commit message inside <commit_message>...</commit_message> â€” no markdown code fences, no backticks, no quotes, no explanations.
3. Any thinking, analysis, reasoning, or draft notes MUST remain OUTSIDE the <commit_message> tags.

Example of correct output:
<commit_message>
feat(portfolio): add portfolio and project implementations

- Add Pantry Pilot, Snake Rush, and ReconcileKit
- Add project tests, configuration, and documentation
</commit_message>

Diff:
${diff.slice(0, 8000)}`;

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
          vscode.window.showErrorMessage(
            `Failed to generate commit message: ${e?.message || e}. Please check your provider API key in Settings.`
          );
          return;
        }

        // Extract clean commit message â€” strips thinking blocks, <commit_message> tags, code fences
        commitMessage = extractCommitMessage(commitMessage);

        if (!commitMessage || commitMessage.trim().length < 5) {
          vscode.window.showWarningMessage(
            "Daemon returned an empty commit message. Please verify your provider API key in Settings."
          );
          return;
        }

        // Check if user has enabled Co-authored-by trailer in Andromity settings
        const config = vscode.workspace.getConfiguration("andromity");
        const includeCoAuthor = config.get<boolean>("includeCoAuthor", true);
        const coAuthorTrailer = "Co-authored-by: Andromity <333054755+andromity-bot@users.noreply.github.com>";

        if (includeCoAuthor && !commitMessage.includes("Co-authored-by:")) {
          commitMessage = `${commitMessage}\n\n${coAuthorTrailer}`;
        }

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
