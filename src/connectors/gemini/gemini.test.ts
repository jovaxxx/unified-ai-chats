import { describe, expect, it } from 'vitest';
import { createApi } from '../../core/api';
import { openDatabase } from '../../core/db';
import { Repo } from '../../core/repo';
import { fakeWeb } from '../../core/testing';
import { EndpointChanged, NotFound, SessionExpired } from '../errors';
import type { BatchRpc } from '../types';
import { GeminiClient } from './client';
import { createGeminiConnector } from './index';
import { cleanTitle, findChats, findTurns, parseConversation, withoutPlaceholders } from './parse';
import {
  buildBatchBody,
  buildBatchUrl,
  extractPageTokens,
  isAllowedRpc,
  leftGemini,
  parseBatchPayload,
} from './rpc';

/**
 * A stand-in for Gemini, shaped like the structure report recorded on a real account (positions and types only).
 * ALL content here is invented.
 */
const noSleep = async () => {};
const id = (n: number) => `c_${String(n).padStart(12, '0')}abc`;
const pair = (sec: number): [number, number] => [sec, 123_000_000];
const T0 = 1_790_000_000; // a fixed moment in 2026

const chatRow = (n: number, title: string, sec: number) => [
  id(n),
  title,
  null,
  null,
  null,
  pair(sec),
  ...Array<null>(15).fill(null),
  `rc_${n}aaaaaaaa`,
];
const listPayload = (rows: unknown[], cursor: string | null = null) => [null, cursor, rows];

const turn = (n: number, k: number, user: string, answer: string, sec: number) => [
  [id(n), `r_${n}${k}bbbbbbbb`],
  null,
  [[user], 1, null, 1, 'abcdef123456', 1, null],
  [[[`rc_${n}${k}cccccccc`, [answer], null]], null, null, `rc_${n}${k}cccccccc`, null],
  pair(sec),
];

/** The text Gemini sends back for a call: a prefix, then rows holding the payload as JSON text. */
const answer = (rpcid: string, payload: unknown) =>
  ")]}'\n\n300\n" +
  JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic']]) +
  '\n25\n[["e",4,null,null,138]]';

interface Fake {
  chats: { n: number; title: string; sec: number; turns?: number }[];
  pageSize?: number;
}

function gemini(f: Fake) {
  const calls: { rpcid: string; args: unknown; sourcePath: string }[] = [];
  const failures: { status: number; text: string; retryAfterSeconds?: number }[] = [];
  const sorted = [...f.chats].sort((a, b) => b.sec - a.sec);
  const rpc: BatchRpc = async (call) => {
    calls.push(call);
    const fail = failures.shift();
    if (fail) return fail;
    if (call.rpcid === 'MaZiqc') {
      const [, cursor] = call.args as [number, string | null];
      const size = f.pageSize ?? 100;
      const start = cursor ? Number(cursor) : 0;
      const page = sorted.slice(start, start + size);
      const next = start + size < sorted.length ? String(start + size) : null;
      return {
        status: 200,
        text: answer(
          'MaZiqc',
          listPayload(
            page.map((c) => chatRow(c.n, c.title, c.sec)),
            next,
          ),
        ),
      };
    }
    if (call.rpcid === 'hNvQHb') {
      const wanted = (call.args as string[])[0];
      const c = f.chats.find((x) => id(x.n) === wanted);
      if (!c) return { status: 200, text: answer('hNvQHb', null) };
      const count = c.turns ?? 2;
      const turns = Array.from({ length: count }, (_, k) =>
        turn(
          c.n,
          k,
          `Question ${k} in ${c.title}`,
          `Answer ${k} in ${c.title}`,
          c.sec - (count - k),
        ),
      );
      // Newest first, nested the way the site nests them: a list of turns, plus the latest one on its own.
      return { status: 200, text: answer('hNvQHb', [[[...turns].reverse(), turns[count - 1]]]) };
    }
    return { status: 404, text: '' };
  };
  return { rpc, calls, failures };
}

