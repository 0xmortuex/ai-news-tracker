// Rule tables for tagging, relevance filters and scoring. Plain data + regexes,
// no LLM. Matching runs on lower-cased NFKC text of title + summary.

import { wordRe } from './text.mjs';

// ---- companies (entity tag; multi-valued, not exclusive) -------------------
// canonical name -> aliases (matched as whole words, case-insensitive)
export const COMPANIES = {
  OpenAI: ['openai', 'chatgpt', 'gpt-\\d[\\w.]*', 'sora', 'codex'],
  Anthropic: ['anthropic', 'claude', 'claude code'],
  Google: ['google', 'gemini', 'gemma', 'alphabet'],
  'Google DeepMind': ['deepmind', 'google deepmind'],
  Meta: ['meta ai', 'llama', 'meta platforms'],
  Microsoft: ['microsoft', 'copilot', 'azure', 'phi-\\d[\\w.]*'],
  Mistral: ['mistral', 'mixtral', 'le chat'],
  xAI: ['xai', 'x\\.ai', 'grok'],
  NVIDIA: ['nvidia', 'nemotron', 'blackwell', 'cuda'],
  Apple: ['apple intelligence', 'apple'],
  Amazon: ['amazon', 'aws', 'bedrock', 'trainium'],
  Cohere: ['cohere'],
  Perplexity: ['perplexity'],
  DeepSeek: ['deepseek'],
  Alibaba: ['alibaba', 'qwen', 'tongyi'],
  Moonshot: ['moonshot', 'kimi'],
  Zhipu: ['zhipu', 'z\\.ai', 'glm-?\\d[\\w.]*', 'chatglm'],
  ByteDance: ['bytedance', 'doubao', 'seedance'],
  Baidu: ['baidu', 'ernie'],
  Tencent: ['tencent', 'hunyuan'],
  MiniMax: ['minimax'],
  'Hugging Face': ['hugging face', 'huggingface'],
  'Stability AI': ['stability ai', 'stable diffusion'],
};

// Capitalised-only aliases: too common as lower-case words.
export const COMPANIES_CASE_SENSITIVE = {
  Meta: ['Meta'],
  Apple: ['Apple'],
  Google: ['Google'],
};

const COMPANY_RES = Object.entries(COMPANIES).map(([name, aliases]) => [name, wordRe(aliases)]);
const COMPANY_CS_RES = Object.entries(COMPANIES_CASE_SENSITIVE).map(([name, aliases]) => [name, wordRe(aliases, 'u')]);

export function findCompanies(text, original = text) {
  const out = new Set();
  for (const [name, re] of COMPANY_RES) {
    if (name === 'Meta' || name === 'Apple') continue; // handled by the case-sensitive pass below
    if (re.test(text)) out.add(name);
  }
  for (const [name, re] of COMPANY_CS_RES) {
    if (name === 'Google') continue;
    if (re.test(original)) out.add(name);
  }
  if (/(^|\W)meta ai(\W|$)|\bllama\b/i.test(text)) out.add('Meta');
  if (/apple intelligence/i.test(text)) out.add('Apple');
  if (out.has('Google DeepMind')) out.add('Google');
  return [...out].sort();
}

