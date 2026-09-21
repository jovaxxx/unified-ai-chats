import { describe, expect, it } from 'vitest';
import { createApi } from '../../core/api';
import { sniffImage, type MediaStore } from '../../core/images';
import { openDatabase } from '../../core/db';
import { Repo } from '../../core/repo';
import { syncAccount } from '../../core/sync';
import { fakeWeb } from '../../core/testing';
import { EndpointChanged, NotFound, RateLimited, SessionExpired } from '../errors';
import type { SyncProgress } from '../../shared/types';
import type { HttpJson, HttpResult } from '../types';
import { ChatGptClient } from './client';
import { createChatGptConnector } from './index';
import { parseConversation } from './parse';
import { conversationDetailSchema } from './schema';

/**
 * A stand-in for ChatGPT's web API, shaped like the structure report recorded on a real account.
 * ALL content here is invented.
 */
const uuid = (n: number) =>
  `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;
const PROJECT = 'g-p-64f8a1b2c3d4e5f60718293a4b5c';
const noSleep = async () => {};

interface Turn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text?: string;
  content_type?: string;
  parts?: unknown[];
  recipient?: string;
  channel?: string | null;
  weight?: number;
  language?: string;
}

/** A chat as ChatGPT returns it: a tree of nodes, `current_node` pointing at the end of the active branch. */
function detailOf(id: string, title: string, turns: Turn[], over: Record<string, unknown> = {}) {
  const mapping: Record<string, unknown> = {
    root: { id: 'root', message: null, parent: null, children: ['n0'] },
  };
  let parent = 'root';
  turns.forEach((t, i) => {
    const nid = `n${i}`;
    mapping[nid] = {
      id: nid,
      parent,
      children: i < turns.length - 1 ? [`n${i + 1}`] : [],
      message: {
        author: { role: t.role },
        create_time: 1_780_000_000 + i * 10,
        content: {
          content_type: t.content_type ?? 'text',
          ...(t.parts
            ? { parts: t.parts }
            : t.content_type === 'code'
              ? { text: t.text, language: t.language ?? 'python' }
              : { parts: [t.text ?? ''] }),
        },
        recipient: t.recipient ?? 'all',
        channel: t.channel ?? null,
        ...(t.weight !== undefined ? { weight: t.weight } : {}),
        status: 'finished_successfully',
      },
    };
    parent = nid;
  });
  return {
    title,
    create_time: 1_780_000_000,
    update_time: 1_780_000_000 + turns.length * 10,
    conversation_id: id,
    gizmo_id: null,
    is_archived: false,
    current_node: parent === 'root' ? null : parent,
    mapping,
    ...over,
  };
}

interface Chat {
  id: string;
  title: string;
  update: string; // ISO
  archived?: boolean;
  project?: string;
  turns?: Turn[];
}

function server(opts: {
  userId?: string;
  chats: Chat[];
  projects?: { id: string; name: string }[];
  /** What GET /backend-api/pins answers: pinned chats and pinned projects. */
  pins?: { chats?: string[]; projects?: { id: string; name: string }[] };
}) {
  const calls: string[] = [];
  const failures = new Map<string, HttpResult[]>();
  const detailCalls: string[] = [];
  const byNewest = (list: Chat[]) => [...list].sort((a, b) => b.update.localeCompare(a.update));
  const item = (c: Chat) => ({
    id: c.id,
    title: c.title,
    create_time: '2026-01-01T00:00:00Z',
    update_time: c.update,
    gizmo_id: c.project ?? null,
    is_archived: !!c.archived,
    is_starred: null,
    extra_field_we_ignore: 'x',
  });
  const http: HttpJson = async (path) => {
    calls.push(path);
    for (const [prefix, queue] of failures) {
      if (path.startsWith(prefix) && queue.length) return queue.shift()!;
    }
    const url = new URL(path, 'https://chatgpt.com');
    const p = url.pathname;
    if (p === '/api/auth/session') {
      return {
        status: 200,
        json: {
          accessToken: 'tok-' + 'x'.repeat(20),
          user: { id: opts.userId ?? 'user-AAA', name: 'Somebody' },
        },
      };
    }
    if (p === '/backend-api/conversations') {
      const archived = url.searchParams.get('is_archived') === 'true';
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const all = byNewest(opts.chats.filter((c) => !!c.archived === archived));
      return {
        status: 200,
        json: {
          items: all.slice(offset, offset + limit).map(item),
          total: all.length,
          limit,
          offset,
        },
      };
    }
    if (p === '/backend-api/gizmos/snorlax/sidebar') {
      const items = [
        { kind: 'sidebar_keep', something: 1 }, // not a project: must be ignored
        ...(opts.projects ?? []).map((pr) => ({
          gizmo: { gizmo: { id: pr.id, display: { name: pr.name }, other: 1 }, tools: [] },
        })),
      ];
      return { status: 200, json: { items, cursor: null } };
    }
    if (p === '/backend-api/pins') {
      const pins = opts.pins ?? {};
      return {
        status: 200,
        json: [
          ...(pins.projects ?? []).map((pr) => ({
            item_type: 'gizmo',
            item: { gizmo: { id: pr.id, display: { name: pr.name } }, files: [] },
          })),
          ...(pins.chats ?? []).map((id) => {
            const c = opts.chats.find((x) => x.id === id)!;
            return {
              item_type: 'conversation',
              item: { id, title: c.title, update_time: c.update },
            };
          }),
        ],
      };
    }
    const proj = /^\/backend-api\/gizmos\/(g-p-[0-9a-z]+)\/conversations$/.exec(p);
    if (proj) {
      const all = byNewest(opts.chats.filter((c) => c.project === proj[1]));
      return { status: 200, json: { items: all.map(item), cursor: null } };
    }
    const one = /^\/backend-api\/conversation\/(.+)$/.exec(p);
    if (one) {
      const c = opts.chats.find((x) => x.id === one[1]);
      if (!c) return { status: 404, json: { detail: 'Not found' } };
      detailCalls.push(c.id);
      return {
        status: 200,
        json: detailOf(
          c.id,
          c.title,
          c.turns ?? [
            { role: 'user', text: `Question in ${c.title}` },
            { role: 'assistant', text: `Answer in ${c.title}` },
          ],
          {
            gizmo_id: c.project ?? null,
            is_archived: !!c.archived,
            update_time: Date.parse(c.update) / 1000,
          },
        ),
      };
    }
    return { status: 404, json: undefined };
  };
  return {
    http,
    calls,
    detailCalls,
    failWith: (prefix: string, ...results: HttpResult[]) => failures.set(prefix, results),
  };
}

const chats = (n: number, over: Partial<Chat> = {}): Chat[] =>
  Array.from({ length: n }, (_, i) => ({
    id: uuid(i + 1),
    title: `Chat number ${i + 1}`,
    update: new Date(Date.UTC(2026, 8, 20, 12, 0) - i * 3_600_000).toISOString(),
    ...over,
  }));

describe('parseConversation', () => {
  const parse = (turns: Turn[], over: Record<string, unknown> = {}) =>
    parseConversation(
      conversationDetailSchema.parse(detailOf(uuid(1), 'A title', turns, over)),
      uuid(1),
      (id) => (id === PROJECT ? 'Client project' : undefined),
    );

  it('shows what was said and hides the plumbing', () => {
    const c = parse([
      { role: 'system', text: 'You are a helpful assistant', weight: 0 },
      { role: 'user', text: 'How do I sort a list?' },
      { role: 'assistant', text: 'Working on it…', channel: 'commentary' }, // intermediate note
      { role: 'assistant', content_type: 'code', text: 'print(sorted(x))', recipient: 'python' }, // a tool call
      { role: 'tool', content_type: 'execution_output', text: '[1, 2, 3]' },
      { role: 'assistant', content_type: 'model_editable_context', parts: ['internal memory'] },
      { role: 'assistant', text: 'Use `sorted(x)`.', channel: 'final' },
    ]);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const flat = JSON.stringify(c.messages);
    expect(flat).toContain('How do I sort a list?');
    expect(flat).toContain('Use `sorted(x)`.');
    for (const hidden of [
      'helpful assistant',
      'Working on it',
      'print(sorted',
      '[1, 2, 3]',
      'internal memory',
    ]) {
      expect(flat).not.toContain(hidden);
    }
  });

  it('keeps images as a marker, code as code, and drops citation markers', () => {
    const c = parse([
      { role: 'user', text: 'Show me a chart' },
      {
        role: 'assistant',
        content_type: 'multimodal_text',
        parts: [
          'Here it is:',
          { content_type: 'image_asset_pointer', asset_pointer: 'file-service://x' },
          'Anything else?',
        ],
      },
      { role: 'assistant', content_type: 'code', text: 'SELECT 1;', language: 'sql' },
      { role: 'assistant', text: 'Sourced citeturn0search0 claim.' },
    ]);
    const blocks = c.messages[1]!.blocks;
    expect(blocks).toEqual([
      { type: 'text', text: 'Here it is:' },
      { type: 'image', ref: 'file-service://x' },
      { type: 'text', text: 'Anything else?' },
      { type: 'code', lang: 'sql', text: 'SELECT 1;' },
      { type: 'text', text: 'Sourced  claim.' },
    ]);
  });

  it('shows what was said in a voice conversation (transcription parts)', () => {
    const c = parse([
      {
        role: 'user',
        content_type: 'multimodal_text',
        parts: [
          { content_type: 'audio_transcription', text: 'spoken question', direction: 'in' },
          { content_type: 'real_time_user_audio_video_asset_pointer', frames_asset_pointers: [] },
        ],
      },
      {
        role: 'assistant',
        content_type: 'multimodal_text',
        parts: [{ content_type: 'audio_transcription', text: 'spoken answer', direction: 'out' }],
      },
    ]);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(c.messages)).toContain('spoken question');
    expect(JSON.stringify(c.messages)).toContain('spoken answer');
  });

  it('never shows an empty chat just because current_node is missing or the chain is broken', () => {
    const noPointer = parse(
      [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'second' },
      ],
      { current_node: null },
    );
    expect(noPointer.messages.map((m) => m.role)).toEqual(['user', 'assistant']); // latest leaf is used

    const detail = conversationDetailSchema.parse(
      detailOf(uuid(1), 'T', [
        { role: 'user', text: 'orphan question' },
        { role: 'assistant', text: 'orphan answer' },
      ]),
    );
    (detail.mapping.n1 as { parent: string }).parent = 'gone'; // the chain from the end is cut
    (detail.mapping.n0 as { parent: string }).parent = 'also-gone';
    const broken = parseConversation({ ...detail, current_node: 'n1' }, uuid(1), () => undefined);
    expect(broken.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(broken.messages)).toContain('orphan answer');
  });

  it('reports which kinds of content it left out (names only), so gaps can be spotted', () => {
    const c = parse([
      { role: 'user', text: 'a question' },
      { role: 'assistant', content_type: 'thoughts', parts: ['private reasoning text'] },
      { role: 'assistant', content_type: 'execution_output', text: 'output' },
      { role: 'assistant', content_type: 'thoughts', parts: ['more reasoning'] },
      { role: 'assistant', text: 'the answer' },
    ]);
    expect(c.skipped).toEqual({ 'unhandled:thoughts': 2, 'hidden:execution_output': 1 });
    expect(JSON.stringify(c.skipped)).not.toContain('reasoning'); // kinds and counts, never content
    expect(parse([{ role: 'user', text: 'hi' }]).skipped).toBeUndefined();
  });

  it('follows the active branch only (edits and regenerations are left out)', () => {
    const detail = conversationDetailSchema.parse(
      detailOf(uuid(1), 'T', [
        { role: 'user', text: 'question' },
        { role: 'assistant', text: 'second answer (current)' },
      ]),
    );
    // A regenerated sibling of n1 that is NOT on the current branch.
    (detail.mapping as Record<string, unknown>).old = {
      id: 'old',
      parent: 'n0',
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['first answer (abandoned)'] },
        recipient: 'all',
      },
    };
    const flat = JSON.stringify(parseConversation(detail, uuid(1), () => undefined).messages);
    expect(flat).toContain('second answer (current)');
    expect(flat).not.toContain('abandoned');
  });

  it('projects, archive flag, dates and titles', () => {
    const c = parse([{ role: 'user', text: 'hi' }], {
      gizmo_id: PROJECT,
      is_archived: true,
      title: '   ',
    });
    expect(c).toMatchObject({
      projectRemoteId: PROJECT,
      projectName: 'Client project',
      archived: true,
      remoteTitle: 'Untitled',
    });
    expect(c.createdAt).toBe('2026-05-28T20:26:40.000Z');
    // A custom GPT (`g-…`, not `g-p-…`) is not a project.
    expect(
      parse([{ role: 'user', text: 'hi' }], { gizmo_id: 'g-abc123' }).projectRemoteId,
    ).toBeUndefined();
  });

  it('survives a broken tree (cycle, missing parent) and empty chats', () => {
    const detail = conversationDetailSchema.parse(
      detailOf(uuid(1), 'T', [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'b' },
      ]),
    );
    (detail.mapping.n0 as { parent: string }).parent = 'n1'; // n0 -> n1 -> n0: a cycle
    expect(() => parseConversation(detail, uuid(1), () => undefined)).not.toThrow();
    expect(parse([]).messages).toEqual([]);
  });
});

describe('ChatGptClient', () => {
  it('reads every page of the list, newest first, and stops when the list ends', async () => {
    const s = server({ chats: chats(70) });
    const client = new ChatGptClient(s.http, { sleep: noSleep });
    const ids: string[] = [];
    for await (const c of client.conversations(false)) ids.push(c.id);
    expect(ids).toHaveLength(70);
    expect(new Set(ids).size).toBe(70);
    expect(s.calls.filter((c) => c.startsWith('/backend-api/conversations?'))).toHaveLength(3); // 28 + 28 + 14
    expect(s.calls.every((c) => !/method|delete|patch/i.test(c))).toBe(true);
  });

  it('is polite: pauses between requests (with jitter) and only reads', async () => {
    const waits: number[] = [];
    const s = server({ chats: chats(60) });
    const client = new ChatGptClient(s.http, {
      sleep: async (ms) => void waits.push(ms),
      paceMs: 300,
      jitterMs: 300,
    });
    for await (const c of client.conversations(false)) void c;
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits.every((ms) => ms >= 300 && ms < 600)).toBe(true);
    expect(new Set(waits).size).toBeGreaterThan(1); // not the same pause every time
  });

  it('retries after a 429 (respecting Retry-After) and then succeeds', async () => {
    const waits: number[] = [];
    const s = server({ chats: chats(3) });
    s.failWith('/backend-api/conversations', {
      status: 429,
      json: undefined,
      retryAfterSeconds: 7,
    });
    const client = new ChatGptClient(s.http, {
      sleep: async (ms) => void waits.push(ms),
      paceMs: 0,
      jitterMs: 0,
    });
    const ids: string[] = [];
    for await (const c of client.conversations(false)) ids.push(c.id);
    expect(ids).toHaveLength(3);
    expect(waits).toContain(7000);
  });

  it('waits longer each time it is limited, and slows down for the rest of the run', async () => {
    const waits: number[] = [];
    const s = server({ chats: chats(70) });
    s.failWith(
      '/backend-api/conversations',
      { status: 429, json: undefined },
      { status: 429, json: undefined },
      { status: 429, json: undefined },
    );
    const client = new ChatGptClient(s.http, {
      sleep: async (ms) => void waits.push(ms),
      paceMs: 100,
      jitterMs: 0,
    });
    const ids: string[] = [];
    for await (const c of client.conversations(false)) ids.push(c.id);
    expect(ids).toHaveLength(70);
    // Backoff grows: 3s, then 10s, then 30s…
    expect(waits.filter((w) => w >= 3000).slice(0, 3)).toEqual([3000, 10_000, 30_000]);
    // …and the ordinary pauses afterwards are longer than the 100ms baseline.
    expect(waits.filter((w) => w < 3000).at(-1)!).toBeGreaterThan(100);
  });

  it('gives up with RateLimited if the limit never lifts, and with a plain error on a server outage', async () => {
    const limited = server({ chats: chats(3) });
    limited.failWith(
      '/backend-api/conversations',
      ...Array(10).fill({ status: 429, json: undefined }),
    );
    await expect(
      (async () => {
        for await (const c of new ChatGptClient(limited.http, { sleep: noSleep }).conversations(
          false,
        ))
          void c;
      })(),
    ).rejects.toBeInstanceOf(RateLimited);
    const down = server({ chats: chats(3) });
    down.failWith(
      '/backend-api/conversations',
      ...Array(10).fill({ status: 503, json: undefined }),
    );
    await expect(
      (async () => {
        for await (const c of new ChatGptClient(down.http, { sleep: noSleep }).conversations(false))
          void c;
      })(),
    ).rejects.toThrow(/503/);
  });

  it('tells apart signed out, not found and a changed site — without putting ids or content in the message', async () => {
    const client = (fail: HttpResult) => {
      const s = server({ chats: chats(2) });
      s.failWith('/backend-api/conversation/', fail);
      return new ChatGptClient(s.http, { sleep: noSleep });
    };
    await expect(
      client({ status: 401, json: undefined }).conversation(uuid(1)),
    ).rejects.toBeInstanceOf(SessionExpired);
    await expect(
      client({ status: 403, json: '<html>Just a moment…</html>' }).conversation(uuid(1)),
    ).rejects.toBeInstanceOf(SessionExpired);
    await expect(
      client({ status: 404, json: undefined }).conversation(uuid(1)),
    ).rejects.toBeInstanceOf(NotFound);
    const e = await client({
      status: 200,
      json: { title: 'My secret client title', mapping: 'not an object', current_node: 5 },
    })
      .conversation(uuid(1))
      .catch((x: Error) => x);
    expect(e).toBeInstanceOf(EndpointChanged);
    expect((e as Error).message).not.toContain('secret');
    expect((e as Error).message).not.toContain(uuid(1)); // ids are masked in messages
    expect((e as Error).message).toContain('/backend-api/conversation/:id');
    await expect(
      client({ status: 200, json: undefined }).conversation(uuid(1)),
    ).rejects.toBeInstanceOf(EndpointChanged); // HTML instead of JSON
  });

  it('ignores fields it does not know, but not a required one going missing', async () => {
    const s = server({ chats: chats(1) });
    const wrap: HttpJson = async (path) => {
      const r = await s.http(path);
      if (path.startsWith('/backend-api/conversations?')) {
        const j = r.json as { items: Record<string, unknown>[] };
        return {
          ...r,
          json: {
            ...j,
            brand_new_field: 1,
            items: j.items.map((it) =>
              Object.fromEntries(Object.entries(it).filter(([k]) => k !== 'update_time')),
            ),
          },
        };
      }
      return r;
    };
    await expect(
      (async () => {
        for await (const c of new ChatGptClient(wrap, { sleep: noSleep }).conversations(false))
          void c;
      })(),
    ).rejects.toBeInstanceOf(EndpointChanged);
  });
});

describe('ChatGPT connector', () => {
  const ctx = (http: HttpJson, over: Record<string, unknown> = {}) => ({
    accountId: 1,
    http,
    ...over,
  });
  const list = async (
    c: ReturnType<typeof createChatGptConnector>,
    x: ReturnType<typeof ctx>,
    since?: Date,
  ) => {
    const out: string[] = [];
    for await (const s of c.listConversations(x, since)) out.push(s.remoteId);
    return out;
  };

  it('lists active, archived and project conversations once each', async () => {
    const s = server({
      chats: [
        ...chats(3),
        { id: uuid(50), title: 'Old one', update: '2026-01-01T00:00:00Z', archived: true },
        { id: uuid(60), title: 'In a project', update: '2026-09-01T00:00:00Z', project: PROJECT },
      ],
      projects: [{ id: PROJECT, name: 'Client project' }],
    });
    const c = createChatGptConnector({ sleep: noSleep });
    const ids = await list(c, ctx(s.http));
    expect(ids.sort()).toEqual([uuid(1), uuid(2), uuid(3), uuid(50), uuid(60)].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('an incremental run stops at the first unchanged conversation', async () => {
    const s = server({ chats: chats(70) });
    const c = createChatGptConnector({ sleep: noSleep });
    const since = new Date(Date.UTC(2026, 8, 20, 12, 0) - 4.5 * 3_600_000); // newer than chats 1–5
    const ids = await list(c, ctx(s.http), since);
    expect(ids).toEqual([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)]);
    expect(
      s.calls.filter(
        (p) =>
          p.startsWith('/backend-api/conversations?is_archived=false') || p.includes('offset=28'),
      ),
    ).toHaveLength(0); // did not page further
  });

  it('refuses to import when the profile is signed in as a different account', async () => {
    const s = server({ userId: 'user-BBB', chats: chats(2) });
    const c = createChatGptConnector({ sleep: noSleep });
    await expect(list(c, ctx(s.http, { expectedIdentity: 'user-AAA' }))).rejects.toThrow(
      /different ChatGPT account/,
    );
    expect(s.calls.some((p) => p.startsWith('/backend-api/conversations'))).toBe(false); // nothing was read
    expect(await list(c, ctx(s.http, { expectedIdentity: 'user-BBB' }))).toHaveLength(2);
    expect(await list(c, ctx(s.http, { expectedIdentity: null }))).toHaveLength(2); // identity not known yet
  });

  it('still imports the chats if the project names cannot be read', async () => {
    const s = server({ chats: chats(2), projects: [{ id: PROJECT, name: 'X' }] });
    s.failWith('/backend-api/gizmos/snorlax', { status: 200, json: { unexpected: true } });
    const c = createChatGptConnector({ sleep: noSleep });
    expect(await list(c, ctx(s.http))).toHaveLength(2);
  });

  it('checkSession says signed in, signed out, or unknown', async () => {
    const c = createChatGptConnector({ sleep: noSleep });
    expect(await c.checkSession(ctx(server({ chats: [] }).http))).toBe('ok');
    const out = server({ chats: [] });
    out.failWith('/api/auth/session', { status: 401, json: undefined });
    expect(await c.checkSession(ctx(out.http))).toBe('login_required');
  });
});

describe('importing ChatGPT into the local inbox', () => {
  const setup = () => {
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      chatgptClient: { sleep: noSleep },
    });
    return { repo, api, web };
  };
  const signedInProfile = async (
    c: ReturnType<typeof setup>,
    label = 'Acme Store',
    identity = 'user-AAA',
  ) => {
    c.web.signedInAs(identity, 'Somebody');
    const { attemptId } = await c.api.signInStart('chatgpt');
    await c.api.signInStatus(attemptId);
    return (await c.api.signInFinish(attemptId, { type: 'new', label })).accountId;
  };

  it('Sync now brings chats, projects and archive in, searchable and readable', async () => {
    const c = setup();
    const accountId = await signedInProfile(c);
    const s = server({
      chats: [
        {
          id: uuid(1),
          title: 'Product page copy',
          update: '2026-09-20T10:00:00Z',
          turns: [
            { role: 'user', text: 'Write product copy for a linen shirt' },
            { role: 'assistant', text: 'Here is a **plain** version.' },
          ],
        },
        { id: uuid(2), title: 'Old archived idea', update: '2025-01-01T00:00:00Z', archived: true },
        { id: uuid(3), title: 'Client brief', update: '2026-09-19T10:00:00Z', project: PROJECT },
      ],
      projects: [{ id: PROJECT, name: 'Client project' }],
    });
    c.web.setHttp(s.http);
    // (the real client paces requests; tests use the api, so keep it quick by not depending on time)
    const stats = await Promise.race([
      c.api.syncAll(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('too slow')), 30_000)),
    ]);
    expect(stats).toMatchObject({ imported: 3, failed: 0 });

    expect(c.repo.listChats({ search: 'linen shirt' }).total).toBe(1);
    const archived = c.repo.listChats({ scope: 'archive' }).items;
    expect(archived.map((x) => x.title)).toEqual(['Old archived idea']);
    const inProject = c.repo.listChats({ search: 'Client brief' }).items[0]!;
    expect(inProject.projectName).toBe('Client project');
    expect(
      c.repo
        .getChat(c.repo.listChats({ search: 'linen' }).items[0]!.id)!
        .messages.map((m) => m.role),
    ).toEqual(['user', 'assistant']);
    expect(c.repo.sidebar().platforms[0]!.accounts[0]).toMatchObject({
      id: accountId,
      status: 'ok',
    });
    expect(c.web.httpPartitions[0]).toBe(c.repo.getAccount(accountId)!.partition); // this profile's own session
  });

  it('a second sync only reads what changed and keeps local edits', async () => {
    const c = setup();
    await signedInProfile(c);
    const all = chats(4);
    const s = server({ chats: all });
    c.web.setHttp(s.http);
    await c.api.syncAll();
    expect(s.detailCalls).toHaveLength(4);
    const mine = c.repo.listChats({}).items[0]!;
    c.repo.setTitle(mine.id, 'My own name');
    c.repo.bulk([mine.id], { type: 'tag', tag: 'keep' });

    s.detailCalls.length = 0;
    all[3]!.update = new Date(Date.now() + 3_600_000).toISOString(); // one chat changed remotely, just now
    all[3]!.title = 'Renamed on ChatGPT';
    await c.api.syncAll();
    expect(s.detailCalls).toEqual([all[3]!.id]);
    expect(c.repo.listChats({}).total).toBe(4); // no duplicates
    const kept = c.repo.getChat(mine.id)!;
    expect(kept.title).toBe('My own name');
    expect(kept.tags).toEqual(['keep']);
  });

  it('an interrupted import resumes where it stopped and says why it stopped', async () => {
    const c = setup();
    await signedInProfile(c);
    const s = server({ chats: chats(6) });
    // The limit kicks in from the 4th conversation on.
    let reads = 0;
    let limited = true;
    c.web.setHttp(async (path) => {
      if (limited && /\/backend-api\/conversation\/[^?]+$/.test(path) && ++reads >= 4)
        return { status: 429, json: undefined };
      return s.http(path);
    });
    const first = await c.api.syncAll();
    expect(first.failed).toBe(1);
    expect(first.errors[0]).toMatch(/limiting requests/);
    expect(c.repo.listChats({}).total).toBe(3); // what was read is kept
    const dash = c.repo.dashboard('chatgpt');
    expect(dash.needsAttention).toBe(true);
    expect(dash.lastError).toMatch(/limiting requests/); // the dashboard can say why

    // Next time the limit is gone: only the 3 missing chats are read, not all 6 again.
    limited = false;
    s.detailCalls.length = 0;
    const second = await c.api.syncAll();
    expect(second).toMatchObject({ failed: 0 });
    expect(s.detailCalls).toHaveLength(3);
    expect(c.repo.listChats({}).total).toBe(6);
    expect(c.repo.dashboard('chatgpt')).toMatchObject({ needsAttention: false, lastError: null });
  });

  it('re-reads a chat that was stored empty, and totals what it skipped', async () => {
    const c = setup();
    await signedInProfile(c);
    const s = server({
      chats: [
        {
          id: uuid(1),
          title: 'Only reasoning',
          update: '2026-09-20T10:00:00Z',
          turns: [
            { role: 'user', text: '   ' },
            { role: 'assistant', content_type: 'thoughts', parts: ['x'] },
          ],
        },
        { id: uuid(2), title: 'Fine', update: '2026-09-20T09:00:00Z' },
      ],
    });
    c.web.setHttp(s.http);
    const first = await c.api.syncAll();
    expect(first.skipped).toEqual({ 'unhandled:thoughts': 1 });
    expect(c.repo.listChats({ search: 'Only reasoning' }).items[0]!.messageCount).toBe(0);
    // Unchanged chats are not read again — except the one that came out empty.
    s.detailCalls.length = 0;
    await c.api.syncAll();
    expect(s.detailCalls).toEqual([uuid(1)]);
  });

  it('a chat deleted for good in the app stays deleted after the next sync, though it still exists on ChatGPT', async () => {
    const c = setup();
    await signedInProfile(c);
    const all = chats(3);
    const s = server({ chats: all });
    c.web.setHttp(s.http);
    await c.api.syncAll();
    const victim = c.repo.listChats({ search: 'Chat number 2' }).items[0]!;
    c.repo.bulk([victim.id], { type: 'trash' });
    await c.api.purge([victim.id]);

    // On ChatGPT that chat still exists and was even updated since: it must NOT come back.
    all[1]!.update = new Date(Date.now() + 3_600_000).toISOString();
    all[0]!.update = new Date(Date.now() + 7_200_000).toISOString(); // another chat did change
    s.detailCalls.length = 0;
    await c.api.syncAll();
    expect(s.detailCalls).toEqual([uuid(1)]); // only the chat that was not deleted is read
    expect(c.repo.listChats({ search: 'Chat number 2' }).total).toBe(0);
    expect(c.repo.listChats({}).total).toBe(2);
  });

  it('chats read by an older importer are read again once, so they can gain what it missed (e.g. images)', async () => {
    const c = setup();
    await signedInProfile(c);
    const s = server({ chats: chats(3) });
    c.web.setHttp(s.http);
    await c.api.syncAll();
    expect(s.detailCalls).toHaveLength(3);

    // Chats stored before the current importer version (as after an app update): version 0.
    c.repo.db.prepare('UPDATE conversations SET parse_version = 0').run();
    s.detailCalls.length = 0;
    await c.api.syncAll();
    expect(s.detailCalls.sort()).toEqual([uuid(1), uuid(2), uuid(3)]); // all of them, though nothing changed remotely
    // ...and only once.
    s.detailCalls.length = 0;
    await c.api.syncAll();
    expect(s.detailCalls).toEqual([]);
  });

  it('a sync cut short by quitting the app is closed as interrupted when the app starts again', async () => {
    const repo = new Repo(openDatabase());
    const account = repo.addAccount({
      platform: 'chatgpt',
      label: 'X',
      partition: 'persist:chatgpt-x',
    });
    repo.startSyncRun(account); // never finished: the app was closed
    expect(repo.closeStaleSyncRuns()).toBe(1);
    expect(repo.closeStaleSyncRuns()).toBe(0);
    const run = repo.db.prepare('SELECT status, stats_json FROM sync_runs').get() as {
      status: string;
      stats_json: string;
    };
    expect(run.status).toBe('failed');
    expect(JSON.parse(run.stats_json).errors[0]).toMatch(/closed during the previous sync/);
  });

  it('a signed-out session stops the run, marks the profile, and says why', async () => {
    const c = setup();
    await signedInProfile(c);
    const s = server({ chats: chats(2) });
    s.failWith('/api/auth/session', { status: 401, json: undefined });
    c.web.setHttp(s.http);
    const stats = await c.api.syncAll();
    expect(stats).toMatchObject({ imported: 0, failed: 1 });
    expect(stats.errors[0]).toMatch(/401.*Sign in again/);
    expect(c.repo.sidebar().platforms[0]!.accounts[0]!.status).toBe('needs_attention');
    expect(c.repo.listChats({}).total).toBe(0);
  });

  it('one profile failing does not stop the others', async () => {
    const c = setup();
    await signedInProfile(c, 'Acme Store', 'user-AAA');
    await signedInProfile(c, 'Bluewave Studio', 'user-BBB');
    const s = server({ userId: 'user-BBB', chats: chats(2) }); // both profiles use this session: only BBB matches
    c.web.setHttp(s.http);
    const stats = await c.api.syncAll();
    expect(stats.imported).toBe(2); // Bluewave imported…
    expect(stats.failed).toBe(1); // …Acme refused (a different account is signed in there)
    expect(stats.errors.join()).toMatch(/different ChatGPT account/);
  });

  it('never syncs the synthetic demo profiles', async () => {
    const repo = new Repo(openDatabase());
    const { seedFixtures } = await import('../../core/fixtures');
    seedFixtures(repo);
    repo.setSetting('demo_data', '1');
    const web = fakeWeb();
    const s = server({ chats: chats(2) });
    web.setHttp(s.http);
    const stats = await createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      chatgptClient: { sleep: noSleep },
    }).syncAll();
    expect(stats).toEqual({ seen: 0, imported: 0, failed: 0, errors: [] });
    expect(s.calls).toEqual([]); // not one request for demo data
  });

  it('syncAccount reports a changed site per conversation and keeps going', async () => {
    const repo = new Repo(openDatabase());
    const account = repo.addAccount({
      platform: 'chatgpt',
      label: 'X',
      partition: 'persist:chatgpt-x',
    });
    const s = server({ chats: chats(3) });
    const broken: HttpJson = async (path) =>
      path.includes(uuid(2)) ? { status: 200, json: { nonsense: true } } : s.http(path);
    const stats = await syncAccount(repo, createChatGptConnector({ sleep: noSleep }), {
      accountId: account,
      http: broken,
    });
    expect(stats).toMatchObject({ seen: 3, imported: 2, failed: 1 });
    expect(stats.errors[0]).toContain('/backend-api/conversation/:id');
    expect(repo.sidebar().platforms[0]!.accounts[0]!.status).toBe('needs_attention');
  });
});

/** Bytes that really start like a PNG. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const imagePart = (file: string, prompt = 'a red bull, pixel art') => ({
  content_type: 'image_asset_pointer',
  asset_pointer: `file-service://${file}`,
  width: 1024,
  height: 1024,
  size_bytes: 1234,
  metadata: { dalle: { prompt } },
});

