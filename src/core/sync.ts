import type { AccountContext, Connector } from '../connectors/types';
import { EndpointChanged, NotFound, SessionExpired } from '../connectors/errors';
import type { SyncStats } from '../shared/types';
import type { Repo } from './repo';

const MAX_REPORTED_ERRORS = 5;
/** The look for deleted chats takes many requests, so it is made at most this often for a profile... */
const REMOVAL_CHECK_EVERY_MS = 10 * 60 * 1000;
/** ...and confirms at most this many chats per run (each is one request); the rest wait for the next run. */
const MAX_CONFIRMED_PER_RUN = 150;
const SINCE_MARGIN_MS = 2000;

/**
 * Pulls new and changed conversations from a connector into the local database.
 *
 * Incremental: only conversations changed after the previous run's START are fetched. Failures are
 * per conversation: one file that no longer parses (EndpointChanged) or vanished (NotFound) is
 * counted and reported, marks the account "needs attention", and does not block the others.
 * Anything unexpected (a bug, a disk error) aborts the run and is rethrown.
 *
 * Conversations that disappear at the source are NOT deleted locally by an ordinary run. When asked to (`checkRemoved`,
 * a sync the user started), the chats the platform no longer has are found and moved to the Trash here, where they stay
 * for the usual days: each one is confirmed by asking the platform for it, and an odd list never causes a clean-up.
 */
export async function syncAccount(
  repo: Repo,
  connector: Connector,
  ctx: AccountContext,
  onProgress?: (p: { phase: 'listing' | 'reading'; done: number; total: number }) => void,
  opts: { checkRemoved?: boolean } = {},
): Promise<SyncStats> {
  const account = repo.accountsOf(connector.id).find((a) => a.id === ctx.accountId);
  if (!account) throw new Error(`Unknown account ${ctx.accountId}`);
  // File timestamps can lag the clock by a few milliseconds, so look back a little: re-reading a file that
  // did not change is harmless, missing one that did is not.
  // A conversation that came out empty last time, or that an older importer read, is read again, so this run must reach it: a full pass over the
  // list (cheap, unchanged conversations are skipped) instead of stopping at the first unchanged one.
  const since =
    account.lastSyncAt && !repo.needsFullPass(ctx.accountId)
      ? new Date(Date.parse(account.lastSyncAt) - SINCE_MARGIN_MS)
      : undefined;
  const run = repo.startSyncRun(ctx.accountId);
  const stats: SyncStats = { seen: 0, imported: 0, failed: 0, errors: [] };
  let filed = 0;

  try {
    // The list is cheap; reading each chat is not. So list first, keep only what is new or changed, and read the
    // most recently changed first: the chats that matter arrive first, the old ones last (or never).
    const queued: { remoteId: string; remoteUpdatedAt: string }[] = [];
    onProgress?.({ phase: 'listing', done: 0, total: 0 });
    for await (const summary of connector.listConversations(ctx, since)) {
      stats.seen++;
      onProgress?.({ phase: 'listing', done: stats.seen, total: 0 });
      // Deleted for good in this app: it still exists at the source, but must not come back.
      if (repo.isIgnored(ctx.accountId, summary.remoteId)) continue;
      // Already stored and unchanged: an interrupted run resumes here instead of starting over.
      if (repo.isUpToDate(ctx.accountId, summary.remoteId, summary.remoteUpdatedAt)) {
        // Already here and unchanged, but the platform says it belongs in a folder it is not in yet.
        if (
          summary.projectRemoteId &&
          summary.projectName &&
          repo.fileInProject(
            ctx.accountId,
            summary.remoteId,
            summary.projectRemoteId,
            summary.projectName,
          )
        ) {
          filed++;
        }
        continue;
      }
      queued.push(summary);
    }
    queued.sort((a, b) => Date.parse(b.remoteUpdatedAt) - Date.parse(a.remoteUpdatedAt));
    let done = 0;
    for (const summary of queued) {
      onProgress?.({ phase: 'reading', done, total: queued.length });
      done++;
      try {
        const c = await connector.getConversation(ctx, summary.remoteId);
        const projectId =
          c.projectRemoteId && c.projectName
            ? repo.upsertProject(ctx.accountId, c.projectRemoteId, c.projectName)
            : null;
        repo.upsertConversation({
          accountId: ctx.accountId,
          remoteId: c.remoteId,
          remoteTitle: c.remoteTitle,
          ...(c.customTitle ? { title: c.customTitle } : {}),
          projectId,
          ...(c.archived ? { state: 'archived' as const } : {}),
          ...(c.cwd ? { cwd: c.cwd } : {}),
          createdAt: c.createdAt,
          remoteUpdatedAt: c.updatedAt,
          messages: c.messages,
          ...(c.images ? { images: c.images } : {}),
        });
        for (const [kind, n] of Object.entries(c.skipped ?? {})) {
          stats.skipped = { ...stats.skipped, [kind]: (stats.skipped?.[kind] ?? 0) + n };
        }
        stats.imported++;
      } catch (err) {
        if (err instanceof EndpointChanged || err instanceof NotFound) {
          stats.failed++;
          if (stats.errors.length < MAX_REPORTED_ERRORS) stats.errors.push(err.message);
        } else {
          throw err;
        }
      }
    }
    onProgress?.({ phase: 'reading', done: queued.length, total: queued.length });
    const listing = connector.notes?.(ctx);
    if (listing && Object.keys(listing).length > 0) stats.listing = listing;
    if (filed > 0) stats.listing = { ...stats.listing, filedInFolder: filed };
    const checkedKey = `removal_check:${ctx.accountId}`;
    const moreKey = `removal_check_more:${ctx.accountId}`;
    const lastCheck = Date.parse(repo.getSetting(checkedKey) ?? '');
    const dueForCheck =
      !Number.isFinite(lastCheck) ||
      Date.now() - lastCheck >= REMOVAL_CHECK_EVERY_MS ||
      repo.getSetting(moreKey) === '1'; // the last run stopped at its limit: go on at once
    if (opts.checkRemoved && connector.listAllIds && dueForCheck) {
      const found = await findRemoved(repo, connector, ctx, onProgress);
      repo.setSetting(checkedKey, new Date().toISOString());
      repo.setSetting(moreKey, found.more ? '1' : '0');
      if (found.removed > 0) stats.removed = found.removed;
      if (found.note) stats.listing = { ...stats.listing, [found.note]: 1 };
    }
  } catch (err) {
    // Keep the reason (our own messages carry ids and statuses, never content) so the app can say why.
    stats.errors.push((err instanceof Error ? err.message : String(err)).slice(0, 300));
    repo.finishSyncRun(run.id, ctx.accountId, {
      status: 'failed',
      startedAt: run.startedAt,
      stats,
    });
    throw err;
  }

  repo.finishSyncRun(run.id, ctx.accountId, {
    status: stats.failed > 0 ? 'partial' : 'ok',
    startedAt: run.startedAt,
    stats,
  });
  return stats;
}

