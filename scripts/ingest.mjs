#!/usr/bin/env node
// AI News Tracker ingest. Reads config/sources.json, fetches due sources with
// conditional GET, normalises/dedupes/tags/scores, validates, and writes
//   news.json  feed.atom  feed.json  sources-health.json  index.json  state.json
// into --out (default ./data). state.json carries ETags, health and the item pool
// between runs (the workflow restores it from the `data` branch).
//
// Exit codes: 0 = published files written, 1 = refused (invalid / below sanity
// floor / config error). On exit 1 NOTHING is written, previous files stay.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runIngest } from './lib/ingest-core.mjs';
import { buildAtom, buildJsonFeed } from './lib/build.mjs';
import { validate, checkInvariants } from './lib/validate.mjs';
import { buildDerived } from './lib/derived.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const a = {
    out: 'data', stateDir: null, config: path.join(ROOT, 'config', 'sources.json'),
    schema: path.join(ROOT, 'docs', 'news.schema.json'),
    only: null, force: false, dryRun: false, minItems: 80, minSources: 15, now: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--out') a.out = v();
    else if (k === '--state-dir') a.stateDir = v();
    else if (k === '--config') a.config = v();
    else if (k === '--only') a.only = v().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--force') a.force = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--min-items') a.minItems = Number(v());
    else if (k === '--min-sources') a.minSources = Number(v());
    else if (k === '--now') a.now = Date.parse(v());
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.stateDir) a.stateDir = a.out;
  return a;
}

async function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
}

async function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

function fail(msg) {
  console.error(`REFUSING TO PUBLISH: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  const config = JSON.parse(await readFile(args.config, 'utf8'));
  if (!Array.isArray(config.sources) || !config.sources.length) fail('config has no sources');
  const ids = new Set();
  for (const s of config.sources) {
    for (const k of ['id', 'name', 'tier', 'url', 'format', 'sourceKind', 'country', 'lang']) {
      if (s[k] === undefined) fail(`source ${s.id || '?'} is missing "${k}"`);
    }
    if (ids.has(s.id)) fail(`duplicate source id ${s.id}`);
    ids.add(s.id);
    if (!/^https:\/\//.test(s.url)) fail(`source ${s.id} url is not https`);
  }
  if (args.only) for (const id of args.only) if (!ids.has(id)) fail(`--only names unknown source ${id}`);

  const state = await readJsonIfExists(path.join(args.stateDir, 'state.json'));
  const prevNews = await readJsonIfExists(path.join(args.stateDir, 'news.json'));
  const schema = JSON.parse(await readFile(args.schema, 'utf8'));
  const now = args.now ?? Date.now();

  const t0 = Date.now();
  const res = await runIngest({
    sources: config.sources, state, prevNews, now, fetchImpl: globalThis.fetch,
    force: args.force, only: args.only,
    log: m => console.log(m),
  });
  const { news, health, results } = res;

  // ---- report ------------------------------------------------------------
  console.log(`ingest finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const r of results) {
    const h = health.find(x => x.id === r.id);
    const bits = [r.outcome.padEnd(12), String(r.status ?? '').padEnd(4)];
    if (r.outcome === 'ok') bits.push(`raw=${r.raw} kept=${r.kept} added=${r.added}${r.truncated ? ' TRUNCATED' : ''}`);
    if (r.outcome === 'error') bits.push(r.error);
    if (r.outcome === 'skipped') bits.push(r.reason);
    console.log(`  ${r.id.padEnd(26)} ${bits.join(' ')}  newest=${h && h.lastNewItem ? h.lastNewItem.slice(0, 10) : '-'}`);
  }

  // ---- gates -------------------------------------------------------------
  const errs = [...validate(news, schema), ...checkInvariants(news)];
  if (errs.length) fail(`news.json failed validation:\n  ${errs.slice(0, 20).join('\n  ')}`);
  if (news.items.length < args.minItems) fail(`only ${news.items.length} items (floor ${args.minItems})`);
  const okSources = health.filter(h => h.status === 'ok' && !h.stale).length;
  if (okSources < args.minSources) fail(`only ${okSources} healthy sources (floor ${args.minSources})`);
  if (prevNews && Array.isArray(prevNews.items) && prevNews.items.length >= args.minItems && news.items.length < prevNews.items.length * 0.5) {
    fail(`item count fell from ${prevNews.items.length} to ${news.items.length} (more than 50%)`);
  }

  // ---- Phase 2 derived files (releases, digests, status): validated before anything is written ----
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const loadSchema = async n => JSON.parse(await readFile(path.join(root, 'docs', n), 'utf8'));
  const derived = buildDerived({
    news, sources: config.sources, pool: res.state.pool,
    prev: {
      releases: await readJsonIfExists(path.join(args.stateDir, 'releases.json')),
      digestWeekly: await readJsonIfExists(path.join(args.stateDir, 'digest-weekly.json')),
    },
    forceWeekly: args.force,
  });
  const checks = [
    ['releases.json', derived.objects.releases, 'releases.schema.json'],
    ['digest-daily.json', derived.objects.daily, 'digest.schema.json'],
    ['digest-weekly.json', derived.objects.weekly, 'digest.schema.json'],
    ['status.json', derived.objects.status, 'status.schema.json'],
  ];
  for (const [name, obj, schemaFile] of checks) {
    const e = validate(obj, await loadSchema(schemaFile));
    if (e.length) fail(`${name} failed validation:\n  ${e.slice(0, 10).join('\n  ')}`);
  }
  console.log(`releases: ${derived.objects.releases.count}; digest daily ${derived.objects.daily.total} stories, weekly ${derived.objects.weekly.total}${derived.weeklyReused ? ' (reused: regenerated once per day)' : ''}; status providers ${derived.objects.status.providers.length}`);

  const newsText = JSON.stringify(news) + '\n';
  const summary = {
    items: news.items.length, sources: health.length, healthy: okSources,
    stale: health.filter(h => h.stale).length, failed: results.filter(r => r.outcome === 'error').length,
  };
  console.log(`valid: ${JSON.stringify(summary)}`);
  if (args.dryRun) { console.log('dry run: nothing written'); return; }

  const outDir = path.resolve(args.out);
  await mkdir(outDir, { recursive: true });
  const newestItem = news.items.reduce((m, i) => (i.publishedAt > m ? i.publishedAt : m), '');
  const index = {
    schema: news.schema, schemaVersion: news.schemaVersion, generatedAt: news.generatedAt, itemCount: news.items.length,
    newestPublishedAt: newestItem || null, staleSources: summary.stale,
    hash: createHash('sha1').update(newsText).digest('hex').slice(0, 16),
  };
  await atomicWrite(path.join(outDir, 'news.json'), newsText);
  await atomicWrite(path.join(outDir, 'feed.atom'), buildAtom(news));
  await atomicWrite(path.join(outDir, 'feed.json'), JSON.stringify(buildJsonFeed(news), null, 1) + '\n');
  await atomicWrite(path.join(outDir, 'sources-health.json'), JSON.stringify({ schema: 'ai-news-health/1', generatedAt: news.generatedAt, sources: health }, null, 1) + '\n');
  await atomicWrite(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  await atomicWrite(path.join(outDir, 'state.json'), JSON.stringify(res.state) + '\n');
  for (const [name, text] of Object.entries(derived.files)) await atomicWrite(path.join(outDir, name), text);
  console.log(`wrote ${6 + Object.keys(derived.files).length} files to ${outDir}`);
}

main().catch(e => { console.error(`ingest failed: ${e.stack || e.message}`); process.exit(1); });
