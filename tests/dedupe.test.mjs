import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, itemId, titleTokens, titleKey, simhash, hamming, jaccard } from '../scripts/lib/normalize.mjs';
import { clusterItems } from '../scripts/lib/cluster.mjs';

test('canonicalUrl strips tracking, fragments, www, trailing slash, AMP, http', () => {
  assert.equal(
    canonicalUrl('http://www.Example.com/post/?utm_source=x&b=2&a=1&fbclid=zz#frag'),
    'https://example.com/post?a=1&b=2',
  );
  assert.equal(canonicalUrl('https://example.com/a/amp/'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://arxiv.org/pdf/2610.18881v2.pdf'), 'https://arxiv.org/abs/2610.18881');
  assert.equal(canonicalUrl('https://arxiv.org/abs/2610.18881v1'), canonicalUrl('https://arxiv.org/pdf/2610.18881v3'));
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl('https://u:p@example.com/'), null);
  assert.equal(canonicalUrl(''), null);
});

test('itemId is stable and 16 hex chars', () => {
  const id = itemId('https://example.com/a');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, itemId('https://example.com/a'));
});

test('title normalisation: outlet suffix, punctuation, version tokens', () => {
  assert.deepEqual(titleTokens('OpenAI unveils GPT 5 1 - The Verge'), ['openai', 'unveils', 'gpt-5.1']);
  assert.equal(titleKey('OpenAI unveils GPT-5.1 | TechCrunch'), titleKey('OpenAI unveils GPT 5.1'));
});

test('simhash: identical tokens -> distance 0; unrelated -> large', () => {
  const a = simhash(titleTokens('Google releases Gemini 4 Argon for everyone'));
  const b = simhash(titleTokens('Google releases Gemini 4 Argon for everyone'));
  const c = simhash(titleTokens('Quarterly revenue rises at a cloud storage company'));
  assert.equal(hamming(a, b), 0);
  assert.ok(hamming(a, c) > 12);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
});

function item(id, title, over = {}) {
  return {
    id, canonicalUrl: `https://${over.domain || 'site' + id}.com/${id}`, title, publishedAt: '2026-10-15T10:00:00Z',
    firstSeenAt: '2026-10-15T10:30:00Z', kind: 'other', models: [], companies: [], tier: 2, sourceId: 's' + id, ...over,
  };
}

test('exact duplicates (same id) collapse, best tier wins', () => {
  const cl = clusterItems([item('a', 'Same thing here today', { tier: 3 }), item('a', 'Same thing here today', { tier: 1 })]);
  assert.equal(cl.length, 1);
  assert.equal(cl[0].rep.tier, 1);
});

test('near-duplicate titles cluster; rep prefers lower tier', () => {
  const cl = clusterItems([
    item('1', 'Anthropic raises $30 billion at $900 billion valuation', { tier: 2 }),
    item('2', 'Anthropic raises $30 billion at a $900 billion valuation - Reuters', { tier: 1 }),
    item('3', 'Totally different story about quantum chips', { tier: 1 }),
  ]);
  assert.equal(cl.length, 2);
  const big = cl.find(c => c.members.length === 2);
  assert.equal(big.rep.id, '2');
});

test('model/variant guard keeps "Gemini 3 Pro" and "Gemini 3 Flash" apart', () => {
  const cl = clusterItems([
    item('1', 'Google announces Gemini 3 Pro with better reasoning'),
    item('2', 'Google announces Gemini 3 Flash with better reasoning'),
  ]);
  assert.equal(cl.length, 2);
});

test('event key: same numbered model release merges different wording', () => {
  const cl = clusterItems([
    item('1', 'OpenAI unveils GPT-5.5', { kind: 'model-release', models: ['GPT-5.5'] }),
    item('2', 'GPT-5.5 is here and it is faster', { kind: 'model-release', models: ['GPT-5.5'] }),
  ]);
  assert.equal(cl.length, 1);
});

test('items more than 72 h apart do not merge', () => {
  const cl = clusterItems([
    item('1', 'Anthropic raises $30 billion at $900 billion valuation', { publishedAt: '2026-10-10T10:00:00Z' }),
    item('2', 'Anthropic raises $30 billion at $900 billion valuation', { publishedAt: '2026-10-15T10:00:00Z' }),
  ]);
  assert.equal(cl.length, 2);
});

test('cluster id is stable and a previously published rep stays rep', () => {
  const base = [
    item('1', 'Meta releases Llama 5 open weights today', { tier: 2, firstSeenAt: '2026-10-15T10:00:00Z' }),
    item('2', 'Meta releases Llama 5 open weights today', { tier: 2, domain: 'other', firstSeenAt: '2026-10-15T10:00:00Z' }),
  ];
  const first = clusterItems(base);
  const later = clusterItems([...base, item('3', 'Meta releases Llama 5 open weights today!', { tier: 1, domain: 'meta', firstSeenAt: '2026-10-15T12:00:00Z' })], { prevReps: new Set([first[0].rep.id]) });
  assert.equal(later.length, 1);
  assert.equal(later[0].id, first[0].id);
  assert.equal(later[0].rep.id, first[0].rep.id);
});
