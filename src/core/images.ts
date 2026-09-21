import { createHash } from 'node:crypto';
import { NotFound, RateLimited, SessionExpired } from '../connectors/errors';
import type { AccountContext, Connector } from '../connectors/types';
import type { Repo } from './repo';

/** Where image files live. The app supplies the real one (a folder); tests use memory. */
export interface MediaStore {
  /** Saves the bytes and returns the path RELATIVE to the media folder. */
  save(accountId: number, sha256: string, ext: string, bytes: Uint8Array): Promise<string>;
  /** Deletes files by relative path. Missing files are ignored. */
  remove(paths: string[]): Promise<void>;
}

const KNOWN: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/gif',
    ext: 'gif',
    test: (b) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) =>
      b.length > 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

/**
 * What kind of image these bytes are, from their first bytes, NOT from what the server claims. A login page or an
 * error page saved as "image.png" is refused here. SVG is refused too: it can carry scripts.
 */
export function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  const hit = KNOWN.find((k) => k.test(bytes));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

export interface ImageSyncResult {
  downloaded: number;
  failed: number;
  errors: string[];
}

/**
 * Downloads the images still pending for a profile, newest chats first, one at a time (the connector paces its own
 * requests). A file that is gone is marked failed for good; other errors are retried on a later sync, up to 3 times.
 * If the session ends or the site asks to slow down, it stops quietly and the rest waits for the next sync.
 */
export async function downloadPendingImages(
  repo: Repo,
  connector: Connector,
  ctx: AccountContext,
  store: MediaStore,
  opts: { limit?: number } = {},
): Promise<ImageSyncResult> {
  const result: ImageSyncResult = { downloaded: 0, failed: 0, errors: [] };
  if (!connector.downloadImage) return result;
  for (const image of repo.pendingImages(ctx.accountId, opts.limit ?? 500)) {
    try {
      const got = await connector.downloadImage(
        ctx,
        { ref: image.ref },
        image.conversationRemoteId,
      );
      if (got.bytes.length === 0 || got.bytes.length > MAX_IMAGE_BYTES)
        throw new Error('The image file has an unexpected size.');
      const kind = sniffImage(got.bytes);
      if (!kind) throw new Error('The downloaded file is not an image this app can show.');
      const sha256 = createHash('sha256').update(got.bytes).digest('hex');
      const path = await store.save(ctx.accountId, sha256, kind.ext, got.bytes);
      repo.markImageDone(image.id, { path, sha256, mime: kind.mime, bytes: got.bytes.length });
      result.downloaded++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof SessionExpired || err instanceof RateLimited) {
        result.errors.push(reason);
        return result; // the rest waits for the next sync
      }
      repo.markImageFailed(image.id, reason, err instanceof NotFound);
      result.failed++;
      if (result.errors.length < 3) result.errors.push(reason);
    }
  }
  return result;
}
