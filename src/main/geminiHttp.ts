import { app, session } from 'electron';
import { EndpointChanged, SessionExpired } from '../connectors/errors';
import { isImageLink, isVideoLink } from '../connectors/gemini/parse';
import {
  buildBatchBody,
  buildBatchUrl,
  extractPageTokens,
  isAllowedRpc,
  leftGemini,
  type PageTokens,
} from '../connectors/gemini/rpc';
import type { BatchRpc, DownloadUrl } from '../connectors/types';

const ORIGIN = 'https://gemini.google.com';
const TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Calls to gemini.google.com made as a profile's signed-in user, through that profile's own browser session (its
 * cookies, nothing else's). It only sends the calls listed in `ALLOWED_RPCS`, which only read.
 *
 * The form token (and the build label and session id) come from the text of Gemini's own page, fetched with the
 * session. They are kept in memory, sent only to gemini.google.com, and never logged or returned to the caller.
 *
 * UNVERIFIED against a live account: where the page keeps those tokens, and which headers the site requires. If
 * Gemini rejects a call the connector reports the HTTP status, never content.
 */
export function createGeminiRpc(partition: string): BatchRpc {
  const ses = session.fromPartition(partition);
  let tokens: { value: PageTokens; at: number } | null = null;
  let reqId = 100_000 + Math.floor(Math.random() * 900_000);
  const lang = () => app.getLocale() || 'en-US';

  const loadTokens = async (): Promise<PageTokens> => {
    const res = await ses.fetch(`${ORIGIN}/app`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/html', 'Accept-Language': lang() },
    });
    if (res.status === 401 || res.status === 403) {
      throw new SessionExpired(`Gemini answered ${res.status}. Sign in again.`);
    }
    if (leftGemini(res.url)) {
      throw new SessionExpired(
        'Gemini sent this session to the Google sign-in page. Sign in again.',
      );
    }
    const found = extractPageTokens(await res.text());
    if (!found) {
      throw new SessionExpired(
        'Gemini did not give this session a token. Sign in again; if it keeps happening, the site may have changed.',
      );
    }
    tokens = { value: found, at: Date.now() };
    return found;
  };

  const send = async (call: Parameters<BatchRpc>[0]) => {
    const t = tokens && Date.now() - tokens.at < TOKEN_TTL_MS ? tokens.value : await loadTokens();
    reqId += 100_000;
    const res = await ses.fetch(
      buildBatchUrl(ORIGIN, call.rpcid, call.sourcePath, t, lang(), reqId),
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: '*/*',
          'Accept-Language': lang(),
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Same-Domain': '1',
          Origin: ORIGIN,
          Referer: `${ORIGIN}/`,
        },
        body: buildBatchBody(call.rpcid, call.args, t.at),
      },
    );
    const text = await res.text();
    const retry = Number(res.headers.get('retry-after'));
    return {
      status: res.status,
      text,
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
    };
  };

  return async (call) => {
    if (!isAllowedRpc(call.rpcid)) {
      throw new EndpointChanged('This call is not one this app makes to Gemini.');
    }
    if (!call.sourcePath.startsWith('/app')) throw new Error('Invalid source path');
    const first = await send(call);
    if (first.status === 400 || first.status === 401 || first.status === 403) {
      tokens = null; // the token may simply have expired: get a fresh one once
      return send(call);
    }
    return first;
  };
}

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;

/**
 * Downloads a picture from Gemini's own image host (`googleusercontent.com`, at most 40 MB) or a video from Google's
 * user-content download address (at most 150 MB), as the profile's session. Only https, only those hosts.
 */
export function createGeminiDownloader(partition: string): DownloadUrl {
  const ses = session.fromPartition(partition);
  return async (url) => {
    const video = isVideoLink(url);
    if (!video && !isImageLink(url)) throw new Error('Download host not allowed.');
    const max = video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    const res = await ses.fetch(url, { method: 'GET', credentials: 'include' });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max)
      throw new Error('The file is too large to download.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > max) throw new Error('The file is too large to download.');
    return { status: res.status, bytes, mime: res.headers.get('content-type') };
  };
}
