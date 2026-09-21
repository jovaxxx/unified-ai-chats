import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EndpointChanged, NotFound, RateLimited, SessionExpired } from '../connectors/errors';
import type { Connector } from '../connectors/types';
import { ActionQueue, ActionRunner } from './actions';
import { createApi } from './api';
import { openDatabase } from './db';
import { exportConversation } from './exporter';
import { Repo } from './repo';
import { fakeWeb, writableConnector } from './testing';

const noSleep = async () => {};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uac-actions-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(connector: Connector | undefined = writableConnector().connector) {
  const repo = new Repo(openDatabase());
  const web = fakeWeb();
  const api = createApi(repo, {
    openExternal: async () => {},
    web: web.host,
    exportDir: join(dir, 'exports'),
    connectors: connector ? { chatgpt: connector } : {},
    actions: { autoRun: false, sleep: noSleep, paceMs: 0, jitterMs: 0 },
  });
  return { repo, web, api };
}
type Ctx = ReturnType<typeof setup>;

async function profile(c: Ctx, label: string, identity: string): Promise<number> {
  c.web.signedInAs(identity);
  const { attemptId } = await c.api.signInStart('chatgpt');
  await c.api.signInStatus(attemptId);
  return (await c.api.signInFinish(attemptId, { type: 'new', label })).accountId;
}

function addChats(repo: Repo, accountId: number, n: number, prefix = 'Chat'): number[] {
  return Array.from({ length: n }, (_, i) =>
    repo.upsertConversation({
      accountId,
      remoteId: `remote-${prefix}-${i + 1}`,
      remoteTitle: `${prefix} ${i + 1}`,
      createdAt: '2026-09-01T00:00:00.000Z',
      remoteUpdatedAt: `2026-09-${10 + i}T00:00:00.000Z`,
      messages: [
        {
          role: 'user',
          createdAt: '2026-09-01T00:00:00.000Z',
          blocks: [{ type: 'text', text: `Question in ${prefix} ${i + 1}` }],
        },
        {
          role: 'assistant',
          createdAt: '2026-09-01T00:00:01.000Z',
          blocks: [
            { type: 'text', text: 'Answer.' },
            { type: 'code', lang: 'ts', text: 'const x = 1;' },
          ],
        },
      ],
    }),
  );
}

describe('changes on the platform are off until the user allows them', () => {
  it('nothing is queued or sent by default, whatever you do in the app', async () => {
    const { connector, calls } = writableConnector();
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    const [id] = addChats(c.repo, acc, 1);
    await c.api.setTitle(id!, 'Renamed locally');
    await c.api.bulk([id!], { type: 'archive' });
    await c.api.bulk([id!], { type: 'trash' });
    expect(await c.api.queueSummary()).toMatchObject({ pending: 0, running: 0 });
    await c.api.queueRun();
    expect(calls).toEqual([]);
    expect(c.repo.getChat(id!)!.title).toBe('Renamed locally'); // the local change still happened
  });

  it('cannot be turned on for a platform the app cannot change things on', async () => {
    const { connector } = writableConnector({
      capabilities: { projects: true, archive: false, rename: false, delete: false, images: false },
    });
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await expect(c.api.allowChanges(acc, true)).rejects.toThrow(
      /cannot change things on this platform yet/,
    );
    expect((await c.api.sidebar()).platforms[0]!.accounts[0]).toMatchObject({
      allowChanges: false,
      canWrite: { rename: false, archive: false, delete: false },
    });
  });

  it('the sidebar says what the profile allows and what the connector can do', async () => {
    const c = setup();
    const acc = await profile(c, 'Acme Store', 'user-A');
    expect((await c.api.sidebar()).platforms[0]!.accounts[0]).toMatchObject({
      allowChanges: false,
      canWrite: { rename: true, archive: true, delete: true },
    });
    await c.api.allowChanges(acc, true);
    expect((await c.api.sidebar()).platforms[0]!.accounts[0]!.allowChanges).toBe(true);
  });
});

