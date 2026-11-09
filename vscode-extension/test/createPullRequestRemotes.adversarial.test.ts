// Independent adversarial tests for Create pull request: remote parsing, host page URLs and branch names.
// Written against private/design/create-pr/DESIGN.md (3.1, 5, 7.2), not against the implementation's notes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  enterpriseHostsFrom, newPullRequestUrl, parseRemoteUrl, pullRequestNumberFromUrl, requestNoun, ssoUrlFromHeader,
} from "../src/integrations/pullRequest/remotes.js";
import {
  DEFAULT_BRANCH_PREFIX, MAX_BRANCH_LENGTH, branchPrefix, firstFreeName, isValidBranchName, slugFromSubject, suggestBranchName,
} from "../src/integrations/pullRequest/branchName.js";
import { isLocalRemote } from "../src/integrations/pullRequest/flow.js";

const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";

describe("remote parsing: credentials never surface (DESIGN 3.1, 7.1)", () => {
  const withCreds = [
    `https://x-access-token:${SECRET}@github.com/acme/orders.git`,
    `https://${SECRET}@github.com/acme/orders.git`,
    `https://${SECRET}:x-oauth-basic@github.com/acme/orders`,
    `http://user:${SECRET}@gitlab.example.com/group/sub/orders.git`,
    `https://user:${encodeURIComponent(SECRET + "@:/")}@bitbucket.org/acme/orders.git`,
    `ssh://${SECRET}@github.com/acme/orders.git`,
    `https://org:${SECRET}@dev.azure.com/org/proj/_git/orders`,
    `https://github.com/acme/orders.git?access_token=${SECRET}`,
    `https://github.com/acme/orders.git#${SECRET}`,
  ];
  for (const url of withCreds) {
    it(`strips secrets from ${url.replace(SECRET, "<token>")}`, () => {
      const parsed = parseRemoteUrl(url);
      assert.ok(parsed, "a remote with credentials is still a valid remote");
      const json = JSON.stringify(parsed);
      assert.ok(!json.includes(SECRET), `token leaked: ${json}`);
      assert.ok(!json.includes("x-access-token") && !json.includes("x-oauth-basic") && !json.includes("user:"), json);
      assert.ok(!parsed.display.includes("@"), parsed.display);
      assert.ok(!parsed.webBase.includes("@"), parsed.webBase);
    });
  }
});

