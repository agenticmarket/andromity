# Skills catalog

`catalog.json` is the index the Andromity Hub reads to browse skills by category, tag and trust level. It contains metadata only. Skill files stay in their upstream GitHub repositories and are installed from there, pinned to the commit recorded here.

Clients fetch it from `https://raw.githubusercontent.com/agenticmarket/andromity/main/skills-catalog/catalog.json`, cache it for six hours, and fall back to scanning the registries directly if it can't be reached. Entries that point at a repository outside `REGISTRY_SOURCES` in `src/andromity/core/skills.py` are ignored. To serve it from somewhere else (for example a Worker route), or to try a catalog before publishing it, set `ANDROMITY_SKILLS_CATALOG_URL` on the client.

## Regenerating

Two steps. The first crawls the registries and assigns categories with keyword rules. The second re-categorizes with an LLM.

```bash
python scripts/build_skills_catalog.py
OPENROUTER_API_KEY=... node scripts/classify-skills-catalog.mjs
```

Set `GITHUB_TOKEN` for the first step to avoid the unauthenticated GitHub API rate limit (60 requests an hour). The file is only rewritten when something changed.

### LLM classification

`classify-skills-catalog.mjs` uses `perplexity/pplx-decider-v1.1-27b` through the OpenRouter Decisions API (`POST https://openrouter.ai/api/alpha/decisions`). Decider doesn't generate text. Each skill goes in as `state`, with one `choice` question whose options are the categories in `catalog.json` (their descriptions are the criteria). The model returns a probability for every category, and the top one is used when its probability is at least `--min-confidence` (default 0.4). Below that, the keyword category stays.

- Only skills still classified by rules are sent (`classified_by: "rules"`). A rerun after the first step costs nothing for skills whose files haven't changed, because the first step keeps earlier LLM categories for unchanged skills.
- Entries in `overrides.json` are never sent or changed.
- Only public skill names and descriptions leave your machine. The key comes from `OPENROUTER_API_KEY` and is never stored.
- `--dry-run` prints how many skills would be sent and one sample request, with no key or network. `--all` re-classifies skills a previous run already classified. `--model` or `SKILLS_CATALOG_MODEL` picks another Decisions model.
- Pricing is per input token ($0.02 per million at the time of writing; output is free), so a full run over about 400 skills costs a fraction of a cent. See the [model page](https://openrouter.ai/perplexity/pplx-decider-v1.1-27b) and the [Decisions API reference](https://docs.perplexity.ai/docs/decisions/quickstart).
- The endpoint is marked alpha by OpenRouter, so its shape may change.

Tags are not LLM-generated (Decider returns probabilities, not text). They come from frontmatter and the keyword rules.

```bash
node --test scripts/classify-skills-catalog.test.mjs
```

## Curating

Categories come from keyword rules in `src/andromity/core/skill_catalog.py` (skill name, parent folder, then the start of the description). Fix individual skills in `overrides.json`, keyed by `<source_id>/<skill-name>` or just `<skill-name>`:

| Field | Effect |
|---|---|
| `category` | Force a category id (`documents`, `design`, `testing`, `security`, `data`, `devops`, `api`, `agents`, `memory`, `business`, `writing`, `engineering`, `other`) |
| `tags` | Replace the generated tags |
| `featured` | Sort to the top of the Hub |
| `verified` | Override the source's verified flag |
| `hidden` | Remove the skill from the catalog |
