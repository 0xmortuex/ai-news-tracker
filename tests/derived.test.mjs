import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildNews } from '../scripts/lib/build.mjs';
import { buildDerived } from '../scripts/lib/derived.mjs';
import { validate } from '../scripts/lib/validate.mjs';
import { parseToolTitle, primaryModel, deriveReleases, buildReleases } from '../scripts/lib/releases.mjs';
import { buildDigest } from '../scripts/lib/digest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rd = p => JSON.parse(readFileSync(path.join(here, p), 'utf8'));
const config = rd('../config/sources.json');
const fx = rd('fixtures/real-clusters.json');
const schemas = {
  releases: rd('../docs/releases.schema.json'),
  digest: rd('../docs/digest.schema.json'),
  status: rd('../docs/status.schema.json'),
};
const NOW = Date.parse(fx.now);
const news = buildNews(fx.items, config.sources, { now: NOW, prevReps: new Set(), health: [] });
const d = buildDerived({ news, sources: config.sources, pool: fx.items });

test('every derived object validates against its JSON Schema', () => {
  assert.deepEqual(validate(d.objects.releases, schemas.releases), []);
  assert.deepEqual(validate(d.objects.daily, schemas.digest), []);
  assert.deepEqual(validate(d.objects.weekly, schemas.digest), []);
  assert.deepEqual(validate(d.objects.status, schemas.status), []);
});

test('digest files: daily/weekly kinds, digest.json is a copy of the daily one, markdown present', () => {
  assert.equal(d.objects.daily.period.kind, 'daily');
  assert.equal(d.objects.weekly.period.kind, 'weekly');
  assert.equal(d.files['digest.json'], d.files['digest-daily.json']);
  assert.match(d.files['digest-daily.md'], /^# AI News Daily Digest/);
  assert.match(d.files['digest-weekly.md'], /^# AI News Weekly Digest/);
});

test('digest is deterministic and ranked by baseImportance', () => {
  const a = JSON.stringify(buildDigest(news, 'weekly'));
  const b = JSON.stringify(buildDigest(JSON.parse(JSON.stringify(news)), 'weekly'));
  assert.equal(a, b);
  for (const s of d.objects.weekly.sections) {
    const v = s.items.map(i => i.baseImportance);
    assert.deepEqual(v, [...v].sort((x, y) => y - x));
    assert.ok(s.items.length <= 8);
    assert.ok(s.count >= s.items.length);
  }
  assert.ok(d.objects.weekly.total >= d.objects.daily.total);
});

test('digest keeps English items only and one section per item', () => {
  const seen = new Set();
  for (const s of d.objects.weekly.sections) {
    for (const i of s.items) {
      assert.equal(i.lang, 'en');
      assert.ok(!seen.has(i.id));
      seen.add(i.id);
    }
  }
});

test('weekly digest is regenerated once per UTC day', () => {
  const again = buildDerived({ news, sources: config.sources, pool: fx.items, prev: { digestWeekly: d.objects.weekly } });
  assert.equal(again.weeklyReused, true);
  const later = JSON.parse(JSON.stringify(news));
  later.generatedAt = '2026-10-16T00:30:00Z';
  const next = buildDerived({ news: later, sources: config.sources, pool: fx.items, prev: { digestWeekly: d.objects.weekly } });
  assert.equal(next.weeklyReused, false);
  assert.equal(next.objects.weekly.generatedAt, '2026-10-16T00:30:00Z');
});

test('releases: model names, companies, open only from the source, dedupe by (company, model)', () => {
  const r = d.objects.releases.releases;
  const by = m => r.filter(x => x.model.toLowerCase() === m.toLowerCase());
  const muse = by('Muse Spark Open');
  assert.equal(muse.length, 1);
  assert.equal(muse[0].company, 'Meta');
  assert.equal(muse[0].open, true); // Hugging Face carries the weights
  assert.ok(muse[0].alsoIn.length >= 1);
  const argon = by('Gemini 4 Argon');
  assert.equal(argon.length, 1);
  assert.equal(argon[0].company, 'Google');
  assert.equal(argon[0].open, null); // closed model, no source says otherwise: unknown, not false
  const ts = r.filter(x => /^Timestral/.test(x.model));
  assert.ok(ts.length >= 1);
  assert.ok(ts.every(x => x.company === 'Mistral' && x.open !== false));
  // newest first, ids unique
  const dates = r.map(x => x.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.equal(new Set(r.map(x => x.id)).size, r.length);
  for (const x of r) assert.ok(x.summary.length <= 200);
});

test('tool titles: pre-release suffix is folded into the final version', () => {
  assert.deepEqual(parseToolTitle('Ollama v0.40.5-rc2'), { product: 'Ollama', version: 'v0.40.5', prerelease: true });
  assert.deepEqual(parseToolTitle('Claude Code v2.1.300'), { product: 'Claude Code', version: 'v2.1.300', prerelease: false });
  assert.deepEqual(parseToolTitle('llama.cpp release b11669'), { product: 'llama.cpp', version: 'b11669', prerelease: false });
  assert.equal(parseToolTitle('A quiet Tuesday'), null);
});

test('primaryModel prefers the earliest model named in the title', () => {
  assert.equal(primaryModel({ title: 'Introducing Muse Wonder and Muse Wonder Full: Frontier Models', models: ['Muse Wonder Full'] }), 'Muse Wonder');
  assert.equal(primaryModel({ title: 'Quarterly results', models: ['Qwen3.8'] }), 'Qwen3.8');
});

test('carry-over: previous releases are kept for 90 days, merged by id, older dropped', () => {
  const prev = JSON.parse(JSON.stringify(d.objects.releases));
  const old = { ...prev.releases[0], id: 'ffffffffffffffff', model: 'Ancient 1', date: '2026-06-01T00:00:00Z' };
  const keep = { ...prev.releases[0], id: 'eeeeeeeeeeeeeeee', model: 'Recent 1', date: '2026-09-01T00:00:00Z' };
  prev.releases.push(old, keep);
  const out = buildReleases(deriveReleases(news.items, config.sources), prev, NOW, news.generatedAt);
  assert.ok(out.releases.some(x => x.model === 'Recent 1'));
  assert.ok(!out.releases.some(x => x.model === 'Ancient 1'));
  assert.equal(new Set(out.releases.map(x => x.id)).size, out.releases.length);
});

test('status feeds stay out of news.json and appear in status.json', () => {
  const st = config.sources.find(s => s.category === 'status');
  assert.ok(st);
  const pool = [{ id: 'aaaaaaaaaaaaaaaa', title: 'Elevated errors on the API', url: 'https://status.example.com/incidents/1', canonicalUrl: 'https://status.example.com/incidents/1', sourceId: st.id, publishedAt: '2026-10-15T10:00:00Z', firstSeenAt: '2026-10-15T10:05:00Z', summary: 'Investigating', engagement: 0 }];
  const n = buildNews(pool, config.sources, { now: NOW, prevReps: new Set(), health: [] });
  assert.equal(n.items.length, 0);
  const dd = buildDerived({ news: n, sources: config.sources, pool });
  const p = dd.objects.status.providers.find(x => x.id === st.id);
  assert.equal(p.incidents.length, 1);
});
