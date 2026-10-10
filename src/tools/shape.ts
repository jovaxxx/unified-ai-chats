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
  'rpcids',
  // Which kind of chats a list asks for (a short word such as the chat's origin), not who they belong to.
  'conversation_origin',
  'exclude_conversation_origin',
  'hide_snorlax',
  'expand',
  'is_starred',
  'owned_only',
  'item_type',
]);
const QUERY_VALUE = /^[a-z0-9_.-]{1,20}$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const URL_LIKE = /^https?:\/\//i;
const IDENT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,60}$/;

const MAX_DEPTH = 10;
const MAX_NODES = 20_000;
const ARRAY_SAMPLE = 5;

export function classifyString(key: string | null, value: string): string {
  if (UUID.test(value)) return 'string:uuid';
  if (ISO_DATE.test(value)) return 'string:iso-datetime';
  if (URL_LIKE.test(value)) return 'string:url';
  if (key && ENUM_KEYS.has(key) && ENUM_VALUE.test(value)) return `string=${value}`;
  if (value === '') return 'string:empty';
  return 'string';
}

export function classifyNumber(value: number): string {
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
export function normalizeKey(key: string): string {
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

const TUPLE_MAX = 60;
const TUPLE_DEPTH = 24;
const POSITIONAL_MAX_NODES = 60_000;
const ID_LIKE = /^(?:[a-z]{1,3}_)?[A-Za-z0-9_-]{6,80}$/;

const MIME = /^(?:image|video|audio)\/[a-z0-9][a-z0-9.+-]{1,40}$/i;
const KNOWN_HOST =
  /(?:^|\.)(?:google\.com|googleusercontent\.com|gstatic\.com|googlevideo\.com|ggpht\.com|youtube\.com)$/;
const MEDIA_EXT = /\.(mp4|webm|m3u8|mpd|mov|png|jpe?g|webp|gif|svg)$/i;
/** The format hint Google puts at the end of a media link (`=s1024-rj`, `=m37`): never a token, never an id. */
const LINK_TAIL = /=([a-z]{1,3}[0-9]{0,4}(?:-[a-z0-9]{1,4}){0,3})$/i;
const FIXED_SEGMENT = /^[a-z][a-z-]{1,11}$/;

/** A host reduced to its kind: a Google domain, with its subdomain only if that is a plain word (`lh3`, `contribution.usercontent`), never a server name. */
function hostKind(host: string): string {
  const suffix = KNOWN_HOST.exec(host)?.[0]?.replace(/^\./, '');
  if (!suffix) return 'other-host';
  const sub = host.slice(0, host.length - suffix.length).replace(/\.$/, '');
  return sub && (/^[a-z]+(\.[a-z]+)*$/.test(sub) || /^[a-z]{1,4}\d$/.test(sub))
    ? `${sub}.${suffix}`
    : suffix;
}

/** A link reduced to its kind: which Google host, the first fixed path word, the file type and the format hint. */
function describeLink(value: string): string {
  try {
    const u = new URL(value);
    const host = hostKind(u.hostname.toLowerCase());
    const first = u.pathname.split('/')[1] ?? '';
    const parts = [
      FIXED_SEGMENT.test(first) ? `${host}/${first}` : host,
      MEDIA_EXT.exec(u.pathname)?.[0]?.toLowerCase(),
      LINK_TAIL.exec(u.pathname)?.[0]?.toLowerCase(),
    ].filter(Boolean);
    return `string:url(${parts.join(' ')})`;
  } catch {
    return 'string:url';
  }
}

/**
 * A string that is not a known format: a media type (`video/mp4`) is kept, a link keeps only its kind, an
 * identifier-like token keeps only its short prefix, free text only a size.
 */
function classifyPositionalString(value: string): string {
  if (MIME.test(value)) return `string=${value.toLowerCase()}`;
  const known = classifyString(null, value);
  if (known === 'string:url') return describeLink(value);
  if (known !== 'string') return known;
  if (ID_LIKE.test(value) && /\d/.test(value)) {
    const prefix = /^([a-z]{1,3}_)/.exec(value)?.[1];
    return prefix ? `string:id(${prefix})` : 'string:id';
  }
  return value.length <= 20
    ? 'string:short'
    : value.length <= 200
      ? 'string:medium'
      : 'string:long';
}

/**
 * Like `shapeOf`, for APIs that answer with unnamed, position-based arrays (Google's batchexecute): the
 * position of each value is what identifies it, so a short array becomes `{ $tuple: { "0": …, "1": … } }`
 * and a long list of similar items becomes `{ $list: … }`. Same rule as everywhere: types only, never a value.
 */
export function positionalShapeOf(value: unknown, budget = { nodes: 0 }, depth = 0): Shape {
  if (++budget.nodes > POSITIONAL_MAX_NODES) return '…truncated';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return classifyPositionalString(value);
    case 'number':
      return classifyNumber(value);
    case 'boolean':
      return 'boolean';
    case 'object':
      break;
    default:
      return typeof value;
  }
  if (depth >= TUPLE_DEPTH) return '…deep';
  if (Array.isArray(value)) {
    const length = value.length > TUPLE_MAX ? `${TUPLE_MAX}+` : String(value.length);
    const records = value.length > 3 && value.every((v) => Array.isArray(v));
    const scalars = value.length > 8 && value.every((v) => v === null || typeof v !== 'object');
    if (records || scalars) {
      let items: Shape | null = null;
      for (const item of value.slice(0, ARRAY_SAMPLE)) {
        const s = positionalShapeOf(item, budget, depth + 1);
        items = items === null ? s : mergeShapes(items, s);
      }
      return { $list: items ?? 'empty', $length: sizeBucket(value.length) };
    }
    const tuple: { [key: string]: Shape } = {};
    value.slice(0, TUPLE_MAX).forEach((item, i) => {
      tuple[String(i)] = positionalShapeOf(item, budget, depth + 1);
    });
    return { $tuple: tuple, $length: length };
  }
  const out: { [key: string]: Shape } = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const nk = normalizeKey(k);
    const s = positionalShapeOf(v, budget, depth + 1);
    out[nk] = nk in out ? mergeShapes(out[nk] as Shape, s) : s;
  }
  return out;
}
