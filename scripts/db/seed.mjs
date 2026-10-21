#!/usr/bin/env node
// `pnpm db:seed` — LOCAL DEMO DATA ONLY.
//
// Creates the demo tenant "The Olive Room" (Egypt) by running the legacy
// migration tool on the sanitized fixture, plus:
//   * a demo owner account and a local platform superadmin (AUTH_DEV_MODE
//     email/password accounts; passwords are generated and printed ONCE),
//   * a complimentary Pro subscription (demo access — nothing is charged),
//   * a photo for every dish (the eight Olive Room dishes and the nine Smash & Co items) and the website hero
//     (media_assets in local storage),
//   * Arabic names for the restaurant and every menu category.
// The legacy fixture is RE-TIMED to the load (its latest activity lands half an hour ago) and work that would be
// stale by then (orders in progress, open visits and calls, past bookings that never arrived) is imported as
// closed history (audit DF-10). After loading, the demo integrity check (scripts/demo/integrity-check.mjs,
// profile "migration") must pass, or the seed exits 1.
// Idempotent: re-running keeps existing accounts and data (`--reset-passwords`
// issues new demo passwords).
//
// For the full demo (8 weeks of history, finance, delivery, the Smash & Co storefront) use
// scripts/demo/load-demo-data.mjs against a running API instead; see scripts/demo/README.md.
//
// Refuses any non-local DATABASE_URL. Storage files go to STORAGE_LOCAL_DIR
// resolved like the API does when started from apps/api (default apps/api/.local/storage).
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { migrate } from './migrate.mjs';
import { legacyName, uuidv5 } from '../../tools/legacy-migration/lib/ids.mjs';
import { formatReport, migrateLegacy } from '../../tools/legacy-migration/migrate.mjs';
import { checkDemoIntegrity, formatIntegrity, LIVE_STALE_HOURS } from '../demo/integrity-check.mjs';

const scrypt = promisify(scryptCb);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const url = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto';
const host = new URL(url).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`Refusing to seed demo data into non-local database host "${host}".`);
  process.exit(2);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production.');
  process.exit(2);
}

const config = JSON.parse(readFileSync(path.join(root, 'supabase/seeds/olive-room.demo.json'), 'utf8'));
const storageDir = path.resolve(root, 'apps/api', process.env.STORAGE_LOCAL_DIR ?? '.local/storage');

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;   // same format as the API dev issuer
}

const resetPasswords = process.argv.includes('--reset-passwords');

/** Creates a dev-auth account if missing (or resets its password with --reset-passwords); returns { id, password|null }. */
async function ensureAccount(client, { email, fullName }) {
  const { rows: [existing] } = await client.query('select id from auth.users where lower(email) = lower($1)', [email]);
  const password = `demo-${randomBytes(9).toString('base64url')}`;
  if (existing && !resetPasswords) return { id: existing.id, password: null };
  if (existing) {
    await client.query('update auth.users set encrypted_password = $2 where id = $1', [existing.id, await hashPassword(password)]);
    return { id: existing.id, password };
  }
  const { rows: [u] } = await client.query(
    `insert into auth.users(email, encrypted_password, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3) returning id`,
    [email.toLowerCase(), await hashPassword(password), { full_name: fullName, demo: true }]);
  await client.query(`insert into profiles(id, full_name, email) values ($1, $2, $3) on conflict (id) do nothing`, [u.id, fullName, email.toLowerCase()]);
  return { id: u.id, password };
}

await migrate({ url, log: () => {} });
const client = new pg.Client({ connectionString: url });
await client.connect();
const created = [];
let admin;
try {
  const owner = await ensureAccount(client, config.owner);
  if (owner.password) created.push({ role: 'restaurant owner', email: config.owner.email, password: owner.password });
  admin = await ensureAccount(client, config.platformAdmin);
  if (admin.password) created.push({ role: `platform ${config.platformAdmin.role} (local only)`, email: config.platformAdmin.email, password: admin.password });
  await client.query(`insert into platform_admins(user_id, role) values ($1, $2) on conflict (user_id) do nothing`, [admin.id, config.platformAdmin.role]);
  // Printed immediately so a later failure can never lose them.
  if (created.length) {
    console.log('\nNew local DEMO accounts (shown once — store them now; sign in with AUTH_DEV_MODE=true):');
    for (const c of created) console.log(`  ${c.role.padEnd(36)} ${c.email}  /  ${c.password}`);
  }
} finally {
  await client.end();
}

