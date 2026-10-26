import { it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

let answer: string | undefined;
const asked: Array<{ question: string; detail?: string }> = [];
const opened: string[] = [];
const mockVscode = {
  Uri: {
    parse: (value: string, strict?: boolean) => {
      const match = /^([a-z][a-z0-9+.-]*):/i.exec(value);
      if (!match && strict) throw new Error("no scheme");
      return { scheme: match ? match[1].toLowerCase() : "", toString: () => value };
    },
  },
  window: {
    showInformationMessage: async (question: string, options: { detail?: string }) => {
      asked.push({ question, detail: options.detail });
      return answer;
    },
  },
  env: { openExternal: async (uri: { toString(): string }) => { opened.push(uri.toString()); return true; } },
};
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (id, ...args) {
  return id === "vscode" ? mockVscode : originalLoad.call(this, id, ...args);
};
const { confirmAndOpenLink } = require("../src/linkOpener.js");
loader._load = originalLoad;

it("shows the full address and opens only after Open is chosen", async () => {
  asked.length = 0; opened.length = 0;
  answer = undefined;
  assert.equal(await confirmAndOpenLink("https://example.com/a?b=1"), false);
  assert.deepEqual(asked, [{ question: "Open this link?", detail: "https://example.com/a?b=1" }]);
  assert.equal(opened.length, 0);
  answer = "Open";
  assert.equal(await confirmAndOpenLink(" https://example.com/a?b=1 "), true);
  assert.deepEqual(opened, ["https://example.com/a?b=1"]);
});

it("never asks about or opens anything that is not an http(s) link", async () => {
  asked.length = 0; opened.length = 0;
  answer = "Open";
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "command:workbench.action.terminal.new", "vscode://x", "not a url", "", 42, null]) {
    assert.equal(await confirmAndOpenLink(url), false, String(url));
  }
  assert.equal(asked.length, 0);
  assert.equal(opened.length, 0);
});
