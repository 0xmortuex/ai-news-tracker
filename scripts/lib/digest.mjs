// Daily / weekly digests (ai-news-digest/1) built from news.json. Deterministic: the
// period ends at news.generatedAt, items are ranked by baseImportance (then newest, then id),
// nothing reads the clock. English-language items only (the site does not language-filter).

import { topStories, topEntry } from './stories.mjs';

export const DIGEST_SCHEMA = 'ai-news-digest/1';
export const TOP_N = 10;
export const SECTIONS = [
  { id: 'model-release', title: 'Model releases' },
  { id: 'research', title: 'Research' },
  { id: 'open-source', title: 'Open source' },
  { id: 'policy', title: 'Policy and regulation' },
  { id: 'hardware', title: 'Hardware and compute' },
  { id: 'funding', title: 'Funding and deals' },
  { id: 'safety', title: 'Safety and security' },
  { id: 'tools', title: 'Tools and products' },
  { id: 'china', title: 'China' },
];
export const PERIODS = {
  daily: { hours: 24, topN: 5 },
  weekly: { hours: 168, topN: 8 },
};
const SECTION_IDS = new Set(SECTIONS.map(s => s.id));

function sectionOf(item) {
  for (const l of item.labels || []) {
    if (!SECTION_IDS.has(l)) continue;
    // The "research" label also fires on words like "study"; the research section is for papers.
    if (l === 'research' && item.kind !== 'paper' && item.sourceKind !== 'research') continue;
    return l;
  }
  return null;
}

function rankCmp(a, b) {
  const ba = a.baseImportance ?? a.importance;
  const bb = b.baseImportance ?? b.importance;
  if (ba !== bb) return bb - ba;
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

function digestItem(it) {
  return {
    id: it.id,
    title: it.title,
    url: it.url,
    source: it.source,
    sourceId: it.sourceId,
    lang: it.lang,
    publishedAt: it.publishedAt,
    kind: it.kind,
    importance: it.importance,
    baseImportance: it.baseImportance ?? it.importance,
    summary: it.summary,
    alsoIn: (it.alsoIn || []).map(a => ({ source: a.source, url: a.url })),
  };
}

// kind: 'daily' | 'weekly'
// storiesDoc (optional, Phase 3): when given, the digest also carries `top`, the stories of the
// period ordered by story score. Without it the output is byte-identical to Phase 2.
export function buildDigest(news, kind, storiesDoc = null) {
  const cfg = PERIODS[kind];
  if (!cfg) throw new Error(`unknown digest kind ${kind}`);
  const endMs = Date.parse(news.generatedAt);
  const startMs = endMs - cfg.hours * 3600000;
  const inPeriod = news.items.filter(it => {
    if (it.lang !== 'en') return false;
    const t = Date.parse(it.publishedAt);
    return t > startMs && t <= endMs;
  });
  const bySection = new Map(SECTIONS.map(s => [s.id, []]));
  for (const it of inPeriod) {
    const s = sectionOf(it);
    if (s) bySection.get(s).push(it);
  }
  const sections = SECTIONS.map(s => {
    const all = bySection.get(s.id).slice().sort(rankCmp);
    return { id: s.id, title: s.title, count: all.length, items: all.slice(0, cfg.topN).map(digestItem) };
  });
  const used = new Map();
  for (const it of inPeriod) {
    const u = used.get(it.sourceId) || { id: it.sourceId, name: it.source, count: 0 };
    u.count++;
    used.set(it.sourceId, u);
  }
  const kinds = {};
  for (const it of inPeriod) kinds[it.kind] = (kinds[it.kind] || 0) + 1;
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const out = {
    schema: DIGEST_SCHEMA,
    schemaVersion: 1,
    generatedAt: news.generatedAt,
    lang: 'en',
    period: { kind, start: iso(startMs), end: iso(endMs), hours: cfg.hours, topN: cfg.topN },
    total: inPeriod.length,
    kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => (a < b ? -1 : 1))),
    sections,
    sources: [...used.values()].sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1)),
  };
  if (storiesDoc) {
    out.top = topStories(storiesDoc, { hours: cfg.hours, limit: TOP_N }).map(s => topEntry(s));
  }
  return out;
}

export function renderDigestMarkdown(d) {
  const title = d.period.kind === 'daily' ? 'AI News Daily Digest' : 'AI News Weekly Digest';
  const L = [];
  L.push(`# ${title}`);
  L.push('');
  L.push(`Period: ${d.period.start} to ${d.period.end} (UTC). ${d.total} stories from ${d.sources.length} sources. Generated ${d.generatedAt}.`);
  if (Array.isArray(d.top) && d.top.length) {
    L.push('');
    L.push(`## ${d.period.kind === 'daily' ? 'Top today' : 'Top this week'}`);
    L.push('');
    for (const it of d.top) {
      const n = it.sourceCount > 1 ? `, ${it.sourceCount} sources` : '';
      L.push(`- [${it.title.replace(/([\[\]])/g, '\\$1')}](${it.url}) - ${it.source}, score ${it.score}${n}`);
    }
  }
  for (const s of d.sections) {
    if (!s.items.length) continue;
    L.push('');
    L.push(`## ${s.title} (${s.count})`);
    L.push('');
    for (const it of s.items) {
      const more = it.alsoIn.length ? ` +${it.alsoIn.length} more` : '';
      L.push(`- [${it.title.replace(/([\[\]])/g, '\\$1')}](${it.url}) - ${it.source}, importance ${it.baseImportance}${more}`);
    }
  }
  L.push('');
  L.push('## Sources used');
  L.push('');
  L.push(d.sources.map(s => `${s.name} (${s.count})`).join(', ') || 'none');
  L.push('');
  L.push('Titles, links and short excerpts only; see each link for the full story. Data: ai-news-digest/1.');
  return L.join('\n') + '\n';
}
