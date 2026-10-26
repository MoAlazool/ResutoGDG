import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import {
  API_URL, apiAddMember, apiAs, apiCreateTenant, collectApiFailures, collectErrors, expect, navLinkFor, newContext, test, workspaceNav, type Tenant, type User,
} from './fixtures';

// 22-DEVICES: Settings › iPad devices in a real browser against the real API. The owner pairs an iPad from the web
// (English and Arabic): the pairing sheet shows a one-time code with a live countdown; a simulated iPad (Playwright's
// request context, as in pos-ipad.spec.ts) exchanges it at POST /v1/pos/pair for its own rpos_ credential, which never
// reaches the page; the device shows up as active; the owner revokes it with a reason and the credential then gets
// 401 device_revoked. Also: a waiter has no entry and no access; a branch-scoped manager can only pick their branch;
// every Settings page marks exactly its own sidebar entry (Messaging included).
// E2E_DEVICES_SHOTS=<dir> also saves the list, the sheet with its code and the revoked state per language.

test.describe.configure({ mode: 'serial', timeout: 120_000 });

const SHOTS = process.env.E2E_DEVICES_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
}

/** Pairing is limited per client address; each simulated iPad has its own (RFC 2544 test range, as in pos-ipad.spec.ts). */
let ipSeq = 0;
const deviceIp = () => { const i = ++ipSeq + (process.pid % 200) * 256 + 128; return `198.19.${(i >> 8) & 255}.${(i & 255) || 1}`; };

async function pairDevice(api: APIRequestContext, code: string) {
  const res = await api.post(`${API_URL}/v1/pos/pair`, {
    headers: { 'X-Forwarded-For': deviceIp() }, data: { code, platform: 'ipados', appVersion: '0.2.0-e2e', model: 'iPad13,1' },
  });
  const text = await res.text();
  expect(res.status(), text).toBe(201);
  const body = JSON.parse(text);
  expect(body.token).toMatch(/^rpos_[A-Za-z0-9_-]{43}$/);
  return body as { token: string; device: { id: string; name: string; actingRole: string; requireStaff: boolean; status: string } };
}

const session = (api: APIRequestContext, token: string) => api.get(`${API_URL}/v1/pos/session`, { headers: { Authorization: `Bearer ${token}` } });

let api: APIRequestContext;
let tenant: Tenant;
let second: string;
let waiter: User;
let scopedManager: User;

test.beforeAll(async () => {
  api = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(api, { planId: 'pro' });
  second = (await apiAs(api, tenant.owner).post(`/o/${tenant.orgId}/branches`, { name: 'Maadi', nameAr: 'المعادي' })).id;
  waiter = await apiAddMember(api, tenant, 'waiter');
  scopedManager = await apiAddMember(api, tenant, 'manager', [second]);
});
test.afterAll(async () => { await api?.dispose(); });

const base = () => `/dashboard/${tenant.orgId}`;

const COPY = {
  en: {
    title: 'iPad devices', empty: 'No iPads paired yet', pair: 'Pair a new iPad', staff: /Require staff sign-in on the device/, create: 'Create pairing code',
    name: 'Name of the iPad', paired: /is paired and ready to use/, done: 'Done', active: 'Active', revoked: 'Revoked', revokeBtn: 'Revoke',
    reasonLabel: /Reason/, confirm: 'Revoke iPad', revokedNotice: /was revoked/, reasonText: 'Reason: Lost at the counter', sections: 'Settings sections',
    role: { cashier: 'Cashier', kitchen: 'Kitchen team' }, required: 'Required', notRequired: 'Not required', table: 'Paired iPads', reason: 'Lost at the counter',
  },
  ar: {
    title: 'أجهزة iPad', empty: 'لا توجد أجهزة iPad مقترنة بعد', pair: 'إقران جهاز iPad جديد', staff: /طلب تسجيل دخول الموظف على الجهاز/, create: 'إنشاء رمز الإقران',
    name: 'اسم الجهاز', paired: /وهو جاهز للاستخدام/, done: 'تم', active: 'نشط', revoked: 'ملغى', revokeBtn: 'إلغاء الإقران',
    reasonLabel: /السبب/, confirm: 'إلغاء إقران الجهاز', revokedNotice: /توقف عن العمل فورًا/, reasonText: 'السبب: فُقد عند الكاشير', sections: 'أقسام الإعدادات',
    role: { cashier: 'الكاشير', kitchen: 'فريق المطبخ' }, required: 'مطلوب', notRequired: 'غير مطلوب', table: 'أجهزة iPad المقترنة', reason: 'فُقد عند الكاشير',
  },
} as const;

