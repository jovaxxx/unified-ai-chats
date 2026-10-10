import { NotFound, SessionExpired } from '../errors';
import type { ClientOptions } from '../chatgpt/client';
import type {
  AccountContext,
  Connector,
  RemoteConversation,
  RemoteConversationSummary,
} from '../types';
import { GeminiClient } from './client';
import { parseConversation } from './parse';

/** What a sync's listing learned about each chat: the title and the last change, which the chat itself lacks. */
const listings = new WeakMap<AccountContext, Map<string, { title: string; updatedAt: string }>>();
const notesOf = new WeakMap<AccountContext, Record<string, number>>();

function clientFor(ctx: AccountContext, opts: ClientOptions | undefined): GeminiClient {
  if (!ctx.rpc) throw new Error('The Gemini connector needs a signed-in session.');
  return new GeminiClient(ctx.rpc, {
    ...opts,
    onWait: (ms) => {
      ctx.onWait?.(ms);
      opts?.onWait?.(ms);
    },
  });
}

/**
 * Gemini (gemini.google.com), read-only, through the profile's own signed-in browser session.
 *
 * Built from a structure report recorded on a real account, and NOT yet run against one: see `client.ts` for what
 * the report did not show. The account is not identified (Gemini does not hand out an id this app knows), so a
 * profile is the session it was signed in with. Anything that does not match raises EndpointChanged.
 */
export function createGeminiConnector(opts?: ClientOptions): Connector {
  const client = new WeakMap<AccountContext, GeminiClient>();
  const of = (ctx: AccountContext) => {
    let c = client.get(ctx);
    if (!c) {
      c = clientFor(ctx, opts);
      client.set(ctx, c);
    }
    return c;
  };
  return {
    id: 'gemini',
    capabilities: { projects: false, archive: false, rename: false, delete: false, images: false },

    async checkSession(ctx) {
      try {
        for await (const chat of of(ctx).chats(() => true)) void chat;
        return 'ok';
      } catch (err) {
        return err instanceof SessionExpired ? 'login_required' : 'unknown';
      }
    },

    async *listConversations(ctx, since): AsyncGenerator<RemoteConversationSummary> {
      const known = new Map<string, { title: string; updatedAt: string }>();
      listings.set(ctx, known);
      const notes = { found: 0 };
      notesOf.set(ctx, notes);
      const fresh = (updated: string) => !since || new Date(updated) > since;
      for await (const chat of of(ctx).chats((c) => !fresh(c.updatedAt))) {
        known.set(chat.id, { title: chat.title, updatedAt: chat.updatedAt });
        notes.found++;
        yield { remoteId: chat.id, remoteUpdatedAt: chat.updatedAt };
      }
    },

    notes: (ctx) => notesOf.get(ctx) ?? {},

    async getConversation(ctx, remoteId): Promise<RemoteConversation> {
      const payload = await of(ctx).chat(remoteId);
      const listed = listings.get(ctx)?.get(remoteId);
      if (!payload) throw new NotFound('Gemini does not have this chat.');
      return parseConversation(payload, remoteId, listed);
    },
  };
}

export const geminiConnector = createGeminiConnector();
