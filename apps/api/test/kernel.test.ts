import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { PricingService } from '../src/modules/kernel/pricing.service';
import { bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let db: DbService;
let orders: OrdersKernelService;
let ledger: PaymentLedgerService;
let pricing: PricingService;
let tenant: TestTenant;
let menu: SeededMenu;
let ctx: TenantContext;

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  orders = t.app.get(OrdersKernelService);
  ledger = t.app.get(PaymentLedgerService);
  pricing = t.app.get(PricingService);
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
});
afterAll(async () => { await t.close(); });

const burger = (m: SeededMenu, size = m.options.regular, extras: string[] = []) => ({
  productId: m.products.burger, quantity: 1,
  modifiers: [{ groupId: m.groups.size, optionId: size }, ...extras.map((optionId) => ({ groupId: m.groups.extras, optionId }))],
});

describe('pricing', () => {
  it('prices modifiers server-side and extracts inclusive Egyptian VAT', async () => {
    const q = await db.scoped(ctx, (tx) => pricing.quote(tx, tenant.orgId, {
      branchId: tenant.branchId, fulfillment: 'dine_in',
      lines: [{ ...burger(menu, menu.options.large, [menu.options.cheese]), quantity: 2 }, { productId: menu.products.fries, quantity: 1 }],
    }));
    // (18500 + 3000 + 1500) × 2 + 4500
    expect(q.subtotalMinor).toBe(50500);
    expect(q.taxInclusive).toBe(true);
    expect(q.vatRateBp).toBe(1400);
    expect(q.taxMinor).toBe(6202); // 50500 × 14/114 = 6201.75
    expect(q.totalMinor).toBe(50500);
    expect(q.lines[0]!.modifiers.map((m) => m.option)).toEqual(['Large', 'Cheese']);
  });

  it('enforces required modifier groups and max selections', async () => {
    await expect(db.scoped(ctx, (tx) => pricing.quote(tx, tenant.orgId, {
      branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.burger, quantity: 1 }],
    }))).rejects.toMatchObject({ code: 'invalid_modifiers' });
    await expect(db.scoped(ctx, (tx) => pricing.quote(tx, tenant.orgId, {
      branchId: tenant.branchId, fulfillment: 'pickup',
      lines: [burger(menu, menu.options.regular, [menu.options.cheese, menu.options.bacon, menu.options.cheese])],
    }))).rejects.toMatchObject({ code: 'invalid_modifiers' });
  });

  it('applies promotions and delivery fee', async () => {
    await sql(`insert into promotions(org_id, code, name, kind, value, max_discount_minor) values ($1, 'WELCOME10', 'Welcome', 'percent', 1000, 2000)`, [tenant.orgId]);
    const q = await db.scoped(ctx, (tx) => pricing.quote(tx, tenant.orgId, {
      branchId: tenant.branchId, fulfillment: 'delivery', promotionCode: 'welcome10',
      lines: [burger(menu), { productId: menu.products.fries, quantity: 2 }],
    }));
    expect(q.subtotalMinor).toBe(27500);
    expect(q.discountMinor).toBe(2000); // 10% = 2750, capped at 2000
    expect(q.deliveryFeeMinor).toBe(2500);
    expect(q.totalMinor).toBe(27500 - 2000 + 2500);
  });
});

