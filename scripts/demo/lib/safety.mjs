// Target safety for the demo loader. Pure: decides from the environment, the arguments and the database URL whether the
// loader may run, and in which mode. No database or network access here.
//
//   disposable        local database that holds nothing but the demo tenant (the default): full load, then refreshes.
//   demo-tenant-only  explicit --demo-tenant-only: the database may hold other organizations (a SHARED staging
//                     database). The loader only creates or updates rows of the demo tenant, never deletes, truncates or
//                     resets anything, and never touches another organization.
//
// Anything that looks like staging (a non-local host, DEMO_TARGET=staging, NODE_ENV=staging) is refused unless
// --demo-tenant-only is given; production is always refused. There is no reset path in the loader at all.

export const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];
export const KNOWN_FLAGS = ['--demo-tenant-only', '--help'];

export function decideTarget({ env = {}, argv = [], dbUrl }) {
  const unknown = argv.filter((a) => !KNOWN_FLAGS.includes(a));
  if (unknown.length) return { refuse: `unknown argument(s): ${unknown.join(' ')} (allowed: ${KNOWN_FLAGS.join(', ')})` };
  if (env.NODE_ENV === 'production') return { refuse: 'refusing to run with NODE_ENV=production' };
  if (!dbUrl) return { refuse: 'DATABASE_URL is required' };
  let host;
  try { host = new URL(dbUrl).hostname.replace(/^\[|\]$/g, ''); } catch { return { refuse: 'DATABASE_URL is not a valid URL' }; }
  const local = LOCAL_HOSTS.includes(host);
  const demoTenantOnly = argv.includes('--demo-tenant-only');
  if (!local && env.DEMO_TARGET !== 'staging') return { refuse: `refusing non-local database host "${host}" without DEMO_TARGET=staging` };
  const stagingLike = !local || env.DEMO_TARGET === 'staging' || env.NODE_ENV === 'staging';
  if (stagingLike && !demoTenantOnly) {
    return { refuse: 'this target looks like staging (a shared database): run with --demo-tenant-only, which only creates or updates the demo tenant and never deletes or resets anything' };
  }
  return { host, local, stagingLike, demoTenantOnly, mode: demoTenantOnly ? 'demo-tenant-only' : 'disposable' };
}

/**
 * Decides what to do with the database as found. `org` is the row for the demo slug (or undefined), `foreign` the number
 * of organizations that are not demo tenants.
 */
export function decideAction({ target, org, foreign }) {
  if (org && !org.demo) return { refuse: `an organization with the demo slug exists but is not marked as demo data (organization ${org.id}); refusing to touch it` };
  if (!target.demoTenantOnly && foreign > 0) {
    return { refuse: `this database holds ${foreign} non-demo organization(s): use a disposable database, or --demo-tenant-only to load only the demo tenant beside them` };
  }
  if (!org) return { action: 'load' };
  if (org.state === 'complete') return { action: 'refresh' };
  return {
    refuse: `the demo tenant (organization ${org.id}) is left over from an interrupted load (state "${org.state ?? 'unknown'}"). `
      + 'The loader never deletes data; load into a fresh disposable database, or have an operator remove that tenant deliberately.',
  };
}
