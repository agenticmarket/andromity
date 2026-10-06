/** Remove automatically appended IDE context only from presentation text. */
export function cleanPromptForDisplay(rawText: string): string {
  if (typeof rawText !== "string") return "";
  return rawText
    .split(/\s+---\s*(?=\[(?:Active Document|Active Diagnostics|Selection in|Other Open Documents))/)[0]
    .replace(/\[Active Document:[^\]\r\n]*\]/g, "")
    .replace(/\[(?:Other Open Documents|Active Diagnostics|Selection in)[^\]]*\]/gs, "")
    .trim();
}

export function getPromptDisplayScript(): string {
  return `const cleanPromptForDisplay = ${cleanPromptForDisplay.toString()};`;
}
