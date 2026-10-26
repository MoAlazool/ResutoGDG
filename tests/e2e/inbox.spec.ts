import { request as playwrightRequest, type Page } from '@playwright/test';
import { apiAs, apiCreateTenant, collectApiFailures, collectErrors, expect, newContext, sql, test, type Tenant } from './fixtures';

// 21-INBOX increment 2 in the browser (Chromium): keyboard-only triage of a conversation in the three-pane Inbox —
// j/k to move, n for an internal note (never sent), r with a "/" saved reply, a tag applied from the keyboard, the
// Customer 360 panel, e to close, and the page's shortcuts in the ? cheat sheet and the ⌘K palette. The old
// Channels/Templates tabs lead to Settings › Messaging.

let tenant: Tenant;
let mona: string;
let karim: string;

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  const api = apiAs(request, tenant.owner);
  const channel = await api.post(`/o/${tenant.orgId}/connect/channels`, { transport: 'sandbox', displayName: 'WhatsApp sandbox', orderingEnabled: false });
  const inbound = (from: string, name: string, text: string) => api.post(`/o/${tenant.orgId}/connect/sandbox/inbound`, { channelId: channel.id, from, name, text });
  mona = (await inbound('+201005550101', 'Mona Adel', 'Is the terrace open tonight?')).conversationId;
  karim = (await inbound('+201005550102', 'Karim Said', 'Do you deliver to Maadi?')).conversationId;
  await api.post(`/o/${tenant.orgId}/connect/tags`, { name: 'VIP', color: 'amber' });
  await api.post(`/o/${tenant.orgId}/connect/saved-replies`, { title: 'Opening hours', shortcut: 'hours', bodyEn: 'We are open every day from 9 am to midnight.' });
  await request.dispose();
});

test.describe.configure({ timeout: 120_000 });

const inboxUrl = () => `/dashboard/${tenant.orgId}/inbox`;
const header = (page: Page) => page.locator('.thread-name');

/** Tabs until the focused element is a button named `name` (keyboard only). */
async function tabToButton(page: Page, name: string, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const text = await page.evaluate(() => (document.activeElement?.tagName === 'BUTTON' ? (document.activeElement.textContent ?? '').trim() : ''));
    if (text === name) return;
  }
  throw new Error(`"${name}" not reached by Tab`);
}

