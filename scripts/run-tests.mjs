// Portable test runner: lists test files itself so it behaves the same on
// Node 20 and 22, on Windows and Linux (no shell globbing, no dir argument).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['tests', path.join('docs', 'tests')];
const files = [];
for (const d of dirs) {
  for (const f of readdirSync(path.join(root, d)).sort()) {
    if (/\.test\.(m?js)$/.test(f)) files.push(path.join(d, f));
  }
}
if (!files.length) { console.error('no test files found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
