import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, FIXTURE } from '../scripts/eval-tagger.mjs';

// Regression floor for the tagger on 213 hand-labelled real headlines
// (tests/fixtures/labelled-headlines.json). Phase 2 baseline: model-release
// precision 25.7% recall before tuning (9 of 35); thresholds below are the
// floors we refuse to fall under.
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const r = evaluate(cases);

test('fixture is large enough to mean something', () => {
  assert.ok(cases.length >= 80);
  assert.ok(cases.filter(c => c.gold === 'model-release').length >= 30);
});

test('model-release precision >= 0.95 and recall >= 0.9', () => {
  const s = r.stats['model-release'];
  assert.ok(s.precision >= 0.95, `precision ${s.precision}`);
  assert.ok(s.recall >= 0.9, `recall ${s.recall}`);
});

test('other kinds keep their floors', () => {
  for (const k of ['funding', 'paper', 'tool']) {
    assert.ok(r.stats[k].precision >= 0.9, `${k} precision ${r.stats[k].precision}`);
    assert.ok(r.stats[k].recall >= 0.9, `${k} recall ${r.stats[k].recall}`);
  }
  assert.ok(r.accuracy >= 0.78, `accuracy ${r.accuracy}`);
});
