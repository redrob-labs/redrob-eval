'use client';

import { useLocale } from '@/components/LocaleProvider';
import { LOCALES, LOCALE_LABELS, type Locale } from '@/lib/i18n/locale';

/**
 * Language choice for Settings → Appearance.
 * Same radiogroup pattern as ThemeSwitch.
 */
export function LocaleSwitch() {
  const { locale, setLocale, t } = useLocale();

  return (
    <div className="theme-switch">
      <div className="theme-switch-options" role="radiogroup" aria-label={t('locale.aria')}>
        {LOCALES.map((option: Locale) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={locale === option}
            className={`theme-switch-option${locale === option ? ' on' : ''}`}
            onClick={() => setLocale(option)}
          >
            {LOCALE_LABELS[option]}
          </button>
        ))}
      </div>
    </div>
  );
}
