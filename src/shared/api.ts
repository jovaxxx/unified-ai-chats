import type {
  BulkAction,
  ActionItem,
  BulkResult,
  ChatDetail,
  FilterOptions,
  ImageList,
  ImageQuery,
  ListQuery,
  ListResult,
  ConnectResult,
  DeletePlan,
  DashboardData,
  DashboardQuery,
  Platform,
  PurgePreview,
  PurgeResult,
  QueueSummary,
  RecorderSaved,
  RecorderStatus,
  SidebarData,
  SignInChoice,
  SignInStatus,
  SyncProgress,
  SyncStats,
} from './types';

/** What the renderer can ask the main process. Implemented over IPC and, in tests, in-process. */
export interface Api {
  sidebar(): Promise<SidebarData>;
  filterOptions(): Promise<FilterOptions>;
  listChats(query: ListQuery): Promise<ListResult>;
  chatIds(query: ListQuery): Promise<number[]>;
  getChat(id: number): Promise<ChatDetail | null>;
  bulk(ids: number[], action: BulkAction): Promise<BulkResult>;
  setTitle(id: number, title: string): Promise<boolean>;
  /** Generated images saved on this Mac, for everything or one platform/profile, newest first. */
  listImages(query: ImageQuery): Promise<ImageList>;
  /** Completions for the image search box: project names and chat titles that have images. */
  imageSuggest(
    text: string,
    scope?: { platform?: Platform; accountId?: number },
  ): Promise<string[]>;
  /** Saves one image where the user chooses (a save dialog). False if they cancelled. */
  saveImage(id: number): Promise<boolean>;
  /** Turns "allow changes on the platform" on or off for a profile. Off by default; nothing is sent while it is off. */
  allowChanges(accountId: number, allowed: boolean): Promise<void>;
  /** What deleting these Trash chats on their platform would do (and which profiles cannot). */
  planDelete(ids: number[]): Promise<DeletePlan>;
  /**
   * Queues the deletion of these Trash chats on their platform. Each one is first saved as a verified full copy, then
   * deleted on the platform, then removed here. Only chats of profiles that allow changes are queued.
   */
  deleteOnPlatform(ids: number[]): Promise<{ queued: number; blocked: number }>;
  queueSummary(): Promise<QueueSummary>;
  queueList(): Promise<ActionItem[]>;
  queuePause(paused: boolean): Promise<void>;
  queueCancelPending(): Promise<number>;
  queueRetryFailed(): Promise<number>;
  /** Runs the queue now instead of waiting for the next turn. */
  queueRun(): Promise<{ done: number; failed: number }>;
  /** Shows the folder with the safety copies of deleted chats. */
  openExports(): Promise<void>;
  /** What "Delete now" would remove from these chats (only those in the Trash count). */
  purgePreview(ids: number[]): Promise<PurgePreview>;
  /**
   * Deletes chats in the Trash from this app for good. Nothing changes on the platform they came from, and they
   * are not imported again.
   */
  purge(ids: number[]): Promise<PurgeResult>;
  removeTag(id: number, tag: string): Promise<void>;
  /** Trash retention in days, for wording ("deleted after N days"). */
  trashRetentionDays(): Promise<number>;
  /** Opens a platform page in the user's default browser. Only known https hosts are allowed. */
  openOnPlatform(platform: Platform, remoteId?: string): Promise<void>;
  /** Opens a link found inside a chat in the system browser. Only http(s) URLs are accepted. */
  openLink(url: string): Promise<void>;
  /**
   * Adds the local Claude Code sessions (read from disk, no login, no network) as an account and
   * imports them. The first real source also removes the synthetic demo data.
   */
  connectClaudeCode(label: string): Promise<ConnectResult>;
  /**
   * Starts adding a web account: opens the platform's sign-in page in a fresh, isolated session. The
   * user signs in there (this app never sees the password) and only afterwards is a profile created,
   * or an existing one recognised. Returns an id for the following calls.
   */
  signInStart(platform: Platform): Promise<{ attemptId: string }>;
  /**
   * Checks whether the user has signed in yet, and if so which account it is. `assumeSignedIn` is the
   * user's own "I've signed in" for when the platform does not say who they are.
   */
  signInStatus(attemptId: string, assumeSignedIn?: boolean): Promise<SignInStatus>;
  /** Finishes the sign-in by creating a new named profile or by reusing an existing one. */
  signInFinish(
    attemptId: string,
    choice: SignInChoice,
  ): Promise<{ accountId: number; created: boolean }>;
  /** Abandons the sign-in: closes the window and forgets the session. */
  signInCancel(attemptId: string): Promise<void>;
  /** (Re)opens the sign-in window of a web profile. */
  openLogin(accountId: number): Promise<void>;
  /** Starts recording the STRUCTURE of the platform's API calls (never values) in a profile's window. */
  recorderStart(accountId: number): Promise<void>;
  recorderStatus(): Promise<RecorderStatus>;
  /** Stops and writes the structure report to disk. Returns null if nothing was recording. */
  recorderStop(): Promise<RecorderSaved | null>;
  /** Shows the last saved report in Finder. */
  revealReport(): Promise<void>;
  /** Numbers for a platform's dashboard, for one profile or all of them. */
  dashboard(query: DashboardQuery): Promise<DashboardData>;
  /** Puts a platform's profiles in the order the user chose (all of them, exactly once). */
  reorderAccounts(platform: Platform, orderedIds: number[]): Promise<void>;
  /** Puts the platforms in the order the user chose. */
  reorderPlatforms(order: Platform[]): Promise<void>;
  /** Renames a profile. Names are free text, unique per platform. */
  renameAccount(id: number, label: string): Promise<void>;
  /** Incremental sync of every connected local source. */
  syncAll(): Promise<SyncStats>;
  /** A quick refresh for the background: only what changed lately, no walk through every project. */
  syncRecent(): Promise<SyncStats>;
  /** Syncs only these profiles, all at the same time and independently of any other sync. */
  syncProfiles(accountIds: number[]): Promise<SyncStats>;
  /** How far each running sync is (one entry per profile being synced). */
  syncProgress(): Promise<SyncProgress[]>;
}

