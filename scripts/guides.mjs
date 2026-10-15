#!/usr/bin/env node
// Builds guides.json (ai-news-guides/1) from config/guide-sources.json.
// One attempt per source, 15 s timeout, per-host gap, size caps. A failing source is
// recorded in `sources` and skipped. Exit 1 (writing nothing) when fewer than --min-items
// guides survive or the result fails schema validation, so the previous file stays.
//
//   node scripts/guides.mjs --out data [--dry-run] [--min-items 20]
//
// GITHUB_TOKEN (optional) raises the GitHub search rate limit.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conditionalGet, runPerHost, USER_AGENT } from './lib/fetch.mjs';
import { validate } from './lib/validate.mjs';
import {
  GUIDES_SCHEMA, buildGuides, parseHnGuides, parseRedditGuides, parseDevto, parseGithubRepos, parseYoutube, parseBlueskyAuthor,
} from './lib/guides.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_GAP = { 'www.reddit.com': 10000, 'api.github.com': 3000, 'hn.algolia.com': 1000, 'dev.to': 1500 };

const PARSERS = {
  hn: (t) => parseHnGuides(t),
  devto: (t) => parseDevto(t),
  reddit: (t, s) => parseRedditGuides(t, s.sub),
  github: (t) => parseGithubRepos(t),
  youtube: (t, s) => parseYoutube(t, s.name),
  bluesky: (t, s) => parseBlueskyAuthor(t, s.handle),
};

function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

export async function collectGuides({ sources, now, fetchImpl = globalThis.fetch, sleep, token = '', log = () => {} }) {
  const since = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
  const sinceTs = Math.floor((now - 120 * 86400000) / 1000);
  const raw = [];
  const report = [];
  const jobs = sources.map(src => {
    const url = src.url.replace('{since}', since).replace('{since_ts}', String(sinceTs));
    const host = new URL(url).hostname;
    return {
      host,
      gapMs: HOST_GAP[host] || 1000,
      run: async () => {
        const headers = {};
        const r = await conditionalGet(url, {}, {
          fetchImpl: src.type === 'github' && token
            ? (u, init) => fetchImpl(u, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })
            : fetchImpl,
          maxBytes: 3000000, nowMs: now,
        });
        void headers;
        if (r.kind !== 'ok') {
          report.push({ id: src.id, name: src.name, status: 'error', count: 0, error: r.error || `HTTP ${r.status}` });
          log(`  ${src.id.padEnd(24)} error ${r.error}`);
          return;
        }
        try {
          const items = PARSERS[src.type](r.text, src);
          raw.push(...items);
          report.push({ id: src.id, name: src.name, status: 'ok', count: items.length, error: null });
          log(`  ${src.id.padEnd(24)} ok    ${items.length} items`);
        } catch (e) {
          report.push({ id: src.id, name: src.name, status: 'error', count: 0, error: `parse error: ${e.message}` });
          log(`  ${src.id.padEnd(24)} error parse error: ${e.message}`);
        }
      },
    };
  });
  await runPerHost(jobs, { concurrency: 5, gapMs: 1000, sleep });
  report.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { raw, report };
}

async function main() {
  const a = { out: 'data', dryRun: false, minItems: 20, minAgeMin: 0, config: path.join(ROOT, 'config', 'guide-sources.json'), now: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--out') a.out = v();
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--min-items') a.minItems = Number(v());
    else if (k === '--min-age-min') a.minAgeMin = Number(v());
    else if (k === '--config') a.config = v();
    else if (k === '--now') a.now = Date.parse(v());
    else throw new Error(`unknown argument ${k}`);
  }
  const now = a.now ?? Date.now();
  if (a.minAgeMin > 0) {
    // Politeness: the ingest workflow runs every 30 minutes; guides only need refreshing every couple of hours.
    try {
      const prev = JSON.parse(await readFile(path.join(path.resolve(a.out), 'guides.json'), 'utf8'));
      const ageMin = (now - Date.parse(prev.generatedAt)) / 60000;
      if (ageMin >= 0 && ageMin < a.minAgeMin) { console.log(`guides: previous file is ${Math.round(ageMin)} min old (< ${a.minAgeMin}); skipping`); return; }
    } catch { /* no previous file: build one */ }
  }
  const config = JSON.parse(await readFile(a.config, 'utf8'));
  const schema = JSON.parse(await readFile(path.join(ROOT, 'docs', 'guides.schema.json'), 'utf8'));
  const featured = JSON.parse(await readFile(path.join(ROOT, 'docs', 'featured-guides.json'), 'utf8')).guides || [];

  console.log(`guides: ${config.sources.length} sources (User-Agent ${USER_AGENT})`);
  const { raw, report } = await collectGuides({ sources: config.sources, now, token: process.env.GITHUB_TOKEN || '', log: m => console.log(m) });
  const items = buildGuides(raw, now);
  const out = {
    schema: GUIDES_SCHEMA,
    schemaVersion: 1,
    generatedAt: iso(now),
    count: items.length,
    featured: featured.map(f => ({ title: f.title, url: f.url, author: f.author, description: f.description, tags: f.tags, dateAdded: f.dateAdded, type: f.type })),
    sources: report,
    items,
  };
  const errs = validate(out, schema);
  if (errs.length) { console.error(`REFUSING TO PUBLISH guides.json:\n  ${errs.slice(0, 10).join('\n  ')}`); process.exit(1); }
  if (items.length < a.minItems) { console.error(`REFUSING TO PUBLISH guides.json: only ${items.length} items (floor ${a.minItems})`); process.exit(1); }
  const okSources = report.filter(r => r.status === 'ok').length;
  console.log(`guides: ${items.length} items from ${okSources}/${report.length} sources`);
  if (a.dryRun) { console.log('dry run: nothing written'); return; }
  await mkdir(path.resolve(a.out), { recursive: true });
  const file = path.join(path.resolve(a.out), 'guides.json');
  await writeFile(`${file}.tmp`, JSON.stringify(out) + '\n', 'utf8');
  await rename(`${file}.tmp`, file);
  console.log(`wrote ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`guides failed: ${e.stack || e.message}`); process.exit(1); });
}
