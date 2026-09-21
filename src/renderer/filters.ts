import type { CleanupKind, ListQuery, Platform, SortKey } from '../shared/types';

/** What the list is showing: a sidebar location plus the filter chips. */
export interface Filters {
  view: 'all' | 'trash';
  platform?: Platform;
  accountId?: number;
  scope?: 'inbox' | 'archive';
  projectId?: number;
  tag?: string;
  cleanup?: CleanupKind;
}

export const ALL_CHATS: Filters = { view: 'all' };

export function isAllChats(f: Filters): boolean {
  return (
    f.view === 'all' &&
    !f.platform &&
    f.accountId === undefined &&
    !f.scope &&
    f.projectId === undefined &&
    !f.tag &&
    !f.cleanup
  );
}

export function toQuery(
  f: Filters,
  search: string,
  limit: number,
  offset = 0,
  sort: SortKey | null = null,
  /** Search across every platform and profile, ignoring where the list is currently scoped. */
  everywhere = false,
): ListQuery {
  if (everywhere && search.trim()) f = ALL_CHATS;
  const q: ListQuery = { view: f.view, limit, offset };
  if (sort) q.sort = sort;
  if (f.platform) q.platform = f.platform;
  if (f.accountId !== undefined) q.accountId = f.accountId;
  if (f.scope) q.scope = f.scope;
  if (f.projectId !== undefined) q.projectId = f.projectId;
  if (f.tag) q.tag = f.tag;
  if (f.cleanup) q.cleanup = f.cleanup;
  if (search.trim()) q.search = search.trim();
  return q;
}
