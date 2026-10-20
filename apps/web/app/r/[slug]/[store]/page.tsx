import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import type { PublicMenu, PublicStorefront } from '@resuto/contracts';
import { getT } from '@/lib/i18n/server';
import { APP_ORIGIN, SERVER_API_URL } from '../_components/load-site';
import { Storefront, type StorefrontMenu } from './Storefront';
import './storefront.css';

type Params = { params: Promise<{ slug: string; store: string }> };
const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

/** Published storefront branding (cached 30 s, dropped with the site's tag when the restaurant publishes). */
const loadStorefront = cache(async (slug: string, store: string): Promise<PublicStorefront | null> => {
  if (!SLUG.test(slug) || !SLUG.test(store)) return null;
  const res = await fetch(`${SERVER_API_URL}/v1/public/sites/${slug}/storefronts/${store}`, { next: { revalidate: 30, tags: [`site:${slug}`] } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Storefront service returned ${res.status}`);
  return (await res.json()) as PublicStorefront;
});

/** The branch's live web menu for the first paint; the page refreshes it in the browser (availability changes). */
async function loadMenu(sf: PublicStorefront): Promise<StorefrontMenu | null> {
  try {
    const res = await fetch(`${SERVER_API_URL}/v1/public/order/${sf.org.slug}?branch=${encodeURIComponent(sf.branch.code)}`, { next: { revalidate: 30, tags: [`site:${sf.org.slug}`] }, signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as PublicMenu as StorefrontMenu) : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, store } = await params;
  const sf = await loadStorefront(slug, store).catch(() => null);
  if (!sf) return { title: 'Not found', robots: { index: false } };
  const { t, locale } = await getT();
  const name = locale === 'ar' && sf.brand.nameAr ? sf.brand.nameAr : sf.brand.name;
  const title = t('studio.site.sf.title', { name });
  const tagline = (locale === 'ar' ? sf.brand.tagline.ar || sf.brand.tagline.en : sf.brand.tagline.en || sf.brand.tagline.ar) ?? '';
  const description = tagline ? `${tagline} ${t('studio.site.sf.description', { name })}` : t('studio.site.sf.description', { name });
  const url = `${APP_ORIGIN}/r/${sf.org.slug}/${sf.slug}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url, languages: { en: `${url}?lang=en`, ar: `${url}?lang=ar` } },
    openGraph: { type: 'website', title, description, url, siteName: name, locale: locale === 'ar' ? 'ar_EG' : 'en_US', ...(sf.brand.heroUrl ? { images: [{ url: sf.brand.heroUrl }] } : {}) },
    icons: sf.brand.logoUrl ? { icon: sf.brand.logoUrl } : undefined,
    robots: { index: true, follow: true },
  };
}

export default async function StorefrontPage({ params }: Params) {
  const { slug, store } = await params;
  const sf = await loadStorefront(slug, store);
  if (!sf) notFound();
  const [{ locale }, menu, h] = await Promise.all([getT(), loadMenu(sf), headers()]);
  // On the restaurant's own domain the site is "/", not /r/<slug> (middleware.ts rewrites host-relative paths).
  const onCustomHost = !!h.get('x-resuto-site-host');
  return <Storefront sf={sf} initialMenu={menu} locale={locale} siteHref={onCustomHost ? '/' : sf.links.site} />;
}
