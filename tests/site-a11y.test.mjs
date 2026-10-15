// Static checks on docs/index.html: WCAG AA contrast of the theme tokens,
// roles/labels, link safety, CSP, no inline handlers, manifest + icons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { root, html } from './site-harness.mjs';

function block(startRe) {
  const m = startRe.exec(html);
  assert.ok(m, 'missing css block ' + startRe);
  const open = html.indexOf('{', m.index);
  const close = html.indexOf('}', open);
  const vars = {};
  for (const [, k, v] of html.slice(open, close).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[k] = v.trim();
  return vars;
}
const dark = block(/:root \{/);
const light = block(/:root\[data-theme="light"\] \{/);
const lightMedia = block(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{/);

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_PAIRS = [
  ['text', 'bg'], ['text', 'bg-card'], ['text', 'bg-elev'],
  ['text-dim', 'bg'], ['text-dim', 'bg-card'], ['text-dim', 'bg-elev'],
  ['text-faint', 'bg'], ['text-faint', 'bg-card'], ['text-faint', 'bg-elev'],
  ['accent', 'bg'], ['accent', 'bg-card'], ['accent', 'bg-elev'],
  ['on-accent', 'accent'], ['on-err', 'err'],
  ['us', 'bg-card'], ['cn', 'bg-card'], ['other', 'bg-card'], ['ok', 'bg-card'], ['err', 'bg-card'], ['warn', 'bg-card'],
  ['mark-fg', 'mark-bg'],
];
for (const [name, v] of [['dark', dark], ['light', light]]) {
  test(`${name} theme: text/background pairs meet WCAG AA (4.5:1)`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      const r = ratio(v[fg], v[bg]);
      assert.ok(r >= 4.5, `${name}: --${fg} ${v[fg]} on --${bg} ${v[bg]} is ${r.toFixed(2)}:1`);
    }
  });
  test(`${name} theme: control borders and focus ring meet 3:1`, () => {
    for (const bg of ['bg', 'bg-card']) {
      assert.ok(ratio(v['control-border'], v[bg]) >= 3, `${name}: control-border on ${bg} ${ratio(v['control-border'], v[bg]).toFixed(2)}`);
      assert.ok(ratio(v.focus, v[bg]) >= 3, `${name}: focus on ${bg}`);
    }
  });
}

test('the prefers-color-scheme light block is identical to the manual light theme', () => {
  const strip = o => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'color-scheme'));
  assert.deepEqual(strip(lightMedia), strip(light));
});

test('semantics: tablist roles, labelled controls, skip link, reduced motion', () => {
  assert.match(html, /<nav class="tabs" role="tablist"/);
  const tabs = [...html.matchAll(/<button class="tab"[^>]*>/g)].map(m => m[0]);
  assert.equal(tabs.length, 4);
  for (const t of tabs) {
    assert.match(t, /role="tab"/);
    assert.match(t, /aria-controls="panel-/);
    assert.match(t, /aria-selected=/);
  }
  assert.equal([...html.matchAll(/role="tabpanel"/g)].length, 4);
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /:focus-visible \{[^}]*outline:/);
  assert.match(html, /<html lang="en">/);
  // every form control has a label or aria-label
  const ids = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map(m => m[1]));
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    assert.ok(/aria-label=/.test(tag) || (id && ids.has(id)), 'unlabelled control: ' + tag);
  }
  // ids are unique
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(all).size, all.length, 'duplicate ids');
});

test('security: strict CSP, no inline handlers, safe external links, no third-party scripts', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csp, 'CSP meta present');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.ok(!/unsafe-eval/.test(csp));
  const script = /script-src ([^;]+)/.exec(csp)[1];
  assert.ok(!/https?:/.test(script), 'no remote script origins: ' + script);
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '')), 'inline event handler attribute in markup');
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) assert.ok(!/^(https?:)?\/\//.test(m[1]), 'external script ' + m[1]);
  for (const m of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) assert.match(m[0], /rel="noopener noreferrer"/, m[0]);
  // generated links in the script
  const script2 = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  for (const m of script2.matchAll(/target="_blank"[^>]*>/g)) assert.match(m[0], /rel="noopener noreferrer"/, m[0]);
  assert.ok(!/innerHTML\s*=\s*[^;]*\bresp\b/.test(script2));
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  // no new fonts: only the original Google Fonts stylesheet
  const fonts = [...html.matchAll(/https:\/\/fonts\.[a-z.]+\/[^"')\s]*/g)].map(m => m[0]);
  assert.ok(fonts.every(f => /fonts\.(googleapis|gstatic)\.com/.test(f)));
});

test('PWA: manifest is valid, icons exist with the stated sizes, service worker is registered', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'docs', 'manifest.webmanifest'), 'utf8'));
  assert.ok(manifest.name && manifest.short_name);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url);
  const purposes = manifest.icons.map(i => i.purpose);
  assert.ok(purposes.includes('maskable') && purposes.includes('any'));
  for (const icon of manifest.icons) {
    const p = path.join(root, 'docs', icon.src);
    assert.ok(existsSync(p), 'missing icon ' + icon.src);
    if (icon.type === 'image/png') {
      const buf = readFileSync(p);
      assert.equal(buf.subarray(1, 4).toString(), 'PNG');
      const [w, h] = icon.sizes.split('x').map(Number);
      assert.equal(buf.readUInt32BE(16), w);
      assert.equal(buf.readUInt32BE(20), h);
    }
  }
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /serviceWorker\.register\("sw\.js"\)/);
  assert.ok(existsSync(path.join(root, 'docs', 'sw.js')));
});
