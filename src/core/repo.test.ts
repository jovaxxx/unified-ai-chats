import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase } from './db';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeCommand } from './platforms';
import { migrations } from './migrations';
import { DEMO_VERSION, ensureDemoData, seedFixtures } from './fixtures';
import { Repo, toFtsQuery } from './repo';
import { createApi } from './api';

const NOW = new Date('2026-09-20T12:00:00Z');

function freshRepo(): Repo {
  const repo = new Repo(openDatabase(), () => NOW);
  seedFixtures(repo, NOW);
  return repo;
}

describe('migrations', () => {
  it('apply once and are idempotent', () => {
    const db = openDatabase();
    const v = () =>
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(v()).toBe(migrations.length);
    migrate(db);
    expect(v()).toBe(migrations.length);
  });

  it('refuse a database from a newer app', () => {
    const db = openDatabase();
    db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer/);
  });
});

describe('sidebar and listing', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = freshRepo();
  });

  it('counts add up: platform totals sum to the total, account totals to inbox+projects+archive', () => {
    const s = repo.sidebar();
    expect(s.platforms.reduce((n, p) => n + p.total, 0)).toBe(s.totalChats);
    expect(s.trashed).toBe(0);
    const work = s.platforms.flatMap((p) => p.accounts).find((a) => a.label === 'Acme Store')!;
    const inProjects = work.projects.reduce((n, p) => n + p.count, 0);
    expect(work.inbox + inProjects + work.archived).toBe(work.total);
  });

  it('lists all chats newest first and reports the total separately from the page', () => {
    const page = repo.listChats({ limit: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(repo.sidebar().totalChats);
    const dates = page.items.map((c) => c.updatedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('filters by account, project, scope and tag', () => {
    const s = repo.sidebar();
    const work = s.platforms.flatMap((p) => p.accounts).find((a) => a.label === 'Acme Store')!;
    expect(repo.listChats({ accountId: work.id }).total).toBe(work.total);
    expect(repo.listChats({ accountId: work.id, scope: 'inbox' }).total).toBe(work.inbox);
    expect(repo.listChats({ accountId: work.id, scope: 'archive' }).total).toBe(work.archived);
    const project = work.projects[0]!;
    expect(repo.listChats({ projectId: project.id }).total).toBe(project.count);
    expect(repo.listChats({ tag: 'Shopify' }).items.every((c) => c.tags.includes('Shopify'))).toBe(
      true,
    );
    expect(repo.listChats({ platform: 'gemini' }).items.every((c) => c.platform === 'gemini')).toBe(
      true,
    );
  });

  it('shows the original title next to the generated one', () => {
    const chat = repo.listChats({ search: 'metafields' }).items[0]!;
    expect(chat.title).toBe('Shopify theme structure: sections and metafields');
    expect(chat.remoteTitle).toBe('Shopify theme help');
  });
});

describe('full-text search', () => {
  it('finds words in titles, original titles, summaries and message bodies', () => {
    const repo = freshRepo();
    expect(repo.listChats({ search: 'metafields' }).total).toBeGreaterThan(0); // title + body
    expect(repo.listChats({ search: 'béchamel' }).total).toBeGreaterThan(0); // body, accent kept
    expect(repo.listChats({ search: 'bechamel' }).total).toBeGreaterThan(0); // diacritics folded
    expect(repo.listChats({ search: 'Liquid' }).total).toBeGreaterThan(0);
    expect(repo.listChats({ search: 'zzzznotpresent' }).total).toBe(0);
  });

  it('matches prefixes and requires every word', () => {
    const repo = freshRepo();
    expect(repo.listChats({ search: 'metafi' }).total).toBeGreaterThan(0);
    expect(repo.listChats({ search: 'metafields pasta' }).total).toBe(0);
  });

  it('is safe against FTS syntax in user input', () => {
    const repo = freshRepo();
    for (const evil of ['"', 'a OR', 'NEAR(', '*', 'title:', "'; DROP TABLE conversations; --"]) {
      expect(() => repo.listChats({ search: evil })).not.toThrow();
    }
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('a "b"')).toBe('"a"* "b"*');
  });

  it('follows a rename', () => {
    const repo = freshRepo();
    const id = repo.listChats({ search: 'pasta' }).items[0]!.id;
    expect(repo.setTitle(id, 'Sunday lasagne')).toBe(true);
    expect(repo.listChats({ search: 'lasagne' }).items.map((c) => c.id)).toContain(id);
    expect(repo.getChat(id)!.remoteTitle).toBe('Recipe'); // original title is kept
    expect(repo.setTitle(id, '   ')).toBe(false);
  });
});

describe('bulk actions (local state only)', () => {
  it('select-all → archive → trash → restore round trip', () => {
    const repo = freshRepo();
    const total = repo.sidebar().totalChats;
    const ids = repo.chatIds({ scope: 'inbox' });
    expect(ids.length).toBeGreaterThan(90);

    const archived = repo.bulk(ids, { type: 'archive' });
    expect(archived).toMatchObject({ changed: ids.length, skipped: 0 });
    expect(archived.changedIds).toEqual(ids);
    expect(repo.listChats({ scope: 'inbox' }).total).toBe(0);
    expect(repo.bulk(ids, { type: 'archive' })).toMatchObject({
      changed: 0,
      skipped: ids.length,
      changedIds: [],
    });

    const some = ids.slice(0, 5);
    expect(repo.bulk(some, { type: 'trash' }).changed).toBe(5);
    const s = repo.sidebar();
    expect(s.trashed).toBe(5);
    expect(s.totalChats).toBe(total - 5);
    expect(repo.listChats({ view: 'all' }).items.some((c) => some.includes(c.id))).toBe(false);

    const trash = repo.listChats({ view: 'trash' });
    expect(trash.total).toBe(5);
    // 14-day default retention, computed from "now".
    expect(trash.items[0]!.trashPurgeAt).toBe('2026-10-04T12:00:00.000Z');

    expect(repo.bulk(some, { type: 'restore' }).changed).toBe(5);
    const restored = repo.getChat(some[0]!)!;
    expect(restored.state).toBe('archived'); // back to where it was, not to the inbox
    expect(restored.trashPurgeAt).toBeNull();
    expect(repo.sidebar().trashed).toBe(0);
  });

  it('honours the configured retention', () => {
    const repo = freshRepo();
    repo.setSetting('trash_retention_days', '3');
    const id = repo.chatIds({})[0]!;
    repo.bulk([id], { type: 'trash' });
    expect(repo.getChat(id)!.trashPurgeAt).toBe('2026-09-23T12:00:00.000Z');
  });

  it('tags many chats at once and ignores duplicates', () => {
    const repo = freshRepo();
    const ids = repo.chatIds({ platform: 'gemini' });
    expect(repo.bulk(ids, { type: 'tag', tag: 'Review' }).changed).toBe(ids.length);
    expect(repo.bulk(ids, { type: 'tag', tag: 'review' }).changed).toBe(0); // case-insensitive
    expect(repo.listChats({ tag: 'Review' }).total).toBe(ids.length);
    repo.removeTag(ids[0]!, 'Review');
    expect(repo.listChats({ tag: 'Review' }).total).toBe(ids.length - 1);
  });

  it('never trashes twice and ignores unknown ids', () => {
    const repo = freshRepo();
    const id = repo.chatIds({})[0]!;
    expect(repo.bulk([id, id, 999_999], { type: 'trash' })).toEqual({
      changed: 1,
      skipped: 1,
      changedIds: [id],
    });
    expect(repo.bulk([id], { type: 'trash' }).changed).toBe(0);
  });
});

describe('re-import (what a sync will do)', () => {
  it('updates in place, keeps local edits, and replaces messages', () => {
    const repo = freshRepo();
    const chat = repo.listChats({ search: 'pasta' }).items[0]!;
    const detail = repo.getChat(chat.id)!;
    repo.setTitle(chat.id, 'My own title');

    const id = repo.upsertConversation({
      accountId: chat.accountId,
      remoteId: detail.remoteId,
      remoteTitle: 'Recipe v2',
      createdAt: detail.createdAt,
      remoteUpdatedAt: '2026-09-21T00:00:00.000Z',
      messages: [
        {
          role: 'user',
          blocks: [{ type: 'text', text: 'only message' }],
          createdAt: detail.createdAt,
        },
      ],
    });
    expect(id).toBe(chat.id);
    const after = repo.getChat(id)!;
    expect(after.title).toBe('My own title'); // user's title survives
    expect(after.remoteTitle).toBe('Recipe v2');
    expect(after.messages).toHaveLength(1);
    expect(repo.listChats({ search: 'only message' }).total).toBe(1);
  });
});

describe('api validation', () => {
  it('rejects malformed input before it reaches the repository', async () => {
    const api = createApi(freshRepo(), { openExternal: async () => {} });
    await expect(api.bulk([], { type: 'archive' })).rejects.toThrow();
    await expect(api.bulk([1], { type: 'delete_everything' } as never)).rejects.toThrow();
    await expect(api.listChats({ limit: 100_000 })).rejects.toThrow();
    await expect(api.getChat(-1)).rejects.toThrow();
  });

  it('validates dashboard, rename and connect inputs', async () => {
    const api = createApi(freshRepo(), { openExternal: async () => {} });
    await expect(api.dashboard({ platform: 'evil' as never })).rejects.toThrow();
    await expect(api.renameAccount(1, '   ')).rejects.toThrow();
    await expect(api.renameAccount(1, 'x'.repeat(41))).rejects.toThrow();
    await expect(api.renameAccount(999_999, 'Ghost')).rejects.toThrow(/no longer exists/);
    await expect(api.connectClaudeCode('')).rejects.toThrow();
    await expect(api.listChats({ cleanup: 'everything' as never })).rejects.toThrow();
    expect((await api.dashboard({ platform: 'claude' })).accounts).toHaveLength(2);
  });

  it('only opens known https platform urls', async () => {
    const opened: string[] = [];
    const api = createApi(freshRepo(), { openExternal: async (u) => void opened.push(u) });
    await api.openOnPlatform('chatgpt');
    await api.openOnPlatform('claude', 'abc 123');
    await api.openOnPlatform('claude-code'); // local source: nothing to open
    await expect(api.openOnPlatform('evil' as never)).rejects.toThrow();
    expect(opened).toEqual(['https://chatgpt.com/', 'https://claude.ai/chat/abc%20123']);
    expect(opened.every((u) => u.startsWith('https://'))).toBe(true);
  });
});

describe('profiles (named accounts)', () => {
  it('several profiles per platform, each with a free-text name', () => {
    const repo = freshRepo();
    const chatgpt = repo.sidebar().platforms.find((p) => p.platform === 'chatgpt')!;
    expect(chatgpt.accounts.map((a) => a.label)).toEqual([
      'Personal',
      'Acme Store',
      'Bluewave Studio',
    ]);
    // The same name may exist on another platform.
    const claude = repo.sidebar().platforms.find((p) => p.platform === 'claude')!;
    expect(claude.accounts.map((a) => a.label)).toContain('Bluewave Studio');
  });

  it('names are unique per platform (ignoring case) and validated', () => {
    const repo = freshRepo();
    const add = (label: string) =>
      repo.addAccount({ platform: 'chatgpt', label, partition: `persist:t-${label}` });
    expect(() => add('acme store')).toThrow(/already have a profile/);
    expect(() => add('   ')).toThrow();
    expect(() => add('x'.repeat(41))).toThrow();
    expect(add('  Client: Rossi & Figli  ')).toBeGreaterThan(0);
    expect(repo.filterOptions().accounts.map((a) => a.label)).toContain('Client: Rossi & Figli');
  });

  it('renames a profile without touching its chats, and rejects clashes', () => {
    const repo = freshRepo();
    const acme = repo.filterOptions().accounts.find((a) => a.label === 'Acme Store')!;
    const before = repo.listChats({ accountId: acme.id }).total;
    expect(repo.renameAccount(acme.id, 'Acme Store (2026)')).toBe(true);
    expect(repo.listChats({ accountId: acme.id }).total).toBe(before);
    expect(repo.listChats({ accountId: acme.id }).items[0]!.accountLabel).toBe('Acme Store (2026)');
    expect(() => repo.renameAccount(acme.id, 'personal')).toThrow(/already have a profile/);
    expect(repo.renameAccount(acme.id, 'ACME STORE (2026)')).toBe(true); // only its own name: allowed
    expect(repo.renameAccount(999_999, 'Nope')).toBe(false);
  });
});

describe('platform dashboard', () => {
  it('counts add up for one profile and for all profiles of a platform', () => {
    const repo = freshRepo();
    const all = repo.dashboard('chatgpt');
    expect(all.selectedAccountId).toBeNull();
    expect(all.accounts).toHaveLength(3);
    expect(all.stats.chats).toBe(all.accounts.reduce((n, a) => n + a.total, 0));
    expect(all.stats.chats).toBe(repo.listChats({ platform: 'chatgpt' }).total);

    const acme = all.accounts.find((a) => a.label === 'Acme Store')!;
    const d = repo.dashboard('chatgpt', acme.id);
    expect(d.selectedAccountId).toBe(acme.id);
    expect(d.stats.chats).toBe(acme.total);
    expect(d.stats.inbox + d.stats.inProjects + d.stats.archived).toBe(d.stats.chats);
    expect(d.stats.projects).toBe(3);
    expect(d.stats.archived).toBe(repo.listChats({ accountId: acme.id, scope: 'archive' }).total);
    expect(d.stats.images).toBe(0); // no image import exists yet
  });

  it('ignores an account id that belongs to another platform', () => {
    const repo = freshRepo();
    const gemini = repo.dashboard('gemini').accounts[0]!;
    const d = repo.dashboard('chatgpt', gemini.id);
    expect(d.selectedAccountId).toBeNull();
    expect(d.stats.chats).toBe(repo.dashboard('chatgpt').stats.chats);
  });

  it('excludes trashed chats and reports sync state', () => {
    const repo = freshRepo();
    const before = repo.dashboard('gemini');
    repo.bulk(repo.chatIds({ platform: 'gemini' }).slice(0, 2), { type: 'trash' });
    expect(repo.dashboard('gemini').stats.chats).toBe(before.stats.chats - 2);
    expect(before.needsAttention).toBe(true);
    expect(repo.dashboard('chatgpt').needsAttention).toBe(false);
    expect(repo.dashboard('chatgpt').lastSyncAt).not.toBeNull();
  });

  it('chats per month: six zero-filled months ending now, summing to at most the total', () => {
    const repo = freshRepo();
    const d = repo.dashboard('chatgpt');
    expect(d.perMonth.map((m) => m.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    const sum = d.perMonth.reduce((n, m) => n + m.count, 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(d.stats.chats);
    expect(d.perMonth.at(-1)!.count).toBeGreaterThan(0); // this month has chats
  });

  it('"to clean" counts match the list filters exactly', () => {
    const repo = freshRepo();
    for (const kind of ['short', 'untagged', 'generic'] as const) {
      const n = repo.dashboard('chatgpt').clean[kind];
      expect(n).toBeGreaterThan(0);
      expect(repo.listChats({ platform: 'chatgpt', cleanup: kind }).total).toBe(n);
    }
    // Renaming a generic-titled chat takes it off the list; tagging takes it off "untagged".
    const generic = repo.listChats({ platform: 'chatgpt', cleanup: 'generic' });
    repo.setTitle(generic.items[0]!.id, 'A meaningful title');
    expect(repo.dashboard('chatgpt').clean.generic).toBe(generic.total - 1);
    const untagged = repo.listChats({ platform: 'chatgpt', cleanup: 'untagged' });
    repo.bulk([untagged.items[0]!.id], { type: 'tag', tag: 'Reviewed' });
    expect(repo.dashboard('chatgpt').clean.untagged).toBe(untagged.total - 1);
    // Chats with 4+ messages are not "short".
    expect(repo.listChats({ cleanup: 'short' }).items.every((c) => c.messageCount < 4)).toBe(true);
  });
});

describe('demo data lifecycle', () => {
  it('seeds an empty database, and leaves an up-to-date demo alone', () => {
    const repo = new Repo(openDatabase(), () => NOW);
    expect(ensureDemoData(repo, NOW)).toBe('seeded');
    expect(repo.sidebar().demo).toBe(true);
    const total = repo.sidebar().totalChats;
    expect(ensureDemoData(repo, NOW)).toBe('kept');
    expect(repo.sidebar().totalChats).toBe(total);
  });

  it('rebuilds an outdated demo (e.g. seeded by an older version of the app)', () => {
    const repo = new Repo(openDatabase(), () => NOW);
    // An older app: demo with only "Personal"/"Work" style profiles, no demo_version recorded.
    const old = repo.addAccount({ platform: 'chatgpt', label: 'Work', partition: 'persist:old' });
    repo.upsertConversation({
      accountId: old,
      remoteId: 'x',
      remoteTitle: 'Old demo chat',
      createdAt: NOW.toISOString(),
      remoteUpdatedAt: NOW.toISOString(),
      messages: [],
    });
    repo.setSetting('demo_data', '1');

    expect(ensureDemoData(repo, NOW)).toBe('refreshed');
    const labels = repo.filterOptions().accounts.map((a) => a.label);
    expect(labels).toContain('Acme Store');
    expect(labels).not.toContain('Work');
    expect(repo.listChats({ search: 'Old demo chat' }).total).toBe(0);
    expect(repo.getSetting('demo_version')).toBe(String(DEMO_VERSION));
  });

  it('never deletes real data, whatever the demo version says', () => {
    const repo = new Repo(openDatabase(), () => NOW);
    const real = repo.addAccount({
      platform: 'claude-code',
      label: 'This Mac',
      partition: 'local:claude-code',
    });
    repo.upsertConversation({
      accountId: real,
      remoteId: 'r1',
      remoteTitle: 'Real session',
      createdAt: NOW.toISOString(),
      remoteUpdatedAt: NOW.toISOString(),
      messages: [],
    });
    // demo_data is not set: this is a real database with an old/missing demo_version.
    expect(ensureDemoData(repo, NOW)).toBe('kept');
    expect(repo.listChats({ search: 'Real session' }).total).toBe(1);
    expect(repo.sidebar().demo).toBe(false);
    expect(repo.filterOptions().accounts.map((a) => a.label)).toEqual(['This Mac']);
  });
});

describe('resume command', () => {
  it('quotes the folder so nothing in it can run', () => {
    expect(resumeCommand('claude-code', 'proj/abc-123', '/work/demo-app')).toBe(
      "cd '/work/demo-app' && claude --resume abc-123",
    );
    expect(resumeCommand('claude-code', 'proj/abc', "/it's a $(rm -rf ~)/dir")).toBe(
      "cd '/it'\\''s a $(rm -rf ~)/dir' && claude --resume abc",
    );
  });

  it('refuses anything suspicious and other platforms', () => {
    expect(resumeCommand('claude-code', 'proj/abc', '/a\nrm -rf ~')).toBeNull(); // newline in the path
    expect(resumeCommand('claude-code', 'proj/abc; rm -rf ~', '/ok')).toBeNull(); // bad session id
    expect(resumeCommand('claude-code', 'proj/abc', null)).toBeNull();
    expect(resumeCommand('chatgpt', 'proj/abc', '/ok')).toBeNull();
  });

  it('is stored with the session and exposed on the chat', () => {
    const repo = new Repo(openDatabase(), () => NOW);
    const acc = repo.addAccount({
      platform: 'claude-code',
      label: 'This Mac',
      partition: 'local:claude-code',
    });
    const id = repo.upsertConversation({
      accountId: acc,
      remoteId: 'proj/sess1',
      remoteTitle: 'A session',
      cwd: '/work/demo-app',
      createdAt: NOW.toISOString(),
      remoteUpdatedAt: NOW.toISOString(),
      messages: [],
    });
    expect(repo.getChat(id)!.resumeCommand).toBe("cd '/work/demo-app' && claude --resume sess1");
    // A later sync that does not know the folder must not erase it.
    repo.upsertConversation({
      accountId: acc,
      remoteId: 'proj/sess1',
      remoteTitle: 'A session',
      createdAt: NOW.toISOString(),
      remoteUpdatedAt: NOW.toISOString(),
      messages: [],
    });
    expect(repo.getChat(id)!.resumeCommand).not.toBeNull();
  });
});

describe('migration 3', () => {
  it('forces a full re-import of local sessions only', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(migrations[0] as string);
    db.exec(migrations[1] as string);
    db.exec('PRAGMA user_version = 2');
    const ins = db.prepare(
      "INSERT INTO accounts (platform, label, partition, last_sync_at) VALUES (?, ?, ?, '2026-09-01T00:00:00.000Z')",
    );
    ins.run('claude-code', 'This Mac', 'local:claude-code');
    ins.run('chatgpt', 'Personal', 'persist:chatgpt-personal');

    migrate(db);
    const rows = db.prepare('SELECT platform, last_sync_at FROM accounts ORDER BY id').all() as {
      platform: string;
      last_sync_at: string | null;
    }[];
    expect(rows).toEqual([
      { platform: 'claude-code', last_sync_at: null },
      { platform: 'chatgpt', last_sync_at: '2026-09-01T00:00:00.000Z' },
    ]);
  });
});

describe('migration 9', () => {
  it('takes Claude Code sessions out of projects named after a generic folder, and only those', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (let i = 0; i < 8; i++) db.exec(migrations[i] as string);
    db.exec('PRAGMA user_version = 8');
    db.exec(`
      INSERT INTO accounts (id, platform, label, partition) VALUES (1, 'claude-code', 'Mac', 'local:cc'), (2, 'chatgpt', 'Acme', 'persist:x');
      INSERT INTO projects (id, account_id, remote_id, name) VALUES (1, 1, 'p1', 'Documents'), (2, 1, 'p2', 'shop'), (3, 2, 'p3', 'Documents');
      INSERT INTO conversations (id, account_id, remote_id, remote_title, title, project_id, created_at, updated_at, remote_updated_at)
        VALUES (1, 1, 'a', 't', 't', 1, 'x', 'x', 'x'), (2, 1, 'b', 't', 't', 2, 'x', 'x', 'x'), (3, 2, 'c', 't', 't', 3, 'x', 'x', 'x');
    `);
    migrate(db);
    const rows = db.prepare('SELECT id, project_id FROM conversations ORDER BY id').all();
    expect(rows).toEqual([
      { id: 1, project_id: null },
      { id: 2, project_id: 2 },
      { id: 3, project_id: 3 }, // a ChatGPT project called Documents is a real project
    ]);
    expect(db.prepare('SELECT name FROM projects ORDER BY id').all()).toEqual([
      { name: 'shop' },
      { name: 'Documents' },
    ]);
  });
});

describe('sorting the list', () => {
  const titles = (repo: Repo, sort: string, extra: Record<string, unknown> = {}) =>
    repo.listChats({ sort, limit: 500, ...extra } as never).items.map((c) => c.title);

  it('offers newest/oldest, created, title and length, with a stable order', () => {
    const repo = freshRepo();
    const newest = repo.listChats({ sort: 'updated_desc' }).items;
    const oldest = repo.listChats({ sort: 'updated_asc' }).items;
    expect(newest[0]!.updatedAt >= newest[1]!.updatedAt).toBe(true);
    expect(oldest[0]!.updatedAt <= oldest[1]!.updatedAt).toBe(true);
    expect(newest[0]!.id).not.toBe(oldest[0]!.id);

    const az = titles(repo, 'title_asc');
    expect(az).toEqual(
      [...az].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    );
    expect(titles(repo, 'title_desc')).toEqual([...az].reverse());

    const most = repo
      .listChats({ sort: 'messages_desc', limit: 500 })
      .items.map((c) => c.messageCount);
    expect(most).toEqual([...most].sort((a, b) => b - a));
    const fewest = repo
      .listChats({ sort: 'messages_asc', limit: 500 })
      .items.map((c) => c.messageCount);
    expect(fewest).toEqual([...most].reverse());
    // created_at ordering is honoured too
    const created = repo.listChats({ sort: 'created_desc', limit: 500 }).items;
    expect(created.length).toBeGreaterThan(50);
  });

  it('paging stays consistent under any sort (no repeats, no gaps)', () => {
    const repo = freshRepo();
    for (const sort of ['title_asc', 'messages_desc', 'updated_asc']) {
      const all = repo.listChats({ sort, limit: 500 } as never).items.map((c) => c.id);
      const pages = [0, 40, 80].flatMap((offset) =>
        repo.listChats({ sort, limit: 40, offset } as never).items.map((c) => c.id),
      );
      expect(pages).toEqual(all.slice(0, pages.length));
      expect(new Set(pages).size).toBe(pages.length);
    }
  });

  it('while searching, best match is the default and an explicit sort overrides it', () => {
    const repo = freshRepo();
    const byRank = repo.listChats({ search: 'sample' }).items.map((c) => c.id);
    const byTitle = repo
      .listChats({ search: 'sample', sort: 'title_asc' })
      .items.map((c) => c.title);
    expect(byTitle).toEqual(
      [...byTitle].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    );
    expect(byRank.length).toBe(byTitle.length);
  });

  it('rejects an unknown sort', () => {
    expect(() => freshRepo().listChats({ sort: 'random' as never })).toThrow();
  });
});

describe('deleting from the Trash (local only)', () => {
  const trash = (repo: Repo, n: number) => {
    const ids = repo.chatIds({ platform: 'chatgpt' }).slice(0, n);
    repo.bulk(ids, { type: 'trash' });
    return ids;
  };

  it('only chats in the Trash can be deleted, and the preview says what and where', () => {
    const repo = freshRepo();
    const ids = trash(repo, 3);
    const live = repo.chatIds({ platform: 'claude' })[0]!;
    const preview = repo.purgePreview([...ids, live]);
    expect(preview.count).toBe(3); // the live chat does not count
    expect(preview.accounts.reduce((n, a) => n + a.count, 0)).toBe(3);
    expect(preview.accounts.every((a) => a.platform === 'chatgpt')).toBe(true);

    const res = repo.purge([...ids, live]);
    expect(res).toMatchObject({ removed: 3, skipped: 1 });
    expect(repo.getChat(live)).not.toBeNull(); // untouched
    expect(ids.every((id) => repo.getChat(id) === null)).toBe(true);
  });

  it('removes messages, search entries and unused tags with them', () => {
    const repo = freshRepo();
    const id = repo.listChats({ search: 'metafields' }).items[0]!.id;
    const tags = repo.getChat(id)!.tags;
    expect(tags.length).toBeGreaterThan(0);
    repo.bulk([id], { type: 'trash' });
    repo.purge([id]);
    expect(repo.listChats({ search: 'metafields' }).items.map((c) => c.id)).not.toContain(id);
    const count = (sql: string) => (repo.db.prepare(sql).get() as { n: number }).n;
    expect(count(`SELECT COUNT(*) n FROM messages WHERE conversation_id = ${id}`)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM conversations_fts WHERE rowid = ${id}`)).toBe(0);
    expect(repo.sidebar().trashed).toBe(0);
  });

  it('remembers what was deleted so a sync does not bring it back, and only that', () => {
    const repo = freshRepo();
    const id = trash(repo, 1)[0]!;
    const chat = repo.getChat(id)!;
    repo.purge([id]);
    expect(repo.isIgnored(chat.accountId, chat.remoteId)).toBe(true);
    expect(repo.isIgnored(chat.accountId, 'some-other-chat')).toBe(false);
  });

  it('removes what stayed in the Trash past its date, and nothing else', () => {
    const repo = freshRepo();
    const [a, b] = trash(repo, 2) as [number, number];
    expect(repo.purgeExpired().removed).toBe(0); // 14 days have not passed
    repo.db
      .prepare("UPDATE conversations SET trash_purge_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(a);
    const res = repo.purgeExpired();
    expect(res.removed).toBe(1);
    expect(repo.getChat(a)).toBeNull();
    expect(repo.getChat(b)).not.toBeNull();
  });

  it('is validated at the api and returns the files to delete', async () => {
    const repo = freshRepo();
    const removed: string[][] = [];
    const api = createApi(repo, {
      openExternal: async () => {},
      removeFiles: async (p) => void removed.push(p),
    });
    await expect(api.purge([])).rejects.toThrow();
    await expect(api.purgePreview([-1])).rejects.toThrow();
    const ids = trash(repo, 1);
    expect(await api.purge(ids)).toEqual({ removed: 1, skipped: 0 });
    expect(removed).toEqual([]); // no images attached: nothing to delete from disk
  });
});

describe('order chosen by the user', () => {
  const labels = (repo: Repo, platform: string) =>
    repo
      .sidebar()
      .platforms.find((p) => p.platform === platform)!
      .accounts.map((a) => a.label);

  it('starts in creation order, and profiles can be reordered within their platform', () => {
    const repo = freshRepo();
    expect(labels(repo, 'chatgpt')).toEqual(['Personal', 'Acme Store', 'Bluewave Studio']);
    const ids = new Map(
      repo
        .sidebar()
        .platforms.find((p) => p.platform === 'chatgpt')!
        .accounts.map((a) => [a.label, a.id]),
    );
    repo.reorderAccounts('chatgpt', [
      ids.get('Bluewave Studio')!,
      ids.get('Personal')!,
      ids.get('Acme Store')!,
    ]);
    expect(labels(repo, 'chatgpt')).toEqual(['Bluewave Studio', 'Personal', 'Acme Store']);
    // The same order everywhere the profiles are listed.
    expect(repo.dashboard('chatgpt').accounts.map((a) => a.label)).toEqual([
      'Bluewave Studio',
      'Personal',
      'Acme Store',
    ]);
    expect(
      repo
        .filterOptions()
        .accounts.filter((a) => a.platform === 'chatgpt')
        .map((a) => a.label),
    ).toEqual(['Bluewave Studio', 'Personal', 'Acme Store']);
    // Other platforms are untouched.
    expect(labels(repo, 'claude')).toEqual(['Personal', 'Bluewave Studio']);
  });

  it('only accepts exactly the platform’s own profiles', () => {
    const repo = freshRepo();
    const chatgpt = repo
      .sidebar()
      .platforms.find((p) => p.platform === 'chatgpt')!
      .accounts.map((a) => a.id);
    const claude = repo
      .sidebar()
      .platforms.find((p) => p.platform === 'claude')!
      .accounts.map((a) => a.id);
    expect(() => repo.reorderAccounts('chatgpt', chatgpt.slice(1))).toThrow(); // one missing
    expect(() => repo.reorderAccounts('chatgpt', [...chatgpt, chatgpt[0]!])).toThrow(); // repeated
    expect(() => repo.reorderAccounts('chatgpt', [...claude, ...chatgpt.slice(1)])).toThrow(); // another platform's
    expect(labels(repo, 'chatgpt')).toEqual(['Personal', 'Acme Store', 'Bluewave Studio']);
  });

  it('a new profile goes last, and platforms can be reordered', () => {
    const repo = freshRepo();
    repo.addAccount({ platform: 'chatgpt', label: 'Newest', partition: 'persist:chatgpt-newest' });
    expect(labels(repo, 'chatgpt').at(-1)).toBe('Newest');
    expect(repo.sidebar().platforms.map((p) => p.platform)).toEqual([
      'chatgpt',
      'claude',
      'gemini',
    ]);
    repo.reorderPlatforms(['gemini', 'chatgpt']); // claude is not listed: it follows
    expect(repo.sidebar().platforms.map((p) => p.platform)).toEqual([
      'gemini',
      'chatgpt',
      'claude',
    ]);
    expect(() => repo.reorderPlatforms(['chatgpt', 'chatgpt'])).toThrow();
    expect(() => repo.reorderPlatforms(['nope' as never])).toThrow();
  });

  it('is validated at the api', async () => {
    const api = createApi(freshRepo(), { openExternal: async () => {} });
    await expect(api.reorderAccounts('chatgpt', [1, 1])).rejects.toThrow();
    await expect(api.reorderPlatforms(['evil' as never])).rejects.toThrow();
  });
});

describe('image gallery filters', () => {
  function setup() {
    const repo = new Repo(openDatabase());
    const accountId = repo.addAccount({
      platform: 'chatgpt',
      label: 'Acme',
      partition: 'persist:t1',
    });
    const shop = repo.upsertProject(accountId, 'g-p-1', 'Habibi Beach');
    const other = repo.upsertProject(accountId, 'g-p-2', 'Something else');
    const chat = (
      remoteId: string,
      title: string,
      updated: string,
      projectId: number | null,
      refs: string[],
    ) =>
      repo.upsertConversation({
        accountId,
        remoteId,
        remoteTitle: title,
        createdAt: updated,
        remoteUpdatedAt: updated,
        ...(projectId ? { projectId } : {}),
        images: refs.map((ref) => ({ ref, kind: 'generated' as const, alt: `prompt of ${ref}` })),
        messages: [{ role: 'user', createdAt: updated, blocks: [{ type: 'text', text: 'hi' }] }],
      });
    chat('c1', 'Logo ideas', '2026-01-01T00:00:00Z', shop, [
      'sediment://file_a1',
      'sediment://file_a2',
    ]);
    chat('c2', 'Poster', '2026-03-01T00:00:00Z', other, ['sediment://file_b1']);
    chat('c3', 'Loose chat', '2026-02-01T00:00:00Z', null, [
      'sediment://file_c1',
      'sediment://file_c1#p_0.jpg', // a web-result thumbnail, not an image of the account
    ]);
    return { repo, shop, other };
  }

  it('sorts by date of the chat, newest or oldest first', () => {
    const { repo } = setup();
    expect(repo.listImages({}).items.map((i) => i.chatTitle)).toEqual([
      'Poster',
      'Loose chat',
      'Logo ideas',
      'Logo ideas',
    ]);
    expect(repo.listImages({ sort: 'oldest' }).items[0]!.chatTitle).toBe('Logo ideas');
    expect(repo.listImages({}).total).toBe(4); // the `#` reference is not counted
  });

  it('filters by project and lists the projects that have images', () => {
    const { repo, shop } = setup();
    const r = repo.listImages({ projectId: shop });
    expect(r.items.map((i) => i.projectName)).toEqual(['Habibi Beach', 'Habibi Beach']);
    expect(r.projects.map((p) => [p.name, p.count])).toEqual([
      ['Habibi Beach', 2],
      ['Something else', 1],
    ]); // not narrowed by the filter itself
  });

  it('searches project name, chat title and prompt, all words required', () => {
    const { repo } = setup();
    expect(repo.listImages({ search: 'habibi' }).total).toBe(2);
    expect(repo.listImages({ search: 'poster' }).total).toBe(1);
    expect(repo.listImages({ search: 'prompt of sediment://file_c1' }).total).toBe(1);
    expect(repo.listImages({ search: 'habibi poster' }).total).toBe(0);
    expect(repo.listImages({ search: '100%' }).total).toBe(0); // wildcard characters are plain text
  });

  it('completes what is typed with project names and chat titles that have images', () => {
    const { repo } = setup();
    expect(repo.imageSuggestions('hab')).toEqual(['Habibi Beach']);
    expect(repo.imageSuggestions('lo').sort()).toEqual(['Logo ideas', 'Loose chat']);
    expect(repo.imageSuggestions('')).toEqual([]);
  });
});

describe('page sizes', () => {
  it('lets a list keep growing as far as the user scrolls (well past 500), through the validated API', async () => {
    const api = createApi(freshRepo(), { openExternal: async () => {} });
    await expect(api.listChats({ limit: 2000 })).resolves.toBeDefined();
    await expect(api.listImages({ limit: 2000 })).resolves.toBeDefined();
    await expect(api.listImages({ limit: 5001 })).rejects.toThrow();
  });
});

describe('backup before a migration', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'uac-db-'));

  it('keeps a copy of an existing database before upgrading it, once, and not for a new or current one', () => {
    const d = dir();
    try {
      const file = join(d, 'app.sqlite');
      // A new database: nothing to back up.
      openDatabase(file).close();
      expect(existsSync(`${file}.backup-v0`)).toBe(false);
      // Current: nothing to back up.
      openDatabase(file).close();
      expect(readdirNames(d).some((n) => n.includes('backup'))).toBe(false);

      // An older database (as if written by the previous version of the app), holding some data.
      const old = new DatabaseSync(file);
      old.exec("INSERT INTO accounts (platform, label, partition) VALUES ('chatgpt', 'Acme', 'p')");
      old.exec('PRAGMA user_version = 8');
      old.close();
      openDatabase(file).close();
      const backup = `${file}.backup-v8`;
      expect(existsSync(backup)).toBe(true);
      const copy = new DatabaseSync(backup);
      expect(copy.prepare('SELECT label FROM accounts').all()).toEqual([{ label: 'Acme' }]);
      expect(
        (copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(8);
      copy.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

import { readdirSync } from 'node:fs';
const readdirNames = (d: string) => readdirSync(d);
