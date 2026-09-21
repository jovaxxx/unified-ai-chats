import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  session,
  shell,
} from 'electron';
import { defaultClaudeCodeRoot } from '../connectors/claude-code';
import { createApi } from '../core/api';
import { openDatabase } from '../core/db';
import { Repo } from '../core/repo';
import { IPC_CHANNELS, type Api } from '../shared/api';
import { createFileMediaStore } from './media';
import { ElectronWebHost } from './web';

// Downloaded images are shown through this scheme, never by file path (see the handler below).
protocol.registerSchemesAsPrivileged([
  { scheme: 'uac-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// One data folder whether the app runs from the installer or from source, so upgrading (or switching) keeps everything:
// database, sessions, image previews. `UAC_USER_DATA` points it elsewhere (tests of the packaged app use it).
app.setPath(
  'userData',
  process.env.UAC_USER_DATA ?? join(app.getPath('appData'), 'unified-ai-chats'),
);
// Two copies at once would fight over the same database and sessions.
const isSelfTest = process.env.UAC_SELFTEST === '1';
const gotLock = isSelfTest || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);

function createRepo(): Repo {
  const repo = new Repo(openDatabase(join(app.getPath('userData'), 'unified-ai-chats.sqlite')));
  // A new install starts empty. Earlier versions seeded demo data: take it away if it is still there.
  repo.removeDemoData();
  repo.closeStaleSyncRuns(); // a sync cut short by quitting the app is not "running" any more
  return repo;
}

function registerIpc(api: Api, isTrustedSender: (url: string) => boolean): void {
  for (const key of Object.keys(IPC_CHANNELS) as (keyof Api)[]) {
    ipcMain.handle(IPC_CHANNELS[key], (event, ...args: unknown[]) => {
      if (!isTrustedSender(event.senderFrame?.url ?? '')) {
        throw new Error('Rejected IPC call from an untrusted frame');
      }
      // Arguments are validated with zod inside createApi.
      return (api[key] as (...a: unknown[]) => unknown)(...args);
    });
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: '#FBF9F4',
    title: 'Unified AI Chats',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links open in the user's browser, never inside the app window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

void app.whenReady().then(() => {
  if (!gotLock) return;
  const repo = createRepo();
  if (isSelfTest) {
    // `UAC_SELFTEST=1 <app>`: opens the database in the data folder, runs a search, prints the result and exits.
    // Used to check that a packaged app can really use its database.
    const found = repo.listChats({ search: 'a' });
    const version = (repo['db'].prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    console.log(
      `SELFTEST ok db=${join(app.getPath('userData'), 'unified-ai-chats.sqlite')} schema=${version} chats=${found.total}`,
    );
    app.exit(0);
    return;
  }
  const media = createFileMediaStore(join(app.getPath('userData'), 'media'));
  // Chats that stayed in the Trash past their date are removed from this app (never from the platform).
  // Small previews of images, a few KB each, kept so images are not fetched again every time. Named by media id.
  const thumbDir = join(app.getPath('userData'), 'thumbs');
  const thumbFile = (id: number) => join(thumbDir, `${Math.trunc(id)}.jpg`);
  const thumbs = {
    get: async (id: number) => {
      try {
        return new Uint8Array(await readFile(thumbFile(id)));
      } catch {
        return null;
      }
    },
    put: async (id: number, bytes: Uint8Array) => {
      await mkdir(thumbDir, { recursive: true });
      await writeFile(thumbFile(id), bytes, { mode: 0o600 });
    },
    remove: async (ids: number[]) => {
      for (const id of ids) await rm(thumbFile(id), { force: true });
    },
  };
  const expired = repo.purgeExpired();
  if (expired.removed > 0) {
    void media.remove(expired.mediaPaths);
    void thumbs.remove(expired.mediaIds);
    console.log(`Removed ${expired.removed} expired chats from the Trash.`);
  }
  // Serves an image by its database id, from memory: the app fetches it from the platform when it is looked at
  // (see imageData in core/api.ts) and never stores it. Only image types, only by id, never a path.
  type Served = { bytes: Uint8Array; mime: string } | null;
  let imageData: (id: number) => Promise<Served> = async () => null;
  let thumbData: (id: number) => Promise<Served> = async () => null;
  protocol.handle('uac-media', async (request) => {
    const url = new URL(request.url);
    const id = Number(url.pathname.replace(/^\//, ''));
    const img = !Number.isInteger(id)
      ? null
      : url.hostname === 'm'
        ? await imageData(id)
        : url.hostname === 't'
          ? await thumbData(id)
          : null;
    if (!img || !/^image\/(png|jpeg|gif|webp)$/.test(img.mime)) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(Buffer.from(img.bytes), {
      headers: {
        'Content-Type': img.mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control':
          url.hostname === 't' ? 'private, max-age=31536000' : 'private, max-age=600',
      },
    });
  });
  const web = new ElectronWebHost();
  app.on('before-quit', () => web.closeAll());
  // Full copies of chats deleted on a platform go where the user can find them (Documents), not in a hidden folder.
  const exportDir = join(app.getPath('documents'), 'Unified AI Chats', 'Exports');
  const api = createApi(repo, {
    web,
    media,
    exportDir,
    readMedia: async (relative) => {
      const abs = media.resolve(relative);
      if (!abs) return null;
      try {
        return new Uint8Array(await readFile(abs));
      } catch {
        return null;
      }
    },
    thumbs,
    makeThumb: (bytes, maxSide) => {
      const img = nativeImage.createFromBuffer(Buffer.from(bytes));
      const { width, height } = img.getSize();
      if (!width || !height) return null;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      const small = scale < 1 ? img.resize({ width: Math.round(width * scale) }) : img;
      const jpeg = small.toJPEG(80);
      return jpeg.length > 0 ? new Uint8Array(jpeg) : null;
    },
    saveFile: async (name, bytes) => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const res = await (win
        ? dialog.showSaveDialog(win, { defaultPath: name })
        : dialog.showSaveDialog({ defaultPath: name }));
      if (res.canceled || !res.filePath) return false;
      await writeFile(res.filePath, bytes);
      return true;
    },
    openPath: async (path) => {
      await shell.openPath(path);
    },
    openExternal: (url) => shell.openExternal(url),
    // UAC_CLAUDE_CODE_ROOT lets tests point at a synthetic folder; it is read here only, never
    // from the renderer.
    claudeCodeRoot: process.env.UAC_CLAUDE_CODE_ROOT ?? defaultClaudeCodeRoot(homedir()),
  });
  const isTrusted = (url: string) =>
    isDev ? url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '') : url.startsWith('file://');
  imageData = api.imageData;
  thumbData = api.thumbData;
  registerIpc(api, isTrusted);

  if (!isDev) {
    // Strict CSP in production (the dev server needs inline scripts for hot reload).
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; img-src 'self' data: uac-media:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          ],
        },
      });
    });
  }

  createWindow();
  // Incremental sync of connected local sources in the background; the window does not wait for it.
  // Carry out queued changes on platforms (rename, archive, delete): shortly after start, then every 30 seconds.
  const runQueue = () =>
    void api
      .queueRun()
      .catch((err: unknown) =>
        console.error('Queue run failed:', err instanceof Error ? err.message : err),
      );
  setTimeout(runQueue, 15_000);
  setInterval(runQueue, 30_000);
  void api.syncAll().catch((err: unknown) => {
    console.error('Background sync failed:', err instanceof Error ? err.message : err);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
