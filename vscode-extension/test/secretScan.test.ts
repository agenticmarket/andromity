import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { findSecrets, getSecretScanScript, redactSecrets } from "../src/secretScan.js";
import { element, loadChat } from "./helpers/chatHarness.js";

// Built at run time so this file never looks like it holds a credential.
const fake = {
  github: "gh" + "p_" + "A1b2C3d4E5".repeat(4).slice(0, 36),
  githubPat: "github" + "_pat_" + "x1".repeat(41),
  aws: "AK" + "IA" + "QWERTYUIOPASDFGH",
  anthropic: "sk-" + "ant-api03-" + "z".repeat(40),
  openrouter: "sk-" + "or-v1-" + "a".repeat(48),
  openai: "sk-" + "proj-" + "B".repeat(48),
  google: "AI" + "za" + "S".repeat(35),
  slack: "xo" + "xb-" + "1234567890-abcdef",
  stripe: "sk" + "_live_" + "9".repeat(24),
  hf: "hf" + "_" + "h".repeat(34),
  jwt: "ey" + "JhbGciOiJIUzI1NiJ9.ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
  pem: "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END " + "OPENSSH PRIVATE KEY-----",
  db: "postgres://admin:" + "hunter2pass" + "@db.internal:5432/app",
};

const labels = (text: string) => findSecrets(text).map(s => s.label);

describe("findSecrets", () => {
  it("recognises common credential formats inside ordinary prose", () => {
    const expected: Record<keyof typeof fake, string> = {
      github: "GitHub token", githubPat: "GitHub token", aws: "AWS access key", anthropic: "Anthropic API key",
      openrouter: "OpenRouter API key", openai: "API key", google: "Google API key", slack: "Slack token",
      stripe: "Stripe live key", hf: "Hugging Face token", jwt: "JSON Web Token", pem: "private key",
      db: "database URL with a password",
    };
    for (const [key, label] of Object.entries(expected)) {
      const value = fake[key as keyof typeof fake];
      assert.deepEqual(labels("here is my config: " + value + " can you fix it?"), [label], key);
    }
  });

  it("leaves ordinary developer text alone", () => {
    for (const text of [
      "Refactor the auth middleware to rotate JWTs every 15 minutes",
      "process.env.OPENAI_API_KEY is undefined in production",
      "git checkout -b feature/sk-learn-upgrade && npm test",
      "postgres://localhost:5432/app has no password set",
      "Use AKIA-style keys only in CI, never locally",
      "const key = 'sk-test'; // placeholder",
      "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "-----BEGIN PUBLIC KEY----- is fine to share",
    ]) {
      assert.deepEqual(labels(text), [], text);
    }
  });

  it("previews without revealing the secret and finds every occurrence once", () => {
    const text = fake.github + " and again " + fake.github + " plus " + fake.aws;
    const found = findSecrets(text);
    assert.equal(found.length, 3);
    for (const s of found) {
      assert.ok(s.preview.length <= 11, s.preview);
      assert.ok(!text.slice(s.start, s.end).startsWith(s.preview.replace("…", "")) || s.preview.includes("…"));
    }
    assert.ok(!found[0].preview.includes(fake.github.slice(10, 30)));
  });

  it("redacts exactly the secrets and keeps the rest of the message", () => {
    const text = "token=" + fake.github + "\nurl=" + fake.db + "\nplease debug";
    const out = redactSecrets(text, findSecrets(text));
    assert.equal(out, "token=[REDACTED GitHub token]\nurl=[REDACTED database URL with a password]/app\nplease debug");
    assert.deepEqual(findSecrets(out), []);
    assert.equal(redactSecrets("plain", []), "plain");
  });

  it("stays fast on large pasted logs", () => {
    const log = ("INFO request ok id=" + "a".repeat(40) + "\n").repeat(5000) + fake.aws;
    const start = Date.now();
    assert.deepEqual(labels(log), ["AWS access key"]);
    assert.ok(Date.now() - start < 1500);
    const unterminatedKey = "-----BEGIN " + "RSA PRIVATE KEY-----\n" + "A".repeat(100_000);
    assert.deepEqual(labels(unterminatedKey), ["private key"]);
  });

  it("runs from its injected source alone", () => {
    const sandbox: any = {};
    vm.createContext(sandbox);
    vm.runInContext(getSecretScanScript() + "this.out = redactSecrets(this.t, findSecrets(this.t));", Object.assign(sandbox, { t: "k " + fake.aws }));
    assert.equal(sandbox.out, "k [REDACTED AWS access key]");
  });
});

describe("sending a message that contains a secret", () => {
  function chatWithPrompt(text: string, provider = "openrouter") {
    const inserted: any[] = [];
    const prompt = element({ tagName: "TEXTAREA", value: text });
    const promptBox = element();
    const chat = loadChat({
      state: { currentProvider: provider },
      elements: { "prompt-input": prompt },
    });
    chat.promptBox.parentElement = element({ insertBefore: (node: any) => { inserted.push(node); return node; } });
    return { chat, prompt, inserted, promptBox };
  }
  const sent = (chat: any) => chat.posted.filter((m: any) => m.type === "send_prompt" || m.type === "submit_input");

  it("holds the message and asks first", () => {
    const { chat, inserted } = chatWithPrompt("deploy with " + fake.github);
    chat.promptKey({ key: "Enter" });
    assert.equal(sent(chat).length, 0);
    assert.equal(inserted.length, 1);
  });

  it("sends straight away when nothing looks secret, or when the model runs locally", () => {
    const plain = chatWithPrompt("add tests for the parser");
    plain.chat.promptKey({ key: "Enter" });
    assert.equal(sent(plain.chat).length, 1);
    const local = chatWithPrompt("deploy with " + fake.github, "ollama");
    local.chat.promptKey({ key: "Enter" });
    assert.equal(sent(local.chat).length, 1);
  });
});
