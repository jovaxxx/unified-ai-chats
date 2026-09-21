import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import it from './locales/it.json';

export const LANGUAGES = ['en', 'it'] as const;
export type Language = (typeof LANGUAGES)[number];

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem('language');
    if (saved === 'en' || saved === 'it') return saved;
  } catch {
    /* storage unavailable: fall through */
  }
  return 'en'; // English by default
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, it: { translation: it } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
});

export function setLanguage(lang: Language): void {
  try {
    localStorage.setItem('language', lang);
  } catch {
    /* ignore */
  }
  void i18n.changeLanguage(lang);
}

export default i18n;
