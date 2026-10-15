// Shared harness for the site tests: runs the REAL inline script of docs/index.html
// in a vm with a small DOM stub, plus fixtures for every data file.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const html = readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
export const guidesLib = readFileSync(path.join(root, 'docs', 'guides-lib.js'), 'utf8');
export const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];

export const NOW = Date.now();
export const iso = ms => new Date(ms).toISOString();
const H = 3600000, D = 24 * H;

function item(o) {
  return Object.assign({
    cluster: 'c-' + o.id, canonicalUrl: o.url, sourceId: 's-' + o.id, sourceKind: 'news', country: 'US', lang: 'en',
    firstSeenAt: iso(NOW - H), kind: 'other', importance: 20, companies: [], models: [], topics: [], summary: '', alsoIn: [], breaking: false,
  }, o);
}

export const newsDoc = {
  schema: 'ai-news/1', schemaVersion: 1, generatedAt: iso(NOW - 12 * 60000), itemCount: 0,
  sources: [{ id: 'openai', name: 'OpenAI News', status: 'ok', stale: false, itemCount: 3 }],
  items: [
    item({ id: 'a1', title: 'OpenAI unveils GPT-6', url: 'https://openai.com/index/gpt-6', source: 'OpenAI News', publishedAt: iso(NOW - H), kind: 'model-release', importance: 82, baseImportance: 90, companies: ['OpenAI'], models: ['GPT-6'], topics: ['llm'], summary: 'A new model with long context.', breaking: true }),
    item({ id: 'a2', title: 'Qwen releases open weights', url: 'https://x.test/q', source: 'Qwen HF', publishedAt: iso(NOW - 2 * H), kind: 'model-release', importance: 35, baseImportance: 60, companies: ['Alibaba'], topics: ['open-weights', 'china'], country: 'CN' }),
    item({ id: 'a3', title: 'EU Commission opens AI Act consultation', url: 'https://digital-strategy.ec.europa.eu/x', source: 'EU Digital Strategy', publishedAt: iso(NOW - 3 * H), kind: 'policy', importance: 20, baseImportance: 25, topics: ['regulation'], country: 'EU', summary: 'Consultation.' }),
    item({ id: 'a4', title: 'Anthropic ships Claude update', url: 'https://anthropic.com/news/x', source: 'Anthropic News (third-party scrape)', publishedAt: iso(NOW - 4 * H), kind: 'product', importance: 40, baseImportance: 75, companies: ['Anthropic'], thirdParty: true }),
    item({ id: 'tr1', title: 'Turkiye yapay zeka stratejisi', url: 'https://webrazzi.test/tr1', source: 'Webrazzi', lang: 'tr', publishedAt: iso(NOW - 5 * H), importance: 30, baseImportance: 30, country: 'OTHER', topics: ['turkey'] }),
    item({ id: 'zh1', title: 'Zhipu launches new GLM model', url: 'https://zhipu.test/zh1', source: '36Kr', lang: 'zh', publishedAt: iso(NOW - 6 * H), importance: 33, baseImportance: 33, country: 'CN', companies: ['Zhipu'] }),
    item({ id: 'old1', title: 'Old but important story', url: 'https://old.test/1', source: 'Old Source', publishedAt: iso(NOW - 9 * D), importance: 10, baseImportance: 95 }),
  ],
};
newsDoc.itemCount = newsDoc.items.length;

export const releasesDoc = {
  schema: 'ai-news-releases/1', generatedAt: iso(NOW - 3600000),
  releases: [
    { id: 'r1', date: iso(NOW - 2 * D), company: 'OpenAI', model: 'GPT-6', family: 'GPT', kind: 'model', url: 'https://openai.com/gpt-6', source: 'OpenAI News', summary: 'Flagship model.', importance: 90, open: false, alsoIn: [{ source: 'The Decoder', url: 'https://the-decoder.com/x' }] },
    { id: 'r2', date: iso(NOW - 3 * D), company: 'Alibaba', model: 'Qwen4', family: 'Qwen', kind: 'model', url: 'https://hf.co/Qwen/Qwen4', source: 'Hugging Face', summary: 'Open weights.', importance: 55, open: true, alsoIn: [] },
    { id: 'r3', date: '2026-09-10T00:00:00Z', company: 'Ollama', model: 'Ollama v0.40', family: 'Ollama', kind: 'tool', url: 'https://github.com/ollama/ollama', source: 'GitHub', summary: '', importance: 30, open: null, alsoIn: [] },
    { id: 'r4', date: '2026-08-20T00:00:00Z', company: 'Meta', model: 'Llama 5', family: 'Llama', kind: 'model', url: 'javascript:alert(1)', source: 'Meta AI', summary: 'x <b>y</b>', importance: 70, open: true, alsoIn: [] },
  ],
};

