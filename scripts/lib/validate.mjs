// Minimal JSON Schema validator (draft 2020-12 subset) for docs/news.schema.json:
// type, enum, const, required, properties, items, minimum, maximum, minLength,
// maxLength, minItems, maxItems, pattern, format (date-time, uri only), and
// $ref to "#/$defs/<name>". Unknown keywords are ignored by design.
// Returns an array of error strings (empty when valid).

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeOk(t, v) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

export function validate(value, schema, root = schema, path = '$', errors = [], max = 50) {
  if (errors.length >= max) return errors;
  if (schema.$ref) {
    const m = String(schema.$ref).match(/^#\/\$defs\/(.+)$/);
    const target = m && root.$defs && root.$defs[m[1]];
    if (!target) { errors.push(`${path}: unresolved $ref ${schema.$ref}`); return errors; }
    return validate(value, target, root, path, errors, max);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => typeOk(t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && !DATE_TIME.test(value)) errors.push(`${path}: not an RFC 3339 date-time`);
    if (schema.format === 'uri' && !/^https?:\/\/[^\s]+$/i.test(value)) errors.push(`${path}: not an http(s) URI`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, root, `${path}[${i}]`, errors, max));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) {
      if (!(k in value)) errors.push(`${path}: missing required "${k}"`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) validate(value[k], sub, root, `${path}.${k}`, errors, max);
    }
  }
  return errors;
}

// Cross-field invariants the schema cannot express.
export function checkInvariants(news) {
  const errors = [];
  const ids = new Set();
  const clusters = new Map();
  for (const it of news.items || []) {
    if (ids.has(it.id)) errors.push(`duplicate id ${it.id}`);
    ids.add(it.id);
    if (it.summary && it.summary.length > 280) errors.push(`summary over 280 chars for ${it.id}`);
    if (!/^https?:\/\//i.test(it.url) || !/^https?:\/\//i.test(it.canonicalUrl)) errors.push(`non-http url for ${it.id}`);
    clusters.set(it.cluster, (clusters.get(it.cluster) || 0) + 1);
  }
  for (const [c, n] of clusters) if (n > 1) errors.push(`cluster ${c} has ${n} representatives`);
  return errors;
}