test('keyboard-only triage: move, note, saved reply, tag, Customer 360, close; shortcuts in ? and ⌘K', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  const failures = collectApiFailures(page);
  try {
    await page.goto(inboxUrl());
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible({ timeout: 20_000 });
    const rows = page.getByRole('list', { name: 'Conversations' }).getByRole('button');
    await expect(rows).toHaveCount(2);
    await expect(page.getByText('Choose a conversation')).toBeVisible();

    // j opens the newest conversation, j the next one, k goes back.
    await page.keyboard.press('j');
    await expect(header(page)).toHaveText('Karim Said');
    await page.keyboard.press('j');
    await expect(header(page)).toHaveText('Mona Adel');
    await page.keyboard.press('k');
    await expect(header(page)).toHaveText('Karim Said');
    await page.keyboard.press('j');
    await expect(header(page)).toHaveText('Mona Adel');
    await expect(page).toHaveURL(new RegExp(`\\?c=${mona}`));

    // n: an internal note. Keys typed in the composer are text, not shortcuts.
    await page.keyboard.press('n');
    const composer = page.locator('form.composer');
    await expect(composer).toHaveAttribute('data-mode', 'note');
    const text = composer.locator('textarea');
    await expect(text).toBeFocused();
    await page.keyboard.type('VIP: allergic to nuts, call before delivery');
    await expect(header(page)).toHaveText('Mona Adel');
    await page.keyboard.press('Control+Enter');
    const note = page.locator('[data-kind="note"]', { hasText: 'VIP: allergic to nuts, call before delivery' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('Internal note');
    await expect(note).toContainText('Not sent to the customer');
    await expect(note.locator('.msg-state')).toHaveCount(0);
    const [stored] = await sql(`select direction, kind, status, provider_message_id from messages where conversation_id = $1 and kind = 'note'`, [mona]);
    expect(stored).toEqual({ direction: 'internal', kind: 'note', status: 'received', provider_message_id: null });
    expect((await sql(`select count(*)::int as n from messages where conversation_id = $1 and direction = 'outbound'`, [mona]))[0].n).toBe(0);

    // r: a reply with a saved reply from "/".
    await page.keyboard.press('Escape');
    await expect(text).not.toBeFocused();
    await page.keyboard.press('r');
    await expect(composer).toHaveAttribute('data-mode', 'reply');
    await expect(text).toBeFocused();
    await page.keyboard.type('/hou');
    const picker = page.getByRole('listbox', { name: 'Saved replies' });
    await expect(picker.getByRole('option')).toHaveText([/Opening hours/]);
    await page.keyboard.press('Enter');
    await expect(text).toHaveValue('We are open every day from 9 am to midnight.');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.msg[data-dir="outbound"]', { hasText: 'We are open every day from 9 am to midnight.' })).toBeVisible();
    await expect(text).toHaveValue('');

    // A tag, from the keyboard: Tab to "Add tag", Enter opens the menu on the first tag, Enter applies it.
    await tabToButton(page, 'Add tag');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'VIP' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('list', { name: 'Tags' })).toContainText('VIP');
    const detail = await apiAs(page.request, tenant.owner).get(`/o/${tenant.orgId}/connect/conversations/${mona}`);
    expect(detail.tags.map((x: { name: string }) => x.name)).toEqual(['VIP']);

    // The Customer 360 panel for Mona's profile, with the source of its figures.
    await expect(page.getByRole('heading', { name: 'Customer 360' })).toBeVisible();
    await expect(page.locator('[data-section="value"]')).toContainText('From the customer totals of all branches');
    await expect(page.locator('[data-section="consent"]')).toContainText('recorded once per customer');

    // ? lists the page's keys; ⌘K offers its actions.
    await page.locator('body').press('Shift+?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toContainText('On this page: Inbox');
    await expect(sheet).toContainText('Add an internal note');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await page.keyboard.press('Control+K');
    const palette = page.getByRole('combobox', { name: 'Command palette' });
    await expect(palette).toBeFocused();
    // Mona's conversation moved to the top with our reply, so the next one is Karim's.
    await expect(rows.first()).toContainText('Mona Adel');
    await page.keyboard.type('next conv');
    await expect(page.getByRole('listbox', { name: 'Command palette' }).getByRole('option').first()).toContainText('Next conversation');
    await page.keyboard.press('Enter');
    await expect(header(page)).toHaveText('Karim Said');

    // e closes the conversation.
    await page.keyboard.press('e');
    await expect(page.locator('.thread-meta')).toContainText('Closed');
    expect((await apiAs(page.request, tenant.owner).get(`/o/${tenant.orgId}/connect/conversations/${karim}`)).status).toBe('closed');

    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the old Channels and Templates tabs lead to Settings › Messaging', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  try {
    await page.goto(`${inboxUrl()}?tab=templates`);
    await expect(page).toHaveURL(new RegExp(`/dashboard/${tenant.orgId}/settings/messaging\\?tab=templates$`), { timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Messaging' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Templates' })).toHaveAttribute('aria-selected', 'true');
    await page.goto(`${inboxUrl()}?tab=channels`);
    await expect(page).toHaveURL(new RegExp(`/dashboard/${tenant.orgId}/settings/messaging$`));
    await expect(page.getByRole('cell', { name: 'WhatsApp sandbox' })).toBeVisible();
    // The Inbox links there, and Settings lists it next to the restaurant settings.
    await page.goto(inboxUrl());
    await page.getByRole('link', { name: 'Channels & templates' }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/messaging$`));
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Messaging' })).toHaveAttribute('aria-current', 'page');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

// 22-INTINBOX: the workspace is exactly the viewport. With a busy inbox (30 conversations, an 80-message thread in
// Arabic and English) the document never scrolls on a desktop; the list, the thread and the customer pane scroll on
// their own; the thread header and the composer stay in view whatever the thread's scroll position. On a phone the
// panes come one at a time (list → thread → customer) with the composer still in view.
test('full-height workspace: no document scroll, independent pane scroll, composer always in view', async ({ browser, request }) => {
  const busy = await apiCreateTenant(request, { planId: 'pro' });
  const api = apiAs(request, busy.owner);
  const channel = await api.post(`/o/${busy.orgId}/connect/channels`, { transport: 'sandbox', displayName: 'WhatsApp sandbox', orderingEnabled: false });
  const say = (from: string, name: string, text: string) => api.post(`/o/${busy.orgId}/connect/sandbox/inbound`, { channelId: channel.id, from, name, text });
  for (let i = 0; i < 30; i++) await say(`+2010055${String(10000 + i)}`, i % 2 ? `ضيف ${i}` : `Guest ${i}`, i % 2 ? 'هل التراس مفتوح الليلة؟' : 'Is the terrace open tonight?');
  let long = '';
  for (let i = 0; i < 80; i++) long = (await say('+201005599999', 'Salma Farouk', i % 3 === 0 ? `رسالة رقم ${i}: عايزة أحجز ترابيزة لـ 6 الساعة 9` : `Message ${i}: can we bring our own cake? Mixed نص عربي too`)).conversationId;

  const measure = (page: Page) => page.evaluate(() => {
    const box = (sel: string) => { const e = document.querySelector(sel)!; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, sh: e.scrollHeight, ch: e.clientHeight, oy: getComputedStyle(e).overflowY }; };
    return { doc: document.documentElement.scrollHeight, vh: window.innerHeight, scrollY: window.scrollY, list: box('.inbox-list-scroll'), thread: box('.thread'), composer: box('form.composer'), head: box('.thread-head') };
  });

  const { context, page } = await newContext(browser, { user: busy.owner });
  const errors = collectErrors(page);
  try {
    await page.goto(`/dashboard/${busy.orgId}/inbox?c=${long}`);
    await expect(page.locator('.thread .msg').first()).toBeVisible({ timeout: 20_000 });
    expect(await page.locator('.thread .msg').count()).toBeGreaterThanOrEqual(80);
    let m = await measure(page);
    expect(m.doc, 'the document is exactly the viewport').toBeLessThanOrEqual(m.vh);
    expect(m.list.sh, 'the list scrolls inside its pane').toBeGreaterThan(m.list.ch);
    expect(m.thread.sh, 'the thread scrolls inside its pane').toBeGreaterThan(m.thread.ch);
    expect([m.list.oy, m.thread.oy]).toEqual(['auto', 'auto']);
    expect(m.composer.bottom).toBeLessThanOrEqual(m.vh);
    // Scroll the thread to its start, then the list to its end: the page itself never moves, header and composer stay.
    await page.locator('.thread').evaluate((e) => { e.scrollTop = 0; });
    await page.locator('.inbox-list-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, 4000);
    m = await measure(page);
    expect(m.scrollY).toBe(0);
    expect(m.head.top).toBeGreaterThanOrEqual(0);
    expect(m.composer.top).toBeGreaterThan(m.thread.top);
    expect(m.composer.bottom).toBeLessThanOrEqual(m.vh);
    await expect(page.locator('form.composer textarea')).toBeInViewport();
    // The customer pane scrolls on its own too, and can be hidden to give the thread the room.
    expect(await page.locator('.rui-workspace-end').evaluate((e) => getComputedStyle(e).overflowY)).toBe('auto');
    await page.getByRole('button', { name: 'Customer details' }).click();
    await expect(page.locator('.rui-workspace-end')).toBeHidden();
    await page.getByRole('button', { name: 'Customer details' }).click();
    await expect(page.locator('.rui-workspace-end')).toBeVisible();
    // Keyboard triage still works in the full-height layout.
    await page.locator('body').press('j');
    await expect(page.locator('.thread-name')).not.toHaveText('Salma Farouk');
    await page.locator('body').press('k');
    await expect(page.locator('.thread-name')).toHaveText('Salma Farouk');
    // Mixed-direction text keeps its own direction per message.
    await expect(page.locator('.thread .msg-bubble').first()).toHaveAttribute('dir', 'auto');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }

  const phone = await newContext(browser, { user: busy.owner, mobile: true });
  try {
    await phone.page.goto(`/dashboard/${busy.orgId}/inbox`);
    await expect(phone.page.locator('.inbox-row').first()).toBeVisible({ timeout: 20_000 });
    let m = await phone.page.evaluate(() => ({ doc: document.documentElement.scrollHeight, vh: window.innerHeight }));
    expect(m.doc).toBeLessThanOrEqual(m.vh);
    await phone.page.locator(`[data-conversation="${long}"]`).click();
    await expect(phone.page.locator('.thread .msg').first()).toBeVisible();
    await expect(phone.page.locator('.inbox-list')).toBeHidden();
    await expect(phone.page.locator('form.composer textarea')).toBeInViewport();
    m = await phone.page.evaluate(() => ({ doc: document.documentElement.scrollHeight, vh: window.innerHeight }));
    expect(m.doc).toBeLessThanOrEqual(m.vh);
    await phone.page.getByRole('button', { name: 'Customer details' }).click();
    await expect(phone.page.locator('.rui-workspace-end')).toBeVisible();
    await expect(phone.page.locator('.thread')).toBeHidden();
    await phone.page.getByRole('button', { name: 'Back to the conversation' }).click();
    await expect(phone.page.locator('.thread')).toBeVisible();
    await phone.page.getByRole('button', { name: 'Conversations' }).click();
    await expect(phone.page.locator('.inbox-list')).toBeVisible();
  } finally {
    await phone.context.close();
  }
});
