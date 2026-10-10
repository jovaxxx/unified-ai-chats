import { describe, expect, it } from 'vitest';
import { StructureRecorder } from './recorder';
import { describeQuery, mergeShapes, normalizePath, positionalShapeOf, shapeOf } from './shape';

/** Strings that stand for things a real user would never want in a report. */
const SECRETS = [
  'My private tax return question',
  'Dear Mario, about the Rossi contract',
  'eyJhbGciOiJIUzI1NiJ9.SECRET_TOKEN_PAYLOAD.sig',
  'session-cookie-value-123',
  'mario.rossi@example.com',
  'Confidential client name Bluewave',
  '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b', // an id
  '1712345678',
];

const has = (obj: unknown, text: string) => JSON.stringify(obj).includes(text);

describe('shapeOf', () => {
  it('keeps names and types and drops every value', () => {
    const shape = shapeOf({
      title: SECRETS[0],
      user: { email: SECRETS[4], id: SECRETS[6] },
      created: '2026-09-20T10:00:00Z',
      update_time: 1712345678.5,
      count: 42,
      flag: true,
      nothing: null,
      messages: [
        { role: 'user', content_type: 'text', parts: [SECRETS[1]] },
        { role: 'assistant', content_type: 'text', parts: [SECRETS[1], 'more'] },
      ],
    });
    for (const s of SECRETS) expect(has(shape, s)).toBe(false);
    expect(shape).toMatchObject({
      title: 'string',
      user: { email: 'string', id: 'string:uuid' },
      created: 'string:iso-datetime',
      update_time: 'number:unix-seconds',
      count: 'number:int',
      flag: 'boolean',
      nothing: 'null',
    });
    // Format keys keep their (identifier-like) value, so the API can be understood.
    expect(JSON.stringify(shape)).toContain('string=user');
    expect(JSON.stringify(shape)).toContain('string=assistant');
    expect(JSON.stringify(shape)).toContain('string=text');
  });

  it('never leaks a value through an allow-listed key that does not look like a format', () => {
    for (const evil of [
      'My private tax return question',
      'Dear Mario',
      'A'.repeat(60),
      'has space',
    ]) {
      expect(has(shapeOf({ role: evil, type: evil, status: evil }), evil)).toBe(false);
    }
  });

  it('masks keys that are data (maps keyed by ids or free text)', () => {
    const shape = shapeOf({
      mapping: {
        '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b': { id: 'x', parent: null },
        '0a1b2c3d-1111-4222-8333-444455556666': { id: 'y', parent: 'z' },
        'Confidential client name Bluewave': { id: 'w' },
      },
    });
    const text = JSON.stringify(shape);
    expect(text).not.toContain('3f2a9c1e');
    expect(text).not.toContain('Bluewave');
    expect(text).toContain('<uuid>');
    expect(text).toContain('<key>');
  });

  it('summarises arrays by size bucket and merged item shape', () => {
    const shape = shapeOf({ items: [{ a: 1 }, { a: 2, b: 'x' }, { a: 3 }] }) as unknown as {
      items: { $array: string; $items: unknown };
    };
    expect(shape.items.$array).toBe('2-10');
    expect(shape.items.$items).toEqual({ a: 'number:int', 'b?': 'string' }); // b is optional
    expect((shapeOf([]) as unknown as { $items: unknown }).$items).toBe('empty');
  });

  it('is bounded on huge or deeply nested input', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50; i++) deep = { n: deep };
    expect(JSON.stringify(shapeOf(deep))).toContain('…deep');
    const wide = Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`k${i}`, i]));
    expect(JSON.stringify(shapeOf(wide))).toContain('…truncated');
  });

  it('keeps a big tree of similar nodes small and readable (no nested $oneOf pile-up)', () => {
    const kinds = ['text', 'code', 'multimodal_text', 'execution_output', 'model_editable_context'];
    const mapping: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      const id = `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`;
      mapping[id] = {
        id,
        parent: i === 0 ? null : 'x',
        children: i % 2 ? ['a'] : [],
        message:
          i % 3 === 0
            ? null
            : {
                author: { role: i % 2 ? 'user' : 'assistant' },
                content: { content_type: kinds[i % kinds.length], parts: ['secret text ' + i] },
              },
      };
    }
    const text = JSON.stringify(shapeOf({ mapping }));
    expect(text.length).toBeLessThan(2500);
    expect((text.match(/\$oneOf/g) ?? []).length).toBeLessThan(6);
    for (const k of kinds) expect(text).toContain(`string=${k}`); // every content type seen, in one place
    expect(text).not.toContain('secret text');
    expect(text).toContain('null'); // null on some nodes, an object on others: one flat alternative
  });

  it('merges different value types at the same place', () => {
    expect(mergeShapes('string', 'null')).toBe('null|string');
    expect(mergeShapes({ a: 'string' }, 'null')).toEqual({ $oneOf: [{ a: 'string' }, 'null'] });
  });
});

