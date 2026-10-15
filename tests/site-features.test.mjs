// Phase 2 site features, driven through the real inline script of docs/index.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, router, goodFiles, newsDoc, iso, NOW, jsonResp } from './site-harness.mjs';

const chipClick = (data) => ({ target: { closest: sel => (sel.includes('data-') ? { dataset: data } : null) } });
const waitFor = async (s, fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await s.wait(10); }
};
const count = (html, re) => (html.match(re) || []).length;
const cards = html => count(html, /role="listitem"/g);

test('default language is English only; the languages control persists to localStorage', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()) });
  assert.deepEqual(JSON.parse(JSON.stringify(s.run('langs'))), ['en']);
  assert.match(s.getEl('visible-count').textContent, /^5 of 7$/);
  assert.ok(!/Turkiye yapay/.test(s.getEl('articles').innerHTML), 'Turkish item hidden by default');
  s.getEl('filter-lang').fire('click', chipClick({ lang: 'tr' }));
  assert.match(s.getEl('visible-count').textContent, /^6 of 7$/);
  assert.match(s.getEl('articles').innerHTML, /Turkiye yapay/);
  assert.match(s.getEl('articles').innerHTML, />TR</, 'language is shown on non-English cards');
  s.getEl('filter-lang').fire('click', chipClick({ lang: 'zh' }));
  s.getEl('filter-lang').fire('click', chipClick({ lang: 'other' }));
  assert.deepEqual(JSON.parse(s.store['ai-news-langs-v1']), ['en', 'tr', 'zh', 'other']);
  // reload remembers
  const s2 = await boot({ fetchImpl: router(goodFiles()), storage: { 'ai-news-langs-v1': s.store['ai-news-langs-v1'] } });
  assert.match(s2.getEl('visible-count').textContent, /^7 of 7$/);
  // English can be switched off when another language stays on
  s2.getEl('filter-lang').fire('click', chipClick({ lang: 'tr' }));
  s2.getEl('filter-lang').fire('click', chipClick({ lang: 'zh' }));
  s2.getEl('filter-lang').fire('click', chipClick({ lang: 'other' }));
  // only English is left: it cannot be removed
  s2.getEl('filter-lang').fire('click', chipClick({ lang: 'en' }));
  assert.deepEqual(JSON.parse(s2.store['ai-news-langs-v1']), ['en']);
});

test('search: debounced, matches company/model/topic/source, highlights terms, escapes markup', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()) });
  s.getEl('q').fire('input', { target: { value: 'gpt-6' } });
  assert.match(s.getEl('visible-count').textContent, /^5 of 7$/, 'not applied before the debounce');
  await s.wait(300);
  assert.match(s.getEl('visible-count').textContent, /^1 of 7$/);
  assert.match(s.getEl('articles').innerHTML, /<mark>GPT-6<\/mark>/);
  for (const [q, n] of [['alibaba', 1], ['open-weights', 1], ['qwen hf', 1], ['regulation', 1], ['anthropic', 1], ['nothing-matches-this', 0]]) {
    s.getEl('q').fire('input', { target: { value: q } });
    await s.wait(300);
    assert.match(s.getEl('visible-count').textContent, new RegExp('^' + n + ' of 7$'), q);
  }
  // regex metacharacters are literal
  s.getEl('q').fire('input', { target: { value: '(a+' } });
  await s.wait(300);
  assert.match(s.getEl('visible-count').textContent, /^0 of 7$/);
  // highlighting never lets data markup through
  assert.equal(s.run(`highlight('<img src=x onerror=alert(1)> a&b', ['a'])`), '&lt;img src=x onerror=<mark>a</mark>lert(1)&gt; <mark>a</mark>&amp;b');
});

test('"/" focuses the search box unless the user is already typing', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()) });
  const ev = s.pressKey('/');
  assert.equal(ev.prevented, true);
  assert.equal(s.getEl('q')._focused, true);
  const typing = s.pressKey('/', { tagName: 'INPUT' });
  assert.equal(typing.prevented, false);
});

