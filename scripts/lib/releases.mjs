// releases.json (ai-news-releases/1): a model / tool release tracker derived from the
// published news.json items plus the carried-over previous file (news.json only keeps
// 14 days, releases keep 90). Pure: no I/O, no clock reads (`now` is passed in).

import { createHash } from 'node:crypto';
import { findModels } from './taxonomy.mjs';
import { clip } from './text.mjs';

export const RELEASES_SCHEMA = 'ai-news-releases/1';
export const WINDOW_DAYS = 90;
export const MAX_RELEASES = 300;
export const MAX_PER_TOOL = 3;

// Family (first word of a model name, lower-cased) -> company, for names the news item
// does not carry a company for. HF org names are handled separately.
const FAMILY_COMPANY = {
  gpt: 'OpenAI', sora: 'OpenAI', codex: 'OpenAI', o1: 'OpenAI', o3: 'OpenAI', o4: 'OpenAI',
  claude: 'Anthropic', fable: 'Anthropic', mythos: 'Anthropic',
  gemini: 'Google', gemma: 'Google', veo: 'Google', imagen: 'Google', embeddinggemma: 'Google',
  llama: 'Meta', muse: 'Meta',
  qwen: 'Alibaba', wan: 'Alibaba', deepseek: 'DeepSeek', kimi: 'Moonshot', glm: 'Zhipu', grok: 'xAI',
  mistral: 'Mistral', mixtral: 'Mistral', magistral: 'Mistral', devstral: 'Mistral', ministral: 'Mistral', pixtral: 'Mistral',
  codestral: 'Mistral', voxtral: 'Mistral', timestral: 'Mistral',
  phi: 'Microsoft', nemotron: 'NVIDIA', hunyuan: 'Tencent', doubao: 'ByteDance', seedance: 'ByteDance', seedream: 'ByteDance',
  omnihuman: 'ByteDance', ernie: 'Baidu', minimax: 'MiniMax', flux: 'Black Forest Labs', falcon: 'TII', lfm: 'Liquid AI',
  step: 'StepFun', nova: 'Amazon', apertus: 'Swiss AI Initiative', jais: 'Inception (G42)', olmo: 'Allen AI', granite: 'IBM',
};
const HF_ORG_COMPANY = {
  'deepseek-ai': 'DeepSeek', qwen: 'Alibaba', moonshotai: 'Moonshot', 'zai-org': 'Zhipu', minimaxai: 'MiniMax', tencent: 'Tencent',
  'bytedance-seed': 'ByteDance', baidu: 'Baidu', mistralai: 'Mistral', google: 'Google', openai: 'OpenAI', nvidia: 'NVIDIA',
  facebook: 'Meta', 'meta-llama': 'Meta', microsoft: 'Microsoft', 'xai-org': 'xAI',
};

const PRERELEASE_RE = /[-.]?(?:rc|alpha|beta|dev|pre|preview)[.\d-]*$/i;
const OPEN_YES_RE = /(?<![\p{L}\p{N}])(?:open[- ]weights?|open[- ]source (?:\w+ ){0,2}models?|apache[- ]2(?:\.0)?|mit license)(?![\p{L}\p{N}])/iu;
const OPEN_NO_RE = /(?<![\p{L}\p{N}])(?:proprietary|closed[- ]source|closed[- ]weights?)(?![\p{L}\p{N}])/iu;

function sha1(s) { return createHash('sha1').update(s).digest('hex'); }
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim(); }

export function familyOf(model) {
  const first = String(model).split(/[\s-]+/)[0];
  if (/^gpt/i.test(first)) return 'GPT';
  if (/^o[1-9]$/i.test(first)) return first.toLowerCase();
  return first;
}

