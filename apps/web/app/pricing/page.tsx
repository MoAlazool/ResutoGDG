import type { Metadata } from 'next';
import type { PublicPlansResponse } from '@resuto/contracts';
import { langAlternates } from '@/components/landing/legacy-routes';
import { PricingPage } from '@/components/landing/PricingPage';
import { ScopeMessages } from '@/lib/i18n/scope';
import { getLocale } from '@/lib/i18n/server';
import { faq, formatAmount, fromPrice } from './pricing-model';

const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
const API = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Egyptian price list, server-rendered so the cards, table and FAQ are in the first HTML (and cached for 5 minutes). */
async function loadPlans(): Promise<PublicPlansResponse | null> {
  try {
    const res = await fetch(`${API}/v1/public/plans?country=EG&interval=month`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as PublicPlansResponse;
    return Array.isArray(body?.plans) ? body : null;
  } catch {
    return null;
  }
}

/** Legacy titles: "Resuto pricing: plans from 799 EGP a month" / "أسعار ريسوتو: خطط تبدأ من 799 جنيهًا شهريًا" (from data). */
export async function generateMetadata(): Promise<Metadata> {
  const [locale, plans] = await Promise.all([getLocale(), loadPlans()]);
  const from = plans ? fromPrice(plans) : null;
  const title = locale === 'ar'
    ? (from !== null ? `أسعار ريسوتو: خطط تبدأ من ${formatAmount(from, 'ar')} جنيهًا شهريًا` : 'أسعار ريسوتو')
    : (from !== null ? `Resuto pricing: plans from ${formatAmount(from, 'en')} EGP a month` : 'Resuto pricing');
  const description = locale === 'ar'
    ? 'خطط ريسوتو للمطاعم في مصر والسعودية: الحجوزات وطلبات QR وشاشة المطبخ وتقسيم الفاتورة، مع تجربة 14 يومًا دون بطاقة. رسوم مزودي الدفع منفصلة.'
    : 'Resuto plans for restaurants in Egypt and Saudi Arabia: reservations, QR ordering, the kitchen board and split bills, with a 14-day trial and no card. Provider fees are billed by the providers, not Resuto.';
  return {
    metadataBase: new URL(APP_ORIGIN),
    title: { absolute: title },
    description,
    alternates: { canonical: '/pricing', languages: langAlternates('/pricing') },
    openGraph: { type: 'website', url: '/pricing', siteName: 'Resuto', title, description, locale: locale === 'ar' ? 'ar_EG' : 'en_US', images: [{ url: '/brand/og-resuto.png', width: 1200, height: 630, alt: 'Resuto' }] },
  };
}

export default async function Pricing() {
  const [locale, plans] = await Promise.all([getLocale(), loadPlans()]);
  // The questions are published as FAQ structured data, as on the legacy page, so every answer must stay true.
  const jsonLd = plans ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faq(plans, locale).map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  } : null;
  return (
    <>
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />}
      <ScopeMessages scope="public"><PricingPage initial={plans} /></ScopeMessages>
    </>
  );
}
