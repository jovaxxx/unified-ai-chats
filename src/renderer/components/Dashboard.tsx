import { SyncProgressLine } from './SyncProgressLine';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SHORT_CHAT_MESSAGES,
  WEB_PLATFORMS,
  type CleanupKind,
  type DashboardData,
  type Platform,
  type SidebarAccount,
} from '../../shared/types';
import type { Filters } from '../filters';
import { formatRelative } from '../format';
import { Icon } from './Icon';
import { ChangesCard } from './ChangesCard';
import { PlatformLogo } from './PlatformLogo';
import { StoredImage } from './Lightbox';
import { RecorderCard } from './RecorderCard';

interface Props {
  platform: Platform;
  accountId: number | undefined;
  /** Bumped by the app after anything that changes the numbers. */
  version: number;
  now: Date;
  syncing: boolean;
  /** The profiles this dashboard syncs, so it shows only their progress. */
  syncIds: number[];
  /** False while only demo data exists: there is nothing real to sync. */
  canSync: boolean;
  /** The selected profile as the sidebar knows it (allow-changes flag and what the connector can do). */
  accountInfo: SidebarAccount | undefined;
  onOpenGallery: (scope: { platform: Platform; accountId?: number }) => void;
  onSelectAccount: (id: number | undefined) => void;
  onSync: () => void;
  onOpenPlatform: () => void;
  onReview: (filters: Filters) => void;
  /** Called after a profile was renamed, so the sidebar and lists refresh. */
  onRenamed: () => void;
}