export const digestDaily = {
  schema: 'ai-news-digest/1', generatedAt: iso(NOW),
  period: { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z', kind: 'daily' },
  sections: [
    { topic: 'llm', title: 'Models [and] more', items: [
      { id: 'a1', title: 'OpenAI unveils GPT-6', url: 'https://openai.com/index/gpt-6', source: 'OpenAI News', importance: 82, alsoIn: [{ source: 'The Decoder', url: 'https://the-decoder.com/x' }] },
      { id: 'a2', title: 'Qwen <b>weights</b>', url: 'javascript:alert(1)', source: 'Qwen HF', importance: 35, alsoIn: [] },
    ] },
    { topic: 'policy', title: 'Policy', items: [{ id: 'a3', title: 'EU consultation', url: 'https://digital-strategy.ec.europa.eu/x', source: 'EU', importance: 20, alsoIn: [] }] },
  ],
  stats: { items: 3, sources: 3 },
};
export const digestWeekly = { ...digestDaily, period: { from: '2026-10-08T00:00:00Z', to: '2026-10-15T00:00:00Z', kind: 'weekly' }, stats: { items: 30, sources: 12 } };

export const guidesDoc = {
  schema: 'ai-news-guides/1', generatedAt: iso(NOW),
  items: [
    { id: 'g1', title: 'Build agents with Claude Code', url: 'https://blog.test/agents', source: 'Simon Willison', sourceKind: 'blog', publishedAt: iso(NOW - D), summary: 'A practical guide.', score: 80 },
    { id: 'g2', title: 'RAG from scratch', url: 'https://youtube.test/rag', source: 'YouTube: Sam', sourceKind: 'youtube', publishedAt: iso(NOW - 2 * D), summary: 'Video walkthrough', score: 95 },
    { id: 'g3', title: 'Local LLM tips', url: 'https://reddit.test/llm', source: 'r/LocalLLaMA', sourceKind: 'reddit', publishedAt: iso(NOW - 3 * D), summary: '', score: 40 },
  ],
};

// ---------------------------------------------------------------------------
export function makeEl(id) {
  const listeners = {};
  const attrs = {};
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, style: {}, dataset: {}, tagName: 'DIV',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { (f === undefined ? !this._s.has(c) : f) ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t, ev = {}) { (listeners[t] || []).forEach(fn => fn({ preventDefault() { el._prevented = true; }, target: el, ...ev })); },
    replaceWith() {}, cloneNode() { return el; },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; }, removeAttribute(k) { delete attrs[k]; },
    insertAdjacentHTML(_p, h) { el.innerHTML += h; el._appended = (el._appended || 0) + 1; },
    focus() { el._focused = true; }, select() { el._selected = true; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
  };
  return el;
}

export async function boot({ fetchImpl, search = '?data=../data/news.json', hash = '', storage = {}, clipboard, settle = true } = {}) {
  const els = new Map();
  const getEl = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const store = { ...storage };
  const docListeners = {};
  const winListeners = {};
  const historyCalls = [];
  const location = { search, hash, pathname: '/docs/index.html', protocol: 'http:', hostname: '127.0.0.1', href: 'http://127.0.0.1:8080/docs/index.html' + search + hash };
  const sandbox = {
    console, URL, URLSearchParams, AbortController, Date, JSON, Math, Promise, Set, Map, Array, Object, String, Number, Error, RegExp, encodeURIComponent,
    document: {
      getElementById: getEl, querySelectorAll: () => [], createElement: () => makeEl('x'), body: makeEl('body'), documentElement: makeEl('html'),
      addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    location,
    history: {
      replaceState(_s, _t, url) { historyCalls.push(['replace', url]); const i = String(url).indexOf('#'); location.hash = i === -1 ? '' : url.slice(i); },
      pushState(_s, _t, url) { historyCalls.push(['push', url]); const i = String(url).indexOf('#'); location.hash = i === -1 ? '' : url.slice(i); },
    },
    navigator: clipboard ? { clipboard } : {},
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    setInterval: () => 0,
    DOMParser: undefined,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); };
  vm.createContext(sandbox);
  vm.runInContext(guidesLib, sandbox);
  vm.runInContext(script, sandbox);
  const ctx = {
    sandbox, getEl, store, historyCalls, location,
    run: code => vm.runInContext(code, sandbox),
    pressKey: (key, target = {}) => { const ev = { key, target, prevented: false, preventDefault() { this.prevented = true; } }; (docListeners.keydown || []).forEach(fn => fn(ev)); return ev; },
    hashChange: h => { location.hash = h; (winListeners.hashchange || []).forEach(fn => fn({})); },
    wait: ms => new Promise(r => setTimeout(r, ms)),
    async settleNews() {
      for (let i = 0; i < 200; i++) {
        const mode = vm.runInContext('dataMode', sandbox);
        if (mode !== 'loading' && !vm.runInContext('refreshing', sandbox)) break;
        await new Promise(r => setTimeout(r, 10));
      }
    },
  };
  if (settle) await ctx.settleNews();
  return ctx;
}
export const jsonResp = (obj, init) => new Response(JSON.stringify(obj), { status: 200, ...init });
// Routes by file name; anything not in `files` answers 404.
export function router(files, calls = []) {
  return async url => {
    const u = String(url);
    calls.push(u);
    const name = u.split('/').pop().split('?')[0];
    if (name in files) {
      const v = files[name];
      if (v instanceof Error) throw v;
      if (v instanceof Response) return v.clone();
      return jsonResp(v);
    }
    return new Response('not found', { status: 404 });
  };
}
export const goodFiles = () => ({
  'news.json': newsDoc, 'releases.json': releasesDoc, 'digest.json': digestDaily, 'digest-weekly.json': digestWeekly, 'guides.json': guidesDoc,
  'featured-guides.json': { guides: [{ title: 'Featured', url: 'https://f.test/x', author: 'A', tags: ['t'] }] },
});
