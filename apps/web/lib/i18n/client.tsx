'use client';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { formatMessage } from './format-message';
import { LOCALE_COOKIE, type Locale, type Messages } from './locale';

// Client-side strings. The server passes only the active locale's messages for the route group (see
// lib/i18n/messages.ts messagesFor), so no dictionary is bundled into client JavaScript.

interface LocaleValue { locale: Locale; messages: Messages }
const LocaleContext = createContext<LocaleValue>({ locale: 'en', messages: {} });
/** Both locales' messages, for the rare page that switches language without a reload (WhatsApp ordering link). */
const CatalogContext = createContext<Partial<Record<Locale, Messages>>>({});

/**
 * Sets the language for a subtree. The root layout passes the server-selected messages; a nested provider that
 * switches language in place takes them from the nearest LocaleCatalog (or keeps the parent's when unchanged).
 */
export function LocaleProvider({ locale, messages, children }: { locale: Locale; messages?: Messages; children: ReactNode }) {
  const parent = useContext(LocaleContext);
  const catalog = useContext(CatalogContext);
  const resolved = messages ?? catalog[locale] ?? parent.messages;
  const value = useMemo(() => ({ locale, messages: resolved }), [locale, resolved]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function LocaleCatalog({ catalog, children }: { catalog: Partial<Record<Locale, Messages>>; children: ReactNode }) {
  return <CatalogContext.Provider value={catalog}>{children}</CatalogContext.Provider>;
}

/** Adds a route group's messages (e.g. the staff namespaces) on top of the root layout's shared ones. */
export function LocaleScope({ messages, children }: { messages: Messages; children: ReactNode }) {
  const parent = useContext(LocaleContext);
  const value = useMemo(() => ({ locale: parent.locale, messages: { ...parent.messages, ...messages } }), [parent, messages]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useT() {
  const { locale, messages } = useContext(LocaleContext);
  /** `t(key, vars)`: {name} interpolation and plurals ({n, plural, one {…} other {…}}); unknown keys show the key. */
  const t = useCallback((key: string, vars?: Record<string, string | number>) => formatMessage(messages[key] ?? key, locale, vars), [locale, messages]);
  return { locale, t, dir: locale === 'ar' ? 'rtl' : 'ltr' } as const;
}

export function setLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}

export function LanguageToggle({ className = 'lang-toggle' }: { className?: string }) {
  const { locale, t } = useT();
  const target: Locale = locale === 'ar' ? 'en' : 'ar';
  return (
    <button type="button" className={className} onClick={() => setLocale(target)} lang={target}
      aria-label={target === 'ar' ? 'التبديل إلى العربية' : 'Switch to English'}>
      {t('lang.switch')}
    </button>
  );
}
