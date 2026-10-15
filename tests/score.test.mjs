import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreItem, isBreaking, decayFactor, ageHours, DECAY_FLOOR } from '../scripts/lib/score.mjs';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const base = {
  title: 'Introducing GPT-6', summary: '', canonicalUrl: 'https://openai.com/index/gpt-6', publishedAt: '2026-10-15T12:00:00Z',
  companies: ['OpenAI'], engagement: 0,
};
const ctx = { tier: 1, sourceId: 'openai', clusterDomains: new Set(['openai.com']), clusterHasSignal: false, nowMs: NOW, company: 'OpenAI' };

test('score is deterministic', () => {
  assert.deepEqual(scoreItem(base, ctx), scoreItem(base, ctx));
});

test('tier 1 primary-source model launch scores high; tier 4 low', () => {
  const hi = scoreItem(base, ctx);
  assert.ok(hi.base >= 60, `base ${hi.base}`);
  const lo = scoreItem({ ...base, title: 'Some blog post' }, { ...ctx, tier: 4, company: null });
  assert.ok(lo.base < 10, `base ${lo.base}`);
});

test('corroboration: +12 per extra distinct domain, capped at 36, +10 for HN/Techmeme signal', () => {
  const none = scoreItem(base, ctx).parts.corroboration;
  const two = scoreItem(base, { ...ctx, clusterDomains: new Set(['openai.com', 'a.com', 'b.com']) }).parts.corroboration;
  const many = scoreItem(base, { ...ctx, clusterDomains: new Set(['openai.com', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com']) }).parts.corroboration;
  const sig = scoreItem(base, { ...ctx, clusterHasSignal: true }).parts.corroboration;
  assert.equal(none, 0);
  assert.equal(two, 24);
  assert.equal(many, 36);
  assert.equal(sig, 10);
});

test('keyword rules: launch+model, version bump, money, policy, listicle, arXiv penalty', () => {
  const k = t => scoreItem({ ...base, title: t }, { ...ctx, company: null }).parts.keywords;
  assert.equal(k('Meta launches Llama 5'), 25); // launch+model 15, version bump 10
  assert.equal(k('Startup raises $2 billion'), 8);
  assert.equal(k('EU Commission proposes new AI regulation'), 8);
  assert.equal(k('Best AI tools: how to pick one'), -10);
  const ax = scoreItem({ ...base, title: 'A paper' }, { ...ctx, sourceId: 'arxiv-cs-ai', tier: 3 });
  assert.equal(ax.parts.keywords, -15);
});

test('model-drop prior (HF org repo) counts as launch+model', () => {
  const a = scoreItem({ ...base, title: 'Qwen/Qwen3-8B on Hugging Face' }, { ...ctx, company: null, priorKind: 'model-release' });
  const b = scoreItem({ ...base, title: 'Qwen/Qwen3-8B on Hugging Face' }, { ...ctx, company: null });
  assert.equal(a.parts.keywords - b.parts.keywords, 15);
});

test('engagement: HN points, HF papers upvotes', () => {
  assert.equal(scoreItem({ ...base, engagement: 400 }, { ...ctx, sourceId: 'hn-llm', tier: 2 }).parts.engagement, 10);
  assert.equal(scoreItem({ ...base, engagement: 1000 }, { ...ctx, sourceId: 'hn-llm', tier: 2 }).parts.engagement, 15);
  assert.equal(scoreItem({ ...base, engagement: 50 }, { ...ctx, sourceId: 'hf-papers', tier: 1 }).parts.engagement, 5);
});

test('recency decay: half-life 48 h towards a floor; base is undecayed', () => {
  assert.equal(decayFactor(0), 1);
  assert.ok(Math.abs(decayFactor(48) - (DECAY_FLOOR + (1 - DECAY_FLOOR) / 2)) < 1e-9);
  assert.ok(decayFactor(100000) >= DECAY_FLOOR);
  const old = scoreItem({ ...base, publishedAt: '2026-10-11T12:00:00Z' }, ctx);
  const fresh = scoreItem(base, ctx);
  assert.equal(old.base, fresh.base);
  assert.ok(old.importance < fresh.importance);
  assert.equal(ageHours('2026-10-15T00:00:00Z', NOW), 12);
});

test('score is clipped to 0..100', () => {
  const s = scoreItem({ ...base, title: 'OpenAI launches GPT-6 for $5 billion', engagement: 99999 }, {
    ...ctx, clusterDomains: new Set(['openai.com', 'a.com', 'b.com', 'c.com', 'd.com']), clusterHasSignal: true,
  });
  assert.ok(s.base <= 100 && s.importance <= 100 && s.importance >= 0);
});

test('breaking: fresh, strong, meaningful kind, primary or corroborated', () => {
  const ok = { kind: 'model-release', base: 80, ageHours: 1, tier: 1, corroboratingDomains: 0 };
  assert.equal(isBreaking(ok), true);
  assert.equal(isBreaking({ ...ok, ageHours: 7 }), false);
  assert.equal(isBreaking({ ...ok, base: 69 }), false);
  assert.equal(isBreaking({ ...ok, kind: 'paper' }), false);
  assert.equal(isBreaking({ ...ok, tier: 2 }), false);
  assert.equal(isBreaking({ ...ok, tier: 2, corroboratingDomains: 2 }), true);
});
