// Writes a migration plan in ONE transaction per tenant, reconciles inside the
// same transaction, and commits only when every reconciliation metric matches
// (or never, for --dry-run). Re-runs are idempotent: every row has a
// deterministic id and is inserted with ON CONFLICT DO NOTHING; identity-keyed
// history rows (events, allocations, audit) are written only together with
// their parent row.
//
// Legacy photos (plan.media, CR-13) are copied into tenant storage inside the same run: the bytes come from the
// exported legacy media store (--media-dir: files named by media key), the legacy public/ folder (--assets-dir, for
// assets/… paths and the Smash & Co storefront photos) or the document itself (data: URLs); each file's type is checked
// from its bytes, then it is written to local tenant storage (--storage-dir, the API's STORAGE_LOCAL_DIR) or uploaded
// to Supabase Storage (bucket tenant-media), and recorded in media_assets and products.image_media_id. A photo that
// cannot be found or stored is a reconciliation mismatch (nothing is committed). Files are written before the commit
// at deterministic paths, so a failed run leaves at most files that the next run overwrites.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Parent tables first. */
export const LOAD_ORDER = [
  'organizations', 'branches', 'memberships', 'subscriptions', 'subscription_events', 'tax_profiles',
  'menus', 'menu_categories', 'products', 'product_branch_settings', 'modifier_groups', 'modifier_options', 'product_modifier_groups',
  'floor_layouts', 'dining_tables', 'customers', 'customer_identities', 'reservations', 'visits',
  'orders', 'order_lines', 'order_events', 'service_requests', 'payments', 'payment_allocations', 'refunds',
  'websites', 'website_sections', 'expense_categories', 'order_counters', 'audit_logs',
];
const IDENTITY_TABLES = new Set(['subscription_events', 'order_events', 'payment_allocations', 'audit_logs']);
/** Rows are skipped only when the SAME row exists; any other unique violation (e.g. a QR token used by another tenant) aborts the run. */
const CONFLICT_TARGET = { product_branch_settings: '(product_id, branch_id)', product_modifier_groups: '(product_id, group_id)', order_counters: '(branch_id)' };

