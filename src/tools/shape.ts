/**
 * Reduces JSON and URLs to their STRUCTURE so a report can describe how a web API behaves without
 * containing anything a user typed or received (no chat content, tokens or cookies).
 *
 * Nothing here ever returns a value taken from the data, with two narrow exceptions that are
 * structure rather than content: (1) the value of a small allow-list of "enum" keys such as `role`
 * or `content_type`, and only if it looks like a lowercase identifier; (2) a few pagination query
 * values such as `limit=28`. Everything else becomes a type token like "string" or "number:int".
 */

export type Shape = string | Shape[] | { [key: string]: Shape };

/** Keys whose (short, identifier-like) string values describe the format, not the content. */
const ENUM_KEYS = new Set([
  'role',
  'type',
  'content_type',
  'status',
  'object',
  'kind',
  'model_slug',
  'finish_type',
  'mime_type',
  'recipient',
  'channel',
  'source',
  'item_type',
  'mode',
  'message_type',
]);
const ENUM_VALUE = /^[a-z][a-z0-9_.-]{0,40}$/;

/** Query parameters whose short values are pagination/filter settings, not personal data. */
const QUERY_VALUE_KEYS = new Set([
  'limit',
  'offset',
  'order',
  'sort',
  'is_archived',
  'page',
  'per_page',
]);
const QUERY_VALUE = /^[a-z0-9_.-]{1,20}$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const URL_LIKE = /^https?:\/\//i;
const IDENT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,60}$/;

const MAX_DEPTH = 10;
const MAX_NODES = 20_000;
const ARRAY_SAMPLE = 5;

function classifyString(key: string | null, value: string): string {
  if (UUID.test(value)) return 'string:uuid';
  if (ISO_DATE.test(value)) return 'string:iso-datetime';
  if (URL_LIKE.test(value)) return 'string:url';
  if (key && ENUM_KEYS.has(key) && ENUM_VALUE.test(value)) return `string=${value}`;
  if (value === '') return 'string:empty';
  return 'string';
}

function classifyNumber(value: number): string {
  if (!Number.isFinite(value)) return 'number';
  if (Number.isInteger(value)) {
    if (value >= 1_000_000_000 && value <= 4_102_444_800) return 'number:unix-seconds';
    if (value >= 1_000_000_000_000 && value <= 4_102_444_800_000) return 'number:unix-ms';
    return 'number:int';
  }
  // Timestamps with fractions are common ("1712345678.123"); keep them apart from ordinary floats.
  if (value >= 1_000_000_000 && value <= 4_102_444_800) return 'number:unix-seconds';
  return 'number:float';
}

/** Object keys can be data (a map keyed by conversation id). Anything not identifier-like is masked. */
function normalizeKey(key: string): string {
  if (UUID.test(key)) return '<uuid>';
  if (!IDENT_KEY.test(key) || /^[0-9a-f]{16,}$/i.test(key)) return '<key>';
  return key;
}

function sizeBucket(n: number): string {
  if (n === 0) return '0';
  if (n === 1) return '1';
  if (n <= 10) return '2-10';
  return '11+';
}

const MAX_VARIANTS = 12;

type Plain = { [key: string]: Shape };
const isObject = (s: Shape): s is Plain => typeof s === 'object' && !Array.isArray(s);
const isOneOf = (s: Shape): s is { $oneOf: Shape[] } => isObject(s) && '$oneOf' in s;
const isArrayShape = (s: Shape): s is { $array: string; $items: Shape } =>
  isObject(s) && '$array' in s;
const isPlainObject = (s: Shape): s is Plain => isObject(s) && !isOneOf(s) && !isArrayShape(s);

export function mergeTokens(a: string, b: string): string {
  return a === b ? a : [...new Set([...a.split('|'), ...b.split('|')])].sort().join('|');
}

