// Phase 3: entity/topic tagging, story clustering, story score, entities index, top list,
// digest top, RSS and top.json. Offline and deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { entitiesFor, entityNames, tagsFor, TAGS } from '../scripts/lib/entities.mjs';
import {
  buildStories, buildEntities, scoreStory, topStories, groupItems, sameEvent, STORIES_SCHEMA, ENTITIES_SCHEMA,
  SOURCES_CAP, TAGS_CAP,
} from '../scripts/lib/stories.mjs';
import { buildRss, buildTop, TOP_MAX_BYTES } from '../scripts/lib/feeds.mjs';
import { buildDigest, renderDigestMarkdown } from '../scripts/lib/digest.mjs';
import { buildDerived } from '../scripts/lib/derived.mjs';
import { buildNews } from '../scripts/lib/build.mjs';
import { validate } from '../scripts/lib/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rd = p => JSON.parse(readFileSync(path.join(here, p), 'utf8'));
const schemas = {
  news: rd('../docs/news.schema.json'),
  stories: rd('../docs/stories.schema.json'),
  entities: rd('../docs/entities.schema.json'),
  top: rd('../docs/top.schema.json'),
  digest: rd('../docs/digest.schema.json'),
};

const NOW = Date.parse('2026-10-15T12:00:00Z');
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const H = 3600000;
let seq = 0;
function hex16(n) { return String(n).padStart(16, '0').replace(/[^0-9a-f]/g, '0'); }

// A published-news item (what news.json carries), with overrides.
function item(o = {}) {
  seq += 1;
  const id = o.id || hex16(seq.toString(16));
  const at = o.publishedAt || iso(NOW - H);
  return {
    id, cluster: `c-${id.slice(-8)}`, title: 'Some title about nothing', url: `https://example.test/${id}`,
    canonicalUrl: `https://example.test/${id}`, source: 'Example', sourceId: `src-${id}`, sourceKind: 'news', country: 'US', lang: 'en',
    publishedAt: at, firstSeenAt: at, kind: 'other', importance: 30, baseImportance: 30, companies: [], models: [], topics: [],
    labels: ['general'], summary: '', alsoIn: [], breaking: false, sourceTier: 2, thirdParty: false, engagement: 0,
    ...o,
  };
}
const newsOf = (items, generatedAt = iso(NOW)) => ({ schema: 'ai-news/1', schemaVersion: 1, generatedAt, itemCount: items.length, sources: [], items });

// ---- entities and tags --------------------------------------------------------------------
test('entities: companies, models and products, typed, deduplicated', () => {
  const e = entitiesFor({ title: 'Anthropic adds background agents to Claude Code, GPT-6 and Cursor compared', summary: '', companies: ['Anthropic'], models: ['GPT-6'] });
  const byType = t => e.filter(x => x.type === t).map(x => x.name);
  assert.deepEqual(byType('company'), ['Anthropic']);
  assert.deepEqual(byType('model'), ['GPT-6']);
  assert.ok(byType('product').includes('Claude Code'));
  assert.ok(byType('product').includes('Cursor'));
  // companies the Phase 1 table does not know
  assert.ok(entitiesFor({ title: 'Databricks buys a startup', summary: '' }).some(x => x.name === 'Databricks' && x.type === 'company'));
  // "cursor" in lower case is a word, not the product
  assert.ok(!entitiesFor({ title: 'Move the cursor to the end', summary: '' }).some(x => x.name === 'Cursor'));
  assert.deepEqual(entityNames({ title: 'ChatGPT and chatgpt', summary: '', companies: ['OpenAI'] }), ['OpenAI', 'ChatGPT']);
});

test('tags: release, pricing, safety, research, policy, tooling and none', () => {
  const t = (title, extra = {}) => tagsFor({ title, summary: '', kind: 'other', labels: [], ...extra });
  assert.deepEqual(t('Introducing GPT-6', { kind: 'model-release', models: ['GPT-6'] }), ['release']);
  assert.ok(t('Claude Code now available in the browser').includes('release'));
  assert.ok(t('Gemini API pricing cut by half').includes('pricing'));
  assert.ok(t('New plan costs $20/month with higher rate limits').includes('pricing'));
  assert.ok(t('Researchers publish jailbreak against guardrails').includes('safety'));
  assert.ok(t('A study', { kind: 'paper' }).includes('research'));
  assert.ok(t('Senate passes AI bill', { kind: 'policy' }).includes('policy'));
  assert.ok(t('New SDK and CLI for agents').includes('tooling'));
  assert.deepEqual(t('Quarterly earnings call notes'), []);
  for (const tag of t('Introducing GPT-6 API pricing and safety report', { kind: 'model-release', models: ['GPT-6'] })) assert.ok(TAGS.includes(tag));
  // deterministic
  assert.deepEqual(t('Gemini API pricing cut'), t('Gemini API pricing cut'));
});

