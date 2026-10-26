import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import {
  API_URL, apiAs, apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, apiSignup, expect, MOBILE, publishSite, qrPath, ROOT, signIn, sql,
  test, unique, WEB_URL, type MenuSeed, type Tenant, type User,
} from './fixtures';

// 21-A11Y (plan §8 1D, §4 Accessibility): axe-core on every staff route an owner can reach, in English and Arabic on
// desktop and on a phone for the busiest screens, plus the operator console, the guest pages, the sign-in pages and
// the landing page. WCAG 2.2 AA colour contrast is checked here (the other specs switch it off), and any serious or
// critical violation fails the test. Nothing is excluded from a scan.
//
// The route list is derived, not hand-kept: every `href` in apps/web/lib/nav.ts and lib/sections.ts (including tabs
// such as /floor?tab=qr), plus every page.tsx under app/dashboard/[orgId] (pages reached from another page, such as
// /mcp/new). A dynamic segment is either covered by a concrete href (/analytics/[section]) or resolved with a real id
// from the fixture restaurant below; a new dynamic route without a resolver fails the route-list test.

const WEB_APP = path.join(ROOT, 'apps/web/app');
const DASHBOARD = path.join(WEB_APP, 'dashboard/[orgId]');

function pagesUnder(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name.startsWith('_')) continue; // private folders (_components, _ui) are not routes
      // Route groups "(name)" add no path segment.
      out.push(...pagesUnder(full, /^\(.+\)$/.test(name) ? rel : `${rel}/${name}`));
    } else if (name === 'page.tsx') out.push(rel);
  }
  return out;
}

const hrefsIn = (file: string) => [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/href: '([^']*)'/g)].map((m) => m[1]!);