describe('rename and archive follow to the platform', () => {
  it('a rename is sent, and two renames before it goes out become one with the latest title', async () => {
    const { connector, calls } = writableConnector();
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const [id] = addChats(c.repo, acc, 1);
    await c.api.setTitle(id!, 'First name');
    await c.api.setTitle(id!, 'Second name');
    expect((await c.api.queueList()).filter((a) => a.status === 'pending')).toHaveLength(1);
    expect(c.repo.listChats({}).items[0]!.remoteSync).toBe('pending'); // the chat says it is waiting

    const res = await c.api.queueRun();
    expect(res).toEqual({ done: 1, failed: 0 });
    expect(calls).toEqual(['verify', 'rename remote-Chat-1 -> Second name']);
    expect(c.repo.listChats({}).items[0]!.remoteSync).toBe('idle');
  });

  it('archive then unarchive before sending cancels the archive; only real changes are sent', async () => {
    const { connector, calls } = writableConnector();
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const ids = addChats(c.repo, acc, 3);
    await c.api.bulk([ids[0]!], { type: 'archive' });
    await c.api.bulk([ids[0]!], { type: 'unarchive' });
    await c.api.bulk([ids[1]!, ids[2]!], { type: 'archive' });
    await c.api.bulk([ids[1]!], { type: 'archive' }); // already archived: nothing changed, nothing queued
    await c.api.queueRun();
    expect(calls.filter((x) => x !== 'verify').sort()).toEqual([
      'archive remote-Chat-2',
      'archive remote-Chat-3',
      'unarchive remote-Chat-1',
    ]);
  });

  it('turning changes off withdraws what was waiting', async () => {
    const { connector, calls } = writableConnector();
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const [id] = addChats(c.repo, acc, 1);
    await c.api.setTitle(id!, 'Will not be sent');
    await c.api.allowChanges(acc, false);
    await c.api.queueRun();
    expect(calls).toEqual([]);
    expect((await c.api.queueList())[0]).toMatchObject({ status: 'cancelled' });
  });

  it('a rename to an empty title is never sent', async () => {
    const { connector, calls } = writableConnector();
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const [id] = addChats(c.repo, acc, 1);
    await c.api.setTitle(id!, '   ');
    await c.api.queueRun();
    expect(calls).toEqual([]);
  });
});

