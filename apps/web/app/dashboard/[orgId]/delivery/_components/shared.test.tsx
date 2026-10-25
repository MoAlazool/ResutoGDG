// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DriverView } from '@resuto/contracts';
import { $$, EASTERN_DIGITS, mount } from '../../../../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { DriverChips, sortDriversForChips } from './shared';

// 21-OPS: driver status chips on the dispatch screen, available drivers first, in both languages.

const inLocale = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>{node}</LocaleProvider>
);
const driver = (id: string, displayName: string, availability: DriverView['availability'], extra: Partial<DriverView> = {}): DriverView => ({
  id, userId: null, displayName, phone: null, vehicleType: 'motorbike', vehiclePlate: null, branchIds: null, status: 'active', availability,
  lastLocation: null, activeJobs: 0, cashOnHandMinor: 0, ...extra,
} as DriverView);
const drivers = [
  driver('1', 'Zaki', 'offline'), driver('2', 'Omar', 'busy', { activeJobs: 2 }), driver('3', 'Amr', 'available'),
  driver('4', 'Basma', 'available', { status: 'suspended' }), driver('5', 'Hoda', 'break'),
];
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

describe('driver status chips', () => {
  it('orders available, busy, on a break, offline, then suspended', () => {
    expect(sortDriversForChips(drivers).map((d) => d.displayName)).toEqual(['Amr', 'Omar', 'Hoda', 'Zaki', 'Basma']);
  });
  for (const locale of ['en', 'ar'] as const) {
    it(`renders one chip per driver with its availability (${locale})`, () => {
      const v = mount(inLocale(locale, <DriverChips drivers={drivers} />), locale);
      unmount = v.unmount;
      const chips = $$(v.host, '.driver-chip');
      expect(chips.map((c) => c.dataset.availability)).toEqual(['available', 'busy', 'break', 'offline', 'suspended']);
      expect(v.host.querySelector('.driver-chips-summary')!.textContent).toMatch(/^1 .+ · 1 .+ · 1 .+ · 1 .+$/);
      if (locale === 'en') expect(chips[1]!.textContent).toContain('Busy');
      expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    });
  }
});
