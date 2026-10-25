// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KitchenFeed, KitchenTicket } from '@resuto/contracts';
import { $, $$, EASTERN_DIGITS, key, mount } from '../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { pageCommands } from '@/lib/page-commands';

// 21-OPS: the ticket board's keys on the Orders board (j/k, Enter opens, a moves on, x + bulk move) and on the kitchen
// display's bump bar (1-9, arrows mirrored in Arabic, Enter bumps), the lanes as named regions with counts, and the
// page commands the shell's palette and cheat sheet list.

const ticket = (id: string, number: string, status: string, extra: Partial<KitchenTicket> = {}): KitchenTicket => ({
  id, number, status, fulfillment: 'dine_in', channel: 'qr', tableLabel: 'T1', customerName: null, placedAt: new Date().toISOString(), acceptedAt: null,
  ageSeconds: 30, notes: null, version: 3, isNew: false, lines: [{ id: `${id}-l`, name: 'Smash burger', nameAr: 'برجر', quantity: 2, station: 'grill', kitchenStatus: status === 'preparing' ? 'preparing' : 'queued', notes: null, modifiers: [], prepMinutes: null }],
  ...extra,
});
const feed = (): KitchenFeed => ({
  cursor: 'c1', serverTime: new Date().toISOString(), stations: ['grill'], serviceMode: 'tables',
  tickets: [ticket('a', '1', 'placed'), ticket('b', '2', 'accepted'), ticket('c', '3', 'preparing')], recent: [],
});

const call = vi.fn(async (path: string, _init?: unknown) => (path.includes('/bump') ? { version: 4 } : feed()));
vi.mock('@/lib/session', () => ({ useSession: () => ({ call }) }));
vi.mock('@/lib/use-api', () => ({ useApi: () => ({ data: undefined, error: null, loading: false, reload: async () => {} }) }));

const { TicketBoard } = await import('./TicketBoard');

const inLocale = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>{node}</LocaleProvider>
);
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; call.mockClear(); document.body.innerHTML = ''; });

async function render(mode: 'orders' | 'kds', locale: 'en' | 'ar' = 'en', onOpen = vi.fn()) {
  const v = mount(inLocale(locale, <TicketBoard orgId="o1" branchId="b1" station={null} mode={mode} onOpen={mode === 'orders' ? onOpen : undefined} timezone="Africa/Cairo" />), locale);
  unmount = v.unmount;
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { ...v, onOpen };
}
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.ticket ?? null;
const bumps = () => call.mock.calls.filter(([p]) => String(p).includes('/bump'));

describe('ticket board', () => {
  it('shows the five lanes as named regions with their counts', async () => {
    const v = await render('orders');
    const lanes = $$(v.host, 'section.rui-lane');
    expect(lanes.map((l) => l.getAttribute('aria-label'))).toEqual(['New orders', 'Preparing', 'Ready to serve', 'On the way', 'Completed']);
    expect(lanes.map((l) => l.querySelector('.rui-lane-count')?.textContent)).toEqual(['2', '1', '0', '0', '0']);
    expect(lanes.map((l) => l.dataset.lane)).toEqual(['new', 'preparing', 'ready', 'out', 'done']);
    // One tab stop on the board (the first card), the others reachable with j/k.
    expect($$(v.host, 'article[tabindex="0"]').map((a) => a.dataset.ticket)).toEqual(['a']);
  });

  it('orders board: j/k move between cards, Enter opens, a moves the card to its next step with its version', async () => {
    const { onOpen } = await render('orders');
    key(document.body, 'j');
    expect(focused()).toBe('a');
    key(document.activeElement!, 'j');
    key(document.activeElement!, 'j');
    expect(focused()).toBe('c');
    key(document.activeElement!, 'k');
    expect(focused()).toBe('b');
    key(document.activeElement!, 'Enter');
    expect(onOpen).toHaveBeenCalledWith('b');
    key(document.activeElement!, 'a');
    await act(async () => { await Promise.resolve(); });
    expect(bumps()).toEqual([['/o/o1/kitchen/orders/b/bump', { body: { to: 'preparing', version: 3 } }]]);
  });

  it('orders board: x selects cards, the bulk bar moves each to its own next step, Escape clears', async () => {
    const v = await render('orders');
    key(document.body, 'j');
    key(document.activeElement!, 'x');
    key(document.activeElement!, 'j');
    key(document.activeElement!, 'j');
    key(document.activeElement!, 'x');
    const bar = $(v.host, '.board-bulk');
    expect(bar.textContent).toContain('2 orders selected');
    expect($$(v.host, '.ticket.is-selected').map((a) => a.dataset.ticket)).toEqual(['a', 'c']);
    key(document.activeElement!, 'Escape');
    expect(v.host.querySelector('.board-bulk')).toBeNull();
    key(document.activeElement!, 'x');
    key(document.activeElement!, 'k');
    key(document.activeElement!, 'k');
    key(document.activeElement!, 'x');
    await act(async () => { $<HTMLButtonElement>(v.host, '.board-bulk .btn-primary').click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(bumps().map(([p, init]) => [p, (init as { body: unknown }).body])).toEqual([
      ['/o/o1/kitchen/orders/a/bump', { to: 'preparing', version: 3 }],
      ['/o/o1/kitchen/orders/c/bump', { to: 'ready', version: 3 }],
    ]);
  });

  it('registers its keys with the page commands (palette and cheat sheet)', async () => {
    await render('orders');
    expect(pageCommands()?.title).toBe('Order board');
    expect(pageCommands()?.commands.map((c) => c.key)).toEqual(['j', 'k', 'o', 'a', 'x']);
  });

  it('kitchen bump bar: a number picks a ticket, Enter bumps it and the focus stays in the lane', async () => {
    await render('kds');
    key(document.body, '2', { code: 'Digit2' });
    expect(focused()).toBe('b');
    key(document.activeElement!, 'Enter');
    await act(async () => { await Promise.resolve(); });
    expect(bumps()[0]).toEqual(['/o/o1/kitchen/orders/b/bump', { body: { to: 'preparing', version: 3 } }]);
    expect(focused()).toBe('a'); // the ticket that takes its place in New orders
    key(document.activeElement!, 'ArrowRight');
    expect(focused()).toBe('c');
  });

  it('kitchen display in Arabic: Left is the next lane, no Arabic-Indic digits', async () => {
    const v = await render('kds', 'ar');
    key(document.body, '1', { code: 'Digit1' });
    expect(focused()).toBe('a');
    key(document.activeElement!, 'ArrowLeft');
    expect(focused()).toBe('c');
    key(document.activeElement!, 'ArrowRight');
    expect(focused()).toBe('a');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    expect($$(v.host, 'section.rui-lane')[0]!.getAttribute('aria-label')).toBe('طلبات جديدة');
  });

  it('ignores keys typed into a field', async () => {
    const v = await render('orders');
    const input = document.createElement('input');
    v.host.appendChild(input);
    input.focus();
    key(input, 'j');
    expect(focused()).toBeNull();
  });
});