test('hash state: filters are read from and written to #/news?..., invalid values ignored', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()), hash: '#/news?q=gpt&topic=llm&imp=40&kind=model-release&view=bogus&country=XX&imp2=1' });
  assert.match(s.getEl('visible-count').textContent, /^1 of 7$/);
  assert.equal(s.run('filters.q'), 'gpt');
  assert.equal(s.run('filters.view'), 'feed', 'unknown view ignored');
  assert.equal(s.run('filters.country'), 'all', 'unknown country ignored');
  assert.equal(s.getEl('q').value, 'gpt');
  assert.equal(s.getEl('f-topic').value, 'llm');
  // changing a filter updates the hash without adding history entries
  s.getEl('f-kind').fire('change', { target: { value: 'all' } });
  const last = s.historyCalls.filter(c => c[0] === 'replace').pop()[1];
  assert.match(last, /#\/news\?q=gpt&topic=llm&imp=40$/);
  assert.equal(s.historyCalls.filter(c => c[0] === 'push').length, 0);
  // pure helpers
  assert.deepEqual(JSON.parse(JSON.stringify(s.run(`(() => { const r = parseHash('#/guides?personalize=abc'); return { route: r.route, p: r.params.get('personalize') }; })()`))), { route: 'guides', p: 'abc' });
  assert.equal(s.run(`parseHash('#/nope').route`), 'news');
  assert.equal(s.run(`parseHash('').route`), 'news');
  assert.equal(s.run(`hashFor('news', filtersToParams(Object.assign(defaultFilters(), {q:'a b', view:'top'}), ['en','tr']))`), '#/news?q=a+b&view=top&lang=en%2Ctr');
});

test('hash routes: #/guides, #/releases, #/digest open their tab; hashchange applies filters', async () => {
  const calls = [];
  const s = await boot({ fetchImpl: router(goodFiles(), calls), hash: '#/guides' });
  assert.equal(s.run('activeTab'), 'guides');
  await waitFor(s, () => s.run('guidesStatus') === 'ok');
  assert.ok(calls.some(u => /guides\.json$/.test(u)));
  s.hashChange('#/news?topic=regulation');
  assert.equal(s.run('activeTab'), 'news');
  assert.match(s.getEl('visible-count').textContent, /^1 of 7$/);
  s.hashChange('#/news');
  assert.match(s.getEl('visible-count').textContent, /^5 of 7$/, 'a bare route resets to default filters');
  s.hashChange('#/releases');
  assert.equal(s.run('activeTab'), 'releases');
});

test('saved filter presets: save, apply, delete, persisted', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()) });
  s.getEl('f-kind').fire('change', { target: { value: 'model-release' } });
  s.getEl('preset-name').value = 'Models';
  s.getEl('preset-form').fire('submit');
  const saved = JSON.parse(s.store['ai-news-presets-v1']);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'Models');
  assert.equal(saved[0].state.kind, 'model-release');
  assert.match(s.getEl('preset-list').innerHTML, /data-preset-apply="0"/);
  s.getEl('f-kind').fire('change', { target: { value: 'all' } });
  assert.match(s.getEl('visible-count').textContent, /^5 of 7$/);
  s.getEl('preset-list').fire('click', { target: { closest: sel => (sel === '[data-preset-apply]' ? { dataset: { presetApply: '0' } } : null) } });
  assert.match(s.getEl('visible-count').textContent, /^2 of 7$/);
  // reload keeps it
  const s2 = await boot({ fetchImpl: router(goodFiles()), storage: { 'ai-news-presets-v1': s.store['ai-news-presets-v1'] } });
  assert.match(s2.getEl('preset-list').innerHTML, /Models/);
  s2.getEl('preset-list').fire('click', { target: { closest: sel => (sel === '[data-preset-del]' ? { dataset: { presetDel: '0' } } : null) } });
  assert.deepEqual(JSON.parse(s2.store['ai-news-presets-v1']), []);
  assert.match(s2.getEl('preset-list').innerHTML, /no saved filters/);
  // empty names are refused loudly
  s2.getEl('preset-name').value = '   ';
  s2.getEl('preset-form').fire('submit');
  assert.match(s2.getEl('toast').textContent, /name/i);
  assert.equal(s2.getEl('toast').classList.contains('err'), true);
});