function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const store: MediaStore = {
    save: async (accountId, sha, ext, bytes) => {
      const path = `${accountId}/${sha.slice(0, 2)}/${sha}.${ext}`;
      files.set(path, bytes);
      return path;
    },
    remove: async (paths) => void paths.forEach((p) => files.delete(p)),
  };
  return { store, files };
}

describe('images in ChatGPT conversations', () => {
  const generatedChat = (id: number, file: string): Chat => ({
    id: uuid(id),
    title: `Image chat ${id}`,
    update: new Date(Date.UTC(2026, 8, 20, 12, 0) - id * 3_600_000).toISOString(),
    turns: [
      { role: 'user', text: 'Draw a bull' },
      { role: 'tool', content_type: 'multimodal_text', parts: [imagePart(file)] },
      { role: 'assistant', text: 'Here is your bull.' },
    ],
  });

  it('a generated image (sent by the image tool) becomes part of the assistant message, with its prompt', () => {
    const detail = conversationDetailSchema.parse(
      detailOf(uuid(1), 'T', [
        { role: 'user', text: 'Draw a bull' },
        {
          role: 'tool',
          content_type: 'multimodal_text',
          parts: ['GPT-4o returned 1 images.', imagePart('file-abc123')],
        },
        { role: 'assistant', text: 'Here you go' },
      ]),
    );
    const c = parseConversation(detail, uuid(1), () => undefined);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(c.messages[1]!.blocks).toEqual([
      { type: 'image', ref: 'file-service://file-abc123', alt: 'a red bull, pixel art' },
      { type: 'text', text: 'Here you go' },
    ]);
    expect(c.images).toEqual([
      {
        ref: 'file-service://file-abc123',
        kind: 'generated',
        alt: 'a red bull, pixel art',
        width: 1024,
        height: 1024,
      },
    ]);
    expect(JSON.stringify(c.messages)).not.toContain('returned 1 images'); // the tool's own text is plumbing
  });

  it('an image the user attached is recorded as uploaded, and the same image is listed once', () => {
    const detail = conversationDetailSchema.parse(
      detailOf(uuid(1), 'T', [
        {
          role: 'user',
          content_type: 'multimodal_text',
          parts: [imagePart('file-up1', 'x'), 'What is this?'],
        },
        {
          role: 'assistant',
          content_type: 'multimodal_text',
          parts: [imagePart('file-up1'), imagePart('file-gen1')],
        },
      ]),
    );
    const c = parseConversation(detail, uuid(1), () => undefined);
    expect(c.images!.map((img) => [img.kind, img.ref])).toEqual([
      ['uploaded', 'file-service://file-up1'],
      ['generated', 'file-service://file-gen1'],
    ]); // file-up1 appears twice in the chat but is listed once
  });

  it('sniffs real image formats and refuses everything else (pages, scripts, SVG)', () => {
    expect(sniffImage(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
    expect(sniffImage(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(new TextEncoder().encode('<!doctype html><title>Log in</title>'))).toBeNull();
    expect(
      sniffImage(
        new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
      ),
    ).toBeNull();
    expect(sniffImage(new Uint8Array([]))).toBeNull();
  });

  const setup = () => {
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const mem = memoryStore();
    const api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      media: mem.store,
      downloadImages: true,
      chatgptClient: { sleep: noSleep },
    });
    return { repo, web, api, mem };
  };
  const signIn = async (c: ReturnType<typeof setup>) => {
    c.web.signedInAs('user-AAA');
    const { attemptId } = await c.api.signInStart('chatgpt');
    await c.api.signInStatus(attemptId);
    return (await c.api.signInFinish(attemptId, { type: 'new', label: 'Acme Store' })).accountId;
  };
  const withFiles =
    (base: HttpJson, table: Record<string, string>): HttpJson =>
    async (path) => {
      const m = /^\/backend-api\/files\/download\/([^?]+)\?/.exec(path);
      if (!m) return base(path);
      const url = table[m[1]!];
      return url
        ? { status: 200, json: { status: 'success', download_url: url } }
        : { status: 404, json: undefined };
    };

  it('Sync downloads the generated images, stores them once, and shows them in the chat, the sidebar and the gallery', async () => {
    const c = setup();
    const accountId = await signIn(c);
    const s = server({
      chats: [
        generatedChat(1, 'file-aaa111'),
        generatedChat(2, 'file-bbb222'),
        { id: uuid(3), title: 'No images', update: '2026-09-01T00:00:00Z' },
      ],
    });
    c.web.setHttp(
      withFiles(s.http, {
        'file-aaa111': 'https://files.oaiusercontent.com/a',
        'file-bbb222': 'https://files.oaiusercontent.com/b',
      }),
    );
    const requested: string[] = [];
    c.web.setDownload(async (url) => {
      requested.push(url);
      return { status: 200, bytes: url.endsWith('/a') ? PNG : JPEG, mime: 'image/png' };
    });

    const stats = await c.api.syncAll();
    expect(stats.images).toEqual({ downloaded: 2, failed: 0 });
    expect(requested.sort()).toEqual([
      'https://files.oaiusercontent.com/a',
      'https://files.oaiusercontent.com/b',
    ]);
    expect(c.mem.files.size).toBe(2);
    expect(
      [...c.mem.files.keys()].every((k) => k.startsWith(`${accountId}/`) && /\.(png|jpg)$/.test(k)),
    ).toBe(true);

    // In the chat: the block knows its file.
    const chat = c.repo.getChat(c.repo.listChats({ search: 'Image chat 1' }).items[0]!.id)!;
    const image = chat.messages.flatMap((m) => m.blocks).find((b) => b.type === 'image')!;
    expect(image).toMatchObject({ type: 'image', status: 'done', alt: 'a red bull, pixel art' });
    expect((image as { mediaId: number }).mediaId).toBeGreaterThan(0);
    expect(c.repo.mediaFile((image as { mediaId: number }).mediaId)).toMatchObject({
      mime: 'image/png',
    });

    // The sidebar, the dashboard and the gallery agree.
    expect(c.repo.sidebar().platforms[0]!.accounts[0]!.images).toBe(2);
    const dash = c.repo.dashboard('chatgpt');
    expect(dash.stats.images).toBe(2);
    expect(dash.recentImages).toHaveLength(2);
    const gallery = await c.api.listImages({ accountId });
    expect(gallery.total).toBe(2);
    expect(gallery.items[0]).toMatchObject({
      chatTitle: 'Image chat 1',
      accountLabel: 'Acme Store',
      alt: 'a red bull, pixel art',
    });
    expect((await c.api.listImages({ platform: 'claude' })).total).toBe(0);

    // A second sync downloads nothing again.
    requested.length = 0;
    expect((await c.api.syncAll()).images).toEqual({ downloaded: 0, failed: 0 });
    expect(requested).toEqual([]);
  });

  it('uploaded images are not downloaded, and are shown as not available', async () => {
    const c = setup();
    await signIn(c);
    const s = server({
      chats: [
        {
          id: uuid(1),
          title: 'Photo chat',
          update: '2026-09-20T10:00:00Z',
          turns: [
            {
              role: 'user',
              content_type: 'multimodal_text',
              parts: [imagePart('file-up9', 'my photo'), 'What is in it?'],
            },
            { role: 'assistant', text: 'A cat.' },
          ],
        },
      ],
    });
    c.web.setHttp(withFiles(s.http, {}));
    let downloads = 0;
    c.web.setDownload(async () => (downloads++, { status: 200, bytes: PNG, mime: 'image/png' }));
    const stats = await c.api.syncAll();
    expect(downloads).toBe(0);
    expect(stats.images).toEqual({ downloaded: 0, failed: 0 });
    const block = c.repo
      .getChat(c.repo.listChats({}).items[0]!.id)!
      .messages[0]!.blocks.find((b) => b.type === 'image')!;
    expect(block).toMatchObject({ status: 'skipped', mediaId: null });
    expect(c.repo.listImages().total).toBe(0);
  });

  it('a page that is not an image is refused; a missing file is given up on; other errors are retried three times', async () => {
    const c = setup();
    await signIn(c);
    const s = server({
      chats: [
        generatedChat(1, 'file-html01'),
        generatedChat(2, 'file-gone02'),
        generatedChat(3, 'file-slow03'),
      ],
    });
    c.web.setHttp(
      withFiles(s.http, {
        'file-html01': 'https://files.oaiusercontent.com/h',
        'file-gone02': 'https://files.oaiusercontent.com/g',
        'file-slow03': 'https://files.oaiusercontent.com/s',
      }),
    );
    c.web.setDownload(async (url) => {
      if (url.endsWith('/h'))
        return {
          status: 200,
          bytes: new TextEncoder().encode('<html>Please log in</html>'),
          mime: 'image/png',
        };
      if (url.endsWith('/g')) return { status: 404, bytes: new Uint8Array(), mime: null };
      return { status: 500, bytes: new Uint8Array(), mime: null };
    });
    const first = await c.api.syncAll();
    expect(first.images).toEqual({ downloaded: 0, failed: 3 });
    expect(c.mem.files.size).toBe(0);
    const status = (ref: string) =>
      c.repo.db
        .prepare('SELECT status, attempts FROM media WHERE ref = ?')
        .get(`file-service://${ref}`) as { status: string; attempts: number };
    expect(status('file-gone02')).toMatchObject({ status: 'failed' }); // gone: not retried
    expect(status('file-html01')).toMatchObject({ status: 'pending', attempts: 1 }); // may work later
    await c.api.syncAll();
    await c.api.syncAll();
    expect(status('file-slow03')).toMatchObject({ status: 'failed', attempts: 3 }); // three tries, then it stops
    expect((await c.api.syncAll()).images).toEqual({ downloaded: 0, failed: 0 }); // and does not hammer the server
  });

  it('refuses a download link that is not https, and never fetches from a host the platform did not name', async () => {
    const c = setup();
    await signIn(c);
    const s = server({ chats: [generatedChat(1, 'file-plain1')] });
    c.web.setHttp(withFiles(s.http, { 'file-plain1': 'http://files.oaiusercontent.com/insecure' }));
    let called = 0;
    c.web.setDownload(async () => (called++, { status: 200, bytes: PNG, mime: 'image/png' }));
    const stats = await c.api.syncAll();
    expect(called).toBe(0);
    expect(stats.images).toEqual({ downloaded: 0, failed: 1 });
  });

  it('stops quietly when the session ends, and keeps the rest for next time', async () => {
    const c = setup();
    await signIn(c);
    const s = server({ chats: [generatedChat(1, 'file-one001'), generatedChat(2, 'file-two002')] });
    const http = withFiles(s.http, {
      'file-one001': 'https://files.oaiusercontent.com/1',
      'file-two002': 'https://files.oaiusercontent.com/2',
    });
    let denyFiles = false;
    c.web.setHttp(async (path) =>
      denyFiles && path.startsWith('/backend-api/files/')
        ? { status: 401, json: undefined }
        : http(path),
    );
    c.web.setDownload(async () => ({ status: 200, bytes: PNG, mime: 'image/png' }));
    denyFiles = true;
    const first = await c.api.syncAll();
    expect(first.imported).toBe(2); // the chats came in
    expect(first.images).toEqual({ downloaded: 0, failed: 0 }); // the images wait
    denyFiles = false;
    expect((await c.api.syncAll()).images).toEqual({ downloaded: 2, failed: 0 });
  });

  it('deleting a chat for good also deletes its image files', async () => {
    const c = setup();
    await signIn(c);
    const s = server({ chats: [generatedChat(1, 'file-del001'), generatedChat(2, 'file-keep02')] });
    c.web.setHttp(
      withFiles(s.http, {
        'file-del001': 'https://files.oaiusercontent.com/d',
        'file-keep02': 'https://files.oaiusercontent.com/k',
      }),
    );
    c.web.setDownload(async (url) => ({
      status: 200,
      bytes: url.endsWith('/d') ? PNG : JPEG,
      mime: null,
    }));
    await c.api.syncAll();
    expect(c.mem.files.size).toBe(2);
    const victim = c.repo.listChats({ search: 'Image chat 1' }).items[0]!;
    c.repo.bulk([victim.id], { type: 'trash' });
    await c.api.purge([victim.id]);
    expect(c.mem.files.size).toBe(1);
    expect(c.repo.listImages().total).toBe(1);
    expect(c.repo.sidebar().platforms[0]!.accounts[0]!.images).toBe(1);
  });
});

describe('pinned chats and folders', () => {
  it('imports pinned chats and pinned folders that the normal lists do not show', async () => {
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      chatgptClient: { sleep: async () => {} },
    });
    web.signedInAs('user-AAA');
    const { attemptId } = await api.signInStart('chatgpt');
    await api.signInStatus(attemptId);
    await api.signInFinish(attemptId, { type: 'new', label: 'Acme Store' });

    const all = server({
      chats: [
        { id: uuid(1), title: 'Plain chat', update: '2026-09-01T00:00:00Z' },
        { id: uuid(2), title: 'Pinned chat', update: '2026-09-02T00:00:00Z' },
        {
          id: uuid(3),
          title: 'In pinned folder',
          update: '2026-09-03T00:00:00Z',
          project: PROJECT,
        },
      ],
      pins: { chats: [uuid(2)], projects: [{ id: PROJECT, name: 'Pinned folder' }] },
    });
    // The main list forgets the pinned chat and the folder's chat, as the user saw.
    web.setHttp(async (path) => {
      if (path.startsWith('/backend-api/conversations?')) {
        const r = await all.http(path);
        const j = r.json as { items: { id: string }[] };
        return { ...r, json: { ...j, items: j.items.filter((i) => i.id === uuid(1)) } };
      }
      if (path.startsWith('/backend-api/gizmos/snorlax/sidebar'))
        return { status: 200, json: { items: [], cursor: null } };
      return all.http(path);
    });

    const stats = await api.syncAll();
    expect(stats.imported).toBe(3);
    const titles = repo.listChats({}).items.map((c) => c.title);
    expect(titles.sort()).toEqual(['In pinned folder', 'Pinned chat', 'Plain chat']);
    const inFolder = repo.listChats({ search: 'In pinned folder' }).items[0]!;
    expect(repo.getChat(inFolder.id)!.projectName).toBe('Pinned folder');
  });

  it('keeps importing when the pins call fails', async () => {
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      chatgptClient: { sleep: async () => {} },
    });
    web.signedInAs('user-AAA');
    const { attemptId } = await api.signInStart('chatgpt');
    await api.signInStatus(attemptId);
    await api.signInFinish(attemptId, { type: 'new', label: 'Acme Store' });
    const s = server({ chats: chats(2) });
    web.setHttp(async (path) =>
      path === '/backend-api/pins' ? { status: 200, json: { unexpected: true } } : s.http(path),
    );
    expect((await api.syncAll()).imported).toBe(2);
  });
});