describe('normalizePath and describeQuery', () => {
  it('replaces ids, keeps the fixed parts of the API path', () => {
    expect(normalizePath('/backend-api/conversation/3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b')).toBe(
      '/backend-api/conversation/:uuid',
    );
    expect(
      normalizePath(
        '/backend-api/gizmos/g-p-64f8a1b2c3d4e5f60718293a4b5c-my-client-project/conversations',
      ),
    ).toBe('/backend-api/gizmos/g-p-:id/conversations');
    expect(normalizePath('/backend-api/conversations/12345/x')).toBe(
      '/backend-api/conversations/:number/x',
    );
    expect(normalizePath('/backend-api/files/caf%C3%A9')).toBe('/backend-api/files/:text');
    // Where the user is (country, locale) and short hex ids are masked; short API words are kept.
    expect(normalizePath('/backend-anon/checkout_pricing_config/configs/IT')).toBe(
      '/backend-anon/checkout_pricing_config/configs/:locale',
    );
    expect(normalizePath('/x/it-IT/y')).toBe('/x/:locale/y');
    expect(normalizePath('/cdn/330e41bb475c/z')).toBe('/cdn/:id/z');
    expect(normalizePath('/backend-api/me')).toBe('/backend-api/me');
    expect(normalizePath('/backend-api/decade/accede')).toBe('/backend-api/decade/accede');
  });

  it('shows query values only for pagination keys', () => {
    const q = describeQuery(
      new URLSearchParams(
        'offset=0&limit=28&order=updated&q=tax+return&cursor=abcDEF123&email=a@b.co',
      ),
    );
    expect(q).toEqual({
      offset: '0',
      limit: '28',
      order: 'updated',
      q: '<value>',
      cursor: '<value>',
      email: '<value>',
    });
    expect(describeQuery(new URLSearchParams('limit=My+private+tax+return+question')).limit).toBe(
      '<value>',
    );
  });
});

