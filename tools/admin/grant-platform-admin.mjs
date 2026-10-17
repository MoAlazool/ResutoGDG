#!/usr/bin/env node
// Grants (or revokes) Resuto platform-admin access for an existing account.
// Local / staging bootstrap only: platform admins are Resuto staff, never
// restaurant members, and act only through the audited /v1/admin routes.
//
//   node tools/admin/grant-platform-admin.mjs <email> [superadmin|support|finance]
//   node tools/admin/grant-platform-admin.mjs <email> --revoke
//
// DATABASE_URL defaults to the local cluster. A non-local database is refused
// unless --confirm-remote is passed explicitly.
import pg from 'pg';

const ROLES = ['superadmin', 'support', 'finance'];
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [email, role = 'support'] = args.filter((a) => !a.startsWith('--'));
const url = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto';

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: grant-platform-admin.mjs <email> [superadmin|support|finance] [--revoke] [--confirm-remote]');
  process.exit(2);
}

if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) usage('an account email is required');
if (!flags.has('--revoke') && !ROLES.includes(role)) usage(`role must be one of ${ROLES.join(', ')}`);
for (const f of flags) if (!['--revoke', '--confirm-remote'].includes(f)) usage(`unknown flag ${f}`);

const host = new URL(url).hostname;
const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!local && !flags.has('--confirm-remote')) {
  console.error(`Refusing to change platform admins on non-local database host "${host}". Re-run with --confirm-remote if this is intended.`);
  process.exit(3);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows: [user] } = await client.query('select id from auth.users where lower(email) = lower($1)', [email]);
  if (!user) {
    console.error(`No account with email ${email}. Sign up first (in dev mode: POST /v1/auth/dev/signup).`);
    process.exit(4);
  }
  if (flags.has('--revoke')) {
    const r = await client.query('delete from platform_admins where user_id = $1', [user.id]);
    console.log(r.rowCount ? `Revoked platform-admin access for ${email}.` : `${email} was not a platform admin.`);
  } else {
    await client.query(
      `insert into platform_admins(user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role`, [user.id, role]);
    console.log(`${email} is now a platform ${role}${local ? '' : ` on ${host}`}.`);
  }
  await client.query(
    `insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
     values (null, 'system', 'tools/admin/grant-platform-admin', $1, 'platform_admin', $2, 'migration', $3)`,
    [flags.has('--revoke') ? 'platform_admin.revoked' : 'platform_admin.granted', user.id, { email, role: flags.has('--revoke') ? null : role, host }]);
} finally {
  await client.end();
}
