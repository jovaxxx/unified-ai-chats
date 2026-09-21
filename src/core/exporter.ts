import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentBlock } from '../shared/types';
import type { Repo } from './repo';

export interface ExportDeps {
  /** Folder all exports go under. */
  dir: string;
  /** Reads a stored image (path relative to the media folder), so it can be copied into the export. */
  readMedia?: (relativePath: string) => Promise<Uint8Array | null>;
  now?: () => Date;
}

export interface ExportResult {
  folder: string;
  jsonPath: string;
  markdownPath: string;
  sha256: string;
  messages: number;
  images: number;
  /** The platform's own full record was included, not just what this app shows. */
  rawIncluded: boolean;
}

const slug = (text: string, max: number) =>
  text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '') || 'chat';

function markdownOf(
  title: string,
  meta: string[],
  messages: { role: string; blocks: ContentBlock[] }[],
  platformName: string,
  imageFile: (mediaId: number) => string | null,
): string {
  const out: string[] = [`# ${title}`, '', ...meta.map((m) => `- ${m}`), ''];
  for (const m of messages) {
    out.push(`## ${m.role === 'user' ? 'You' : platformName}`, '');
    for (const b of m.blocks) {
      if (b.type === 'text') out.push(b.text, '');
      else if (b.type === 'code') out.push('```' + b.lang, b.text, '```', '');
      else {
        const file = b.mediaId ? imageFile(b.mediaId) : null;
        out.push(
          file ? `![${b.alt ?? 'image'}](images/${file})` : `_[image${b.alt ? `: ${b.alt}` : ''}]_`,
          '',
        );
      }
    }
  }
  return out.join('\n');
}

/**
 * Writes a complete, VERIFIED copy of a conversation to disk: the platform's own full record (when the connector can
 * supply it), what this app shows, a Markdown version to read, and the downloaded images. This is the safety net made
 * before anything is deleted on a platform: it throws unless what was written reads back exactly as intended.
 */
export async function exportConversation(
  repo: Repo,
  conversationId: number,
  raw: unknown,
  deps: ExportDeps,
): Promise<ExportResult> {
  const chat = repo.getChat(conversationId);
  if (!chat) throw new Error('This chat no longer exists here, so it cannot be exported.');
  const account = repo.filterOptions().accounts.find((a) => a.id === chat.accountId);
  const when = (deps.now?.() ?? new Date()).toISOString();
  const folder = join(
    deps.dir,
    slug(chat.platform, 20),
    slug(account?.label ?? String(chat.accountId), 40),
    // A short code from the WHOLE id keeps two chats with the same title on the same day apart.
    `${when.slice(0, 10)}-${slug(chat.title, 50)}-${createHash('sha256').update(`${chat.platform}:${chat.remoteId}`).digest('hex').slice(0, 10)}`,
  );
  await mkdir(join(folder, 'images'), { recursive: true });

  // Images first: the JSON and the Markdown refer to the copies made here.
  const copied = new Map<number, string>();
  for (const m of chat.messages) {
    for (const b of m.blocks) {
      if (b.type !== 'image' || !b.mediaId || copied.has(b.mediaId)) continue;
      const file = repo.mediaFile(b.mediaId);
      const bytes = file ? await deps.readMedia?.(file.path) : null;
      if (!file || !bytes) continue;
      const name = `${b.mediaId}.${file.mime.split('/')[1] ?? 'bin'}`;
      await writeFile(join(folder, 'images', name), bytes, { mode: 0o600 });
      copied.set(b.mediaId, name);
    }
  }

  const rawIncluded = raw !== undefined && raw !== null;
  const messages = chat.messages.map((m) => ({
    role: m.role,
    createdAt: m.createdAt,
    blocks: m.blocks,
  }));
  const document = {
    app: 'Unified AI Chats',
    exportedAt: when,
    source: { platform: chat.platform, account: account?.label ?? null, remoteId: chat.remoteId },
    title: chat.title,
    originalTitle: chat.remoteTitle,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    project: chat.projectName,
    tags: chat.tags,
    messages,
    rawIncluded,
    raw: rawIncluded ? raw : null,
  };
  const json = JSON.stringify(document, null, 2);
  const md = markdownOf(
    chat.title,
    [
      `Platform: ${chat.platform} · ${account?.label ?? ''}`,
      `Original title: ${chat.remoteTitle}`,
      `Created: ${chat.createdAt}`,
      `Exported: ${when}`,
    ],
    messages,
    chat.platform,
    (id) => copied.get(id) ?? null,
  );

  const jsonPath = join(folder, 'conversation.json');
  const markdownPath = join(folder, 'conversation.md');
  await writeFile(jsonPath, json, { encoding: 'utf8', mode: 0o600 });
  await writeFile(markdownPath, md, { encoding: 'utf8', mode: 0o600 });

  // Verify by reading everything back, not by trusting the writes.
  const sha256 = createHash('sha256').update(json).digest('hex');
  const readBack = await readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(readBack) as { messages?: unknown[]; rawIncluded?: boolean };
  const mdSize = (await stat(markdownPath)).size;
  let imagesOk = true;
  for (const name of copied.values())
    if ((await stat(join(folder, 'images', name))).size === 0) imagesOk = false;
  if (
    createHash('sha256').update(readBack).digest('hex') !== sha256 ||
    parsed.messages?.length !== messages.length ||
    parsed.rawIncluded !== rawIncluded ||
    mdSize === 0 ||
    !imagesOk
  ) {
    throw new Error('The safety copy could not be verified, so nothing was deleted.');
  }
  return {
    folder,
    jsonPath,
    markdownPath,
    sha256,
    messages: messages.length,
    images: copied.size,
    rawIncluded,
  };
}
