import { Injectable } from '@nestjs/common';
import type { CustomerListQuery, CustomerProfile, CustomerSummary } from '@resuto/contracts';
import type { anonymiseInput, consentUpdate, customerUpdate } from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { conflict, forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { branchScope, int, iso } from '../analytics/scope';
import { escapeLike } from '../mcp/mcp.util';

/** Orders that count towards customer value: confirmed and not cancelled. */
const COUNTED = `o.status not in ('cancelled', 'awaiting_payment')`;
const EXPORT_LIMIT = 50_000;

type Sort = CustomerListQuery['sort'];
type Mode = 'org' | 'branch';

/**
 * Keyset sorts (PCL-17). Each sort is a tuple compared as a row value, so a page seeks straight into the matching
 * index instead of skipping OFFSET rows: organization-wide lists walk customer_stats_{last_order,spend,orders}_idx,
 * name and created walk the customers indexes. `key` is selected with every row so the cursor carries the exact
 * value (timestamps as text, never through a JS Date). Ties break on the customer id in the same direction.
 * Branch-scoped lists aggregate customer_branch_stats per customer (customers without orders there sort last).
 */
const SORT_KEYS: Record<Sort, { dir: 'desc' | 'asc'; cols: (m: Mode) => string[]; casts: string[] }> = {
  last_order: { dir: 'desc', cols: (m) => [`coalesce(a.last_order_at, '-infinity'::timestamptz)`, idCol(m)], casts: ['timestamptz', 'uuid'] },
  spend: { dir: 'desc', cols: (m) => [m === 'org' ? 'a.spend_minor' : 'coalesce(a.spend_minor, 0)', idCol(m)], casts: ['bigint', 'uuid'] },
  orders: { dir: 'desc', cols: (m) => [m === 'org' ? 'a.order_count' : 'coalesce(a.order_count, 0)', idCol(m)], casts: ['int', 'uuid'] },
  name: { dir: 'asc', cols: () => ['(c.display_name is null)', `coalesce(lower(c.display_name), '')`, 'c.id'], casts: ['boolean', 'text', 'uuid'] },
  created: { dir: 'desc', cols: () => ['c.created_at', 'c.id'], casts: ['timestamptz', 'uuid'] },
};
function idCol(m: Mode) { return m === 'org' ? 'a.customer_id' : 'c.id'; }

/** Opaque keyset cursor: "k" + base64url(JSON [sort, ...key values]). Plain digits are a legacy OFFSET cursor. */
function encodeCursor(sort: Sort, key: unknown[]) {
  return 'k' + Buffer.from(JSON.stringify([sort, ...key])).toString('base64url');
}
function decodeCursor(sort: Sort, cursor: string): unknown[] {
  try {
    const [s, ...key] = JSON.parse(Buffer.from(cursor.slice(1), 'base64url').toString('utf8')) as [string, ...unknown[]];
    if (s === sort && key.length === SORT_KEYS[sort].casts.length && key.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) return key;
  } catch { /* fall through */ }
  throw invalid('invalid_cursor', 'Invalid cursor');
}

/**
 * CRM read model and the customer-owned mutations (profile edits, consent,
 * anonymisation, merge). Order totals are always computed from orders.
 * Branch-scoped staff only see customers who ordered or booked in their branches.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly audit: AuditService) {}

  /**
   * FROM/WHERE for list, count, export and profile. Organization-wide callers join customer_stats (every customer has
   * a row; triggers keep it exact); branch-scoped callers aggregate customer_branch_stats for their branches.
   * `a` exposes order_count, spend_minor, last_order_at, first_order_at, any_orders either way.
   */
  private filterSql(ctx: TenantContext, q: Partial<CustomerListQuery>, opts: { countOnly?: boolean } = {}) {
    const scope = branchScope(ctx, q.branchId);
    const mode: Mode = scope === null ? 'org' : 'branch';
    const qText = q.q?.trim() ? escapeLike(q.q.trim()) : null;
    const digits = qText ? qText.replace(/\D/g, '') : '';
    const params: unknown[] = [
      ctx.orgId, scope, qText, digits.length >= 3 ? digits : null, q.tag ?? null,
      q.consent === undefined ? null : q.consent === 'granted', q.lastOrderBefore ?? null, q.lastOrderAfter ?? null,
      q.minOrders ?? null, q.minSpendMinor ?? null, q.includeAnonymised === 'true', scope !== null,
    ];
    const stats = mode === 'org'
      // The list walks the stats indexes (inner join, org_id repeated for the index); a bare count joins nothing.
      ? `${opts.countOnly ? 'left ' : ''}join customer_stats a on a.customer_id = c.id${opts.countOnly ? '' : ' and a.org_id = $1'}`
      : `left join lateral (
           select sum(b.order_count)::int as order_count, sum(b.spend_minor)::bigint as spend_minor, max(b.last_order_at) as last_order_at,
                  min(b.first_order_at) as first_order_at, sum(b.any_orders)::int as any_orders
             from customer_branch_stats b where b.customer_id = c.id and b.branch_id = any($2)
         ) a on true`;
    const sql = `
      from customers c
      join organizations org on org.id = c.org_id
      ${stats}
      where c.org_id = $1 and c.merged_into_id is null and ($11 or c.anonymized_at is null)
        and ($3::text is null or c.display_name ilike '%' || $3 || '%' or c.email::text ilike '%' || $3 || '%'
             or ($4::text is not null and c.phone_e164 like '%' || $4 || '%'))
        and ($5::text is null or $5 = any(c.tags))
        and ($6::boolean is null or c.marketing_consent = $6)
        and ($7::date is null or (a.last_order_at at time zone org.timezone)::date < $7)
        and ($8::date is null or (a.last_order_at at time zone org.timezone)::date >= $8)
        and ($9::int is null or coalesce(a.order_count, 0) >= $9)
        and ($10::bigint is null or coalesce(a.spend_minor, 0) >= $10)
        and (not $12 or a.any_orders > 0 or exists (
              select 1 from reservations r where r.customer_id = c.id and r.branch_id = any($2)))`;
    return { sql, params, mode };
  }

  private order(sort: Sort, mode: Mode) {
    const k = SORT_KEYS[sort];
    return k.cols(mode).map((c) => `${c} ${k.dir}`).join(', ');
  }

  /** Key columns of the sort, selected as text/number so a cursor round-trips exactly. */
  private keySelect(sort: Sort, mode: Mode) {
    return SORT_KEYS[sort].cols(mode).map((c, i) => `(${c})${SORT_KEYS[sort].casts[i] === 'timestamptz' ? '::text' : ''} as _k${i}`).join(', ');
  }

  async list(tx: Tx, ctx: TenantContext, q: CustomerListQuery) {
    const { sql, params, mode } = this.filterSql(ctx, q);
    const k = SORT_KEYS[q.sort];
    // Legacy numeric cursors (issued before keyset paging) keep working as offsets.
    const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
    const after = q.cursor && !/^\d+$/.test(q.cursor) ? decodeCursor(q.sort, q.cursor) : null;
    const seek = after
      ? ` and (${k.cols(mode).join(', ')}) ${k.dir === 'desc' ? '<' : '>'} (${after.map((_, i) => `$${params.length + 3 + i}::${k.casts[i]}`).join(', ')})`
      : '';
    const rows = await tx.query(
      `select c.*, a.order_count, a.spend_minor, a.last_order_at, a.first_order_at, ${this.keySelect(q.sort, mode)} ${sql}${seek}
        order by ${this.order(q.sort, mode)} limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, q.limit + 1, offset, ...(after ?? [])]);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > q.limit ? encodeCursor(q.sort, k.casts.map((_, i) => last[`_k${i}`])) : null;
    const { sql: countSql, params: countParams } = this.filterSql(ctx, q, { countOnly: true });
    const total = await tx.one<{ n: number }>(`select count(*)::int as n ${countSql}`, countParams);
    return { items: page.map(mapSummary), nextCursor, total: total.n };
  }

  /** CSV with the minimum PII needed for outreach. Caller must hold customers:export; audited. */
  async exportCsv(tx: Tx, ctx: TenantContext, q: CustomerListQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
    const { sql, params, mode } = this.filterSql(ctx, { ...q, includeAnonymised: 'false' });
    const rows = await tx.query(
      `select c.*, a.order_count, a.spend_minor, a.last_order_at, a.first_order_at ${sql} order by ${this.order(q.sort, mode)} limit $${params.length + 1}`,
      [...params, EXPORT_LIMIT + 1]);
    const truncated = rows.length > EXPORT_LIMIT;
    const items = rows.slice(0, EXPORT_LIMIT).map(mapSummary);
    const header = ['id', 'display_name', 'phone', 'email', 'marketing_consent', 'marketing_consent_at', 'marketing_consent_source', 'tags', 'order_count', 'total_spend_minor', 'last_order_at'];
    const lines = [header.join(',')];
    for (const c of items) {
      lines.push([c.id, c.displayName, c.phone, c.email, c.marketingConsent, c.marketingConsentAt, c.marketingConsentSource, c.tags.join(';'),
        c.orderCount, c.totalSpendMinor, c.lastOrderAt].map(csvCell).join(','));
    }
    const { cursor: _c, limit: _l, ...filters } = q;
    await this.audit.record(tx, ctx, { action: 'customers.exported', entityType: 'customer', metadata: { filters, rows: items.length, truncated,
      columns: header } });
    return { csv: lines.join('\r\n') + '\r\n', rows: items.length, truncated };
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<CustomerProfile> {
    const scope = branchScope(ctx);
    const { sql, params } = this.filterSql(ctx, { includeAnonymised: 'true' });
    const c = await tx.maybeOne(`select c.*, a.order_count, a.spend_minor, a.last_order_at, a.first_order_at ${sql} and c.id = $${params.length + 1}`, [...params, id]);
    if (!c) {
      // A merged duplicate points to its survivor.
      const merged = await tx.maybeOne<{ merged_into_id: string }>(`select merged_into_id from customers where id = $1 and org_id = $2 and merged_into_id is not null`, [id, ctx.orgId]);
      if (merged) throw conflict('customer_merged', 'This customer was merged into another profile', { mergedIntoId: merged.merged_into_id });
      throw notFound('Customer');
    }
    const [identities, addresses, orders, totals, reservations, consent, currency] = await Promise.all([
      tx.query(`select id, kind, value, verified_at from customer_identities where customer_id = $1 order by created_at`, [id]),
      tx.query(`select id, label, line1, area, city, notes from customer_addresses where customer_id = $1 order by created_at desc`, [id]),
      tx.query(`select id, number, branch_id, channel, fulfillment, status, payment_status, total_minor, refunded_minor, placed_at
                  from orders o where customer_id = $1 and ($2::uuid[] is null or branch_id = any($2)) order by placed_at desc limit 50`, [id, scope]),
      tx.one(`select count(*) filter (where ${COUNTED})::int as order_count, count(*) filter (where o.status = 'cancelled')::int as cancelled,
                     coalesce(sum(o.total_minor) filter (where ${COUNTED}), 0)::bigint as gross,
                     coalesce(sum(o.refunded_minor) filter (where ${COUNTED}), 0)::bigint as refunded
                from orders o where o.customer_id = $1 and ($2::uuid[] is null or o.branch_id = any($2))`, [id, scope]),
      tx.query(`select id, code, branch_id, starts_at, party_size, status from reservations
                 where customer_id = $1 and ($2::uuid[] is null or branch_id = any($2)) order by starts_at desc limit 50`, [id, scope]),
      tx.query(`select id, granted, source, note, actor, occurred_at from customer_consent_events where customer_id = $1 order by occurred_at desc, id`, [id]),
      tx.one<{ currency: string }>(`select currency from organizations where id = $1`, [ctx.orgId]),
    ]);
    const gross = int(totals.gross);
    const refunded = int(totals.refunded);
    return {
      ...mapSummary(c),
      notes: c.notes,
      identities: identities.map((i) => ({ id: i.id, kind: i.kind, value: i.value, verifiedAt: iso(i.verified_at) })),
      addresses: addresses.map((a) => ({ id: a.id, label: a.label, line1: a.line1, area: a.area, city: a.city, notes: a.notes })),
      totals: { orderCount: totals.order_count, cancelledCount: totals.cancelled, grossMinor: gross, refundedMinor: refunded, netMinor: gross - refunded,
        averageOrderMinor: totals.order_count ? Math.round(gross / totals.order_count) : 0, currency: currency.currency },
      orders: orders.map((o) => ({ id: o.id, number: o.number, branchId: o.branch_id, channel: o.channel, fulfillment: o.fulfillment, status: o.status,
        paymentStatus: o.payment_status, totalMinor: o.total_minor, refundedMinor: o.refunded_minor, placedAt: iso(o.placed_at)! })),
      reservations: reservations.map((r) => ({ id: r.id, code: r.code, branchId: r.branch_id, startsAt: iso(r.starts_at)!, partySize: r.party_size, status: r.status })),
      consentHistory: consent.map((e) => ({ id: e.id, granted: e.granted, source: e.source, note: e.note, actor: e.actor, occurredAt: iso(e.occurred_at)! })),
    };
  }

  async update(tx: Tx, ctx: TenantContext, id: string, input: z.infer<typeof customerUpdate>) {
    const c = await this.lockVisible(tx, ctx, id);
    if (c.anonymized_at) throw conflict('customer_anonymised', 'This customer was anonymised and cannot be edited');
    const tags = input.tags ? [...new Set(input.tags)] : null;
    await tx.query(
      `update customers set display_name = case when $2 then $3 else display_name end, tags = coalesce($4, tags),
              notes = case when $5 then $6 else notes end where id = $1`,
      [id, input.displayName !== undefined, input.displayName ?? null, tags, input.notes !== undefined, input.notes ?? null]);
    await this.audit.record(tx, ctx, { action: 'customers.updated', entityType: 'customer', entityId: id,
      metadata: { fields: Object.keys(input), tags: tags ?? undefined } });
    return this.get(tx, ctx, id);
  }

  /** Explicit consent decision with its source. A no-op request (same state) changes nothing and is reported as such. */
  async setConsent(tx: Tx, ctx: TenantContext, id: string, input: z.infer<typeof consentUpdate>) {
    const c = await this.lockVisible(tx, ctx, id);
    if (c.anonymized_at) throw conflict('customer_anonymised', 'This customer was anonymised');
    if (c.marketing_consent === input.granted) {
      return { customerId: id, marketingConsent: c.marketing_consent, changed: false };
    }
    await tx.query(`select set_config('app.consent_note', $1, true)`, [input.note ?? '']);
    await tx.query(
      `update customers set marketing_consent = $2, marketing_consent_at = now(), marketing_consent_source = $3 where id = $1`,
      [id, input.granted, `staff:${input.source}`]);
    await tx.query(`select set_config('app.consent_note', '', true)`);
    await this.audit.record(tx, ctx, { action: input.granted ? 'customers.consent_granted' : 'customers.consent_revoked', entityType: 'customer', entityId: id,
      metadata: { source: input.source, previous: c.marketing_consent } });
    return { customerId: id, marketingConsent: input.granted, changed: true };
  }

  /**
   * Replaces personal data with nothing while keeping order aggregates: profile
   * PII, identities, addresses, consent-note text, and the name/phone/address
   * snapshots on this customer's orders and reservations. Requires all-branch access.
   */
  async anonymise(tx: Tx, ctx: TenantContext, id: string, input: z.infer<typeof anonymiseInput>) {
    if (ctx.branchFilter !== null) throw forbidden('Anonymisation needs access to every branch so no copy is left behind');
    const c = await this.lockVisible(tx, ctx, id);
    if (c.anonymized_at) throw conflict('already_anonymised', 'This customer is already anonymised');
    await tx.query(`select set_config('app.consent_note', 'anonymisation request', true)`);
    await tx.query(
      `update customers set display_name = null, phone_e164 = null, email = null, notes = null, tags = '{}', legacy_id = null,
              marketing_consent = false,
              marketing_consent_at = case when marketing_consent then now() else marketing_consent_at end,
              marketing_consent_source = case when marketing_consent then 'anonymisation' else marketing_consent_source end,
              anonymized_at = now()
        where id = $1`, [id]);
    await tx.query(`select set_config('app.consent_note', '', true)`);
    const identities = await tx.query(`delete from customer_identities where customer_id = $1 returning id`, [id]);
    const addresses = await tx.query(`delete from customer_addresses where customer_id = $1 returning id`, [id]);
    await tx.query(`update customer_consent_events set note = null where customer_id = $1 and note is not null`, [id]);
    const orders = await tx.query(
      `update orders set customer_name = null, customer_phone = null,
              delivery_address = case when delivery_address is null then null else '{"redacted": true}'::jsonb end
        where customer_id = $1 returning id`, [id]);
    const reservations = await tx.query(
      `update reservations set guest_name = 'Anonymised guest', guest_phone = null, guest_email = null, notes = null
        where customer_id = $1 returning id`, [id]);
    await this.audit.record(tx, ctx, { action: 'customers.anonymised', entityType: 'customer', entityId: id,
      metadata: { reason: input.reason, identitiesRemoved: identities.length, addressesRemoved: addresses.length,
        ordersRedacted: orders.length, reservationsRedacted: reservations.length } });
    return { customerId: id, anonymisedAt: new Date().toISOString(), ordersRetained: orders.length, reservationsRetained: reservations.length };
  }

  /**
   * Merges `duplicateId` into `survivorId` in one transaction: orders, visits,
   * reservations, identities, addresses and consent history move to the survivor;
   * blank survivor fields are filled from the duplicate; tags are united. The
   * survivor's consent is never changed by a merge — a conflict is reported instead.
   * The duplicate row remains as a tombstone (merged_into_id) so references held
   * by other modules stay resolvable.
   */
  async merge(tx: Tx, ctx: TenantContext, survivorId: string, duplicateId: string) {
    if (survivorId === duplicateId) throw invalid('same_customer', 'Choose two different customers');
    if (ctx.branchFilter !== null) throw forbidden('Merging customers needs access to every branch');
    const locked = await tx.query(`select * from customers where org_id = $1 and id = any($2::uuid[]) order by id for update`, [ctx.orgId, [survivorId, duplicateId]]);
    const survivor = locked.find((r) => r.id === survivorId);
    const dup = locked.find((r) => r.id === duplicateId);
    if (!survivor || !dup) throw notFound('Customer');
    for (const r of [survivor, dup]) {
      if (r.merged_into_id) throw conflict('customer_merged', 'One of these customers was already merged', { customerId: r.id });
      if (r.anonymized_at) throw conflict('customer_anonymised', 'Anonymised customers cannot be merged', { customerId: r.id });
    }
    const moved: Record<string, number> = {};
    const move = async (table: string) => {
      moved[table] = (await tx.query(`update ${table} set customer_id = $1 where customer_id = $2 returning 1`, [survivorId, duplicateId])).length;
    };
    for (const t of ['orders', 'visits', 'reservations', 'customer_identities', 'customer_addresses', 'customer_consent_events']) await move(t);
    // Release the duplicate's unique phone/email before the survivor may take them.
    await tx.query(`update customers set phone_e164 = null, email = null, merged_into_id = $2, tags = '{}' where id = $1`, [duplicateId, survivorId]);
    await tx.query(
      `update customers s set display_name = coalesce(s.display_name, $2), phone_e164 = coalesce(s.phone_e164, $3), email = coalesce(s.email, $4::citext),
              tags = (select coalesce(array_agg(distinct t order by t), '{}') from unnest(s.tags || $5::text[]) t),
              notes = case when $6::text is null then s.notes when s.notes is null then $6 else s.notes || E'\\n---\\n' || $6 end,
              first_seen_at = least(s.first_seen_at, $7), last_seen_at = greatest(s.last_seen_at, $8)
        where s.id = $1`,
      [survivorId, dup.display_name, dup.phone_e164, dup.email, dup.tags ?? [], dup.notes, dup.first_seen_at, dup.last_seen_at]);
    const consentConflict = dup.marketing_consent !== survivor.marketing_consent;
    await this.audit.record(tx, ctx, { action: 'customers.merged', entityType: 'customer', entityId: survivorId,
      metadata: { duplicateId, moved, consentConflict, survivorConsent: survivor.marketing_consent, duplicateConsent: dup.marketing_consent } });
    return { survivorId, duplicateId, moved, consentConflict,
      consentNote: consentConflict ? 'Consent differs between the profiles. The surviving profile kept its own consent; record the guest\'s decision explicitly if needed.' : null };
  }

  /** Locks a customer the caller may see (branch scope applies). */
  private async lockVisible(tx: Tx, ctx: TenantContext, id: string) {
    const c = await tx.maybeOne(`select * from customers where id = $1 and org_id = $2 and merged_into_id is null for update`, [id, ctx.orgId]);
    if (!c) throw notFound('Customer');
    const scope = branchScope(ctx);
    if (scope) {
      const visible = await tx.maybeOne(
        `select 1 where exists (select 1 from orders where customer_id = $1 and branch_id = any($2))
                    or exists (select 1 from reservations where customer_id = $1 and branch_id = any($2))`, [id, scope]);
      if (!visible) throw notFound('Customer');
    }
    return c;
  }
}

function mapSummary(c: any): CustomerSummary {
  return {
    id: c.id, displayName: c.display_name, phone: c.phone_e164, email: c.email, locale: c.locale,
    marketingConsent: c.marketing_consent, marketingConsentAt: iso(c.marketing_consent_at), marketingConsentSource: c.marketing_consent_source,
    tags: c.tags ?? [], orderCount: c.order_count ?? 0, totalSpendMinor: int(c.spend_minor), lastOrderAt: iso(c.last_order_at),
    firstOrderAt: iso(c.first_order_at), anonymisedAt: iso(c.anonymized_at), createdAt: iso(c.created_at)!,
  };
}

/** RFC 4180 quoting plus spreadsheet formula-injection protection for free-text cells. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^\+[1-9][0-9]{6,14}$/.test(s)) s = `'${s}`;
  return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
