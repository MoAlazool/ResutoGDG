import { Injectable } from '@nestjs/common';
import type { DeliverJob, DeviceRegistration, DriverAvailability, FailJob, LocationBatch, VehicleType } from '@resuto/contracts';
import { nearestNeighbourSequencer, type RoutePoint } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { safeEqual } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { OrdersKernelService } from '../kernel/orders-kernel.service';
import { PaymentLedgerService } from '../kernel/payment-ledger.service';
import { JOB_SELECT, decodeCursor, encodeCursor, toDriverView, toJobView, DRIVER_SELECT } from './delivery.mappers';
import { DeliveryService, type Actor, type Coordinates } from './delivery.service';

/** Location batches per driver per minute (the web app sends one every ~15 s). */
export const LOCATION_BATCHES_PER_MINUTE = 12;
const LIVE = ['accepted', 'picked_up', 'en_route'];
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Driver self-service (role "driver", permission delivery:drive). Every call
 * resolves the caller's own drivers row; a driver only ever sees jobs assigned
 * or offered to them (other jobs are 404).
 */
@Injectable()
export class DriverAppService {
  constructor(
    private readonly db: DbService,
    private readonly delivery: DeliveryService,
    private readonly orders: OrdersKernelService,
    private readonly ledger: PaymentLedgerService,
    private readonly limiter: RateLimiter,
  ) {}

  private async me(tx: Tx, ctx: TenantContext, lock = false) {
    const d = await tx.maybeOne<any>(`select * from drivers where org_id = $1 and user_id = $2${lock ? ' for update' : ''}`, [ctx.orgId, ctx.userId]);
    if (!d) throw forbidden('You are not registered as a driver for this restaurant');
    if (d.status === 'suspended') throw new DomainError('driver_suspended', 'Your driver account is suspended. Contact your manager.', 403);
    return d;
  }

  private actor(driver: any): Actor {
    return { type: 'driver', id: driver.id };
  }

