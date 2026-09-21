import type { AccountContext, Connector } from '../connectors/types';
import { EndpointChanged, NotFound } from '../connectors/errors';
import type { SyncStats } from '../shared/types';
import type { Repo } from './repo';

const MAX_REPORTED_ERRORS = 5;
const SINCE_MARGIN_MS = 2000;

/**
 * Pulls new and changed conversations from a connector into the local database.
 *
 * Incremental: only conversations changed after the previous run's START are fetched. Failures are
 * per conversation: one file that no longer parses (EndpointChanged) or vanished (NotFound) is
 * counted and reported, marks the account "needs attention", and does not block the others.
 * Anything unexpected (a bug, a disk error) aborts the run and is rethrown.
 *
 * Conversations that disappear at the source are NOT deleted locally.
 */
export async function syncAccount(
  repo: Repo,
  connector: Connector,
  ctx: AccountContext,
  onProgress?: (p: { phase: 'listing' | 'reading'; done: number; total: number }) => void,
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
      if (repo.isUpToDate(ctx.accountId, summary.remoteId, summary.remoteUpdatedAt)) continue;
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
