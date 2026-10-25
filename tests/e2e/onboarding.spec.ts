import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Download, Page } from '@playwright/test';
import { collectErrors, expect, expectNoHorizontalOverflow, newContext, ROOT, sql, test, unique } from './fixtures';

// 21-ONB (plan §6.2, §8 acceptance): a new owner goes from signup to a published digital menu and a downloaded menu
// QR in at most 10 steps, on desktop and on a 390 px phone, in English and in Arabic (no sideways scrolling). The
// wizard saves progress after every step (a reload resumes), creates the restaurant on the Free plan, and offers no
// ordering QR. Every "step" below is one screen the owner finishes with its primary button.

const MAX_STEPS = 10;
const CSV = 'name,name_ar,category,price,description\r\nFlat white,فلات وايت,Coffee,65,Double shot\r\nCroissant,كرواسون,Bakery,45.5,\r\nLemon tart,,Bakery,70,Tangy\r\n';
const LOGO = path.join(ROOT, 'apps/web/public/brand/resuto-icon.png');
const XLSX = path.join(ROOT, 'apps/web/lib/onboarding/__fixtures__/menu.xlsx');

const L = {
  en: {
    fullName: 'Full name', email: 'Email', password: /^Password/, signup: 'Create account →',
    restaurant: 'Tell us about your restaurant', name: 'Restaurant name', nameAr: 'Arabic name (optional)', counter: /At the counter/,
    address: 'Choose your web address', addressField: 'Web address', available: 'Available', create: 'Create my restaurant',
    brand: 'Add your logo and pick a look', skip: 'Skip for now', menu: 'Add your menu', details: 'Photos, prices and availability',
    social: 'Where can guests find you?', publish: 'Preview and publish', publishBtn: 'Publish my menu', qr: 'Your menu QR code',
    next: 'Continue', finished: 'All set: your menu is published.',
  },
  ar: {
    fullName: 'الاسم الكامل', email: 'البريد الإلكتروني', password: /^كلمة المرور/, signup: 'إنشاء الحساب ←',
    restaurant: 'عرّفنا بمطعمك', name: 'اسم المطعم', nameAr: 'الاسم بالعربية (اختياري)', counter: /عند الكاونتر/,
    address: 'اختر عنوان موقعك', addressField: 'عنوان الموقع', available: 'متاح', create: 'أنشئ مطعمي',
    brand: 'أضف شعارك واختر مظهرًا', skip: 'تخطَّ الآن', menu: 'أضف قائمتك', details: 'الصور والأسعار والتوفر',
    social: 'أين يجدك الضيوف؟', publish: 'عاين وانشر', publishBtn: 'انشر قائمتي', qr: 'رمز QR لقائمتك',
    next: 'متابعة', finished: 'كل شيء جاهز: تم نشر قائمتك.',
  },
} as const;
type Copy = (typeof L)[keyof typeof L];

/** One finished screen: its primary button, then the next screen's heading. */
async function step(page: Page, counter: { n: number }, click: () => Promise<void>, nextHeading: string) {
  await click();
  counter.n += 1;
  await expect(page.getByRole('heading', { level: 1, name: nextHeading })).toBeVisible();
}
const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const savedProgress = async (email: string) => (await sql(
  `select p.step, p.completed, p.org_id, p.completed_at from onboarding_progress p join auth.users u on u.id = p.user_id where u.email = $1`, [email]))[0];

async function signupAndStart(page: Page, c: Copy, counter: { n: number }, email: string, phone = false) {
  await page.getByLabel(c.fullName).fill('Mona Adel');
  await page.getByRole('textbox', { name: c.email, exact: true }).fill(email);
  await page.getByRole('textbox', { name: c.password }).fill('correct-horse-battery');
  await step(page, counter, () => page.getByRole('button', { name: c.signup }).click(), c.restaurant);
  await expect(page).toHaveURL(/\/onboarding$/);
  if (phone) await expectNoHorizontalOverflow(page);
}

