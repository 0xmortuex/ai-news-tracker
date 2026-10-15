// Service worker: pure decision functions + a simulated fetch/activate flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './site-harness.mjs';

const swSource = readFileSync(path.join(root, 'docs', 'sw.js'), 'utf8');
const DATA = 'https://raw.githubusercontent.com/0xmortuex/ai-news-tracker/data/news.json';
const ORIGIN = 'https://0xmortuex.github.io';

function makeCaches() {
  const stores = new Map();
  const keyOf = k => (typeof k === 'string' ? k : k.url);
  const bucket = n => { if (!stores.has(n)) stores.set(n, new Map()); return stores.get(n); };
  return {
    stores,
    async open(n) {
      const b = bucket(n);
      return {
        async put(k, r) { b.set(keyOf(k), r); },
        async match(k) { const r = b.get(keyOf(k)); return r ? r.clone() : undefined; },
        async add(k) { b.set(keyOf(k), new Response('shell')); },
      };
    },
    async match(k) { for (const b of stores.values()) { const r = b.get(keyOf(k)); if (r) return r.clone(); } return undefined; },
    async keys() { return [...stores.keys()]; },
    async delete(n) { return stores.delete(n); },
  };
}

function loadSw({ fetchImpl, caches = makeCaches() } = {}) {
  const handlers = {};
  const self = {
    addEventListener(t, fn) { handlers[t] = fn; },
    registration: { scope: ORIGIN + '/ai-news-tracker/' },
    location: { href: ORIGIN + '/ai-news-tracker/sw.js' },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const sandbox = { self, caches, fetch: fetchImpl, Response, Headers, URL, console, Promise, Date, Object, Array, Error, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(swSource, sandbox);
  async function request(url, init = {}) {
    let responded;
    const ev = { request: { url, method: init.method || 'GET', mode: init.mode || 'cors' }, respondWith(p) { responded = Promise.resolve(p); } };
    handlers.fetch(ev);
    return responded ? { handled: true, response: await responded } : { handled: false };
  }
  return { api: sandbox.module.exports, handlers, caches, request, self };
}

test('request classification', () => {
  const { api } = loadSw({ fetchImpl: async () => new Response('') });
  for (const f of ['news', 'releases', 'guides', 'digest', 'digest-daily', 'digest-weekly']) {
    assert.equal(api.isDataRequest(`https://raw.githubusercontent.com/0xmortuex/ai-news-tracker/data/${f}.json`, ORIGIN), true, f);
  }
  assert.equal(api.isDataRequest(ORIGIN + '/data/news.json', ORIGIN), true, 'same-origin copy');
  assert.equal(api.isDataRequest('https://raw.githubusercontent.com/someone/else/data/news.json', ORIGIN), false, 'other repos are not cached');
  assert.equal(api.isDataRequest('https://evil.example/news.json', ORIGIN), false);
  assert.equal(api.isDataRequest('https://raw.githubusercontent.com/0xmortuex/ai-news-tracker/data/state.json', ORIGIN), false);
  assert.equal(api.isDataRequest(ORIGIN + '/ai-news-tracker/featured-guides.json', ORIGIN), false, 'featured-guides.json is shell data, not a published feed');
  assert.equal(api.isDataRequest('chrome-extension://x/news.json', ORIGIN), false);
  assert.equal(api.isShellRequest(ORIGIN + '/ai-news-tracker/', ORIGIN, '/ai-news-tracker/'), true);
  assert.equal(api.isShellRequest(ORIGIN + '/ai-news-tracker/index.html', ORIGIN, '/ai-news-tracker/'), true);
  assert.equal(api.isShellRequest(ORIGIN + '/ai-news-tracker/icons/icon-192.png', ORIGIN, '/ai-news-tracker/'), true);
  assert.equal(api.isShellRequest('https://ai-news-cors.mortuexhavoc.workers.dev/?url=x', ORIGIN, '/ai-news-tracker/'), false);
});

test('only complete 200 responses are cacheable; failures never are', () => {
  const { api } = loadSw({ fetchImpl: async () => new Response('') });
  assert.equal(api.isCacheable(new Response('{}', { status: 200 })), true);
  assert.equal(api.isCacheable(new Response('', { status: 404 })), false);
  assert.equal(api.isCacheable(new Response('', { status: 500 })), false);
  assert.equal(api.isCacheable(new Response(null, { status: 304 })), false);
  assert.equal(api.isCacheable({ status: 200, ok: true, type: 'opaque' }), false);
  assert.equal(api.isCacheable(null), false);
});

test('cache names are versioned and old versions are selected for deletion', () => {
  const { api } = loadSw({ fetchImpl: async () => new Response('') });
  assert.match(api.SHELL_CACHE, /-v\d+$/);
  assert.match(api.DATA_CACHE, /-v\d+$/);
  const old = ['ai-news-shell-v0', 'ai-news-data-v0', api.SHELL_CACHE, api.DATA_CACHE, 'someone-elses-cache'];
  assert.deepEqual(api.staleCacheNames(old), ['ai-news-shell-v0', 'ai-news-data-v0']);
  assert.equal(api.offlineHeaders('2026-10-15T10:00:00.000Z')['x-offline-copy'], '2026-10-15T10:00:00.000Z');
});

test('data: live answer is stored; when the network fails the stored copy is served with x-offline-copy', async () => {
  let online = true;
  const sw = loadSw({
    fetchImpl: async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Response('{"schema":"ai-news/1"}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const live = await sw.request(DATA);
  assert.equal(live.handled, true);
  assert.equal(live.response.headers.get('x-offline-copy'), null, 'a live answer is not marked offline');
  assert.equal(await live.response.text(), '{"schema":"ai-news/1"}');
  online = false;
  const off = await sw.request(DATA);
  assert.equal(off.response.status, 200);
  const at = off.response.headers.get('x-offline-copy');
  assert.ok(at && !isNaN(Date.parse(at)), 'offline copy carries the time it was stored');
  assert.equal(await off.response.text(), '{"schema":"ai-news/1"}');
});

test('data: nothing stored yet and the network fails -> the error is raised, not hidden', async () => {
  const sw = loadSw({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(sw.request(DATA), /Failed to fetch/);
});

test('data: failures are never stored and never replace a stored copy', async () => {
  let mode = 'ok';
  const sw = loadSw({
    fetchImpl: async () => {
      if (mode === 'ok') return new Response('{"v":1}', { status: 200 });
      if (mode === '500') return new Response('boom', { status: 500 });
      if (mode === '404') return new Response('nope', { status: 404 });
      throw new Error('x');
    },
  });
  await sw.request(DATA); // store v1
  mode = '500';
  const r500 = await sw.request(DATA); // server error -> the stored copy, flagged
  assert.equal(r500.response.status, 200);
  assert.ok(r500.response.headers.get('x-offline-copy'));
  assert.equal(await r500.response.text(), '{"v":1}');
  mode = '404';
  const r404 = await sw.request(DATA); // 404 = not published: shown as such
  assert.equal(r404.response.status, 404);
  assert.equal(r404.response.headers.get('x-offline-copy'), null);
  const stored = await (await sw.caches.open(sw.api.DATA_CACHE)).match(DATA);
  assert.equal(await stored.text(), '{"v":1}', 'the good copy survived both failures');
  // a failure with nothing stored is returned as-is and nothing is written
  const empty = loadSw({ fetchImpl: async () => new Response('boom', { status: 500 }) });
  const r = await empty.request(DATA);
  assert.equal(r.response.status, 500);
  const bucket = empty.caches.stores.get(empty.api.DATA_CACHE);
  assert.equal(bucket ? bucket.size : 0, 0);
});

test('non-GET and unrelated requests are left to the network', async () => {
  const sw = loadSw({ fetchImpl: async () => new Response('x') });
  assert.equal((await sw.request(DATA, { method: 'POST' })).handled, false);
  assert.equal((await sw.request('https://ai-news-cors.mortuexhavoc.workers.dev/guides/aggregate')).handled, false);
  assert.equal((await sw.request('https://fonts.googleapis.com/css2?family=Fraunces')).handled, false);
});

test('shell: network first, stored copy when offline; activate removes old caches', async () => {
  let online = true;
  const sw = loadSw({
    fetchImpl: async () => {
      if (!online) throw new TypeError('offline');
      return new Response('<html>v2</html>', { status: 200 });
    },
  });
  const url = ORIGIN + '/ai-news-tracker/index.html';
  const a = await sw.request(url);
  assert.equal(await a.response.text(), '<html>v2</html>');
  await new Promise(r => setTimeout(r, 10)); // the shell copy is stored in the background
  online = false;
  const b = await sw.request(url, { mode: 'navigate' });
  assert.equal(await b.response.text(), '<html>v2</html>');
  await sw.caches.open('ai-news-shell-v0');
  await new Promise((resolve, reject) => {
    sw.handlers.activate({ waitUntil: p => p.then(resolve, reject) });
  });
  assert.ok(!sw.caches.stores.has('ai-news-shell-v0'), 'old version deleted');
  assert.ok(sw.caches.stores.has(sw.api.SHELL_CACHE));
});