describe("remote parsing: shapes (DESIGN 8 tests list)", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["https://github.com/acme/orders.git", { kind: "github", owner: "acme", repo: "orders", display: "github.com/acme/orders" }],
    ["https://github.com/acme/orders", { kind: "github", owner: "acme", repo: "orders" }],
    ["https://github.com/acme/orders/", { kind: "github", owner: "acme", repo: "orders" }],
    ["https://github.com/acme/orders.git/", { kind: "github", owner: "acme", repo: "orders" }],
    ["HTTPS://GitHub.COM/Acme/Orders.GIT", { kind: "github", owner: "Acme", repo: "Orders", host: "github.com" }],
    ["git@github.com:acme/orders.git", { kind: "github", owner: "acme", repo: "orders", webBase: "https://github.com" }],
    ["git@github.com:/acme/orders.git", { kind: "github", owner: "acme", repo: "orders" }],
    ["ssh://git@github.com/acme/orders.git", { kind: "github", owner: "acme", repo: "orders" }],
    ["ssh://git@github.com:22/acme/orders.git", { kind: "github", owner: "acme", repo: "orders", webBase: "https://github.com" }],
    ["ssh://git@ssh.github.com:443/acme/orders.git", { kind: "github", owner: "acme", repo: "orders", host: "github.com" }],
    ["github.com:acme/orders.git", { kind: "github", owner: "acme", repo: "orders" }],
    ["git://github.com/acme/orders.git", { kind: "github" }],
    ["https://gitlab.com/group/sub/orders.git", { kind: "gitlab", owner: "group/sub", repo: "orders" }],
    ["git@gitlab.com:group/sub/deeper/orders.git", { kind: "gitlab", owner: "group/sub/deeper", repo: "orders" }],
    ["https://gitlab.example.com:8443/team/orders.git", { kind: "gitlab", port: "8443", webBase: "https://gitlab.example.com:8443" }],
    ["https://bitbucket.org/acme/orders.git", { kind: "bitbucket", owner: "acme", repo: "orders" }],
    ["https://codeberg.org/acme/orders.git", { kind: "gitea" }],
    ["https://dev.azure.com/org/proj/_git/orders", { kind: "azure", owner: "org/proj", repo: "orders", host: "dev.azure.com" }],
    ["git@ssh.dev.azure.com:v3/org/proj/orders", { kind: "azure", owner: "org/proj", repo: "orders" }],
    ["https://org.visualstudio.com/proj/_git/orders", { kind: "azure", owner: "org/proj", repo: "orders" }],
    ["https://org.visualstudio.com/DefaultCollection/proj/_git/orders", { kind: "azure", owner: "org/proj", repo: "orders" }],
    ["http://git.internal:3000/acme/orders.git", { kind: "other", webBase: "http://git.internal:3000" }],
  ];
  for (const [url, expected] of cases) {
    it(url, () => {
      const parsed = parseRemoteUrl(url);
      assert.ok(parsed, `should parse ${url}`);
      for (const [key, value] of Object.entries(expected)) assert.equal((parsed as any)[key], value, `${key} of ${url}`);
    });
  }

  it("http remotes keep http, https remotes never downgrade", () => {
    assert.equal(parseRemoteUrl("https://git.internal/a/b")!.webBase, "https://git.internal");
    assert.equal(parseRemoteUrl("git@git.internal:a/b")!.webBase, "https://git.internal");
  });

  it("an Azure DevOps project name with a space (very common) is recognised", () => {
    // Azure project names may contain spaces; git stores them percent-encoded in the remote URL.
    const parsed = parseRemoteUrl("https://dev.azure.com/contoso/My%20Project/_git/orders");
    assert.ok(parsed, "Azure remote with a space in the project name was not recognised");
    assert.equal(parsed.kind, "azure");
    const url = newPullRequestUrl(parsed, "main", "andromity/x");
    assert.ok(url && new URL(url).pathname.startsWith("/contoso/My%20Project/_git/orders/"), String(url));
  });
});

describe("remote parsing: lookalike hosts are never GitHub (DESIGN 5, 7.2)", () => {
  const lookalikes = [
    "https://github.com.evil.io/acme/orders.git",
    "https://evilgithub.com/acme/orders.git",
    "https://github.co/acme/orders.git",
    "https://github.com@evil.io/acme/orders.git",
    "https://evil.io/github.com/acme",
    "git@github.com.evil.io:acme/orders.git",
    "https://api.github.com/acme/orders",
    "https://gist.github.com/acme/orders",
    "https://xn--gthub-n4a.com/acme/orders",
    "https://gіthub.com/acme/orders",
    "https://github.com./acme/orders.git/../../evil",
  ];
  for (const url of lookalikes) {
    it(url, () => {
      const parsed = parseRemoteUrl(url);
      if (parsed) {
        assert.notEqual(parsed.kind, "github", `${url} classified as github`);
        assert.notEqual(parsed.host, "github.com", `${url} mapped to github.com`);
      }
    });
  }

  it("a trailing-dot github.com is either github.com itself or refused, never another host", () => {
    const parsed = parseRemoteUrl("https://github.com./acme/orders.git");
    if (parsed) assert.equal(parsed.host, "github.com");
  });

  it("GitHub Enterprise is recognised only from the configured https/http uri", () => {
    assert.deepEqual(enterpriseHostsFrom("https://GHE.acme.corp/"), ["ghe.acme.corp"]);
    assert.deepEqual(enterpriseHostsFrom("javascript:alert(1)"), []);
    assert.deepEqual(enterpriseHostsFrom("file:///etc/passwd"), []);
    assert.deepEqual(enterpriseHostsFrom(42), []);
    assert.equal(parseRemoteUrl("https://ghe.acme.corp/acme/orders.git", ["ghe.acme.corp"])!.kind, "ghe");
    assert.equal(parseRemoteUrl("https://ghe.acme.corp.evil.io/acme/orders.git", ["ghe.acme.corp"])!.kind, "other");
  });
});