// ---- model names -----------------------------------------------------------
const FAMILIES = [
  'GPT', 'o[1-9]', 'Claude', 'Gemini', 'Gemma', 'Llama', 'Qwen\\d*(?:\\.\\d+)?', 'DeepSeek', 'Kimi', 'GLM', 'Grok', 'Mistral', 'Mixtral',
  'Magistral', 'Devstral', 'Ministral', 'Pixtral', 'Phi', 'Nemotron', 'Sora', 'Veo', 'Imagen', 'Opus', 'Sonnet', 'Haiku', 'Hunyuan', 'ERNIE',
  'Doubao', 'MiniMax', 'Seedance', 'Flux', 'Command', 'Granite', 'Olmo', 'SmolLM\\d*', 'Yi', 'InternVL\\d*', 'InternLM\\d*',
  // Phase 2: lab brands seen in the live data. These words are ordinary English too, so a match
  // must start with a capital letter (BRAND_FAMILIES below) and be followed by a version/variant.
  'Muse', 'Fable', 'Mythos', 'Jais', 'LFM\\d*(?:\\.\\d+)?', 'Falcon', 'Apertus', 'OmniHuman', 'Kling', 'Wan', 'Ling', 'Ring',
  'Whisper', 'Nova', 'Seedream', 'Intern-?S', 'EmbeddingGemma',
];
// Families whose bare names are ordinary words: only count when written with a capital initial.
const BRAND_FAMILIES = new Set(['muse', 'fable', 'mythos', 'falcon', 'kling', 'wan', 'ling', 'ring', 'whisper', 'nova', 'flux']);
const VARIANT = '(?:v?\\d+(?:\\.\\d+)*[a-z]?|mini|nano|pro|flash|ultra|turbo|thinking|instruct|opus|sonnet|haiku|max|lite|air|plus|vl|coder|omni|preview|large|small|medium|high|image|vision|codex|reasoner|chat|base|r\\d|k\\d(?:\\.\\d+)?' +
  '|spark|wonder|full|open|super|bolt|klein|argon|carbon|sol|astra|ultrafast|asr|tts|live|rerank|embed|fable|mythos)';
const MODEL_STRICT_RE = new RegExp(`(?<![\\p{L}\\p{N}_-])(${FAMILIES.join('|')})((?:[ -]${VARIANT}){1,3})(?![\\p{L}\\p{N}])`, 'giu');
const HYPHEN_FAMILIES = new Set(['gpt', 'glm', 'deepseek', 'phi', 'o1', 'o3', 'o4']);

function titleCaseFamily(f) {
  const l = f.toLowerCase();
  const special = { gpt: 'GPT', glm: 'GLM', deepseek: 'DeepSeek', xai: 'xAI', ernie: 'ERNIE', minimax: 'MiniMax', gemini: 'Gemini' };
  if (special[l]) return special[l];
  if (/^o[1-9]$/.test(l)) return l;
  if (/^[A-Z]{4,}$/.test(f) && !/^(LFM|ERNIE)/.test(f)) return f.charAt(0) + f.slice(1).toLowerCase(); // "MUSE", "FLUX"
  return f.charAt(0).toUpperCase() + f.slice(1);
}

// Returns canonical model names found in text, e.g. ["GPT-5.5", "Claude Opus 4.5"].
export function findModels(text) {
  const out = new Set();
  MODEL_STRICT_RE.lastIndex = 0;
  let m;
  while ((m = MODEL_STRICT_RE.exec(text))) {
    if (BRAND_FAMILIES.has(m[1].toLowerCase()) && !/^[A-Z]/.test(m[1])) continue;
    const family = titleCaseFamily(m[1]);
    const rest = m[2].trim().split(/[ -]+/).filter(Boolean).map(t => (/^\d+(?:\.\d+)?[bm]$/i.test(t) ? t.toUpperCase()
      : /^(vl|asr|tts|moe|ocr)$/i.test(t) ? t.toUpperCase()
      : /^\d/.test(t) || /^v\d/i.test(t) ? t.toLowerCase() : t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()));
    if (!rest.length) continue;
    // A bare variant word without a number is only a model for strong families.
    const hasNumber = rest.some(t => /\d/.test(t));
    const strong = /^(claude|gemini|gpt|llama|qwen|deepseek|grok|kimi|glm|mistral|gemma|phi|nemotron|muse|jais|falcon|apertus|lfm|flux|embeddinggemma|omnihuman|fable|mythos)/i.test(family);
    if (!hasNumber && !strong) continue;
    if (/^falcon$/i.test(family) && /^9$/.test(rest[0])) continue; // SpaceX Falcon 9
    let name;
    if (HYPHEN_FAMILIES.has(family.toLowerCase()) && /^\d|^v\d/.test(rest[0])) name = `${family}-${rest.join('-')}`;
    else name = `${family} ${rest.join(' ')}`;
    out.add(name.replace(/-(Mini|Nano|Pro|Flash|Ultra|Turbo|Thinking|Instruct)/g, '-$1'));
  }
  // Bare, numbered family names without a separator: "GPT5", "Qwen3", "Llama4".
  const bare = /(?<![\p{L}\p{N}_-])(GPT|Qwen|Llama|Gemini|DeepSeek|Grok|Kimi|GLM|Gemma)(\d+(?:\.\d+)*)(?![\p{L}\p{N}])/giu;
  while ((m = bare.exec(text))) {
    const family = titleCaseFamily(m[1]);
    out.add(HYPHEN_FAMILIES.has(family.toLowerCase()) ? `${family}-${m[2]}` : `${family} ${m[2]}`);
  }
  // Hugging Face repo paths: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B" (the hyphen before the
  // family blocks the strict pass above, and "llm-gemini 0.35" must keep failing, so only repo paths are rewritten).
  const repo = /(?<![\w.-])[\w.-]+\/([\w.-]+)/g;
  while ((m = repo.exec(text))) {
    const spaced = m[1].replace(/^(?:NVIDIA|nvidia|Qwen|google|meta|mistral)-/, '').replace(/-/g, ' ');
    for (const n of findModels(spaced)) out.add(n);
  }
  // "Step-5-Preview" (hyphenated only: "Step 3" is a tutorial step), distinct -stral names ("Timestral-123M").
  const step = /(?<![\p{L}\p{N}_-])(Step-\d+(?:\.\d+)?(?:-[A-Z][a-z]+)?)(?![\p{L}\p{N}])/gu;
  while ((m = step.exec(text))) out.add(m[1]);
  const stral = /(?<![\p{L}\p{N}_/-])((?!Mistral(?![\p{L}]))[A-Z][a-z]{2,}stral(?:-[\p{L}\p{N}.]+)?)(?![\p{L}])/gu;
  while ((m = stral.exec(text))) out.add(m[1]);
  // Case-insensitive dedupe ("MUSE Spark Open" / "Muse Spark Open"): keep the first spelling seen.
  const seen = new Set();
  return [...out].filter(n => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).sort();
}

