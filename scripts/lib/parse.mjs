// Tolerant feed parsers. No dependencies: RSS 2.0, RSS 1.0/RDF, Atom, JSON Feed 1.x
// and the four JSON APIs the config uses (Hugging Face models/papers, HN Algolia,
// Federal Register). Every parser returns raw items:
//   { title, link, summary, published, categories[], author, engagement, extra }
// `summary` is plain text (tags stripped); `published` is an ISO string or null.

import { decodeEntities, stripTags } from './text.mjs';

export function parseDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    // "15 Oct 2026 13:17 +0000" and RFC 822 with a zone name Node does not know.
    const m = s.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)(?:\s*([+-]\d{4}|Z|UTC|GMT))?/);
    if (m) {
      const zone = m[2] && /^[+-]\d{4}$/.test(m[2]) ? m[2] : 'Z';
      t = Date.parse(`${m[1]} ${zone === 'Z' ? 'GMT' : zone}`);
    }
  }
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function unwrap(raw) {
  const m = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (m) return m[1];
  // CDATA mixed with text: unwrap each section, decode only the rest.
  if (raw.includes('<![CDATA[')) {
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+|<)/g, (all, cdata, other) => (cdata !== undefined ? cdata : decodeEntities(other)));
  }
  return decodeEntities(raw);
}

function tagText(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m ? unwrap(m[1]) : null;
}

function allTagText(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(unwrap(m[1]));
  return out;
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : null;
}

function pickLink(block) {
  const re = /<link\b([^>]*?)(?:\/>|>([\s\S]*?)<\/link>)/gi;
  let m;
  while ((m = re.exec(block))) {
    const attrs = m[1] || '';
    const href = attr(attrs, 'href');
    const rel = attr(attrs, 'rel');
    const text = m[2] !== undefined ? unwrap(m[2]).trim() : '';
    const candidate = href || text;
    if (!candidate) continue;
    if (href && rel && rel !== 'alternate') continue; // skip rel=self/enclosure/replies
    return candidate.trim();
  }
  return null;
}

export function parseXmlFeed(text) {
  let xml = String(text).replace(/^﻿/, '');
  const items = [];
  const re = /<(item|entry)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[3];
    const title = stripTags(tagText(b, 'title') || '');
    let link = pickLink(b);
    if (!link) {
      const guid = tagText(b, 'guid');
      if (guid && /^https?:\/\//i.test(guid.trim())) link = guid.trim();
    }
    const rawSummary = tagText(b, 'description') ?? tagText(b, 'summary') ?? tagText(b, 'content:encoded') ?? tagText(b, 'content') ?? '';
    const published = parseDate(
      tagText(b, 'pubDate') ?? tagText(b, 'published') ?? tagText(b, 'dc:date') ?? tagText(b, 'updated') ?? tagText(b, 'date'),
    );
    const cats = [];
    for (const c of allTagText(b, 'category')) cats.push(stripTags(c));
    const catRe = /<category\b[^>]*\bterm\s*=\s*("([^"]*)"|'([^']*)')[^>]*\/?>/gi;
    let cm;
    while ((cm = catRe.exec(b))) cats.push(decodeEntities(cm[2] ?? cm[3]));
    const author = stripTags(tagText(b, 'dc:creator') || tagText(b, 'author') || tagText(b, 'name') || '');
    items.push({
      title,
      link: link || '',
      summary: stripTags(rawSummary),
      rawSummary,
      published,
      categories: cats.filter(Boolean),
      author,
      engagement: 0,
      extra: {},
    });
  }
  return items;
}

export function parseJsonFeed(obj) {
  const arr = Array.isArray(obj.items) ? obj.items : [];
  return arr.map(it => ({
    title: stripTags(it.title || ''),
    link: it.url || it.external_url || '',
    summary: stripTags(it.summary || it.content_text || it.content_html || ''),
    rawSummary: '',
    published: parseDate(it.date_published || it.date_modified),
    categories: Array.isArray(it.tags) ? it.tags.map(String) : [],
    author: it.authors && it.authors[0] ? String(it.authors[0].name || '') : '',
    engagement: 0,
    extra: {},
  }));
}

