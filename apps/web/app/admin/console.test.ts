import { describe, expect, it } from 'vitest';
import { hasEasternDigits, type AdminOperations } from '@resuto/contracts';
import { PROVIDER_LOGOS } from '@resuto/ui';
import {
  ADMIN_NAV, PROVIDER_APP_LOGO, activeAdminNav, byDate, checklistLabel, countryLabel, opsTiles, planLabel, readiness, roleLabel,
  statusLabel, subscriptionLabel, tenantFilterChips, tenantsQuery,
} from './console';
import { ADMIN_STRINGS } from './strings';
import { fill, pickString } from './text';

// 21-ADMIN operator console logic, in English and Arabic: navigation, the restaurants list query and chips, labels for
// codes, the operations tiles and the provider readiness summary (never "verified" without a recorded run).

const ARABIC = /[؀-ۿ]/;

describe('admin strings', () => {
  it('every key exists in both languages, Arabic is Arabic, digits are Western', () => {
    const en = ADMIN_STRINGS.en as Record<string, string>;
    const ar = ADMIN_STRINGS.ar as Record<string, string>;
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(ar)) {
      expect(v, k).not.toBe('');
      expect(hasEasternDigits(v), k).toBe(false);
      expect(hasEasternDigits(en[k]!), k).toBe(false);
    }
    // Spot checks: user-facing copy is translated (not left in English).
    for (const k of ['console', 'tenants', 'operations', 'providers', 'onlyAdmins', 'sortNote', 'readyOf', 'statOutbox', 'secretsNote']) expect(ar[k]).toMatch(ARABIC);
  });

  it('placeholders are the same in both languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const en = ADMIN_STRINGS.en as Record<string, string>;
    const ar = ADMIN_STRINGS.ar as Record<string, string>;
    for (const k of Object.keys(en)) expect(vars(ar[k]!), k).toEqual(vars(en[k]!));
  });

  it('fill and pickString', () => {
    expect(fill('{a} of {b}, {a}', { a: 1, b: 2 })).toBe('1 of 2, 1');
    expect(pickString(ADMIN_STRINGS.ar, 'st_active')).toBe('نشط');
    expect(pickString(ADMIN_STRINGS.en, 'st_unknown_code')).toBe('st_unknown_code');
    expect(pickString(ADMIN_STRINGS.en, 'st_unknown_code', 'unknown_code')).toBe('unknown_code');
  });
});

describe('console navigation', () => {
  it('four sections; a restaurant page is under Restaurants', () => {
    expect(ADMIN_NAV.map((n) => n.key)).toEqual(['tenants', 'prices', 'operations', 'providers']);
    expect(activeAdminNav('/admin')).toBe('tenants');
    expect(activeAdminNav('/admin/')).toBe('tenants');
    expect(activeAdminNav('/admin/tenants/0d6f1c1e-0000-4000-8000-000000000000')).toBe('tenants');
    expect(activeAdminNav('/admin/prices')).toBe('prices');
    expect(activeAdminNav('/admin/operations')).toBe('operations');
    expect(activeAdminNav('/admin/providers')).toBe('providers');
    expect(activeAdminNav('/admin/pricesx')).toBeNull();
    expect(activeAdminNav('/dashboard/o1')).toBeNull();
  });

  it('role names in both languages', () => {
    expect(roleLabel(ADMIN_STRINGS.en, 'superadmin')).toBe('Superadmin');
    expect(roleLabel(ADMIN_STRINGS.ar, 'support')).toMatch(ARABIC);
    expect(roleLabel(ADMIN_STRINGS.ar, 'finance')).toMatch(ARABIC);
  });
});

describe('restaurants list', () => {
  const none = { q: '', status: '', plan: '', country: '' };
  it('builds the keyset query: limit, trimmed search, filters, cursor; empty filters are left out', () => {
    expect(tenantsQuery(none, null)).toBe('limit=50');
    const q = new URLSearchParams(tenantsQuery({ q: '  olive ', status: 'active', plan: 'pro', country: 'EG' }, 'c1'));
    expect(Object.fromEntries(q)).toEqual({ limit: '50', q: 'olive', status: 'active', plan: 'pro', country: 'EG', cursor: 'c1' });
    expect(tenantsQuery({ ...none, q: '   ' }, null)).toBe('limit=50');
  });

  it('filter chips name the filter and its value in the page language', () => {
    const f = { q: 'olive', status: 'suspended', plan: 'growth', country: 'SA' };
    expect(tenantFilterChips(ADMIN_STRINGS.en, f).map((c) => c.text)).toEqual(['Search: olive', 'Status: Suspended', 'Plan: Growth', 'Country: Saudi Arabia']);
    const ar = tenantFilterChips(ADMIN_STRINGS.ar, f);
    expect(ar.map((c) => c.key)).toEqual(['q', 'status', 'plan', 'country']);
    for (const c of ar) expect(c.text).toMatch(ARABIC);
    expect(tenantFilterChips(ADMIN_STRINGS.en, none)).toEqual([]);
  });

  it('labels codes, falling back to the code itself', () => {
    expect(statusLabel(ADMIN_STRINGS.ar, 'onboarding')).toBe('قيد الإعداد');
    expect(planLabel(ADMIN_STRINGS.en, null)).toBe('No plan');
    expect(planLabel(ADMIN_STRINGS.en, 'enterprise')).toBe('enterprise');
    expect(subscriptionLabel(ADMIN_STRINGS.en, 'past_due')).toBe('Past due');
    expect(countryLabel(ADMIN_STRINGS.ar, 'EG')).toBe('مصر');
  });

  it('dates sort with "never" first ascending', () => {
    const rows = ['2026-10-02T00:00:00Z', null, '2026-09-01T00:00:00Z'];
    expect([...rows].sort(byDate)).toEqual([null, '2026-09-01T00:00:00Z', '2026-10-02T00:00:00Z']);
  });
});