describe('images shown from their own link', () => {
  const generated = (n: number, file: string): Chat => ({
    id: uuid(n),
    title: `Image chat ${n}`,
    update: '2026-09-20T10:00:00Z',
    turns: [
      { role: 'user', text: 'draw' },
      {
        role: 'assistant',
        content_type: 'multimodal_text',
        parts: [
          {
            content_type: 'image_asset_pointer',
            asset_pointer: `sediment://${file}`,
            width: 1024,
            height: 1024,
            metadata: { dalle: { prompt: 'a bull' } },
          },
        ],
      },
    ],
  });
  const boot = async (links: Record<string, string>, bytes: Uint8Array = PNG) => {
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const saved: { name: string; size: number }[] = [];
    const kept = new Map<number, Uint8Array>();
    const api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      chatgptClient: { sleep: async () => {}, paceMs: 0, jitterMs: 0 },
      saveFile: async (name, b) => (saved.push({ name, size: b.length }), true),
      thumbs: {
        get: async (id) => kept.get(id) ?? null,
        put: async (id, b) => void kept.set(id, b),
        remove: async (ids) => ids.forEach((id) => kept.delete(id)),
      },
      makeThumb: (b, side) => new Uint8Array(Math.min(b.length, side)),
    });
    web.signedInAs('user-AAA');
    const { attemptId } = await api.signInStart('chatgpt');
    await api.signInStatus(attemptId);
    await api.signInFinish(attemptId, { type: 'new', label: 'Acme Store' });
    const s = server({ chats: [generated(1, 'file_aaa111')] });
    let asks = 0;
    web.setHttp(async (path) => {
      const m = /^\/backend-api\/files\/download\/([^?]+)\?/.exec(path);
      if (!m) return s.http(path);
      asks++;
      const url = links[m[1]!];
      return url
        ? { status: 200, json: { status: 'success', download_url: url } }
        : { status: 404, json: undefined };
    });
    const fetched: string[] = [];
    web.setDownload(async (url) => (fetched.push(url), { status: 200, bytes, mime: 'image/png' }));
    const stats = await api.syncAll();
    return { repo, api, stats, saved, fetched, kept, asks: () => asks };
  };

  it('syncing downloads nothing, but the images are counted, listed and shown when looked at', async () => {
    const c = await boot({ file_aaa111: 'https://files.oaiusercontent.com/a?sig=1' });
    expect(c.fetched).toEqual([]);
    expect(c.asks()).toBe(0); // no link is asked for until an image is looked at
    expect(c.stats.images).toBeUndefined();
    expect(c.repo.listImages().total).toBe(1);
    const id = c.repo.listImages().items[0]!.id;
    const img = await c.api.imageData(id);
    expect(img?.mime).toBe('image/png');
    expect(c.fetched).toEqual(['https://files.oaiusercontent.com/a?sig=1']);
    await c.api.imageData(id);
    expect(c.asks()).toBe(1); // kept in memory for the next look, not asked for again
  });

  it('shows only images: anything else the link returns is refused', async () => {
    const c = await boot(
      { file_aaa111: 'https://files.oaiusercontent.com/a' },
      new TextEncoder().encode('<html>Please log in</html>'),
    );
    expect(await c.api.imageData(c.repo.listImages().items[0]!.id)).toBeNull();
  });

  it('says nothing is available when the platform no longer has the file', async () => {
    const c = await boot({});
    expect(await c.api.imageData(c.repo.listImages().items[0]!.id)).toBeNull();
    expect(await c.api.imageData(99999)).toBeNull();
  });

  it('previews are small, kept for next time, and removed with the chat', async () => {
    const c = await boot({ file_aaa111: 'https://files.oaiusercontent.com/a' });
    const id = c.repo.listImages().items[0]!.id;
    const first = await c.api.thumbData(id);
    expect(first?.mime).toBe('image/jpeg');
    expect(first!.bytes.length).toBeLessThan(PNG.length + 1);
    expect(c.kept.has(id)).toBe(true);
    expect(c.fetched).toHaveLength(1);
    // Later, even with nothing in memory, the kept preview is used: the platform is not asked again.
    const again = await c.api.thumbData(id);
    expect(again?.bytes).toEqual(first?.bytes);
    expect(c.fetched).toHaveLength(1);
    // Deleting the chat for good removes its preview too.
    const chatId = c.repo.listChats({}).items[0]!.id;
    c.repo.bulk([chatId], { type: 'trash' });
    await c.api.purge([chatId]);
    expect(c.kept.has(id)).toBe(false);
  });

  it('a single image can be saved on request, and nothing else is written', async () => {
    const c = await boot({ file_aaa111: 'https://files.oaiusercontent.com/a' });
    const id = c.repo.listImages().items[0]!.id;
    expect(await c.api.saveImage(id)).toBe(true);
    expect(c.saved).toEqual([{ name: `image-${id}.png`, size: PNG.length }]);
    await expect(c.api.saveImage(99999)).rejects.toThrow(/not available/);
  });
});

