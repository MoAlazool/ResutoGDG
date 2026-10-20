import type { PaymentAdapter } from '@resuto/integrations';
import type { CatalogAdapter } from './catalog';

/**
 * Honest per-capability readiness (INT-16, PAY-22). Six states, computed — never
 * hand-set:
 * - not_configured: the tenant has no connection for this provider.
 * - implementation_incomplete: Resuto's code does not implement the capability.
 * - pending_external_verification: implemented against the provider's docs and
 *   covered by local tests, but never run against the provider.
 * - official_test_verified: a recorded acceptance check passed against the
 *   provider's official test environment (integration_verifications).
 * - live_verified: a recorded acceptance check passed in live mode.
 * - blocked_by_provider: the provider documents that it cannot serve this
 *   tenant (e.g. Stripe does not onboard businesses in Egypt or Saudi Arabia).
 */
export const READINESS_STATES = [
  'not_configured', 'implementation_incomplete', 'pending_external_verification', 'official_test_verified', 'live_verified', 'blocked_by_provider',
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export interface VerificationRow { provider: string; capability: string; environment: 'official_test' | 'live'; status: string; ran_at: Date | string; commit_sha: string | null }

export interface CapabilityReadiness {
  capability: string;
  /** State for the provider's official test environment and for live. */
  test: ReadinessState;
  live: ReadinessState;
  note: string | null;
  blockedBy: string | null;
  lastVerified: { test: string | null; live: string | null };
}

export interface ProviderReadiness {
  /** Overall state for the tenant: the weakest live state across implemented capabilities, or not_configured. */
  summary: ReadinessState;
  configured: boolean;
  capabilities: CapabilityReadiness[];
  restriction: { country: string; reason: string; source: string } | null;
}

const isPayment = (a: CatalogAdapter): a is CatalogAdapter & PaymentAdapter => !!(a as any).setup?.capabilities;
const ORDER: ReadinessState[] = ['blocked_by_provider', 'implementation_incomplete', 'pending_external_verification', 'official_test_verified', 'live_verified'];

/** Readiness of one provider for one tenant. Simulated providers have no readiness (they never talk to a provider). */
export function providerReadiness(adapter: CatalogAdapter, ctx: { country: string | null; configured: boolean; verifications: VerificationRow[] }): ProviderReadiness | null {
  const d = adapter.descriptor;
  if (d.readiness === 'simulated') return null;
  const passed = (capability: string, env: 'official_test' | 'live') => ctx.verifications
    .filter((v) => v.provider === d.id && v.capability === capability && v.environment === env && v.status === 'passed')
    .map((v) => new Date(v.ran_at).toISOString()).sort().at(-1) ?? null;
  const restriction = isPayment(adapter) ? adapter.setup.restrictedCountries?.find((r) => r.country === ctx.country) ?? null : null;
  const facts: Array<[string, { implemented: boolean; note?: string; blockedBy?: string }]> = isPayment(adapter)
    ? Object.entries(adapter.setup.capabilities)
    // Providers without per-capability facts: their descriptor claims apply to each listed capability.
    : d.capabilities.map((c) => [c, { implemented: d.readiness !== 'simulated' }]);
  const capabilities = facts.map(([capability, f]): CapabilityReadiness => {
    const lastTest = passed(capability, 'official_test');
    const lastLive = passed(capability, 'live');
    const blockedBy = restriction ? `${restriction.reason} (${restriction.source})` : f.blockedBy ?? null;
    const state = (verified: string | null, verifiedState: ReadinessState): ReadinessState =>
      blockedBy ? 'blocked_by_provider' : !f.implemented ? 'implementation_incomplete' : verified ? verifiedState : legacyState(d.readiness, verifiedState);
    return {
      capability, note: f.note ?? null, blockedBy,
      test: state(lastTest, 'official_test_verified'),
      live: state(lastLive, 'live_verified'),
      lastVerified: { test: lastTest, live: lastLive },
    };
  });
  const implemented = capabilities.filter((c) => c.live !== 'implementation_incomplete');
  const weakest = (implemented.length ? implemented : capabilities).map((c) => c.live).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] ?? 'implementation_incomplete';
  return {
    summary: ctx.configured || weakest === 'blocked_by_provider' ? weakest : 'not_configured',
    configured: ctx.configured,
    capabilities,
    restriction: restriction ? { country: restriction.country, reason: restriction.reason, source: restriction.source } : null,
  };
}

/** Descriptor claims of providers owned by other workstreams map onto the taxonomy without upgrading anything. */
function legacyState(readiness: string, verifiedState: ReadinessState): ReadinessState {
  if (readiness === 'live_verified' && verifiedState === 'live_verified') return 'live_verified';
  if ((readiness === 'sandbox_verified' || readiness === 'live_verified') && verifiedState === 'official_test_verified') return 'official_test_verified';
  return 'pending_external_verification';
}
