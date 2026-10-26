import AxeBuilder from '@axe-core/playwright';
import { API_URL, apiCreateTenant, auth, collectErrors, expect, publishSite, seedMenu, setLocale, signIn, sql, test, unique, WEB_URL, type Tenant } from './fixtures';

// 22-STUDIO: the Optimize workspace (SEO / AEO / GEO) over real data, and the structured data the published pages emit
// checked against the published records (Restaurant, Menu, Offers, FAQ only while visible, the same @ids on both pages).

const SHELL_404 = [/Failed to load resource.*404/];
type Ld = Record<string, any>;

/** Every JSON-LD document of an HTML page, parsed (a script that does not parse fails the test). */
function jsonLdOf(html: string): Ld[] {
  return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
}
/** Every node of a JSON-LD tree (objects with an @type). */
function nodes(v: unknown, out: Ld[] = []): Ld[] {
  if (Array.isArray(v)) v.forEach((x) => nodes(x, out));
  else if (v && typeof v === 'object') { if ((v as Ld)['@type']) out.push(v as Ld); Object.values(v).forEach((x) => nodes(x, out)); }
  return out;
}
/** The required properties of the types the pages emit (lib/structured-data-checks.ts, Restaurant/Menu/FAQ guidance). */
function requiredProblems(docs: Ld[]): string[] {
  const problems: string[] = [];
  for (const d of docs) if (d['@context'] !== 'https://schema.org') problems.push(`@context ${d['@type']}`);
  for (const n of nodes(docs)) {
    const need: Record<string, string[]> = { Restaurant: ['name'], PostalAddress: ['addressCountry'], Menu: ['hasMenuSection'], MenuSection: ['name', 'hasMenuItem'],
      MenuItem: ['name'], FAQPage: ['mainEntity'], Question: ['name', 'acceptedAnswer'], Answer: ['text'], OpeningHoursSpecification: ['dayOfWeek', 'opens', 'closes'] };
    for (const f of need[n['@type']] ?? []) if (n[f] === undefined || n[f] === '' || (Array.isArray(n[f]) && !n[f].length)) problems.push(`${n['@type']}.${f}`);
    if (n['@type'] === 'Offer' && n.price !== undefined && !(/^\d+\.\d{2}$/.test(n.price) && /^[A-Z]{3}$/.test(n.priceCurrency))) problems.push(`Offer price ${n.price} ${n.priceCurrency}`);
  }
  return problems;
}

