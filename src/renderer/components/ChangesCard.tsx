import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Platform, SidebarAccount } from '../../shared/types';

interface Props {
  platform: Platform;
  /** The selected profile, as the sidebar knows it. */
  account: SidebarAccount | undefined;
  onChanged: () => void;
}

/**
 * The per-profile switch "allow this app to change things on the platform". Off by default. It is turned on
 * only after reading what that means, and it can only be turned on if the connector really can do something.
 */
export function ChangesCard({ platform, account, onChanged }: Props) {
  const { t } = useTranslation();
  const platformName = t(`platforms.${platform}`);
  const [confirming, setConfirming] = useState(false);
  const [exportDir, setExportDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .queueSummary()
      .then((s) => {
        if (!cancelled) setExportDir(s.exportDir);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!account) {
    return (
      <section className="card card--wide" aria-labelledby="changes-title">
        <div className="card-title" id="changes-title">
          {t('changes.title', { platform: platformName })}
        </div>
        <p className="empty-note">{t('changes.pick')}</p>
      </section>
    );
  }

  const caps = account.canWrite;
  const supported = caps.rename || caps.archive || caps.delete;
  const set = async (allowed: boolean) => {
    setError(null);
    try {
      await window.api.allowChanges(account.id, allowed);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="card card--wide" aria-labelledby="changes-title">
      <div className="card-title" id="changes-title">
        {t('changes.title', { platform: platformName })}
      </div>
      <p className="empty-note">{t('changes.intro', { platform: platformName })}</p>
      {!supported && (
        <p className="notice" role="note">
          {t('changes.unsupported', { platform: platformName })}
        </p>
      )}
      {supported && (
        <p className="empty-note">
          {[
            caps.rename && t('changes.canRename'),
            caps.archive && t('changes.canArchive'),
            caps.delete && t('changes.canDelete'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          checked={account.allowChanges}
          disabled={!supported}
          onChange={(e) => (e.target.checked ? setConfirming(true) : void set(false))}
        />
        <span>{t('changes.allow', { platform: platformName, account: account.label })}</span>
      </label>
      {account.allowChanges && (
        <p className="empty-note">{t('changes.on', { platform: platformName })}</p>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      {confirming && (
        <div
          className="overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setConfirming(false)}
        >
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="allow-title"
            onKeyDown={(e) => e.key === 'Escape' && setConfirming(false)}
          >
            <h2 id="allow-title" className="dialog-title">
              {t('changes.confirmTitle', { platform: platformName })}
            </h2>
            <div className="dialog-body">
              <p className="dialog-note">
                {t('changes.confirmBody', { platform: platformName, account: account.label })}
              </p>
              <p className="dialog-note">
                <strong>{t('changes.confirmDelete', { platform: platformName })}</strong>
                {exportDir && (
                  <>
                    {' '}
                    <code>{exportDir}</code>
                  </>
                )}
              </p>
              <p className="dialog-note">{t('changes.confirmRisk', { platform: platformName })}</p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn" autoFocus onClick={() => setConfirming(false)}>
                {t('trash.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void set(true)}>
                {t('changes.turnOn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
