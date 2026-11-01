'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'en' | 'ar';
type I18n = { locale: Locale; t: (key: string, vars?: Record<string, string | number>) => string };
const Context = createContext<I18n>({ locale: 'en', t: (key) => key });
const EVENT = 'resuto:locale';

const copy: Record<Locale, Record<string, string>> = {
  en: {
    'platform.signup': 'Request access',
    'platform.seePricing': 'See plans and prices',
    'platform.pricingUnavailable': 'See the maintained public price list.',
  },
  ar: {
    'platform.signup': 'اطلب الوصول',
    'platform.seePricing': 'عرض الخطط والأسعار',
    'platform.pricingUnavailable': 'راجع قائمة الأسعار العامة المحدّثة.',
  },
};

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setCurrent] = useState<Locale>('en');
  useEffect(() => {
    const saved = window.localStorage.getItem('resuto_locale');
    const query = new URLSearchParams(window.location.search).get('lang');
    const initial: Locale = query === 'ar' || query === 'en' ? query : saved === 'ar' ? 'ar' : 'en';
    setCurrent(initial);
    const onLocale = (event: Event) => setCurrent((event as CustomEvent<Locale>).detail);
    window.addEventListener(EVENT, onLocale);
    return () => window.removeEventListener(EVENT, onLocale);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    let value = copy[locale][key] ?? copy.en[key] ?? key;
    for (const [name, replacement] of Object.entries(vars ?? {})) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  }, [locale]);
  const value = useMemo(() => ({ locale, t }), [locale, t]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useT() {
  const value = useContext(Context);
  return { ...value, dir: value.locale === 'ar' ? 'rtl' : 'ltr' } as const;
}

export function setLocale(locale: Locale) {
  window.localStorage.setItem('resuto_locale', locale);
  document.cookie = `resuto_locale=${locale}; path=/; max-age=31536000; samesite=lax`;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: locale }));
}
