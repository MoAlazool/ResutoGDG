// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $, $$, click, EASTERN_DIGITS, key, mount } from '../../../../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import { pageCommands } from '@/lib/page-commands';
import { DEFAULT_FILTERS } from '@/lib/inbox';
import { Composer } from './Composer';
import { ConversationList } from './ConversationList';
import { Thread } from './Thread';
import type { ConvItem, Detail } from './types';

// 21-INBOX increment 2: the Inbox workspace in a browser-like DOM, in English and Arabic. Keyboard-only triage on the
// whole page (j/k/r/n/a/e, ignored while typing), internal notes that are never shown as sent and never go through
// the reply endpoint, the "/" saved replies, the SLA timer and the virtualised list.

const api = vi.hoisted(() => ({ data: new Map<string, unknown>(), calls: [] as Array<{ path: string; opts: any }> }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard/o1/inbox', useRouter: () => ({ push() {}, replace() {} }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/use-api', () => {
  const states = new Map<string, unknown>();
  return {
    useApi: (path: string | null) => {
      if (!path) return { data: undefined, error: null, loading: false, refreshing: false, pending: false, updatedAt: 0, reload: async () => {}, setData() {} };
      const hit = [...api.data.entries()].find(([p]) => path.startsWith(p) || path.includes(p));
      const key = `${path}|${hit ? hit[0] : ''}`;
      if (!states.has(key)) {
        states.set(key, { data: hit?.[1], error: null, loading: !hit, refreshing: false, pending: false, updatedAt: hit ? 1 : 0, reload: async () => {}, setData() {} });
      }
      return states.get(key);
    },
  };
});
vi.mock('@/lib/session', () => ({
  useSession: () => ({
    call: async (path: string, opts: any = {}) => {
      api.calls.push({ path, opts });
      if (path.endsWith('/notes')) return { id: 'n-new', body: opts.body.body, createdAt: new Date().toISOString() };
      return {};
    },
  }),
}));

const inLocale = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>{node}</LocaleProvider>
);
// Effects, lazy chunks and requestAnimationFrame (the composer focuses on the next frame) settle within a few frames.
const flush = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 20)); });
const org: OrgInfo = {
  id: 'o1', slug: 'olive', name: 'The Olive Room', nameAr: 'غرفة الزيتون', country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active',
  branches: [{ id: 'b1', name: 'Zamalek', nameAr: 'الزمالك', code: 'main', isActive: true, acceptsPickup: true, acceptsReservations: true }],
};
const withOrg = (locale: 'en' | 'ar', node: ReactNode) => inLocale(locale, (
  <OrgProvider value={{ org, modules: null, reload: async () => {}, branchId: 'b1', allBranches: false }}>{node}</OrgProvider>
));

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const conv = (over: Partial<ConvItem>): ConvItem => ({
  id: 'c1', channelId: 'ch1', channelName: 'WhatsApp sandbox', channelKind: 'whatsapp', sandbox: true, customerId: 'cu1', contact: '201000000001', name: 'Mona',
  status: 'open', assignedTo: null, unreadCount: 2, lastMessageAt: ago(10), lastMessage: { body: 'Is the terrace open?', direction: 'inbound' },
  window: { open: true, closesAt: ago(-600) }, handoffOpen: false, tags: [], branchId: 'b1', orderingStep: null, lead: false, ...over,
});
const detail = (over: Partial<Detail> = {}): Detail => ({
  id: 'c1', status: 'open', channel: { id: 'ch1', name: 'WhatsApp sandbox', sandbox: true, kind: 'whatsapp', transport: 'sandbox' }, contact: '201000000001',
  contactName: 'Mona', locale: 'en', customer: { id: 'cu1', name: 'Mona', marketingConsent: false }, window: { open: true, closesAt: ago(-600) }, botActive: false,
  handoff: null, assignedTo: null, orderingSession: null,
  messages: [
    { id: 'm1', direction: 'inbound', kind: 'text', body: 'Is the terrace open?', status: 'received', error: null, automated: false, sandbox: true, interactive: null, createdAt: ago(12) },
    { id: 'm2', direction: 'outbound', kind: 'text', body: 'Yes, until 11 pm.', status: 'delivered', error: null, automated: false, sandbox: true, interactive: null, createdAt: ago(11) },
  ],
  notes: [{ id: 'n1', conversationId: 'c1', body: 'VIP: call before delivery', authorId: 'u1', authorName: 'Hana', createdAt: ago(10) }],
  tags: [],
  ...over,
});
const savedReplies = [{ id: 'r1', title: 'Opening hours', shortcut: 'hours', bodyEn: 'We open at 9 every day.', bodyAr: 'نفتح الساعة 9 يوميًا.', branchId: null, createdAt: ago(100), updatedAt: ago(100) }];