/**
 * The chats of this profile that the platform no longer has, moved to the Trash (where they wait the usual days before
 * going for good). Careful by design: an empty or failed list does nothing, and every candidate is asked for from the
 * platform: only a clear "not found" counts, any other answer leaves the chat where it is. At most
 * `MAX_CONFIRMED_PER_RUN` are confirmed per run; `more` says some are still waiting.
 */
async function findRemoved(
  repo: Repo,
  connector: Connector,
  ctx: AccountContext,
  onProgress?: (p: { phase: 'listing' | 'reading'; done: number; total: number }) => void,
): Promise<{ removed: number; more: boolean; note?: string }> {
  const known = repo.liveRemoteIds(ctx.accountId);
  if (known.length === 0) return { removed: 0, more: false };
  const present = new Set<string>();
  try {
    for await (const id of connector.listAllIds!(ctx)) present.add(id);
  } catch (err) {
    if (err instanceof SessionExpired) throw err;
    return { removed: 0, more: false, note: 'removalCheckFailed' };
  }
  if (present.size === 0) return { removed: 0, more: false, note: 'removalCheckEmptyList' };
  const missing = known.filter((k) => !present.has(k.remoteId));
  if (missing.length === 0) return { removed: 0, more: false };
  const now = missing.slice(0, MAX_CONFIRMED_PER_RUN);
  const gone: number[] = [];
  let done = 0;
  for (const m of now) {
    onProgress?.({ phase: 'reading', done: done++, total: now.length });
    try {
      await connector.getConversation(ctx, m.remoteId);
    } catch (err) {
      if (err instanceof NotFound) gone.push(m.id);
      else if (err instanceof SessionExpired) throw err;
      // Anything else (busy, changed site): not proof of anything, so the chat stays.
    }
  }
  const removed = gone.length > 0 ? repo.bulk(gone, { type: 'trash' }).changed : 0;
  return { removed, more: missing.length > now.length };
}
