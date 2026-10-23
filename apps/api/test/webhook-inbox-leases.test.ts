// PCL-13 remainder (REM-A02): the provider webhook inbox had no backoff and no processing lease, so the receiving
// request, a provider redelivery and the inbox worker could process one event at the same time, and failed events were
// retried every minute until they hit the attempt cap. Covered here: concurrent claims (one winner; disjoint worker
// batches), the lease fence, the backoff schedule with jitter and cap, dead-lettering after the last attempt, the
// audited superadmin replay, and the end-to-end path through the real Stripe webhook controller.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import {
  INBOX_BACKOFF, INBOX_INLINE_GRACE_SECONDS, INBOX_MAX_ATTEMPTS, WebhookInboxService, inboxBackoffWindow,
} from '../src/common/platform/webhook-inbox.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { CHECKOUT_PORT, type CheckoutPort } from '../src/modules/kernel/ports';
import { PaymentWebhooksService } from '../src/modules/payments/webhooks.service';
import { auth, bootTestApp, createTenant, seedMenu, signup, sql, unique, type TestApp, type TestUser } from './helpers';
import { connect, scriptHealth, scriptProviders, stripeSignature, type Scripted } from './payments-fixtures';

let t: TestApp;
let inbox: WebhookInboxService;

beforeAll(async () => {
  t = await bootTestApp();
  inbox = t.app.get(WebhookInboxService);
});
afterAll(async () => { await t.close(); });

const provider = () => unique('lease-test');
const row = async (id: string) => (await sql(
  `select status, attempts, error, claimed_by, locked_until > now() as leased, dead_lettered_at is not null as dead,
          extract(epoch from next_attempt_at - now())::float8 as due_in, replay_count, alerted_at
     from webhook_inbox where id = $1`, [id]))[0];
