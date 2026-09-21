import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { inTransaction } from './db';
import { resumeCommand } from './platforms';
import { stripMarkdown } from '../shared/text';
import {
  accountLabelSchema,
  imageQuerySchema,
  PLATFORMS,
  CLEANUP_KINDS,
  SHORT_CHAT_MESSAGES,
  listQuerySchema,
  type BulkAction,
  type BulkResult,
  type ChatDetail,
  type ChatState,
  type ChatSummary,
  type CleanupKind,
  type DashboardData,
  type ContentBlock,
  type ImageList,
  type ImageQuery,
  type MediaStatus,
  type FilterOptions,
  type ListQuery,
  type ListResult,
  type Message,
  type Platform,
  type PurgePreview,
  type PurgeResult,
  type SidebarData,
  type SortKey,
} from '../shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TRASH_RETENTION_DAYS = 14;
/** Bump when an importer learns to keep more of a conversation: older reads are then redone once. */
/** A chat not updated for this long is only re-read if the platform reports a change. */
export const STALE_AFTER_MS = 60 * 24 * 3600 * 1000;
export const PARSE_VERSION = 2;

const LIVE_STATES = ['inbox', 'archived'] as const;

/** ORDER BY for each sort choice. Titles sort ignoring case; a tie is broken by id so paging is stable. */
const SORT_SQL: Record<SortKey, string> = {
  updated_desc: 'c.remote_updated_at DESC',
  updated_asc: 'c.remote_updated_at ASC',
  created_desc: 'c.created_at DESC',
  created_asc: 'c.created_at ASC',
  title_asc: 'c.title COLLATE NOCASE ASC',
  title_desc: 'c.title COLLATE NOCASE DESC',
  messages_desc: 'c.message_count DESC',
  messages_asc: 'c.message_count ASC',
};

/** Titles that say nothing. Lower-case, compared with the trimmed current title. */
export const GENERIC_TITLES = [
  'new chat',
  'new conversation',
  'untitled',
  'untitled session',
  'chat',
  'conversation',
  'test',
  'hello',
  'hi',
  'help',
  'quick question',
  'nuova chat',
  'nuova conversazione',
  'senza titolo',
  'ciao',
  'aiuto',
  'prova',
];

function cleanupClause(kind: CleanupKind): { sql: string; params: string[] } {
  switch (kind) {
    case 'short':
      return { sql: `c.message_count < ${SHORT_CHAT_MESSAGES}`, params: [] };
    case 'untagged':
      return {
        sql: 'NOT EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.conversation_id = c.id)',
        params: [],
      };
    case 'generic':
      return {
        sql: `lower(trim(c.title)) IN (${GENERIC_TITLES.map(() => '?').join(',')})`,
        params: GENERIC_TITLES,
      };
  }
}

export interface NewAccount {
  platform: Platform;
  label: string;
  partition: string;
  identityHint?: string;
  status?: 'ok' | 'needs_attention';
  lastSyncAt?: string | null;
}

export interface NewConversation {
  accountId: number;
  remoteId: string;
  remoteTitle: string;
  /** The title the source shows (e.g. one the user set there). Defaults to `remoteTitle`. On re-import,
   *  a title the user never changed locally follows the source; a locally renamed one is kept. */
  title?: string;
  summary?: string | null;
  projectId?: number | null;
  /** Local sources: the session's working directory. */
  cwd?: string | null;
  state?: 'inbox' | 'archived';
  createdAt: string;
  remoteUpdatedAt: string;
  messages: { role: 'user' | 'assistant'; blocks: ContentBlock[]; createdAt: string }[];
  tags?: string[];
  /** Images referenced by the conversation. They are downloaded separately; a re-import keeps their state. */
  images?: {
    ref: string;
    kind: 'generated' | 'uploaded';
    alt?: string;
    width?: number;
    height?: number;
  }[];
}

type Row = Record<string, unknown>;

/** Separates tag names inside the group_concat in SELECT_SUMMARY (ASCII unit separator, char(31)). */
const TAG_SEPARATOR = String.fromCharCode(31);

const SELECT_SUMMARY = `
  SELECT c.id, a.platform, c.account_id, a.label AS account_label,
         c.project_id, p.name AS project_name,
         c.title, c.remote_title, c.preview, c.state, c.trash_purge_at,
         c.message_count, c.remote_updated_at,
         (SELECT group_concat(t.name, char(31))
            FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id
           WHERE ct.conversation_id = c.id) AS tags,
         (SELECT CASE WHEN SUM(q.status IN ('pending','running')) > 0 THEN 'pending'
                      WHEN SUM(q.status = 'failed') > 0 THEN 'failed' ELSE 'idle' END
            FROM action_queue q
           WHERE q.conversation_id = c.id AND q.status IN ('pending','running','failed')) AS remote_sync
    FROM conversations c
    JOIN accounts a ON a.id = c.account_id
    LEFT JOIN projects p ON p.id = c.project_id`;

function toSummary(r: Row): ChatSummary {
  return {
    id: r.id as number,
    platform: r.platform as Platform,
    accountId: r.account_id as number,
    accountLabel: r.account_label as string,
    projectId: (r.project_id as number | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    title: r.title as string,
    remoteTitle: r.remote_title as string,
    preview: stripMarkdown(r.preview as string),
    state: r.state as ChatState,
    trashPurgeAt: (r.trash_purge_at as string | null) ?? null,
    tags: r.tags ? (r.tags as string).split(TAG_SEPARATOR).sort((a, b) => a.localeCompare(b)) : [],
    messageCount: r.message_count as number,
    updatedAt: r.remote_updated_at as string,
    remoteSync: ((r.remote_sync as string | null) ?? 'idle') as ChatSummary['remoteSync'],
  };
}

/** Turns free text into a safe FTS5 query: every word is a quoted prefix term, all must match. */
export function toFtsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length === 0) return null;
  return words.map((w) => `"${w}"*`).join(' ');
}

function blocksToText(blocks: ContentBlock[]): string {
  return blocks.map((b) => (b.type === 'image' ? (b.alt ?? '') : b.text)).join('\n');
}

