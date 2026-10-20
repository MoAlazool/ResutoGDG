import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  RESERVATION_RULES, TABLE_FEATURES, canTransitionReservation, normalizePhone,
  type AvailabilityResult, type ReservationHoldRequest, type ReservationSlotsView, type ReservationStatus, type ReservationView,
} from '@resuto/contracts';
import { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { OrdersKernelService } from '../kernel/orders-kernel.service';
import { CHECKOUT_PORT, requirePort, type CheckoutPort } from '../kernel/ports';
import { orgCountry } from '../orders/org-country';
import { VisitsService } from '../orders/visits.service';
import { evaluateTables, pickTable, withinOpeningHours, type BookingRow, type TableRow } from './availability';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const LIVE = `(status in ('confirmed', 'seated', 'pending_deposit') or (status = 'held' and hold_expires_at > now()))`;

export const toReservation = (r: any, currency: string): ReservationView => ({
  id: r.id, code: r.code, branchId: r.branch_id, tableId: r.table_id, tableLabel: r.table_label ?? null, status: r.status,
  guestName: r.guest_name, guestPhone: r.guest_phone, guestEmail: r.guest_email, partySize: r.party_size, startsAt: iso(r.starts_at)!,
  endsAt: iso(r.ends_at)!, holdExpiresAt: iso(r.hold_expires_at), depositMinor: r.deposit_minor, depositStatus: r.deposit_status,
  source: r.source, notes: r.notes, seatedVisitId: r.seated_visit_id, currency, createdAt: iso(r.created_at)!,
});

interface Slot {
  branch: any; tz: string; currency: string; startsAt: Date; endsAt: Date; blockedUntil: Date; durationMin: number; dow: number; startMin: number;
}

const half = (from: number, to: number) => Array.from({ length: (to - from) * 2 + 1 }, (_, i) => `${String(from + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
/** Legacy booking services (reservations.js): lunch 12:00-16:00 and dinner 17:00-23:00, every half hour. */
const SERVICES = { lunch: half(12, 16), dinner: half(17, 23) } as const;

/** Translates the exclusion constraint into a friendly conflict. */
function overlapToConflict(e: unknown): never {
  if ((e as any)?.code === '23P01') throw conflict('table_unavailable', 'This table was just booked for an overlapping time. Choose another table or time.');
  throw e;
}

/**
 * Reservations: availability search, 5-minute holds, deposit hand-off to
 * ResutoPay, guest manage links, the staff day book and check-in (which opens
 * the visit and turns a paid deposit into visit credit). Legacy rules from
 * server.js are preserved; the DB exclusion constraint is the final arbiter.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger('Reservations');

  constructor(
    private readonly db: DbService,
    private readonly visits: VisitsService,
    private readonly kernel: OrdersKernelService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    @Optional() @Inject(CHECKOUT_PORT) private readonly checkout?: CheckoutPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Slots and availability
  // ---------------------------------------------------------------------------
  private async slot(tx: Tx, branchId: string, date: string, time: string, durationOverride?: number): Promise<Slot> {
    const branch = await tx.maybeOne<any>(
      `select b.*, coalesce(b.timezone, o.timezone) as tz, o.currency from branches b join organizations o on o.id = b.org_id where b.id = $1 and b.is_active`, [branchId]);
    if (!branch) throw notFound('Branch');
    const durationMin = durationOverride ?? branch.reservation_duration_min;
    const t = await tx.one<{ starts_at: Date; dow: number }>(
      `select (($1::date + $2::time) at time zone $3) as starts_at, extract(dow from $1::date)::int as dow`, [date, time, branch.tz]);
    const [h, m] = time.split(':').map(Number);
    const endsAt = new Date(t.starts_at.getTime() + durationMin * 60_000);
    return {
      branch, tz: branch.tz, currency: branch.currency, startsAt: t.starts_at, endsAt,
      blockedUntil: new Date(endsAt.getTime() + branch.reservation_buffer_min * 60_000), durationMin, dow: t.dow, startMin: (h ?? 0) * 60 + (m ?? 0),
    };
  }

  private assertBookable(slot: Slot, now = new Date()) {
    if (!slot.branch.accepts_reservations) throw conflict('reservations_disabled', 'This branch does not take reservations.');
    if (slot.startsAt.getTime() < now.getTime() - 60_000) throw invalid('time_in_past', 'Choose a future time.');
    if (slot.startsAt.getTime() > now.getTime() + RESERVATION_RULES.maxDaysAhead * 86_400_000) throw invalid('too_far_ahead', 'Choose a time within 180 days.');
    if (!withinOpeningHours(slot.branch.opening_hours ?? [], slot.dow, slot.startMin, slot.durationMin)) {
      throw conflict('outside_opening_hours', 'The restaurant is closed at this time.');
    }
  }

  private async evaluate(tx: Tx, slot: Slot, partySize: number, features: string[], excludeId?: string | null) {
    const tables = await tx.query<TableRow>(
      `select id, label, capacity, zone, features, is_premium, min_spend_minor, is_reservable, status from dining_tables
        where branch_id = $1 and is_active order by capacity, label`, [slot.branch.id]);
    const dayStart = new Date(slot.startsAt.getTime() - 12 * 3600_000);
    const dayEnd = new Date(slot.blockedUntil.getTime() + 12 * 3600_000);
    const bookings = await tx.query<BookingRow>(
      `select id, table_id, starts_at, blocked_until from reservations
        where branch_id = $1 and table_id is not null and ${LIVE} and starts_at < $3 and blocked_until > $2`, [slot.branch.id, dayStart, dayEnd]);
    const occupied = new Set((await tx.query<{ table_id: string }>(`select table_id from visits where branch_id = $1 and status = 'open'`, [slot.branch.id])).map((v) => v.table_id));
    const now = new Date();
    const at = (s: Slot) => evaluateTables({ tables, bookings, occupied, partySize, features, startsAt: s.startsAt, blockedUntil: s.blockedUntil, durationMin: s.durationMin, now, excludeReservationId: excludeId });
    return { tables: at(slot), at };
  }

  private parseFeatures(raw?: string | string[]) {
    const list = Array.isArray(raw) ? raw : (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.find((f) => !(TABLE_FEATURES as readonly string[]).includes(f));
    if (bad) throw invalid('unknown_feature', `Unknown table feature: ${bad}`);
    return list;
  }

  async availabilityFor(tx: Tx, branchId: string, q: { date: string; time: string; partySize: number; features?: string }): Promise<AvailabilityResult> {
    const slot = await this.slot(tx, branchId, q.date, q.time);
    const features = this.parseFeatures(q.features);
    let open = true;
    let closedReason: string | null = null;
    try { this.assertBookable(slot); } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      open = false;
      closedReason = e.code;
    }
    const { tables, at } = await this.evaluate(tx, slot, q.partySize, features);
    const alternatives: string[] = [];
    if (open && !tables.some((t) => t.available)) {
      for (const offset of [-30, 30, -60, 60, -90, 90, -120, 120]) {
        const startMin = slot.startMin + offset;
        if (startMin < 0 || startMin >= 1440) continue;
        const shifted: Slot = {
          ...slot, startMin, startsAt: new Date(slot.startsAt.getTime() + offset * 60_000), endsAt: new Date(slot.endsAt.getTime() + offset * 60_000),
          blockedUntil: new Date(slot.blockedUntil.getTime() + offset * 60_000),
        };
        try { this.assertBookable(shifted); } catch { continue; }
        if (at(shifted).some((t) => t.available)) alternatives.push(`${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`);
        if (alternatives.length >= 4) break;
      }
      alternatives.sort();
    }
    return {
      branchId, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), blockedUntil: slot.blockedUntil.toISOString(),
      open, closedReason, depositMinor: slot.branch.reservation_deposit_minor, currency: slot.currency,
      tables: open ? tables : tables.map((t) => ({ ...t, available: false })), alternatives,
    };
  }

  async publicAvailability(slug: string, q: { branch?: string; date: string; time: string; partySize: number; features?: string }) {
    return this.publicTenant(slug, async (tx, orgId) => {
      const branch = await this.publicBranch(tx, orgId, q.branch);
      return this.availabilityFor(tx, branch.id, q);
    });
  }

  /**
   * The bookable sittings of one service (lunch 12:00-16:00, dinner 17:00-23:00, every 30 minutes, as in the legacy
   * booking page) with the number of tables free for the party at each, in the branch's time zone (VP-08, VP-11).
   * "Today" is today where the restaurant is, not where the guest's phone is; sittings that start within ten minutes
   * are dropped; with no date, the guest starts on the first day that still has a few sittings left.
   */
  async publicSlots(slug: string, q: { branch?: string; date?: string; partySize: number; service?: 'lunch' | 'dinner' }): Promise<ReservationSlotsView> {
    return this.publicTenant(slug, async (tx, orgId) => {
      const found = await tx.maybeOne<{ id: string }>(
        `select id from branches where org_id = $1 and is_active and accepts_reservations and ($2::text is null or code = $2) order by created_at limit 1`,
        [orgId, q.branch ?? null]);
      if (!found) throw notFound('Branch');
      const branch = await tx.one<any>(
        `select b.*, coalesce(b.timezone, o.timezone) as tz, o.currency, ((now() at time zone coalesce(b.timezone, o.timezone))::date)::text as today
           from branches b join organizations o on o.id = b.org_id where b.id = $1`, [found.id]);
      const today: string = branch.today;
      const sittings = async (date: string, service: 'lunch' | 'dinner') => {
        const times = SERVICES[service];
        const rows = await tx.query<{ time: string; starts_at: Date; dow: number }>(
          `select t as time, (($1::date + t::time) at time zone $2) as starts_at, extract(dow from $1::date)::int as dow from unnest($3::text[]) t`,
          [date, branch.tz, times]);
        const now = Date.now();
        const upcoming = rows.filter((r) => r.starts_at.getTime() >= now + 10 * 60_000);
        return { rows: upcoming, passed: rows.length - upcoming.length };
      };
      let date = q.date && q.date >= today ? q.date : today;
      let service: 'lunch' | 'dinner' = q.service ?? 'dinner';
      let firstOpenDate = today;
      if (!q.date) {
        // Legacy openingSlot(): dinner, else lunch, when at least three sittings are left today; otherwise tomorrow.
        const pickToday = q.service ? [q.service] : (['dinner', 'lunch'] as const);
        let chosen: 'lunch' | 'dinner' | null = null;
        for (const s of pickToday) if ((await sittings(today, s)).rows.length >= 3) { chosen = s; break; }
        if (chosen) service = chosen;
        else {
          date = (await tx.one<{ d: string }>(`select ($1::date + 1)::text as d`, [today])).d;
          firstOpenDate = date;
          service = q.service ?? 'dinner';
        }
      }
      const { rows, passed } = await sittings(date, service);
      const durationMin = Number(branch.reservation_duration_min);
      const slots: ReservationSlotsView['slots'] = [];
      if (rows.length) {
        const first = rows[0]!;
        const mk = (r: { time: string; starts_at: Date; dow: number }): Slot => {
          const [h, m] = r.time.split(':').map(Number);
          const endsAt = new Date(r.starts_at.getTime() + durationMin * 60_000);
          return { branch, tz: branch.tz, currency: branch.currency, startsAt: r.starts_at, endsAt,
            blockedUntil: new Date(endsAt.getTime() + Number(branch.reservation_buffer_min) * 60_000), durationMin, dow: r.dow, startMin: (h ?? 0) * 60 + (m ?? 0) };
        };
        const { at } = await this.evaluate(tx, mk(first), q.partySize, []);
        for (const r of rows) {
          const slot = mk(r);
          let open = true;
          try { this.assertBookable(slot); } catch (e) { if (!(e instanceof DomainError)) throw e; open = false; }
          slots.push({ time: r.time, open, free: open ? at(slot).filter((t) => t.available).length : 0 });
        }
      }
      return {
        branch: { id: branch.id, code: branch.code, name: branch.name, nameAr: branch.name_ar },
        timeZone: branch.tz, today, date, service, firstOpenDate, slots, passed,
        durationMin, depositMinor: Number(branch.reservation_deposit_minor), currency: branch.currency,
      };
    });
  }

  staffAvailability(ctx: TenantContext, q: { branchId?: string; date: string; time: string; partySize: number; features?: string }) {
    if (!q.branchId) throw invalid('branch_required', 'Choose a branch');
    ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, (tx) => this.availabilityFor(tx, q.branchId!, q));
  }

  private async publicTenant<T>(slug: string, fn: (tx: Tx, orgId: string) => Promise<T>) {
    const org = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from organizations where slug = $1 and status <> 'closed'`, [slug]));
    if (!org) throw notFound('Restaurant');
    return this.db.withTenant(org.id, (tx) => fn(tx, org.id), 'guest:reservations');
  }

  private async publicBranch(tx: Tx, orgId: string, code?: string) {
    const b = await tx.maybeOne<{ id: string }>(
      `select id from branches where org_id = $1 and is_active and ($2::text is null or code = $2) order by created_at limit 1`, [orgId, code ?? null]);
    if (!b) throw notFound('Branch');
    return b;
  }

  // ---------------------------------------------------------------------------
  // Guest booking: hold → confirm (→ deposit) → manage
  // ---------------------------------------------------------------------------
  private async currency(tx: Tx, orgId: string) {
    return (await tx.one<{ currency: string }>('select currency from organizations where id = $1', [orgId])).currency;
  }

  private async load(tx: Tx, id: string, lock = false) {
    const r = await tx.maybeOne<any>(
      `select r.*, t.label as table_label from reservations r left join dining_tables t on t.id = r.table_id where r.id = $1${lock ? ' for update of r' : ''}`, [id]);
    if (!r) throw notFound('Reservation');
    return r;
  }

  /** `onPhone` sees the guest's number once normalised to E.164 (the controller's per-number abuse limit). */
  async hold(slug: string, body: ReservationHoldRequest, onPhone?: (e164: string) => void) {
    return this.publicTenant(slug, async (tx, orgId) => {
      const ctx = new TenantContext(orgId, 'waiter', null, null, 'guest', 'web:reservation', 'web');
      const branch = await tx.maybeOne<{ id: string }>('select id from branches where id = $1 and org_id = $2 and is_active', [body.branchId, orgId]);
      if (!branch) throw notFound('Branch');
      // CR-06: the phone as typed (01x…, 05x…, Arabic-Indic digits) becomes E.164 for the restaurant's country.
      const phone = normalizePhone(body.guestPhone, await orgCountry(tx, orgId));
      if (!phone) throw invalid('phone_invalid', 'Enter a phone number the restaurant can call, e.g. 010 0123 4567.');
      onPhone?.(phone);
      body = { ...body, guestPhone: phone };
      const { key, ...payload } = body;
      const result = await this.idempotency.run(tx, orgId, 'reservation-hold', key, payload, async () => {
        const r = await this.insert(tx, ctx, {
          branchId: body.branchId, tableId: body.tableId ?? null, date: body.date, time: body.time, partySize: body.partySize,
          guestName: body.guestName, guestPhone: body.guestPhone, guestEmail: body.guestEmail ?? null, notes: body.notes ?? null,
          features: body.features ?? [], source: 'web', status: 'held',
        });
        return { id: r.id };
      });
      const r = await this.load(tx, result.id);
      return { reservation: toReservation(r, await this.currency(tx, orgId)), manageToken: await this.issueManageToken(tx, r) };
    });
  }

  private async insert(tx: Tx, ctx: TenantContext, input: {
    branchId: string; tableId: string | null; date: string; time: string; partySize: number; guestName: string; guestPhone: string | null;
    guestEmail: string | null; notes: string | null; features: string[]; source: string; status: 'held' | 'confirmed' | 'pending_deposit';
    durationMinutes?: number; depositOverride?: number;
  }) {
    const slot = await this.slot(tx, input.branchId, input.date, input.time, input.durationMinutes);
    this.assertBookable(slot);
    // Expired holds still satisfy the exclusion constraint until swept; release them now.
    await tx.query(
      `update reservations set status = 'expired' where branch_id = $1 and status in ('held', 'pending_deposit') and hold_expires_at < now()`, [input.branchId]);
    const { tables } = await this.evaluate(tx, slot, input.partySize, input.features);
    let table = input.tableId ? tables.find((t) => t.id === input.tableId) : pickTable(tables);
    if (input.tableId && !table) throw notFound('Table');
    if (!table || !table.available) {
      throw conflict('table_unavailable', input.tableId ? 'This table is no longer available.' : 'No table is available for this party at this time.',
        { reason: table?.reason ?? 'no_table' });
    }
    const customerId = input.guestPhone && /^\+[1-9][0-9]{6,14}$/.test(input.guestPhone)
      ? await this.kernel.resolveCustomer(tx, ctx.orgId, { name: input.guestName, phone: input.guestPhone, email: input.guestEmail }, input.source)
      : null;
    const deposit = input.depositOverride ?? (input.status === 'held' ? Number(slot.branch.reservation_deposit_minor) : 0);
    const id = (await tx.one<{ id: string }>('select gen_random_uuid() as id')).id;
    const holdUntil = input.status === 'held' ? new Date(Date.now() + RESERVATION_RULES.holdMinutes * 60_000)
      : input.status === 'pending_deposit' ? new Date(Date.now() + RESERVATION_RULES.depositWindowMinutes * 60_000) : null;
    await tx.query(
      `insert into reservations(id, org_id, branch_id, table_id, customer_id, access_token_hash, guest_name, guest_phone, guest_email, party_size,
          starts_at, ends_at, blocked_until, status, hold_expires_at, deposit_minor, deposit_status, source, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [id, ctx.orgId, input.branchId, table.id, customerId, sha256(this.visits.tokens.reservationToken(id)), input.guestName, input.guestPhone,
        input.guestEmail, input.partySize, slot.startsAt, slot.endsAt, slot.blockedUntil, input.status, holdUntil, deposit,
        deposit > 0 ? 'required' : 'none', input.source, input.notes]).catch(overlapToConflict);
    await this.outbox.publish(tx, ctx.orgId, {
      type: 'reservation.created', aggregateType: 'reservation', aggregateId: id,
      payload: { branchId: input.branchId, status: input.status, startsAt: slot.startsAt.toISOString(), partySize: input.partySize, source: input.source },
    });
    if (input.status === 'confirmed') {
      await this.outbox.publish(tx, ctx.orgId, { type: 'reservation.confirmed', aggregateType: 'reservation', aggregateId: id, payload: { depositMinor: 0 } });
    }
    return { id };
  }

  /**
   * The manage link token for a stored reservation (also on an idempotent retry): the guest-token ring key that
   * produced its stored hash, so key rotation never changes a link already sent (PS-25). Only when that key has been
   * retired is the reservation moved to a new token under the active key.
   */
  private async issueManageToken(tx: Tx, r: { id: string; access_token_hash: string | null }): Promise<string> {
    const existing = this.visits.tokens.reservationToken(r.id, r.access_token_hash);
    if (existing) return existing;
    const fresh = this.visits.tokens.reservationToken(r.id);
    await tx.query('update reservations set access_token_hash = $2 where id = $1', [r.id, sha256(fresh)]);
    return fresh;
  }

  private async byToken<T>(token: string | undefined, fn: (tx: Tx, r: any, orgId: string) => Promise<T>) {
    if (!token || token.length < 20 || token.length > 200) throw new DomainError('reservation_token_required', 'Open the link from your confirmation.', 401);
    const found = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string }>(
      `select id, org_id from reservations where access_token_hash = $1`, [sha256(token)]));
    if (!found) throw notFound('Reservation');
    return this.db.withTenant(found.org_id, async (tx) => fn(tx, await this.load(tx, found.id, true), found.org_id), `guest:reservation:${found.id}`);
  }

  /** Confirms a held booking; with a branch deposit it becomes pending_deposit and gets a ResutoPay checkout. */
  async confirm(token: string | undefined, body: { key: string; returnUrl?: string }) {
    return this.byToken(token, async (tx, r, orgId) => {
      const ctx = new TenantContext(orgId, 'waiter', null, null, 'guest', `reservation:${r.id}`, 'web');
      await this.idempotency.run(tx, orgId, `reservation-confirm:${r.id}`, body.key, { reservationId: r.id }, async () => {
        if (r.status !== 'held' || new Date(r.hold_expires_at).getTime() < Date.now()) {
          throw conflict('hold_expired', 'This hold has expired or is already confirmed. Search again.');
        }
        if (Number(r.deposit_minor) > 0) {
          requirePort(this.checkout, 'Reservation deposits (ResutoPay)');
          await tx.query(`update reservations set status = 'pending_deposit', hold_expires_at = now() + make_interval(mins => $2) where id = $1`,
            [r.id, RESERVATION_RULES.depositWindowMinutes]);
        } else {
          await tx.query(`update reservations set status = 'confirmed', hold_expires_at = null where id = $1`, [r.id]);
          await this.outbox.publish(tx, orgId, { type: 'reservation.confirmed', aggregateType: 'reservation', aggregateId: r.id, payload: { depositMinor: 0 } });
        }
        return { ok: true };
      });
      const fresh = await this.load(tx, r.id);
      let checkout = null;
      if (fresh.status === 'pending_deposit' && fresh.deposit_status === 'required') {
        // A fresh link per call: checkout tokens are bearer credentials and are never stored in replay records.
        const s = await requirePort(this.checkout, 'Reservation deposits (ResutoPay)').createSession(tx, ctx, {
          purpose: 'reservation_deposit', reservationId: r.id, amountMinor: Number(fresh.deposit_minor), channel: 'web',
          returnUrl: body.returnUrl ?? null, customerId: fresh.customer_id, expiresInMinutes: RESERVATION_RULES.depositWindowMinutes,
        });
        checkout = { id: s.id, url: s.url, token: s.token, expiresAt: s.expiresAt, amountMinor: s.amountMinor };
      }
      return { reservation: toReservation(fresh, await this.currency(tx, orgId)), checkout };
    });
  }

  async manageView(token: string | undefined) {
    return this.byToken(token, async (tx, r, orgId) => {
      const org = await tx.one<any>('select name, name_ar, slug, currency, timezone from organizations where id = $1', [orgId]);
      const branch = await tx.one<any>('select code, name, name_ar, address, phone, timezone from branches where id = $1', [r.branch_id]);
      const cancellable = ['held', 'pending_deposit', 'confirmed'].includes(r.status) && new Date(r.starts_at).getTime() > Date.now();
      const view = toReservation(r, org.currency);
      return {
        reservation: { ...view, guestPhone: null, guestEmail: null },
        org: { name: org.name, nameAr: org.name_ar, slug: org.slug },
        branch: { code: branch.code, name: branch.name, nameAr: branch.name_ar, address: branch.address, phone: branch.phone, timeZone: branch.timezone ?? org.timezone },
        cancellable,
      };
    });
  }

  async guestCancel(token: string | undefined, reason?: string | null) {
    return this.byToken(token, async (tx, r, orgId) => {
      if (new Date(r.starts_at).getTime() <= Date.now()) throw conflict('too_late_to_cancel', 'This reservation has started. Contact the restaurant.');
      const ctx = new TenantContext(orgId, 'waiter', null, null, 'guest', `reservation:${r.id}`, 'web');
      return this.doCancel(tx, ctx, r, reason ?? 'guest_cancelled', 'guest');
    });
  }

  private async doCancel(tx: Tx, ctx: TenantContext, r: any, reason: string, by: 'guest' | 'staff') {
    if (!canTransitionReservation(r.status, 'cancelled')) throw conflict('invalid_transition', `A ${r.status} reservation cannot be cancelled.`);
    await tx.query(`update reservations set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, hold_expires_at = null where id = $1`,
      [r.id, reason.slice(0, 300)]);
    const depositPaid = r.deposit_status === 'paid' ? Number(r.deposit_minor) : 0;
    await this.outbox.publish(tx, ctx.orgId, {
      type: 'reservation.cancelled', aggregateType: 'reservation', aggregateId: r.id, payload: { by, reason, depositPaidMinor: depositPaid },
    });
    // Deposits are refunded by ResutoPay (D1) from the event; the booking itself is released now.
    return { ok: true, status: 'cancelled' as const, refundRequired: depositPaid > 0 ? { amountMinor: depositPaid } : null };
  }

  // ---------------------------------------------------------------------------
  // Staff day book
  // ---------------------------------------------------------------------------
  async day(ctx: TenantContext, q: { branchId?: string; date: string; status?: string }) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const statuses = q.status ? q.status.split(',').map((s) => s.trim()).filter(Boolean) : null;
      const rows = await tx.query<any>(
        `select r.*, t.label as table_label from reservations r
           join branches b on b.id = r.branch_id join organizations o on o.id = r.org_id
           left join dining_tables t on t.id = r.table_id
          where r.org_id = $1 and ($2::uuid is null or r.branch_id = $2) and ($3::uuid[] is null or r.branch_id = any($3::uuid[]))
            and r.starts_at >= ($4::date::timestamp at time zone coalesce(b.timezone, o.timezone))
            and r.starts_at < (($4::date + 1)::timestamp at time zone coalesce(b.timezone, o.timezone))
            and ($5::text[] is null or r.status::text = any($5::text[]))
          order by r.starts_at, r.created_at`, [ctx.orgId, q.branchId ?? null, ctx.branchFilter, q.date, statuses]);
      const currency = await this.currency(tx, ctx.orgId);
      const pii = ctx.can('customers:read');
      return { date: q.date, items: rows.map((r) => ({ ...toReservation(r, currency), ...(pii ? {} : { guestPhone: null, guestEmail: null }) })) };
    });
  }

  async get(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.load(tx, id);
      ctx.assertBranch(r.branch_id);
      return toReservation(r, await this.currency(tx, ctx.orgId));
    });
  }

  async create(ctx: TenantContext, body: {
    branchId: string; tableId?: string | null; date: string; time: string; partySize: number; guestName: string; guestPhone?: string | null;
    guestEmail?: string | null; notes?: string | null; durationMinutes?: number; source: string; requireDeposit: boolean;
  }, key: string | undefined) {
    if (!key) throw invalid('idempotency_key_required', 'An Idempotency-Key header is required');
    ctx.assertBranch(body.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const out = await this.idempotency.run(tx, ctx.orgId, 'reservation-staff', key, body, async () => {
        const branch = await tx.maybeOne<any>('select reservation_deposit_minor from branches where id = $1', [body.branchId]);
        if (!branch) throw notFound('Branch');
        const deposit = body.requireDeposit ? Number(branch.reservation_deposit_minor) : 0;
        if (deposit > 0) requirePort(this.checkout, 'Reservation deposits (ResutoPay)');
        const r = await this.insert(tx, ctx, {
          branchId: body.branchId, tableId: body.tableId ?? null, date: body.date, time: body.time, partySize: body.partySize,
          guestName: body.guestName, guestPhone: body.guestPhone ?? null, guestEmail: body.guestEmail ?? null, notes: body.notes ?? null, features: [],
          source: body.source, status: deposit > 0 ? 'pending_deposit' : 'confirmed', durationMinutes: body.durationMinutes, depositOverride: deposit,
        });
        await this.audit.record(tx, ctx, { action: 'reservation.created', entityType: 'reservation', entityId: r.id, branchId: body.branchId, metadata: { source: body.source, deposit } });
        return r;
      });
      const fresh = await this.load(tx, out.id);
      let checkout = null;
      if (fresh.status === 'pending_deposit' && fresh.deposit_status === 'required' && this.checkout) {
        const s = await this.checkout.createSession(tx, ctx, {
          purpose: 'reservation_deposit', reservationId: fresh.id, amountMinor: Number(fresh.deposit_minor), channel: 'staff',
          customerId: fresh.customer_id, expiresInMinutes: RESERVATION_RULES.depositWindowMinutes,
        });
        checkout = { id: s.id, url: s.url, expiresAt: s.expiresAt, amountMinor: s.amountMinor };
      }
      return { reservation: toReservation(fresh, await this.currency(tx, ctx.orgId)), manageToken: await this.issueManageToken(tx, fresh), checkout };
    });
  }

  async update(ctx: TenantContext, id: string, patch: {
    tableId?: string | null; date?: string; time?: string; partySize?: number; guestName?: string; guestPhone?: string | null; notes?: string | null; durationMinutes?: number;
  }) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.load(tx, id, true);
      ctx.assertBranch(r.branch_id);
      if (!['held', 'pending_deposit', 'confirmed'].includes(r.status)) throw conflict('not_editable', `A ${r.status} reservation cannot be changed.`);
      const timing = patch.date !== undefined || patch.time !== undefined || patch.partySize !== undefined || patch.tableId !== undefined || patch.durationMinutes !== undefined;
      let startsAt = r.starts_at, endsAt = r.ends_at, blockedUntil = r.blocked_until, tableId = r.table_id;
      if (timing) {
        const local = await tx.one<{ d: string; t: string }>(
          `select to_char(r.starts_at at time zone coalesce(b.timezone, o.timezone), 'YYYY-MM-DD') as d,
                  to_char(r.starts_at at time zone coalesce(b.timezone, o.timezone), 'HH24:MI') as t
             from reservations r join branches b on b.id = r.branch_id join organizations o on o.id = r.org_id where r.id = $1`, [id]);
        const duration = patch.durationMinutes ?? Math.round((new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60_000);
        const slot = await this.slot(tx, r.branch_id, patch.date ?? local.d, patch.time ?? local.t, duration);
        this.assertBookable(slot);
        const { tables } = await this.evaluate(tx, slot, patch.partySize ?? r.party_size, [], id);
        const wanted = patch.tableId === undefined ? r.table_id : patch.tableId;
        const table = wanted ? tables.find((t) => t.id === wanted) : pickTable(tables);
        if (wanted && !table) throw notFound('Table');
        if (!table || !table.available) throw conflict('table_unavailable', 'This table is not available at that time.', { reason: table?.reason ?? 'no_table' });
        startsAt = slot.startsAt; endsAt = slot.endsAt; blockedUntil = slot.blockedUntil; tableId = table.id;
      }
      await tx.query(
        `update reservations set table_id = $2, starts_at = $3, ends_at = $4, blocked_until = $5, party_size = $6, guest_name = $7,
            guest_phone = $8, notes = $9 where id = $1`,
        [id, tableId, startsAt, endsAt, blockedUntil, patch.partySize ?? r.party_size, patch.guestName ?? r.guest_name,
          patch.guestPhone !== undefined ? patch.guestPhone : r.guest_phone, patch.notes !== undefined ? patch.notes : r.notes]).catch(overlapToConflict);
      await this.audit.record(tx, ctx, { action: 'reservation.updated', entityType: 'reservation', entityId: id, branchId: r.branch_id, metadata: { fields: Object.keys(patch) } });
      return toReservation(await this.load(tx, id), await this.currency(tx, ctx.orgId));
    });
  }

  async staffCancel(ctx: TenantContext, id: string, reason?: string | null) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.load(tx, id, true);
      ctx.assertBranch(r.branch_id);
      const out = await this.doCancel(tx, ctx, r, reason ?? 'staff_cancelled', 'staff');
      await this.audit.record(tx, ctx, { action: 'reservation.cancelled', entityType: 'reservation', entityId: id, branchId: r.branch_id, metadata: { reason: reason ?? null } });
      return out;
    });
  }

  async noShow(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.load(tx, id, true);
      ctx.assertBranch(r.branch_id);
      if (!canTransitionReservation(r.status as ReservationStatus, 'no_show')) throw conflict('invalid_transition', `A ${r.status} reservation cannot be marked as a no-show.`);
      if (new Date(r.starts_at).getTime() > Date.now()) throw conflict('not_started', 'A reservation can be marked as a no-show only after its start time.');
      await tx.query(
        `update reservations set status = 'no_show', deposit_status = case when deposit_status = 'paid' then 'forfeited'::deposit_status else deposit_status end where id = $1`, [id]);
      await this.audit.record(tx, ctx, { action: 'reservation.no_show', entityType: 'reservation', entityId: id, branchId: r.branch_id });
      await this.outbox.publish(tx, ctx.orgId, { type: 'reservation.cancelled', aggregateType: 'reservation', aggregateId: id, payload: { by: 'staff', reason: 'no_show', depositPaidMinor: 0 } });
      return { ok: true, status: 'no_show' };
    });
  }

  /** Check-in (−15/+30 min) seats the party: opens the visit and moves a paid deposit to visit credit. */
  async checkIn(ctx: TenantContext, id: string, body: { tableId?: string; partySize?: number }) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.load(tx, id, true);
      ctx.assertBranch(r.branch_id);
      if (r.status !== 'confirmed') throw conflict('not_confirmed', r.status === 'pending_deposit' ? 'The deposit has not been paid yet.' : `A ${r.status} reservation cannot be checked in.`);
      const tableId = body.tableId ?? r.table_id;
      if (!tableId) throw invalid('table_required', 'Choose a table for this party');
      if (r.table_id && body.tableId && body.tableId !== r.table_id) {
        await tx.query('update reservations set table_id = $2 where id = $1', [id, body.tableId]).catch(overlapToConflict);
      }
      const { visit } = await this.visits.open(tx, ctx, { tableId, partySize: body.partySize ?? r.party_size, reservationId: id, via: 'reservation' });
      return { reservationId: id, visitId: visit.id, tableId, creditMinor: Number(visit.credit_minor) };
    });
  }

  // ---------------------------------------------------------------------------
  // Hold expiry (legacy: held reservations expire after 5 minutes)
  // ---------------------------------------------------------------------------
  @Scheduled('reservations.hold_expiry', 60)
  async holdExpiryJob() {
    return this.expireHolds();
  }

  async expireHolds(asOf = new Date()) {
    const orgs = await this.db.withPlatform((tx) => tx.query<{ org_id: string }>(
      `select distinct org_id from reservations where status in ('held', 'pending_deposit') and hold_expires_at < $1 limit 1000`, [asOf]));
    let expired = 0;
    for (const { org_id } of orgs) {
      try {
        expired += await this.db.withTenant(org_id, async (tx) => {
          const rows = await tx.query<{ id: string; status: string }>(
            `update reservations set status = 'expired' where org_id = $1 and status in ('held', 'pending_deposit') and hold_expires_at < $2 returning id, status`,
            [org_id, asOf]);
          for (const r of rows) {
            await this.outbox.publish(tx, org_id, { type: 'reservation.cancelled', aggregateType: 'reservation', aggregateId: r.id, payload: { by: 'system', reason: 'hold_expired' } });
          }
          return rows.length;
        }, 'system:reservation-expiry');
      } catch (error) {
        this.logger.warn(`hold expiry for ${org_id} failed: ${(error as Error).message}`);
      }
    }
    return { expired };
  }
}
