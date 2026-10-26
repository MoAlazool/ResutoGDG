import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import {
  API_URL, apiAs, apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, apiSignup, expect, publishSite, qrPath, signIn, sql, test, unique,
  WEB_URL, type MenuSeed, type Tenant, type User,
} from './fixtures';

// 22-DASH: layout regression sweep. The main staff routes (with the Inbox, integrations, Website studio and Messaging),
// the full-screen kitchen display, the operator console, the guest pages, the sign-in pages and onboarding, in English
// and Arabic, at 1280 px (desktop), 768 px (tablet: sidebar beside the page) and 390 px (phone). Every page must
//   1. never scroll sideways: document scrollWidth === clientWidth (a wide table or board scrolls inside its own box);
//   2. show no visible text smaller than 12.5 px in English or 13.5 px in Arabic (the 22-TYPE / 22-DASH floor: small
//      sizes go through the --t-sm / --fs-sm tokens, which are larger in Arabic).
// SVG text (charts, the floor drawing) scales with its drawing and is not measured; neither is visually hidden text.

const ROUTES = [
  '', '/orders', '/orders?view=list', '/kitchen', '/floor', '/host', '/reservations', '/menu', '/inventory', '/customers', '/customers?view=segments',
  '/payments', '/payments?tab=reconciliation', '/finance', '/finance/pnl', '/finance/expenses', '/finance/exports', '/marketing', '/loyalty',
  '/analytics', '/analytics/sales', '/intelligence', '/intelligence/assistant', '/mcp', '/mcp/approvals', '/approvals', '/qr', '/settings',
  '/team', '/billing', '/audit',
  // 22-DASH follow-up: the Inbox (list and a thread with Customer 360), the integrations marketplace and a connect sheet, the
  // Website studio (Design and Optimize; the canvas frame holds the restaurant's own site and is not measured), Food
  // photos and Settings › Messaging with the WhatsApp stepper open.
  '/inbox', '/inbox?c=CONVERSATION', '/integrations', '/integrations?provider=paymob', '/website', '/website?tab=optimize', '/studio-media',
  '/settings/messaging', '/settings/messaging?connect=whatsapp',
  // 22-DEVICES: Settings › iPad devices (an active and a revoked iPad in the list) and its pairing sheet.
  '/settings/devices', '/settings/devices?pair=1',
];
const WIDTHS = [{ width: 1280, height: 860 }, { width: 768, height: 1024 }, { width: 390, height: 844 }] as const;
const MIN_PX = { en: 12.5, ar: 13.5 } as const;

interface Finding { overflow: string | null; small: string[] }

/** Horizontal overflow of the document and visible text under the minimum size (deduplicated by element and size). */
async function measure(page: Page, minPx: number): Promise<Finding> {
  return page.evaluate((min) => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth > doc.clientWidth + 1 ? `scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}` : null;
    const hidden = (el: Element) => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
        if (cs.clipPath === 'inset(50%)' || cs.clip === 'rect(0px, 0px, 0px, 0px)') return true;
        if (e instanceof HTMLDialogElement && !e.open) return true;
      }
      return false;
    };
    const small = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      if (el.closest('svg, script, style, noscript, template')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || hidden(el)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < min) {
        const cls = [...el.classList].slice(0, 2).join('.');
        small.add(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} ${fs}px "${n.textContent.trim().slice(0, 30)}"`);
      }
    }
    return { overflow, small: [...small] };
  }, minPx);
}

async function settle(page: Page) {
  await page.waitForLoadState('load');
  // A visible heading (on a phone the Inbox thread pane hides the page title, so its thread heading counts).
  await expect(page.locator('h1:visible, main h2:visible, main .empty strong:visible').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.skeleton:visible')).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

function report(label: string, f: Finding): string[] {
  return [...(f.overflow ? [`${label}: page scrolls sideways (${f.overflow})`] : []), ...f.small.map((s) => `${label}: small text ${s}`)];
}

async function placeQrOrder(request: APIRequestContext, t: Tenant, menu: MenuSeed) {
  const qr = (await apiQrSheet(request, t))[0]!;
  const s = await (await request.post(`${API_URL}/v1/public/tables/${qrPath(qr.url).split('/t/')[1]}/session`)).json();
  const lines = [{ productId: menu.burger, quantity: 2, modifiers: [{ groupId: menu.sizeGroup, optionId: menu.large }] }, { productId: menu.fries, quantity: 1, modifiers: [] }];
  const quote = await (await request.post(`${API_URL}/v1/public/visits/current/quote`, { headers: { 'X-Visit-Token': s.token }, data: { lines } })).json();
  const res = await request.post(`${API_URL}/v1/public/visits/current/orders`, { headers: { 'X-Visit-Token': s.token, 'Idempotency-Key': unique('o') }, data: { lines, expectedTotalMinor: quote.totalMinor } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

let tenant: Tenant;
let tablePath: string;
let superadmin: User;
let conversationId: string;
let newcomer: User;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  const menu = await apiSeedMenu(request, tenant);
  await apiSaveFloor(request, tenant);
  tablePath = qrPath((await apiQrSheet(request, tenant))[0]!.url);
  await publishSite(request, tenant, { productIds: [menu.burger, menu.fries] });
  // Something on the boards, tables and lists: a QR order on a table and a customer with a long name and a phone.
  await placeQrOrder(request, tenant, menu);
  await sql(`insert into customers(org_id, display_name, phone_e164, email) values ($1, 'Mona Abdelrahman El-Sayed (layout)', '+201001112233', 'mona.layout@example.test')`, [tenant.orgId]);
  await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/mcp/clients`, { name: 'Layout assistant', actingRole: 'manager', groups: ['menu'], rateLimitPerMin: 600 });
  // Two paired iPads for Settings › iPad devices: one active, one revoked with a reason (pairing as in pos-ipad.spec.ts).
  for (const [i, name] of ['Counter iPad (layout)', 'Kitchen display iPad with a long name'].entries()) {
    const pairing = await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/pos/pairings`, { branchId: tenant.branchId, actingRole: i ? 'kitchen' : 'cashier', name, requireStaff: !i });
    const paired = await request.post(`${API_URL}/v1/pos/pair`, { headers: { 'X-Forwarded-For': `198.19.250.${10 + i}` }, data: { code: pairing.code, model: 'iPad13,1', appVersion: '0.2.0' } });
    expect(paired.status(), await paired.text()).toBe(201);
    if (i) await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/pos/devices/${(await paired.json()).device.id}/revoke`, { reason: 'Replaced by a new iPad after the screen cracked' });
  }
  // An Inbox conversation (sandbox WhatsApp channel) for the thread and Customer 360 panes.
  const api = apiAs(request, tenant.owner);
  const channel = await api.post(`/o/${tenant.orgId}/connect/channels`, { transport: 'sandbox', displayName: 'WhatsApp sandbox', orderingEnabled: false });
  conversationId = (await api.post(`/o/${tenant.orgId}/connect/sandbox/inbound`, { channelId: channel.id, from: '+201005550199', name: 'Mona Abdelrahman', text: 'Is the terrace open tonight? We are six.' })).conversationId;
  // A signed-up account without a restaurant, for the onboarding wizard.
  newcomer = await apiSignup(request, 'Layout Newcomer');
  superadmin = await apiSignup(request, 'Layout Operator');
  await sql(`insert into platform_admins(user_id, role) values ($1, 'superadmin') on conflict do nothing`, [superadmin.userId]);
  await request.dispose();
});

