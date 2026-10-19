// Provider acceptance checks: executable tests that run against a provider's OFFICIAL TEST environment (or, with
// explicit permission, live) once the owner configures credentials. They are not unit tests: unit and contract tests
// use scripted transports and never call providers. Results are recorded per provider × capability × environment and
// reported separately from mocks and contract tests (docs/INTEGRATION_READINESS.md).
//
// Safety:
// - A check that spends money, sends a message to a real person, publishes or submits to a regulator is `effect`
//   'spend' | 'message' | 'publish' | 'fiscal' and never runs without the matching explicit allowance.
// - Live mode needs --allow-live; nothing silently falls back to a simulator.
// - Credentials come from environment variables named in `requires`; values are never printed (see redact()).
import type { AdapterContext } from '../core';

export type AcceptanceMode = 'official_test' | 'live';
export type AcceptanceEffect = 'read' | 'write_test' | 'spend' | 'message' | 'publish' | 'fiscal';
export type AcceptanceStatus = 'passed' | 'failed' | 'not_run' | 'blocked';

export interface AcceptanceContext {
  mode: AcceptanceMode;
  env: Record<string, string>;
  adapter: AdapterContext;
  /** Record a redacted observation (ids, statuses, HTTP codes). Never pass secrets. */
  evidence(note: string, data?: Record<string, unknown>): void;
}

export interface AcceptanceCheck {
  id: string;
  provider: string;
  capability: string;
  /** Environments this check is valid for. */
  modes: AcceptanceMode[];
  /** Environment variables needed (names only). Missing ones → status not_run. */
  requires: string[];
  effect: AcceptanceEffect;
  /** Manual steps the owner must do first (e.g. "register the webhook URL in the Paymob dashboard"). */
  prerequisites?: string[];
  docsUrl?: string;
  run(ctx: AcceptanceContext): Promise<void>;
}

export interface AcceptanceResult {
  id: string; provider: string; capability: string; mode: AcceptanceMode; status: AcceptanceStatus;
  reason?: string; evidence: Array<{ note: string; data?: Record<string, unknown> }>; startedAt: string; durationMs: number;
}

export interface RunOptions {
  mode: AcceptanceMode;
  env: Record<string, string | undefined>;
  allowLive?: boolean;
  allow?: AcceptanceEffect[];
  fetch?: typeof fetch;
  now?: () => Date;
}

const SECRETISH = /(secret|token|key|password|hmac|signature|authorization|cookie|pan|cvv)/i;
/** Redacts values whose key looks secret and any configured credential value appearing in text. */
export function redact(data: Record<string, unknown> | undefined, secrets: string[]): Record<string, unknown> | undefined {
  if (!data) return data;
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return secrets.reduce((s, x) => (x && x.length >= 6 ? s.split(x).join('[redacted]') : s), v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRETISH.test(k) ? '[redacted]' : scrub(x)]));
    return v;
  };
  return scrub(data) as Record<string, unknown>;
}

export async function runAcceptance(checks: AcceptanceCheck[], opts: RunOptions): Promise<AcceptanceResult[]> {
  const results: AcceptanceResult[] = [];
  const allow = new Set<AcceptanceEffect>(['read', 'write_test', ...(opts.allow ?? [])]);
  const now = opts.now ?? (() => new Date());
  for (const check of checks) {
    const started = now();
    const evidence: AcceptanceResult['evidence'] = [];
    const base = { id: check.id, provider: check.provider, capability: check.capability, mode: opts.mode, startedAt: started.toISOString() };
    const finish = (status: AcceptanceStatus, reason?: string) =>
      results.push({ ...base, status, reason, evidence, durationMs: now().getTime() - started.getTime() });
    if (!check.modes.includes(opts.mode)) { finish('not_run', `check does not apply to ${opts.mode}`); continue; }
    if (opts.mode === 'live' && !opts.allowLive) { finish('blocked', 'live mode needs --allow-live'); continue; }
    if (!allow.has(check.effect)) { finish('blocked', `effect "${check.effect}" needs explicit --allow ${check.effect}`); continue; }
    const missing = check.requires.filter((k) => !opts.env[k]);
    if (missing.length) { finish('not_run', `not configured: ${missing.join(', ')}`); continue; }
    const env = Object.fromEntries(check.requires.map((k) => [k, opts.env[k]!]));
    const secrets = Object.values(env);
    const ctx: AcceptanceContext = {
      mode: opts.mode,
      env,
      adapter: { environment: opts.mode === 'live' ? 'live' : 'sandbox', credentials: env, config: {}, fetch: opts.fetch ?? fetch },
      evidence: (note, data) => evidence.push({ note: redact({ note }, secrets)!.note as string, data: redact(data, secrets) }),
    };
    try {
      await check.run(ctx);
      finish('passed');
    } catch (e) {
      finish('failed', redact({ m: (e as Error).message }, secrets)!.m as string);
    }
  }
  return results;
}

/** Throws with a readable message when a provider response does not match expectations. */
export function expectThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const ACCEPTANCE_CHECKS: AcceptanceCheck[] = [];
/** Providers register their checks here (one module per provider, imported by ./registry). */
export function registerChecks(...checks: AcceptanceCheck[]) {
  for (const c of checks) {
    if (ACCEPTANCE_CHECKS.some((x) => x.id === c.id)) throw new Error(`duplicate acceptance check ${c.id}`);
    ACCEPTANCE_CHECKS.push(c);
  }
}
