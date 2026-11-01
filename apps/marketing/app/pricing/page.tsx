import type { Metadata } from 'next';
import { PricingPage } from '../../../web/components/landing/PricingPage';
import { EGYPT_CATALOG, SAUDI_CATALOG } from '@/lib/pricing-catalog';
import { faq } from '../../../web/app/pricing/pricing-model';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Resuto launch pricing for restaurants in Egypt and Saudi Arabia, with complete plan and module comparisons.',
  alternates: { canonical: '/pricing/' },
};

export default function Pricing() {
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: ['en', 'ar'],
    mainEntity: faq(EGYPT_CATALOG, 'en').map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })),
  };
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} /><PricingPage initial={EGYPT_CATALOG} countries={{ EG: EGYPT_CATALOG, SA: SAUDI_CATALOG }} /></>;
}