/** Detects an image type from its first bytes; null when the bytes are not an image the API serves. */
export function sniffImage(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length > 6 && bytes.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

/** Reads the bytes of one planned legacy photo, or explains why it cannot. */
export function readLegacyMedia(m, { mediaDir = null, assetsDir = null } = {}) {
  const inside = (dir, rel) => { const f = path.resolve(dir, rel); return f.startsWith(path.resolve(dir) + path.sep) ? f : null; };
  let file = null;
  if (m.source.kind === 'inline') return { bytes: Buffer.from(m.source.data, 'base64') };
  if (m.source.kind === 'media') {
    if (!mediaDir) return { error: `legacy media "${m.source.key}" needs --media-dir (the exported legacy media store)` };
    file = inside(mediaDir, m.source.key);
  } else if (m.source.kind === 'asset') {
    if (!assetsDir) return { error: `legacy asset "${m.source.path}" needs --assets-dir (the legacy public/ folder)` };
    file = inside(assetsDir, m.source.path);
  }
  if (!file || !existsSync(file)) return { error: `legacy photo for menu item ${m.legacyItem} not found (${m.source.key ?? m.source.path})` };
  return { bytes: readFileSync(file) };
}

/** Copies the planned legacy photos into tenant storage and records them; returns { copied, problems }. */
async function loadMedia(client, plan, { dryRun, media = {}, log }) {
  const problems = [];
  let copied = 0, inserted = 0;
  for (const m of plan.media ?? []) {
    const { bytes, error } = readLegacyMedia(m, media);
    if (error) { problems.push(error); continue; }
    const type = sniffImage(bytes);
    if (!type || bytes.length > MAX_MEDIA_BYTES) { problems.push(`legacy photo for menu item ${m.legacyItem} is not a supported image (or larger than 15 MB)`); continue; }
    if (!dryRun) {
      if (media.storageDir) {
        const file = path.join(media.storageDir, 'tenant-media', m.objectPath);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      } else if (media.supabase) {
        const res = await (media.fetch ?? fetch)(`${media.supabase.url.replace(/\/$/, '')}/storage/v1/object/tenant-media/${m.objectPath}`, {
          method: 'POST', body: bytes,
          headers: { Authorization: `Bearer ${media.supabase.key}`, apikey: media.supabase.key, 'Content-Type': type, 'x-upsert': 'true' },
        });
        if (!res.ok) { problems.push(`upload of the photo for menu item ${m.legacyItem} failed: HTTP ${res.status}`); continue; }
      } else { problems.push('legacy photos need a destination: --storage-dir (local tenant storage) or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'); break; }
    }
    const row = await client.query(
      `insert into media_assets(id, org_id, path, content_type, byte_size, alt, source) values ($1, $2, $3, $4, $5, $6, 'legacy') on conflict (id) do nothing`,
      [m.id, plan.orgId, m.objectPath, type, bytes.length, m.alt]);
    inserted += row.rowCount;
    await client.query(`update products set image_media_id = $2 where id = $1 and org_id = $3 and image_media_id is null`, [m.productId, m.id, plan.orgId]);
    copied++;
  }
  if ((plan.media ?? []).length) log(`  media: ${copied}/${plan.media.length} legacy photo(s) copied${problems.length ? `; ${problems.length} problem(s)` : ''}`);
  return { copied, inserted, problems };
}

export async function loadPlan(client, plan, { dryRun = false, ownerUserId = null, ownerEmail = null, log = () => {}, media = {} } = {}) {
  const started = Date.now();
  await client.query('begin');
  try {
    await client.query(`select set_config('app.actor', 'legacy-migration', true)`);
    const slugClash = await client.query('select id from organizations where slug = $1 and id <> $2', [plan.slug, plan.orgId]);
    if (slugClash.rowCount) throw new Error(`slug "${plan.slug}" already belongs to another organization (${slugClash.rows[0].id}); pass --slug`);
    const legacyClash = await client.query('select id from organizations where legacy_id = $1 and id <> $2', [plan.restaurantId, plan.orgId]);
    if (legacyClash.rowCount) throw new Error(`legacy restaurant "${plan.restaurantId}" was already migrated as ${legacyClash.rows[0].id}`);
    const existed = (await client.query('select 1 from organizations where id = $1', [plan.orgId])).rowCount > 0;
    // A printed venue QR must resolve to exactly one restaurant (GET /v1/public/venue/:token).
    const venue = plan.idMap.filter((m) => m.entity === 'venue_qr').map((m) => m.legacyId);
    if (venue.length) {
      const clash = await client.query(`select org_id from legacy_id_map where entity_type = 'venue_qr' and legacy_id = any($1) and org_id <> $2 limit 1`, [venue, plan.orgId]);
      if (clash.rowCount) throw new Error(`venue QR token already belongs to another organization (${clash.rows[0].org_id}); printed codes cannot point to two restaurants`);
    }
    if (ownerUserId) {
      await client.query(`insert into profiles(id, email) values ($1, $2) on conflict (id) do nothing`, [ownerUserId, ownerEmail]);
    }

    const inserted = new Set();
    const checkpoints = {};
    for (const table of LOAD_ORDER) {
      const rows = plan.rows[table] ?? [];
      const cp = (checkpoints[table] = { planned: rows.length, inserted: 0, existing: 0 });
      for (const row of rows) {
        const { _parent, ...data } = row;
        if (IDENTITY_TABLES.has(table) && !inserted.has(_parent)) { cp.existing++; continue; }
        const cols = Object.keys(data);
        const target = data.id ? '(id)' : CONFLICT_TARGET[table];
        const conflict = IDENTITY_TABLES.has(table) ? '' : `on conflict ${target ?? ''} do nothing`;
        const res = await client.query(
          `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ${conflict}`,
          cols.map((c) => data[c]));
        if (res.rowCount) { cp.inserted++; if (data.id) inserted.add(data.id); } else cp.existing++;
      }
      if (rows.length) log(`  ${table}: ${cp.inserted} inserted, ${cp.existing} already present`);
    }
    if (plan.rows.organizations?.length && !inserted.has(plan.orgId) && !existed) throw new Error('organization row was not written');
    const mediaResult = await loadMedia(client, plan, { dryRun, media, log });
    checkpoints.media = { planned: (plan.media ?? []).length, inserted: mediaResult.inserted, existing: mediaResult.copied - mediaResult.inserted,
      copied: mediaResult.copied, problems: mediaResult.problems };
    for (const u of plan.after) await client.query(u.sql, u.params);
    if (ownerUserId) await client.query(`update profiles set last_org_id = coalesce(last_org_id, $2) where id = $1`, [ownerUserId, plan.orgId]);
    let mapped = 0;
    let remapped = 0;
    for (const m of plan.idMap) {
      const r = await client.query(
        `insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, $2, $3, $4) on conflict (org_id, entity_type, legacy_id) do nothing`,
        [plan.orgId, m.entity, m.legacyId, m.newId]);
      mapped += r.rowCount;
      // Earlier versions of this tool mapped the venue QR to the organization; the public venue route resolves a
      // branch, so a re-run moves such a row to the planned branch (only rows that point at the organization itself).
      if (!r.rowCount && m.entity === 'venue_qr') {
        remapped += (await client.query(`update legacy_id_map set new_id = $4 where org_id = $1 and entity_type = $2 and legacy_id = $3 and new_id = $1`,
          [plan.orgId, m.entity, m.legacyId, m.newId])).rowCount;
      }
    }
    checkpoints.legacy_id_map = { planned: plan.idMap.length, inserted: mapped, existing: plan.idMap.length - mapped, remapped };
    if (remapped) log(`  legacy_id_map: ${remapped} venue QR token(s) moved from the organization to its branch`);

    const reconciliation = await reconcile(client, plan);
    const commit = !dryRun && reconciliation.ok;
    await client.query(commit ? 'commit' : 'rollback');
    return {
      orgId: plan.orgId, restaurantId: plan.restaurantId, slug: plan.slug, rerun: existed, dryRun, committed: commit,
      durationMs: Date.now() - started, checkpoints, reconciliation, warnings: [...plan.warnings, ...mediaResult.problems],
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

const sortC = (xs) => [...(xs ?? [])].sort();

/** Counts and money sums per entity, legacy vs migrated (read inside the load transaction). */
export async function reconcile(client, plan) {
  const { rows: [m] } = await client.query(
    `select
       (select count(*) from branches where org_id = $1)::int as branches,
       (select count(*) from menu_categories where org_id = $1)::int as menu_categories,
       (select count(*) from products where org_id = $1)::int as products,
       (select count(*) from modifier_options where org_id = $1)::int as modifier_options,
       (select count(*) from dining_tables where org_id = $1)::int as tables,
       (select coalesce(array_agg(qr_token), '{}') from dining_tables where org_id = $1) as qr_tokens,
       (select coalesce(sum(jsonb_array_length(zones)), 0) from floor_layouts where org_id = $1)::int as floor_zones,
       (select coalesce(sum(jsonb_array_length(objects)), 0) from floor_layouts where org_id = $1)::int as floor_objects,
       (select count(*) from visits where org_id = $1)::int as visits,
       (select count(*) from orders where org_id = $1)::int as orders,
       (select count(*) from order_lines where org_id = $1)::int as order_lines,
       (select coalesce(sum(subtotal_minor), 0) from orders where org_id = $1)::bigint as order_items_minor,
       (select coalesce(sum(total_minor), 0) from orders where org_id = $1)::bigint as order_totals_minor,
       (select coalesce(sum(paid_minor), 0) from orders where org_id = $1)::bigint as orders_settled_minor,
       (select count(*) from payments where org_id = $1 and raw->'legacy'->>'kind' = 'bill')::int as bill_payments,
       (select coalesce(sum(amount_minor), 0) from payments where org_id = $1 and raw->'legacy'->>'kind' = 'bill')::bigint as bill_payments_minor,
       (select count(*) from payments where org_id = $1 and raw->'legacy'->>'kind' = 'deposit')::int as deposit_payments,
       (select coalesce(sum(amount_minor), 0) from payments where org_id = $1 and raw->'legacy'->>'kind' = 'deposit')::bigint as deposit_payments_minor,
       (select coalesce(sum(amount_minor), 0) from refunds where org_id = $1)::bigint as deposit_refunds_minor,
       (select coalesce(array_agg(provider_payment_id), '{}') from payments where org_id = $1 and provider_payment_id is not null
          and raw->'legacy'->>'kind' in ('bill', 'deposit')) as provider_references,
       (select count(*) from reservations where org_id = $1)::int as reservations,
       (select coalesce(sum(deposit_minor), 0) from reservations where org_id = $1)::bigint as reservation_deposits_minor,
       (select count(*) from service_requests where org_id = $1)::int as service_requests,
       (select count(*) from customers where org_id = $1)::int as customers,
       (select count(*) from media_assets a where a.org_id = $1 and a.id = any($2::uuid[])
          and exists (select 1 from products p where p.org_id = $1 and p.image_media_id = a.id))::int as media,
       -- a venue token counts only when it resolves the way GET /v1/public/venue/:token does: to an active branch of the org
       (select coalesce(array_agg(m.legacy_id), '{}') from legacy_id_map m join branches b on b.id = m.new_id and b.org_id = m.org_id and b.is_active
         where m.org_id = $1 and m.entity_type = 'venue_qr') as venue_qr_tokens`,
    [plan.orgId, (plan.media ?? []).map((x) => x.id)]);
  const metrics = Object.entries(plan.legacy).map(([name, legacy]) => {
    let migrated = m[name];
    if (Array.isArray(legacy)) {
      migrated = sortC(migrated);
      const l = sortC(legacy);
      return { name, legacy: l.length, migrated: migrated.length, match: JSON.stringify(l) === JSON.stringify(migrated), kind: 'set' };
    }
    migrated = Number(migrated);
    return { name, legacy, migrated, match: legacy === migrated, kind: name.endsWith('_minor') ? 'money' : 'count' };
  });
  const mismatches = metrics.filter((x) => !x.match);
  return { ok: mismatches.length === 0, mismatches: mismatches.length, metrics };
}

/**
 * Deletes a migrated tenant. Legacy data is never touched. Refuses when the
 * organization was not created by this tool, or when it already holds orders
 * that did not come from the migration (unless force).
 */
export async function rollbackTenant(client, orgId, { force = false } = {}) {
  await client.query('begin');
  try {
    const { rows: [org] } = await client.query('select id, slug, legacy_id from organizations where id = $1 for update', [orgId]);
    if (!org) throw new Error(`organization ${orgId} not found`);
    const { rows: [{ n: mapped }] } = await client.query('select count(*)::int as n from legacy_id_map where org_id = $1', [orgId]);
    if (!org.legacy_id || !mapped) throw new Error(`organization ${orgId} was not created by the legacy migration; refusing to delete it`);
    const { rows: [{ n: native }] } = await client.query('select count(*)::int as n from orders where org_id = $1 and legacy_id is null', [orgId]);
    if (native && !force) throw new Error(`organization ${orgId} has ${native} order(s) created after migration; re-run with --force to delete them too`);
    // RESTRICT / NO ACTION references inside the tenant are cleared before the organization cascade.
    await client.query('delete from order_lines where org_id = $1', [orgId]);
    await client.query('delete from recipe_components where org_id = $1', [orgId]);
    await client.query('delete from products where org_id = $1', [orgId]);
    await client.query('delete from organizations where id = $1', [orgId]);
    await client.query('commit');
    return { orgId, slug: org.slug, restaurantId: org.legacy_id, deleted: true, mappedRows: mapped, nativeOrdersDeleted: native };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}
