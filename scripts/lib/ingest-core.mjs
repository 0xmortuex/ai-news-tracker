// The ingest run without any file I/O: fetch due sources, parse, filter,
// merge into the pool, update per-source state, build news.json.

import { conditionalGet, runPerHost, DEFAULT_MAX_BYTES } from './fetch.mjs';
import { parseBody } from './parse.mjs';
import { makePoolItem } from './normalize.mjs';
import { passesFilter } from './taxonomy.mjs';
import { buildNews, MAX_AGE_DAYS } from './build.mjs';

export const POOL_CAP = 2000;
const HOST_GAP = { 'rss.arxiv.org': 3000, 'export.arxiv.org': 3000, 'www.reddit.com': 10000 };
const DEFAULT_POLL_MIN = 30;
const DEFAULT_STALE_DAYS = 21;

function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

export function isDue(src, st, nowMs, force) {
  if (force) return true;
  if (st.nextTryAt && nowMs < Date.parse(st.nextTryAt)) return false;
  const every = src.pollEveryMin ?? DEFAULT_POLL_MIN;
  if (st.lastFetchAt && nowMs - Date.parse(st.lastFetchAt) < (every - 5) * 60000) return false;
  return true;
}

function looksLikeHtml(text) {
  return /^\s*(<!doctype html|<html)/i.test(text.slice(0, 200));
}

// Parse + filter + cap one fetched body into pool items.
export function itemsFromBody(src, text, nowIso) {
  if (src.format === 'feed' && looksLikeHtml(text)) throw new Error('response is an HTML page, not a feed');
  const raw = parseBody(src.format, text, src);
  const rawCount = raw.length;
  let kept = [];
  for (const r of raw) {
    const f = passesFilter(src.filter, r.title, r.summary, r.rawSummary);
    if (!f.ok) continue;
    kept.push({ r, score: f.score });
  }
  const t = x => (x.r.published ? Date.parse(x.r.published) : 0);
  if (src.filter === 'arxiv') kept.sort((a, b) => b.score - a.score || t(b) - t(a) || (a.r.link < b.r.link ? -1 : 1));
  else kept.sort((a, b) => t(b) - t(a) || (a.r.link < b.r.link ? -1 : 1));
  kept = kept.slice(0, src.maxItems ?? 40);
  const items = [];
  for (const { r } of kept) {
    const p = makePoolItem(r, src, nowIso);
    if (p) items.push(p);
  }
  return { items, rawCount, filteredCount: kept.length };
}