describe('what a sync reads, and in which order', () => {
  const boot = async (list: Chat[], projects: { id: string; name: string }[] = []) => {
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const progress: string[] = [];
    const api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      chatgptClient: { sleep: async () => {}, paceMs: 0, jitterMs: 0 },
    });
    web.signedInAs('user-AAA');
    const { attemptId } = await api.signInStart('chatgpt');
    await api.signInStatus(attemptId);
    await api.signInFinish(attemptId, { type: 'new', label: 'Acme Store' });
    const s = server({ chats: list, projects });
    web.setHttp(s.http);
    return { repo, api, s, progress };
  };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('reads the most recently changed chats first, wherever they were listed', async () => {
    const c = await boot(
      [
        { id: uuid(1), title: 'Old', update: daysAgo(30) },
        { id: uuid(2), title: 'Newest, in a folder', update: daysAgo(1), project: PROJECT },
        { id: uuid(3), title: 'Middle', update: daysAgo(10) },
      ],
      [{ id: PROJECT, name: 'Folder' }],
    );
    await c.api.syncAll();
    expect(c.s.detailCalls).toEqual([uuid(2), uuid(3), uuid(1)]);
  });

  it('does not look again at a chat that has not changed for months, even if the importer improved', async () => {
    const c = await boot([
      { id: uuid(1), title: 'Ancient', update: daysAgo(400) },
      { id: uuid(2), title: 'Recent', update: daysAgo(2) },
    ]);
    await c.api.syncAll();
    // Pretend both were read by an older importer.
    (c.repo as unknown as { db: { exec(sql: string): void } }).db.exec(
      'UPDATE conversations SET parse_version = 0',
    );
    c.s.detailCalls.length = 0;
    await c.api.syncAll();
    expect(c.s.detailCalls).toEqual([uuid(2)]); // the recent one is read again once, the ancient one is left alone
  });

  it('reports how far it is, and says when ChatGPT makes it wait', async () => {
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const asked: (SyncProgress | null)[] = [];
    const api: ReturnType<typeof createApi> = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      chatgptClient: {
        paceMs: 0,
        jitterMs: 0,
        sleep: async (ms) => {
          if (ms >= 3000) asked.push((await api.syncProgress())[0] ?? null);
        },
      },
    });
    web.signedInAs('user-AAA');
    const { attemptId } = await api.signInStart('chatgpt');
    await api.signInStatus(attemptId);
    await api.signInFinish(attemptId, { type: 'new', label: 'Acme Store' });
    const s = server({ chats: chats(3) });
    s.failWith('/backend-api/conversation/', { status: 429, json: undefined });
    web.setHttp(s.http);

    expect(await api.syncProgress()).toEqual([]); // nothing running yet
    await api.syncAll();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      label: 'Acme Store',
      phase: 'reading',
      done: 0,
      total: 3,
      waitingSeconds: 3,
    });
    expect(await api.syncProgress()).toEqual([]); // and nothing after it
  });
});

