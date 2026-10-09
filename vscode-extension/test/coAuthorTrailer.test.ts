import { it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
function stub(): any {
  const fn: any = function () { return stub(); };
  return new Proxy(fn, { get: (_t, key) => (key === Symbol.toPrimitive ? () => "" : stub()) });
}
Module.prototype.require = function (name: string) {
  if (name === "vscode") return stub();
  return originalRequire.apply(this, arguments);
};
const { appendCoAuthorTrailer, CO_AUTHOR_TRAILER } = require("../src/integrations/GitCommit.js");
Module.prototype.require = originalRequire;

it("appends the trailer as its own paragraph", () => {
  assert.equal(
    appendCoAuthorTrailer("feat: add thing\n\nBody text.\n"),
    `feat: add thing\n\nBody text.\n\n${CO_AUTHOR_TRAILER}`,
  );
});

it("still credits Andromity when a human co-author is already present", () => {
  const message = "fix: bug\n\nCo-authored-by: Jane <jane@example.com>";
  assert.equal(appendCoAuthorTrailer(message), `${message}\n${CO_AUTHOR_TRAILER}`);
});

it("does not duplicate an existing Andromity trailer", () => {
  const message = `fix: bug\n\n${CO_AUTHOR_TRAILER}`;
  assert.equal(appendCoAuthorTrailer(message), message);
});

it("does not treat a single-line subject as a trailer block", () => {
  assert.equal(appendCoAuthorTrailer("fix: bug"), `fix: bug\n\n${CO_AUTHOR_TRAILER}`);
});
