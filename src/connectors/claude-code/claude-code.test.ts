import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, CLAUDE_CODE_PARTITION } from '../../core/api';
import { openDatabase } from '../../core/db';
import { seedFixtures } from '../../core/fixtures';
import { Repo } from '../../core/repo';
import { syncAccount } from '../../core/sync';
import { EndpointChanged, NotFound } from '../errors';
import { claudeCodeConnector } from './index';
import { isGenericFolder, parseSession } from './parse';

/**
 * All sessions below are SYNTHETIC. Their shape follows the fields observed on a real Claude Code
 * installation (structure only); no real conversation content is used anywhere.
 */

const T = (n: number) => `2026-09-1${n}T10:00:0${n}.000Z`;
type Line = Record<string, unknown>;
const jsonl = (lines: (Line | string)[]) =>
  lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

const base = (over: Line) => ({
  sessionId: 's1',
  cwd: '/work/demo-app',
  isSidechain: false,
  ...over,
});
const user = (uuid: string, parent: string | null, content: unknown, n = 1, over: Line = {}) =>
  base({
    type: 'user',
    uuid,
    parentUuid: parent,
    timestamp: T(n),
    message: { role: 'user', content },
    ...over,
  });
const assistant = (
  uuid: string,
  parent: string | null,
  content: unknown[],
  n = 2,
  over: Line = {},
) =>
  base({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    timestamp: T(n),
    message: { role: 'assistant', content },
    ...over,
  });

const SIMPLE = jsonl([
  { type: 'queue-operation', operation: 'enqueue', sessionId: 's1', timestamp: T(1) },
  user('u1', null, 'How do I rename a git branch?'),
  assistant('a1', 'u1', [{ type: 'thinking', thinking: 'internal reasoning must not appear' }]),
  assistant('a2', 'a1', [{ type: 'text', text: 'Use git branch -m old new.' }], 3),
  assistant(
    'a3',
    'a2',
    [{ type: 'tool_use', name: 'Bash', input: { command: 'git branch -m old new' } }],
    4,
  ),
  user('u2', 'a3', [{ type: 'tool_result', tool_use_id: 'x', content: 'HUGE TOOL OUTPUT' }], 5),
  assistant('a4', 'u2', [{ type: 'text', text: 'Done, the branch is renamed.' }], 6),
  { type: 'ai-title', sessionId: 's1', aiTitle: 'Rename a git branch' },
  { type: 'system', subtype: 'x', sessionId: 's1' },
]);

const opts = {
  sessionId: 's1',
  projectDir: '-work-demo-app',
  fallbackTime: '2026-01-01T00:00:00.000Z',
};

