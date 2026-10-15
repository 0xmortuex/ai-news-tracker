// Phase 3 entity and topic tagging. Deterministic, rule-based, no network, no LLM.
//
//   entitiesFor(item) -> [{ name, type: 'company' | 'model' | 'product' }]
//   tagsFor(item)     -> subset of TAGS (release, pricing, safety, research, policy, tooling)
//
// It builds on what the tagger (tag.mjs) already stored on an item (companies, models, kind,
// labels) and adds products and a few companies the Phase 1 tables do not know. It only ever
// reads fields of the item, so it works the same on a pool item and on a published news.json item.

import { wordRe } from './text.mjs';
import { LAUNCH_RE, VERSION_TOKEN_RE } from './taxonomy.mjs';

export const TAGS = ['release', 'pricing', 'safety', 'research', 'policy', 'tooling'];
export const ENTITY_TYPES = ['company', 'model', 'product'];

// canonical name -> aliases (whole words, case-insensitive unless listed in CASE_SENSITIVE)
export const PRODUCTS = {
  ChatGPT: ['chatgpt'],
  Codex: ['codex'],
  Sora: ['sora'],
  'Claude Code': ['claude code'],
  'GitHub Copilot': ['github copilot'],
  Copilot: ['copilot', 'microsoft copilot'],
  Cursor: ['cursor'],
  Windsurf: ['windsurf'],
  Devin: ['devin'],
  Midjourney: ['midjourney'],
  NotebookLM: ['notebooklm'],
  'Gemini CLI': ['gemini cli'],
  'Apple Intelligence': ['apple intelligence'],
  Ollama: ['ollama'],
  vLLM: ['vllm'],
  'llama.cpp': ['llama\\.cpp'],
  ComfyUI: ['comfyui'],
  LangChain: ['langchain'],
  LlamaIndex: ['llamaindex', 'llama index'],
  'Model Context Protocol': ['model context protocol', 'mcp'],
  'Hugging Face Hub': ['hugging face hub'],
};
const PRODUCT_CASE_SENSITIVE = new Set(['Cursor', 'Devin', 'Sora']);

// Companies that appear in the news but are not in taxonomy.COMPANIES (changing that table
// would change published `companies` values).
export const EXTRA_COMPANIES = {
  Midjourney: ['midjourney'],
  Databricks: ['databricks'],
  Salesforce: ['salesforce'],
  Samsung: ['samsung'],
  Intel: ['intel'],
  AMD: ['amd'],
  Huawei: ['huawei'],
  SoftBank: ['softbank'],
  'Scale AI': ['scale ai'],
  Anysphere: ['anysphere'],
  Runway: ['runway'],
  ElevenLabs: ['elevenlabs'],
  'Character.AI': ['character\\.ai'],
  'Thinking Machines': ['thinking machines'],
  'Safe Superintelligence': ['safe superintelligence', 'ssi'],
  Cerebras: ['cerebras'],
  Groq: ['groq'],
  'Together AI': ['together ai'],
  Replit: ['replit'],
  Figma: ['figma'],
};

const compile = table => Object.entries(table).map(([name, aliases]) => {
  const cs = PRODUCT_CASE_SENSITIVE.has(name);
  const list = cs ? aliases.map(a => a.charAt(0).toUpperCase() + a.slice(1)) : aliases;
  return [name, wordRe(list, cs ? 'u' : 'iu')];
});
const PRODUCT_RES = compile(PRODUCTS);
const EXTRA_COMPANY_RES = compile(EXTRA_COMPANIES);

const TAG_RULES = {
  pricing: new RegExp(
    '(?<![\\p{L}\\p{N}])(?:pric(?:e|es|ed|ing)|cheaper|free tier|free plan|subscriptions?|rate limits?|per million tokens|per 1m tokens|token costs?)(?![\\p{L}\\p{N}])'
    + '|\\$\\s?\\d+(?:\\.\\d+)?\\s?(?:/|per\\s)\\s?(?:month|mo|year|yr|million|1m|m tokens|seat|user)', 'iu'),
  safety: wordRe(['safety', 'alignment', 'jailbreaks?', 'red[- ]team\\w*', 'misuse', 'deepfakes?', 'interpretability', 'guardrails?', 'vulnerabilit\\w+', 'prompt injection', 'ai security', 'catastroph\\w+', 'existential']),
  research: wordRe(['arxiv', 'preprint', 'we propose', 'benchmarks?', 'researchers (?:find|show|propose|introduce)', 'paper', 'papers']),
  policy: wordRe(['regulat\\w*', 'ai act', 'executive order', 'legislation', 'lawsuit', 'sues?', 'copyright', 'export controls?', 'senate', 'congress', 'white house', 'european commission', 'eu commission', 'ban(?:s|ned)?', 'lawmakers?']),
  tooling: wordRe(['sdk', 'apis?', 'cli', 'mcp', 'plugins?', 'extensions?', 'libraries', 'library', 'frameworks?', 'ide', 'open[- ]source tool', 'agent framework', 'toolkit', 'runtime']),
};

function norm(s) {
  return String(s || '').normalize('NFKC').replace(/[‐-―−]/g, '-');
}

// item: { title, summary?, companies?, models?, kind?, labels?, sourceKind? }
export function entitiesFor(item) {
  const text = `${norm(item.title)} ${norm(item.summary)}`;
  const out = [];
  const seen = new Set();
  const add = (name, type) => {
    const k = `${type}:${String(name).toLowerCase()}`;
    if (!name || seen.has(k)) return;
    seen.add(k);
    out.push({ name, type });
  };
  for (const c of item.companies || []) add(c, 'company');
  for (const [name, re] of EXTRA_COMPANY_RES) if (re.test(text)) add(name, 'company');
  for (const m of item.models || []) add(m, 'model');
  for (const [name, re] of PRODUCT_RES) if (re.test(text)) add(name, 'product');
  return out;
}

export function entityNames(item) {
  const seen = new Set();
  const names = [];
  for (const e of entitiesFor(item)) {
    const k = e.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    names.push(e.name);
  }
  return names.slice(0, 16);
}

export function tagsFor(item) {
  const title = norm(item.title);
  const text = `${title} ${norm(item.summary)}`;
  const kind = item.kind || 'other';
  const labels = item.labels || [];
  const tags = [];
  const products = PRODUCT_RES.filter(([, re]) => re.test(text));

  const release = kind === 'model-release' || labels.includes('model-release')
    || (LAUNCH_RE.test(title) && ((item.models || []).length > 0 || products.length > 0))
    || (item.sourceKind === 'repo' && VERSION_TOKEN_RE.test(title));
  if (release) tags.push('release');
  if (TAG_RULES.pricing.test(text)) tags.push('pricing');
  if (kind === 'security' || labels.includes('safety') || TAG_RULES.safety.test(text)) tags.push('safety');
  if (kind === 'paper' || item.sourceKind === 'research' || TAG_RULES.research.test(title)) tags.push('research');
  if (kind === 'policy' || labels.includes('policy') || TAG_RULES.policy.test(title)) tags.push('policy');
  if (kind === 'tool' || TAG_RULES.tooling.test(title)) tags.push('tooling');
  return tags;
}
