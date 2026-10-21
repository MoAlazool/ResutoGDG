import { Inject, Injectable, Logger } from '@nestjs/common';
import { MANAGER_ROLES as CONTRACT_MANAGER_ROLES, RESERVATION_RULES, VISIT_RULES, type GuestSession, type GuestVisitLive, type PublicTableView, type VisitSummary } from '@resuto/contracts';
import { randomUUID } from 'node:crypto';
import { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, forbidden, notFound } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { ENV, type Env } from '../../config/env';
import { StorageService } from '../../common/storage/storage.service';
import { PaymentLedgerService } from '../kernel/payment-ledger.service';
import { guestCoverPath, signGuestCover } from './guest-cover';
import { GuestTokens } from './guest-tokens';

export interface OpenVisitInput {
  tableId: string;
  partySize?: number | null;
  reservationId?: string | null;
  via: 'qr' | 'staff' | 'reservation';
}

export interface GuestContext { ctx: TenantContext; visit: any }

const FULFILLED = `('served', 'picked_up', 'delivered', 'cancelled')`;
const LIVE_RES = `(r.status in ('confirmed', 'seated', 'pending_deposit') or (r.status = 'held' and r.hold_expires_at > now()))`;
const MANAGER_ROLES = new Set<string>(CONTRACT_MANAGER_ROLES);

/** Guest acting inside a tenant (least-privileged role; the kernel never checks guest permissions). */
export const guestContext = (orgId: string, visitId: string) => new TenantContext(orgId, 'waiter', null, null, 'guest', visitId, 'web');

/**
 * Visits: a seated table session. Opening (QR auto-open, staff seat, reservation
 * check-in), the guest bearer token, the bill view, closing (manual, forced,
 * automatic) and the 60-second undo — the legacy lifecycle from server.js.
 * Owns `visits` and `dining_tables.status`.
 */
@Injectable()
export class VisitsService {
  private readonly logger = new Logger('Visits');
  readonly tokens: GuestTokens;

  constructor(
    private readonly db: DbService,
    private readonly ledger: PaymentLedgerService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    @Inject(ENV) env: Env,
    private readonly storage: StorageService,
  ) {
    this.tokens = new GuestTokens(env);
  }

