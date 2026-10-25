// @vitest-environment jsdom
import type { ReactNode } from 'react';
import type { Customer360 } from '@resuto/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, $$, EASTERN_DIGITS, mount } from '../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import Customer360Panel from './Customer360Panel';

// 21-INBOX: the Customer 360 panel shared by the Inbox and the customer profile. Each section names its source; parts
// the role or the plan leave out say why; customer-written text stays plain text; EN/AR with Western digits.

const fixture = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/use-api', () => ({
  useApi: () => ({ data: fixture.value ?? undefined, error: null, loading: !fixture.value, refreshing: false, pending: false, updatedAt: 1, reload: async () => {}, setData() {} }),
}));

const org: OrgInfo = {
  id: 'o1', slug: 'olive', name: 'The Olive Room', nameAr: 'غرفة الزيتون', country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'manager', status: 'active',
  branches: [{ id: 'b1', name: 'Zamalek', nameAr: 'الزمالك', code: 'main', isActive: true }],
};
const wrap = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>
    <OrgProvider value={{ org, modules: null, reload: async () => {} }}>{node}</OrgProvider>
  </LocaleProvider>
);

const c360 = (over: Partial<Customer360> = {}): Customer360 => ({
  customer: { id: 'cu1', displayName: '<b>Hana</b>', phone: '+201005551234', email: null, locale: 'en', tags: ['vip'], firstSeenAt: '2026-09-01T10:00:00Z',
    lastSeenAt: '2026-10-24T10:00:00Z', anonymisedAt: null, createdAt: '2026-09-01T10:00:00Z' },
  identities: [{ id: 'i1', kind: 'whatsapp', value: '201005551234', verifiedAt: null }],
  stats: { source: 'customer_branch_stats', orderCount: 12, spendMinor: 1_234_500, averageOrderMinor: 102_875, currency: 'EGP', firstOrderAt: '2026-09-01T10:00:00Z',
    lastOrderAt: '2026-10-24T10:00:00Z', cadence: { basis: 'counted_orders', ordersLast30Days: 4, ordersLast90Days: 12, daysSinceLastOrder: 1, medianDaysBetweenOrders: 4.5, sampleSize: 12 } },
  topItems: [{ productId: 'p1', name: 'Fries', nameAr: 'بطاطس', quantity: 14, orderCount: 9 }],
  consent: { perChannel: false, marketing: { granted: true, source: 'staff_verbal', at: '2026-10-01T10:00:00Z' },
    channels: [{ channel: 'whatsapp', scope: 'customer', granted: true, source: 'staff_verbal', at: '2026-10-01T10:00:00Z', serviceWindow: { open: false, closesAt: null } }], history: [] },
  acquisition: { firstTouch: { basis: 'first_order_channel', inferred: true, occurredAt: '2026-09-01T10:00:00Z', channel: 'web',
    utm: { source: null, medium: null, campaign: null, content: null, term: null }, campaignId: null, campaignName: null, orderId: 'o9' } },
  recentOrders: [{ id: 'o9', number: '1042', branchId: 'b1', channel: 'web', fulfillment: 'pickup', status: 'ready', paymentStatus: 'paid', totalMinor: 25_000, placedAt: '2026-10-24T10:00:00Z' }],
  reservations: [],
  loyalty: null,
  conversations: null,
  tags: { customer: ['vip'], conversation: [] },
  notes: { profile: 'Birthday in May', conversation: null },
  sections: { conversations: 'no_permission', loyalty: 'not_entitled' },
  untrustedFields: [],
  generatedAt: '2026-10-25T09:00:00Z',
  ...over,
});

afterEach(() => { document.body.innerHTML = ''; fixture.value = null; });

describe('Customer 360 panel', () => {
  it('names the source of each figure and says why a part is missing', () => {
    fixture.value = c360();
    const v = mount(wrap('en', <Customer360Panel customerId="cu1" />));
    const sec = (k: string) => $(v.host, `[data-section="${k}"]`);
    expect(sec('value').textContent).toContain('From the customer totals of your branches only');
    expect(sec('value').textContent).toContain('From the last 12 counted orders.');
    expect(sec('value').textContent).toContain('Orders about every 4.5 days · 4 in the last 30 days · 12 in the last 90');
    expect(sec('acquisition').textContent).toContain('Inferred');
    expect(sec('acquisition').textContent).toContain('Where they placed their first order');
    expect(sec('consent').textContent).toContain('recorded once per customer');
    expect(sec('consent').textContent).toContain('reply window closed');
    expect(sec('loyalty').textContent).toContain('Your plan does not include this module.');
    expect(sec('conversations').textContent).toContain('Your role does not include this part.');
    expect(sec('orders').querySelector('a')?.getAttribute('href')).toBe('/dashboard/o1/orders?order=o9');
    expect(v.host.textContent).toContain('Updated');
    v.unmount();
  });

  it('shows customer-written text as plain text, never as markup', () => {
    fixture.value = c360();
    const v = mount(wrap('en', <Customer360Panel customerId="cu1" />));
    expect($(v.host, '[data-section="identity"]').textContent).toContain('<b>Hana</b>');
    expect(v.host.querySelector('[data-section="identity"] b')).toBeNull();
    v.unmount();
  });

  it('leaves out the sections the host page already shows', () => {
    fixture.value = c360();
    const v = mount(wrap('en', <Customer360Panel customerId="cu1" omit={['identity', 'orders', 'reservations', 'loyalty']} layout="grid" />));
    expect($$(v.host, '[data-section]').map((s) => s.getAttribute('data-section'))).toEqual(['value', 'favourites', 'acquisition', 'consent', 'conversations', 'notes']);
    expect($(v.host, '.c360').getAttribute('data-layout')).toBe('grid');
    v.unmount();
  });

  it('is localised in Arabic with Western digits', () => {
    fixture.value = c360({ stats: { ...c360().stats, source: 'customer_stats' } });
    const v = mount(wrap('ar', <Customer360Panel customerId="cu1" />), 'ar');
    expect(v.host.textContent).toContain('من إجماليات العميل في كل الفروع');
    expect(v.host.textContent).toContain('بطاطس');
    expect(v.host.textContent).toContain('مستنتج');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('shows a skeleton while loading', () => {
    const v = mount(wrap('en', <Customer360Panel customerId="cu1" />));
    expect($(v.host, '.c360').getAttribute('aria-busy')).toBe('true');
    v.unmount();
  });
});
