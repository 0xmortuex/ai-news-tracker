// status.json (ai-news-status/1): recent incidents from the provider status feeds
// (category "status" sources). They are not news, so they never enter news.json.

import { clip } from './text.mjs';

export const STATUS_SCHEMA = 'ai-news-status/1';
const WINDOW_DAYS = 7;
const PER_PROVIDER = 15;

export function buildStatus(pool, sources, nowMs, generatedAt) {
  const status = sources.filter(s => s.category === 'status');
  const cutoff = nowMs - WINDOW_DAYS * 86400000;
  const providers = status.map(src => {
    const incidents = pool
      .filter(p => p.sourceId === src.id)
      .map(p => ({ t: Date.parse(p.publishedAt || p.firstSeenAt), p }))
      .filter(x => Number.isFinite(x.t) && x.t >= cutoff && x.t <= nowMs + 3600000)
      .sort((a, b) => b.t - a.t || (a.p.id < b.p.id ? -1 : 1))
      .slice(0, PER_PROVIDER)
      .map(({ p }) => ({
        id: p.id,
        title: clip(p.title, 200),
        url: p.url,
        publishedAt: p.publishedAt || p.firstSeenAt,
        summary: clip(p.summary || '', 280),
      }));
    return { id: src.id, name: src.name, company: src.company || null, url: src.url.replace(/\/history\.rss$/, ''), incidents };
  });
  return { schema: STATUS_SCHEMA, schemaVersion: 1, generatedAt, windowDays: WINDOW_DAYS, providers };
}