describe('deleting on the platform (the function that matters)', () => {
  const trash = async (c: Ctx, ids: number[]) => c.api.bulk(ids, { type: 'trash' });

  it('saves a verified full copy first, then deletes on the platform, then removes the chat here', async () => {
    const { connector, calls } = writableConnector();
    let copyExistedWhenDeleting = false;
    const inner = connector.delete!;
    connector.delete = async (ctx, id) => {
      copyExistedWhenDeleting =
        existsSync(join(dir, 'exports')) && readdirSync(join(dir, 'exports')).length > 0;
      await inner(ctx, id);
    };
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const ids = addChats(c.repo, acc, 3);
    await trash(c, ids);

    const plan = await c.api.planDelete(ids);
    expect(plan).toMatchObject({
      total: 3,
      allowed: [{ label: 'Acme Store', count: 3 }],
      blocked: [],
    });
    expect(await c.api.deleteOnPlatform(ids)).toEqual({ queued: 3, blocked: 0 });
    // Queued, not yet gone: still in the Trash, marked as waiting.
    expect(c.repo.listChats({ view: 'trash' }).items.every((x) => x.remoteSync === 'pending')).toBe(
      true,
    );

    expect(await c.api.queueRun()).toEqual({ done: 3, failed: 0 });
    expect(copyExistedWhenDeleting).toBe(true); // the copy was there BEFORE the delete
    expect(calls.filter((x) => x.startsWith('delete')).sort()).toEqual([
      'delete remote-Chat-1',
      'delete remote-Chat-2',
      'delete remote-Chat-3',
    ]);
    expect(c.repo.sidebar().trashed).toBe(0);
    expect(ids.every((id) => c.repo.getChat(id) === null)).toBe(true);
    expect(c.repo.isIgnored(acc, 'remote-Chat-2')).toBe(true); // a later sync will not bring it back

    // The safety copies stay on disk: JSON with the platform's own record + Markdown.
    const folders = readdirSync(join(dir, 'exports', 'chatgpt', 'acme-store'));
    expect(folders).toHaveLength(3);
    const one = join(
      dir,
      'exports',
      'chatgpt',
      'acme-store',
      folders.find((f) => f.includes('-chat-1-'))!,
    );
    const json = JSON.parse(readFileSync(join(one, 'conversation.json'), 'utf8'));
    expect(json).toMatchObject({
      title: 'Chat 1',
      rawIncluded: true,
      raw: { platformRecord: true, id: 'remote-Chat-1' },
      source: { platform: 'chatgpt', account: 'Acme Store' },
    });
    expect(json.messages).toHaveLength(2);
    const md = readFileSync(join(one, 'conversation.md'), 'utf8');
    expect(md).toContain('# Chat 1');
    expect(md).toContain('Question in Chat 1');
    expect(md).toContain('```ts');
  });

  it('does NOT delete on the platform if the safety copy cannot be made or verified', async () => {
    const { connector, calls } = writableConnector();
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const [id] = addChats(c.repo, acc, 1);
    await trash(c, [id!]);
    writeFileSync(join(dir, 'exports'), 'a file, so a folder cannot be created there');
    await c.api.deleteOnPlatform([id!]);
    const res = await c.api.queueRun();
    expect(res.done).toBe(0);
    expect(calls.some((x) => x.startsWith('delete'))).toBe(false); // nothing was deleted
    expect(c.repo.getChat(id!)).not.toBeNull(); // the chat is still here, in the Trash
    expect(c.repo.getChat(id!)!.state).toBe('trashed_local');
    expect((await c.api.queueList())[0]).toMatchObject({ status: 'pending', attempts: 1 }); // will be retried
  });

  it('a chat restored from the Trash is never deleted, even if the delete was already queued', async () => {
    const { connector, calls } = writableConnector();
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const [a, b] = addChats(c.repo, acc, 2);
    await trash(c, [a!, b!]);
    await c.api.deleteOnPlatform([a!, b!]);
    await c.api.bulk([a!], { type: 'restore' }); // through the api: withdraws the queued delete
    c.repo.bulk([b!], { type: 'restore' }); // behind the api's back (e.g. an older window): the runner must still notice
    const res = await c.api.queueRun();
    expect(calls.some((x) => x.startsWith('delete'))).toBe(false);
    expect(c.repo.getChat(a!)!.state).toBe('inbox');
    expect(c.repo.getChat(b!)!.state).toBe('inbox');
    expect(res.done).toBe(0);
    expect((await c.api.queueList()).every((x) => x.status === 'cancelled')).toBe(true);
  });

  it('profiles that do not allow changes are only offered a removal from this app', async () => {
    const c = setup();
    const on = await profile(c, 'Acme Store', 'user-A');
    const off = await profile(c, 'Bluewave Studio', 'user-B');
    await c.api.allowChanges(on, true);
    const ids = [...addChats(c.repo, on, 2, 'On'), ...addChats(c.repo, off, 3, 'Off')];
    await trash(c, ids);
    const plan = await c.api.planDelete(ids);
    expect(plan.allowed).toEqual([
      { accountId: on, platform: 'chatgpt', label: 'Acme Store', count: 2 },
    ]);
    expect(plan.blocked).toEqual([
      {
        accountId: off,
        platform: 'chatgpt',
        label: 'Bluewave Studio',
        count: 3,
        reason: 'not_allowed',
      },
    ]);
    expect(await c.api.deleteOnPlatform(ids)).toEqual({ queued: 2, blocked: 3 });
  });

  it('a chat that is not in the Trash cannot be deleted on the platform', async () => {
    const { connector, calls } = writableConnector();
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const [id] = addChats(c.repo, acc, 1);
    expect((await c.api.planDelete([id!])).total).toBe(0);
    expect(await c.api.deleteOnPlatform([id!])).toEqual({ queued: 0, blocked: 0 });
    await c.api.queueRun();
    expect(calls).toEqual([]);
  });

  it('a chat already gone on the platform counts as deleted', async () => {
    const { connector, failWith } = writableConnector();
    failWith('delete', new NotFound('gone'));
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const [id] = addChats(c.repo, acc, 1);
    await trash(c, [id!]);
    await c.api.deleteOnPlatform([id!]);
    expect(await c.api.queueRun()).toEqual({ done: 1, failed: 0 });
    expect(c.repo.getChat(id!)).toBeNull();
  });

  it('never deletes anything for the wrong account', async () => {
    const { connector, calls } = writableConnector({
      verifyAccount: async () => {
        throw new SessionExpired('This profile is signed in as a different ChatGPT account.');
      },
    });
    const c = setup(connector);
    const acc = await profile(c, 'Acme Store', 'user-A');
    await c.api.allowChanges(acc, true);
    const [id] = addChats(c.repo, acc, 1);
    await trash(c, [id!]);
    await c.api.deleteOnPlatform([id!]);
    const res = await c.api.queueRun();
    expect(calls).toEqual([]);
    expect(res.done).toBe(0);
    expect(c.repo.getChat(id!)).not.toBeNull();
    expect((await c.api.queueSummary()).needsSignIn).toBe(true);
  });

  it('removes downloaded images of the deleted chat, after copying them into the safety copy', async () => {
    const { connector } = writableConnector();
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const files = new Map<string, Uint8Array>();
    const removed: string[] = [];
    const api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      exportDir: join(dir, 'exports'),
      connectors: { chatgpt: connector },
      readMedia: async (p) => files.get(p) ?? null,
      removeFiles: async (p) => void removed.push(...p),
      actions: { autoRun: false, sleep: noSleep, paceMs: 0, jitterMs: 0 },
    });
    const c: Ctx = { repo, web, api };
    const acc = await profile(c, 'Acme Store', 'user-A');
    await api.allowChanges(acc, true);
    const id = repo.upsertConversation({
      accountId: acc,
      remoteId: 'img-chat',
      remoteTitle: 'Bull',
      createdAt: '2026-09-01T00:00:00.000Z',
      remoteUpdatedAt: '2026-09-02T00:00:00.000Z',
      images: [{ ref: 'r1', kind: 'generated', alt: 'a red bull' }],
      messages: [
        {
          role: 'assistant',
          createdAt: '2026-09-01T00:00:00.000Z',
          blocks: [{ type: 'image', ref: 'r1', alt: 'a red bull' }],
        },
      ],
    });
    const media = repo.pendingImages(acc, 5)[0]!;
    files.set('1/ab/x.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    repo.markImageDone(media.id, { path: '1/ab/x.png', sha256: 'x', mime: 'image/png', bytes: 7 });
    await api.bulk([id], { type: 'trash' });
    await api.deleteOnPlatform([id]);
    expect(await api.queueRun()).toEqual({ done: 1, failed: 0 });
    expect(removed).toEqual(['1/ab/x.png']); // the app's copy is removed…
    const folder = join(dir, 'exports', 'chatgpt', 'acme-store');
    const copy = join(folder, readdirSync(folder)[0]!, 'images');
    expect(readdirSync(copy)).toHaveLength(1); // …but the safety copy keeps the picture
    expect(readFileSync(join(folder, readdirSync(folder)[0]!, 'conversation.md'), 'utf8')).toMatch(
      /!\[a red bull\]\(images\/\d+\.png\)/,
    );
  });
});

