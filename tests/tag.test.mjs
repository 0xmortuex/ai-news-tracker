import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tagItem, isModelRelease } from '../scripts/lib/tag.mjs';
import { findModels, findCompanies, passesFilter } from '../scripts/lib/taxonomy.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const { cases } = JSON.parse(readFileSync(path.join(dir, 'headlines.json'), 'utf8'));

for (const c of cases) {
  test(`headline: ${c.title.slice(0, 70)}`, () => {
    const t = tagItem({ title: c.title, summary: c.summary || '', extra: c.extra }, c.source);
    if (c.kind) assert.equal(t.kind, c.kind, `kind (labels ${t.labels})`);
    if (c.kindNot) assert.notEqual(t.kind, c.kindNot);
    for (const m of c.models || []) assert.ok(t.models.includes(m), `model ${m} in ${JSON.stringify(t.models)}`);
    if (c.models && c.models.length === 0) assert.deepEqual(t.models, []);
    for (const co of c.companies || []) assert.ok(t.companies.includes(co), `company ${co} in ${JSON.stringify(t.companies)}`);
    for (const l of c.labelsInclude || []) assert.ok(t.labels.includes(l),`label ${l} in ${JSON.stringify(t.labels)}`);
  });
}

test('labels are the rule-table names, at most 3, general when nothing matches', () => {
  const t = tagItem({ title: 'A quiet Tuesday', summary: '' }, { sourceKind: 'news', country: 'US', lang: 'en', tier: 2 });
  assert.deepEqual(t.labels, ['general']);
  assert.equal(t.kind, 'other');
  const big = tagItem({ title: 'China open-source GPU chips funding regulation safety', summary: '' }, { sourceKind: 'news', country: 'CN', lang: 'en', tier: 2 });
  assert.ok(big.labels.length <= 3);
});

test('release rule needs verb AND model name', () => {
  assert.equal(isModelRelease('Meta releases Llama 5', ''), true);
  assert.equal(isModelRelease('Meta releases quarterly earnings', ''), false);
  assert.equal(isModelRelease('Why Claude 4 matters', ''), false);
  assert.equal(isModelRelease('Open models have real benefits', 'GLM-5.3 was released last week'), false);
});

test('model extraction', () => {
  assert.ok(findModels('OpenAI ships GPT-5.5 and more').includes('GPT-5.5'));
  assert.ok(findModels('Claude Opus 4.5 is out').includes('Claude Opus 4.5'));
  assert.ok(findModels('DeepSeek-V4.1-Flash weights').some(m => /DeepSeek/.test(m)));
  assert.deepEqual(findModels('install llm-gemini 0.35'), []);
});

test('company extraction is case-aware for ambiguous names', () => {
  assert.ok(findCompanies('meta ai released llama', 'Meta AI released Llama').includes('Meta'));
  assert.ok(!findCompanies('a meta analysis of apples', 'a meta analysis of apples').includes('Meta'));
  assert.ok(!findCompanies('i ate an apple', 'I ate an apple').includes('Apple'));
});

test('relevance filters: ai, ai-tr, arxiv (hard, announce type new only)', () => {
  assert.equal(passesFilter('ai', 'Chancellor budget speech', 'Taxes and spending').ok, false);
  assert.equal(passesFilter('ai', 'Nvidia earnings', '').ok, true);
  assert.equal(passesFilter('ai-tr', 'Yapay zeka destekli arama', '').ok, true);
  assert.equal(passesFilter('ai-tr', 'Hava durumu', 'Yarın yağmur').ok, false);
  assert.equal(passesFilter('arxiv', 'A study of graph colouring', 'Announce Type: new Abstract: We colour graphs.', 'arXiv:1 Announce Type: new Abstract: x').ok, false);
  assert.equal(passesFilter('arxiv', 'Agents for debt', 'arXiv:1 Announce Type: new Abstract: large language models help', 'arXiv:1 Announce Type: new Abstract: large language models help').ok, true);
  assert.equal(passesFilter('arxiv', 'Agents for debt', 'x', 'arXiv:1 Announce Type: replace-cross Abstract: large language models').ok, false);
  assert.throws(() => passesFilter('nope', 'a', 'b'), /unknown filter preset/);
});
