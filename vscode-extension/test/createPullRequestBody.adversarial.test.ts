// Independent adversarial tests for Create pull request: body + receipt, drafts, chips, secret scan, size, reviewers.
// Spec: private/design/create-pr/DESIGN.md 3.2, 3.4, 3.5, 3.6, 7.2 rules 4, 9, 11.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GITHUB_BODY_LIMIT, MAX_DESCRIPTION, cleanDraft, cleanTitle, composeBody, composeReceiptComment, mdCode, plainText, receiptLinkLine,
} from "../src/integrations/pullRequest/body.js";
import {
  MAX_REVIEWERS, addedLines, chooseReviewers, closedIssuesIn, isLockfile, looksBinary, mentionsIn, secretsInDiff, secretsInFile,
  secretsInText, sizeOf, sizeWarningLimit,
} from "../src/integrations/pullRequest/checks.js";
import { installVscodeStub } from "./helpers/prVscodeStub.js";

installVscodeStub();
const { extractTagged } = require("../src/integrations/GitCommit.js") as typeof import("../src/integrations/GitCommit.js");

const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const GH = "ghp_" + "A".repeat(36);
const link = { turnIndex: 2, commitSha: "a1b2c3d4e5f6a7b8c9d0", leftOut: [] as string[], extra: [] as string[] };

function receipt(details = 0, detailSize = 2000): string {
  const head = "### Andromity receipt · turn 3\n\n**Needs your eyes**\n- High · Changed a file that runs code: `.github/workflows/ci.yml`\n- High · Changed a sensitive file: `.env`\n";
  let out = head;
  for (let i = 0; i < details; i++) out += `\n<details>\n<summary>Section ${i}</summary>\n\n${("line " + i + " ").repeat(detailSize / 8)}\n</details>\n`;
  return out + "\n<sub>Built from Andromity's records, not by the AI. checksum abc</sub>";
}