describe('the queue survives trouble', () => {
  const build = (connector: Connector, start = new Date('2026-09-20T12:00:00Z')) => {
    const clock = { now: start };
    const repo = new Repo(openDatabase(), () => clock.now);
    const queue = new ActionQueue(repo, () => clock.now);
    const sleeps: number[] = [];
    const runner = new ActionRunner({
      repo,
      queue,
      connectorFor: () => connector,
      contextFor: (id) => ({ accountId: id }),
      exports: { dir: join(dir, 'exports') },
      sleep: async (ms) => void sleeps.push(ms),
      paceMs: 1500,
      jitterMs: 1500,
      now: () => clock.now,
    });
    const acc = repo.addAccount({
      platform: 'chatgpt',
      label: 'Acme Store',
      partition: 'persist:chatgpt-x',
    });
    repo.setAllowChanges(acc, true);
    const ids = addChats(repo, acc, 3);
    const queueRename = (i: number) =>
      queue.enqueue({
        accountId: acc,
        conversationId: ids[i]!,
        remoteId: `remote-Chat-${i + 1}`,
        type: 'rename',
        payload: { title: `New ${i + 1}` },
      });
    return { clock, repo, queue, runner, acc, ids, sleeps, queueRename };
  };

  it('waits after a rate limit with growing delays, keeps going with the rest, and retries later', async () => {
    const { connector, calls, failWith } = writableConnector();
    failWith('rename', new RateLimited('slow down'));
    const t = build(connector);
    t.queueRename(0);
    t.queueRename(1);
    t.queueRename(2);
    const first = await t.runner.drain();
    expect(first).toMatchObject({ done: 2, failed: 0 }); // the limited one waits; the others go through
    expect(calls.filter((x) => x.startsWith('rename')).sort()).toEqual([
      'rename remote-Chat-2 -> New 2',
      'rename remote-Chat-3 -> New 3',
    ]);
    const waiting = t.queue.list().find((a) => a.status === 'pending')!;
    expect(waiting).toMatchObject({ attempts: 1, lastError: 'slow down' });
    expect(Date.parse(waiting.runAfter!) - t.clock.now.getTime()).toBe(30_000);

    // Not yet due: nothing happens. Later it goes through.
    expect((await t.runner.drain()).done).toBe(0);
    t.clock.now = new Date(t.clock.now.getTime() + 31_000);
    expect((await t.runner.drain()).done).toBe(1);
    expect(calls).toContain('rename remote-Chat-1 -> New 1');
  });

  it('gives up after four attempts and reports why, without blocking others', async () => {
    const { connector, failWith } = writableConnector();
    failWith('rename', ...Array.from({ length: 10 }, () => new Error('server said no')));
    const t = build(connector);
    t.queueRename(0);
    for (let i = 0; i < 6; i++) {
      await t.runner.drain();
      t.clock.now = new Date(t.clock.now.getTime() + 3_600_000);
    }
    expect(t.queue.list()[0]).toMatchObject({
      status: 'failed',
      attempts: 4,
      lastError: 'server said no',
    });
    expect(t.queue.summary(null)).toMatchObject({ failed: 1, pending: 0 });
    expect(t.queue.retryFailed()).toBe(1);
    expect(t.queue.summary(null)).toMatchObject({ failed: 0, pending: 1 });
  });

  it('a signed-out session stops the run without using up attempts', async () => {
    const { connector, calls, failWith } = writableConnector();
    failWith('rename', new SessionExpired('ChatGPT answered 401. Sign in again.'));
    const t = build(connector);
    t.queueRename(0);
    t.queueRename(1);
    const res = await t.runner.drain();
    expect(res.stoppedFor).toBe('needs_sign_in');
    expect(calls.filter((x) => x.startsWith('rename'))).toEqual([]); // nothing sent, the second was not even tried
    expect(t.queue.list().every((a) => a.status === 'pending' && a.attempts === 0)).toBe(true);
    expect(t.queue.summary(null).needsSignIn).toBe(true);
    // After signing in again (and the delay), it carries on and clears the flag.
    t.clock.now = new Date(t.clock.now.getTime() + 31_000);
    expect((await t.runner.drain()).done).toBe(2);
    expect(t.queue.summary(null).needsSignIn).toBe(false);
  });

  it('a site that changed stops that profile’s changes until the user retries', async () => {
    const { connector, calls, failWith } = writableConnector();
    failWith('rename', new EndpointChanged('PATCH /backend-api/conversation/:id answered 422'));
    const t = build(connector);
    t.queueRename(0);
    t.queueRename(1);
    const res = await t.runner.drain();
    expect(res.failed).toBe(1);
    expect(calls.filter((x) => x.startsWith('rename'))).toEqual([]); // the second was NOT tried: no hammering
    expect(t.queue.blockedReason(t.acc)).toMatch(/422/);
    expect((await t.runner.drain()).done).toBe(0);
    t.queue.retryFailed();
    expect((await t.runner.drain()).done).toBe(2);
  });

  it('is unhurried: pauses with jitter between changes, and can be paused', async () => {
    const { connector } = writableConnector();
    const t = build(connector);
    t.queueRename(0);
    t.queueRename(1);
    t.queueRename(2);
    t.queue.setPaused(true);
    expect((await t.runner.drain()).stoppedFor).toBe('paused');
    expect(t.queue.summary(null)).toMatchObject({ paused: true, pending: 3 });
    t.queue.setPaused(false);
    await t.runner.drain();
    expect(t.sleeps).toHaveLength(3);
    expect(t.sleeps.every((ms) => ms >= 1500 && ms < 3000)).toBe(true);
    expect(new Set(t.sleeps).size).toBeGreaterThan(1);
  });

  it('a change interrupted by quitting the app is picked up again, and repeating it is harmless', async () => {
    const { connector, calls } = writableConnector();
    const t = build(connector);
    const id = t.queueRename(0);
    t.queue.markRunning(id); // the app was closed mid-change
    expect(t.queue.resetRunning()).toBe(1);
    expect((await t.runner.drain()).done).toBe(1);
    expect(calls.filter((x) => x.startsWith('rename'))).toEqual(['rename remote-Chat-1 -> New 1']);
  });

  it('only one run at a time', async () => {
    const { connector } = writableConnector();
    const t = build(connector);
    t.queueRename(0);
    const [a, b] = await Promise.all([t.runner.drain(), t.runner.drain()]);
    expect(a.done + b.done).toBe(1);
  });

  it('an action for a platform the app cannot change is failed with a clear reason, not silently dropped', async () => {
    const { connector } = writableConnector({
      capabilities: { projects: true, archive: false, rename: false, delete: false, images: false },
    });
    const t = build(connector);
    t.queueRename(0);
    await t.runner.drain();
    expect(t.queue.list()[0]).toMatchObject({ status: 'failed' });
    expect(t.queue.list()[0]!.lastError).toMatch(/cannot rename chats on chatgpt yet/);
  });
});

