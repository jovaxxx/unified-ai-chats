import { EndpointChanged, NotFound, SessionExpired } from '../errors';
import type {
  AccountContext,
  Connector,
  RemoteConversation,
  RemoteConversationSummary,
} from '../types';
import { ChatGptClient, type ClientOptions } from './client';
import { parseConversation } from './parse';

/** The folder the work chats are filed in (a project of its own that the platform does not have). */
const WORK_FOLDER_ID = 'work';
const WORK_FOLDER_NAME = 'WORK';

/** Project names found at the start of a sync, used when each conversation is read. */
const projectNames = new WeakMap<AccountContext, Map<string, string>>();
/** Counts about the last listing (numbers only), so a gap between what ChatGPT says and what was read shows. */
const listingNotes = new WeakMap<AccountContext, Record<string, number>>();
/** The chats that came from the list the site keeps apart ("work"): they are read the way the site reads them. */
const workChats = new WeakMap<AccountContext, Set<string>>();

function clientFor(ctx: AccountContext, opts: ClientOptions | undefined): ChatGptClient {
  if (!ctx.http) throw new Error('The ChatGPT connector needs a signed-in session.');
  return new ChatGptClient(ctx.http, {
    ...opts,
    onWait: (ms) => {
      ctx.onWait?.(ms);
      opts?.onWait?.(ms);
    },
  });
}

/**
 * ChatGPT, read-only, through the profile's own signed-in browser session.
 *
 * Built from a structure report recorded on a real account, and run against few real
 * accounts. Assumptions not confirmed by the report: `is_archived=true` on the same list endpoint
 * returns the archive, and the project sidebar/conversation calls accept the parameters used here.
 * Anything that does not match raises EndpointChanged instead of being guessed at.
 */
