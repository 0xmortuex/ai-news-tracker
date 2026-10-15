// Phase 3 story layer: stories.json (ai-news-stories/1), entities.json (ai-news-entities/1)
// and the "Top today" ranking. Pure and deterministic: input is a built news.json object,
// `now` is news.generatedAt, nothing reads the clock or the network.
//
// A news.json item is already one cluster (same canonical URL / near-identical title / same model
// release, see cluster.mjs). A STORY is one level above: clusters that cover the same event from
// a different angle are merged when they share an entity, sit inside a 48 h window and their titles
// are similar enough. The thresholds are deliberately conservative: two stories wrongly merged hide
// one headline, two wrongly split only show the same event twice.

import { sha1, titleTokens, keyTokens, jaccard } from './normalize.mjs';
import { aspectOf, sharesSpecificModel } from './cluster.mjs';
import { entitiesFor, tagsFor, TAGS } from './entities.mjs';

export const STORIES_SCHEMA = 'ai-news-stories/1';
export const ENTITIES_SCHEMA = 'ai-news-entities/1';
export const MERGE_WINDOW_MS = 48 * 3600 * 1000;
export const TREND_DAYS = 7;

// ---- importance score 0-100 -------------------------------------------------
export const SOURCE_POINTS = { 1: 20, 2: 12, 3: 6, 4: 2 };            // best source tier in the story
export const TAG_POINTS = { release: 15, pricing: 10, safety: 10, policy: 8, research: 3, tooling: 3 };
export const SOURCES_STEP = 10;                                          // per extra distinct source
export const SOURCES_CAP = 30;
export const TAGS_CAP = 25;
export const RECENCY_FLOOR = 0.3;
export const RECENCY_HALF_LIFE_H = 24;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ms = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
// Drop undefined values so the object validates the same before and after JSON serialisation.
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---- merging clusters into stories ------------------------------------------
function prepare(it) {
  const toks = titleTokens(it.title);
  const ents = entitiesFor(it);
  return {
    it,
    id: it.id,
    t: ms(it.publishedAt) ?? 0,
    set: new Set(toks),
    keys: keyTokens(toks),
    companies: new Set(ents.filter(e => e.type === 'company').map(e => e.name.toLowerCase())),
    models: ents.filter(e => e.type === 'model').map(e => e.name),
    products: new Set(ents.filter(e => e.type === 'product').map(e => e.name.toLowerCase())),
  };
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// Same-story test for two prepared items. Exported for the unit tests.
export function sameEvent(a, b) {
  if (a.it.lang !== b.it.lang) return false;
  if (Math.abs(a.t - b.t) > MERGE_WINDOW_MS) return false;
  if (a.set.size < 3 || b.set.size < 3) return false;
  if (aspectOf(a.it.title) !== aspectOf(b.it.title)) return false;
  // Different version / variant tokens = different release ("Gemini 3 Pro" vs "Gemini 3 Flash").
  if (a.keys.size && b.keys.size) {
    if (a.keys.size !== b.keys.size) return false;
    for (const t of a.keys) if (!b.keys.has(t)) return false;
  } else if (a.keys.size !== b.keys.size) {
    return false;
  }
  const j = jaccard(a.set, b.set);
  const sharedModel = a.models.length && b.models.length && sharesSpecificModel(a.models, b.models);
  const sharedProduct = intersects(a.products, b.products);
  const sharedCompany = intersects(a.companies, b.companies);
  if (sharedModel || sharedProduct) return j >= 0.25;
  if (sharedCompany) {
    const sameKind = a.it.kind === b.it.kind && a.it.kind !== 'other';
    return j >= (sameKind ? 0.4 : 0.5);
  }
  return false;
}

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb); }
}

export function groupItems(items) {
  const prepared = items.map(prepare).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const uf = new UnionFind(prepared.length);
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      if (prepared[j].t - prepared[i].t > MERGE_WINDOW_MS) break;
      if (uf.find(i) === uf.find(j)) continue;
      if (sameEvent(prepared[i], prepared[j])) uf.union(i, j);
    }
  }
  const groups = new Map();
  prepared.forEach((p, idx) => {
    const r = uf.find(idx);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p.it);
  });
  return [...groups.values()];
}

// ---- score ------------------------------------------------------------------
export function scoreStory({ sourceCount, bestTier, tags, signal, engagement, lastPublishedMs, nowMs }) {
  const parts = {
    sources: clamp(SOURCES_STEP * (sourceCount - 1), 0, SOURCES_CAP),
    weight: SOURCE_POINTS[bestTier] ?? SOURCE_POINTS[4],
    tags: Math.min(TAGS_CAP, tags.reduce((s, t) => s + (TAG_POINTS[t] || 0), 0)),
    signal: clamp(Math.round(0.2 * (signal || 0)), 0, 20),
    engagement: clamp(Math.round((engagement || 0) / 60), 0, 5),
  };
  const raw = clamp(parts.sources + parts.weight + parts.tags + parts.signal + parts.engagement, 0, 100);
  const ageH = Math.max(0, (nowMs - lastPublishedMs) / 3600000);
  const factor = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.pow(0.5, ageH / RECENCY_HALF_LIFE_H);
  parts.recency = Math.round(factor * 100) / 100;
  return { score: clamp(Math.round(raw * factor), 0, 100), baseScore: raw, parts };
}

