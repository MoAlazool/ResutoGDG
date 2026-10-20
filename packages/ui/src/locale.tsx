'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { UiLocale } from './overlays';

// The active UI language for components that format values themselves (date and time fields, states). The web app's
// LocaleProvider sets it, so components no longer need a `locale` prop to show Western-digit Arabic formats.

const UiLocaleContext = createContext<UiLocale>('en');

export function UiLocaleProvider({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  return <UiLocaleContext.Provider value={locale}>{children}</UiLocaleContext.Provider>;
}

export const useUiLocale = () => useContext(UiLocaleContext);
