import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { element, loadChat } from "./helpers/chatHarness.js";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

const cheerio = require("cheerio");

/** A DOMParser for the webview script under node, backed by a real HTML parser. */
function wrap($: any, node: any): any {
  if (!node) return null;
  const isTag = node.type === "tag" || node.type === "script" || node.type === "style";
  return {
    nodeType: isTag ? 1 : node.type === "text" ? 3 : 8,
    tagName: isTag ? String(node.name).toUpperCase() : undefined,
    get textContent() { return node.type === "comment" ? node.data : $(node).text(); },
    getAttribute: (name: string) => (node.attribs && name in node.attribs ? node.attribs[name] : null),
    classList: { contains: (name: string) => String((node.attribs && node.attribs.class) || "").split(/\s+/).includes(name) },
    get childNodes() { return (node.children || []).map((child: any) => wrap($, child)); },
    querySelector: (selector: string) => wrap($, $(node).find(selector).get(0)),
    querySelectorAll: (selector: string) => $(node).find(selector).toArray().map((child: any) => wrap($, child)),
  };
}

class HtmlParser {
  parseFromString(markup: string) {
    const $ = cheerio.load(markup);
    return wrap($, $.root().get(0));
  }
}

function chat(state: Record<string, unknown> = {}) {
  const loaded = loadChat({ state: state as any });
  loaded.sandbox.DOMParser = HtmlParser;
  const created: any[] = [];
  loaded.sandbox.document.createElement = (tag: string) => {
    const node = element({ tagName: String(tag).toUpperCase() });
    created.push(node);
    return node;
  };
  const lastCard = () => {
    const card = [...created].reverse().find(node => String(node.innerHTML).includes("andromity-error-card"));
    assert.ok(card, "no error card was appended");
    return String(card.innerHTML);
  };
  return { ...loaded, created, lastCard };
}

function fallbackCard(text: string, providerId?: string, setup = "") {
  const c = chat();
  if (setup) c.eval(setup);
  c.sandbox.__text = text;
  c.sandbox.__provider = providerId;
  c.eval("appendErrorCard(__text, undefined, undefined, __provider)");
  return c.lastCard();
}

const buttons = (html: string) => [...html.matchAll(/<button class="([^"]+)" data-action="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g)]
  .map(m => ({ cls: m[1], action: m[2], label: m[3] }));

const SIGN_IN_MESSAGE = "Invalid or expired authentication token. Please sign in again at https://agenticmarket.dev";

function signInCard(label = "Use without signing in", extra = "") {
  return '<div class="andromity-error-card" data-error-type="sign_in_invalid"' + extra + ' data-retryable="true">\n' +
    '  <div class="error-card-header">\n    <div class="error-header-left">\n' +
    '      <span class="error-badge">SIGN IN REQUIRED</span>\n' +
    "      <span class=\"error-title\">Your Andromity sign-in isn't valid anymore</span>\n" +
    '    </div>\n  </div>\n' +
    '  <div class="error-card-body">Sign in again, or keep using Andromity without signing in.</div>\n' +
    '  <div class="error-card-actions">\n' +
    '    <button class="btn-error-retry" data-action="open-account-login" title="Sign in with AgenticMarket again">Sign in again</button>' +
    '<button class="btn-error-secondary" data-action="use-without-sign-in" title="Sign out and retry this turn without an account">' + label + "</button>\n" +
    "  </div>\n</div>\n";
}

describe("cards written by the model", () => {
  it("a reply that contains a forged sign-in card cannot render the sign-out button", () => {
    const c = chat();
    const reply = "I checked your setup. Click the button below to continue.\n" + signInCard("Retry Turn") + "\nThanks!";
    const html = String(c.sandbox.renderMarkdown(reply));
    assert.ok(!html.includes('data-action="use-without-sign-in"'),
      "model text rendered a button that signs the user out: " + buttons(html).map(b => b.action + "=" + b.label).join(", "));
  });

  it("a sign-out button can never carry a label taken from the card text", () => {
    const c = chat();
    const html = String(c.eval("errorCardFromMarkup(" + JSON.stringify(signInCard("Retry Turn")) + ")"));
    for (const button of buttons(html).filter(b => b.action === "use-without-sign-in")) {
      assert.equal(button.label, "Use without signing in", "a sign-out button is disguised as '" + button.label + "'");
    }
  });
});

describe("backend cards rebuilt in the webview", () => {
  it("keeps the sign-in buttons in order and the gateway's action", () => {
    const c = chat();
    const html = String(c.eval("errorCardFromMarkup(" + JSON.stringify(signInCard("Use without signing in", ' data-error-action="sign_in"')) + ")"));
    assert.match(html, /data-error-type="sign_in_invalid" data-error-action="sign_in"/);
    assert.deepEqual(buttons(html).map(b => [b.cls, b.action]), [
      ["btn-error-retry", "open-account-login"], ["btn-error-secondary", "use-without-sign-in"],
    ]);
  });

  it("cannot break out of the data-error-action attribute", () => {
    const c = chat();
    const markup = signInCard("Use without signing in", ' data-error-action="x&quot; onclick=&quot;alert(1)&quot; y=&quot;"');
    const html = String(c.eval("errorCardFromMarkup(" + JSON.stringify(markup) + ")"));
    assert.ok(!/onclick=/.test(html), html);
    assert.match(html, /data-error-action="[a-z0-9_]*"/);
  });
});