async function restaurantAndAddress(page: Page, c: Copy, counter: { n: number }, name: string, slug: string, phone = false) {
  await page.getByLabel(c.name, { exact: true }).fill(name);
  await page.getByLabel(c.nameAr).fill('غرفة الزيتون');
  await page.getByRole('radio', { name: c.counter }).check();
  await step(page, counter, () => page.getByRole('button', { name: c.next }).click(), c.address);
  const field = page.getByRole('textbox', { name: c.addressField, exact: true });
  await field.fill(slug);
  await expect(page.locator('#onb-slug-state')).toHaveText(c.available);
  if (phone) await expectNoHorizontalOverflow(page);
  await step(page, counter, () => page.getByRole('button', { name: c.create }).click(), c.brand);
}

async function downloaded(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [dl]: [Download, void] = await Promise.all([page.waitForEvent('download'), click()]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), bytes: readFileSync(file!) };
}

async function assertFreeAndPublished(email: string, slug: string) {
  const p = await savedProgress(email);
  expect(p.completed_at).not.toBeNull();
  expect(p.completed).toEqual(['account', 'restaurant', 'address', 'brand', 'menu', 'details', 'social', 'publish', 'qr']);
  const [org] = await sql(`select o.id, s.plan_id, s.status, w.status as site from organizations o join subscriptions s on s.org_id = o.id
    join websites w on w.org_id = o.id where o.slug = $1`, [slug]);
  expect(org).toMatchObject({ plan_id: 'free', status: 'active', site: 'published' });
  expect(p.org_id).toBe(org.id);
  // The wizard never creates an ordering QR: no table and no venue QR exists for the restaurant.
  expect((await sql(`select count(*)::int as n from dining_tables where org_id = $1`, [org.id]))[0].n).toBe(0);
  return org.id as string;
}

