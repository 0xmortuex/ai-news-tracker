// Polite HTTP: conditional GET (ETag / If-Modified-Since), hard timeout, hard
// response-size cap, no retries (one attempt per source per run), Retry-After
// reported to the caller so it can back off. Never throws for network or HTTP
// problems: it returns { kind: 'error', error } so the run can record the
// failure in the per-source health block (nothing is swallowed silently).

export const USER_AGENT = 'ai-news-tracker/1 (+https://github.com/0xmortuex/ai-news-tracker)';
export const TIMEOUT_MS = 15000;
export const DEFAULT_MAX_BYTES = 3000000;

const ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.8, application/json;q=0.8, */*;q=0.5';

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.min(Number(s), 86400);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.min(Math.round((t - nowMs) / 1000), 86400));
}

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const over = total - maxBytes;
      chunks.push(value.subarray(0, value.byteLength - over));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return { text: buf.toString('utf8'), truncated, bytes: Math.min(total, maxBytes) };
}

// cache: { etag?, lastModified? } from the previous successful fetch of this URL.
export async function conditionalGet(url, cache = {}, opts = {}) {
  // An explicit, referenced timer (not AbortSignal.timeout, whose timer is unref'd and lets Node 22 exit
  // the event loop while a request is still pending). It covers the body read too, as before.
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
  try {
    return await conditionalGetInner(url, cache, opts, ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function conditionalGetInner(url, cache, opts, signal) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const headers = { 'User-Agent': opts.userAgent || USER_AGENT, Accept: ACCEPT };
  if (cache.etag) headers['If-None-Match'] = cache.etag;
  if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;

  let res;
  try {
    res = await fetchImpl(url, { headers, redirect: 'follow', signal });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const cause = e && e.cause && e.cause.code ? ` (${e.cause.code})` : '';
    return { kind: 'error', status: 0, error: timedOut ? `timeout after ${timeoutMs} ms` : `network error: ${e.message}${cause}` };
  }

  const status = res.status;
  const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'), opts.nowMs);
  if (status === 304) {
    return { kind: 'not-modified', status, etag: cache.etag || null, lastModified: cache.lastModified || null };
  }
  if (status < 200 || status >= 300) {
    try { await res.body?.cancel(); } catch { /* body already closed */ }
    return { kind: 'error', status, error: `HTTP ${status}`, retryAfterSec };
  }
  let body;
  try {
    body = await readCapped(res, maxBytes);
  } catch (e) {
    return { kind: 'error', status, error: `body read failed: ${e.message}` };
  }
  return {
    kind: 'ok',
    status,
    text: body.text,
    bytes: body.bytes,
    truncated: body.truncated,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    contentType: res.headers.get('content-type') || '',
  };
}

// Run async jobs grouped by host: one request at a time per host with a minimum
// gap between requests, hosts in parallel up to `concurrency`.
export async function runPerHost(jobs, { concurrency = 6, gapMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const groups = new Map();
  for (const job of jobs) {
    if (!groups.has(job.host)) groups.set(job.host, []);
    groups.get(job.host).push(job);
  }
  const queue = [...groups.values()];
  async function worker() {
    while (queue.length) {
      const group = queue.shift();
      for (let i = 0; i < group.length; i++) {
        await group[i].run();
        if (i < group.length - 1) await sleep(Math.max(gapMs, ...group.map(j => j.gapMs || 0)));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
