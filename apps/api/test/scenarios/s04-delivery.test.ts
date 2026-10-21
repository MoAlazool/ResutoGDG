// S04 — Delivery: a WhatsApp cash-on-delivery order becomes a delivery job, is
// dispatched to an invited driver, picked up, delivered with photo proof, the cash
// is collected through the ledger and later settled. HTTP only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../../src/common/events/dispatcher.service';
import { sandboxChannel, walkToMenu } from '../growth-helpers';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { buildMenuViaApi, outboundMessages, PRICES, type ApiMenu } from './support';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

let t: TestApp;
let tenant: TestTenant;
let menu: ApiMenu;
let dispatcherUser: TestUser;
let kitchen: TestUser;
let driver: TestUser;
let driverId: string;
let conversationId: string;
let order: { id: string; number: string; totalMinor: number };
let jobId: string;
let proofMediaId: string;

const D = (p: string) => `/v1/o/${tenant.orgId}/driver${p}`;
const M = (p: string) => `/v1/o/${tenant.orgId}/delivery${p}`;
const drain = () => t.app.get(EventDispatcher).drain();
const TOTAL = PRICES.fries * 2 + PRICES.soda + 2500;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  await t.http.patch(`/v1/o/${tenant.orgId}/branches/${tenant.branchId}`).set(auth(tenant.owner)).send({ latitude: 30.0444, longitude: 31.2357 }).expect(200);
  menu = await buildMenuViaApi(t, tenant);
  dispatcherUser = await addMember(t, tenant, 'manager');
  kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
  driver = await addMember(t, tenant, 'driver', [tenant.branchId]); // invitation → accepted as a driver
});
afterAll(async () => { await t.close(); });