const document = JSON.parse(readFileSync(path.join(root, config.fixture), 'utf8'));
const report = await migrateLegacy({
  url, document,
  options: { restaurantId: config.restaurantId, slug: config.slug, planId: config.planId, subscriptionStatus: config.subscriptionStatus,
    ownerEmail: config.owner.email, subscriptionNote: 'Demo tenant: complimentary Pro access, no payment collected.',
    nameAr: config.nameAr, categoryNamesAr: config.categoryNamesAr,
    retimeTo: new Date(Date.now() - 30 * 60_000), closeStaleAfterHours: LIVE_STALE_HOURS },
  // Legacy photos (the Smash & Co storefront's) are copied into local tenant storage by the migration (CR-13).
  media: { assetsDir: path.join(root, 'legacy/public'), storageDir },
});
if (!report.committed) {
  console.error(formatReport(report));
  console.error('Seeding failed: the migration did not reconcile.');
  process.exit(1);
}

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  await db.query('begin');
  const orgId = report.orgId;
  await db.query(`update organizations set onboarding = onboarding || '{"demo": true}'::jsonb where id = $1`, [orgId]);
  const { rows: [sub] } = await db.query(`select id from subscriptions where org_id = $1 and status <> 'canceled'`, [orgId]);
  const { rowCount: hasEvent } = await db.query(`select 1 from subscription_events where org_id = $1 and event_type = 'demo_complimentary'`, [orgId]);
  if (sub && !hasEvent) {
    await db.query(`insert into subscription_events(org_id, subscription_id, event_type, to_plan_id, details) values ($1, $2, 'demo_complimentary', $3, $4)`,
      [orgId, sub.id, config.planId, { note: 'Demo data: complimentary access, nothing charged, no billing provider.' }]);
  }
  // Arabic names (also for a tenant seeded before they were part of the plan).
  await db.query(`update organizations set name_ar = $2 where id = $1 and coalesce(btrim(name_ar), '') = ''`, [orgId, config.nameAr]);
  for (const [name, nameAr] of Object.entries(config.categoryNamesAr)) {
    await db.query(`update menu_categories set name_ar = $3 where org_id = $1 and name = $2 and coalesce(btrim(name_ar), '') = ''`, [orgId, name, nameAr]);
  }
  /** Writes a seed image into local tenant storage and records it; returns the media id. */
  const storeMedia = async (key, rel, objectPath, alt) => {
    const bytes = readFileSync(path.join(root, 'supabase/seeds', rel));
    const file = path.join(storageDir, 'tenant-media', objectPath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const mediaId = uuidv5(legacyName(config.restaurantId, 'media', key));
    await db.query(
      `insert into media_assets(id, org_id, path, content_type, byte_size, width, height, alt, source) values ($1, $2, $3, 'image/webp', $4, 512, 384, $5, 'legacy')
       on conflict (id) do nothing`, [mediaId, orgId, objectPath, bytes.length, alt]);
    return mediaId;
  };
  const hero = await storeMedia('website:hero', config.websiteHero.path, `${orgId}/website/legacy-hero.webp`, config.websiteHero.alt);
  await db.query(`update websites set theme = coalesce(theme, '{}'::jsonb) || jsonb_build_object('heroMediaId', $2::text)
                   where org_id = $1 and coalesce(theme->>'heroMediaId', '') = ''`, [orgId, hero]);
  let photos = 0;
  for (const [legacyId, rel] of [...Object.entries(config.photos), ...Object.entries(config.smash.photos)]) {
    if (legacyId.startsWith('_')) continue;
    const { rows: [product] } = await db.query(`select id, name from products where org_id = $1 and legacy_id = $2`, [orgId, legacyId]);
    if (!product) continue;
    const mediaId = await storeMedia(`menu:${legacyId}`, rel, `${orgId}/menu/legacy-${legacyId}.webp`, product.name);
    const r = await db.query(`update products set image_media_id = $2 where id = $1 and image_media_id is null`, [product.id, mediaId]);
    photos += r.rowCount;
  }
  await db.query(
    `insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
     values ($1, 'system', 'scripts/db/seed.mjs', 'demo.seeded', 'organization', $2, 'migration', $3)`, [orgId, orgId, { photosLinked: photos, demo: true }]);
  await db.query('commit');
  const integrity = await checkDemoIntegrity(async (t, p) => (await db.query(t, p)).rows, { slug: config.slug, profile: 'migration' });
  console.log(formatIntegrity(integrity));
  if (!integrity.ok) process.exitCode = 1;

  console.log(`\nDEMO DATA — The Olive Room (${config.slug})  organization ${orgId}`);
  console.log(`  migration: ${report.rerun ? 're-run (no changes)' : 'created'}; reconciliation ${report.reconciliation.metrics.length}/${report.reconciliation.metrics.length} metrics match`);
  console.log(`  subscription: ${config.planId} (${config.subscriptionStatus}, complimentary demo access — nothing is charged)`);
  console.log(`  menu photos: ${photos} linked now; files in ${path.relative(root, storageDir)}`);
  console.log(`  dashboard: http://localhost:3000/dashboard/${orgId}   admin console: http://localhost:3000/admin`);
  if (!created.length) console.log('\n  Demo accounts already existed; passwords were not changed (use --reset-passwords to issue new ones).');
} catch (e) {
  await db.query('rollback').catch(() => undefined);
  throw e;
} finally {
  await db.end();
}
