import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runIngest, isDue } from '../scripts/lib/ingest-core.mjs';
import { buildAtom, buildJsonFeed } from '../scripts/lib/build.mjs';
import { validate, checkInvariants } from '../scripts/lib/validate.mjs';
import { parseFeed } from '../scripts/lib/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = n => readFileSync(path.join(here, 'fixtures', n), 'utf8');
const schema = JSON.parse(readFileSync(path.join(here, '..', 'docs', 'news.schema.json'), 'utf8'));
const config = JSON.parse(readFileSync(path.join(here, '..', 'config', 'sources.json'), 'utf8'));

const NOW = Date.parse('2026-10-15T15:00:00Z');
const S = {
  decoder: { id: 'the-decoder', name: 'The Decoder', category: 'press', tier: 2, url: 'https://the-decoder.com/feed/', format: 'feed', sourceKind: 'news', country: 'OTHER', lang: 'en', maxItems: 15 },
  arxiv: { id: 'arxiv-cs-cl', name: 'arXiv cs.CL', category: 'research', tier: 3, url: 'https://rss.arxiv.org/rss/cs.CL', format: 'feed', sourceKind: 'research', country: 'OTHER', lang: 'en', filter: 'arxiv', maxItems: 3, pollEveryMin: 720, prior: { kind: 'paper' } },
  mistral: { id: 'mistral-news', name: 'Mistral News', category: 'lab', tier: 1, url: 'https://mistral.ai/news/rss', format: 'feed', sourceKind: 'company', country: 'EU', lang: 'en', company: 'Mistral' },
  ollama: { id: 'ollama-releases', name: 'Ollama releases', category: 'tracker', tier: 2, url: 'https://github.com/ollama/ollama/releases.atom', format: 'feed', sourceKind: 'repo', country: 'US', lang: 'en', company: 'Ollama', maxItems: 2, titleTemplate: 'Ollama {title}', prior: { kind: 'tool' } },
  hfp: { id: 'hf-papers', name: 'HF Daily Papers', category: 'research', tier: 1, url: 'https://huggingface.co/api/daily_papers?limit=30', format: 'hf-papers', sourceKind: 'research', country: 'OTHER', lang: 'en', prior: { kind: 'paper' } },
  hn: { id: 'hn-llm', name: 'HN LLM', category: 'community', tier: 2, url: 'https://hn.algolia.com/api/v1/search_by_date', format: 'hn-algolia', sourceKind: 'community', country: 'OTHER', lang: 'en' },
  bad: { id: 'broken', name: 'Broken feed', category: 'press', tier: 3, url: 'https://broken.example.com/feed', format: 'feed', sourceKind: 'news', country: 'US', lang: 'en' },
  html: { id: 'htmlpage', name: 'HTML page', category: 'press', tier: 3, url: 'https://html.example.com/feed', format: 'feed', sourceKind: 'news', country: 'US', lang: 'en' },
};
const sources = Object.values(S);

const bodies = {
  [S.decoder.url]: { body: fx('decoder-rss.xml'), etag: '"d1"' },
  [S.arxiv.url]: { body: fx('arxiv-cs-cl.xml'), etag: '"a1"' },
  [S.mistral.url]: { body: fx('mistral-rss.xml'), headers: { 'content-type': 'text/plain' } },
  [S.ollama.url]: { body: fx('ollama-releases.atom') },
  [S.hfp.url]: { body: fx('hf-daily-papers.json') },
  [S.hn.url]: { body: fx('hn-algolia.json') },
  [S.html.url]: { body: '<!DOCTYPE html><html><body>Cloudflare</body></html>' },
};

function makeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url === S.bad.url) return new Response('nope', { status: 503, headers: { 'retry-after': '600' } });
    const b = bodies[url];
    if (!b) return new Response('not found', { status: 404 });
    if (b.etag && init.headers['If-None-Match'] === b.etag) return new Response(null, { status: 304 });
    return new Response(b.body, { status: 200, headers: { ...(b.headers || {}), ...(b.etag ? { etag: b.etag } : {}) } });
  };
}