describe("remote parsing: refuses what it can't read with confidence", () => {
  const refused = [
    "", "   ", "/srv/git/orders.git", "./orders.git", "../orders.git", "C:\\repos\\orders.git", "C:/repos/orders.git",
    "\\\\server\\share\\orders.git", "file:///srv/git/orders.git", "https://github.com/acme", "https://github.com/acme/orders/extra",
    "https://github.com/./orders", "https://github.com/../orders", "https://github.com/acme/..", "https://github.com/a%2Fb/orders",
    "https://github.com/acme/orders\u0000", "https://github.com/acme/or ders", "https://github.com/acme/orders\nhttps://evil.io/a/b",
    "javascript:alert(1)//github.com/a/b", "data:text/html,github.com/a/b", "ext::sh -c touch% /tmp/pwned", "https://",
    "https://github.com/acme/" + "a".repeat(5000), "https://github.com/acme/<script>", "https://github.com/acme/%3Cscript%3E",
    "https://github.com/acme/orders\u202e", "-oProxyCommand=evil:acme/orders",
  ];
  for (const url of refused) {
    it(JSON.stringify(url.slice(0, 60)), () => {
      const started = Date.now();
      const parsed = parseRemoteUrl(url);
      assert.ok(Date.now() - started < 200, "parsing must stay fast");
      if (parsed) {
        // Anything accepted must at least be safe to show and to build URLs from.
        assert.match(parsed.owner, /^[A-Za-z0-9._~\/-]+$/, `${url} -> owner ${parsed.owner}`);
        assert.match(parsed.repo, /^[A-Za-z0-9._~-]+$/, `${url} -> repo ${parsed.repo}`);
        assert.notEqual(parsed.kind, "github", `${url} must not be read as GitHub`);
      }
    });
  }

  it("non-string input", () => {
    for (const value of [null, undefined, 42, {}, [], { toString: () => "https://github.com/a/b" }]) {
      assert.equal(parseRemoteUrl(value as any), null);
    }
  });

  it("local paths and file URLs are local remotes", () => {
    for (const url of ["/srv/git/x.git", "./x.git", "../x.git", "C:\\x.git", "C:/x.git", "\\\\srv\\x.git", "file:///x.git", "FILE:///x.git"]) {
      assert.equal(isLocalRemote(url), true, url);
      assert.equal(parseRemoteUrl(url), null, url);
    }
    for (const url of ["https://github.com/a/b", "git@github.com:a/b", undefined, ""]) assert.equal(isLocalRemote(url), false, String(url));
  });
});

