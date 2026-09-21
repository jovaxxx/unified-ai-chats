import type { HttpJson, Connector, DownloadUrl } from '../connectors/types';
import type { SignInProbe, WebHost, WebTarget } from './api';
import type { Platform, RecorderSaved, RecorderStatus } from '../shared/types';

/** Test doubles shared by several test files. Not a test file itself, so importing it runs no tests. */

/** A stand-in for the Electron side: records what it was asked to do and answers probes as told. */
export function fakeWeb() {
  const calls: { fn: string; [k: string]: unknown }[] = [];
  const wiped: string[] = [];
  const partitions = new Map<string, string>();
  let n = 0;
  let probe: SignInProbe = { state: 'waiting' };
  let probeNeedsUser = false; // the platform never says who it is; only the user's own "I've signed in" counts
  let http: HttpJson = async () => {
    throw new Error('no fake http configured');
  };
  let downloadUrlFn: DownloadUrl = async () => {
    throw new Error('no fake downloads configured');
  };
  const httpPartitions: string[] = [];
  let recording: WebTarget | null = null;
  let saved: RecorderSaved | null = null;

  const host: WebHost = {
    openLogin: async (target) => void calls.push({ fn: 'openLogin', target }),
    startSignIn: async (platform: Platform) => {
      const attemptId = `att-${++n}`;
      const partition = `persist:${platform}-fake${n}`;
      partitions.set(attemptId, partition);
      calls.push({ fn: 'startSignIn', platform });
      return { attemptId, partition };
    },
    probeSignIn: async (_id, assume) => {
      if (probeNeedsUser && !assume) return { state: 'waiting' };
      return probe;
    },
    endSignIn: async (attemptId, keep) => {
      calls.push({ fn: 'endSignIn', attemptId, keep });
      if (!keep) wiped.push(partitions.get(attemptId)!);
    },
    downloadFor: () => (url) => downloadUrlFn(url),
    httpFor: (partition) => {
      httpPartitions.push(partition);
      return (path) => http(path);
    },
    closeLogin: async (accountId) => void calls.push({ fn: 'closeLogin', accountId }),
    wipePartition: async (partition) => void wiped.push(partition),
    recorderStart: async (target) => {
      calls.push({ fn: 'recorderStart', target });
      recording = target;
      saved = null;
    },
    recorderStatus: (): RecorderStatus => ({
      state: recording ? 'recording' : 'idle',
      accountId: recording?.accountId ?? null,
      requests: recording ? 7 : 0,
      endpoints: recording ? 3 : 0,
      openLogins: [],
      saved,
    }),
    recorderStop: async () => {
      calls.push({ fn: 'recorderStop' });
      if (recording)
        saved = { path: '/tmp/structure-chatgpt-test.json', requests: 7, endpoints: 3 };
      recording = null;
      return saved;
    },
    revealReport: async () => void calls.push({ fn: 'revealReport' }),
  };
  return {
    host,
    calls,
    wiped,
    partitionOf: (attemptId: string) => partitions.get(attemptId)!,
    setDownload: (fn: DownloadUrl) => {
      downloadUrlFn = fn;
    },
    /** The web API the signed-in sessions talk to. */
    setHttp: (fn: HttpJson) => {
      http = fn;
    },
    httpPartitions,
    /** What the sign-in window will report next. */
    signedInAs: (identity: string | null, displayName: string | null = null) => {
      probe = { state: 'signed-in', identity, displayName };
    },
    windowClosed: () => {
      probe = { state: 'closed' };
    },
    onlyAfterUserSaysSo: (v = true) => {
      probeNeedsUser = v;
    },
  };
}

/** A connector that can change things on the platform, recording every call. Nothing here touches a network. */
export function writableConnector(over: Partial<Connector> = {}) {
  const calls: string[] = [];
  const failures = new Map<string, Error[]>();
  const maybeFail = (key: string) => {
    const queue = failures.get(key);
    if (queue?.length) throw queue.shift()!;
  };
  const connector: Connector = {
    id: 'chatgpt',
    capabilities: { projects: true, archive: true, rename: true, delete: true, images: false },
    checkSession: async () => 'ok',
    async *listConversations() {},
    getConversation: async () => {
      throw new Error('not used');
    },
    verifyAccount: async () => void calls.push('verify'),
    rename: async (_c, id, title) => {
      maybeFail('rename');
      calls.push(`rename ${id} -> ${title}`);
    },
    archive: async (_c, id, archived) => {
      maybeFail('archive');
      calls.push(`${archived ? 'archive' : 'unarchive'} ${id}`);
    },
    delete: async (_c, id) => {
      maybeFail('delete');
      calls.push(`delete ${id}`);
    },
    exportRaw: async (_c, id) => ({ platformRecord: true, id }),
    ...over,
  };
  return { connector, calls, failWith: (key: string, ...errs: Error[]) => failures.set(key, errs) };
}
