import type { Metadata } from 'next';
import { LandingPage } from '../../web/components/landing/LandingPage';
import { SAMPLE_FLOOR } from '../../web/components/landing/floor-data';
import { PUBLIC_PLANS_EG } from '../../web/components/landing/plans.fixture';
import { landingPlansFrom } from '../../web/components/landing/plans';

export const metadata: Metadata = { alternates: { canonical: '/' } };

export default function Home() {
  const plans = landingPlansFrom(PUBLIC_PLANS_EG);
  const jsonLd = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Resuto', applicationCategory: 'BusinessApplication', operatingSystem: 'Web', url: 'https://resuto.app', areaServed: ['EG', 'SA'], inLanguage: ['en', 'ar'] };
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} /><LandingPage plans={plans} floor={SAMPLE_FLOOR} /></>;
}
