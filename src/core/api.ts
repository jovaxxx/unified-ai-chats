import { z } from 'zod';
import { createChatGptConnector } from '../connectors/chatgpt';
import { createClaudeConnector } from '../connectors/claude';
import type { ClientOptions } from '../connectors/chatgpt/client';
import { claudeCodeConnector } from '../connectors/claude-code';
import type { AccountContext, Connector, DownloadUrl, HttpJson } from '../connectors/types';
import type { Api } from '../shared/api';
import {
  accountLabelSchema,
  bulkActionSchema,
  dashboardQuerySchema,
  imageQuerySchema,
  listQuerySchema,
  PLATFORMS,
  signInChoiceSchema,
  WEB_PLATFORMS,
  type Platform,
  type RecorderSaved,
  type RecorderStatus,
  type SignInStatus,
  type SyncProgress,
  type SyncStats,
} from '../shared/types';
import { ActionQueue, ActionRunner, type RunnerDeps } from './actions';
import { downloadPendingImages, sniffImage, type MediaStore } from './images';
import { platformUrl } from './platforms';
import type { Repo } from './repo';
import { syncAccount } from './sync';

const idSchema = z.number().int().positive();
const idsSchema = z.array(idSchema).min(1).max(100_000);

/** Partition/identity of the single local Claude Code source ("This Mac"). Not a browser session. */
export const CLAUDE_CODE_PARTITION = 'local:claude-code';

/** The web profile a window or recording belongs to. Always read from the database, never from the renderer. */
export interface WebTarget {
  accountId: number;
  platform: Platform;
  partition: string;
}

/** What the sign-in window says about the user, learned from the platform's own pages. */
export type SignInProbe =
  | { state: 'waiting' }
  | { state: 'closed' }
  | {
      state: 'signed-in';
      /** The platform's own id for the account. Null when the platform did not say. */
      identity: string | null;
      displayName: string | null;
    };

/** Electron-side capabilities for web platforms (sign-in windows, structure recorder). */
export interface WebHost {
  /** Reopens the sign-in window of an existing profile. */
  openLogin(target: WebTarget): Promise<void>;
  /** Opens the platform's sign-in page in a brand-new isolated session. */
  startSignIn(platform: Platform): Promise<{ attemptId: string; partition: string }>;
  probeSignIn(attemptId: string, assumeSignedIn: boolean): Promise<SignInProbe>;
  /** Closes the attempt's window. Without `keepSession` its session is wiped too. */
  endSignIn(attemptId: string, keepSession: boolean): Promise<void>;
  /** Closes a profile's sign-in window, if it is open. */
  closeLogin(accountId: number): Promise<void>;
  /** Downloads a file (e.g. an image) from a link the platform handed out, as this session. Only known hosts. */
  downloadFor(partition: string): DownloadUrl;
  /** Requests made as this session's signed-in user. The access token never leaves the host. */
  httpFor(partition: string): HttpJson;
  /** Deletes everything a browser session stored (cookies, storage, cache). */
  wipePartition(partition: string): Promise<void>;
  recorderStart(target: WebTarget): Promise<void>;
  recorderStatus(): RecorderStatus;
  recorderStop(): Promise<RecorderSaved | null>;
  revealReport(): Promise<void>;
}

