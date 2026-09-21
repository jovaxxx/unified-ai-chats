import type { ContentBlock, Platform } from '../shared/types';

/** The result of one JSON request to a platform's web API. `json` is undefined if the body was not JSON. */
export interface HttpResult {
  status: number;
  json: unknown;
  retryAfterSeconds?: number;
}
/** Performs a GET on the platform's own site (path only, e.g. `/backend-api/me`) as the signed-in user. */
export type HttpJson = (path: string) => Promise<HttpResult>;

/** Fetches a file from an absolute https URL (e.g. a signed download link), as this profile's session. */
export type DownloadUrl = (
  url: string,
) => Promise<{ status: number; bytes: Uint8Array; mime: string | null }>;

/** An image a conversation refers to. It is downloaded separately. */
export interface RemoteImage {
  ref: string;
  /** Made by the assistant, or uploaded by the user. Only generated images are downloaded. */
  kind: 'generated' | 'uploaded';
  alt?: string;
  width?: number;
  height?: number;
}

export interface DownloadedImage {
  bytes: Uint8Array;
  mime: string;
}

/** Everything a connector needs to know about one account. */
export interface AccountContext {
  accountId: number;
  /** Web connectors only: performs requests as this profile's signed-in session. */
  http?: HttpJson;
  /** Web connectors only: downloads a file from a URL the platform handed out. */
  downloadUrl?: DownloadUrl;
  /** Web connectors only: the platform's own account id this profile was created for, if known. */
  expectedIdentity?: string | null;
  /**
   * False on a quick background refresh: skip the walk through every project's chat list (many requests) and only
   * look at the main lists and pins, where recent changes show up first. A full sync and the button still walk them.
   */
  includeProjects?: boolean;
  /** Told when the platform makes this profile wait (milliseconds), and with 0 when the wait is over. */
  onWait?: (ms: number) => void;
  /** Local-file connectors only: the folder they read from. */
  root?: string;
}

export interface RemoteConversationSummary {
  remoteId: string;
  /** Last change time as the source reports it (ISO 8601). Used for incremental sync. */
  remoteUpdatedAt: string;
}

export interface RemoteMessage {
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
  createdAt: string;
}

export interface RemoteConversation {
  remoteId: string;
  /** The source's own title, always kept and shown as «was …». */
  remoteTitle: string;
  /** A title the user set at the source, if any; it wins over `remoteTitle`. */
  customTitle?: string;
  projectRemoteId?: string;
  projectName?: string;
  /** Kinds of content that were left out, with counts (names only, never content). For diagnosing gaps. */
  skipped?: Record<string, number>;
  /** The source says this conversation is archived (used when it is first imported). */
  archived?: boolean;
  images?: RemoteImage[];
  /** Local sources: the folder the session ran in. Only ever used to build a resume command. */
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  messages: RemoteMessage[];
}

/** Optional methods are only present when the capability is true. */
export interface Connector {
  id: Platform;
  capabilities: {
    projects: boolean;
    archive: boolean;
    rename: boolean;
    delete: boolean;
    images: boolean;
  };
  checkSession(ctx: AccountContext): Promise<'ok' | 'login_required' | 'unknown'>;
  listConversations(ctx: AccountContext, since?: Date): AsyncIterable<RemoteConversationSummary>;
  getConversation(ctx: AccountContext, remoteId: string): Promise<RemoteConversation>;
  /**
   * Changes on the platform. Each exists only if the connector really can do it (see `capabilities`). They must be
   * idempotent: repeating one that already happened is not an error, and `delete` of something already gone is a
   * `NotFound`, which callers treat as success.
   */
  rename?(ctx: AccountContext, remoteId: string, title: string): Promise<void>;
  archive?(ctx: AccountContext, remoteId: string, archived: boolean): Promise<void>;
  delete?(ctx: AccountContext, remoteId: string): Promise<void>;
  /** The platform's own complete record of a conversation, for the safety copy made before deleting it. */
  exportRaw?(ctx: AccountContext, remoteId: string): Promise<unknown>;
  /** Throws if the signed-in session is not the account this profile was made for. Called before any change. */
  verifyAccount?(ctx: AccountContext): Promise<void>;
  /**
   * A fresh link the app can show an image from, straight from the platform's own file host. Links expire, so this
   * is asked when an image is looked at, not stored.
   */
  imageLink?(
    ctx: AccountContext,
    image: { ref: string },
    remoteConversationId: string,
  ): Promise<string>;
  /**
   * Counts about the last listing (how many the platform said it has, how many came from where), so gaps can be
   * spotted. Names and numbers only, never content.
   */
  notes?(ctx: AccountContext): Record<string, number>;
  /** Fetches one image of a conversation. Only connectors that have images implement it. */
  downloadImage?(
    ctx: AccountContext,
    image: { ref: string },
    remoteConversationId: string,
  ): Promise<DownloadedImage>;
}
