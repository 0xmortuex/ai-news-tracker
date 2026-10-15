#!/usr/bin/env node
// Offline tagger evaluation against the hand-labelled fixture
// (tests/fixtures/labelled-headlines.json). Prints per-kind precision / recall and
// the model-release confusion list. Used to tune scripts/lib/tag.mjs and by
// tests/tag-quality.test.mjs for regression thresholds.
//
//   node scripts/eval-tagger.mjs [--verbose]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagItem } from './lib/tag.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'labelled-headlines.json');

export function evaluate(cases) {
  const rows = cases.map(c => {
    const t = tagItem({ title: c.title, summary: c.summary || '', extra: c.source.prior && c.source.prior.kind === 'model-release' && c.models && c.models[0] ? { modelId: c.models[0] } : undefined }, c.source);
    return { c, got: t.kind, tags: t };
  });
  const kinds = [...new Set(rows.flatMap(r => [r.c.gold, r.got]))].sort();
  const stats = {};
  for (const k of kinds) {
    const tp = rows.filter(r => r.c.gold === k && r.got === k).length;
    const fp = rows.filter(r => r.c.gold !== k && r.got === k).length;
    const fn = rows.filter(r => r.c.gold === k && r.got !== k).length;
    stats[k] = {
      tp, fp, fn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
    };
  }
  const correct = rows.filter(r => r.c.gold === r.got).length;
  return { rows, stats, accuracy: correct / rows.length, n: rows.length };
}

function pct(x) { return x === null ? '  n/a' : `${(x * 100).toFixed(1).padStart(5)}%`; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const r = evaluate(cases);
  console.log(`fixture: ${r.n} labelled headlines, overall accuracy ${pct(r.accuracy)}`);
  console.log('kind            tp  fp  fn  precision  recall');
  for (const [k, s] of Object.entries(r.stats)) {
    console.log(`${k.padEnd(14)} ${String(s.tp).padStart(3)} ${String(s.fp).padStart(3)} ${String(s.fn).padStart(3)}  ${pct(s.precision)}   ${pct(s.recall)}`);
  }
  const verbose = process.argv.includes('--verbose');
  for (const row of r.rows) {
    const mr = row.c.gold === 'model-release' || row.got === 'model-release';
    if (row.c.gold !== row.got && (verbose || mr)) {
      console.log(`  gold=${row.c.gold.padEnd(13)} got=${row.got.padEnd(13)} [${row.c.source.sourceId}] ${row.c.title.slice(0, 90)}`);
    }
  }
}
