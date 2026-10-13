import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DECISIONS_URL, DEFAULT_MODEL, FatalDecisionsError, buildRequest, classifyCatalog, decide, parseAnswer,
} from "./classify-skills-catalog.mjs";

const categories = [
  { id: "documents", label: "Documents", description: "Files and documents." },
  { id: "data", label: "Data & Analytics", description: "SQL and analytics." },
  { id: "other", label: "Other", description: "Nothing else fits." },
];

const skill = (name, extra = {}) => ({
  id: `src/${name}`, name, description: `${name} does things`, dir: `group/${name}`, source_id: "src",
  source_label: "Source", category: "other", classified_by: "rules", ...extra,
});

const answerFor = (choice, probability = 0.9) => ({
  model: "m",
  answers: { category: { type: "choice", choice, confidence: 0.5, probabilities: { [choice]: probability } } },
  usage: { input_tokens: 1, output_tokens: 1 },
});

const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, statusText: "",
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

const noSleep = async () => {};

describe("buildRequest", () => {
  it("sends the skill as state and the categories as the criteria of one choice question", () => {
    const body = buildRequest(DEFAULT_MODEL, skill("pdf", { description: "x".repeat(2000) }), categories);
    assert.equal(body.model, "perplexity/pplx-decider-v1.1-27b");
    assert.deepEqual(body.state, { name: "pdf", description: "x".repeat(600), folder: "group", source: "Source" });
    assert.equal(body.questions.category.type, "choice");
    assert.deepEqual(Object.keys(body.questions.category.criteria), ["documents", "data", "other"]);
    assert.equal(body.questions.category.criteria.data, "Data & Analytics: SQL and analytics.");
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  });
});

describe("parseAnswer", () => {
  it("returns the top choice and its probability, and rejects unknown or malformed answers", () => {
    const ids = categories.map((c) => c.id);
    assert.deepEqual(parseAnswer(answerFor("data", 0.8), ids), { category: "data", probability: 0.8 });
    assert.equal(parseAnswer(answerFor("invented"), ids), null);
    assert.equal(parseAnswer({ answers: {} }, ids), null);
    assert.equal(parseAnswer(null, ids), null);
  });
});

describe("decide", () => {
  const options = (responses, calls = []) => ({
    apiKey: "key", sleep: noSleep,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return responses.shift(); },
  });

  it("posts to the OpenRouter decisions endpoint with the bearer key", async () => {
    const calls = [];
    const out = await decide({ model: "m" }, options([jsonResponse(200, answerFor("data"))], calls));
    assert.equal(out.answers.category.choice, "data");
    assert.equal(calls[0].url, DECISIONS_URL);
    assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(calls[0].init.headers.Authorization, "Bearer key");
    assert.equal(JSON.parse(calls[0].init.body).model, "m");
  });

  it("waits for Retry-After on 429 and retries server errors", async () => {
    const waits = [];
    const responses = [jsonResponse(429, {}, { "retry-after": "3" }), jsonResponse(503, {}), jsonResponse(200, answerFor("data"))];
    const out = await decide({}, { apiKey: "k", sleep: async (ms) => waits.push(ms), fetchImpl: async () => responses.shift() });
    assert.equal(out.answers.category.choice, "data");
    assert.deepEqual(waits, [3000, 1000]);
  });

  it("gives up after repeated rate limits and server errors", async () => {
    await assert.rejects(decide({}, options(Array.from({ length: 6 }, () => jsonResponse(429, {})))), /rate limited/);
    await assert.rejects(decide({}, options(Array.from({ length: 4 }, () => jsonResponse(500, {})))), /returned 500/);
  });

  it("treats auth, credit and bad-model errors as fatal with readable messages", async () => {
    await assert.rejects(decide({}, options([jsonResponse(401, {})])), (e) => e instanceof FatalDecisionsError && /OPENROUTER_API_KEY/.test(e.message));
    await assert.rejects(decide({}, options([jsonResponse(402, {})])), (e) => e instanceof FatalDecisionsError && /credits/.test(e.message));
    await assert.rejects(
      decide({}, options([jsonResponse(400, { error: { message: "unknown model" } })])),
      (e) => e instanceof FatalDecisionsError && /unknown model/.test(e.message),
    );
  });

  it("retries network failures before giving up", async () => {
    let attempts = 0;
    await assert.rejects(
      decide({}, { apiKey: "k", sleep: noSleep, fetchImpl: async () => { attempts++; throw new Error("socket closed"); } }),
      /network error: socket closed/,
    );
    assert.equal(attempts, 4);
  });
});