test.describe.configure({ timeout: 600_000 });

for (const locale of ['en', 'ar'] as const) {
  test(`staff routes never scroll sideways and keep text at ${MIN_PX[locale]} px or more (${locale})`, async ({ browser }) => {
    const failures: string[] = [];
    for (const size of WIDTHS) {
      const phone = size.width < 700;
      const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, baseURL: WEB_URL, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await signIn(page, tenant.owner, locale);
      for (const route of ROUTES) {
        await page.goto(`/dashboard/${tenant.orgId}${route.replace('CONVERSATION', conversationId)}`);
        await settle(page);
        failures.push(...report(`${locale} ${size.width} ${route || '/'}`, await measure(page, MIN_PX[locale])));
      }
      await page.goto(`/kitchen/${tenant.orgId}`);
      await settle(page);
      failures.push(...report(`${locale} ${size.width} /kitchen/[orgId]`, await measure(page, MIN_PX[locale])));
      await context.close();
    }
    expect(failures).toEqual([]);
  });

  test(`operator console, guest, sign-in and onboarding pages never scroll sideways and keep text at ${MIN_PX[locale]} px or more (${locale})`, async ({ browser }) => {
    const failures: string[] = [];
    for (const size of WIDTHS) {
      const phone = size.width < 700;
      const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, baseURL: WEB_URL, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await signIn(page, superadmin, locale);
      for (const url of ['/admin', '/admin/operations', `/admin/tenants/${tenant.orgId}`]) {
        await page.goto(url);
        await settle(page);
        failures.push(...report(`${locale} ${size.width} ${url.replace(tenant.orgId, '[orgId]')}`, await measure(page, MIN_PX[locale])));
      }
      for (const url of [`/m/${tenant.slug}`, tablePath, `/order/${tenant.slug}`, `/reserve/${tenant.slug}`]) {
        await page.goto(url);
        await settle(page);
        failures.push(...report(`${locale} ${size.width} ${url.replace(tenant.slug, '[slug]').replace(/\/t\/[^/]+$/, '/t/[qr]')}`, await measure(page, MIN_PX[locale])));
      }
      // Sign-in pages (signed out) and the onboarding wizard (an account without a restaurant).
      await page.evaluate(() => localStorage.removeItem('resuto_session'));
      for (const url of ['/login', '/signup', '/forgot-password', '/reset-password']) {
        await page.goto(url);
        await settle(page);
        failures.push(...report(`${locale} ${size.width} ${url}`, await measure(page, MIN_PX[locale])));
      }
      await signIn(page, newcomer, locale);
      await page.goto('/onboarding');
      await settle(page);
      failures.push(...report(`${locale} ${size.width} /onboarding`, await measure(page, MIN_PX[locale])));
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}
