import { common } from './dict/common';
import { compliance } from './dict/compliance';
import { connect } from './dict/connect';
import { core } from './dict/core';
import { driver } from './dict/driver';
import { finance } from './dict/finance';
import { intelligence } from './dict/intelligence';
import { marketing } from './dict/marketing';
import { mcp } from './dict/mcp';
import { pay } from './dict/pay';
import { platform } from './dict/platform';
import { studio } from './dict/studio';

export type Locale = 'en' | 'ar';
export const LOCALE_COOKIE = 'resuto_locale';
export const isRtl = (l: Locale) => l === 'ar';

const parts = [common, core, platform, connect, marketing, pay, driver, studio, finance, compliance, intelligence, mcp];
const merged: Record<Locale, Record<string, string>> = { en: {}, ar: {} };
for (const p of parts) {
  Object.assign(merged.en, p.en);
  Object.assign(merged.ar, p.ar);
}
export const dictionaries = merged;

/** Translate with {name} interpolation; falls back to English, then the key. */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let s = merged[locale][key] ?? merged.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