describe('parseSession', () => {
  it('builds a readable transcript: merges assistant lines, keeps tool calls short, drops thinking and tool output', () => {
    const c = parseSession(SIMPLE, opts);
    expect(c.remoteTitle).toBe('Rename a git branch');
    expect(c.projectName).toBe('demo-app'); // basename of cwd, never the full path
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const ai = c.messages[1]!;
    expect(ai.blocks).toEqual([
      { type: 'text', text: 'Use git branch -m old new.' },
      { type: 'code', lang: 'tool', text: 'Bash: git branch -m old new' },
      { type: 'text', text: 'Done, the branch is renamed.' },
    ]);
    const all = JSON.stringify(c);
    expect(all).not.toContain('internal reasoning');
    expect(all).not.toContain('HUGE TOOL OUTPUT');
    expect(c.createdAt).toBe(T(1));
    expect(c.updatedAt).toBe(T(6));
  });

  it('titles: custom beats ai-title, and falls back to the first prompt', () => {
    const custom = parseSession(
      SIMPLE + jsonl([{ type: 'custom-title', customTitle: 'My branch chat' }]),
      opts,
    );
    expect(custom.customTitle).toBe('My branch chat');
    expect(custom.remoteTitle).toBe('Rename a git branch'); // the original stays available

    const none = parseSession(
      jsonl([
        user('u1', null, 'A very first prompt'),
        assistant('a1', 'u1', [{ type: 'text', text: 'ok' }]),
      ]),
      opts,
    );
    expect(none.remoteTitle).toBe('A very first prompt');
  });

  it('follows the active branch and ignores abandoned branches and sidechains', () => {
    const text = jsonl([
      user('u1', null, 'question'),
      assistant('a1', 'u1', [{ type: 'text', text: 'first answer (abandoned)' }], 2),
      user('u2', 'u1', 'question, edited', 3), // fork: u1 has two children
      assistant('a2', 'u2', [{ type: 'text', text: 'answer to the edited question' }], 4),
      assistant('side', 'a2', [{ type: 'text', text: 'sub-agent chatter' }], 5, {
        isSidechain: true,
      }),
    ]);
    const c = parseSession(text, opts);
    const flat = JSON.stringify(c.messages);
    expect(flat).toContain('question, edited');
    expect(flat).toContain('answer to the edited question');
    expect(flat).not.toContain('abandoned');
    expect(flat).not.toContain('sub-agent chatter');
  });

  it('follows the chain THROUGH non-message lines (attachments, system notices)', () => {
    // Regression: real sessions link messages via attachment/system lines. Walking only user/assistant
    // lines cut the conversation down to its last couple of messages.
    const node = (type: string, uuid: string, parent: string | null, n: number) =>
      base({ type, uuid, parentUuid: parent, timestamp: T(n) });
    const text = jsonl([
      user('u1', null, 'first question', 1),
      assistant('a1', 'u1', [{ type: 'text', text: 'first answer' }], 2),
      node('attachment', 'att1', 'a1', 3),
      node('system', 'sys1', 'att1', 3),
      user('u2', 'sys1', 'second question', 4), // parent is a system line, not a message
      node('attachment', 'att2', 'u2', 4),
      assistant('a2', 'att2', [{ type: 'text', text: 'second answer' }], 5),
    ]);
    const c = parseSession(text, opts);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(c.messages)).toContain('first question');
    expect(JSON.stringify(c.messages)).toContain('second answer');
  });

  it('crosses a compaction boundary through logicalParentUuid', () => {
    const text = jsonl([
      user('u1', null, 'before compaction', 1),
      assistant('a1', 'u1', [{ type: 'text', text: 'answer before' }], 2),
      // The boundary starts a new parent chain (parentUuid null) but points back logically.
      base({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'cb',
        parentUuid: null,
        logicalParentUuid: 'a1',
        timestamp: T(3),
      }),
      user('u2', 'cb', 'after compaction', 4),
      assistant('a2', 'u2', [{ type: 'text', text: 'answer after' }], 5),
    ]);
    const c = parseSession(text, opts);
    const flat = JSON.stringify(c.messages);
    expect(flat).toContain('before compaction');
    expect(flat).toContain('answer after');
    expect(c.messages).toHaveLength(4);
  });

  it('a genuinely missing parent ends the chain instead of failing', () => {
    const c = parseSession(
      jsonl([
        user('u9', 'gone', 'orphan question', 1),
        assistant('a9', 'u9', [{ type: 'text', text: 'orphan answer' }], 2),
      ]),
      opts,
    );
    expect(c.messages).toHaveLength(2);
  });

  it('tolerates a session that is still being written (truncated last line)', () => {
    const c = parseSession(SIMPLE + '{"type":"assistant","uuid":"a9","message":{"ro', opts);
    expect(c.messages).toHaveLength(2);
  });

  it('raises EndpointChanged instead of guessing when the format changes', () => {
    expect(() =>
      parseSession(jsonl([{ type: 'user', uuid: 'u1', timestamp: T(1) }]), opts),
    ).toThrow(EndpointChanged); // no message
    expect(() =>
      parseSession(
        jsonl([user('u1', null, 'x'), 'not json at all', user('u2', 'u1', 'y', 2)]),
        opts,
      ),
    ).toThrow(EndpointChanged); // garbage in the middle
    expect(() =>
      parseSession(
        jsonl([{ ...user('u1', null, 'x'), message: { role: 'user', content: 42 } }]),
        opts,
      ),
    ).toThrow(EndpointChanged); // content is neither string nor array
  });

  it('handles empty and metadata-only files', () => {
    const c = parseSession('', opts);
    expect(c.messages).toEqual([]);
    expect(c.remoteTitle).toBe('Untitled session');
    expect(c.createdAt).toBe(opts.fallbackTime);
  });
});