test('buildNews adds entities and tags to every item and still validates', () => {
  const config = rd('../config/sources.json');
  const fx = rd('fixtures/real-clusters.json');
  const news = buildNews(fx.items, config.sources, { now: Date.parse(fx.now), prevReps: new Set(), health: [] });
  assert.ok(news.items.length > 10);
  for (const it of news.items) {
    assert.ok(Array.isArray(it.entities));
    assert.ok(Array.isArray(it.tags));
    for (const c of it.companies) assert.ok(it.entities.includes(c), `${c} missing from entities`);
  }
  assert.deepEqual(validate(news, schemas.news), []);
  assert.ok(news.items.some(i => i.tags.includes('release')));
});

// ---- story clustering ----------------------------------------------------------------------
test('different angles on the same product event merge into one story with a source count', () => {
  const a = item({ title: 'Anthropic expands Claude Code with new background agents feature', source: 'The Verge', sourceId: 'verge', companies: ['Anthropic'], publishedAt: iso(NOW - 5 * H) });
  const b = item({ title: 'Claude Code gets background agents, Anthropic says', source: 'TechCrunch', sourceId: 'tc', companies: ['Anthropic'], publishedAt: iso(NOW - 3 * H), sourceTier: 3 });
  const c = item({ title: 'Quarterly earnings call notes', source: 'Other', sourceId: 'o' });
  const doc = buildStories(newsOf([a, b, c]));
  assert.equal(doc.schema, STORIES_SCHEMA);
  assert.equal(doc.count, 2);
  assert.equal(doc.merged, 1);
  const s = doc.stories.find(x => x.itemIds.length === 2);
  assert.ok(s);
  assert.equal(s.sourceCount, 2);
  assert.equal(s.firstPublishedAt, a.publishedAt);
  assert.equal(s.lastPublishedAt, b.publishedAt);
  assert.equal(s.url, a.url, 'primary: best source tier');
  assert.deepEqual(s.sources.map(x => x.source), ['The Verge', 'TechCrunch']);
  assert.ok(s.products.includes('Claude Code'));
});

test('stories do not merge across languages, aspects, versions or a wide time gap', () => {
  const mk = o => item({ companies: ['Anthropic'], ...o });
  const base = 'Anthropic expands Claude Code with new background agents feature';
  const alt = 'Claude Code gets background agents, Anthropic says';
  const t0 = NOW - 5 * H;
  const count = items => buildStories(newsOf(items)).count;
  assert.equal(count([mk({ title: base, publishedAt: iso(t0) }), mk({ title: alt, publishedAt: iso(t0 + 2 * H) })]), 1, 'control: merges');
  assert.equal(count([mk({ title: base, publishedAt: iso(t0) }), mk({ title: alt, lang: 'tr', publishedAt: iso(t0 + 2 * H) })]), 2, 'language');
  assert.equal(count([mk({ title: base, publishedAt: iso(t0 - 60 * H) }), mk({ title: alt, publishedAt: iso(t0) })]), 2, 'time window');
  assert.equal(count([mk({ title: base, publishedAt: iso(t0) }), mk({ title: 'Claude Code pricing: background agents explained, Anthropic says', publishedAt: iso(t0 + H) })]), 2, 'aspect');
  assert.equal(count([
    mk({ title: 'OpenAI raises $40 billion funding round from SoftBank', companies: ['OpenAI'], kind: 'funding', publishedAt: iso(t0) }),
    mk({ title: 'OpenAI closes funding round valuing company above $300 billion', companies: ['OpenAI'], kind: 'funding', publishedAt: iso(t0 + H) }),
  ]), 2, 'different numbers are different events');
});

