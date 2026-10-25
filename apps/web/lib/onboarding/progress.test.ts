import { describe, expect, it } from 'vitest';
import { EMPTY_ONBOARDING, type OnboardingProgress } from '@resuto/contracts/lite';
import { applySave, canOpen, finishStep, moveTo, resumeStep, stepNumber, WIZARD_STEPS } from './progress';

// 21-ONB: what the wizard saves after each step (PUT /v1/onboarding/progress) and where it reopens.

const at = (p: Partial<OnboardingProgress>): OnboardingProgress => ({ ...EMPTY_ONBOARDING, ...p });

describe('wizard progress', () => {
  it('finishing a step saves it as finished and moves to the next one; the last step finishes the wizard', () => {
    expect(finishStep('restaurant', { draft: { name: 'Olive' } })).toEqual({ step: 'address', completed: ['restaurant'], draft: { name: 'Olive' } });
    expect(finishStep('address', { orgId: 'o1' })).toEqual({ step: 'brand', completed: ['address'], orgId: 'o1' });
    expect(finishStep('qr')).toEqual({ step: 'qr', completed: ['qr'], done: true });
    expect(moveTo('menu')).toEqual({ step: 'menu', completed: [] });
  });

  it('applies a save the way the server does (finished steps only grow, restart clears)', () => {
    let p = at({});
    p = applySave(p, finishStep('restaurant', { draft: { name: 'Olive', country: 'SA' } }));
    p = applySave(p, finishStep('address', { orgId: 'o1' }));
    expect(p).toMatchObject({ step: 'brand', completed: ['account', 'restaurant', 'address'], orgId: 'o1', draft: { name: 'Olive', country: 'SA' } });
    p = applySave(p, moveTo('restaurant'));
    expect(p.completed).toEqual(['account', 'restaurant', 'address']);
    p = applySave(p, finishStep('qr'));
    expect(p.completedAt).toEqual(expect.any(String));
    p = applySave(p, { step: 'restaurant', completed: [], orgId: null, restart: true });
    expect(p).toMatchObject({ step: 'restaurant', completed: ['account'], orgId: null, draft: {}, completedAt: null });
  });

  it('resumes on another device where the owner left off, never past an unfinished step', () => {
    expect(resumeStep(at({ step: 'details', completed: ['account', 'restaurant', 'address', 'brand', 'menu'], orgId: 'o1' }))).toBe('details');
    expect(resumeStep(at({ step: 'publish', completed: ['account', 'restaurant', 'address', 'brand'], orgId: 'o1' }))).toBe('menu');
    expect(resumeStep(at({ step: 'brand', completed: ['account', 'restaurant', 'address'], orgId: null }))).toBe('address');
  });

  it('the step list opens finished steps and the next open one only', () => {
    const p = at({ step: 'menu', completed: ['account', 'restaurant', 'address', 'brand'], orgId: 'o1' });
    expect(WIZARD_STEPS.filter((s) => canOpen(p, s))).toEqual(['restaurant', 'address', 'brand', 'menu']);
    expect(WIZARD_STEPS[0]).toBe('account');
    expect(canOpen(p, 'account')).toBe(false);
    expect(canOpen(at({ step: 'address', completed: ['account', 'restaurant'] }), 'brand')).toBe(false);
    expect(WIZARD_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(stepNumber('restaurant')).toBe(2);
  });
});
