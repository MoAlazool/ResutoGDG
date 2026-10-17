import {
  apiAs, apiCreateTenant, apiSeedMenu, collectApiFailures, collectErrors, eventually, expect, expectNoHorizontalOverflow, newContext,
  paySandboxInBrowser, sql, test, type Tenant,
} from './fixtures';

// Scenario 3 (WhatsApp ordering) — the conversation is driven through the staff
// sandbox simulator (POST /connect/sandbox/inbound, as in apps/api/test/connect.test.ts),
// then the guest completes the hosted ordering page /o/<token> on a phone, pays
// online with the sandbox provider, and the order reaches the kitchen feed.

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 15_000 });

const L = {
  en: { add: 'Add', review: 'Review order', reviewTitle: 'Review your order', payOnline: 'Pay online', awaiting: 'Complete your payment', payNow: 'Pay now', large: 'Large', burger: 'Smash burger', fries: 'Fries' },
  ar: { add: 'أضف', review: 'راجع الطلب', reviewTitle: 'راجع طلبك', payOnline: 'ادفع أونلاين', awaiting: 'أكمل الدفع', payNow: 'ادفع الآن', large: 'كبير', burger: 'برجر سماش', fries: 'بطاطس' },
} as const;

let phone = 0;
const nextPhone = () => `+2010077${String(Date.now() % 10000).padStart(4, '0')}${++phone}`;

async function lastOutbound(conversationId: string) {
  const rows = await sql<{ payload: any; body: string }>(`select payload, body from messages where conversation_id = $1 and direction = 'outbound' order by created_at desc, id desc limit 1`, [conversationId]);
  return rows[0]!;
}

/** Walks the sandbox bot: "order" → pickup → name, returning the hosted page path from the bot's menu link. */
async function walkToMenuLink(request: import('@playwright/test').APIRequestContext, t: Tenant) {
  const api = apiAs(request, t.owner);
  const channel = await api.post(`/o/${t.orgId}/connect/channels`, { transport: 'sandbox', displayName: 'WhatsApp sandbox' });
  expect(channel.sandbox).toBe(true);
  const from = nextPhone();
  const inbound = (msg: Record<string, unknown>) => api.post(`/o/${t.orgId}/connect/sandbox/inbound`, { channelId: channel.id, from, ...msg });
  const first = await inbound({ text: 'order', name: 'Mona' });
  expect(first.sandbox).toBe(true);
  expect((await lastOutbound(first.conversationId)).payload.buttons.map((b: any) => b.id)).toEqual(['ful:pickup', 'ful:delivery']);
  await inbound({ reply: { id: 'ful:pickup', title: 'Pickup' } });
  await inbound({ text: 'Mona Adel' });
  const link = await lastOutbound(first.conversationId);
  expect(link.payload).toMatchObject({ type: 'cta_url', sandbox: true });
  const url = new URL(link.payload.url);
  expect(url.pathname).toMatch(/^\/o\/[A-Za-z0-9_-]+$/);
  return { conversationId: first.conversationId as string, path: url.pathname, from };
}

