import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SHORT_CHAT_MESSAGES,
  type ChatSummary,
  type FilterOptions,
  type Platform,
  SORT_KEYS,
  type SortKey,
} from '../../shared/types';
import { useNearEnd } from '../useNearEnd';
import { isAllChats, type Filters } from '../filters';
import { daysUntil, formatChatDate } from '../format';
import { FilterSelect, SearchField, SortSelect } from './Controls';
import { Icon } from './Icon';
import { PlatformLogo } from './PlatformLogo';

interface Props {
  items: ChatSummary[];
  total: number;
  loading: boolean;
  filters: Filters;
  options: FilterOptions | null;
  search: string;
  /** Increment to move keyboard focus to the search field (Cmd/Ctrl+K). */
  focusSearchToken: number;
  selected: Set<number>;
  openId: number | null;
  now: Date;
  onSearch: (s: string) => void;
  onFilters: (f: Filters) => void;
  onToggle: (id: number) => void;
  onToggleAllVisible: () => void;
  onSelectAllMatching: () => void;
  onClearSelection: () => void;
  onOpen: (id: number) => void;
  onLoadMore: () => void;
  onBulk: (type: 'archive' | 'unarchive' | 'trash' | 'restore') => void;
  onBulkTag: (tag: string) => void;
  sort: SortKey | null;
  onSort: (sort: SortKey | null) => void;
  everywhere: boolean;
  onEverywhere: (v: boolean) => void;
  /** Days chats stay in the Trash. */
  retention: number;
  /** Delete the selected chats from this app for good (asks first). */
  onPurge: () => void;
}

