import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Platform, SignInStatus } from '../../shared/types';
import { PlatformLogo } from './PlatformLogo';

type SignedIn = Extract<SignInStatus, { state: 'signed-in' }>;
type Phase =
  | { k: 'starting' }
  | { k: 'waiting' }
  | { k: 'closed' }
  | { k: 'choose'; status: SignedIn }
  | { k: 'error'; message: string };

export interface SignInResult {
  accountId: number;
  created: boolean;
  label: string;
}

interface Props {
  platform: Platform;
  onDone: (result: SignInResult) => void;
  onCancel: () => void;
}

const POLL_MS = 1500;
const NAME_MAX = 40;

/**
 * Adds a web account the way an email client does: sign in first, then the app works out whether that
 * account is already one of your profiles. A profile is only created (and only then named) if it is new.
 */
export function SignInDialog({ platform, onDone, onCancel }: Props) {
  const { t } = useTranslation();
  const platformName = t(`platforms.${platform}`);
  const [phase, setPhase] = useState<Phase>({ k: 'starting' });
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0); // bump to start over
  const finished = useRef(false);

  // The choice made in the "signed in" step.
  const [pick, setPick] = useState<'new' | number | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Open the sign-in window. If this dialog goes away before the user finishes, the attempt is cancelled
  // (window closed, session wiped), so nothing half-finished is left behind.
  useEffect(() => {
    let cancelled = false;
    let id: string | null = null;
    finished.current = false;
    window.api
      .signInStart(platform)
      .then((r) => {
        if (cancelled) {
          void window.api.signInCancel(r.attemptId).catch(() => undefined);
          return;
        }
        id = r.attemptId;
        setAttemptId(r.attemptId);
        setPhase({ k: 'waiting' });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
      if (id && !finished.current) void window.api.signInCancel(id).catch(() => undefined);
    };
  }, [platform, attempt]);

  const finish = async (
    id: string,
    choice: Parameters<typeof window.api.signInFinish>[1],
    label: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.signInFinish(id, choice);
      finished.current = true;
      onDone({ ...res, label });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const handleStatus = (s: SignInStatus, id: string) => {
    if (s.state === 'closed') {
      finished.current = true;
      setPhase({ k: 'closed' });
    } else if (s.state === 'signed-in') {
      if (s.match) {
        // Already one of the profiles: nothing to ask, just reconnect it.
        void finish(id, { type: 'existing', accountId: s.match.id }, s.match.label);
        return;
      }
      setName((s.displayName ?? '').slice(0, NAME_MAX));
      setPick(s.candidates.length === 0 ? 'new' : null);
      setPhase({ k: 'choose', status: s });
    }
  };

  // Wait for the user to sign in.
  useEffect(() => {
    if (phase.k !== 'waiting' || !attemptId) return;
    let stopped = false;
    const tick = () =>
      window.api
        .signInStatus(attemptId, false)
        .then((s) => {
          if (!stopped) handleStatus(s, attemptId);
        })
        .catch(() => undefined);
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // handleStatus only uses setters and props that are stable for the life of this phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k, attemptId]);

  const retry = () => {
    setPhase({ k: 'starting' });
    setAttempt((n) => n + 1);
  };

  const cancel = () => {
    if (attemptId && !finished.current) {
      finished.current = true;
      void window.api.signInCancel(attemptId).catch(() => undefined);
    }
    onCancel();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!attemptId || phase.k !== 'choose' || pick === null) return;
    if (pick === 'new') void finish(attemptId, { type: 'new', label: name }, name.trim());
    else {
      const label = phase.status.candidates.find((c) => c.id === pick)?.label ?? '';
      void finish(attemptId, { type: 'existing', accountId: pick }, label);
    }
  };

  return (
    <div className="overlay">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
        onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && cancel()}
      >
        <div className="dialog-head">
          <PlatformLogo platform={platform} />
          <h2 id="signin-title">{t('signin.title', { platform: platformName })}</h2>
        </div>

        {phase.k === 'starting' && <p className="dialog-note">{t('signin.starting')}</p>}

        {phase.k === 'waiting' && (
          <>
            <p className="dialog-note">{t('signin.waiting', { platform: platformName })}</p>
            <p className="dialog-note">{t('signin.noPassword')}</p>
            <div className="signin-wait" role="status">
              <span className="rec-dot" aria-hidden="true" />
              {t('signin.watching')}
            </div>
            <p className="dialog-note">{t('signin.signedInHint')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={cancel}>
                {t('dialog.cancel')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  attemptId &&
                  void window.api
                    .signInStatus(attemptId, true)
                    .then((s) => handleStatus(s, attemptId))
                    .catch(() => undefined)
                }
              >
                {t('signin.signedIn')}
              </button>
            </div>
          </>
        )}

        {phase.k === 'closed' && (
          <>
            <p className="dialog-note">{t('signin.closed')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onCancel}>
                {t('dialog.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={retry}>
                {t('signin.retry')}
              </button>
            </div>
          </>
        )}

        {phase.k === 'error' && (
          <>
            <div className="form-error" role="alert">
              {phase.message}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onCancel}>
                {t('dialog.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={retry}>
                {t('signin.retry')}
              </button>
            </div>
          </>
        )}

        {phase.k === 'choose' && (
          <>
            <p className="dialog-note">
              {phase.status.identityKnown
                ? t('signin.newAccount', { platform: platformName })
                : t('signin.unknownAccount', { platform: platformName })}
            </p>
            <fieldset className="choices">
              <legend>{t('signin.which')}</legend>
              {phase.status.candidates.map((c) => (
                <label key={c.id} className="choice">
                  <input
                    type="radio"
                    name="which"
                    checked={pick === c.id}
                    onChange={() => setPick(c.id)}
                  />
                  <span>{t('signin.existingOption', { label: c.label })}</span>
                </label>
              ))}
              <label className="choice">
                <input
                  type="radio"
                  name="which"
                  checked={pick === 'new'}
                  onChange={() => setPick('new')}
                />
                <span>{t('signin.newOption')}</span>
              </label>
            </fieldset>
            {pick === 'new' && (
              <>
                <label className="field">
                  <span>{t('dialog.nameLabel')}</span>
                  <input
                    autoFocus
                    value={name}
                    maxLength={NAME_MAX}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <p className="dialog-note">{t('dialog.nameHint')}</p>
              </>
            )}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn" disabled={busy} onClick={cancel}>
                {t('dialog.cancel')}
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || pick === null || (pick === 'new' && !name.trim())}
              >
                {t('signin.continue')}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
