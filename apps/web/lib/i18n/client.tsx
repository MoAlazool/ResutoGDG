'use client';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { LOCALE_COOKIE, translate, type Locale } from './index';

const LocaleContext = createContext<Locale>('en');

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useT() {
  const locale = useContext(LocaleContext);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(locale, key, vars), [locale]);
  return { locale, t, dir: locale === 'ar' ? 'rtl' : 'ltr' } as const;
}

export function setLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}

export function LanguageToggle({ className = 'lang-toggle' }: { className?: string }) {
  const { locale, t } = useT();
  return (
    <button type="button" className={className} onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} lang={locale === 'ar' ? 'en' : 'ar'}>
      {t('lang.switch')}
    </button>
  );
}
