// Single-runner lease for the demo loader. On staging the loader starts on every boot (DEMO_SEED_ON_BOOT), so two
// instances (a deploy overlapping the old one, a restart loop) could refresh the same tenant at once. The lease is a row
// in job_leases, the table the API's scheduler already uses for its single-runner jobs: it holds no session state, so it
// works through a transaction pooler (a session advisory lock would not), and it expires on its own if the holder dies.
//
// `q(text, params)` returns rows (a pg Pool wrapper).
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

/** Short, renewed every RENEW_SECONDS while the run is alive: a run that was killed frees the tenant within minutes. */
export const LEASE_SECONDS = 180;
export const RENEW_SECONDS = 30;
export const leaseName = (slug) => `demo-loader:${slug}`;

/** Claims the lease. Returns { owner } or { heldBy, until } when another run holds it. */
export async function claimLease(q, slug, { seconds = LEASE_SECONDS, owner = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}` } = {}) {
  const job = leaseName(slug);
  await q(`insert into job_leases(job) values ($1) on conflict do nothing`, [job]);
  const [claimed] = await q(`update job_leases set owner = $2, locked_until = now() + make_interval(secs => $3), last_started_at = now()
                              where job = $1 and locked_until <= now() returning job`, [job, owner, seconds]);
  if (claimed) return { owner };
  const [held] = await q(`select owner, locked_until from job_leases where job = $1`, [job]);
  return { heldBy: held?.owner ?? null, until: held?.locked_until ?? null };
}

/** Extends the lease; false when it was lost (expired and taken by another run). */
export async function renewLease(q, slug, owner, { seconds = LEASE_SECONDS } = {}) {
  const rows = await q(`update job_leases set locked_until = now() + make_interval(secs => $3) where job = $1 and owner = $2 and locked_until > now() returning job`,
    [leaseName(slug), owner, seconds]);
  return rows.length === 1;
}

/** Frees the lease and records how the run ended ('succeeded' | 'failed'). */
export async function releaseLease(q, slug, owner, status) {
  await q(`update job_leases set locked_until = now(), last_finished_at = now(), last_status = $3 where job = $1 and owner = $2`, [leaseName(slug), owner, status]);
}