describe('StructureRecorder (Chrome DevTools Protocol events)', () => {
  const HOSTS = ['chatgpt.com'];
  const body = (obj: unknown) => async () => ({ body: JSON.stringify(obj), base64Encoded: false });

  async function request(
    rec: StructureRecorder,
    id: string,
    o: {
      url: string;
      method?: string;
      type?: string;
      headers?: Record<string, string>;
      postData?: string;
      extraHeaders?: Record<string, string>;
      status?: number;
      mime?: string;
      response?: unknown;
    },
  ) {
    const fetcher = body(o.response ?? {});
    await rec.onEvent(
      'Network.requestWillBeSent',
      {
        requestId: id,
        type: o.type ?? 'Fetch',
        request: {
          url: o.url,
          method: o.method ?? 'GET',
          headers: o.headers ?? {},
          ...(o.postData ? { postData: o.postData } : {}),
        },
      },
      fetcher,
    );
    if (o.extraHeaders)
      await rec.onEvent(
        'Network.requestWillBeSentExtraInfo',
        { requestId: id, headers: o.extraHeaders },
        fetcher,
      );
    await rec.onEvent(
      'Network.responseReceived',
      {
        requestId: id,
        response: { status: o.status ?? 200, mimeType: o.mime ?? 'application/json' },
      },
      fetcher,
    );
    await rec.onEvent('Network.loadingFinished', { requestId: id }, fetcher);
  }

  it('produces a report with no personal value in it, however the data arrives', async () => {
    const rec = new StructureRecorder({ allowedHosts: HOSTS });
    await request(rec, '1', {
      url: `https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&search=${encodeURIComponent(SECRETS[0]!)}`,
      headers: { 'X-Custom-Feature': SECRETS[2]!, Accept: 'application/json' },
      extraHeaders: { Authorization: `Bearer ${SECRETS[2]}`, Cookie: `sid=${SECRETS[3]}` },
      response: {
        items: [{ id: SECRETS[6], title: SECRETS[0], create_time: '2026-01-01T00:00:00Z' }],
        total: 1,
        email: SECRETS[4],
      },
    });
    await request(rec, '2', {
      url: `https://chatgpt.com/backend-api/conversation/${SECRETS[6]}`,
      method: 'POST',
      postData: JSON.stringify({
        action: 'next',
        messages: [
          { author: { role: 'user' }, content: { content_type: 'text', parts: [SECRETS[1]] } },
        ],
      }),
      response: {
        title: SECRETS[0],
        mapping: { [SECRETS[6]!]: { message: { content: { parts: [SECRETS[1], SECRETS[5]] } } } },
      },
    });

    const report = rec.report(new Date('2026-09-20T12:00:00Z'));
    for (const s of SECRETS) expect(has(report, s), `leaked: ${s}`).toBe(false);
    expect(has(report, 'Bearer')).toBe(false);
    expect(has(report, 'sid=')).toBe(false);

    const list = report.endpoints.find((e) => e.path === '/backend-api/conversations')!;
    expect(list).toMatchObject({
      method: 'GET',
      host: 'chatgpt.com',
      count: 1,
      sendsAuthorizationHeader: true,
      sendsCookie: true,
      statuses: { '200': 1 },
    });
    expect(list.query).toMatchObject({
      offset: '0',
      limit: '28',
      order: 'updated',
      search: '<value>',
    });
    expect(list.requestHeaderNames).toEqual(['accept', 'x-custom-feature']); // names only
    expect(list.responseShape).toMatchObject({ total: 'number:int', email: 'string' });
    const post = report.endpoints.find((e) => e.method === 'POST')!;
    expect(post.path).toBe('/backend-api/conversation/:uuid');
    expect(JSON.stringify(post.requestBodyShape)).toContain('string=user');
  });

  it('ignores everything that is not a fetch/XHR call to an allowed host', async () => {
    const rec = new StructureRecorder({ allowedHosts: HOSTS });
    await request(rec, 'a', { url: 'https://chatgpt.com/', type: 'Document' });
    await request(rec, 'b', { url: 'https://chatgpt.com/static/app.js', type: 'Script' });
    await request(rec, 'c', { url: 'https://tracker.example/collect', type: 'Fetch' });
    await request(rec, 'd', {
      url: 'https://chatgpt.com.evil.example/backend-api/x',
      type: 'Fetch',
    });
    await request(rec, 'e', { url: 'http://chatgpt.com/backend-api/x', type: 'Fetch' }); // not https
    await request(rec, 'f', { url: 'https://chatgpt.com/backend-api/x', method: 'OPTIONS' });
    await request(rec, 'g', {
      url: 'https://chatgpt.com/backend-api/sentinel/chat-requirements',
      method: 'POST',
    });
    expect(rec.status()).toEqual({ requests: 0, endpoints: 0 });
    await request(rec, 'ok', { url: 'https://api.chatgpt.com/x', type: 'XHR' }); // sub-domain of an allowed host
    expect(rec.status()).toEqual({ requests: 1, endpoints: 1 });
  });

  it('aggregates repeated calls and merges response shapes', async () => {
    const rec = new StructureRecorder({ allowedHosts: HOSTS });
    await request(rec, '1', {
      url: 'https://chatgpt.com/backend-api/me',
      response: { id: 'a', plan: 'x' },
    });
    await request(rec, '2', {
      url: 'https://chatgpt.com/backend-api/me',
      response: { id: 'b' },
      status: 429,
    });
    const [e] = rec.report().endpoints;
    expect(e).toMatchObject({ count: 2, statuses: { '200': 1, '429': 1 } });
    expect(e!.responseShape).toEqual({ id: 'string', 'plan?': 'string' });
  });

  it('survives bodies it cannot read and non-JSON responses', async () => {
    const rec = new StructureRecorder({ allowedHosts: HOSTS });
    await rec.onEvent(
      'Network.requestWillBeSent',
      {
        requestId: 'x',
        type: 'Fetch',
        request: { url: 'https://chatgpt.com/backend-api/a', method: 'GET', headers: {} },
      },
      async () => null,
    );
    await rec.onEvent(
      'Network.responseReceived',
      { requestId: 'x', response: { status: 200, mimeType: 'application/json' } },
      async () => null,
    );
    await rec.onEvent('Network.loadingFinished', { requestId: 'x' }, async () => {
      throw new Error('no body');
    });
    await request(rec, 'y', {
      url: 'https://chatgpt.com/backend-api/b',
      mime: 'text/event-stream',
      response: 'data: hello',
    });
    await request(rec, 'z', {
      url: 'https://chatgpt.com/backend-api/c',
      mime: 'application/json',
      response: undefined,
    });
    const r = rec.report();
    expect(r.endpoints).toHaveLength(3);
    expect(r.endpoints.find((e) => e.path === '/backend-api/b')!.responseShape).toBe(
      'non-json:text/event-stream',
    );
    expect(has(r, 'hello')).toBe(false);
  });
});

