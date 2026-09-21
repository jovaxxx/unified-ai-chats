import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BulkAction,
  ChatDetail,
  ChatSummary,
  FilterOptions,
  DeletePlan,
  Platform,
  PurgePreview,
  QueueSummary,
  SidebarData,
  SortKey,
  SyncStats,
} from '../shared/types';
import { ChatList } from './components/ChatList';
import { ToastView, type Toast } from './components/ToastView';
import { Reader } from './components/Reader';
import { AddProfileDialog } from './components/AddProfileDialog';
import { PurgeDialog } from './components/PurgeDialog';
import { SignInDialog, type SignInResult } from './components/SignInDialog';
import { ActivityView } from './components/ActivityView';
import { Dashboard } from './components/Dashboard';
import { Welcome } from './components/Welcome';
import { Gallery } from './components/Gallery';
import { Sidebar } from './components/Sidebar';
import { Splitter } from './components/Splitter';
import { ALL_CHATS, toQuery, type Filters } from './filters';
import { readJson, writeJson } from './storage';
import { applyTheme, initialTheme, saveTheme, type Theme } from './theme';

const PAGE_SIZE = 100;
const DEFAULT_LAYOUT = { sidebar: 264, list: 420 };
const SIDEBAR_RANGE = { min: 200, max: 420 };
const LIST_RANGE = { min: 300, max: 720 };
const READER_MIN = 380;
type SimpleAction = 'archive' | 'unarchive' | 'trash' | 'restore';
const INVERSE: Record<SimpleAction, SimpleAction> = {
  archive: 'unarchive',
  unarchive: 'archive',
  trash: 'restore',
  restore: 'trash',
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** How often chats are refreshed in the background, and how long a window may stay unfocused before a refresh. */
const REFRESH_EVERY_MS = 3 * 60_000;
const REFRESH_ON_FOCUS_AFTER_MS = 60_000;

export function App() {
  const { t } = useTranslation();
  const api = window.api;

  const [filters, setFilters] = useState<Filters>(ALL_CHATS);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput, 200);
  const [limit, setLimit] = useState(PAGE_SIZE);
  // The list result remembers which request produced it, so `loading` is derived, not stored.
  const [result, setResult] = useState<{ key: string; items: ChatSummary[]; total: number } | null>(
    null,
  );
  const [sidebar, setSidebar] = useState<SidebarData | null>(null);
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [loadedChat, setLoadedChat] = useState<{ id: number; chat: ChatDetail | null } | null>(
    null,
  );
  const [toast, setToast] = useState<Toast | null>(null);
  // Which profiles are syncing right now. Each one syncs on its own, so one never waits for another.
  const [syncingIds, setSyncingIds] = useState<ReadonlySet<number>>(new Set());
  const [connecting, setConnecting] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [layout, setLayout] = useState(() => {
    const saved = readJson('layout', DEFAULT_LAYOUT);
    return {
      sidebar: Math.min(
        SIDEBAR_RANGE.max,
        Math.max(SIDEBAR_RANGE.min, Number(saved.sidebar) || DEFAULT_LAYOUT.sidebar),
      ),
      list: Math.min(
        LIST_RANGE.max,
        Math.max(LIST_RANGE.min, Number(saved.list) || DEFAULT_LAYOUT.list),
      ),
    };
  });
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);
  useEffect(() => writeJson('layout', layout), [layout]);
  // The reader always keeps a usable width, whatever the other two columns are set to.
  const listMax = Math.max(
    LIST_RANGE.min,
    Math.min(LIST_RANGE.max, viewport - layout.sidebar - READER_MIN),
  );
  const sidebarMax = Math.max(
    SIDEBAR_RANGE.min,
    Math.min(SIDEBAR_RANGE.max, viewport - layout.list - READER_MIN),
  );
  // The dashboard replaces the two-column list/reader view while a platform is selected.
  const [dashboard, setDashboard] = useState<{ platform: Platform; accountId?: number } | null>(
    null,
  );
  // The image gallery, like the dashboard, replaces the list and the reader while it is open.
  const [gallery, setGallery] = useState<{ platform?: Platform; accountId?: number } | null>(null);
  const [addingProfile, setAddingProfile] = useState<Platform | null>(null);
  const [version, setVersion] = useState(0); // bumped after every mutation to reload the views
  const [focusSearchToken, setFocusSearchToken] = useState(0);
  const [sort, setSort] = useState<SortKey | null>(() => readJson<SortKey | null>('sort', null));
  const [everywhere, setEverywhere] = useState(false);
  const [retention, setRetention] = useState(14);
  const [purging, setPurging] = useState<{
    ids: number[];
    preview: PurgePreview;
    plan: DeletePlan;
  } | null>(null);
  const [activity, setActivity] = useState(false);
  const [queueInfo, setQueueInfo] = useState<QueueSummary | null>(null);
  // How much is waiting to be sent to a platform, for the badge and the "sending…" hints.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .queueSummary()
        .then((q) => {
          if (!cancelled) setQueueInfo(q);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, version]);
  useEffect(() => writeJson('sort', sort), [sort]);
  useEffect(() => {
    void api
      .trashRetentionDays()
      .then(setRetention)
      .catch(() => undefined);
  }, [api]);
  const now = useMemo(() => new Date(), [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const showError = useCallback(
    (err: unknown) =>
      setToast({
        error: true,
        message: t('toast.error', { message: err instanceof Error ? err.message : String(err) }),
      }),
    [t],
  );

  // Like a mail client checking for new mail: every few minutes, and when the window comes back into focus, pull
  // only what changed lately, quietly. The buttons still do a fuller sync when asked.
  const demoNow = sidebar?.demo ?? true;
  // A new install has no data at all (no demo data): show how to connect the first account.
  const firstRun = sidebar !== null && sidebar.platforms.length === 0 && !sidebar.demo;
  useEffect(() => {
    if (demoNow) return;
    let busy = false;
    let last = Date.now();
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await api.syncRecent();
        last = Date.now();
        if (s.imported > 0) {
          setVersion((v) => v + 1);
          setToast({ message: t('toast.refreshed', { count: s.imported }) });
        }
      } catch {
        /* quiet: the next refresh tries again, and Sync now shows real errors */
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void refresh(), REFRESH_EVERY_MS);
    const onFocus = () => {
      if (Date.now() - last > REFRESH_ON_FOCUS_AFTER_MS) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [api, demoNow, t]);

  // Sidebar counts and filter options.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.sidebar(), api.filterOptions()])
      .then(([s, o]) => {
        if (cancelled) return;
        setSidebar(s);
        setOptions(o);
      })
      .catch(showError);
    return () => {
      cancelled = true;
    };
  }, [api, version, showError]);

  // The list. A newer request always wins over a slower older one.
  const requestKey = JSON.stringify([filters, search, limit, version, sort, everywhere]);
  useEffect(() => {
    let cancelled = false;
    api
      .listChats(toQuery(filters, search, limit, 0, sort, everywhere))
      .then((r) => {
        if (!cancelled) setResult({ key: requestKey, items: r.items, total: r.total });
      })
      .catch((e) => {
        if (!cancelled) showError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [api, filters, search, limit, requestKey, sort, everywhere, showError]);
  const items = result?.items ?? [];
  const total = result?.total ?? 0;
  const loading = result?.key !== requestKey;

  // The open chat.
  useEffect(() => {
    if (openId === null) return;
    let cancelled = false;
    api
      .getChat(openId)
      .then((c) => {
        if (!cancelled) setLoadedChat({ id: openId, chat: c });
      })
      .catch(showError);
    return () => {
      cancelled = true;
    };
  }, [api, openId, version, showError]);
  const chatLoaded = openId !== null && loadedChat?.id === openId;
  const chat = chatLoaded ? loadedChat.chat : null;
  const missing = chatLoaded && loadedChat.chat === null;

  const openGlobalSearch = useCallback(() => {
    setDashboard(null);
    setGallery(null);
    setActivity(false);
    setFilters(ALL_CHATS);
    setLimit(PAGE_SIZE);
    setSelected(new Set());
    setFocusSearchToken((n) => n + 1);
  }, []);

  // Cmd/Ctrl+K (or the Search item) opens a search across everything, from wherever you are.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openGlobalSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openGlobalSearch]);

  /** Leaves the gallery and opens one chat in the reader. */
  const showChat = (conversationId: number) => {
    setGallery(null);
    setActivity(false);
    setDashboard(null);
    setFilters(ALL_CHATS);
    setSearchInput('');
    setSelected(new Set());
    setOpenId(conversationId);
  };

  /** Asks what deleting these chats would do, here and on their platforms, then shows the confirmation. */
  const askPurge = async (ids: number[]) => {
    try {
      const [preview, plan] = await Promise.all([api.purgePreview(ids), api.planDelete(ids)]);
      if (preview.count === 0) setToast({ message: t('trash.nothing') });
      else setPurging({ ids, preview, plan });
    } catch (e) {
      showError(e);
    }
  };

  const afterPurge = (ids: number[], message: string) => {
    setPurging(null);
    setSelected(new Set());
    if (openId !== null && ids.includes(openId)) setOpenId(null);
    setToast({ message });
    setVersion((v) => v + 1);
  };

  /** Removes the chats from this app only. Nothing changes on any platform. */
  const deleteHere = async () => {
    if (!purging) return;
    const res = await api.purge(purging.ids);
    afterPurge(purging.ids, t('trash.done', { count: res.removed }));
  };

  /** Queues the deletion on the platform (after a verified copy), for the profiles that allow it. */
  const deleteOnPlatform = async () => {
    if (!purging) return;
    const res = await api.deleteOnPlatform(purging.ids);
    setPurging(null);
    setSelected(new Set());
    setToast({ message: t('trash.queued', { count: res.queued }) });
    setVersion((v) => v + 1);
  };

  const navigate = (f: Filters) => {
    setDashboard(null);
    setGallery(null);
    setActivity(false);
    setFilters(f);
    setLimit(PAGE_SIZE);
    setSelected(new Set());
  };

  const runBulk = async (ids: number[], action: BulkAction, undoable = true) => {
    try {
      const res = await api.bulk(ids, action);
      const key = `toast.${action.type}`;
      let message =
        res.changed > 0
          ? t(key, { count: res.changed, tag: action.type === 'tag' ? action.tag : '' })
          : t('toast.skipped', { count: res.skipped });
      if (res.changed > 0 && res.skipped > 0)
        message += ` ${t('toast.skipped', { count: res.skipped })}`;
      const inverse = action.type !== 'tag' ? INVERSE[action.type] : null;
      setToast({
        message,
        ...(undoable && inverse && res.changed > 0
          ? {
              undo: () =>
                void runBulk(res.changedIds, { type: inverse }, false).then(() => setToast(null)),
            }
          : {}),
      });
      setSelected(new Set());
      setVersion((v) => v + 1);
    } catch (e) {
      showError(e);
    }
  };

  const reportSync = (s: SyncStats) => {
    if (s.imported === 0 && s.failed > 0 && s.errors[0]) {
      // Nothing came in and we know why (signed out, rate limited, the site changed): say that, not a count.
      setToast({ error: true, message: s.errors[0] });
    } else {
      let message =
        s.imported === 0 && s.failed === 0
          ? t('toast.upToDate')
          : t('toast.synced', { count: s.imported });
      if (s.failed > 0) message += ` ${t('toast.syncFailed', { count: s.failed })}`;
      if (s.images?.downloaded) message += ` ${t('toast.images', { count: s.images.downloaded })}`;
      setToast({ message, ...(s.failed > 0 ? { error: true } : {}) });
    }
    setVersion((v) => v + 1);
  };

  const runSync = async (ids: number[], job: () => Promise<SyncStats>) => {
    const change = (fn: (s: Set<number>) => void) =>
      setSyncingIds((prev) => {
        const next = new Set(prev);
        fn(next);
        return next;
      });
    change((s) => ids.forEach((id) => s.add(id)));
    try {
      reportSync(await job());
    } catch (e) {
      showError(e);
    } finally {
      change((s) => ids.forEach((id) => s.delete(id)));
    }
  };
  const allProfileIds = () =>
    (sidebar?.platforms ?? []).flatMap((g) => g.accounts.map((a) => a.id));
  /** The profiles a dashboard is about: the chosen one, or every profile of its platform. */
  const dashboardIds = (): number[] => {
    if (!dashboard) return [];
    if (dashboard.accountId !== undefined) return [dashboard.accountId];
    return (sidebar?.platforms ?? [])
      .filter((g) => g.platform === dashboard.platform)
      .flatMap((g) => g.accounts.map((a) => a.id));
  };

  /** Connects the local Claude Code sessions under the name the user chose. Errors go to the dialog. */
  const connectClaudeCode = async (name: string) => {
    setConnecting(true);
    try {
      const res = await api.connectClaudeCode(name);
      setAddingProfile(null);
      navigate(ALL_CHATS);
      reportSync(res.stats);
    } finally {
      setConnecting(false);
    }
  };

  /** A web account finished signing in: land on its dashboard and say whether it was new. */
  const signedIn = (platform: Platform, r: SignInResult) => {
    setAddingProfile(null);
    setSelected(new Set());
    setDashboard({ platform, accountId: r.accountId });
    setToast({
      message: t(r.created ? 'toast.profileCreatedSignedIn' : 'toast.alreadyConnected', {
        label: r.label,
      }),
    });
    setVersion((v) => v + 1);
    // The first import starts by itself: nobody should have to press Sync after signing in.
    const ids = [r.accountId];
    void runSync(ids, () => api.syncProfiles(ids));
  };

  const selectAllMatching = async () => {
    try {
      const ids = await api.chatIds(toQuery(filters, search, 1, 0, sort, everywhere));
      setSelected(new Set(ids));
    } catch (e) {
      showError(e);
    }
  };

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllVisible = () =>
    setSelected((prev) => {
      const allOn = items.length > 0 && items.every((c) => prev.has(c.id));
      return allOn ? new Set() : new Set(items.map((c) => c.id));
    });

  const openOnPlatform = (c: ChatDetail) =>
    api.openOnPlatform(c.platform, c.remoteId).catch(showError);

  return (
    <div
      className={dashboard || gallery || activity || firstRun ? 'app app--dashboard' : 'app'}
      style={
        {
          '--sidebar-w': `${layout.sidebar}px`,
          '--list-w': `${Math.min(layout.list, listMax)}px`,
        } as React.CSSProperties
      }
    >
      <Sidebar
        data={sidebar}
        filters={filters}
        onNavigate={navigate}
        onNewChat={(p: Platform) => void api.openOnPlatform(p).catch(showError)}
        onAddProfile={setAddingProfile}
        dashboardPlatform={dashboard?.platform ?? null}
        galleryScope={gallery}
        activityOpen={activity}
        activityBadge={
          (queueInfo?.pending ?? 0) + (queueInfo?.running ?? 0) + (queueInfo?.failed ?? 0)
        }
        onOpenActivity={() => {
          setActivity(true);
          setGallery(null);
          setDashboard(null);
          setSelected(new Set());
        }}
        onOpenGallery={(scope) => {
          setActivity(false);
          setGallery(scope);
          setDashboard(null);
          setSelected(new Set());
        }}
        onOpenDashboard={(platform) => {
          setDashboard({ platform });
          setGallery(null);
          setActivity(false);
          setSelected(new Set());
        }}
        onSyncAll={() => void runSync(allProfileIds(), () => api.syncAll())}
        syncing={connecting || syncingIds.size > 0}
        onReorderAccounts={(platform, ids) =>
          void api
            .reorderAccounts(platform, ids)
            .then(() => setVersion((v) => v + 1))
            .catch(showError)
        }
        onReorderPlatforms={(order) =>
          void api
            .reorderPlatforms(order)
            .then(() => setVersion((v) => v + 1))
            .catch(showError)
        }
        theme={theme}
        onToggleTheme={() => setTheme((th) => (th === 'dark' ? 'light' : 'dark'))}
      />
      <Splitter
        left={layout.sidebar}
        value={layout.sidebar}
        min={SIDEBAR_RANGE.min}
        max={sidebarMax}
        label={t('layout.sidebar')}
        onChange={(v) => setLayout((l) => ({ ...l, sidebar: v }))}
        onReset={() => setLayout((l) => ({ ...l, sidebar: DEFAULT_LAYOUT.sidebar }))}
      />
      {!dashboard && !gallery && !activity && !firstRun && (
        <Splitter
          left={layout.sidebar + Math.min(layout.list, listMax)}
          value={Math.min(layout.list, listMax)}
          min={LIST_RANGE.min}
          max={listMax}
          label={t('layout.list')}
          onChange={(v) => setLayout((l) => ({ ...l, list: v }))}
          onReset={() => setLayout((l) => ({ ...l, list: DEFAULT_LAYOUT.list }))}
        />
      )}
      {firstRun ? (
        <Welcome onAdd={setAddingProfile} />
      ) : activity ? (
        <ActivityView version={version} onChanged={() => setVersion((v) => v + 1)} />
      ) : gallery ? (
        <Gallery scope={gallery} version={version} onOpenChat={showChat} />
      ) : dashboard ? (
        <Dashboard
          platform={dashboard.platform}
          accountId={dashboard.accountId}
          version={version}
          now={now}
          syncing={dashboardIds().some((id) => syncingIds.has(id))}
          syncIds={dashboardIds()}
          onOpenGallery={(scope) => {
            setGallery(scope);
            setDashboard(null);
          }}
          accountInfo={sidebar?.platforms
            .flatMap((g) => g.accounts)
            .find((a) => a.id === dashboard.accountId)}
          canSync={
            dashboard.platform === 'claude-code' ||
            ((dashboard.platform === 'chatgpt' || dashboard.platform === 'claude') &&
              !sidebar?.demo)
          }
          onSelectAccount={(id) =>
            setDashboard({
              platform: dashboard.platform,
              ...(id !== undefined ? { accountId: id } : {}),
            })
          }
          onSync={() => {
            const ids = dashboardIds();
            void runSync(ids, () => api.syncProfiles(ids));
          }}
          onOpenPlatform={() => void api.openOnPlatform(dashboard.platform).catch(showError)}
          onReview={navigate}
          onRenamed={() => setVersion((v) => v + 1)}
        />
      ) : (
        <>
          <ChatList
            items={items}
            total={total}
            loading={loading}
            filters={filters}
            options={options}
            search={searchInput}
            focusSearchToken={focusSearchToken}
            selected={selected}
            openId={openId}
            now={now}
            onSearch={(s) => {
              setSearchInput(s);
              setLimit(PAGE_SIZE);
              if (!s.trim()) setEverywhere(false);
            }}
            sort={sort}
            onSort={(v) => {
              setSort(v);
              setLimit(PAGE_SIZE);
            }}
            everywhere={everywhere}
            onEverywhere={(v) => {
              setEverywhere(v);
              setSelected(new Set());
              setLimit(PAGE_SIZE);
            }}
            retention={retention}
            onPurge={() => void askPurge([...selected])}
            onFilters={navigate}
            onToggle={toggle}
            onToggleAllVisible={toggleAllVisible}
            onSelectAllMatching={() => void selectAllMatching()}
            onClearSelection={() => setSelected(new Set())}
            onOpen={setOpenId}
            onLoadMore={() => setLimit((l) => l + PAGE_SIZE)}
            onBulk={(type) => void runBulk([...selected], { type })}
            onBulkTag={(tag) => void runBulk([...selected], { type: 'tag', tag })}
          />
          <Reader
            key={openId ?? 'none'} // editing state belongs to one chat
            chat={chat}
            missing={missing}
            now={now}
            onOpenPlatform={openOnPlatform}
            onRename={(id, title) =>
              void api
                .setTitle(id, title)
                .then(() => setVersion((v) => v + 1))
                .catch(showError)
            }
            onAction={(id, type) => void runBulk([id], { type })}
            onAddTag={(id, tag) => void runBulk([id], { type: 'tag', tag })}
            onPurge={(id) => void askPurge([id])}
            onRemoveTag={(id, tag) =>
              void api
                .removeTag(id, tag)
                .then(() => setVersion((v) => v + 1))
                .catch(showError)
            }
          />
        </>
      )}
      <ToastView toast={toast} onDismiss={() => setToast(null)} />
      {purging && (
        <PurgeDialog
          preview={purging.preview}
          plan={purging.plan}
          onDeleteHere={deleteHere}
          onDeleteOnPlatform={deleteOnPlatform}
          onCancel={() => setPurging(null)}
        />
      )}
      {addingProfile === 'claude-code' && (
        <AddProfileDialog
          platform="claude-code"
          defaultName="This Mac"
          onSubmit={connectClaudeCode}
          onClose={() => setAddingProfile(null)}
        />
      )}
      {addingProfile && addingProfile !== 'claude-code' && (
        <SignInDialog
          platform={addingProfile}
          onDone={(r) => signedIn(addingProfile, r)}
          onCancel={() => setAddingProfile(null)}
        />
      )}
    </div>
  );
}