describe('order placement and lifecycle', () => {
  it('places an order with snapshots, numbering, stock and customer resolution', async () => {
    const placed = await db.scoped(ctx, (tx) => orders.place(tx, ctx, {
      branchId: tenant.branchId, channel: 'web', fulfillment: 'pickup', lines: [{ productId: menu.products.limited, quantity: 2 }],
      customer: { name: 'Mona', phone: '+201001234567', marketingConsent: true },
    }));
    expect(placed.status).toBe('placed');
    const [stock] = await sql(`select stock_qty from product_branch_settings where product_id = $1`, [menu.products.limited]);
    expect(stock.stock_qty).toBe(0);
    await expect(db.scoped(ctx, (tx) => orders.place(tx, ctx, {
      branchId: tenant.branchId, channel: 'web', fulfillment: 'pickup', lines: [{ productId: menu.products.limited, quantity: 1 }],
    }))).rejects.toMatchObject({ code: 'out_of_stock' });
    const [customer] = await sql(`select display_name, marketing_consent, marketing_consent_source from customers where id = $1`, [placed.customerId]);
    expect(customer).toMatchObject({ display_name: 'Mona', marketing_consent: true, marketing_consent_source: 'web' });

    // Cancelling restores stock and is recorded.
    await db.scoped(ctx, (tx) => orders.transition(tx, ctx, placed.id, 'cancelled', { reason: 'customer request' }));
    const [restored] = await sql(`select stock_qty from product_branch_settings where product_id = $1`, [menu.products.limited]);
    expect(restored.stock_qty).toBe(2);
    const events = await sql(`select event_type, to_status from order_events where order_id = $1 order by id`, [placed.id]);
    expect(events.map((e) => e.to_status)).toEqual(['placed', 'cancelled']);
    const outbox = await sql(`select event_type from outbox_events where aggregate_id = $1 order by created_at`, [placed.id]);
    expect(outbox.map((e) => e.event_type)).toEqual(['order.placed', 'order.cancelled']);
  });

  it('rejects stale client prices', async () => {
    await expect(db.scoped(ctx, (tx) => orders.place(tx, ctx, {
      branchId: tenant.branchId, channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId,
      lines: [{ productId: menu.products.fries, quantity: 1 }], expectedTotalMinor: 4000,
    }))).rejects.toMatchObject({ code: 'price_changed' });
  });

  it('enforces the fulfillment-specific state machine', async () => {
    const o = await db.scoped(ctx, (tx) => orders.place(tx, ctx, {
      branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }],
    }));
    await expect(db.scoped(ctx, (tx) => orders.transition(tx, ctx, o.id, 'ready'))).rejects.toMatchObject({ code: 'invalid_transition' });
    for (const s of ['accepted', 'preparing', 'ready'] as const) await db.scoped(ctx, (tx) => orders.transition(tx, ctx, o.id, s));
    await expect(db.scoped(ctx, (tx) => orders.transition(tx, ctx, o.id, 'served'))).rejects.toMatchObject({ code: 'invalid_transition' });
    const done = await db.scoped(ctx, (tx) => orders.transition(tx, ctx, o.id, 'picked_up'));
    expect(done.status).toBe('picked_up');
    const [lines] = await sql(`select kitchen_status from order_lines where order_id = $1`, [o.id]);
    expect(lines.kitchen_status).toBe('served');
  });

  it('numbers orders sequentially per branch', async () => {
    const a = await db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }] }));
    const b = await db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }] }));
    expect(Number(b.number)).toBe(Number(a.number) + 1);
  });
});

