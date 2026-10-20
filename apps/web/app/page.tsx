import type { Metadata } from 'next';
import { LandingPage } from '@/components/landing/LandingPage';
import { landingFloorFrom, SAMPLE_FLOOR, type LandingFloor } from '@/components/landing/floor-data';
import { langAlternates } from '@/components/landing/legacy-routes';
import { DEMO_SLUG } from '@/components/landing/links';
import { landingPlansFrom, type LandingPlan } from '@/components/landing/plans';
import { getT } from '@/lib/i18n/server';

const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
const API = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getT();
  const title = t('platform.meta.title');
  const description = t('platform.meta.description');
  return {
    metadataBase: new URL(APP_ORIGIN),
    title: { absolute: title },
    description,
    // hreflang alternates are rendered by the page below: Next's metadata resolver drops the query of a root URL
    // ('/?lang=ar' comes out as the bare origin).
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website', url: '/', siteName: 'Resuto', title, description, locale: locale === 'ar' ? 'ar_EG' : 'en_US',
      images: [{ url: '/brand/og-resuto.png', width: 1200, height: 630, alt: 'Resuto' }],
    },
    twitter: { card: 'summary_large_image', title, description, images: ['/brand/og-resuto.png'] },
    robots: { index: true, follow: true },
  };
}

/*
 * Caching (audit PCL-27). The HTML of this page, /pricing and /r/<slug> is rendered per request and sent
 * `private, no-store`, deliberately:
 *  - every response embeds the middleware's per-request CSP script nonce (PS-17, lib/csp.ts); a CDN copy would
 *    replay one nonce to every visitor and so defeat the policy, and Next only applies nonces when rendering dynamically;
 *  - the language comes from the resuto_locale cookie or ?lang (VP-16), read by the root layout, so one URL serves
 *    two documents.
 * What is expensive is cached instead: the plan list and the demo floor below (5 minutes) and the restaurant site
 * (30 s, tag site:<slug>, purged on publish) come from Next's data cache, so a render costs no API round trip.
 * Making the HTML itself shareable needs the locale in the path (/ar/...) and a hash-based CSP for these pages; that
 * is a routing change across every public page, not part of this pass.
 */

/**
 * Public plan prices for the pricing teaser. Prices are data owned by the
 * billing module; if its public endpoint is unavailable the teaser links to
 * /pricing instead of showing numbers. Parsing lives in components/landing/plans.ts (unit tested with the real shape).
 */
async function loadPlans(): Promise<LandingPlan[] | null> {
  try {
    const res = await fetch(`${API}/v1/public/plans?country=EG`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return landingPlansFrom(await res.json());
  } catch {
    return null;
  }
}

/** The demo restaurant's saved floor for the hero and closing banner (audit VP-12); the recorded sample if unavailable. */
async function loadFloor(): Promise<LandingFloor> {
  try {
    const res = await fetch(`${API}/v1/public/floor/${encodeURIComponent(DEMO_SLUG)}/main`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(3000) });
    return res.ok ? landingFloorFrom(await res.json()) : SAMPLE_FLOOR;
  } catch {
    return SAMPLE_FLOOR;
  }
}

export default async function Home() {
  const [plans, floor] = await Promise.all([loadPlans(), loadFloor()]);
  const { t } = await getT();
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Resuto',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: APP_ORIGIN,
    description: t('platform.meta.description'),
    areaServed: ['EG', 'SA'],
    inLanguage: ['en', 'ar'],
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      {Object.entries(langAlternates(`${APP_ORIGIN}/`)).map(([hl, href]) => <link key={hl} rel="alternate" hrefLang={hl} href={href} />)}
      <LandingPage plans={plans} floor={floor} />
    </>
  );
}