describe('the pieces of a batchexecute call', () => {
  it('only the two reading calls are allowed', () => {
    expect(isAllowedRpc('MaZiqc')).toBe(true);
    expect(isAllowedRpc('hNvQHb')).toBe(true);
    for (const other of ['StreamGenerate', 'VxUbXb', 'PCck7e', 'whPPme', '', 'MaZiqc2'])
      expect(isAllowedRpc(other)).toBe(false);
  });

  it('tells a sign-in redirect from an answer that does not say where it ended up', () => {
    expect(leftGemini('https://gemini.google.com/app')).toBe(false);
    expect(leftGemini('https://accounts.google.com/v3/signin')).toBe(true);
    for (const unreadable of ['', 'not a url', '/app']) expect(leftGemini(unreadable)).toBe(false);
  });

  it('finds the tokens in the page, and says so when the form token is missing', () => {
    const page =
      '..."SNlM0e":"AB12cd34EF56-token","cfb2h":"boq_assistant_x.2026","FdrFJe":"-1234567890123"...';
    expect(extractPageTokens(page)).toEqual({
      at: 'AB12cd34EF56-token',
      bl: 'boq_assistant_x.2026',
      sid: '-1234567890123',
    });
    expect(extractPageTokens('"SNlM0e":"AB12cd34EF56-token"')).toEqual({
      at: 'AB12cd34EF56-token',
    });
    expect(extractPageTokens('<html>signed out</html>')).toBeNull();
  });

  it('builds the form and the address the way the site does', () => {
    const body = buildBatchBody('MaZiqc', [13, null, [0, null, 1]], 'tok/en=');
    const params = new URLSearchParams(body);
    expect(JSON.parse(params.get('f.req')!)).toEqual([
      [['MaZiqc', '[13,null,[0,null,1]]', null, 'generic']],
    ]);
    expect(params.get('at')).toBe('tok/en=');
    const url = new URL(
      buildBatchUrl(
        'https://gemini.google.com',
        'MaZiqc',
        '/app',
        { bl: 'b1', sid: '99' },
        'en-US',
        5,
      ),
    );
    expect(url.pathname).toBe('/_/BardChatUi/data/batchexecute');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      rpcids: 'MaZiqc',
      'source-path': '/app',
      bl: 'b1',
      'f.sid': '99',
      _reqid: '5',
    });
  });

  it('reads the payload of the answer, found, empty or missing', () => {
    expect(parseBatchPayload(answer('MaZiqc', [1, 2]), 'MaZiqc')).toEqual({
      found: true,
      payload: [1, 2],
    });
    expect(parseBatchPayload(answer('MaZiqc', [1, 2]), 'hNvQHb')).toEqual({
      found: false,
      payload: null,
    });
    expect(
      parseBatchPayload(")]}'\n\n9\n" + JSON.stringify([['wrb.fr', 'hNvQHb', null]]), 'hNvQHb'),
    ).toEqual({
      found: true,
      payload: null,
    });
    expect(parseBatchPayload('<html>not it</html>', 'MaZiqc').found).toBe(false);
  });
});

describe('finding chats and turns by what they look like', () => {
  it('finds the chat rows wherever they are, and not the id pairs', () => {
    const payload = [
      [null, null, [chatRow(1, 'One', T0), chatRow(2, 'Two', T0 + 5)]],
      [[id(1), 'r_111111111']],
    ];
    expect(findChats(payload).map((c) => [c.id, c.title])).toEqual([
      [id(1), 'One'],
      [id(2), 'Two'],
    ]);
    expect(findChats(payload)[0]!.updatedAt).toBe(new Date(T0 * 1000 + 123).toISOString());
  });

  it('finds each turn once, however it is nested, with the user and the answer text', () => {
    const t = turn(1, 0, 'What is a bumblebee?', 'A large, hairy bee.', T0);
    const found = findTurns([[[t, t], t], [[t]]]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      chatId: id(1),
      user: 'What is a bumblebee?',
      assistant: 'A large, hairy bee.',
    });
  });

  it('picks the chosen answer when there are several drafts', () => {
    const t = turn(1, 0, 'Q', 'first draft', T0);
    (t[3] as unknown[])[0] = [
      ['rc_draft1aaaa', ['first draft']],
      ['rc_chosenbbbb', ['the chosen answer']],
    ];
    (t[3] as unknown[])[3] = 'rc_chosenbbbb';
    expect(findTurns([t])[0]!.assistant).toBe('the chosen answer');
  });

  it('turns a chat into messages in time order, even when Gemini sends the newest first', () => {
    const turns = [
      turn(1, 2, 'Third', 'A3', T0 + 20),
      turn(1, 0, 'First', 'A1', T0),
      turn(1, 1, 'Second', 'A2', T0 + 10),
    ];
    const chat = parseConversation([[turns]], id(1), {
      title: 'My chat',
      updatedAt: '2026-09-30T10:00:00.000Z',
    });
    expect(chat.remoteTitle).toBe('My chat');
    expect(chat.updatedAt).toBe('2026-09-30T10:00:00.000Z');
    expect(
      chat.messages.map(
        (m) => `${m.role}:${m.blocks[0]!.type === 'text' ? m.blocks[0]!.text : ''}`,
      ),
    ).toEqual([
      'user:First',
      'assistant:A1',
      'user:Second',
      'assistant:A2',
      'user:Third',
      'assistant:A3',
    ]);
    expect(chat.skipped).toBeUndefined();
  });

  it('says so when a page of turns may not be the whole chat, and when nothing is readable', () => {
    const ten = Array.from({ length: 10 }, (_, k) => turn(1, k, `Q${k}`, `A${k}`, T0 + k));
    expect(parseConversation([[ten]], id(1)).skipped).toEqual({ 'turns:maybe-more': 1 });
    expect(() => parseConversation([[['nothing', 'here']]], id(1))).toThrow(EndpointChanged);
  });
});

