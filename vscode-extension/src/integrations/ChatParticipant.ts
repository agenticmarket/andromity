import * as path from "path";
import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { ClarifyingQuestionsEvent, ToolApprovalEvent } from "../server/types.js";
import { EditorBridge } from "./EditorBridge.js";
import { runAgentTurn } from "./agentTurn.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";

export const CHAT_PARTICIPANT_ID = "andromity.agent";
export const DELEGATE_TOOL_NAME = "andromity_delegate";

export interface ChatIntegrationDeps {
  waitForClient(timeoutMs: number): Promise<RpcClient | null>;
  getTurnDefaults(): { model: string; provider: string; mode: string; profile: string; reasoningEffort: string };
}

const COMMAND_INSTRUCTIONS: Record<string, string> = {
  explain: "Explain the following clearly and concisely. Do not modify any files.",
  fix: "Find and fix the problem described below. Make the smallest correct change.",
  tests: "Write focused unit tests for the code described below, following the project's existing test conventions.",
};

interface ApprovalArgs {
  sessionId: string;
  approvalId: string;
  approved: boolean;
}

function workspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function describeReference(ref: vscode.ChatPromptReference): string | null {
  const value = ref.value;
  if (value instanceof vscode.Uri) return vscode.workspace.asRelativePath(value, false);
  if (value instanceof vscode.Location) {
    const file = vscode.workspace.asRelativePath(value.uri, false);
    return `${file} (lines ${value.range.start.line + 1}-${value.range.end.line + 1})`;
  }
  if (typeof value === "string") return value;
  return null;
}

/** Find the Andromity session a native chat thread already runs in, so
 *  follow-ups continue the same conversation and context. */
function previousSessionId(context: vscode.ChatContext): string | undefined {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i];
    if (turn instanceof vscode.ChatResponseTurn && turn.participant === CHAT_PARTICIPANT_ID) {
      const sessionId = turn.result.metadata?.sessionId;
      if (typeof sessionId === "string" && sessionId) return sessionId;
    }
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n…" : text;
}

function buildPrompt(request: vscode.ChatRequest): string {
  const instruction = request.command ? COMMAND_INSTRUCTIONS[request.command] : undefined;
  const references = request.references.map(describeReference).filter((r): r is string => !!r);
  let prompt = request.prompt.trim();
  if (instruction) prompt = `${instruction}\n\n${prompt}`;
  if (references.length) prompt += `\n\nReferenced:\n${references.map((r) => `- ${r}`).join("\n")}`;
  return EditorBridge.formatPromptWithEditorState(prompt, EditorBridge.getActiveContext(), true);
}

function streamApproval(stream: vscode.ChatResponseStream, event: ToolApprovalEvent) {
  const args = truncate(JSON.stringify(event.args ?? {}, null, 2), 1500);
  stream.markdown(`\n\n**Approval needed:** \`${event.tool_name}\`\n\n\`\`\`json\n${args}\n\`\`\`\n`);
  const base = { sessionId: event.session_id, approvalId: event.approval_id };
  stream.button({ command: "andromity.chat.resolveApproval", title: "Approve", arguments: [{ ...base, approved: true }] });
  stream.button({ command: "andromity.chat.resolveApproval", title: "Reject", arguments: [{ ...base, approved: false }] });
}

function streamQuestions(stream: vscode.ChatResponseStream, event: ClarifyingQuestionsEvent) {
  const list = event.questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
  stream.markdown(`\n\n**Andromity has a question:**\n\n${list}\n`);
  stream.button({ command: "andromity.chat.answerQuestions", title: "Answer", arguments: [event] });
}

async function answerQuestions(rpc: RpcClient, event: ClarifyingQuestionsEvent): Promise<void> {
  const answers: string[] = [];
  for (const question of event.questions) {
    let answer: string | undefined;
    if (question.options?.length && question.type !== "text") {
      const picked = await vscode.window.showQuickPick(question.options, {
        title: question.question,
        canPickMany: question.type === "multi",
        ignoreFocusOut: true,
      });
      if (picked === undefined) return;
      answer = Array.isArray(picked) ? picked.join(", ") : picked;
    } else {
      answer = await vscode.window.showInputBox({ title: question.question, ignoreFocusOut: true });
      if (answer === undefined) return;
    }
    answers.push(answer.trim());
  }
  const result = await rpc.call<{ success: boolean }>("agent.answer_question", {
    session_id: event.session_id,
    question_id: event.question_id,
    answers: answers.join(", "),
  });
  if (!result.success) void vscode.window.showWarningMessage("This question is no longer pending.");
}

/** VS Code's native chat (@andromity) and a language-model tool that lets
 *  Copilot agent mode delegate tasks. Both need VS Code 1.95+; on older
 *  editors this is a no-op so existing installs keep working. */