describe('connector + sync', () => {
  let root: string;
  let repo: Repo;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uac-cc-'));
    mkdirSync(join(root, '-work-demo-app', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(root, '-work-demo-app', 's1.jsonl'), SIMPLE);
    writeFileSync(
      join(root, '-work-demo-app', 's2.jsonl'),
      jsonl([
        user('u1', null, 'Second session prompt', 2),
        assistant('a1', 'u1', [{ type: 'text', text: 'Second answer' }], 3),
      ]),
    );
    // Sub-agent transcripts live in nested folders and are not chats.
    writeFileSync(join(root, '-work-demo-app', 's1', 'subagents', 'agent-x.jsonl'), SIMPLE);
    writeFileSync(join(root, '-work-demo-app', 'notes.txt'), 'ignored');
    repo = new Repo(openDatabase());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ids = async (since?: Date) => {
    const out: string[] = [];
    for await (const s of claudeCodeConnector.listConversations({ accountId: 1, root }, since))
      out.push(s.remoteId);
    return out.sort();
  };

  it('lists only top-level session files', async () => {
    expect(await ids()).toEqual(['-work-demo-app/s1', '-work-demo-app/s2']);
  });

  it('filters by modification time for incremental sync', async () => {
    const old = new Date('2020-01-01');
    utimesSync(join(root, '-work-demo-app', 's1.jsonl'), old, old);
    expect(await ids(new Date('2021-01-01'))).toEqual(['-work-demo-app/s2']);
  });

  it('rejects ids that try to leave the root', async () => {
    for (const bad of ['../etc/passwd', '-work-demo-app/../../x', 'a/b/c', '', '/abs/path']) {
      await expect(
        claudeCodeConnector.getConversation({ accountId: 1, root }, bad),
      ).rejects.toBeInstanceOf(NotFound);
    }
  });

  it('imports sessions searchable and readable, with the project and original title', async () => {
    const accountId = repo.addAccount({
      platform: 'claude-code',
      label: 'This Mac',
      partition: CLAUDE_CODE_PARTITION,
    });
    const stats = await syncAccount(repo, claudeCodeConnector, { accountId, root });
    expect(stats).toMatchObject({ seen: 2, imported: 2, failed: 0 });

    expect(repo.listChats({ search: 'branch' }).total).toBe(1);
    expect(repo.listChats({ search: 'Second answer' }).total).toBe(1);
    expect(repo.listChats({ search: 'internal reasoning' }).total).toBe(0);

    const chat = repo.getChat(repo.listChats({ search: 'branch' }).items[0]!.id)!;
    expect(chat.platform).toBe('claude-code');
    expect(chat.projectName).toBe('demo-app');
    expect(chat.messages).toHaveLength(2);
    expect(repo.sidebar().platforms[0]!.accounts[0]).toMatchObject({
      label: 'This Mac',
      status: 'ok',
    });
  });

  it('is incremental and keeps local edits across re-syncs', async () => {
    const accountId = repo.addAccount({
      platform: 'claude-code',
      label: 'This Mac',
      partition: CLAUDE_CODE_PARTITION,
    });
    await syncAccount(repo, claudeCodeConnector, { accountId, root });
    const first = repo.listChats({ search: 'branch' }).items[0]!;
    repo.setTitle(first.id, 'My own name');
    repo.bulk([first.id], { type: 'tag', tag: 'keep' });

    // Nothing changed on disk: nothing is fetched.
    const past = new Date('2020-01-01');
    for (const f of ['s1', 's2'])
      utimesSync(join(root, '-work-demo-app', `${f}.jsonl`), past, past);
    expect((await syncAccount(repo, claudeCodeConnector, { accountId, root })).seen).toBe(0);

    // A session grows: only it is re-imported; the rename and tag survive.
    const grown =
      SIMPLE +
      jsonl([
        user('u3', 'a4', 'one more question', 7),
        assistant('a5', 'u3', [{ type: 'text', text: 'one more answer' }], 8),
      ]);
    writeFileSync(join(root, '-work-demo-app', 's1.jsonl'), grown);
    const stats = await syncAccount(repo, claudeCodeConnector, { accountId, root });
    expect(stats).toMatchObject({ seen: 1, imported: 1 });
    const after = repo.getChat(first.id)!;
    expect(after.title).toBe('My own name');
    expect(after.remoteTitle).toBe('Rename a git branch');
    expect(after.tags).toEqual(['keep']);
    expect(after.messages.length).toBe(4);
    expect(repo.listChats({ search: 'one more answer' }).total).toBe(1);
    expect(repo.listChats({}).total).toBe(2); // no duplicates
  });

  it('a broken file is reported and flags the account, without blocking the others', async () => {
    writeFileSync(
      join(root, '-work-demo-app', 's3.jsonl'),
      jsonl([{ type: 'user', uuid: 'u1', timestamp: T(1) }]),
    );
    const accountId = repo.addAccount({
      platform: 'claude-code',
      label: 'This Mac',
      partition: CLAUDE_CODE_PARTITION,
    });
    const stats = await syncAccount(repo, claudeCodeConnector, { accountId, root });
    expect(stats).toMatchObject({ seen: 3, imported: 2, failed: 1 });
    expect(stats.errors[0]).toMatch(/s3/);
    expect(stats.errors[0]).not.toMatch(/\//); // ids and reasons only, no paths or content
    expect(repo.sidebar().platforms[0]!.accounts[0]!.status).toBe('needs_attention');
    expect(repo.listChats({}).total).toBe(2);

    // Fixing the file clears the flag on the next sync.
    writeFileSync(
      join(root, '-work-demo-app', 's3.jsonl'),
      jsonl([
        user('u1', null, 'fixed', 9),
        assistant('a1', 'u1', [{ type: 'text', text: 'ok' }], 9),
      ]),
    );
    await syncAccount(repo, claudeCodeConnector, { accountId, root });
    expect(repo.sidebar().platforms[0]!.accounts[0]!.status).toBe('ok');
  });
});

describe('connectClaudeCode (api)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uac-cc-'));
    mkdirSync(join(root, '-work-demo-app'), { recursive: true });
    writeFileSync(join(root, '-work-demo-app', 's1.jsonl'), SIMPLE);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes the demo data on the first real source, once, and imports the sessions', async () => {
    const repo = new Repo(openDatabase());
    seedFixtures(repo);
    repo.setSetting('demo_data', '1');
    const api = createApi(repo, { openExternal: async () => {}, claudeCodeRoot: root });

    const res = await api.connectClaudeCode('This Mac');
    expect(res.stats).toMatchObject({ imported: 1, failed: 0 });
    const s = await api.sidebar();
    expect(s.demo).toBe(false);
    expect(s.platforms.map((p) => p.platform)).toEqual(['claude-code']);
    expect(s.totalChats).toBe(1);
    expect(repo.listChats({ search: 'Shopify' }).total).toBe(0); // demo rows are fully gone, index included
    expect(repo.filterOptions().tags).toEqual([]);

    // Connecting again reuses the account and does not duplicate anything.
    const again = await api.connectClaudeCode('This Mac');
    expect(again.accountId).toBe(res.accountId);
    expect((await api.sidebar()).totalChats).toBe(1);
    expect((await api.syncAll()).failed).toBe(0);
  });

  it('never deletes real data: removeDemoData does nothing once the demo flag is off', async () => {
    const repo = new Repo(openDatabase());
    const api = createApi(repo, { openExternal: async () => {}, claudeCodeRoot: root });
    await api.connectClaudeCode('This Mac');
    expect(repo.removeDemoData()).toBe(false);
    expect(repo.listChats({}).total).toBe(1);
  });

  it('explains a missing sessions folder instead of failing silently', async () => {
    const api = createApi(new Repo(openDatabase()), {
      openExternal: async () => {},
      claudeCodeRoot: join(root, 'nope'),
    });
    await expect(api.connectClaudeCode('This Mac')).rejects.toThrow(
      /No Claude Code sessions folder/,
    );
  });
});

