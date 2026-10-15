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

---

# Phase 2 files

All files below sit next to `news.json` on the `data` branch, each carries a `schema` string,
`schemaVersion` and `generatedAt`, is validated against its JSON Schema before the job
publishes, and follows the same rule as `ai-news/1`: additive changes only within `/1`,
consumers ignore unknown fields. They contain English-language items only (Turkish items stay
in `news.json`, tagged `lang: "tr"`); every item still has a `lang` field where it is derived
from a news item so a client can filter.

| File | Schema | Schema file | Notes |
|---|---|---|---|
| `releases.json` | `ai-news-releases/1` | [`releases.schema.json`](releases.schema.json) | model / tool release tracker, last 90 days, max 300, newest first |
| `digest-daily.json` | `ai-news-digest/1` | [`digest.schema.json`](digest.schema.json) | `period.kind = "daily"`, last 24 h |
| `digest-weekly.json` | `ai-news-digest/1` | [`digest.schema.json`](digest.schema.json) | `period.kind = "weekly"`, last 7 days, regenerated once per UTC day |
| `digest.json` | `ai-news-digest/1` | [`digest.schema.json`](digest.schema.json) | byte-identical copy of `digest-daily.json` (compatibility) |
| `digest-daily.md`, `digest-weekly.md` | n/a | n/a | the same digests as Markdown (titles, links, source, importance) |
| `guides.json` | `ai-news-guides/1` | [`guides.schema.json`](guides.schema.json) | learning / guide content, replaces the Worker `/guides/aggregate` route |
| `status.json` | `ai-news-status/1` | [`status.schema.json`](status.schema.json) | last 7 days of OpenAI and Claude status incidents |

## `releases.json` (`ai-news-releases/1`)

```
{ schema, schemaVersion, generatedAt, windowDays: 90, count, releases: [ release ] }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | 16 hex | `sha1(company + "|" + model)`; stable across runs, the dedupe key |
| `date` | RFC 3339 | earliest date any member of the story was published (release day) |
| `company` | string | `OpenAI`, `Anthropic`, `Google`, `Meta`, ...; from the Hugging Face org, then the model family, then the source's company. Tools use the source's company or the product name |
| `model` | string | model or `Product vX.Y.Z` for tools (pre-release suffixes `-rcN`, `-beta` are folded into the final version) |
| `family` | string | `GPT`, `Claude`, `Gemini`, `Muse`, `Ollama`, ... |
| `kind` | `model` \| `tool` \| `dataset` \| `library` | |
| `url`, `source` | string | the best English item for the release (lowest source tier, earliest) |
| `summary` | string, <= 200 | the source's own excerpt |
| `importance` | 0-100 | undecayed `baseImportance` of the underlying story, so it does not shrink as the release ages |
| `open` | `true` \| `false` \| `null` | `true` only when a source says open weights (a Hugging Face repo, or "open-weight"/"open-source model"/Apache 2/MIT in the text); `false` only when the text says proprietary/closed; otherwise `null` (unknown, never guessed) |
| `alsoIn` | `{source, url}[]` | other English members of the story, max 10 |

Built from `news.json` items of kind `model-release` and from repo trackers (`kind: tool`). Records
carry over between runs (the previous `releases.json` is restored from the data branch) so the
window is really 90 days even though `news.json` keeps 14. At most 3 versions per tool or library are kept.

## `digest-daily.json` / `digest-weekly.json` / `digest.json` (`ai-news-digest/1`)

```
{ schema, schemaVersion, generatedAt, lang: "en",
  period: { kind: "daily" | "weekly", start, end, hours, topN },
  total, kinds: { <kind>: n },
  sections: [ { id, title, count, items: [ item ] } ],
  sources: [ { id, name, count } ] }
```

- `period.end` is `news.generatedAt`; `start` is 24 h / 168 h earlier. The file is deterministic for a given `news.json`.
- Section ids, in order: `model-release`, `research`, `open-source`, `policy`, `hardware`, `funding`, `safety`, `tools`, `china`.
  An item is placed in the first of its `labels` that is a section (research only for papers), once.
- `items` are the top `topN` (daily 5, weekly 8) of the section by `baseImportance`, then newest, then id. `count` is the section total before the cut.
- item: `id, title, url, source, sourceId, lang, publishedAt, kind, importance, baseImportance, summary, alsoIn: [{source, url}]`.
- `sources` lists every source that contributed a story in the period, most first.
- Clients that need the weekly digest read `digest-weekly.json`; a client may fall back to `digest.json` only if `period.kind` matches what it asked for.

## `guides.json` (`ai-news-guides/1`)

```
{ schema, schemaVersion, generatedAt, count, featured: [ ... ], sources: [ { id, name, status, count, error } ], items: [ item ] }
```

item: `id` (16 hex of the canonical URL), `title`, `url`, `source`, `sourceKind`
(`hn` | `reddit` | `devto` | `github` | `youtube` | `bluesky` | `blog`), `publishedAt`, `summary` (<= 280),
`score` (HN points, dev.to reactions, GitHub stars, Bluesky likes, else 0), optional `comments`.
Newest first, deduplicated by canonical URL, at most 150, at most 40 per `sourceKind`, at most 120 days old.
`source` follows the labels the Guides tab buckets on: `Hacker News`, `dev.to`, `GitHub`, `r/<sub>`,
`YouTube: <channel>`, `Bluesky: @<handle>`. `featured` is `docs/featured-guides.json`. `sources` is the per-source result
of the run (failures are listed, not hidden). Source list: `config/guide-sources.json`.
Refreshed at most every 110 minutes; the job never replaces the file with one below 20 items.

## `status.json` (`ai-news-status/1`)

`{ schema, schemaVersion, generatedAt, windowDays: 7, providers: [ { id, name, company, url, incidents: [ { id, title, url, publishedAt, summary } ] } ] }`,
newest first, max 15 incidents per provider. Status feeds (config category `status`) never appear in `news.json`.

## Tagger additions (still `ai-news/1`)

`kind`, `models` and `labels` values are produced by the same rule table with more coverage
(lab brands such as `Muse`, `Timestral`, `Jais`; parameter counts such as `74B-A9B`; "is out",
"Welcome X", "open-weight" phrasing). Model names are now more specific (`Gemini 4 Argon` rather than
`Gemini 4`), so `models[]` values may differ from earlier runs for the same story.
Items from provider status feeds are excluded from `items`.
