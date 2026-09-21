import {
  describeQuery,
  mergeShapes,
  mergeTokens,
  normalizePath,
  shapeOf,
  type Shape,
} from './shape';

/**
 * Builds a STRUCTURE report of a web API from Chrome DevTools Protocol network events.
 * See shape.ts for what "structure" means. Response and request bodies are reduced to a shape the
 * moment they are read and are never kept. Header VALUES are never read at all: only names, and for
 * `cookie` / `authorization` just whether they were present.
 *
 * Only requests to `allowedHosts` are considered, and only fetch/XHR calls, so page loads, images,
 * fonts and third-party analytics never enter the report.
 */

export interface RecorderOptions {
  allowedHosts: string[];
}

export interface EndpointReport {
  method: string;
  host: string;
  path: string;
  count: number;
  /** Query parameter names; the value is shown only for pagination-style keys, else "<value>". */
  query: Record<string, string>;
  statuses: Record<string, number>;
  responseMime: string[];
  requestHeaderNames: string[];
  sendsAuthorizationHeader: boolean;
  sendsCookie: boolean;
  requestBodyShape?: Shape;
  responseShape?: Shape;
}

export interface StructureReport {
  schema: 1;
  kind: 'api-structure';
  createdAt: string;
  notes: string[];
  requests: number;
  endpoints: EndpointReport[];
}

interface Pending {
  method: string;
  url: URL;
  headerNames: Set<string>;
  hasAuth: boolean;
  hasCookie: boolean;
  requestBodyShape?: Shape;
  status?: number;
  mime?: string;
}

export type BodyFetcher = (
  requestId: string,
) => Promise<{ body: string; base64Encoded: boolean } | null>;

// Not needed to read chats, and better left out: anti-bot challenges (sentinel, Cloudflare), analytics
// and real-user-monitoring beacons.
const SKIPPED_PATH = /\/(sentinel|cdn-cgi|ces|awe)\//;
const MAX_PENDING = 500;
const MAX_ENDPOINTS = 300;

