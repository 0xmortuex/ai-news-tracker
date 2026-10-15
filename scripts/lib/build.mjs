// Pure assembly: pool items + sources + health -> news.json object, Atom and JSON Feed.
// No I/O and no clock reads: `now` is always passed in.

import { tagItem } from './tag.mjs';
import { clusterItems } from './cluster.mjs';
import { scoreItem, isBreaking } from './score.mjs';
import { domainOf } from './normalize.mjs';
import { escapeXml } from './text.mjs';

export const SCHEMA = 'ai-news/1';
export const MAX_ITEMS = 600;
export const MAX_AGE_DAYS = 14;
export const SITE_URL = 'https://0xmortuex.github.io/ai-news-tracker/';
export const DATA_URL = 'https://raw.githubusercontent.com/0xmortuex/ai-news-tracker/data/news.json';

const SIGNAL_SOURCES = /^(techmeme|hn-)/;

function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// pool: [{ id, title, url, canonicalUrl, sourceId, publishedAt, firstSeenAt, summary, engagement, extra }]
// sources: array of config source entries. opts: { now (ms), prevReps:Set, maxItems, maxAgeDays, health:[...] }
export function buildNews(pool, sources, opts) {
  const nowMs = opts.now;
  const maxItems = opts.maxItems ?? MAX_ITEMS;
  const maxAgeMs = (opts.maxAgeDays ?? MAX_AGE_DAYS) * 86400000;
  const byId = new Map(sources.map(s => [s.id, s]));

  const tagged = [];
  for (const p of pool) {
    const src = byId.get(p.sourceId);
    if (!src) continue; // source removed from config
    if (src.category === 'status') continue; // provider status feeds go to status.json, not the news list
    let pubMs = Date.parse(p.publishedAt);
    if (Number.isNaN(pubMs) || pubMs > nowMs + 3600000) pubMs = Date.parse(p.firstSeenAt);
    if (Number.isNaN(pubMs)) pubMs = nowMs;
    if (nowMs - pubMs > maxAgeMs) continue;
    const tags = tagItem(p, src);
    tagged.push({
      ...p,
      publishedAt: iso(pubMs),
      firstSeenAt: p.firstSeenAt || iso(nowMs),
      tier: src.tier,
      src,
      ...tags,
    });
  }

  const clusters = clusterItems(tagged, { prevReps: opts.prevReps });
  const out = [];
  for (const c of clusters) {
    const rep = c.rep;
    const src = rep.src;
    const others = c.members.filter(m => m.id !== rep.id);
    const domains = new Set(c.members.map(m => domainOf(m.canonicalUrl)));
    const clusterHasSignal = c.members.some(m => SIGNAL_SOURCES.test(m.sourceId));
    // Engagement is the best seen across the cluster (HN points of a covering thread count).
    const engagement = Math.max(...c.members.map(m => m.engagement || 0));
    const sc = scoreItem({ ...rep, engagement }, {
      tier: rep.tier, sourceId: rep.sourceId, clusterDomains: domains, clusterHasSignal, nowMs, company: src.company,
      priorKind: src.prior && src.prior.kind,
    });
    const otherDomains = new Set(others.map(m => domainOf(m.canonicalUrl)).filter(d => d && d !== domainOf(rep.canonicalUrl)));
    const breaking = isBreaking({
      kind: rep.kind, base: sc.base, ageHours: sc.ageHours, tier: rep.tier, corroboratingDomains: otherDomains.size,
    });
    // Merge tags across members: companies/models union (rep's order first).
    const companies = [...new Set([...rep.companies, ...others.flatMap(m => m.companies)])].sort();
    const seenModels = new Set();
    const models = [...rep.models, ...others.flatMap(m => m.models)]
      .filter(n => { const k = n.toLowerCase(); if (seenModels.has(k)) return false; seenModels.add(k); return true; })
      .slice(0, 5);
    const item = {
      id: rep.id,
      cluster: c.id,
      title: rep.title,
      url: rep.url,
      canonicalUrl: rep.canonicalUrl,
      source: src.name,
      sourceId: src.id,
      sourceKind: src.sourceKind,
      country: src.country,
      lang: src.lang,
      publishedAt: rep.publishedAt,
      firstSeenAt: rep.firstSeenAt,
      kind: rep.kind,
      importance: sc.importance,
      baseImportance: sc.base,
      companies,
      models,
      topics: rep.topics,
      labels: rep.labels,
      summary: rep.summary,
      alsoIn: others
        .sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.id < b.id ? -1 : 1))
        .map(m => ({ source: m.src.name, sourceId: m.src.id, url: m.url, publishedAt: m.publishedAt })),
      breaking,
      sourceTier: rep.tier,
      thirdParty: !!src.thirdParty,
      engagement,
    };
    out.push(item);
  }

  out.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.id < b.id ? -1 : 1));
  const items = out.slice(0, maxItems);

  return {
    schema: SCHEMA,
    schemaVersion: 1,
    generatedAt: iso(nowMs),
    itemCount: items.length,
    sources: opts.health || [],
    items,
  };
}

