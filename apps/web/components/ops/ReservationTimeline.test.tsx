// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReservationView } from '@resuto/contracts';
import { $$, click, EASTERN_DIGITS, mount } from '../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { ReservationTimeline } from './ReservationTimeline';

// 21-OPS: the reservation timeline renders one row per table with bars placed by logical inset (so Arabic runs the
// hours right to left), named buttons that open the booking, Western digits in both languages.

const inLocale = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>{node}</LocaleProvider>
);
const r = (id: string, tableId: string | null, start: string, end: string, guestName: string): ReservationView => ({
  id, code: `R-${id}`, branchId: 'b1', tableId, tableLabel: tableId ? tableId.toUpperCase() : null, status: 'confirmed', guestName, guestPhone: null, guestEmail: null,
  partySize: 4, startsAt: new Date(`2026-10-25T${start}:00+03:00`).toISOString(), endsAt: new Date(`2026-10-25T${end}:00+03:00`).toISOString(),
  holdExpiresAt: null, depositMinor: 0, depositStatus: 'none', source: 'staff', notes: null, seatedVisitId: null, currency: 'EGP', createdAt: '2026-10-20T10:00:00Z',
});
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

describe('reservation timeline', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`draws the day per table with logical positions (${locale})`, () => {
      const onOpen = vi.fn();
      const v = mount(inLocale(locale, (
        <ReservationTimeline tables={[{ id: 't1', label: 'T1' }, { id: 't2', label: 'T2' }]} timeZone="Africa/Cairo" day="2026-10-25"
          bookings={[r('a', 't1', '19:00', '20:30', 'Salma'), r('b', null, '20:00', '21:00', 'عمر')]} onOpen={onOpen} />
      )), locale);
      unmount = v.unmount;
      const rows = $$(v.host, '.res-gantt-row');
      expect(rows).toHaveLength(3); // T1, T2 and "no table yet"
      const bars = $$<HTMLButtonElement>(v.host, '.res-gantt-bar');
      expect(bars).toHaveLength(2);
      expect(bars[0]!.style.insetInlineStart).toMatch(/^33\.33/); // 17:00-23:00 window: 19:00 is a third of the way
      expect(bars[0]!.getAttribute('style')).not.toMatch(/\b(left|right)\s*:/);
      expect(bars[0]!.getAttribute('aria-label')).toContain('T1: 19:00–20:30 · Salma');
      expect(getComputedStyle(bars[0]!).direction).toBe(locale === 'ar' ? 'rtl' : 'ltr');
      expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
      click(bars[1]!);
      expect(onOpen).toHaveBeenCalledWith('b');
    });
  }
});
