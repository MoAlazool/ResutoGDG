import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderError, sendWebPush, validatePushSubscription, validVapidKeys, type PushSubscriptionJson, type VapidKeys } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService } from '../../common/db/db.service';
import { DomainError, forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { OnDomainEvent, type OutboxEvent } from '../../common/events/events';
import { ENV, type Env } from '../../config/env';
import { ProviderHttp } from '../integrations/provider-http';

export type PushKind = 'offer' | 'assigned' | 'cancelled' | 'unassigned' | 'test';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const LIVE = ['assigned', 'accepted', 'picked_up', 'en_route'];

/**
 * FT-22: Web Push to the driver PWA. Subscriptions are sealed per device; notifications are sent after the domain
 * event committed (outbox handler), one per device and event (redelivery is a no-op), with the true outcome recorded.
 * The payload carries no customer data: just the kind and the job id the app opens (the push service only ever sees
 * ciphertext anyway). A 404/410 from the push service deletes the subscription. Without VAPID keys nothing is sent
 * and the app says notifications are unavailable.
 */
@Injectable()
export class DriverPushService {
  private readonly logger = new Logger('DriverPush');

  constructor(
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly http: ProviderHttp,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private keys(): VapidKeys | null {
    const k = { publicKey: this.env.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: this.env.WEB_PUSH_VAPID_PRIVATE_KEY, subject: this.env.WEB_PUSH_SUBJECT };
    return validVapidKeys(k) ? k : null;
  }

  private async driver(tx: any, ctx: TenantContext) {
    const d = await tx.maybeOne(`select id, status from drivers where org_id = $1 and user_id = $2`, [ctx.orgId, ctx.userId]);
    if (!d) throw forbidden('You are not registered as a driver for this restaurant');
    if (d.status === 'suspended') throw new DomainError('driver_suspended', 'Your driver account is suspended. Contact your manager.', 403);
    return d as { id: string };
  }

  async config(ctx: TenantContext, deviceId?: string | null) {
    const keys = this.keys();
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.driver(tx, ctx);
      const dev = deviceId ? await tx.maybeOne<{ on: boolean; last: Date | null; err: string | null }>(
        `select push_subscription_sealed is not null as on, push_last_success_at as last, push_last_error as err from driver_devices where driver_id = $1 and device_id = $2`,
        [d.id, deviceId]) : null;
      return { available: !!keys, publicKey: keys?.publicKey ?? null, subscribed: !!dev?.on,
        lastSuccessAt: dev?.last ? new Date(dev.last).toISOString() : null, lastError: dev?.err ?? null };
    });
  }

  async subscribe(ctx: TenantContext, input: { deviceId: string; subscription: unknown; appVersion?: string | null }) {
    if (!this.keys()) throw new DomainError('push_not_configured', 'Notifications are not set up on this server yet', 503);
    const v = validatePushSubscription(input.subscription);
    if (!v.ok) throw invalid('invalid_subscription', `This browser's push subscription was refused (${v.reason})`);
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.driver(tx, ctx);
      await tx.query(
        `insert into driver_devices(org_id, driver_id, platform, device_id, app_version, push_subscription_sealed, push_endpoint_hash, push_subscribed_at, push_last_error)
         values ($1, $2, 'web', $3, $4, $5, $6, now(), null)
         on conflict (driver_id, device_id) do update set push_subscription_sealed = excluded.push_subscription_sealed, push_endpoint_hash = excluded.push_endpoint_hash,
           push_subscribed_at = now(), push_last_error = null, last_seen_at = now(), app_version = coalesce(excluded.app_version, driver_devices.app_version)`,
        [ctx.orgId, d.id, input.deviceId, input.appVersion ?? null, this.box.seal(JSON.stringify(v.subscription), `push:${ctx.orgId}:${input.deviceId}`), sha256(v.subscription.endpoint)]);
      return { subscribed: true };
    });
  }

  async unsubscribe(ctx: TenantContext, deviceId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const d = await this.driver(tx, ctx);
      const r = await tx.query(`update driver_devices set push_subscription_sealed = null, push_endpoint_hash = null where driver_id = $1 and device_id = $2 returning id`, [d.id, deviceId]);
      if (!r.length) throw notFound('Device');
      return { subscribed: false };
    });
  }

  /** Sends one test notification to the caller's device (button in the app). */
  async test(ctx: TenantContext, deviceId: string) {
    const d = await this.db.scoped(ctx, (tx) => this.driver(tx, ctx));
    return this.notify(ctx.orgId, d.id, null, 'test', `test:${Date.now()}`, { deviceId });
  }

  // ---------------------------------------------------------------------------
  // Domain events → notifications (after commit)
  // ---------------------------------------------------------------------------
  @OnDomainEvent('delivery.push-assigned', 'delivery.assigned')
  async onAssigned(e: OutboxEvent) {
    if (!e.orgId || typeof e.payload.driverId !== 'string') return;
    await this.notify(e.orgId, e.payload.driverId, e.aggregateId, e.payload.mode === 'offer' ? 'offer' : 'assigned', e.id);
  }

  @OnDomainEvent('delivery.push-released', 'delivery.status_changed')
  async onStatusChanged(e: OutboxEvent) {
    if (!e.orgId) return;
    const { from, to } = e.payload as { from: string; to: string };
    const released = to === 'cancelled' ? [...LIVE, 'offered'].includes(from) : to === 'unassigned' && LIVE.includes(from);
    if (!released) return;
    // The job row no longer names the driver once released: take the driver of the last assignment / offer.
    const driverId = (typeof e.payload.driverId === 'string' && e.payload.driverId) || await this.db.withTenant(e.orgId, async (tx) => (await tx.maybeOne<{ d: string }>(
      `select coalesce(details->>'driverId', actor_id) as d from delivery_events
        where job_id = $1 and to_status in ('offered', 'assigned', 'accepted') and (details ? 'driverId' or actor_type = 'driver')
        order by id desc limit 1`, [e.aggregateId]))?.d ?? null, 'system:push');
    if (!driverId || !/^[0-9a-f-]{36}$/i.test(driverId)) return;
    await this.notify(e.orgId, driverId, e.aggregateId, to === 'cancelled' ? 'cancelled' : 'unassigned', e.id);
  }

  /** One notification per subscribed device of the driver; returns the outcome per device. */
  async notify(orgId: string, driverId: string, jobId: string | null, kind: PushKind, eventKey: string, scope: { deviceId?: string } = {}) {
    const keys = this.keys();
    if (!keys) return { sent: 0, skipped: 'not_configured' as const };
    const devices = await this.db.withTenant(orgId, async (tx) => {
      const rows = await tx.query<{ id: string; device_id: string; sealed: string }>(
        `select id, device_id, push_subscription_sealed as sealed from driver_devices
          where org_id = $1 and driver_id = $2 and push_subscription_sealed is not null and ($3::text is null or device_id = $3)`, [orgId, driverId, scope.deviceId ?? null]);
      const fresh: typeof rows = [];
      for (const r of rows) {
        const ins = await tx.query(`insert into driver_push_events(org_id, driver_id, device_id, job_id, kind, event_key) values ($1, $2, $3, $4, $5, $6)
          on conflict (device_id, event_key) do nothing returning id`, [orgId, driverId, r.id, jobId, kind, eventKey.slice(0, 200)]);
        if (ins.length) fresh.push(r);
      }
      return fresh;
    }, 'system:push');
    const outcomes: Record<string, string> = {};
    for (const dev of devices) {
      let status: 'accepted' | 'gone' | 'failed' = 'failed';
      let error: string | null = null;
      try {
        const sub = JSON.parse(this.box.open(dev.sealed, `push:${orgId}:${dev.device_id}`)) as PushSubscriptionJson;
        await sendWebPush(this.http.fetch, sub, { v: 1, kind, jobId, orgId, url: jobId ? `/driver/jobs/${jobId}` : '/driver' }, keys,
          { ttlSeconds: kind === 'offer' ? 120 : 900, urgency: 'high', topic: jobId ? `job-${jobId.replace(/-/g, '').slice(0, 26)}` : undefined });
        status = 'accepted';
      } catch (err) {
        status = err instanceof ProviderError && err.message === 'web_push: gone' ? 'gone' : 'failed';
        error = (err as Error).message.slice(0, 200);
        this.logger.warn(`push ${kind} to device ${dev.id}: ${error}`);
      }
      outcomes[dev.device_id] = status;
      await this.db.withTenant(orgId, async (tx) => {
        await tx.query(`update driver_push_events set status = $3, error = $4, sent_at = now() where device_id = $1 and event_key = $2`, [dev.id, eventKey.slice(0, 200), status, error]);
        if (status === 'accepted') await tx.query(`update driver_devices set push_last_success_at = now(), push_last_error = null where id = $1`, [dev.id]);
        else if (status === 'gone') await tx.query(`update driver_devices set push_subscription_sealed = null, push_endpoint_hash = null, push_last_error = 'subscription_expired' where id = $1`, [dev.id]);
        else await tx.query(`update driver_devices set push_last_error = $2 where id = $1`, [dev.id, error]);
      }, 'system:push');
    }
    return { sent: Object.values(outcomes).filter((s) => s === 'accepted').length, devices: outcomes };
  }
}
