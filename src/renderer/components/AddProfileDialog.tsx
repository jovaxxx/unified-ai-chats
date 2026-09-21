import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Platform } from '../../shared/types';
import { PlatformLogo } from './PlatformLogo';

interface Props {
  platform: Platform;
  defaultName: string;
  /** Resolves when the profile was created; rejects with a message to show in the dialog. */
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

/** Asks for the profile's name when it is created (a client, a project, "Personal"…). */
export function AddProfileDialog({ platform, defaultName, onSubmit, onClose }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-profile-title"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
      >
        <div className="dialog-head">
          <PlatformLogo platform={platform} />
          <h2 id="add-profile-title">{t('nav.profileName')}</h2>
        </div>
        <p className="dialog-note">{t('dialog.localNote')}</p>
        <label className="field">
          <span>{t('dialog.nameLabel')}</span>
          <input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="dialog-note">{t('dialog.nameHint')}</p>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
            {busy ? t('dialog.connecting') : t('dialog.connect')}
          </button>
        </div>
      </form>
    </div>
  );
}
