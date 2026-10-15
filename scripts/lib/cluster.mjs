// Dedupe and clustering.
//   1. exact: same canonical URL (id) -> one item
//   2. near-duplicate: title token Jaccard / SimHash inside a 72 h window, guarded by
//      model/version tokens so "Gemini 3 Pro" and "Gemini 3 Flash" stay apart
//   3. event key: same model-release of the same model name inside 72 h
// Clusters are connected components (union-find). The representative is stable:
// a previously published representative wins, then lowest tier number, then earliest.

import { BRAND_RE } from './taxonomy.mjs';
import { sha1, titleTokens, keyTokens, simhash, hamming, jaccard, domainOf } from './normalize.mjs';

const WINDOW_MS = 72 * 3600 * 1000;
export const JACCARD_MIN = 0.6;
export const SIMHASH_MAX = 6;
export const SIMHASH_JACCARD_MIN = 0.45;

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb); }
}

// A model name that identifies one release on its own: it has a number, or it is a lab brand
// ("Muse Wonder", "Timestral"). Bare "Gemini" style names are not specific.
function isSpecific(name) { return /\d/.test(name) || BRAND_RE.test(name); }

// Phase 2: brand names count (not only numbered ones), case-insensitively, and a brand family
// name ("Timestral") is the same story as its sized repos ("Timestral-123M").
export function sharesSpecificModel(ma, mb) {
  const A = ma.filter(isSpecific).map(m => m.toLowerCase());
  const B = mb.filter(isSpecific).map(m => m.toLowerCase());
  for (const x of A) {
    for (const y of B) {
      if (x === y) return true;
      const [s, l] = x.length <= y.length ? [x, y] : [y, x];
      if (l.startsWith(`${s}-`) && BRAND_RE.test(s.charAt(0).toUpperCase() + s.slice(1))) return true;
    }
  }
  return false;
}

// Titles about a side aspect of a model ("for Robotics", "in Diffusers", "safety") are their own
// story even when they name the same model.
const ASPECT_RE = /(?<![\p{L}\p{N}])(robotics|robots?|responsibly|safety|pricing|system card|model card|technical report|tutorial|review|diffusers|llama\.cpp|quantized|gguf|vs)(?![\p{L}\p{N}])/iu;
export function aspectOf(title) {
  const m = ASPECT_RE.exec(title);
  return m ? m[1].toLowerCase() : '';
}

// Same-story test for two prepared items.
export function sameStory(a, b) {
  if (a.canonicalUrl === b.canonicalUrl) return true;
  const ta = a._t ? a._ms : Date.parse(a.publishedAt);
  const tb = b._t ? b._ms : Date.parse(b.publishedAt);
  if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) > WINDOW_MS) return false;

  // Event key: same model released (needs a numbered model name to avoid generic merges).
  if (a.kind === 'model-release' && b.kind === 'model-release' && a.models.length && b.models.length) {
    if (aspectOf(a.title) === aspectOf(b.title) && sharesSpecificModel(a.models, b.models)) return true;
  }

  const ka = a._keys; const kb = b._keys;
  if (ka.size && kb.size) {
    // key tokens must be identical sets, otherwise different model/variant
    if (ka.size !== kb.size) return false;
    for (const t of ka) if (!kb.has(t)) return false;
  } else if (ka.size !== kb.size) {
    return false;
  }
  if (a._set.size < 3 || b._set.size < 3) return false;
  const j = jaccard(a._set, b._set);
  if (j >= JACCARD_MIN) return true;
  return j >= SIMHASH_JACCARD_MIN && hamming(a._sim, b._sim) <= SIMHASH_MAX;
}

function prepare(item) {
  const toks = titleTokens(item.title);
  item._tok = toks;
  item._set = new Set(toks);
  item._keys = keyTokens(toks);
  item._sim = simhash(toks);
  item._ms = Date.parse(item.publishedAt);
  item._t = true;
}

// items: tagged items [{id, canonicalUrl, title, publishedAt, firstSeenAt, kind, models, tier, sourceId, ...}]
// opts.prevReps: Set of ids that were published as representatives last run.
// Returns clusters: [{ id, members:[item...], rep:item }] sorted by rep id for determinism.
export function clusterItems(items, opts = {}) {
  const prevReps = opts.prevReps || new Set();
  // 1. exact dedupe by id (keep best tier, then earliest)
  const byId = new Map();
  for (const it of items) {
    const cur = byId.get(it.id);
    if (!cur || better(it, cur, prevReps)) byId.set(it.id, it);
  }
  const uniq = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const it of uniq) prepare(it);

  // 2+3. pairwise within time window (sorted by time, sliding window)
  const order = uniq.map((_, i) => i).sort((i, j) => (uniq[i]._ms || 0) - (uniq[j]._ms || 0) || (uniq[i].id < uniq[j].id ? -1 : 1));
  const uf = new UnionFind(uniq.length);
  for (let x = 0; x < order.length; x++) {
    const i = order[x];
    for (let y = x + 1; y < order.length; y++) {
      const j = order[y];
      if ((uniq[j]._ms || 0) - (uniq[i]._ms || 0) > WINDOW_MS) break;
      if (uf.find(i) === uf.find(j)) continue;
      if (sameStory(uniq[i], uniq[j])) uf.union(i, j);
    }
  }
  const groups = new Map();
  uniq.forEach((it, idx) => {
    const r = uf.find(idx);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  const clusters = [];
  for (const members of groups.values()) {
    members.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : a.id < b.id ? -1 : 1));
    // Cluster id = hash of its earliest-seen member: stable while the cluster only grows.
    const id = `c-${sha1(members[0].id).slice(0, 8)}`;
    let rep = members[0];
    for (const m of members) if (better(m, rep, prevReps)) rep = m;
    clusters.push({ id, members, rep });
  }
  clusters.sort((a, b) => (a.id < b.id ? -1 : 1));
  return clusters;
}

// true when `a` should be preferred over `b` as the representative.
function better(a, b, prevReps) {
  const pa = prevReps.has(a.id); const pb = prevReps.has(b.id);
  if (pa !== pb) return pa;
  if (a.tier !== b.tier) return a.tier < b.tier;
  const ta = Date.parse(a.publishedAt) || 0; const tb = Date.parse(b.publishedAt) || 0;
  if (ta !== tb) return ta < tb;
  const da = domainMatchesCompany(a); const db = domainMatchesCompany(b);
  if (da !== db) return da;
  return a.id < b.id;
}

function domainMatchesCompany(it) {
  const d = domainOf(it.canonicalUrl).replace(/\./g, '');
  return (it.companies || []).some(c => d.includes(c.toLowerCase().replace(/[^a-z0-9]/g, '')));
}