describe('payment ledger', () => {
  async function openVisitWithOrders() {
    const [visit] = await sql(`insert into visits(org_id, branch_id, table_id, guest_token_hash) values ($1, $2, $3, md5(random()::text)) returning id`,
      [tenant.orgId, tenant.branchId, menu.tableId]);
    const place = (productId: string, quantity: number) => db.scoped(ctx, (tx) => orders.place(tx, ctx, {
      branchId: tenant.branchId, channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId, visitId: visit.id, lines: [{ productId, quantity }],
    }));
    const first = await place(menu.products.fries, 2);  // 9000
    const second = await place(menu.products.soda, 2);  // 5000
    return { visitId: visit.id as string, first, second };
  }

  it('allocates table-bill payments across orders and blocks overpayment', async () => {
    const { visitId, first, second } = await openVisitWithOrders();
    const pay = (amountMinor: number, key: string) => db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, {
      branchId: tenant.branchId, visitId, method: 'cash', provider: 'manual', amountMinor, currency: 'EGP', idempotencyKey: key,
    }));
    await pay(10000, 'cash-visit-1');
    // retry with the same key is a no-op
    await pay(10000, 'cash-visit-1');
    const [o1] = await sql(`select paid_minor, payment_status from orders where id = $1`, [first.id]);
    const [o2] = await sql(`select paid_minor, payment_status from orders where id = $1`, [second.id]);
    expect(o1).toMatchObject({ paid_minor: 9000, payment_status: 'paid' });
    expect(o2).toMatchObject({ paid_minor: 1000, payment_status: 'partially_paid' });
    await expect(pay(4001, 'cash-visit-2')).rejects.toMatchObject({ code: 'overpayment' });
    const p = await pay(4000, 'cash-visit-3');
    const out = await db.scoped(ctx, (tx) => ledger.outstanding(tx, { visitId }));
    expect(out.dueMinor).toBe(0);

    // Partial refund of the last payment reverses the latest order first.
    await db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, p.id, 3000));
    const [after] = await sql(`select paid_minor, refunded_minor, payment_status from orders where id = $1`, [second.id]);
    expect(after).toMatchObject({ refunded_minor: 3000, payment_status: 'partially_refunded' });
    await expect(db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, p.id, 1001))).rejects.toMatchObject({ code: 'refund_exceeds_payment' });
    await db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, p.id, 1000));
    const [payment] = await sql(`select status, refunded_minor from payments where id = $1`, [p.id]);
    expect(payment).toEqual({ status: 'refunded', refunded_minor: 4000 });
    await expect(db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, p.id, 1))).rejects.toMatchObject({ code: 'not_refundable' });
  });

  it('serializes concurrent full payments so only one applies', async () => {
    const o = await db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }] }));
    const attempt = (key: string) => db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, {
      branchId: tenant.branchId, orderId: o.id, method: 'cash', provider: 'manual', amountMinor: 4500, currency: 'EGP', idempotencyKey: key,
    }));
    const results = await Promise.allSettled([attempt('race-a'), attempt('race-b'), attempt('race-c')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [row] = await sql(`select paid_minor from orders where id = $1`, [o.id]);
    expect(row.paid_minor).toBe(4500);
  });

  it('releases prepaid orders to the kitchen only after a verified, matching confirmation', async () => {
    const o = await db.scoped(ctx, (tx) => orders.place(tx, ctx, {
      branchId: tenant.branchId, channel: 'whatsapp', fulfillment: 'delivery', initialStatus: 'awaiting_payment',
      lines: [{ productId: menu.products.fries, quantity: 2 }], customer: { phone: '+201112223334' }, deliveryAddress: { line1: '12 Nile St' },
    }));
    const pending = await db.scoped(ctx, (tx) => ledger.createPending(tx, ctx, {
      branchId: tenant.branchId, orderId: o.id, method: 'card', provider: 'simulated', amountMinor: o.totalMinor, currency: 'EGP', isTest: true,
    }));
    await expect(db.scoped(ctx, (tx) => ledger.confirm(tx, ctx, pending.id, { amountMinor: o.totalMinor - 1, currency: 'EGP' })))
      .rejects.toMatchObject({ code: 'payment_mismatch' });
    const [failed] = await sql(`select status from payments where id = $1`, [pending.id]);
    expect(failed.status).toBe('pending'); // mismatch rolled back with the transaction; nothing applied
    const retry = await db.scoped(ctx, (tx) => ledger.createPending(tx, ctx, {
      branchId: tenant.branchId, orderId: o.id, method: 'card', provider: 'simulated', amountMinor: o.totalMinor, currency: 'EGP', isTest: true, idempotencyKey: 'wa-pay-1',
    })).catch((e) => e);
    // the first pending attempt still reserves the balance
    expect(retry.code).toBe('overpayment');
    const confirmed = await db.scoped(ctx, (tx) => ledger.confirm(tx, ctx, pending.id, { amountMinor: o.totalMinor, currency: 'egp', providerPaymentId: 'sim_123' }));
    expect(confirmed.applied).toBe(true);
    const again = await db.scoped(ctx, (tx) => ledger.confirm(tx, ctx, pending.id, { amountMinor: o.totalMinor, currency: 'EGP' }));
    expect(again.applied).toBe(false);
    const [order] = await sql(`select status, payment_status from orders where id = $1`, [o.id]);
    expect(order).toEqual({ status: 'placed', payment_status: 'paid' });
  });
});