async function addFaq(request: Parameters<typeof publishSite>[0], t: Tenant) {
  const base = `${API_URL}/v1/o/${t.orgId}/studio`;
  const res = await request.post(`${base}/website/sections`, { headers: auth(t.owner), data: { kind: 'faq', isVisible: true, content: {
    headline: { en: 'Questions and answers', ar: 'أسئلة وأجوبة' },
    items: [
      { title: { en: 'Do you deliver?', ar: 'هل توصلون؟' }, body: { en: 'Yes, across Zamalek.', ar: 'نعم، في الزمالك.' } },
      { title: { en: 'Can I book a table?', ar: 'هل يمكنني حجز طاولة؟' }, body: { en: 'Yes, online.', ar: 'نعم، عبر الإنترنت.' } },
    ] } } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}
async function publish(request: Parameters<typeof publishSite>[0], t: Tenant) {
  const res = await request.post(`${API_URL}/v1/o/${t.orgId}/studio/website/publish`, { headers: auth(t.owner), data: { key: unique('publish') } });
  expect(res.status(), await res.text()).toBe(200);
}

test('the published pages’ JSON-LD matches the published data: Restaurant, Menu → sections → dishes → offers, FAQ only while visible', async ({ request }) => {
  const tenant = await apiCreateTenant(request);
  await seedMenu(tenant);
  await publishSite(request, tenant, { productIds: (await sql(`select id from products where org_id = $1 order by sort_order`, [tenant.orgId])).map((p) => p.id) });
  const faqId = await addFaq(request, tenant);
  await publish(request, tenant);

  const published = await (await request.get(`${API_URL}/v1/public/sites/${tenant.slug}`)).json();
  const menu = await (await request.get(`${API_URL}/v1/public/menu/${tenant.slug}`)).json();
  const branch = published.branches[0];
  const siteUrl = `${WEB_URL}/r/${tenant.slug}`;
  const menuUrl = `${WEB_URL}/m/${tenant.slug}`;

  for (const lang of ['en', 'ar'] as const) {
    const html = await (await request.get(`/r/${tenant.slug}?lang=${lang}`)).text();
    const docs = jsonLdOf(html);
    expect(docs.map((d) => d['@type'])).toEqual(['Restaurant', 'FAQPage']);
    expect(requiredProblems(docs)).toEqual([]);
    const [r, faq] = docs as [Ld, Ld];
    expect(r).toMatchObject({ '@id': `${siteUrl}#restaurant`, url: siteUrl, name: lang === 'ar' ? 'غرفة الزيتون' : 'The Olive Room', telephone: branch.phone,
      currenciesAccepted: 'EGP', menu: menuUrl, hasMenu: menuUrl, address: { '@type': 'PostalAddress', addressLocality: branch.city, addressCountry: 'EG' } });
    expect(r.description).toBe(published.seo.description[lang]);
    expect(r.openingHoursSpecification).toHaveLength(branch.openingHours.length);
    // The dishes the page shows are the restaurant's offers, at the menu's prices.
    const offered = r.makesOffer.filter((o: Ld) => o.itemOffered);
    expect(offered.length).toBe(3);
    for (const o of offered) {
      const p = menu.categories.flatMap((c: Ld) => c.products).find((x: Ld) => x.name === o.itemOffered.name || x.nameAr === o.itemOffered.name);
      expect(p, o.itemOffered.name).toBeTruthy();
      expect(o).toMatchObject({ price: (p.priceMinor / 100).toFixed(2), priceCurrency: 'EGP' });
    }
    // FAQPage = exactly the questions the page shows.
    const questions = faq.mainEntity.map((q: Ld) => q.name);
    expect(questions).toEqual(lang === 'ar' ? ['هل توصلون؟', 'هل يمكنني حجز طاولة؟'] : ['Do you deliver?', 'Can I book a table?']);
    for (const q of questions) expect(html).toContain(`<summary>${q}</summary>`);
    // Nothing invented: no ratings or reviews; Western digits only.
    expect(JSON.stringify(docs)).not.toMatch(/aggregateRating|"review"|[٠-٩]/);
    // Language alternates and canonical.
    expect(html).toMatch(new RegExp(`<link rel="canonical" href="${siteUrl}"`));
    for (const l of ['en', 'ar', 'x-default']) expect(html).toMatch(new RegExp(`<link rel="alternate" hrefLang="${l}"`, 'i'));
  }

  // The menu page: the whole public menu, under the same Restaurant @id and NAP as the website.
  const mHtml = await (await request.get(`/m/${tenant.slug}?lang=en`)).text();
  const mDocs = jsonLdOf(mHtml);
  expect(mDocs.map((d) => d['@type'])).toEqual(['Menu', 'Restaurant']);
  expect(requiredProblems(mDocs)).toEqual([]);
  const [m, mr] = mDocs as [Ld, Ld];
  expect(m['@id']).toBe(`${menuUrl}#menu`);
  expect(mr).toMatchObject({ '@id': `${siteUrl}#restaurant`, telephone: branch.phone, hasMenu: { '@id': `${menuUrl}#menu` } });
  const items = m.hasMenuSection.flatMap((s: Ld) => s.hasMenuItem);
  const products = menu.categories.flatMap((c: Ld) => c.products);
  expect(items.length).toBe(products.length);
  for (const p of products) {
    expect(items.find((i: Ld) => i.name === p.name).offers).toMatchObject({ price: (p.priceMinor / 100).toFixed(2), priceCurrency: 'EGP',
      availability: p.available ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut' });
  }
  expect(mHtml).toMatch(new RegExp(`<link rel="canonical" href="${menuUrl}"`));

  // Sitemap and robots: the website and its menu page, both languages, and crawlers may read them.
  const sitemap = await (await request.get(`/r/${tenant.slug}/sitemap.xml`)).text();
  for (const u of [siteUrl, menuUrl]) {
    expect(sitemap).toContain(`<loc>${u}</loc>`);
    expect(sitemap).toContain(`hreflang="ar" href="${u}?lang=ar"`);
  }
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toMatch(/Allow: \/r\//);
  expect(robots).toMatch(/Allow: \/m\//);

  // Hidden FAQ: no FAQPage (the markup only follows what guests can see).
  await request.patch(`${API_URL}/v1/o/${tenant.orgId}/studio/website/sections/${faqId}`, { headers: auth(tenant.owner), data: { isVisible: false } });
  await publish(request, tenant);
  await request.post(`/r/${tenant.slug}/revalidate`, { headers: auth(tenant.owner), data: { orgId: tenant.orgId } });
  await expect.poll(async () => jsonLdOf(await (await request.get(`/r/${tenant.slug}`)).text()).map((d) => d['@type']), { timeout: 40_000 }).toEqual(['Restaurant']);
});

test('Optimize: SEO, AEO and GEO checks over real data, bilingual search settings, JSON-LD preview, AI suggestion reviewed on the canvas', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  await publishSite(request, tenant, { productIds: await seedMenu(tenant) });
  await signIn(page, tenant.owner);
  const errors = collectErrors(page, SHELL_404);
  await page.goto(`/dashboard/${tenant.orgId}/website?tab=seo`);
  const opt = page.locator('.ws-opt');
  await expect(opt.getByRole('heading', { name: 'Optimize for search, answers and AI' })).toBeVisible();
  await expect(page.frameLocator('iframe.ws-frame').locator('.restaurant-editorial h1')).toHaveText('Good food. Long conversations.');
  await expect(opt.locator('.ws-opt-summary')).toHaveText(/^\d+ passed · \d+ failed · \d+ to improve$/);
  const check = (id: string, lang?: 'EN' | 'AR') => {
    const rows = opt.locator(`li[data-check="${id}"]`);
    return lang ? rows.filter({ has: page.locator('.ws-opt-lang', { hasText: lang }) }) : rows;
  };
  await expect(check('seo.indexable')).toHaveAttribute('data-status', 'pass');
  await expect(check('seo.hreflang')).toHaveAttribute('data-status', 'pass');
  // The rendered draft: one h1 in each language, real headings.
  await expect(check('seo.h1', 'EN')).toHaveAttribute('data-status', 'pass');
  await expect(check('seo.h1', 'AR')).toHaveAttribute('data-status', 'pass');
  // The fixture's description is short (49 characters): improve it, in both languages side by side.
  await expect(check('seo.description', 'EN')).toHaveAttribute('data-status', 'warn');
  const description = opt.locator('fieldset.ws-loc').filter({ hasText: 'Description' });
  await description.getByLabel('English').fill('Seasonal Mediterranean plates and warm hospitality in Zamalek, Cairo. Book a table or order online.');
  await description.getByLabel('Arabic').fill('أطباق متوسطية موسمية وضيافة دافئة في الزمالك بالقاهرة. احجز طاولة أو اطلب عبر الإنترنت من موقعنا.');
  await expect(opt.locator('.ws-snippet').first()).toContainText('Seasonal Mediterranean plates');
  await opt.getByRole('button', { name: 'Apply' }).click();
  await expect(check('seo.description', 'EN')).toHaveAttribute('data-status', 'pass');
  await expect(check('seo.description', 'AR')).toHaveAttribute('data-status', 'pass');
  await expect(check('seo.unpublished')).toHaveAttribute('data-status', 'warn');
  const [w] = await sql(`select seo, published_revision from websites where org_id = $1`, [tenant.orgId]);
  expect(w.seo.description.en).toMatch(/^Seasonal Mediterranean plates/);
  expect(w.published_revision).toBe(1);

  // AEO: the JSON-LD exactly as the pages emit it, with its checks.
  await opt.getByRole('tab', { name: /Answers \(AEO\)/ }).click();
  const pre = opt.locator('.ws-ld-pre');
  await expect(pre).toContainText('"@type": "Restaurant"');
  await expect(pre).toContainText(`"@id": "${WEB_URL}/r/${tenant.slug}#restaurant"`);
  await expect(opt.getByText(/^\d+ of \d+ required properties$/)).toBeVisible();
  await opt.getByRole('radio', { name: 'Menu page' }).click();
  await expect(pre).toContainText('"@type": "Menu"');
  await expect(pre).toContainText('"name": "Burrata & heirloom tomato"');
  await expect(pre).toContainText('"price": "145.00"');
  await opt.getByRole('radio', { name: 'ع' }).click();
  await expect(pre).toContainText('"name": "بوراتا مع الطماطم"');
  await expect(opt.locator('.ws-facts tbody tr')).toHaveCount(1);
  await expect(check('aeo.hours')).toHaveAttribute('data-status', 'pass');
  await expect(check('aeo.faq')).toHaveAttribute('data-status', 'warn');

  // GEO: the entity chain, then an AI suggestion that becomes a change set to review (nothing applied or published).
  await opt.getByRole('tab', { name: /AI engines \(GEO\)/ }).click();
  await expect(opt.locator('.ws-chain li').filter({ hasText: 'Dishes' }).locator('strong')).toHaveText('3');
  await opt.locator('.ws-suggest-card').filter({ hasText: 'Questions and answers' }).getByRole('button', { name: 'Draft for review' }).click();
  const inspector = page.locator('.ws-inspector');
  await expect(inspector.getByRole('radio', { name: 'AI' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.frameLocator('iframe.ws-frame').locator('.site-block[data-diff="added"]')).toBeVisible();
  const [cs] = await sql(`select status, origin from change_sets where org_id = $1 order by created_at desc limit 1`, [tenant.orgId]);
  expect(cs).toMatchObject({ status: 'pending_approval', origin: 'studio_ai' });
  expect((await sql(`select count(*)::int as n from website_sections s join websites w on w.id = s.website_id where w.org_id = $1 and s.kind = 'faq'`, [tenant.orgId]))[0].n).toBe(0);
  expect((await sql(`select published_revision from websites where org_id = $1`, [tenant.orgId]))[0].published_revision).toBe(1);
  expect(errors).toEqual([]);
});

test('the Optimize workspace has no serious accessibility violations, in English and Arabic', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  await publishSite(request, tenant, { productIds: await seedMenu(tenant) });
  await signIn(page, tenant.owner);
  for (const locale of ['en', 'ar'] as const) {
    await setLocale(page, locale);
    for (const tab of ['seo', 'aeo', 'geo']) {
      await page.goto(`/dashboard/${tenant.orgId}/website?tab=${tab}`);
      await expect(page.locator('.ws-opt-summary')).toBeVisible();
      await expect(page.locator('.ws-opt [role=tab][aria-selected=true]')).toContainText(tab.toUpperCase());
      await expect(page.frameLocator('iframe.ws-frame').locator('.site-root')).toBeVisible();
      const r = await new AxeBuilder({ page }).exclude('.ws-stage').analyze();
      expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${locale}/${tab} ${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    }
  }
});
