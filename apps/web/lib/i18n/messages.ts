// All dictionaries (both locales). Import this only on the server (getT, layouts) or where both locales are really
// needed; client components get their messages from LocaleProvider (lib/i18n/client.tsx), which receives just the
// active locale and the route group's scope, so the dictionaries are not part of any shared client bundle.
//
// The module has no top-level side effects (merging is lazy), so a client file that imports only constants from
// '@/lib/i18n' does not drag the dictionaries in.
import { account } from './dict/account';
import { common } from './dict/common';
import { compliance } from './dict/compliance';
import { connect } from './dict/connect';
import { core } from './dict/core';
import { counter } from './dict/counter';
import { deliveryGuest } from './dict/delivery-guest';
import { deliveryStaff } from './dict/delivery-staff';
import { driver } from './dict/driver';
import { finance } from './dict/finance';
import { guest } from './dict/guest';
import { home } from './dict/home';
import { insights } from './dict/insights';
import { insightsArea } from './dict/insights-area';
import { integrations } from './dict/integrations';
import { integrationsWave4 } from './dict/integrations-wave4';
import { integrationsActivation } from './dict/integrations-activation';
import { integrationsMarketplace } from './dict/integrations-marketplace';
import { intelligence } from './dict/intelligence';
import { marketing } from './dict/marketing';
import { loyalty } from './dict/loyalty';
import { mcp } from './dict/mcp';
import { notifications } from './dict/notifications';
import { onboarding } from './dict/onboarding';
import { ops } from './dict/ops';
import { opsBoard } from './dict/ops-board';
import { pay } from './dict/pay';
import { platform } from './dict/platform';
import { shell } from './dict/shell';
import { studio } from './dict/studio';
import { studioAi } from './dict/studio-ai';
import { studioWorkspace } from './dict/studio-workspace';
import { allergens, vocab } from './dict/vocab';
import { formatMessage } from './format-message';
import type { Locale, Messages } from './locale';

const PARTS = [common, core, insights, insightsArea, home, platform, connect, marketing, pay, driver, studio, studioAi, studioWorkspace, finance, compliance, intelligence, mcp, notifications, loyalty, integrations, integrationsWave4, integrationsActivation, integrationsMarketplace, vocab, allergens, guest, ops, opsBoard, account, deliveryGuest, deliveryStaff, counter, shell, onboarding];

let merged: Record<Locale, Messages> | null = null;
function all(): Record<Locale, Messages> {
  if (!merged) {
    const m: Record<Locale, Messages> = { en: {}, ar: {} };
    for (const p of PARTS) { Object.assign(m.en, p.en); Object.assign(m.ar, p.ar); }
    merged = m;
  }
  return merged;
}

/** Both locales, merged across modules (raw: Arabic entries do not include English fallbacks). */
export const dictionaries: Record<Locale, Messages> = {
  get en() { return all().en; },
  get ar() { return all().ar; },
};

/** Translate with {name} interpolation and plurals; falls back to English, then the key. */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const d = all();
  return formatMessage(d[locale][key] ?? d.en[key] ?? key, locale, vars);
}

/**
 * Message scopes per route group. Guest pages (QR table, ordering, booking, payment, restaurant site) receive only
 * the shared and guest namespaces; staff route groups add the rest. The landing page reads its own copy
 * (platform.lp.*) and is excluded from both. lib/i18n/scopes.test.ts checks that every key the guest routes use is
 * covered.
 */
export const GUEST_SCOPE: RegExp[] = [
  /^app\./, /^action\./, /^state\./, /^lang\./, /^err\./, /^plural\./,
  /^core\.(guest|bill|status|res|web|dietary|allergen|feature|method|channel|payment)\./,
  /^pay\./, /^connect\.order\./, /^marketing\.consent\./, /^connect\.sandbox/, /^studio\.site\./, /^platform\.(?!lp\.)/,
];
const LANDING = /^platform\.lp\./;
/**
 * Sign-in, sign-up, onboarding and invitation pages need only the auth copy on top of the guest scope the root layout
 * already ships; the full staff scope (every module's copy, ~140 KB of text) is serialised into each staff HTML
 * document, so these entry pages must not carry it. lib/i18n/scopes.test.ts checks their keys are covered.
 */
export const AUTH_SCOPE: RegExp[] = [/^auth\./, /^role\./]; // role names: the account page lists memberships (CR-05)
/** The onboarding wizard (21-ONB): the auth copy plus its own (onb.*), never every module's. */
export const ONBOARDING_SCOPE: RegExp[] = [...AUTH_SCOPE, /^onb\./];
export type MessageScope = 'guest' | 'staff' | 'auth' | 'onboarding';
export const inScope = (key: string, scope: MessageScope) => {
  if (LANDING.test(key)) return false;
  const guest = GUEST_SCOPE.some((r) => r.test(key));
  if (scope === 'guest') return guest;
  if (scope === 'auth') return !guest && AUTH_SCOPE.some((r) => r.test(key));
  if (scope === 'onboarding') return !guest && ONBOARDING_SCOPE.some((r) => r.test(key));
  return !guest;
};

const scoped = new Map<string, Messages>();
/** The messages a route group's client components need, for one locale, with English fallbacks applied. */
export function messagesFor(locale: Locale, scope: MessageScope): Messages {
  const cacheKey = `${locale}|${scope}`;
  let out = scoped.get(cacheKey);
  if (!out) {
    const d = all();
    out = {};
    for (const key of new Set([...Object.keys(d.en), ...Object.keys(d.ar)])) {
      if (inScope(key, scope)) out[key] = d[locale][key] ?? d.en[key]!;
    }
    scoped.set(cacheKey, out);
  }
  return out;
}