test('theme toggle cycles auto -> light -> dark -> auto and is remembered', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()) });
  const root = () => s.sandbox.document.documentElement;
  assert.equal(root().getAttribute('data-theme'), null);
  s.getEl('btn-theme').fire('click');
  assert.equal(root().getAttribute('data-theme'), 'light');
  assert.equal(s.store['ai-news-theme-v1'], 'light');
  s.getEl('btn-theme').fire('click');
  assert.equal(root().getAttribute('data-theme'), 'dark');
  assert.equal(s.store['ai-news-theme-v1'], 'dark');
  assert.match(s.getEl('btn-theme').textContent, /dark/);
  const s2 = await boot({ fetchImpl: router(goodFiles()), storage: { 'ai-news-theme-v1': 'dark' } });
  assert.equal(s2.sandbox.document.documentElement.getAttribute('data-theme'), 'dark');
  s2.getEl('btn-theme').fire('click');
  assert.equal(s2.sandbox.document.documentElement.getAttribute('data-theme'), null);
  assert.ok(!('ai-news-theme-v1' in s2.store), 'auto removes the stored choice');
  // garbage in storage is ignored
  const s3 = await boot({ fetchImpl: router(goodFiles()), storage: { 'ai-news-theme-v1': 'purple' } });
  assert.equal(s3.sandbox.document.documentElement.getAttribute('data-theme'), null);
});

test('offline copy served by the service worker: banner says "Offline copy from <time>"', async () => {
  const stored = iso(NOW - 3 * 3600000);
  const files = goodFiles();
  const f = async url => {
    if (/news\.json/.test(url)) return jsonResp(newsDoc, { headers: { 'x-offline-copy': stored } });
    return router(files)(url);
  };
  const s = await boot({ fetchImpl: f });
  assert.equal(s.run('dataMode'), 'cache');
  const banner = s.getEl('data-banner').innerHTML;
  assert.match(banner, /Offline copy from /);
  assert.match(banner, /3h ago/);
  assert.ok(!('ai-news-cache-v3' in s.store), 'a stored copy is not written back as if it were live');
  assert.match(s.getEl('visible-count').textContent, /^5 of 7$/, 'still readable');
});

test('pagination: 60 cards per page, Show more appends the next page', async () => {
  const items = Array.from({ length: 150 }, (_, i) => ({
    id: 'p' + String(i).padStart(3, '0'), cluster: 'c-' + i, title: 'Story number ' + i, url: 'https://e.test/' + i, source: 'E', sourceId: 'e',
    sourceKind: 'news', country: 'US', lang: 'en', publishedAt: iso(NOW - i * 60000), kind: 'other', importance: 20, companies: [], models: [], topics: [], summary: '', alsoIn: [], breaking: false,
  }));
  const doc = { ...newsDoc, items, itemCount: 150 };
  const s = await boot({ fetchImpl: router({ ...goodFiles(), 'news.json': doc }) });
  assert.equal(cards(s.getEl('articles').innerHTML), 60);
  assert.match(s.getEl('visible-count').textContent, /^150 of 150$/);
  assert.equal(s.getEl('news-more-wrap').hidden, false);
  assert.match(s.getEl('news-more').textContent, /Show more \(90\)/);
  s.getEl('news-more').fire('click');
  assert.equal(cards(s.getEl('articles').innerHTML), 120);
  assert.ok(s.getEl('articles')._appended >= 1, 'appended instead of re-rendering everything');
  s.getEl('news-more').fire('click');
  assert.equal(cards(s.getEl('articles').innerHTML), 150);
  assert.equal(s.getEl('news-more-wrap').hidden, true);
  // changing a filter goes back to the first page
  s.getEl('f-imp').fire('change', { target: { value: '0' } });
  assert.equal(cards(s.getEl('articles').innerHTML), 60);
});

