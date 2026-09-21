import { useTranslation } from 'react-i18next';
import type { Platform } from '../../shared/types';
import { PlatformLogo } from './PlatformLogo';

/** What a brand-new install shows: no data at all, just how to connect the first account. */
export function Welcome({ onAdd }: { onAdd: (platform: Platform) => void }) {
  const { t } = useTranslation();
  const choices: Platform[] = ['chatgpt', 'claude', 'claude-code'];
  return (
    <main className="dash welcome" aria-label={t('welcome.label')}>
      <div className="welcome-box">
        <h1 className="dash-title">{t('welcome.title')}</h1>
        <p className="welcome-lead">{t('welcome.lead')}</p>
        <div className="welcome-choices">
          {choices.map((p) => (
            <button key={p} type="button" className="btn btn--lg" onClick={() => onAdd(p)}>
              <PlatformLogo platform={p} />
              {p === 'claude-code' ? t('nav.claudeCodeLocal') : t(`platforms.${p}`)}
            </button>
          ))}
        </div>
        <ul className="welcome-points">
          <li>{t('welcome.pointSync')}</li>
          <li>{t('welcome.pointLocal')}</li>
          <li>{t('welcome.pointRead')}</li>
        </ul>
      </div>
    </main>
  );
}
