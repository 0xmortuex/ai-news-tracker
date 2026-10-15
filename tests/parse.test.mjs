import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseFeed, parseXmlFeed, parseJsonFeed, parseHfModels, parseHfPapers, parseHnAlgolia, parseFederalRegister, parseDate } from '../scripts/lib/parse.mjs';
import { decodeEntities, stripTags, clip } from '../scripts/lib/text.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = name => readFileSync(path.join(dir, name), 'utf8');

test('RSS 2.0 (The Decoder fixture): title entities, link, text summary, date', () => {
  const items = parseFeed(fx('decoder-rss.xml'));
  assert.equal(items.length, 4);
  assert.equal(items[0].title, "Anthropic's Q3 revenue hits $16.8B but growth slows ahead of planned November IPO");
  assert.match(items[0].link, /^https:\/\/the-decoder\.com\/anthropics-q3/);
  assert.ok(!/[<>]/.test(items[0].summary), 'summary is plain text');
  assert.match(items[0].published, /^\d{4}-\d{2}-\d{2}T/);
});

test('RSS 2.0 (arXiv fixture): dc:creator and Announce Type retained for filtering', () => {
  const items = parseFeed(fx('arxiv-cs-cl.xml'));
  assert.equal(items.length, 6);
  assert.match(items[0].link, /^https:\/\/arxiv\.org\/abs\//);
  assert.match(items[0].summary, /Announce Type: new/);
});

test('RSS served as text/plain is parsed by content (Mistral fixture)', () => {
  const items = parseFeed(fx('mistral-rss.xml'));
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Introducing Mistral Large 4');
  assert.equal(items[0].link, 'https://mistral.ai/news/mistral-large-4/');
});

test('Atom (GitHub releases fixture): href links and entry titles', () => {
  const items = parseFeed(fx('ollama-releases.atom'));
  assert.equal(items.length, 3);
  assert.match(items[0].link, /^https:\/\/github\.com\/ollama\/ollama\/releases\/tag\//);
  assert.ok(items[0].published);
});

test('Atom: picks rel=alternate, ignores rel=self/enclosure, handles CDATA', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <title type="html"><![CDATA[A &amp; B <i>x</i>]]></title>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" href="https://example.com/a?utm_source=x"/>
    <updated>2026-10-15T10:00:00+03:00</updated>
    <summary>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</summary></entry></feed>`;
  const [it] = parseXmlFeed(xml);
  assert.equal(it.link, 'https://example.com/a?utm_source=x');
  assert.equal(it.summary, 'Hello world');
  assert.equal(it.published, '2026-10-15T07:00:00.000Z');
});

test('RSS 1.0 / RDF items and guid permalink fallback', () => {
  const xml = `<rdf:RDF><item><title>T</title><guid isPermaLink="true">https://example.org/p/1</guid><dc:date>2026-10-01T00:00:00Z</dc:date></item></rdf:RDF>`;
  const [it] = parseFeed(xml);
  assert.equal(it.link, 'https://example.org/p/1');
  assert.equal(it.published, '2026-10-01T00:00:00.000Z');
});

test('JSON Feed 1.1', () => {
  const doc = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: '1', url: 'https://e.org/1', title: 'Hi', content_text: 'Body', date_published: '2026-10-15T10:00:00Z', tags: ['ai'] }] });
  const [it] = parseFeed(doc);
  assert.deepEqual([it.title, it.link, it.summary, it.published, it.categories], ['Hi', 'https://e.org/1', 'Body', '2026-10-15T10:00:00.000Z', ['ai']]);
  assert.equal(parseJsonFeed({ items: [] }).length, 0);
});

test('HF models API: link, date, quantised variants skipped', () => {
  const items = parseHfModels(fx('hf-models-qwen.json'));
  assert.ok(items.length > 0);
  assert.match(items[0].link, /^https:\/\/huggingface\.co\/Qwen\//);
  assert.ok(items.every(i => i.published));
  const q = parseHfModels(JSON.stringify([{ id: 'Qwen/Qwen3-8B-GGUF', createdAt: '2026-10-01T00:00:00Z' }, { id: 'Qwen/Qwen3-8B', createdAt: '2026-10-01T00:00:00Z' }]));
  assert.deepEqual(q.map(i => i.extra.modelId), ['Qwen/Qwen3-8B']);
});

test('HF daily papers: upvotes become engagement', () => {
  const items = parseHfPapers(fx('hf-daily-papers.json'));
  assert.equal(items.length, 3);
  assert.match(items[0].link, /^https:\/\/huggingface\.co\/papers\//);
  assert.ok(Number.isInteger(items[0].engagement));
});

test('HN Algolia: points as engagement, Ask HN fallback link', () => {
  const items = parseHnAlgolia(fx('hn-algolia.json'));
  assert.equal(items.length, 5);
  assert.ok(items[0].engagement > 50);
  const ask = parseHnAlgolia(JSON.stringify({ hits: [{ title: 'Ask HN: x', url: null, objectID: '42', points: 80, created_at: '2026-10-01T00:00:00Z' }] }));
  assert.equal(ask[0].link, 'https://news.ycombinator.com/item?id=42');
});

test('Federal Register API', () => {
  const items = parseFederalRegister(JSON.stringify({ results: [{ title: 'AI RFI', html_url: 'https://www.federalregister.gov/d/1', abstract: 'Abs', publication_date: '2026-10-14' }] }));
  assert.equal(items[0].published, '2026-10-14T00:00:00.000Z');
});

test('parse errors are explicit', () => {
  assert.throws(() => parseFeed('<html><body>nope</body></html>'), /not an RSS\/Atom feed/);
  assert.throws(() => parseFeed('{"a":1}'), /not a JSON Feed/);
  assert.throws(() => parseHfModels('{}'), /not an array/);
  assert.throws(() => parseHnAlgolia('not json'), /invalid HN Algolia JSON/);
});

test('date and text helpers', () => {
  assert.equal(parseDate('Thu, 15 Oct 2026 13:17:00 +0300'), '2026-10-15T10:17:00.000Z');
  assert.equal(parseDate('15 Oct 2026 13:17 +0000'), '2026-10-15T13:17:00.000Z');
  assert.equal(parseDate('garbage'), null);
  assert.equal(decodeEntities('&#x41;&amp;&#66;&nbsp;'), 'A&B ');
  assert.equal(stripTags('<script>x()</script><p>a</p><p>b &amp; c</p>'), 'a b & c');
  assert.ok(clip('word '.repeat(100), 280).length <= 280);
  assert.ok(clip('word '.repeat(100), 280).endsWith('…'));
});