test('Top this week ranks by baseImportance within 7 days; Breaking strip lists breaking items', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()) });
  const strip = s.getEl('breaking-strip');
  assert.equal(strip.hidden, false);
  assert.match(strip.innerHTML, /OpenAI unveils GPT-6/);
  assert.ok(!/Qwen/.test(strip.innerHTML));
  s.getEl('panel-news').fire('click', { target: { closest: sel => (sel.includes('data-view') ? { dataset: { view: 'top' } } : null) } });
  const html = s.getEl('articles').innerHTML;
  const order = ['OpenAI unveils GPT-6', 'Anthropic ships Claude update', 'Qwen releases open weights', 'EU Commission'].map(t => html.indexOf(t));
  assert.ok(order.every(i => i >= 0), 'all present');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'ordered by baseImportance 90, 75, 60, 25');
  assert.ok(!/Old but important/.test(html), 'older than 7 days is excluded from the weekly top');
  assert.match(s.getEl('visible-count').textContent, /^4 of 7$/);
  assert.match(s.store.x ?? '', /^$/);
  // no breaking items: the strip is hidden
  const quiet = { ...newsDoc, items: newsDoc.items.map(i => ({ ...i, breaking: false })) };
  const s2 = await boot({ fetchImpl: router({ ...goodFiles(), 'news.json': quiet }) });
  assert.equal(s2.getEl('breaking-strip').hidden, true);
});

test('Releases tab: lazy fetch, month timeline, filters, new-in-7-days badge, safe links', async () => {
  const calls = [];
  const s = await boot({ fetchImpl: router(goodFiles(), calls) });
  assert.ok(!calls.some(u => /releases\.json/.test(u)), 'not fetched until the tab is opened');
  s.run(`setActiveTab('releases')`);
  await waitFor(s, () => s.run('releases.status') === 'ok');
  const list = s.getEl('rel-list').innerHTML;
  assert.equal(count(list, /class="month-head"/g), 3, 'three month groups');
  assert.match(list, /September 2026/);
  assert.match(list, /August 2026/);
  assert.equal(count(list, /class="new-badge">NEW/g), 2);
  assert.equal(s.getEl('rel-new-badge').textContent, '2 new');
  assert.ok(!list.includes('javascript:'), 'javascript: link neutralised');
  assert.ok(list.includes('rel="noopener noreferrer"'));
  assert.match(list, /openness unknown/);
  assert.match(s.getEl('rel-count').textContent, /^4 of 4$/);
  s.getEl('r-open').value = 'open'; s.getEl('r-open').fire('change');
  assert.match(s.getEl('rel-count').textContent, /^2 of 4$/);
  s.getEl('r-open').value = 'unknown'; s.getEl('r-open').fire('change');
  assert.match(s.getEl('rel-count').textContent, /^1 of 4$/);
  s.getEl('r-open').value = 'all'; s.getEl('r-open').fire('change');
  s.getEl('r-kind').value = 'tool'; s.getEl('r-kind').fire('change');
  assert.match(s.getEl('rel-count').textContent, /^1 of 4$/);
  s.getEl('r-kind').value = 'all'; s.getEl('r-kind').fire('change');
  s.getEl('r-company').value = 'Meta'; s.getEl('r-company').fire('change');
  assert.match(s.getEl('rel-count').textContent, /^1 of 4$/);
  assert.match(s.getEl('r-company').innerHTML, /<option value="Alibaba">/);
});