describe('sessions started in a generic folder', () => {
  it('knows the home folder and Documents/Desktop/Downloads, and nothing deeper', () => {
    for (const generic of [
      '/Users/someone',
      '/Users/someone/Documents',
      '/Users/someone/Desktop/',
      '/home/someone/Downloads',
      'C:\\Users\\someone\\Documents',
    ])
      expect(isGenericFolder(generic), generic).toBe(true);
    for (const project of [
      '/work/demo-app',
      '/Users/someone/Documents/shop',
      '/Users/someone/Projects',
      'C:\\Users\\someone\\Documents\\shop',
    ])
      expect(isGenericFolder(project), project).toBe(false);
  });

  it('files them as plain chats, not under a project named after the folder', () => {
    const line = (cwd: string) =>
      jsonl([
        user('u1', null, 'Rename a git branch', 1, { cwd }),
        assistant('a1', 'u1', [{ type: 'text', text: 'Use git branch -m.' }], 2, { cwd }),
      ]);
    const generic = parseSession(line('/Users/someone/Documents'), opts);
    expect(generic.projectName).toBeUndefined();
    expect(generic.projectRemoteId).toBeUndefined();
    const real = parseSession(line('/Users/someone/Documents/shop'), opts);
    expect(real.projectName).toBe('shop');
  });
});