export function ChatList(p: Props) {
  const { t, i18n } = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  // The next page loads by itself when the end of the list comes into view.
  const endRef = useRef<HTMLLIElement>(null);
  useNearEnd(endRef, p.items.length < p.total && !p.loading, p.items.length, p.onLoadMore);
  const { focusSearchToken } = p;
  useEffect(() => {
    if (focusSearchToken > 0) {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [focusSearchToken]);
  const [tagging, setTagging] = useState(false);
  const [tagText, setTagText] = useState('');
  const inTrash = p.filters.view === 'trash';
  const anySelected = p.selected.size > 0;
  const allVisibleSelected = p.items.length > 0 && p.items.every((c) => p.selected.has(c.id));
  const dateLabels = { today: t('dates.today'), yesterday: t('dates.yesterday') };

  const accounts = (p.options?.accounts ?? []).filter(
    (a) => !p.filters.platform || a.platform === p.filters.platform,
  );
  const projects = (p.options?.projects ?? []).filter(
    (pr) => p.filters.accountId === undefined || pr.accountId === p.filters.accountId,
  );
  const platforms = [...new Set((p.options?.accounts ?? []).map((a) => a.platform))];

  const submitTag = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tagText.trim()) return;
    p.onBulkTag(tagText.trim());
    setTagText('');
    setTagging(false);
  };

  return (
    <section className="list" aria-label={t('list.label')}>
      <SearchField
        label={t('list.searchLabel')}
        placeholder={t('list.searchPlaceholder')}
        value={p.search}
        onChange={p.onSearch}
        ref={searchRef}
      />
      {p.search.trim() && !inTrash && !isAllChats(p.filters) && (
        <div className="search-scope">
          <span>{p.everywhere ? t('search.scopeEverywhere') : t('search.scopeView')}</span>
          <button type="button" className="link" onClick={() => p.onEverywhere(!p.everywhere)}>
            {p.everywhere ? t('search.thisView') : t('search.everywhere')}
          </button>
        </div>
      )}
      {inTrash && <div className="filter-note">{t('trash.note', { count: p.retention })}</div>}

      {!inTrash && (
        <div className="chips" role="group" aria-label={t('list.filters')}>
          <FilterSelect
            label={t('list.platform')}
            anyLabel={t('list.any')}
            value={p.filters.platform ?? ''}
            options={platforms.map((pl) => ({ value: pl, label: t(`platforms.${pl}`) }))}
            onChange={(v) =>
              p.onFilters({
                view: 'all',
                ...(v ? { platform: v as Platform } : {}),
                ...(p.filters.tag ? { tag: p.filters.tag } : {}),
              })
            }
          />
          <FilterSelect
            label={t('list.account')}
            anyLabel={t('list.any')}
            value={p.filters.accountId?.toString() ?? ''}
            options={accounts.map((a) => ({
              value: String(a.id),
              label: `${t(`platforms.${a.platform}`)} · ${a.label}`,
            }))}
            onChange={(v) => {
              const acc = accounts.find((a) => String(a.id) === v);
              p.onFilters({
                view: 'all',
                ...(acc
                  ? { platform: acc.platform, accountId: acc.id }
                  : p.filters.platform
                    ? { platform: p.filters.platform }
                    : {}),
                ...(p.filters.tag ? { tag: p.filters.tag } : {}),
              });
            }}
          />
          <FilterSelect
            label={t('list.project')}
            anyLabel={t('list.any')}
            value={p.filters.projectId?.toString() ?? ''}
            options={projects.map((pr) => ({ value: String(pr.id), label: pr.name }))}
            onChange={(v) => {
              const pr = projects.find((x) => String(x.id) === v);
              const { scope: _scope, projectId: _project, ...rest } = p.filters;
              void _scope;
              void _project;
              p.onFilters(pr ? { ...rest, accountId: pr.accountId, projectId: pr.id } : rest);
            }}
          />
          <FilterSelect
            label={t('list.tag')}
            anyLabel={t('list.any')}
            value={p.filters.tag ?? ''}
            options={(p.options?.tags ?? []).map((tag) => ({ value: tag, label: tag }))}
            onChange={(v) => {
              const { tag: _tag, ...rest } = p.filters;
              void _tag;
              p.onFilters(v ? { ...rest, tag: v } : rest);
            }}
          />
        </div>
      )}

      {p.filters.cleanup && (
        <div className="filter-note">
          <span>
            {t('list.cleanupNote', {
              what:
                p.filters.cleanup === 'short'
                  ? t('dash.cleanShort', { count: SHORT_CHAT_MESSAGES })
                  : p.filters.cleanup === 'untagged'
                    ? t('dash.cleanUntagged')
                    : t('dash.cleanGeneric'),
            })}
          </span>
          <button
            type="button"
            className="link"
            onClick={() => {
              const { cleanup: _cleanup, ...rest } = p.filters;
              void _cleanup;
              p.onFilters(rest);
            }}
          >
            {t('list.clearFilter')}
          </button>
        </div>
      )}
      {anySelected && (
        <div className="bulkbar">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            aria-label={t('bulk.selectAllVisible')}
            onChange={p.onToggleAllVisible}
          />
          <span className="bulkbar-label">{t('bulk.selected', { count: p.selected.size })}</span>
          {inTrash ? (
            <>
              <button
                type="button"
                className="bulk-btn"
                onClick={() => p.onBulk('restore')}
                title={t('bulk.localOnly')}
              >
                {t('bulk.restore')}
              </button>
              <button type="button" className="bulk-btn bulk-btn--danger" onClick={p.onPurge}>
                <Icon name="trash" size="sm" />
                {t('trash.deleteNow')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="bulk-btn"
                onClick={() => setTagging((v) => !v)}
                aria-expanded={tagging}
              >
                <Icon name="tag" size="sm" />
                {t('bulk.tag')}
              </button>
              <button
                type="button"
                className="bulk-btn"
                onClick={() => p.onBulk(p.filters.scope === 'archive' ? 'unarchive' : 'archive')}
                title={t('bulk.localOnly')}
              >
                <Icon name="archive" size="sm" />
                {p.filters.scope === 'archive' ? t('bulk.unarchive') : t('bulk.archive')}
              </button>
              <button
                type="button"
                className="bulk-btn bulk-btn--danger"
                onClick={() => p.onBulk('trash')}
                title={t('bulk.localOnly')}
              >
                <Icon name="trash" size="sm" />
                {t('bulk.delete')}
              </button>
            </>
          )}
        </div>
      )}
      {anySelected && tagging && !inTrash && (
        <form className="tagbar" onSubmit={submitTag}>
          <input
            autoFocus
            list="known-tags"
            aria-label={t('bulk.tagName')}
            placeholder={t('bulk.tagName')}
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
          />
          <datalist id="known-tags">
            {(p.options?.tags ?? []).map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
          <button
            type="submit"
            className="bulk-btn"
            style={{ color: 'var(--ink)', borderColor: 'var(--border-input)' }}
          >
            {t('bulk.tagApply')}
          </button>
          <button
            type="button"
            className="bulk-btn"
            style={{ color: 'var(--ink)', borderColor: 'var(--border-input)' }}
            onClick={() => setTagging(false)}
          >
            {t('bulk.tagCancel')}
          </button>
        </form>
      )}
      <div className="selection-info">
        {anySelected ? (
          <>
            <span>{t('bulk.info', { count: p.selected.size, total: p.total })}</span>
            {p.selected.size < p.total ? (
              <button type="button" className="link" onClick={p.onSelectAllMatching}>
                {t('bulk.selectAll', { total: p.total })}
              </button>
            ) : (
              <button type="button" className="link" onClick={p.onClearSelection}>
                {t('bulk.clear')}
              </button>
            )}
          </>
        ) : (
          <span>{p.loading ? t('list.loading') : `${p.total}`}</span>
        )}
        <SortSelect
          end
          label={t('sort.label')}
          value={p.sort ?? ''}
          options={[
            { value: '', label: p.search.trim() ? t('sort.best') : t('sort.recent') },
            ...SORT_KEYS.filter((k) => k !== 'updated_desc' || p.search.trim()).map((k) => ({
              value: k,
              label: t(`sort.${k}`),
            })),
          ]}
          onChange={(v) => p.onSort(v === '' ? null : (v as SortKey))}
        />
      </div>

      {p.items.length === 0 && !p.loading ? (
        <div className="list-empty">{inTrash ? t('list.emptyTrash') : t('list.empty')}</div>
      ) : (
        <ul className="chat-list">
          {p.items.map((c) => {
            const isSel = p.selected.has(c.id);
            const purgeDays = c.trashPurgeAt ? daysUntil(c.trashPurgeAt, p.now) : null;
            const dateText =
              inTrash && purgeDays !== null
                ? purgeDays === 0
                  ? t('list.deletesToday')
                  : t('list.deletesIn', { count: purgeDays })
                : formatChatDate(c.updatedAt, p.now, i18n.language, dateLabels);
            return (
              <li
                key={c.id}
                className={`chat-row${isSel ? ' is-selected' : ''}${p.openId === c.id ? ' is-open' : ''}`}
              >
                <input
                  type="checkbox"
                  className="row-check"
                  checked={isSel}
                  aria-label={t('list.selectRow', { title: c.title })}
                  onChange={() => p.onToggle(c.id)}
                />
                <button
                  type="button"
                  className="chat-link"
                  aria-current={p.openId === c.id ? 'true' : undefined}
                  onClick={() => p.onOpen(c.id)}
                >
                  <span className="chat-title-line">
                    <PlatformLogo platform={c.platform} />
                    <span className="sr-only">{t(`platforms.${c.platform}`)}: </span>
                    <span className="chat-title">{c.title}</span>
                    <span className="chat-date">{dateText}</span>
                  </span>
                  <span className="chat-preview">{c.preview}</span>
                  <span className="chat-meta">
                    <span className="tag tag--account">{c.accountLabel}</span>
                    {c.remoteSync !== 'idle' && (
                      <span
                        className={`tag ${c.remoteSync === 'failed' ? 'tag--sync-failed' : 'tag--sync'}`}
                      >
                        {t(`sync.${c.remoteSync}`)}
                      </span>
                    )}
                    {c.tags.slice(0, 3).map((tag) => (
                      <span className="tag" key={tag}>
                        {tag}
                      </span>
                    ))}
                    {c.remoteTitle !== c.title && (
                      <span className="was" title={c.remoteTitle}>
                        {t('list.was', { title: c.remoteTitle })}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {p.items.length < p.total && (
            <li ref={endRef} className="load-sentinel" aria-hidden="true" />
          )}
        </ul>
      )}
    </section>
  );
}