// state: { sources: { id: {...} }, pool: [...] } (mutated copy is returned)
export async function runIngest({ sources, state, prevNews, now, fetchImpl, force = false, only = null, log = () => {}, sleep, gapMs = 1000 }) {
  const nowMs = now;
  const nowIso = iso(nowMs);
  const st = JSON.parse(JSON.stringify(state || {}));
  st.version = 1;
  st.sources = st.sources || {};
  const pool = new Map((st.pool || []).map(p => [p.id, p]));
  const results = [];

  const active = sources.filter(s => !only || only.includes(s.id));
  const jobs = [];
  for (const src of active) {
    const s = (st.sources[src.id] = st.sources[src.id] || {});
    if (!isDue(src, s, nowMs, force)) {
      results.push({ id: src.id, outcome: 'skipped', reason: s.nextTryAt && nowMs < Date.parse(s.nextTryAt) ? 'backoff' : 'not due' });
      continue;
    }
    let host = '';
    try { host = new URL(src.url).hostname; } catch { /* invalid URL surfaces as a fetch error below */ }
    jobs.push({
      host,
      gapMs: Math.max(HOST_GAP[host] || 0, src.hostGapMs || 0),
      run: async () => {
        s.lastFetchAt = nowIso;
        const r = await conditionalGet(src.url, { etag: s.etag, lastModified: s.lastModified }, {
          fetchImpl, maxBytes: src.maxBytes ?? DEFAULT_MAX_BYTES, nowMs,
        });
        s.httpStatus = r.status || 0;
        if (r.kind === 'not-modified') {
          s.lastOkAt = nowIso; s.consecutiveFailures = 0; s.lastError = null; s.nextTryAt = null;
          results.push({ id: src.id, outcome: 'not-modified', status: r.status });
          return;
        }
        if (r.kind === 'ok') {
          try {
            const { items, rawCount, filteredCount } = itemsFromBody(src, r.text, nowIso);
            if (rawCount === 0 && !r.truncated) throw new Error('feed parsed but contained no items');
            let added = 0;
            for (const it of items) {
              const prev = pool.get(it.id);
              if (prev) {
                pool.set(it.id, { ...it, firstSeenAt: prev.firstSeenAt, publishedAt: it.publishedAt || prev.publishedAt });
              } else {
                pool.set(it.id, it);
                added++;
              }
            }
            s.etag = r.etag || null;
            s.lastModified = r.lastModified || null;
            s.lastOkAt = nowIso; s.consecutiveFailures = 0; s.lastError = null; s.lastErrorAt = s.lastErrorAt || null; s.nextTryAt = null;
            s.lastRawCount = rawCount; s.lastItemCount = items.length;
            for (const it of items) {
              if (it.publishedAt && (!s.newestItemAt || it.publishedAt > s.newestItemAt)) s.newestItemAt = it.publishedAt;
            }
            results.push({ id: src.id, outcome: 'ok', status: r.status, raw: rawCount, filtered: filteredCount, kept: items.length, added, truncated: r.truncated, bytes: r.bytes });
            return;
          } catch (e) {
            r.kind = 'error';
            r.error = `parse error: ${e.message}`;
          }
        }
        // error path
        s.consecutiveFailures = (s.consecutiveFailures || 0) + 1;
        s.lastError = r.error;
        s.lastErrorAt = nowIso;
        const every = Math.max(src.pollEveryMin ?? DEFAULT_POLL_MIN, 30);
        let backoffMin = Math.min(360, every * 2 ** (s.consecutiveFailures - 1));
        if (r.retryAfterSec) backoffMin = Math.min(360, Math.max(backoffMin, Math.ceil(r.retryAfterSec / 60)));
        s.nextTryAt = iso(nowMs + backoffMin * 60000);
        results.push({ id: src.id, outcome: 'error', status: r.status, error: r.error, backoffMin });
      },
    });
  }

  await runPerHost(jobs, { concurrency: 6, gapMs, sleep });

  // Age out + cap the pool.
  const cutoff = nowMs - MAX_AGE_DAYS * 86400000;
  let poolItems = [...pool.values()].filter(p => {
    const t = Date.parse(p.publishedAt || p.firstSeenAt);
    return Number.isNaN(t) || t >= cutoff;
  });
  poolItems.sort((a, b) => ((a.publishedAt || a.firstSeenAt) < (b.publishedAt || b.firstSeenAt) ? 1 : -1) || (a.id < b.id ? -1 : 1));
  poolItems = poolItems.slice(0, POOL_CAP);
  st.pool = poolItems;

  // Newest item per source (for staleness).
  const newest = new Map();
  const counts = new Map();
  for (const p of poolItems) {
    const t = p.publishedAt || p.firstSeenAt;
    if (!newest.has(p.sourceId) || t > newest.get(p.sourceId)) newest.set(p.sourceId, t);
    counts.set(p.sourceId, (counts.get(p.sourceId) || 0) + 1);
  }

  const health = sources.map(src => {
    const s = st.sources[src.id] || {};
    const every = src.pollEveryMin ?? DEFAULT_POLL_MIN;
    const lastNewItem = newest.get(src.id) || s.newestItemAt || null;
    const reasons = [];
    const fetchWindowMs = Math.max(6 * 3600000, 3 * every * 60000);
    if (!s.lastOkAt) reasons.push('never fetched successfully');
    else if (nowMs - Date.parse(s.lastOkAt) > fetchWindowMs) reasons.push('last successful fetch is old');
    if ((s.consecutiveFailures || 0) >= 3) reasons.push(`${s.consecutiveFailures} consecutive failures`);
    // Model-drop and policy sources are legitimately quiet for months.
    const quietByNature = src.format === 'hf-models' || src.category === 'policy' || src.sourceKind === 'newsletter';
    const staleDays = src.staleAfterDays ?? (quietByNature ? 120 : DEFAULT_STALE_DAYS);
    if (lastNewItem && nowMs - Date.parse(lastNewItem) > staleDays * 86400000) reasons.push(`no new item for over ${staleDays} days`);
    let status = 'never';
    if (s.lastFetchAt) status = s.lastError ? 'error' : 'ok';
    return {
      id: src.id,
      name: src.name,
      category: src.category,
      tier: src.tier,
      thirdParty: !!src.thirdParty,
      status,
      stale: reasons.length > 0,
      staleReason: reasons.join('; ') || null,
      lastOk: s.lastOkAt || null,
      lastFetch: s.lastFetchAt || null,
      lastError: s.lastErrorAt || null,
      error: s.lastError || null,
      httpStatus: s.httpStatus ?? null,
      consecutiveFailures: s.consecutiveFailures || 0,
      lastNewItem,
      itemCount: counts.get(src.id) || 0,
    };
  });

  const prevReps = new Set((prevNews && prevNews.items ? prevNews.items : []).map(i => i.id));
  const news = buildNews(poolItems, sources, { now: nowMs, prevReps, health });
  return { news, state: st, health, results };
}
