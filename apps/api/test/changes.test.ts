import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/common/auth/jwt.service';
import { DomainError } from '../src/common/errors/domain-error';
import { hardeningMiddleware } from '../src/common/http/http-hardening';
import { loadEnv } from '../src/config/env';
import type { OutboxEvent } from '../src/common/events/events';
import { ChangesJobs } from '../src/modules/changes/changes.jobs';
import { ChangesService } from '../src/modules/changes/changes.service';
import { CAMPAIGN_SEND_PORT, CHECKOUT_PORT, type CampaignSendPort, type CheckoutPort } from '../src/modules/kernel/ports';
import { NotificationsHandlers } from '../src/modules/notifications/notifications.handlers';
import { addMember, auth, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

// 21-CS: the change-set engine through its REST API (approvals inbox, staff proposals) on a real database. The menu,
// promotions and studio ops use the real modules; the two external effects (payment links, campaign sends) use
// scripted ports so a test can make an attempt succeed, fail for good or fail transiently.

type Mode = 'ok' | 'transient' | 'refuse';
const script = { checkout: [] as Mode[], campaign: [] as Mode[] };
const calls = { checkout: [] as any[], cancelled: [] as string[], campaign: [] as any[] };
const take = (q: Mode[]) => q.shift() ?? 'ok';

const fakeCheckout: CheckoutPort = {
  async createSession(_tx, ctx, input) {
    const m = take(script.checkout);
    if (m === 'transient') throw new Error('provider timeout');
    if (m === 'refuse') throw new DomainError('no_payment_method', 'No payment method is available for this checkout', 409);
    calls.checkout.push({ actorType: ctx.actorType, input });
    const n = calls.checkout.length;
    return { id: `6f1c2a40-0000-4000-8000-${String(n).padStart(12, '0')}`, token: `tok_${n}`, url: `http://app.test/pay/tok_${n}`,
      amountMinor: input.amountMinor ?? 0, currency: 'EGP', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  },
  async cancelSession(_tx, _ctx, id) {
    calls.cancelled.push(id);
    return true;
  },
};
const fakeCampaign: CampaignSendPort = {
  async requestSend(_tx, _ctx, input) {
    const m = take(script.campaign);
    if (m === 'transient') throw new Error('sender unavailable');
    if (m === 'refuse') throw new DomainError('channel_unavailable', 'No messaging channel is connected', 409);
    calls.campaign.push(input);
    return { campaignId: input.campaignId, status: 'sent', scheduledAt: null };
  },
};

async function boot(): Promise<TestApp> {
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CHECKOUT_PORT).useValue(fakeCheckout)
    .overrideProvider(CAMPAIGN_SEND_PORT).useValue(fakeCampaign)
    .compile();
  const app = ref.createNestApplication({ rawBody: true, logger: ['error'] });
  app.setGlobalPrefix('v1');
  // Request ids (audit_logs.request_id), as in createApp().
  app.use(hardeningMiddleware(loadEnv()));
  await app.init();
  return { app, http: request(app.getHttpServer()), close: () => app.close() };
}

let t: TestApp;
let a: TestTenant;
let b: TestTenant;
let menu: SeededMenu;
let menuB: SeededMenu;
let manager: TestUser;
let manager2: TestUser;
let waiter: TestUser;
let jwt: JwtService;

const base = (tenant: TestTenant) => `/v1/o/${tenant.orgId}/change-sets`;
const propose = (u: TestUser, body: object, key = unique('cs-key'), tenant = a) =>
  t.http.post(base(tenant)).set(auth(u)).set('Idempotency-Key', key).send(body);
const approve = (u: { token: string }, id: string, body: Record<string, unknown> = {}, tenant = a) =>
  t.http.post(`${base(tenant)}/${id}/approve`).set(auth(u)).send(body);
const view = async (u: TestUser, id: string) => (await t.http.get(`${base(a)}/${id}`).set(auth(u))).body;
const priceOp = (productId: string, priceMinor: number) => ({ type: 'menu.item.price.set', input: { productId, priceMinor } });
const aal2 = async (u: TestUser) => ({ token: await jwt.issue(u.userId, u.email, 600, { aal: 'aal2' }) });
const auditActions = async (id: string) => (await sql(`select action from audit_logs where entity_type = 'change_set' and entity_id = $1 order by id`, [id])).map((r) => r.action);
const setPolicy = (u: TestUser, group: string, body: Record<string, unknown>, tenant = a) =>
  t.http.put(`/v1/o/${tenant.orgId}/change-policies/${group}`).set(auth(u)).send(body);

beforeAll(async () => {
  t = await boot();
  jwt = t.app.get(JwtService);
  a = await createTenant(t, { name: 'Change Grill' });
  b = await createTenant(t, { name: 'Other Grill' });
  menu = await seedMenu(a);
  menuB = await seedMenu(b);
  manager = await addMember(t, a, 'manager');
  manager2 = await addMember(t, a, 'manager');
  waiter = await addMember(t, a, 'waiter');
});
afterAll(async () => { await t?.close(); });
beforeEach(() => { script.checkout.length = 0; script.campaign.length = 0; });

describe('proposal: validate and preview', () => {
  it('records each op with its target version, before/after and a digest, and waits for approval (prices need one)', async () => {
    const res = await propose(manager, { title: 'Fries price', ops: [priceOp(menu.products.fries, 5000)] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ origin: 'staff', status: 'pending_approval', title: 'Fries price', proposedBy: manager.userId,
      policy: { mode: 'approval', approvalsRequired: 1, requiresOwner: false, groups: { prices: 'approval' } } });
    expect(res.body.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.expiresAt).toBeTruthy();
    const [op] = res.body.ops;
    expect(op).toMatchObject({ type: 'menu.item.price.set', group: 'prices', kind: 'local', status: 'proposed', target: { type: 'product', id: menu.products.fries },
      before: { priceMinor: 4500, currency: 'EGP' }, after: { priceMinor: 5000 }, changes: [{ label: 'Price of Fries', before: '45.00 EGP', after: '50.00 EGP' }] });
    expect(op.summary).toBe('Change the price of "Fries" from 45.00 EGP to 50.00 EGP (+11.1%)');
    const [row] = await sql(`select target_version from change_ops where id = $1`, [op.id]);
    const [p] = await sql(`select version from products where id = $1`, [menu.products.fries]);
    expect(row.target_version).toBe(String(p.version));
    // Nothing changed yet.
    expect((await sql(`select price_minor from products where id = $1`, [menu.products.fries]))[0].price_minor).toBe(4500);
    expect(await auditActions(res.body.id)).toEqual(['change_set.draft', 'change_op.proposed', 'change_set.validated', 'change_set.pending_approval']);
    const [evt] = await sql(`select event_type, payload from outbox_events where aggregate_id = $1`, [res.body.id]);
    expect(evt).toMatchObject({ event_type: 'change_set.approval_requested', payload: { origin: 'staff', requiresOwner: false } });
  });

  it('refuses malformed input (400 with the op path), domain-rule violations (422) and unknown records (404) without storing anything', async () => {
    const before = (await sql(`select count(*)::int as n from change_sets where org_id = $1`, [a.orgId]))[0].n;
    const bad = await propose(manager, { title: 'x', ops: [priceOp(menu.products.fries, -1)] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(JSON.stringify(bad.body.error.details)).toContain('ops');
    const unknownType = await propose(manager, { title: 'x', ops: [{ type: 'sql.run', input: {} }] });
    expect(unknownType.status).toBe(400);
    const jump = await propose(manager, { title: 'x', ops: [priceOp(menu.products.fries, 4500 * 11)] });
    expect(jump.status).toBe(422);
    expect(jump.body.error.code).toBe('price_change_out_of_bounds');
    const missing = await propose(manager, { title: 'x', ops: [priceOp('6f1c2a40-0000-4000-8000-00000000ffff', 100)] });
    expect(missing.status).toBe(404);
    const discount = await propose(manager, { title: 'x', ops: [{ type: 'promotion.create', input: { name: 'Too much', kind: 'percent', value: 9500 } }] });
    expect(discount.status).toBe(422);
    expect(discount.body.error.code).toBe('discount_out_of_bounds');
    expect((await propose(manager, { title: 'x', ops: [priceOp(menu.products.fries, 100)] }, 'short')).status).toBe(400);
    expect((await t.http.post(base(a)).set(auth(manager)).send({ title: 'x', ops: [priceOp(menu.products.fries, 100)] })).body.error.code).toBe('idempotency_key_required');
    expect((await sql(`select count(*)::int as n from change_sets where org_id = $1`, [a.orgId]))[0].n).toBe(before);
  });

  it('needs every op\'s permission from the proposer and changes:read for the inbox', async () => {
    const res = await propose(waiter, { title: 'x', ops: [priceOp(menu.products.fries, 5000)] });
    expect(res.status).toBe(403);
    expect((await t.http.get(base(a)).set(auth(waiter))).status).toBe(403);
    // A waiter may 86 a dish: that op is in the auto-applied menu group.
    const ok = await propose(waiter, { title: '86 soda', ops: [{ type: 'menu.item.availability.set', input: { productId: menu.products.soda, branchId: a.branchId, available: false } }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ status: 'applied', policy: { mode: 'auto', approvalsRequired: 0 }, ops: [{ status: 'applied', result: { available: false } }] });
    expect(await sql(`select sold_out from product_branch_settings where product_id = $1 and branch_id = $2`, [menu.products.soda, a.branchId])).toEqual([{ sold_out: true }]);
    await propose(waiter, { title: 'soda back', ops: [{ type: 'menu.item.availability.set', input: { productId: menu.products.soda, branchId: a.branchId, available: true } }] });
  });

  it('replays an identical proposal under the same Idempotency-Key and refuses the key for a different body', async () => {
    const key = unique('replay');
    const body = { title: 'Rename fries', ops: [{ type: 'menu.item.update', input: { productId: menu.products.fries, nameAr: 'بطاطس' } }] };
    const first = await propose(manager, body, key);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'applied', replayed: false });
    const again = await propose(manager, body, key);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: first.body.id, status: 'applied', replayed: true });
    const other = await propose(manager, { ...body, title: 'Something else' }, key);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('idempotency_key_reused');
    expect(await sql(`select count(*)::int as n from change_ops where change_set_id = $1`, [first.body.id])).toEqual([{ n: 1 }]);
    expect(await sql(`select count(*)::int as n from audit_logs where entity_id = $1 and action = 'change_op.applied'`, [first.body.id])).toEqual([{ n: 1 }]);
  });
});