describe('long titles and pictures', () => {
  it('shortens a title to one line that fits, and keeps a short one as it is', () => {
    expect(cleanTitle('A short title')).toBe('A short title');
    expect(cleanTitle('\n  First   line \n second line')).toBe('First line');
    const long = `${'word '.repeat(300)}end`;
    const cut = cleanTitle(long);
    expect(cut.length).toBeLessThanOrEqual(101);
    expect(cut.endsWith('…')).toBe(true);
    expect(cleanTitle('x'.repeat(1181)).length).toBeLessThanOrEqual(101); // no spaces at all
    expect(cleanTitle('   ')).toBe('');
  });

  it('the chat list never carries a long title', () => {
    const rows = [chatRow(1, `${'long '.repeat(200)}`, T0)];
    expect(findChats([null, null, rows])[0]!.title.length).toBeLessThanOrEqual(101);
  });

  it('takes out the made-up picture links and keeps what is real', () => {
    const out = withoutPlaceholders(
      'Here you go!\n\nhttp://googleusercontent.com/image_generation_content/0\n\n[Pic](http://googleusercontent.com/image_generation_content/1)\n\nhttp://googleusercontent.com/generated_video_content/0',
    );
    expect(out.images).toBe(2);
    expect(out.videos).toBe(1);
    expect(out.text).not.toContain('googleusercontent');
    expect(out.text).toContain('Here you go!');
    expect(out.text).toContain('open this chat on Gemini');
  });

  const withImages = (links: string[]) => {
    const t = turn(
      1,
      0,
      'Draw a bee',
      'Here it is!\n\nhttp://googleusercontent.com/image_generation_content/0',
      T0,
    );
    // The description of one picture: its link at position 3. A second size sits next to it in the same list.
    const description = (url: string) => [
      null,
      1,
      'bee.png',
      url,
      null,
      'prompt-ish text',
      null,
      null,
      1,
    ];
    (t[3] as unknown[])[0] = [
      [
        'rc_aaaaaaaa',
        ['Here it is!\n\nhttp://googleusercontent.com/image_generation_content/0'],
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          links.map((u) => [
            [[[null, null, null, description(u), null, null, description(`${u}=s64`)]]],
          ]),
        ],
      ],
    ];
    return t;
  };

  it("shows a picture as an image block, takes its link from Gemini's own image host, and drops the dead link", () => {
    const url = 'https://lh3.googleusercontent.com/gg/AbCdEf123456';
    const chat = parseConversation([[[withImages([url])]]], id(1));
    const reply = chat.messages.find((m) => m.role === 'assistant')!;
    expect(reply.blocks).toEqual([
      { type: 'text', text: 'Here it is!' },
      { type: 'image', ref: url },
    ]);
    expect(chat.images).toEqual([{ ref: url, kind: 'generated' }]); // only the first size
    expect(chat.skipped).toBeUndefined();
  });

  it("never takes a link that is not on Gemini's image host", () => {
    const chat = parseConversation(
      [[[withImages(['https://evil.example/x.png', 'http://lh3.googleusercontent.com/x'])]]],
      id(1),
    );
    expect(chat.images).toBeUndefined();
    expect(chat.skipped).toEqual({ 'images:link-not-found': 1 }); // said, not hidden
  });
});