// "Ollama v0.40.5-rc2" -> { product: "Ollama", version: "v0.40.5", prerelease: true }
export function parseToolTitle(title) {
  const m = String(title).match(/^(.*?)\s+(?:release\s+)?(v?\d[\w.]*(?:-[\w.]+)?|b\d{3,})(?:\s*[:(].*)?$/i);
  if (!m) return null;
  let product = m[1].replace(/\s+release$/i, '').trim();
  let version = m[2];
  const prerelease = PRERELEASE_RE.test(version);
  if (prerelease) version = version.replace(PRERELEASE_RE, '');
  if (!product) return null;
  return { product, version, prerelease };
}

// The model a news item is "about": earliest model name in the title, else the first tagged model.
export function primaryModel(item) {
  const inTitle = findModels(item.title);
  if (inTitle.length) {
    const low = item.title.toLowerCase();
    return inTitle
      .map(n => ({ n, i: low.indexOf(n.toLowerCase().replace(/ /g, ' ')) }))
      .sort((a, b) => (a.i < 0 ? 1e9 : a.i) - (b.i < 0 ? 1e9 : b.i) || (a.n < b.n ? -1 : 1))[0].n;
  }
  return item.models && item.models[0] ? item.models[0] : null;
}

function hfOrg(url) {
  const m = String(url).match(/^https:\/\/huggingface\.co\/([^/]+)\/[^/]+/);
  return m ? m[1] : null;
}

// items: news.json items; sources: config sources. Returns release records (unsorted, unmerged).
export function deriveReleases(items, sources) {
  const byId = new Map(sources.map(s => [s.id, s]));
  const out = [];
  for (const it of items) {
    const src = byId.get(it.sourceId);
    if (!src) continue;
    const isTool = it.kind === 'tool' && src.releaseKind;
    if (it.kind !== 'model-release' && !isTool) continue;
    // English display member: the rep itself or the first English folded duplicate.
    const members = [{ sourceId: it.sourceId, source: it.source, url: it.url, publishedAt: it.publishedAt }, ...(it.alsoIn || [])];
    const langOf = m => (byId.get(m.sourceId) || {}).lang;
    const main = members.find(m => langOf(m) === 'en');
    if (!main) continue;
    const pubs = members.map(m => m.publishedAt).filter(Boolean).sort();

    let model; let family; let kind; let company;
    let prerelease = false;
    if (isTool) {
      const p = parseToolTitle(it.title);
      if (!p) continue;
      model = `${p.product} ${p.version}`;
      family = p.product;
      kind = src.releaseKind;
      company = src.company || family; // never the tagger's guess: "llama.cpp" is not Meta's
      prerelease = p.prerelease;
    } else {
      model = primaryModel(it);
      if (!model) continue;
      family = familyOf(model);
      kind = /(?<![\p{L}\p{N}])datasets?(?![\p{L}\p{N}])/iu.test(it.title) ? 'dataset' : 'model';
      const org = hfOrg(it.url) || members.map(m => hfOrg(m.url)).find(Boolean);
      company = (org && HF_ORG_COMPANY[org.toLowerCase()])
        || FAMILY_COMPANY[family.toLowerCase().replace(/\d.*$/, '')]
        || src.company
        || (it.companies && it.companies[0])
        || null;
      if (!company) continue; // an unattributed model name is not a trustworthy release record
    }
    const text = `${it.title} ${it.summary || ''}`;
    let open = null;
    if (!isTool) {
      if (members.some(m => /^https:\/\/huggingface\.co\//.test(m.url))) open = true;
      else if (OPEN_YES_RE.test(text)) open = true;
      else if (OPEN_NO_RE.test(text)) open = false;
    }
    const others = members.filter(m => m.url !== main.url && langOf(m) === 'en').map(m => ({ source: m.source, url: m.url }));
    out.push({
      id: sha1(`${norm(company)}|${norm(model)}`).slice(0, 16),
      date: pubs[0] || it.publishedAt,
      company,
      model,
      family,
      kind,
      url: main.url,
      source: main.source,
      summary: clip(it.summary || it.title, 200),
      importance: typeof it.baseImportance === 'number' ? it.baseImportance : it.importance,
      open,
      alsoIn: others,
      _prerelease: prerelease,
    });
  }
  return out;
}

function betterRecord(a, b) {
  // a replaces b as the displayed record: a final over a pre-release, then higher importance.
  if (!!a._prerelease !== !!b._prerelease) return !a._prerelease;
  if (a.importance !== b.importance) return a.importance > b.importance;
  return a.url < b.url;
}

// derived: deriveReleases() output; prev: previous releases.json object or null.
export function buildReleases(derived, prev, nowMs, generatedAt) {
  const cutoff = nowMs - WINDOW_DAYS * 86400000;
  const byId = new Map();
  const prevList = prev && Array.isArray(prev.releases) ? prev.releases : [];
  const merge = (r) => {
    const cur = byId.get(r.id);
    if (!cur) { byId.set(r.id, { ...r }); return; }
    const best = betterRecord(r, cur) ? r : cur;
    const worse = best === r ? cur : r;
    const seen = new Set([best.url]);
    const alsoIn = [];
    for (const a of [{ source: worse.source, url: worse.url }, ...best.alsoIn, ...worse.alsoIn]) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      alsoIn.push({ source: a.source, url: a.url });
    }
    byId.set(r.id, {
      ...best,
      date: r.date < cur.date ? r.date : cur.date,
      importance: Math.max(r.importance, cur.importance),
      open: best.open !== null ? best.open : worse.open,
      alsoIn: alsoIn.slice(0, 10),
      _prerelease: best._prerelease,
    });
  };
  for (const p of prevList) merge({ ...p, _prerelease: false });
  for (const d of derived) merge(d);

  let list = [...byId.values()].filter(r => Date.parse(r.date) >= cutoff);
  // Tool / library trackers: only the newest few versions per product (a build number every few hours is noise).
  const perTool = new Map();
  list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1));
  list = list.filter(r => {
    if (r.kind !== 'tool' && r.kind !== 'library') return true;
    const k = `${r.company}|${r.family}`;
    const n = (perTool.get(k) || 0) + 1;
    perTool.set(k, n);
    return n <= MAX_PER_TOOL;
  });
  list = list.slice(0, MAX_RELEASES).map(({ _prerelease, ...r }) => r);
  return {
    schema: RELEASES_SCHEMA,
    schemaVersion: 1,
    generatedAt,
    windowDays: WINDOW_DAYS,
    count: list.length,
    releases: list,
  };
}
