'use client';
import { createContext } from 'react';
import type { Locale, Messages } from './locale';

// The locale contexts on their own (no components), so the tiny LocaleScope module (locale-scope.tsx) that every
// staff module layout renders does not carry the whole client i18n module into each layout's chunk (21-PERF).
export interface LocaleValue { locale: Locale; messages: Messages }
export const LocaleContext = createContext<LocaleValue>({ locale: 'en', messages: {} });
/** Both locales' messages, for the rare page that switches language without a reload (WhatsApp ordering link). */
export const CatalogContext = createContext<Partial<Record<Locale, Messages>>>({});
