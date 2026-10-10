import { describe, expect, it } from 'vitest';
import { NotFound, RateLimited } from '../connectors/errors';
import type { AccountContext, Connector, RemoteConversation } from '../connectors/types';
import { openDatabase } from './db';
import { Repo } from './repo';
import { syncAccount } from './sync';

const NOW = '2026-09-01T00:00:00.000Z';

function setup(ids: string[]) {
  const repo = new Repo(openDatabase());
  const accountId = repo.addAccount({ platform: 'chatgpt', label: 'Acme', partition: 'persist:x' });
  const chat = new Map<string, number>();
  for (const remoteId of ids) {
    chat.set(
      remoteId,
      repo.upsertConversation({
        accountId,
        remoteId,
        remoteTitle: `Chat ${remoteId}`,
        createdAt: NOW,
        remoteUpdatedAt: NOW,
        messages: [{ role: 'user', createdAt: NOW, blocks: [{ type: 'text', text: 'hi' }] }],
      }),
    );
  }
  return { repo, accountId, chat };
}

/** A platform that has the chats in `present`; the ones in `readable` can still be read; the others say not found. */
function platform(opts: {
  present: string[];
  readable?: string[];
  readError?: Record<string, Error>;
  listError?: Error;
}) {
  const calls = { listAll: 0, reads: [] as string[] };
  const connector: Connector = {
    id: 'chatgpt',
    capabilities: { projects: false, archive: false, rename: false, delete: false, images: false },
    checkSession: async () => 'ok',
    async *listConversations() {},
    async getConversation(_ctx, id): Promise<RemoteConversation> {
      calls.reads.push(id);
      if (opts.readError?.[id]) throw opts.readError[id]!;
      if (opts.readable?.includes(id) || opts.present.includes(id)) {
        return {
          remoteId: id,
          remoteTitle: id,
          createdAt: NOW,
          updatedAt: NOW,
          messages: [],
        };
      }
      throw new NotFound('Not found');
    },
    async *listAllIds() {
      calls.listAll++;
      if (opts.listError) throw opts.listError;
      yield* opts.present;
    },
  };
  return { connector, calls };
}

const ctx = (accountId: number): AccountContext => ({ accountId });
const run = (s: ReturnType<typeof setup>, c: Connector, checkRemoved = true) =>
  syncAccount(s.repo, c, ctx(s.accountId), undefined, { checkRemoved });
const state = (s: ReturnType<typeof setup>, id: string) => s.repo.getChat(s.chat.get(id)!)!.state;

describe('chats deleted on the platform follow it into the Trash', () => {
  it('a chat the platform no longer has, confirmed as not found, goes to the Trash; the others stay', async () => {
    const s = setup(['a', 'b', 'c']);
    const p = platform({ present: ['a', 'c'] });
    const stats = await run(s, p.connector);
    expect(stats.removed).toBe(1);
    expect(state(s, 'b')).toBe('trashed_local'); // the app's own Trash: it waits there before it goes for good
    expect(state(s, 'a')).toBe('inbox');
    expect(state(s, 'c')).toBe('inbox');
    expect(s.repo.getChat(s.chat.get('b')!)!.trashPurgeAt).not.toBeNull();
  });

  it('a chat missing from the list but still readable stays where it is', async () => {
    const s = setup(['a', 'b']);
    const stats = await run(s, platform({ present: ['a'], readable: ['b'] }).connector);
    expect(stats.removed).toBeUndefined();
    expect(state(s, 'b')).toBe('inbox');
  });

  it('only a clear "not found" counts: any other answer leaves the chat alone', async () => {
    const s = setup(['a', 'b']);
    const stats = await run(
      s,
      platform({ present: ['a'], readError: { b: new RateLimited('busy') } }).connector,
    );
    expect(stats.removed).toBeUndefined();
    expect(state(s, 'b')).toBe('inbox');
  });

  it('an empty or failed list never causes a clean-up, and never fails the sync', async () => {
    const s = setup(['a', 'b']);
    const empty = await run(s, platform({ present: [] }).connector);
    expect(empty.removed).toBeUndefined();
    expect(empty.listing).toMatchObject({ removalCheckEmptyList: 1 });
    s.repo.setSetting(`removal_check:${s.accountId}`, '');
    const failed = await run(
      s,
      platform({ present: ['a'], listError: new Error('boom') }).connector,
    );
    expect(failed.removed).toBeUndefined();
    expect(failed.listing).toMatchObject({ removalCheckFailed: 1 });
    expect(state(s, 'a')).toBe('inbox');
    expect(state(s, 'b')).toBe('inbox');
  });

  it('is only done when asked for, never by a plain run', async () => {
    const s = setup(['a', 'b']);
    const p = platform({ present: ['a'] });
    await run(s, p.connector, false);
    expect(p.calls.listAll).toBe(0);
    expect(state(s, 'b')).toBe('inbox');
  });

  it('is made at most every ten minutes for a profile, and looks at archived chats too, never at the Trash', async () => {
    const s = setup(['a', 'b', 'c']);
    s.repo.bulk([s.chat.get('c')!], { type: 'trash' }); // already in the Trash: not a candidate
    s.repo.bulk([s.chat.get('b')!], { type: 'archive' });
    const p = platform({ present: ['a'] });
    await run(s, p.connector);
    expect(state(s, 'b')).toBe('trashed_local'); // the archived one was checked
    expect(p.calls.reads).toEqual(['b']); // the one already in the Trash was not asked for
    await run(s, p.connector);
    expect(p.calls.listAll).toBe(1); // the second run came too soon
  });

  it('confirms at most 150 per run and goes on at the next one, however soon it comes', async () => {
    const ids = Array.from({ length: 165 }, (_, i) => `x${i}`);
    const s = setup(['keep', ...ids]);
    const p = platform({ present: ['keep'] });
    const first = await run(s, p.connector);
    expect(first.removed).toBe(150);
    const second = await run(s, p.connector); // not ten minutes later, but the first stopped at its limit
    expect(second.removed).toBe(15);
    expect(s.repo.liveRemoteIds(s.accountId).map((c) => c.remoteId)).toEqual(['keep']);
  });
});
