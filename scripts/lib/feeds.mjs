// Phase 3 machine feeds built from stories.json: feed.rss (RSS 2.0) and top.json (small,
// for the Vex start page). Pure; the same input gives the same bytes.

import { escapeXml } from './text.mjs';
import { topStories, topEntry } from './stories.mjs';
import { SITE_URL, DATA_URL } from './build.mjs';

export const TOP_SCHEMA = 'ai-news-top/1';
export const TOP_MAX_BYTES = 18000;        // the contract says < 20 KB; keep a margin
export const RSS_LIMIT = 30;
export const RSS_HOURS = 72;

// XML 1.0 forbids most control characters; remove them instead of emitting a broken feed.
function xmlText(s) {
  return escapeXml(String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ''));
}

function rfc822(isoString) {
  const t = Date.parse(isoString);
  return new Date(Number.isFinite(t) ? t : 0).toUTCString();
}

export function buildRss(storiesDoc, { limit = RSS_LIMIT, hours = RSS_HOURS } = {}) {
  const list = topStories(storiesDoc, { hours, limit });
  const base = DATA_URL.replace(/news\.json$/, '');
  const L = [];
  L.push('<?xml version="1.0" encoding="utf-8"?>');
  L.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  L.push('<channel>');
  L.push('  <title>AI News Tracker: top stories</title>');
  L.push(`  <link>${xmlText(SITE_URL)}</link>`);
  L.push('  <description>The highest-scoring AI stories of the last 3 days, one entry per story. Title, link and a short excerpt only.</description>');
  L.push('  <language>en</language>');
  L.push(`  <lastBuildDate>${rfc822(storiesDoc.generatedAt)}</lastBuildDate>`);
  L.push('  <generator>ai-news-tracker/stories-1</generator>');
  L.push(`  <atom:link href="${xmlText(base + 'feed.rss')}" rel="self" type="application/rss+xml"/>`);
  for (const s of list) {
    const who = s.sources.slice(0, 4).map(x => x.source).join(', ');
    const more = s.sourceCount > 4 ? ` and ${s.sourceCount - 4} more` : '';
    const lead = s.sourceCount > 1 ? `${s.sourceCount} sources: ${who}${more}. ` : `${s.source}. `;
    const desc = `${lead}${s.summary || ''}`.trim();
    L.push('  <item>');
    L.push(`    <title>${xmlText(s.title)}</title>`);
    L.push(`    <link>${xmlText(s.url)}</link>`);
    L.push(`    <guid isPermaLink="false">urn:ai-news-tracker:story:${xmlText(s.id)}</guid>`);
    L.push(`    <pubDate>${rfc822(s.publishedAt)}</pubDate>`);
    L.push(`    <description>${xmlText(desc)}</description>`);
    L.push(`    <source url="${xmlText(base + 'feed.rss')}">AI News Tracker</source>`);
    for (const c of [s.kind, ...s.tags, ...s.entities.slice(0, 4)]) if (c) L.push(`    <category>${xmlText(c)}</category>`);
    L.push('  </item>');
  }
  L.push('</channel>');
  L.push('</rss>');
  return L.join('\n') + '\n';
}

// top.json: the top stories of the last 24 h (falls back to 72 h when the day is quiet), trimmed
// from the bottom until the serialised file is under TOP_MAX_BYTES.
export function buildTop(storiesDoc, { limit = 10 } = {}) {
  let list = topStories(storiesDoc, { hours: 24, limit });
  let window = 24;
  if (list.length < 3) { list = topStories(storiesDoc, { hours: 72, limit }); window = 72; }
  const make = items => ({
    schema: TOP_SCHEMA,
    schemaVersion: 1,
    generatedAt: storiesDoc.generatedAt,
    windowHours: window,
    count: items.length,
    site: SITE_URL,
    stories: items.map(s => {
      const e = topEntry(s, 3);
      return { id: e.id, title: e.title, url: e.url, source: e.source, sourceCount: e.sourceCount, score: e.score, tags: e.tags, entities: e.entities, publishedAt: e.publishedAt };
    }),
  });
  let doc = make(list);
  while (list.length > 0 && Buffer.byteLength(JSON.stringify(doc)) > TOP_MAX_BYTES) {
    list = list.slice(0, -1);
    doc = make(list);
  }
  return doc;
}
