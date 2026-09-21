import { z } from 'zod';

export const PLATFORMS = ['chatgpt', 'claude', 'gemini', 'claude-code'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CHAT_STATES = ['inbox', 'archived', 'trashed_local', 'deleted_remote'] as const;
export type ChatState = (typeof CHAT_STATES)[number];

export type AccountStatus = 'ok' | 'needs_attention';

/** One block of message content. Kept deliberately small until real connectors define more. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; text: string }
  /**
   * An image in the conversation. `ref` is the source's own pointer. `mediaId` and `status` are filled in when the chat
   * is read (never stored): `done` means the file is on this Mac.
   */
  | { type: 'image'; ref: string; alt?: string; mediaId?: number | null; status?: MediaStatus };

export type MediaStatus = 'pending' | 'done' | 'failed' | 'skipped';

export interface Message {
  id: number;
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
  createdAt: string;
}

export interface ChatSummary {
  id: number;
  platform: Platform;
  accountId: number;
  accountLabel: string;
  projectId: number | null;
  projectName: string | null;
  title: string;
  /** Title as shown by the platform. Shown as «was …» when it differs from `title`. */
  remoteTitle: string;
  preview: string;
  state: ChatState;
  trashPurgeAt: string | null;
  tags: string[];
  messageCount: number;
  updatedAt: string;
  /** Whether a change to this chat is still being sent to the platform, or failed to be. */
  remoteSync: 'idle' | 'pending' | 'failed';
}

export interface ChatDetail extends ChatSummary {
  summary: string | null;
  createdAt: string;
  remoteId: string;
  /** A shell command that resumes this conversation in its own tool (Claude Code), if it has one. */
  resumeCommand: string | null;
  /** Messages of the active branch only. */
  messages: Message[];
}

export interface SidebarProject {
  id: number;
  name: string;
  count: number;
}

export interface SidebarAccount {
  id: number;
  platform: Platform;
  label: string;
  status: AccountStatus;
  lastSyncAt: string | null;
  total: number;
  inbox: number;
  archived: number;
  /** Generated images downloaded to this Mac. */
  images: number;
  /** The user allowed this app to change things on the platform for this profile (off by default). */
  allowChanges: boolean;
  /** What the connector can actually do on the platform. Actions it cannot do are never offered. */
  canWrite: { rename: boolean; archive: boolean; delete: boolean };
  projects: SidebarProject[];
}

export interface SidebarPlatform {
  platform: Platform;
  total: number;
  accounts: SidebarAccount[];
}

export interface SidebarData {
  /** True while the database holds only the synthetic demo data (no real account yet). */
  demo: boolean;
  totalChats: number;
  trashed: number;
  platforms: SidebarPlatform[];
}

/** Chats shorter than this many messages count as "very short" on the dashboard. */
export const SHORT_CHAT_MESSAGES = 4;

export const CLEANUP_KINDS = ['short', 'untagged', 'generic'] as const;
export type CleanupKind = (typeof CLEANUP_KINDS)[number];

export const SORT_KEYS = [
  'updated_desc',
  'updated_asc',
  'created_desc',
  'created_asc',
  'title_asc',
  'title_desc',
  'messages_desc',
  'messages_asc',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** Where in the sidebar tree the list is scoped to. */
export const listQuerySchema = z.object({
  view: z.enum(['all', 'trash']).default('all'),
  platform: z.enum(PLATFORMS).optional(),
  accountId: z.number().int().optional(),
  scope: z.enum(['inbox', 'archive']).optional(),
  projectId: z.number().int().optional(),
  tag: z.string().min(1).max(64).optional(),
  /** The "to clean" suggestions on the dashboard, as list filters. */
  cleanup: z.enum(CLEANUP_KINDS).optional(),
  search: z.string().max(200).optional(),
  /** Omit for the default: best match while searching, most recently updated otherwise. */
  sort: z.enum(SORT_KEYS).optional(),
  limit: z.number().int().min(1).max(5000).default(100),
  offset: z.number().int().min(0).default(0),
});
export type ListQuery = z.input<typeof listQuerySchema>;

export interface ListResult {
  items: ChatSummary[];
  total: number;
}

export const bulkActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('archive') }),
  z.object({ type: z.literal('unarchive') }),
  z.object({ type: z.literal('trash') }),
  z.object({ type: z.literal('restore') }),
  z.object({ type: z.literal('tag'), tag: z.string().trim().min(1).max(64) }),
]);
export type BulkAction = z.infer<typeof bulkActionSchema>;

