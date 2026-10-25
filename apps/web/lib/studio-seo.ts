// The Studio SEO / AEO / GEO checklist (21-STUDIO, plan §6.4), computed from the draft as guests will get it (the
// staff preview payload): search basics, local-listing facts and "AI answer readiness" (what answer engines need to
// quote the restaurant correctly). Each item says whether it is done; nothing here is a score or an estimate.
// Pure; unit-tested in lib/studio-seo.test.ts.
import type { PublicSite } from '@resuto/contracts';
import { siteJsonLd, validateJsonLd } from '@/app/r/[slug]/_components/structured-data';
import { openingHours } from '@/app/r/[slug]/_components/site-utils';

export type CheckGroup = 'search' | 'local' | 'answers';
export interface CheckItem { group: CheckGroup; key: string; ok: boolean }

const both = (v: { en?: string; ar?: string } | undefined) => !!v?.en?.trim() && !!v?.ar?.trim();

/** Every check for a site, in display order. `url` is the canonical page address (for the structured-data check). */
export function seoChecklist(site: PublicSite, url: string): CheckItem[] {
  const branches = site.branches;
  const visible = site.sections;
  const faqAnswers = visible.filter((s) => s.kind === 'faq').flatMap((s) => s.content.items ?? []).filter((i) => (i.title?.en || i.title?.ar) && (i.body?.en || i.body?.ar));
  const fullMenu = visible.some((s) => s.kind === 'menu_full' && (s.content.menu ?? []).some((g) => g.items.length));
  const described = site.menuHighlights.filter((p) => p.description || p.descriptionAr).length;
  const menuText = fullMenu || (site.menuHighlights.length > 0 && described * 2 >= site.menuHighlights.length);
  const ld = ['en', 'ar'].flatMap((l) => siteJsonLd(site, url, l as 'en' | 'ar'));
  const items: CheckItem[] = [
    { group: 'search', key: 'title', ok: both(site.seo.title) },
    { group: 'search', key: 'description', ok: both(site.seo.description) },
    { group: 'search', key: 'shareImage', ok: !!site.seo.ogImageUrl },
    // Every page carries hreflang alternates (en, ar, x-default) and a canonical URL; the site has its own sitemap.
    { group: 'search', key: 'hreflang', ok: true },
    { group: 'search', key: 'sitemap', ok: true },
    { group: 'search', key: 'structuredData', ok: ld.length > 0 && ld.every((d) => validateJsonLd(d).length === 0) },
    { group: 'local', key: 'nameBoth', ok: !!site.org.nameAr },
    { group: 'local', key: 'address', ok: branches.length > 0 && branches.every((b) => !!(b.address && b.city)) },
    { group: 'local', key: 'phone', ok: branches.length > 0 && branches.every((b) => !!b.phone) },
    { group: 'local', key: 'mapPin', ok: branches.length > 0 && branches.every((b) => b.latitude !== null && b.longitude !== null) },
    { group: 'local', key: 'mapsLink', ok: !!site.org.socialLinks?.google_maps },
    { group: 'local', key: 'logo', ok: !!site.theme.logoUrl },
    { group: 'local', key: 'photos', ok: !!site.theme.heroUrl || visible.some((s) => !!s.content.media || (s.content.gallery ?? []).length > 0) },
    { group: 'answers', key: 'faq', ok: faqAnswers.length >= 3 },
    { group: 'answers', key: 'hours', ok: branches.length > 0 && branches.every((b) => openingHours(b.openingHours).length > 0) },
    { group: 'answers', key: 'menuText', ok: menuText },
    { group: 'answers', key: 'aboutBoth', ok: visible.some((s) => (s.kind === 'about' || s.kind === 'hero') && both(s.content.body)) },
  ];
  return items;
}
