// After sign-in (21-ONB): an owner who left the onboarding wizard half way goes back to it instead of the dashboard.
// Only when no explicit `next` was asked for, and only for a restaurant the person still belongs to; any failure
// keeps the usual destination.
import type { MeResponse, OnboardingProgress } from '@resuto/contracts';

export async function withWizardResume(
  me: MeResponse | null, destination: string, explicitNext: boolean, readProgress: () => Promise<OnboardingProgress>,
): Promise<string> {
  if (explicitNext || destination === '/onboarding' || !me?.memberships.length) return destination;
  try {
    const p = await readProgress();
    const mine = p.orgId && me.memberships.some((m) => m.orgId === p.orgId && m.role === 'owner');
    return mine && !p.completedAt ? '/onboarding' : destination;
  } catch {
    return destination;
  }
}
