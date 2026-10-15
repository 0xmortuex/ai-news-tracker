import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildGuides, parseHnGuides, parseRedditGuides, parseDevto, parseGithubRepos, parseYoutube, parseBlueskyAuthor, GUIDES_SCHEMA,
} from '../scripts/lib/guides.mjs';
import { collectGuides } from '../scripts/guides.mjs';
import { validate } from '../scripts/lib/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(path.join(here, '..', 'docs', 'guides.schema.json'), 'utf8'));
const NOW = Date.parse('2026-10-15T12:00:00Z');

const hn = JSON.stringify({ hits: [
  { objectID: '1', title: 'A tutorial on building agents from scratch', url: 'https://example.com/agents', points: 120, num_comments: 40, created_at: '2026-10-10T10:00:00Z' },
  { objectID: '2', title: 'Ask HN: best practices for LLM evals?', url: null, points: 60, num_comments: 22, created_at: '2026-10-12T10:00:00Z', story_text: '<p>How do you <b>evaluate</b>?</p>' },
  { objectID: '3', title: 'Quarterly results are in', url: 'https://example.com/q', points: 500, num_comments: 5, created_at: '2026-10-12T10:00:00Z' },
  { objectID: '4', title: 'An old guide to prompts', url: 'https://example.com/old', points: 90, num_comments: 1, created_at: '2025-01-01T00:00:00Z' },
] });
const devto = JSON.stringify([
  { title: 'Getting started with local LLMs', url: 'https://dev.to/a/local-llms', published_at: '2026-10-13T08:00:00Z', description: 'A <i>beginner</i> walkthrough.', public_reactions_count: 33, comments_count: 4, tag_list: ['ai', 'tutorial'] },
  { title: 'My hot take on AI', url: 'https://dev.to/a/hot-take', published_at: '2026-10-13T08:00:00Z', description: 'opinions', public_reactions_count: 99, comments_count: 0, tag_list: ['ai'] },
]);
const gh = JSON.stringify({ items: [
  { full_name: 'acme/awesome-llm', description: 'Curated LLM resources', html_url: 'https://github.com/acme/awesome-llm', pushed_at: '2026-10-14T00:00:00Z', stargazers_count: 4200 },
] });
const yt = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Let's build GPT from scratch</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><published>2026-10-11T00:00:00+00:00</published></entry></feed>`;
const rss = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>How I run Qwen on 16 GB: a setup guide</title><link rel="alternate" href="https://www.reddit.com/r/LocalLLaMA/comments/x/y/"/><updated>2026-10-14T00:00:00+00:00</updated></entry></feed>`;
const bsky = JSON.stringify({ feed: [
  { post: { embed: { external: { uri: 'https://simonwillison.net/2026/Oct/1/guide', title: 'A guide to tool use', description: 'short' } }, record: { createdAt: '2026-10-14T00:00:00Z', text: 'new post' }, likeCount: 55, replyCount: 2 } },
  { post: { embed: null, record: { createdAt: '2026-10-14T00:00:00Z', text: 'no link' }, likeCount: 1 } },
  { reason: {}, post: { embed: { external: { uri: 'https://x.example/repost', title: 'repost' } }, record: { createdAt: '2026-10-14T00:00:00Z' } } },
] });

test('parsers return normalised items per source kind', () => {
  assert.equal(parseHnGuides(hn).length, 4);
  assert.equal(parseHnGuides(hn)[1].url, 'https://news.ycombinator.com/item?id=2');
  assert.equal(parseDevto(devto)[0].score, 33);
  assert.equal(parseGithubRepos(gh)[0].score, 4200);
  assert.equal(parseYoutube(yt, 'Karpathy')[0].source, 'YouTube: Karpathy');
  assert.equal(parseRedditGuides(rss, 'LocalLLaMA')[0].source, 'r/LocalLLaMA');
  const b = parseBlueskyAuthor(bsky, 'simonwillison.net');
  assert.equal(b.length, 1);
  assert.equal(b[0].score, 55);
});

test('buildGuides: guide-like only, recent only, deduped, valid, source labels match the site filter', () => {
  const raw = [
    ...parseHnGuides(hn), ...parseDevto(devto), ...parseGithubRepos(gh), ...parseYoutube(yt, 'Karpathy'),
    ...parseRedditGuides(rss, 'LocalLLaMA'), ...parseBlueskyAuthor(bsky, 'simonwillison.net'),
    ...parseHnGuides(hn), // duplicates collapse
  ];
  const items = buildGuides(raw, NOW);
  const titles = items.map(i => i.title);
  assert.ok(titles.includes('A tutorial on building agents from scratch'));
  assert.ok(!titles.includes('Quarterly results are in')); // not guide-like
  assert.ok(!titles.includes('My hot take on AI'));
  assert.ok(!titles.includes('An old guide to prompts')); // older than 120 days
  assert.equal(new Set(items.map(i => i.url)).size, items.length);
  const dates = items.map(i => i.publishedAt);
  assert.deepEqual(dates, [...dates].sort().reverse());
  const out = { schema: GUIDES_SCHEMA, schemaVersion: 1, generatedAt: '2026-10-15T12:00:00Z', count: items.length, items };
  assert.deepEqual(validate(out, schema), []);
  // The site buckets by the start of `source`: r/..., Hacker News, dev.to, GitHub, YouTube..., Bluesky...
  assert.ok(items.some(i => i.source === 'Hacker News'));
  assert.ok(items.some(i => i.source === 'dev.to'));
  assert.ok(items.some(i => i.source === 'GitHub'));
  assert.ok(items.some(i => /^YouTube/.test(i.source)));
  assert.ok(items.some(i => /^r\//.test(i.source)));
  assert.ok(items.some(i => /^Bluesky/.test(i.source)));
});

test('buildGuides caps at 150 and per source kind', () => {
  const raw = Array.from({ length: 300 }, (_, i) => ({
    sourceKind: 'hn', source: 'Hacker News', title: `A tutorial number ${i} about agents`, url: `https://example.com/${i}`,
    publishedAt: new Date(NOW - i * 3600000).toISOString(), summary: '', score: i,
  }));
  assert.equal(buildGuides(raw, NOW).length, 40);
});

test('collectGuides: one request per source, failures are reported, nothing throws', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers['User-Agent'] });
    if (url.includes('dev.to')) return new Response('nope', { status: 429 });
    if (url.includes('hn.algolia')) return new Response(hn, { status: 200 });
    return new Response('not json at all', { status: 200 });
  };
  const sources = [
    { id: 'hn-a', name: 'HN A', type: 'hn', url: 'https://hn.algolia.com/api/v1/search?x=1&n={since_ts}' },
    { id: 'devto-a', name: 'dev.to', type: 'devto', url: 'https://dev.to/api/articles?tag=ai' },
    { id: 'gh-a', name: 'gh', type: 'github', url: 'https://api.github.com/search/repositories?q=x' },
  ];
  const { raw, report } = await collectGuides({ sources, now: NOW, fetchImpl, sleep: async () => {} });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => /^ai-news-tracker\/1/.test(c.ua)));
  assert.ok(!calls[0].url.includes('{since_ts}'));
  assert.equal(raw.length, 4);
  assert.deepEqual(report.map(r => `${r.id}:${r.status}`), ['devto-a:error', 'gh-a:error', 'hn-a:ok']);
  assert.match(report.find(r => r.id === 'gh-a').error, /parse error/);
});