/**
 * Combines two shapes seen at the same place. Objects merge key by key (a key missing on one side becomes
 * optional, `key?`), arrays merge their items, plain tokens are joined with `|`. Only genuinely different
 * kinds of value (an object here, `null` there) are listed as `$oneOf`, flattened and de-duplicated, and
 * capped, so a large tree of similar nodes stays small and readable.
 */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (typeof a === 'string' && typeof b === 'string') return mergeTokens(a, b);
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Plain = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const base = k.endsWith('?') ? k.slice(0, -1) : k;
      const inA = k in a || `${base}?` in a;
      const inB = k in b || `${base}?` in b;
      const va = (a[k] ?? a[`${base}?`]) as Shape | undefined;
      const vb = (b[k] ?? b[`${base}?`]) as Shape | undefined;
      const merged =
        va !== undefined && vb !== undefined ? mergeShapes(va, vb) : ((va ?? vb) as Shape);
      const optional = !(inA && inB) || k.endsWith('?');
      out[optional ? `${base}?` : base] = merged;
    }
    return out;
  }
  if (isArrayShape(a) && isArrayShape(b)) {
    return { $array: mergeTokens(a.$array, b.$array), $items: mergeShapes(a.$items, b.$items) };
  }
  // Different kinds of value: keep one variant per kind, folding like with like.
  const variants: Shape[] = [];
  for (const v of [...(isOneOf(a) ? a.$oneOf : [a]), ...(isOneOf(b) ? b.$oneOf : [b])]) {
    const at = variants.findIndex(
      (x) =>
        (typeof x === 'string' && typeof v === 'string') ||
        (isPlainObject(x) && isPlainObject(v)) ||
        (isArrayShape(x) && isArrayShape(v)),
    );
    if (at >= 0) variants[at] = mergeShapes(variants[at] as Shape, v);
    else variants.push(v);
  }
  if (variants.length > MAX_VARIANTS)
    return { $oneOf: [...variants.slice(0, MAX_VARIANTS), '…more'] };
  return variants.length === 1 ? (variants[0] as Shape) : { $oneOf: variants };
}

export function shapeOf(
  value: unknown,
  key: string | null = null,
  budget = { nodes: 0 },
  depth = 0,
): Shape {
  if (++budget.nodes > MAX_NODES) return '…truncated';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return classifyString(key, value);
    case 'number':
      return classifyNumber(value);
    case 'boolean':
      return 'boolean';
    case 'object':
      break;
    default:
      return typeof value;
  }
  if (depth >= MAX_DEPTH) return '…deep';
  if (Array.isArray(value)) {
    let items: Shape | null = null;
    for (const item of value.slice(0, ARRAY_SAMPLE)) {
      const s = shapeOf(item, key, budget, depth + 1);
      items = items === null ? s : mergeShapes(items, s);
    }
    return { $array: sizeBucket(value.length), $items: items ?? 'empty' };
  }
  const out: { [key: string]: Shape } = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const nk = normalizeKey(k);
    const s = shapeOf(v, nk, budget, depth + 1);
    out[nk] = nk in out ? mergeShapes(out[nk] as Shape, s) : s;
  }
  return out;
}

/** `/backend-api/conversation/3f2a…-…` → `/backend-api/conversation/:uuid` */
export function normalizePath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (UUID.test(seg)) return ':uuid';
      // Country and locale codes come from where the user is, so they are masked too.
      if (/^[A-Z]{2}$/.test(seg) || /^[a-z]{2}-[A-Z]{2}$/.test(seg)) return ':locale';
      if (/^\d+$/.test(seg)) return ':number';
      // Prefixed ids such as `g-p-<hex>` keep their prefix so the id FORMAT stays visible.
      const prefixed = /^((?:[a-z]{1,4}-)+)[0-9a-z]{12,}.*$/i.exec(seg);
      if (prefixed) return `${prefixed[1]}:id`;
      if (/(?=[0-9a-f]*\d)[0-9a-f]{10,}/i.test(seg) || (seg.length >= 24 && /\d/.test(seg)))
        return ':id';
      // Anything else is a fixed part of the API path, unless it is long and free-form (a slug).
      if (seg.includes('%')) return ':text';
      return seg.length > 40 ? ':slug' : seg;
    })
    .join('/');
}

/** Query parameter names, each with a value ONLY for the allow-listed pagination keys. */
export function describeQuery(searchParams: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of searchParams) {
    const key = normalizeKey(name);
    out[key] = QUERY_VALUE_KEYS.has(name) && QUERY_VALUE.test(value) ? value : '<value>';
  }
  return out;
}
