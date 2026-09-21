import type { z } from 'zod';
import { EndpointChanged, NotFound, RateLimited, SessionExpired } from '../errors';
import type { ClientOptions } from '../chatgpt/client';
import type { HttpJson } from '../types';
import {
  accountSchema,
  conversationDetailSchema,
  conversationPageSchema,
  organizationsSchema,
  parseConversationItem,
  parseProject,
  projectPageSchema,
  type ConversationDetail,
  type ConversationItem,
} from './schema';

const BACKOFF_MS = [3_000, 10_000, 30_000, 60_000, 120_000];
const MAX_EXTRA_PACE_MS = 8_000;
const MAX_PAGES = 200;
const PAGE_SIZE = 30;

/** A path with ids removed, safe to show in an error. */
function label(path: string): string {
  return path
    .split('?')[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
}

/** Reads claude.ai's web API, politely: one request at a time, paused, backing off when told to slow down. */
export class ClaudeClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly paceMs: number;
  private readonly jitterMs: number;
  private readonly maxRetries: number;
  private readonly onWait: ClientOptions['onWait'];
  private first = true;
  private extraPaceMs = 0;
  /** The organization the conversations belong to (chats live under an organization). */
  private orgs: string[] | null = null;

  constructor(
    private readonly http: HttpJson,
    opts: ClientOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.paceMs = opts.paceMs ?? 700;
    this.jitterMs = opts.jitterMs ?? 700;
    this.maxRetries = opts.maxRetries ?? BACKOFF_MS.length;
    this.onWait = opts.onWait;
  }

  private async get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    for (let attempt = 0; ; attempt++) {
      if (!this.first)
        await this.sleep(this.paceMs + this.extraPaceMs + Math.random() * this.jitterMs);
      this.first = false;
      const res = await this.http(path);
      if (res.status === 401 || res.status === 403) {
        throw new SessionExpired(
          `Claude answered ${res.status} for ${label(path)}. Sign in again.`,
        );
      }
      if (res.status === 404) throw new NotFound(`Not found: ${label(path)}`);
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) {
          if (res.status === 429)
            throw new RateLimited(
              `Claude is limiting requests (${label(path)}). Try again later.`,
              res.retryAfterSeconds ? res.retryAfterSeconds * 1000 : undefined,
            );
          throw new Error(`Claude answered ${res.status} for ${label(path)}.`);
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
        throw new EndpointChanged(`${label(path)} answered ${res.status}, which was not expected.`);
      }
      const parsed = schema.safeParse(res.json);
      if (!parsed.success) {
        const where = parsed.error.issues[0]?.path.join('.') || 'body';
        throw new EndpointChanged(
          `${label(path)}: the response no longer matches what was expected (${where}).`,
        );
      }
      return parsed.data;
    }
  }

  /** The signed-in account's id. UNVERIFIED call (see schema.ts). */
  async accountId(): Promise<string> {
    return (await this.get('/api/account', accountSchema)).uuid;
  }

  /** Organizations that can hold chats. Falls back to all of them if none says it has the "chat" capability. */
  async organizations(): Promise<string[]> {
    if (this.orgs) return this.orgs;
    const all = await this.get('/api/organizations', organizationsSchema);
    const chat = all.filter((o) => o.capabilities?.includes('chat'));
    this.orgs = (chat.length > 0 ? chat : all).map((o) => o.uuid);
    return this.orgs;
  }

  async projects(org: string): Promise<{ uuid: string; name: string }[]> {
    const out: { uuid: string; name: string }[] = [];
    for (const archived of [false, true]) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await this.get(
          `/api/organizations/${encodeURIComponent(org)}/projects_v2?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&is_archived=${archived}`,
          projectPageSchema,
        );
        for (const v of res.data) {
          const p = parseProject(v);
          if (p) out.push(p);
        }
        if (!res.pagination?.has_more || res.data.length === 0) break;
      }
    }
    return out;
  }

  /** Every conversation of an organization, in the states asked for. Order is not relied on. */
  async *conversations(
    org: string,
    filter: 'active' | 'archived' | 'starred',
  ): AsyncGenerator<ConversationItem> {
    const flags =
      filter === 'archived'
        ? 'archived=true'
        : filter === 'starred'
          ? 'starred=true'
          : 'archived=false';
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.get(
        `/api/organizations/${encodeURIComponent(org)}/chat_conversations_v2?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&${flags}`,
        conversationPageSchema,
      );
      for (const v of res.data) {
        const item = parseConversationItem(v);
        if (item) yield item;
      }
      if (!res.has_more || res.data.length === 0) return;
    }
  }

  async conversation(org: string, id: string): Promise<ConversationDetail> {
    return this.get(
      `/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(id)}?tree=True&rendering_mode=messages&render_all_tools=true`,
      conversationDetailSchema,
    );
  }
}