test('story ids are stable when a story grows and independent of input order', () => {
  const a = item({ title: 'Anthropic expands Claude Code with new background agents feature', companies: ['Anthropic'], publishedAt: iso(NOW - 5 * H) });
  const b = item({ title: 'Claude Code gets background agents, Anthropic says', companies: ['Anthropic'], publishedAt: iso(NOW - 3 * H) });
  const one = buildStories(newsOf([a]));
  const two = buildStories(newsOf([a, b]));
  const rev = buildStories(newsOf([b, a]));
  assert.equal(two.stories[0].id, one.stories[0].id);
  assert.equal(JSON.stringify(two), JSON.stringify(rev));
});

test('sources are counted across folded duplicates (alsoIn) and de-duplicated by source id', () => {
  const a = item({
    title: 'Mistral releases Timestral model', source: 'Mistral', sourceId: 'mistral',
    alsoIn: [
      { source: 'HN', sourceId: 'hn', url: 'https://news.ycombinator.test/1', publishedAt: iso(NOW - 2 * H) },
      { source: 'Mistral', sourceId: 'mistral', url: 'https://mistral.test/dup', publishedAt: iso(NOW - 2 * H) },
      { source: 'Old feed with no id', url: 'https://old.test/1' },
    ],
  });
  const s = buildStories(newsOf([a])).stories[0];
  assert.equal(s.sourceCount, 3);
});

// ---- score ----------------------------------------------------------------------------------
test('story score: more sources, better tier and release/pricing/safety tags raise it; age lowers it', () => {
  const nowMs = NOW;
  const base = { sourceCount: 1, bestTier: 3, tags: [], signal: 30, engagement: 0, lastPublishedMs: nowMs, nowMs };
  const s0 = scoreStory(base).score;
  assert.ok(scoreStory({ ...base, sourceCount: 3 }).score > s0);
  assert.ok(scoreStory({ ...base, bestTier: 1 }).score > s0);
  assert.ok(scoreStory({ ...base, tags: ['release'] }).score > s0);
  const rel = scoreStory({ ...base, tags: ['release'] }).score;
  assert.ok(scoreStory({ ...base, tags: ['release', 'pricing'] }).score > rel);
  assert.ok(scoreStory({ ...base, lastPublishedMs: nowMs - 48 * H }).score < s0);
  // bounds and caps
  const max = scoreStory({ sourceCount: 99, bestTier: 1, tags: TAGS, signal: 100, engagement: 99999, lastPublishedMs: nowMs, nowMs });
  assert.ok(max.score <= 100 && max.score >= 0);
  assert.equal(max.parts.sources, SOURCES_CAP);
  assert.equal(max.parts.tags, TAGS_CAP);
  const min = scoreStory({ sourceCount: 1, bestTier: 4, tags: [], signal: 0, engagement: 0, lastPublishedMs: nowMs - 90 * 24 * H, nowMs });
  assert.ok(min.score >= 0);
  assert.equal(scoreStory(base).score, scoreStory({ ...base }).score);
});

// ---- entities index -------------------------------------------------------------------------
test('entities.json: 7 UTC day trend, counts, rising flag, tag totals; validates', () => {
  const day = d => Date.parse('2026-10-15T09:00:00Z') - d * 24 * H;
  const items = [];
  for (let i = 0; i < 3; i++) items.push(item({ title: `OpenAI ships update number ${i} for ChatGPT users today`, companies: ['OpenAI'], kind: 'product', publishedAt: iso(day(0) + i * 1000) }));
  items.push(item({ title: 'OpenAI quarterly numbers shared with investors', companies: ['OpenAI'], publishedAt: iso(day(3)) }));
  items.push(item({ title: 'Anthropic publishes a safety framework paper', companies: ['Anthropic'], kind: 'paper', labels: ['safety'], publishedAt: iso(day(1)) }));
  items.push(item({ title: 'Ancient story from last month', companies: ['OpenAI'], publishedAt: iso(day(12)) }));
  const doc = buildEntities(buildStories(newsOf(items)));
  assert.equal(doc.schema, ENTITIES_SCHEMA);
  assert.equal(doc.days.length, 7);
  assert.equal(doc.days[6], '2026-10-15');
  assert.equal(doc.days[0], '2026-10-09');
  const openai = doc.entities.find(e => e.name === 'OpenAI');
  assert.equal(openai.type, 'company');
  assert.deepEqual(openai.trend, [0, 0, 0, 1, 0, 0, 3]);
  assert.equal(openai.count, 4, 'the 12 day old story is outside the window');
  assert.equal(openai.today, 3);
  assert.equal(openai.rising, true);
  assert.ok(doc.entities.find(e => e.name === 'ChatGPT' && e.type === 'product'));
  assert.equal(doc.entities[0].name, 'OpenAI', 'sorted by count');
  const safety = doc.tags.find(t => t.tag === 'safety');
  assert.equal(safety.count, 1);
  assert.deepEqual(validate(doc, schemas.entities), []);
  assert.equal(JSON.stringify(doc), JSON.stringify(buildEntities(buildStories(newsOf([...items].reverse())))));
});