export function createChatGptConnector(opts?: ClientOptions): Connector {
  return {
    id: 'chatgpt',
    // Read-only: no renaming, archiving or deleting on the platform (off by default).
    capabilities: { projects: true, archive: false, rename: false, delete: false, images: false },

    async checkSession(ctx) {
      try {
        await clientFor(ctx, opts).session();
        return 'ok';
      } catch (err) {
        return err instanceof SessionExpired ? 'login_required' : 'unknown';
      }
    },

    /** Refuses to go on if the signed-in account is not the one this profile was made for. */
    async verifyAccount(ctx) {
      const { userId } = await clientFor(ctx, opts).session();
      if (ctx.expectedIdentity && ctx.expectedIdentity !== userId) {
        throw new SessionExpired(
          'This profile is signed in as a different ChatGPT account than the one it was created for. Sign in again with the right account.',
        );
      }
    },

    /** ChatGPT's own complete record of the conversation (every field it returned), for the safety copy. */
    async exportRaw(ctx, remoteId) {
      return clientFor(ctx, opts).conversation(remoteId);
    },

    async *listConversations(ctx, since) {
      const client = clientFor(ctx, opts);

      // The profile must be signed in as the account it was created for: never mix two accounts.
      const { userId } = await client.session();
      if (ctx.expectedIdentity && ctx.expectedIdentity !== userId) {
        throw new SessionExpired(
          'This profile is signed in as a different ChatGPT account than the one it was created for. Sign in again with the right account.',
        );
      }

      // Projects give the names; failing to read them must not stop the chats from being imported.
      const names = new Map<string, string>();
      projectNames.set(ctx, names);
      let projects: { id: string; name: string }[] = [];
      try {
        projects = await client.projects();
        for (const p of projects) names.set(p.id, p.name);
      } catch {
        /* chats still import, filed under a generic project name */
      }

      // Pinned chats and folders ("Bloccate") may not be in the lists above: ask for them too.
      let pinnedChats: { id: string; updated: string | null }[] = [];
      let pinnedProjects = 0;
      try {
        const pins = await client.pins();
        pinnedChats = pins.chats;
        for (const p of pins.projects) {
          if (names.has(p.id)) continue;
          names.set(p.id, p.name);
          projects.push(p);
          pinnedProjects++;
        }
      } catch {
        /* pins are an extra; the rest still imports */
      }
      const notes: Record<string, number> = {
        projects: projects.length,
        pinnedProjectsAdded: pinnedProjects,
        pinnedChats: pinnedChats.length,
        found: 0,
        fromPins: 0,
        fromProjects: 0,
      };
      listingNotes.set(ctx, notes);

      const seen = new Set<string>();
      const fresh = (updated: string) => !since || new Date(updated) > since;
      const summary = (id: string, updated: string): RemoteConversationSummary => ({
        remoteId: id,
        remoteUpdatedAt: updated,
      });

      // Lists are newest first, so an incremental sync can stop at the first unchanged conversation.
      for (const archived of [false, true]) {
        for await (const item of client.conversations(archived, (i) => !fresh(i.update_time))) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          yield summary(item.id, item.update_time);
        }
      }
      // The list the site keeps apart for "work" chats; the ordinary list leaves them out. It is short, so it is read
      // whole every time (never cut at "since"): a work chat that existed before this was built must still be found, and
      // the sync skips the ones it already has. A failure here never stops the rest of the sync.
      const work = new Set<string>();
      workChats.set(ctx, work);
      notes.workListed = 0;
      try {
        for (const archived of [false, true]) {
          for await (const item of client.conversations(archived, undefined, 'tpp')) {
            work.add(item.id);
            notes.workListed = (notes.workListed ?? 0) + 1;
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            notes.work = (notes.work ?? 0) + 1;
            yield summary(item.id, item.update_time);
          }
        }
      } catch (err) {
        if (err instanceof SessionExpired) throw err;
        notes.workListFailed = 1;
      }
      notes.found = seen.size;
      notes.listTotal = client.listTotal ?? 0;
      // Numbers only: how many chats each first page held, when the newest changed, and what a run counts as new.
      const sec = (ms: number | null | undefined) => (ms ? Math.floor(ms / 1000) : 0);
      notes.firstPageItems = client.firstPages.active?.items ?? 0;
      notes.firstPageNewest = sec(client.firstPages.active?.newest);
      notes.archivedFirstPageItems = client.firstPages.archived?.items ?? 0;
      notes.newerThan = sec(since?.getTime());
      // How many of the first page's chats came from each kind of origin (the word the site gives it, never content).
      for (const [name, n] of Object.entries(client.firstPages.active?.origins ?? {}))
        notes[`origin:${name}`] = n;
      for (const pin of pinnedChats) {
        if (seen.has(pin.id)) continue;
        seen.add(pin.id);
        notes.fromPins = (notes.fromPins ?? 0) + 1;
        // No date from the pin: read it again this time, whatever `since` says.
        yield summary(pin.id, pin.updated ?? new Date().toISOString());
      }
      // Conversations that live in a project may not be in the main list.
      for (const p of ctx.includeProjects === false ? [] : projects) {
        for await (const item of client.projectConversations(p.id)) {
          if (seen.has(item.id) || !fresh(item.update_time)) continue;
          seen.add(item.id);
          notes.fromProjects = (notes.fromProjects ?? 0) + 1;
          yield summary(item.id, item.update_time);
        }
      }
    },

    /** Every chat ChatGPT has: the ordinary lists, the archive, the work list, every project and the pins. */
    async *listAllIds(ctx) {
      const client = clientFor(ctx, opts);
      const seen = new Set<string>();
      const fresh = (id: string) => (seen.has(id) ? false : (seen.add(id), true));
      for (const archived of [false, true]) {
        for await (const item of client.conversations(archived)) if (fresh(item.id)) yield item.id;
      }
      for (const archived of [false, true]) {
        for await (const item of client.conversations(archived, undefined, 'tpp'))
          if (fresh(item.id)) yield item.id;
      }
      for (const project of await client.projects()) {
        for await (const item of client.projectConversations(project.id))
          if (fresh(item.id)) yield item.id;
      }
      for (const chat of (await client.pins()).chats) if (fresh(chat.id)) yield chat.id;
    },

    notes: (ctx) => listingNotes.get(ctx) ?? {},

    async imageLink(ctx, image, remoteConversationId) {
      const fileId = /^[a-z-]+:\/\/([A-Za-z0-9_-]{6,120})$/.exec(image.ref)?.[1];
      if (!fileId)
        throw new NotFound('This image reference is not one this app knows how to fetch.');
      return clientFor(ctx, opts).imageUrl(fileId, remoteConversationId);
    },

    async downloadImage(ctx, image, remoteConversationId) {
      if (!ctx.downloadUrl) throw new Error('The ChatGPT connector needs a way to download files.');
      // `file-service://file-abc` or `sediment://file_abc` -> the file id.
      const fileId = /^[a-z-]+:\/\/([A-Za-z0-9_-]{6,120})$/.exec(image.ref)?.[1];
      if (!fileId)
        throw new NotFound('This image reference is not one this app knows how to fetch.');
      const url = await clientFor(ctx, opts).imageUrl(fileId, remoteConversationId);
      if (new URL(url).protocol !== 'https:')
        throw new Error('Refusing a download link that is not https.');
      const res = await ctx.downloadUrl(url);
      if (res.status === 403 || res.status === 404 || res.status === 410) {
        throw new NotFound(`The image file is gone (HTTP ${res.status}).`);
      }
      if (res.status !== 200) throw new Error(`Downloading an image answered HTTP ${res.status}.`);
      return { bytes: res.bytes, mime: res.mime ?? '' };
    },

    async getConversation(ctx, remoteId): Promise<RemoteConversation> {
      const client = clientFor(ctx, opts);
      const names = projectNames.get(ctx);
      const asWork = async () => {
        const { detail, maybeMore } = await client.workConversation(remoteId);
        const parsed = parseConversation(detail, remoteId, (id) => names?.get(id));
        return maybeMore
          ? { ...parsed, skipped: { ...parsed.skipped, 'turns:maybe-more': 1 } }
          : parsed;
      };
      /** Work chats sit in a folder of their own, WORK, unless they already belong to a project. */
      const inWorkFolder = (c: RemoteConversation): RemoteConversation =>
        workChats.get(ctx)?.has(remoteId) && !c.projectRemoteId
          ? { ...c, projectRemoteId: WORK_FOLDER_ID, projectName: WORK_FOLDER_NAME }
          : c;
      const asOrdinary = async () =>
        parseConversation(await client.conversation(remoteId), remoteId, (id) => names?.get(id));
      // A work chat is read the way the site reads it; the old way is the fallback, and the other way round.
      const first = workChats.get(ctx)?.has(remoteId) ? asWork : asOrdinary;
      const second = first === asWork ? asOrdinary : asWork;
      try {
        return inWorkFolder(await first());
      } catch (err) {
        if (!(err instanceof NotFound) && !(err instanceof EndpointChanged)) throw err;
        try {
          return inWorkFolder(await second());
        } catch (again) {
          // The way that was tried first is the one worth reporting when neither works.
          if (again instanceof NotFound || again instanceof EndpointChanged) throw err;
          throw again;
        }
      }
    },
  };
}

export const chatgptConnector = createChatGptConnector();
