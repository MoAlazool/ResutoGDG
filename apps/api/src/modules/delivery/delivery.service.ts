import { Inject, Injectable, Optional } from '@nestjs/common';
import { canTransitionDelivery, type AssignJob, type DeliveryStatus, type SettlementInput, type VehicleType } from '@resuto/contracts';
import { estimateTravelSeconds, haversineMeters } from '@resuto/integrations';
import { createHmac, randomInt } from 'node:crypto';
import { TenantContext } from '../../common/auth/context';
import { safeEqual } from '../../common/crypto/hash';
import { purposeKey } from '../../common/crypto/keys';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { StorageService } from '../../common/storage/storage.service';
import { ENV, type Env } from '../../config/env';
import { MESSAGING_PORT, type MessagingPort } from '../kernel/ports';
import { DRIVER_SELECT, JOB_SELECT, decodeCursor, encodeCursor, toDriverView, toEventView, toJobView } from './delivery.mappers';

export interface Actor { type: 'user' | 'driver' | 'system'; id: string }
export const actorOf = (ctx: TenantContext): Actor => ({ type: ctx.actorType === 'system' ? 'system' : 'user', id: ctx.actorId });

export interface Coordinates { latitude?: number | null; longitude?: number | null }

const ACTIVE = ['assigned', 'accepted', 'picked_up', 'en_route'];
/** Wrong delivery codes accepted per issued code before it locks (a new code must then be issued). */
export const OTP_MAX_ATTEMPTS = 5;
const OTP_HASH_VERSION = 'h1:';
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * ResutoDriver core: delivery jobs, the delivery state machine
 * (packages/contracts state-machines.ts), dispatch (assign / offer / reassign /
 * cancel), cash settlement and the job read models. Driver self-service lives
 * in DriverAppService and calls the shared transition helpers here.
 */