describe("host page URLs are built from escaped parts (DESIGN 5, 7.2 rule 5)", () => {
  const hostile = ["feature/x", "a?b=c", "a#frag", "a&merge_request[target_branch]=evil", "../../evil", "%2e%2e", "a b", "\u202eevil", "a\"><img>"];
  const remotes = [
    "https://github.com/acme/orders.git", "https://gitlab.com/group/sub/orders.git", "https://bitbucket.org/acme/orders.git",
    "https://dev.azure.com/org/proj/_git/orders", "https://codeberg.org/acme/orders.git", "https://ghe.acme.corp/acme/orders.git",
  ];
  for (const remote of remotes) {
    for (const branch of hostile) {
      it(`${remote} with head ${JSON.stringify(branch)}`, () => {
        const parsed = parseRemoteUrl(remote, ["ghe.acme.corp"])!;
        const url = newPullRequestUrl(parsed, "main", branch, "fork-owner");
        assert.ok(url, "a known host gets a page");
        const u = new URL(url);
        assert.equal(u.protocol, "https:");
        assert.equal(u.hostname, parsed.kind === "azure" ? "dev.azure.com" : parsed.host);
        assert.equal(u.username + u.password, "");
        assert.equal(u.hash, "", `fragment injected: ${url}`);
        assert.ok(u.pathname.startsWith("/" + parsed.owner.split("/").map(encodeURIComponent).join("/") + "/") || parsed.kind === "azure", u.pathname);
        assert.ok(!/[<>"\s\u202e]/.test(url), `unescaped character in ${url}`);
        if (parsed.kind === "gitlab") {
          assert.equal(u.searchParams.get("merge_request[source_branch]"), branch);
          assert.equal(u.searchParams.get("merge_request[target_branch]"), "main");
          assert.equal([...u.searchParams.keys()].length, 2, url);
        }
        if (parsed.kind === "bitbucket") {
          assert.equal(u.searchParams.get("source"), branch);
          assert.equal(u.searchParams.get("dest"), "main");
        }
        if (parsed.kind === "azure") {
          assert.equal(u.searchParams.get("sourceRef"), branch);
          assert.equal(u.searchParams.get("targetRef"), "main");
          assert.equal(u.pathname, "/org/proj/_git/orders/pullrequestcreate");
        }
        if (parsed.kind === "github" || parsed.kind === "ghe" || parsed.kind === "gitea") {
          assert.ok(!u.pathname.includes("/../") && !u.pathname.endsWith("/.."), u.pathname);
          assert.ok(u.search === "" || u.search === "?expand=1", `query injected: ${u.search}`);
        }
      });
    }
  }

  it("the GitHub compare page names the fork owner for a cross-repository head", () => {
    const parsed = parseRemoteUrl("https://github.com/upstream/orders.git")!;
    assert.equal(newPullRequestUrl(parsed, "main", "andromity/x", "me"), "https://github.com/upstream/orders/compare/main...me:andromity/x?expand=1");
    assert.equal(newPullRequestUrl(parsed, "main", "andromity/x", "UPSTREAM"), "https://github.com/upstream/orders/compare/main...andromity/x?expand=1");
  });

  it("unknown hosts get no page", () => {
    assert.equal(newPullRequestUrl(parseRemoteUrl("https://git.internal/a/b")!, "main", "x"), null);
    assert.equal(requestNoun("gitlab"), "merge request");
    assert.equal(requestNoun("github"), "pull request");
  });
});

describe("links opened from API answers are checked (DESIGN 4.3, 5 SSO, 7.2 rule 5)", () => {
  it("pull request link must be exactly https://github.com/owner/repo/pull/N", () => {
    assert.equal(pullRequestNumberFromUrl("https://github.com/acme/orders/pull/42", "acme", "orders"), 42);
    assert.equal(pullRequestNumberFromUrl("https://github.com/ACME/Orders/pull/42", "acme", "orders"), 42);
    for (const bad of [
      "http://github.com/acme/orders/pull/42", "https://github.com.evil.io/acme/orders/pull/42", "https://evil.io/acme/orders/pull/42",
      "https://github.com/other/orders/pull/42", "https://github.com/acme/orders/pull/0", "https://github.com/acme/orders/pull/42/files",
      "https://github.com/acme/orders/pull/42?x=1", "https://github.com/acme/orders/pull/42#x", "https://u:p@github.com/acme/orders/pull/42",
      "https://github.com:444/acme/orders/pull/42", "javascript:alert(1)", "https://github.com/acme/orders/issues/42", 42 as any,
    ]) {
      assert.equal(pullRequestNumberFromUrl(bad, "acme", "orders"), null, String(bad));
    }
  });

  it("SSO authorize link only on https://github.com", () => {
    const good = ssoUrlFromHeader("required; url=https://github.com/orgs/acme/sso?authorization_request=ABC");
    assert.ok(good && new URL(good).hostname === "github.com");
    for (const header of [
      "required; url=https://github.com.evil.io/orgs/acme/sso", "required; url=http://github.com/orgs/acme/sso",
      "required; url=javascript:alert(1)", "required; url=https://user:pw@github.com/x", "required", "", null,
      "required; url=https://evil.io/?https://github.com/",
    ]) {
      assert.equal(ssoUrlFromHeader(header), null, String(header));
    }
  });
});

describe("branch names (DESIGN 3.1, 7.2 rule 3)", () => {
  const invalid = [
    "", "-x", "--force", "-", "x..y", "..", "x@{1}", "@{-1}", "@", "x.lock", "a/b.lock", "a.LOCK", "x/", "/x", "x//y", "x.", ".x", "a/.b",
    "HEAD", "x y", "x~1", "x^", "x:y", "x?", "x*", "x[", "x\\y", "x\u0000", "x\n", "é", "a".repeat(MAX_BRANCH_LENGTH + 1), "x@{",
    "\u202eevil", "a\tb", "refs/heads/../x", 42 as any, null as any,
  ];
  for (const name of invalid) {
    it(`refuses ${JSON.stringify(name)}`, () => assert.equal(isValidBranchName(name), false));
  }

  it("accepts ordinary names", () => {
    for (const name of ["andromity/round-totals", "feature/ABC-123_x.y", "a", "a".repeat(MAX_BRANCH_LENGTH), "v1.2.3"]) {
      assert.equal(isValidBranchName(name), true, name);
    }
  });

  it("every name it accepts git accepts too (git check-ref-format --branch)", { timeout: 60_000 }, () => {
    const alphabet = "aZ09._/-";
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const names = new Set<string>(["a.lock.b", "a/b.c", "x-.y", "x_/y", "a/-b", "a/b-", "a.b./c", "refs/heads/x", "origin/main", "HEAD-1"]);
    while (names.size < 90) {
      let s = "";
      const len = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      names.add(s);
    }
    const disagree: string[] = [];
    for (const name of names) {
      if (!isValidBranchName(name)) continue;
      const git = spawnSync("git", ["check-ref-format", "--branch", name], { encoding: "utf8", timeout: 10_000 });
      if (git.status !== 0) disagree.push(name);
    }
    assert.deepEqual(disagree, [], "accepted names git refuses");
  });

  it("suggests from the commit subject without its type, cut at a word boundary to 48 characters", () => {
    assert.equal(suggestBranchName("andromity/", "fix(orders): round totals to cents before tax", []), "andromity/round-totals-to-cents-before-tax");
    assert.equal(suggestBranchName("andromity/", "feat!: Add Ünïcödé façade", []), "andromity/add-unicode-facade");
    const long = slugFromSubject("refactor: " + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi");
    assert.ok(long.length <= 48, long);
    assert.ok(!long.endsWith("-") && "alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota-kappa".startsWith(long), long);
    assert.equal(suggestBranchName("andromity/", undefined, ["src/orders/totals.py"]), "andromity/update-totals");
    assert.equal(suggestBranchName("andromity/", "🎉🎉🎉", ["README.md"]), "andromity/update-readme");
    assert.equal(suggestBranchName("andromity/", "", []), "andromity/changes");
    assert.equal(suggestBranchName("andromity/", "x\ny", ["a"]), "andromity/x");
  });

  it("refuses dangerous prefixes from settings (a repository can set it)", () => {
    for (const bad of ["-x/", "../", "a..b/", "x.lock/", "a b/", "@{", "\u202e/", 5, null, "/", "a".repeat(41)]) {
      const prefix = branchPrefix(bad);
      assert.ok(prefix === DEFAULT_BRANCH_PREFIX, `${JSON.stringify(bad)} -> ${prefix}`);
    }
    assert.equal(branchPrefix(""), "");
    assert.equal(branchPrefix("me/"), "me/");
    for (const prefix of ["", "me/", "team.x-y/"]) assert.ok(isValidBranchName(suggestBranchName(prefix, "fix: thing", [])));
  });

  it("adds -2, -3 … on collisions and stays valid at the length limit", async () => {
    const taken = new Set(["andromity/x", "andromity/x-2"]);
    assert.equal(await firstFreeName("andromity/x", async (n) => taken.has(n)), "andromity/x-3");
    const long = "a/" + "b".repeat(MAX_BRANCH_LENGTH - 2);
    const free = await firstFreeName(long, async (n) => n === long);
    assert.ok(free && free.length <= MAX_BRANCH_LENGTH && isValidBranchName(free) && free.endsWith("-2"), String(free));
    const dotEnd = "a/" + "b".repeat(MAX_BRANCH_LENGTH - 5) + "x.y";
    const free2 = await firstFreeName(dotEnd, async (n) => n === dotEnd);
    assert.ok(free2 && isValidBranchName(free2), String(free2));
    assert.equal(await firstFreeName("x", async () => true), null);
    assert.equal(await firstFreeName("-bad", async () => false), null);
  });
});
