// Phase 3 site features, driven through the real inline script of docs/index.html:
// one card per story ("N sources"), the watchlist (localStorage only), Top today in the digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, router, goodFiles, newsDoc, digestDaily, iso, NOW, jsonResp } from './site-harness.mjs';

const waitFor = async (s, fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await s.wait(10); }
};
const cards = html => (html.match(/role="listitem"/g) || []).length;
const a1 = newsDoc.items.find(i => i.id === 'a1');

const storiesDoc = () => ({
  schema: 'ai-news-stories/1', schemaVersion: 1, generatedAt: iso(NOW), itemCount: 7, count: 6, merged: 1,
  stories: [{
    id: 's-00000001', title: a1.title, url: a1.url, source: a1.source, sourceId: a1.sourceId, lang: 'en', kind: 'model-release',
    publishedAt: a1.publishedAt, firstPublishedAt: a1.publishedAt, lastPublishedAt: a1.publishedAt, firstSeenAt: a1.publishedAt,
    sourceCount: 3,
    sources: [
      { source: a1.source, sourceId: a1.sourceId, url: a1.url },
      { source: 'Anthropic News (third-party scrape)', sourceId: 's-a4', url: 'https://anthropic.com/news/x' },
      { source: 'The Decoder', sourceId: 'decoder', url: 'https://the-decoder.com/gpt-6' },
    ],
    itemIds: ['a1', 'a4'], entities: ['OpenAI', 'GPT-6', 'Anthropic'], tags: ['release'], score: 77,
  }],
});
const entitiesDoc = () => ({
  schema: 'ai-news-entities/1', schemaVersion: 1, generatedAt: iso(NOW), windowDays: 7, days: [],
  entities: [{ name: 'Cursor', type: 'product', count: 2, trend: [0, 0, 0, 0, 0, 1, 1], today: 1, prevAvg: 0.2, rising: false, lastSeenAt: iso(NOW) }],
  tags: [],
});

async function bootWithStories(extra = {}, files = {}) {
  const f = { ...goodFiles(), 'stories.json': storiesDoc(), 'entities.json': entitiesDoc(), ...files };
  const calls = [];
  const s = await boot({ fetchImpl: router(f, calls), ...extra });
  await waitFor(s, () => s.run('storiesDoc !== null'));
  return { s, calls };
}

test('stories.json folds merged items into one card and shows "N sources"', async () => {
  const plain = await boot({ fetchImpl: router(goodFiles()) });
  const before = cards(plain.getEl('articles').innerHTML);
  const { s } = await bootWithStories();
  const html = s.getEl('articles').innerHTML;
  assert.equal(cards(html), before - 1, 'the Anthropic item is folded into the OpenAI story');
  assert.ok(!/Anthropic ships Claude update/.test(html));
  assert.match(html, /3 sources/);
  assert.match(html, /The Decoder/, 'also-in lists every other source of the story');
  assert.match(s.getEl('visible-count').textContent, /^4 of 6$/, 'the denominator counts stories, not folded items');
});

test('without stories.json the page still works and counts sources from alsoIn', async () => {
  const docs = JSON.parse(JSON.stringify(goodFiles()['news.json']));
  docs.items[0].alsoIn = [{ source: 'The Decoder', sourceId: 'decoder', url: 'https://the-decoder.com/x' }, { source: 'Verge', url: 'https://theverge.test/x' }];
  const s = await boot({ fetchImpl: router({ ...goodFiles(), 'news.json': docs }) });
  assert.equal(s.run('storiesDoc'), null);
  assert.match(s.getEl('articles').innerHTML, /3 sources/);
  assert.match(s.getEl('visible-count').textContent, /^5 of 7$/);
});

test('a malformed stories.json is ignored, not fatal', async () => {
  const s = await boot({ fetchImpl: router({ ...goodFiles(), 'stories.json': { schema: 'something-else', stories: 'no' } }) });
  await s.wait(50);
  assert.equal(s.run('storiesDoc'), null);
  assert.match(s.getEl('visible-count').textContent, /^5 of 7$/);
});

