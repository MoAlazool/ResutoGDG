import { describe, expect, it, vi } from 'vitest';
import { EMPTY_ONBOARDING, type MeResponse } from '@resuto/contracts';
import { withWizardResume } from './resume';

// 21-ONB: signing in again resumes a half-finished onboarding wizard (owners only, their own restaurant).
const me = (role = 'owner'): MeResponse => ({ user: { id: 'u', email: 'a@b.c', fullName: null, locale: 'en' }, platformRole: null,
  memberships: [{ orgId: 'o1', orgSlug: 'olive', orgName: 'Olive', role, branchIds: null }] });
const progress = (p: object) => async () => ({ ...EMPTY_ONBOARDING, ...p });

describe('resume the wizard after sign-in', () => {
  it('sends an owner with an unfinished wizard back to it', async () => {
    expect(await withWizardResume(me(), '/dashboard/o1', false, progress({ orgId: 'o1', step: 'menu' }))).toBe('/onboarding');
  });
  it('keeps the usual destination otherwise', async () => {
    expect(await withWizardResume(me(), '/dashboard/o1', false, progress({ orgId: 'o1', completedAt: '2026-10-25T10:00:00Z' }))).toBe('/dashboard/o1');
    expect(await withWizardResume(me(), '/dashboard/o1', false, progress({ orgId: null }))).toBe('/dashboard/o1');
    expect(await withWizardResume(me(), '/dashboard/o1', false, progress({ orgId: 'other' }))).toBe('/dashboard/o1');
    expect(await withWizardResume(me('manager'), '/dashboard/o1', false, progress({ orgId: 'o1' }))).toBe('/dashboard/o1');
    expect(await withWizardResume(me(), '/dashboard/o1', false, async () => { throw new Error('offline'); })).toBe('/dashboard/o1');
    const read = vi.fn(progress({ orgId: 'o1' }));
    expect(await withWizardResume(me(), '/invite/x', true, read)).toBe('/invite/x');
    expect(await withWizardResume(null, '/onboarding', false, read)).toBe('/onboarding');
    expect(read).not.toHaveBeenCalled();
  });
});
