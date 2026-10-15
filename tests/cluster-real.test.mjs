import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildNews } from '../scripts/lib/build.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = JSON.parse(readFileSync(path.join(dir, 'real-clusters.json'), 'utf8'));
const config = JSON.parse(readFileSync(path.join(dir, '..', '..', 'config', 'sources.json'), 'utf8'));

// Run the real tag + cluster + score pipeline over real pool items and map every
// item id (representative or folded duplicate) to its cluster id.
const news = buildNews(fx.items, config.sources, { now: Date.parse(fx.now), prevReps: new Set(), health: [] });
const clusterOf = new Map();
const byUrl = new Map(fx.items.map(i => [i.url, i.id]));
for (const it of news.items) {
  clusterOf.set(it.id, it.cluster);
  for (const a of it.alsoIn) clusterOf.set(byUrl.get(a.url), it.cluster);
}

test('every fixture item survives into the output', () => {
  for (const i of fx.items) assert.ok(clusterOf.has(i.id), `${i.sourceId}: ${i.title}`);
});

for (const [name, ids] of Object.entries(fx.groups)) {
  test(`same story clusters together: ${name}`, () => {
    const clusters = new Set(ids.map(id => clusterOf.get(id)));
    assert.equal(clusters.size, 1, `${name} split into ${clusters.size} clusters`);
  });
}

for (const p of fx.apart) {
  test(`different stories stay apart: ${p.why}`, () => {
    assert.notEqual(clusterOf.get(p.a), clusterOf.get(p.b));
  });
}
