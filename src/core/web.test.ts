import { describe, expect, it } from 'vitest';
import { createApi, type WebTarget } from './api';
import { fakeWeb } from './testing';
import { openDatabase } from './db';
import { seedFixtures } from './fixtures';
import { Repo } from './repo';

const setup = () => {
  const repo = new Repo(openDatabase());
  const web = fakeWeb();
  const api = createApi(repo, { openExternal: async () => {}, web: web.host });
  return { repo, api, ...web };
};

type Ctx = ReturnType<typeof setup>;

/** Runs a whole sign-in as `identity` and creates the named profile. */
async function addProfile(
  c: Ctx,
  label: string,
  identity: string | null,
  name: string | null = null,
) {
  c.signedInAs(identity, name);
  const { attemptId } = await c.api.signInStart('chatgpt');
  const status = await c.api.signInStatus(attemptId, identity === null);
  expect(status.state).toBe('signed-in');
  return { attemptId, ...(await c.api.signInFinish(attemptId, { type: 'new', label })) };
}

describe('adding a web account: sign in first, then decide', () => {
  it('waits for the sign-in and does not create anything before it', async () => {
    const c = setup();
    const { attemptId } = await c.api.signInStart('chatgpt');
    expect(await c.api.signInStatus(attemptId)).toEqual({ state: 'waiting' });
    expect(c.repo.filterOptions().accounts).toEqual([]); // no profile yet, and no name asked
    await expect(c.api.signInFinish(attemptId, { type: 'new', label: 'X' })).rejects.toThrow(
      /Sign in first/,
    );
  });

  it('a new account becomes a named profile that keeps the session it signed in with', async () => {
    const c = setup();
    seedFixtures(c.repo);
    c.repo.setSetting('demo_data', '1');
    c.signedInAs('user-AAA', 'Mario Rossi');
    const { attemptId } = await c.api.signInStart('chatgpt');

    const status = await c.api.signInStatus(attemptId);
    expect(status).toEqual({
      state: 'signed-in',
      displayName: 'Mario Rossi',
      identityKnown: true,
      match: null,
      candidates: [],
    });

    const res = await c.api.signInFinish(attemptId, {
      type: 'new',
      label: '  Client: Rossi & Figli ',
    });
    expect(res.created).toBe(true);
    const acc = c.repo.getAccount(res.accountId)!;
    expect(acc.partition).toBe(c.partitionOf(attemptId)); // the session it just signed in with, no re-login
    expect(c.repo.profilesOf('chatgpt')).toEqual([
      { id: res.accountId, label: 'Client: Rossi & Figli', identity: 'user-AAA' },
    ]);
    expect(c.repo.sidebar().demo).toBe(false); // the first real source replaces the demo
    expect(c.calls.filter((x) => x.fn === 'endSignIn')).toEqual([
      { fn: 'endSignIn', attemptId, keep: true },
    ]);
    await expect(c.api.signInStatus(attemptId)).rejects.toThrow(/no longer active/); // the attempt is over
  });

  it('signing in again as the same account reuses the profile: no name, no duplicate', async () => {
    const c = setup();
    const first = await addProfile(c, 'Acme Store', 'user-AAA');
    const oldPartition = c.repo.getAccount(first.accountId)!.partition;

    c.signedInAs('user-AAA', 'Mario');
    const { attemptId } = await c.api.signInStart('chatgpt');
    const status = await c.api.signInStatus(attemptId);
    expect(status).toMatchObject({
      state: 'signed-in',
      match: { id: first.accountId, label: 'Acme Store' },
    });

    const res = await c.api.signInFinish(attemptId, {
      type: 'existing',
      accountId: first.accountId,
    });
    expect(res).toEqual({ accountId: first.accountId, created: false });
    expect(c.repo.profilesOf('chatgpt')).toHaveLength(1);
    // The profile now uses the fresh session; the old one is wiped and its window closed.
    expect(c.repo.getAccount(first.accountId)!.partition).toBe(c.partitionOf(attemptId));
    expect(c.wiped).toContain(oldPartition);
    expect(c.calls).toContainEqual({ fn: 'closeLogin', accountId: first.accountId });
  });

  it('refuses to add the same account twice even if asked to', async () => {
    const c = setup();
    await addProfile(c, 'Acme Store', 'user-AAA');
    c.signedInAs('user-AAA');
    const { attemptId } = await c.api.signInStart('chatgpt');
    await c.api.signInStatus(attemptId);
    await expect(
      c.api.signInFinish(attemptId, { type: 'new', label: 'Acme Store 2' }),
    ).rejects.toThrow(/already connected as “Acme Store”/);
    expect(c.repo.profilesOf('chatgpt')).toHaveLength(1);
  });

  it('never offers the synthetic demo profiles as a match', async () => {
    const c = setup();
    seedFixtures(c.repo);
    c.repo.setSetting('demo_data', '1');
    c.signedInAs(null);
    c.onlyAfterUserSaysSo();
    const { attemptId } = await c.api.signInStart('chatgpt');
    const s = await c.api.signInStatus(attemptId, true);
    expect(s).toMatchObject({ state: 'signed-in', match: null, candidates: [] });
    await expect(c.api.signInFinish(attemptId, { type: 'existing', accountId: 1 })).rejects.toThrow(
      /does not exist/,
    );
    expect(c.repo.sidebar().demo).toBe(true); // nothing was touched
  });

  it('a different account gets its own profile and its own session', async () => {
    const c = setup();
    const a = await addProfile(c, 'Acme Store', 'user-AAA');
    const b = await addProfile(c, 'Bluewave Studio', 'user-BBB');
    expect(c.repo.getAccount(a.accountId)!.partition).not.toBe(
      c.repo.getAccount(b.accountId)!.partition,
    );
    c.signedInAs('user-BBB');
    const { attemptId } = await c.api.signInStart('chatgpt');
    expect(await c.api.signInStatus(attemptId)).toMatchObject({
      match: { label: 'Bluewave Studio' },
      candidates: [],
    });
  });

  it('a profile made before identities were recorded is offered, and gets its identity', async () => {
    const c = setup();
    const legacy = c.repo.addAccount({
      platform: 'chatgpt',
      label: 'Old profile',
      partition: 'persist:chatgpt-old',
    });
    c.signedInAs('user-AAA');
    const { attemptId } = await c.api.signInStart('chatgpt');
    const s = await c.api.signInStatus(attemptId);
    expect(s).toMatchObject({
      match: null,
      identityKnown: true,
      candidates: [{ id: legacy, label: 'Old profile' }],
    });

    const res = await c.api.signInFinish(attemptId, { type: 'existing', accountId: legacy });
    expect(res.created).toBe(false);
    expect(c.repo.profilesOf('chatgpt')[0]).toMatchObject({ id: legacy, identity: 'user-AAA' });
    expect(c.wiped).toContain('persist:chatgpt-old');
  });

  it('when the platform does not say who it is, the user picks (and only their own "I signed in" counts)', async () => {
    const c = setup();
    const a = await addProfile(c, 'Acme Store', 'user-AAA');
    c.onlyAfterUserSaysSo();
    c.signedInAs(null);
    const { attemptId } = await c.api.signInStart('chatgpt');
    expect(await c.api.signInStatus(attemptId, false)).toEqual({ state: 'waiting' }); // never guesses on its own
    const s = await c.api.signInStatus(attemptId, true);
    expect(s).toMatchObject({
      state: 'signed-in',
      identityKnown: false,
      match: null,
      candidates: [{ id: a.accountId, label: 'Acme Store' }],
    });
    // Picking the existing profile keeps its known identity untouched.
    await c.api.signInFinish(attemptId, { type: 'existing', accountId: a.accountId });
    expect(c.repo.profilesOf('chatgpt')[0]!.identity).toBe('user-AAA');
  });

  it('will not put an account into a profile that belongs to a different one', async () => {
    const c = setup();
    const a = await addProfile(c, 'Acme Store', 'user-AAA');
    c.signedInAs('user-BBB');
    const { attemptId } = await c.api.signInStart('chatgpt');
    await c.api.signInStatus(attemptId);
    await expect(
      c.api.signInFinish(attemptId, { type: 'existing', accountId: a.accountId }),
    ).rejects.toThrow(/different account/);
    expect(c.repo.profilesOf('chatgpt')[0]!.identity).toBe('user-AAA'); // untouched
    await expect(
      c.api.signInFinish(attemptId, { type: 'existing', accountId: 999_999 }),
    ).rejects.toThrow(/does not exist/);
  });

  it('a name clash keeps the attempt alive so the user can pick another name', async () => {
    const c = setup();
    await addProfile(c, 'Acme Store', 'user-AAA');
    c.signedInAs('user-CCC');
    const { attemptId } = await c.api.signInStart('chatgpt');
    await c.api.signInStatus(attemptId);
    await expect(
      c.api.signInFinish(attemptId, { type: 'new', label: 'acme store' }),
    ).rejects.toThrow(/already have a profile/);
    await expect(c.api.signInFinish(attemptId, { type: 'new', label: '   ' })).rejects.toThrow();
    const ok = await c.api.signInFinish(attemptId, { type: 'new', label: 'Third client' });
    expect(ok.created).toBe(true);
  });

  it('closing the window or cancelling wipes the session it created', async () => {
    const c = setup();
    const a = await c.api.signInStart('chatgpt');
    c.windowClosed();
    expect(await c.api.signInStatus(a.attemptId)).toEqual({ state: 'closed' });
    expect(c.wiped).toContain(c.partitionOf(a.attemptId));

    const b = await c.api.signInStart('chatgpt');
    await c.api.signInCancel(b.attemptId);
    expect(c.wiped).toContain(c.partitionOf(b.attemptId));
    await expect(c.api.signInCancel(b.attemptId)).rejects.toThrow(/no longer active/);
    expect(c.repo.filterOptions().accounts).toEqual([]);
  });

  it('only web platforms with a sign-in window, and the session name is never the caller’s', async () => {
    const c = setup();
    await expect(c.api.signInStart('gemini')).rejects.toThrow(); // Gemini has no sign-in window
    await expect(c.api.signInStart('claude-code')).rejects.toThrow();
    await expect(c.api.signInStatus('made-up-id')).rejects.toThrow(/no longer active/);
    await expect(c.api.signInStatus('')).rejects.toThrow();
    const a = await addProfile(c, 'Acme Store', 'user-AAA');
    expect(c.repo.getAccount(a.accountId)!.partition).toMatch(/^persist:chatgpt-fake\d+$/);
  });

  it('says so when there is no Electron host', async () => {
    const api = createApi(new Repo(openDatabase()), { openExternal: async () => {} });
    await expect(api.signInStart('chatgpt')).rejects.toThrow(/not available/);
  });
});