// ---- top list, digest, feeds -----------------------------------------------------------------
function manyStories(n, o = {}) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(item({
      title: `Story ${i} about the topic number ${i * 7} from vendor${i} with quite a few extra words`,
      companies: ['OpenAI'], sourceTier: 1 + (i % 3), baseImportance: (i * 13) % 90, importance: 20,
      publishedAt: iso(NOW - (i % 20) * H), ...o,
    }));
  }
  return items;
}

test('top today is ordered by score, English only, inside the window, and ties are deterministic', () => {
  const items = [
    item({ title: 'Introducing GPT-6 model', kind: 'model-release', models: ['GPT-6'], sourceTier: 1, baseImportance: 90, publishedAt: iso(NOW - H) }),
    item({ title: 'A minor blog post about gardens', sourceTier: 4, baseImportance: 5, publishedAt: iso(NOW - H) }),
    item({ title: 'Introducing Qwen 5 model', kind: 'model-release', models: ['Qwen 5'], sourceTier: 1, baseImportance: 90, lang: 'zh', publishedAt: iso(NOW - H) }),
    item({ title: 'Old release from a week ago for Gemini 4', kind: 'model-release', models: ['Gemini 4'], sourceTier: 1, baseImportance: 90, publishedAt: iso(NOW - 150 * H) }),
  ];
  const stories = buildStories(newsOf(items));
  const top = topStories(stories, { hours: 24, limit: 10 });
  assert.equal(top.length, 2);
  assert.equal(top[0].title, 'Introducing GPT-6 model');
  assert.ok(top[0].score > top[1].score);
  const scores = top.map(s => s.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  const wk = topStories(stories, { hours: 168, limit: 10 });
  assert.equal(wk.length, 3, 'weekly window includes the older release, still no Chinese item');
});

test('digest-daily.json carries top (schema valid) and markdown renders "Top today"; without stories nothing changes', () => {
  const news = newsOf(manyStories(30));
  const stories = buildStories(news);
  const daily = buildDigest(news, 'daily', stories);
  assert.ok(Array.isArray(daily.top) && daily.top.length === 10);
  const sc = daily.top.map(t => t.score);
  assert.deepEqual(sc, [...sc].sort((a, b) => b - a));
  assert.deepEqual(validate(daily, schemas.digest), []);
  assert.match(renderDigestMarkdown(daily), /## Top today/);
  const legacy = buildDigest(news, 'daily');
  assert.equal(legacy.top, undefined);
  assert.deepEqual(validate(legacy, schemas.digest), []);
  assert.ok(!/Top today/.test(renderDigestMarkdown(legacy)));
});

test('top.json: schema valid, at most 10, under 20 KB even with maximum-length titles', () => {
  const long = 'X'.repeat(290);
  const items = manyStories(40).map((it, i) => ({ ...it, title: `${long}${i}`.slice(0, 300), summary: 'S'.repeat(280) }));
  const stories = buildStories(newsOf(items));
  const top = buildTop(stories);
  assert.deepEqual(validate(top, schemas.top), []);
  assert.ok(top.stories.length <= 10);
  assert.ok(Buffer.byteLength(JSON.stringify(top)) < TOP_MAX_BYTES);
  assert.ok(TOP_MAX_BYTES < 20000);
  // the trimming path
  const fat = { ...stories, stories: stories.stories.map(s => ({ ...s, entities: Array.from({ length: 16 }, (_, k) => `Entity${'y'.repeat(100)}${k}`) })) };
  const t2 = buildTop(fat);
  assert.ok(Buffer.byteLength(JSON.stringify(t2)) < TOP_MAX_BYTES);
  assert.equal(t2.count, t2.stories.length);
});

test('top.json falls back to 72 h when the last day is quiet', () => {
  const items = manyStories(4, { publishedAt: iso(NOW - 40 * H) });
  const top = buildTop(buildStories(newsOf(items)));
  assert.equal(top.windowHours, 72);
  assert.equal(top.count, 4);
});

test('feed.rss: RSS 2.0, escaped, one item per story, ordered by score, guid is the story id', () => {
  const items = [
    item({ title: 'Tom & Jerry <script>alert(1)</script> "quoted" release', summary: 'Bell\u0007 & whistles', sourceTier: 1, baseImportance: 80 }),
    item({ title: 'Second story about something else entirely', sourceTier: 3, baseImportance: 10 }),
  ];
  const stories = buildStories(newsOf(items));
  const xml = buildRss(stories);
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<rss version="2\.0"/);
  assert.equal((xml.match(/<item>/g) || []).length, 2);
  assert.equal((xml.match(/<\/item>/g) || []).length, 2);
  assert.ok(!/<script>/.test(xml));
  assert.ok(!/\u0007/.test(xml));
  assert.match(xml, /Tom &amp; Jerry &lt;script&gt;/);
  assert.match(xml, /<guid isPermaLink="false">urn:ai-news-tracker:story:s-[0-9a-f]{8}<\/guid>/);
  assert.match(xml, /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
  assert.ok(xml.indexOf('Tom &amp;') < xml.indexOf('Second story'), 'higher score first');
  // balanced tags
  for (const tag of ['channel', 'item', 'title', 'link', 'description', 'guid', 'pubDate']) {
    assert.equal((xml.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length, (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length, tag);
  }
  assert.equal(xml, buildRss(buildStories(newsOf([...items].reverse()))));
});

test('buildDerived: new files are present, validate, and are byte-stable', () => {
  const config = rd('../config/sources.json');
  const fx = rd('fixtures/real-clusters.json');
  const news = buildNews(fx.items, config.sources, { now: Date.parse(fx.now), prevReps: new Set(), health: [] });
  const d1 = buildDerived({ news, sources: config.sources, pool: fx.items });
  const d2 = buildDerived({ news: JSON.parse(JSON.stringify(news)), sources: config.sources, pool: fx.items });
  for (const f of ['stories.json', 'entities.json', 'top.json', 'feed.rss']) {
    assert.ok(d1.files[f], f);
    assert.equal(d1.files[f], d2.files[f], `${f} deterministic`);
  }
  assert.deepEqual(validate(d1.objects.stories, schemas.stories), []);
  assert.deepEqual(validate(d1.objects.entities, schemas.entities), []);
  assert.deepEqual(validate(d1.objects.top, schemas.top), []);
  assert.deepEqual(validate(d1.objects.daily, schemas.digest), []);
  assert.deepEqual(validate(d1.objects.weekly, schemas.digest), []);
  assert.ok(Buffer.byteLength(d1.files['top.json']) < 20000);
  assert.ok(Array.isArray(d1.objects.daily.top));
  // a Phase 2 weekly digest (no `top`) is not reused
  const old = { ...d1.objects.weekly }; delete old.top;
  const d3 = buildDerived({ news, sources: config.sources, pool: fx.items, prev: { digestWeekly: old } });
  assert.equal(d3.weeklyReused, false);
  assert.ok(Array.isArray(d3.objects.weekly.top));
});

test('backward compatible: a Phase 1/2 news.json (no entities, tags, sourceTier, alsoIn ids) still builds stories', () => {
  const legacy = newsOf([
    { id: 'a'.repeat(16), cluster: 'c-aaaaaaaa', title: 'Old shape item about Gemini 4 launch', url: 'https://x.test/1', canonicalUrl: 'https://x.test/1', source: 'X', sourceId: 'x',
      sourceKind: 'news', country: 'US', lang: 'en', publishedAt: iso(NOW - H), firstSeenAt: iso(NOW - H), kind: 'other', importance: 10,
      companies: [], models: [], topics: [], summary: '', alsoIn: [{ source: 'Y', url: 'https://y.test/1' }], breaking: false },
  ]);
  const doc = buildStories(legacy);
  assert.equal(doc.count, 1);
  assert.equal(doc.stories[0].sourceCount, 2);
  assert.deepEqual(validate(doc, schemas.stories), []);
});

test('groupItems and sameEvent are pure over their input', () => {
  const a = item({ title: 'Anthropic expands Claude Code with new background agents feature', companies: ['Anthropic'] });
  const before = JSON.stringify(a);
  groupItems([a]);
  assert.equal(JSON.stringify(a), before, 'items are not mutated');
  assert.equal(typeof sameEvent, 'function');
});