export interface BulkResult {
  /** Chats actually changed; chats already in the target state are skipped. */
  changed: number;
  skipped: number;
  /** Ids of the chats that changed. An undo must act on exactly these, not on the whole selection. */
  changedIds: number[];
}

export interface FilterOptions {
  accounts: { id: number; platform: Platform; label: string }[];
  projects: { id: number; accountId: number; name: string }[];
  tags: string[];
}

export interface SyncStats {
  /** Conversations the source offered (new or changed since the last sync). */
  seen: number;
  imported: number;
  failed: number;
  /** Short, content-free messages (ids and reasons only), at most a handful. */
  errors: string[];
  /** Generated images fetched during this sync. */
  images?: { downloaded: number; failed: number };
  /** Kinds of content the importer left out, with counts (names only). Helps spot what it does not understand yet. */
  skipped?: Record<string, number>;
  /** Numbers about what the platform listed (chats found, from pins, projects…), to spot gaps. Never content. */
  listing?: Record<string, number>;
}

/** How far a running sync is, for the progress line. Numbers only. */
export interface SyncProgress {
  accountId: number;
  /** Which profile is being synced. */
  label: string;
  phase: 'listing' | 'reading';
  done: number;
  total: number;
  /** Seconds the platform asked us to wait (rate limit), when it did. */
  waitingSeconds: number | null;
}

export interface ConnectResult {
  accountId: number;
  stats: SyncStats;
}

export const ACCOUNT_LABEL_MAX = 40;
export const accountLabelSchema = z
  .string()
  .trim()
  .min(1, 'Give the profile a name')
  .max(ACCOUNT_LABEL_MAX, `Use at most ${ACCOUNT_LABEL_MAX} characters`);

export const dashboardQuerySchema = z.object({
  platform: z.enum(PLATFORMS),
  /** Omit for "all accounts of this platform". */
  accountId: z.number().int().positive().optional(),
});
export type DashboardQuery = z.input<typeof dashboardQuerySchema>;

export interface DashboardData {
  platform: Platform;
  selectedAccountId: number | null;
  accounts: { id: number; label: string; status: AccountStatus; total: number }[];
  /** Latest sync among the selected accounts, or null if none ever ran. */
  lastSyncAt: string | null;
  needsAttention: boolean;
  /** Why the latest sync of the selected profile(s) did not complete, if it did not. */
  lastError: string | null;
  stats: {
    chats: number;
    inbox: number;
    projects: number;
    inProjects: number;
    archived: number;
    images: number;
  };
  /** Chats created per calendar month, oldest first, last 6 months including this one. */
  perMonth: { month: string; count: number }[];
  clean: Record<CleanupKind, number>;
  /** The most recent generated images (for the dashboard's strip). */
  recentImages: ImageItem[];
}

/** Web platforms whose sign-in window (and structure recorder) exist today. */
export const WEB_PLATFORMS = ['chatgpt', 'claude'] as const satisfies readonly Platform[];
export type WebPlatform = (typeof WEB_PLATFORMS)[number];

export interface RecorderStatus {
  state: 'idle' | 'recording';
  /** The profile being recorded, if any. */
  accountId: number | null;
  requests: number;
  endpoints: number;
  /** Profiles that currently have a sign-in window open. */
  openLogins: number[];
  /** Set once a report was saved (until the next recording starts). */
  saved: RecorderSaved | null;
}

