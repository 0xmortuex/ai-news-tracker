// Normalisation: canonical URLs, ids, title keys, raw feed item -> pool item.

import { createHash } from 'node:crypto';
import { clip } from './text.mjs';

const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|ref_url|igshid|cmpid|campaign|spm|share|source|xtor|s_cid|_hsenc|_hsmi|mkt_tok)$/i;

export function sha1(s) {
  return createHash('sha1').update(String(s)).digest('hex');
}

// Returns a canonical https/http URL string, or null when the URL is unusable.
export function canonicalUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.port === '80' || u.port === '443') u.port = '';
  const keep = [];
  for (const [k, v] of u.searchParams) if (!TRACKING.test(k)) keep.push([k, v]);
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/amp\/?$/i, '/');
  // arXiv: /pdf/2510.12345v2(.pdf) and /abs/2510.12345v1 are the same paper.
  if (u.hostname.endsWith('arxiv.org')) {
    const m = path.match(/^\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?$/i);
    if (m) path = `/abs/${m[1]}`;
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  u.pathname = path;
  return u.toString();
}

export function itemId(canonical) {
  return sha1(canonical).slice(0, 16);
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Title -> comparable token list (lower-case, NFKC, outlet suffix removed,
// version tokens joined: "gpt 5 1" -> "gpt-5.1").
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'its', 'it', 'as', 'at', 'by', 'from', 'new', 'how', 'what', 'this', 'that', 'be', 'has', 'have', 'your', 'you', 'ai']);

export function stripOutletSuffix(title) {
  const m = title.match(/^(.*\S)\s+[-–—|·:]\s+([^-–—|·:]{2,40})$/);
  if (m && m[2].trim().split(/\s+/).length <= 4 && m[1].split(/\s+/).length >= 3) return m[1];
  return title;
}

export function titleTokens(title) {
  let t = stripOutletSuffix(String(title)).normalize('NFKC').toLowerCase();
  t = t.replace(/[‘’']/g, '').replace(/[^\p{L}\p{N}.\-\s]/gu, ' ');
  // "gpt 5 1" / "gpt-5 1" / "gpt 5.1" -> "gpt-5.1"
  t = t.replace(/(^|\s)([a-z]{2,})[\s-](v?\d+)(?:[\s.](\d+))?(?=\s|$)/g, (m, pre, fam, a, b) => `${pre}${fam}-${a}${b ? '.' + b : ''}`);
  t = t.replace(/(?<=\s|^)[.\-]+|[.\-]+(?=\s|$)/g, ' ');
  const toks = t.split(/\s+/).filter(Boolean);
  return toks.filter(x => !STOP.has(x));
}

export function titleKey(title) {
  return titleTokens(title).join(' ');
}

// Tokens that identify a specific model/version; two titles that differ in
// these must not be merged by fuzzy matching ("Gemini 3 Pro" vs "Gemini 3 Flash").
const VARIANT_WORDS = new Set(['pro', 'flash', 'mini', 'nano', 'ultra', 'opus', 'sonnet', 'haiku', 'max', 'lite', 'turbo', 'air', 'plus', 'thinking', 'instruct', 'coder', 'vl', 'omni']);
export function keyTokens(tokens) {
  const out = new Set();
  for (const t of tokens) if (/\d/.test(t) || VARIANT_WORDS.has(t)) out.add(t);
  return out;
}

// ---- 64-bit SimHash as two 32-bit halves ----------------------------------
function fnv32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function simhash(tokens) {
  const v = new Array(64).fill(0);
  for (const tok of tokens) {
    const hi = fnv32(tok, 0x811c9dc5);
    const lo = fnv32(tok, 0x9747b28c);
    for (let b = 0; b < 32; b++) {
      v[b] += (lo >>> b) & 1 ? 1 : -1;
      v[32 + b] += (hi >>> b) & 1 ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b] > 0) lo |= 1 << b;
    if (v[32 + b] > 0) hi |= 1 << b;
  }
  return [hi >>> 0, lo >>> 0];
}

function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

export function hamming(a, b) {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

export function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

// ---- raw feed item -> pool item --------------------------------------------
// Returns null for items without a usable title/link.
export function makePoolItem(raw, source, nowIso) {
  const title0 = String(raw.title || '').replace(/\s+/g, ' ').trim();
  const url = canonicalUrl(raw.link);
  if (!title0 || !url) return null;
  let title = title0;
  if (source.titleTemplate) title = source.titleTemplate.replace('{title}', title0);
  title = clip(title, 300);
  let summary = String(raw.summary || '');
  summary = summary.replace(/^arXiv:\S+\s+Announce Type:\s*[\w-]+\s*(?:Abstract:\s*)?/i, '');
  if (summary.trim().toLowerCase() === title.toLowerCase()) summary = '';
  summary = clip(summary, 280);
  const publishedAt = raw.published || null;
  return {
    id: itemId(url),
    title,
    url: String(raw.link).trim(),
    canonicalUrl: url,
    sourceId: source.id,
    publishedAt,
    firstSeenAt: nowIso,
    summary,
    engagement: Math.max(0, Math.round(raw.engagement || 0)),
    extra: raw.extra && raw.extra.modelId ? { modelId: raw.extra.modelId } : undefined,
  };
}
