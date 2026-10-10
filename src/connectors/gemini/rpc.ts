/**
 * Pure helpers for talking to Gemini through Google's batchexecute (no network here, so they can be tested).
 *
 * Read from a structure report recorded on a real account: the address, the form (`f.req`, `at`) and the answer
 * (`)]}'` then rows `["wrb.fr", <method id>, <payload as JSON text>, …]`). NOT confirmed by it: where the page
 * keeps the tokens (`at`, `bl`, `f.sid`). Those are looked for in the page's own text; if they are not there the
 * connector says so instead of guessing.
 */

/** The only methods this app ever calls: the chat list and reading one chat. Both only read. */
export const ALLOWED_RPCS: ReadonlySet<string> = new Set(['MaZiqc', 'hNvQHb']);

export const isAllowedRpc = (rpcid: string): boolean => ALLOWED_RPCS.has(rpcid);

/**
 * Whether the page the session ended up on is a sign-in page rather than Gemini. An answer that does not say where it
 * ended up (an empty or unreadable address) tells nothing, so it is not taken for a sign-in redirect.
 */
export function leftGemini(finalUrl: string): boolean {
  try {
    return new URL(finalUrl).hostname !== 'gemini.google.com';
  } catch {
    return false;
  }
}

export interface PageTokens {
  /** The anti-forgery token the form must carry (`at`). */
  at: string;
  /** The server build label (`bl`), when the page has it. */
  bl?: string;
  /** The session id (`f.sid`), when the page has it. */
  sid?: string;
}

/** Looks for the tokens in the text of Gemini's page. Null when the form token is not there. */
export function extractPageTokens(html: string): PageTokens | null {
  const at = /"SNlM0e":"([^"]{8,400})"/.exec(html)?.[1];
  if (!at) return null;
  const bl = /"cfb2h":"([^"]{3,200})"/.exec(html)?.[1];
  const sid = /"FdrFJe":"(-?\d{6,30})"/.exec(html)?.[1];
  return { at, ...(bl ? { bl } : {}), ...(sid ? { sid } : {}) };
}

export function buildBatchBody(rpcid: string, args: unknown, at: string): string {
  const f = JSON.stringify([[[rpcid, JSON.stringify(args), null, 'generic']]]);
  return `f.req=${encodeURIComponent(f)}&at=${encodeURIComponent(at)}&`;
}

export function buildBatchUrl(
  origin: string,
  rpcid: string,
  sourcePath: string,
  tokens: Pick<PageTokens, 'bl' | 'sid'>,
  lang: string,
  reqId: number,
): string {
  const q = new URLSearchParams({ rpcids: rpcid, 'source-path': sourcePath });
  if (tokens.bl) q.set('bl', tokens.bl);
  if (tokens.sid) q.set('f.sid', tokens.sid);
  q.set('hl', lang);
  q.set('_reqid', String(reqId));
  q.set('rt', 'c');
  return `${origin}/_/BardChatUi/data/batchexecute?${q.toString()}`;
}

/**
 * The payload of the answer to `rpcid`. `found` is false when the answer has no row for it; `payload` is null when
 * the row is there but empty.
 */
export function parseBatchPayload(
  text: string,
  rpcid: string,
): { found: boolean; payload: unknown } {
  for (const line of text.split('\n')) {
    const row = line.trim();
    if (!row.startsWith('[')) continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(row);
    } catch {
      continue;
    }
    if (!Array.isArray(chunk)) continue;
    for (const entry of chunk as unknown[]) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== rpcid) continue;
      if (typeof entry[2] !== 'string') return { found: true, payload: null };
      try {
        return { found: true, payload: JSON.parse(entry[2]) as unknown };
      } catch {
        return { found: true, payload: null };
      }
    }
  }
  return { found: false, payload: null };
}