// Distinct lab brands: a mention is already a model name even without a version number
// ("Introducing Timestral", "Muse Spark Open", "Jais 3 is out"). Capitalised only.
export const BRAND_RE = new RegExp(
  '(?<![\\p{L}\\p{N}_-])(?:' + [
    '(?!Mistral(?![\\p{L}]))[A-Z][a-z]{2,}stral',
    'Muse[ -](?:Spark|Wonder|Pro|Open|Full|\\d)\\w*',
    'Nemotron', 'Jais(?:[ -]\\d+)?', 'LFM\\d(?:\\.\\d+)?', 'Apertus', 'EmbeddingGemma', 'OmniHuman', 'Seedream', 'Seedance',
    'Falcon(?:[ -](?:ASR|TTS|H1|Mamba|OCR|Vision|Edge|\\d+B))', 'Flux[ .-]?\\d(?:\\.\\d+)?', 'FLUX', 'Step-\\d',
    'Kling[ -]\\d', 'Wan[ -]\\d(?:\\.\\d+)?', 'Intern-?S\\d', 'Ling-\\d', 'Ring-\\d', 'Qwen[- ]?Image', 'Hunyuan[\\w-]*',
    'Claude (?:Fable|Mythos)', 'Matrix-Game',
  ].join('|') + ')(?![\\p{L}\\p{N}])',
  'u',
);
// Parameter-count tokens: "74B-A9B", "120B", "35B3A", "135M". Not money ("$16B").
export const SIZE_RE = /(?<![\p{L}\p{N}$€£.,])(?:\d{1,4}(?:\.\d+)?B|(?:[2-9]\d|\d{3})M)(?:[- ]?A\d+(?:\.\d+)?B|\d+A)?(?![\p{L}\p{N}])/u;