function Chart({
  data,
  locale,
  labelFor,
}: {
  data: DashboardData['perMonth'];
  locale: string;
  labelFor: (summary: string) => string;
}) {
  const W = 640;
  const base = 140;
  const maxH = 110;
  const barW = 66;
  const step = 104;
  const max = Math.max(1, ...data.map((m) => m.count));
  const month = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const monthLong = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const at = (m: string, f: Intl.DateTimeFormat) => f.format(new Date(`${m}-01T00:00:00Z`));
  const summary = data.map((m) => `${at(m.month, monthLong)} ${m.count}`).join(', ');
  return (
    <svg
      viewBox={`0 0 ${W} 170`}
      width="100%"
      height="170"
      role="img"
      aria-label={labelFor(summary)}
      style={{ display: 'block' }}
    >
      <line x1="0" y1={base} x2={W} y2={base} style={{ stroke: 'var(--border)' }} strokeWidth="1" />
      {data.map((m, i) => {
        const h = m.count === 0 ? 0 : Math.max(4, (m.count / max) * maxH);
        const x = 30 + i * step;
        return (
          <g key={m.month}>
            {h > 0 && (
              <rect
                x={x}
                y={base - h}
                width={barW}
                height={h}
                rx="6"
                style={{ fill: 'var(--chart-bar)' }}
              />
            )}
            <text
              x={x + barW / 2}
              y={base - h - 7}
              textAnchor="middle"
              fontSize="12"
              fontWeight="600"
              style={{ fill: 'var(--ink)' }}
            >
              {m.count}
            </text>
            <text
              x={x + barW / 2}
              y="160"
              textAnchor="middle"
              fontSize="12"
              style={{ fill: 'var(--muted)' }}
            >
              {at(m.month, month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Dashboard(p: Props) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<{ key: string; data: DashboardData } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = `${p.platform}:${p.accountId ?? 'all'}:${p.version}`;
  const platformName = t(`platforms.${p.platform}`);

  useEffect(() => {
    let cancelled = false;
    window.api
      .dashboard({
        platform: p.platform,
        ...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
      })
      .then((data) => {
        if (!cancelled) setState({ key, data });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [key, p.platform, p.accountId]);

  const d = state?.data;
  if (!d) {
    return (
      <main className="dash" aria-label={platformName}>
        <div className="dash-sub">{error ?? t('dash.loading')}</div>
      </main>
    );
  }

  const selected = d.accounts.find((a) => a.id === d.selectedAccountId);
  const canSync = p.canSync;
  const canOpen = p.platform !== 'claude-code';
  const isWeb = (WEB_PLATFORMS as readonly string[]).includes(p.platform);
  const total = d.accounts.reduce((n, a) => n + a.total, 0);
  const status = d.needsAttention
    ? t('dash.needsAttention')
    : d.lastSyncAt
      ? t('dash.syncedAgo', { when: formatRelative(d.lastSyncAt, p.now, i18n.language) })
      : t('dash.neverSynced');
  const scope = selected
    ? t('dash.profile', { name: selected.label })
    : t('dash.profiles', { count: d.accounts.length });

  const scopeFilters = (extra: Partial<Filters>): Filters => ({
    view: 'all',
    platform: p.platform,
    ...(d.selectedAccountId !== null ? { accountId: d.selectedAccountId } : {}),
    ...extra,
  });

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    try {
      await window.api.renameAccount(selected.id, draft);
      setRenaming(false);
      setError(null);
      p.onRenamed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cleanRows: { kind: CleanupKind; label: string }[] = [
    { kind: 'short', label: t('dash.cleanShort', { count: SHORT_CHAT_MESSAGES }) },
    { kind: 'untagged', label: t('dash.cleanUntagged') },
    { kind: 'generic', label: t('dash.cleanGeneric') },
  ];

  return (
    <main className="dash" aria-label={platformName}>
      <header className="dash-head">
        <PlatformLogo platform={p.platform} size="lg" />
        <div className="grow">
          <h1 className="dash-title">{platformName}</h1>
          <div className={`dash-sub${d.needsAttention ? ' dash-sub--warn' : ''}`}>
            {d.needsAttention ? (
              <Icon name="warn" size="xs" />
            ) : (
              <span className="status-dot" aria-hidden="true" />
            )}
            {status} · {scope}
          </div>
        </div>
        {isWeb && selected && (
          <button
            type="button"
            className="btn btn--lg"
            title={t('dash.signInHint', { platform: platformName })}
            onClick={() =>
              void window.api
                .openLogin(selected.id)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            {t('dash.signIn')}
          </button>
        )}
        <button
          type="button"
          className="btn btn--lg"
          disabled={!canSync || p.syncing}
          title={canSync ? undefined : t('dash.syncSoon')}
          onClick={p.onSync}
        >
          {p.syncing ? t('nav.syncing') : t('dash.syncNow')}
        </button>
        {p.syncing && <SyncProgressLine accountIds={p.syncIds} />}
        <button
          type="button"
          className="btn btn--primary btn--lg"
          disabled={!canOpen}
          title={canOpen ? undefined : t('dash.openUnavailable')}
          onClick={p.onOpenPlatform}
        >
          {t('dash.open', { platform: platformName })}
          <Icon name="external" size="sm" />
        </button>
      </header>

      {d.lastError && (
        <div className="form-error" role="alert">
          {t('dash.lastError', { message: d.lastError })}
        </div>
      )}
      {isWeb && !d.lastSyncAt && (
        <div className="info-box" role="note">
          <strong>{t('dash.noConnectorTitle')}</strong>
          <span>{t('dash.noConnector', { platform: platformName })}</span>
        </div>
      )}

      <div className="switcher-row">
        <nav className="segmented" aria-label={t('dash.switcher', { platform: platformName })}>
          <button
            type="button"
            aria-pressed={selected === undefined}
            onClick={() => p.onSelectAccount(undefined)}
          >
            {t('dash.allProfiles')} · {total}
          </button>
          {d.accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              aria-pressed={selected?.id === a.id}
              onClick={() => p.onSelectAccount(a.id)}
            >
              {a.label} · {a.total}
            </button>
          ))}
        </nav>
        {selected && !renaming && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDraft(selected.label);
              setError(null);
              setRenaming(true);
            }}
          >
            <Icon name="pencil" size="sm" />
            {t('dash.renameProfile')}
          </button>
        )}
      </div>
      {renaming && selected && (
        <form className="rename-profile" onSubmit={(e) => void saveName(e)}>
          <input
            autoFocus
            aria-label={t('dash.renameLabel')}
            value={draft}
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
          />
          <button type="submit" className="btn btn--primary">
            {t('dash.renameSave')}
          </button>
          <button type="button" className="btn" onClick={() => setRenaming(false)}>
            {t('dash.renameCancel')}
          </button>
        </form>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <div className="stats">
        <div className="card">
          <div className="stat-label">{t('dash.chats')}</div>
          <div className="stat-num">{d.stats.chats}</div>
          <div className="stat-sub">{t('dash.inInbox', { count: d.stats.inbox })}</div>
        </div>
        <div className="card">
          <div className="stat-label">{t('dash.projects')}</div>
          <div className="stat-num">{d.stats.projects}</div>
          <div className="stat-sub">{t('dash.inProjects', { count: d.stats.inProjects })}</div>
        </div>
        <div className="card">
          <div className="stat-label">{t('dash.archived')}</div>
          <div className="stat-num">{d.stats.archived}</div>
          <div className="stat-sub">{t('dash.archivedSub')}</div>
        </div>
        <div className="card">
          <div className="stat-label">{t('dash.images')}</div>
          <div className="stat-num">{d.stats.images}</div>
          <div className="stat-sub">
            {d.stats.images === 0 ? t('dash.imagesNone') : t('dash.imagesSome')}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card card--wide">
          <div className="card-head">
            <div className="card-title">{t('dash.perMonth')}</div>
            <div className="card-aside">{t('dash.last6')}</div>
          </div>
          <Chart
            data={d.perMonth}
            locale={i18n.language}
            labelFor={(values) => t('dash.perMonthLabel', { values })}
          />
        </div>
        <div className="card card--wide card--clean">
          <div className="card-title">{t('dash.clean')}</div>
          {cleanRows.map((r) => (
            <button
              key={r.kind}
              type="button"
              className="clean-row"
              disabled={d.clean[r.kind] === 0}
              onClick={() => p.onReview(scopeFilters({ cleanup: r.kind }))}
            >
              <span className="clean-spacer">{r.label}</span>
              <strong>{d.clean[r.kind]}</strong>
            </button>
          ))}
          <div className="clean-spacer" />
          <button
            type="button"
            className="btn btn--block"
            onClick={() => p.onReview(scopeFilters({}))}
          >
            {t('dash.review')}
          </button>
        </div>
      </div>

      <div className="card card--wide">
        <div className="card-head">
          <div className="card-title">{t('dash.imagesTitle')}</div>
          {d.stats.images > 0 && (
            <button
              type="button"
              className="link"
              onClick={() =>
                p.onOpenGallery({
                  platform: p.platform,
                  ...(d.selectedAccountId !== null ? { accountId: d.selectedAccountId } : {}),
                })
              }
            >
              {t('images.seeAll', { count: d.stats.images })}
            </button>
          )}
        </div>
        {d.recentImages.length > 0 ? (
          <div className="thumb-strip">
            {d.recentImages.map((img) => (
              <button
                key={img.id}
                type="button"
                className="thumb"
                aria-label={img.alt ?? `${t('images.altFallback')} — ${img.chatTitle}`}
                onClick={() =>
                  p.onOpenGallery({
                    platform: p.platform,
                    ...(d.selectedAccountId !== null ? { accountId: d.selectedAccountId } : {}),
                  })
                }
              >
                <StoredImage id={img.id} alt="" thumb />
              </button>
            ))}
          </div>
        ) : (
          <p className="empty-note">{t('dash.imagesEmpty')}</p>
        )}
      </div>
      {isWeb && (
        <ChangesCard platform={p.platform} account={p.accountInfo} onChanged={p.onRenamed} />
      )}
      {isWeb && <RecorderCard platform={p.platform} accountId={d.selectedAccountId ?? undefined} />}
    </main>
  );
}