test('desktop, English: signup → spreadsheet menu → published → menu QR and A4 poster, resumable, ≤ 10 steps', async ({ page }) => {
  const c = L.en;
  const counter = { n: 0 };
  const errors = collectErrors(page);
  const email = `${unique('wizard')}@example.test`;
  const name = `Olive ${unique('r').slice(-6)}`;
  const slug = unique('olive').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  await page.goto('/');
  await page.locator('.lp-cta a[href="/signup"]').click();
  await expect(page).toHaveURL(/\/signup$/);
  await signupAndStart(page, c, counter, email);
  // Free by default: nothing about plans, payments or ordering on the first screen.
  await expect(page.getByText('Free plan: a digital menu and menu QR codes. No card needed.')).toBeVisible();
  await restaurantAndAddress(page, c, counter, name, slug);

  // Logo and theme preset (studio_basic on Free).
  await page.locator('.onb-logo input[type="file"]').setInputFiles(LOGO);
  await expect(page.getByRole('img', { name: `${name} logo` })).toBeVisible();
  await page.getByRole('radio', { name: /Café/ }).check({ force: true });
  await expect(page.locator('.onb-preset.is-on')).toContainText('Café');
  await step(page, counter, () => page.getByRole('button', { name: c.next }).click(), c.menu);

  // Saved after every step: a reload resumes on the menu step.
  expect(await savedProgress(email)).toMatchObject({ step: 'menu', completed: ['account', 'restaurant', 'address', 'brand'] });
  await page.reload();
  await expect(heading(page, c.menu)).toBeVisible();

  // Spreadsheet: read in the browser, previewed by the API, imported.
  await page.getByRole('radio', { name: 'Spreadsheet (CSV or Excel)' }).click();
  await page.locator('.onb-sheet input[type="file"]').setInputFiles({ name: 'menu.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
  await expect(page.getByRole('heading', { name: 'Check before importing' })).toBeVisible();
  await expect(page.getByText('3 rows found')).toBeVisible();
  await page.getByRole('button', { name: 'Import the dishes' }).click();
  await expect(page.getByText('Imported: 3 new, 0 updated.')).toBeVisible();
  await expect(page.getByText('3 dishes on your menu')).toBeVisible();
  await step(page, counter, () => page.getByRole('button', { name: c.next }).click(), c.details);

  // Photos, prices, availability: change a price and switch a dish off for today.
  const tart = page.locator('.onb-dish').filter({ hasText: 'Lemon tart' });
  await tart.getByLabel(/^Price/).fill('72.5');
  await tart.getByRole('button', { name: 'Save' }).click();
  await expect(tart.getByText('Saved')).toBeVisible();
  await tart.getByRole('switch', { name: 'Available today' }).uncheck({ force: true });
  await expect(tart.getByRole('switch', { name: 'Available today' })).not.toBeChecked();
  await step(page, counter, () => page.getByRole('button', { name: c.next }).click(), c.social);

  await page.getByLabel('Instagram').fill('http://instagram.com/olive');
  await expect(page.getByText('Enter a full https:// link to Instagram.')).toBeVisible();
  await page.getByLabel('Instagram').fill('https://instagram.com/olive_e2e');
  await step(page, counter, () => page.getByRole('button', { name: c.next }).click(), c.publish);

  // Preview frames (phone and desktop), then publish.
  await expect(page.locator('.onb-device.is-phone')).toContainText('Flat white');
  await page.getByRole('radio', { name: 'Desktop' }).click();
  await expect(page.locator('.onb-device.is-desktop')).toContainText('Croissant');
  await step(page, counter, () => page.getByRole('button', { name: c.publishBtn }).click(), c.qr);

  const png = await downloaded(page, () => page.getByRole('button', { name: 'Download PNG' }).click());
  expect(png.name).toBe(`${slug}-menu-qr.png`);
  expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');
  await expect(page.getByText(c.finished)).toBeVisible();
  const pdf = await downloaded(page, () => page.getByRole('button', { name: 'A4 poster' }).click());
  expect(pdf.name).toBe(`${slug}-menu-qr-a4.pdf`);
  expect(pdf.bytes.subarray(0, 8).toString()).toBe('%PDF-1.4');
  expect(pdf.bytes.toString('latin1')).toContain('/MediaBox [0 0 595.276 841.89]');
  expect(counter.n).toBeLessThanOrEqual(MAX_STEPS);
  await assertFreeAndPublished(email, slug);
  // Paid areas only as "Explore Resuto" previews, never as controls here.
  await expect(page.getByRole('link', { name: 'Explore what else Resuto can do' })).toHaveAttribute('href', /\/explore$/);

  // The published menu (what the QR opens) and the site, with the social link as an icon.
  await page.goto(`/m/${slug}`);
  await expect(page.getByText('Flat white')).toBeVisible();
  await expect(page.locator('a[data-network="instagram"]')).toHaveAttribute('href', 'https://instagram.com/olive_e2e');
  await page.goto(`/r/${slug}`);
  await expect(page.locator('.site-social a[data-network="instagram"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('phone 390 px, English: typed-in menu, PNG and SVG QR, ≤ 10 steps', async ({ browser }) => {
  const c = L.en;
  const counter = { n: 0 };
  const { context, page } = await newContext(browser, { mobile: true });
  const email = `${unique('wizard-phone')}@example.test`;
  const slug = unique('koshary').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  await page.goto('/signup?next=%2Fonboarding');
  await signupAndStart(page, c, counter, email, true);
  await restaurantAndAddress(page, c, counter, 'Koshary Corner', slug, true);
  await expectNoHorizontalOverflow(page);
  await step(page, counter, () => page.getByRole('button', { name: c.skip }).click(), c.menu);

  // Typed in: a new category and two dishes.
  const manual = page.locator('.onb-manual');
  await expect(manual.getByLabel('New category', { exact: true })).toHaveValue('Mains');
  await manual.getByLabel('Dish name', { exact: true }).fill('Koshary');
  await manual.getByLabel(/^Price/).fill('95');
  await manual.getByRole('button', { name: 'Add dish' }).click();
  await expect(page.getByText('1 dish on your menu')).toBeVisible();
  await manual.getByLabel('Dish name', { exact: true }).fill('Rice pudding');
  await manual.getByLabel(/^Price/).fill('٣٥');
  await manual.getByLabel(/^Price/).press('Enter');
  await expect(page.getByText('2 dishes on your menu')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  for (const next of [c.details, c.social, c.publish]) {
    await step(page, counter, () => page.getByRole('button', { name: c.next }).click(), next);
    await expectNoHorizontalOverflow(page);
  }
  await expect(page.locator('.onb-device.is-phone')).toContainText('Rice pudding');
  await step(page, counter, () => page.getByRole('button', { name: c.publishBtn }).click(), c.qr);
  await expectNoHorizontalOverflow(page);
  const svg = await downloaded(page, () => page.getByRole('button', { name: 'Download SVG' }).click());
  expect(svg.name).toBe(`${slug}-menu-qr.svg`);
  expect(svg.bytes.toString()).toMatch(/^<svg/);
  await expect(page.getByText(c.finished)).toBeVisible();
  expect(counter.n).toBeLessThanOrEqual(MAX_STEPS);
  await assertFreeAndPublished(email, slug);
  // Rice pudding was priced with Arabic-Indic digits and stored as 35.00.
  const [pudding] = await sql(`select price_minor from products p join organizations o on o.id = p.org_id where o.slug = $1 and p.name = 'Rice pudding'`, [slug]);
  expect(Number(pudding.price_minor)).toBe(3500);
  await context.close();
});

test('phone 390 px, Arabic: Excel menu, table-tent poster, RTL with no sideways scrolling, ≤ 10 steps', async ({ browser }) => {
  const c = L.ar;
  const counter = { n: 0 };
  const { context, page } = await newContext(browser, { mobile: true, locale: 'ar' });
  const errors = collectErrors(page);
  const email = `${unique('wizard-ar')}@example.test`;
  const slug = unique('zaytoun').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  await page.goto('/signup?next=%2Fonboarding');
  await signupAndStart(page, c, counter, email, true);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await restaurantAndAddress(page, c, counter, 'Zaytoun', slug, true);
  await step(page, counter, () => page.getByRole('button', { name: c.next }).click(), c.menu);
  await expectNoHorizontalOverflow(page);

  await page.getByRole('radio', { name: 'جدول بيانات (CSV أو Excel)' }).click();
  await page.locator('.onb-sheet input[type="file"]').setInputFiles(XLSX);
  await expect(page.getByRole('heading', { name: 'راجع قبل الاستيراد' })).toBeVisible();
  await page.getByRole('button', { name: 'استورد الأطباق' }).click();
  await expect(page.getByText('تم الاستيراد: 3 جديد، 0 محدَّث.')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  for (const next of [c.details, c.social, c.publish]) {
    await step(page, counter, () => page.getByRole('button', { name: c.next }).click(), next);
    await expectNoHorizontalOverflow(page);
  }
  await expect(page.locator('.onb-device')).toContainText('فلات وايت');
  await step(page, counter, () => page.getByRole('button', { name: c.publishBtn }).click(), c.qr);
  await expectNoHorizontalOverflow(page);
  const tent = await downloaded(page, () => page.getByRole('button', { name: 'لافتة طاولة (A4، تُطوى من المنتصف)' }).click());
  expect(tent.name).toBe(`${slug}-menu-qr-table-tent.pdf`);
  expect(tent.bytes.subarray(0, 8).toString()).toBe('%PDF-1.4');
  await expect(page.getByText(c.finished)).toBeVisible();
  expect(counter.n).toBeLessThanOrEqual(MAX_STEPS);
  // Western digits only (0-9), even in Arabic.
  expect(await page.locator('main').innerText()).not.toMatch(/[٠-٩۰-۹]/);
  await assertFreeAndPublished(email, slug);
  await page.goto(`/m/${slug}`);
  await expect(page.getByText('فلات وايت')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
  await context.close();
});
