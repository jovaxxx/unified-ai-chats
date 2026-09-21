import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImageItem, ImageList, Platform } from '../../shared/types';
import { useNearEnd } from '../useNearEnd';
import { FilterSelect, SearchField, SortSelect } from './Controls';
import { Lightbox, StoredImage } from './Lightbox';
import { PlatformLogo } from './PlatformLogo';

const PAGE = 60;
const DEBOUNCE_MS = 250;

interface Props {
  /** What to show: everything, one platform, or one profile. */
  scope: { platform?: Platform; accountId?: number };
  /** Bumped after a sync or a deletion. */
  version: number;
  onOpenChat: (conversationId: number) => void;
}

/** The generated images saved on this Mac, as a grid. Click one to see it large and jump to its chat. */
export function Gallery({ scope, version, onOpenChat }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ key: string; list: ImageList } | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [projectId, setProjectId] = useState<number | ''>('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // More images load by themselves when the end of the grid comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const key = `${scope.platform ?? ''}:${scope.accountId ?? ''}:${limit}:${version}:${search}:${projectId}:${sort}`;

  // What is typed is applied after a short pause, and completions are offered as you type.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(typed.trim());
      setLimit(PAGE);
    }, DEBOUNCE_MS);
    let live = true;
    if (typed.trim()) {
      window.api
        .imageSuggest(typed, {
          ...(scope.platform ? { platform: scope.platform } : {}),
          ...(scope.accountId !== undefined ? { accountId: scope.accountId } : {}),
        })
        .then((s) => live && setSuggestions(s))
        .catch(() => undefined);
    }
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [typed, scope.platform, scope.accountId]);

  useEffect(() => {
    let cancelled = false;
    window.api
      .listImages({
        ...(scope.platform ? { platform: scope.platform } : {}),
        ...(scope.accountId !== undefined ? { accountId: scope.accountId } : {}),
        ...(projectId !== '' ? { projectId } : {}),
        ...(search ? { search } : {}),
        sort,
        limit,
      })
      .then((list) => {
        if (!cancelled) setState({ key, list });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [key, scope.platform, scope.accountId, limit, projectId, search, sort]);

  const items: ImageItem[] = state?.list.items ?? [];
  const more = items.length < (state?.list.total ?? 0);
  useNearEnd(sentinel, more, items.length, () => setLimit((l) => l + PAGE));
  const total = state?.list.total ?? 0;
  const current = open !== null ? items[open] : undefined;
  const caption = (i: ImageItem) =>
    `${i.chatTitle} · ${t(`platforms.${i.platform}`)} ${i.accountLabel}`;

  return (
    <main className="dash" aria-label={t('images.title')}>
      <header className="dash-head">
        <div className="grow">
          <h1 className="dash-title">{t('images.title')}</h1>
          <div className="dash-sub">{t('images.count', { count: total })}</div>
        </div>
      </header>
      <div className="gallery-tools">
        <SearchField
          inline
          label={t('images.searchLabel')}
          placeholder={t('images.searchPlaceholder')}
          value={typed}
          onChange={setTyped}
          suggestions={suggestions}
        />
        <FilterSelect
          label={t('list.project')}
          ariaLabel={t('images.projectFilter')}
          anyLabel={t('list.any')}
          value={projectId === '' ? '' : String(projectId)}
          options={(state?.list.projects ?? []).map((p) => ({
            value: String(p.id),
            label: `${p.name} (${p.count})`,
          }))}
          onChange={(v) => {
            setProjectId(v === '' ? '' : Number(v));
            setLimit(PAGE);
          }}
        />
        <SortSelect
          label={t('images.sortLabel')}
          value={sort}
          options={[
            { value: 'newest', label: t('images.newest') },
            { value: 'oldest', label: t('images.oldest') },
          ]}
          onChange={(v) => setSort(v as 'newest' | 'oldest')}
        />
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {state && items.length === 0 ? (
        <p className="empty-note">
          {search || projectId !== '' ? t('images.noMatches') : t('images.empty')}
        </p>
      ) : (
        <ul className="gallery-grid">
          {items.map((img, i) => (
            <li key={img.id}>
              <button
                type="button"
                className="thumb"
                onClick={() => setOpen(i)}
                aria-label={img.alt ?? `${t('images.altFallback')} — ${img.chatTitle}`}
                title={`${img.chatTitle}${img.projectName ? ` · ${img.projectName}` : ''} · ${new Date(img.date).toLocaleDateString()}`}
              >
                <StoredImage id={img.id} alt="" thumb />
                <span className="thumb-badge">
                  <PlatformLogo platform={img.platform} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length < total && <div ref={sentinel} className="load-sentinel" aria-hidden="true" />}
      {current && (
        <Lightbox
          mediaId={current.id}
          alt={current.alt}
          caption={caption(current)}
          onClose={() => setOpen(null)}
          {...(open! > 0 ? { onPrev: () => setOpen(open! - 1) } : {})}
          {...(open! < items.length - 1 ? { onNext: () => setOpen(open! + 1) } : {})}
          onOpenChat={() => onOpenChat(current.conversationId)}
        />
      )}
    </main>
  );
}
