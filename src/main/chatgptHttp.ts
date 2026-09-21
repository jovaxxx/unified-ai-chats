import { app, session } from 'electron';
import type { DownloadUrl, HttpJson, HttpResult } from '../connectors/types';

const ORIGIN = 'https://chatgpt.com';
const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Requests to chatgpt.com made as a profile's signed-in user, through that profile's own browser session
 * (so its cookies are used and nothing else's). Read-only: only GET is ever sent.
 *
 * The site's API wants a short-lived access token, which its own session call hands out. It is kept in
 * memory only, sent only to chatgpt.com, and never logged or returned to the caller.
 *
 * UNVERIFIED against a live account: the exact headers the site requires. We send the ones the structure
 * report showed (Authorization, device id from the `oai-did` cookie, language). If ChatGPT rejects the
 * requests the connector reports the HTTP status, never the content.
 */
export function createChatGptHttp(partition: string): HttpJson {
  const ses = session.fromPartition(partition);
  let token: { value: string; at: number } | null = null;

  const baseHeaders = (): Record<string, string> => {
    const lang = app.getLocale() || 'en-US';
    return {
      Accept: 'application/json',
      'Accept-Language': lang,
      'oai-language': lang,
      Referer: `${ORIGIN}/`,
    };
  };

  const send = async (path: string, headers: Record<string, string>): Promise<HttpResult> => {
    const res = await ses.fetch(`${ORIGIN}${path}`, {
      method: 'GET',
      headers,
      credentials: 'include',
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

  const remember = (res: HttpResult) => {
    const t = (res.json as { accessToken?: unknown } | undefined)?.accessToken;
    if (res.status === 200 && typeof t === 'string' && t.length > 10)
      token = { value: t, at: Date.now() };
  };

  const currentToken = async (): Promise<{ value: string } | { failure: HttpResult }> => {
    if (token && Date.now() - token.at < TOKEN_TTL_MS) return token;
    const res = await send('/api/auth/session', baseHeaders());
    remember(res);
    return token ? token : { failure: res };
  };

  return async (path) => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid path');
    if (path.startsWith('/api/auth/')) {
      const res = await send(path, baseHeaders());
      remember(res);
      return res;
    }
    const call = async (): Promise<HttpResult> => {
      const t = await currentToken();
      if ('failure' in t) return t.failure;
      const headers: Record<string, string> = {
        ...baseHeaders(),
        Authorization: `Bearer ${t.value}`,
      };
      const [did] = await ses.cookies.get({ url: ORIGIN, name: 'oai-did' });
      if (did?.value) headers['oai-device-id'] = did.value;
      return send(path, headers);
    };
    const first = await call();
    if (first.status === 401) {
      token = null; // it may simply have expired: get a fresh one once
      return call();
    }
    return first;
  };
}

/** Hosts a signed download link may point to. Anything else is refused, whatever the response said. */
const DOWNLOAD_HOSTS = ['chatgpt.com', 'oaiusercontent.com', 'openaiusercontent.com'];
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

/**
 * Downloads a file from a link ChatGPT handed out (for example a generated image). Only https, only the hosts
 * above, and never more than 40 MB. Cookies are sent to chatgpt.com only; a signed link carries its own permission.
 */
export function createChatGptDownloader(partition: string): DownloadUrl {
  const ses = session.fromPartition(partition);
  return async (url) => {
    const u = new URL(url);
    if (
      u.protocol !== 'https:' ||
      !DOWNLOAD_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
    ) {
      throw new Error(`Download host not allowed: ${u.hostname}`);
    }
    const res = await ses.fetch(url, {
      method: 'GET',
      credentials:
        u.hostname === 'chatgpt.com' || u.hostname.endsWith('.chatgpt.com') ? 'include' : 'omit',
    });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES)
      throw new Error('The file is too large to download.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('The file is too large to download.');
    return { status: res.status, bytes, mime: res.headers.get('content-type') };
  };
}
