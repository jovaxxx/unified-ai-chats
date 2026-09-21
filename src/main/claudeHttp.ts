import { app, session } from 'electron';
import type { HttpJson, HttpResult } from '../connectors/types';

const ORIGIN = 'https://claude.ai';

/**
 * Requests to claude.ai made as a profile's signed-in user, through that profile's own browser session (its cookies,
 * nothing else's). Read-only: only GET is ever sent.
 *
 * UNVERIFIED against a live account: whether the session cookie alone is enough. If claude.ai rejects the requests
 * the connector reports the HTTP status, never content.
 */
export function createClaudeHttp(partition: string): HttpJson {
  const ses = session.fromPartition(partition);
  return async (path): Promise<HttpResult> => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid path');
    const res = await ses.fetch(`${ORIGIN}${path}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Accept-Language': app.getLocale() || 'en-US',
        Referer: `${ORIGIN}/`,
      },
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined; // an HTML page (e.g. a bot check) or an empty body
    }
    const retry = Number(res.headers.get('retry-after'));
    return {
      status: res.status,
      json,
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
    };
  };
}
