import type { z } from 'zod';
import { EndpointChanged, NotFound, RateLimited, SessionExpired } from '../errors';
import type { HttpJson } from '../types';
import {
  conversationDetailSchema,
  conversationFlatSchema,
  flatToDetail,
  conversationPageSchema,
  fileDownloadSchema,
  pinsSchema,
  projectConversationPageSchema,
  sessionSchema,
  sidebarProjectSchema,
  sidebarSchema,
  type ConversationDetail,
  type ConversationItem,
} from './schema';

export interface ClientOptions {
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Pause between requests: base plus up to `jitterMs` extra, so the pattern is not mechanical. */
  paceMs?: number;
  jitterMs?: number;
  maxRetries?: number;
  /** Told when the site made us wait (milliseconds), and with 0 when the wait is over. */
  onWait?: (ms: number) => void;
}

/** How long to wait after a rate-limit or server error, per attempt, when the server does not say. */
const BACKOFF_MS = [3_000, 10_000, 30_000, 60_000, 120_000];
const MAX_EXTRA_PACE_MS = 4_000;

const PAGE_SIZE = 28; // what the site itself uses
const MAX_PAGES = 500; // a safety net against a server that never ends the list

/** `/backend-api/conversation/3f2a…?x=1` → `/backend-api/conversation/:id`, for messages that must not carry ids. */
function label(path: string): string {
  return path
    .split('?')[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/g-p-[0-9a-z]+/gi, 'g-p-:id');
}

export interface ProjectRef {
  id: string;
  name: string;
}

/**
 * Reads ChatGPT's web API sequentially and politely (pauses with jitter, backoff on 429/5xx), validating
 * every response with a schema. Read-only: it only ever issues GET requests.
 */