describe('S04 delivery from a WhatsApp COD order', () => {
  it('1. the invited driver appears in the fleet, offline', async () => {
    const list = await t.http.get(M('/drivers')).set(auth(dispatcherUser));
    expect(list.status).toBe(200);
    const mine = list.body.items.find((d: any) => d.userId === driver.userId);
    expect(mine).toMatchObject({ status: 'active', availability: 'offline' });
    driverId = mine.id;
    const me = await t.http.get(D('/me')).set(auth(driver));
    expect(me.status).toBe(200);
  });

  it('2. the customer orders delivery with cash on delivery over WhatsApp', async () => {
    const channelId = (await sandboxChannel(t, tenant)).id;
    const walk = await walkToMenu(t, tenant, channelId, '+201002220001', 'delivery');
    conversationId = walk.conversationId;
    const v = (await t.http.get(`/v1/public/connect/ordering/${walk.token}`)).body;
    const cart = await t.http.post(`/v1/public/connect/ordering/${walk.token}/cart`).send({ version: v.version, lines: [{ productId: menu.fries, quantity: 2 }, { productId: menu.soda, quantity: 1 }] });
    expect(cart.body.quote.totalMinor).toBe(TOTAL);
    const done = await t.http.post(`/v1/public/connect/ordering/${walk.token}/checkout`).send({ version: cart.body.version, paymentMethod: 'cod', expectedTotalMinor: TOTAL });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    order = done.body.order;
    expect(order).toMatchObject({ status: 'placed', totalMinor: TOTAL });
  });

  it('3. a delivery job is created automatically, unassigned, with the cash to collect', async () => {
    await drain();
    const board = await t.http.get(M('/board')).set(auth(dispatcherUser));
    expect(board.status).toBe(200);
    const job = [...board.body.active, ...(board.body.unassigned ?? [])].find((j: any) => j.orderId === order.id);
    expect(job).toBeTruthy();
    jobId = job.id;
    const detail = await t.http.get(M(`/jobs/${jobId}`)).set(auth(dispatcherUser));
    expect(detail.body).toMatchObject({ status: 'unassigned', codAmountMinor: TOTAL, cashStatus: 'pending' });
    expect(detail.body.dropoff).toMatchObject({ line1: '26 July St, building 4, floor 2', customerPhone: '+201002220001' });
    await drain();
    expect((await sql(`select count(*)::int as n from delivery_jobs where order_id = $1`, [order.id]))[0].n).toBe(1);
  });

  it('4. the dispatcher offers it to the driver once online; the driver accepts', async () => {
    const offline = await t.http.post(M(`/jobs/${jobId}/assign`)).set(auth(dispatcherUser)).send({ driverId, mode: 'offer' });
    expect(offline.body.error.code).toBe('driver_unavailable');
    await t.http.patch(D('/me/availability')).set(auth(driver)).send({ availability: 'available' }).expect(200);
    const offer = await t.http.post(M(`/jobs/${jobId}/assign`)).set(auth(dispatcherUser)).send({ driverId, mode: 'offer', offerTtlSeconds: 120 });
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);
    expect(offer.body).toMatchObject({ status: 'offered', offer: { driverId } });
    const inbox = await t.http.get(D('/jobs')).set(auth(driver));
    expect(inbox.body.offers.map((j: any) => j.id)).toContain(jobId);
    const accepted = await t.http.post(D(`/jobs/${jobId}/accept`)).set(auth(driver)).send({ latitude: 30.045, longitude: 31.236 });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', driverId });
  });

  it('5. pickup waits for the kitchen; once ready the driver picks up and heads out', async () => {
    const early = await t.http.post(D(`/jobs/${jobId}/pickup`)).set(auth(driver)).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('order_not_ready');
    for (const to of ['accepted', 'preparing', 'ready']) {
      await t.http.post(`/v1/o/${tenant.orgId}/kitchen/orders/${order.id}/bump`).set(auth(kitchen)).send({ to }).expect(200);
    }
    const picked = await t.http.post(D(`/jobs/${jobId}/pickup`)).set(auth(driver)).send({});
    expect(picked.body.status).toBe('picked_up');
    const enRoute = await t.http.post(D(`/jobs/${jobId}/en-route`)).set(auth(driver)).send({ latitude: 30.046, longitude: 31.237 });
    expect(enRoute.body.status).toBe('en_route');
    await drain();
    const bodies = (await outboundMessages(conversationId)).map((m) => m.body);
    expect(bodies.some((b) => b.includes(`#${order.number} is on the way`))).toBe(true);
  });

  it('6. delivers with a photo proof and collects the exact cash through the ledger', async () => {
    const photo = await t.http.post(D(`/jobs/${jobId}/proof-photo`)).set(auth(driver)).attach('file', PNG, { filename: 'door.png', contentType: 'image/png' });
    expect(photo.status, JSON.stringify(photo.body)).toBe(201);
    proofMediaId = photo.body.mediaId;
    const short = await t.http.post(D(`/jobs/${jobId}/deliver`)).set(auth(driver)).send({ proofMediaId, cashCollectedMinor: TOTAL - 500 });
    expect(short.body.error.code).toBe('cash_amount_mismatch');
    const k = `deliver-${jobId}`;
    const body = { proofMediaId, recipientName: 'Mona', cashCollectedMinor: TOTAL, latitude: 30.05, longitude: 31.24 };
    const done = await t.http.post(D(`/jobs/${jobId}/deliver`)).set(auth(driver)).set('Idempotency-Key', k).send(body);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'delivered', cashStatus: 'collected', cashCollectedMinor: TOTAL, proofRecipient: 'Mona' });
    const replay = await t.http.post(D(`/jobs/${jobId}/deliver`)).set(auth(driver)).set('Idempotency-Key', k).send(body);
    expect(replay.status).toBe(200);
    const detail = await t.http.get(M(`/jobs/${jobId}`)).set(auth(dispatcherUser));
    expect(detail.body.proofPhotoUrl).toMatch(/^http:\/\/api\.test\/v1\/media\//);
    expect(detail.body.events.map((e: any) => e.toStatus)).toEqual(['unassigned', 'offered', 'accepted', 'picked_up', 'en_route', 'delivered']);
  });

  it('7. the order is delivered and paid by COD, and the customer was kept informed', async () => {
    const o = await t.http.get(`/v1/o/${tenant.orgId}/orders/${order.id}`).set(auth(tenant.owner));
    expect(o.body).toMatchObject({ status: 'delivered', paymentStatus: 'paid', paidMinor: TOTAL, dueMinor: 0 });
    expect(o.body.payments).toEqual([expect.objectContaining({ method: 'cod', amountMinor: TOTAL, status: 'succeeded' })]);
    await drain();
    const bodies = (await outboundMessages(conversationId)).map((m) => m.body);
    expect(bodies.some((b) => b.includes(`#${order.number} received`))).toBe(true);
    expect(bodies.some((b) => b.includes(`#${order.number} was delivered`))).toBe(true);
  });

  it('8. the driver hands the cash in and the manager settles it exactly once', async () => {
    const cash = await t.http.get(D('/me/cash')).set(auth(driver));
    expect(cash.status).toBe(200);
    expect(cash.body.onHandMinor).toBe(TOTAL);
    expect(cash.body.collectedJobs.map((j: any) => j.id)).toEqual([jobId]);
    const wrong = await t.http.post(M('/settlements')).set(auth(dispatcherUser)).send({ driverId, jobIds: [jobId], amountMinor: TOTAL - 1 });
    expect(wrong.body.error).toMatchObject({ code: 'settlement_amount_mismatch', details: { expectedMinor: TOTAL } });
    const settled = await t.http.post(M('/settlements')).set(auth(dispatcherUser)).send({ driverId, jobIds: [jobId], amountMinor: TOTAL, note: 'end of shift' });
    expect(settled.status, JSON.stringify(settled.body)).toBe(201);
    expect((await t.http.get(D('/me/cash')).set(auth(driver))).body.onHandMinor).toBe(0);
    const twice = await t.http.post(M('/settlements')).set(auth(dispatcherUser)).send({ driverId, jobIds: [jobId], amountMinor: TOTAL });
    expect(twice.body.error.code).toBe('cash_not_collected');
    expect((await t.http.get(M(`/jobs/${jobId}`)).set(auth(dispatcherUser))).body.cashStatus).toBe('settled');
    const [drv] = await sql(`select availability from drivers where id = $1`, [driverId]);
    expect(drv.availability).toBe('available');
  });
});
