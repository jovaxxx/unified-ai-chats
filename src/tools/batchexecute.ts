import { positionalShapeOf, type Shape } from './shape';

/**
 * Google web apps (Gemini among them) talk to their server through one address, `…/batchexecute`, with the
 * method named in `rpcids`. The request carries `f.req` (a JSON array of calls, each with its own arguments as a
 * JSON text); the answer starts with `)]}'` and holds rows `["wrb.fr", <rpc id>, <payload as JSON text>, …]`.
 * Both are reduced to a shape (types only, by position) as soon as they are read. Everything else in the
 * request (`at` and the other form fields) is never looked at.
 */

export const isBatchExecute = (pathname: string): boolean => pathname.endsWith('/batchexecute');

const RPC_ID = /^[A-Za-z0-9_]{2,16}$/;

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The method ids named in the address, as a stable label (`MaZiqc+hNvQHb`), or null if there are none. */
export function rpcLabel(searchParams: URLSearchParams): string | null {
  const ids = (searchParams.get('rpcids') ?? '').split(',').filter((id) => RPC_ID.test(id));
  return ids.length > 0 ? [...new Set(ids)].sort().join('+') : null;
}

/** `{ <rpc id>: <shape of its arguments> }` for the calls in a request body. */
export function batchRequestShape(postData: string): Shape | undefined {
  const f = new URLSearchParams(postData).get('f.req');
  const outer = f ? tryJson(f) : undefined;
  if (!Array.isArray(outer) || !Array.isArray(outer[0])) return undefined;
  const out: { [key: string]: Shape } = {};
  for (const call of outer[0] as unknown[]) {
    if (!Array.isArray(call) || typeof call[0] !== 'string' || !RPC_ID.test(call[0])) continue;
    const args = typeof call[1] === 'string' ? tryJson(call[1]) : call[1];
    out[call[0]] = args === undefined ? 'non-json' : positionalShapeOf(args);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `{ <rpc id>: <shape of its payload> }` for the answers in a response body. */
export function batchResponseShape(text: string): Shape | undefined {
  const out: { [key: string]: Shape } = {};
  for (const line of text.split('\n')) {
    const row = line.trim();
    if (!row.startsWith('[')) continue;
    const chunk = tryJson(row);
    if (!Array.isArray(chunk)) continue;
    for (const entry of chunk as unknown[]) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
      const id = entry[1];
      if (typeof id !== 'string' || !RPC_ID.test(id)) continue;
      const payload = typeof entry[2] === 'string' ? tryJson(entry[2]) : undefined;
      out[id] = payload === undefined ? 'empty' : positionalShapeOf(payload);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
