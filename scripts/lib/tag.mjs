// Rule-based tagging: kind, labels, topics, companies, models. No LLM, deterministic.

import {
  LABEL_RULES, LAUNCH_RE, MODEL_NAME_RE, O_SERIES_RE, VERSION_TOKEN_RE,
  findCompanies, findModels,
} from './taxonomy.mjs';

// Label -> contract `topics` value (additive vocabulary; see docs/CONTRACT.md).
const LABEL_TO_TOPIC = {
  'model-release': 'llm',
  research: 'research',
  'open-source': 'open-weights',
  policy: 'regulation',
  hardware: 'chips',
  funding: 'funding',
  safety: 'safety',
  tools: 'tools',
  china: 'china',
  turkey: 'turkey',
};

// Tie-break order when several labels apply (report section 3):
// model release > policy > funding > research.
const KIND_PRIORITY = ['model-release', 'policy', 'funding', 'research', 'safety', 'tools'];

const OPINION_RE = /(?<![\p{L}\p{N}])(?:opinion|essay|commentary|column|the case for|my take|i think)(?![\p{L}\p{N}])/iu;
const SECURITY_RE = /(?<![\p{L}\p{N}])(?:vulnerabilit\w+|cve-\d+|exploit\w*|breach\w*|data leak|prompt injection|malware|supply chain attack)(?![\p{L}\p{N}])/iu;
const DEV_TOOL_RE = /(?<![\p{L}\p{N}])(?:api|sdk|cli|library|framework|open[- ]source|github|plugin|package|mcp|runtime|compiler|toolkit)(?![\p{L}\p{N}])/iu;
const PRODUCT_RE = /(?<![\p{L}\p{N}])(?:app|apps|feature|features|pricing|subscription|assistant|copilot|browser|device|devices|wearables?|launches?|rolls? out|available)(?![\p{L}\p{N}])/iu;
const FUNDING_STRONG_RE = /(?<![\p{L}\p{N}])(?:raises?|raised|series [a-e]|valuation|acquir\w+|ipo|funding round|yatırım)/iu;

// A model release needs a launch verb AND a model name:
//  - verb in the title with a model name in title or summary, or
//  - a model name in the title with a verb in the summary, or
//  - "model" + a version token in a title that has a verb.
export function isModelRelease(title, summary = '') {
  const verbInTitle = LAUNCH_RE.test(title);
  const nameInTitle = MODEL_NAME_RE.test(title) || O_SERIES_RE.test(title);
  const nameInSummary = MODEL_NAME_RE.test(summary) || O_SERIES_RE.test(summary);
  if (verbInTitle && (nameInTitle || nameInSummary)) return true;
  if (nameInTitle && LAUNCH_RE.test(summary)) return true;
  if (verbInTitle && /(?<![\p{L}\p{N}])model(?![\p{L}\p{N}])/iu.test(title) && VERSION_TOKEN_RE.test(title)) return true;
  return false;
}

// "Gemini 4 Argon: Built to ..." on a company's own blog is the announcement.
function startsWithModel(title) {
  const m = MODEL_NAME_RE.exec(title);
  return !!m && m.index <= 3;
}

// item: { title, summary, extra? }, source: config entry. Returns tag fields.
export function tagItem(item, source = {}) {
  const title = String(item.title || '').normalize('NFKC');
  const summary = String(item.summary || '').normalize('NFKC');
  const original = `${title} ${summary}`;
  const text = original.toLowerCase();
  const score = new Map();
  const add = (label, w) => score.set(label, (score.get(label) || 0) + w);

  const isRepoTool = source.sourceKind === 'repo' && (source.prior || {}).kind === 'tool';
  const prior = source.prior || {};
  const modelRelease = !isRepoTool && (isModelRelease(title, summary)
    || (source.sourceKind === 'company' && source.tier <= 2 && startsWithModel(title)));
  if (modelRelease) add('model-release', 3);
  for (const r of LABEL_RULES) {
    if (r.re.test(original)) add(r.label, r.weight);
  }

  // Source priors (report: arXiv = research, HF models = model-release/open-source, Webrazzi = Turkey).
  if (prior.kind === 'paper' || source.sourceKind === 'research') add('research', 2);
  if (prior.kind === 'model-release') { add('model-release', 4); add('open-source', 2); }
  if (prior.kind === 'policy' || source.category === 'policy') add('policy', 2);
  if (isRepoTool) { add('tools', 2); add('open-source', 1); }
  if (source.country === 'CN') add('china', 2);
  if (source.lang === 'tr') add('turkey', 2);
  if (source.sourceKind === 'company') add('tools', 1);

  const labels = [...score.entries()]
    .filter(([, s]) => s >= 1)
    .sort((a, b) => b[1] - a[1] || KIND_PRIORITY.indexOf(a[0]) - KIND_PRIORITY.indexOf(b[0]) || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([l]) => l);

  // kind: tie-break order over ALL matched labels (not only the top 3).
  const matched = new Set(score.keys());
  let kind = 'other';
  if (isRepoTool) kind = 'tool';
  else if (matched.has('model-release') && score.get('model-release') >= 3) kind = 'model-release';
  else if (SECURITY_RE.test(text) && matched.has('safety')) kind = 'security';
  else if (matched.has('policy') && score.get('policy') >= 2 && prior.kind !== 'model-release') kind = 'policy';
  else if (matched.has('funding') && FUNDING_STRONG_RE.test(original)) kind = 'funding';
  else if (matched.has('research') && (prior.kind === 'paper' || source.sourceKind === 'research' || /arxiv|paper|preprint|we propose/.test(text))) kind = 'paper';
  else if (LAUNCH_RE.test(title) || PRODUCT_RE.test(title) || (source.sourceKind === 'company' && matched.has('tools'))) {
    kind = DEV_TOOL_RE.test(title) && source.sourceKind !== 'company' ? 'tool' : 'product';
  } else if (OPINION_RE.test(original)) kind = 'opinion';
  else if (DEV_TOOL_RE.test(title)) kind = 'tool';

  // Companies and models: title wins; fall back to the summary only when the
  // title names none (summaries often mention competitors for comparison).
  const companies = new Set(findCompanies(title.toLowerCase(), title));
  if (companies.size === 0) for (const c of findCompanies(text, original).slice(0, 3)) companies.add(c);
  if (source.company) companies.add(source.company);

  let models = findModels(title);
  if (models.length === 0) models = findModels(summary).slice(0, 2);
  if (item.extra && item.extra.modelId) {
    const name = String(item.extra.modelId).split('/').pop();
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (name) models = [name, ...models.filter(m => norm(m) !== norm(name))];
  }

  const topics = [];
  for (const l of labels) {
    const t = LABEL_TO_TOPIC[l];
    if (t && !topics.includes(t)) topics.push(t);
  }
  if (/(?<![\p{L}\p{N}])(?:agents?|agentic|mcp|computer use)(?![\p{L}\p{N}])/iu.test(original) && !topics.includes('agents')) topics.push('agents');
  if (kind === 'model-release' && !topics.includes('llm')) topics.push('llm');

  return {
    kind,
    labels: labels.length ? labels : ['general'],
    topics,
    companies: [...companies].sort(),
    models: models.slice(0, 5),
  };
}