describe('approval and apply', () => {
  it('approve requires an aal2 session from a user with a verified factor (opt-in MFA) and records the assurance level', async () => {
    const strict = await addMember(t, a, 'manager');
    await sql(`insert into auth.mfa_factors(user_id, friendly_name, factor_type, status) values ($1, 'Authenticator app', 'totp', 'verified')`, [strict.userId]);
    const cs = (await propose(manager, { title: 'MFA', ops: [priceOp(menu.products.burger, 19000)] })).body;
    const weak = await approve(strict, cs.id);
    expect(weak.status).toBe(403);
    expect(weak.body.error.code).toBe('mfa_required');
    expect((await t.http.post(`${base(a)}/${cs.id}/reject`).set(auth(strict)).send({})).body.error.code).toBe('mfa_required');
    expect((await view(manager, cs.id)).status).toBe('pending_approval');
    const strong = await approve(await aal2(strict), cs.id, { previewDigest: cs.previewDigest, note: 'ok' });
    expect(strong.status, JSON.stringify(strong.body)).toBe(200);
    expect(strong.body).toMatchObject({ status: 'applied', decidedBy: strict.userId, decisionNote: 'ok', ops: [{ status: 'applied' }],
      decisions: [{ userId: strict.userId, role: 'manager', decision: 'approved' }] });
    expect(await sql(`select aal, digest from change_decisions where change_set_id = $1`, [cs.id])).toEqual([{ aal: 'aal2', digest: cs.previewDigest }]);
    expect((await sql(`select price_minor from products where id = $1`, [menu.products.burger]))[0].price_minor).toBe(19000);
    // Users without a factor keep working with aal1 (demo accounts, Free plan).
    const cs2 = (await propose(manager, { title: 'no factor', ops: [priceOp(menu.products.burger, 18500)] })).body;
    expect((await approve(manager2, cs2.id)).status).toBe(200);
  });

  it('applies exactly once under concurrent approvals', async () => {
    const [p0] = await sql(`select version from products where id = $1`, [menu.products.fries]);
    const cs = (await propose(manager, { title: 'Race', ops: [priceOp(menu.products.fries, 5200)] })).body;
    const approvers = [a.owner, manager2, manager, await addMember(t, a, 'admin'), await addMember(t, a, 'manager')];
    const results = await Promise.all(approvers.map((u) => approve(u, cs.id)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.error.code).every((c) => c === 'change_set_not_pending')).toBe(true);
    expect(results.filter((r) => r.status !== 200 && r.status !== 409)).toEqual([]);
    const [p1] = await sql(`select version, price_minor from products where id = $1`, [menu.products.fries]);
    expect(p1).toEqual({ version: p0.version + 1, price_minor: 5200 });
    const actions = await auditActions(cs.id);
    expect(actions.filter((x) => x === 'change_op.applied')).toHaveLength(1);
    expect(actions.filter((x) => x === 'change_set.applied')).toHaveLength(1);
    expect(await sql(`select count(*)::int as n from change_decisions where change_set_id = $1`, [cs.id])).toEqual([{ n: 1 }]);
    // The engine itself, raced directly: every extra apply is a replay.
    const engine = t.app.get(ChangesService);
    const replays = await Promise.all([1, 2, 3].map(() => engine.apply(a.orgId, cs.id)));
    expect(replays.every((r) => r.replayed && r.status === 'applied')).toBe(true);
  });

  it('a replayed apply is a no-op', async () => {
    const cs = (await propose(manager, { title: 'Replay apply', ops: [priceOp(menu.products.soda, 2600)] })).body;
    expect((await approve(a.owner, cs.id)).body.status).toBe('applied');
    const before = await auditActions(cs.id);
    const [v] = await sql(`select version from products where id = $1`, [menu.products.soda]);
    const replay = await t.http.post(`${base(a)}/${cs.id}/apply`).set(auth(a.owner)).send({});
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'applied', replayed: true });
    expect(await auditActions(cs.id)).toEqual(before);
    expect(await sql(`select version from products where id = $1`, [menu.products.soda])).toEqual([v]);
    expect((await approve(a.owner, cs.id)).status).toBe(409);
  });

  it('a target changed after the proposal invalidates the set; nothing is applied', async () => {
    const cs = (await propose(manager, { title: 'Stale', ops: [priceOp(menu.products.limited, 31000)] })).body;
    const [p] = await sql(`select version from products where id = $1`, [menu.products.limited]);
    // Staff edit the same item in the menu editor meanwhile.
    const edit = await t.http.patch(`/v1/o/${a.orgId}/menu/products/${menu.products.limited}`).set(auth(a.owner)).send({ priceMinor: 32000, version: p.version });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const res = await approve(a.owner, cs.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('change_set_invalidated');
    expect(res.body.error.details.changeSet).toMatchObject({ status: 'invalidated', ops: [{ status: 'proposed' }] });
    expect(res.body.error.details.changeSet.invalidatedReason).toMatch(/changed after this was proposed/);
    expect((await sql(`select price_minor from products where id = $1`, [menu.products.limited]))[0].price_minor).toBe(32000);
    expect(await auditActions(cs.id)).toContain('change_set.invalidated');
    expect((await approve(a.owner, cs.id)).body.error.code).toBe('change_set_not_pending');
  });

  it('a website section edited in the Studio after the proposal invalidates the set (draft ops under an approval policy)', async () => {
    expect((await setPolicy(a.owner, 'website_drafts', { mode: 'approval' })).status).toBe(200);
    const created = await t.http.post(`/v1/o/${a.orgId}/studio/website/sections`).set(auth(a.owner)).send({ kind: 'about', content: { headline: { en: 'About us' } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const cs = (await propose(manager, { title: 'New about', ops: [{ type: 'website.section.update', input: { sectionId: created.body.id, content: { headline: { en: 'Our story' } } } }] })).body;
    expect(cs).toMatchObject({ status: 'pending_approval', ops: [{ target: { type: 'website_section', id: created.body.id }, changes: [{ before: 'About us', after: 'Our story' }] }] });
    expect((await t.http.patch(`/v1/o/${a.orgId}/studio/website/sections/${created.body.id}`).set(auth(a.owner)).send({ isVisible: false })).status).toBe(200);
    const res = await approve(a.owner, cs.id);
    expect(res.body.error.code).toBe('change_set_invalidated');
    expect((await sql(`select content->'headline'->>'en' as h from website_sections where id = $1`, [created.body.id]))[0].h).toBe('About us');
    await setPolicy(a.owner, 'website_drafts', { mode: 'auto' });
  });

  it('refuses an approval made on a stale screen (digest) and lets a reject close the set', async () => {
    const cs = (await propose(manager, { title: 'Digest', ops: [priceOp(menu.products.soda, 2700)] })).body;
    const stale = await approve(a.owner, cs.id, { previewDigest: 'f'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('approval_changed');
    const rej = await t.http.post(`${base(a)}/${cs.id}/reject`).set(auth(a.owner)).send({ note: 'not now' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: 'rejected', decisionNote: 'not now', decisions: [{ decision: 'rejected', userId: a.owner.userId }] });
    expect((await approve(a.owner, cs.id)).status).toBe(409);
    expect((await sql(`select price_minor from products where id = $1`, [menu.products.soda]))[0].price_minor).not.toBe(2700);
  });

  it('expires undecided sets', async () => {
    const cs = (await propose(manager, { title: 'Expire', ops: [priceOp(menu.products.soda, 2800)] })).body;
    await sql(`update change_sets set expires_at = now() - interval '1 second' where id = $1`, [cs.id]);
    expect(await t.app.get(ChangesJobs).expire()).toMatchObject({ expired: 1 });
    expect((await view(manager, cs.id)).status).toBe('expired');
    expect((await approve(a.owner, cs.id)).body.error.code).toBe('change_set_not_pending');
  });
});

describe('external effects (transactional outbox)', () => {
  const availability = (productId: string, available: boolean) => ({ type: 'menu.item.availability.set', input: { productId, branchId: a.branchId, available } });
  const link = (amountMinor: number) => ({ type: 'payment_link.create', input: { amountMinor, description: 'Deposit' } });

  it('an effect that fails for good leaves the set partially applied, with the local part kept and visible', async () => {
    script.checkout.push('refuse');
    const cs = (await propose(manager, { title: 'Mixed', ops: [availability(menu.products.fries, false), link(5000)] })).body;
    expect(cs.status).toBe('pending_approval');
    const res = await approve(a.owner, cs.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('partially_applied');
    const [local, effect] = res.body.ops;
    expect(local).toMatchObject({ type: 'menu.item.availability.set', status: 'applied', result: { available: false } });
    expect(effect).toMatchObject({ type: 'payment_link.create', status: 'failed', effect: { status: 'failed', attempts: 1, compensation: 'none' } });
    expect(effect.error).toMatch(/^no_payment_method:/);
    expect(res.body.error).toMatch(/no_payment_method/);
    // The local part stays applied.
    expect(await sql(`select sold_out from product_branch_settings where product_id = $1 and branch_id = $2`, [menu.products.fries, a.branchId])).toEqual([{ sold_out: true }]);
    const actions = await auditActions(cs.id);
    expect(actions).toEqual(expect.arrayContaining(['change_op.applied', 'change_op.effect_queued', 'change_op.effect_failed', 'change_set.partially_applied']));
    expect(actions).not.toContain('change_set.applied');
    const inbox = await t.http.get(`${base(a)}?status=partially_applied`).set(auth(manager));
    expect(inbox.body.items.map((x: any) => x.id)).toContain(cs.id);
    await propose(manager, { title: 'fries back', ops: [availability(menu.products.fries, true)] });
  });

  it('retries a transient failure with backoff, then succeeds; the set is applied only once the effect is confirmed', async () => {
    script.checkout.push('transient');
    const cs = (await propose(manager, { title: 'Retry', ops: [link(7000)] })).body;
    const res = await approve(a.owner, cs.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'applying', ops: [{ status: 'pending_effect', effect: { status: 'pending_effect', attempts: 1 } }] });
    expect(res.body.ops[0].effect.lastError).toMatch(/internal_error/);
    expect(new Date(res.body.ops[0].effect.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    // Not due yet: the job leaves it alone.
    const jobs = t.app.get(ChangesJobs);
    expect((await jobs.effects()).succeeded).toBe(0);
    await sql(`update change_effects set next_attempt_at = now() where change_set_id = $1`, [cs.id]);
    expect((await jobs.effects()).succeeded).toBe(1);
    const done = await view(manager, cs.id);
    expect(done).toMatchObject({ status: 'applied', ops: [{ status: 'succeeded', effect: { status: 'succeeded', attempts: 2 } }] });
    // The stored result never carries the payment URL (a bearer token); the key the provider saw is <changeSetId>:<opId>.
    expect(JSON.stringify(done.ops[0].result)).not.toContain('http');
    expect(done.ops[0].result).toMatchObject({ urlIssued: true, amountMinor: 7000 });
    expect(await sql(`select provider_key from change_effects where change_set_id = $1`, [cs.id])).toEqual([{ provider_key: `${cs.id}:${done.ops[0].id}` }]);
    const actions = await auditActions(cs.id);
    expect(actions.indexOf('change_op.effect_retry_scheduled')).toBeLessThan(actions.indexOf('change_op.effect_succeeded'));
    expect(actions.at(-1)).toBe('change_set.applied');
    // Running the job again does nothing more.
    const n = calls.checkout.length;
    await jobs.effects();
    expect(calls.checkout.length).toBe(n);
  });

  it('an attempt whose outcome is unknown (non-atomic effect, lease lost) is flagged needs_attention and never retried', async () => {
    script.checkout.push('transient');
    const cs = (await propose(manager, { title: 'Unknown outcome', ops: [link(6000)] })).body;
    expect((await approve(a.owner, cs.id)).body.status).toBe('applying');
    await sql(`update change_effects set status = 'running', atomic = false, locked_until = now() - interval '1 second' where change_set_id = $1`, [cs.id]);
    const n = calls.checkout.length;
    expect((await t.app.get(ChangesJobs).effects()).needsAttention).toBe(1);
    expect(calls.checkout.length).toBe(n);
    const v = await view(manager, cs.id);
    expect(v).toMatchObject({ status: 'failed', ops: [{ status: 'needs_attention', effect: { status: 'needs_attention' } }] });
    expect(v.ops[0].effect.lastError).toMatch(/outcome of the last attempt is unknown/);
    expect(await auditActions(cs.id)).toContain('change_op.needs_attention');
  });

  it('hands the payment URL to the approver once, as a deliverable that is not stored', async () => {
    const cs = (await propose(manager, { title: 'Link now', ops: [link(3000)] })).body;
    const res = await approve(a.owner, cs.id);
    expect(res.body.status).toBe('applied');
    expect(Object.values(res.body.deliverables)[0]).toMatchObject({ url: expect.stringMatching(/^http:\/\/app\.test\/pay\//) });
    expect((await view(a.owner, cs.id)).deliverables).toBeUndefined();
    expect(JSON.stringify(await sql(`select result from change_ops where change_set_id = $1`, [cs.id]))).not.toContain('/pay/');
  });

  it('after a partial outcome a reversible effect can be undone, an irreversible one is flagged for follow-up', async () => {
    const [campaign] = await sql(`insert into campaigns(org_id, name, channel, status, content, utm_campaign) values ($1, 'Eid blast', 'whatsapp', 'draft', '{"text":"Eid mubarak"}', 'eid-blast') returning id`, [a.orgId]);
    script.campaign.push('refuse');
    const first = (await propose(manager, { title: 'Link then send', ops: [link(4000), { type: 'campaign.send', input: { campaignId: campaign.id } }] })).body;
    const r1 = await approve(a.owner, first.id);
    expect(r1.body.status).toBe('partially_applied');
    const [linkOp, sendOp] = r1.body.ops;
    expect(linkOp.effect).toMatchObject({ status: 'succeeded', reversible: true, compensation: 'available' });
    expect(sendOp.effect).toMatchObject({ status: 'failed', reversible: false });
    const undo = await t.http.post(`${base(a)}/${first.id}/ops/${linkOp.id}/reverse`).set(auth(a.owner)).send({ note: 'campaign failed' });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(undo.body.ops[0].effect.compensation).toBe('reversed');
    expect(calls.cancelled).toContain(linkOp.result.checkoutSessionId);
    expect((await t.http.post(`${base(a)}/${first.id}/ops/${linkOp.id}/reverse`).set(auth(a.owner)).send({})).body.error.code).toBe('not_reversible');

    script.checkout.push('refuse');
    const second = (await propose(manager, { title: 'Send then link', ops: [{ type: 'campaign.send', input: { campaignId: campaign.id } }, link(4000)] })).body;
    const r2 = await approve(a.owner, second.id);
    expect(r2.body.status).toBe('partially_applied');
    expect(r2.body.ops[0].effect).toMatchObject({ status: 'succeeded', reversible: false, compensation: 'follow_up' });
    const nope = await t.http.post(`${base(a)}/${second.id}/ops/${r2.body.ops[0].id}/reverse`).set(auth(a.owner)).send({});
    expect(nope.status).toBe(409);
    expect(nope.body.error.code).toBe('not_reversible');
  });
});

describe('policy', () => {
  it('a discount above the owner threshold needs the owner among the approvers', async () => {
    const offer = (value: number, code: string) => ({ type: 'promotion.create', input: { name: `Offer ${code}`, code, kind: 'percent', value } });
    const big = (await propose(manager, { title: 'Big offer', ops: [offer(3500, unique('BIG').replace(/[^A-Za-z0-9]/g, '').slice(0, 20))] })).body;
    expect(big).toMatchObject({ status: 'pending_approval', policy: { requiresOwner: true } });
    const byManager = await approve(manager2, big.id);
    expect(byManager.status).toBe(403);
    expect(byManager.body.error.code).toBe('owner_approval_required');
    const byOwner = await approve(a.owner, big.id);
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.status).toBe('applied');
    expect(await sql(`select kind, value from promotions where id = $1`, [byOwner.body.ops[0].result.promotionId])).toEqual([{ kind: 'percent', value: 3500 }]);
    // 15 % is under the default 30 %: a manager may approve; a lower threshold makes the owner necessary again.
    const small = (await propose(manager, { title: 'Small', ops: [offer(1500, unique('SM').replace(/[^A-Za-z0-9]/g, '').slice(0, 20))] })).body;
    expect(small.policy.requiresOwner).toBe(false);
    expect((await approve(manager2, small.id)).status).toBe(200);
    expect((await setPolicy(manager, 'promotions', { mode: 'approval', ownerAboveBps: 1000 })).status).toBe(403);
    expect((await setPolicy(a.owner, 'promotions', { mode: 'approval', ownerAboveBps: 1000 })).body).toMatchObject({ group: 'promotions', ownerAboveBps: 1000, isDefault: false });
    const small2 = (await propose(manager, { title: 'Small again', ops: [offer(1500, unique('SN').replace(/[^A-Za-z0-9]/g, '').slice(0, 20))] })).body;
    expect(small2.policy.requiresOwner).toBe(true);
    expect((await approve(manager2, small2.id)).body.error.code).toBe('owner_approval_required');
    await setPolicy(a.owner, 'promotions', { mode: 'approval', ownerAboveBps: 3000 });
  });

  it('a blocked group refuses the proposal (staff and MCP) and stores nothing', async () => {
    expect((await setPolicy(a.owner, 'prices', { mode: 'blocked' })).status).toBe(200);
    const count = async () => (await sql(`select count(*)::int as n from change_sets where org_id = $1`, [a.orgId]))[0].n;
    const before = await count();
    const res = await propose(manager, { title: 'Blocked', ops: [priceOp(menu.products.fries, 5100)] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'change_blocked', details: { groups: ['prices'] } });
    expect(await count()).toBe(before);
    await setPolicy(a.owner, 'prices', { mode: 'approval' });
    // MCP requests run through the same policy.
    await setPolicy(a.owner, 'menu', { mode: 'blocked' });
    const client = await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner))
      .send({ name: 'Blocked bot', actingRole: 'manager', allowedTools: ['update_product_availability'], rateLimitPerMin: 60 });
    const mcp = await t.http.post(`/v1/o/${a.orgId}/mcp/tools/update_product_availability`).set({ Authorization: `Bearer ${client.body.key}` })
      .send({ input: { productId: menu.products.burger, branchId: a.branchId, available: false } });
    expect(mcp.status).toBe(403);
    expect(mcp.body.error.code).toBe('change_blocked');
    expect(await sql(`select 1 from mcp_approvals where client_id = $1`, [client.body.id])).toHaveLength(0);
    await setPolicy(a.owner, 'menu', { mode: 'auto' });
    const listed = await t.http.get(`/v1/o/${a.orgId}/change-policies`).set(auth(manager));
    expect(listed.body.items.find((p: any) => p.group === 'messages')).toMatchObject({ mode: 'approval', isDefault: true });
  });

  it('a second approver must be another person than the first and than the proposer', async () => {
    await setPolicy(a.owner, 'prices', { mode: 'approval', approvers: 2 });
    const cs = (await propose(manager, { title: 'Four eyes', ops: [priceOp(menu.products.soda, 2900)] })).body;
    expect(cs.policy.approvalsRequired).toBe(2);
    expect((await approve(manager, cs.id)).body.error.code).toBe('self_approval_not_allowed');
    const one = await approve(manager2, cs.id);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ status: 'pending_approval', decisions: [{ userId: manager2.userId }] });
    expect((await approve(manager2, cs.id)).body.error.code).toBe('already_decided');
    const two = await approve(a.owner, cs.id);
    expect(two.body.status).toBe('applied');
    expect(await auditActions(cs.id)).toContain('change_set.approval_recorded');
    await setPolicy(a.owner, 'prices', { mode: 'approval', approvers: 1 });
  });
});

describe('tenant isolation', () => {
  it('refuses an op on another restaurant\'s record and hides each restaurant\'s change sets from the other', async () => {
    const res = await propose(manager, { title: 'Cross', ops: [priceOp(menuB.products.fries, 100)] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    const section = await propose(manager, { title: 'Cross section', ops: [{ type: 'website.section.add', input: { kind: 'menu_highlights', content: { productIds: [menuB.products.burger] } } }] });
    expect(section.status).toBe(422);
    expect(section.body.error.code).toBe('unknown_product');
    const mine = (await propose(manager, { title: 'Mine', ops: [priceOp(menu.products.soda, 2950)] })).body;
    expect((await t.http.get(`${base(b)}/${mine.id}`).set(auth(b.owner))).status).toBe(404);
    expect((await approve(b.owner, mine.id, {}, b)).status).toBe(404);
    expect((await t.http.get(`${base(a)}/${mine.id}`).set(auth(b.owner))).status).toBe(404);
    const list = await t.http.get(`${base(b)}?status=all`).set(auth(b.owner));
    expect(list.body.items.map((x: any) => x.id)).not.toContain(mine.id);
    // The engine itself refuses the other tenant's id (RLS and the org filter).
    await expect(t.app.get(ChangesService).apply(b.orgId, mine.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('MCP requests in the inbox', () => {
  it('shows an MCP request as a change set and approves it through the MCP binding', async () => {
    const client = await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner))
      .send({ name: 'Inbox bot', actingRole: 'manager', allowedTools: ['create_payment_link', 'get_approval_status'], rateLimitPerMin: 60 });
    const call = await t.http.post(`/v1/o/${a.orgId}/mcp/tools/create_payment_link`).set({ Authorization: `Bearer ${client.body.key}` })
      .send({ input: { amountMinor: 2500, description: 'Table 2' } });
    expect(call.status).toBe(202);
    const approvalId = call.body.output.approvalId;
    const [link] = await sql(`select change_set_id from mcp_approvals where id = $1`, [approvalId]);
    const inbox = await t.http.get(`${base(a)}?origin=mcp`).set(auth(manager));
    const item = inbox.body.items.find((x: any) => x.id === link.change_set_id);
    expect(item).toMatchObject({ origin: 'mcp', status: 'pending_approval', opTypes: ['payment_link.create'], actor: { type: 'mcp_client', mcpClientId: client.body.id } });
    const res = await approve(manager, link.change_set_id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('applied');
    const status = await t.http.post(`/v1/o/${a.orgId}/mcp/tools/get_approval_status`).set({ Authorization: `Bearer ${client.body.key}` }).send({ input: { approvalId } });
    expect(status.body.output).toMatchObject({ status: 'executed', result: { url: expect.stringMatching(/\/pay\//) } });
    const trail = await t.http.get(`${base(a)}/${link.change_set_id}/audit`).set(auth(manager));
    expect(trail.body.items.map((x: any) => x.action)).toEqual(expect.arrayContaining(['mcp.approval.requested', 'mcp.approval.approved', 'change_set.applied']));
  });
});

describe('Eid offers: one change set adds a website section with 3 dishes and a 15% offer, then publishes', () => {
  it('approves, applies the local ops in one transaction, publishes and audits every step', async () => {
    const [w0] = await sql(`select id, published_revision from websites where org_id = $1`, [a.orgId]);
    const products = [menu.products.burger, menu.products.fries, menu.products.soda];
    const body = {
      title: 'Eid offers',
      summary: 'Eid section with three dishes at 15% off',
      ops: [
        { type: 'website.section.add', input: { kind: 'menu_highlights', content: { headline: { en: 'Eid offers', ar: 'عروض العيد' }, productIds: products } } },
        { type: 'promotion.create', input: { name: 'Eid 15', nameAr: 'خصم العيد', code: 'EID15', kind: 'percent', value: 1500 } },
        { type: 'website.publish', input: { note: 'Eid' } },
      ],
    };
    const cs = (await propose(manager, body)).body;
    expect(cs).toMatchObject({ status: 'pending_approval', policy: { mode: 'approval', requiresOwner: false, groups: { website_drafts: 'auto', promotions: 'approval', website_publish: 'auto' } } });
    expect(cs.ops.map((o: any) => o.summary)).toEqual([
      'Add a menu_highlights section "Eid offers" to the website draft with 3 menu items',
      'Create the offer "Eid 15" (15% off, code EID15)',
      `Publish the website (revision ${w0.published_revision + 1}): Eid`,
    ]);
    expect(cs.ops[0].changes[1]).toEqual({ label: 'Menu items', before: null, after: 'Smash burger, Fries, Soda' });

    // The approvers are told (notification centre).
    const [evt] = await sql(`select id, org_id, aggregate_type, aggregate_id, event_type, payload, created_at from outbox_events where aggregate_id = $1`, [cs.id]);
    await t.app.get(NotificationsHandlers).onChangeSetApproval({ id: evt.id, orgId: evt.org_id, type: evt.event_type, aggregateType: evt.aggregate_type,
      aggregateId: evt.aggregate_id, payload: evt.payload, createdAt: new Date(evt.created_at).toISOString() } as OutboxEvent);
    const notes = await t.http.get(`/v1/o/${a.orgId}/notifications`).set(auth(manager2));
    expect(notes.body.items.find((n: any) => n.kind === 'approval_requested' && n.link === `/approvals/${cs.id}`)).toBeTruthy();

    const res = await approve(manager2, cs.id, { previewDigest: cs.previewDigest });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const requestId = res.headers['x-request-id'];
    expect(requestId).toBeTruthy();
    expect(res.body.status).toBe('applied');
    expect(res.body.ops.map((o: any) => o.status)).toEqual(['applied', 'applied', 'applied']);
    const sectionId = res.body.ops[0].result.sectionId;
    expect(await sql(`select kind, content->'productIds' as products from website_sections where id = $1`, [sectionId])).toEqual([{ kind: 'menu_highlights', products }]);
    expect(await sql(`select code, kind, value, is_active from promotions where org_id = $1 and code = 'EID15'`, [a.orgId])).toEqual([{ code: 'EID15', kind: 'percent', value: 1500, is_active: true }]);
    const [w1] = await sql(`select published_revision from websites where id = $1`, [w0.id]);
    expect(w1.published_revision).toBe(w0.published_revision + 1);
    const [rev] = await sql(`select snapshot from website_revisions where website_id = $1 and revision = $2`, [w0.id, w1.published_revision]);
    expect(rev.snapshot.sections.some((s: any) => s.id === sectionId)).toBe(true);
    expect(res.body.ops[2].result).toMatchObject({ revision: w1.published_revision });

    expect(await auditActions(cs.id)).toEqual([
      'change_set.draft', 'change_op.proposed', 'change_op.proposed', 'change_op.proposed', 'change_set.validated', 'change_set.pending_approval',
      'change_set.approved', 'change_set.applying', 'change_op.applied', 'change_op.applied', 'change_op.applied', 'change_set.applied',
    ]);
    const applied = await sql(`select actor_type, actor_id, metadata from audit_logs where entity_id = $1 and action = 'change_op.applied' order by id`, [cs.id]);
    expect(applied.map((r) => r.metadata.type)).toEqual(['website.section.add', 'promotion.create', 'website.publish']);
    expect(applied.every((r) => r.actor_type === 'user' && r.actor_id === manager.userId && r.metadata.approvedBy === manager2.userId)).toBe(true);
    const [approvedRow] = await sql(`select actor_id, metadata, request_id from audit_logs where entity_id = $1 and action = 'change_set.approved'`, [cs.id]);
    expect(approvedRow).toMatchObject({ actor_id: manager2.userId, metadata: { from: 'pending_approval', to: 'approved', origin: 'staff' } });
    expect(approvedRow.request_id).toBe(requestId);
    expect((await sql(`select distinct request_id from audit_logs where entity_id = $1 and action like 'change_op.applied'`, [cs.id])).map((r) => r.request_id)).toEqual([requestId]);
    // The module's own audit rows are written too (the change set is not a back door).
    expect(await sql(`select 1 from audit_logs where org_id = $1 and action = 'marketing.promotion_created' and entity_id = $2`, [a.orgId, res.body.ops[1].result.promotionId])).toHaveLength(1);
    const trail = await t.http.get(`${base(a)}/${cs.id}/audit?limit=5`).set(auth(manager));
    expect(trail.body.items).toHaveLength(5);
    expect(trail.body.nextCursor).toBeTruthy();
    const page2 = await t.http.get(`${base(a)}/${cs.id}/audit?limit=50&cursor=${trail.body.nextCursor}`).set(auth(manager));
    expect([...trail.body.items, ...page2.body.items].map((x: any) => x.action)).toEqual(await auditActions(cs.id));
  });
});