function headerFlags(headers: Record<string, unknown> | undefined) {
  const names = new Set<string>();
  let hasAuth = false;
  let hasCookie = false;
  for (const name of Object.keys(headers ?? {})) {
    const n = name.toLowerCase();
    if (n === 'authorization') hasAuth = true;
    else if (n === 'cookie') hasCookie = true;
    else if (/^[a-z0-9-]{1,60}$/.test(n)) names.add(n);
  }
  return { names, hasAuth, hasCookie };
}

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class StructureRecorder {
  private pending = new Map<string, Pending>();
  private endpoints = new Map<string, EndpointReport>();
  private total = 0;

  constructor(private readonly opts: RecorderOptions) {}

  status(): { requests: number; endpoints: number } {
    return { requests: this.total, endpoints: this.endpoints.size };
  }

  private allowed(url: URL): boolean {
    if (url.protocol !== 'https:') return false;
    return this.opts.allowedHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  }

  /** Feed every `Network.*` event here. Returns when the event has been fully processed. */
  async onEvent(
    method: string,
    params: Record<string, unknown>,
    getBody: BodyFetcher,
  ): Promise<void> {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const req = params.request as
          | { url?: string; method?: string; headers?: Record<string, unknown>; postData?: string }
          | undefined;
        const type = params.type as string | undefined;
        if (!req?.url || (type !== 'XHR' && type !== 'Fetch')) return;
        let url: URL;
        try {
          url = new URL(req.url);
        } catch {
          return;
        }
        const httpMethod = (req.method ?? 'GET').toUpperCase();
        if (!this.allowed(url) || httpMethod === 'OPTIONS' || SKIPPED_PATH.test(url.pathname))
          return;
        if (this.pending.size >= MAX_PENDING) this.pending.clear(); // never grow without bound
        const flags = headerFlags(req.headers);
        const entry: Pending = {
          method: httpMethod,
          url,
          headerNames: flags.names,
          hasAuth: flags.hasAuth,
          hasCookie: flags.hasCookie,
        };
        if (typeof req.postData === 'string') {
          const json = tryJson(req.postData);
          entry.requestBodyShape = json === undefined ? 'non-json' : shapeOf(json);
        }
        this.pending.set(params.requestId as string, entry);
        return;
      }
      case 'Network.requestWillBeSentExtraInfo': {
        // Carries the real headers (cookies are only visible here). Names only, flags for secrets.
        const p = this.pending.get(params.requestId as string);
        if (!p) return;
        const flags = headerFlags(params.headers as Record<string, unknown> | undefined);
        flags.names.forEach((n) => p.headerNames.add(n));
        p.hasAuth ||= flags.hasAuth;
        p.hasCookie ||= flags.hasCookie;
        return;
      }
      case 'Network.responseReceived': {
        const p = this.pending.get(params.requestId as string);
        const res = params.response as { status?: number; mimeType?: string } | undefined;
        if (!p || !res) return;
        p.status = res.status;
        p.mime =
          typeof res.mimeType === 'string'
            ? res.mimeType.split(';')[0]?.trim().toLowerCase()
            : undefined;
        return;
      }
      case 'Network.loadingFinished': {
        const id = params.requestId as string;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        let responseShape: Shape | undefined;
        if (p.mime?.includes('json')) {
          const raw = await getBody(id).catch(() => null);
          if (raw) {
            const text = raw.base64Encoded
              ? Buffer.from(raw.body, 'base64').toString('utf8')
              : raw.body;
            const json = tryJson(text);
            // The parsed value is reduced to a shape here and goes out of scope immediately.
            responseShape = json === undefined ? 'non-json' : shapeOf(json);
          }
        } else if (p.mime) {
          responseShape = `non-json:${p.mime}`;
        }
        this.record(p, responseShape);
        return;
      }
      case 'Network.loadingFailed':
        this.pending.delete(params.requestId as string);
        return;
      default:
    }
  }

  private record(p: Pending, responseShape: Shape | undefined): void {
    this.total++;
    const path = normalizePath(p.url.pathname);
    const key = `${p.method} ${p.url.hostname}${path}`;
    let e = this.endpoints.get(key);
    if (!e) {
      if (this.endpoints.size >= MAX_ENDPOINTS) return;
      e = {
        method: p.method,
        host: p.url.hostname,
        path,
        count: 0,
        query: {},
        statuses: {},
        responseMime: [],
        requestHeaderNames: [],
        sendsAuthorizationHeader: false,
        sendsCookie: false,
      };
      this.endpoints.set(key, e);
    }
    e.count++;
    // Pagination-style values from every call are kept together ("false|true"), not just the last one.
    for (const [name, value] of Object.entries(describeQuery(p.url.searchParams))) {
      e.query[name] = e.query[name] === undefined ? value : mergeTokens(e.query[name], value);
    }
    const status = String(p.status ?? 'unknown');
    e.statuses[status] = (e.statuses[status] ?? 0) + 1;
    if (p.mime && !e.responseMime.includes(p.mime)) e.responseMime.push(p.mime);
    e.requestHeaderNames = [...new Set([...e.requestHeaderNames, ...p.headerNames])].sort();
    e.sendsAuthorizationHeader ||= p.hasAuth;
    e.sendsCookie ||= p.hasCookie;
    if (p.requestBodyShape !== undefined) {
      e.requestBodyShape =
        e.requestBodyShape === undefined
          ? p.requestBodyShape
          : mergeShapes(e.requestBodyShape, p.requestBodyShape);
    }
    if (responseShape !== undefined) {
      e.responseShape =
        e.responseShape === undefined ? responseShape : mergeShapes(e.responseShape, responseShape);
    }
  }

  report(now: Date = new Date()): StructureReport {
    return {
      schema: 1,
      kind: 'api-structure',
      createdAt: now.toISOString(),
      notes: [
        'Structure only: field names and value types. No titles, messages, tokens, cookies or ids are stored.',
        'Values shown as string=xxx come from a small allow-list of format keys (role, type, content_type, status, ...).',
        'Query values are shown only for pagination-style keys (limit, offset, order, ...).',
        'Only fetch/XHR calls to the allowed hosts are included.',
      ],
      requests: this.total,
      endpoints: [...this.endpoints.values()].sort(
        (a, b) => b.count - a.count || a.path.localeCompare(b.path),
      ),
    };
  }
}