// ---- Atom 1.0 --------------------------------------------------------------
export function buildAtom(news, { limit = 100 } = {}) {
  const items = news.items.slice(0, limit);
  const updated = news.generatedAt;
  const parts = [];
  parts.push('<?xml version="1.0" encoding="utf-8"?>');
  parts.push('<feed xmlns="http://www.w3.org/2005/Atom">');
  parts.push('  <title>AI News Tracker</title>');
  parts.push('  <subtitle>Deduplicated, tagged and scored AI news. Title, link and a short excerpt only.</subtitle>');
  parts.push(`  <id>urn:ai-news-tracker:feed</id>`);
  parts.push(`  <link rel="self" type="application/atom+xml" href="${escapeXml(DATA_URL.replace(/news\.json$/, 'feed.atom'))}"/>`);
  parts.push(`  <link rel="alternate" type="text/html" href="${escapeXml(SITE_URL)}"/>`);
  parts.push(`  <updated>${updated}</updated>`);
  parts.push('  <generator>ai-news-tracker/1</generator>');
  for (const it of items) {
    parts.push('  <entry>');
    parts.push(`    <id>urn:ai-news-tracker:${it.id}</id>`);
    parts.push(`    <title>${escapeXml(it.title)}</title>`);
    parts.push(`    <link rel="alternate" href="${escapeXml(it.url)}"/>`);
    parts.push(`    <published>${it.publishedAt}</published>`);
    parts.push(`    <updated>${it.publishedAt}</updated>`);
    parts.push(`    <author><name>${escapeXml(it.source)}</name></author>`);
    if (it.summary) parts.push(`    <summary type="text">${escapeXml(it.summary)}</summary>`);
    for (const t of [it.kind, ...it.topics]) parts.push(`    <category term="${escapeXml(t)}"/>`);
    parts.push('  </entry>');
  }
  parts.push('</feed>');
  return parts.join('\n') + '\n';
}

// ---- JSON Feed 1.1 ---------------------------------------------------------
export function buildJsonFeed(news, { limit = 100 } = {}) {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'AI News Tracker',
    home_page_url: SITE_URL,
    feed_url: DATA_URL.replace(/news\.json$/, 'feed.json'),
    description: 'Deduplicated, tagged and scored AI news. Title, link and a short excerpt only.',
    language: 'en',
    items: news.items.slice(0, limit).map(it => ({
      id: it.id,
      url: it.url,
      title: it.title,
      content_text: it.summary || it.title,
      date_published: it.publishedAt,
      authors: [{ name: it.source }],
      tags: [it.kind, ...it.topics, ...it.companies],
      language: it.lang,
      _ai_news: {
        cluster: it.cluster,
        importance: it.importance,
        breaking: it.breaking,
        kind: it.kind,
        companies: it.companies,
        models: it.models,
        topics: it.topics,
        alsoIn: it.alsoIn,
      },
    })),
  };
}
