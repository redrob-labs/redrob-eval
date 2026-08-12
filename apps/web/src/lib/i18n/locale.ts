export type Locale = 'en' | 'ko';

export const LOCALES: Locale[] = ['en', 'ko'];

export const LOCALE_STORAGE_KEY = 'redrob-locale';

export const LOCALE_LABELS: Record<Locale, string> = { en: 'English', ko: '한국어' };

export function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'ko';
}

export function detectDefaultLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  try {
    return navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  } catch {
    return 'en';
  }
}

export function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* blocked */
  }
  return detectDefaultLocale();
}

export function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale === 'ko' ? 'ko' : 'en';
}

/** Pre-paint: set html lang from localStorage / browser before React. */
export const LOCALE_SCRIPT = `(function(){try{
var s=localStorage.getItem('${LOCALE_STORAGE_KEY}');
var l=(s==='en'||s==='ko')?s:(navigator.language||'').toLowerCase().indexOf('ko')===0?'ko':'en';
document.documentElement.lang=l==='ko'?'ko':'en';
}catch(e){document.documentElement.lang='en';}})();`;