test('Releases and Digest degrade to "not available yet" when the file is missing', async () => {
  const files = goodFiles(); delete files['releases.json']; delete files['digest.json']; delete files['digest-weekly.json'];
  const s = await boot({ fetchImpl: router(files) });
  s.run(`setActiveTab('releases')`);
  await waitFor(s, () => s.run('releases.status') === 'missing');
  assert.match(s.getEl('rel-list').innerHTML, /not available yet/);
  s.run(`setActiveTab('digest')`);
  await waitFor(s, () => s.run('digest.status') === 'missing');
  assert.match(s.getEl('digest-body').innerHTML, /not available yet/);
  // network failure is reported as an error, not as "not published"
  const s2 = await boot({ fetchImpl: async u => { if (/releases/.test(u)) throw new Error('boom'); return router(goodFiles())(u); } });
  s2.run(`setActiveTab('releases')`);
  await waitFor(s2, () => s2.run('releases.status') === 'error');
  assert.match(s2.getEl('rel-list').innerHTML, /boom/);
});

test('Digest tab: daily/weekly toggle, sections by topic, copy as Markdown', async () => {
  const written = [];
  const calls = [];
  const s = await boot({ fetchImpl: router(goodFiles(), calls), clipboard: { writeText: async t => { written.push(t); } } });
  s.run(`setActiveTab('digest')`);
  await waitFor(s, () => s.run('digest.status') === 'ok');
  let body = s.getEl('digest-body').innerHTML;
  assert.match(body, /Models \[and\] more/);
  assert.match(body, /<h3>Policy<\/h3>/);
  assert.ok(!body.includes('javascript:'));
  assert.match(s.getEl('digest-count').textContent, /3 items · 3 sources/);
  // weekly uses digest-weekly.json
  s.getEl('panel-digest').fire('click', { target: { closest: () => ({ dataset: { digest: 'weekly' } }) } });
  await waitFor(s, () => s.run('digest.kind') === 'weekly' && s.run('digest.status') === 'ok');
  assert.ok(calls.some(u => /digest-weekly\.json$/.test(u)));
  assert.match(s.getEl('digest-count').textContent, /30 items · 12 sources/);
  // copy
  s.getEl('digest-copy').fire('click');
  await s.wait(20);
  assert.equal(written.length, 1);
  assert.match(written[0], /^# AI news weekly digest \(2026-10-08 to 2026-10-15\)/);
  assert.match(written[0], /## Models \\\[and\\\] more/);
  assert.match(written[0], /- \[OpenAI unveils GPT-6\]\(https:\/\/openai\.com\/index\/gpt-6\) - OpenAI News, \+1 more/);
  assert.ok(!written[0].includes('javascript:'));
  // no clipboard: the Markdown is shown for manual copy and the failure is raised
  const s2 = await boot({ fetchImpl: router(goodFiles()) });
  s2.run(`setActiveTab('digest')`);
  await waitFor(s2, () => s2.run('digest.status') === 'ok');
  s2.getEl('digest-copy').fire('click');
  await s2.wait(20);
  assert.equal(s2.getEl('digest-md').hidden, false);
  assert.match(s2.getEl('digest-md').value, /^# AI news daily digest/);
  assert.equal(s2.getEl('toast').classList.contains('err'), true);
});

test('Digest: a file of the other period kind is not shown as the requested one', async () => {
  const files = goodFiles(); delete files['digest-weekly.json']; // digest.json is daily
  const s = await boot({ fetchImpl: router(files) });
  s.run(`setActiveTab('digest')`);
  await waitFor(s, () => s.run('digest.status') === 'ok');
  s.getEl('panel-digest').fire('click', { target: { closest: () => ({ dataset: { digest: 'weekly' } }) } });
  await waitFor(s, () => s.run('digest.status') === 'missing');
  assert.match(s.getEl('digest-body').innerHTML, /not available yet/);
  assert.match(s.getEl('digest-body').innerHTML, /only the daily digest is published/);
});

test('Guides: guides.json first (no Worker call), sourceKind filter and search', async () => {
  const calls = [];
  const s = await boot({ fetchImpl: router(goodFiles(), calls), hash: '#/guides' });
  await waitFor(s, () => s.run('guidesStatus') === 'ok');
  assert.equal(s.run('guidesSource'), 'guides.json');
  assert.ok(!calls.some(u => /workers\.dev|codetabs|allorigins/.test(u)), 'the Worker is not touched');
  assert.equal(s.getEl('guides-banner').innerHTML, '');
  assert.equal(cards(s.getEl('latest-list').innerHTML), 3);
  assert.match(s.getEl('guides-filter').innerHTML, /<option value="youtube">/);
  s.getEl('guides-filter').fire('change', { target: { value: 'youtube' } });
  assert.equal(cards(s.getEl('latest-list').innerHTML), 1);
  assert.match(s.getEl('latest-count').textContent, /^1 of 3$/);
  s.getEl('guides-filter').fire('change', { target: { value: 'all' } });
  s.getEl('guides-q').fire('input', { target: { value: 'agents' } });
  await s.wait(300);
  assert.equal(cards(s.getEl('latest-list').innerHTML), 1);
  assert.match(s.getEl('latest-list').innerHTML, /<mark>agents<\/mark>/i);
  s.getEl('guides-q').fire('input', { target: { value: '' } });
  await s.wait(300);
  s.getEl('guides-sort').fire('change', { target: { value: 'score' } });
  assert.ok(s.getEl('latest-list').innerHTML.indexOf('RAG from scratch') < s.getEl('latest-list').innerHTML.indexOf('Local LLM tips'));
});

test('Guides: Worker path only when guides.json is unreachable, and it says so', async () => {
  const calls = [];
  const files = goodFiles();
  delete files['guides.json'];
  files['guide-sources.json'] = { sources: [{ name: 'Aggregate', url: 'https://ai-news-cors.mortuexhavoc.workers.dev/guides/aggregate', type: 'json', parser: 'aggregate', direct: true, category: 'Blogs' }] };
  const base = router(files, calls);
  const f = async url => {
    if (/guides\/aggregate/.test(url)) { calls.push(String(url)); return jsonResp({ items: [{ title: 'Legacy guide', url: 'https://l.test/1', source: 'Some Blog', published: iso(NOW - 1000), summary: 's' }] }); }
    return base(url);
  };
  const s = await boot({ fetchImpl: f, hash: '#/guides' });
  await waitFor(s, () => s.run('guidesStatus') === 'ok');
  assert.equal(s.run('guidesSource'), 'legacy-worker');
  assert.ok(calls.some(u => /guides\/aggregate/.test(u)));
  assert.match(s.getEl('guides-banner').innerHTML, /Fallback mode/);
  assert.match(s.getEl('guides-banner').innerHTML, /guides\.json/);
  assert.match(s.getEl('latest-list').innerHTML, /Legacy guide/);
});

test('personalize secret is scrubbed from the address bar after it has been read', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()), search: '?data=../data/news.json&personalize=hunter2', hash: '#/guides?personalize=hunter2' });
  await s.wait(50);
  const scrubs = s.historyCalls.filter(c => c[0] === 'replace').map(c => c[1]);
  assert.ok(scrubs.length > 0);
  assert.ok(!/hunter2/.test(scrubs[scrubs.length - 1]), 'the address bar ends without the secret: ' + scrubs.join(' | '));
  assert.match(scrubs[scrubs.length - 1], /#\/guides$/, 'the route survives the scrub');
  assert.equal(s.run('personalizeEnabled'), false, 'a wrong secret does not enable the feature');
});

test('sibling data files are resolved next to news.json (and next to a ?data= override)', async () => {
  const s = await boot({ fetchImpl: router(goodFiles()) });
  assert.equal(s.run(`dataFileUrl('releases.json')`), '../data/releases.json');
  const s2 = await boot({ fetchImpl: router(goodFiles()), search: '' });
  assert.equal(s2.run(`dataFileUrl('digest.json')`), 'https://raw.githubusercontent.com/0xmortuex/ai-news-tracker/data/digest.json');
});
