import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { element, loadChat } from "./helpers/chatHarness.js";

const OPENROUTER_KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);
const GEMINI_KEY = "AIza" + "SyD9".repeat(8) + "xYz";
const SIGN_IN_TOKEN = "andromity_" + "ab12".repeat(16);
const BEARER = "abcdefgh12345678ijkl";
const MARKER = "•••";

const RAW_ERRORS: Array<[string, string]> = [
  [`Upstream refused key ${OPENROUTER_KEY} for this model`, OPENROUTER_KEY],
  [`API key not valid: ${GEMINI_KEY}`, GEMINI_KEY],
  [`Token ${SIGN_IN_TOKEN} was rejected`, SIGN_IN_TOKEN],
  [`Authorization: Bearer ${BEARER} was refused`, BEARER],
];

/** The card the chat shows for raw error text that did not arrive as an engine card. */
function fallbackCard(text: string): string {
  const loaded = loadChat({ state: {} as any });
  const created: any[] = [];
  loaded.sandbox.document.createElement = (tag: string) => {
    const node = element({ tagName: String(tag).toUpperCase() });
    created.push(node);
    return node;
  };
  loaded.sandbox.__text = text;
  loaded.eval("appendErrorCard(__text, undefined, undefined, 'openrouter')");
  const card = [...created].reverse().find(node => String(node.innerHTML).includes("andromity-error-card"));
  assert.ok(card, "no error card was appended");
  return String(card.innerHTML);
}

describe("redaction in chat error text", () => {
  it("never shows a key or token from raw error text", () => {
    for (const [text, secret] of RAW_ERRORS) {
      assert.ok(!fallbackCard(text).includes(secret), text);
    }
  });

  it("hides them behind the engine's marker, not square-bracket labels", () => {
    const bracketed: string[] = [];
    for (const [text] of RAW_ERRORS) {
      const html = fallbackCard(text);
      bracketed.push(...(html.match(/\[[^\]<]*redacted[^\]<]*\]/gi) || []));
      if (!html.includes(MARKER)) bracketed.push(`no ${MARKER} for: ${text.slice(0, 30)}`);
    }
    assert.deepEqual([...new Set(bracketed)], []);
  });
});