for (const locale of ['en', 'ar'] as const) {
  test(`WhatsApp sandbox → hosted ordering page (${locale}, 390 px) → online sandbox payment → kitchen feed`, async ({ browser, request }) => {
    const s = L[locale];
    const tenant = await apiCreateTenant(request);
    await apiSeedMenu(request, tenant);
    const { conversationId, path } = await walkToMenuLink(request, tenant);
    const guest = await newContext(browser, { mobile: true, locale });
    const errors = collectErrors(guest.page);
    const failures = collectApiFailures(guest.page);
    const g = guest.page;
    try {
      await g.goto(path);
      const root = g.locator('div[dir]').first();
      await expect(root).toHaveAttribute('dir', 'ltr');
      if (locale === 'ar') {
        // The page starts in the conversation's language (the cookie is ignored, H-5); switch with its toggle.
        await g.getByRole('button', { name: 'العربية' }).click();
      }
      await expect(root).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(root).toHaveAttribute('lang', locale);
      await expect(g.getByText(s.burger)).toBeVisible();
      await expectNoHorizontalOverflow(g);

      // Build a cart: a Large burger (modifier sheet) and fries.
      await g.locator('article').filter({ hasText: s.burger }).getByRole('button', { name: s.add }).click();
      const sheet = g.getByRole('dialog');
      await expect(sheet.locator('input[type="radio"]:checked')).toHaveCount(1); // required Size preselected
      await sheet.locator('label').filter({ hasText: s.large }).click();
      await sheet.getByRole('button', { name: s.add }).click();
      await g.locator('article').filter({ hasText: s.fries }).getByRole('button', { name: s.add }).click();
      await expect(g.getByText(locale === 'ar' ? /^(2|٢) صنف$/ : /^2 item\(s\)$/)).toBeVisible();
      await g.getByRole('button', { name: s.review }).click();
      await expect(g.getByRole('heading', { name: s.reviewTitle })).toBeVisible();
      await expectNoHorizontalOverflow(g);
      const [session] = await sql(`select step, state from ordering_sessions where conversation_id = $1`, [conversationId]);
      expect(session.step).toBe('review');
      await expect(g.getByText(locale === 'ar' ? /260|٢٦٠/ : 'EGP 260').first()).toBeVisible(); // (18500 + 3000) + 4500

      // Online payment → hosted checkout → sandbox provider → receipt.
      await g.getByRole('button', { name: s.payOnline }).click();
      await expect(g.getByRole('heading', { name: s.awaiting })).toBeVisible();
      await g.getByRole('link', { name: s.payNow }).click();
      if (locale === 'ar') {
        // The payment pages are bilingual too; drive them by role/structure.
        await expect(g.locator('.pay-methods')).toBeVisible();
        await expectNoHorizontalOverflow(g);
        await g.locator('.pay-methods [role="radio"]').first().click();
        await g.locator('.pay-card .btn-primary').last().click();
        await expect(g).toHaveURL(/\/sandbox/);
        await g.locator('.pay-card .btn-primary').first().click();
        await expect(g).toHaveURL(/\?return=1/);
      } else {
        await paySandboxInBrowser(g);
        await expect(g.getByText('Payment successful')).toBeVisible({ timeout: 20_000 });
      }

      const [order] = await eventually(async () => {
        const rows = await sql<{ id: string; status: string; payment_status: string; channel: string; total_minor: string }>(
          `select id, status, payment_status, channel, total_minor from orders where conversation_id = $1`, [conversationId]);
        return rows[0]?.payment_status === 'paid' ? rows : null;
      }, { message: 'order paid' });
      expect(order).toMatchObject({ channel: 'whatsapp', payment_status: 'paid', total_minor: '26000' });
      expect(order!.status).toBe('placed');

      // The paid order is on the kitchen feed (API) and on the KDS (browser).
      const feed = await apiAs(request, tenant.owner).get(`/o/${tenant.orgId}/kitchen/${tenant.branchId}`);
      const ticket = (feed.tickets ?? feed.items ?? feed.orders ?? []).find((x: any) => x.id === order!.id);
      expect(ticket, JSON.stringify(feed).slice(0, 400)).toBeTruthy();
      const staff = await newContext(browser, { user: tenant.owner });
      try {
        await staff.page.goto(`/kitchen/${tenant.orgId}`);
        await expect(staff.page.locator('.kds-col').first().locator('article').filter({ hasText: 'Smash burger' })).toBeVisible({ timeout: 15_000 });
      } finally {
        await staff.context.close();
      }
      // The conversation gets the confirmation (order.paid / order.placed handlers on the worker).
      await eventually(async () => /#\d+/.test((await lastOutbound(conversationId)).body ?? ''), { message: 'confirmation message' });
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await guest.context.close();
    }
  });
}

// DEFECT: H-5 the hosted ordering page ignores the resuto_locale cookie and always starts in the conversation's language.
test.fail('the hosted ordering page honours the Arabic locale cookie (dir=rtl, no overflow)', async ({ browser, request }) => {
  const tenant = await apiCreateTenant(request);
  await apiSeedMenu(request, tenant);
  const { path } = await walkToMenuLink(request, tenant);
  const guest = await newContext(browser, { mobile: true, locale: 'ar' });
  try {
    await guest.page.goto(path);
    await expect(guest.page.getByText(L.ar.burger)).toBeVisible();
    await expect(guest.page.locator('div[dir]').first()).toHaveAttribute('dir', 'rtl');
    await expectNoHorizontalOverflow(guest.page);
  } finally {
    await guest.context.close();
  }
});
