import type { Metadata } from 'next';
import { PricingView } from './PricingView';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Resuto plans for restaurants in Egypt and Saudi Arabia: Free QR, Starter, Growth, Pro or build your own from modules. Provider fees are billed by the providers, not Resuto.',
};

export default function PricingPage() {
  return <PricingView />;
}
