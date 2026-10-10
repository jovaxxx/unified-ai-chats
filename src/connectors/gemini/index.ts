import { NotFound, SessionExpired } from '../errors';
import type { ClientOptions } from '../chatgpt/client';
import type {
  AccountContext,
  Connector,
  RemoteConversation,
  RemoteConversationSummary,
} from '../types';
import { GeminiClient } from './client';
import { isImageLink, isVideoLink, parseConversation, POSTER_MARK, VIDEO_MARK } from './parse';

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

    /**
     * Fetches one picture, a video's still or a video, as this profile's session. A picture or a still comes from
     * Gemini's image host; a video from Google's user-content download address. Nothing else.
     */
    async downloadImage(ctx, image) {
      if (!ctx.downloadUrl) throw new Error('The Gemini connector needs a way to download files.');
      const isVideo = image.ref.endsWith(VIDEO_MARK);
      const url = image.ref.endsWith(VIDEO_MARK)
        ? image.ref.slice(0, -VIDEO_MARK.length)
        : image.ref.endsWith(POSTER_MARK)
          ? image.ref.slice(0, -POSTER_MARK.length)
          : image.ref;
      if (!(isVideo ? isVideoLink(url) : isImageLink(url)))
        throw new NotFound('This image reference is not one this app knows how to fetch.');
      const res = await ctx.downloadUrl(url);
      if (res.status === 403 || res.status === 404 || res.status === 410) {
        throw new NotFound(`The file is gone (HTTP ${res.status}).`);
      }
      if (res.status !== 200) throw new Error(`Downloading a file answered HTTP ${res.status}.`);
      return { bytes: res.bytes, mime: res.mime ?? '' };
    },

    async getConversation(ctx, remoteId): Promise<RemoteConversation> {
      const payload = await of(ctx).chat(remoteId);
      const listed = listings.get(ctx)?.get(remoteId);
      if (!payload) throw new NotFound('Gemini does not have this chat.');
      return parseConversation(payload, remoteId, listed);
    },
  };
}

export const geminiConnector = createGeminiConnector();