  async profile(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const view = toDriverView(await tx.one(`${DRIVER_SELECT} where d.id = $1`, [d.id]));
      const offers = await tx.one<{ n: number }>(`select count(*)::int as n from delivery_offers where driver_id = $1 and status = 'offered' and expires_at > now()`, [d.id]);
      const org = await tx.one<any>('select name, name_ar, currency, timezone from organizations where id = $1', [ctx.orgId]);
      return { ...view, pendingOffers: offers.n, org: { id: ctx.orgId, name: org.name, nameAr: org.name_ar, currency: org.currency, timezone: org.timezone } };
    });
  }

  async setAvailability(ctx: TenantContext, availability: DriverAvailability) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx, true);
      const live = await tx.one<{ n: number }>(`select count(*)::int as n from delivery_jobs where driver_id = $1 and status in ('assigned', 'accepted', 'picked_up', 'en_route')`, [d.id]);
      if (availability === 'offline' && live.n > 0) throw conflict('active_jobs', 'Finish or hand back your active deliveries before going offline');
      if (availability === 'available' && live.n > 0) availability = 'busy';
      await tx.query('update drivers set availability = $2 where id = $1', [d.id, availability]);
      if (availability === 'offline') {
        // Going offline declines live offers so dispatch can re-offer them.
        const offered = await tx.query<any>(
          `select j.*, f.id as offer_id from delivery_jobs j join delivery_offers f on f.job_id = j.id
            where f.driver_id = $1 and f.status = 'offered' and j.status = 'offered' for update of j, f`, [d.id]);
        for (const job of offered) {
          await tx.query(`update delivery_offers set status = 'declined', responded_at = now() where id = $1`, [job.offer_id]);
          await this.delivery.move(tx, ctx.orgId, job, 'unassigned', this.actor(d), {}, { reason: 'driver_went_offline', offerId: job.offer_id });
        }
      }
      return { availability };
    });
  }

  async registerDevice(ctx: TenantContext, input: DeviceRegistration) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const row = await tx.one<any>(
        `insert into driver_devices(org_id, driver_id, platform, device_id, push_token, app_version) values ($1, $2, $3, $4, $5, $6)
         on conflict (driver_id, device_id) do update set platform = excluded.platform, push_token = coalesce(excluded.push_token, driver_devices.push_token),
           app_version = excluded.app_version, last_seen_at = now()
         returning id, platform, device_id, app_version, push_token is not null as has_push, last_seen_at`,
        [ctx.orgId, d.id, input.platform, input.deviceId, input.pushToken ?? null, input.appVersion ?? null]);
      return { id: row.id, platform: row.platform, deviceId: row.device_id, appVersion: row.app_version, hasPushToken: row.has_push, lastSeenAt: row.last_seen_at };
    });
  }

  async removeDevice(ctx: TenantContext, deviceId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const rows = await tx.query('delete from driver_devices where driver_id = $1 and device_id = $2 returning id', [d.id, deviceId]);
      if (!rows.length) throw notFound('Device');
      return { removed: true };
    });
  }

  /**
   * Batched GPS ingest. Rate limited per driver; accepted only while the driver
   * is on shift (not offline) or carries an active job. Points older than one
   * hour or in the future are dropped. Updates the en-route ETA baseline.
   */
  async ingestLocations(ctx: TenantContext, batch: LocationBatch) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      this.limiter.hit(`driver-location:${d.id}`, LOCATION_BATCHES_PER_MINUTE, 60_000);
      const job = await tx.maybeOne<any>(
        `select * from delivery_jobs where driver_id = $1 and status in ('accepted', 'picked_up', 'en_route')
          order by (status = 'en_route') desc, (status = 'picked_up') desc, accepted_at limit 1`, [d.id]);
      if (d.availability === 'offline' && !job) throw conflict('not_on_shift', 'Location is only shared while you are on shift');
      const now = Date.now();
      const points = batch.points
        .map((p) => ({ ...p, at: p.recordedAt ? Date.parse(p.recordedAt) : now }))
        .filter((p) => p.at <= now + 120_000 && p.at >= now - 3_600_000)
        .sort((a, b) => a.at - b.at);
      if (points.length) {
        await tx.query(
          `insert into driver_locations(org_id, driver_id, job_id, latitude, longitude, accuracy_m, recorded_at)
           select $1, $2, $3, p.lat, p.lng, p.acc, p.at from unnest($4::numeric[], $5::numeric[], $6::numeric[], $7::timestamptz[]) as p(lat, lng, acc, at)`,
          [ctx.orgId, d.id, job?.id ?? null, points.map((p) => p.latitude), points.map((p) => p.longitude),
            points.map((p) => p.accuracyM ?? null), points.map((p) => new Date(p.at).toISOString())]);
        const last = points[points.length - 1]!;
        await tx.query('update drivers set last_latitude = $2, last_longitude = $3, last_location_at = $4 where id = $1 and (last_location_at is null or last_location_at <= $4)',
          [d.id, last.latitude, last.longitude, new Date(last.at).toISOString()]);
        if (job && (job.status === 'en_route' || job.status === 'picked_up')) {
          const eta = this.delivery.etaFrom(job, { latitude: last.latitude, longitude: last.longitude }, d.vehicle_type as VehicleType);
          if (eta) await tx.query('update delivery_jobs set eta_at = $2 where id = $1', [job.id, eta]);
        }
      }
      return { accepted: points.length, dropped: batch.points.length - points.length, jobId: job?.id ?? null };
    });
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------
  async myJobs(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const active = await tx.query(`${JOB_SELECT} where j.driver_id = $1 and j.status in ('assigned', 'accepted', 'picked_up', 'en_route') order by j.assigned_at, j.created_at`, [d.id]);
      const offers = await tx.query(
        `${JOB_SELECT} where j.status = 'offered' and ofr.driver_id = $1 and ofr.expires_at > now() order by ofr.expires_at`, [d.id]);
      // Multi-drop suggestion for jobs with coordinates still to deliver (nearest-neighbour baseline).
      const origin: RoutePoint | null = n(d.last_latitude) !== null && n(d.last_longitude) !== null
        ? { latitude: n(d.last_latitude)!, longitude: n(d.last_longitude)! }
        : active[0] && n(active[0].pickup_latitude) !== null ? { latitude: n(active[0].pickup_latitude)!, longitude: n(active[0].pickup_longitude)! } : null;
      const stops = active.filter((j) => n(j.dropoff_latitude) !== null && n(j.dropoff_longitude) !== null)
        .map((j) => ({ id: j.id, location: { latitude: n(j.dropoff_latitude)!, longitude: n(j.dropoff_longitude)! } }));
      const route = origin && stops.length > 1 ? nearestNeighbourSequencer.sequence({ origin, stops, vehicle: d.vehicle_type }) : null;
      return { active: active.map(toJobView), offers: offers.map(toJobView), route };
    });
  }

  async history(ctx: TenantContext, q: { limit: number; cursor?: string }) {
    const cursor = decodeCursor(q.cursor);
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const rows = await tx.query(
        `${JOB_SELECT} where j.driver_id = $1 and j.status in ('delivered', 'failed', 'cancelled')
            and ($2::timestamptz is null or (j.created_at, j.id) < ($2, $3::uuid))
          order by j.created_at desc, j.id desc limit $4`, [d.id, cursor?.at ?? null, cursor?.id ?? null, q.limit]);
      const last = rows[rows.length - 1];
      return { items: rows.map(toJobView), nextCursor: rows.length === q.limit && last ? encodeCursor(last.created_at, last.id) : null };
    });
  }

  async cashSummary(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const collected = await tx.query(`${JOB_SELECT} where j.driver_id = $1 and j.cash_status = 'collected' order by j.delivered_at`, [d.id]);
      const pending = await tx.query(`${JOB_SELECT} where j.driver_id = $1 and j.cash_status = 'pending' and j.status in ('accepted', 'picked_up', 'en_route') order by j.accepted_at`, [d.id]);
      const settlements = await tx.query('select id, amount_minor, currency, job_ids, note, created_at from driver_cash_settlements where driver_id = $1 order by created_at desc limit 20', [d.id]);
      const { currency } = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      return {
        currency,
        onHandMinor: collected.reduce((s, j) => s + Number(j.cash_collected_minor), 0),
        toCollectMinor: pending.reduce((s, j) => s + Number(j.cod_amount_minor), 0),
        collectedJobs: collected.map(toJobView),
        toCollectJobs: pending.map(toJobView),
        settlements: settlements.map((s) => ({ id: s.id, amountMinor: s.amount_minor, currency: s.currency, jobCount: s.job_ids.length, note: s.note, createdAt: s.created_at })),
      };
    });
  }

  /** A driver may read a job assigned to them or offered to them; anything else is 404. */
  async job(ctx: TenantContext, jobId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const r = await tx.maybeOne(`${JOB_SELECT} where j.id = $1`, [jobId]);
      if (!r || !(r.driver_id === d.id || (r.status === 'offered' && r.offer_driver_id === d.id))) throw notFound('Delivery job');
      const detail = await this.delivery.detail(tx, r);
      return { ...detail, offers: undefined, events: detail.events.filter((e) => e.actorType !== 'system' || e.toStatus !== 'unassigned') };
    });
  }

  private async ownJob(tx: Tx, ctx: TenantContext, d: any, jobId: string) {
    const job = await tx.maybeOne<any>('select * from delivery_jobs where id = $1 for update', [jobId]);
    if (!job || job.driver_id !== d.id) throw notFound('Delivery job');
    return job;
  }

  async accept(ctx: TenantContext, jobId: string, at: Coordinates) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx, true);
      const job = await tx.maybeOne<any>('select * from delivery_jobs where id = $1 for update', [jobId]);
      if (!job) throw notFound('Delivery job');
      if (job.status === 'offered') {
        const offer = await tx.maybeOne<any>(`select * from delivery_offers where job_id = $1 and status = 'offered' for update`, [jobId]);
        if (!offer || offer.driver_id !== d.id) throw notFound('Delivery job');
        if (new Date(offer.expires_at).getTime() <= Date.now()) throw conflict('offer_expired', 'This offer has expired');
        await tx.query(`update delivery_offers set status = 'accepted', responded_at = now() where id = $1`, [offer.id]);
        await this.delivery.move(tx, ctx.orgId, job, 'accepted', this.actor(d), { driver_id: d.id, assigned_at: new Date(), accepted_at: new Date() }, { offerId: offer.id }, at);
      } else {
        if (job.driver_id !== d.id) throw notFound('Delivery job');
        if (job.status === 'accepted') return this.delivery.viewOf(tx, job.id);
        await this.delivery.move(tx, ctx.orgId, job, 'accepted', this.actor(d), { accepted_at: new Date() }, {}, at);
      }
      await tx.query(`update drivers set availability = 'busy' where id = $1`, [d.id]);
      return this.delivery.viewOf(tx, job.id);
    });
  }

  async decline(ctx: TenantContext, jobId: string, reason: string | null | undefined, at: Coordinates) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx, true);
      const job = await tx.maybeOne<any>('select * from delivery_jobs where id = $1 for update', [jobId]);
      if (!job) throw notFound('Delivery job');
      if (job.status === 'offered') {
        const offer = await tx.maybeOne<any>(`select * from delivery_offers where job_id = $1 and status = 'offered' for update`, [jobId]);
        if (!offer || offer.driver_id !== d.id) throw notFound('Delivery job');
        await tx.query(`update delivery_offers set status = 'declined', responded_at = now() where id = $1`, [offer.id]);
        await this.delivery.move(tx, ctx.orgId, job, 'unassigned', this.actor(d), {}, { reason: reason ?? 'declined', offerId: offer.id, declinedBy: d.id }, at);
      } else {
        if (job.driver_id !== d.id) throw notFound('Delivery job');
        if (job.status !== 'assigned') throw new DomainError('invalid_transition', 'Only new assignments can be declined; ask dispatch to reassign accepted deliveries', 409, { from: job.status, to: 'unassigned' });
        await this.delivery.move(tx, ctx.orgId, job, 'unassigned', this.actor(d), { driver_id: null, assigned_at: null }, { reason: reason ?? 'declined', declinedBy: d.id }, at);
      }
      await this.delivery.refreshAvailability(tx, d.id);
      return { id: job.id, status: 'unassigned' as const };
    });
  }

  /**
   * Pickup rule: the driver can only confirm pickup once the kitchen has marked
   * the order `ready` (order state machine), so food never leaves unfinished
   * and order/delivery states stay consistent.
   */
  async pickup(ctx: TenantContext, jobId: string, at: Coordinates) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const job = await this.ownJob(tx, ctx, d, jobId);
      this.delivery.assertTransition(job.status, 'picked_up');
      const order = await tx.one<{ status: string }>('select status from orders where id = $1', [job.order_id]);
      if (order.status !== 'ready') {
        throw new DomainError('order_not_ready', 'The kitchen has not marked this order ready yet', 409, { orderStatus: order.status });
      }
      const pickupPoint = n(job.pickup_latitude) !== null ? { latitude: n(job.pickup_latitude)!, longitude: n(job.pickup_longitude)! } : null;
      await this.delivery.move(tx, ctx.orgId, job, 'picked_up', this.actor(d), { picked_up_at: new Date(), eta_at: this.delivery.etaFrom(job, pickupPoint, d.vehicle_type) }, {}, at);
      return this.delivery.viewOf(tx, job.id);
    });
  }

  async enRoute(ctx: TenantContext, jobId: string, at: Coordinates) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const job = await this.ownJob(tx, ctx, d, jobId);
      if (job.status === 'en_route') return this.delivery.viewOf(tx, job.id);
      const from = at.latitude != null && at.longitude != null ? { latitude: at.latitude, longitude: at.longitude } : null;
      const eta = this.delivery.etaFrom(job, from, d.vehicle_type);
      await this.delivery.move(tx, ctx.orgId, job, 'en_route', this.actor(d), eta ? { eta_at: eta } : {}, {}, at);
      return this.delivery.viewOf(tx, job.id);
    });
  }

  /** Stores a proof-of-delivery photo (StorageService folder delivery-proofs) and attaches it to the job. */
  async uploadProof(ctx: TenantContext, jobId: string, file: { buffer: Buffer; mimetype: string } | undefined) {
    if (!file?.buffer?.length) throw invalid('file_required', 'Attach a photo');
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx);
      const job = await this.ownJob(tx, ctx, d, jobId);
      if (!['picked_up', 'en_route'].includes(job.status)) throw conflict('job_not_on_route', 'Photos can be added after pickup');
      const media = await this.delivery.storage.put(tx, ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'delivery-proofs', source: 'upload', alt: 'Proof of delivery' });
      await tx.query('update delivery_jobs set proof_media_id = $2 where id = $1', [job.id, media.id]);
      return { mediaId: media.id, url: await this.delivery.storage.signedUrl(media.path, 900) };
    });
  }

  /**
   * Completes a delivery: verifies proof (photo, recipient or code), moves the
   * order ready → delivered through the kernel, records COD cash through the
   * payment ledger (method cod, driverId) and marks the cash as collected.
   * The cash amount must equal what is still due — overpayment is impossible.
   */
  async deliver(ctx: TenantContext, jobId: string, input: DeliverJob, key?: string) {
    return this.db.scoped(ctx, (tx) => this.delivery.withKey(tx, ctx, 'delivery.deliver', key, { jobId, ...input }, async () => {
      const d = await this.me(tx, ctx, true);
      const job = await this.ownJob(tx, ctx, d, jobId);
      this.delivery.assertTransition(job.status, 'delivered');
      if (input.proofMediaId && input.proofMediaId !== job.proof_media_id) throw invalid('proof_not_found', 'Upload the photo for this delivery first');
      let otpVerified = false;
      if (input.otp) {
        if (!job.delivery_otp_hash) throw invalid('otp_not_set', 'This delivery has no delivery code');
        this.limiter.hit(`delivery-otp:${job.id}`, 5, 10 * 60_000);
        if (!safeEqual(this.delivery.otpHash(job.id, input.otp), job.delivery_otp_hash)) throw invalid('otp_invalid', 'The delivery code is not correct');
        otpVerified = true;
      }

      const order = await tx.one<any>('select id, status, currency, branch_id from orders where id = $1', [job.order_id]);
      if (order.status !== 'ready') throw new DomainError('order_not_ready', 'This order cannot be completed in its current state', 409, { orderStatus: order.status });
      await this.orders.transition(tx, ctx, order.id, 'delivered', { reason: 'delivered_by_driver' });

      const { dueMinor } = await this.ledger.outstanding(tx, { orderId: order.id });
      const cash = input.cashCollectedMinor ?? 0;
      let cashSet: Record<string, unknown> = {};
      if (cash > dueMinor) throw new DomainError('overpayment', 'This amount is more than what is still due', 409, { dueMinor });
      if (dueMinor > 0) {
        if (input.cashCollectedMinor === undefined) throw invalid('cash_amount_required', 'Enter the cash collected from the customer', { dueMinor });
        if (cash < dueMinor) throw invalid('cash_amount_mismatch', 'The cash collected must equal the amount due. Mark the delivery failed if the customer cannot pay.', { dueMinor });
        await this.ledger.recordSucceeded(tx, ctx, {
          branchId: order.branch_id, orderId: order.id, method: 'cod', provider: 'manual', amountMinor: cash, currency: order.currency,
          idempotencyKey: `delivery-cod:${job.id}`, driverId: d.id, raw: { deliveryJobId: job.id },
        });
        cashSet = { cash_collected_minor: cash, cod_amount_minor: Math.max(Number(job.cod_amount_minor), cash), cash_status: 'collected' };
      } else if (job.cash_status === 'pending') {
        cashSet = { cash_status: 'none' }; // paid online before arrival
      }

      await this.delivery.move(tx, ctx.orgId, job, 'delivered', this.actor(d), {
        delivered_at: new Date(), eta_at: null, proof_recipient: input.recipientName ?? null, proof_note: input.note ?? null, ...cashSet,
      }, { otpVerified, photo: !!job.proof_media_id, cashCollectedMinor: cash }, input);
      await this.delivery.refreshAvailability(tx, d.id);
      return this.delivery.viewOf(tx, job.id);
    }));
  }

  async fail(ctx: TenantContext, jobId: string, input: FailJob) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.me(tx, ctx, true);
      const job = await this.ownJob(tx, ctx, d, jobId);
      await this.delivery.move(tx, ctx.orgId, job, 'failed', this.actor(d), { failure_reason: input.reason, proof_note: input.note ?? null, eta_at: null }, { reason: input.reason, note: input.note ?? null }, input);
      await this.delivery.refreshAvailability(tx, d.id);
      return this.delivery.viewOf(tx, job.id);
    });
  }
}