export interface RecorderSaved {
  /** Where the structure report was written on this Mac. */
  path: string;
  requests: number;
  endpoints: number;
}

/** A profile that a just-signed-in account could belong to. */
export interface SignInCandidate {
  id: number;
  label: string;
}

/**
 * Where a sign-in stands. The user signs in first; only then does the app decide whether the account
 * is already one of their profiles (matched by the platform's own account id) or a new one.
 */
export type SignInStatus =
  | { state: 'waiting' }
  /** The window was closed before signing in. */
  | { state: 'closed' }
  | {
      state: 'signed-in';
      /** The name the platform shows for the account, if it told us (used to suggest a profile name). */
      displayName: string | null;
      /** False when the platform did not say which account this is. */
      identityKnown: boolean;
      /** A profile that is already this account: nothing new needs to be created. */
      match: SignInCandidate | null;
      /** Profiles this account might be, when it cannot be matched (older profiles, unknown identity). */
      candidates: SignInCandidate[];
    };

export const signInChoiceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new'), label: accountLabelSchema }),
  z.object({ type: z.literal('existing'), accountId: z.number().int().positive() }),
]);
export type SignInChoice = z.input<typeof signInChoiceSchema>;

/** What "delete now" would remove, shown before the user confirms. */
export interface PurgePreview {
  count: number;
  accounts: { platform: Platform; label: string; count: number }[];
}

export interface PurgeResult {
  removed: number;
  skipped: number;
}

/** An image saved on this Mac, with where it came from. */
export interface ImageItem {
  id: number;
  conversationId: number;
  chatTitle: string;
  platform: Platform;
  accountId: number;
  accountLabel: string;
  /** What it was generated from (the prompt), when the source says. */
  alt: string | null;
  width: number | null;
  height: number | null;
  /** The project the chat belongs to, if any. */
  projectName: string | null;
  /** When the chat was last changed (ISO): the best date we have for its images. */
  date: string;
}

export const imageQuerySchema = z.object({
  platform: z.enum(PLATFORMS).optional(),
  accountId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(5000).default(60),
  offset: z.number().int().min(0).default(0),
  /** Only images of chats in this project. */
  projectId: z.number().int().positive().optional(),
  /** Words that must appear in the chat title, the project name or what the image was made from. */
  search: z.string().max(200).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
});
export type ImageQuery = z.input<typeof imageQuerySchema>;

export interface ImageList {
  items: ImageItem[];
  total: number;
  /** Projects that have images in this scope, for the filter (not narrowed by the other filters). */
  projects: { id: number; name: string; count: number }[];
}

export const ACTION_TYPES = ['rename', 'archive', 'unarchive', 'delete'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** One change waiting to be sent to a platform, or already sent. */
export interface ActionItem {
  id: number;
  accountId: number;
  accountLabel: string;
  platform: Platform;
  type: ActionType;
  chatTitle: string | null;
  status: ActionStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  /** Not before this time (waiting after a rate limit, for example). */
  runAfter: string | null;
}

export interface QueueSummary {
  pending: number;
  running: number;
  failed: number;
  done: number;
  paused: boolean;
  /** A profile has to sign in again before its changes can continue. */
  needsSignIn: boolean;
  /** Where full copies of chats are kept before they are deleted on a platform. */
  exportDir: string | null;
}

/** What "delete on the platform" would do, shown before the user confirms. */
export interface DeletePlan {
  /** Chats in the Trash that were asked about. */
  total: number;
  /** Will be deleted on the platform (after a verified local copy is saved). */
  allowed: { accountId: number; platform: Platform; label: string; count: number }[];
  /** Cannot be deleted on the platform, and why. They can still be removed from this app only. */
  blocked: {
    accountId: number;
    platform: Platform;
    label: string;
    count: number;
    reason: 'not_allowed' | 'not_supported';
  }[];
  exportDir: string | null;
}