describe('the Gemini client', () => {
  const client = (g: ReturnType<typeof gemini>) => new GeminiClient(g.rpc, { sleep: noSleep });
  const all = async (c: GeminiClient) => {
    const out: string[] = [];
    for await (const chat of c.chats()) out.push(chat.id);
    return out;
  };

  it('reads every page of the list, and only calls what it may', async () => {
    const g = gemini({
      chats: Array.from({ length: 7 }, (_, i) => ({
        n: i + 1,
        title: `Chat ${i + 1}`,
        sec: T0 + i,
      })),
      pageSize: 3,
    });
    const ids = await all(client(g));
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(g.calls).toHaveLength(3); // 3 + 3 + 1
    expect(g.calls.every((c) => c.rpcid === 'MaZiqc' && c.sourcePath === '/app')).toBe(true);
    expect(g.calls[0]!.args).toEqual([13, null, [0, null, 1]]);
    expect((g.calls[1]!.args as unknown[])[1]).toBe('3'); // the token from the answer is what asks for the next page
  });

  it('stops at the first chat that has not changed since the last sync', async () => {
    const g = gemini({
      chats: Array.from({ length: 30 }, (_, i) => ({
        n: i + 1,
        title: `Chat ${i + 1}`,
        sec: T0 + i,
      })),
      pageSize: 10,
    });
    const out: string[] = [];
    for await (const c of client(g).chats(
      (x) => x.updatedAt < new Date((T0 + 25) * 1000).toISOString(),
    ))
      out.push(c.id);
    expect(out).toHaveLength(5);
    expect(g.calls).toHaveLength(1); // did not page further
  });

  it('reads one chat from the page it belongs to', async () => {
    const g = gemini({ chats: [{ n: 4, title: 'Four', sec: T0 }] });
    await client(g).chat(id(4));
    expect(g.calls[0]).toMatchObject({
      rpcid: 'hNvQHb',
      sourcePath: `/app/${id(4).slice(2)}`,
    });
    expect((g.calls[0]!.args as unknown[]).slice(0, 2)).toEqual([id(4), 10]);
  });

  it('a chat Gemini does not have is NotFound; a strange id is never sent', async () => {
    const g = gemini({ chats: [] });
    await expect(client(g).chat(id(9))).rejects.toThrow(NotFound);
    for (const bad of ['', 'abc', '../me', 'c_x'])
      await expect(client(g).chat(bad)).rejects.toThrow();
    expect(g.calls).toHaveLength(1); // only the one real ask
  });

  it('signed out is SessionExpired; a busy site is retried; anything else is EndpointChanged', async () => {
    const g = gemini({ chats: [{ n: 1, title: 'One', sec: T0 }] });
    g.failures.push({ status: 401, text: '' });
    await expect(all(client(g))).rejects.toThrow(SessionExpired);

    const busy = gemini({ chats: [{ n: 1, title: 'One', sec: T0 }] });
    busy.failures.push({ status: 429, text: '', retryAfterSeconds: 1 });
    expect(await all(client(busy))).toHaveLength(1);
    expect(busy.calls).toHaveLength(2);

    const odd = gemini({ chats: [] });
    odd.failures.push({ status: 200, text: '<html>not what was expected</html>' });
    await expect(all(client(odd))).rejects.toThrow(EndpointChanged);
    const gone = gemini({ chats: [] });
    gone.failures.push({ status: 405, text: '' });
    await expect(all(client(gone))).rejects.toThrow(EndpointChanged);
  });
});

