// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionResponse, OverviewPeriod } from '@resuto/contracts/home';
import { defaultOverviewPreferences, type OverviewPreferences } from '@/lib/contracts-home';
import { $, $$, click, EASTERN_DIGITS, mount } from '../../../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import { Attention } from './Attention';
import { Customers } from './Customers';
import CustomiseSheet from './CustomiseSheet';
import { Performance } from './Performance';
import type { HomeAccess } from './model';

// 21-HOME rows in a browser-like DOM, in English and Arabic: provenance on every figure, Western digits, the
// attention list with omitted kinds, acquisition labelled attributed/inferred, and the Customise sheet's controls.

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard/o1', useRouter: () => ({ push() {}, replace() {} }) }));

const ORG: OrgInfo = {
  id: 'o1', slug: 'olive', name: 'The Olive Room', nameAr: 'غرفة الزيتون', country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active',
  branches: [{ id: 'b1', name: 'Zamalek', nameAr: 'الزمالك', code: 'main', isActive: true }],
};
const wrap = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>
    <OrgProvider value={{ org: ORG, modules: null, reload: async () => {} }}>{node}</OrgProvider>
  </LocaleProvider>
);
const render = (locale: 'en' | 'ar', node: ReactNode) => mount(wrap(locale, node), locale);
afterEach(() => { document.body.innerHTML = ''; });

const meta = { method: 'm', assumptions: [], dataCoverage: {}, kind: 'mixed' as const, timezone: 'Africa/Cairo', generatedAt: '2026-10-25T10:00:00Z' };
const PERIOD: OverviewPeriod = {
  from: '2026-10-19', to: '2026-10-25', days: 7, compare: 'previous_period',
  current: { orders: 1234, netMinor: 5678900, averageOrderMinor: 460200, customers: 40, repeatCustomers: 12, repeatRatePct: 30 },
  comparison: { from: '2026-10-12', to: '2026-10-18', kpis: { orders: 1000, netMinor: 5000000, averageOrderMinor: 500000, customers: 38, repeatCustomers: 10, repeatRatePct: 26.32 } },
  changePct: { orders: 23.4, netMinor: 13.58, averageOrderMinor: -7.96, repeatRatePts: 3.68 },
  daily: [10, 20, 30, 40, 50, 60, 70].map((n, i) => ({ date: `2026-10-${19 + i}`, orders: n, netMinor: n * 1000 })),
  comparisonDaily: null,
  customers: { newCustomers: 15, returningCustomers: 25, newCustomerNetMinor: 100000, returningCustomerNetMinor: 200000, ordersWithoutCustomer: 3 },
  acquisition: { newCustomers: 15, attributed: 9, inferred: 6, channels: [
    { channel: 'instagram', customers: 7, attributed: 7, inferred: 0 }, { channel: 'qr', customers: 6, attributed: 0, inferred: 6 },
    { channel: 'campaign_link', customers: 2, attributed: 2, inferred: 0 }] },
  campaigns: { attributedOrders: 4, attributedNetMinor: 40000, clicksIncluded: true, excludedSandboxOrders: 2,
    items: [{ campaignId: 'c1', name: 'Eid link', channel: 'whatsapp', orders: 4, netMinor: 40000, clicks: 12, conversionPct: 33.33 }] },
  meta,
};
const ATTENTION: AttentionResponse = {
  generatedAt: '2026-10-25T10:00:00Z', branchId: null, checked: ['slow_orders', 'low_stock', 'negative_reviews'],
  omitted: [{ kind: 'integrations_failing', reason: 'permission', permission: 'integrations:manage' }, { kind: 'creative_approvals', reason: 'module', module: 'studio' }],
  rules: { slowOrderMinutes: 30, unpaidBillDays: 7, tokenExpiryDays: 7, negativeReviewMaxScore: 2, negativeReviewDays: 7, samples: 3 },
  items: [
    { kind: 'slow_orders', severity: 'critical', count: 5, href: '/orders', source: 'orders', provenance: 'live',
      samples: [{ id: 'x1', label: '1042', at: '2026-10-25T09:00:00Z' }, { id: 'x2', label: '1043', at: '2026-10-25T09:10:00Z' }] },
    { kind: 'negative_reviews', severity: 'warning', count: 1, href: '/analytics?tab=guests', source: 'guest_ratings', provenance: 'live',
      samples: [{ id: 'r1', label: 'Cold <b>fries</b>', value: 1 }] },
  ],
};

describe('performance row', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`shows the period KPIs with deltas, sparklines and provenance (${locale})`, () => {
      const v = render(locale, <Performance period={PERIOD} hourlyToday={null} ratings={{ count: 8, averages: { overall: 4.26 } }} />);
      const tiles = $$(v.host, '.rui-stat');
      expect(tiles).toHaveLength(5);
      expect(tiles.every((tile) => tile.getAttribute('data-provenance') === 'live')).toBe(true);
      expect($$(v.host, '.rui-stat-delta').length).toBe(3);
      expect($$(v.host, 'svg').length).toBeGreaterThanOrEqual(2);
      expect(v.host.textContent).toContain('1,234');
      expect(v.host.textContent).toContain('4.3');
      expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
      v.unmount();
    });
  }

  it('marks satisfaction unavailable while there is no ratings answer, never a made-up score', () => {
    const v = render('en', <Performance period={{ ...PERIOD, changePct: null, comparison: null }} hourlyToday={null} ratings={undefined} />);
    const last = $$(v.host, '.rui-stat').at(-1)!;
    expect(last.getAttribute('data-provenance')).toBe('unavailable');
    expect(last.querySelector('.rui-stat-value')!.textContent).toBe('—');
    expect($$(v.host, '.rui-stat-delta')).toHaveLength(0);
    v.unmount();
  });
});

