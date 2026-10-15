# `news.json` contract: `ai-news/1`

Machine-readable schema: [`news.schema.json`](news.schema.json) (JSON Schema 2020-12).
The test suite validates every generated file against it, and the ingest job
refuses to publish a file that fails.

## Where it is served

| File | URL | Notes |
|---|---|---|
| `news.json` | `https://raw.githubusercontent.com/0xmortuex/ai-news-tracker/data/news.json` | main contract; `Access-Control-Allow-Origin: *`, supports `ETag` / `If-None-Match` |
| `index.json` | `.../data/index.json` | ~250 bytes: `{schema, schemaVersion, generatedAt, itemCount, newestPublishedAt, staleSources, hash}`; cheap "did anything change" poll |
| `feed.atom` | `.../data/feed.atom` | Atom 1.0, newest 100 |
| `feed.json` | `.../data/feed.json` | JSON Feed 1.1, newest 100, extras under `_ai_news` |
| `sources-health.json` | `.../data/sources-health.json` | same health block as in `news.json`, standalone |
| `state.json` | `.../data/state.json` | pipeline internals (ETag cache, item pool). **Not a contract**; do not consume |

The `data` branch is an orphan branch, force-pushed with a single commit by the
`ingest` workflow roughly every 30 minutes. raw.githubusercontent.com caches for
about 5 minutes, so polling faster than every 5-10 minutes is pointless.

## Versioning rules

- Within `ai-news/1` changes are **additive only**. Consumers **must ignore unknown fields**.
- A breaking change bumps to `ai-news/2`, published at a new path (`data/v2/news.json`); `v1` is kept for 90 days.
- `schemaVersion` is the integer form of the same thing (`1`).

## Top level

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"ai-news/1"` | constant |
| `schemaVersion` | integer | `1` |
| `generatedAt` | RFC 3339 UTC | when the job built this file (not when the sources last changed) |
| `itemCount` | integer | `items.length` |
| `sources` | array | per-source health, see below |
| `items` | array | at most 600, newest `publishedAt` first, ties by `id` |

## Item

| Field | Type | Meaning |
|---|---|---|
| `id` | string, 16 hex | `sha1(canonicalUrl)[0:16]`. Stable across runs. Use for seen/read state |
| `cluster` | string `c-xxxxxxxx` | same-story group. Stable while the cluster only grows |
| `title` | string | as published (repo releases get a product prefix, e.g. `Ollama v0.40.5`) |
| `url` | string, http(s) | link to the original publisher |
| `canonicalUrl` | string | `url` without tracking params / fragment / `www` / trailing slash; https |
| `source` | string | display name of the representative item's source |
| `sourceId` | string | stable id from `config/sources.json` |
| `sourceKind` | `company` \| `news` \| `research` \| `community` \| `repo` \| `newsletter` | |
| `country` | `US` \| `CN` \| `EU` \| `OTHER` | origin of the source |
| `lang` | string | source language (`en`, `tr`, `zh`) |
| `publishedAt` | RFC 3339 UTC | publisher's date (falls back to `firstSeenAt` when missing/in the future) |
| `firstSeenAt` | RFC 3339 UTC | first run that saw it. Use for "new since last poll" |
| `kind` | `model-release` \| `paper` \| `policy` \| `funding` \| `product` \| `tool` \| `opinion` \| `security` \| `other` | rule-based, single value |
| `importance` | integer 0-100 | see scoring; includes recency decay |
| `companies` | string[] | canonical names (`OpenAI`, `Anthropic`, `Google`, `Google DeepMind`, `Meta`, ...) |
| `models` | string[] | up to 5 (`GPT-5.5`, `Claude Opus 4.5`, HF repo name) |
| `topics` | string[] | open vocabulary: `llm`, `agents`, `safety`, `open-weights`, `chips`, `china`, `regulation`, `research`, `funding`, `tools`, `turkey` |
| `summary` | string, <= 280 | the source's own excerpt as plain text; no AI rewrite, no full text |
| `alsoIn` | `{source, url, sourceId?, publishedAt?}[]` | other members of the cluster (the folded duplicates) |
| `breaking` | boolean | fresh (<= 6 h), strong (base >= 70), kind in model-release/policy/security/funding, and a tier-1 source or >= 2 other domains |

### Additive fields (not in the original report, safe to ignore)

| Field | Type | Meaning |
|---|---|---|
| `baseImportance` | integer 0-100 | importance **without** recency decay ("top this week" ranking) |
| `labels` | string[] (max 3) | rule-table labels in score order: `model-release`, `research`, `open-source`, `policy`, `hardware`, `funding`, `safety`, `tools`, `china`, `turkey`, or `general` |
| `sourceTier` | 1-4 | tier of the representative's source |
| `thirdParty` | boolean | true when the source is a community scrape (Anthropic, xAI, UK AISI, The Batch) rather than the publisher's own feed |
| `engagement` | integer | best HN points / HF paper upvotes / Reddit score in the cluster, else 0 |

## Importance

`base = clip(0..100, tier + corroboration + keywords + engagement + primary)`

- tier: T1 30, T2 18, T3 10, T4 4
- corroboration: +12 per extra distinct domain in the cluster (cap 36), +10 if Techmeme or HN carries it
- keywords: +15 launch verb with a model name, +10 version bump, +8 money >= $1B, +8 policy word with a regulator, -10 listicle words, -15 arXiv-only
- engagement: HN `min(15, points/40)`, HF papers `min(12, upvotes/10)`, Reddit `min(8, score/300)`
- primary: +10 when the company named in the title owns the item's domain

`importance = round(base * (0.4 + 0.6 * 0.5^(ageHours/48)))`. Guideline: >= 70 top story,
40-69 normal, < 15 minor. Single-source stories rarely exceed ~60; that is intended.

## Source health block (`sources[]`, also `sources-health.json`)

`id`, `name`, `category`, `tier`, `thirdParty`, `status` (`ok` | `error` | `never`: result of the
last attempt), `stale` (boolean), `staleReason`, `lastOk`, `lastFetch`, `lastError`, `error`,
`httpStatus`, `consecutiveFailures`, `lastNewItem`, `itemCount`.

A source is `stale` when it never succeeded, its last success is older than
`max(6 h, 3 x poll interval)`, it has failed 3+ times in a row, or it published nothing for
21 days (120 days for model-drop, policy and newsletter sources). Consumers should show
"N sources failing" rather than hide it.

## Consumer rules (security)

Treat every string as untrusted: render as text, only open `http(s)` URLs, cap lengths.
The schema guarantees `url` is http(s) for files produced by the job; do not rely on it for
files fetched from elsewhere.