  // ---------------------------------------------------------------------------
  // Opening
  // ---------------------------------------------------------------------------
  /** Opens a visit on a locked table row. Caller runs inside a tenant transaction. */
  async open(tx: Tx, ctx: TenantContext, input: OpenVisitInput) {
    const table = await tx.maybeOne<any>(
      `select t.*, b.is_active as branch_active, b.accepts_dine_in, b.reservation_duration_min, b.reservation_buffer_min
         from dining_tables t join branches b on b.id = t.branch_id where t.id = $1 and t.is_active for update of t`, [input.tableId]);
    if (!table) throw notFound('Table');
    ctx.assertBranch(table.branch_id);
    if (!table.branch_active) throw conflict('branch_unavailable', 'This branch is not open.');
    if (await tx.maybeOne(`select 1 from visits where table_id = $1 and status = 'open'`, [table.id])) {
      throw conflict('table_occupied', 'This table already has an open visit.');
    }
    if (table.status === 'cleaning' || table.status === 'out_of_service') {
      throw conflict('table_unavailable', table.status === 'cleaning' ? 'This table needs cleaning first.' : 'This table is out of service.', { reason: table.status });
    }
    let reservation: any = null;
    if (input.reservationId) {
      reservation = await tx.maybeOne<any>('select * from reservations where id = $1 for update', [input.reservationId]);
      if (!reservation || reservation.status !== 'confirmed') throw notFound('Confirmed reservation');
      if (reservation.table_id && reservation.table_id !== table.id) throw conflict('reservation_table_mismatch', 'This reservation is for another table.');
      if (reservation.party_size > table.capacity) throw conflict('table_too_small', 'This table is too small for the reservation.');
      this.assertCheckInWindow(reservation.starts_at);
    }
    const minutes = table.reservation_duration_min + table.reservation_buffer_min;
    const upcoming = await tx.maybeOne<{ id: string; starts_at: Date }>(
      `select r.id, r.starts_at from reservations r
        where r.table_id = $1 and ${LIVE_RES} and r.status <> 'seated' and ($2::uuid is null or r.id <> $2)
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(now(), now() + make_interval(mins => $3), '[)')
        order by r.starts_at limit 1`, [table.id, reservation?.id ?? null, minutes]);
    if (upcoming) throw conflict('reservation_conflict', 'An upcoming reservation conflicts with this visit.', { reservationId: upcoming.id, startsAt: upcoming.starts_at });

    const id = randomUUID();
    const credit = reservation && reservation.deposit_status === 'paid' ? Number(reservation.deposit_minor) - Number(reservation.deposit_credit_used_minor) : 0;
    const visit = await tx.one<any>(
      `insert into visits(id, org_id, branch_id, table_id, reservation_id, customer_id, party_size, guest_token_hash, opened_by, opened_via, credit_minor)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [id, ctx.orgId, table.branch_id, table.id, reservation?.id ?? null, reservation?.customer_id ?? null,
        input.partySize ?? reservation?.party_size ?? null, this.tokens.hashFor(id), ctx.userId, reservation ? (input.via === 'qr' ? 'qr' : 'reservation') : input.via,
        Math.max(0, credit)]);
    await tx.query(`update dining_tables set status = 'occupied' where id = $1`, [table.id]);
    if (reservation) {
      await tx.query(
        `update reservations set status = 'seated', seated_visit_id = $2, checked_in_at = now(), table_id = coalesce(table_id, $3),
            deposit_status = case when deposit_status = 'paid' then 'applied'::deposit_status else deposit_status end
          where id = $1`, [reservation.id, id, table.id]);
      await this.outbox.publish(tx, ctx.orgId, { type: 'reservation.seated', aggregateType: 'reservation', aggregateId: reservation.id, payload: { visitId: id, creditMinor: credit } });
    }
    await this.outbox.publish(tx, ctx.orgId, { type: 'visit.opened', aggregateType: 'visit', aggregateId: id, payload: { tableId: table.id, branchId: table.branch_id, via: visit.opened_via } });
    if (ctx.actorType !== 'guest') {
      await this.audit.record(tx, ctx, { action: 'visit.opened', entityType: 'visit', entityId: id, branchId: table.branch_id, metadata: { tableId: table.id, reservationId: reservation?.id ?? null } });
    }
    return { visit, table, token: this.tokens.tokenFor(id) };
  }

  assertCheckInWindow(startsAt: Date, now = Date.now()) {
    const start = new Date(startsAt).getTime();
    if (now < start - RESERVATION_RULES.checkInBeforeMinutes * 60_000 || now > start + RESERVATION_RULES.checkInAfterMinutes * 60_000) {
      throw conflict('outside_check_in_window', 'Check-in is available from 15 minutes before to 30 minutes after the reservation.');
    }
  }

  async seat(ctx: TenantContext, input: { tableId: string; partySize?: number; reservationId?: string }) {
    return this.db.scoped(ctx, async (tx) => {
      const { visit } = await this.open(tx, ctx, { ...input, via: input.reservationId ? 'reservation' : 'staff' });
      return { id: visit.id, tableId: visit.table_id, creditMinor: visit.credit_minor };
    });
  }

  /**
   * Guest QR scan (public). Joins the table's open visit, or auto-opens one when
   * the table is free, clean, reservable and has no conflicting reservation; a
   * confirmed reservation inside its check-in window is seated automatically.
   */
  async tableSession(qrToken: string): Promise<GuestSession> {
    const found = await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string; id: string }>(
      `select t.org_id, t.id from dining_tables t join organizations o on o.id = t.org_id
        where t.qr_token = $1 and t.is_active and o.status <> 'closed'`, [qrToken]));
    if (!found) throw notFound('Table');
    return this.db.withTenant(found.org_id, async (tx) => {
      const table = await tx.one<any>('select * from dining_tables where id = $1 for update', [found.id]);
      const org = await tx.one<any>('select name, name_ar, slug, currency from organizations where id = $1', [found.org_id]);
      let visit = await tx.maybeOne<any>(`select * from visits where table_id = $1 and status = 'open'`, [table.id]);
      let opened = false;
      let token: string | null = null;
      if (visit) {
        // Keep the token the table already shares (any guest-token ring key); only when no ring key reproduces the
        // stored hash (that key was retired) does the visit move to the active key, and earlier copies stop working.
        token = this.tokens.visitTokenMatching(visit.id, visit.guest_token_hash);
        if (!token) {
          token = this.tokens.tokenFor(visit.id);
          await tx.query('update visits set guest_token_hash = $2 where id = $1', [visit.id, this.tokens.hashFor(visit.id)]);
        }
      } else {
        const branch = await tx.one<any>('select is_active, accepts_dine_in from branches where id = $1', [table.branch_id]);
        if (!branch.is_active || !branch.accepts_dine_in) throw conflict('table_unavailable', 'This table is not taking orders right now.', { reason: 'branch_closed' });
        if (!table.is_reservable) throw conflict('table_unavailable', 'Please ask a member of staff to seat you at this table.', { reason: 'staff_seating' });
        const due = await tx.maybeOne<{ id: string }>(
          `select id from reservations where table_id = $1 and status = 'confirmed'
              and now() between starts_at - interval '${RESERVATION_RULES.checkInBeforeMinutes} minutes' and starts_at + interval '${RESERVATION_RULES.checkInAfterMinutes} minutes'
            order by starts_at limit 1`, [table.id]);
        const ctx = guestContext(found.org_id, `qr:${table.id}`);
        try {
          visit = (await this.open(tx, ctx, { tableId: table.id, reservationId: due?.id ?? null, via: 'qr' })).visit;
        } catch (e) {
          if (e instanceof DomainError && ['table_unavailable', 'reservation_conflict', 'table_too_small'].includes(e.code)) {
            throw conflict('table_unavailable', e.code === 'reservation_conflict' ? 'This table is reserved soon. Please ask a member of staff.' : e.message,
              { reason: e.code === 'reservation_conflict' ? 'reserved' : (e.details as any)?.reason ?? e.code });
          }
          throw e;
        }
        opened = true;
      }
      return {
        token: token ?? this.tokens.tokenFor(visit.id), visitId: visit.id, orgId: found.org_id, branchId: visit.branch_id, tableLabel: table.label,
        currency: org.currency, org: { name: org.name, nameAr: org.name_ar, slug: org.slug }, opened,
      };
    }, `guest:qr:${found.id}`);
  }

  /**
   * Read-only table lookup for a QR link (CR-03): who the table belongs to and whether scanning in can work, with no
   * session side effects (nothing is opened or re-hashed), so the guest page can answer a real 404 for unknown QR
   * codes and render the branded shell before the session call. The QR code itself is the proof of presence; no
   * visit id or token is ever returned here.
   */
  async tablePublic(qrToken: string): Promise<PublicTableView> {
    const found = await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string; id: string }>(
      `select t.org_id, t.id from dining_tables t join organizations o on o.id = t.org_id
        where t.qr_token = $1 and t.is_active and o.status <> 'closed'`, [qrToken]));
    if (!found) throw notFound('Table');
    const view = await this.db.withTenant(found.org_id, async (tx) => {
      const r = await tx.one<any>(
        `select t.label, t.status, t.is_reservable, b.id as branch_id, b.code, b.name, b.name_ar, b.is_active, b.accepts_dine_in,
                o.name as org_name, o.name_ar as org_name_ar, o.slug, o.currency,
                exists (select 1 from visits v where v.table_id = t.id and v.status = 'open') as has_visit
           from dining_tables t join branches b on b.id = t.branch_id join organizations o on o.id = t.org_id where t.id = $1`, [found.id]);
      const reason = r.has_visit ? null
        : !r.is_active || !r.accepts_dine_in ? 'branch_closed'
          : !r.is_reservable ? 'staff_seating'
            : r.status === 'out_of_service' ? 'out_of_service'
              : r.status === 'cleaning' ? 'cleaning' : null;
      return {
        org: { name: r.org_name, nameAr: r.org_name_ar, slug: r.slug, currency: r.currency },
        branch: { id: r.branch_id, code: r.code, name: r.name, nameAr: r.name_ar },
        table: { label: r.label }, accepting: reason === null, reason,
        coverPath: await guestCoverPath(tx, found.org_id),
      };
    }, `guest:qr-lookup:${found.id}`);
    // The cover is signed after the transaction (PCL-11: no storage round-trip while a pooled connection is held).
    const { coverPath, ...rest } = view;
    return { ...rest, cover: await signGuestCover(this.storage, coverPath) };
  }

  /** Resolves an X-Visit-Token header to its open visit (closed visits are rejected). */
  async resolveGuest(token: string | undefined): Promise<{ orgId: string; visitId: string }> {
    if (!token || token.length < 20 || token.length > 200) throw new DomainError('visit_token_required', 'Scan the table QR code to start.', 401);
    const v = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string }>(
      `select id, org_id from visits where guest_token_hash = $1 and status = 'open'`, [sha256(token)]));
    if (!v) throw new DomainError('visit_closed', 'This table session has ended. Scan the table QR code again.', 401);
    return { orgId: v.org_id, visitId: v.id };
  }

  /** Runs fn inside the guest's tenant with the visit row locked. */
  async withGuest<T>(token: string | undefined, fn: (tx: Tx, g: GuestContext) => Promise<T>): Promise<T> {
    const { orgId, visitId } = await this.resolveGuest(token);
    return this.db.withTenant(orgId, async (tx) => {
      const visit = await tx.maybeOne<any>(`select * from visits where id = $1 and status = 'open' for update`, [visitId]);
      if (!visit) throw new DomainError('visit_closed', 'This table session has ended. Scan the table QR code again.', 401);
      return fn(tx, { ctx: guestContext(orgId, visitId), visit });
    }, `guest:visit:${visitId}`);
  }

  /**
   * Like withGuest, but for reads: the visit row is not locked, so guests polling a table never queue behind an
   * order or a payment on the same visit (PCL-18).
   */
  async withGuestRead<T>(token: string | undefined, fn: (tx: Tx, g: GuestContext) => Promise<T>): Promise<T> {
    const { orgId, visitId } = await this.resolveGuest(token);
    return this.db.withTenant(orgId, async (tx) => {
      const visit = await tx.maybeOne<any>(`select * from visits where id = $1 and status = 'open'`, [visitId]);
      if (!visit) throw new DomainError('visit_closed', 'This table session has ended. Scan the table QR code again.', 401);
      return fn(tx, { ctx: guestContext(orgId, visitId), visit });
    }, `guest:visit:${visitId}`);
  }

  // ---------------------------------------------------------------------------
  // Bill
  // ---------------------------------------------------------------------------
  /** A payment is in flight or a split is active: guests cannot add orders (legacy settling rule). */
  async settling(tx: Tx, visitId: string): Promise<boolean> {
    const row = await tx.maybeOne(
      `select 1 from payments where visit_id = $1 and status in ('pending', 'requires_action', 'authorized')
       union all select 1 from bill_splits where visit_id = $1 and status = 'open' limit 1`, [visitId]);
    return !!row;
  }

  async totals(tx: Tx, visitId: string) {
    const out = await this.ledger.outstanding(tx, { visitId });
    const sums = await tx.one<{ total: number; paid: number }>(
      `select coalesce(sum(total_minor), 0)::bigint as total, coalesce(sum(paid_minor - refunded_minor), 0)::bigint as paid
         from orders where visit_id = $1 and status <> 'cancelled'`, [visitId]);
    const credit = out.availableCreditMinor;
    return { totalMinor: sums.total, paidMinor: sums.paid, creditMinor: credit, dueMinor: Math.max(0, out.dueMinor - credit), ledgerDueMinor: out.dueMinor };
  }

  /**
   * The guest's table view: orders with lines and their status timelines (so tracking an order needs no second
   * request), totals, open requests and whether the table has been rated. `version` hashes the content, so a poll
   * that sends it back can be answered with `{ unchanged: true }` (PCL-18).
   */
  async guestView(tx: Tx, visit: any): Promise<GuestVisitLive> {
    const table = await tx.one<{ id: string; label: string }>('select id, label from dining_tables where id = $1', [visit.table_id]);
    const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [visit.org_id]);
    const orders = await tx.query<any>('select id, number, status, fulfillment, total_minor, placed_at from orders where visit_id = $1 order by placed_at', [visit.id]);
    const ids = orders.map((o) => o.id);
    const lines = ids.length
      ? await tx.query<any>('select order_id, name, name_ar, quantity, line_total_minor, kitchen_status, modifiers from order_lines where order_id = any($1::uuid[]) order by line_seq', [ids])
      : [];
    const events = ids.length
      ? await tx.query<any>('select order_id, to_status, created_at from order_events where order_id = any($1::uuid[]) and to_status is not null order by id', [ids])
      : [];
    const requests = await tx.query<any>(`select kind, status, created_at from service_requests where visit_id = $1 and status <> 'resolved' order by created_at`, [visit.id]);
    const totals = await this.totals(tx, visit.id);
    const rated = !!(await tx.maybeOne(`select 1 from guest_ratings where visit_id = $1 and source = 'table'`, [visit.id]));
    const view: Omit<GuestVisitLive, 'version'> = {
      visitId: visit.id, status: visit.status, table, branchId: visit.branch_id, currency: org.currency,
      orders: orders.map((o) => ({
        id: o.id, number: o.number, status: o.status, fulfillment: o.fulfillment, totalMinor: o.total_minor, placedAt: o.placed_at.toISOString(),
        lines: lines.filter((l) => l.order_id === o.id).map((l) => ({
          name: l.name, nameAr: l.name_ar, quantity: l.quantity, lineTotalMinor: l.line_total_minor, kitchenStatus: l.kitchen_status,
          modifiers: (l.modifiers as any[]).map((m) => m.option),
        })),
        timeline: events.filter((e) => e.order_id === o.id).map((e) => ({ status: e.to_status, at: e.created_at.toISOString() })),
      })),
      totals: { totalMinor: totals.totalMinor, paidMinor: totals.paidMinor, creditMinor: totals.creditMinor, dueMinor: totals.dueMinor },
      requests: requests.map((r) => ({ kind: r.kind, status: r.status, createdAt: r.created_at.toISOString() })),
      settling: await this.settling(tx, visit.id),
      rated,
    };
    return { ...view, version: sha256(JSON.stringify(view)).slice(0, 16) };
  }

  /** Applies unused reservation-deposit credit to the bill as a `deposit_credit` ledger payment. */
  async applyCredit(tx: Tx, ctx: TenantContext, visitId: string): Promise<number> {
    const v = await tx.one<any>('select id, branch_id, credit_minor, credit_used_minor from visits where id = $1 for update', [visitId]);
    const available = Number(v.credit_minor) - Number(v.credit_used_minor);
    if (available <= 0) return 0;
    const { dueMinor } = await this.ledger.outstanding(tx, { visitId });
    const pending = await tx.one<{ s: number }>(
      `select coalesce(sum(amount_minor), 0)::bigint as s from payments where visit_id = $1 and status in ('pending', 'requires_action', 'authorized')`, [visitId]);
    const amount = Math.min(available, dueMinor - Number(pending.s));
    if (amount <= 0) return 0;
    const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
    await this.ledger.recordSucceeded(tx, ctx, {
      branchId: v.branch_id, visitId, method: 'deposit_credit', provider: 'reservation_deposit', amountMinor: amount, currency: org.currency,
      idempotencyKey: `visit-credit:${visitId}:${v.credit_used_minor}`,
    });
    // The ledger consumes visits.credit_used_minor for deposit_credit payments.

    return amount;
  }

  /** Counter cash/card-terminal collection for a whole table bill (`payments:collect`). */
  async collect(ctx: TenantContext, visitId: string, body: { amountMinor?: number; method: string; reference?: string | null }, key: string | undefined) {
    if (!key) throw new DomainError('idempotency_key_required', 'An Idempotency-Key header is required', 422);
    return this.db.scoped(ctx, (tx) => this.idempotency.run(tx, ctx.orgId, `visit-collect:${visitId}`, key, body, async () => {
      const v = await tx.maybeOne<any>('select * from visits where id = $1 for update', [visitId]);
      if (!v) throw notFound('Visit');
      ctx.assertBranch(v.branch_id);
      if (v.status !== 'open') throw conflict('visit_closed', 'This visit is closed.');
      const credit = await this.applyCredit(tx, ctx, visitId);
      const totals = await this.totals(tx, visitId);
      const amount = body.amountMinor ?? totals.dueMinor;
      if (amount <= 0) {
        if (credit > 0) return { paymentId: null, creditAppliedMinor: credit, totals: await this.totals(tx, visitId) };
        throw conflict('nothing_due', 'Nothing is due on this bill.');
      }
      const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      const p = await this.ledger.recordSucceeded(tx, ctx, {
        branchId: v.branch_id, visitId, method: body.method as any, provider: 'manual', amountMinor: amount, currency: org.currency,
        idempotencyKey: `visit-collect:${visitId}:${key}`, raw: body.reference ? { reference: body.reference } : {},
      });
      await this.audit.record(tx, ctx, { action: 'payment.collected', entityType: 'visit', entityId: visitId, branchId: v.branch_id, metadata: { amountMinor: amount, method: body.method, paymentId: p.id } });
      return { paymentId: p.id, creditAppliedMinor: credit, totals: await this.totals(tx, visitId) };
    }));
  }

  // ---------------------------------------------------------------------------
  // Closing
  // ---------------------------------------------------------------------------
  async close(ctx: TenantContext, visitId: string, body: { force?: boolean; reason?: string | null; needsCleaning?: boolean }) {
    if (body.force && !MANAGER_ROLES.has(ctx.role)) throw forbidden('Only a manager can force-close a visit');
    return this.db.scoped(ctx, async (tx) => {
      const v = await tx.maybeOne<any>('select * from visits where id = $1 for update', [visitId]);
      if (!v) throw notFound('Visit');
      ctx.assertBranch(v.branch_id);
      if (v.status !== 'open') throw conflict('visit_closed', 'This visit is already closed.');
      await this.applyCredit(tx, ctx, visitId);
      const totals = await this.totals(tx, visitId);
      const open = await tx.query<{ id: string; number: string; status: string }>(
        `select id, number, status from orders where visit_id = $1 and status not in ${FULFILLED}`, [visitId]);
      const pending = await tx.maybeOne(`select 1 from payments where visit_id = $1 and status in ('pending', 'requires_action', 'authorized') limit 1`, [visitId]);
      if (!body.force) {
        if (pending) throw conflict('payment_pending', 'Reconcile the pending payment before closing.');
        if (totals.dueMinor > 0 || open.length) {
          throw conflict('visit_not_settled', 'Settle the bill and fulfil all orders before closing.', { dueMinor: totals.dueMinor, openOrders: open.map((o) => o.number) });
        }
      }
      // Guests just left: the table needs cleaning unless staff say it is already clean.
      const closed = await this.settle(tx, ctx, v, body.force ? 'force' : 'manual', body.needsCleaning ?? true);
      await this.audit.record(tx, ctx, {
        action: body.force ? 'visit.force_closed' : 'visit.closed', entityType: 'visit', entityId: visitId, branchId: v.branch_id,
        metadata: { dueMinor: totals.dueMinor, openOrders: open.map((o) => o.number), reason: body.reason ?? null, unusedCreditMinor: closed.unusedCreditMinor },
      });
      return { ok: true, ...closed, dueMinor: totals.dueMinor };
    });
  }

  private async settle(tx: Tx, ctx: TenantContext, v: any, reason: 'manual' | 'auto' | 'force', needsCleaning: boolean) {
    const fresh = await tx.one<any>('select credit_minor, credit_used_minor from visits where id = $1', [v.id]);
    const unused = Math.max(0, Number(fresh.credit_minor) - Number(fresh.credit_used_minor));
    await tx.query(
      `update visits set status = 'closed', closed_at = now(), closed_by = $2, close_reason = $3, unused_credit_minor = $4 where id = $1`,
      [v.id, ctx.userId, reason, unused]);
    await tx.query(`update dining_tables set status = $2::table_status where id = $1 and status <> 'out_of_service'`, [v.table_id, needsCleaning ? 'cleaning' : 'available']);
    await tx.query(`update service_requests set status = 'resolved', resolved_at = now() where visit_id = $1 and status <> 'resolved'`, [v.id]);
    if (v.reservation_id) {
      await tx.query(
        `update reservations set status = 'completed', deposit_credit_used_minor = least(deposit_minor, $2) where id = $1 and status = 'seated'`,
        [v.reservation_id, Number(fresh.credit_used_minor)]);
    }
    // Unused deposit credit is a refund owed to the guest; ResutoPay (D1) issues it from this event.
    await this.outbox.publish(tx, ctx.orgId, {
      type: 'visit.closed', aggregateType: 'visit', aggregateId: v.id,
      payload: { reason, tableId: v.table_id, branchId: v.branch_id, reservationId: v.reservation_id, unusedCreditMinor: unused },
    });
    return { unusedCreditMinor: unused };
  }

  /** Releases a QR auto-opened visit within 60 s when nothing happened on it (legacy undo-auto-open). */
  async undo(ctx: TenantContext, visitId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const v = await tx.maybeOne<any>('select * from visits where id = $1 for update', [visitId]);
      if (!v || v.status !== 'open') throw notFound('Open visit');
      ctx.assertBranch(v.branch_id);
      if (v.opened_via !== 'qr') throw new DomainError('not_auto_opened', 'This visit was not opened automatically.', 409);
      if (Date.now() - new Date(v.opened_at).getTime() > VISIT_RULES.autoOpenUndoMs) {
        throw conflict('undo_window_passed', 'This table has been open too long to undo. Close the visit instead.');
      }
      const activity = await tx.maybeOne(`select 1 from orders where visit_id = $1 union all select 1 from payments where visit_id = $1 limit 1`, [visitId]);
      if (activity) throw conflict('visit_has_activity', 'This table already has activity. Close the visit instead.');
      await tx.query(`update visits set status = 'closed', closed_at = now(), closed_by = $2, close_reason = 'undo', undone_at = now() where id = $1`, [visitId, ctx.userId]);
      await tx.query(`update dining_tables set status = 'available' where id = $1 and status = 'occupied'`, [v.table_id]);
      if (v.reservation_id) {
        await tx.query(
          `update reservations set status = 'confirmed', seated_visit_id = null, checked_in_at = null,
              deposit_status = case when deposit_status = 'applied' then 'paid'::deposit_status else deposit_status end
            where id = $1 and status = 'seated'`, [v.reservation_id]);
      }
      await this.audit.record(tx, ctx, { action: 'visit.undone', entityType: 'visit', entityId: visitId, branchId: v.branch_id });
      await this.outbox.publish(tx, ctx.orgId, { type: 'visit.closed', aggregateType: 'visit', aggregateId: visitId, payload: { reason: 'undo', tableId: v.table_id, unusedCreditMinor: 0 } });
      return { ok: true };
    });
  }

  async clean(ctx: TenantContext, tableId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const t = await tx.maybeOne<any>('select * from dining_tables where id = $1 and is_active for update', [tableId]);
      if (!t) throw notFound('Table');
      ctx.assertBranch(t.branch_id);
      if (await tx.maybeOne(`select 1 from visits where table_id = $1 and status = 'open'`, [tableId])) throw conflict('table_occupied', 'Table cannot be cleaned while a visit is open.');
      const row = await tx.one<any>(
        `update dining_tables set status = case when status = 'out_of_service' then status else 'available'::table_status end, version = version + 1
          where id = $1 returning id, status, version`, [tableId]);
      await this.audit.record(tx, ctx, { action: 'table.cleaned', entityType: 'dining_table', entityId: tableId, branchId: t.branch_id });
      return { id: row.id, status: row.status, version: row.version };
    });
  }

  /**
   * Open visits for the legacy "Active visits" board (VS-13): one card per seated table with its bill. Totals use the
   * same rule as the live floor (orders net of refunds, minus unused deposit credit). Branch-scoped by the caller's
   * access and RLS.
   */
  async listOpen(ctx: TenantContext, branchId?: string): Promise<{ items: VisitSummary[] }> {
    if (branchId) ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select v.id, v.branch_id, v.table_id, t.label as table_label, v.party_size, v.opened_at, v.opened_via, v.reservation_id,
                r.guest_name, o2.currency,
                count(o.id) filter (where o.status <> 'cancelled')::int as order_count,
                count(o.id) filter (where o.status not in ${FULFILLED})::int as open_orders,
                coalesce(sum(o.total_minor) filter (where o.status <> 'cancelled'), 0)::bigint as total,
                coalesce(sum(o.paid_minor - o.refunded_minor) filter (where o.status <> 'cancelled'), 0)::bigint as paid,
                greatest(v.credit_minor - v.credit_used_minor, 0)::bigint as credit,
                exists (select 1 from payments p where p.visit_id = v.id and p.status in ('pending', 'requires_action', 'authorized'))
                  or exists (select 1 from bill_splits b where b.visit_id = v.id and b.status = 'open') as locked,
                coalesce((select array_agg(distinct s.kind) from service_requests s where s.visit_id = v.id and s.status <> 'resolved'), '{}') as requests
           from visits v
           join organizations o2 on o2.id = v.org_id
           left join dining_tables t on t.id = v.table_id
           left join reservations r on r.id = v.reservation_id
           left join orders o on o.visit_id = v.id
          where v.org_id = $1 and v.status = 'open' and ($2::uuid is null or v.branch_id = $2) and ($3::uuid[] is null or v.branch_id = any($3::uuid[]))
          group by v.id, t.label, r.guest_name, o2.currency
          order by v.opened_at`, [ctx.orgId, branchId ?? null, ctx.branchFilter]);
      return {
        items: rows.map((v) => ({
          id: v.id, branchId: v.branch_id, tableId: v.table_id, tableLabel: v.table_label, partySize: v.party_size,
          openedAt: new Date(v.opened_at).toISOString(), openedVia: v.opened_via, reservationId: v.reservation_id, guestName: v.guest_name,
          orderCount: v.order_count, openOrders: v.open_orders, totalMinor: Number(v.total), paidMinor: Number(v.paid),
          creditMinor: Number(v.credit), dueMinor: Math.max(0, Number(v.total) - Number(v.paid) - Number(v.credit)),
          billingLocked: v.locked, requests: v.requests, currency: v.currency,
        })),
      };
    });
  }

  async staffDetail(ctx: TenantContext, visitId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const v = await tx.maybeOne<any>('select * from visits where id = $1', [visitId]);
      if (!v) throw notFound('Visit');
      ctx.assertBranch(v.branch_id);
      const view = await this.guestView(tx, v);
      return {
        ...view, openedAt: v.opened_at, openedVia: v.opened_via, closedAt: v.closed_at, closeReason: v.close_reason, partySize: v.party_size,
        reservationId: v.reservation_id, creditMinor: v.credit_minor, creditUsedMinor: v.credit_used_minor, unusedCreditMinor: v.unused_credit_minor,
        undoable: v.status === 'open' && v.opened_via === 'qr' && Date.now() - new Date(v.opened_at).getTime() <= VISIT_RULES.autoOpenUndoMs,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Automatic close (legacy sweepVisits): paid, everything fulfilled, no open
  // requests or in-flight payments, and quiet for 10 minutes.
  // ---------------------------------------------------------------------------
  @Scheduled('orders.visit_auto_close', 60)
  async autoCloseJob() {
    return this.runAutoClose();
  }

  async runAutoClose(asOf = new Date()) {
    const quietBefore = new Date(asOf.getTime() - VISIT_RULES.autoCloseQuietMs);
    // Enumerating candidate tenants is the only cross-tenant step; each close runs in its tenant.
    const candidates = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string }>(
      `select v.id, v.org_id from visits v
        where v.status = 'open' and v.opened_at <= $1
          and exists (select 1 from orders o where o.visit_id = v.id and o.status <> 'cancelled')
          and not exists (select 1 from orders o where o.visit_id = v.id and o.status not in ${FULFILLED})
          and not exists (select 1 from service_requests s where s.visit_id = v.id and s.status <> 'resolved')
          and not exists (select 1 from payments p where p.visit_id = v.id and p.status in ('pending', 'requires_action', 'authorized'))
          and not exists (select 1 from bill_splits b where b.visit_id = v.id and b.status = 'open')
          and coalesce((select max(coalesce(o.fulfilled_at, o.cancelled_at, o.placed_at)) from orders o where o.visit_id = v.id), v.opened_at) <= $1
          and coalesce((select max(p.created_at) from payments p where p.visit_id = v.id
                          or p.order_id in (select o.id from orders o where o.visit_id = v.id)), v.opened_at) <= $1
        limit 500`, [quietBefore]));
    let closed = 0;
    for (const c of candidates) {
      const ctx = TenantContext.system(c.org_id, 'visit-auto-close');
      try {
        const done = await this.db.withTenant(c.org_id, async (tx) => {
          const v = await tx.maybeOne<any>(`select * from visits where id = $1 and status = 'open' for update`, [c.id]);
          if (!v) return false;
          await this.applyCredit(tx, ctx, v.id);
          const totals = await this.totals(tx, v.id);
          if (totals.dueMinor > 0 || totals.totalMinor <= 0) return false;
          await this.settle(tx, ctx, v, 'auto', false);
          await this.audit.record(tx, ctx, { action: 'visit.auto_closed', entityType: 'visit', entityId: v.id, branchId: v.branch_id });
          return true;
        }, 'system:visit-auto-close');
        if (done) closed++;
      } catch (error) {
        this.logger.warn(`auto-close ${c.id} failed: ${(error as Error).message}`);
      }
    }
    return { candidates: candidates.length, closed };
  }
}