export class ChatGptClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly paceMs: number;
  private readonly jitterMs: number;
  private readonly maxRetries: number;
  private readonly onWait: ClientOptions['onWait'];
  private first = true;
  /** How many conversations the platform said the last list has (for spotting gaps). */
  listTotal: number | null = null;
  /** What the first page of each list held (how many chats, and the newest change), for spotting gaps. */
  readonly firstPages: {
    active?: { items: number; newest: number | null; origins: Record<string, number> };
    archived?: { items: number; newest: number | null; origins: Record<string, number> };
  } = {};
  /** Added to every pause after the site pushed back, so the rest of the run is gentler. */
  private extraPaceMs = 0;

  constructor(
    private readonly http: HttpJson,
    opts: ClientOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // About a second between requests on average: a full import is slower, but ChatGPT rate-limits bursts.
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
          `ChatGPT answered ${res.status} for ${label(path)}. Sign in again.`,
        );
      }
      if (res.status === 404) throw new NotFound(`Not found: ${label(path)}`);
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) {
          if (res.status === 429)
            throw new RateLimited(
              `ChatGPT is limiting requests (${label(path)}). Try again later.`,
              res.retryAfterSeconds ? res.retryAfterSeconds * 1000 : undefined,
            );
          throw new Error(`ChatGPT answered ${res.status} for ${label(path)}.`);
        }
        // Be gentler for the rest of the run, and wait as long as the site asks (or our own schedule).
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

  /** The signed-in account's id, from the site's own session call. */
  async session(): Promise<{ userId: string }> {
    const s = await this.get('/api/auth/session', sessionSchema);
    return { userId: s.user.id };
  }

  /** The user's projects (id and name). */
  async projects(): Promise<ProjectRef[]> {
    const out: ProjectRef[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = `owned_only=true&conversations_per_gizmo=0&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await this.get(`/backend-api/gizmos/snorlax/sidebar?${qs}`, sidebarSchema);
      for (const item of res.items) {
        const p = sidebarProjectSchema.safeParse(item);
        if (p.success)
          out.push({ id: p.data.gizmo.gizmo.id, name: p.data.gizmo.gizmo.display.name });
      }
      cursor = res.cursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  /** Conversations, newest first. Ends when the list ends, or after `stopWhen` says so. */
  async *conversations(
    archived: boolean,
    stopWhen?: (item: ConversationItem) => boolean,
    /** `'tpp'`: the chats the site lists apart ("work" chats), which the ordinary list leaves out. */
    origin?: 'tpp',
  ): AsyncGenerator<ConversationItem> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const res = await this.get(
        `/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated&is_archived=${archived}${origin ? `&conversation_origin=${origin}` : ''}`,
        conversationPageSchema,
      );
      // What the first page said, noted BEFORE reading it, so it is known even when the list is cut short.
      if (offset === 0 && !origin) {
        const newest = res.items.reduce((m, i) => Math.max(m, Date.parse(i.update_time) || 0), 0);
        const origins: Record<string, number> = {};
        for (const item of res.items) {
          const o = (item as { conversation_origin?: unknown }).conversation_origin;
          if (typeof o === 'string' && /^[a-z0-9_-]{1,40}$/i.test(o))
            origins[o] = (origins[o] ?? 0) + 1;
        }
        this.firstPages[archived ? 'archived' : 'active'] = {
          items: res.items.length,
          newest: newest || null,
          origins,
        };
        if (!archived) this.listTotal = res.total ?? null;
      }
      for (const item of res.items) {
        if (stopWhen?.(item)) return;
        yield item;
      }
      const total = res.total ?? undefined;
      if (
        res.items.length < PAGE_SIZE ||
        (total !== undefined && offset + res.items.length >= total)
      )
        return;
    }
  }

  /** Pinned chats and pinned projects/folders ("Bloccate"), which the main list does not have to include. */
  async pins(): Promise<{
    projects: ProjectRef[];
    chats: { id: string; updated: string | null }[];
  }> {
    const res = await this.get('/backend-api/pins', pinsSchema);
    const projects: ProjectRef[] = [];
    const chats: { id: string; updated: string | null }[] = [];
    for (const { item } of res) {
      if (item.gizmo) projects.push({ id: item.gizmo.id, name: item.gizmo.display.name });
      else if (item.id) chats.push({ id: item.id, updated: item.update_time ?? null });
    }
    return { projects, chats };
  }

  /** Every conversation of one project (paged by cursor). */
  async *projectConversations(projectId: string): AsyncGenerator<ConversationItem> {
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = `limit=${PAGE_SIZE}&owned_only=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await this.get(
        `/backend-api/gizmos/${projectId}/conversations?${qs}`,
        projectConversationPageSchema,
      );
      yield* res.items;
      cursor = res.cursor ?? null;
      if (!cursor) return;
    }
  }

  /** The signed link to an image file of a conversation. */
  async imageUrl(fileId: string, conversationId: string): Promise<string> {
    const res = await this.get(
      `/backend-api/files/download/${encodeURIComponent(fileId)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`,
      fileDownloadSchema,
    );
    if (res.status && res.status !== 'success')
      throw new NotFound('The image is no longer available.');
    return res.download_url;
  }

  /**
   * A chat read the way the site reads its work chats: `GET /backend-api/conversations/<id>`, a flat list of messages.
   * Asked for a large number of turns first; if the site does not take that, without. If it says there are earlier turns
   * it did not return, the result says so (`maybeMore`). NOT confirmed which parameter asks for the earlier ones.
   */
  async workConversation(id: string): Promise<{ detail: ConversationDetail; maybeMore: boolean }> {
    const path = `/backend-api/conversations/${encodeURIComponent(id)}`;
    let flat;
    try {
      flat = await this.get(`${path}?num_turns=100`, conversationFlatSchema);
    } catch (err) {
      if (!(err instanceof EndpointChanged)) throw err;
      flat = await this.get(path, conversationFlatSchema);
    }
    return { detail: flatToDetail(flat), maybeMore: flat.page_info?.has_previous_page === true };
  }

  async conversation(id: string): Promise<ConversationDetail> {
    return this.get(
      `/backend-api/conversation/${encodeURIComponent(id)}`,
      conversationDetailSchema,
    );
  }
}
