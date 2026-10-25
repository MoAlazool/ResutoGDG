'use client';
// The steps that run once the restaurant exists (logo and look → menu QR), loaded as one chunk when the wizard first
// reaches them: one entry in the app's chunk map instead of six, so every other page's runtime stays as small.
import type { OnboardingStep } from '@resuto/contracts/lite';
import { BrandStep } from './BrandStep';
import { DetailsStep } from './DetailsStep';
import { MenuStep } from './MenuStep';
import { PublishStep } from './PublishStep';
import { QrStep } from './QrStep';
import { SocialStep } from './SocialStep';

export type RestaurantStepName = Extract<OnboardingStep, 'brand' | 'menu' | 'details' | 'social' | 'publish' | 'qr'>;

export function RestaurantSteps({ step }: { step: RestaurantStepName }) {
  switch (step) {
    case 'brand': return <BrandStep />;
    case 'menu': return <MenuStep />;
    case 'details': return <DetailsStep />;
    case 'social': return <SocialStep />;
    case 'publish': return <PublishStep />;
    case 'qr': return <QrStep />;
  }
}