// ---- stories ----------------------------------------------------------------
function primaryCmp(a, b) {
  const ta = a.sourceTier ?? 4; const tb = b.sourceTier ?? 4;
  if (ta !== tb) return ta - tb;
  const ia = a.baseImportance ?? a.importance ?? 0; const ib = b.baseImportance ?? b.importance ?? 0;
  if (ia !== ib) return ib - ia;
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export function buildStory(group, nowMs) {
  const members = group.slice().sort(primaryCmp);
  const primary = members[0];
  const byTime = group.slice().sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.id < b.id ? -1 : 1));

  // Distinct sources across every member and every folded duplicate.
  const sources = new Map();
  const addSource = (name, sourceId, url, publishedAt) => {
    const key = sourceId || name;
    if (!key || sources.has(key)) return;
    sources.set(key, compact({ source: name, sourceId: sourceId || undefined, url, publishedAt: publishedAt || undefined }));
  };
  addSource(primary.source, primary.sourceId, primary.url, primary.publishedAt);
  for (const m of members) {
    addSource(m.source, m.sourceId, m.url, m.publishedAt);
    for (const a of m.alsoIn || []) addSource(a.source, a.sourceId, a.url, a.publishedAt);
  }
  const srcList = [...sources.values()].sort((a, b) =>
    (a.publishedAt || '') < (b.publishedAt || '') ? -1 : (a.publishedAt || '') > (b.publishedAt || '') ? 1 : (a.source < b.source ? -1 : 1));

  let firstPub = Infinity; let lastPub = -Infinity; let firstSeen = Infinity;
  for (const m of group) {
    const p = ms(m.publishedAt); if (p !== null) { firstPub = Math.min(firstPub, p); lastPub = Math.max(lastPub, p); }
    const f = ms(m.firstSeenAt); if (f !== null) firstSeen = Math.min(firstSeen, f);
    for (const a of m.alsoIn || []) {
      const q = ms(a.publishedAt); if (q !== null) { firstPub = Math.min(firstPub, q); lastPub = Math.max(lastPub, q); }
    }
  }
  if (!Number.isFinite(firstPub)) { firstPub = nowMs; lastPub = nowMs; }
  if (!Number.isFinite(firstSeen)) firstSeen = firstPub;

  const typed = new Map();
  const tags = new Set();
  const topics = new Set();
  for (const m of members) {
    for (const e of entitiesFor(m)) {
      const k = `${e.type}:${e.name.toLowerCase()}`;
      if (!typed.has(k)) typed.set(k, e);
    }
    for (const t of tagsFor(m)) tags.add(t);
    for (const t of m.topics || []) topics.add(t);
  }
  const ents = [...typed.values()];
  const names = [];
  const seenName = new Set();
  for (const e of ents) { const k = e.name.toLowerCase(); if (!seenName.has(k)) { seenName.add(k); names.push(e.name); } }
  const tagList = TAGS.filter(t => tags.has(t));
  const bestTier = Math.min(...group.map(m => m.sourceTier ?? 4));
  const signal = Math.max(...group.map(m => m.baseImportance ?? m.importance ?? 0));
  const engagement = Math.max(0, ...group.map(m => m.engagement || 0));
  const sc = scoreStory({ sourceCount: srcList.length, bestTier, tags: tagList, signal, engagement, lastPublishedMs: lastPub, nowMs });

  return compact({
    id: `s-${sha1(byTime[0].id).slice(0, 8)}`,
    title: primary.title,
    url: primary.url,
    source: primary.source,
    sourceId: primary.sourceId,
    lang: primary.lang,
    country: primary.country,
    kind: primary.kind,
    summary: primary.summary || '',
    publishedAt: primary.publishedAt,
    firstPublishedAt: iso(firstPub),
    lastPublishedAt: iso(lastPub),
    firstSeenAt: iso(firstSeen),
    sourceCount: srcList.length,
    sources: srcList.slice(0, 12),
    itemIds: byTime.map(m => m.id).slice(0, 20),
    clusters: byTime.map(m => m.cluster).filter(Boolean).slice(0, 20),
    companies: ents.filter(e => e.type === 'company').map(e => e.name).slice(0, 8),
    models: ents.filter(e => e.type === 'model').map(e => e.name).slice(0, 5),
    products: ents.filter(e => e.type === 'product').map(e => e.name).slice(0, 5),
    entities: names.slice(0, 16),
    tags: tagList,
    topics: [...topics].sort(),
    score: sc.score,
    baseScore: sc.baseScore,
    scoreParts: sc.parts,
    breaking: group.some(m => m.breaking),
    thirdParty: !!primary.thirdParty,
  });
}

