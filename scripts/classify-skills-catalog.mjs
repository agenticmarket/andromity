#!/usr/bin/env node
/**
 * Categorize the skills in skills-catalog/catalog.json with Perplexity's Decider
 * model through the OpenRouter Decisions API (POST /api/alpha/decisions).
 *
 *   OPENROUTER_API_KEY=... node scripts/classify-skills-catalog.mjs
 *
 * Decider doesn't generate text. Each skill is sent as `state` together with one
 * `choice` question whose options are the catalog's categories, and the model
 * returns a probability for every option. The most likely category replaces the
 * keyword-rule category when its probability reaches --min-confidence.
 *
 * Only skills still classified by keyword rules are sent, so a rerun after
 * `python scripts/build_skills_catalog.py` costs nothing for unchanged skills.
 * Overrides from skills-catalog/overrides.json are never touched. Only public
 * skill names and descriptions leave this machine.
 *
 * Options:
 *   --catalog <path>         catalog file (default: skills-catalog/catalog.json)
 *   --model <id>             OpenRouter model id (default: perplexity/pplx-decider-v1.1-27b)
 *   --min-confidence <0-1>   keep the rule category below this probability (default: 0.4)
 *   --concurrency <n>        parallel requests (default: 4)
 *   --all                    also re-classify skills a previous run classified
 *   --dry-run                show what would be sent; no key or network needed
 *
 * Docs: https://openrouter.ai/docs/api-reference/overview (Decisions: POST /api/alpha/decisions)
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_MODEL = "perplexity/pplx-decider-v1.1-27b";
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MIN_CONFIDENCE = 0.4;
const DESCRIPTION_CHARS = 600;
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_SERVER_RETRIES = 3;
const FATAL_STATUSES = new Set([400, 401, 402, 403, 404]);

export class FatalDecisionsError extends Error {}

export function buildRequest(model, skill, categories) {
  const slash = skill.dir.lastIndexOf("/");
  return {
    model,
    state: {
      name: skill.name,
      description: (skill.description || "").slice(0, DESCRIPTION_CHARS),
      folder: slash === -1 ? "" : skill.dir.slice(0, slash),
      source: skill.source_label || skill.source_id,
    },
    questions: {
      category: {
        type: "choice",
        instructions:
          "Which category best describes what this agent skill helps a user do? " +
          "Judge by the skill's purpose, not by incidental words in its text.",
        criteria: Object.fromEntries(categories.map((c) => [c.id, `${c.label}: ${c.description}`])),
      },
    },
  };
}

export function parseAnswer(response, categoryIds) {
  const answer = response?.answers?.category;
  if (!answer || answer.type !== "choice" || !categoryIds.includes(answer.choice)) return null;
  const probability = answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0;
  return { category: answer.choice, probability };
}

async function errorMessage(res) {
  try {
    const body = await res.json();
    return body?.error?.message || JSON.stringify(body).slice(0, 300);
  } catch {
    return res.statusText || "no response body";
  }
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** POST one decisions request; retries rate limits and server errors, throws FatalDecisionsError for the rest of the 4xx class that mean the run can't succeed. */
export async function decide(body, { apiKey, fetchImpl = fetch, sleep = defaultSleep }) {
  let rateLimited = 0;
  let serverErrors = 0;
  for (;;) {
    let res;
    try {
      res = await fetchImpl(DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (++serverErrors > MAX_SERVER_RETRIES) throw new Error(`network error: ${err.message}`);
      await sleep(1000 * 2 ** (serverErrors - 1));
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429) {
      if (++rateLimited > MAX_RATE_LIMIT_RETRIES) throw new Error("rate limited by OpenRouter");
      const wait = Number(res.headers.get("retry-after"));
      await sleep((Number.isFinite(wait) && wait > 0 ? wait : 2 * rateLimited) * 1000);
      continue;
    }
    if (res.status >= 500) {
      if (++serverErrors > MAX_SERVER_RETRIES) throw new Error(`OpenRouter returned ${res.status}`);
      await sleep(1000 * 2 ** (serverErrors - 1));
      continue;
    }
    const message = await errorMessage(res);
    if (res.status === 401) throw new FatalDecisionsError("OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.");
    if (res.status === 402) throw new FatalDecisionsError("OpenRouter account is out of credits (402).");
    if (FATAL_STATUSES.has(res.status)) throw new FatalDecisionsError(`OpenRouter returned ${res.status}: ${message}`);
    throw new Error(`OpenRouter returned ${res.status}: ${message}`);
  }
}

/**
 * Classify catalog entries in place. Returns counts plus the entries that were
 * skipped for low confidence or failed.
 */
export async function classifyCatalog(doc, options) {
  const { model = DEFAULT_MODEL, minConfidence = DEFAULT_MIN_CONFIDENCE, concurrency = 4, all = false, log = () => {} } = options;
  const categories = doc.categories;
  const categoryIds = categories.map((c) => c.id);
  const todo = doc.skills.filter((s) => s.classified_by !== "override" && (all || s.classified_by !== "llm"));
  const summary = { total: doc.skills.length, sent: todo.length, classified: 0, changed: 0, lowConfidence: [], failed: [], fatal: null };

  let next = 0;
  let done = 0;
  async function worker() {
    while (next < todo.length && !summary.fatal) {
      const skill = todo[next++];
      try {
        const answer = parseAnswer(await decide(buildRequest(model, skill, categories), options), categoryIds);
        if (!answer) {
          summary.failed.push({ id: skill.id, reason: "unusable answer" });
        } else if (answer.probability < minConfidence) {
          summary.lowConfidence.push({ id: skill.id, category: answer.category, probability: answer.probability });
        } else {
          if (answer.category !== skill.category) summary.changed++;
          skill.category = answer.category;
          skill.classified_by = "llm";
          summary.classified++;
        }
      } catch (err) {
        if (err instanceof FatalDecisionsError) summary.fatal = err.message;
        else summary.failed.push({ id: skill.id, reason: err.message });
      }
      if (++done % 25 === 0) log(`  ${done}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length || 1)) }, worker));
  return summary;
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      catalog: { type: "string" },
      model: { type: "string" },
      "min-confidence": { type: "string" },
      concurrency: { type: "string" },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const minConfidence = values["min-confidence"] === undefined ? DEFAULT_MIN_CONFIDENCE : Number(values["min-confidence"]);
  const concurrency = values.concurrency === undefined ? 4 : Number(values.concurrency);
  if (!(minConfidence >= 0 && minConfidence <= 1)) throw new Error("--min-confidence must be between 0 and 1");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
  return {
    catalog: resolve(values.catalog ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills-catalog", "catalog.json")),
    model: values.model ?? process.env.SKILLS_CATALOG_MODEL ?? DEFAULT_MODEL,
    minConfidence,
    concurrency,
    all: values.all,
    dryRun: values["dry-run"],
    help: values.help,
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log((await readFile(fileURLToPath(import.meta.url), "utf8")).split("*/")[0].replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
    return 0;
  }
  const text = await readFile(cli.catalog, "utf8");
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.skills) || !Array.isArray(doc.categories) || doc.categories.some((c) => !c.description)) {
    throw new Error("Catalog has no category descriptions. Rebuild it with: python scripts/build_skills_catalog.py");
  }

  if (cli.dryRun) {
    const pending = doc.skills.filter((s) => s.classified_by !== "override" && (cli.all || s.classified_by !== "llm"));
    console.log(`${pending.length} of ${doc.skills.length} skills would be sent to ${cli.model}.`);
    if (pending[0]) console.log(JSON.stringify(buildRequest(cli.model, pending[0], doc.categories), null, 2));
    return 0;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set. Create a key at https://openrouter.ai/keys and export it.");
    return 2;
  }

  console.log(`Classifying with ${cli.model} (min confidence ${cli.minConfidence})...`);
  const summary = await classifyCatalog(doc, { ...cli, apiKey, log: console.log });
  if (summary.classified > 0) {
    await writeFile(cli.catalog, JSON.stringify(doc, null, 2) + "\n", "utf8");
  }
  console.log(
    `Sent ${summary.sent}; classified ${summary.classified} (${summary.changed} changed category), ` +
      `${summary.lowConfidence.length} below confidence, ${summary.failed.length} failed.`,
  );
  for (const item of summary.lowConfidence.slice(0, 10)) {
    console.log(`  low confidence: ${item.id} -> ${item.category} (${item.probability.toFixed(2)}), kept rule category`);
  }
  for (const item of summary.failed.slice(0, 10)) console.log(`  failed: ${item.id}: ${item.reason}`);
  if (summary.fatal) {
    console.error(`Stopped early: ${summary.fatal}`);
    return 1;
  }
  return summary.failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