describe('operations tiles', () => {
  const base: AdminOperations = {
    generatedAt: '2026-10-25T10:00:00Z',
    outbox: { unpublished: 0, oldestUnpublishedAt: null, retrying: 0 },
    eventHandlings: { failed: 0, dead: 0, stuck: 0, recent: [] },
    webhooks: { failed: 0, rejected: 0, recent: [] },
    jobs: [{ id: 1, job: 'rollups', status: 'succeeded', startedAt: '2026-10-25T09:00:00Z', finishedAt: null, error: null, stats: {} }],
    usage30d: [],
  };
  it('all calm when nothing fails', () => {
    expect(opsTiles(base).map((t) => [t.key, t.value, t.tone])).toEqual([['outbox', 0, 'ok'], ['handlers', 0, 'ok'], ['webhooks', 0, 'ok'], ['jobs', 0, 'ok']]);
  });
  it('sums failures and escalates dead or stuck runs and failed jobs to danger', () => {
    const d: AdminOperations = {
      ...base,
      outbox: { unpublished: 4, oldestUnpublishedAt: '2026-10-25T09:00:00Z', retrying: 2 },
      eventHandlings: { failed: 2, dead: 1, stuck: 1, recent: [] },
      webhooks: { failed: 0, rejected: 3, recent: [] },
      jobs: [...base.jobs, { id: 2, job: 'health', status: 'failed', startedAt: '2026-10-25T09:30:00Z', finishedAt: null, error: 'boom', stats: {} }],
    };
    expect(opsTiles(d).map((t) => [t.key, t.value, t.tone])).toEqual([['outbox', 4, 'warn'], ['handlers', 4, 'danger'], ['webhooks', 3, 'warn'], ['jobs', 1, 'danger']]);
    expect(opsTiles({ ...base, eventHandlings: { failed: 1, dead: 0, stuck: 0, recent: [] } })[1]!.tone).toBe('warn');
  });
});

describe('provider apps', () => {
  it('every platform app has a logo', () => {
    for (const id of Object.values(PROVIDER_APP_LOGO)) expect(PROVIDER_LOGOS[id]).toBeTruthy();
  });

  it('checklist lines name the field they need, in both languages', () => {
    expect(checklistLabel(ADMIN_STRINGS.en, 'app_id')).toBe('App id entered');
    expect(checklistLabel(ADMIN_STRINGS.en, 'secret.appSecret')).toBe('Secret: App secret');
    expect(checklistLabel(ADMIN_STRINGS.ar, 'config.whatsappSignupConfigId')).toMatch(ARABIC);
    expect(checklistLabel(ADMIN_STRINGS.en, 'config.unknownThing')).toBe('Configuration id: unknownThing');
  });

  it('readiness counts done items; without a recorded acceptance run it says verification is pending', () => {
    const app = { checklist: [{ key: 'app_id', done: true }, { key: 'app_secret', done: false }, { key: 'review_approved', done: false }], acceptance: { passed: 0, lastPassedAt: null } };
    const en = readiness(ADMIN_STRINGS.en, app);
    expect(en).toMatchObject({ done: 1, total: 3, complete: false, summary: '1 of 3 ready' });
    expect(en.acceptance).toMatch(/verification pending/);
    const ar = readiness(ADMIN_STRINGS.ar, { ...app, acceptance: { passed: 2, lastPassedAt: '2026-10-25T00:00:00Z' } });
    expect(ar.summary).toMatch(ARABIC);
    expect(ar.summary).toMatch(/1.*3/);
    expect(hasEasternDigits(ar.summary + ar.acceptance)).toBe(false);
    expect(ar.acceptance).toContain('2');
    expect(readiness(ADMIN_STRINGS.en, { checklist: [{ key: 'app_id', done: true }], acceptance: { passed: 0, lastPassedAt: null } }).complete).toBe(true);
  });
});