describe('positional shapes keep the kind of a link and a media type, never a value', () => {
  it('says which host, which fixed path word, which file type and which format hint', () => {
    const shape = JSON.stringify(
      positionalShapeOf([
        'https://lh3.googleusercontent.com/gg/AbCdEf1234567890xyzSECRET=s1024-rj',
        'https://contribution.usercontent.google.com/download?c=SECRETTOKEN&filename=video.mp4',
        'https://rr3---sn-abc.googlevideo.com/videoplayback/SECRET123.mp4',
        'https://evil.example/Secret_Path/a.png',
        'video/mp4',
        'image/png',
        'a plain sentence that is not a link or a type',
      ]),
    );
    expect(shape).toContain('string:url(lh3.googleusercontent.com/gg =s1024-rj)');
    expect(shape).toContain('string:url(contribution.usercontent.google.com/download)');
    expect(shape).toContain('string:url(googlevideo.com .mp4)');
    expect(shape).toContain('string:url(other-host .png)');
    expect(shape).toContain('string=video/mp4');
    expect(shape).toContain('string=image/png');
    for (const secret of ['SECRET', 'AbCdEf', 'Secret_Path', 'plain sentence', 'sn-abc', 'rr3---'])
      expect(shape).not.toContain(secret);
  });

  it('looks much deeper than before, so a nested media description is not cut off', () => {
    let deep: unknown = ['https://lh3.googleusercontent.com/gg/x=m37'];
    for (let i = 0; i < 20; i++) deep = [deep];
    expect(JSON.stringify(positionalShapeOf(deep))).toContain('=m37');
  });
});