export interface ApiDeps {
  /** Where full copies of chats are saved before they are deleted on a platform. */
  exportDir?: string;
  /** Reads a stored image, so it can be copied into a safety copy. */
  readMedia?: (relativePath: string) => Promise<Uint8Array | null>;
  /** Opens a folder in the file manager. */
  openPath?: (path: string) => Promise<void>;
  /** Connectors that can change things on a platform. Defaults to the built-in ones; tests supply fakes. */
  connectors?: Partial<Record<Platform, Connector>>;
  /** Pacing and automatic running of the action queue. Tests turn both off. */
  actions?: {
    autoRun?: boolean;
    paceMs?: number;
    jitterMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  /** Deletes image files from disk after their chats were purged. Injected: only the app has the media folder. */
  removeFiles?: (paths: string[]) => Promise<void>;
  /** Where downloaded images are kept. Without it, images are recorded but not downloaded. */
  media?: MediaStore;
  web?: WebHost;
  /** Small previews kept on disk so an image is not fetched again every time. Removed with the chat. */
  thumbs?: {
    get(id: number): Promise<Uint8Array | null>;
    put(id: number, bytes: Uint8Array): Promise<void>;
    remove(ids: number[]): Promise<void>;
  };
  /** Electron: shrinks an image to a JPEG preview whose longest side is `maxSide`. Null if it cannot. */
  makeThumb?: (bytes: Uint8Array, maxSide: number) => Uint8Array | null;
  /** Electron: asks where to save a file and writes it. Returns false if the user cancelled. */
  saveFile?: (suggestedName: string, bytes: Uint8Array) => Promise<boolean>;
  /** Also save every generated image on this Mac while syncing. Off by default: images are shown from their own link. */
  downloadImages?: boolean;
  /** Pacing of requests to ChatGPT. Defaults to polite pauses; tests turn them off. */
  chatgptClient?: ClientOptions;
  /** Electron: shell.openExternal. Tests: a recorder. */
  openExternal: (url: string) => Promise<void>;
  /** Folder Claude Code keeps its sessions in (~/.claude/projects). Never taken from the renderer. */
  claudeCodeRoot?: string;
}

/**
 * Implements the renderer-facing API on top of the repository. Every argument is validated here,
 * because in the app it arrives over IPC from a sandboxed renderer and must not be trusted.
 */
export function createApi(
  repo: Repo,
  deps: ApiDeps,
): Api & {
  imageData: (id: number) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  thumbData: (id: number) => Promise<{ bytes: Uint8Array; mime: string } | null>;
} {
  // Every profile syncs on its own: its own lock, its own progress, its own waiting. One profile being slow or
  // rate limited never holds another one back.
  const progress = new Map<number, SyncProgress>();
  const waiting = new Map<number, number>();
  const claudeConnector = createClaudeConnector(deps.chatgptClient);
  const chatgptConnector = createChatGptConnector(deps.chatgptClient);
  const running = new Map<number, Promise<SyncStats>>();
  let recentRuns = 0;
  /** Runs one profile's sync; asking again while it runs gives the same run instead of starting a second. */
  const exclusive = (accountId: number, job: () => Promise<SyncStats>): Promise<SyncStats> => {
    const now = running.get(accountId);
    if (now) return now;
    const p = job().finally(() => {
      running.delete(accountId);
      progress.delete(accountId);
      waiting.delete(accountId);
    });
    running.set(accountId, p);
    return p;
  };

  const syncClaudeCode = async (accountId: number): Promise<SyncStats> => {
    if (!deps.claudeCodeRoot) throw new Error('Claude Code sessions folder is not configured');
    return syncAccount(repo, claudeCodeConnector, { accountId, root: deps.claudeCodeRoot });
  };

  const syncWeb = async (
    accountId: number,
    opts: { includeProjects?: boolean } = {},
  ): Promise<SyncStats> => {
    const acc = repo.getAccount(accountId);
    if (!acc || (acc.platform !== 'chatgpt' && acc.platform !== 'claude'))
      throw new Error('This profile is not a web profile.');
    const connector = acc.platform === 'claude' ? claudeConnector : chatgptConnector;
    if (!deps.web) throw new Error('Signing in is not available here.');
    const ctx = {
      accountId,
      http: deps.web.httpFor(acc.partition),
      downloadUrl: deps.web.downloadFor(acc.partition),
      expectedIdentity: acc.identity,
      ...(opts.includeProjects === false ? { includeProjects: false } : {}),
      onWait: (ms: number) => {
        if (ms > 0) waiting.set(accountId, Math.round(ms / 1000));
        else waiting.delete(accountId);
        deps.chatgptClient?.onWait?.(ms);
      },
    };
    const label = repo.filterOptions().accounts.find((a) => a.id === accountId)?.label ?? '';
    const stats = await syncAccount(repo, connector, ctx, (p) => {
      progress.set(accountId, { accountId, label, ...p, waitingSeconds: null });
    });
    // Then the images of those chats. A problem here never fails the sync: what is left waits for the next one.
    if (deps.media && deps.downloadImages && acc.platform === 'chatgpt') {
      try {
        const img = await downloadPendingImages(repo, chatgptConnector, ctx, deps.media);
        stats.images = { downloaded: img.downloaded, failed: img.failed };
      } catch {
        /* leave the images pending */
      }
    }
    return stats;
  };

  /** Every profile that can be synced now. Demo profiles have no session, so they are left out. */
  const syncableIds = (): number[] => [
    ...repo.accountsOf('claude-code').map((a) => a.id),
    ...(deps.web
      ? [...repo.profilesOf('chatgpt'), ...repo.profilesOf('claude')].map((a) => a.id)
      : []),
  ];

  /** Syncs the given profiles at the same time, each on its own; one failing never stops the others. */
  const syncMany = async (
    ids: number[],
    opts: { includeProjects?: boolean } = {},
  ): Promise<SyncStats> => {
    const total: SyncStats = { seen: 0, imported: 0, failed: 0, errors: [] };
    const add = (s: SyncStats) => {
      total.seen += s.seen;
      total.imported += s.imported;
      total.failed += s.failed;
      total.errors.push(...s.errors);
      if (s.images) {
        total.images = {
          downloaded: (total.images?.downloaded ?? 0) + s.images.downloaded,
          failed: (total.images?.failed ?? 0) + s.images.failed,
        };
      }
      for (const [k, n] of Object.entries(s.listing ?? {})) {
        total.listing = { ...total.listing, [k]: (total.listing?.[k] ?? 0) + n };
      }
      for (const [k, n] of Object.entries(s.skipped ?? {})) {
        total.skipped = { ...total.skipped, [k]: (total.skipped?.[k] ?? 0) + n };
      }
    };
    const results = await Promise.allSettled(
      [...new Set(ids)].map((id) =>
        exclusive(id, async () => {
          const acc = repo.getAccount(id);
          if (!acc) throw new Error('This profile does not exist.');
          return acc.platform === 'claude-code' ? syncClaudeCode(id) : syncWeb(id, opts);
        }),
      ),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') add(r.value);
      else {
        total.failed++;
        total.errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }
    return total;
  };

  // ---- images shown from the platform's own link (nothing is saved to disk) ----
  // The app asks the platform for a fresh link when an image is looked at and fetches it with that profile's own
  // session (the link may need its cookies), keeps a few in memory, and never writes them anywhere. Asks are one at
  // a time and spaced out, so a page of images is not a burst.
  const CACHE_MAX_ITEMS = 80;
  const CACHE_MAX_BYTES = 120 * 1024 * 1024;
  const FAIL_MEMORY_MS = 60_000;
  const imageCache = new Map<number, { bytes: Uint8Array; mime: string }>();
  const imageFailed = new Map<number, number>();
  let imageBytesHeld = 0;
  // Two lanes: a page of previews is not one long queue, but the platform is still never hit by a burst.
  const lanes: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
  let nextLane = 0;
  const remember = (id: number, img: { bytes: Uint8Array; mime: string }) => {
    imageCache.set(id, img);
    imageBytesHeld += img.bytes.length;
    for (const [old, v] of imageCache) {
      if (imageCache.size <= CACHE_MAX_ITEMS && imageBytesHeld <= CACHE_MAX_BYTES) break;
      if (old === id) continue;
      imageCache.delete(old);
      imageBytesHeld -= v.bytes.length;
    }
  };
  const fetchImage = async (id: number): Promise<{ bytes: Uint8Array; mime: string } | null> => {
    const src = repo.mediaSource(id);
    if (!src) return null;
    if (src.stored) {
      const file = repo.mediaFile(id);
      const bytes = file && deps.readMedia ? await deps.readMedia(file.path) : null;
      return file && bytes ? { bytes, mime: file.mime } : null;
    }
    const hit = imageCache.get(id);
    if (hit) return hit;
    const failedAt = imageFailed.get(id);
    if (failedAt && Date.now() - failedAt < FAIL_MEMORY_MS) return null;
    const acc = repo.getAccount(src.accountId);
    if (!acc || acc.platform !== 'chatgpt' || !deps.web) return null;
    const lane = nextLane++ % lanes.length;
    const job = lanes[lane]!.then(async () => {
      const again = imageCache.get(id);
      if (again) return again;
      try {
        const got = await chatgptConnector.downloadImage!(
          {
            accountId: src.accountId,
            http: deps.web!.httpFor(acc.partition),
            downloadUrl: deps.web!.downloadFor(acc.partition),
            expectedIdentity: acc.identity,
          },
          { ref: src.ref },
          src.conversationRemoteId,
        );
        const kind = sniffImage(got.bytes);
        if (!kind || got.bytes.length === 0) throw new Error('The file is not an image.');
        const img = { bytes: got.bytes, mime: kind.mime };
        remember(id, img);
        return img;
      } catch (err) {
        imageFailed.set(id, Date.now());
        // Our own messages: a status or a reason, never content.
        console.error('[image] not shown:', err instanceof Error ? err.message : String(err));
        return null;
      }
    });
    lanes[lane] = job.then(
      () => new Promise<void>((r) => setTimeout(r, deps.chatgptClient?.paceMs ?? 150)),
    );
    return job;
  };
  const imageData = (id: number) => fetchImage(id);

  // Previews: about a third of the size, kept on disk (a few KB each), so the list and the gallery are instant the
  // second time and the platform is not asked again. The full image is only fetched when one is opened.
  const THUMB_SIDE = 240;
  const thumbJobs = new Map<number, Promise<{ bytes: Uint8Array; mime: string } | null>>();
  const thumbData = (id: number) => {
    const running = thumbJobs.get(id);
    if (running) return running;
    const job = (async () => {
      const kept = await deps.thumbs?.get(id).catch(() => null);
      if (kept) return { bytes: kept, mime: 'image/jpeg' };
      const full = await fetchImage(id);
      if (!full) return null;
      const small = deps.makeThumb?.(full.bytes, THUMB_SIDE) ?? null;
      if (!small) return full; // cannot shrink here: show it as it is
      await deps.thumbs?.put(id, small).catch(() => undefined);
      return { bytes: small, mime: 'image/jpeg' };
    })().finally(() => thumbJobs.delete(id));
    thumbJobs.set(id, job);
    return job;
  };

  // ---- changes on the platform: a durable queue, carried out one at a time ----
  const queue = new ActionQueue(repo);
  const writeConnectors: Partial<Record<Platform, Connector>> = deps.connectors ?? {
    chatgpt: chatgptConnector,
  };
  const exportDir = deps.exportDir ?? null;
  const runnerDeps: RunnerDeps = {
    repo,
    queue,
    connectorFor: (platform) => writeConnectors[platform],
    contextFor: (accountId): AccountContext | null => {
      const acc = repo.getAccount(accountId);
      if (!acc || !deps.web) return null;
      return {
        accountId,
        http: deps.web.httpFor(acc.partition),
        downloadUrl: deps.web.downloadFor(acc.partition),
        expectedIdentity: acc.identity,
      };
    },
    exports: { dir: exportDir ?? '', ...(deps.readMedia ? { readMedia: deps.readMedia } : {}) },
    ...((deps.removeFiles ?? deps.media)
      ? { removeFiles: deps.removeFiles ?? deps.media!.remove.bind(deps.media) }
      : {}),
    ...(deps.actions?.sleep ? { sleep: deps.actions.sleep } : {}),
    ...(deps.actions?.paceMs !== undefined ? { paceMs: deps.actions.paceMs } : {}),
    ...(deps.actions?.jitterMs !== undefined ? { jitterMs: deps.actions.jitterMs } : {}),
  };
  const runner = new ActionRunner(runnerDeps);
  // Changes that were mid-way when the app last closed go back in line (they are safe to repeat).
  queue.resetRunning();
  const kick = () => {
    if (deps.actions?.autoRun === false) return;
    setTimeout(() => void runner.drain().catch(() => undefined), 0);
  };
  /** Sends a local change to the platform too, but only for a profile that allows it and a connector that can. */
  const propagate = (
    conversationId: number,
    type: 'rename' | 'archive' | 'unarchive',
    payload: { title?: string } = {},
  ) => {
    const c = repo.conversationRemote(conversationId);
    if (!c || !repo.allowsChanges(c.accountId)) return;
    const cap = type === 'rename' ? 'rename' : 'archive';
    if (!writeConnectors[c.platform]?.capabilities[cap]) return;
    queue.enqueue({
      accountId: c.accountId,
      conversationId,
      remoteId: c.remoteId,
      type,
      payload: { ...payload, chatTitle: c.title },
    });
    kick();
  };
  const canWriteOf = (platform: Platform) => {
    const caps = writeConnectors[platform]?.capabilities;
    return { rename: !!caps?.rename, archive: !!caps?.archive, delete: !!caps?.delete };
  };

  const requireWeb = (): WebHost => {
    if (!deps.web) throw new Error('Sign-in windows are not available here.');
    return deps.web;
  };
  /** Looks the profile up in the database: the renderer only ever names it by id. */
  const webTarget = (accountId: number): WebTarget => {
    const acc = repo.getAccount(idSchema.parse(accountId));
    if (!acc || !(WEB_PLATFORMS as readonly string[]).includes(acc.platform)) {
      throw new Error('This profile does not use a sign-in window.');
    }
    return { accountId: acc.id, platform: acc.platform, partition: acc.partition };
  };

  /** Sign-ins in progress. The session name lives here, so the renderer can never choose one. */
  const attempts = new Map<
    string,
    {
      platform: Platform;
      partition: string;
      identity: string | null;
      displayName: string | null;
      signedIn: boolean;
    }
  >();
  const attemptOf = (attemptId: string) => {
    const a = attempts.get(z.string().min(1).max(100).parse(attemptId));
    if (!a) throw new Error('This sign-in is no longer active. Start again.');
    return a;
  };

  return {
    imageData,
    thumbData,
    sidebar: async () => {
      const data = repo.sidebar();
      for (const g of data.platforms)
        for (const a of g.accounts) a.canWrite = canWriteOf(a.platform);
      return data;
    },
    filterOptions: async () => repo.filterOptions(),
    listChats: async (query) => repo.listChats(listQuerySchema.parse(query)),
    chatIds: async (query) => repo.chatIds(listQuerySchema.parse(query)),
    getChat: async (id) => repo.getChat(idSchema.parse(id)),
    bulk: async (ids, rawAction) => {
      const action = bulkActionSchema.parse(rawAction);
      const res = repo.bulk(idsSchema.parse(ids), action);
      // Only what really changed is sent on; restoring from the Trash withdraws a delete that was not sent yet.
      if (action.type === 'archive' || action.type === 'unarchive') {
        for (const id of res.changedIds) propagate(id, action.type);
      } else if (action.type === 'restore') {
        for (const id of res.changedIds) queue.cancelPendingFor(id, ['delete']);
      }
      return res;
    },
    setTitle: async (id, title) => {
      const convId = idSchema.parse(id);
      const clean = z.string().max(1000).parse(title);
      const ok = repo.setTitle(convId, clean);
      if (ok) propagate(convId, 'rename', { title: clean.trim() });
      return ok;
    },
    removeTag: async (id, tag) =>
      repo.removeTag(idSchema.parse(id), z.string().min(1).max(64).parse(tag)),
    saveImage: async (id) => {
      const mediaId = idSchema.parse(id);
      if (!deps.saveFile) throw new Error('Saving is not available here.');
      const img = await imageData(mediaId);
      if (!img) throw new Error('This image is not available.');
      const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime.replace('image/', '');
      return deps.saveFile(`image-${mediaId}.${ext}`, img.bytes);
    },
    imageSuggest: async (text, scope) => {
      const q = z.string().max(200).parse(text);
      const s = imageQuerySchema.pick({ platform: true, accountId: true }).parse(scope ?? {});
      return repo.imageSuggestions(q, {
        ...(s.platform ? { platform: s.platform } : {}),
        ...(s.accountId !== undefined ? { accountIds: [s.accountId] } : {}),
      });
    },
    listImages: async (query) => repo.listImages(imageQuerySchema.parse(query)),
    purgePreview: async (ids) => repo.purgePreview(idsSchema.parse(ids)),
    purge: async (ids) => {
      const { mediaPaths, mediaIds, ...result } = repo.purge(idsSchema.parse(ids));
      if (mediaIds.length > 0) await deps.thumbs?.remove(mediaIds).catch(() => undefined);
      if (mediaPaths.length > 0)
        await (deps.removeFiles ?? deps.media?.remove.bind(deps.media))?.(mediaPaths);
      return result;
    },
    trashRetentionDays: async () => repo.trashRetentionDays,
    openOnPlatform: async (platform, remoteId) => {
      const url = platformUrl(
        z.enum(PLATFORMS).parse(platform),
        remoteId === undefined ? undefined : z.string().min(1).max(200).parse(remoteId),
      );
      if (url) await deps.openExternal(url);
    },

    allowChanges: async (accountId, allowed) => {
      const id = idSchema.parse(accountId);
      const acc = repo.getAccount(id);
      if (!acc) throw new Error('This profile does not exist.');
      const can = canWriteOf(acc.platform);
      if (allowed && !(can.rename || can.archive || can.delete)) {
        throw new Error('This app cannot change things on this platform yet.');
      }
      repo.setAllowChanges(id, z.boolean().parse(allowed));
      // Turning it off also withdraws anything that was waiting to be sent for this profile.
      if (!allowed) queue.cancelPendingForAccount(id);
    },
    planDelete: async (ids) => runner.plan(idsSchema.parse(ids)),
    deleteOnPlatform: async (ids) => {
      const list = idsSchema.parse(ids);
      const plan = runner.plan(list);
      let queued = 0;
      for (const id of new Set(list)) {
        const c = repo.conversationRemote(id);
        if (!c || c.state !== 'trashed_local') continue;
        const blocked = plan.blocked.some((b) => b.accountId === c.accountId);
        if (blocked) continue;
        queue.enqueue({
          accountId: c.accountId,
          conversationId: id,
          remoteId: c.remoteId,
          type: 'delete',
          payload: { chatTitle: c.title },
        });
        queued++;
      }
      if (queued > 0) kick();
      return { queued, blocked: plan.total - queued };
    },
    queueSummary: async () => queue.summary(exportDir),
    queueList: async () => queue.list(200),
    queuePause: async (paused) => queue.setPaused(z.boolean().parse(paused)),
    queueCancelPending: async () => queue.cancelAllPending(),
    queueRetryFailed: async () => {
      const n = queue.retryFailed();
      if (n > 0) kick();
      return n;
    },
    queueRun: async () => {
      const r = await runner.drain();
      return { done: r.done, failed: r.failed };
    },
    openExports: async () => {
      if (exportDir && deps.openPath) await deps.openPath(exportDir);
    },
    dashboard: async (query) => {
      const q = dashboardQuerySchema.parse(query);
      return repo.dashboard(q.platform, q.accountId);
    },
    reorderAccounts: async (platform, orderedIds) =>
      repo.reorderAccounts(
        z.enum(PLATFORMS).parse(platform),
        z.array(idSchema).max(1000).parse(orderedIds),
      ),
    reorderPlatforms: async (order) =>
      repo.reorderPlatforms(z.array(z.enum(PLATFORMS)).max(10).parse(order)),
    renameAccount: async (id, label) => {
      if (!repo.renameAccount(idSchema.parse(id), accountLabelSchema.parse(label))) {
        throw new Error('This profile no longer exists.');
      }
    },

    openLink: async (url) => {
      const parsed = z
        .string()
        .max(2048)
        .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links can be opened')
        .parse(url);
      await deps.openExternal(new URL(parsed).toString());
    },

    signInStart: async (platform) => {
      const web = requireWeb();
      const p = z.enum(WEB_PLATFORMS).parse(platform);
      const { attemptId, partition } = await web.startSignIn(p);
      attempts.set(attemptId, {
        platform: p,
        partition,
        identity: null,
        displayName: null,
        signedIn: false,
      });
      return { attemptId };
    },

    signInStatus: async (attemptId, assumeSignedIn = false) => {
      const web = requireWeb();
      const a = attemptOf(attemptId);
      const probe = await web.probeSignIn(attemptId, z.boolean().parse(assumeSignedIn));
      if (probe.state === 'closed') {
        attempts.delete(attemptId);
        await web.endSignIn(attemptId, false);
        return { state: 'closed' } satisfies SignInStatus;
      }
      if (probe.state === 'waiting') return { state: 'waiting' } satisfies SignInStatus;

      a.signedIn = true;
      a.identity = probe.identity;
      a.displayName = probe.displayName;
      const profiles = repo.profilesOf(a.platform);
      // Recognised by the platform's own account id: the same account is never added twice.
      const match = a.identity ? profiles.find((x) => x.identity === a.identity) : undefined;
      // Not recognised: it may still be a profile made before identities were recorded (no id yet), or,
      // when the platform did not say who this is, any profile of the platform.
      const candidates = match ? [] : profiles.filter((x) => !a.identity || x.identity === null);
      return {
        state: 'signed-in',
        displayName: a.displayName,
        identityKnown: a.identity !== null,
        match: match ? { id: match.id, label: match.label } : null,
        candidates: candidates.map((x) => ({ id: x.id, label: x.label })),
      } satisfies SignInStatus;
    },

    signInFinish: async (attemptId, rawChoice) => {
      const web = requireWeb();
      const a = attemptOf(attemptId);
      if (!a.signedIn) throw new Error('Sign in first, then finish.');
      const choice = signInChoiceSchema.parse(rawChoice);
      const profiles = repo.profilesOf(a.platform);

      if (choice.type === 'new') {
        const twin = a.identity ? profiles.find((x) => x.identity === a.identity) : undefined;
        if (twin) throw new Error(`This account is already connected as “${twin.label}”.`);
        // First real source: the demo data goes. A name clash is impossible while only demo data
        // exists, and real data is never deleted.
        repo.removeDemoData();
        const accountId = repo.addAccount({
          platform: a.platform,
          label: choice.label,
          partition: a.partition,
          ...(a.identity ? { identityHint: a.identity } : {}),
        });
        attempts.delete(attemptId);
        await web.endSignIn(attemptId, true);
        return { accountId, created: true };
      }

      const target = profiles.find((x) => x.id === choice.accountId);
      if (!target) throw new Error('This profile does not exist.');
      if (target.identity && a.identity && target.identity !== a.identity) {
        throw new Error('This is a different account than the profile you chose.');
      }
      const oldPartition = repo.replaceAccountSession(target.id, a.partition, a.identity);
      attempts.delete(attemptId);
      await web.closeLogin(target.id);
      await web.endSignIn(attemptId, true);
      // The new session replaces the old one, which is now dead weight.
      if (oldPartition && oldPartition !== a.partition) await web.wipePartition(oldPartition);
      return { accountId: target.id, created: false };
    },

    signInCancel: async (attemptId) => {
      const web = requireWeb();
      attemptOf(attemptId);
      attempts.delete(attemptId);
      await web.endSignIn(attemptId, false);
    },

    openLogin: async (accountId) => requireWeb().openLogin(webTarget(accountId)),
    recorderStart: async (accountId) => requireWeb().recorderStart(webTarget(accountId)),
    recorderStatus: async () => requireWeb().recorderStatus(),
    recorderStop: async () => requireWeb().recorderStop(),
    revealReport: async () => requireWeb().revealReport(),

    connectClaudeCode: async (label) => {
      const name = accountLabelSchema.parse(label);
      const root = deps.claudeCodeRoot;
      if (!root) throw new Error('Claude Code sessions folder is not configured');
      const ctx = { accountId: 0, root };
      if ((await claudeCodeConnector.checkSession(ctx)) !== 'ok') {
        throw new Error('No Claude Code sessions folder found on this Mac (~/.claude/projects).');
      }
      let accountId = repo.findAccountId(CLAUDE_CODE_PARTITION);
      if (accountId === null) {
        repo.removeDemoData(); // first real source: the synthetic data has served its purpose
        accountId = repo.addAccount({
          platform: 'claude-code',
          label: name,
          partition: CLAUDE_CODE_PARTITION,
        });
      }
      const id = accountId;
      const stats = await exclusive(id, () => syncClaudeCode(id));
      return { accountId: id, stats };
    },

    syncProgress: async () =>
      [...progress.values()].map((p) => ({
        ...p,
        waitingSeconds: waiting.get(p.accountId) ?? null,
      })),

    syncProfiles: async (ids) => syncMany(z.array(idSchema).max(200).parse(ids)),

    syncAll: async () => syncMany(syncableIds()),

    // A quick refresh for the background, like a mail client checking for new mail: only what changed lately. The
    // walk through every project's chat list is more requests, so it is done on every fifth refresh (and by the
    // buttons), not every time.
    syncRecent: async () => {
      recentRuns++;
      return syncMany(syncableIds(), { includeProjects: recentRuns % 5 === 1 });
    },
  };
}
