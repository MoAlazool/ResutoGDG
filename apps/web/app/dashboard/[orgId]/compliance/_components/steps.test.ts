import { describe, expect, it } from 'vitest';
import { compliance } from '@/lib/i18n/dict/compliance';
import { currentStep, doneCount, etaSteps, zatcaSteps, type ComplianceFacts } from './steps';

const facts = (over: Partial<ComplianceFacts> = {}): ComplianceFacts => ({
  profileValidated: false, branches: 2, units: [], etaConnection: null, issued30d: 0, submissionMode: 'sandbox_stub', ...over,
});
const states = (steps: Array<{ key: string; state: string }>) => Object.fromEntries(steps.map((s) => [s.key, s.state]));

describe('ZATCA set-up steps', () => {
  it('starts at the tax profile and ends with certification, which is never done', () => {
    const steps = zatcaSteps(facts());
    expect(steps.map((s) => s.key)).toEqual(['profile', 'egs', 'csid', 'checks', 'production', 'certification']);
    expect(states(steps)).toMatchObject({ profile: 'todo', egs: 'todo', certification: 'not_certified' });
    expect(currentStep(steps)).toBe('profile');
  });

  it('counts each branch by its most advanced unit; every branch must reach a step for it to be done', () => {
    const units = [
      { branchId: 'a', status: 'active', environment: 'production' },
      { branchId: 'b', status: 'compliance_csid', environment: 'sandbox' },
      { branchId: 'b', status: 'retired', environment: 'production' },
    ];
    const steps = zatcaSteps(facts({ profileValidated: true, units }));
    expect(states(steps)).toEqual({ profile: 'done', egs: 'done', csid: 'done', checks: 'in_progress', production: 'in_progress', certification: 'not_certified' });
    expect(steps.find((s) => s.key === 'checks')!.count).toEqual({ done: 1, total: 2 });
    expect(currentStep(steps)).toBe('checks');
    expect(doneCount(steps)).toBe(3);
  });

  it('every branch active is still not certified', () => {
    const units = [{ branchId: 'a', status: 'active', environment: 'production' }, { branchId: 'b', status: 'active', environment: 'production' }];
    const steps = zatcaSteps(facts({ profileValidated: true, units }));
    expect(states(steps).production).toBe('done');
    expect(states(steps).certification).toBe('not_certified');
    expect(currentStep(steps)).toBeNull();
  });

  it('an onboarding error needs attention; unknown units read unknown, not to do', () => {
    const steps = zatcaSteps(facts({ profileValidated: true, units: [{ branchId: 'a', status: 'error', environment: 'sandbox', lastError: 'OTP expired' }] }));
    expect(states(steps).egs).toBe('error');
    expect(states(zatcaSteps(facts({ units: null }))).egs).toBe('unknown');
  });
});

describe('ETA set-up steps', () => {
  it('portal registration is outside Resuto and never marked done; submission is not done in sandbox-stub mode', () => {
    const steps = etaSteps(facts({ profileValidated: true, etaConnection: { status: 'connected', environment: 'preprod' }, issued30d: 12 }));
    expect(states(steps)).toEqual({ profile: 'done', portal: 'outside', connect: 'done', documents: 'done', submission: 'todo', certification: 'not_certified' });
    expect(currentStep(steps)).toBe('submission');
  });

  it('the connection step is unknown when the role cannot read connections', () => {
    expect(states(etaSteps(facts({ etaConnection: undefined }))).connect).toBe('unknown');
    expect(states(etaSteps(facts({ etaConnection: null }))).connect).toBe('todo');
    expect(states(etaSteps(facts({ etaConnection: { status: 'error', environment: 'preprod' } }))).connect).toBe('error');
  });
});

describe('stepper strings', () => {
  it('every step, state and body has English and Arabic text', () => {
    const keys = [
      ...['profile', 'egs', 'csid', 'checks', 'production', 'certification'].flatMap((k) => [`compliance.step.zatca.${k}`, `compliance.step.zatca.${k}.body`]),
      ...['profile', 'portal', 'connect', 'documents', 'submission', 'certification'].flatMap((k) => [`compliance.step.eta.${k}`, `compliance.step.eta.${k}.body`]),
      ...['done', 'in_progress', 'todo', 'error', 'outside', 'not_certified', 'unknown'].map((k) => `compliance.step.state.${k}`),
    ];
    for (const k of keys) {
      expect(compliance.en[k], k).toBeTruthy();
      expect(compliance.ar[k], k).toBeTruthy();
    }
    // Honest labels: no step text claims certification.
    for (const v of Object.entries(compliance.en).filter(([k]) => k.startsWith('compliance.step')).map(([, v]) => v)) expect(v).not.toMatch(/\bcertified by\b|is certified/i);
  });
});
