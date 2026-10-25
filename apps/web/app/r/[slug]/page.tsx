import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { langAlternates } from '@/components/landing/legacy-routes';
import { getT } from '@/lib/i18n/server';
import { FunnelView } from '@/components/guest/FunnelView';
import { MetaPixel } from '@/lib/tracking/MetaPixel';
import { canonicalUrl, loadSite } from './_components/load-site';
import { SiteView } from './_components/SiteView';
import { loc, pickName } from './_components/site-utils';
import { jsonLdScript, siteJsonLd } from './_components/structured-data';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadSite(slug).catch(() => null);
  const { locale } = await getT();
  if (!site) return { title: 'Not found', robots: { index: false } };
  const name = pickName(locale, site.org.name, site.org.nameAr);
  const title = loc(site.seo.title, locale) || name;
  const description = loc(site.seo.description, locale) || undefined;
  const url = canonicalUrl(site);
  const image = site.seo.ogImageUrl ?? site.theme.heroUrl ?? undefined;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url, languages: langAlternates(url) },
    openGraph: { type: 'website', title, description, url, siteName: name, locale: locale === 'ar' ? 'ar_EG' : 'en_US', ...(image ? { images: [{ url: image }] } : {}) },
    twitter: { card: image ? 'summary_large_image' : 'summary', title, description, ...(image ? { images: [image] } : {}) },
    icons: site.theme.logoUrl ? { icon: site.theme.logoUrl } : undefined,
    robots: { index: true, follow: true },
  };
}

export default async function RestaurantSite({ params }: Params) {
  const { slug } = await params;
  const site = await loadSite(slug);
  if (!site) notFound();
  const { t, locale } = await getT();
  const onCustomHost = !!(await headers()).get('x-resuto-site-host');
  return (
    <>
      {/* schema.org Restaurant (menu, offers) and FAQPage, server-rendered from the published site (21-STUDIO). */}
      {siteJsonLd(site, canonicalUrl(site), locale).map((ld, i) => <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />)}
      <a className="sr-only" href="#main">{t('studio.site.skip')}</a>
      <MetaPixel slug={slug} />
      <FunnelView surface="r" slug={slug} />
      <SiteView site={site} locale={locale} t={t} hostLinks={onCustomHost ? { home: '/', order: '/order', reserve: '/reserve' } : undefined} />
    </>
  );
}
