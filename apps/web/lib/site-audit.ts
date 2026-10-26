// The Studio "Optimize" checks (22-STUDIO): search (SEO), answer engines (AEO) and generative engines (GEO) for a
// restaurant website, computed from real data only — the draft as guests will get it (the staff preview), the published
// site, the public menu page, the rendered canvas (headings, images, links) and the site's robots.txt. Every check
// says pass, fail or warn with the facts behind it, and why it matters; "info" items explain without counting. There is
// no score: the workspace shows how many checks pass and fail. Nothing here promises rankings, answers or citations.
// Pure; unit-tested in lib/site-audit.test.ts.
import type { PublicMenu, PublicSite } from '@resuto/contracts';
import { menuPageJsonLd, siteJsonLd, siteUrls, visibleFaq } from '@/app/r/[slug]/_components/structured-data';
import { loc, openingHours } from '@/app/r/[slug]/_components/site-utils';
import { jsonLdReport, type JsonLdReport } from './structured-data-checks';

export type AuditArea = 'seo' | 'aeo' | 'geo';
export type AuditStatus = 'pass' | 'fail' | 'warn' | 'info';
export type Locale = 'en' | 'ar';

/** What the workspace offers to fix a check: edit a search field, open a section, add one, draft with AI, open a page. */
export type AuditFix =
  | { kind: 'field'; field: 'title' | 'description' | 'ogImage' }
  | { kind: 'section'; id: string }
  | { kind: 'addSection'; section: 'faq' | 'about' | 'menu_full' }
  | { kind: 'ai'; request: 'faq' | 'about' }
  | { kind: 'link'; href: string; external?: boolean }
  | { kind: 'publish' }
  | { kind: 'media' };

export interface AuditCheck {
  id: string;
  area: AuditArea;
  status: AuditStatus;
  locale?: Locale;
  /** Facts for the message ({name} placeholders in the copy). */
  vars?: Record<string, string | number>;
  /** Details listed under the message (e.g. the missing properties, the headings out of order). */
  details?: string[];
  fix?: AuditFix;
}

export interface Heading { level: number; text: string }
export interface RenderedPage {
  headings: Heading[];
  /** Content images: the src and the alt attribute (null when the attribute is missing; "" marks a decorative image). */
  images: Array<{ src: string; alt: string | null; decorative: boolean }>;
  /** Links on the page that stay on the restaurant's site (menu, ordering, booking, storefronts). */
  internalLinks: string[];
}

export interface AuditInput {
  /** The draft as guests will see it once published (staff preview payload). */
  draft: PublicSite;
  /** The published site, or null when it has never been published. */
  published: PublicSite | null;
  website: { publishedRevision: number; hasUnpublishedChanges: boolean };
  /** The canonical page address (https://custom-domain/ or <app>/r/<slug>). */
  siteUrl: string;
  /** The public menu page's data, or null when it could not be read. */
  menu: PublicMenu | null;
  /** The rendered draft per language (from the canvas), when available. */
  rendered?: Partial<Record<Locale, RenderedPage>>;
  /** robots.txt as served for the site's host, or null when it could not be read. */
  robotsTxt?: string | null;
  /** Media used on the site with their alt text in both languages (the media library). */
  media?: Array<{ id: string; url: string; alt: string | null; altAr: string | null; inUse: boolean }>;
}

const LOCALES: Locale[] = ['en', 'ar'];
const TITLE = { min: 15, max: 60 };
const DESCRIPTION = { min: 70, max: 160 };
const text = (v: { en?: string; ar?: string } | undefined, l: Locale) => (v?.[l] ?? '').trim();