for (const locale of ['en', 'ar'] as const) {
  test(`the owner pairs an iPad from Settings › iPad devices, the device works, and revoking it locks it out (${locale})`, async ({ browser }) => {
    const s = COPY[locale];
    // English pairs a cashier iPad with staff sign-in (the default); Arabic a kitchen iPad without it.
    const role = locale === 'en' ? 'cashier' : 'kitchen';
    const deviceName = locale === 'en' ? 'Counter iPad' : 'جهاز المطبخ';
    const { context, page } = await newContext(browser, { user: tenant.owner, locale });
    const errors = collectErrors(page);
    const failures = collectApiFailures(page);
    const bodies: string[] = [];
    page.on('response', async (r) => {
      if (r.url().startsWith(API_URL)) bodies.push(await r.text().catch(() => ''));
    });
    try {
      await page.goto(`${base()}/settings/devices`);
      await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      // The sidebar's Settings cluster and the page's section list both mark this page.
      await expect(workspaceNav(page).locator('a[aria-current="page"]')).toHaveAttribute('href', `${base()}/settings/devices`);
      await expect(page.getByRole('navigation', { name: s.sections }).getByRole('link', { name: s.title })).toHaveAttribute('aria-current', 'page');
      if (locale === 'en') {
        await expect(page.getByText(s.empty)).toBeVisible();
        await shot(page, `${locale}-1-empty`);
      }

      await page.getByRole('button', { name: s.pair }).first().click();
      const sheet = page.getByRole('dialog', { name: s.pair });
      await expect(sheet).toBeVisible();
      // Contract 0.2.0 recommends a staff session on shared iPads: the switch starts on.
      const staffSwitch = sheet.getByRole('switch', { name: s.staff });
      await expect(staffSwitch).toBeChecked();
      if (locale === 'ar') {
        await sheet.getByText(s.staff).click();
        await expect(staffSwitch).not.toBeChecked();
      }
      await sheet.getByRole('radio', { name: new RegExp(s.role[role]) }).check({ force: true });
      await sheet.getByLabel(s.name).fill(deviceName);
      await page.getByRole('button', { name: s.create }).click();

      const codeEl = page.getByTestId('pairing-code');
      await expect(codeEl).toHaveText(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/, { timeout: 20_000 });
      const code = (await codeEl.textContent())!.trim();
      // A live countdown in Western digits, from the 10-minute default.
      const timer = page.getByTestId('code-countdown');
      await expect(timer).toHaveText(/^(10:00|9:[0-5][0-9])$/);
      const first = await timer.textContent();
      await expect(timer).not.toHaveText(first!, { timeout: 5_000 });
      await expect(page.getByTestId('api-base')).toHaveText(`${API_URL}/v1`);
      await shot(page, `${locale}-2-pairing-code`);

      // The simulated iPad exchanges the code for its own credential.
      const paired = await pairDevice(api, code);
      expect(paired.device).toMatchObject({ name: deviceName, actingRole: role, requireStaff: locale === 'en', status: 'active' });
      expect((await session(api, paired.token)).status()).toBe(200);
      // The sheet notices the pairing on its own (it polls while the code is valid).
      await expect(page.getByRole('dialog').getByText(s.paired)).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: s.done, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const table = page.getByRole('table', { name: s.table });
      const row = table.getByRole('row').filter({ hasText: deviceName });
      await expect(row).toHaveCount(1, { timeout: 20_000 });
      await expect(row).toContainText(s.active);
      await expect(row).toContainText(s.role[role]);
      await expect(row).toContainText(locale === 'en' ? s.required : s.notRequired);
      await shot(page, `${locale}-3-list-active`);

      // Revoke with a reason; the list refreshes and shows it.
      await row.getByRole('button', { name: new RegExp(s.revokeBtn) }).click();
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: s.confirm }) });
      await dialog.getByLabel(s.reasonLabel).fill(s.reason);
      await dialog.getByRole('button', { name: s.confirm }).click();
      await expect(page.getByText(s.revokedNotice)).toBeVisible({ timeout: 20_000 });
      await expect(row).toContainText(s.revoked);
      await expect(row).toContainText(s.reasonText);
      await expect(row.getByRole('button', { name: new RegExp(s.revokeBtn) })).toHaveCount(0);
      await shot(page, `${locale}-4-list-revoked`);

      // The device credential is refused from now on, and it never reached the page.
      const after = await session(api, paired.token);
      expect(after.status()).toBe(401);
      expect((await after.json()).error.code).toBe('device_revoked');
      expect(await page.content()).not.toContain(paired.token);
      expect(bodies.some((b) => b.includes(paired.token))).toBe(false);
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('a waiter has no iPad devices entry and cannot open the page', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: waiter });
  try {
    await page.goto(base());
    await expect(workspaceNav(page)).toBeVisible({ timeout: 30_000 });
    await expect(navLinkFor(page, '/settings/devices')).toHaveCount(0);
    await page.goto(`${base()}/settings/devices`);
    await expect(page.getByText('This screen is not available for your role')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Pair a new iPad' })).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a branch-scoped manager sees the entry, only their branch in the branch select, and only that branch’s iPads', async ({ browser }) => {
  // An iPad of the main branch, paired by the owner: the Maadi manager must not see it.
  const main = await apiAs(api, tenant.owner).post(`/o/${tenant.orgId}/pos/pairings`, { branchId: tenant.branchId, actingRole: 'waiter', name: 'Zamalek floor iPad' });
  await pairDevice(api, main.code);
  const { context, page } = await newContext(browser, { user: scopedManager });
  try {
    await page.goto(base());
    await expect(workspaceNav(page)).toBeVisible({ timeout: 30_000 });
    await expect(navLinkFor(page, '/settings/devices')).toHaveCount(1);
    await page.goto(`${base()}/settings/devices`);
    await expect(page.getByRole('heading', { level: 1, name: 'iPad devices' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('No iPads paired yet')).toBeVisible();
    await expect(page.getByText('Zamalek floor iPad')).toHaveCount(0);
    await page.getByRole('button', { name: 'Pair a new iPad' }).first().click();
    const select = page.getByRole('dialog', { name: 'Pair a new iPad' }).getByRole('combobox', { name: /^Branch/ });
    await expect(select.locator('option')).toHaveText(['Maadi']);
    await expect(select).toHaveValue(second);
  } finally {
    await context.close();
  }
});

test('every Settings page marks exactly its own sidebar entry and section (Messaging and iPad devices included)', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  try {
    for (const [route, label] of [['/settings', 'Restaurant settings'], ['/settings/messaging', 'Messaging'], ['/settings/devices', 'iPad devices'], ['/team', 'Team & roles']] as const) {
      await page.goto(`${base()}${route}`);
      await expect(page.locator('#workspace-main h1').first()).toBeVisible({ timeout: 30_000 });
      const current = workspaceNav(page).locator('a[aria-current="page"]');
      await expect(current, route).toHaveCount(1);
      await expect(current, route).toHaveAttribute('href', `${base()}${route}`);
      await expect(current, route).toHaveText(label);
      const sections = page.getByRole('navigation', { name: 'Settings sections' });
      await expect(sections.locator('a[aria-current="page"]'), route).toHaveText(label);
    }
  } finally {
    await context.close();
  }
});
