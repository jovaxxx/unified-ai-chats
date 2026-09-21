import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Platform, RecorderStatus } from '../../shared/types';

interface Props {
  platform: Platform;
  /** The selected profile; the recorder always works on one profile. */
  accountId: number | undefined;
}

/** Developer tool: records the STRUCTURE of a web platform's API so its connector can be built. */
export function RecorderCard({ platform, accountId }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const platformName = t(`platforms.${platform}`);

  // Poll while mounted: counts change as the user browses in the other window.
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      window.api
        .recorderStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => undefined);
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const run = async (job: () => Promise<unknown>) => {
    setError(null);
    try {
      await job();
      setStatus(await window.api.recorderStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const recordingHere = status?.state === 'recording' && status.accountId === accountId;
  const recordingElsewhere = status?.state === 'recording' && status.accountId !== accountId;

  return (
    <section className="card card--wide" aria-labelledby="rec-title">
      <div className="card-head">
        <div className="card-title" id="rec-title">
          {t('rec.title')}
        </div>
        <div className="card-aside">{t('rec.tag')}</div>
      </div>
      <p className="empty-note">{t('rec.intro', { platform: platformName })}</p>
      <details className="rec-steps">
        <summary>{t('rec.steps')}</summary>
        <ol>
          <li>{t('rec.step1', { platform: platformName })}</li>
          <li>{t('rec.step2')}</li>
          <li>{t('rec.step3', { platform: platformName })}</li>
          <li>{t('rec.step4')}</li>
        </ol>
      </details>
      <details className="rec-steps">
        <summary>{t('rec.writeTitle')}</summary>
        <ol>
          <li>{t('rec.write1')}</li>
          <li>{t('rec.write2')}</li>
          <li>
            <strong>{t('rec.write3')}</strong>
          </li>
          <li>{t('rec.write4')}</li>
        </ol>
      </details>

      {accountId === undefined ? (
        <p className="empty-note">{t('rec.pick')}</p>
      ) : (
        <div className="rec-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void run(() => window.api.openLogin(accountId))}
          >
            {t('dash.signIn')}
          </button>
          {recordingHere ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void run(() => window.api.recorderStop())}
            >
              {t('rec.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={recordingElsewhere}
              onClick={() => void run(() => window.api.recorderStart(accountId))}
            >
              {t('rec.start')}
            </button>
          )}
          {recordingElsewhere && <span className="empty-note">{t('rec.busyOther')}</span>}
        </div>
      )}

      {recordingHere && status && (
        <div className="rec-live" role="status">
          <span className="rec-dot" aria-hidden="true" />
          {t('rec.recording', { requests: status.requests, endpoints: status.endpoints })}
        </div>
      )}
      {!recordingHere && status?.saved && (
        <div className="rec-saved">
          <div>
            {t('rec.saved', { requests: status.saved.requests, endpoints: status.saved.endpoints })}
          </div>
          <code className="rec-path">{status.saved.path}</code>
          <div className="rec-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void run(() => window.api.revealReport())}
            >
              {t('rec.reveal')}
            </button>
            <span className="empty-note">{t('rec.checkFirst')}</span>
          </div>
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
