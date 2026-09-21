// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanDirectives, stripMarkdown } from '../../shared/text';
import { Markdown } from './Markdown';

afterEach(cleanup);

const SAMPLE = `## Plan

Use **bold**, *italic* and \`inline code\`.

- first item
- second item

1. one
2. two

> a quote

| Name | Value |
| --- | --- |
| a | 1 |

\`\`\`ts
const x = 1;
\`\`\`

See [the docs](https://example.com/docs) and [local](./file.md).`;

describe('Markdown reader', () => {
  it('renders structure instead of showing the markup characters', () => {
    const { container } = render(<Markdown text={SAMPLE} onOpenLink={() => {}} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Plan' })).toBeVisible();
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'first item',
      'second item',
      'one',
      'two',
    ]);
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    expect(container.querySelector('pre.code code')).toHaveTextContent('const x = 1;');
    // None of the syntax characters leak into the visible text.
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\*\*|##|```|\]\(|\| ---/);
  });

  it('opens http(s) links through the app, never inside the window', async () => {
    const open = vi.fn();
    render(<Markdown text={SAMPLE} onOpenLink={open} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'the docs' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
    await user.click(screen.getByRole('link', { name: 'local' })); // relative: nothing to open
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('is safe with hostile content', async () => {
    const open = vi.fn();
    const evil = `<script>window.__pwned = 1</script>

<img src=x onerror="window.__pwned = 2">

<a href="javascript:window.__pwned = 3">click</a>

[js](javascript:window.__pwned=4)

![remote](https://tracker.example/pixel.png)`;
    const { container } = render(<Markdown text={evil} onOpenLink={open} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull(); // nothing is ever fetched
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.textContent).toContain('[image: remote]');
    for (const a of container.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
    const links = within(container).queryAllByRole('link');
    const user = userEvent.setup();
    for (const l of links) await user.click(l);
    expect(open).not.toHaveBeenCalled();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('stripMarkdown (list previews)', () => {
  it('turns markdown into one readable line', () => {
    expect(stripMarkdown('## Title\n\n**Bold** and *italic* with `code`.')).toBe(
      'Title Bold and italic with code.',
    );
    expect(stripMarkdown('- one\n- two\n\n> quote')).toBe('one two quote');
    expect(stripMarkdown('See [the docs](https://x.example/a_b) now ![pic](https://x/y.png)')).toBe(
      'See the docs now pic',
    );
    expect(stripMarkdown('```ts\nconst a = 1;\n```')).toBe('ts const a = 1;'.replace('ts ', ''));
  });

  it('cleans headings that were already flattened onto one line', () => {
    expect(stripMarkdown('Fixing ### Steps 1. Open')).toBe('Fixing Steps 1. Open');
    expect(stripMarkdown('I like C# and #1 picks')).toBe('I like C# and #1 picks');
  });

  it('keeps snake_case and multiplication intact', () => {
    expect(stripMarkdown('use my_var_name and 2 * 3 * 4')).toBe('use my_var_name and 2 * 3 * 4');
  });
});

describe('ChatGPT directive markers', () => {
  const draft = [
    'Here is a message you can send:',
    '',
    ':::writing{variant="chat_message" id="58314" title="Message"}',
    'Hi Sam, thanks for the quick reply!',
    ':::',
    '',
    'Anything else?',
  ].join('\n');

  it('removes the opening and closing markers and keeps what is inside', () => {
    const clean = cleanDirectives(draft);
    expect(clean).not.toMatch(/:::|writing|58314/);
    expect(clean).toContain('Hi Sam, thanks for the quick reply!');
    expect(clean).toContain('Here is a message you can send:');
    expect(clean).toContain('Anything else?');
  });

  it('keeps an email subject as a bold first line, and handles several blocks and contextList', () => {
    const text =
      ':::writing{variant="email" id="1" subject="Order update"}\nDear Ana,\n:::\n\n:::contextList\n- source a\n:::\n';
    const clean = cleanDirectives(text);
    expect(clean).toContain('**Order update**');
    expect(clean).toContain('Dear Ana,');
    expect(clean).toContain('- source a');
    expect(clean).not.toMatch(/:::/);
  });

  it('leaves ordinary text and code blocks alone', () => {
    const plain = 'Ratio a:b and a line with ::: in the middle.';
    expect(cleanDirectives(plain)).toBe(plain);
    const code = '```\n:::writing{x="1"}\n:::\n```';
    expect(cleanDirectives(code)).toBe(code);
  });

  it('shows no marker in the rendered message or in the list preview', () => {
    render(<Markdown text={draft} onOpenLink={() => {}} />);
    expect(screen.getByText(/Hi Sam, thanks for the quick reply!/)).toBeVisible();
    expect(screen.queryByText(/:::/)).toBeNull();
    expect(screen.queryByText(/writing\{/)).toBeNull();
    expect(stripMarkdown(draft)).not.toMatch(/:::|writing/);
  });
});