export class Repo {
  constructor(
    readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------- settings ----------

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  get trashRetentionDays(): number {
    const raw = Number(this.getSetting('trash_retention_days'));
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_TRASH_RETENTION_DAYS;
  }

  // ---------- writes used by fixtures and connectors ----------

  /** A profile name is free text (e.g. a client), unique per platform, ignoring case. */
  private assertLabelFree(platform: Platform, label: string, exceptId?: number): string {
    const clean = accountLabelSchema.parse(label);
    const clash = this.db
      .prepare(
        'SELECT id FROM accounts WHERE platform = ? AND label = ? COLLATE NOCASE AND id != ?',
      )
      .get(platform, clean, exceptId ?? -1);
    if (clash) throw new Error(`You already have a profile called “${clean}” on this platform.`);
    return clean;
  }

  addAccount(a: NewAccount): number {
    const label = this.assertLabelFree(a.platform, a.label);
    const res = this.db
      .prepare(
        `INSERT INTO accounts (platform, label, identity_hint, partition, status, last_sync_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts))`,
      )
      .run(
        a.platform,
        label,
        a.identityHint ?? null,
        a.partition,
        a.status ?? 'ok',
        a.lastSyncAt ?? null,
      );
    return Number(res.lastInsertRowid);
  }

  /** Whether the user allowed this app to change things on the platform for this profile (off by default). */
  allowsChanges(accountId: number): boolean {
    const row = this.db
      .prepare('SELECT allow_remote_changes FROM accounts WHERE id = ?')
      .get(accountId) as { allow_remote_changes: number } | undefined;
    return row?.allow_remote_changes === 1;
  }

  setAllowChanges(accountId: number, allowed: boolean): boolean {
    const res = this.db
      .prepare('UPDATE accounts SET allow_remote_changes = ? WHERE id = ?')
      .run(allowed ? 1 : 0, accountId);
    return Number(res.changes) > 0;
  }

  /** What is needed to act on a conversation at its source. Null for one that no longer exists here. */
  conversationRemote(conversationId: number): {
    accountId: number;
    platform: Platform;
    remoteId: string;
    state: ChatState;
    title: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT c.account_id, a.platform, c.remote_id, c.state, c.title
           FROM conversations c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?`,
      )
      .get(conversationId) as
      | {
          account_id: number;
          platform: Platform;
          remote_id: string;
          state: ChatState;
          title: string;
        }
      | undefined;
    return row
      ? {
          accountId: row.account_id,
          platform: row.platform,
          remoteId: row.remote_id,
          state: row.state,
          title: row.title,
        }
      : null;
  }

  private platformOrder(): Platform[] {
    try {
      const raw = JSON.parse(this.getSetting('platform_order') ?? '[]') as unknown;
      return Array.isArray(raw)
        ? (raw.filter((p) => PLATFORMS.includes(p as Platform)) as Platform[])
        : [];
    } catch {
      return [];
    }
  }

  /** Puts a platform's profiles in the given order. The list must contain exactly that platform's profiles. */
  reorderAccounts(platform: Platform, orderedIds: number[]): void {
    const ids = this.db
      .prepare('SELECT id FROM accounts WHERE platform = ?')
      .all(platform)
      .map((r) => (r as { id: number }).id);
    if (
      orderedIds.length !== ids.length ||
      new Set(orderedIds).size !== ids.length ||
      !orderedIds.every((id) => ids.includes(id))
    ) {
      throw new Error('That is not the list of this platform’s profiles.');
    }
    inTransaction(this.db, () => {
      // Keep the group where it is among the other platforms: reuse the same set of positions.
      const slots = (
        this.db
          .prepare('SELECT sort_order FROM accounts WHERE platform = ? ORDER BY sort_order, id')
          .all(platform) as {
          sort_order: number;
        }[]
      ).map((r) => r.sort_order);
      const set = this.db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ?');
      orderedIds.forEach((id, i) => set.run(slots[i] as number, id));
    });
  }

  /** The order platforms are shown in. Unknown or repeated platforms are rejected. */
  reorderPlatforms(order: Platform[]): void {
    if (new Set(order).size !== order.length || !order.every((p) => PLATFORMS.includes(p))) {
      throw new Error('That is not a valid list of platforms.');
    }
    this.setSetting('platform_order', JSON.stringify(order));
  }

  renameAccount(id: number, label: string): boolean {
    const row = this.db.prepare('SELECT platform FROM accounts WHERE id = ?').get(id) as
      { platform: Platform } | undefined;
    if (!row) return false;
    const clean = this.assertLabelFree(row.platform, label, id);
    this.db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(clean, id);
    return true;
  }

  upsertProject(accountId: number, remoteId: string, name: string): number {
    this.db
      .prepare(
        'INSERT INTO projects (account_id, remote_id, name) VALUES (?, ?, ?) ON CONFLICT(account_id, remote_id) DO UPDATE SET name = excluded.name',
      )
      .run(accountId, remoteId, name);
    const row = this.db
      .prepare('SELECT id FROM projects WHERE account_id = ? AND remote_id = ?')
      .get(accountId, remoteId) as { id: number };
    return row.id;
  }

  /** Inserts or updates a conversation and replaces its messages and search index entry. */
  upsertConversation(c: NewConversation): number {
    return inTransaction(this.db, () => {
      const existing = this.db
        .prepare(
          'SELECT id, title, source_title FROM conversations WHERE account_id = ? AND remote_id = ?',
        )
        .get(c.accountId, c.remoteId) as
        { id: number; title: string; source_title: string | null } | undefined;
      const sourceTitle = c.title ?? c.remoteTitle;

      const firstAssistant = c.messages.find((m) => m.role === 'assistant');
      const previewSource = firstAssistant?.blocks.find((b) => b.type === 'text')?.text ?? '';
      const preview = stripMarkdown(previewSource).slice(0, 160);
      const nowIso = this.now().toISOString();

      let id: number;
      if (existing) {
        id = existing.id;
        const untouched = existing.title === (existing.source_title ?? existing.title);
        const title = untouched ? sourceTitle : existing.title;
        this.db
          .prepare(
            `UPDATE conversations SET remote_title = ?, title = ?, source_title = ?, summary = COALESCE(?, summary),
               preview = ?, project_id = ?, cwd = COALESCE(?, cwd), parse_version = ?, message_count = ?, updated_at = ?, remote_updated_at = ?
             WHERE id = ?`,
          )
          .run(
            c.remoteTitle,
            title,
            sourceTitle,
            c.summary ?? null,
            preview,
            c.projectId ?? null,
            c.cwd ?? null,
            PARSE_VERSION,
            c.messages.length,
            nowIso,
            c.remoteUpdatedAt,
            id,
          );
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      } else {
        const res = this.db
          .prepare(
            `INSERT INTO conversations
               (account_id, remote_id, remote_title, title, source_title, summary, preview, project_id,
                cwd, parse_version, state, message_count, created_at, updated_at, remote_updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            c.accountId,
            c.remoteId,
            c.remoteTitle,
            sourceTitle,
            sourceTitle,
            c.summary ?? null,
            preview,
            c.projectId ?? null,
            c.cwd ?? null,
            PARSE_VERSION,
            c.state ?? 'inbox',
            c.messages.length,
            c.createdAt,
            nowIso,
            c.remoteUpdatedAt,
          );
        id = Number(res.lastInsertRowid);
      }

      const insertMsg = this.db.prepare(
        'INSERT INTO messages (conversation_id, role, content_json, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const m of c.messages) {
        insertMsg.run(id, m.role, JSON.stringify(m.blocks), m.createdAt);
      }
      const addImage = this.db.prepare(
        `INSERT INTO media (conversation_id, ref, kind, alt, width, height, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id, ref) DO UPDATE SET alt = COALESCE(excluded.alt, media.alt),
           width = COALESCE(excluded.width, media.width), height = COALESCE(excluded.height, media.height)`,
      );
      for (const img of c.images ?? []) {
        // Only generated images are downloaded; the ones the user uploaded stay a placeholder.
        addImage.run(
          id,
          img.ref,
          img.kind,
          img.alt ?? null,
          img.width ?? null,
          img.height ?? null,
          img.kind === 'generated' ? 'pending' : 'skipped',
          nowIso,
        );
      }
      for (const tag of c.tags ?? []) this.linkTag(id, tag);
      this.reindex(id, c.messages.map((m) => blocksToText(m.blocks)).join('\n'));
      return id;
    });
  }

  private reindex(id: number, body: string): void {
    const row = this.db
      .prepare('SELECT title, remote_title, summary FROM conversations WHERE id = ?')
      .get(id) as { title: string; remote_title: string; summary: string | null };
    this.db.prepare('DELETE FROM conversations_fts WHERE rowid = ?').run(id);
    this.db
      .prepare(
        'INSERT INTO conversations_fts (rowid, title, remote_title, summary, body) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, row.title, row.remote_title, row.summary ?? '', body);
  }

  private bodyOf(id: number): string {
    const rows = this.db
      .prepare('SELECT content_json FROM messages WHERE conversation_id = ? ORDER BY id')
      .all(id) as { content_json: string }[];
    return rows.map((r) => blocksToText(JSON.parse(r.content_json) as ContentBlock[])).join('\n');
  }

  private linkTag(conversationId: number, tag: string): boolean {
    const name = tag.trim();
    this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    const t = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number };
    const res = this.db
      .prepare('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)')
      .run(conversationId, t.id);
    return Number(res.changes) > 0;
  }

  // ---------- accounts, sync bookkeeping ----------

  findAccountId(partition: string): number | null {
    const row = this.db.prepare('SELECT id FROM accounts WHERE partition = ?').get(partition) as
      { id: number } | undefined;
    return row?.id ?? null;
  }

  getAccount(
    id: number,
  ): { id: number; platform: Platform; partition: string; identity: string | null } | null {
    const row = this.db
      .prepare('SELECT id, platform, partition, identity_hint FROM accounts WHERE id = ?')
      .get(id) as
      | { id: number; platform: Platform; partition: string; identity_hint: string | null }
      | undefined;
    return row
      ? {
          id: row.id,
          platform: row.platform,
          partition: row.partition,
          identity: row.identity_hint,
        }
      : null;
  }

  /** Marks sync runs that were still "running" when the app stopped as interrupted (they can never finish). */
  closeStaleSyncRuns(): number {
    const res = this.db
      .prepare(
        "UPDATE sync_runs SET status = 'failed', finished_at = ?, stats_json = json_set(CASE WHEN json_valid(stats_json) THEN stats_json ELSE '{}' END, '$.errors', json('[\"The app was closed during the previous sync.\"]')) WHERE status = 'running'",
      )
      .run(this.now().toISOString());
    return Number(res.changes);
  }

  /** True if the user deleted this conversation for good from the app: a sync must not bring it back. */
  isIgnored(accountId: number, remoteId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM ignored_conversations WHERE account_id = ? AND remote_id = ?')
        .get(accountId, remoteId) !== undefined
    );
  }

  /** What deleting these chats now would remove: only chats in the Trash count. */
  purgePreview(ids: number[]): PurgePreview {
    const unique = [...new Set(ids)];
    const marks = unique.map(() => '?').join(',') || 'NULL';
    const rows = this.db
      .prepare(
        `SELECT a.platform AS platform, a.label AS label, COUNT(*) AS n
           FROM conversations c JOIN accounts a ON a.id = c.account_id
          WHERE c.id IN (${marks}) AND c.state = 'trashed_local'
          GROUP BY a.id ORDER BY a.platform, a.label`,
      )
      .all(...unique) as { platform: Platform; label: string; n: number }[];
    return {
      count: rows.reduce((n, r) => n + r.n, 0),
      accounts: rows.map((r) => ({ platform: r.platform, label: r.label, count: r.n })),
    };
  }

  /**
   * Removes chats that are in the Trash from this app for good, together with their messages, tags and image
   * records. Nothing is changed at the source: the conversation stays on ChatGPT (or wherever it came from), and
   * is remembered so that a sync does not import it again. Chats that are not in the Trash are never touched.
   * Returns the files (images) that were attached, so the caller can delete them from disk.
   */
  purge(ids: number[]): PurgeResult & { mediaPaths: string[]; mediaIds: number[] } {
    const unique = [...new Set(ids)];
    const mediaPaths: string[] = [];
    const mediaIds: number[] = [];
    let removed = 0;
    inTransaction(this.db, () => {
      const get = this.db.prepare(
        'SELECT account_id, remote_id, state FROM conversations WHERE id = ?',
      );
      const media = this.db.prepare('SELECT id, local_path FROM media WHERE conversation_id = ?');
      const ignore = this.db.prepare(
        'INSERT OR IGNORE INTO ignored_conversations (account_id, remote_id, removed_at) VALUES (?, ?, ?)',
      );
      for (const id of unique) {
        const row = get.get(id) as
          { account_id: number; remote_id: string; state: ChatState } | undefined;
        if (!row || row.state !== 'trashed_local') continue;
        for (const m of media.all(id) as { id: number; local_path: string | null }[]) {
          mediaIds.push(m.id);
          if (m.local_path) mediaPaths.push(m.local_path);
        }
        ignore.run(row.account_id, row.remote_id, this.now().toISOString());
        this.db.prepare('DELETE FROM conversations_fts WHERE rowid = ?').run(id);
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id); // messages, tags, media: cascade
        removed++;
      }
      // Tags nobody uses any more.
      this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM conversation_tags)');
    });
    return { removed, skipped: unique.length - removed, mediaPaths, mediaIds };
  }

  /** Purges whatever has been in the Trash for longer than the retention period. */
  purgeExpired(): PurgeResult & { mediaPaths: string[]; mediaIds: number[] } {
    const due = (
      this.db
        .prepare(
          "SELECT id FROM conversations WHERE state = 'trashed_local' AND trash_purge_at <= ?",
        )
        .all(this.now().toISOString()) as { id: number }[]
    ).map((r) => r.id);
    return due.length ? this.purge(due) : { removed: 0, skipped: 0, mediaPaths: [], mediaIds: [] };
  }

  /**
   * Whether this profile has conversations that must be read again: ones that came out empty, or that an older
   * importer read. A run then walks the whole list instead of stopping at the first unchanged conversation.
   */
  needsFullPass(accountId: number): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM conversations WHERE account_id = ? AND (message_count = 0 OR parse_version < ?) AND remote_updated_at >= ? LIMIT 1',
        )
        .get(accountId, PARSE_VERSION, new Date(Date.now() - STALE_AFTER_MS).toISOString()) !==
      undefined
    );
  }

  /**
   * True if this conversation is already stored and was not changed at the source since. Lets an
   * interrupted sync resume, and a repeated one skip what it already has. A second of tolerance covers
   * sources that report the same time with different precision.
   */
  isUpToDate(accountId: number, remoteId: string, remoteUpdatedAt: string): boolean {
    const row = this.db
      .prepare(
        'SELECT remote_updated_at, message_count, parse_version FROM conversations WHERE account_id = ? AND remote_id = ?',
      )
      .get(accountId, remoteId) as
      { remote_updated_at: string; message_count: number; parse_version: number } | undefined;
    if (!row) return false;
    // A chat nobody has touched for months is not looked at again unless the platform says it changed: it
    // does not change. Newer chats are re-read once if they came out empty or an older importer kept less.
    const recent = Date.parse(row.remote_updated_at) >= Date.now() - STALE_AFTER_MS;
    if (recent && (row.message_count === 0 || row.parse_version < PARSE_VERSION)) return false;
    const stored = Date.parse(row.remote_updated_at);
    const offered = Date.parse(remoteUpdatedAt);
    return Number.isFinite(stored) && Number.isFinite(offered) && stored >= offered - 1000;
  }

  /**
   * The REAL profiles of a platform with the platform's own account id, when it was ever learned.
   * While the synthetic demo is showing, there are none: demo profiles must never be offered as a match.
   */
  profilesOf(platform: Platform): { id: number; label: string; identity: string | null }[] {
    if (this.getSetting('demo_data') === '1') return [];
    return (
      this.db
        .prepare(
          'SELECT id, label, identity_hint FROM accounts WHERE platform = ? ORDER BY sort_order, id',
        )
        .all(platform) as { id: number; label: string; identity_hint: string | null }[]
    ).map((a) => ({ id: a.id, label: a.label, identity: a.identity_hint }));
  }

  /**
   * Points a profile at a new browser session (after the user signed in again) and remembers which
   * platform account it is. Returns the old session name so the caller can wipe it.
   */
  replaceAccountSession(id: number, partition: string, identity: string | null): string | null {
    const old = this.getAccount(id);
    if (!old) return null;
    this.db
      .prepare(
        'UPDATE accounts SET partition = ?, identity_hint = COALESCE(?, identity_hint) WHERE id = ?',
      )
      .run(partition, identity, id);
    return old.partition;
  }

  accountsOf(platform: Platform): { id: number; lastSyncAt: string | null }[] {
    return (
      this.db
        .prepare('SELECT id, last_sync_at FROM accounts WHERE platform = ? ORDER BY id')
        .all(platform) as { id: number; last_sync_at: string | null }[]
    ).map((a) => ({ id: a.id, lastSyncAt: a.last_sync_at }));
  }

  startSyncRun(accountId: number): { id: number; startedAt: string } {
    const startedAt = this.now().toISOString();
    const res = this.db
      .prepare("INSERT INTO sync_runs (account_id, started_at, status) VALUES (?, ?, 'running')")
      .run(accountId, startedAt);
    return { id: Number(res.lastInsertRowid), startedAt };
  }

  finishSyncRun(
    runId: number,
    accountId: number,
    run: { status: 'ok' | 'partial' | 'failed'; startedAt: string; stats: unknown },
  ): void {
    inTransaction(this.db, () => {
      this.db
        .prepare('UPDATE sync_runs SET finished_at = ?, status = ?, stats_json = ? WHERE id = ?')
        .run(this.now().toISOString(), run.status, JSON.stringify(run.stats), runId);
      // last_sync_at is the START of the run, so files changed while it ran are picked up next time.
      this.db
        .prepare(
          'UPDATE accounts SET status = ?, last_sync_at = COALESCE(?, last_sync_at) WHERE id = ?',
        )
        .run(
          run.status === 'ok' ? 'ok' : 'needs_attention',
          run.status === 'failed' ? null : run.startedAt,
          accountId,
        );
    });
  }

  /**
   * Deletes the synthetic demo dataset. Only acts while the `demo_data` flag is set, which is only
   * true while the database holds nothing but demo rows, so it can never touch real data.
   */
  removeDemoData(): boolean {
    if (this.getSetting('demo_data') !== '1') return false;
    inTransaction(this.db, () => {
      this.db.exec('DELETE FROM conversations_fts');
      this.db.exec('DELETE FROM accounts'); // cascades to projects, conversations, messages, links
      this.db.exec('DELETE FROM tags');
      this.setSetting('demo_data', '0');
    });
    return true;
  }

  // ---------- reads ----------

  sidebar(): SidebarData {
    const accounts = this.db
      .prepare(
        'SELECT id, platform, label, status, last_sync_at, allow_remote_changes FROM accounts ORDER BY sort_order, id',
      )
      .all() as Row[];
    const counts = this.db
      .prepare(
        `SELECT account_id,
                SUM(state = 'inbox' AND project_id IS NULL) AS inbox,
                SUM(state = 'archived') AS archived,
                COUNT(*) AS total,
                (SELECT COUNT(*) FROM media m JOIN conversations c2 ON c2.id = m.conversation_id
                  WHERE c2.account_id = conversations.account_id AND c2.state IN ('inbox','archived')
                    AND m.kind = 'generated' AND m.ref NOT LIKE '%#%') AS images
           FROM conversations WHERE state IN ('inbox','archived') GROUP BY account_id`,
      )
      .all() as Row[];
    const projects = this.db
      .prepare(
        `SELECT p.id, p.account_id, p.name,
                (SELECT COUNT(*) FROM conversations c
                  WHERE c.project_id = p.id AND c.state IN ('inbox','archived')) AS count
           FROM projects p ORDER BY p.name COLLATE NOCASE`,
      )
      .all() as Row[];
    const trashed = this.db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE state = 'trashed_local'")
      .get() as { n: number };

    const byPlatform = new Map<Platform, SidebarData['platforms'][number]>();
    let totalChats = 0;
    for (const a of accounts) {
      const c = counts.find((x) => x.account_id === a.id);
      const total = (c?.total as number | undefined) ?? 0;
      const platform = a.platform as Platform;
      const group = byPlatform.get(platform) ?? { platform, total: 0, accounts: [] };
      group.total += total;
      totalChats += total;
      group.accounts.push({
        id: a.id as number,
        platform,
        label: a.label as string,
        status: a.status as 'ok' | 'needs_attention',
        lastSyncAt: (a.last_sync_at as string | null) ?? null,
        total,
        inbox: (c?.inbox as number | undefined) ?? 0,
        archived: (c?.archived as number | undefined) ?? 0,
        images: (c?.images as number | undefined) ?? 0,
        allowChanges: a.allow_remote_changes === 1,
        // What the connector can do is filled in by the api layer, which knows the connectors.
        canWrite: { rename: false, archive: false, delete: false },
        projects: projects
          .filter((p) => p.account_id === a.id)
          .map((p) => ({ id: p.id as number, name: p.name as string, count: p.count as number })),
      });
      byPlatform.set(platform, group);
    }
    const saved = this.platformOrder();
    const groups = [...byPlatform.values()].sort((a, b) => {
      const ia = saved.indexOf(a.platform);
      const ib = saved.indexOf(b.platform);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); // unlisted platforms keep their original relative order
    });
    return {
      demo: this.getSetting('demo_data') === '1',
      totalChats,
      trashed: trashed.n,
      platforms: groups,
    };
  }

  /** Numbers for one platform's dashboard, for one account or for all of them. Live chats only. */
  dashboard(platform: Platform, accountId?: number): DashboardData {
    const accounts = (
      this.db
        .prepare(
          `SELECT a.id, a.label, a.status, a.last_sync_at,
                  (SELECT COUNT(*) FROM conversations c
                    WHERE c.account_id = a.id AND c.state IN ('inbox','archived')) AS total
             FROM accounts a WHERE a.platform = ? ORDER BY a.sort_order, a.id`,
        )
        .all(platform) as Row[]
    ).map((a) => ({
      id: a.id as number,
      label: a.label as string,
      status: a.status as 'ok' | 'needs_attention',
      lastSyncAt: (a.last_sync_at as string | null) ?? null,
      total: a.total as number,
    }));
    const selected =
      accountId !== undefined && accounts.some((a) => a.id === accountId) ? accountId : null;
    const inScope = accounts.filter((a) => selected === null || a.id === selected);
    const ids = inScope.map((a) => a.id);
    const inIds = ids.length > 0 ? ids.map(() => '?').join(',') : 'NULL';
    const live = `c.account_id IN (${inIds}) AND c.state IN ('inbox','archived')`;

    const one = (sql: string, extra: SQLInputValue[] = []): number =>
      (this.db.prepare(sql).get(...ids, ...extra) as { n: number }).n;
    const chats = one(`SELECT COUNT(*) AS n FROM conversations c WHERE ${live}`);
    const inProjects = one(
      `SELECT COUNT(*) AS n FROM conversations c WHERE ${live} AND c.project_id IS NOT NULL`,
    );
    const stats = {
      chats,
      inbox: one(
        `SELECT COUNT(*) AS n FROM conversations c WHERE ${live} AND c.state = 'inbox' AND c.project_id IS NULL`,
      ),
      projects: one(`SELECT COUNT(*) AS n FROM projects p WHERE p.account_id IN (${inIds})`),
      inProjects,
      archived: one(
        `SELECT COUNT(*) AS n FROM conversations c WHERE ${live} AND c.state = 'archived'`,
      ),
      images: one(
        `SELECT COUNT(*) AS n FROM media m JOIN conversations c ON c.id = m.conversation_id
          WHERE ${live} AND m.kind = 'generated' AND m.ref NOT LIKE '%#%'`,
      ),
    };

    // Last 6 calendar months (UTC), oldest first, zero-filled.
    const now = this.now();
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      months.push(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
          .toISOString()
          .slice(0, 7),
      );
    }
    const counts = new Map(
      (
        this.db
          .prepare(
            `SELECT substr(c.created_at, 1, 7) AS m, COUNT(*) AS n FROM conversations c
              WHERE ${live} AND substr(c.created_at, 1, 7) >= ? GROUP BY m`,
          )
          .all(...ids, months[0] as string) as { m: string; n: number }[]
      ).map((r) => [r.m, r.n]),
    );

    const clean = Object.fromEntries(
      CLEANUP_KINDS.map((kind) => {
        const c = cleanupClause(kind);
        return [
          kind,
          one(`SELECT COUNT(*) AS n FROM conversations c WHERE ${live} AND ${c.sql}`, c.params),
        ];
      }),
    ) as Record<CleanupKind, number>;

    // The reason the latest sync of an in-scope profile stopped, if it did not finish cleanly.
    let lastError: string | null = null;
    for (const id of ids) {
      const run = this.db
        .prepare(
          'SELECT status, stats_json FROM sync_runs WHERE account_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(id) as { status: string; stats_json: string } | undefined;
      if (run && (run.status === 'failed' || run.status === 'partial')) {
        try {
          const errors = (JSON.parse(run.stats_json) as { errors?: unknown }).errors;
          if (Array.isArray(errors) && typeof errors[0] === 'string') {
            lastError = errors[0];
            break;
          }
        } catch {
          /* unreadable stats: no reason to show */
        }
      }
    }

    const syncs = inScope.map((a) => a.lastSyncAt).filter((x): x is string => x !== null);
    return {
      platform,
      selectedAccountId: selected,
      accounts: accounts.map(({ id, label, status, total }) => ({ id, label, status, total })),
      lastSyncAt: syncs.length > 0 ? (syncs.sort().at(-1) ?? null) : null,
      needsAttention: inScope.some((a) => a.status === 'needs_attention'),
      lastError,
      recentImages: this.imageRows({ accountIds: ids, limit: 6, offset: 0 }).items,
      stats,
      perMonth: months.map((month) => ({ month, count: counts.get(month) ?? 0 })),
      clean,
    };
  }

  // ---------- images ----------

  private imageRows(q: {
    accountIds?: number[];
    platform?: Platform;
    projectId?: number;
    search?: string;
    sort?: 'newest' | 'oldest';
    limit: number;
    offset: number;
  }): ImageList {
    // References with a `#` are thumbnails of web results, not files of the account: nothing to show.
    const base = [
      "m.kind = 'generated'",
      "m.ref NOT LIKE '%#%'",
      "c.state IN ('inbox','archived')",
    ];
    const params: SQLInputValue[] = [];
    if (q.accountIds) {
      base.push(`a.id IN (${q.accountIds.map(() => '?').join(',') || 'NULL'})`);
      params.push(...q.accountIds);
    }
    if (q.platform) {
      base.push('a.platform = ?');
      params.push(q.platform);
    }
    const join =
      'FROM media m JOIN conversations c ON c.id = m.conversation_id JOIN accounts a ON a.id = c.account_id LEFT JOIN projects p ON p.id = c.project_id';
    const where = [...base];
    const wparams = [...params];
    if (q.projectId !== undefined) {
      where.push('c.project_id = ?');
      wparams.push(q.projectId);
    }
    // Every word must appear somewhere in the title, the project name or the prompt.
    for (const word of (q.search ?? '').split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = `%${word.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      where.push(
        "(c.title LIKE ? ESCAPE '\\' OR c.remote_title LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR m.alt LIKE ? ESCAPE '\\')",
      );
      wparams.push(like, like, like, like);
    }
    const order = q.sort === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, c.title, a.platform, a.id AS account_id, a.label, m.alt, m.width, m.height,
                p.name AS project_name, c.remote_updated_at
           ${join} WHERE ${where.join(' AND ')}
          ORDER BY c.remote_updated_at ${order}, m.id ${order} LIMIT ? OFFSET ?`,
      )
      .all(...wparams, q.limit, q.offset) as Row[];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n ${join} WHERE ${where.join(' AND ')}`)
        .get(...wparams) as { n: number }
    ).n;
    const projects = (
      this.db
        .prepare(
          `SELECT p.id, p.name, COUNT(*) AS n ${join}
            WHERE ${base.join(' AND ')} AND c.project_id IS NOT NULL
            GROUP BY p.id ORDER BY p.name COLLATE NOCASE`,
        )
        .all(...params) as Row[]
    ).map((r) => ({ id: r.id as number, name: r.name as string, count: r.n as number }));
    return {
      total,
      projects,
      items: rows.map((r) => ({
        id: r.id as number,
        conversationId: r.conversation_id as number,
        chatTitle: r.title as string,
        platform: r.platform as Platform,
        accountId: r.account_id as number,
        accountLabel: r.label as string,
        alt: (r.alt as string | null) ?? null,
        width: (r.width as number | null) ?? null,
        height: (r.height as number | null) ?? null,
        projectName: (r.project_name as string | null) ?? null,
        date: r.remote_updated_at as string,
      })),
    };
  }

  /**
   * Suggestions for the image search box: project names and chat titles that contain what was typed, and that
   * have images, most relevant (starting with it) first.
   */
  imageSuggestions(
    text: string,
    scope: { accountIds?: number[]; platform?: Platform } = {},
  ): string[] {
    const needle = text.trim();
    if (!needle) return [];
    const where = [
      "m.kind = 'generated'",
      "m.ref NOT LIKE '%#%'",
      "c.state IN ('inbox','archived')",
    ];
    const params: SQLInputValue[] = [];
    if (scope.accountIds) {
      where.push(`a.id IN (${scope.accountIds.map(() => '?').join(',') || 'NULL'})`);
      params.push(...scope.accountIds);
    }
    if (scope.platform) {
      where.push('a.platform = ?');
      params.push(scope.platform);
    }
    const like = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT name FROM (
           SELECT p.name AS name FROM media m JOIN conversations c ON c.id = m.conversation_id
             JOIN accounts a ON a.id = c.account_id JOIN projects p ON p.id = c.project_id
            WHERE ${where.join(' AND ')} AND p.name LIKE ? ESCAPE '\\'
           UNION
           SELECT c.title AS name FROM media m JOIN conversations c ON c.id = m.conversation_id
             JOIN accounts a ON a.id = c.account_id
            WHERE ${where.join(' AND ')} AND c.title LIKE ? ESCAPE '\\'
         ) ORDER BY (name LIKE ? ESCAPE '\\') DESC, length(name) LIMIT 8`,
      )
      .all(...params, like, ...params, like, `${like.slice(1)}`) as Row[];
    return rows.map((r) => r.name as string);
  }

  /** Generated images saved on this Mac, newest chats first, for the whole app or one platform/profile. */
  listImages(query: ImageQuery = {}): ImageList {
    const q = imageQuerySchema.parse(query);
    return this.imageRows({
      ...(q.accountId !== undefined ? { accountIds: [q.accountId] } : {}),
      ...(q.platform ? { platform: q.platform } : {}),
      ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
      ...(q.search ? { search: q.search } : {}),
      sort: q.sort,
      limit: q.limit,
      offset: q.offset,
    });
  }

  /** The stored file of an image, for showing it. Only images that are on disk. */
  mediaFile(id: number): { path: string; mime: string } | null {
    const row = this.db
      .prepare(
        "SELECT local_path, mime FROM media WHERE id = ? AND status = 'done' AND local_path IS NOT NULL",
      )
      .get(id) as { local_path: string; mime: string | null } | undefined;
    return row ? { path: row.local_path, mime: row.mime ?? 'application/octet-stream' } : null;
  }

  /** What is needed to ask the platform for a fresh link to an image: which profile, which chat, which file. */
  mediaSource(id: number): {
    ref: string;
    accountId: number;
    conversationRemoteId: string;
    stored: boolean;
  } | null {
    const row = this.db
      .prepare(
        `SELECT m.ref, m.status, c.account_id, c.remote_id
           FROM media m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`,
      )
      .get(id) as
      { ref: string; status: string; account_id: number; remote_id: string } | undefined;
    return row
      ? {
          ref: row.ref,
          accountId: row.account_id,
          conversationRemoteId: row.remote_id,
          stored: row.status === 'done',
        }
      : null;
  }

  /** Images still to download for a profile, newest chats first. Gives up on one after 3 failed attempts. */
  pendingImages(
    accountId: number,
    limit: number,
  ): { id: number; ref: string; conversationRemoteId: string }[] {
    return (
      this.db
        .prepare(
          `SELECT m.id, m.ref, c.remote_id
             FROM media m JOIN conversations c ON c.id = m.conversation_id
            WHERE c.account_id = ? AND m.kind = 'generated' AND m.status = 'pending' AND m.attempts < 3
              AND c.state IN ('inbox','archived')
            ORDER BY c.remote_updated_at DESC, m.id DESC LIMIT ?`,
        )
        .all(accountId, limit) as { id: number; ref: string; remote_id: string }[]
    ).map((r) => ({ id: r.id, ref: r.ref, conversationRemoteId: r.remote_id }));
  }

  markImageDone(
    id: number,
    file: { path: string; sha256: string; mime: string; bytes: number },
  ): void {
    this.db
      .prepare(
        "UPDATE media SET status = 'done', local_path = ?, sha256 = ?, mime = ?, bytes = ?, last_error = NULL WHERE id = ?",
      )
      .run(file.path, file.sha256, file.mime, file.bytes, id);
  }

  /** Records a failed attempt. `giveUp` marks it failed for good (e.g. the file no longer exists). */
  markImageFailed(id: number, reason: string, giveUp: boolean): void {
    this.db
      .prepare(
        `UPDATE media SET attempts = attempts + 1, last_error = ?,
                status = CASE WHEN ? OR attempts + 1 >= 3 THEN 'failed' ELSE status END WHERE id = ?`,
      )
      .run(reason.slice(0, 200), giveUp ? 1 : 0, id);
  }

  filterOptions(): FilterOptions {
    const accounts = this.db
      .prepare('SELECT id, platform, label FROM accounts ORDER BY sort_order, id')
      .all() as unknown as FilterOptions['accounts'];
    const projects = (
      this.db
        .prepare('SELECT id, account_id, name FROM projects ORDER BY name COLLATE NOCASE')
        .all() as Row[]
    ).map((p) => ({
      id: p.id as number,
      accountId: p.account_id as number,
      name: p.name as string,
    }));
    const tags = (
      this.db.prepare('SELECT name FROM tags ORDER BY name COLLATE NOCASE').all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    return { accounts, projects, tags };
  }

  private buildWhere(q: ReturnType<typeof listQuerySchema.parse>): {
    joins: string;
    where: string;
    params: SQLInputValue[];
    order: string;
    searching: boolean;
  } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const states = q.view === 'trash' ? ['trashed_local'] : [...LIVE_STATES];
    where.push(`c.state IN (${states.map(() => '?').join(',')})`);
    params.push(...states);

    if (q.platform) {
      where.push('a.platform = ?');
      params.push(q.platform);
    }
    if (q.accountId !== undefined) {
      where.push('c.account_id = ?');
      params.push(q.accountId);
    }
    if (q.scope === 'inbox') where.push("c.state = 'inbox' AND c.project_id IS NULL");
    if (q.scope === 'archive') where.push("c.state = 'archived'");
    if (q.projectId !== undefined) {
      where.push('c.project_id = ?');
      params.push(q.projectId);
    }
    if (q.tag) {
      where.push(
        `EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id
                  WHERE ct.conversation_id = c.id AND t.name = ?)`,
      );
      params.push(q.tag);
    }

    if (q.cleanup) {
      const c = cleanupClause(q.cleanup);
      where.push(c.sql);
      params.push(...c.params);
    }

    let joins = '';
    let order =
      q.view === 'trash' ? 'c.trash_purge_at ASC, c.id ASC' : 'c.remote_updated_at DESC, c.id DESC';
    const fts = q.search ? toFtsQuery(q.search) : null;
    if (fts) {
      joins =
        'JOIN (SELECT rowid AS rid, rank FROM conversations_fts WHERE conversations_fts MATCH ?) f ON f.rid = c.id';
      // The FTS parameter appears in the JOIN, before the WHERE parameters.
      params.unshift(fts);
      order = 'f.rank, c.remote_updated_at DESC';
    }
    // An explicit sort wins over the default (best match while searching, newest otherwise).
    if (q.sort) order = `${SORT_SQL[q.sort]}, c.id DESC`;
    return { joins, where: where.join(' AND '), params, order, searching: fts !== null };
  }

  listChats(query: ListQuery = {}): ListResult {
    const q = listQuerySchema.parse(query);
    const { joins, where, params, order } = this.buildWhere(q);
    const from = `${SELECT_SUMMARY} ${joins}`;
    const items = (
      this.db
        .prepare(`${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...params, q.limit, q.offset) as Row[]
    ).map(toSummary);
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM conversations c JOIN accounts a ON a.id = c.account_id ${joins} WHERE ${where}`,
        )
        .get(...params) as { n: number }
    ).n;
    return { items, total };
  }

  /** Every id matching the query (ignores paging). Backs "Select all N". */
  chatIds(query: ListQuery = {}): number[] {
    const q = listQuerySchema.parse(query);
    const { joins, where, params, order } = this.buildWhere(q);
    return (
      this.db
        .prepare(
          `SELECT c.id FROM conversations c JOIN accounts a ON a.id = c.account_id ${joins} WHERE ${where} ORDER BY ${order}`,
        )
        .all(...params) as { id: number }[]
    ).map((r) => r.id);
  }

  getChat(id: number): ChatDetail | null {
    const row = this.db.prepare(`${SELECT_SUMMARY} WHERE c.id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    const extra = this.db
      .prepare('SELECT summary, created_at, remote_id, cwd FROM conversations WHERE id = ?')
      .get(id) as {
      summary: string | null;
      created_at: string;
      remote_id: string;
      cwd: string | null;
    };
    const mediaByRef = new Map(
      (
        this.db
          .prepare('SELECT id, ref, status, kind FROM media WHERE conversation_id = ?')
          .all(id) as {
          id: number;
          ref: string;
          status: MediaStatus;
          kind: string;
        }[]
      ).map((m) => [m.ref, m]),
    );
    const withMedia = (b: ContentBlock): ContentBlock => {
      if (b.type !== 'image') return b;
      const m = mediaByRef.get(b.ref);
      return {
        ...b,
        mediaId: m && m.kind === 'generated' && !m.ref.includes('#') ? m.id : null,
        status: m?.status ?? 'pending',
      };
    };
    const messages: Message[] = (
      this.db
        .prepare(
          'SELECT id, role, content_json, created_at FROM messages WHERE conversation_id = ? AND is_active_branch = 1 ORDER BY id',
        )
        .all(id) as Row[]
    ).map((m) => ({
      id: m.id as number,
      role: m.role as 'user' | 'assistant',
      blocks: (JSON.parse(m.content_json as string) as ContentBlock[]).map(withMedia),
      createdAt: m.created_at as string,
    }));
    const base = toSummary(row);
    return {
      ...base,
      summary: extra.summary,
      createdAt: extra.created_at,
      remoteId: extra.remote_id,
      resumeCommand: resumeCommand(base.platform, extra.remote_id, extra.cwd),
      messages,
    };
  }

  // ---------- local edits ----------

  /**
   * Bulk action on local state. Nothing here talks to a platform: the caller/UI must present
   * these as local-only. Chats already in the target state are skipped.
   */
  bulk(ids: number[], action: BulkAction): BulkResult {
    const unique = [...new Set(ids)];
    const changedIds: number[] = [];
    inTransaction(this.db, () => {
      const get = this.db.prepare('SELECT state FROM conversations WHERE id = ?');
      for (const id of unique) {
        const row = get.get(id) as { state: ChatState } | undefined;
        if (!row) continue;
        if (this.applyOne(id, row.state, action)) changedIds.push(id);
      }
    });
    return { changed: changedIds.length, skipped: unique.length - changedIds.length, changedIds };
  }

  private applyOne(id: number, state: ChatState, action: BulkAction): boolean {
    const nowIso = this.now().toISOString();
    switch (action.type) {
      case 'archive':
        if (state !== 'inbox') return false;
        this.db
          .prepare("UPDATE conversations SET state = 'archived', updated_at = ? WHERE id = ?")
          .run(nowIso, id);
        return true;
      case 'unarchive':
        if (state !== 'archived') return false;
        this.db
          .prepare("UPDATE conversations SET state = 'inbox', updated_at = ? WHERE id = ?")
          .run(nowIso, id);
        return true;
      case 'trash': {
        if (state !== 'inbox' && state !== 'archived') return false;
        const purgeAt = new Date(
          this.now().getTime() + this.trashRetentionDays * DAY_MS,
        ).toISOString();
        this.db
          .prepare(
            "UPDATE conversations SET state = 'trashed_local', state_before_trash = ?, trash_purge_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(state, purgeAt, nowIso, id);
        return true;
      }
      case 'restore':
        if (state !== 'trashed_local') return false;
        this.db
          .prepare(
            "UPDATE conversations SET state = COALESCE(state_before_trash, 'inbox'), state_before_trash = NULL, trash_purge_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run(nowIso, id);
        return true;
      case 'tag':
        if (state === 'deleted_remote') return false;
        return this.linkTag(id, action.tag);
    }
  }

  setTitle(id: number, title: string): boolean {
    const clean = title.trim().slice(0, 300);
    if (!clean) return false;
    return inTransaction(this.db, () => {
      const res = this.db
        .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
        .run(clean, this.now().toISOString(), id);
      if (Number(res.changes) === 0) return false;
      this.reindex(id, this.bodyOf(id));
      return true;
    });
  }

  removeTag(id: number, tag: string): void {
    this.db
      .prepare(
        `DELETE FROM conversation_tags WHERE conversation_id = ?
           AND tag_id = (SELECT id FROM tags WHERE name = ?)`,
      )
      .run(id, tag);
  }
}
