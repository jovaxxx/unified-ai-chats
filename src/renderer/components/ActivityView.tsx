import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActionItem, QueueSummary } from '../../shared/types';
import { PlatformLogo } from './PlatformLogo';

interface Props {
  /** Bumped by the app after anything that changes the queue. */
  version: number;
  onChanged: () => void;
}

const POLL_MS = 2000;

/** Everything waiting to be sent to a platform, what was sent, and what failed, with the controls to steer it. */
export function ActivityView({ version, onChanged }: Props) {
  const { t, i18n } = useTranslation();
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [items, setItems] = useState<ActionItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all([window.api.queueSummary(), window.api.queueList()])
        .then(([s, l]) => {
          if (cancelled) return;
          setSummary(s);
          setItems(l);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [version]);

  const act = async (job: () => Promise<unknown>) => {
    setError(null);
    try {
      await job();
      onChanged();
      setSummary(await window.api.queueSummary());
      setItems(await window.api.queueList());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(
          new Date(iso),
        )
      : '';

  return (
    <main className="dash" aria-label={t('activity.title')}>
      <header className="dash-head">
        <div className="grow">
          <h1 className="dash-title">{t('activity.title')}</h1>
          <div className="dash-sub">
            {summary
              ? t('activity.counts', {
                  pending: summary.pending + summary.running,
                  failed: summary.failed,
                  done: summary.done,
                })
              : t('dash.loading')}
          </div>
        </div>
        {summary && (
          <div className="activity-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void act(() => window.api.queuePause(!summary.paused))}
            >
              {summary.paused ? t('activity.resume') : t('activity.pause')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void act(() => window.api.queueRun())}
            >
              {t('activity.runNow')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={summary.pending === 0}
              onClick={() => void act(() => window.api.queueCancelPending())}
            >
              {t('activity.cancelWaiting')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={summary.failed === 0}
              onClick={() => void act(() => window.api.queueRetryFailed())}
            >
              {t('activity.retryFailed')}
            </button>
            {summary.exportDir && (
              <button
                type="button"
                className="btn"
                onClick={() => void act(() => window.api.openExports())}
              >
                {t('activity.openCopies')}
              </button>
            )}
          </div>
        )}
      </header>

      {summary?.paused && (
        <div className="notice" role="status">
          {t('activity.paused')}
        </div>
      )}
      {summary?.needsSignIn && (
        <div className="form-error" role="alert">
          {t('activity.needsSignIn')}
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <p className="empty-note">{t('activity.note')}</p>

      {items.length === 0 ? (
        <p className="empty-note">{t('activity.empty')}</p>
      ) : (
        <ul className="activity-list">
          {items.map((a) => (
            <li key={a.id} className={`activity-row activity-row--${a.status}`}>
              <PlatformLogo platform={a.platform} />
              <div className="activity-main">
                <div className="activity-line">
                  <strong>{t(`activity.type.${a.type}`)}</strong>
                  {a.chatTitle && <span className="activity-title">“{a.chatTitle}”</span>}
                </div>
                <div className="activity-sub">
                  {t(`platforms.${a.platform}`)} · {a.accountLabel}
                  {a.status === 'pending' &&
                    a.runAfter &&
                    ` · ${t('activity.waitingUntil', { when: when(a.runAfter) })}`}
                  {a.attempts > 0 &&
                    a.status !== 'done' &&
                    ` · ${t('activity.attempts', { count: a.attempts })}`}
                </div>
                {a.lastError && a.status !== 'done' && (
                  <div className="activity-error">{a.lastError}</div>
                )}
              </div>
              <span className={`status-pill status-pill--${a.status}`}>
                {t(`activity.status.${a.status}`)}
              </span>
              <span className="activity-when">{when(a.finishedAt ?? a.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