// news: a parsed news.json object. Items from older files (no entities/tags) are fine.
export function buildStories(news) {
  const nowMs = ms(news.generatedAt);
  if (nowMs === null) throw new Error('news.generatedAt is not a date');
  const groups = groupItems(news.items);
  const stories = groups.map(g => buildStory(g, nowMs));
  stories.sort((a, b) => (a.lastPublishedAt < b.lastPublishedAt ? 1 : a.lastPublishedAt > b.lastPublishedAt ? -1 : a.id < b.id ? -1 : 1));
  return {
    schema: STORIES_SCHEMA,
    schemaVersion: 1,
    generatedAt: news.generatedAt,
    itemCount: news.items.length,
    count: stories.length,
    merged: news.items.length - stories.length,
    stories,
  };
}

// ---- ranking -----------------------------------------------------------------
export function rankStories(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.sourceCount !== b.sourceCount) return b.sourceCount - a.sourceCount;
  if (a.lastPublishedAt !== b.lastPublishedAt) return a.lastPublishedAt < b.lastPublishedAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

// Stories updated inside the last `hours` hours, English only by default, best first.
export function topStories(storiesDoc, { hours = 24, limit = 10, lang = 'en' } = {}) {
  const end = ms(storiesDoc.generatedAt);
  const start = end - hours * 3600000;
  return storiesDoc.stories
    .filter(s => (!lang || s.lang === lang))
    .filter(s => { const t = ms(s.lastPublishedAt); return t !== null && t > start && t <= end + 3600000; })
    .sort(rankStories)
    .slice(0, limit);
}

// Compact form used by the digest and top.json.
export function topEntry(s, entityLimit = 6) {
  return {
    id: s.id,
    title: s.title,
    url: s.url,
    source: s.source,
    sourceCount: s.sourceCount,
    score: s.score,
    kind: s.kind,
    tags: s.tags,
    entities: s.entities.slice(0, entityLimit),
    publishedAt: s.publishedAt,
    firstSeenAt: s.firstPublishedAt,
  };
}

// ---- entities index ----------------------------------------------------------
function dayKeys(nowMs, days) {
  const base = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

export function buildEntities(storiesDoc, { limit = 200 } = {}) {
  const nowMs = ms(storiesDoc.generatedAt);
  const days = dayKeys(nowMs, TREND_DAYS);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const ents = new Map();
  const tagMap = new Map(TAGS.map(t => [t, new Array(TREND_DAYS).fill(0)]));
  for (const s of storiesDoc.stories) {
    const di = dayIndex.get(String(s.firstPublishedAt).slice(0, 10));
    if (di === undefined) continue;
    const typed = new Map();
    for (const c of s.companies) typed.set(c.toLowerCase(), { name: c, type: 'company' });
    for (const m of s.models) if (!typed.has(m.toLowerCase())) typed.set(m.toLowerCase(), { name: m, type: 'model' });
    for (const p of s.products) if (!typed.has(p.toLowerCase())) typed.set(p.toLowerCase(), { name: p, type: 'product' });
    for (const e of typed.values()) {
      const key = `${e.type}:${e.name.toLowerCase()}`;
      let rec = ents.get(key);
      if (!rec) { rec = { name: e.name, type: e.type, trend: new Array(TREND_DAYS).fill(0), tags: new Map(), lastSeenAt: '' }; ents.set(key, rec); }
      rec.trend[di]++;
      if (s.lastPublishedAt > rec.lastSeenAt) rec.lastSeenAt = s.lastPublishedAt;
      for (const t of s.tags) rec.tags.set(t, (rec.tags.get(t) || 0) + 1);
    }
    for (const t of s.tags) tagMap.get(t)[di]++;
  }
  const sum = a => a.reduce((x, y) => x + y, 0);
  const entities = [...ents.values()].map(r => {
    const count = sum(r.trend);
    const today = r.trend[TREND_DAYS - 1];
    const prevAvg = Math.round((sum(r.trend.slice(0, TREND_DAYS - 1)) / (TREND_DAYS - 1)) * 10) / 10;
    return {
      name: r.name,
      type: r.type,
      count,
      trend: r.trend,
      today,
      prevAvg,
      rising: today >= 2 && today > prevAvg * 1.5,
      lastSeenAt: r.lastSeenAt,
      topTags: [...r.tags.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([t]) => t),
    };
  }).sort((a, b) => b.count - a.count || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.type < b.type ? -1 : 1))
    .slice(0, limit);
  const tags = TAGS.map(t => ({ tag: t, count: sum(tagMap.get(t)), trend: tagMap.get(t) }));
  return {
    schema: ENTITIES_SCHEMA,
    schemaVersion: 1,
    generatedAt: storiesDoc.generatedAt,
    windowDays: TREND_DAYS,
    days,
    entities,
    tags,
  };
}
