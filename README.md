# AI News Tracker

A static AI news pipeline. A scheduled GitHub Action fetches ~75 curated sources,
dedupes and clusters them, tags and scores each story, and publishes
`news.json` (+ Atom and JSON Feed). The site and other consumers (for example the
Vex browser) just read that file. There is no server and no database.

```
config/sources.json --> scripts/ingest.mjs --> data/ (orphan `data` branch)
  (75 sources)           fetch (conditional GET, per-host rate limit, 15 s timeout, size caps)
                         parse (RSS / Atom / JSON Feed / HF API / HN / Federal Register)
                         dedupe + cluster (canonical URL, title Jaccard + SimHash, model-event key)
                         tag (kind, labels, topics, companies, models) + score 0-100 + breaking
                         validate against docs/news.schema.json, sanity floor, then publish
                         derive releases.json, digest-daily/weekly (.json/.md), status.json (each schema-validated)

config/guide-sources.json --> scripts/guides.mjs --> data/guides.json   (HN, dev.to, GitHub, YouTube, Reddit, Bluesky)

raw.githubusercontent.com/0xmortuex/ai-news-tracker/data/news.json  <-- docs/index.html (GitHub Pages)
                                                                    <-- Vex and any other client
```

Published files (on the `data` branch): `news.json`, `index.json`, `feed.atom`,
`feed.json`, `sources-health.json`, `releases.json`, `digest-daily.json`, `digest-weekly.json`,
`digest.json` (copy of the daily one), `digest-daily.md`, `digest-weekly.md`, `guides.json`,
`status.json`, `state.json` (internal). The contract is in
[`docs/CONTRACT.md`](docs/CONTRACT.md) and [`docs/news.schema.json`](docs/news.schema.json).

## Repository layout

| Path | What |
|---|---|
| `config/sources.json` | the curated source list (tier, kind, country, filters, poll interval, third-party flag) |
| `scripts/ingest.mjs` | CLI entry point; `scripts/lib/*` pure modules (parse, normalize, cluster, tag, score, build, validate, fetch) |
| `config/guide-sources.json` | sources for `guides.json` (replaces the Cloudflare Worker `/guides/aggregate` route) |
| `scripts/guides.mjs`, `scripts/eval-tagger.mjs` | builds `guides.json`; prints tagger precision/recall on the labelled fixture |
| `tests/` | `node:test` suite, fixtures in `tests/fixtures` (real feed samples and headlines); runs offline |
| `docs/` | GitHub Pages site (`index.html`, Guides tab files) and the contract |
| `.github/workflows/ingest.yml` | cron every 30 min + manual run; tests, ingest, force-push to `data` |
| `.github/workflows/test.yml` | tests on every PR (Node 20 and 22) |
| `legacy/` | the old Django app, kept for reference only |

## Use it

Needs Node 20+ (no dependencies, no install step).

```
npm test                       # offline unit + pipeline tests
node scripts/ingest.mjs --out data            # one live pass (about 20 s), writes data/
node scripts/guides.mjs --out data            # guides.json (17 requests over 6 hosts)
node scripts/eval-tagger.mjs                  # tagger precision / recall on tests/fixtures/labelled-headlines.json
node scripts/ingest.mjs --dry-run --only openai,hf-papers --min-items 1 --min-sources 1
npm run serve                  # then open http://127.0.0.1:8080/docs/index.html?data=../data/news.json
```

`ingest.mjs` flags: `--out`, `--state-dir`, `--config`, `--only a,b`, `--force` (ignore
poll intervals and backoff), `--dry-run`, `--min-items`, `--min-sources`.
It exits 1 and writes nothing when the result is invalid or below the sanity floor
(80 items, 15 healthy sources, no more than a 50% drop from the previous file), so
the previous data stays published.

## Politeness and terms

Descriptive `User-Agent`, conditional GET with ETag / If-Modified-Since, one request
at a time per host with a gap, 15 s timeout, response size caps, per-source poll
intervals, back-off on 429/5xx (honours `Retry-After`). Only the title, link,
source, date, a source-provided excerpt of at most 280 characters and derived tags
are published: no article text, no images. Community scrapes (Anthropic, xAI, UK
AISI, The Batch come from `Olshansk/rss-feeds`) are flagged `thirdParty` and shown
as such. To request removal of a source or an item, open an issue.

## Legacy

`legacy/` holds the original Django app. The live site never used it.
