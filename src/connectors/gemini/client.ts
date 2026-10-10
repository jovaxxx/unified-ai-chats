import { EndpointChanged, NotFound, RateLimited, SessionExpired } from '../errors';
import type { ClientOptions } from '../chatgpt/client';
import type { BatchRpc } from '../types';
import { findChats, type ListedChat } from './parse';
import { isAllowedRpc, parseBatchPayload } from './rpc';

/** How long to wait after a rate-limit or server error, per attempt, when the server does not say. */
const BACKOFF_MS = [3_000, 10_000, 30_000, 60_000, 120_000];
const MAX_EXTRA_PACE_MS = 4_000;
const MAX_PAGES = 200;
/** The size of one page of the chat list, as the site asks for it. */
const LIST_PAGE = 13;

/**
 * Reads Gemini sequentially and politely (pauses with jitter, backoff on 429/5xx). It only ever reads: the list of
 * chats and one chat.
 *
 * NOT confirmed by the recorded structure report (so each is checked, and a mismatch is reported, never guessed):
 * how the next page of the list is asked for (a text token at position 1 of the answer is assumed), the order of the
 * turns inside a chat (they are sorted by time), and whether a long chat needs more than one call.
 */
export class GeminiClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly paceMs: number;
  private readonly jitterMs: number;
  private readonly maxRetries: number;
  private readonly onWait: ClientOptions['onWait'];
  private first = true;
  private extraPaceMs = 0;

  constructor(
    private readonly rpc: BatchRpc,
    opts: ClientOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.paceMs = opts.paceMs ?? 700;
    this.jitterMs = opts.jitterMs ?? 700;
    this.maxRetries = opts.maxRetries ?? BACKOFF_MS.length;
    this.onWait = opts.onWait;
  }

  private async call(rpcid: string, args: unknown, sourcePath: string): Promise<unknown> {
    if (!isAllowedRpc(rpcid)) throw new Error('This call is not one this app makes to Gemini.');
    for (let attempt = 0; ; attempt++) {
      if (!this.first)
        await this.sleep(this.paceMs + this.extraPaceMs + Math.random() * this.jitterMs);
      this.first = false;
      const res = await this.rpc({ rpcid, args, sourcePath });

      if (res.status === 401 || res.status === 403) {
        throw new SessionExpired(`Gemini answered ${res.status}. Sign in again.`);
      }
      if (res.status === 404) throw new NotFound('Gemini does not have this.');
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) {
          if (res.status === 429)
            throw new RateLimited(
              'Gemini is limiting requests. Try again later.',
              res.retryAfterSeconds ? res.retryAfterSeconds * 1000 : undefined,
            );
          throw new Error(`Gemini answered ${res.status}.`);
        }
        this.extraPaceMs = Math.min(MAX_EXTRA_PACE_MS, Math.max(700, this.extraPaceMs * 2));
        const wait = res.retryAfterSeconds
          ? res.retryAfterSeconds * 1000
          : (BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
        this.onWait?.(wait);
        try {
          await this.sleep(wait);
        } finally {
          this.onWait?.(0);
        }
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new EndpointChanged(`Gemini answered ${res.status}, which was not expected.`);
      }
      const parsed = parseBatchPayload(res.text, rpcid);
      if (!parsed.found) {
        throw new EndpointChanged(`Gemini's answer no longer has what was expected (${rpcid}).`);
      }
      return parsed.payload;
    }
  }

  /** The chats, newest first as the site lists them. Ends when the list ends, or after `stopWhen` says so. */
  async *chats(stopWhen?: (chat: ListedChat) => boolean): AsyncGenerator<ListedChat> {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const payload = await this.call('MaZiqc', [LIST_PAGE, cursor, [0, null, 1]], '/app');
      if (payload !== null && !Array.isArray(payload)) {
        throw new EndpointChanged('The Gemini chat list no longer has the expected shape.');
      }
      const items = findChats(payload);
      let fresh = 0;
      for (const chat of items) {
        if (seen.has(chat.id)) continue;
        seen.add(chat.id);
        fresh++;
        if (stopWhen?.(chat)) return;
        yield chat;
      }
      const next: unknown = Array.isArray(payload) ? payload[1] : null;
      if (typeof next !== 'string' || next === '' || next === cursor || fresh === 0) return;
      cursor = next;
    }
  }

  /** One chat, as Gemini returns it. A chat Gemini no longer has is `NotFound`. */
  async chat(id: string): Promise<unknown> {
    if (!/^c_[A-Za-z0-9_-]{6,}$/.test(id)) {
      throw new EndpointChanged('This chat has an id this app does not know how to read.');
    }
    const payload = await this.call(
      'hNvQHb',
      [id, 10, null, 1, [0], [4], null, 1],
      `/app/${id.replace(/^c_/, '')}`,
    );
    if (payload === null) throw new NotFound('Gemini does not have this chat.');
    return payload;
  }
}