describe('the safety copy', () => {
  const chatWith = (title: string) => {
    const repo = new Repo(openDatabase());
    const acc = repo.addAccount({
      platform: 'chatgpt',
      label: 'Client: A/B',
      partition: 'persist:chatgpt-x',
    });
    const id = addChats(repo, acc, 1)[0]!;
    repo.setTitle(id, title);
    return { repo, id };
  };

  it('keeps folder names safe whatever the title or profile is called', async () => {
    for (const title of [
      '../../etc/passwd',
      'Ünïcödé ✨ chat / with \\ slashes',
      'x'.repeat(500),
      '   ',
      'CON',
      '..',
    ]) {
      const { repo, id } = chatWith(title);
      const res = await exportConversation(repo, id, { any: 'thing' }, { dir: join(dir, 'out') });
      expect(res.folder.startsWith(join(dir, 'out'))).toBe(true); // never outside the export folder
      expect(res.folder.split(join(dir, 'out'))[1]).not.toMatch(/\.\./);
      expect(existsSync(res.jsonPath)).toBe(true);
    }
  });

  it('two chats with the same title on the same day never share a folder', async () => {
    const repo = new Repo(openDatabase());
    const acc = repo.addAccount({
      platform: 'chatgpt',
      label: 'X',
      partition: 'persist:chatgpt-x',
    });
    const [a, b] = addChats(repo, acc, 2);
    repo.setTitle(a!, 'Same title');
    repo.setTitle(b!, 'Same title');
    const one = await exportConversation(repo, a!, {}, { dir: join(dir, 'same') });
    const two = await exportConversation(repo, b!, {}, { dir: join(dir, 'same') });
    expect(one.folder).not.toBe(two.folder);
    expect(readFileSync(one.jsonPath, 'utf8')).toContain('remote-Chat-1');
    expect(readFileSync(two.jsonPath, 'utf8')).toContain('remote-Chat-2');
  });

  it('says whether the platform’s own record is included, and refuses a chat that does not exist', async () => {
    const { repo, id } = chatWith('Plain');
    expect(
      (await exportConversation(repo, id, undefined, { dir: join(dir, 'a') })).rawIncluded,
    ).toBe(false);
    expect(
      (await exportConversation(repo, id, { full: true }, { dir: join(dir, 'b') })).rawIncluded,
    ).toBe(true);
    await expect(exportConversation(repo, 999_999, {}, { dir: join(dir, 'c') })).rejects.toThrow(
      /no longer exists/,
    );
  });
});