describe('needs attention row', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`lists items with severity, count, samples, provenance and a link; names the omitted kinds (${locale})`, () => {
      const v = render(locale, <Attention data={ATTENTION} orgId="o1" timeZone="Africa/Cairo" />);
      const items = $$(v.host, 'li[data-kind]');
      expect(items.map((i) => i.getAttribute('data-kind'))).toEqual(['slow_orders', 'negative_reviews']);
      expect(items[0]!.getAttribute('data-severity')).toBe('critical');
      expect($(items[0]!, 'a').getAttribute('href')).toBe('/dashboard/o1/orders');
      expect(items[0]!.textContent).toContain('#1042');
      expect(items[0]!.textContent).toMatch(locale === 'ar' ? /أخرى/ : /\+3 more/);
      expect($(items[1]!, 'a').getAttribute('href')).toBe('/dashboard/o1/analytics?tab=guests');
      // A guest's words are text, never markup.
      expect(items[1]!.querySelector('b')).toBeNull();
      expect(items[1]!.textContent).toContain('Cold <b>fries</b>');
      expect($$(v.host, '.rui-provenance')).toHaveLength(2);
      expect(v.host.textContent).toContain(locale === 'ar' ? 'تكاملات متعطلة' : 'Failing integrations');
      expect(v.host.textContent).toContain(locale === 'ar' ? 'غير مضمّن في خطتك' : 'Not in your plan');
      expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
      v.unmount();
    });
  }

  it('says all clear when the checked kinds have nothing', () => {
    const v = render('en', <Attention data={{ ...ATTENTION, items: [], omitted: [] }} orgId="o1" timeZone="Africa/Cairo" />);
    expect(v.host.textContent).toContain('Nothing needs attention right now.');
    v.unmount();
  });
});

describe('customers and channels row', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`labels acquisition as an estimate when part of it is inferred and shows campaign conversion (${locale})`, () => {
      const v = render(locale, <Customers period={PERIOD} />);
      const acq = $(v.host, '[aria-labelledby="cust-acq"]');
      expect($(acq, '.rui-provenance').getAttribute('data-provenance')).toBe('estimated');
      expect($$(acq, '.rui-bar-row')).toHaveLength(3);
      expect(acq.textContent).toContain(locale === 'ar' ? 'مستنتج' : 'inferred');
      const camp = $(v.host, '[aria-labelledby="cust-camp"]');
      expect(camp.textContent).toContain('Eid link');
      expect(camp.textContent).toContain('33.33%');
      expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
      v.unmount();
    });
  }

  it('is live when everything is attributed', () => {
    const p = { ...PERIOD, acquisition: { newCustomers: 2, attributed: 2, inferred: 0, channels: [{ channel: 'instagram' as const, customers: 2, attributed: 2, inferred: 0 }] } };
    const v = render('en', <Customers period={p} />);
    expect($(v.host, '[aria-labelledby="cust-acq"] .rui-provenance').getAttribute('data-provenance')).toBe('live');
    v.unmount();
  });
});

describe('customise sheet', () => {
  const all: HomeAccess = { can: () => true, hasModule: () => true };
  const setup = (locale: 'en' | 'ar', access = all) => {
    const changes: OverviewPreferences[] = [];
    const v = render(locale, <CustomiseSheet open onClose={() => {}} prefs={defaultOverviewPreferences()} onChange={(p) => changes.push(p)} status="saved" access={access} />);
    return { v, changes };
  };

  it('hides a section and moves one, reporting each change', () => {
    const { v, changes } = setup('en');
    const rows = $$(v.host, 'li[data-section]');
    expect(rows.map((r) => r.getAttribute('data-section'))).toEqual(['now', 'performance', 'attention', 'customers', 'actions']);
    act(() => { $<HTMLInputElement>(rows[3]!, 'input[role="switch"]').click(); });
    expect(changes.at(-1)!.sections.find((x) => x.id === 'customers')!.visible).toBe(false);
    click($(rows[2]!, 'button[aria-label="Move Needs attention up"]'));
    expect(changes.at(-1)!.sections.map((x) => x.id)).toEqual(['now', 'attention', 'performance', 'customers', 'actions']);
    // The first cannot move up, the last cannot move down.
    expect($<HTMLButtonElement>(rows[0]!, 'button[aria-label="Move Right now up"]').disabled).toBe(true);
    expect($<HTMLButtonElement>(rows[4]!, 'button[aria-label="Move Next actions down"]').disabled).toBe(true);
    expect(v.host.textContent).toContain('Saved');
    click($$(v.host, 'button').find((b) => b.textContent === 'Reset to default')!);
    expect(changes.at(-1)).toEqual(defaultOverviewPreferences());
    v.unmount();
  });

  it('offers only the sections the role can use, in Arabic with labelled controls', () => {
    const cashier: HomeAccess = { can: (p) => p === 'orders:read', hasModule: () => true };
    const { v } = setup('ar', cashier);
    expect($$(v.host, 'li[data-section]').map((r) => r.getAttribute('data-section'))).toEqual(['attention']);
    expect($(v.host, 'button[aria-label="نقل يحتاج انتباهك للأعلى"]')).toBeTruthy();
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});
