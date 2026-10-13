import { randomBytes } from "crypto";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const BACKSLASH = String.fromCharCode(92);

function unicodeEscape(ch: string): string {
  return BACKSLASH + "u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
}

/** CSP nonce from a CSPRNG; Math.random() output is predictable. */
export function getNonce(): string {
  return randomBytes(16).toString("hex");
}

/** JSON for embedding inside an inline <script>. JSON.stringify leaves "<" and
 *  the JS line terminators U+2028/U+2029 as-is, so a value containing
 *  "</script>" would end the script element and inject markup. */
export function scriptJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/[<>&]/g, unicodeEscape)
    .split(LINE_SEPARATOR).join(unicodeEscape(LINE_SEPARATOR))
    .split(PARAGRAPH_SEPARATOR).join(unicodeEscape(PARAGRAPH_SEPARATOR));
}

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}