@Injectable()
export class DeliveryService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    readonly storage: StorageService,
    @Inject(ENV) env: Env,
    @Optional() @Inject(MESSAGING_PORT) private readonly messaging?: MessagingPort,
  ) {
    this.otpKey = purposeKey(env, 'delivery-otp');
  }

  private readonly otpKey: Buffer;

  // ---------------------------------------------------------------------------
  // Job creation (MODULE_CONTRACTS §4: idempotent per order)
  // ---------------------------------------------------------------------------
  /**
   * Creates the delivery job for a delivery order, once (unique order_id).
   * Snapshots the drop-off address and customer contact, and sets the COD
   * amount to what is still due when the order is not prepaid. Returns null for
   * orders that are not (or no longer) deliverable.
   */
  async createJobForOrder(tx: Tx, ctx: TenantContext, orderId: string): Promise<{ id: string; created: boolean } | null> {
    const o = await tx.maybeOne<any>(
      `select o.id, o.branch_id, o.fulfillment, o.status, o.delivery_address, o.customer_name, o.customer_phone,
              o.total_minor, o.paid_minor, o.refunded_minor, b.latitude as b_lat, b.longitude as b_lng
         from orders o join branches b on b.id = o.branch_id where o.id = $1 for update of o`, [orderId]);
    if (!o) throw notFound('Order');
    ctx.assertBranch(o.branch_id);
    if (o.fulfillment !== 'delivery' || ['awaiting_payment', 'cancelled', 'delivered'].includes(o.status)) return null;
    const existing = await tx.maybeOne<{ id: string }>('select id from delivery_jobs where order_id = $1', [orderId]);
    if (existing) return { id: existing.id, created: false };

    const addr = o.delivery_address ?? {};
    const dLat = n(addr.latitude), dLng = n(addr.longitude), pLat = n(o.b_lat), pLng = n(o.b_lng);
    const distance = dLat !== null && dLng !== null && pLat !== null && pLng !== null
      ? Math.round(haversineMeters({ latitude: pLat, longitude: pLng }, { latitude: dLat, longitude: dLng })) : null;
    const due = Math.max(0, o.total_minor - (o.paid_minor - o.refunded_minor));
    const dropoff = {
      line1: addr.line1 ?? '', area: addr.area ?? null, city: addr.city ?? null, notes: addr.notes ?? null,
      customerName: o.customer_name ?? null, customerPhone: o.customer_phone ?? null, latitude: dLat, longitude: dLng,
    };
    const job = await tx.maybeOne<{ id: string }>(
      `insert into delivery_jobs(org_id, branch_id, order_id, status, pickup_latitude, pickup_longitude, dropoff, dropoff_latitude,
          dropoff_longitude, distance_m, cod_amount_minor, cash_status)
       values ($1, $2, $3, 'unassigned', $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (order_id) do nothing returning id`,
      [ctx.orgId, o.branch_id, orderId, pLat, pLng, dropoff, dLat, dLng, distance, due, due > 0 ? 'pending' : 'none']);
    if (!job) {
      const again = await tx.one<{ id: string }>('select id from delivery_jobs where order_id = $1', [orderId]);
      return { id: again.id, created: false };
    }
    await this.recordEvent(tx, ctx.orgId, job.id, null, 'unassigned', actorOf(ctx), {}, { reason: 'order_' + o.status, codAmountMinor: due });
    await this.outbox.publish(tx, ctx.orgId, {
      type: 'delivery.created', aggregateType: 'delivery_job', aggregateId: job.id,
      payload: { orderId, branchId: o.branch_id, codAmountMinor: due },
    });
    return { id: job.id, created: true };
  }

  // ---------------------------------------------------------------------------
  // State machine helpers (shared with DriverAppService)
  // ---------------------------------------------------------------------------
  async lockJob(tx: Tx, ctx: TenantContext, jobId: string): Promise<any> {
    const job = await tx.maybeOne<any>('select * from delivery_jobs where id = $1 for update', [jobId]);
    if (!job) throw notFound('Delivery job');
    ctx.assertBranch(job.branch_id);
    return job;
  }

  assertTransition(from: DeliveryStatus, to: DeliveryStatus) {
    if (!canTransitionDelivery(from, to)) {
      throw new DomainError('invalid_transition', `Cannot move a delivery from ${from} to ${to}`, 409, { from, to });
    }
  }

  /** Validated transition + event + outbox in the caller's transaction. */
  async move(tx: Tx, orgId: string, job: any, to: DeliveryStatus, actor: Actor, set: Record<string, unknown> = {}, details: Record<string, unknown> = {}, at: Coordinates = {}) {
    this.assertTransition(job.status, to);
    const entries = Object.entries(set);
    const row = await tx.one<any>(
      `update delivery_jobs set status = $2, version = version + 1${entries.map(([k], i) => `, ${k} = $${i + 3}`).join('')}
        where id = $1 returning *`, [job.id, to, ...entries.map(([, v]) => v)]);
    await this.recordEvent(tx, orgId, job.id, job.status, to, actor, at, details);
    await this.outbox.publish(tx, orgId, {
      type: 'delivery.status_changed', aggregateType: 'delivery_job', aggregateId: job.id,
      payload: { from: job.status, to, orderId: job.order_id, driverId: row.driver_id, branchId: job.branch_id },
    });
    return row;
  }

  async recordEvent(tx: Tx, orgId: string, jobId: string, from: string | null, to: string, actor: Actor, at: Coordinates, details: Record<string, unknown>) {
    await tx.query(
      `insert into delivery_events(org_id, job_id, from_status, to_status, actor_type, actor_id, latitude, longitude, details)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orgId, jobId, from, to, actor.type, actor.id, at.latitude ?? null, at.longitude ?? null, details]);
  }

  /** Drivers become available again when their last active job ends. */
  async refreshAvailability(tx: Tx, driverId: string | null) {
    if (!driverId) return;
    await tx.query(
      `update drivers set availability = case
          when exists (select 1 from delivery_jobs where driver_id = $1 and status in ('accepted', 'picked_up', 'en_route')) then 'busy'
          when availability = 'busy' then 'available' else availability end
        where id = $1`, [driverId]);
  }

  /** Returns a job to the pool (from offered/assigned/accepted/failed). */
  private async release(tx: Tx, ctx: TenantContext, job: any, reason: string) {
    if (job.status === 'unassigned') return job;
    if (job.status === 'offered') {
      await tx.query(`update delivery_offers set status = 'withdrawn', responded_at = now() where job_id = $1 and status = 'offered'`, [job.id]);
    }
    const row = await this.move(tx, ctx.orgId, job, 'unassigned', actorOf(ctx), { driver_id: null, assigned_at: null, accepted_at: null }, { reason, previousDriverId: job.driver_id });
    await this.refreshAvailability(tx, job.driver_id);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Dispatch (delivery:dispatch)
  // ---------------------------------------------------------------------------
  async board(ctx: TenantContext, branchId?: string) {
    if (branchId) ctx.assertBranch(branchId);
    const branches = branchId ? [branchId] : ctx.branchFilter;
    return this.db.scoped(ctx, async (tx) => {
      const jobs = await tx.query(
        `${JOB_SELECT}
          where j.org_id = $1 and ($2::uuid[] is null or j.branch_id = any($2))
            and (j.status not in ('delivered', 'cancelled') or j.updated_at > now() - interval '12 hours')
          order by j.created_at asc limit 500`, [ctx.orgId, branches]);
      const drivers = await tx.query(
        `${DRIVER_SELECT} where d.org_id = $1 and d.status = 'active'
            and ($2::uuid[] is null or d.branch_ids is null or d.branch_ids && $2)
          order by (d.availability = 'offline'), d.display_name`, [ctx.orgId, branches]);
      const views = jobs.map(toJobView);
      return {
        unassigned: views.filter((j) => ['unassigned', 'offered', 'failed'].includes(j.status)),
        active: views.filter((j) => ACTIVE.includes(j.status)),
        recent: views.filter((j) => ['delivered', 'cancelled'].includes(j.status)).reverse().slice(0, 50),
        drivers: drivers.map(toDriverView),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async listJobs(ctx: TenantContext, q: { status?: string; branchId?: string; driverId?: string; limit: number; cursor?: string }) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    const statuses = q.status ? q.status.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const cursor = decodeCursor(q.cursor);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `${JOB_SELECT}
          where j.org_id = $1 and ($2::uuid[] is null or j.branch_id = any($2)) and ($3::text[] is null or j.status::text = any($3))
            and ($4::uuid is null or j.driver_id = $4) and ($5::timestamptz is null or (j.created_at, j.id) < ($5, $6::uuid))
          order by j.created_at desc, j.id desc limit $7`,
        [ctx.orgId, q.branchId ? [q.branchId] : ctx.branchFilter, statuses, q.driverId ?? null, cursor?.at ?? null, cursor?.id ?? null, q.limit]);
      const last = rows[rows.length - 1];
      return { items: rows.map(toJobView), nextCursor: rows.length === q.limit && last ? encodeCursor(last.created_at, last.id) : null };
    });
  }

  async jobDetail(ctx: TenantContext, jobId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`${JOB_SELECT} where j.id = $1`, [jobId]);
      if (!r) throw notFound('Delivery job');
      ctx.assertBranch(r.branch_id);
      return this.detail(tx, r);
    });
  }

  /** Full job detail: view + timeline + offers + order lines + proof photo. */
  async detail(tx: Tx, r: any) {
    const events = await tx.query('select * from delivery_events where job_id = $1 order by created_at, id', [r.id]);
    const offers = await tx.query(
      `select f.id, f.driver_id, d.display_name, f.status, f.expires_at, f.responded_at, f.created_at
         from delivery_offers f join drivers d on d.id = f.driver_id where f.job_id = $1 order by f.created_at`, [r.id]);
    const lines = await tx.query('select name, name_ar, quantity, modifiers, notes from order_lines where order_id = $1 order by id', [r.order_id]);
    let proofPhotoUrl: string | null = null;
    if (r.proof_media_id) {
      const m = await tx.maybeOne<{ path: string }>('select path from media_assets where id = $1', [r.proof_media_id]);
      if (m) proofPhotoUrl = await this.storage.signedUrl(m.path, 900);
    }
    return {
      ...toJobView(r),
      proofNote: r.proof_note,
      proofMediaId: r.proof_media_id,
      proofPhotoUrl,
      events: events.map(toEventView),
      offers: offers.map((f) => ({ id: f.id, driverId: f.driver_id, driverName: f.display_name, status: f.status, expiresAt: f.expires_at, respondedAt: f.responded_at, createdAt: f.created_at })),
      items: lines.map((l) => ({ name: l.name, nameAr: l.name_ar, quantity: l.quantity, modifiers: l.modifiers, notes: l.notes })),
    };
  }

  /**
   * Assigns or offers a job to a driver. A job already with a driver (offered,
   * assigned, accepted) or failed is first returned to the pool, so this is
   * also "reassign". Jobs already picked up cannot be reassigned.
   */
  async assign(ctx: TenantContext, jobId: string, input: AssignJob, key?: string) {
    return this.db.scoped(ctx, (tx) => this.withKey(tx, ctx, 'delivery.assign', key, { jobId, ...input }, async () => {
      let job = await this.lockJob(tx, ctx, jobId);
      const driver = await tx.maybeOne<any>('select * from drivers where id = $1 for update', [input.driverId]);
      if (!driver) throw notFound('Driver');
      if (driver.status !== 'active') throw conflict('driver_inactive', 'This driver is not active');
      if (driver.branch_ids && !driver.branch_ids.includes(job.branch_id)) throw conflict('driver_branch_mismatch', 'This driver does not work at this branch');
      if (input.mode === 'offer' && !['available', 'busy'].includes(driver.availability)) {
        throw conflict('driver_unavailable', 'Offers can only be sent to drivers who are online');
      }
      if (['picked_up', 'en_route', 'delivered', 'cancelled'].includes(job.status)) this.assertTransition(job.status, 'unassigned');
      const sameDriver = job.driver_id === driver.id && ['assigned', 'accepted'].includes(job.status) && input.mode === 'assign';
      if (sameDriver) return this.viewOf(tx, job.id);
      job = await this.release(tx, ctx, job, 'reassigned');

      if (input.mode === 'offer') {
        const offer = await tx.one<{ id: string; expires_at: string }>(
          `insert into delivery_offers(org_id, job_id, driver_id, expires_at) values ($1, $2, $3, now() + make_interval(secs => $4)) returning id, expires_at`,
          [ctx.orgId, job.id, driver.id, input.offerTtlSeconds]);
        await this.move(tx, ctx.orgId, job, 'offered', actorOf(ctx), {}, { driverId: driver.id, offerId: offer.id, expiresAt: offer.expires_at });
      } else {
        await this.move(tx, ctx.orgId, job, 'assigned', actorOf(ctx), { driver_id: driver.id, assigned_at: new Date() }, { driverId: driver.id });
      }
      await this.outbox.publish(tx, ctx.orgId, {
        type: 'delivery.assigned', aggregateType: 'delivery_job', aggregateId: job.id,
        payload: { driverId: driver.id, mode: input.mode, orderId: job.order_id },
      });
      await this.audit.record(tx, ctx, { action: `delivery.${input.mode === 'offer' ? 'offered' : 'assigned'}`, entityType: 'delivery_job', entityId: job.id, branchId: job.branch_id, metadata: { driverId: driver.id } });
      return this.viewOf(tx, job.id);
    }));
  }

  async unassign(ctx: TenantContext, jobId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const job = await this.lockJob(tx, ctx, jobId);
      if (job.status === 'unassigned') return this.viewOf(tx, job.id);
      this.assertTransition(job.status, 'unassigned');
      await this.release(tx, ctx, job, 'unassigned_by_dispatcher');
      await this.audit.record(tx, ctx, { action: 'delivery.unassigned', entityType: 'delivery_job', entityId: job.id, branchId: job.branch_id, metadata: { driverId: job.driver_id } });
      return this.viewOf(tx, job.id);
    });
  }

  /** Cancels the delivery job only; the order itself is cancelled through the orders module. */
  async cancel(ctx: TenantContext, jobId: string, reason: string) {
    return this.db.scoped(ctx, async (tx) => {
      const job = await this.lockJob(tx, ctx, jobId);
      await this.cancelLocked(tx, ctx, job, reason);
      await this.audit.record(tx, ctx, { action: 'delivery.cancelled', entityType: 'delivery_job', entityId: job.id, branchId: job.branch_id, metadata: { reason } });
      return this.viewOf(tx, job.id);
    });
  }

  async cancelLocked(tx: Tx, ctx: TenantContext, job: any, reason: string) {
    if (job.status === 'cancelled') return job;
    // Jobs on the road must be marked failed first (state machine: picked_up/en_route → failed → cancelled).
    if (job.status === 'picked_up' || job.status === 'en_route') {
      job = await this.move(tx, ctx.orgId, job, 'failed', actorOf(ctx), { failure_reason: 'order_cancelled' }, { reason });
    }
    if (job.status === 'offered') await tx.query(`update delivery_offers set status = 'withdrawn', responded_at = now() where job_id = $1 and status = 'offered'`, [job.id]);
    const row = await this.move(tx, ctx.orgId, job, 'cancelled', actorOf(ctx), {}, { reason });
    await this.refreshAvailability(tx, job.driver_id);
    return row;
  }

  /**
   * Generates a 4-digit delivery code (only its keyed hash is stored). The code is
   * returned once so staff can read it to the customer, and is sent through
   * Resuto Connect when that module is deployed. A new code resets the failed
   * attempt counter and lifts a lock.
   */
  async issueOtp(ctx: TenantContext, jobId: string) {
    const code = String(randomInt(0, 10_000)).padStart(4, '0');
    const job = await this.db.scoped(ctx, async (tx) => {
      const j = await this.lockJob(tx, ctx, jobId);
      if (['delivered', 'cancelled', 'failed'].includes(j.status)) throw conflict('job_closed', 'This delivery is already closed');
      await tx.query(`update delivery_jobs set delivery_otp_hash = $2, otp_failed_attempts = 0, otp_locked_at = null, otp_issued_at = now()
                        where id = $1`, [j.id, this.otpHash(j.id, code)]);
      await this.audit.record(tx, ctx, { action: 'delivery.otp_issued', entityType: 'delivery_job', entityId: j.id, branchId: j.branch_id });
      return tx.one<any>('select j.order_id, j.dropoff, o.customer_id from delivery_jobs j join orders o on o.id = j.order_id where j.id = $1', [j.id]);
    });
    let messaging: { status: 'queued' | 'skipped' | 'unavailable' | 'failed'; reason?: string } = { status: 'unavailable', reason: 'messaging_module_not_deployed' };
    if (this.messaging) {
      try {
        const res = await this.db.scoped(ctx, (tx) => this.messaging!.enqueueToCustomer(tx, ctx, {
          customerId: job.customer_id, phone: job.dropoff?.customerPhone ?? null, orderId: job.order_id, reason: 'delivery_otp',
          text: `Your delivery code is ${code}. Share it with the driver when your order arrives.`, variables: { code },
        }));
        messaging = res.messageId ? { status: 'queued' } : { status: 'skipped', reason: res.skipped };
      } catch (e) {
        messaging = { status: 'failed', reason: (e as Error).message.slice(0, 200) };
      }
    }
    return { code, messaging };
  }

  /** Keyed hash of a delivery code (audit PS-08): without the server key, the stored value cannot be reversed. */
  otpHash(jobId: string, code: string) {
    return OTP_HASH_VERSION + createHmac('sha256', this.otpKey).update(`delivery-otp:${jobId}:${code}`).digest('hex');
  }

  /**
   * Checks a delivery code in its own committed transaction, so a wrong attempt is counted even though the delivery
   * that carried it fails (audit PS-08: the limit used to live in one process's memory). Throws otp_locked after
   * OTP_MAX_ATTEMPTS wrong codes, until a new code is issued.
   */
  async verifyOtp(orgId: string, jobId: string, driverId: string, code: string): Promise<void> {
    const outcome = await this.db.withTenant(orgId, async (tx) => {
      const job = await tx.maybeOne<{ delivery_otp_hash: string | null; otp_failed_attempts: number; otp_locked_at: Date | null; driver_id: string | null }>(
        `select delivery_otp_hash, otp_failed_attempts, otp_locked_at, driver_id from delivery_jobs where id = $1 for update`, [jobId]);
      if (!job || job.driver_id !== driverId) return 'not_found' as const;
      if (!job.delivery_otp_hash) return 'not_set' as const;
      if (!job.delivery_otp_hash.startsWith(OTP_HASH_VERSION)) return 'reissue' as const; // issued before keyed hashes
      if (job.otp_locked_at || job.otp_failed_attempts >= OTP_MAX_ATTEMPTS) return 'locked' as const;
      if (safeEqual(this.otpHash(jobId, code), job.delivery_otp_hash)) return 'ok' as const;
      const r = await tx.one<{ otp_failed_attempts: number }>(
        `update delivery_jobs set otp_failed_attempts = otp_failed_attempts + 1,
                otp_locked_at = case when otp_failed_attempts + 1 >= $2 then now() else null end
          where id = $1 returning otp_failed_attempts`, [jobId, OTP_MAX_ATTEMPTS]);
      return r.otp_failed_attempts >= OTP_MAX_ATTEMPTS ? 'locked_now' as const : 'wrong' as const;
    }, 'system:delivery-otp');
    if (outcome === 'ok') return;
    if (outcome === 'not_found') throw notFound('Delivery job');
    if (outcome === 'not_set') throw invalid('otp_not_set', 'This delivery has no delivery code');
    if (outcome === 'reissue') throw invalid('otp_reissue_required', 'Ask the restaurant to send the customer a new delivery code');
    if (outcome === 'locked' || outcome === 'locked_now') {
      throw new DomainError('otp_locked', 'Too many wrong delivery codes. Ask the restaurant to send a new code.', 423, { maxAttempts: OTP_MAX_ATTEMPTS });
    }
    throw invalid('otp_invalid', 'The delivery code is not correct');
  }

  // ---------------------------------------------------------------------------
  // Drivers (manager view)
  // ---------------------------------------------------------------------------
  async listDrivers(ctx: TenantContext, opts: { includeSuspended?: boolean } = {}) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `${DRIVER_SELECT} where d.org_id = $1 and ($2::uuid[] is null or d.branch_ids is null or d.branch_ids && $2)
            and ($3 or d.status <> 'suspended') order by d.status, d.display_name`, [ctx.orgId, ctx.branchFilter, !!opts.includeSuspended]);
      return { items: rows.map(toDriverView) };
    });
  }

  async driverProfile(ctx: TenantContext, driverId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`${DRIVER_SELECT} where d.id = $1`, [driverId]);
      if (!r || !this.driverVisible(ctx, r.branch_ids)) throw notFound('Driver');
      const stats = await tx.one<any>(
        `select count(*) filter (where status = 'delivered')::int as delivered, count(*) filter (where status = 'failed')::int as failed,
                count(*) filter (where status = 'delivered' and delivered_at > now() - interval '7 days')::int as delivered_7d
           from delivery_jobs where driver_id = $1`, [driverId]);
      const devices = await tx.query('select platform, device_id, app_version, push_token is not null as has_push, last_seen_at from driver_devices where driver_id = $1 order by last_seen_at desc', [driverId]);
      const settlements = await tx.query('select id, amount_minor, currency, job_ids, note, created_at from driver_cash_settlements where driver_id = $1 order by created_at desc limit 20', [driverId]);
      const collected = await tx.query(`${JOB_SELECT} where j.driver_id = $1 and j.cash_status = 'collected' order by j.delivered_at`, [driverId]);
      return {
        ...toDriverView(r),
        stats: { delivered: stats.delivered, failed: stats.failed, delivered7d: stats.delivered_7d },
        devices: devices.map((d) => ({ platform: d.platform, deviceId: d.device_id, appVersion: d.app_version, hasPushToken: d.has_push, lastSeenAt: d.last_seen_at })),
        unsettledJobs: collected.map(toJobView),
        settlements: settlements.map((s) => ({ id: s.id, amountMinor: s.amount_minor, currency: s.currency, jobIds: s.job_ids, note: s.note, createdAt: s.created_at })),
      };
    });
  }

  async updateDriver(ctx: TenantContext, driverId: string, patch: { displayName?: string; phone?: string | null; vehicleType?: VehicleType; vehiclePlate?: string | null; branchIds?: string[] | null; status?: 'active' | 'suspended' }) {
    await this.db.scoped(ctx, async (tx) => {
      const d = await tx.maybeOne<any>('select * from drivers where id = $1 for update', [driverId]);
      if (!d || !this.driverVisible(ctx, d.branch_ids)) throw notFound('Driver');
      if (patch.branchIds?.length) {
        for (const b of patch.branchIds) ctx.assertBranch(b);
        const { n: valid } = await tx.one<{ n: number }>('select count(*)::int as n from branches where org_id = $1 and id = any($2)', [ctx.orgId, patch.branchIds]);
        if (valid !== new Set(patch.branchIds).size) throw invalid('unknown_branch', 'One or more branches do not exist');
      }
      if (patch.status === 'suspended' && d.status !== 'suspended') {
        const active = await tx.one<{ n: number }>(`select count(*)::int as n from delivery_jobs where driver_id = $1 and status in ('assigned', 'accepted', 'picked_up', 'en_route')`, [driverId]);
        if (active.n > 0) throw conflict('driver_has_active_jobs', 'Reassign this driver\'s active deliveries before suspending them');
        const offered = await tx.query<any>(
          `select j.* from delivery_jobs j join delivery_offers f on f.job_id = j.id
            where f.driver_id = $1 and f.status = 'offered' and j.status = 'offered' for update of j`, [driverId]);
        for (const job of offered) await this.release(tx, ctx, job, 'driver_suspended');
      }
      await tx.query(
        `update drivers set display_name = coalesce($2, display_name), phone_e164 = case when $3 then $4 else phone_e164 end,
            vehicle_type = coalesce($5, vehicle_type), vehicle_plate = case when $6 then $7 else vehicle_plate end,
            branch_ids = case when $8 then $9::uuid[] else branch_ids end, status = coalesce($10, status),
            availability = case when $10 = 'suspended' then 'offline' else availability end
          where id = $1`,
        [driverId, patch.displayName ?? null, patch.phone !== undefined, patch.phone ?? null, patch.vehicleType ?? null,
          patch.vehiclePlate !== undefined, patch.vehiclePlate ?? null, patch.branchIds !== undefined, patch.branchIds ?? null, patch.status ?? null]);
      await this.audit.record(tx, ctx, { action: patch.status === 'suspended' ? 'driver.suspended' : 'driver.updated', entityType: 'driver', entityId: driverId, metadata: { fields: Object.keys(patch) } });
    });
    return this.driverProfile(ctx, driverId);
  }

  private driverVisible(ctx: TenantContext, branchIds: string[] | null) {
    return ctx.branchFilter === null || branchIds === null || branchIds.some((b) => ctx.branchFilter!.includes(b));
  }

  // ---------------------------------------------------------------------------
  // Cash settlement
  // ---------------------------------------------------------------------------
  /** The driver hands over collected COD cash; the exact collected amount must be settled. */
  async settle(ctx: TenantContext, input: SettlementInput, key?: string) {
    return this.db.scoped(ctx, (tx) => this.withKey(tx, ctx, 'delivery.settle', key, input, async () => {
      const driver = await tx.maybeOne<any>('select id, branch_ids from drivers where id = $1 for update', [input.driverId]);
      if (!driver || !this.driverVisible(ctx, driver.branch_ids)) throw notFound('Driver');
      const ids = [...new Set(input.jobIds)];
      const jobs = await tx.query<any>('select id, branch_id, driver_id, cash_status, cash_collected_minor from delivery_jobs where id = any($1) for update', [ids]);
      if (jobs.length !== ids.length) throw notFound('Delivery job');
      for (const j of jobs) {
        ctx.assertBranch(j.branch_id);
        if (j.driver_id !== driver.id) throw conflict('job_driver_mismatch', 'A selected delivery belongs to another driver');
        if (j.cash_status !== 'collected') throw conflict('cash_not_collected', 'A selected delivery has no unsettled cash', { jobId: j.id, cashStatus: j.cash_status });
      }
      const expected = jobs.reduce((s, j) => s + Number(j.cash_collected_minor), 0);
      if (expected !== input.amountMinor) {
        throw invalid('settlement_amount_mismatch', 'The amount must equal the cash collected on the selected deliveries', { expectedMinor: expected });
      }
      const { currency } = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      const row = await tx.one<any>(
        `insert into driver_cash_settlements(org_id, driver_id, amount_minor, currency, job_ids, received_by, note)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`, [ctx.orgId, driver.id, input.amountMinor, currency, ids, ctx.userId, input.note ?? null]);
      await tx.query(`update delivery_jobs set cash_status = 'settled' where id = any($1)`, [ids]);
      for (const id of ids) await this.recordEvent(tx, ctx.orgId, id, null, 'delivered', actorOf(ctx), {}, { cash: 'settled', settlementId: row.id });
      await this.audit.record(tx, ctx, { action: 'delivery.cash_settled', entityType: 'driver_cash_settlement', entityId: row.id, metadata: { driverId: driver.id, amountMinor: input.amountMinor, jobs: ids.length } });
      return { id: row.id, driverId: row.driver_id, amountMinor: row.amount_minor, currency: row.currency, jobIds: row.job_ids, note: row.note, createdAt: row.created_at };
    }));
  }

  async listSettlements(ctx: TenantContext, driverId?: string) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `select s.*, d.display_name, d.branch_ids from driver_cash_settlements s join drivers d on d.id = s.driver_id
          where s.org_id = $1 and ($2::uuid is null or s.driver_id = $2) order by s.created_at desc limit 200`, [ctx.orgId, driverId ?? null]);
      return { items: rows.filter((s) => this.driverVisible(ctx, s.branch_ids)).map((s) => ({
        id: s.id, driverId: s.driver_id, driverName: s.display_name, amountMinor: s.amount_minor, currency: s.currency, jobIds: s.job_ids, note: s.note, createdAt: s.created_at,
      })) };
    });
  }

  // ---------------------------------------------------------------------------
  // Scheduled: offer expiry
  // ---------------------------------------------------------------------------
  async expireOffers(): Promise<{ expired: number }> {
    const due = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string }>(
      `select id, org_id from delivery_offers where status = 'offered' and expires_at <= now() order by expires_at limit 500`));
    const byOrg = new Map<string, string[]>();
    for (const d of due) byOrg.set(d.org_id, [...(byOrg.get(d.org_id) ?? []), d.id]);
    let expired = 0;
    for (const [orgId, ids] of byOrg) {
      const ctx = this.systemCtx(orgId);
      expired += await this.db.withTenant(orgId, async (tx) => {
        let count = 0;
        const offers = await tx.query<any>(
          `select * from delivery_offers where id = any($1) and status = 'offered' and expires_at <= now() for update skip locked`, [ids]);
        for (const offer of offers) {
          await tx.query(`update delivery_offers set status = 'expired', responded_at = now() where id = $1`, [offer.id]);
          const job = await tx.maybeOne<any>('select * from delivery_jobs where id = $1 for update', [offer.job_id]);
          if (job?.status === 'offered') {
            await this.move(tx, orgId, job, 'unassigned', actorOf(ctx), {}, { reason: 'offer_expired', offerId: offer.id, driverId: offer.driver_id });
          }
          count++;
        }
        return count;
      }, 'system:delivery.expire_offers');
    }
    return { expired };
  }

  systemCtx(orgId: string) {
    return TenantContext.system(orgId, 'delivery');
  }

  // ---------------------------------------------------------------------------
  async viewOf(tx: Tx, jobId: string) {
    return toJobView(await tx.one(`${JOB_SELECT} where j.id = $1`, [jobId]));
  }

  /** Baseline ETA from a point to the job's drop-off. */
  etaFrom(job: any, from: { latitude: number; longitude: number } | null, vehicle: VehicleType): Date | null {
    const dLat = n(job.dropoff_latitude), dLng = n(job.dropoff_longitude);
    if (!from || dLat === null || dLng === null) return null;
    return new Date(Date.now() + estimateTravelSeconds(haversineMeters(from, { latitude: dLat, longitude: dLng }), vehicle) * 1000);
  }

  async withKey<T>(tx: Tx, ctx: TenantContext, scope: string, key: string | undefined, payload: unknown, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    if (key.length < 8 || key.length > 200) throw invalid('invalid_idempotency_key', 'Idempotency-Key must be 8–200 characters');
    return this.idempotency.run(tx, ctx.orgId, scope, key, payload, fn);
  }
}