/** Whether robots.txt lets every crawler ("*") fetch `path` (longest matching Allow/Disallow wins, as in RFC 9309). */
export function robotsAllows(robots: string, path: string): boolean {
  let inStar = false;
  let best: { len: number; allow: boolean } | null = null;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [k, v] = [m[1]!.toLowerCase(), m[2]!.trim()];
    if (k === 'user-agent') { inStar = v === '*'; continue; }
    if (!inStar || (k !== 'allow' && k !== 'disallow') || !v) continue;
    const pattern = new RegExp(`^${v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
    if (pattern.test(path) && (!best || v.length >= best.len)) best = { len: v.length, allow: k === 'allow' };
  }
  return best ? best.allow : true;
}

/** Heading outline problems: no h1 or more than one, a skipped level (h2 → h4), an empty heading. */
export function outlineProblems(headings: Heading[]): { h1: number; skipped: string[]; empty: number } {
  const h1 = headings.filter((h) => h.level === 1).length;
  const skipped: string[] = [];
  let prev = 0;
  for (const h of headings) {
    if (prev && h.level > prev + 1) skipped.push(`h${prev} → h${h.level} “${h.text.slice(0, 60)}”`);
    prev = h.level;
  }
  return { h1, skipped, empty: headings.filter((h) => !h.text.trim()).length };
}

/** Clock times written in a text ("12:00", "11 pm", "٩ مساءً" after digit folding) as HH:MM, 24-hour. */
export function timesIn(s: string): string[] {
  const out = new Set<string>();
  const folded = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));
  for (const m of folded.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(am|pm|a\.m\.|p\.m\.|ص|م|صباحًا|صباحا|مساءً|مساء)?/gi)) {
    out.add(to24(Number(m[1]), Number(m[2]), m[3]));
  }
  for (const m of folded.matchAll(/\b(1[0-2]|0?[1-9])\s*(am|pm|a\.m\.|p\.m\.)/gi)) out.add(to24(Number(m[1]), 0, m[2]));
  return [...out];
}
function to24(h: number, min: number, suffix?: string) {
  const s = (suffix ?? '').toLowerCase();
  const pm = /^(pm|p\.m\.|م|مساءً|مساء)$/.test(s);
  const am = /^(am|a\.m\.|ص|صباحًا|صباحا)$/.test(s);
  const hh = pm && h < 12 ? h + 12 : am && h === 12 ? 0 : h;
  return `${String(hh % 24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
/** Phone numbers written in a text (7+ digits with optional +, spaces or dashes), digits only. */
export function phonesIn(s: string): string[] {
  return [...s.matchAll(/\+?\d[\d\s-]{6,}\d/g)].map((m) => m[0].replace(/[^\d]/g, '')).filter((d) => d.length >= 7);
}
const digits = (s: string | null) => (s ?? '').replace(/[^\d]/g, '');

/** Every check, in display order per area. */
export function auditSite(input: AuditInput): AuditCheck[] {
  const { draft, published, website, siteUrl, menu } = input;
  const out: AuditCheck[] = [];
  const add = (c: AuditCheck) => out.push(c);
  const urls = siteUrls(draft, siteUrl);
  const name = { en: draft.org.name, ar: draft.org.nameAr ?? '' };
  const seo = draft.seo;

  // ---------------------------------------------------------------- SEO
  for (const l of LOCALES) {
    const t = text(seo.title, l);
    add({ id: 'seo.title', area: 'seo', locale: l, fix: { kind: 'field', field: 'title' }, vars: { length: t.length, min: TITLE.min, max: TITLE.max },
      status: !t ? 'fail' : t.length > TITLE.max || t.length < TITLE.min ? 'warn' : 'pass' });
    const d = text(seo.description, l);
    add({ id: 'seo.description', area: 'seo', locale: l, fix: { kind: 'field', field: 'description' }, vars: { length: d.length, min: DESCRIPTION.min, max: DESCRIPTION.max },
      status: !d ? 'fail' : d.length > DESCRIPTION.max || d.length < DESCRIPTION.min ? 'warn' : 'pass' });
  }
  const sameTitle = !!text(seo.title, 'en') && text(seo.title, 'en') === text(seo.title, 'ar');
  const sameDescription = !!text(seo.description, 'en') && text(seo.description, 'en') === text(seo.description, 'ar');
  add({ id: 'seo.duplicateLocale', area: 'seo', status: sameTitle || sameDescription ? 'warn' : 'pass', fix: { kind: 'field', field: 'title' },
    details: [...(sameTitle ? ['title'] : []), ...(sameDescription ? ['description'] : [])] });
  const headlines = draft.sections.map((s) => loc(s.content.headline, 'en').trim().toLowerCase()).filter(Boolean);
  const dupHeadlines = [...new Set(headlines.filter((h, i) => headlines.indexOf(h) !== i))];
  add({ id: 'seo.duplicateHeadlines', area: 'seo', status: dupHeadlines.length ? 'warn' : 'pass', details: dupHeadlines });
  add({ id: 'seo.canonical', area: 'seo', status: 'pass', vars: { url: siteUrl, domain: draft.canonicalHost ? 'custom' : 'app' } });
  add({ id: 'seo.hreflang', area: 'seo', status: 'pass', details: [`en: ${siteUrl}?lang=en`, `ar: ${siteUrl}?lang=ar`, `x-default: ${siteUrl}`] });
  add({ id: 'seo.indexable', area: 'seo', status: website.publishedRevision > 0 ? 'pass' : 'fail', fix: website.publishedRevision > 0 ? undefined : { kind: 'publish' } });
  add({ id: 'seo.unpublished', area: 'seo', status: website.hasUnpublishedChanges ? 'warn' : 'pass', fix: website.hasUnpublishedChanges ? { kind: 'publish' } : undefined });
  const sitePath = new URL(siteUrl).pathname;
  const menuPath = new URL(urls.menu).pathname;
  if (input.robotsTxt === undefined || input.robotsTxt === null) add({ id: 'seo.robots', area: 'seo', status: 'info', vars: { path: sitePath } });
  else {
    const blocked = [sitePath, menuPath].filter((p) => !robotsAllows(input.robotsTxt!, p));
    add({ id: 'seo.robots', area: 'seo', status: blocked.length ? 'fail' : 'pass', vars: { path: sitePath }, details: blocked });
  }
  add({ id: 'seo.sitemap', area: 'seo', status: website.publishedRevision > 0 ? 'pass' : 'warn',
    vars: { url: `${new URL(siteUrl).origin}${draft.canonicalHost ? '' : `/r/${draft.slug}`}/sitemap.xml` },
    fix: { kind: 'link', href: `/r/${draft.slug}/sitemap.xml`, external: true } });
  add({ id: 'seo.shareImage', area: 'seo', status: seo.ogImageUrl ? 'pass' : 'warn', fix: { kind: 'field', field: 'ogImage' } });
  const photos = !!draft.theme.heroUrl || draft.sections.some((s) => !!s.content.media || (s.content.gallery ?? []).length > 0);
  add({ id: 'seo.photos', area: 'seo', status: photos ? 'pass' : 'warn' });
  for (const l of LOCALES) {
    const page = input.rendered?.[l];
    if (!page) continue;
    const o = outlineProblems(page.headings);
    add({ id: 'seo.h1', area: 'seo', locale: l, status: o.h1 === 1 ? 'pass' : 'fail', vars: { count: o.h1 } });
    add({ id: 'seo.headingOrder', area: 'seo', locale: l, status: o.skipped.length || o.empty ? 'warn' : 'pass', details: o.skipped, vars: { empty: o.empty } });
    const content = page.images.filter((i) => !i.decorative);
    const missing = content.filter((i) => !i.alt?.trim());
    add({ id: 'seo.imageAlt', area: 'seo', locale: l, status: missing.length ? 'fail' : 'pass', vars: { missing: missing.length, total: content.length },
      fix: missing.length ? { kind: 'media' } : undefined });
    add({ id: 'seo.internalLinks', area: 'seo', locale: l, status: page.internalLinks.length ? 'pass' : 'warn', vars: { count: new Set(page.internalLinks).size } });
  }
  const used = (input.media ?? []).filter((m) => m.inUse);
  if (input.media) {
    const noAr = used.filter((m) => m.alt?.trim() && !m.altAr?.trim()).length;
    const noAlt = used.filter((m) => !m.alt?.trim() && !m.altAr?.trim()).length;
    add({ id: 'seo.mediaAlt', area: 'seo', status: noAlt ? 'fail' : noAr ? 'warn' : 'pass', vars: { missing: noAlt, missingAr: noAr, total: used.length }, fix: { kind: 'media' } });
  }
  add({ id: 'seo.webVitals', area: 'seo', status: 'info', vars: { url: siteUrl },
    fix: /^https:\/\//.test(siteUrl) ? { kind: 'link', href: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(siteUrl)}`, external: true } : undefined });

  // ---------------------------------------------------------------- AEO
  const ld = { en: siteJsonLd(draft, siteUrl, 'en'), ar: siteJsonLd(draft, siteUrl, 'ar') };
  const reports: Record<Locale, JsonLdReport> = { en: jsonLdReport(ld.en), ar: jsonLdReport(ld.ar) };
  for (const l of LOCALES) {
    const r = reports[l];
    add({ id: 'aeo.ldValid', area: 'aeo', locale: l, status: r.problems.length ? 'fail' : 'pass', details: r.problems });
    add({ id: 'aeo.ldRequired', area: 'aeo', locale: l, status: r.required.failed.length ? 'fail' : 'pass',
      vars: { passed: r.required.passed, total: r.required.passed + r.required.failed.length },
      details: r.required.failed.map((c) => `${c.path} ${c.type}.${c.property}`) });
  }
  const recMissing = reports.en.recommended.missing;
  add({ id: 'aeo.ldRecommended', area: 'aeo', status: recMissing.some((c) => !c.note) ? 'warn' : 'pass',
    vars: { passed: reports.en.recommended.passed, total: reports.en.recommended.passed + recMissing.length },
    details: recMissing.map((c) => `${c.type}.${c.property}${c.note ? ` (${c.note})` : ''}`) });
  const faq = { en: visibleFaq(draft, 'en'), ar: visibleFaq(draft, 'ar') };
  const faqSections = draft.sections.filter((s) => s.kind === 'faq');
  add({ id: 'aeo.faq', area: 'aeo', status: faq.en.length >= 3 ? 'pass' : 'warn', vars: { count: faq.en.length },
    fix: faqSections[0] ? { kind: 'section', id: faqSections[0].id } : { kind: 'ai', request: 'faq' } });
  const items = faqSections.flatMap((s) => s.content.items ?? []);
  for (const l of LOCALES) {
    const missing = items.filter((i) => !text(i.title, l) || !text(i.body, l)).length;
    if (items.length) add({ id: 'aeo.faqLanguage', area: 'aeo', locale: l, status: missing ? 'warn' : 'pass', vars: { missing, total: items.length },
      fix: faqSections[0] ? { kind: 'section', id: faqSections[0].id } : undefined });
  }
  add({ id: 'aeo.faqMarkup', area: 'aeo', status: 'info', vars: { count: faq.en.length } });
  const branches = draft.branches;
  const noHours = branches.filter((b) => !openingHours(b.openingHours).length).map((b) => b.name);
  add({ id: 'aeo.hours', area: 'aeo', status: !branches.length || noHours.length ? 'fail' : 'pass', details: noHours, vars: { count: branches.length } });
  const noAddress = branches.filter((b) => !b.address || !b.city).map((b) => b.name);
  add({ id: 'aeo.address', area: 'aeo', status: !branches.length || noAddress.length ? 'fail' : 'pass', details: noAddress });
  const noPhone = branches.filter((b) => !b.phone).map((b) => b.name);
  add({ id: 'aeo.phone', area: 'aeo', status: noPhone.length ? 'warn' : 'pass', details: noPhone });
  const dishes = menu?.categories.flatMap((c) => c.products) ?? [];
  if (menu) {
    add({ id: 'aeo.menuPrices', area: 'aeo', status: dishes.length ? 'pass' : 'fail', vars: { count: dishes.length, categories: menu.categories.length, currency: menu.org.currency },
      fix: { kind: 'link', href: urls.menu, external: true } });
    for (const l of LOCALES) {
      const described = dishes.filter((p) => (l === 'ar' ? p.descriptionAr : p.description)?.trim()).length;
      add({ id: 'aeo.menuDescriptions', area: 'aeo', locale: l, status: !dishes.length || described * 2 >= dishes.length ? 'pass' : 'warn', vars: { described, total: dishes.length } });
    }
  } else add({ id: 'aeo.menuPrices', area: 'aeo', status: 'info', vars: { count: 0, categories: 0, currency: draft.org.currency } });

  // ---------------------------------------------------------------- GEO
  for (const l of LOCALES) {
    add({ id: 'geo.description', area: 'geo', locale: l, status: text(seo.description, l) ? 'pass' : 'fail', fix: { kind: 'field', field: 'description' } });
  }
  const about = draft.sections.find((s) => s.kind === 'about');
  for (const l of LOCALES) {
    add({ id: 'geo.about', area: 'geo', locale: l, status: about && text(about.content.body, l) ? 'pass' : 'warn',
      fix: about ? { kind: 'section', id: about.id } : { kind: 'ai', request: 'about' } });
  }
  add({ id: 'geo.names', area: 'geo', status: name.en && name.ar ? 'pass' : 'warn', details: name.ar ? [] : ['ar'] });
  const noPin = draft.branches.filter((b) => b.latitude === null || b.longitude === null).map((b) => b.name);
  add({ id: 'geo.mapPin', area: 'geo', status: draft.branches.length && !noPin.length ? 'pass' : 'warn', details: noPin });
  add({ id: 'geo.mapsLink', area: 'geo', status: draft.org.socialLinks?.google_maps ? 'pass' : 'warn' });
  add({ id: 'geo.logo', area: 'geo', status: draft.theme.logoUrl ? 'pass' : 'warn' });
  // Name, address and phone must agree between the website, the menu page and the structured data (they come from the
  // same branch records, so a difference means one page is stale: e.g. the published site predates a branch change).
  const contradictions: string[] = [];
  if (menu) {
    for (const b of draft.branches) {
      const m = menu.branches.find((x) => x.code === b.code);
      if (!m) { contradictions.push(`${b.name}: not on the menu page`); continue; }
      if ((m.address ?? '') !== (b.address ?? '')) contradictions.push(`${b.name}: address “${b.address ?? '—'}” / “${m.address ?? '—'}”`);
      if (digits(m.phone) !== digits(b.phone)) contradictions.push(`${b.name}: phone “${b.phone ?? '—'}” / “${m.phone ?? '—'}”`);
    }
  }
  if (published) {
    for (const b of draft.branches) {
      const p = published.branches.find((x) => x.code === b.code);
      if (p && ((p.address ?? '') !== (b.address ?? '') || digits(p.phone) !== digits(b.phone) || JSON.stringify(openingHours(p.openingHours)) !== JSON.stringify(openingHours(b.openingHours)))) {
        contradictions.push(`${b.name}: the published site shows older details (publish to update)`);
      }
    }
  }
  add({ id: 'geo.nap', area: 'geo', status: contradictions.length ? 'fail' : 'pass', details: contradictions });
  // Facts written into the page text that the branch records contradict (hours, phone numbers).
  const hourSet = new Set(draft.branches.flatMap((b) => openingHours(b.openingHours).flatMap((h) => [h.opens, h.closes])));
  const phones = new Set(draft.branches.map((b) => digits(b.phone)).filter(Boolean));
  const textFacts: string[] = [];
  for (const s of draft.sections) {
    const bodies = [s.content.body, s.content.headline, ...(s.content.items ?? []).flatMap((i) => [i.title, i.body])];
    for (const l of LOCALES) {
      for (const b of bodies) {
        const v = text(b, l);
        if (!v) continue;
        for (const tm of timesIn(v)) if (!hourSet.has(tm)) textFacts.push(`${s.kind} (${l}): “${v.slice(0, 80)}” — ${tm}`);
        for (const ph of phonesIn(v)) if (![...phones].some((p) => p.endsWith(ph) || ph.endsWith(p))) textFacts.push(`${s.kind} (${l}): “${v.slice(0, 80)}” — ${ph}`);
      }
    }
  }
  add({ id: 'geo.textFacts', area: 'geo', status: textFacts.length ? 'warn' : 'pass', details: [...new Set(textFacts)] });
  // The entity chain answer engines follow: Restaurant → Menu → MenuSection → MenuItem → Offer.
  const menuLd = menu ? menuPageJsonLd(menu, draft, siteUrl, urls.menu, 'en') : [];
  const types = jsonLdReport([...ld.en, ...menuLd]).types;
  const chain = ['Restaurant', 'Menu', 'MenuSection', 'MenuItem', 'Offer'];
  add({ id: 'geo.entities', area: 'geo', status: chain.every((t) => types[t]) ? 'pass' : 'warn',
    details: chain.map((t) => `${t}: ${types[t] ?? 0}`), vars: { branches: draft.branches.length } });
  const social = Object.values(draft.org.socialLinks ?? {}).filter(Boolean).length;
  add({ id: 'geo.sameAs', area: 'geo', status: social ? 'pass' : 'warn', vars: { count: social } });
  // Language completeness: what an Arabic (or English) reader would get in the other language.
  for (const l of LOCALES) {
    const gaps: string[] = [];
    if (!text(seo.title, l)) gaps.push('seo.title');
    if (!text(seo.description, l)) gaps.push('seo.description');
    if (l === 'ar' && !name.ar) gaps.push('org.nameAr');
    for (const s of draft.sections) {
      if (s.content.headline && !text(s.content.headline, l) && text(s.content.headline, l === 'en' ? 'ar' : 'en')) gaps.push(`${s.kind}.headline`);
      if (s.content.body && !text(s.content.body, l) && text(s.content.body, l === 'en' ? 'ar' : 'en')) gaps.push(`${s.kind}.body`);
    }
    if (l === 'ar') {
      const noArName = dishes.filter((p) => !p.nameAr).length;
      if (noArName) gaps.push(`menu: ${noArName} dish names`);
      for (const b of draft.branches) if (!b.nameAr) gaps.push(`branch ${b.name}`);
    }
    add({ id: 'geo.language', area: 'geo', locale: l, status: gaps.length ? 'warn' : 'pass', details: gaps, vars: { count: gaps.length } });
  }
  return out;
}

/** Passed and failing (fail + warn) counts per area; info items are not counted. */
export function auditCounts(checks: AuditCheck[], area?: AuditArea) {
  const xs = checks.filter((c) => (!area || c.area === area) && c.status !== 'info');
  return { passed: xs.filter((c) => c.status === 'pass').length, failed: xs.filter((c) => c.status === 'fail').length, warnings: xs.filter((c) => c.status === 'warn').length, total: xs.length };
}

/** Reads the rendered page from a canvas (or any) document: the heading outline, content images and internal links. */
export function readRendered(doc: Document, siteBase: string): RenderedPage {
  const root = doc.querySelector('.site-root') ?? doc.body;
  const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]
    .filter((h) => !h.closest('[hidden], [aria-hidden="true"]'))
    .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').replace(/\s+/g, ' ').trim() }));
  const images = [...root.querySelectorAll<HTMLImageElement>('img')].map((img) => ({
    src: img.getAttribute('src') ?? '', alt: img.hasAttribute('alt') ? img.getAttribute('alt') : null,
    decorative: img.getAttribute('aria-hidden') === 'true' || img.hasAttribute('aria-hidden') || (img.getAttribute('alt') === '' && !!img.closest('.site-logo, .olive-logo, .site-social, a[aria-label]')),
  }));
  const base = siteBase.replace(/\/$/, '');
  const internalLinks = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.getAttribute('href') ?? '')
    .filter((h) => h.startsWith('/') || h.startsWith(base));
  return { headings, images, internalLinks };
}