export function registerChatIntegration(context: vscode.ExtensionContext, deps: ChatIntegrationDeps): void {
  const chatApi = (vscode as any).chat;
  const lmApi = (vscode as any).lm;

  context.subscriptions.push(
    vscode.commands.registerCommand("andromity.chat.resolveApproval", async (args: ApprovalArgs) => {
      const rpc = await deps.waitForClient(3000);
      if (!rpc || !args?.approvalId) return;
      try {
        const result = await rpc.call<{ success: boolean; error?: string }>("agent.approve_tool", {
          session_id: args.sessionId,
          approval_id: args.approvalId,
          approved: args.approved === true,
          scope: "once",
        });
        if (!result.success) {
          void vscode.window.showWarningMessage(
            result.error === "Workspace is untrusted"
              ? "This workspace is untrusted. Enable workspace trust before approving tools."
              : "This request is no longer pending."
          );
        }
      } catch {
        void vscode.window.showErrorMessage("Could not send your response to Andromity. Reconnect and try again.");
      }
    }),
    vscode.commands.registerCommand("andromity.chat.answerQuestions", async (event: ClarifyingQuestionsEvent) => {
      const rpc = await deps.waitForClient(3000);
      if (!rpc || !event?.question_id) return;
      try {
        await answerQuestions(rpc, event);
      } catch {
        void vscode.window.showErrorMessage("Could not send your answer to Andromity. Reconnect and try again.");
      }
    })
  );

  if (typeof chatApi?.createChatParticipant === "function") {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
      const rpc = await deps.waitForClient(5000);
      if (!rpc) {
        stream.markdown("Andromity's engine isn't running yet. Run **Andromity: System Setup Check** and try again.");
        return { errorDetails: { message: "Andromity engine is not connected." } };
      }
      const defaults = deps.getTurnDefaults();
      const prompt = buildPrompt(request);
      recordFeatureUse(request.command ? "chat_participant_" + request.command : "chat_participant", { client: rpc });
      stream.progress("Andromity is working…");
      try {
        const result = await runAgentTurn(rpc, {
          prompt,
          projectPath: workspaceFolder(),
          sessionId: previousSessionId(chatContext),
          sessionName: `Chat: ${request.prompt.trim().slice(0, 40) || "VS Code chat"}`,
          model: defaults.model || undefined,
          provider: defaults.provider || undefined,
          mode: defaults.mode,
          profile: defaults.profile,
          reasoningEffort: defaults.reasoningEffort,
        }, {
          onText: (text) => stream.markdown(text),
          onToolStart: (name) => stream.progress(`Running ${name}…`),
          onApproval: (event) => streamApproval(stream, event),
          onQuestions: (event) => streamQuestions(stream, event),
        }, token);

        const root = workspaceFolder();
        if (result.turnFiles?.length && root) {
          stream.markdown("\n\n**Changed files:** ");
          for (const file of result.turnFiles.slice(0, 20)) {
            stream.anchor(vscode.Uri.file(path.isAbsolute(file) ? file : path.join(root, file)), file);
            stream.markdown(" ");
          }
        }
        stream.button({
          command: "andromity.openSessionInTab",
          title: "Open in Andromity",
          arguments: [{ id: result.sessionId, name: "VS Code chat" }],
        });
        if (result.outcome === "error") {
          return { errorDetails: { message: result.error || "The run failed." }, metadata: { sessionId: result.sessionId } };
        }
        return { metadata: { sessionId: result.sessionId } };
      } catch {
        return { errorDetails: { message: "Andromity could not start this request. Check the Andromity output for details." } };
      }
    };
    const participant: vscode.ChatParticipant = chatApi.createChatParticipant(CHAT_PARTICIPANT_ID, handler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    context.subscriptions.push(participant);
  }

  if (typeof lmApi?.registerTool === "function") {
    const tool: vscode.LanguageModelTool<{ task: string }> = {
      prepareInvocation(options) {
        return {
          invocationMessage: "Delegating to Andromity…",
          confirmationMessages: {
            title: "Run this task with Andromity?",
            message: new vscode.MarkdownString(truncate(options.input.task || "", 600)),
          },
        };
      },
      async invoke(options, token) {
        const rpc = await deps.waitForClient(5000);
        if (rpc) recordFeatureUse("copilot_delegate", { client: rpc });
        if (!rpc) throw new Error("Andromity's engine is not running. Run 'Andromity: System Setup Check'.");
        const defaults = deps.getTurnDefaults();
        const result = await runAgentTurn(rpc, {
          prompt: options.input.task,
          projectPath: workspaceFolder(),
          sessionName: `Copilot: ${(options.input.task || "").slice(0, 40)}`,
          model: defaults.model || undefined,
          provider: defaults.provider || undefined,
          mode: defaults.mode,
          profile: defaults.profile,
          reasoningEffort: defaults.reasoningEffort,
        }, {
          // Interactions surface in the Andromity panel, which follows every session.
          onApproval: () => void vscode.commands.executeCommand("andromity.openChat"),
          onQuestions: () => void vscode.commands.executeCommand("andromity.openChat"),
        }, token);
        const summary = result.outcome === "done"
          ? result.text || "Andromity finished without a text reply."
          : result.outcome === "cancelled" ? "The Andromity task was cancelled." : `Andromity failed: ${result.error}`;
        const files = result.turnFiles?.length ? `\n\nChanged files: ${result.turnFiles.join(", ")}` : "";
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(summary + files)]);
      },
    };
    context.subscriptions.push(lmApi.registerTool(DELEGATE_TOOL_NAME, tool));
  }
}