// Model name patterns used by the release / version-bump rules.
export const MODEL_NAME_RE = /(?<![\p{L}\p{N}_-])(?:gpt|claude|gemini|llama|qwen|deepseek|kimi|glm|grok|mistral|mixtral|phi|gemma|nemotron|sora|veo)(?:[ -](?:mini|nano|pro|flash|ultra|turbo|opus|sonnet|haiku|max|lite|air|plus|large|small|medium|high|image|vision)){0,2}[- ]?v?\d/iu;
export const O_SERIES_RE = /(?<![\p{L}\p{N}])o[1-9](?![\p{L}\p{N}])/iu;
export const VERSION_TOKEN_RE = /(?<![\p{L}\p{N}])v\d+(?:\.\d+)*(?![\p{L}\p{N}])/iu;
export const VERSION_BUMP_RE = /(?<![\p{L}\p{N}])(?:gpt-?\d|claude[ -]\w+[ -]\d|claude[ -]\d|gemini[ -]\d|llama[ -]?\d|qwen[ -]?\d|deepseek[- ]?[vr]?\d|grok[ -]?\d|kimi[ -]?k?\d|glm-?\d|mistral[ -]\w+[ -]?\d)/iu;
export const LAUNCH_RE = wordRe([
  'launch(?:es|ed|ing)?', 'releas(?:es|ed|ing)', 'introduc(?:es|ed|ing)', 'unveil(?:s|ed|ing)', 'announc(?:es|ed|ing)',
  'rolls? out', 'rolling out', 'now available', 'debuts?', 'open[- ]sourc(?:es|ed)', 'new model', 'is here',
  // Phase 2: community and blog phrasings of the same event.
  'is out', 'now out', 'is live', 'now live', 'goes live', 'begins rolling out', 'ships?', 'shipped', 'drops?', 'dropped',
  'welcome', 'release notes', 'expands? (?:[\\w-]+ ){0,3}family',
  // Turkish
  'kullan\u0131ma sund\\w*', 'kullan\u0131ma a\u00e7\\w*', 'tan\u0131tt\\w*', 'duyurdu', 'yay\u0131nlad\\w*', 'piyasaya s\u00fcrd\\w*',
]);

// Funding needs a money/deal signal; bare "raises" or "billion" is too noisy
// ("GLM-5.3 raises researcher fears").
export const FUNDING_RE = new RegExp(
  [
    '(?<![\\p{L}\\p{N}])(?:raises?|raised|secures?|lands?|closes?|bags?)\\s+(?:an?\\s+)?(?:up to\\s+)?(?:[$\u20ac\u00a3]|us\\$)?\\s?\\d',
    '(?<![\\p{L}\\p{N}])series [a-e](?![\\p{L}\\p{N}])',
    '(?<![\\p{L}\\p{N}])(?:funding round|seed funding|in funding|valuation|acquir(?:es|ed|ing)|acquisitions?|ipo|tender offer)(?![\\p{L}\\p{N}])',
    '(?<![\\p{L}\\p{N}])invest(?:s|ed|ing|ment)?\\s+(?:of\\s+|in\\s+)?(?:[$\u20ac\u00a3]|us\\$)\\s?\\d',
    'yat[\u0131i]r[\u0131i]m\\s+al[\u0131i]\\w*|milyon dolar\\w*\\s+yat[\u0131i]r[\u0131i]m|milyar dolar\\w*\\s+(?:de\u011ferleme|yat[\u0131i]r[\u0131i]m)',
  ].join('|'),
  'iu',
);

