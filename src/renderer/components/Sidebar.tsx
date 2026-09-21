import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Platform, SidebarData } from '../../shared/types';
import { LANGUAGES, setLanguage, type Language } from '../i18n';
import { ALL_CHATS, isAllChats, type Filters } from '../filters';
import { readJson, writeJson } from '../storage';
import type { Theme } from '../theme';
import { SyncProgressLine } from './SyncProgressLine';
import { Icon } from './Icon';
import { PlatformLogo } from './PlatformLogo';

interface Props {
  data: SidebarData | null;
  filters: Filters;
  onNavigate: (f: Filters) => void;
  onNewChat: (platform: Platform) => void;
  onAddProfile: (platform: Platform) => void;
  /** Platform whose dashboard is open, if any. */
  dashboardPlatform: Platform | null;
  onOpenDashboard: (platform: Platform) => void;
  /** The image gallery being shown, if any. */
  galleryScope: { platform?: Platform; accountId?: number } | null;
  activityOpen: boolean;
  activityBadge: number;
  onOpenActivity: () => void;
  onOpenGallery: (scope: { platform?: Platform; accountId?: number }) => void;
  onSyncAll: () => void;
  syncing: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  onReorderAccounts: (platform: Platform, orderedIds: number[]) => void;
  onReorderPlatforms: (order: Platform[]) => void;
}

const NEW_CHAT_PLATFORMS: Platform[] = ['chatgpt', 'claude', 'gemini'];
/** Web platforms whose connector does not exist yet. */
const SOON: Platform[] = ['gemini'];

