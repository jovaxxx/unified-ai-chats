import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncProgress } from '../../shared/types';

/**
 * Shown while syncs run: for each profile (or only the given ones), how far it is and whether the platform is
 * making it wait. Every profile syncs on its own, so each has its own line.
 */
export function SyncProgressLine({ accountIds }: { accountIds?: number[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState<SyncProgress[]>([]);
  useEffect(() => {
    let live = true;
    const tick = () =>
      void window.api
        .syncProgress()
        .then((r) => live && setAll(r))
        .catch(() => undefined);
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const shown = accountIds ? all.filter((p) => accountIds.includes(p.accountId)) : all;
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((p) => {
        const text =
          p.phase === 'listing'
            ? t('sync.listing', { label: p.label, count: p.done })
            : t('sync.reading', { label: p.label, done: p.done, total: p.total });
        return (
          <div className="sync-progress" role="status" aria-live="off" key={p.accountId}>
            <div>{text}</div>
            {p.phase === 'reading' && p.total > 0 && (
              <progress max={p.total} value={p.done} aria-label={text} />
            )}
            {p.waitingSeconds !== null && (
              <div className="sync-wait">{t('sync.waiting', { seconds: p.waitingSeconds })}</div>
            )}
          </div>
        );
      })}
    </>
  );
}
