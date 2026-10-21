// FT-22: Web Push to the driver PWA. Subscriptions are validated and sealed; offers, assignments and cancellations
// reach the driver's subscribed devices once per event, after commit; a 410 from the push service drops the
// subscription. The push service is scripted (nothing leaves the box); the payload is checked by decrypting it.
import { createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { generateVapidKeys } from '@resuto/integrations';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { ENV } from '../src/config/env';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
let tenant: TestTenant;
let menu: SeededMenu;
let manager: TestUser;
let driver: TestUser;
let driverId: string;
const vapid = { ...generateVapidKeys(), subject: 'mailto:ops@resuto.example' };
// A browser's subscription keys (receiver side), so the test can decrypt what the API sent.
const ua = createECDH('prime256v1');
ua.generateKeys();
const auth16 = Buffer.alloc(16, 7);
const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/driver-device-1') =>
  ({ endpoint, expirationTime: null, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth16.toString('base64url') } });
const DEVICE = 'web-device-0001';

function decrypt(body: Buffer) {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]!);
  const ct = body.subarray(21 + body[20]!);
  const h = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
  const ikm = h(h(auth16, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const d = createDecipheriv('aes-128-gcm', h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(out.subarray(0, -1).toString('utf8'));
}
/** A scripted push service that keeps the raw (binary) body. */
function pushService(status: number) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((v, k) => { headers[k] = v; });
    calls.push({ url: String(url), headers, body: Buffer.from(init.body as Uint8Array) });
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

beforeAll(async () => {
  t = await bootTestApp();
  http = t.app.get(ProviderHttp);
  original = http.fetch;
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  await sql(`update branches set latitude = 30.0444, longitude = 31.2357 where id = $1`, [tenant.branchId]);
  manager = await addMember(t, tenant, 'manager');
  driver = await addMember(t, tenant, 'driver', [tenant.branchId]);
  driverId = (await sql(`select id from drivers where user_id = $1`, [driver.userId]))[0].id;
  await sql(`update outbox_events set published_at = now() where published_at is null`);
});
afterEach(() => { http.fetch = original; });
afterAll(async () => { await t.close(); });

const D = (p: string) => `/v1/o/${tenant.orgId}/driver${p}`;
const M = (p: string) => `/v1/o/${tenant.orgId}/delivery${p}`;
const env = () => t.app.get(ENV) as Record<string, unknown>;
const withVapid = () => Object.assign(env(), { WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey, WEB_PUSH_SUBJECT: vapid.subject });
const withoutVapid = () => Object.assign(env(), { WEB_PUSH_VAPID_PUBLIC_KEY: undefined, WEB_PUSH_VAPID_PRIVATE_KEY: undefined, WEB_PUSH_SUBJECT: undefined });

async function freshJob() {
  const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  const o = await t.app.get(DbService).scoped(ctx, (tx) => t.app.get(OrdersKernelService).place(tx, ctx, {
    branchId: tenant.branchId, channel: 'web', fulfillment: 'delivery', lines: [{ productId: menu.products.fries, quantity: 1 }],
    customer: { name: 'Salma', phone: '+201005550001' }, deliveryAddress: { line1: '5 Tahrir Sq', area: 'Downtown', city: 'Cairo', latitude: 30.045, longitude: 31.24 },
    initialStatus: 'placed',
  }));
  await t.app.get(EventDispatcher).drain();
  return (await sql(`select id from delivery_jobs where order_id = $1`, [o.id]))[0].id as string;
}

describe('driver Web Push (FT-22)', () => {
  it('without VAPID keys: reported unavailable and subscribing is refused', async () => {
    withoutVapid();
    expect((await t.http.get(D(`/me/push?deviceId=${DEVICE}`)).set(auth(driver))).body).toEqual({ available: false, publicKey: null, subscribed: false, lastSuccessAt: null, lastError: null });
    const r = await t.http.post(D('/me/push')).set(auth(driver)).send({ deviceId: DEVICE, subscription: subscription() });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('push_not_configured');
  });

  it('validates and seals the subscription; only drivers can subscribe', async () => {
    withVapid();
    const bad = await t.http.post(D('/me/push')).set(auth(driver)).send({ deviceId: DEVICE, subscription: subscription('https://attacker.example/push/1') });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_subscription');
    expect((await t.http.post(D('/me/push')).set(auth(manager)).send({ deviceId: DEVICE, subscription: subscription() })).status).toBe(403);
    const ok = await t.http.post(D('/me/push')).set(auth(driver)).send({ deviceId: DEVICE, subscription: subscription(), appVersion: 'pwa-1' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const cfg = await t.http.get(D(`/me/push?deviceId=${DEVICE}`)).set(auth(driver));
    expect(cfg.body).toMatchObject({ available: true, publicKey: vapid.publicKey, subscribed: true });
    const [row] = await sql(`select push_subscription_sealed as s, push_endpoint_hash as h, platform from driver_devices where driver_id = $1 and device_id = $2`, [driverId, DEVICE]);
    expect(row.s).not.toContain('fcm.googleapis.com');
    expect(row.h).toMatch(/^[0-9a-f]{64}$/);
    expect(row.platform).toBe('web');
  });

  it('notifies the driver of an offer and of the cancellation, once per event, with no customer data in the payload', async () => {
    withVapid();
    await t.http.patch(D('/me/availability')).set(auth(driver)).send({ availability: 'available' }).expect(200);
    const jobId = await freshJob();
    const f = pushService(201);
    http.fetch = f.fetch;
    const offer = await t.http.post(M(`/jobs/${jobId}/assign`)).set(auth(manager)).send({ driverId, mode: 'offer', offerTtlSeconds: 60 });
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);
    expect(f.calls).toHaveLength(0); // never inside the request transaction
    await t.app.get(EventDispatcher).drain();
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://fcm.googleapis.com/fcm/send/driver-device-1');
    expect(call.headers).toMatchObject({ ttl: '120', 'content-encoding': 'aes128gcm', urgency: 'high' });
    expect(call.headers.authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${vapid.publicKey}$`));
    const payload = decrypt(call.body);
    expect(payload).toEqual({ v: 1, kind: 'offer', jobId, orgId: tenant.orgId, url: `/driver/jobs/${jobId}` });
    expect(JSON.stringify(payload)).not.toMatch(/Salma|Tahrir|\+2010/);
    // Redelivery of the same events: no second notification.
    await sql(`update outbox_events set published_at = null where aggregate_id = $1 and event_type = 'delivery.assigned'`, [jobId]);
    await t.app.get(EventDispatcher).drain();
    expect(f.calls).toHaveLength(1);

    await t.http.post(M(`/jobs/${jobId}/cancel`)).set(auth(manager)).send({ reason: 'Customer called to cancel' }).expect(200);
    await t.app.get(EventDispatcher).drain();
    expect(f.calls).toHaveLength(2);
    expect(decrypt(f.calls[1]!.body)).toMatchObject({ kind: 'cancelled', jobId });
    const events = await sql(`select kind, status from driver_push_events where job_id = $1 order by created_at, kind`, [jobId]);
    expect(events).toEqual([{ kind: 'offer', status: 'accepted' }, { kind: 'cancelled', status: 'accepted' }]);
  });

  it('a 410 from the push service removes the subscription; the next event sends nothing', async () => {
    withVapid();
    http.fetch = pushService(410).fetch;
    const res = await t.http.post(D(`/me/push/${DEVICE}/test`)).set(auth(driver));
    expect(res.body).toEqual({ sent: 0, devices: { [DEVICE]: 'gone' } });
    const [row] = await sql(`select push_subscription_sealed as s, push_last_error as e from driver_devices where driver_id = $1 and device_id = $2`, [driverId, DEVICE]);
    expect(row).toEqual({ s: null, e: 'subscription_expired' });
    const f = pushService(201);
    http.fetch = f.fetch;
    const jobId = await freshJob();
    await t.http.post(M(`/jobs/${jobId}/assign`)).set(auth(manager)).send({ driverId }).expect(200);
    await t.app.get(EventDispatcher).drain();
    expect(f.calls).toHaveLength(0);
    expect((await t.http.get(D(`/me/push?deviceId=${DEVICE}`)).set(auth(driver))).body).toMatchObject({ subscribed: false, lastError: 'subscription_expired' });
  });
});
