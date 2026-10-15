import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionalGet, parseRetryAfter, runPerHost, USER_AGENT } from '../scripts/lib/fetch.mjs';

function fakeResponse({ status = 200, body = '', headers = {} } = {}) {
  return new Response(status === 304 ? null : body, { status, headers });
}

test('sends User-Agent and conditional headers; 304 is not-modified', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = init.headers; return fakeResponse({ status: 304 }); };
  const r = await conditionalGet('https://e.org/feed', { etag: '"abc"', lastModified: 'Wed, 14 Oct 2026 10:00:00 GMT' }, { fetchImpl });
  assert.equal(r.kind, 'not-modified');
  assert.equal(seen['If-None-Match'], '"abc"');
  assert.equal(seen['If-Modified-Since'], 'Wed, 14 Oct 2026 10:00:00 GMT');
  assert.equal(seen['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /ai-news-tracker\/1 \(\+https:\/\/github\.com\/0xmortuex\/ai-news-tracker\)/);
});

test('200 returns body and validators for the cache', async () => {
  const fetchImpl = async () => fakeResponse({ body: '<rss/>', headers: { etag: '"v2"', 'last-modified': 'Thu, 15 Oct 2026 08:00:00 GMT' } });
  const r = await conditionalGet('https://e.org/feed', {}, { fetchImpl });
  assert.equal(r.kind, 'ok');
  assert.equal(r.etag, '"v2"');
  assert.equal(r.text, '<rss/>');
});

test('response size cap truncates and flags it', async () => {
  const fetchImpl = async () => fakeResponse({ body: 'x'.repeat(10000) });
  const r = await conditionalGet('https://e.org/feed', {}, { fetchImpl, maxBytes: 1000 });
  assert.equal(r.kind, 'ok');
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 1000);
});

test('HTTP errors and network errors are returned, not thrown; Retry-After parsed', async () => {
  const r429 = await conditionalGet('https://e.org/f', {}, { fetchImpl: async () => fakeResponse({ status: 429, body: 'slow down', headers: { 'retry-after': '120' } }) });
  assert.deepEqual([r429.kind, r429.status, r429.retryAfterSec], ['error', 429, 120]);
  const rNet = await conditionalGet('https://e.org/f', {}, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(rNet.kind, 'error');
  assert.match(rNet.error, /network error: fetch failed/);
  assert.equal(parseRetryAfter('Thu, 15 Oct 2026 12:05:00 GMT', Date.parse('2026-10-15T12:00:00Z')), 300);
  assert.equal(parseRetryAfter('nonsense'), null);
});

test('timeout is reported as a timeout', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
  const r = await conditionalGet('https://e.org/f', {}, { fetchImpl, timeoutMs: 20 });
  assert.equal(r.kind, 'error');
  assert.match(r.error, /timeout after 20 ms/);
});

test('runPerHost: one request at a time per host, gap between them, hosts in parallel', async () => {
  const log = [];
  let active = 0;
  let maxActive = 0;
  const mk = (host, n) => ({ host, run: async () => { active++; maxActive = Math.max(maxActive, active); log.push(`${host}${n}`); await new Promise(r => setTimeout(r, 5)); active--; } });
  const sleeps = [];
  await runPerHost([mk('a', 1), mk('a', 2), mk('a', 3), mk('b', 1)], { concurrency: 4, gapMs: 1000, sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(log.filter(x => x.startsWith('a')), ['a1', 'a2', 'a3']);
  assert.equal(sleeps.length, 2); // between a1-a2 and a2-a3 only
  assert.ok(sleeps.every(ms => ms >= 1000));
  assert.ok(maxActive <= 2);
});