test('watchlist: add by typing, highlighted cards, watched-only filter, hash, persistence, remove', async () => {
  const { s } = await bootWithStories();
  s.getEl('watch-input').value = 'OpenAI';
  s.getEl('watch-form').fire('submit');
  assert.deepEqual(JSON.parse(s.store['ai-news-watch-v1']), { entities: ['OpenAI'], topics: [] });
  let html = s.getEl('articles').innerHTML;
  assert.equal((html.match(/article class="article[^"]*watched/g) || []).length, 1, 'one story matches');
  assert.match(html, />watching</);
  assert.match(s.getEl('watch-list').innerHTML, /OpenAI/);
  // known tags and topics are stored as topics
  s.getEl('watch-input').value = 'regulation';
  s.getEl('watch-form').fire('submit');
  s.getEl('watch-input').value = 'release';
  s.getEl('watch-form').fire('submit');
  const stored = JSON.parse(s.store['ai-news-watch-v1']);
  assert.deepEqual(stored.entities, ['OpenAI']);
  assert.deepEqual(stored.topics, ['regulation', 'release']);
  // watched only
  s.getEl('filter-watch').fire('click', { target: { closest: () => ({ dataset: { f: 'watch', v: 'only' } }) } });
  assert.equal(s.run('filters.watch'), 'only');
  html = s.getEl('articles').innerHTML;
  assert.equal(cards(html), 2, 'OpenAI story and the EU regulation item');
  assert.ok(s.historyCalls.some(c => /watch=only/.test(String(c[1]))), 'shareable in the hash');
  // reload remembers the watchlist and the hash restores the filter
  const s2 = await boot({
    fetchImpl: router({ ...goodFiles(), 'stories.json': storiesDoc() }),
    storage: { 'ai-news-watch-v1': s.store['ai-news-watch-v1'] }, hash: '#/news?watch=only',
  });
  assert.equal(cards(s2.getEl('articles').innerHTML), 2);
  // remove
  s.getEl('watch-list').fire('click', { target: { closest: () => ({ dataset: { unwatch: 'entities', v: 'OpenAI' } }) } });
  assert.deepEqual(JSON.parse(s.store['ai-news-watch-v1']).entities, []);
});

test('watchlist: clicking a pill on a card toggles it; nothing leaves the browser', async () => {
  const { s, calls } = await bootWithStories();
  assert.match(s.getEl('articles').innerHTML, /data-watch="OpenAI"/);
  const click = (name, kind) => s.getEl('articles').fire('click', { target: { closest: sel => (sel.includes('data-watch') ? { dataset: { watch: name, watchKind: kind } } : null) } });
  click('OpenAI', 'entities');
  assert.deepEqual(JSON.parse(s.store['ai-news-watch-v1']).entities, ['OpenAI']);
  assert.match(s.getEl('articles').innerHTML, /aria-pressed="true"/);
  click('OpenAI', 'entities');
  assert.deepEqual(JSON.parse(s.store['ai-news-watch-v1']).entities, []);
  assert.ok(calls.every(u => /\.json(\?|$)/.test(u) && !/watch/i.test(u)), 'only data files are requested, no watchlist in any URL');
});

test('watchlist: junk in localStorage is ignored and the list is capped', async () => {
  const bad = await boot({ fetchImpl: router(goodFiles()), storage: { 'ai-news-watch-v1': '{"entities":[1,null,"<img src=x>"],"topics":"nope"}' } });
  assert.deepEqual(JSON.parse(JSON.stringify(bad.run('watch'))), { entities: ['<img src=x>'], topics: [] });
  assert.ok(!/<img src=x>/.test(bad.getEl('watch-list').innerHTML.replace(/&lt;img src=x&gt;/g, '')), 'rendered escaped');
  const s = await boot({ fetchImpl: router(goodFiles()), storage: { 'ai-news-watch-v1': 'not json' } });
  assert.deepEqual(JSON.parse(JSON.stringify(s.run('watch'))), { entities: [], topics: [] });
  for (let i = 0; i < 60; i++) { s.getEl('watch-input').value = `Name${i}`; s.getEl('watch-form').fire('submit'); }
  const w = JSON.parse(s.store['ai-news-watch-v1']);
  assert.equal(w.entities.length + w.topics.length, 50);
});

test('digest tab shows Top today with story scores and handles the published period shape', async () => {
  const daily = {
    ...digestDaily,
    period: { kind: 'daily', start: '2026-10-14T12:00:00Z', end: '2026-10-15T12:00:00Z', hours: 24 },
    top: [
      { id: 's-00000001', title: 'GPT-6 <b>ships</b>', url: 'https://openai.com/index/gpt-6', source: 'OpenAI News', sourceCount: 3, score: 77, tags: ['release'], entities: ['OpenAI'] },
      { id: 's-00000002', title: 'Evil link', url: 'javascript:alert(1)', source: 'X', sourceCount: 1, score: 40, tags: [], entities: [] },
    ],
  };
  delete daily.stats;
  daily.total = 12; daily.sources = [{ id: 'a', name: 'A', count: 1 }];
  const s = await boot({ fetchImpl: router({ ...goodFiles(), 'digest.json': daily, 'digest-daily.json': daily }), hash: '#/digest' });
  await waitFor(s, () => s.run('digest.status') === 'ok');
  const body = s.getEl('digest-body').innerHTML;
  assert.match(body, /Top today/);
  assert.match(body, />77</);
  assert.match(body, /3 sources/);
  assert.match(body, /GPT-6 &lt;b&gt;ships&lt;\/b&gt;/);
  assert.ok(!/href="javascript:/.test(body));
  assert.match(body, /2026-10-14 to 2026-10-15/);
  assert.match(s.getEl('digest-count').textContent, /12 items · 1 sources/);
  assert.match(s.run('digestToMarkdown(digest.docs.daily)'), /## Top today\n\n- \[GPT-6/);
});
