import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, session, shell, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { SignInProbe, WebHost, WebTarget } from '../core/api';
import type { DownloadUrl, HttpJson } from '../connectors/types';
import { createChatGptDownloader, createChatGptHttp } from './chatgptHttp';
import { createClaudeHttp } from './claudeHttp';
import { platformUrl } from '../core/platforms';
import type { Platform, RecorderSaved, RecorderStatus } from '../shared/types';
import { StructureRecorder } from '../tools/recorder';

/** Only calls to these hosts are ever considered by the recorder. Sign-in hosts are excluded on purpose. */
const RECORD_HOSTS: Partial<Record<Platform, string[]>> = {
  chatgpt: ['chatgpt.com', 'chat.openai.com'],
  claude: ['claude.ai'],
};

const PLATFORM_NAME: Partial<Record<Platform, string>> = { chatgpt: 'ChatGPT', claude: 'Claude' };

/**
 * How to learn WHICH account is signed in, using the platform's own page from inside its window (so the
 * request is exactly the one the site makes itself). The script returns only the account id and display
 * name: the access token that the same response contains never leaves the page.
 *
 * UNVERIFIED for ChatGPT: the `/api/auth/session` shape (`user.id`, `user.name`) is what the site is known to
 * use, but it has not been confirmed against a real signed-in session yet. If it does not match, the app falls
 * back to asking the user ("I've signed in") and to choosing the profile by hand.
 */
const IDENTITY_PROBE: Partial<Record<Platform, { hosts: string[]; script: string }>> = {
  chatgpt: {
    hosts: ['chatgpt.com', 'chat.openai.com'],
    script: `fetch('/api/auth/session', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || !j.user) return null;
        const u = j.user;
        return {
          id: typeof u.id === 'string' ? u.id.slice(0, 200) : '',
          name: typeof u.name === 'string' ? u.name.slice(0, 80) : '',
        };
      })
      .catch(() => null)`,
  },
  // UNVERIFIED for Claude: `/api/account` with `uuid` and `full_name` is a guess. If it does not answer like this
  // the app falls back to "I've signed in" and asks the user to choose the profile by hand.
  claude: {
    hosts: ['claude.ai'],
    script: `fetch('/api/account', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || typeof j.uuid !== 'string') return null;
        return {
          id: j.uuid.slice(0, 200),
          name: typeof j.full_name === 'string' ? j.full_name.slice(0, 80) : '',
        };
      })
      .catch(() => null)`,
  },
};

interface Attempt {
  platform: Platform;
  partition: string;
  window: BrowserWindow;
  closed: boolean;
}

interface Recording {
  target: WebTarget;
  recorder: StructureRecorder;
  contents: WebContents;
  detach: () => void;
}

/**
 * Sign-in windows for web platforms, one persistent session (`persist:…`) per profile, so several
 * accounts of the same platform stay signed in at once. The user types their password on the
 * platform's own page; this app never sees it.
 *
 * The windows load remote websites, so they get NO preload script and no access to this app's API:
 * sandboxed, context-isolated, no Node, all permission requests (camera, microphone, notifications…)
 * denied, and navigation limited to https.
 */
export class ElectronWebHost implements WebHost {
  private windows = new Map<number, BrowserWindow>();
  private attempts = new Map<string, Attempt>();
  private recording: Recording | null = null;
  private saved: RecorderSaved | null = null;