describe('profile windows and the structure recorder', () => {
  it('reopening a profile’s window takes the session from the database, never from the caller', async () => {
    const c = setup();
    const { accountId } = await addProfile(c, 'Acme Store', 'user-AAA');
    c.calls.length = 0;
    await c.api.openLogin(accountId);
    await c.api.recorderStart(accountId);
    for (const call of c.calls)
      expect((call.target as WebTarget).partition).toBe(c.repo.getAccount(accountId)!.partition);
    await expect(c.api.openLogin(999_999)).rejects.toThrow(/does not use a sign-in window/);
    await expect(c.api.openLogin(-1)).rejects.toThrow();
    const local = c.repo.addAccount({
      platform: 'claude-code',
      label: 'This Mac',
      partition: 'local:claude-code',
    });
    await expect(c.api.openLogin(local)).rejects.toThrow(/does not use a sign-in window/);
    await expect(c.api.recorderStart(local)).rejects.toThrow(/does not use a sign-in window/);
  });

  it('start → status → stop → reveal', async () => {
    const c = setup();
    const { accountId } = await addProfile(c, 'Acme Store', 'user-AAA');
    expect((await c.api.recorderStatus()).state).toBe('idle');
    await c.api.recorderStart(accountId);
    expect(await c.api.recorderStatus()).toMatchObject({
      state: 'recording',
      accountId,
      requests: 7,
      endpoints: 3,
    });
    expect(await c.api.recorderStop()).toEqual({
      path: '/tmp/structure-chatgpt-test.json',
      requests: 7,
      endpoints: 3,
    });
    await c.api.revealReport();
    expect(c.calls.map((x) => x.fn).slice(-3)).toEqual([
      'recorderStart',
      'recorderStop',
      'revealReport',
    ]);
  });
});
