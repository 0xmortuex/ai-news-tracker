// Importance score 0-100 and the breaking flag. Pure and deterministic:
// everything that varies in time takes `nowMs` explicitly.
//
//   base = clip(0..100, tier + corroboration + keywords + engagement + primary)
//   importance = round(base * (0.4 + 0.6 * 0.5^(ageHours / 48)))
//
// `base` is the undecayed score (exported as `baseImportance` in news.json).

import { domainOf } from './normalize.mjs';
import { LAUNCH_RE, MODEL_NAME_RE, O_SERIES_RE, VERSION_BUMP_RE } from './taxonomy.mjs';

export const TIER_POINTS = { 1: 30, 2: 18, 3: 10, 4: 4 };
export const HALF_LIFE_HOURS = 48;
export const DECAY_FLOOR = 0.4;

const LISTICLE_RE = /(?<![\p{L}\p{N}])(?:how to|best|opinion|review|deal|deals|tips|top \d+|guide to|vs\.?|what is|explained)(?![\p{L}\p{N}])/iu;
const MONEY_RE = /\$\s?(\d+(?:\.\d+)?)\s?(billion|bn|b)(?![a-z])|(\d+(?:\.\d+)?)\s?(?:billion|bn)\s+(?:dollars|usd|\$)/i;
const POLICY_WORD_RE = /(?<![\p{L}\p{N}])(?:regulat\w*|ai act|executive order|legislation|export controls?|lawsuit|ban|bill|rules?)(?![\p{L}\p{N}])/iu;
const REGULATOR_RE = /(?<![\p{L}\p{N}])(?:european commission|eu commission|eu|congress|senate|white house|nist|aisi|cac|ministry|federal|parliament|ftc|doj|fda|commerce department|uk government)(?![\p{L}\p{N}])/iu;

export function ageHours(publishedAt, nowMs) {
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (nowMs - t) / 3600000);
}

export function decayFactor(hours) {
  return DECAY_FLOOR + (1 - DECAY_FLOOR) * Math.pow(0.5, hours / HALF_LIFE_HOURS);
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// item: tagged pool item; ctx: { tier, sourceId, clusterDomains:Set, clusterHasSignal:boolean, nowMs, company, priorKind }
export function scoreItem(item, ctx) {
  const text = `${item.title} ${item.summary || ''}`;
  const parts = {};

  parts.tier = TIER_POINTS[ctx.tier] ?? TIER_POINTS[4];

  const own = domainOf(item.canonicalUrl);
  const other = [...(ctx.clusterDomains || [])].filter(d => d && d !== own);
  parts.corroboration = Math.min(36, 12 * other.length);
  if (ctx.clusterHasSignal) parts.corroboration += 10;

  let kw = 0;
  const launch = LAUNCH_RE.test(text);
  const modelName = MODEL_NAME_RE.test(text) || O_SERIES_RE.test(text);
  // A new repo on a lab's Hugging Face org is a model drop by definition.
  if ((launch && modelName) || ctx.priorKind === 'model-release') kw += 15;
  if (VERSION_BUMP_RE.test(text)) kw += 10;
  const money = text.match(MONEY_RE);
  if (money) {
    const v = parseFloat(money[1] || money[3]);
    if (Number.isFinite(v) && v >= 1) kw += 8;
  }
  if (POLICY_WORD_RE.test(text) && REGULATOR_RE.test(text)) kw += 8;
  if (LISTICLE_RE.test(item.title)) kw -= 10;
  if (/^arxiv/.test(ctx.sourceId || '')) kw -= 15;
  parts.keywords = kw;

  const eng = item.engagement || 0;
  if (ctx.sourceId === 'hf-papers') parts.engagement = Math.min(12, eng / 10);
  else if (/^hn-/.test(ctx.sourceId || '')) parts.engagement = Math.min(15, eng / 40);
  else if (/^reddit/.test(ctx.sourceId || '')) parts.engagement = Math.min(8, eng / 300);
  else parts.engagement = 0;

  // Primary-source boost: the company named in the title owns the domain.
  parts.primary = 0;
  const titleLower = item.title.toLowerCase();
  for (const c of item.companies || []) {
    const slug = c.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (slug && titleLower.replace(/[^a-z0-9 ]/g, '').includes(c.toLowerCase().replace(/[^a-z0-9 ]/g, '')) && own.replace(/\./g, '').includes(slug)) {
      parts.primary = 10;
      break;
    }
  }
  if (!parts.primary && ctx.company && own.replace(/\./g, '').includes(String(ctx.company).toLowerCase().replace(/[^a-z0-9]/g, '')) && ctx.tier === 1) parts.primary = 10;

  const raw = parts.tier + parts.corroboration + parts.keywords + parts.engagement + parts.primary;
  const base = clamp(Math.round(raw), 0, 100);
  const hours = ageHours(item.publishedAt, ctx.nowMs);
  const importance = clamp(Math.round(base * decayFactor(hours)), 0, 100);
  return { base, importance, ageHours: hours, parts };
}

// breaking = fresh + strong + (primary lab OR corroborated) + a kind that matters.
export function isBreaking({ kind, base, ageHours: hours, tier, corroboratingDomains }) {
  if (hours > 6) return false;
  if (base < 70) return false;
  if (!['model-release', 'policy', 'security', 'funding'].includes(kind)) return false;
  return tier === 1 || corroboratingDomains >= 2;
}