const stored = (p: string, key = unique('evt')) => inbox.store({ provider: p, eventKey: key, signatureValid: true, payload: { n: 1 } });
/** Moves a row's retry time (and any lease) into the past, as if the backoff had elapsed. */
const makeDue = (id: string) => sql(`update webhook_inbox set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);

describe('claims and the processing lease', () => {
  it('exactly one of many concurrent claims on an event wins; the loser gets null and records nothing', async () => {
    const rec = await stored(provider());
    const claims = await Promise.all(Array.from({ length: 8 }, () => inbox.claim(rec.id)));
    const winners = claims.filter((c): c is string => c !== null);
    expect(winners).toHaveLength(1);
    expect(await row(rec.id)).toMatchObject({ status: 'received', leased: true, claimed_by: winners[0] });
    // A claim that is not the current holder cannot record an outcome.
    expect(await inbox.markProcessed(rec.id, 'someone-else', 'processed')).toBe(false);
    expect(await row(rec.id)).toMatchObject({ status: 'received', attempts: 0 });
    expect(await inbox.markProcessed(rec.id, winners[0]!, 'processed')).toBe(true);
    expect(await row(rec.id)).toMatchObject({ status: 'processed', attempts: 1, leased: null, claimed_by: null });
    // Done events are never claimed again; neither are rejected (unsigned) ones.
    expect(await inbox.claim(rec.id)).toBeNull();
    const rejected = await inbox.store({ provider: provider(), eventKey: unique('rej'), signatureValid: false, payload: {} });
    expect(await inbox.claim(rejected.id)).toBeNull();
  });

  it('a fresh delivery is left to the request that received it; the worker takes it only after the grace period', async () => {
    const p = provider();
    const rec = await stored(p);
    expect(INBOX_INLINE_GRACE_SECONDS).toBeGreaterThan(0);
    expect(await inbox.claimDue(p)).toEqual([]);
    await makeDue(rec.id);
    const [claimed] = await inbox.claimDue(p);
    expect(claimed).toMatchObject({ id: rec.id, attempts: 0 });
    // While the worker holds it, a redelivery cannot claim it (it is acknowledged and left to the worker).
    expect(await inbox.claim(rec.id)).toBeNull();
    expect(await inbox.markProcessed(rec.id, claimed!.claim, 'processed')).toBe(true);
  });

  it('concurrent workers get disjoint batches (FOR UPDATE SKIP LOCKED); an expired lease can be taken over and fences the old holder', async () => {
    const p = provider();
    const ids = (await Promise.all(Array.from({ length: 6 }, () => stored(p)))).map((r) => r.id);
    await sql(`update webhook_inbox set next_attempt_at = now() - interval '1 second' where id = any($1)`, [ids]);
    const [a, b] = await Promise.all([inbox.claimDue(p, 4), inbox.claimDue(p, 4)]);
    const seen = [...a, ...b].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...ids].sort());
    // Nothing is due any more while the leases are live.
    expect(await inbox.claimDue(p, 10)).toEqual([]);

    const first = a[0]!;
    await sql(`update webhook_inbox set locked_until = now() - interval '1 second' where id = $1`, [first.id]);   // its worker stalled
    const takeover = await inbox.claim(first.id);
    expect(takeover).not.toBeNull();
    expect(await inbox.markProcessed(first.id, first.claim, 'failed', 'late failure from the stalled worker')).toBe(false);
    expect(await inbox.markProcessed(first.id, takeover!, 'processed')).toBe(true);
    expect(await row(first.id)).toMatchObject({ status: 'processed', attempts: 1, error: null });
    for (const r of [...a.slice(1), ...b]) await inbox.markProcessed(r.id, r.claim, 'processed');
  });
});

describe('backoff and dead-lettering', () => {
  it('backs off exponentially with jitter and a cap, then dead-letters after the last attempt (kept, alerted once)', async () => {
    const p = provider();
    const rec = await stored(p);
    for (let attempt = 1; attempt <= INBOX_MAX_ATTEMPTS; attempt++) {
      await makeDue(rec.id);
      const [c] = await inbox.claimDue(p);
      expect(c, `attempt ${attempt} should be due`).toBeDefined();
      expect(await inbox.markProcessed(rec.id, c!.claim, 'failed', `boom ${attempt}`)).toBe(true);
      const r = await row(rec.id);
      expect(r.attempts).toBe(attempt);
      const { min, max } = inboxBackoffWindow(attempt);
      expect(r.due_in, `attempt ${attempt}: ${r.due_in}s not in [${min}, ${max}]`).toBeGreaterThanOrEqual(min - 2);
      expect(r.due_in).toBeLessThanOrEqual(max + 1);
      expect(r.dead).toBe(attempt >= INBOX_MAX_ATTEMPTS);
    }
    // The schedule itself: 30 s, 60 s, 120 s … capped at one hour.
    expect(inboxBackoffWindow(1)).toEqual({ min: 24, max: 36 });
    expect(inboxBackoffWindow(4)).toEqual({ min: 192, max: 288 });
    expect(inboxBackoffWindow(9).max).toBe(INBOX_BACKOFF.capSeconds);
    // A dead letter is never claimed by the worker again, stays stored, and is reported once.
    await makeDue(rec.id);
    expect(await inbox.claimDue(p)).toEqual([]);
    expect((await inbox.exhausted(p)).map((r) => r.id)).toEqual([rec.id]);
    await inbox.markAlerted(rec.id);
    expect(await inbox.exhausted(p)).toEqual([]);
    expect(await row(rec.id)).toMatchObject({ status: 'failed', dead: true });
    // A signed redelivery from the provider still gets a chance; success clears the dead letter.
    const claim = await inbox.claim(rec.id);
    expect(claim).not.toBeNull();
    await inbox.markProcessed(rec.id, claim!, 'processed');
    expect(await row(rec.id)).toMatchObject({ status: 'processed', dead: false });
  });

  it('jitter spreads retries of events that failed together', async () => {
    const p = provider();
    const ids = (await Promise.all(Array.from({ length: 12 }, () => stored(p)))).map((r) => r.id);
    await sql(`update webhook_inbox set next_attempt_at = now() - interval '1 second', attempts = 4 where id = any($1)`, [ids]);
    for (const c of await inbox.claimDue(p, 20)) await inbox.markProcessed(c.id, c.claim, 'failed', 'outage');
    const due = (await sql(`select extract(epoch from next_attempt_at - now())::float8 as s from webhook_inbox where id = any($1)`, [ids])).map((r) => Math.round(r.s));
    const { min, max } = inboxBackoffWindow(5);
    for (const s of due) { expect(s).toBeGreaterThanOrEqual(min - 2); expect(s).toBeLessThanOrEqual(max + 1); }
    expect(new Set(due).size).toBeGreaterThan(1);
  });
});

describe('superadmin replay of a dead letter (audited)', () => {
  let superadmin: TestUser;
  let support: TestUser;
  const replay = (u: TestUser, id: string, reason = 'provider outage over') =>
    t.http.post(`/v1/admin/operations/webhooks/${id}/replay`).set(auth(u)).send({ reason });

  beforeAll(async () => {
    superadmin = await signup(t, 'wh-superadmin');
    support = await signup(t, 'wh-support');
    await sql(`insert into platform_admins(user_id, role) values ($1, 'superadmin'), ($2, 'support')`, [superadmin.userId, support.userId]);
  });

  it('re-queues a dead-lettered event with a fresh budget; support cannot; unsigned, done or held events are refused', async () => {
    const p = provider();
    const rec = await stored(p);
    await sql(`update webhook_inbox set status = 'failed', attempts = $2, dead_lettered_at = now(), alerted_at = now(), error = 'boom',
               next_attempt_at = now() + interval '1 hour' where id = $1`, [rec.id, INBOX_MAX_ATTEMPTS]);
    const rejected = await inbox.store({ provider: p, eventKey: unique('rej'), signatureValid: false, payload: {} });
    const done = await stored(p);
    await sql(`update webhook_inbox set status = 'processed' where id = $1`, [done.id]);
    const held = await stored(p);
    await sql(`update webhook_inbox set status = 'failed', attempts = 2, locked_until = now() + interval '2 minutes', claimed_by = 'worker' where id = $1`, [held.id]);

    expect((await replay(support, rec.id)).status).toBe(403);
    expect((await replay(superadmin, rejected.id)).status).toBe(409);
    expect((await replay(superadmin, done.id)).status).toBe(409);
    const busy = await replay(superadmin, held.id);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('run_in_progress');
    expect((await replay(superadmin, '00000000-0000-4000-8000-000000000000')).status).toBe(404);

    const res = await replay(superadmin, rec.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ id: rec.id, provider: p, status: 'queued' });
    expect(await row(rec.id)).toMatchObject({ status: 'failed', attempts: 0, dead: false, alerted_at: null, replay_count: 1 });
    const [c] = await inbox.claimDue(p);
    expect(c?.id).toBe(rec.id);
    await inbox.markProcessed(rec.id, c!.claim, 'processed');
    const [log] = await sql(`select actor_id, metadata from audit_logs where action = 'admin.webhook_replayed' and entity_id = $1`, [rec.id]);
    expect(log.actor_id).toBe(superadmin.userId);
    expect(log.metadata).toMatchObject({ provider: p, previousAttempts: INBOX_MAX_ATTEMPTS, deadLettered: true, reason: 'provider outage over' });
  });
});

describe('end to end through the Stripe webhook controller', () => {
  let s: Scripted;
  const secret = 'whsec_leaseflow';
  const evt = () => `evt_${randomBytes(8).toString('hex')}`;

  it('a redelivery never processes an event the worker holds; the worker applies it exactly once after its backoff', async () => {
    s = scriptProviders(t);
    scriptHealth(s);
    const tenant = await createTenant(t);
    const menu = await seedMenu(tenant);
    const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    const conn = (await connect(t, tenant, 'stripe', { secretKey: 'sk_test_lease', webhookSecret: secret })).id;
    const db = t.app.get(DbService);
    const order = await db.scoped(ctx, (tx) => t.app.get(OrdersKernelService).place(tx, ctx,
      { branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 2 }] } as any));
    const session = await db.scoped(ctx, (tx) => t.app.get<CheckoutPort>(CHECKOUT_PORT).createSession(tx, ctx, { purpose: 'order', orderId: order.id, channel: 'web' }));
    const csId = `cs_test_${randomBytes(6).toString('hex')}`;
    s.on('POST', 'https://api.stripe.com/v1/checkout/sessions', () => ({ body: { id: csId, url: `https://checkout.stripe.com/c/pay/${csId}`, livemode: false } }));
    expect((await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' })).status).toBe(200);
    const [payment] = await sql(`select id from payments where checkout_session_id = $1`, [session.id]);
    s.on('GET', `https://api.stripe.com/v1/payment_intents/pi_${csId}`, () => ({ body: { id: `pi_${csId}`, amount: order.totalMinor, currency: 'egp', livemode: false,
      metadata: { resuto_payment_id: payment.id }, latest_charge: { id: `ch_${csId}`, amount_refunded: 500 } } }));
    const send = (raw: string) => t.http.post(`/v1/webhooks/payments/stripe?c=${conn}`)
      .set({ 'content-type': 'application/json', 'stripe-signature': stripeSignature(secret, raw) }).send(raw);
    const refundOf = async () => (await sql(`select status, refunded_minor from payments where id = $1`, [payment.id]))[0];

    // The refund arrives before the payment it reverses: stored, failed, retried later with backoff.
    const refunded = JSON.stringify({ id: evt(), type: 'charge.refunded', livemode: false,
      data: { object: { id: `ch_${csId}`, payment_intent: `pi_${csId}`, amount: order.totalMinor, amount_refunded: 500, currency: 'egp' } } });
    expect((await send(refunded)).status).toBe(503);
    const [ev] = await sql(`select id from webhook_inbox where provider = 'payments:stripe' and org_id = $1 and status = 'failed'`, [tenant.orgId]);
    const afterFirst = await row(ev.id);
    expect(afterFirst).toMatchObject({ attempts: 1, leased: null });
    expect(afterFirst.due_in).toBeGreaterThan(inboxBackoffWindow(1).min - 2);
    const paid = JSON.stringify({ id: evt(), type: 'checkout.session.completed', livemode: false,
      data: { object: { id: csId, amount_total: order.totalMinor, currency: 'egp', payment_status: 'paid', payment_intent: `pi_${csId}` } } });
    expect((await send(paid)).body.outcome).toBe('applied');

    // Not due yet: the worker leaves it alone (no retry storm).
    await t.app.get(PaymentWebhooksService).retryPending();
    expect(await refundOf()).toEqual({ status: 'succeeded', refunded_minor: 0 });

    // The worker holds it (live lease): a provider redelivery is acknowledged and does NOT process it a second time.
    await sql(`update webhook_inbox set locked_until = now() + interval '2 minutes', claimed_by = 'worker:held' where id = $1`, [ev.id]);
    expect((await send(refunded)).body).toEqual({ received: true, queued: true });
    expect(await refundOf()).toEqual({ status: 'succeeded', refunded_minor: 0 });

    // That worker stalled; once its lease expires and the backoff elapsed, the next worker run applies it once.
    await sql(`update webhook_inbox set locked_until = now() - interval '1 second', next_attempt_at = now() - interval '1 second' where id = $1`, [ev.id]);
    expect(await t.app.get(PaymentWebhooksService).retryPending()).toMatchObject({ retried: 1, failed: 0 });
    expect(await refundOf()).toEqual({ status: 'partially_refunded', refunded_minor: 500 });
    expect(await inbox.markProcessed(ev.id, 'worker:held', 'failed', 'late')).toBe(false);
    expect(await row(ev.id)).toMatchObject({ status: 'processed', attempts: 2 });
    expect((await send(refunded)).body).toEqual({ received: true, duplicate: true });
    expect((await sql(`select count(*)::int as n from refunds where payment_id = $1`, [payment.id]))[0].n).toBe(1);
  });
});