/** Dashboard routes relative to /dashboard/[orgId], with dynamic segments still as "[name]". */
function staffRouteTemplates(): string[] {
  // Navigation items and their tabs, section lists, and the palette's page actions (dialogs opened by ?new=1 …).
  const navHrefs = [...hrefsIn('apps/web/lib/nav.ts'), ...hrefsIn('apps/web/lib/sections.ts'), ...hrefsIn('apps/web/lib/palette-entries.ts')];
  const fsRoutes = pagesUnder(DASHBOARD);
  const all = new Set<string>(navHrefs);
  // Tabs a page reads from the address (`type Tab = 'a' | 'b'` and a `tab` query parameter): every tab after the first.
  for (const r of fsRoutes) {
    const src = readFileSync(path.join(DASHBOARD, r, 'page.tsx'), 'utf8');
    const union = /type Tab = ([^;]+);/.exec(src)?.[1];
    if (!union || !/['"]tab['"]/.test(src)) continue;
    for (const tab of [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).slice(1)) all.add(`${r}?tab=${tab}`);
  }
  const matches = (template: string, href: string) =>
    new RegExp(`^${template.replace(/\[[^\]]+\]/g, '[^/?]+')}$`).test(href.split('?')[0]!);
  for (const r of fsRoutes) {
    if (!r.includes('[')) { all.add(r); continue; }
    // A dynamic page already covered by a concrete navigation href (e.g. /analytics/sales for /analytics/[section]).
    if (navHrefs.some((h) => matches(r, h))) continue;
    all.add(r);
  }
  return [...all].sort();
}

interface Ids { customerId: string; paymentId: string; changeSetId: string; clientId: string }

/** Real ids for the dynamic segments of the dashboard (a new dynamic route needs an entry here). */
const RESOLVERS: Record<string, (ids: Ids) => string> = {
  '/customers/[customerId]': (ids) => `/customers/${ids.customerId}`,
  '/payments/[paymentId]': (ids) => `/payments/${ids.paymentId}`,
  '/approvals/[changeSetId]': (ids) => `/approvals/${ids.changeSetId}`,
  '/mcp/clients/[clientId]': (ids) => `/mcp/clients/${ids.clientId}`,
};

/** The screens checked on a phone as well (the busiest operations and settings screens). */
const PHONE_ROUTES = ['', '/orders', '/kitchen', '/floor', '/menu', '/inbox', '/customers', '/analytics', '/settings', '/billing'];

const SERIOUS = new Set(['serious', 'critical']);

/**
 * Waits until the page has drawn its content: a heading (or a module's locked state, which has none: ModuleGate),
 * then no skeleton rows and no busy regions (best effort).
 */
async function settle(page: Page) {
  await page.waitForLoadState('load');
  await expect(page.locator('h1, main .empty strong').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.skeleton:visible')).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/** axe with every rule (colour contrast included); returns the serious/critical violations, readable. */
async function scan(page: Page, label: string): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => SERIOUS.has(v.impact ?? ''));
  if (bad.length) {
    await test.info().attach(`axe-${label.replace(/[^a-z0-9]+/gi, '_')}.json`, { body: JSON.stringify(bad, null, 1), contentType: 'application/json' });
  }
  return bad.map((v) => `${label} — ${v.id} (${v.impact}): ${describeNodes(v.id, v.nodes)}`);
}

/** Colour-contrast nodes grouped by colour pair (every distinct pair listed); other rules: the first targets. */
function describeNodes(rule: string, nodes: Array<{ target: unknown[]; any: Array<{ data?: unknown }> }>) {
  if (rule !== 'color-contrast') return `${nodes.slice(0, 4).map((n) => n.target.join(' ')).join(' | ')}${nodes.length > 4 ? ` (+${nodes.length - 4})` : ''}`;
  const pairs = new Map<string, { first: string; n: number }>();
  for (const node of nodes) {
    const d = (node.any[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string };
    const key = `${d.fgColor} on ${d.bgColor} = ${d.contrastRatio} (needs ${d.expectedContrastRatio})`;
    const seen = pairs.get(key);
    if (seen) seen.n++;
    else pairs.set(key, { first: node.target.join(' '), n: 1 });
  }
  return [...pairs].map(([pair, { first, n }]) => `[${pair}] ${first}${n > 1 ? ` (+${n - 1})` : ''}`).join(' | ');
}

async function placeQrOrder(request: APIRequestContext, t: Tenant, menu: MenuSeed) {
  const qr = (await apiQrSheet(request, t))[0]!;
  const s = await (await request.post(`${API_URL}/v1/public/tables/${qrPath(qr.url).split('/t/')[1]}/session`)).json();
  const lines = [{ productId: menu.fries, quantity: 2, modifiers: [] }];
  const quote = await (await request.post(`${API_URL}/v1/public/visits/current/quote`, { headers: { 'X-Visit-Token': s.token }, data: { lines } })).json();
  const res = await request.post(`${API_URL}/v1/public/visits/current/orders`, { headers: { 'X-Visit-Token': s.token, 'Idempotency-Key': unique('o') }, data: { lines, expectedTotalMinor: quote.totalMinor } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const order = await res.json();
  return (order.id ?? order.order?.id) as string;
}

let tenant: Tenant;
let ids: Ids;
let tablePath: string;
let superadmin: User;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  const owner = apiAs(request, tenant.owner);
  const menu = await apiSeedMenu(request, tenant);
  await apiSaveFloor(request, tenant);
  tablePath = qrPath((await apiQrSheet(request, tenant))[0]!.url);
  await publishSite(request, tenant, { productIds: [menu.burger, menu.fries] });
  // An order paid in cash (a payment to open), a customer, an MCP connection and a change set it proposed.
  const orderId = await placeQrOrder(request, tenant, menu);
  const due = await owner.get(`/o/${tenant.orgId}/payments/due?orderId=${orderId}`);
  const paymentId = (await owner.post(`/o/${tenant.orgId}/payments/collect`, { orderId, method: 'cash', amountMinor: due.dueMinor, key: unique('collect') })).id;
  const [customer] = await sql(`insert into customers(org_id, display_name, phone_e164, email) values ($1, 'Mona Adel', '+201001112233', 'mona@example.test') returning id`, [tenant.orgId]);
  const conn = await owner.post(`/o/${tenant.orgId}/mcp/clients`, { name: 'A11y assistant', actingRole: 'manager', groups: ['menu', 'promotions'], rateLimitPerMin: 600 });
  const proposed = await request.post(`${API_URL}/v1/o/${tenant.orgId}/mcp/tools/propose_changes`, {
    headers: { Authorization: `Bearer ${conn.key}` },
    data: { input: { title: 'Weekend offer', summary: 'A 10% weekend promotion', idempotencyKey: unique('cs'), ops: [
      { type: 'promotion.create', input: { name: 'Weekend 10', nameAr: 'خصم نهاية الأسبوع', code: 'WKND10', kind: 'percent', value: 1000 } },
    ] } },
  });
  const body = await proposed.json();
  expect(proposed.status(), JSON.stringify(body)).toBe(202);
  ids = { customerId: customer.id, paymentId, changeSetId: body.output.changeSetId, clientId: conn.id ?? conn.client?.id };
  superadmin = await apiSignup(request, 'A11y Operator');
  await sql(`insert into platform_admins(user_id, role) values ($1, 'superadmin') on conflict do nothing`, [superadmin.userId]);
  await request.dispose();
});

test.describe.configure({ timeout: 900_000 });

const resolve = (template: string) => {
  if (!template.includes('[')) return template;
  const r = RESOLVERS[template];
  if (!r) throw new Error(`no id resolver for ${template}: add it to RESOLVERS in a11y.spec.ts`);
  return r(ids);
};

test('the route list covers every navigation entry and dashboard page', () => {
  const routes = staffRouteTemplates();
  // Sanity: the derivation found the shell (nav.ts), the section lists (sections.ts) and the file-system pages.
  for (const r of ['', '/orders', '/inbox', '/menu', '/analytics/sales', '/settings/messaging', '/settings/devices', '/mcp/new', '/floor?tab=qr', '/floor?tab=studio', '/orders?new=1', '/explore']) {
    expect(routes, r).toContain(r);
  }
  expect(routes.length).toBeGreaterThan(50);
  for (const r of routes.filter((x) => x.includes('['))) expect(Object.keys(RESOLVERS), `id resolver for ${r}`).toContain(r);
});

for (const locale of ['en', 'ar'] as const) {
  test(`every staff route has no serious or critical violations (${locale}, desktop)`, async ({ page }) => {
    await signIn(page, tenant.owner, locale);
    const failures: string[] = [];
    for (const template of staffRouteTemplates()) {
      const url = `/dashboard/${tenant.orgId}${resolve(template)}`;
      await page.goto(url);
      await settle(page);
      failures.push(...await scan(page, `${locale} ${template || '/'}`));
    }
    // Full-screen staff routes outside the dashboard shell.
    for (const url of [`/kitchen/${tenant.orgId}`, '/account/security']) {
      await page.goto(url);
      await settle(page);
      failures.push(...await scan(page, `${locale} ${url.replace(tenant.orgId, '[orgId]')}`));
    }
    expect(failures).toEqual([]);
  });

  test(`busiest staff routes on a phone have no serious or critical violations (${locale})`, async ({ browser }) => {
    const context = await browser.newContext({ ...MOBILE, baseURL: WEB_URL, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await signIn(page, tenant.owner, locale);
    const failures: string[] = [];
    for (const template of PHONE_ROUTES) {
      await page.goto(`/dashboard/${tenant.orgId}${template}`);
      await settle(page);
      failures.push(...await scan(page, `${locale} phone ${template || '/'}`));
    }
    await context.close();
    expect(failures).toEqual([]);
  });

  test(`guest, sign-in and public pages have no serious or critical violations (${locale})`, async ({ browser }) => {
    const context = await browser.newContext({ ...MOBILE, baseURL: WEB_URL, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'resuto_locale', value: locale, url: WEB_URL }]);
    const page = await context.newPage();
    const failures: string[] = [];
    for (const url of [`/r/${tenant.slug}`, `/order/${tenant.slug}`, `/m/${tenant.slug}`, tablePath, '/login', '/signup', '/forgot-password', '/', '/pricing']) {
      await page.goto(url);
      await settle(page);
      failures.push(...await scan(page, `${locale} ${url.replace(tenant.slug, '[slug]').replace(/\/t\/[^/]+$/, '/t/[qr]')}`));
    }
    await context.close();
    expect(failures).toEqual([]);
  });
}

test('onboarding (a new account without a restaurant) has no serious or critical violations', async ({ page, request }) => {
  const user = await apiSignup(request, 'New Owner');
  const failures: string[] = [];
  for (const locale of ['en', 'ar'] as const) {
    await signIn(page, user, locale);
    await page.goto('/onboarding');
    await settle(page);
    failures.push(...await scan(page, `${locale} /onboarding`));
  }
  expect(failures).toEqual([]);
});

test('the operator console has no serious or critical violations', async ({ page }) => {
  const failures: string[] = [];
  for (const locale of ['en', 'ar'] as const) {
    await signIn(page, superadmin, locale);
    for (const url of [...pagesUnder(path.join(WEB_APP, 'admin')).map((r) => `/admin${r.replace('[orgId]', tenant.orgId)}`)]) {
      await page.goto(url);
      await settle(page);
      failures.push(...await scan(page, `${locale} ${url.replace(tenant.orgId, '[orgId]')}`));
    }
  }
  expect(failures).toEqual([]);
});

test('plan-locked previews (Free plan) have no serious or critical violations', async ({ page, request }) => {
  const free = await apiCreateTenant(request, { planId: 'free' });
  const failures: string[] = [];
  for (const locale of ['en', 'ar'] as const) {
    await signIn(page, free.owner, locale);
    for (const route of ['', '/explore', '/inbox', '/finance', '/analytics', '/website']) {
      await page.goto(`/dashboard/${free.orgId}${route}`);
      await settle(page);
      failures.push(...await scan(page, `${locale} free ${route || '/'}`));
    }
  }
  expect(failures).toEqual([]);
});
