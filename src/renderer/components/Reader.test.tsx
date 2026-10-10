// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatDetail, ContentBlock } from '../../shared/types';
import '../i18n';
import { Reader } from './Reader';

afterEach(cleanup);

const chat = (blocks: ContentBlock[]): ChatDetail => ({
  id: 1,
  platform: 'gemini',
  accountId: 1,
  accountLabel: 'Personal',
  projectId: null,
  projectName: null,
  title: 'Bee clip',
  remoteTitle: 'Bee clip',
  preview: '',
  state: 'inbox',
  trashPurgeAt: null,
  tags: [],
  messageCount: 1,
  updatedAt: '2026-10-10T10:00:00.000Z',
  remoteSync: 'idle',
  summary: null,
  createdAt: '2026-10-10T10:00:00.000Z',
  remoteId: 'c_abcdef123456',
  resumeCommand: null,
  messages: [{ id: 1, role: 'assistant', blocks, createdAt: '2026-10-10T10:00:00.000Z' }],
});

const show = (c: ChatDetail) =>
  render(
    <Reader
      chat={c}
      missing={false}
      now={new Date('2026-10-10T12:00:00.000Z')}
      onOpenPlatform={() => {}}
      onRename={() => {}}
      onAction={() => {}}
      onAddTag={() => {}}
      onRemoveTag={() => {}}
      onPurge={() => {}}
    />,
  );

describe('a generated video in the reader', () => {
  it('shows its still with a play button, and only after a click loads the player from the app scheme', async () => {
    show(chat([{ type: 'video', ref: 'v#video', poster: 'p#poster', mediaId: 7, posterId: 8 }]));
    expect(document.querySelector('video')).toBeNull(); // nothing is fetched before it is asked for
    const still = [...document.querySelectorAll('img')].find((i) =>
      i.getAttribute('src')?.startsWith('uac-media:'),
    );
    expect(still?.getAttribute('src')).toBe('uac-media://t/8');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Play video' }));
    const player = document.querySelector('video');
    expect(player?.getAttribute('src')).toBe('uac-media://m/7');
    expect(player?.hasAttribute('controls')).toBe(true);
  });

  it('can be enlarged into the large view, which has its own player at its real size', async () => {
    show(chat([{ type: 'video', ref: 'v#video', poster: 'p#poster', mediaId: 7, posterId: 8 }]));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enlarge' }));
    const big = screen.getByRole('dialog', { name: 'Generated video' });
    const player = big.querySelector('video');
    expect(player?.getAttribute('src')).toBe('uac-media://m/7');
    expect(player?.className).toContain('lightbox-video');
    expect(screen.getByRole('button', { name: 'Save video…' })).toBeVisible();
  });

  it('says so when there is no file to play, and when the player fails', async () => {
    show(chat([{ type: 'video', ref: 'v#video', mediaId: null }]));
    expect(screen.getByText(/cannot be shown here/)).toBeVisible();
    expect(document.querySelector('video')).toBeNull();
    cleanup();

    show(chat([{ type: 'video', ref: 'v#video', mediaId: 7 }]));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Play video' }));
    document.querySelector('video')!.dispatchEvent(new Event('error'));
    expect(await screen.findByText(/cannot be shown here/)).toBeVisible();
  });
});