describe("classifyCatalog", () => {
  const catalogOf = (...skills) => ({ categories, skills });
  const run = (doc, answers, extra = {}) => classifyCatalog(doc, {
    apiKey: "k", sleep: noSleep, concurrency: 2, ...extra,
    fetchImpl: async (_url, init) => {
      const name = JSON.parse(init.body).state.name;
      const answer = answers[name];
      return answer instanceof Error ? Promise.reject(answer) : answer ?? jsonResponse(200, answerFor("other"));
    },
  });

  it("stamps confident answers, keeps rule categories below the threshold, and skips overrides and earlier LLM answers", async () => {
    const doc = catalogOf(
      skill("pdf"), skill("sales"), skill("pinned", { classified_by: "override", category: "data" }),
      skill("done", { classified_by: "llm", category: "documents" }),
    );
    const sent = [];
    const summary = await classifyCatalog(doc, {
      apiKey: "k", sleep: noSleep, concurrency: 2,
      fetchImpl: async (_url, init) => {
        const name = JSON.parse(init.body).state.name;
        sent.push(name);
        return jsonResponse(200, name === "pdf" ? answerFor("documents", 0.95) : answerFor("data", 0.2));
      },
    });
    assert.deepEqual(sent.sort(), ["pdf", "sales"]);
    const by = Object.fromEntries(doc.skills.map((s) => [s.name, s]));
    assert.deepEqual([by.pdf.category, by.pdf.classified_by], ["documents", "llm"]);
    assert.deepEqual([by.sales.category, by.sales.classified_by], ["other", "rules"]);
    assert.deepEqual([by.pinned.category, by.pinned.classified_by], ["data", "override"]);
    assert.equal(summary.classified, 1);
    assert.equal(summary.changed, 1);
    assert.deepEqual(summary.lowConfidence.map((i) => i.id), ["src/sales"]);
  });

  it("re-classifies earlier LLM answers with --all but still never overrides", async () => {
    const doc = catalogOf(skill("done", { classified_by: "llm", category: "documents" }), skill("pinned", { classified_by: "override" }));
    const summary = await run(doc, { done: jsonResponse(200, answerFor("data")) }, { all: true });
    assert.equal(summary.sent, 1);
    assert.equal(doc.skills[0].category, "data");
  });

  it("records per-skill failures and carries on", async () => {
    const doc = catalogOf(skill("a"), skill("b"), skill("c"));
    const summary = await run(doc, {
      a: jsonResponse(200, answerFor("data")),
      b: jsonResponse(200, { answers: {} }),
      c: jsonResponse(413, {}),
    });
    assert.equal(summary.classified, 1);
    assert.deepEqual(summary.failed.map((f) => f.id).sort(), ["src/b", "src/c"]);
    assert.equal(summary.fatal, null);
  });

  it("stops sending after a fatal error and keeps what was already classified", async () => {
    const doc = catalogOf(...Array.from({ length: 10 }, (_, i) => skill(`s${i}`)));
    let calls = 0;
    const summary = await classifyCatalog(doc, {
      apiKey: "k", sleep: noSleep, concurrency: 1,
      fetchImpl: async () => (++calls === 1 ? jsonResponse(200, answerFor("data")) : jsonResponse(402, {})),
    });
    assert.equal(calls, 2);
    assert.equal(summary.classified, 1);
    assert.match(summary.fatal, /credits/);
    assert.equal(doc.skills[0].classified_by, "llm");
    assert.equal(doc.skills[2].classified_by, "rules");
  });

  it("handles an empty queue", async () => {
    const summary = await run(catalogOf(skill("only", { classified_by: "override" })), {});
    assert.equal(summary.sent, 0);
  });
});