describe('quick background refresh', () => {
  const boot = async (list: Chat[], projects: { id: string; name: string }[] = []) => {
    const repo = new Repo(openDatabase());
    const web = fakeWeb();
    const api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      chatgptClient: { sleep: async () => {}, paceMs: 0, jitterMs: 0 },
    });
    web.signedInAs('user-AAA');
    const { attemptId } = await api.signInStart('chatgpt');
    await api.signInStatus(attemptId);
    await api.signInFinish(attemptId, { type: 'new', label: 'Acme Store' });
    const s = server({ chats: list, projects });
    web.setHttp(s.http);
    return { repo, api, s, list };
  };
  const projectListCalls = (calls: string[]) =>
    calls.filter((c) => /^\/backend-api\/gizmos\/g-p-[^/]+\/conversations/.test(c)).length;

  it('picks up a chat that just changed, without walking every project and without re-reading the rest', async () => {
    const c = await boot(
      [
        { id: uuid(1), title: 'Old one', update: '2026-09-01T00:00:00Z' },
        { id: uuid(2), title: 'Other', update: '2026-09-02T00:00:00Z' },
        { id: uuid(3), title: 'In a folder', update: '2026-09-03T00:00:00Z', project: PROJECT },
      ],
      [{ id: PROJECT, name: 'Folder' }],
    );
    await c.api.syncAll(); // the first, full import
    expect(c.repo.listChats({}).total).toBe(3);

    // The user writes in a chat on ChatGPT: it now has a newer update time.
    c.list[1]!.update = new Date(Date.now() + 60_000).toISOString();
    c.s.detailCalls.length = 0;
    c.s.calls.length = 0;
    const first = await c.api.syncRecent();
    expect(first.imported).toBe(1);
    expect(c.s.detailCalls).toEqual([uuid(2)]); // only that one is read
    expect(projectListCalls(c.s.calls)).toBeGreaterThan(0); // the first refresh also looks at the projects

    // The next ones are quick: no walk through the projects, and nothing is read again.
    c.s.calls.length = 0;
    c.s.detailCalls.length = 0;
    expect((await c.api.syncRecent()).imported).toBe(0);
    expect(projectListCalls(c.s.calls)).toBe(0);
    expect(c.s.detailCalls).toEqual([]);

    // A change in a chat shows up in the very next quick refresh.
    c.list[0]!.update = new Date(Date.now() + 120_000).toISOString();
    expect((await c.api.syncRecent()).imported).toBe(1);
    expect(c.s.detailCalls).toEqual([uuid(1)]);
  });

  it('is a no-op while nothing real is connected (demo data has no session)', async () => {
    const api = createApi(new Repo(openDatabase()), { openExternal: async () => {} });
    expect(await api.syncRecent()).toMatchObject({ imported: 0, failed: 0 });
  });
});