// ---- topic / label rules (the report's table) ------------------------------
// weight is added once when any alternative matches.
export const LABEL_RULES = [
  { label: 'research', weight: 2, re: wordRe(['arxiv', '(?<!toilet )paper', '(?<!toilet )papers', 'benchmark', 'we propose', 'preprint', 'neurips', 'icml', 'iclr', 'acl', 'emnlp', 'study', 'researchers']) },
  { label: 'open-source', weight: 2, re: wordRe(['open[- ]?source', 'open[- ]?weights?', 'apache 2(?:\\.0)?', 'mit license', 'hugging ?face', 'github', 'gguf', 'llama\\.cpp', 'ollama', 'vllm', 'comfyui']) },
  { label: 'policy', weight: 2, re: wordRe(['regulat\\w*', 'ai act', 'executive order', 'congress', 'senate', 'lawsuit', 'sues?', 'copyright', 'ban(?:s|ned)?', 'export controls?', 'nist', 'eu commission', 'european commission', 'aisi', 'cac', 'legislation', 'bill', 'ftc', 'doj', 'probes?', 'lawmakers?', 'civil investigative demands?', 'usage polic(?:y|ies)', 'kvkk', 'yasa\\w*', 'd\\u00fczenleme\\w*', 'white house', 'federal register']) },
  { label: 'hardware', weight: 2, re: wordRe(['gpus?', 'h100', 'h200', 'b200', 'gb200', 'blackwell', 'rubin', 'tpus?', 'trainium', 'chips?', 'datacenters?', 'data centers?', 'hbm', 'cuda', 'inference cost', 'gigawatts?', 'semiconductors?', '\\u00e7ip\\w*']) },
  { label: 'funding', weight: 2, re: FUNDING_RE },
  { label: 'safety', weight: 2, re: wordRe(['safety', 'alignment', 'jailbreaks?', 'red[- ]team\\w*', 'misuse', 'deepfakes?', 'interpretability', 'ai security', 'guardrails?', 'risks?', 'g\\u00fcvenlik\\w*', 'vulnerabilit\\w+']) },
  { label: 'tools', weight: 1, re: wordRe(['app', 'apps', 'feature', 'features', 'agents?', 'agentic', 'copilot', 'assistant', 'plugins?', 'api', 'sdk', 'pricing', 'integrations?', 'browser', 'ide', 'codex', 'chatgpt', 'gemini app', 'claude code', 'cli', 'release[sd]?']) },
  { label: 'china', weight: 2, re: /(?<![\p{L}\p{N}])(?:china|chinese|beijing|shenzhen|shanghai|alibaba|tencent|baidu|bytedance|huawei|deepseek|qwen|kimi|zhipu|minimax|moonshot)(?![\p{L}\p{N}])|中国|大模型|人工智能/iu },
  { label: 'turkey', weight: 2, re: wordRe(['t\\u00fcrkiye', 'turkiye', 'turkish', 'turkcell', 't\\u00fcrk telekom', 'baykar', 'aselsan', 'trendyol', 'yapay zek\\w+', 't\\u00fcbitak', 'bilkent']) },
];
// "model-release" is computed (verb AND model pattern), see tag.mjs.

// ---- relevance filter presets for general-purpose feeds --------------------
export const FILTERS = {
  ai: {
    include: wordRe(['ai', 'a\\.i\\.', 'artificial intelligence', 'machine learning', 'llms?', 'large language models?', 'generative', 'genai', 'gpt[\\w.-]*', 'chatgpt', 'openai', 'anthropic', 'claude', 'gemini', 'deepmind', 'copilot', 'neural', 'deep learning', 'chatbots?', 'agentic', 'ai agents?', 'diffusion', 'foundation models?', 'deepseek', 'qwen', 'kimi', 'mistral', 'nvidia', 'robot\\w*', 'humanoids?']),
  },
  'ai-tr': {
    include: wordRe(['yapay zek\\w+', 'ai', 'chatgpt', 'gemini', 'claude', 'copilot', 'llms?', 'openai', 'anthropic', 'deepseek', 'b\\u00fcy\\u00fck dil model\\w*', '\\u00fcretken', 'grok', 'nvidia', 'robot\\w*']),
  },
  arxiv: {
    // Hard filter: LLM-centric terms only, "new" announcements only.
    include: wordRe(['large language models?', 'llms?', 'language models?', 'foundation models?', 'agentic', 'ai agents?', 'llm agents?', 'reasoning models?', 'rlhf', 'rlvr', 'grpo', 'mixture[- ]of[- ]experts', 'vision[- ]language', 'multimodal (?:llms?|models?)', 'jailbreak\\w*', 'instruction[- ]tun\\w+', 'in-context learning', 'chain[- ]of[- ]thought', 'retrieval[- ]augmented', 'tool use', 'ai safety', 'scaling laws?']),
    requireAnnounceNew: true,
  },
};

export function passesFilter(presetName, title, summary, rawSummary = '') {
  if (!presetName) return { ok: true, score: 0 };
  const preset = FILTERS[presetName];
  if (!preset) throw new Error(`unknown filter preset "${presetName}"`);
  const text = `${title} ${summary}`.normalize('NFKC');
  if (preset.requireAnnounceNew) {
    const m = String(rawSummary || summary).match(/Announce Type:\s*([\w-]+)/i);
    if (m && m[1].toLowerCase() !== 'new') return { ok: false, score: 0 };
  }
  const re = new RegExp(preset.include.source, preset.include.flags.includes('g') ? preset.include.flags : preset.include.flags + 'g');
  const hits = text.match(re);
  return { ok: !!hits, score: hits ? new Set(hits.map(h => h.toLowerCase())).size : 0 };
}
