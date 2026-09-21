import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { MediaStore } from '../core/images';

export interface FileMediaStore extends MediaStore {
  /** The absolute path of a stored file, or null if `relative` would point outside the media folder. */
  resolve(relative: string): string | null;
}

/**
 * Keeps downloaded images in one folder inside the app's data folder, named by their content hash
 * (`<account>/<first two hex>/<sha256>.<ext>`), so the same image is never stored twice. Files are private
 * to the user (mode 600). A path that would leave the folder is refused, wherever it comes from.
 */
export function createFileMediaStore(dir: string): FileMediaStore {
  const root = resolve(dir);
  const inside = (relative: string): string | null => {
    const abs = resolve(root, relative);
    return abs.startsWith(root + sep) ? abs : null;
  };
  return {
    resolve: inside,
    async save(accountId, sha256, ext, bytes) {
      if (!/^[0-9a-f]{64}$/.test(sha256) || !/^[a-z0-9]{2,5}$/.test(ext))
        throw new Error('Invalid image name');
      const relative = join(String(Math.trunc(accountId)), sha256.slice(0, 2), `${sha256}.${ext}`);
      const abs = inside(relative);
      if (!abs) throw new Error('Invalid image path');
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes, { mode: 0o600 });
      return relative;
    },
    async remove(paths) {
      for (const p of paths) {
        const abs = inside(p);
        if (abs) await rm(abs, { force: true });
      }
    },
  };
}
