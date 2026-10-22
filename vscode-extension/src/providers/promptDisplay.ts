export interface CollabWakePrompt {
  kind: "question" | "handoff";
  from: string;
  body: string;
}

/**
 * Recognise the prompt the server writes when another session wakes this one
 * (session_bus.question_wake_prompt / handoff_wake_prompt). The model needs the
 * instructions in it; people only need who asked and what.
 */
export function parseCollabWakePrompt(rawText: string): CollabWakePrompt | null {
  if (typeof rawText !== "string") return null;
  const text = rawText.replace(/\r\n/g, "\n");
  const question = text.match(/^\[Incoming Question from co-agent '([\s\S]*?)' \(ID: [^)\n]*\)\]:\n"([\s\S]*)"\n\nPlease address this question/);
  if (question) return { kind: "question", from: question[1], body: question[2] };
  const handoff = text.match(/^\[Incoming Task Handoff from co-agent '([\s\S]*?)' \(Phase: [^\n]*\)\]:\nSummary: ([\s\S]*?)\n\nPlease review the handoff/);
  if (handoff) return { kind: "handoff", from: handoff[1], body: handoff[2] };
  return null;
}

// Injected into webviews with toString(), and production builds rename identifiers, so this
// may only use its parameters and built-ins.
function formatPromptForDisplay(rawText: string, parseWake: (text: string) => CollabWakePrompt | null): string {
  if (typeof rawText !== "string") return "";
  const wake = parseWake(rawText);
  if (wake) return (wake.kind === "question" ? "Question from " : "Handoff from ") + (wake.from || "another session") + ": " + wake.body;
  return rawText
    .split(/\s+---\s*(?=\[(?:Active Document|Active Diagnostics|Selection in|Other Open Documents|Started from session|Background sessions))/)[0]
    .replace(/\[Active Document:[^\]\r\n]*\]/g, "")
    .replace(/\[(?:Other Open Documents|Active Diagnostics|Selection in)[^\]]*\]/gs, "")
    .trim();
}

/** Remove automatically appended IDE context only from presentation text. */
export function cleanPromptForDisplay(rawText: string): string {
  return formatPromptForDisplay(rawText, parseCollabWakePrompt);
}

export function getPromptDisplayScript(): string {
  return `const parseCollabWakePrompt = ${parseCollabWakePrompt.toString()};\n`
    + `const cleanPromptForDisplay = (rawText) => (${formatPromptForDisplay.toString()})(rawText, parseCollabWakePrompt);`;
}