  /** A hardened window for a platform's own pages, bound to one persistent browser session. */
  private createWindow(platform: Platform, partition: string): BrowserWindow {
    const url = platformUrl(platform);
    if (!url) throw new Error('This platform has no sign-in page.');

    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      title: `${PLATFORM_NAME[platform] ?? platform} — sign in`,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const secure = { sandbox: true, contextIsolation: true, nodeIntegration: false };
    // "Continue with Google/Apple/Microsoft" opens a pop-up: allow https ones, same hardening, nothing else.
    win.webContents.setWindowOpenHandler(({ url: popup }) =>
      popup.startsWith('https://')
        ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: secure } }
        : { action: 'deny' },
    );
    win.webContents.on('will-navigate', (event, to) => {
      if (!to.startsWith('https://')) event.preventDefault();
    });
    // A page that fails to load (offline, blocked, interrupted) must not fail "sign in": the window stays
    // open and shows the browser's own error page.
    win.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        console.error(
          `Sign-in page failed to load (${code} ${description}) for ${new URL(failedUrl).origin}`,
        );
      }
    });
    void win.loadURL(url).catch(() => undefined); // failures are reported by did-fail-load above
    return win;
  }

  async openLogin(target: WebTarget): Promise<void> {
    const existing = this.windows.get(target.accountId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const win = this.createWindow(target.platform, target.partition);
    win.on('closed', () => {
      this.windows.delete(target.accountId);
      if (this.recording?.target.accountId === target.accountId) void this.finish();
    });
    this.windows.set(target.accountId, win);
  }

  async closeLogin(accountId: number): Promise<void> {
    const w = this.windows.get(accountId);
    if (w && !w.isDestroyed()) w.destroy();
    this.windows.delete(accountId);
  }

  // ---------- adding an account: sign in first, decide afterwards ----------

  async startSignIn(platform: Platform): Promise<{ attemptId: string; partition: string }> {
    if (!IDENTITY_PROBE[platform])
      throw new Error('Signing in is not supported for this platform yet.');
    const attemptId = randomUUID();
    const partition = `persist:${platform}-${randomUUID().slice(0, 8)}`;
    const window = this.createWindow(platform, partition);
    const attempt: Attempt = { platform, partition, window, closed: false };
    window.on('closed', () => {
      attempt.closed = true;
    });
    this.attempts.set(attemptId, attempt);
    return { attemptId, partition };
  }

  async probeSignIn(attemptId: string, assumeSignedIn: boolean): Promise<SignInProbe> {
    const a = this.attempts.get(attemptId);
    if (!a || a.closed || a.window.isDestroyed()) return { state: 'closed' };
    const probe = IDENTITY_PROBE[a.platform];
    if (!probe) return { state: 'waiting' };

    const contents = a.window.webContents;
    let location: URL;
    try {
      location = new URL(contents.getURL());
    } catch {
      return { state: 'waiting' };
    }
    const host = location.hostname;
    if (!probe.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { state: 'waiting' };

    type Learned = { id?: unknown; name?: unknown } | null;
    const result: Learned = await Promise.race([
      contents.executeJavaScript(probe.script, false) as Promise<Learned>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ]).catch(() => null);
    if (result && typeof result === 'object') {
      const id = typeof result.id === 'string' && result.id.trim() ? result.id.trim() : null;
      const name =
        typeof result.name === 'string' && result.name.trim() ? result.name.trim() : null;
      return { state: 'signed-in', identity: id, displayName: name };
    }
    // The site did not say who is signed in. If the user says they are, and the page is not a sign-in page,
    // believe them, with an unknown identity.
    if (assumeSignedIn && !/^\/(auth|log-?in)/.test(location.pathname)) {
      return { state: 'signed-in', identity: null, displayName: null };
    }
    return { state: 'waiting' };
  }

  async endSignIn(attemptId: string, keepSession: boolean): Promise<void> {
    const a = this.attempts.get(attemptId);
    if (!a) return;
    this.attempts.delete(attemptId);
    if (!a.window.isDestroyed()) a.window.destroy();
    if (!keepSession) await this.wipePartition(a.partition);
  }

  private http = new Map<string, HttpJson>();

  httpFor(partition: string): HttpJson {
    let h = this.http.get(partition);
    if (!h) {
      h = partition.startsWith('persist:claude-')
        ? createClaudeHttp(partition)
        : createChatGptHttp(partition);
      this.http.set(partition, h);
    }
    return h;
  }

  downloadFor(partition: string): DownloadUrl {
    return createChatGptDownloader(partition);
  }

  async wipePartition(partition: string): Promise<void> {
    this.http.delete(partition);
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
    await ses.clearCache();
  }

  async recorderStart(target: WebTarget): Promise<void> {
    if (this.recording) throw new Error('A recording is already running. Stop it first.');
    const hosts = RECORD_HOSTS[target.platform];
    if (!hosts) throw new Error('The recorder does not support this platform yet.');
    await this.openLogin(target);
    const win = this.windows.get(target.accountId);
    if (!win || win.isDestroyed()) throw new Error('The sign-in window is not open.');

    const contents = win.webContents;
    const recorder = new StructureRecorder({ allowedHosts: hosts });
    const dbg = contents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Network.enable');

    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
      void recorder
        .onEvent(method, params, async (requestId) => {
          try {
            return (await dbg.sendCommand('Network.getResponseBody', { requestId })) as {
              body: string;
              base64Encoded: boolean;
            };
          } catch {
            return null;
          }
        })
        .catch(() => undefined);
    };
    dbg.on('message', onMessage);
    const onDetach = () => {
      if (this.recording?.contents === contents) void this.finish();
    };
    dbg.on('detach', onDetach);

    this.saved = null;
    this.recording = {
      target,
      recorder,
      contents,
      detach: () => {
        dbg.removeListener('message', onMessage);
        dbg.removeListener('detach', onDetach);
        try {
          dbg.detach();
        } catch {
          /* already detached */
        }
      },
    };
    // Reload so the calls made at page load (session, chat list…) are part of the recording.
    contents.reloadIgnoringCache();
  }

  recorderStatus(): RecorderStatus {
    const s = this.recording?.recorder.status() ?? { requests: 0, endpoints: 0 };
    return {
      state: this.recording ? 'recording' : 'idle',
      accountId: this.recording?.target.accountId ?? null,
      requests: s.requests,
      endpoints: s.endpoints,
      openLogins: [...this.windows.entries()].filter(([, w]) => !w.isDestroyed()).map(([id]) => id),
      saved: this.saved,
    };
  }

  async recorderStop(): Promise<RecorderSaved | null> {
    if (this.recording) await this.finish();
    return this.saved;
  }

  /** Detaches, writes the report (structure only) into the app's data folder, remembers where. */
  private async finish(): Promise<void> {
    const rec = this.recording;
    if (!rec) return;
    this.recording = null;
    rec.detach();
    const report = rec.recorder.report();
    const dir = join(app.getPath('userData'), 'captures');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `structure-${rec.target.platform}-${stamp}.json`);
    await writeFile(path, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.saved = { path, requests: report.requests, endpoints: report.endpoints.length };
  }

  async revealReport(): Promise<void> {
    if (this.saved) shell.showItemInFolder(this.saved.path);
  }

  closeAll(): void {
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    for (const a of this.attempts.values()) if (!a.window.isDestroyed()) a.window.destroy();
  }
}
