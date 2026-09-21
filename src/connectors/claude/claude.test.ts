import { describe, expect, it } from 'vitest';
import { createApi } from '../../core/api';
import { openDatabase } from '../../core/db';
import { Repo } from '../../core/repo';
import { fakeWeb } from '../../core/testing';
import type { HttpJson, HttpResult } from '../types';
import { parseConversation } from './parse';
import { conversationDetailSchema } from './schema';

const uuid = (n: number, tag = '0') =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-${tag.padStart(12, '0')}`;
const ORG = uuid(1, 'a');
const PROJECT = uuid(2, 'b');

interface Chat {
  n: number;
  title: string;
  update: string;
  archived?: boolean;
  starred?: boolean;
  project?: string;
  messages?: { sender: string; blocks: { type: string; text?: string }[] }[];
}

/** A fake claude.ai: only the calls the connector makes, with the shapes recorded on a real account. */
function server(chats: Chat[], projects: { uuid: string; name: string }[] = []) {
  const detailCalls: string[] = [];
  const failures: HttpResult[] = [];
  const item = (c: Chat) => ({
    uuid: uuid(c.n),
    name: c.title,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: c.update,
    project_uuid: c.project ?? null,
    is_starred: !!c.starred,
    extra_field_we_ignore: 1,
  });
  const http: HttpJson = async (path) => {
    if (failures.length && path.includes('/chat_conversations/')) return failures.shift()!;
    const url = new URL(path, 'https://claude.ai');
    const p = url.pathname;
    if (p === '/api/account') return { status: 200, json: { uuid: 'acct-1', email_address: 'x' } };
    if (p === '/api/organizations')
      return { status: 200, json: [{ uuid: ORG, name: 'Me', capabilities: ['chat'] }] };
    if (p === `/api/organizations/${ORG}/projects_v2`) {
      const archived = url.searchParams.get('is_archived') === 'true';
      return {
        status: 200,
        json: { data: archived ? [] : projects, pagination: { has_more: false } },
      };
    }
    if (p === `/api/organizations/${ORG}/chat_conversations_v2`) {
      const q = url.searchParams;
      const offset = Number(q.get('offset'));
      const limit = Number(q.get('limit'));
      const all = chats.filter((c) =>
        q.get('starred') === 'true' ? c.starred : !!c.archived === (q.get('archived') === 'true'),
      );
      const data = all.slice(offset, offset + limit).map(item);
      return {
        status: 200,
        json: { data: [...data, {}], has_more: offset + limit < all.length },
      };
    }
    const one = new RegExp(`^/api/organizations/${ORG}/chat_conversations/(.+)$`).exec(p);
    if (one) {
      const c = chats.find((x) => uuid(x.n) === one[1]);
      if (!c) return { status: 404, json: undefined };
      detailCalls.push(one[1]!);
      const msgs = c.messages ?? [
        { sender: 'human', blocks: [{ type: 'text', text: `Question in ${c.title}` }] },
        { sender: 'assistant', blocks: [{ type: 'text', text: `Answer in ${c.title}` }] },
      ];
      return {
        status: 200,
        json: {
          ...item(c),
          current_leaf_message_uuid: uuid(c.n, String(msgs.length)),
          chat_messages: msgs.map((m, i) => ({
            uuid: uuid(c.n, String(i + 1)),
            sender: m.sender,
            content: m.blocks,
            created_at: '2026-01-01T00:00:00Z',
            parent_message_uuid: i === 0 ? uuid(0) : uuid(c.n, String(i)),
            files: [],
          })),
        },
      };
    }
    return { status: 404, json: undefined };
  };
  return { http, detailCalls, failures };
}

async function boot(chats: Chat[], projects: { uuid: string; name: string }[] = []) {
  const repo = new Repo(openDatabase());
  const web = fakeWeb();
  const api = createApi(repo, {
    openExternal: async () => {},
    web: web.host,
    chatgptClient: { sleep: async () => {}, paceMs: 0, jitterMs: 0 },
  });
  web.signedInAs('acct-1');
  const { attemptId } = await api.signInStart('claude');
  await api.signInStatus(attemptId);
  await api.signInFinish(attemptId, { type: 'new', label: 'Studio' });
  const s = server(chats, projects);
  web.setHttp(s.http);
  return { repo, api, s, web };
}

describe('parseConversation (Claude)', () => {
  const detail = (over: Record<string, unknown> = {}) =>
    conversationDetailSchema.parse({
      uuid: uuid(1),
      name: 'A title',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      current_leaf_message_uuid: uuid(1, '4'),
      chat_messages: [
        {
          uuid: uuid(1, '1'),
          sender: 'human',
          text: 'Hi',
          created_at: 'x',
          parent_message_uuid: uuid(0),
        },
        {
          uuid: uuid(1, '2'),
          sender: 'assistant',
          text: 'old branch',
          created_at: 'x',
          parent_message_uuid: uuid(1, '1'),
        },
        {
          uuid: uuid(1, '3'),
          sender: 'assistant',
          created_at: 'x',
          parent_message_uuid: uuid(1, '1'),
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', name: 'search' },
            { type: 'text', text: 'Answer' },
          ],
        },
        {
          uuid: uuid(1, '4'),
          sender: 'human',
          text: 'Thanks',
          created_at: 'x',
          parent_message_uuid: uuid(1, '3'),
        },
      ],
      ...over,
    });

  it('keeps the branch on screen, the text, and counts what it leaves out', () => {
    const c = parseConversation(detail(), uuid(1), () => undefined);
    expect(c.messages.map((m) => [m.role, m.blocks[0]])).toEqual([
      ['user', { type: 'text', text: 'Hi' }],
      ['assistant', { type: 'text', text: 'Answer' }],
      ['user', { type: 'text', text: 'Thanks' }],
    ]);
    expect(JSON.stringify(c)).not.toContain('old branch');
    expect(c.skipped).toEqual({ 'block:thinking': 1, 'block:tool_use': 1 });
  });

  it('names the project when it is known', () => {
    const c = parseConversation(detail({ project_uuid: PROJECT }), uuid(1), (id) =>
      id === PROJECT ? 'Client work' : undefined,
    );
    expect(c).toMatchObject({ projectRemoteId: PROJECT, projectName: 'Client work' });
  });
});

describe('importing Claude into the local inbox', () => {
  it('imports active, archived and starred chats, with projects, newest first', async () => {
    const c = await boot(
      [
        { n: 1, title: 'Plain', update: '2026-09-01T00:00:00Z' },
        { n: 2, title: 'Filed', update: '2026-09-03T00:00:00Z', project: PROJECT },
        { n: 3, title: 'Old archived', update: '2026-08-01T00:00:00Z', archived: true },
      ],
      [{ uuid: PROJECT, name: 'Client work' }],
    );
    const stats = await c.api.syncAll();
    expect(stats).toMatchObject({ imported: 3, failed: 0 });
    expect(stats.listing).toMatchObject({ organizations: 1, projects: 1, found: 3 });
    expect(c.s.detailCalls).toEqual([uuid(2), uuid(1), uuid(3)]);
    const filed = c.repo.listChats({ search: 'Filed' }).items[0]!;
    expect(c.repo.getChat(filed.id)).toMatchObject({
      platform: 'claude',
      projectName: 'Client work',
    });
    const archived = c.repo.listChats({ search: 'Old archived' }).items[0]!;
    expect(c.repo.getChat(archived.id)!.state).toBe('archived');
  });

  it('does not read a chat again when nothing changed', async () => {
    const c = await boot([{ n: 1, title: 'Plain', update: '2026-09-01T00:00:00Z' }]);
    await c.api.syncAll();
    c.s.detailCalls.length = 0;
    expect((await c.api.syncAll()).imported).toBe(0);
    expect(c.s.detailCalls).toEqual([]);
  });

  it('refuses a session that belongs to another Claude account', async () => {
    const c = await boot([{ n: 1, title: 'Plain', update: '2026-09-01T00:00:00Z' }]);
    const other: HttpJson = async (path) =>
      path === '/api/account' ? { status: 200, json: { uuid: 'someone-else' } } : c.s.http(path);
    c.web.setHttp(other);
    const stats = await c.api.syncAll();
    expect(stats.failed).toBe(1);
    expect(stats.errors.join()).toMatch(/different Claude account/);
    expect(c.repo.listChats({}).total).toBe(0);
  });

  it('stops with a clear message when a response no longer matches', async () => {
    const c = await boot([{ n: 1, title: 'Plain', update: '2026-09-01T00:00:00Z' }]);
    c.web.setHttp(async (path) =>
      path === '/api/organizations' ? { status: 200, json: { unexpected: true } } : c.s.http(path),
    );
    const stats = await c.api.syncAll();
    expect(stats.failed).toBe(1);
    expect(stats.errors.join()).toMatch(/no longer matches/);
  });

  it('waits and goes on when Claude asks it to slow down', async () => {
    const c = await boot([{ n: 1, title: 'Plain', update: '2026-09-01T00:00:00Z' }]);
    c.s.failures.push({ status: 429, json: undefined });
    expect((await c.api.syncAll()).imported).toBe(1);
  });
});

describe('each profile syncs on its own', () => {
  it('a slow ChatGPT sync does not hold Claude back, and Claude alone can be synced', async () => {
    const c = await boot([{ n: 1, title: 'Plain', update: '2026-09-01T00:00:00Z' }]);
    const claudeId = c.repo.profilesOf('claude')[0]!.id;
    c.web.signedInAs('user-x');
    const { attemptId } = await c.api.signInStart('chatgpt');
    await c.api.signInStatus(attemptId);
    const gptId = (await c.api.signInFinish(attemptId, { type: 'new', label: 'Acme' })).accountId;

    // ChatGPT never answers until we say so; Claude answers at once.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const claude = c.s.http;
    c.web.setHttp(async (path) => {
      if (path.startsWith('/backend-api') || path.startsWith('/api/auth')) {
        await gate;
        return { status: 401, json: undefined };
      }
      return claude(path);
    });

    const slow = c.api.syncProfiles([gptId]);
    const stats = await c.api.syncProfiles([claudeId]); // must finish while ChatGPT is still stuck
    expect(stats).toMatchObject({ imported: 1, failed: 0 });
    expect(c.repo.listChats({}).total).toBe(1);

    // Asking again for the stuck one joins its run instead of starting another.
    const again = c.api.syncProfiles([gptId]);
    release();
    const [a, b] = await Promise.all([slow, again]);
    expect(a.failed).toBe(1);
    expect(b.failed).toBe(1);
  });

  it('progress is kept per profile', async () => {
    const c = await boot([{ n: 1, title: 'Plain', update: '2026-09-01T00:00:00Z' }]);
    await c.api.syncAll();
    expect(await c.api.syncProgress()).toEqual([]);
  });
});
