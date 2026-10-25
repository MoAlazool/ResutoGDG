import { describe, expect, it } from 'vitest';
import { EMPTY_ONBOARDING, mergeCompleted, nextStep, ONBOARDING_STEPS, ORG_ONBOARDING_STEPS, previousStep, resumeStep } from './onboarding';
import { onboardingProgressInput, updateBrand } from './onboarding-api';

describe('onboarding wizard steps (21-ONB)', () => {
  it('has the nine plan steps in order; the restaurant exists from the brand step on', () => {
    expect(ONBOARDING_STEPS).toEqual(['account', 'restaurant', 'address', 'brand', 'menu', 'details', 'social', 'publish', 'qr']);
    expect(ORG_ONBOARDING_STEPS[0]).toBe('brand');
    expect(nextStep('qr')).toBe('qr');
    expect(nextStep('address')).toBe('brand');
    // The account step is the signup: going back never leaves the wizard for it.
    expect(previousStep('restaurant')).toBe('restaurant');
    expect(previousStep('menu')).toBe('brand');
  });

  it('resumes at the saved step, never past the first unfinished step and never on a restaurant step without one', () => {
    expect(resumeStep(EMPTY_ONBOARDING)).toBe('restaurant');
    expect(resumeStep({ step: 'menu', completed: ['account', 'restaurant', 'address', 'brand'], orgId: 'o' })).toBe('menu');
    // A forged or stale step beyond what was finished goes back to the first open step.
    expect(resumeStep({ step: 'qr', completed: ['account', 'restaurant', 'address'], orgId: 'o' })).toBe('brand');
    expect(resumeStep({ step: 'menu', completed: ['account', 'restaurant', 'address', 'brand'], orgId: null })).toBe('address');
    expect(resumeStep({ step: 'account', completed: ['account'], orgId: null })).toBe('restaurant');
    expect(resumeStep({ step: 'nonsense' as never, completed: [], orgId: null })).toBe('restaurant');
    expect(resumeStep({ step: 'qr', completed: [...ONBOARDING_STEPS], orgId: 'o' })).toBe('qr');
    // Going back to edit an earlier step is allowed.
    expect(resumeStep({ step: 'brand', completed: [...ONBOARDING_STEPS], orgId: 'o' })).toBe('brand');
  });

  it('merges finished steps in wizard order, dropping unknown names', () => {
    expect(mergeCompleted(['menu', 'account'], ['restaurant', 'menu', 'bogus'])).toEqual(['account', 'restaurant', 'menu']);
  });

  it('progress input is strict and bounded', () => {
    expect(onboardingProgressInput.parse({ step: 'menu' })).toEqual({ step: 'menu', completed: [] });
    expect(onboardingProgressInput.safeParse({ step: 'menu', extra: 1 }).success).toBe(false);
    expect(onboardingProgressInput.safeParse({ step: 'ordering' }).success).toBe(false);
    expect(onboardingProgressInput.safeParse({ step: 'menu', draft: { name: 'x'.repeat(121) } }).success).toBe(false);
    expect(onboardingProgressInput.safeParse({ step: 'menu', draft: { planId: 'pro' } }).success).toBe(false);
    expect(onboardingProgressInput.parse({ step: 'address', draft: { slug: ' Olive-Room ' } }).draft).toEqual({ slug: 'olive-room' });
  });

  it('the brand input takes only studio_basic fields', () => {
    expect(updateBrand.parse({ presetId: 'cafe', primaryColor: '#112233', logoMediaId: null })).toEqual({ presetId: 'cafe', primaryColor: '#112233', logoMediaId: null });
    for (const bad of [{ heroMediaId: '00000000-0000-4000-8000-000000000000' }, { tagline: { en: 'x' } }, { template: 'smash' }, { seo: {} },
      { font: 'editorial' }, { primaryColor: 'red' }, { primaryColor: '#12345' }, { presetId: 'Cafe!' }]) {
      expect(updateBrand.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