describe('Google batchexecute calls (Gemini)', () => {
  const URL_ =
    'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&source-path=%2Fapp%2Fc_9f8e7d6c5b4a&bl=boq_x&hl=en';
  const argsText = JSON.stringify([13, null, [0, null, 1]]);
  const form =
    'f.req=' +
    encodeURIComponent(JSON.stringify([[['MaZiqc', argsText, null, 'generic']]])) +
    '&at=SECRET_CSRF_TOKEN_VALUE&';
  const payload = JSON.stringify([
    null,
    null,
    [
      ['c_9f8e7d6c5b4a', 'My private tax return question', null, [1712345678, 123456000]],
      ['c_1a2b3c4d5e6f', 'Dear Mario, about the Rossi contract', null, [1712345679, 5]],
      ['c_aaaa1111bbbb', 'Confidential client name Bluewave', null, [1712345680, 7]],
      ['c_cccc2222dddd', 'another private title', null, [1712345681, 9]],
    ],
  ]);
  const answer =
    ")]}'\n\n" +
    '300\n' +
    JSON.stringify([
      ['wrb.fr', 'MaZiqc', payload, null, null, null, 'generic'],
      ['di', 42],
    ]) +
    '\n25\n[["e",4,null,null,138]]';

  const feed = async (r: StructureRecorder) => {
    await r.onEvent(
      'Network.requestWillBeSent',
      {
        requestId: '1',
        type: 'XHR',
        request: { url: URL_, method: 'POST', headers: {}, postData: form },
      },
      async () => null,
    );
    await r.onEvent(
      'Network.responseReceived',
      { requestId: '1', response: { status: 200, mimeType: 'application/json' } },
      async () => null,
    );
    await r.onEvent('Network.loadingFinished', { requestId: '1' }, async () => ({
      body: answer,
      base64Encoded: false,
    }));
  };

  it('tells the calls apart by method id and describes arguments and answers by position, types only', async () => {
    const r = new StructureRecorder({ allowedHosts: ['gemini.google.com'] });
    await feed(r);
    const report = r.report();
    const e = report.endpoints[0]!;
    expect(e.path).toBe('/_/BardChatUi/data/batchexecute#MaZiqc');
    expect(e.query.rpcids).toBe('MaZiqc');
    expect(e.requestBodyShape).toMatchObject({
      MaZiqc: {
        $tuple: { '0': 'number:int', '1': 'null', '2': { $tuple: { '0': 'number:int' } } },
      },
    });
    const answerShape = JSON.stringify(e.responseShape);
    expect(answerShape).toContain('"$list"'); // the list of chats
    expect(answerShape).toContain('string:id(c_)'); // the chat id keeps only its format
    expect(answerShape).toContain('string:medium'); // titles keep only a size
    expect(answerShape).toContain('number:unix-seconds');
  });

  it('keeps no value from the call, the answer, the address or the form', async () => {
    const r = new StructureRecorder({ allowedHosts: ['gemini.google.com'] });
    await feed(r);
    const text = JSON.stringify(r.report());
    for (const secret of [
      'SECRET_CSRF_TOKEN_VALUE',
      'My private tax return question',
      'Dear Mario',
      'Bluewave',
      'c_9f8e7d6c5b4a',
      '1712345678',
      'boq_x',
    ])
      expect(text).not.toContain(secret);
  });

  it('a body that is not what was expected is reported as non-json, not guessed at', async () => {
    const r = new StructureRecorder({ allowedHosts: ['gemini.google.com'] });
    await r.onEvent(
      'Network.requestWillBeSent',
      {
        requestId: '2',
        type: 'XHR',
        request: { url: URL_, method: 'POST', headers: {}, postData: 'something=else' },
      },
      async () => null,
    );
    await r.onEvent(
      'Network.responseReceived',
      { requestId: '2', response: { status: 200, mimeType: 'text/plain' } },
      async () => null,
    );
    await r.onEvent('Network.loadingFinished', { requestId: '2' }, async () => ({
      body: 'not the usual format',
      base64Encoded: false,
    }));
    const e = r.report().endpoints[0]!;
    expect(e.requestBodyShape).toBe('non-json');
    expect(e.responseShape).toBe('non-json');
  });
});