describe("body: the receipt is the engine's text, unmodified (7.2 rule 9)", () => {
  it("contains the receipt byte for byte after a rule and the fixed line", () => {
    const md = "### Receipt\n\n| a | b |\n|---|---|\n| `x` | <b>y</b> |\n\u202eRTL in a path\u202c\n\t- tab\r\nCRLF line\n\u0007bell";
    const { body, receiptShortened } = composeBody("What changed.", { markdown: md, link });
    assert.equal(receiptShortened, false);
    assert.ok(body.endsWith(md), "receipt changed on the way into the body");
    const [desc, rest] = body.split("\n\n---\n\n");
    assert.equal(desc, "What changed.");
    assert.ok(rest.startsWith("<sub>Receipt for Andromity turn 3, committed as `a1b2c3d`.</sub>\n\n"), rest.slice(0, 120));
  });

  it("the fixed line names left-out and extra files, safely", () => {
    const line = receiptLinkLine({ turnIndex: 0, leftOut: [".env"], extra: ["README.md", "a`b.md", "x\ny</sub><img src=x>.md"] });
    assert.match(line, /^<sub>Receipt for Andromity turn 1\. This pull request leaves out 1 file the turn changed: `\.env`\. It also commits 3 files the turn did not change: /);
    assert.ok(line.endsWith("</sub>"));
    assert.ok(!line.includes("\n"), "a newline in a path breaks the line");
    assert.ok(line.includes("``a`b.md``"), line);
    const many = receiptLinkLine({ turnIndex: 4, leftOut: Array.from({ length: 25 }, (_, i) => `f${i}`), extra: [] });
    assert.match(many, /and 15 more/);
    assert.ok(!receiptLinkLine({ turnIndex: 0, commitSha: "not-a-sha; rm -rf", leftOut: [], extra: [] }).includes("rm -rf"));
  });

  it("mdCode can't be closed by the value", () => {
    for (const value of ["`", "``", "a ``` b", "`x`", " lead", "trail`"]) {
      const code = mdCode(value);
      const fence = /^`+/.exec(code)![0];
      assert.ok(!value.includes(fence), `${value} -> ${code}`);
    }
  });

  it("a model- or user-written description can't hide or swallow the receipt (unclosed comment, fence, details)", () => {
    for (const description of [
      "Looks fine.\n<!--", "Looks fine.\n```", "Looks fine.\n<details><summary>x</summary>", "Looks fine.\n~~~", "Looks fine.\n<pre>",
    ]) {
      const { body } = composeBody(description, { markdown: receipt(), link });
      const at = body.indexOf("<sub>Receipt for Andromity");
      const before = body.slice(0, at);
      const opens = (re: RegExp) => (before.match(re) || []).length;
      const openComment = opens(/<!--/g) > opens(/-->/g);
      const openFence = opens(/^```/gm) % 2 === 1 || opens(/^~~~/gm) % 2 === 1;
      const openDetails = opens(/<details>/gi) > opens(/<\/details>/gi);
      const openPre = opens(/<pre>/gi) > opens(/<\/pre>/gi);
      assert.ok(!openComment && !openFence && !openDetails && !openPre,
        `receipt rendered inside an unclosed construct from the description ${JSON.stringify(description)}`);
    }
  });
});

describe("body: GitHub's 65,536-character limit (3.5)", () => {
  it("cuts folded details first and keeps the header and Needs your eyes", () => {
    const md = receipt(60, 2000);
    const { body, receiptShortened } = composeBody("d".repeat(30_000), { markdown: md, link });
    assert.equal(receiptShortened, true);
    assert.ok(body.length <= GITHUB_BODY_LIMIT, String(body.length));
    assert.ok(body.includes("**Needs your eyes**") && body.includes("Changed a sensitive file"));
    assert.ok(body.includes("Receipt shortened to fit GitHub's limit"));
    assert.ok(body.includes("<sub>Receipt for Andromity turn 3"));
  });

  it("stays under the limit with the longest description the form accepts", () => {
    const { body } = composeBody("x".repeat(MAX_DESCRIPTION), { markdown: receipt(40, 4000), link: { ...link, leftOut: Array(10).fill("a/".repeat(100)), extra: Array(10).fill("b/".repeat(100)) } });
    assert.ok(body.length <= GITHUB_BODY_LIMIT, String(body.length));
    assert.ok(body.includes("Needs your eyes"));
  });

  it("a receipt without details is cut at a line boundary", () => {
    const md = receipt() + "\n" + Array.from({ length: 5000 }, (_, i) => `- command ${i} ran`).join("\n");
    const { body } = composeBody("y".repeat(20_000), { markdown: md, link });
    assert.ok(body.length <= GITHUB_BODY_LIMIT);
    const beforeNote = body.split("\n\n<sub>Receipt shortened")[0];
    assert.match(beforeNote.split("\n").pop()!, /^- command \d+ ran$/, "cut mid-line");
  });

  it("a receipt whose Needs-your-eyes list alone is huge still fits", () => {
    const md = "### Receipt\n**Needs your eyes**\n" + "- High · x\n".repeat(20_000);
    for (const fn of [() => composeBody("", { markdown: md, link }).body, () => composeReceiptComment({ markdown: md, link }).body]) {
      const body = fn();
      assert.ok(body.length <= GITHUB_BODY_LIMIT, String(body.length));
    }
  });

  it("description text is stripped of control and bidi characters and capped", () => {
    const { body } = composeBody("a\u0000b\u0007c\u202ed\u2066e\u200bf\r\ng", undefined);
    assert.equal(body, "abcdef\ng");
    assert.equal(plainText("x".repeat(MAX_DESCRIPTION + 10), MAX_DESCRIPTION).length, MAX_DESCRIPTION);
  });
});

describe("drafts and titles (3.4, 7.2 rule 4)", () => {
  it("drops trailers the model wrote, in any case or spacing, keeps the rest", () => {
    const draft = "fix(orders): round totals\n\n- Quantize\nCo-authored-by: Someone <a@b.c>\n  signed-off-by : Me <m@e>\nCO-AUTHORED-BY:x\nCo\u200b-authored-by: Hidden <h@i>\nAssisted-by: model\nReviewed-by: kept";
    const clean = cleanDraft(draft);
    assert.ok(!/co-authored-by|signed-off-by|assisted-by/i.test(clean), clean);
    assert.ok(clean.includes("Reviewed-by: kept") && clean.startsWith("fix(orders): round totals"));
  });

  it("removes control, zero-width and bidi characters (Trojan Source set, including U+061C and U+200E)", () => {
    const bidi = ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "\u061c"];
    for (const ch of bidi) {
      assert.equal(cleanTitle(`fix: a${ch}b`), "fix: ab", `U+${ch.charCodeAt(0).toString(16)} kept in the title`);
      assert.equal(cleanDraft(`fix: a${ch}b`), "fix: ab", `U+${ch.charCodeAt(0).toString(16)} kept in the draft`);
    }
    assert.equal(cleanTitle("a\nb\tc\u0000d"), "a b cd");
    assert.equal(cleanTitle("t".repeat(1000)).length, 256);
  });

  it("extractTagged takes the last real block and ignores think blocks", () => {
    const raw = "<think><pr_description>leak</pr_description></think><pr_description>and</pr_description>x<pr_description>\n```md\nReal description\n```\n</pr_description>";
    assert.equal(extractTagged(raw, "pr_description"), "Real description");
    assert.equal(extractTagged("<pr_description>abc", "pr_description"), "");
  });
});

describe("warning chips (3.5)", () => {
  it("mentions outside code, not emails", () => {
    assert.deepEqual(mentionsIn("Thanks @alice and (@acme/backend), mail a@b.com, `@code` and\n```\n@fenced\n```\n@bob."), ["@alice", "@acme/backend", "@bob"]);
    assert.deepEqual(mentionsIn("@-bad"), []);
  });

  it("closing keywords GitHub honours", () => {
    const text = "Fixes #12. closes acme/orders#3, Resolved: #7, FIX #1, `fixes #99`";
    assert.deepEqual(closedIssuesIn(text).sort(), ["#1", "#12", "#7", "acme/orders#3"].sort());
  });

  it("closing keyword with a full issue URL (GitHub closes these too)", () => {
    assert.ok(closedIssuesIn("Closes https://github.com/acme/orders/issues/5").length > 0, "URL form of a closing keyword not detected");
  });

  it("is bounded on hostile input", () => {
    const started = Date.now();
    mentionsIn("@a".repeat(200_000));
    closedIssuesIn("fixes ".repeat(100_000) + "#1");
    mentionsIn("```".repeat(50_000));
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });
});

describe("secret scan (3.6, 7.2 rule 11)", () => {
  it("flags added lines only, with the new file's line numbers", () => {
    const diff = [
      "diff --git a/config.ts b/config.ts", "index 1..2 100644", "--- a/config.ts", "+++ b/config.ts",
      "@@ -10,4 +10,5 @@ export const x = 1;",
      ` const old = "${GH}";`,
      "-const removed = \"" + AWS + "\";",
      "+const added = \"" + AWS + "\";",
      " const ctx = 1;",
      "+// fine",
      "\\ No newline at end of file",
      "@@ -40,2 +41,3 @@",
      " a",
      "+b",
      `+token = "${GH}"`,
    ].join("\n");
    const hits = secretsInDiff("config.ts", diff);
    assert.deepEqual(hits.map((h) => [h.kind, h.line]), [["AWS access key", 11], ["GitHub token", 43]]);
    for (const hit of hits) assert.equal(hit.path, "config.ts");
  });

  it("reads the engine's new-file diff shape and CRLF diffs", () => {
    const fresh = `--- /dev/null\n+++ b/k.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+${AWS}`;
    assert.deepEqual(secretsInDiff("k.txt", fresh).map((h) => h.line), [3]);
    const crlf = `--- a/x\r\n+++ b/x\r\n@@ -1 +1,2 @@\r\n a\r\n+${AWS}\r\n`;
    assert.deepEqual(secretsInDiff("x", crlf).map((h) => h.line), [2]);
  });

  it("does not read the +++ header or a removed '-- ' line as content", () => {
    const diff = `--- a/${AWS}.txt\n+++ b/${AWS}.txt\n@@ -1,2 +1,2 @@\n--- ${GH}\n+-- safe\n a`;
    assert.deepEqual(secretsInDiff(`${AWS}.txt`, diff), []);
  });

  it("a multi-file diff keeps line numbers per hunk", () => {
    const diff = `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -5,0 +6,1 @@\n+${AWS}`;
    assert.deepEqual(secretsInDiff("b", diff).map((h) => h.line), [6]);
  });

  it("whole-file scan and text fields give line numbers and never the value", () => {
    const file = `a\nb\nkey=${AWS}\n\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n`;
    const hits = [...secretsInFile("f", file), ...secretsInText("commit_message", `fix\n\n${GH}`), ...secretsInText("title", AWS + " x"),
      ...secretsInText("description", `one\ntwo\npostgres://u:hunter2pass@db.example.com/x`)];
    assert.deepEqual(hits.map((h) => [h.place, h.kind, h.line]), [
      ["file", "AWS access key", 3], ["file", "private key", 5], ["commit_message", "GitHub token", 3], ["title", "AWS access key", 1],
      ["description", "database URL with a password", 3],
    ]);
    const json = JSON.stringify(hits);
    for (const part of [AWS, AWS.slice(0, 8), GH.slice(0, 10), "MIIabc", "hunter2"]) assert.ok(!json.includes(part), `value leaked: ${part}`);
  });

  it("a large file is scanned quickly", { timeout: 20_000 }, () => {
    const big = ("const filler = 'abcdefghijklmnopqrstuvwxyz0123456789';\n").repeat(120_000) + `k=${AWS}\n`;
    const started = Date.now();
    const hits = secretsInFile("big.ts", big);
    assert.deepEqual(hits.map((h) => h.line), [120_001]);
    assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  });

  it("binary detection", () => {
    assert.equal(looksBinary(new Uint8Array([1, 2, 0, 3])), true);
    assert.equal(looksBinary(Buffer.from("text only")), false);
  });
});

describe("size (3.2)", () => {
  it("lockfiles are not counted, anywhere in the tree and in any case", () => {
    const size = sizeOf([
      { path: "web/package-lock.json", additions: 5000, deletions: 10 }, { path: "Cargo.lock", additions: 300, deletions: 0 },
      { path: "go.sum", additions: 1, deletions: 1 }, { path: "src/a.ts", additions: 30, deletions: 9 },
      { path: "img.png", additions: 0, deletions: 0, binary: true }, { path: "b.ts", additions: -5 as number, deletions: NaN },
    ]);
    assert.equal(size.lines, 39);
    assert.equal(size.files, 6);
    assert.deepEqual(size.lockfiles, ["web/package-lock.json", "Cargo.lock", "go.sum"]);
    assert.equal(isLockfile("C:\\x\\YARN.LOCK"), true);
    assert.equal(isLockfile("package-lock.json.bak"), false);
  });

  it("limit from settings: whole numbers, 0 turns it off, junk falls back to 300", () => {
    assert.equal(sizeWarningLimit(0), 0);
    assert.equal(sizeWarningLimit(150.9), 150);
    for (const junk of [-1, NaN, Infinity, "500", null, undefined, {}]) assert.equal(sizeWarningLimit(junk), 300, String(junk));
    assert.equal(sizeWarningLimit(1e12), 1_000_000);
  });
});

describe("reviewers (3.5)", () => {
  it("checks names, teams, self and the count", () => {
    const choice = chooseReviewers(["@priya", "Priya", "acme/backend", "other/team", "acme/a/b", "-bad", "bad-", "b--ad", "a".repeat(40),
      "me", "ME", "", 42, "__proto__", "constructor"], "acme", "Me");
    assert.deepEqual(choice.reviewers, ["priya", "constructor"]);
    assert.deepEqual(choice.teams, ["backend"]);
    assert.ok(choice.problems.some((p) => p.includes("isn't a team in acme")));
    assert.ok(choice.problems.some((p) => p.includes("yourself")));
    assert.ok(choice.problems.length >= 7, choice.problems.join(" | "));
    const many = chooseReviewers(Array.from({ length: MAX_REVIEWERS + 1 }, (_, i) => `user${i}`), "acme", undefined);
    assert.ok(many.problems.some((p) => p.includes(`at most ${MAX_REVIEWERS}`)));
    const long = chooseReviewers(["x".repeat(10_000) + "/y"], "acme", undefined);
    assert.ok(long.problems.every((p) => p.length < 200));
  });

  it("a team in a user-owned repository's owner is still a team of the owner only", () => {
    assert.deepEqual(chooseReviewers(["ACME/Backend"], "acme", undefined).teams, ["Backend"]);
  });

  it("addedLines tolerates garbage", () => {
    assert.deepEqual(addedLines(""), []);
    assert.deepEqual(addedLines("+not in a hunk\n@@ bad @@\n+x"), []);
  });
});
