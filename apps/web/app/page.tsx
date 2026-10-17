import type { Metadata } from 'next';
import { LandingPage } from '@/components/landing/LandingPage';
import type { LandingPlan } from '@/components/landing/Chrome';
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
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website', url: '/', siteName: 'Resuto', title, description, locale: locale === 'ar' ? 'ar_EG' : 'en_US',
      images: [{ url: '/brand/og-resuto.png', width: 1200, height: 630, alt: 'Resuto' }],
    },
    twitter: { card: 'summary_large_image', title, description, images: ['/brand/og-resuto.png'] },
    robots: { index: true, follow: true },
  };
}

/**
 * Public plan prices for the pricing teaser. Prices are data owned by the
 * billing module; if its public endpoint is unavailable the teaser links to
 * /pricing instead of showing numbers.
 */
async function loadPlans(): Promise<LandingPlan[] | null> {
  try {
    const res = await fetch(`${API}/v1/public/plans?country=EG`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = await res.json();
    const items: any[] = Array.isArray(body) ? body : body.items ?? body.plans ?? [];
    const plans = items.filter((p) => p && typeof p.id === 'string' && p.id !== 'free').map((p): LandingPlan => {
      const monthly = p.monthlyMinor ?? p.prices?.find((x: any) => (x.billingInterval ?? x.interval) === 'month' && (x.currency ?? 'EGP') === 'EGP')?.amountMinor;
      return { id: p.id, name: p.name, nameAr: p.nameAr ?? null, monthlyMinor: typeof monthly === 'number' ? monthly : null, currency: 'EGP', description: p.description ?? null };
    });
    return plans.length ? plans : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const plans = await loadPlans();
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
      <LandingPage plans={plans} />
    </>
  );
}
