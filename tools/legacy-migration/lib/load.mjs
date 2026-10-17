// Writes a migration plan in ONE transaction per tenant, reconciles inside the
// same transaction, and commits only when every reconciliation metric matches
// (or never, for --dry-run). Re-runs are idempotent: every row has a
// deterministic id and is inserted with ON CONFLICT DO NOTHING; identity-keyed
// history rows (events, allocations, audit) are written only together with
// their parent row.

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

export async function loadPlan(client, plan, { dryRun = false, ownerUserId = null, ownerEmail = null, log = () => {} } = {}) {
  const started = Date.now();
  await client.query('begin');
  try {
    await client.query(`select set_config('app.actor', 'legacy-migration', true)`);
    const slugClash = await client.query('select id from organizations where slug = $1 and id <> $2', [plan.slug, plan.orgId]);
    if (slugClash.rowCount) throw new Error(`slug "${plan.slug}" already belongs to another organization (${slugClash.rows[0].id}); pass --slug`);
    const legacyClash = await client.query('select id from organizations where legacy_id = $1 and id <> $2', [plan.restaurantId, plan.orgId]);
    if (legacyClash.rowCount) throw new Error(`legacy restaurant "${plan.restaurantId}" was already migrated as ${legacyClash.rows[0].id}`);
    const existed = (await client.query('select 1 from organizations where id = $1', [plan.orgId])).rowCount > 0;
    if (ownerUserId) {
      await client.query(`insert into profiles(id, email) values ($1, $2) on conflict (id) do nothing`, [ownerUserId, ownerEmail]);
      await client.query(`update profiles set last_org_id = coalesce(last_org_id, $2) where id = $1`, [ownerUserId, plan.orgId]).catch(() => undefined);
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
    for (const u of plan.after) await client.query(u.sql, u.params);
    let mapped = 0;
    for (const m of plan.idMap) {
      const r = await client.query(
        `insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, $2, $3, $4) on conflict (org_id, entity_type, legacy_id) do nothing`,
        [plan.orgId, m.entity, m.legacyId, m.newId]);
      mapped += r.rowCount;
    }
    checkpoints.legacy_id_map = { planned: plan.idMap.length, inserted: mapped, existing: plan.idMap.length - mapped };

    const reconciliation = await reconcile(client, plan);
    const commit = !dryRun && reconciliation.ok;
    await client.query(commit ? 'commit' : 'rollback');
    return {
      orgId: plan.orgId, restaurantId: plan.restaurantId, slug: plan.slug, rerun: existed, dryRun, committed: commit,
      durationMs: Date.now() - started, checkpoints, reconciliation, warnings: plan.warnings,
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
       (select count(*) from customers where org_id = $1)::int as customers`, [plan.orgId]);
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