function setText(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => { setter.call(el, value); el.setSelectionRange(value.length, value.length); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => { api.data.clear(); api.calls.length = 0; });
afterEach(() => { document.body.innerHTML = ''; });

describe('thread', () => {
  it('shows internal notes as staff-only and never as sent: no delivery state, not on the outbound side', () => {
    const v = mount(withOrg('en', <Thread d={detail()} timeZone="Africa/Cairo" canReply resendBusy={false} onResend={() => {}} />));
    const note = $(v.host, '[data-kind="note"]');
    expect(note.getAttribute('aria-label')).toBe('Internal note, visible to staff only');
    expect(note.textContent).toContain('Internal note');
    expect(note.textContent).toContain('Only your team sees this');
    expect(note.textContent).toContain('Not sent to the customer');
    expect(note.textContent).toContain('VIP: call before delivery');
    expect(note.getAttribute('data-dir')).toBeNull();
    expect(note.querySelector('.msg-state')).toBeNull();
    // No delivery word anywhere on it except the explicit "Not sent to the customer".
    expect(note.textContent!.replace('Not sent to the customer', '')).not.toMatch(/\b(sent|delivered|read|queued|failed)\b/i);
    // The customer's thread keeps its delivery states.
    expect($(v.host, '.msg[data-dir="outbound"] .msg-state').textContent).toContain('delivered');
    // Day separator, then the message, the reply and the note, in time order.
    expect($$(v.host, '.thread-list > li').map((li) => li.className.split(' ').pop())).toEqual(['thread-day', 'msg', 'msg', 'msg-note']);
    v.unmount();
  });

  it('is localised in Arabic with Western digits', () => {
    const v = mount(withOrg('ar', <Thread d={detail()} timeZone="Africa/Cairo" canReply resendBusy={false} onResend={() => {}} />), 'ar');
    expect($(v.host, '[data-kind="note"]').textContent).toContain('ملاحظة داخلية');
    expect($(v.host, '[data-kind="note"]').textContent).toContain('لم تُرسل إلى العميل');
    expect($(v.host, '.thread-day').textContent).toBe('اليوم');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('announces a new customer message politely, not the first load', async () => {
    const d = detail();
    const v = mount(withOrg('en', <Thread d={d} timeZone="UTC" canReply resendBusy={false} onResend={() => {}} />));
    const live = $(v.host, '[aria-live="polite"]');
    expect(live.textContent).toBe('');
    const next = { ...d, messages: [...d.messages, { ...d.messages[0]!, id: 'm3', body: 'Can I bring my dog?', createdAt: ago(0) }] };
    v.rerender(withOrg('en', <Thread d={next} timeZone="UTC" canReply resendBusy={false} onResend={() => {}} />));
    await flush();
    expect(live.textContent).toBe('New message from Mona: Can I bring my dog?');
    v.unmount();
  });
});

describe('composer', () => {
  const setup = (mode: 'reply' | 'note', calls = { reply: vi.fn(async () => {}), note: vi.fn(async () => {}), mode: vi.fn() }, locale: 'en' | 'ar' = 'en') => {
    const v = mount(withOrg(locale, (
      <Composer d={detail()} mode={mode} onMode={calls.mode} canReply templates={[]} savedReplies={savedReplies}
        quick={{ orderUrl: 'https://app.example/order/olive?branch=main', reserveUrl: null, paymentLink: null }} onReply={calls.reply} onNote={calls.note} />
    )), locale);
    return { v, calls };
  };

  it('"/" opens the saved replies; arrows and Enter insert one; Ctrl+Enter sends it as a reply', async () => {
    const { v, calls } = setup('reply');
    const area = $<HTMLTextAreaElement>(v.host, 'textarea');
    setText(area, 'Hello! /ho');
    const list = $(v.host, '[role="listbox"]');
    expect(area.getAttribute('aria-controls')).toBe(list.id);
    expect($$(list, '[role="option"]').map((o) => o.textContent)).toEqual([expect.stringContaining('Opening hours')]);
    expect(area.getAttribute('aria-activedescendant')).toBe($(list, '[role="option"]').id);
    key(area, 'Enter');
    expect(area.value).toBe('Hello! We open at 9 every day.');
    expect(v.host.querySelector('[role="listbox"]')).toBeNull();
    key(area, 'Enter', { ctrlKey: true });
    await flush();
    expect(calls.reply).toHaveBeenCalledWith({ text: 'Hello! We open at 9 every day.' });
    expect(calls.note).not.toHaveBeenCalled();
    v.unmount();
  });

  it('Escape closes the picker without inserting; quick actions put a link in the draft for a person to send', () => {
    const { v, calls } = setup('reply');
    const area = $<HTMLTextAreaElement>(v.host, 'textarea');
    setText(area, '/');
    expect(v.host.querySelector('[role="listbox"]')).not.toBeNull();
    key(area, 'Escape');
    expect(v.host.querySelector('[role="listbox"]')).toBeNull();
    setText(area, 'Order here');
    click($$(v.host, 'button').find((b) => b.textContent?.includes('Order link'))!);
    expect(area.value).toBe('Order here https://app.example/order/olive?branch=main');
    expect(calls.reply).not.toHaveBeenCalled();
    v.unmount();
  });

  it('a note is staff-only: labelled, sent to the notes endpoint and never to the reply one', async () => {
    const { v, calls } = setup('note');
    expect($(v.host, 'form').getAttribute('data-mode')).toBe('note');
    expect(v.host.textContent).toContain('Staff only: an internal note is never sent to the customer.');
    // No window badge, templates or quick actions on a note: nothing here goes to the customer.
    expect(v.host.textContent).not.toContain('Order link');
    const area = $<HTMLTextAreaElement>(v.host, 'textarea');
    setText(area, 'Refund approved by Hana');
    const submit = $$<HTMLButtonElement>(v.host, 'button').find((b) => b.textContent === 'Add note')!;
    click(submit);
    await flush();
    expect(calls.note).toHaveBeenCalledWith('Refund approved by Hana');
    expect(calls.reply).not.toHaveBeenCalled();
    expect(v.host.textContent).toContain('Note added. It was not sent to the customer.');
    v.unmount();
  });

  it('works in Arabic (saved reply in the conversation language, Western digits)', () => {
    const { v } = setup('reply', undefined, 'ar');
    expect(v.host.textContent).toContain('الردود المحفوظة');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});

describe('conversation list', () => {
  const props = (items: ConvItem[], onFilters = vi.fn(), onSelect = vi.fn()) => ({
    items, selectedId: null, onSelect, loading: false, error: null, hasMore: false, loadingMore: false, onLoadMore: () => {},
    filters: DEFAULT_FILTERS, onFilters, channels: [], tags: [], timeZone: 'Africa/Cairo', now: Date.now(),
  });

  it('shows unread counts, the reply timer with its tone, ordering and lead badges', () => {
    const items = [conv({ lastMessageAt: ago(20) }), conv({ id: 'c2', name: 'Karim', status: 'bot', unreadCount: 0, orderingStep: 'menu', lead: true, lastMessage: { body: 'order', direction: 'inbound' } })];
    const v = mount(withOrg('en', <ConversationList {...props(items)} />));
    const rows = $$(v.host, '.inbox-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute('aria-posinset')).toBe('1');
    expect(rows[0]!.getAttribute('aria-setsize')).toBe('2');
    expect($(rows[0]!, '.inbox-sla').getAttribute('data-tone')).toBe('danger');
    expect($(rows[0]!, '.inbox-sla').textContent).toContain('20');
    expect(rows[0]!.textContent).toContain('2 Unread');
    // A bot chat is not waiting for a person.
    expect(rows[1]!.querySelector('.inbox-sla')).toBeNull();
    expect(rows[1]!.textContent).toContain('Ordering');
    expect(rows[1]!.textContent).toContain('Lead');
    v.unmount();
  });

  it('renders only a window of a long list (virtualised)', () => {
    const items = Array.from({ length: 400 }, (_, i) => conv({ id: `c${i}`, name: `Guest ${i}` }));
    const v = mount(withOrg('en', <ConversationList {...props(items)} />));
    const rendered = $$(v.host, '.inbox-row').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(40);
    expect($$(v.host, '.inbox-spacer').length).toBe(1);
    expect($(v.host, '.inbox-row').getAttribute('aria-setsize')).toBe('400');
    v.unmount();
  });

  it('views are toggle buttons that change the filters', () => {
    const onFilters = vi.fn();
    const v = mount(withOrg('en', <ConversationList {...props([conv({})], onFilters)} />));
    const views = $$(v.host, '[role="group"] button').map((b) => b.textContent);
    expect(views).toEqual(['All', 'Mine', 'Unassigned', 'Open', 'Leads', 'Ordering']);
    click($$(v.host, '[role="group"] button').find((b) => b.textContent === 'Leads')!);
    expect(onFilters).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, view: 'leads' });
    v.unmount();
  });

  it('is localised in Arabic with Western digits', () => {
    const v = mount(withOrg('ar', <ConversationList {...props([conv({ unreadCount: 12, lastMessageAt: ago(75) })])} />), 'ar');
    expect(v.host.textContent).toContain('عملاء محتملون');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});

describe('inbox page: keyboard-only triage', () => {
  async function openPage(locale: 'en' | 'ar' = 'en') {
    const { default: InboxPage } = await import('../page');
    const c1 = conv({}), c2 = conv({ id: 'c2', name: 'Karim', customerId: null, unreadCount: 0, lastMessageAt: ago(30) });
    api.data.set('/o/o1/connect/conversations?', { items: [c1, c2], nextCursor: null });
    api.data.set('/o/o1/connect/conversations/c1', detail());
    api.data.set('/o/o1/connect/conversations/c2', detail({ id: 'c2', contactName: 'Karim', customer: null, notes: [], messages: [] }));
    api.data.set('/o/o1/connect/channels', { items: [] });
    api.data.set('/o/o1/connect/tags', { items: [{ id: 'tg1', name: 'VIP', color: 'amber', createdAt: ago(100) }] });
    api.data.set('/o/o1/connect/saved-replies', { items: savedReplies });
    api.data.set('/o/o1/connect/templates', { items: [] });
    api.data.set('/o/o1/connect/assignees', { items: [{ userId: 'u2', name: 'Omar', role: 'manager' }] });
    api.data.set('/o/o1/customers/cu1/360', undefined);
    const v = mount(withOrg(locale, <InboxPage />), locale);
    await flush();
    return v;
  }
  const press = (k: string, init: KeyboardEventInit = {}) => key(document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body, k, init);
  const header = (host: HTMLElement) => host.querySelector('.thread-name')?.textContent ?? null;

  it('j/k move, n writes a note (keys ignored while typing), r replies, e closes, a opens the assignee menu', async () => {
    const v = await openPage();
    expect(header(v.host)).toBeNull();
    press('j');
    await flush();
    expect(header(v.host)).toBe('Mona');
    press('j');
    await flush();
    expect(header(v.host)).toBe('Karim');
    press('k');
    await flush();
    expect(header(v.host)).toBe('Mona');
    // The selected conversation is marked read.
    expect(api.calls.some((c) => c.path === '/o/o1/connect/conversations/c1/read')).toBe(true);

    press('n');
    await flush();
    const area = $<HTMLTextAreaElement>(v.host, 'textarea');
    expect($(v.host, 'form.composer').getAttribute('data-mode')).toBe('note');
    expect(document.activeElement).toBe(area);
    setText(area, 'Allergic to nuts');
    press('j'); // typing: not a shortcut
    press('e');
    await flush();
    expect(header(v.host)).toBe('Mona');
    expect(api.calls.some((c) => c.path.endsWith('/close'))).toBe(false);
    press('Enter', { ctrlKey: true });
    await flush();
    const noteCall = api.calls.find((c) => c.path === '/o/o1/connect/conversations/c1/notes')!;
    expect(noteCall.opts.body).toMatchObject({ body: 'Allergic to nuts', key: expect.any(String) });
    expect(api.calls.some((c) => c.path.endsWith('/reply'))).toBe(false);

    press('Escape');
    expect(document.activeElement).not.toBe(area);
    press('r');
    await flush();
    expect($(v.host, 'form.composer').getAttribute('data-mode')).toBe('reply');
    expect(document.activeElement).toBe($(v.host, 'textarea'));
    press('Escape');

    press('a');
    await flush();
    const menu = $(v.host, '[role="menu"]');
    expect(menu.hidden).toBe(false);
    expect($$(menu, '[role="menuitem"]').map((i) => i.textContent)).toEqual(['Unassigned', expect.stringContaining('Omar')]);
    press('Escape');
    await flush();

    press('e');
    await flush();
    expect(api.calls.some((c) => c.path === '/o/o1/connect/conversations/c1/close')).toBe(true);
    v.unmount();
  });

  it('registers its shortcuts for the ⌘K palette and the ? cheat sheet while open', async () => {
    const v = await openPage();
    const group = pageCommands()!;
    expect(group.title).toBe('Inbox');
    expect(group.commands.map((c) => [c.key, c.label])).toEqual([
      ['j', 'Next conversation'], ['k', 'Previous conversation'], ['r', 'Reply'], ['n', 'Add an internal note'], ['a', 'Assign'], ['e', 'Close the conversation'],
    ]);
    // Without an open conversation only moving is offered in the palette.
    expect(group.commands.filter((c) => c.enabled !== false).map((c) => c.id)).toEqual(['next', 'prev']);
    act(() => group.commands[0]!.run());
    await flush();
    expect(header(v.host)).toBe('Mona');
    v.unmount();
    expect(pageCommands()).toBeNull();
  });

  it('works in Arabic', async () => {
    const v = await openPage('ar');
    press('j');
    await flush();
    expect(v.host.querySelector('h1')?.textContent).toBe('صندوق الرسائل');
    expect(v.host.textContent).toContain('ملاحظة داخلية');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});