export function Sidebar({
  data,
  filters,
  onNavigate,
  onNewChat,
  onAddProfile,
  dashboardPlatform,
  onOpenDashboard,
  galleryScope,
  activityOpen,
  activityBadge,
  onOpenActivity,
  onOpenGallery,
  onSyncAll,
  syncing,
  theme,
  onToggleTheme,
  onReorderAccounts,
  onReorderPlatforms,
}: Props) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Which accounts have their Projects folder closed, remembered between launches.
  const [closedProjects, setClosedProjects] = useState<number[]>(() =>
    readJson('closedProjects', []),
  );
  const toggleProjects = (id: number) =>
    setClosedProjects((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      writeJson('closedProjects', next);
      return next;
    });
  const hasLocal = data?.platforms.some((p) => p.platform === 'claude-code') ?? false;
  // A source the app can import from (local sessions or a connected ChatGPT profile).
  const hasSyncable =
    data?.platforms.some(
      (p) =>
        p.platform === 'claude-code' ||
        ((p.platform === 'chatgpt' || p.platform === 'claude') && !data.demo),
    ) ?? false;

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const listShown = dashboardPlatform === null && galleryScope === null && !activityOpen;
  const totalImages =
    data?.platforms.reduce((n, g) => n + g.accounts.reduce((m, a) => m + a.images, 0), 0) ?? 0;
  const isAllView = listShown && isAllChats(filters);

  // ---- reordering: drag with the mouse, or Alt+ArrowUp / Alt+ArrowDown on a focused item ----
  type Drag =
    { kind: 'platform'; platform: Platform } | { kind: 'account'; platform: Platform; id: number };
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<{ key: string; after: boolean } | null>(null);

  const moved = <T,>(list: T[], from: number, to: number): T[] => {
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as T);
    return next;
  };
  const movePlatform = (platform: Platform, delta: number) => {
    const order = data?.platforms.map((g) => g.platform) ?? [];
    const from = order.indexOf(platform);
    const to = from + delta;
    if (from >= 0 && to >= 0 && to < order.length) onReorderPlatforms(moved(order, from, to));
  };
  const moveAccount = (platform: Platform, id: number, delta: number) => {
    const ids =
      data?.platforms.find((g) => g.platform === platform)?.accounts.map((a) => a.id) ?? [];
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from >= 0 && to >= 0 && to < ids.length) onReorderAccounts(platform, moved(ids, from, to));
  };
  /** Where the dragged item lands when dropped on `targetIndex` (before or after it). */
  const dropIndex = (from: number, targetIndex: number, after: boolean) => {
    const to = targetIndex + (after ? 1 : 0);
    return from < to ? to - 1 : to;
  };
  const isAfter = (e: React.DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return (e.clientY ?? 0) > r.top + r.height / 2;
  };
  const altArrow = (e: React.KeyboardEvent, move: (delta: number) => void) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(e.key === 'ArrowUp' ? -1 : 1);
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="tray" />
        </span>
        <span className="brand-name">{t('app.name')}</span>
      </div>

      <div className="menu-wrap">
        <button
          type="button"
          className="btn-new"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span>
            <Icon name="plus" />
            {t('nav.newChatOn')}
          </span>
          <Icon name="chev-down" size="sm" />
        </button>
        {menuOpen && (
          <div
            className="menu"
            role="menu"
            onKeyDown={(e) => e.key === 'Escape' && setMenuOpen(false)}
          >
            <div className="menu-hint">{t('nav.newChatHint')}</div>
            {NEW_CHAT_PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onNewChat(p);
                }}
              >
                <PlatformLogo platform={p} />
                {t(`platforms.${p}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <nav className="nav" aria-label={t('nav.views')}>
        <button
          type="button"
          className={`nav-item${isAllView ? ' is-active' : ''}`}
          aria-current={isAllView ? 'page' : undefined}
          onClick={() => onNavigate(ALL_CHATS)}
        >
          <Icon name="grid" />
          {t('nav.all')}
          <span className="count">{data?.totalChats ?? ''}</span>
        </button>
        <button
          type="button"
          className={`nav-item${galleryScope && !galleryScope.accountId && !galleryScope.platform ? ' is-active' : ''}`}
          aria-current={
            galleryScope && !galleryScope.accountId && !galleryScope.platform ? 'page' : undefined
          }
          onClick={() => onOpenGallery({})}
        >
          <Icon name="image" />
          {t('nav.images')}
          <span className="count">{totalImages}</span>
        </button>
        <button
          type="button"
          className={`nav-item${activityOpen ? ' is-active' : ''}`}
          aria-current={activityOpen ? 'page' : undefined}
          onClick={onOpenActivity}
        >
          <Icon name="activity" />
          {t('nav.activity')}
          {activityBadge > 0 && <span className="count">{activityBadge}</span>}
        </button>
        <button
          type="button"
          className={`nav-item${listShown && filters.view === 'trash' ? ' is-active' : ''}`}
          aria-current={listShown && filters.view === 'trash' ? 'page' : undefined}
          onClick={() => onNavigate({ view: 'trash' })}
        >
          <Icon name="trash" />
          {t('nav.trash')}
          <span className="count">{data?.trashed ?? ''}</span>
        </button>
      </nav>

      <div className="section-label">{t('nav.accounts')}</div>

      <div className="platforms">
        {data?.platforms.map((p, pIndex) => (
          <div
            className={`platform${over?.key === `p:${p.platform}` ? (over.after ? ' drop-after' : ' drop-before') : ''}`}
            key={p.platform}
            onDragOver={(e) => {
              if (drag?.kind !== 'platform' || drag.platform === p.platform) return;
              e.preventDefault();
              setOver({ key: `p:${p.platform}`, after: isAfter(e) });
            }}
            onDrop={(e) => {
              if (drag?.kind !== 'platform') return;
              e.preventDefault();
              const order = data.platforms.map((g) => g.platform);
              onReorderPlatforms(
                moved(
                  order,
                  order.indexOf(drag.platform),
                  dropIndex(order.indexOf(drag.platform), pIndex, over?.after ?? false),
                ),
              );
              setDrag(null);
              setOver(null);
            }}
          >
            <button
              type="button"
              draggable
              className={`platform-head${dashboardPlatform === p.platform ? ' is-active' : ''}`}
              aria-current={dashboardPlatform === p.platform ? 'page' : undefined}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              title={t('nav.movable')}
              onClick={() => onOpenDashboard(p.platform)}
              onKeyDown={(e) => altArrow(e, (d) => movePlatform(p.platform, d))}
              onDragStart={(e) => {
                e.dataTransfer?.setData('text/plain', p.platform);
                setDrag({ kind: 'platform', platform: p.platform });
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
            >
              <PlatformLogo platform={p.platform} />
              {t(`platforms.${p.platform}`)}
              <span className="count">{p.total}</span>
            </button>

            {p.accounts.map((a, aIndex) => {
              const isOpen = expanded.has(a.id);
              const accountActive =
                listShown &&
                filters.view === 'all' &&
                filters.accountId === a.id &&
                !filters.scope &&
                filters.projectId === undefined;
              const at = (extra: Partial<Filters>): Filters => ({
                view: 'all',
                platform: a.platform,
                accountId: a.id,
                ...extra,
              });
              const name = `${t(`platforms.${a.platform}`)} ${a.label}`;
              return (
                <div
                  key={a.id}
                  className={`platform${over?.key === `a:${a.id}` ? (over.after ? ' drop-after' : ' drop-before') : ''}`}
                  onDragOver={(e) => {
                    if (
                      drag?.kind !== 'account' ||
                      drag.platform !== p.platform ||
                      drag.id === a.id
                    )
                      return;
                    e.preventDefault();
                    setOver({ key: `a:${a.id}`, after: isAfter(e) });
                  }}
                  onDrop={(e) => {
                    if (drag?.kind !== 'account' || drag.platform !== p.platform) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const ids = p.accounts.map((x) => x.id);
                    const from = ids.indexOf(drag.id);
                    onReorderAccounts(
                      p.platform,
                      moved(ids, from, dropIndex(from, aIndex, over?.after ?? false)),
                    );
                    setDrag(null);
                    setOver(null);
                  }}
                >
                  <button
                    type="button"
                    draggable
                    className={`account${isOpen ? ' is-expanded' : ''}${accountActive ? ' is-active' : ''}`}
                    aria-expanded={isOpen}
                    aria-label={name}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    title={t('nav.movable')}
                    onKeyDown={(e) => altArrow(e, (d) => moveAccount(p.platform, a.id, d))}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer?.setData('text/plain', String(a.id));
                      setDrag({ kind: 'account', platform: p.platform, id: a.id });
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setOver(null);
                    }}
                    onClick={() => {
                      toggle(a.id);
                      onNavigate(at({}));
                    }}
                  >
                    <span className="chev">
                      <Icon name={isOpen ? 'chev-down' : 'chev-right'} size="xs" />
                    </span>
                    <Icon name="person" size="sm" />
                    {a.label}
                    {a.status === 'needs_attention' ? (
                      <span className="status-warn">
                        <Icon name="warn" size="xs" />
                        {t('nav.verify')}
                      </span>
                    ) : (
                      <>
                        <span className="count">{a.total}</span>
                        <span
                          className="status-dot"
                          role="img"
                          aria-label={t('nav.synced')}
                          title={t('nav.synced')}
                        />
                      </>
                    )}
                  </button>

                  {isOpen && (
                    <>
                      <button
                        type="button"
                        className={`tree-item${
                          filters.accountId === a.id && filters.scope === 'inbox'
                            ? ' is-active'
                            : ''
                        }`}
                        onClick={() => onNavigate(at({ scope: 'inbox' }))}
                      >
                        <Icon name="tray" size="sm" />
                        {t('nav.inbox')}
                        <span className="count">{a.inbox}</span>
                      </button>
                      {a.projects.length > 0 && (
                        <>
                          <button
                            type="button"
                            className="tree-item tree-item--folder"
                            aria-expanded={!closedProjects.includes(a.id)}
                            aria-label={`${t('nav.projects')} ${a.label}. ${t(
                              closedProjects.includes(a.id)
                                ? 'nav.projectsExpand'
                                : 'nav.projectsCollapse',
                            )}`}
                            onClick={() => toggleProjects(a.id)}
                          >
                            <Icon
                              name={closedProjects.includes(a.id) ? 'chev-right' : 'chev-down'}
                              size="xs"
                            />
                            <Icon name="folder" size="sm" />
                            {t('nav.projects')}
                            <span className="count">{a.projects.length}</span>
                          </button>
                          {!closedProjects.includes(a.id) &&
                            a.projects.map((pr) => (
                              <button
                                key={pr.id}
                                type="button"
                                className={`tree-item tree-item--project${
                                  listShown && filters.projectId === pr.id ? ' is-active' : ''
                                }`}
                                onClick={() => onNavigate(at({ projectId: pr.id }))}
                              >
                                {pr.name}
                                <span className="count">{pr.count}</span>
                              </button>
                            ))}
                        </>
                      )}
                      {a.platform !== 'claude-code' && (
                        <button
                          type="button"
                          className={`tree-item${galleryScope?.accountId === a.id ? ' is-active' : ''}`}
                          onClick={() => onOpenGallery({ platform: a.platform, accountId: a.id })}
                        >
                          <Icon name="image" size="sm" />
                          {t('nav.imagesFolder')}
                          <span className="count">{a.images}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className={`tree-item${
                          filters.accountId === a.id && filters.scope === 'archive'
                            ? ' is-active'
                            : ''
                        }`}
                        onClick={() => onNavigate(at({ scope: 'archive' }))}
                      >
                        <Icon name="archive" size="sm" />
                        {t('nav.archive')}
                        <span className="count">{a.archived}</span>
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        {hasSyncable && (
          <button type="button" className="btn-dashed" onClick={onSyncAll}>
            {syncing ? t('nav.syncing') : t('nav.syncNow')}
          </button>
        )}
        {syncing && <SyncProgressLine />}
        <div className="menu-wrap">
          <button
            type="button"
            className="btn-dashed"
            style={{ width: '100%' }}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((o) => !o)}
          >
            <Icon name="plus" size="sm" />
            {t('nav.addAccount')}
          </button>
          {addOpen && (
            <div
              className="menu menu--up"
              role="menu"
              onKeyDown={(e) => e.key === 'Escape' && setAddOpen(false)}
            >
              <div className="menu-hint">{t('nav.addAccountHint')}</div>
              <button
                type="button"
                role="menuitem"
                className="menu-item menu-item--stack"
                disabled={hasLocal || syncing}
                onClick={() => {
                  setAddOpen(false);
                  onAddProfile('claude-code');
                }}
              >
                <span className="menu-item-row">
                  <PlatformLogo platform="claude-code" />
                  {t('nav.claudeCodeLocal')}
                </span>
                <span className="menu-hint">{t('nav.claudeCodeHint')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setAddOpen(false);
                  onAddProfile('chatgpt');
                }}
              >
                <PlatformLogo platform="chatgpt" />
                {t('platforms.chatgpt')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setAddOpen(false);
                  onAddProfile('claude');
                }}
              >
                <PlatformLogo platform="claude" />
                {t('platforms.claude')}
              </button>
              {SOON.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  disabled
                  title={t('nav.addAccountSoon')}
                >
                  <PlatformLogo platform={p} />
                  {t(`platforms.${p}`)}
                  <span className="count">{t('nav.comingSoon')}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {data?.demo && <div className="note note--demo">{t('nav.demo')}</div>}
        <div className="note">{t('nav.localNote')}</div>
        <div className="foot-row">
          <label className="lang">
            {t('nav.language')}
            <select value={i18n.language} onChange={(e) => setLanguage(e.target.value as Language)}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l === 'en' ? 'English' : 'Italiano'}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="theme-toggle"
            aria-pressed={theme === 'dark'}
            aria-label={theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')}
            title={theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')}
            onClick={onToggleTheme}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size="sm" />
          </button>
        </div>
      </div>
    </aside>
  );
}