describe('Gemini in the local inbox', () => {
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
  const profile = async (c: ReturnType<typeof setup>) => {
    c.web.signedInAs(null);
    c.web.onlyAfterUserSaysSo();
    const { attemptId } = await c.api.signInStart('gemini');
    await c.api.signInStatus(attemptId, true);
    return (await c.api.signInFinish(attemptId, { type: 'new', label: 'Personal' })).accountId;
  };

  it('is read-only: the connector can change nothing', () => {
    const c = createGeminiConnector();
    expect(c.capabilities).toEqual({
      projects: false,
      archive: false,
      rename: false,
      delete: false,
      images: false,
    });
    expect(c.rename).toBeUndefined();
    expect(c.archive).toBeUndefined();
    expect(c.delete).toBeUndefined();
  });

  it('Sync now brings the chats in, readable and searchable, and the next one only what changed', async () => {
    const c = setup();
    const accountId = await profile(c);
    const g = gemini({
      chats: [
        { n: 1, title: 'Bumblebee facts', sec: T0 },
        { n: 2, title: 'Sourdough starter', sec: T0 + 100 },
      ],
    });
    c.web.setRpc(g.rpc);

    const first = await c.api.syncProfiles([accountId]);
    expect(first).toMatchObject({ seen: 2, imported: 2, failed: 0 });
    const list = c.repo.listChats({ accountId });
    expect(list.items.map((x) => x.title).sort()).toEqual(['Bumblebee facts', 'Sourdough starter']);
    const chat = c.repo.getChat(list.items.find((x) => x.title === 'Bumblebee facts')!.id)!;
    expect(chat.platform).toBe('gemini');
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    g.calls.length = 0;
    const second = await c.api.syncProfiles([accountId]);
    expect(second.imported).toBe(0); // nothing changed: the list is read, no chat is read again
    expect(g.calls.every((x) => x.rpcid === 'MaZiqc')).toBe(true);
  });

  it("a generated picture is shown from its link after a sync, with the profile's session", async () => {
    const c = setup();
    const accountId = await profile(c);
    const url = 'https://lh3.googleusercontent.com/gg/AbCdEf123456';
    const g = gemini({ chats: [{ n: 1, title: 'Bee picture', sec: T0, turns: 1 }] });
    const plain = g.rpc;
    // The one turn of this chat carries a picture and the dead link to it.
    c.web.setRpc(async (call) => {
      const res = await plain(call);
      if (call.rpcid !== 'hNvQHb') return res;
      const placeholder = 'Here it is!\n\nhttp://googleusercontent.com/image_generation_content/0';
      const withPicture = turn(1, 0, 'Draw a bee', placeholder, T0);
      (withPicture[3] as unknown[][])[0]![0] = [
        'rc_aaaaaaaa',
        [placeholder],
        ...Array<null>(10).fill(null),
        [null, null, null, null, null, null, null, [[[[null, null, null, [null, 1, 'bee', url]]]]]],
      ];
      return { status: 200, text: answer('hNvQHb', [[[withPicture]]]) };
    });
    const asked: string[] = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    c.web.setDownload(async (u) => {
      asked.push(u);
      return { status: 200, bytes: png, mime: 'image/png' };
    });

    await c.api.syncProfiles([accountId]);
    const chatId = c.repo.listChats({ accountId }).items[0]!.id;
    const reply = c.repo.getChat(chatId)!.messages.find((m) => m.role === 'assistant')!;
    const image = reply.blocks.find((b) => b.type === 'image');
    expect(image).toMatchObject({ type: 'image', ref: url });
    const mediaId = (image as { mediaId?: number | null }).mediaId!;
    expect(mediaId).toBeTruthy();
    const shown = await c.api.imageData(mediaId);
    expect(shown?.mime).toBe('image/png');
    expect(asked).toEqual([url]);
    expect(JSON.stringify(reply.blocks)).not.toContain('image_generation_content');
  });

  it("downloads a picture only from Gemini's image host", async () => {
    const c = createGeminiConnector();
    const asked: string[] = [];
    const ctx = {
      accountId: 1,
      downloadUrl: async (u: string) => {
        asked.push(u);
        return { status: 200, bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' };
      },
    };
    const ok = await c.downloadImage!(
      ctx,
      { ref: 'https://lh3.googleusercontent.com/gg/abc' },
      id(1),
    );
    expect(ok.mime).toBe('image/png');
    for (const bad of [
      'https://evil.example/a.png',
      'http://lh3.googleusercontent.com/a',
      'file:///etc/passwd',
      '',
    ])
      await expect(c.downloadImage!(ctx, { ref: bad }, id(1))).rejects.toThrow(NotFound);
    expect(asked).toEqual(['https://lh3.googleusercontent.com/gg/abc']);
    const gone = {
      ...ctx,
      downloadUrl: async () => ({ status: 404, bytes: new Uint8Array(), mime: null }),
    };
    await expect(
      c.downloadImage!(gone, { ref: 'https://lh3.googleusercontent.com/gg/abc' }, id(1)),
    ).rejects.toThrow(NotFound);
  });

  it('the "Open on Gemini" address drops the c_ of the id', async () => {
    const { platformUrl } = await import('../../core/platforms');
    expect(platformUrl('gemini', id(1))).toBe(`https://gemini.google.com/app/${id(1).slice(2)}`);
  });
});