/** IPC channel names, one per Api method. */
export const IPC_CHANNELS = {
  sidebar: 'api:sidebar',
  filterOptions: 'api:filterOptions',
  listChats: 'api:listChats',
  chatIds: 'api:chatIds',
  getChat: 'api:getChat',
  bulk: 'api:bulk',
  setTitle: 'api:setTitle',
  listImages: 'api:listImages',
  imageSuggest: 'api:imageSuggest',
  saveImage: 'api:saveImage',
  allowChanges: 'api:allowChanges',
  planDelete: 'api:planDelete',
  deleteOnPlatform: 'api:deleteOnPlatform',
  queueSummary: 'api:queueSummary',
  queueList: 'api:queueList',
  queuePause: 'api:queuePause',
  queueCancelPending: 'api:queueCancelPending',
  queueRetryFailed: 'api:queueRetryFailed',
  queueRun: 'api:queueRun',
  openExports: 'api:openExports',
  purgePreview: 'api:purgePreview',
  purge: 'api:purge',
  removeTag: 'api:removeTag',
  trashRetentionDays: 'api:trashRetentionDays',
  openOnPlatform: 'api:openOnPlatform',
  openLink: 'api:openLink',
  connectClaudeCode: 'api:connectClaudeCode',
  signInStart: 'api:signInStart',
  signInStatus: 'api:signInStatus',
  signInFinish: 'api:signInFinish',
  signInCancel: 'api:signInCancel',
  openLogin: 'api:openLogin',
  recorderStart: 'api:recorderStart',
  recorderStatus: 'api:recorderStatus',
  recorderStop: 'api:recorderStop',
  revealReport: 'api:revealReport',
  dashboard: 'api:dashboard',
  renameAccount: 'api:renameAccount',
  reorderAccounts: 'api:reorderAccounts',
  reorderPlatforms: 'api:reorderPlatforms',
  syncAll: 'api:syncAll',
  syncRecent: 'api:syncRecent',
  syncProgress: 'api:syncProgress',
  syncProfiles: 'api:syncProfiles',
} as const satisfies Record<keyof Api, string>;

declare global {
  interface Window {
    api: Api;
  }
}
