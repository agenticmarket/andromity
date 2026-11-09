// Independent adversarial tests for the GitHub REST client used by Create pull request.
// Spec: private/design/create-pr/DESIGN.md 5 (error table), 7.1 (token), 7.2 rules 7 and 8.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FetchLike, GitHubClient, GitHubError, HttpResponse } from "../src/integrations/pullRequest/github.js";

const TOKEN = "gho_" + "T0k3n".repeat(8);

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function client(handler: (url: string, init: Parameters<FetchLike>[1]) => Promise<HttpResponse> | HttpResponse, timeoutMs = 15_000) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { gh: new GitHubClient(TOKEN, fetchImpl, "https://api.github.com", timeoutMs), calls };
}

async function errorOf(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GitHubError, `not a GitHubError: ${error}`);
    const text = [String(error), (error as Error).message, (error as Error).stack, JSON.stringify(error)].join("\n");
    assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN.slice(0, 12)), "token in an error");
    return error as GitHubError;
  }
  assert.fail("expected an error");
}

const repoJson = { name: "orders", owner: { login: "acme" }, default_branch: "main", private: false, permissions: { push: true } };

describe("requests (7.2 rule 8)", () => {
  it("sends the token only in Authorization, with the fixed headers, to the API host", async () => {
    const { gh, calls } = client(() => response(200, repoJson));
    await gh.repository("acme", "orders");
    await gh.createPull("acme", "orders", { title: `t ${TOKEN}?`, head: "x", base: "main", body: "b", draft: false }).catch(() => {});
    const call = calls[0];
    assert.equal(call.url, "https://api.github.com/repos/acme/orders");
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.init.headers.Accept, "application/vnd.github+json");
    assert.equal(call.init.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(call.init.headers["User-Agent"], "Andromity-VSCode");
    assert.ok(call.init.signal, "every call is abortable");
    for (const c of calls) {
      assert.ok(!c.url.includes(TOKEN));
      const headersWithoutAuth = Object.entries(c.init.headers).filter(([k]) => k !== "Authorization");
      assert.ok(!JSON.stringify(headersWithoutAuth).includes(TOKEN));
    }
    const create = calls[1];
    assert.equal(JSON.parse(create.init.body!).maintainer_can_modify, true);
  });

  it("escapes path segments and the head filter", async () => {
    const { gh, calls } = client(() => response(200, []));
    await gh.openPullFor("acme", "orders", "me", "feature/x&state=closed#y");
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/repos/acme/orders/pulls");
    assert.equal(url.searchParams.get("head"), "me:feature/x&state=closed#y");
    assert.equal(url.searchParams.get("state"), "open");
    await gh.branchExists("a/b", "c?d", "x").catch(() => {});
    assert.equal(new URL(calls[1].url).pathname, "/repos/a%2Fb/c%3Fd/branches/x");
  });
});

