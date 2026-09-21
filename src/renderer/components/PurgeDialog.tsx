import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeletePlan, PurgePreview } from '../../shared/types';

interface Props {
  preview: PurgePreview;
  plan: DeletePlan;
  /** Delete on the platform (after a verified copy), for the profiles that allow it. */
  onDeleteOnPlatform: () => Promise<void>;
  /** Remove from this app only. Nothing changes on any platform. */
  onDeleteHere: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Asks before deleting chats for good. It says how many, from which profiles, WHERE they will be deleted (on the
 * platform, or only here), what is saved first, and that a delete on a platform cannot be undone (never let
 * the user believe a remote action is local, or the opposite).
 */
export function PurgeDialog({ preview, plan, onDeleteOnPlatform, onDeleteHere, onCancel }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onPlatform = plan.allowed.reduce((n, a) => n + a.count, 0);
  const blocked = plan.blocked.reduce((n, a) => n + a.count, 0);

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const platformName = (p: string) => t(`platforms.${p}`);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}
    >
      <div
        className="dialog dialog--wide"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="purge-title"
        aria-describedby="purge-body"
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}
      >
        <h2 id="purge-title" className="dialog-title">
          {t('trash.confirmTitle', { count: preview.count })}
        </h2>
        <div id="purge-body" className="dialog-body">
          {onPlatform > 0 && (
            <section
              className="purge-block purge-block--remote"
              aria-label={t('trash.onPlatformTitle')}
            >
              <h3>{t('trash.onPlatformTitle')}</h3>
              <ul className="purge-list">
                {plan.allowed.map((a) => (
                  <li key={a.accountId}>
                    {t('trash.confirmFrom', {
                      count: a.count,
                      platform: platformName(a.platform),
                      account: a.label,
                    })}
                  </li>
                ))}
              </ul>
              <p className="dialog-note">{t('trash.onPlatformBody')}</p>
              {plan.exportDir && (
                <p className="dialog-note">
                  {t('trash.copyFirst')} <code>{plan.exportDir}</code>
                </p>
              )}
              <label className="choice">
                <input
                  type="checkbox"
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                />
                <span>{t('trash.understand')}</span>
              </label>
            </section>
          )}
          {blocked > 0 && (
            <section className="purge-block" aria-label={t('trash.hereOnlyTitle')}>
              <h3>{t('trash.hereOnlyTitle')}</h3>
              <ul className="purge-list">
                {plan.blocked.map((a) => (
                  <li key={`${a.accountId}-${a.reason}`}>
                    {t('trash.confirmFrom', {
                      count: a.count,
                      platform: platformName(a.platform),
                      account: a.label,
                    })}
                    {' — '}
                    {t(
                      a.reason === 'not_allowed'
                        ? 'trash.reasonNotAllowed'
                        : 'trash.reasonNotSupported',
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {onPlatform === 0 && <p className="dialog-note">{t('trash.confirmBody')}</p>}
          <p className="dialog-note">
            <strong>{t(onPlatform > 0 ? 'trash.hereKeepMixed' : 'trash.confirmKeep')}</strong>
          </p>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions dialog-actions--wrap">
          <button type="button" className="btn" autoFocus disabled={busy} onClick={onCancel}>
            {t('trash.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={() => void run(onDeleteHere)}
          >
            {t(onPlatform > 0 ? 'trash.deleteHereAll' : 'trash.confirm')}
          </button>
          {onPlatform > 0 && (
            <button
              type="button"
              className="btn btn--danger-solid"
              disabled={busy || !understood}
              onClick={() => void run(onDeleteOnPlatform)}
            >
              {t('trash.deleteOnPlatform', { count: onPlatform })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