test('end to end: valid ai-news/1, filters, caps, failures recorded, nothing thrown', async () => {
  const calls = [];
  const r = await runIngest({ sources, state: null, prevNews: null, now: NOW, fetchImpl: makeFetch(calls), sleep: async () => {} });
  const errs = [...validate(r.news, schema), ...checkInvariants(r.news)];
  assert.deepEqual(errs, []);
  assert.equal(r.news.schema, 'ai-news/1');
  assert.equal(r.news.generatedAt, '2026-10-15T15:00:00Z');
  // arXiv: hard filter + maxItems 3, Announce Type new only
  const arx = r.news.items.filter(i => i.sourceId === 'arxiv-cs-cl');
  assert.ok(arx.length > 0 && arx.length <= 3);
  assert.ok(arx.every(i => i.kind === 'paper'));
  // repo titles templated and capped
  const ol = r.news.items.filter(i => i.sourceId === 'ollama-releases');
  assert.equal(ol.length, 2);
  assert.ok(ol.every(i => i.title.startsWith('Ollama v') && i.kind === 'tool'));
  // Mistral served as text/plain parsed, model release detected
  const mi = r.news.items.find(i => i.title === 'Introducing Mistral Large 4');
  assert.equal(mi.kind, 'model-release');
  assert.ok(mi.companies.includes('Mistral'));
  // per-source health
  const h = Object.fromEntries(r.news.sources.map(s => [s.id, s]));
  assert.equal(h['the-decoder'].status, 'ok');
  assert.equal(h.broken.status, 'error');
  assert.equal(h.broken.error, 'HTTP 503');
  assert.equal(h.broken.stale, true);
  assert.equal(h.htmlpage.status, 'error');
  assert.match(h.htmlpage.error, /HTML page, not a feed/);
  // backoff honours Retry-After (>= 10 min) and is in state
  assert.ok(Date.parse(r.state.sources.broken.nextTryAt) >= NOW + 600 * 1000);
  // deterministic ordering: newest first
  const dates = r.news.items.map(i => i.publishedAt);
  assert.deepEqual([...dates].sort().reverse(), dates);
});

test('second run: conditional GET sends If-None-Match, 304 keeps items, failed source is in backoff', async () => {
  const calls1 = [];
  const r1 = await runIngest({ sources, state: null, prevNews: null, now: NOW, fetchImpl: makeFetch(calls1), sleep: async () => {} });
  const calls2 = [];
  const r2 = await runIngest({
    sources, state: r1.state, prevNews: r1.news, now: NOW + 27 * 60000, fetchImpl: makeFetch(calls2), sleep: async () => {}, force: false,
  });
  const dec = calls2.find(c => c.url === S.decoder.url);
  assert.equal(dec.headers['If-None-Match'], '"d1"');
  assert.ok(!calls2.some(c => c.url === S.bad.url), 'backed-off source is not hit again');
  const d = r2.results.find(x => x.id === 'the-decoder');
  assert.equal(d.outcome, 'not-modified');
  assert.equal(r2.news.items.filter(i => i.sourceId === 'the-decoder').length, 4);
  // ids and cluster ids are stable across runs
  const ids1 = r1.news.items.map(i => i.id + i.cluster).sort();
  const ids2 = r2.news.items.map(i => i.id + i.cluster).sort();
  assert.deepEqual(ids2, ids1);
  // firstSeenAt is preserved
  const a = r1.news.items.find(i => i.sourceId === 'the-decoder');
  const b = r2.news.items.find(i => i.id === a.id);
  assert.equal(b.firstSeenAt, a.firstSeenAt);
});

