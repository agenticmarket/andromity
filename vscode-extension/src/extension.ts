import * as vscode from "vscode";
import { AndromityCodeActionProvider } from "./integrations/CodeActionProvider.js";
import { EditorBridge } from "./integrations/EditorBridge.js";
import { generateCommitMessage } from "./integrations/GitCommit.js";
import { ChatViewProvider } from "./providers/ChatViewProvider.js";
import { ChangesTreeProvider } from "./providers/ChangesTreeProvider.js";
import { CronTreeProvider } from "./providers/CronTreeProvider.js";
import { PlanViewProvider } from "./providers/PlanViewProvider.js";
import { SessionTreeProvider } from "./providers/SessionTreeProvider.js";
import { SettingsPanel } from "./panels/SettingsPanel.js";
import { PlanEditorPanel } from "./panels/PlanEditorPanel.js";
import { PythonBridge } from "./server/PythonBridge.js";
import { RpcClient } from "./server/RpcClient.js";

let pythonBridge: PythonBridge | null = null;
let statusBarItem: vscode.StatusBarItem;
let currentPlan: any = null;

/** Reflects daemon turn state in the status bar (idle / running / approval needed). */
function bindStatusBarEvents(client: RpcClient) {
  client.on("agent/textDelta", () => {
    statusBarItem.text = "$(sync~spin) Andromity";
  });
  client.on("agent/toolStart", () => {
    statusBarItem.text = "$(sync~spin) Andromity";
  });
  client.on("agent/toolApprovalRequired", () => {
    statusBarItem.text = "$(alert) Andromity";
  });
  client.on("agent/askQuestions", () => {
    statusBarItem.text = "$(question) Andromity";
  });
  const idle = () => {
    statusBarItem.text = "$(sparkle) Andromity";
  };
  client.on("agent/done", idle);
  client.on("agent/cancelled", idle);
  client.on("agent/error", idle);
}

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Andromity AI (Daemon)");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("[Andromity] Activating extension...");

  // 1. Initialize Python Bridge Daemon
  pythonBridge = new PythonBridge(outputChannel);
  context.subscriptions.push({
    dispose: () => {
      pythonBridge?.dispose();
    },
  });

  // 2. Initialize Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "andromity.openChat";
  statusBarItem.text = "$(sparkle) Andromity";
  statusBarItem.tooltip = "Andromity AI Coding Agent";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 3. Register Providers
  const chatProvider = new ChatViewProvider(context.extensionUri, context);
  const planProvider = new PlanViewProvider(context.extensionUri);
  const sessionTreeProvider = new SessionTreeProvider();
  const cronTreeProvider = new CronTreeProvider();
  const changesTreeProvider = new ChangesTreeProvider();

  // Plan approve/reject flows through the chat session + queue (TUI parity).
  planProvider.setPlanActionHandler(async (approved, feedback) => {
    await chatProvider.handlePlanApproval(approved, feedback);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 4. Register Code Actions Provider
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new AndromityCodeActionProvider(),
      { providedCodeActionKinds: AndromityCodeActionProvider.providedCodeActionKinds }
    )
  );

  // 5. Connect Python Daemon and wire to providers on every (re)connection
  pythonBridge.onClientReady((rpcClient) => {
    chatProvider.setRpcClient(rpcClient);
    planProvider.setRpcClient(rpcClient);
    sessionTreeProvider.setRpcClient(rpcClient);
    cronTreeProvider.setRpcClient(rpcClient);
    changesTreeProvider.setRpcClient(rpcClient);
    SettingsPanel.currentPanel?.setRpcClient(rpcClient);
    PlanEditorPanel.currentPanel?.setRpcClient(rpcClient);
    bindStatusBarEvents(rpcClient);

    rpcClient.on("agent/planApproval", (params: any) => {
      if (params?.plan) {
        currentPlan = params.plan;
        chatProvider.updateCurrentPlan(params.plan);
        PlanEditorPanel.createOrShow(
          context.extensionUri,
          params.plan,
          rpcClient,
          async (approved, feedback) => {
            await chatProvider.handlePlanApproval(approved, feedback);
          }
        );
      }
    });

    rpcClient.on("agent/planUpdated", (params: any) => {
      if (params?.plan) {
        currentPlan = params.plan;
        chatProvider.updateCurrentPlan(params.plan);
        PlanEditorPanel.currentPanel?.updatePlan(params.plan);
      }
    });

    outputChannel.appendLine("[Andromity] Python daemon client wired successfully.");
  });

  pythonBridge
    .start()
    .catch((err) => {
      outputChannel.appendLine(`[Andromity] Failed to start Python daemon: ${err.message}`);
      vscode.window.showWarningMessage(
        `Andromity daemon could not start: ${err.message}. Ensure Python 3.11+ is installed.`
      );
    });

  // 6. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("andromity.openChat", () => {
      vscode.commands.executeCommand("andromity.chatView.focus");
    }),

    vscode.commands.registerCommand("andromity.newSession", async () => {
      const client = pythonBridge?.getClient();
      if (client) {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const res = await client.call<any>("session.create", {
            name: `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            project_path: workspaceFolder,
          });
          if (res?.id) {
            chatProvider.setCurrentSessionId(res.id);
            sessionTreeProvider.setCurrentSessionId(res.id);
            sessionTreeProvider.refresh();
            await vscode.commands.executeCommand("andromity.chatView.focus");
          }
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to create session: ${e.message}`);
        }
      } else {
        vscode.window.showWarningMessage("Andromity daemon is not connected yet.");
      }
    }),

    vscode.commands.registerCommand("andromity.switchSessionById", (sessionId: string) => {
      chatProvider.setCurrentSessionId(sessionId);
      sessionTreeProvider.setCurrentSessionId(sessionId);
      vscode.commands.executeCommand("andromity.chatView.focus");
    }),

    vscode.commands.registerCommand("andromity.askAboutSelection", async () => {
      const editorContext = EditorBridge.getActiveContext();
      if (!editorContext.selectedText) {
        vscode.window.showInformationMessage("Select some code first to ask Andromity.");
        return;
      }
      const prompt = await vscode.window.showInputBox({
        prompt: "What would you like to ask Andromity about this selection?",
        placeHolder: "e.g., How can I optimize this algorithm?",
      });
      if (prompt) {
        await chatProvider.sendPromptFromExternal(prompt, editorContext);
      }
    }),

    vscode.commands.registerCommand("andromity.explainCode", async () => {
      const editorContext = EditorBridge.getActiveContext();
      if (!editorContext.selectedText) {
        vscode.window.showInformationMessage("Select some code first to explain.");
        return;
      }
      await chatProvider.sendPromptFromExternal("Explain this code step-by-step in detail.", editorContext);
    }),

    vscode.commands.registerCommand("andromity.fixErrors", async (uri?: vscode.Uri, diagnostics?: vscode.Diagnostic[]) => {
      const editorContext = EditorBridge.getActiveContext();
      const prompt = "Please analyze and fix the errors/diagnostics reported in this code.";
      await chatProvider.sendPromptFromExternal(prompt, editorContext);
    }),

    vscode.commands.registerCommand("andromity.generateTests", async () => {
      const editorContext = EditorBridge.getActiveContext();
      const prompt = "Write comprehensive unit tests with edge cases for this code.";
      await chatProvider.sendPromptFromExternal(prompt, editorContext);
    }),

    vscode.commands.registerCommand("andromity.undoTurn", async () => {
      await vscode.commands.executeCommand("andromity.chatView.focus");
      chatProvider.requestUndoTurn();
    }),

    vscode.commands.registerCommand("andromity.viewGitDiff", async () => {
      await chatProvider.pickAndShowFileDiff();
    }),

    vscode.commands.registerCommand("andromity.showSessions", async () => {
      await vscode.commands.executeCommand("andromity.chatView.focus");
      chatProvider.toggleSessionsDrawer();
    }),

    vscode.commands.registerCommand("andromity.openPlanTab", (plan?: any) => {
      const planToShow = plan || currentPlan || chatProvider.getCurrentPlan();
      PlanEditorPanel.createOrShow(
        context.extensionUri,
        planToShow,
        pythonBridge?.getClient() || null,
        async (approved, feedback) => {
          await chatProvider.handlePlanApproval(approved, feedback);
        }
      );
    }),

    vscode.commands.registerCommand("andromity.openCrons", () => {
      SettingsPanel.createOrShow(
        context.extensionUri,
        pythonBridge?.getClient() || null,
        "crons",
        () => chatProvider.refreshConfig()
      );
    }),

    vscode.commands.registerCommand("andromity.openFileDiff", async (filePath: string, isUntracked: boolean) => {
      await chatProvider.openFileDiff(filePath, isUntracked);
    }),

    vscode.commands.registerCommand("andromity.refreshSessions", () => {
      sessionTreeProvider.refresh();
    }),

    vscode.commands.registerCommand("andromity.refreshCrons", () => {
      cronTreeProvider.refresh();
    }),

    vscode.commands.registerCommand("andromity.refreshChanges", () => {
      changesTreeProvider.refresh();
    }),

    vscode.commands.registerCommand("andromity.deleteSession", async (item: any) => {
      const client = pythonBridge?.getClient();
      if (!client || !item?.session?.id) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete session "${item.session.name || item.session.id}"?`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") return;
      try {
        await client.call("session.delete", { session_id: item.session.id });
        sessionTreeProvider.refresh();
        vscode.window.showInformationMessage("Session deleted.");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to delete session: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("andromity.compactSession", async () => {
      const client = pythonBridge?.getClient();
      if (!client) return;
      await vscode.commands.executeCommand("andromity.chatView.focus");
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await client.call("session.compact", { project_path: workspaceFolder });
        vscode.window.showInformationMessage("Context compacted successfully.");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to compact context: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("andromity.openModelHub", () => {
      SettingsPanel.createOrShow(
        context.extensionUri,
        pythonBridge?.getClient() || null,
        "models",
        () => chatProvider.refreshConfig()
      );
    }),

    vscode.commands.registerCommand("andromity.switchModel", async () => {
      const client = pythonBridge?.getClient();
      if (!client) return;
      try {
        const models = await client.call<any[]>("config.list_models", {});
        const items = [
          {
            label: "$(search) Browse Full Model Hub (396+ OpenRouter models)...",
            description: "Open dedicated full-tab catalog browser",
            detail: "Filter by Free Tier, Coding, Reasoning, Vision, and Providers",
            modelId: "__open_hub__",
            provider: "",
          },
          ...models.slice(0, 50).map((m) => ({
            label: m.name || m.id,
            description: `${m.provider} • ${m.pricing || ""}`,
            detail: m.desc || `Context: ${m.context_limit || "N/A"} tokens`,
            modelId: m.id,
            provider: m.provider,
          })),
        ];
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: "Select AI Model or Open Full Model Hub",
        });
        if (selected) {
          if (selected.modelId === "__open_hub__") {
            vscode.commands.executeCommand("andromity.openModelHub");
          } else {
            await client.call("config.set", { key: "model", value: selected.modelId });
            if (selected.provider) {
              await client.call("config.set", { key: "provider", value: selected.provider });
            }
            await chatProvider.refreshConfig();
            vscode.window.showInformationMessage(`Active model switched to ${selected.label}`);
          }
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to list models: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("andromity.switchProfile", async () => {
      const client = pythonBridge?.getClient();
      if (!client) return;
      const profiles = [
        { label: "Builder", detail: "Plans architecture first, then implements changes.", profile: "builder" },
        { label: "Coder", detail: "Direct implementation without planning phase.", profile: "coder" },
        { label: "Reviewer", detail: "Read-only mode for audits and inspections.", profile: "reviewer" },
        { label: "Planner", detail: "Produces plans and architectures without editing files.", profile: "planner" },
      ];
      const selected = await vscode.window.showQuickPick(profiles, {
        placeHolder: "Select Agent Profile",
      });
      if (selected) {
        await client.call("config.set", { key: "profile", value: selected.profile });
        await chatProvider.refreshConfig();
        SettingsPanel.currentPanel?.loadData();
        vscode.window.showInformationMessage(`Agent profile switched to ${selected.label}`);
      }
    }),

    vscode.commands.registerCommand("andromity.switchMode", async () => {
      const client = pythonBridge?.getClient();
      const modes = [
        { label: "SAFE", detail: "Requires approval for every file write and shell command.", mode: "safe" },
        { label: "TRUST", detail: "Auto-approves direct file writes in trusted workspace directories.", mode: "trust" },
        { label: "FULL", detail: "Auto-approves all actions and logs them to the UI stream.", mode: "full" },
        { label: "YOLO", detail: "Silent autonomous mode without review prompts.", mode: "yolo" },
      ];
      const selected = await vscode.window.showQuickPick(modes, {
        placeHolder: "Select Trust Governance Permission Mode",
      });
      if (selected) {
        const config = vscode.workspace.getConfiguration("andromity");
        await config.update("permissionMode", selected.mode, vscode.ConfigurationTarget.Global);
        if (client) {
          await client.call("config.set", { key: "permission_mode", value: selected.mode });
        }
        await chatProvider.refreshConfig();
        SettingsPanel.currentPanel?.loadData();
        vscode.window.showInformationMessage(`Permission mode switched to ${selected.label}`);
      }
    }),

    vscode.commands.registerCommand("andromity.openSettings", () => {
      SettingsPanel.createOrShow(
        context.extensionUri,
        pythonBridge?.getClient() || null,
        "keys",
        () => chatProvider.refreshConfig()
      );
    }),

    vscode.commands.registerCommand("andromity.restartServer", async () => {
      if (pythonBridge) {
        try {
          const rpcClient = await pythonBridge.restart();
          chatProvider.setRpcClient(rpcClient);
          planProvider.setRpcClient(rpcClient);
          sessionTreeProvider.setRpcClient(rpcClient);
          cronTreeProvider.setRpcClient(rpcClient);
          changesTreeProvider.setRpcClient(rpcClient);
          SettingsPanel.currentPanel?.setRpcClient(rpcClient);
          bindStatusBarEvents(rpcClient);
          vscode.window.showInformationMessage("Andromity daemon restarted successfully.");
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to restart daemon: ${e.message}`);
        }
      }
    }),

    vscode.commands.registerCommand("andromity.generateCommitMessage", async () => {
      await generateCommitMessage(pythonBridge?.getClient() || null);
    }),

    vscode.commands.registerCommand("andromity.explainTerminalSelection", async () => {
      // Terminal has no direct selection API — guide user to use chat
      vscode.commands.executeCommand("andromity.chatView.focus");
      vscode.window.showInformationMessage(
        "Copy the terminal error output, then use Andromity: Ask About Selection or paste it in the chat for explanation."
      );
      await chatProvider.sendPromptFromExternal(
        "Explain the last terminal error and propose a fix. (Paste the error output below if available.)"
      );
    })
  );
}

export function deactivate() {
  if (pythonBridge) {
    pythonBridge.dispose();
    pythonBridge = null;
  }
}