describe("error mapping (5)", () => {
  const cases: [string, number, unknown, Record<string, string>, string][] = [
    ["401", 401, { message: "Bad credentials" }, {}, "unauthorized"],
    ["403 SSO", 403, { message: "Resource protected by organization SAML enforcement." }, { "X-GitHub-SSO": "required; url=https://github.com/orgs/acme/sso?authorization_request=AAA" }, "sso"],
    ["403 rate limit", 403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" }, "rate_limited"],
    ["403 secondary rate limit", 403, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "60" }, "rate_limited"],
    ["429 with retry-after", 429, {}, { "retry-after": "30" }, "rate_limited"],
    ["429 bare", 429, "", {}, "rate_limited"],
    ["403 plain", 403, { message: "Resource not accessible by integration" }, {}, "forbidden"],
    ["404", 404, { message: "Not Found" }, {}, "not_found"],
    ["422 exists", 422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:x." }] }, {}, "exists"],
    ["422 no commits", 422, { message: "Validation Failed", errors: [{ message: "No commits between main and x" }] }, {}, "no_commits"],
    ["422 draft", 422, { message: "Draft pull requests are not supported in this repository." }, {}, "draft_unsupported"],
    ["422 other", 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "base", code: "invalid" }] }, {}, "invalid"],
    ["500", 500, "<html>oops</html>", {}, "server"],
    ["502", 502, "", {}, "server"],
    ["503", 503, { message: "x" }, {}, "server"],
  ];
  for (const [name, status, body, headers, kind] of cases) {
    it(name, async () => {
      const { gh } = client(() => response(status, body, headers));
      const error = await errorOf(gh.createPull("acme", "orders", { title: "t", head: "x", base: "main", body: "b", draft: true }));
      assert.equal(error.kind, kind);
      assert.equal(error.status, status);
      assert.ok(!error.message.toLowerCase().includes("saml") && !error.message.includes("Validation"), "GitHub's raw text reached the error");
    });
  }

  it("SSO link is kept only when it is on https://github.com", async () => {
    const ok = await errorOf(client(() => response(403, {}, { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=A" })).gh.viewer());
    assert.equal(ok.ssoUrl, "https://github.com/orgs/acme/sso?authorization_request=A");
    const evil = await errorOf(client(() => response(403, {}, { "x-github-sso": "required; url=https://evil.io/phish" })).gh.viewer());
    assert.equal(evil.kind, "sso");
    assert.equal(evil.ssoUrl, null);
  });

  it("rate limit reset time comes from the header", async () => {
    const error = await errorOf(client(() => response(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" })).gh.viewer());
    assert.equal(error.resetAt, 2_000_000_000_000);
  });

  it("network failure and timeout", async () => {
    const net = await errorOf(client(() => { throw new Error(`connect ECONNREFUSED with ${TOKEN}`); }).gh.viewer());
    assert.equal(net.kind, "network");
    const started = Date.now();
    const slow = await errorOf(client((_url, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))), 80).gh.viewer());
    assert.equal(slow.kind, "timeout");
    assert.ok(Date.now() - started < 2000);
  });

  it("a server that sends headers and then stalls the body still times out (15-second rule covers the whole call)", { timeout: 5_000 }, async () => {
    const stalled = client(() => ({ status: 200, headers: { get: () => null }, text: () => new Promise<string>(() => {}) }), 100).gh;
    const outcome = await Promise.race([
      stalled.repository("acme", "orders").then(() => "resolved", (e) => (e instanceof GitHubError ? e.kind : "other-error")),
      new Promise((resolve) => setTimeout(() => resolve("still waiting after 1.5 s"), 1500)),
    ]);
    assert.equal(outcome, "timeout");
  });
});

describe("hostile and malformed answers", () => {
  it("malformed JSON on success is a server error, never a crash", async () => {
    for (const body of ["{", "null", "[]", "\"str\"", "{\"number\": \"42\", \"html_url\": \"https://github.com/a/b/pull/42\"}", "{\"number\": 1e400, \"html_url\": \"x\"}",
      "{\"number\": -1, \"html_url\": \"x\"}", "{\"number\": 3.5, \"html_url\": \"x\"}"]) {
      const error = await errorOf(client(() => response(201, body)).gh.createPull("a", "b", { title: "t", head: "h", base: "main", body: "", draft: false }));
      assert.equal(error.kind, "server", body);
    }
  });

  it("repository answers with odd shapes are refused or read conservatively", async () => {
    const bad = [
      { ...repoJson, owner: { login: "../evil" } }, { ...repoJson, name: "a/b" }, { ...repoJson, default_branch: 5 }, { ...repoJson, owner: null },
    ];
    for (const body of bad) assert.equal((await errorOf(client(() => response(200, body)).gh.repository("a", "b"))).kind, "server");
    const proto = JSON.parse('{"name":"orders","owner":{"login":"acme"},"default_branch":"main","permissions":{"__proto__":{"push":true}},"__proto__":{"private":false}}');
    const info = await client(() => response(200, proto)).gh.repository("acme", "orders");
    assert.equal(info.canPush, false, "push permission from a prototype key");
    assert.equal(info.isPrivate, false);
    const forkNoFlag = await client(() => response(200, { ...repoJson, parent: { name: "o", owner: { login: "up" }, default_branch: "dev" } })).gh.repository("acme", "orders");
    assert.equal(forkNoFlag.parent, undefined, "parent without fork: true");
    const fork = await client(() => response(200, { ...repoJson, fork: true, parent: { name: "o", owner: { login: "up" }, default_branch: "dev" } })).gh.repository("acme", "orders");
    assert.deepEqual(fork.parent, { owner: "up", repo: "o", defaultBranch: "dev" });
  });

  it("lists drop junk and are bounded", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ login: i % 2 ? `user${i}` : "bad login!", name: `b${i}` }));
    const { gh } = client(() => response(200, many));
    const assignees = await gh.assignees("a", "b");
    assert.ok(assignees.length <= 100 && assignees.every((l) => /^[A-Za-z0-9-]+$/.test(l)));
    assert.ok((await gh.branches("a", "b")).length <= 100);
    assert.deepEqual(await client(() => response(200, { not: "an array" })).gh.assignees("a", "b"), []);
  });

  it("viewer login must be a GitHub login", async () => {
    assert.equal(await client(() => response(200, { login: "<script>" })).gh.viewer(), null);
    assert.equal(await client(() => response(200, { login: "octo-cat" })).gh.viewer(), "octo-cat");
  });

  it("branchExists: 404 means free; other errors are not silently 'free'", async () => {
    assert.equal(await client(() => response(404, {})).gh.branchExists("a", "b", "x"), false);
    assert.equal(await client(() => response(200, {})).gh.branchExists("a", "b", "x"), true);
    assert.equal((await errorOf(client(() => response(500, {})).gh.branchExists("a", "b", "x"))).kind, "server");
  });
});
