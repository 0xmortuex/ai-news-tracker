// Runs the REAL inline script of docs/index.html in a vm with a tiny DOM stub
// (no browser needed) and checks what it renders from a news.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
const guidesLib = readFileSync(path.join(root, 'docs', 'guides-lib.js'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];

const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
const doc = {
  schema: 'ai-news/1', schemaVersion: 1, generatedAt: iso(NOW - 12 * 60000), itemCount: 4,
  sources: [
    { id: 'openai', name: 'OpenAI News', status: 'ok', stale: false, itemCount: 3 },
    { id: 'xai-news', name: 'xAI News (third-party scrape)', status: 'ok', stale: true, staleReason: 'no new item for over 21 days', itemCount: 0 },
    { id: 'broken', name: 'Broken', status: 'error', stale: true, staleReason: '3 consecutive failures', error: 'HTTP 503', itemCount: 0 },
  ],
  items: [
    { id: 'a1', cluster: 'c-00000001', title: 'OpenAI unveils GPT-6', url: 'https://openai.com/index/gpt-6', canonicalUrl: 'https://openai.com/index/gpt-6', source: 'OpenAI News', sourceId: 'openai', sourceKind: 'company', country: 'US', lang: 'en', publishedAt: iso(NOW - 3600000), firstSeenAt: iso(NOW - 3000000), kind: 'model-release', importance: 82, companies: ['OpenAI'], models: ['GPT-6'], topics: ['llm'], summary: 'A new model.', alsoIn: [{ source: 'The Decoder', url: 'https://the-decoder.com/gpt-6' }], breaking: true },
    { id: 'a2', cluster: 'c-00000002', title: 'Qwen releases <img src=x onerror=alert(1)> weights', url: 'javascript:alert(1)', canonicalUrl: 'https://x.test/q', source: 'Qwen HF', sourceId: 'hf-qwen', sourceKind: 'repo', country: 'CN', lang: 'en', publishedAt: iso(NOW - 7200000), firstSeenAt: iso(NOW - 7000000), kind: 'model-release', importance: 35, companies: ['Alibaba'], models: [], topics: ['open-weights', 'china'], summary: '', alsoIn: [], breaking: false },
    { id: 'a3', cluster: 'c-00000003', title: 'EU Commission opens AI Act consultation', url: 'https://digital-strategy.ec.europa.eu/x', canonicalUrl: 'https://digital-strategy.ec.europa.eu/x', source: 'EU Digital Strategy', sourceId: 'eu', sourceKind: 'news', country: 'EU', lang: 'en', publishedAt: iso(NOW - 9000000), firstSeenAt: iso(NOW - 8000000), kind: 'policy', importance: 20, companies: [], models: [], topics: ['regulation'], summary: 'Consultation.', alsoIn: [], breaking: false },
    { id: 'a4', cluster: 'c-00000004', title: 'Anthropic news item sponsored', url: 'https://anthropic.com/news/x', canonicalUrl: 'https://anthropic.com/news/x', source: 'Anthropic News (third-party scrape)', sourceId: 'anthropic-news', sourceKind: 'company', country: 'US', lang: 'en', publishedAt: iso(NOW - 10000000), firstSeenAt: iso(NOW - 9000000), kind: 'product', importance: 40, companies: ['Anthropic'], models: [], topics: [], summary: '', alsoIn: [], breaking: false, thirdParty: true },
  ],
};

function makeEl(id) {
  const listeners = {};
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, style: {}, dataset: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { (f === undefined ? !this._s.has(c) : f) ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t, ev = {}) { (listeners[t] || []).forEach(fn => fn({ preventDefault() {}, target: el, ...ev })); },
    replaceWith() {}, cloneNode() { return el; }, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
  };
  return el;
}

