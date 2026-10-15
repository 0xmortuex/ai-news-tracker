// guides.json (ai-news-guides/1): learning / guide content from free public sources.
// Replaces the Cloudflare Worker /guides/aggregate route. Parsers are pure; the runner
// (scripts/guides.mjs) does the polite fetching. Only title, link, source, date, a short
// excerpt and a popularity score are kept.

import { canonicalUrl, itemId, domainOf } from './normalize.mjs';
import { parseXmlFeed, parseDate } from './parse.mjs';
import { clip, stripTags } from './text.mjs';

export const GUIDES_SCHEMA = 'ai-news-guides/1';
export const MAX_GUIDES = 150;
export const MAX_AGE_DAYS = 120;
const PER_KIND_CAP = 40;

const GUIDE_RE = /(?<![\p{L}\p{N}])(?:tutorials?|guides?|how[- ]to|how i|walkthrough|cheat ?sheets?|from scratch|step[- ]by[- ]step|learn(?:ing)?|course|explained|beginners?|introduction to|intro to|deep dive|lessons?|best practices|handbook|playbook|roadmap|prompt(?:ing)? (?:tips|techniques|patterns)|workflows?|setup|set up|build(?:ing)? (?:a|an|your|my)|awesome|notebook|cookbook|examples?)(?![\p{L}\p{N}])/iu;

export function isGuideLike(text) { return GUIDE_RE.test(text); }

function latinRatio(s) {
  const letters = String(s).match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  return letters.filter(c => /[A-Za-zÀ-ɏ]/.test(c)).length / letters.length;
}

function num(x) { return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; }

function mk(kind, source, r) {
  return {
    sourceKind: kind,
    source,
    title: String(r.title || '').replace(/\s+/g, ' ').trim(),
    url: String(r.url || '').trim(),
    publishedAt: r.publishedAt || null,
    summary: clip(r.summary || '', 280),
    score: num(r.score),
    ...(r.comments ? { comments: num(r.comments) } : {}),
    ...(r._tags ? { _tags: r._tags } : {}),
  };
}

export function parseHnGuides(text) {
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.hits)) throw new Error('HN Algolia response has no hits array');
  return o.hits.map(h => {
    const title = stripTags(h.title || '');
    const hn = h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : '';
    return mk('hn', 'Hacker News', {
      title, url: h.url || hn, publishedAt: parseDate(h.created_at),
      summary: h.story_text ? stripTags(h.story_text) : `${h.points || 0} points, ${h.num_comments || 0} comments on Hacker News`,
      score: h.points, comments: h.num_comments,
    });
  }).filter(r => r.title && r.url);
}

export function parseRedditGuides(text, sub) {
  return parseXmlFeed(text).map(r => mk('reddit', `r/${sub}`, { title: r.title, url: r.link, publishedAt: r.published, summary: '', score: 0 }))
    .filter(r => r.title && r.url);
}

export function parseDevto(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('dev.to response is not an array');
  return arr.map(a => mk('devto', 'dev.to', {
    title: a.title, url: a.url, publishedAt: parseDate(a.published_at || a.published_timestamp),
    summary: stripTags(a.description || ''), score: a.public_reactions_count, comments: a.comments_count,
    _tags: a.tag_list,
  })).filter(r => r.title && r.url);
}

export function parseGithubRepos(text) {
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.items)) throw new Error('GitHub search response has no items array');
  return o.items.map(r => mk('github', 'GitHub', {
    title: `${r.full_name}${r.description ? `: ${stripTags(r.description)}` : ''}`.slice(0, 300),
    url: r.html_url, publishedAt: parseDate(r.pushed_at || r.updated_at),
    summary: stripTags(r.description || ''), score: r.stargazers_count,
  })).filter(r => r.title && r.url);
}

export function parseYoutube(text, channelName) {
  return parseXmlFeed(text).map(r => mk('youtube', `YouTube: ${channelName}`, {
    title: r.title, url: r.link, publishedAt: r.published, summary: '', score: 0,
  })).filter(r => r.title && r.url);
}

// app.bsky.feed.getAuthorFeed on public.api.bsky.app (no auth). Only posts that link out.
export function parseBlueskyAuthor(text, handle) {
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.feed)) throw new Error('Bluesky response has no feed array');
  const out = [];
  for (const f of o.feed) {
    const p = f.post;
    if (!p || f.reason) continue; // skip reposts
    const ext = p.embed && p.embed.external;
    if (!ext || !ext.uri) continue;
    out.push(mk('bluesky', `Bluesky: @${handle}`, {
      title: ext.title || (p.record && p.record.text) || '', url: ext.uri,
      publishedAt: parseDate(p.record && p.record.createdAt || p.indexedAt),
      summary: ext.description || (p.record && p.record.text) || '', score: p.likeCount, comments: p.replyCount,
    }));
  }
  return out.filter(r => r.title && r.url);
}

// raw: parsed items from every source (already tagged with sourceKind). Returns the published items.
export function buildGuides(raw, nowMs, { max = MAX_GUIDES, maxAgeDays = MAX_AGE_DAYS } = {}) {
  const cutoff = nowMs - maxAgeDays * 86400000;
  const byUrl = new Map();
  for (const r of raw) {
    const canon = canonicalUrl(r.url);
    if (!canon) continue;
    const t = Date.parse(r.publishedAt);
    if (!Number.isFinite(t) || t < cutoff || t > nowMs + 3600000) continue;
    if (latinRatio(r.title) < 0.8) continue;
    // Curated-by-nature sources pass; everything else must look like learning material.
    const curated = r.sourceKind === 'youtube' || r.sourceKind === 'github';
    if (!curated && !isGuideLike(`${r.title} ${(r._tags || []).join(' ')}`)) continue;
    const item = {
      id: itemId(canon),
      title: r.title.slice(0, 300),
      url: r.url,
      source: r.source,
      sourceKind: r.sourceKind,
      publishedAt: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      summary: r.summary || '',
      score: r.score || 0,
      ...(r.comments ? { comments: r.comments } : {}),
      _domain: domainOf(canon),
    };
    const cur = byUrl.get(canon);
    if (!cur || item.score > cur.score) byUrl.set(canon, item);
  }
  const all = [...byUrl.values()].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.id < b.id ? -1 : 1));
  const perKind = new Map();
  const out = [];
  for (const it of all) {
    const n = perKind.get(it.sourceKind) || 0;
    if (n >= PER_KIND_CAP) continue;
    perKind.set(it.sourceKind, n + 1);
    const { _domain, ...clean } = it;
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}