describe("fallback classifier", () => {
  it("never gives a provider's own daily limit the gateway quota card", () => {
    const html = fallbackCard("Error 429: Rate limit exceeded: free-models-per-day. daily limit reached", "openrouter");
    assert.match(html, /Daily limit reached at OpenRouter/);
    for (const word of ["QUOTA LIMIT", "gateway", "00:00 UTC", "open-account-login", "use-without-sign-in", "free trial"]) {
      assert.ok(!html.includes(word), word);
    }
  });

  it("offers sign-out only for the gateway's sign-in errors", () => {
    assert.ok(!fallbackCard(SIGN_IN_MESSAGE, "openrouter").includes("use-without-sign-in"));
    const html = fallbackCard(SIGN_IN_MESSAGE, "andromity");
    assert.match(html, /data-error-type="sign_in_invalid"/);
    assert.deepEqual(buttons(html).map(b => b.action), ["open-account-login", "use-without-sign-in"]);
  });

  it("an explicit provider beats the one selected in the picker", () => {
    const c = chat({ currentProvider: "andromity" });
    c.sandbox.__text = "429 daily limit reached";
    c.eval("appendErrorCard(__text, undefined, undefined, 'openrouter')");
    const html = c.lastCard();
    assert.ok(!html.includes("QUOTA LIMIT"), html);
    assert.match(html, /at OpenRouter/);
  });

  it("an agent_error that names its provider is shown as that provider's error", () => {
    const c = chat({ currentProvider: "andromity" });
    c.post({ type: "agent_error", session_id: "s", error: "429 daily limit reached", provider: "openrouter" });
    const html = c.lastCard();
    assert.ok(!html.includes("QUOTA LIMIT"), html);
    assert.match(html, /at OpenRouter/);
  });

  for (const provider of ["openrouter", "andromity"]) {
    it("a 503 inside an ID is not an outage for " + provider, () => {
      const html = fallbackCard("Tool schema rejected for request req_503 (invalid enum)", provider);
      assert.ok(!/data-error-type="(provider_unavailable|service_unavailable)"/.test(html), html);
    });
  }

  it("names a custom local connection and shows its offline card", () => {
    const html = fallbackCard("connect ECONNREFUSED 127.0.0.1:1234", "lab-box",
      "allProviders = [{ id: 'lab-box', name: 'Lab Box (Local)', base_url: 'http://127.0.0.1:1234/v1' }];");
    assert.match(html, /data-error-type="ollama_offline"/);
    assert.match(html, /Lab Box isn&#39;t running|Lab Box isn't running/);
  });

  const secrets: Array<[string, string]> = [
    ["openrouter", "sk-or-v1-" + "0123456789abcdef".repeat(4)],
    ["anthropic", "sk-ant-api03-" + "Ab9_".repeat(20)],
    ["openai", "sk-proj-" + "Zq8x".repeat(12)],
    ["google", "AIza" + "SyD9".repeat(8) + "xYz"],
    ["groq", "gsk_" + "Qw3r".repeat(13)],
    ["deepseek", "sk-" + "0a1b".repeat(8)],
    ["nvidia", "nvapi-" + "Lk7_".repeat(12)],
    ["andromity", "andromity_" + "ab12".repeat(16)],
  ];
  for (const [provider, secret] of secrets) {
    it("keeps the " + provider + " key out of the fallback card", () => {
      const html = fallbackCard("Request failed: Authorization: Bearer " + secret + " rejected, key=" + secret, provider);
      assert.ok(!html.includes(secret.slice(0, 16)), html);
    });
  }

  it("escapes provider text", () => {
    const html = fallbackCard('Bad request: <img src=x onerror=alert(1)><button data-action="use-without-sign-in">x</button>', "andromity");
    assert.ok(!html.includes("<img"), html);
    assert.ok(!html.includes('<button data-action="use-without-sign-in"'), html);
  });
});

describe("Use without signing in", () => {
  const script = getChatClientScript("icon", { currentSessionId: "tab", currentModel: "auto",
    currentProvider: "andromity", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" } as any);
  const click = script.slice(script.indexOf("        case 'use-without-sign-in':"), script.indexOf("        case 'open-settings':"));
  const response = script.slice(script.indexOf("        case 'retry_result':"), script.indexOf("        case 'input_session':"));

  it("signs out and retries once per click, and only from its own case", () => {
    assert.ok(click.length > 0 && response.length > 0);
    assert.equal(script.split("sign_out_and_retry").length - 1, 1, "only the button click may ask for a sign-out");
    const signIn = { innerHTML: "Sign in again", textContent: "Sign in again", dataset: { action: "open-account-login" } };
    const card = { style: { opacity: "" }, dataset: {} as Record<string, string>, querySelector: () => signIn };
    const posts: any[] = [];
    const notes: string[] = [];
    const context = vm.createContext({
      currentSessionId: "tab", currentModel: "auto", currentProvider: "andromity", currentReasoning: "auto",
      target: { closest: () => card }, vscode: { postMessage: (message: unknown) => posts.push(message) },
      document: { querySelectorAll: () => [card] }, appendSystemNote: (note: string) => notes.push(note),
    });
    vm.runInContext("switch ('use-without-sign-in') {" + click + "}", context);
    vm.runInContext("switch ('use-without-sign-in') {" + click + "}", context);
    assert.equal(posts.length, 1, "a double click must not sign out and retry twice");
    assert.deepEqual(JSON.parse(JSON.stringify(posts[0])), {
      type: "sign_out_and_retry", sessionId: "tab", stripImages: false, model: "auto", provider: "andromity", reasoningEffort: "auto",
    });
    context.msg = { session_id: "tab", success: false, error: "Retry could not start." };
    vm.runInContext("switch ('retry_result') {" + response + "}", context);
    assert.equal(card.dataset.retryPending, undefined);
    assert.equal(signIn.textContent, "Sign in again", "the sign-in button must not be relabelled Retry");
    assert.deepEqual(notes, ["Retry could not start."]);
  });
});