// Autodetect: JSON Feed, otherwise XML (RSS/Atom/RDF). Throws on unparseable input.
export function parseFeed(text) {
  const t = String(text).replace(/^﻿/, '').trimStart();
  if (t.startsWith('{')) {
    let obj;
    try { obj = JSON.parse(t); } catch (e) { throw new Error(`invalid JSON feed: ${e.message}`); }
    if (!obj || !Array.isArray(obj.items)) throw new Error('JSON document is not a JSON Feed (no items array)');
    return parseJsonFeed(obj);
  }
  if (!/<(rss|feed|rdf:RDF|channel)\b/i.test(t.slice(0, 4000)) && !/<(item|entry)\b/i.test(t)) {
    throw new Error('not an RSS/Atom feed (no rss/feed/channel element)');
  }
  return parseXmlFeed(t);
}

// --- JSON APIs -----------------------------------------------------------

function json(text, what) {
  try { return JSON.parse(text); } catch (e) { throw new Error(`invalid ${what} JSON: ${e.message}`); }
}

const QUANT_RE = /(?:^|[-_.])(gguf|awq|gptq|bnb|mlx|int4|int8|nf4|4bit|8bit|quantized?|onnx|exl2)(?:$|[-_.])/i;

export function parseHfModels(text, src = {}) {
  const arr = json(text, 'Hugging Face models');
  if (!Array.isArray(arr)) throw new Error('Hugging Face models response is not an array');
  const out = [];
  for (const m of arr) {
    const id = m.id || m.modelId;
    if (!id || typeof id !== 'string') continue;
    if (QUANT_RE.test(id)) continue;
    const bits = [];
    if (m.pipeline_tag) bits.push(m.pipeline_tag);
    if (typeof m.likes === 'number') bits.push(`${m.likes} likes`);
    if (typeof m.downloads === 'number') bits.push(`${m.downloads} downloads`);
    out.push({
      title: `New model on Hugging Face: ${id}`,
      link: `https://huggingface.co/${id}`,
      summary: bits.join(' · '),
      rawSummary: '',
      published: parseDate(m.createdAt || m.lastModified),
      categories: Array.isArray(m.tags) ? m.tags.slice(0, 8).map(String) : [],
      author: id.includes('/') ? id.split('/')[0] : '',
      engagement: 0,
      extra: { modelId: id, hf: true },
    });
  }
  return out;
}

export function parseHfPapers(text) {
  const arr = json(text, 'Hugging Face papers');
  if (!Array.isArray(arr)) throw new Error('Hugging Face papers response is not an array');
  const out = [];
  for (const e of arr) {
    const p = e.paper || e;
    const id = p.id;
    const title = stripTags(e.title || p.title || '');
    if (!id || !title) continue;
    out.push({
      title,
      link: `https://huggingface.co/papers/${id}`,
      summary: stripTags(e.summary || p.summary || ''),
      rawSummary: '',
      published: parseDate(e.publishedAt || p.publishedAt || p.submittedOnDailyAt),
      categories: [],
      author: '',
      engagement: Number.isFinite(p.upvotes) ? p.upvotes : 0,
      extra: { hfPaper: true },
    });
  }
  return out;
}

export function parseHnAlgolia(text) {
  const o = json(text, 'HN Algolia');
  if (!o || !Array.isArray(o.hits)) throw new Error('HN Algolia response has no hits array');
  const out = [];
  for (const h of o.hits) {
    const title = stripTags(h.title || h.story_title || '');
    if (!title) continue;
    out.push({
      title,
      link: h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : ''),
      summary: `${h.points || 0} points · ${h.num_comments || 0} comments on Hacker News`,
      rawSummary: '',
      published: parseDate(h.created_at),
      categories: [],
      author: '',
      engagement: Number.isFinite(h.points) ? h.points : 0,
      extra: { hn: true },
    });
  }
  return out;
}

export function parseFederalRegister(text) {
  const o = json(text, 'Federal Register');
  if (!o || !Array.isArray(o.results)) throw new Error('Federal Register response has no results array');
  return o.results.map(r => ({
    title: stripTags(r.title || ''),
    link: r.html_url || '',
    summary: stripTags(r.abstract || ''),
    rawSummary: '',
    published: parseDate(r.publication_date),
    categories: r.type ? [String(r.type)] : [],
    author: '',
    engagement: 0,
    extra: {},
  })).filter(r => r.title && r.link);
}

export const PARSERS = {
  feed: text => parseFeed(text),
  'hf-models': parseHfModels,
  'hf-papers': parseHfPapers,
  'hn-algolia': parseHnAlgolia,
  'federal-register': parseFederalRegister,
};

export function parseBody(format, text, src) {
  const p = PARSERS[format];
  if (!p) throw new Error(`unknown source format "${format}"`);
  return p(text, src);
}
