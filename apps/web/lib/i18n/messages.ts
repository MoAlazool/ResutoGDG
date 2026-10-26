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
import { crm } from './dict/crm';
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
import { menuWorkspace } from './dict/menu-workspace';
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
import { ROUTE_FAMILIES, type RouteScope } from './route-families';

const PARTS = [common, core, insights, insightsArea, home, crm, platform, connect, marketing, pay, driver, studio, studioAi, studioWorkspace, finance, compliance, intelligence, mcp, notifications, loyalty, integrations, integrationsWave4, integrationsActivation, integrationsMarketplace, vocab, allergens, guest, ops, opsBoard, menuWorkspace, account, deliveryGuest, deliveryStaff, counter, shell, onboarding];

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
 * Message scopes. The root layout ships only the base scope (labels every page can show: app name, actions, states,
 * errors). Each route group adds its own on top (lib/i18n/scope.tsx ScopeMessages, components/shell/StaffProviders,
 * lib/i18n/route-messages.tsx RouteMessages): guest pages (QR table, ordering, booking, payment, restaurant site) the
 * guest namespaces, the landing and pricing pages the public ones, the sign-in, onboarding and console pages their own,
 * and staff screens the families their source uses (lib/i18n/route-families.ts). Before 21-PERF the root layout gave
 * every document, staff and sign-in pages included, the whole guest scope (~55 KB of text).
 * lib/i18n/scopes.test.ts and route-scopes.test.ts check that every scope covers the keys its routes use.
 */
export const BASE_SCOPE: RegExp[] = [/^app\./, /^action\./, /^state\./, /^lang\./, /^err\./, /^plural\./];
/**
 * Guest payment copy: the payment page, split bill, receipt, payment methods and failures. The rest of pay.* (the
 * payments workspace: dashboard, reconciliation, alerts, refunds, cash, links) is staff copy.
 */
const GUEST_PAY = /^pay\.(?:[^.]+$|(?:receipt|method|error|status|failure|sandbox|share|invite|bill|split)\.)/;
export const GUEST_SCOPE: RegExp[] = [
  ...BASE_SCOPE,
  /^core\.(guest|bill|status|res|web|dietary|allergen|feature|method|channel|payment)\./,
  GUEST_PAY, /^connect\.order\./, /^marketing\.consent\./, /^connect\.sandbox/, /^studio\.site\./, /^platform\.(?!lp\.)/,
];
const LANDING = /^platform\.lp\./;
/** The landing and pricing pages: their client components read only the platform copy (the landing copy itself, platform.lp.*, is passed as props). */
export const PUBLIC_SCOPE: RegExp[] = [/^platform\.(?!lp\.)/];
/**
 * Sign-in, sign-up, onboarding and invitation pages need only the auth copy on top of the base scope the root layout
 * ships; the full staff scope (every module's copy, ~300 KB of text) must not be serialised into these entry pages.
 * lib/i18n/scopes.test.ts checks their keys are covered.
 */
export const AUTH_SCOPE: RegExp[] = [/^auth\./, /^role\./]; // role names: the account page lists memberships (CR-05)
/** The onboarding wizard (21-ONB): the auth copy plus its own (onb.*) and the social network names, never every module's. */
export const ONBOARDING_SCOPE: RegExp[] = [...AUTH_SCOPE, /^onb\./, /^core\.guest\.social\./];
/**
 * The operator console (/admin, 21-ADMIN): the auth copy (session errors), the shell's (account menu, area errors) and
 * the operations replay copy; the console's own strings come from app/admin/strings.ts through its server layout.
 * Like the auth and onboarding scopes, a subset of the staff scope.
 */
export const ADMIN_SCOPE: RegExp[] = [...AUTH_SCOPE, /^shell\./, /^ops\.admin\./];
/** 'staff' is every staff key (the reference set of the tests); staff screens get route scopes (routeMessages). */
export type MessageScope = 'base' | 'guest' | 'public' | 'staff' | 'auth' | 'onboarding' | 'admin';
export const inScope = (key: string, scope: MessageScope) => {
  if (LANDING.test(key)) return false;
  const base = BASE_SCOPE.some((r) => r.test(key));
  if (scope === 'base') return base;
  const guest = GUEST_SCOPE.some((r) => r.test(key));
  if (scope === 'guest') return guest;
  if (scope === 'public') return !base && PUBLIC_SCOPE.some((r) => r.test(key));
  if (scope === 'auth') return !base && AUTH_SCOPE.some((r) => r.test(key));
  if (scope === 'onboarding') return !base && ONBOARDING_SCOPE.some((r) => r.test(key));
  if (scope === 'admin') return !base && ADMIN_SCOPE.some((r) => r.test(key));
  return !guest;
};

const scoped = new Map<string, Messages>();
function collect(locale: Locale, cacheKey: string, keep: (key: string) => boolean): Messages {
  let out = scoped.get(cacheKey);
  if (!out) {
    const d = all();
    out = {};
    for (const key of new Set([...Object.keys(d.en), ...Object.keys(d.ar)])) {
      if (keep(key)) out[key] = d[locale][key] ?? d.en[key]!;
    }
    scoped.set(cacheKey, out);
  }
  return out;
}

/** The messages a route group's client components need, for one locale, with English fallbacks applied. */
export function messagesFor(locale: Locale, scope: MessageScope): Messages {
  return collect(locale, `${locale}|${scope}`, (key) => inScope(key, scope));
}

/** A scope as a layer over the root layout's base scope (the base keys are already in the document once). */
export function layerMessages(locale: Locale, scope: MessageScope): Messages {
  return collect(locale, `${locale}|layer:${scope}`, (key) => inScope(key, scope) && !BASE_SCOPE.some((r) => r.test(key)));
}

/** 'core.orders.subtitle' -> 'core.orders'; 'nav.orders' -> 'nav' (a key without its last segment, at most two segments). */
export const familyOf = (key: string): string => {
  const s = key.split('.');
  return s.slice(0, Math.min(2, s.length - 1)).join('.');
};

/**
 * A staff route's messages (lib/i18n/route-families.ts): the families its source uses, minus the base scope and
 * minus what its parent route already ships (a module screen sits inside the dashboard shell's scope).
 */
export function routeMessages(locale: Locale, route: RouteScope): Messages {
  const own = new Set<string>(ROUTE_FAMILIES[route]);
  const parent = route.startsWith('dashboard/') ? new Set<string>(ROUTE_FAMILIES.dashboard) : null;
  return collect(locale, `${locale}|route:${route}`, (key) => {
    if (LANDING.test(key) || BASE_SCOPE.some((r) => r.test(key))) return false;
    const f = familyOf(key);
    return own.has(f) && !parent?.has(f);
  });
}
