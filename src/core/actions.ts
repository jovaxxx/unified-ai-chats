import { EndpointChanged, NotFound, RateLimited, SessionExpired } from '../connectors/errors';
import type { AccountContext, Connector } from '../connectors/types';
import type {
  ActionItem,
  ActionStatus,
  ActionType,
  DeletePlan,
  Platform,
  QueueSummary,
} from '../shared/types';
import { exportConversation, type ExportDeps } from './exporter';
import type { Repo } from './repo';

type Row = Record<string, unknown>;

export interface EnqueueInput {
  accountId: number;
  conversationId: number;
  remoteId: string;
  type: ActionType;
  payload?: { title?: string; chatTitle?: string };
}

const MAX_ATTEMPTS = 4;
/** After a rate limit or a temporary error: wait this long before the next try, growing each time. */
const BACKOFF_MS = [30_000, 120_000, 600_000];

/**
 * Changes waiting to be sent to a platform. Durable (a table), so it survives quitting the app; one change is
 * performed at a time; a failing change never blocks the rest.
 */
export class ActionQueue {
  constructor(
    private readonly repo: Repo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get db() {
    return this.repo.db;
  }

  enqueue(input: EnqueueInput): number {
    const nowIso = this.now().toISOString();
    const payload = JSON.stringify(input.payload ?? {});
    const pending = (types: ActionType[]) =>
      this.db
        .prepare(
          `SELECT id FROM action_queue WHERE conversation_id = ? AND status = 'pending' AND type IN (${types.map(() => '?').join(',')})`,
        )
        .all(input.conversationId, ...types) as { id: number }[];

    if (input.type === 'rename') {
      // Renaming twice before the first is sent: only the latest title matters.
      const existing = pending(['rename'])[0];
      if (existing) {
        this.db
          .prepare(
            'UPDATE action_queue SET payload_json = ?, attempts = 0, run_after = NULL, last_error = NULL WHERE id = ?',
          )
          .run(payload, existing.id);
        return existing.id;
      }
    } else if (input.type === 'delete') {
      const existing = pending(['delete'])[0];
      if (existing) return existing.id;
    } else {
      // archive / unarchive: the newest wish replaces an older, unsent one.
      for (const old of pending(['archive', 'unarchive'])) {
        this.db
          .prepare("UPDATE action_queue SET status = 'cancelled', finished_at = ? WHERE id = ?")
          .run(nowIso, old.id);
      }
    }
    const res = this.db
      .prepare(
        `INSERT INTO action_queue (account_id, conversation_id, remote_id, type, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.accountId, input.conversationId, input.remoteId, input.type, payload, nowIso);
    return Number(res.lastInsertRowid);
  }

  /** Withdraws changes that were not sent yet (for example a delete, when the chat is restored from the Trash). */
  cancelPendingFor(conversationId: number, types: ActionType[]): number {
    const res = this.db
      .prepare(
        `UPDATE action_queue SET status = 'cancelled', finished_at = ?
          WHERE conversation_id = ? AND status = 'pending' AND type IN (${types.map(() => '?').join(',')})`,
      )
      .run(this.now().toISOString(), conversationId, ...types);
    return Number(res.changes);
  }

  /** Withdraws everything not yet sent for one profile (when the user turns changes off for it). */
  cancelPendingForAccount(accountId: number): number {
    const res = this.db
      .prepare(
        "UPDATE action_queue SET status = 'cancelled', finished_at = ? WHERE account_id = ? AND status = 'pending'",
      )
      .run(this.now().toISOString(), accountId);
    return Number(res.changes);
  }

  cancelAllPending(): number {
    const res = this.db
      .prepare(
        "UPDATE action_queue SET status = 'cancelled', finished_at = ? WHERE status = 'pending'",
      )
      .run(this.now().toISOString());
    return Number(res.changes);
  }

  /** Puts failed changes back in line (and lifts a block placed after the site changed). */
  retryFailed(): number {
    this.db.prepare("DELETE FROM settings WHERE key LIKE 'write_blocked:%'").run();
    const res = this.db
      .prepare(
        "UPDATE action_queue SET status = 'pending', attempts = 0, run_after = NULL, last_error = NULL, finished_at = NULL WHERE status = 'failed'",
      )
      .run();
    return Number(res.changes);
  }

  /** A change interrupted by quitting the app goes back in line. It is safe to repeat: changes are idempotent. */
  resetRunning(): number {
    const res = this.db
      .prepare("UPDATE action_queue SET status = 'pending' WHERE status = 'running'")
      .run();
    return Number(res.changes);
  }

  get paused(): boolean {
    return this.repo.getSetting('queue_paused') === '1';
  }
  setPaused(paused: boolean): void {
    this.repo.setSetting('queue_paused', paused ? '1' : '0');
  }

  blockedReason(accountId: number): string | null {
    return this.repo.getSetting(`write_blocked:${accountId}`);
  }
  block(accountId: number, reason: string): void {
    this.repo.setSetting(`write_blocked:${accountId}`, reason);
  }

  /** The next change that may run now. */
  next(): {
    id: number;
    accountId: number;
    conversationId: number | null;
    remoteId: string;
    type: ActionType;
    payload: Record<string, unknown>;
    attempts: number;
  } | null {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, conversation_id, remote_id, type, payload_json, attempts FROM action_queue
          WHERE status = 'pending' AND (run_after IS NULL OR run_after <= ?) ORDER BY id LIMIT 50`,
      )
      .all(this.now().toISOString()) as Row[];
    const r = rows.find((x) => !this.blockedReason(x.account_id as number));
    if (!r) return null;
    return {
      id: r.id as number,
      accountId: r.account_id as number,
      conversationId: (r.conversation_id as number | null) ?? null,
      remoteId: r.remote_id as string,
      type: r.type as ActionType,
      payload: JSON.parse((r.payload_json as string) || '{}') as Record<string, unknown>,
      attempts: r.attempts as number,
    };
  }

  /** Whether something is waiting only because of a delay, and when it becomes due. */
  nextDueAt(): string | null {
    const row = this.db
      .prepare(
        "SELECT MIN(run_after) AS t FROM action_queue WHERE status = 'pending' AND run_after IS NOT NULL",
      )
      .get() as { t: string | null };
    return row.t;
  }

  markRunning(id: number): void {
    this.db.prepare("UPDATE action_queue SET status = 'running' WHERE id = ?").run(id);
  }
  markDone(id: number): void {
    this.db
      .prepare(
        "UPDATE action_queue SET status = 'done', last_error = NULL, finished_at = ? WHERE id = ?",
      )
      .run(this.now().toISOString(), id);
  }
  markCancelled(id: number, why: string): void {
    this.db
      .prepare(
        "UPDATE action_queue SET status = 'cancelled', last_error = ?, finished_at = ? WHERE id = ?",
      )
      .run(why, this.now().toISOString(), id);
  }
  /** `retryAt` puts it back in line for later; without it, the change is failed until the user retries. */
  markFailed(
    id: number,
    message: string,
    opts: { retryAt?: Date; countAttempt?: boolean } = {},
  ): void {
    const nowIso = this.now().toISOString();
    if (opts.retryAt) {
      this.db
        .prepare(
          "UPDATE action_queue SET status = 'pending', attempts = attempts + ?, run_after = ?, last_error = ? WHERE id = ?",
        )
        .run(
          opts.countAttempt === false ? 0 : 1,
          opts.retryAt.toISOString(),
          message.slice(0, 300),
          id,
        );
    } else {
      this.db
        .prepare(
          "UPDATE action_queue SET status = 'failed', attempts = attempts + 1, last_error = ?, finished_at = ? WHERE id = ?",
        )
        .run(message.slice(0, 300), nowIso, id);
    }
  }
  setPayload(id: number, patch: Record<string, unknown>): void {
    const row = this.db.prepare('SELECT payload_json FROM action_queue WHERE id = ?').get(id) as
      { payload_json: string } | undefined;
    const merged = { ...(JSON.parse(row?.payload_json ?? '{}') as object), ...patch };
    this.db
      .prepare('UPDATE action_queue SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(merged), id);
  }

  list(limit = 200, statuses?: ActionStatus[]): ActionItem[] {
    const where = statuses?.length
      ? `WHERE q.status IN (${statuses.map(() => '?').join(',')})`
      : '';
    return (
      this.db
        .prepare(
          `SELECT q.id, q.account_id, a.label, a.platform, q.type, q.payload_json, q.status, q.attempts, q.last_error,
                  q.created_at, q.finished_at, q.run_after
             FROM action_queue q JOIN accounts a ON a.id = q.account_id ${where}
            ORDER BY CASE q.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, q.id DESC LIMIT ?`,
        )
        .all(...(statuses ?? []), limit) as Row[]
    ).map((r) => ({
      id: r.id as number,
      accountId: r.account_id as number,
      accountLabel: r.label as string,
      platform: r.platform as Platform,
      type: r.type as ActionType,
      chatTitle:
        (JSON.parse((r.payload_json as string) || '{}') as { chatTitle?: string }).chatTitle ??
        null,
      status: r.status as ActionStatus,
      attempts: r.attempts as number,
      lastError: (r.last_error as string | null) ?? null,
      createdAt: (r.created_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      runAfter: (r.run_after as string | null) ?? null,
    }));
  }

  summary(exportDir: string | null): QueueSummary {
    const count = (status: string) =>
      (
        this.db.prepare('SELECT COUNT(*) AS n FROM action_queue WHERE status = ?').get(status) as {
          n: number;
        }
      ).n;
    return {
      pending: count('pending'),
      running: count('running'),
      failed: count('failed'),
      done: count('done'),
      paused: this.paused,
      needsSignIn: this.repo.getSetting('queue_needs_signin') === '1',
      exportDir,
    };
  }
}

export interface RunnerDeps {
  repo: Repo;
  queue: ActionQueue;
  connectorFor: (platform: Platform) => Connector | undefined;
  /** The signed-in session of a profile, or null if it has none. */
  contextFor: (accountId: number) => AccountContext | null;
  exports: ExportDeps;
  /** Deletes image files after a chat was removed here. */
  removeFiles?: (paths: string[]) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between changes on a platform, plus up to `jitterMs`: sequential and unhurried. */
  paceMs?: number;
  jitterMs?: number;
  now?: () => Date;
}

export interface DrainResult {
  done: number;
  failed: number;
  stoppedFor: 'empty' | 'paused' | 'needs_sign_in' | 'limit';
}

/** Which capability each kind of change needs. */
const NEEDS: Record<ActionType, 'rename' | 'archive' | 'delete'> = {
  rename: 'rename',
  archive: 'archive',
  unarchive: 'archive',
  delete: 'delete',
};

/**
 * Carries the queue out, one change at a time, oldest first.
 *
 * - Nothing is sent for a profile unless the user allowed changes on it, and the connector really supports it.
 * - The signed-in account must be the one the profile was made for, checked before the first change of a run.
 * - A delete first makes a VERIFIED full copy, and only then deletes on the platform, and only then removes the chat here.
 *   If the chat left the Trash meanwhile, nothing is deleted.
 * - A rate limit waits and retries (growing waits); a signed-out session stops the run without using up attempts;
 *   a site that changed stops that profile's changes; anything else is retried a few times, then reported.
 */
export class ActionRunner {
  private running = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly d: RunnerDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? (() => new Date());
  }

  get busy(): boolean {
    return this.running;
  }

  async drain(maxActions = 10_000): Promise<DrainResult> {
    if (this.running) return { done: 0, failed: 0, stoppedFor: 'limit' };
    this.running = true;
    const result: DrainResult = { done: 0, failed: 0, stoppedFor: 'empty' };
    const verified = new Set<number>();
    try {
      for (let n = 0; n < maxActions; n++) {
        if (this.d.queue.paused) {
          result.stoppedFor = 'paused';
          break;
        }
        const item = this.d.queue.next();
        if (!item) break;
        const outcome = await this.perform(item, verified);
        if (outcome === 'done') result.done++;
        else if (outcome === 'failed') result.failed++;
        else if (outcome === 'needs_sign_in') {
          result.stoppedFor = 'needs_sign_in';
          break;
        }
        await this.sleep((this.d.paceMs ?? 1500) + Math.random() * (this.d.jitterMs ?? 1500));
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  private async perform(
    item: NonNullable<ReturnType<ActionQueue['next']>>,
    verified: Set<number>,
  ): Promise<'done' | 'failed' | 'retry' | 'needs_sign_in'> {
    const { repo, queue } = this.d;
    const account = repo.getAccount(item.accountId);
    const connector = account ? this.d.connectorFor(account.platform) : undefined;
    const capability = NEEDS[item.type];

    if (!account) {
      queue.markCancelled(item.id, 'The profile no longer exists.');
      return 'failed';
    }
    if (!repo.allowsChanges(item.accountId)) {
      queue.markFailed(item.id, 'Changes on this platform are turned off for this profile.');
      return 'failed';
    }
    if (!connector || !connector.capabilities[capability] || !connector[capability]) {
      queue.markFailed(item.id, `This app cannot ${item.type} chats on ${account.platform} yet.`);
      return 'failed';
    }
    const ctx = this.d.contextFor(item.accountId);
    if (!ctx) {
      queue.markFailed(item.id, 'This profile is not signed in.', {
        retryAt: new Date(this.now().getTime() + BACKOFF_MS[0]!),
        countAttempt: false,
      });
      repo.setSetting('queue_needs_signin', '1');
      return 'needs_sign_in';
    }

    queue.markRunning(item.id);
    try {
      // Never mix accounts: check who is signed in before the first change for this profile in this run.
      if (!verified.has(item.accountId)) {
        await connector.verifyAccount?.(ctx);
        verified.add(item.accountId);
      }
      await this.execute(item, connector, ctx);
      repo.setSetting('queue_needs_signin', '0');
      queue.markDone(item.id);
      return 'done';
    } catch (err) {
      return this.classify(item, err);
    }
  }

  private async execute(
    item: NonNullable<ReturnType<ActionQueue['next']>>,
    connector: Connector,
    ctx: AccountContext,
  ): Promise<void> {
    const { repo, queue } = this.d;
    switch (item.type) {
      case 'rename': {
        const title = String(item.payload.title ?? '');
        if (!title.trim()) throw new EndpointChanged('A rename without a title cannot be sent.');
        await connector.rename!(ctx, item.remoteId, title);
        return;
      }
      case 'archive':
      case 'unarchive':
        await connector.archive!(ctx, item.remoteId, item.type === 'archive');
        return;
      case 'delete': {
        const convId = item.conversationId;
        const chat = convId === null ? null : repo.conversationRemote(convId);
        if (convId === null || !chat) return; // already gone here: nothing left to do
        if (chat.state !== 'trashed_local') {
          // Restored from the Trash since it was queued: the user changed their mind.
          throw new Cancelled('The chat was restored from the Trash, so it was not deleted.');
        }
        // 1. A verified full copy first. If this fails, nothing is deleted.
        const raw = connector.exportRaw ? await connector.exportRaw(ctx, item.remoteId) : undefined;
        const exported = await exportConversation(repo, convId, raw, this.d.exports);
        queue.setPayload(item.id, { exportPath: exported.folder });
        // 2. Delete on the platform. "Already gone" counts as done.
        try {
          await connector.delete!(ctx, item.remoteId);
        } catch (err) {
          if (!(err instanceof NotFound)) throw err;
        }
        // 3. Only now remove it here.
        const { mediaPaths } = repo.purge([convId]);
        if (mediaPaths.length > 0) await this.d.removeFiles?.(mediaPaths);
        return;
      }
    }
  }

  private classify(
    item: NonNullable<ReturnType<ActionQueue['next']>>,
    err: unknown,
  ): 'failed' | 'retry' | 'needs_sign_in' {
    const { queue, repo } = this.d;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Cancelled) {
      queue.markCancelled(item.id, message);
      return 'failed';
    }
    if (err instanceof SessionExpired) {
      // Not the change's fault: keep it, do not use up an attempt, and stop until the user signs in again.
      queue.markFailed(item.id, message, {
        retryAt: new Date(this.now().getTime() + BACKOFF_MS[0]!),
        countAttempt: false,
      });
      repo.setSetting('queue_needs_signin', '1');
      return 'needs_sign_in';
    }
    if (err instanceof EndpointChanged) {
      // The site no longer behaves as recorded: stop sending anything for this profile until the user retries.
      queue.markFailed(item.id, message);
      queue.block(item.accountId, message);
      return 'failed';
    }
    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      queue.markFailed(item.id, message);
      return 'failed';
    }
    const wait =
      err instanceof RateLimited && err.retryAfterMs
        ? err.retryAfterMs
        : (BACKOFF_MS[item.attempts] ?? BACKOFF_MS.at(-1)!);
    queue.markFailed(item.id, message, { retryAt: new Date(this.now().getTime() + wait) });
    return 'retry';
  }

  /** What deleting these Trash chats on their platforms would do, for the confirmation. */
  plan(ids: number[]): DeletePlan {
    const groups = new Map<
      string,
      DeletePlan['allowed'][number] & { blockedReason?: 'not_allowed' | 'not_supported' }
    >();
    let total = 0;
    for (const id of new Set(ids)) {
      const c = this.d.repo.conversationRemote(id);
      if (!c || c.state !== 'trashed_local') continue;
      total++;
      const accountId = c.accountId;
      const label =
        this.d.repo.filterOptions().accounts.find((a) => a.id === accountId)?.label ?? '';
      const connector = this.d.connectorFor(c.platform);
      const reason: 'not_allowed' | 'not_supported' | undefined =
        !connector?.capabilities.delete || !connector.delete
          ? 'not_supported'
          : !this.d.repo.allowsChanges(accountId)
            ? 'not_allowed'
            : undefined;
      const key = `${accountId}:${reason ?? 'ok'}`;
      const g = groups.get(key) ?? {
        accountId,
        platform: c.platform,
        label,
        count: 0,
        ...(reason ? { blockedReason: reason } : {}),
      };
      g.count++;
      groups.set(key, g);
    }
    const all = [...groups.values()];
    return {
      total,
      allowed: all
        .filter((g) => !g.blockedReason)
        .map(({ accountId, platform, label, count }) => ({ accountId, platform, label, count })),
      blocked: all
        .filter((g) => g.blockedReason)
        .map((g) => ({
          accountId: g.accountId,
          platform: g.platform,
          label: g.label,
          count: g.count,
          reason: g.blockedReason!,
        })),
      exportDir: this.d.exports.dir,
    };
  }
}

/** A change that should quietly not happen (the user changed their mind), not a failure. */
class Cancelled extends Error {}