test('isDue honours pollEveryMin and nextTryAt, force overrides', () => {
  const src = { pollEveryMin: 60 };
  const now = NOW;
  assert.equal(isDue(src, {}, now, false), true);
  assert.equal(isDue(src, { lastFetchAt: new Date(now - 30 * 60000).toISOString() }, now, false), false);
  assert.equal(isDue(src, { lastFetchAt: new Date(now - 56 * 60000).toISOString() }, now, false), true);
  assert.equal(isDue(src, { nextTryAt: new Date(now + 60000).toISOString() }, now, false), false);
  assert.equal(isDue(src, { nextTryAt: new Date(now + 60000).toISOString() }, now, true), true);
});

test('schema rejects broken documents', () => {
  assert.ok(validate({}, schema).length > 0);
  assert.ok(validate({ schema: 'ai-news/2', schemaVersion: 1, generatedAt: 'x', itemCount: 0, sources: [], items: [] }, schema).length > 0);
  const item = { id: 'zz', cluster: 'c-1', title: '', url: 'ftp://x', canonicalUrl: 'x', source: 's', sourceId: 's', sourceKind: 'blog', country: 'FR', lang: 'en', publishedAt: 'yesterday', firstSeenAt: 'x', kind: 'rumor', importance: 140, companies: [], models: [], topics: [], summary: 'x'.repeat(300), alsoIn: [], breaking: 'no' };
  const errs = validate({ schema: 'ai-news/1', schemaVersion: 1, generatedAt: '2026-10-15T00:00:00Z', itemCount: 1, sources: [], items: [item] }, schema);
  assert.ok(errs.length >= 8, errs.join('\n'));
});

test('Atom and JSON Feed outputs are well-formed and escape markup', async () => {
  const r = await runIngest({ sources, state: null, prevNews: null, now: NOW, fetchImpl: makeFetch([]), sleep: async () => {} });
  const news = { ...r.news, items: [{ ...r.news.items[0], title: 'A <b>&</b> "q"', summary: 'x < y' }, ...r.news.items.slice(1)] };
  const atom = buildAtom(news, { limit: 10 });
  assert.match(atom, /^<\?xml version="1.0" encoding="utf-8"\?>/);
  assert.ok(atom.includes('A &lt;b&gt;&amp;&lt;/b&gt; &quot;q&quot;'));
  const parsed = parseFeed(atom);
  assert.equal(parsed.length, 10);
  assert.equal(parsed[0].title, 'A <b>&</b> "q"'.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  const jf = buildJsonFeed(news, { limit: 5 });
  assert.equal(jf.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(jf.items.length, 5);
  assert.ok(jf.items.every(i => i.id && i.url && i.date_published && i._ai_news));
});

test('shipped config is sane: unique ids, https, known formats and presets, no dead sources', async () => {
  const ids = new Set();
  const formats = new Set(['feed', 'hf-models', 'hf-papers', 'hn-algolia', 'federal-register']);
  const { FILTERS } = await import('../scripts/lib/taxonomy.mjs');
  const dead = [/anthropic\.com\/news\/feed\.xml/, /ai\.meta\.com\/blog\/rss/, /blogs\.microsoft\.com\/ai\/feed/, /chinadaily/, /caixin/, /venturebeat/, /reuters/, /nikkei/, /marktechpost/, /news\.google\.com/];
  for (const s of config.sources) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.match(s.url, /^https:\/\//, s.id);
    assert.ok(formats.has(s.format), s.id);
    assert.ok([1, 2, 3, 4].includes(s.tier), s.id);
    assert.ok(['company', 'news', 'research', 'community', 'repo', 'newsletter'].includes(s.sourceKind), s.id);
    assert.ok(['US', 'CN', 'EU', 'OTHER'].includes(s.country), s.id);
    if (s.filter) assert.ok(FILTERS[s.filter], `${s.id} preset`);
    for (const re of dead) assert.ok(!re.test(s.url), `${s.id} is a dropped source`);
    if (/Olshansk/.test(s.url)) assert.equal(s.thirdParty, true, `${s.id} must be flagged third-party`);
  }
  assert.ok(config.sources.length >= 55);
});