async function boot({ fetchImpl, search = '?data=../data/news.json', storage = {} }) {
  const els = new Map();
  const getEl = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const store = { ...storage };
  const sandbox = {
    console, URL, URLSearchParams, AbortController, Date, JSON, Math, Promise, Set, Map, Array, Object, String, Number, Error, encodeURIComponent,
    document: { getElementById: getEl, querySelectorAll: () => [], createElement: () => makeEl('x'), body: makeEl('body') },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    location: { search, hash: '', href: 'http://127.0.0.1:8080/docs/index.html' + search },
    history: { replaceState() {}, pushState() {} },
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    setInterval: () => 0, // no background timers in tests
    DOMParser: undefined,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(guidesLib, sandbox);
  vm.runInContext(script, sandbox);
  // wait for the async news load to settle
  for (let i = 0; i < 100; i++) {
    const mode = vm.runInContext('dataMode', sandbox);
    if (mode !== 'loading' && !vm.runInContext('refreshing', sandbox)) break;
    await new Promise(r => setTimeout(r, 10));
  }
  return { sandbox, getEl, store, run: code => vm.runInContext(code, sandbox) };
}

const okFetch = calls => async url => {
  calls.push(String(url));
  if (/news\.json/.test(url)) return new Response(JSON.stringify(doc), { status: 200 });
  throw new Error('unexpected fetch ' + url);
};

test('renders cards, tags, importance, also-in, freshness and stale note from news.json', async () => {
  const calls = [];
  const s = await boot({ fetchImpl: okFetch(calls) });
  assert.equal(s.run('dataMode'), 'live');
  // news.json first; the optional Phase 3 siblings come from the same folder. Never a proxy.
  assert.equal(calls[0], '../data/news.json');
  assert.deepEqual(calls.slice(1).sort(), ['../data/entities.json', '../data/stories.json'], 'only data files were fetched (no proxy)');
  const cards = s.getEl('articles').innerHTML;
  assert.match(cards, /OpenAI unveils GPT-6/);
  assert.match(cards, /model-release/);
  assert.match(cards, /also in: <a [^>]*>The Decoder/);
  assert.match(cards, /BREAKING/);
  assert.match(cards, /class="imp top"[^>]*>82/);
  assert.match(cards, /third-party/);
  assert.match(s.getEl('stat-updated').textContent, /^updated 12m ago$/);
  assert.match(s.getEl('data-banner').innerHTML, /2 sources are stale or failing/);
  assert.match(s.getEl('data-banner').innerHTML, /3 consecutive failures/);
  assert.equal(s.getEl('stat-sources').textContent, '1/3');
  assert.match(s.getEl('visible-count').textContent, /4 of 4/);
});

test('untrusted data: markup escaped, javascript: URLs neutralised', async () => {
  const s = await boot({ fetchImpl: okFetch([]) });
  const cards = s.getEl('articles').innerHTML;
  assert.ok(!cards.includes('<img src=x'), 'title markup must be escaped');
  assert.match(cards, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!cards.includes('javascript:'), 'javascript: URL must not reach href');
});

test('filters: kind, importance, company, topic', async () => {
  const s = await boot({ fetchImpl: okFetch([]) });
  s.getEl('f-kind').fire('change', { target: { value: 'policy' } });
  assert.match(s.getEl('visible-count').textContent, /^1 of 4/);
  s.getEl('f-kind').fire('change', { target: { value: 'all' } });
  s.getEl('f-imp').fire('change', { target: { value: '40' } });
  assert.match(s.getEl('visible-count').textContent, /^2 of 4/);
  s.getEl('f-imp').fire('change', { target: { value: '0' } });
  s.getEl('f-company').fire('change', { target: { value: 'Alibaba' } });
  assert.match(s.getEl('visible-count').textContent, /^1 of 4/);
  s.getEl('f-company').fire('change', { target: { value: 'all' } });
  s.getEl('f-topic').fire('change', { target: { value: 'regulation' } });
  assert.match(s.getEl('visible-count').textContent, /^1 of 4/);
  assert.match(s.getEl('f-company').innerHTML, /<option value="Anthropic">/, 'company options come from the data');
});

test('mute list: keyword and source, persisted in localStorage', async () => {
  const s = await boot({ fetchImpl: okFetch([]) });
  s.getEl('mute-input').value = ' Sponsored ';
  s.getEl('mute-form').fire('submit');
  assert.match(s.getEl('visible-count').textContent, /^3 of 4/);
  const btn = { dataset: { muteSource: 'hf-qwen', muteName: 'Qwen HF' } };
  s.getEl('articles').fire('click', { target: { closest: sel => (sel === '[data-mute-source]' ? btn : null) } });
  assert.match(s.getEl('visible-count').textContent, /^2 of 4/);
  const saved = JSON.parse(s.store['ai-news-mute-v1']);
  assert.deepEqual(saved.keywords, ['sponsored']);
  assert.deepEqual(saved.sources, ['hf-qwen']);
  assert.match(s.getEl('mute-list').innerHTML, /source: Qwen HF/);
  // reload picks the mute list up again
  const s2 = await boot({ fetchImpl: okFetch([]), storage: { 'ai-news-mute-v1': s.store['ai-news-mute-v1'] } });
  assert.match(s2.getEl('visible-count').textContent, /^2 of 4/);
});

test('unreachable news.json: marked fallback to the legacy proxy path, then cached copy', async () => {
  const calls = [];
  const failing = async url => { calls.push(String(url)); throw new Error('network down'); };
  // legacy path uses DOMParser; stub is undefined so each legacy source fails fast -> cache is used
  const cached = JSON.stringify(doc);
  const s = await boot({ fetchImpl: failing, storage: { 'ai-news-cache-v3': cached } });
  assert.ok(calls[0].endsWith('news.json'), 'live data is tried first');
  assert.ok(calls.some(u => /ai-news-cors\.mortuexhavoc\.workers\.dev/.test(u)), 'fallback goes through the old worker');
  assert.equal(s.run('dataMode'), 'cache');
  assert.match(s.getEl('data-banner').innerHTML, /Offline copy/);
});

test('unreachable and nothing cached: explicit error banner, no crash', async () => {
  const s = await boot({ fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(s.run('dataMode'), 'error');
  assert.match(s.getEl('data-banner').innerHTML, /No data/);
});

test('the data query parameter only accepts same-origin relative .json paths', async () => {
  const calls = [];
  const f = async url => { calls.push(String(url)); return new Response(JSON.stringify(doc)); };
  await boot({ fetchImpl: f, search: '?data=https://evil.example/news.json' });
  assert.match(calls[0], /^https:\/\/raw\.githubusercontent\.com\/0xmortuex\/ai-news-tracker\/data\/news\.json$/);
  const c2 = [];
  await boot({ fetchImpl: async u => { c2.push(String(u)); return new Response(JSON.stringify(doc)); }, search: '?data=//evil.example/news.json' });
  assert.match(c2[0], /^https:\/\/raw\.githubusercontent\.com/);
});
