// Operator console view logic (21-ADMIN): navigation, the tenants list query and filter chips, labels for codes, the
// operations summary and the provider readiness view. Pure functions, unit tested in console.test.ts (EN and AR).
import type { AdminOperations, AdminProviderAppView, PlatformAppProvider, PlatformRole } from '@resuto/contracts';
import type { ProviderId, Tone } from '@resuto/ui';
import { fill, pickString, type AdminStrings } from './strings';

export type AdminNavKey = 'tenants' | 'prices' | 'operations' | 'providers';
export const ADMIN_NAV: ReadonlyArray<{ key: AdminNavKey; href: string }> = [
  { key: 'tenants', href: '/admin' },
  { key: 'prices', href: '/admin/prices' },
  { key: 'operations', href: '/admin/operations' },
  { key: 'providers', href: '/admin/providers' },
];

/** The console section a path belongs to (a restaurant's page is under Restaurants). */
export function activeAdminNav(pathname: string): AdminNavKey | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/admin' || p.startsWith('/admin/tenants')) return 'tenants';
  return ADMIN_NAV.find((n) => n.key !== 'tenants' && (p === n.href || p.startsWith(`${n.href}/`)))?.key ?? null;
}

export const roleLabel = (s: AdminStrings, role: PlatformRole) => pickString(s, `pr_${role}`, role);

// --- Restaurants list ----------------------------------------------------------------------------------------------

export const TENANT_STATUSES = ['onboarding', 'active', 'suspended', 'closed'] as const;
export const PLAN_IDS = ['free', 'starter', 'growth', 'pro', 'custom'] as const;
export const COUNTRIES = ['EG', 'SA'] as const;
export interface TenantFilters { q: string; status: string; plan: string; country: string }

/** GET /v1/admin/tenants query: 50 per page, newest first (keyset cursor), empty filters left out. */
export function tenantsQuery(f: TenantFilters, cursor: string | null, limit = 50): string {
  const p = new URLSearchParams({ limit: String(limit) });
  const q = f.q.trim();
  if (q) p.set('q', q);
  if (f.status) p.set('status', f.status);
  if (f.plan) p.set('plan', f.plan);
  if (f.country) p.set('country', f.country);
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export const statusLabel = (s: AdminStrings, status: string) => pickString(s, `st_${status}`, status);
export const planLabel = (s: AdminStrings, plan: string | null | undefined) => (plan ? pickString(s, `plan_${plan}`, plan) : s.noPlan);
export const subscriptionLabel = (s: AdminStrings, status: string) => pickString(s, `sub_${status}`, status);
export const countryLabel = (s: AdminStrings, country: string) => pickString(s, `ctry_${country}`, country);

/** The active filters as removable chips (label text; the page wires the removal). */
export function tenantFilterChips(s: AdminStrings, f: TenantFilters): Array<{ key: keyof TenantFilters; text: string }> {
  const out: Array<{ key: keyof TenantFilters; text: string }> = [];
  if (f.q.trim()) out.push({ key: 'q', text: fill(s.chipSearch, { v: f.q.trim() }) });
  if (f.status) out.push({ key: 'status', text: fill(s.chipStatus, { v: statusLabel(s, f.status) }) });
  if (f.plan) out.push({ key: 'plan', text: fill(s.chipPlan, { v: planLabel(s, f.plan) }) });
  if (f.country) out.push({ key: 'country', text: fill(s.chipCountry, { v: countryLabel(s, f.country) }) });
  return out;
}

/** Sorts nulls (no order yet) after every date, in both directions of the table's sort. */
export const byDate = (a: string | null | undefined, b: string | null | undefined) => (a ? Date.parse(a) : -Infinity) - (b ? Date.parse(b) : -Infinity);

// --- Operations -----------------------------------------------------------------------------------------------------

export type OpsTone = 'ok' | 'warn' | 'danger';
export interface OpsTile { key: 'outbox' | 'handlers' | 'webhooks' | 'jobs'; value: number; tone: OpsTone }

/** The four health tiles: a count each (failures summed), and how worried to be. */
export function opsTiles(d: AdminOperations): OpsTile[] {
  const h = d.eventHandlings;
  const stuck = h.stuck ?? 0;
  const failedJobs = d.jobs.filter((j) => j.status === 'failed').length;
  return [
    { key: 'outbox', value: d.outbox.unpublished, tone: d.outbox.retrying ? 'warn' : 'ok' },
    { key: 'handlers', value: h.failed + h.dead + stuck, tone: h.dead || stuck ? 'danger' : h.failed ? 'warn' : 'ok' },
    { key: 'webhooks', value: d.webhooks.failed + d.webhooks.rejected, tone: d.webhooks.failed || d.webhooks.rejected ? 'warn' : 'ok' },
    { key: 'jobs', value: failedJobs, tone: failedJobs ? 'danger' : 'ok' },
  ];
}

// --- Provider apps --------------------------------------------------------------------------------------------------

/** The logo drawn for each of Resuto's provider apps (packages/ui ProviderLogo). */
export const PROVIDER_APP_LOGO: Record<PlatformAppProvider, ProviderId> = { meta: 'meta', tiktok_ads: 'tiktok', snapchat_ads: 'snapchat', foodics: 'foodics' };

export const SOURCE_TONE: Record<AdminProviderAppView['source'], Tone> = { database: 'ok', environment: 'info', none: 'warn' };

/** A readiness checklist line in the page language ("config.x" and "secret.x" name the field they need). */
export function checklistLabel(s: AdminStrings, key: string): string {
  if (key.startsWith('config.')) return fill(s.chk_config, { name: pickString(s, `cfg_${key.slice(7)}`, key.slice(7)) });
  if (key.startsWith('secret.')) return fill(s.chk_secret, { name: pickString(s, `sec_${key.slice(7)}`, key.slice(7)) });
  return pickString(s, `chk_${key}`, key);
}

/** How far an app is: items done, total, and the summary line. Never "verified" without a recorded acceptance run. */
export function readiness(s: AdminStrings, app: Pick<AdminProviderAppView, 'checklist' | 'acceptance'>) {
  const done = app.checklist.filter((c) => c.done).length;
  const total = app.checklist.length;
  return {
    done, total, complete: total > 0 && done === total,
    summary: fill(s.readyOf, { done, total }),
    acceptance: app.acceptance.passed > 0 ? fill(s.acceptance, { n: app.acceptance.passed }) : s.unverified,
  };
}
