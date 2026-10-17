// Cross-module integration (lead): website orders (B1) carry Marketing (C) tracking
// attribution so campaign revenue is reported; foreign campaign ids are ignored.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootTestApp, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let a: TestTenant;
let b: TestTenant;
let menu: SeededMenu;
beforeAll(async () => {
  t = await bootTestApp();
  a = await createTenant(t);
  b = await createTenant(t);
  menu = await seedMenu(a);
});
afterAll(async () => { await t.close(); });

const campaign = async (tenant: TestTenant) => (await sql(
  `insert into campaigns(org_id, name, channel, utm_campaign) values ($1, 'Ramadan offer', 'whatsapp', $2) returning id`,
  [tenant.orgId, unique('ramadan')]))[0].id as string;

const order = (attribution: Record<string, string>) => t.http.post(`/v1/public/order/${a.slug}/orders`).set('Idempotency-Key', unique('web-attr'))
  .send({ branchId: a.branchId, fulfillment: 'pickup', payment: 'pay_at_pickup', lines: [{ productId: menu.products.soda, quantity: 1 }],
    customer: { name: 'Salma', phone: '+201006667777' }, attribution });

it('links a website order to the restaurant\'s own campaign from the tracking link', async () => {
  const own = await campaign(a);
  const res = await order({ utm_source: 'whatsapp', utm_campaign: 'ramadan', campaignId: own, sessionKey: 'sess_abcdefgh' });
  expect(res.status).toBe(201);
  const [o] = await sql(`select campaign_id, attribution from orders where id = $1`, [res.body.order.id]);
  expect(o.campaign_id).toBe(own);
  expect(o.attribution).toMatchObject({ utm_source: 'whatsapp', utm_campaign: 'ramadan' });
  const [ev] = await sql(`select kind, campaign_id from attribution_events where order_id = $1`, [res.body.order.id]);
  expect(ev).toEqual({ kind: 'order_placed', campaign_id: own });
});

it('ignores a campaign id that belongs to another restaurant', async () => {
  const foreign = await campaign(b);
  const res = await order({ campaignId: foreign });
  expect(res.status).toBe(201);
  const [o] = await sql(`select campaign_id from orders where id = $1`, [res.body.order.id]);
  expect(o.campaign_id).toBeNull();
});
