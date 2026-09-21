import { NotFound, SessionExpired } from '../errors';
import type { ClientOptions } from '../chatgpt/client';
import type {
  AccountContext,
  Connector,
  RemoteConversation,
  RemoteConversationSummary,
} from '../types';
import { ClaudeClient } from './client';
import { parseConversation } from './parse';

/** What a sync learned about this profile: which organization each chat lives in, and the project names. */
interface Listing {
  orgOf: Map<string, string>;
  archived: Set<string>;
  projects: Map<string, string>;
  notes: Record<string, number>;
}
const listings = new WeakMap<AccountContext, Listing>();

function clientFor(ctx: AccountContext, opts: ClientOptions | undefined): ClaudeClient {
  if (!ctx.http) throw new Error('The Claude connector needs a signed-in session.');
  return new ClaudeClient(ctx.http, {
    ...opts,
    onWait: (ms) => {
      ctx.onWait?.(ms);
      opts?.onWait?.(ms);
    },
  });
}

/**
 * Claude (claude.ai), read-only, through the profile's own signed-in browser session.
 *
 * The chat list, the chat itself and the projects come from a structure report recorded on a real account. NOT
 * confirmed by it: `/api/organizations` and `/api/account`, and whether `starred=true` lists starred chats. Anything
 * that does not match raises EndpointChanged instead of being guessed at.
 */
export function createClaudeConnector(opts?: ClientOptions): Connector {
  const client = new WeakMap<AccountContext, ClaudeClient>();
  const of = (ctx: AccountContext) => {
    let c = client.get(ctx);
    if (!c) {
      c = clientFor(ctx, opts);
      client.set(ctx, c);
    }
    return c;
  };
  return {
    id: 'claude',
    capabilities: { projects: true, archive: false, rename: false, delete: false, images: false },

    async checkSession(ctx) {
      try {
        await of(ctx).organizations();
        return 'ok';
      } catch (err) {
        return err instanceof SessionExpired ? 'login_required' : 'unknown';
      }
    },

    async verifyAccount(ctx) {
      if (!ctx.expectedIdentity) return;
      if ((await of(ctx).accountId()) !== ctx.expectedIdentity) {
        throw new SessionExpired(
          'This profile is signed in as a different Claude account than the one it was created for. Sign in again with the right account.',
        );
      }
    },

    async *listConversations(ctx): AsyncGenerator<RemoteConversationSummary> {
      const c = of(ctx);
      await this.verifyAccount!(ctx);
      const orgs = await c.organizations();
      const listing: Listing = {
        orgOf: new Map(),
        archived: new Set(),
        projects: new Map(),
        notes: { organizations: orgs.length, projects: 0, found: 0, starredOnly: 0 },
      };
      listings.set(ctx, listing);
      for (const org of orgs) {
        try {
          for (const p of await c.projects(org)) listing.projects.set(p.uuid, p.name);
        } catch {
          /* chats still import, filed under a generic project name */
        }
      }
      listing.notes.projects = listing.projects.size;
      const seen = new Set<string>();
      for (const org of orgs) {
        for (const filter of ['active', 'archived', 'starred'] as const) {
          for await (const item of c.conversations(org, filter)) {
            if (seen.has(item.uuid)) continue;
            seen.add(item.uuid);
            listing.orgOf.set(item.uuid, org);
            if (filter === 'archived') listing.archived.add(item.uuid);
            if (filter === 'starred')
              listing.notes.starredOnly = (listing.notes.starredOnly ?? 0) + 1;
            yield { remoteId: item.uuid, remoteUpdatedAt: item.updated_at };
          }
        }
      }
      listing.notes.found = seen.size;
    },

    notes: (ctx) => listings.get(ctx)?.notes ?? {},

    async getConversation(ctx, remoteId): Promise<RemoteConversation> {
      const listing = listings.get(ctx);
      const org = listing?.orgOf.get(remoteId) ?? (await of(ctx).organizations())[0];
      if (!org) throw new NotFound('No Claude organization found for this profile.');
      const detail = await of(ctx).conversation(org, remoteId);
      const parsed = parseConversation(detail, remoteId, (id) => listing?.projects.get(id));
      return listing?.archived.has(remoteId) ? { ...parsed, archived: true } : parsed;
    },
  };
}

export const claudeConnector = createClaudeConnector();
