// REM-A10 (PS-13 remainder): the per-phone budgets of web orders (web-order:phone, 10/min) and reservation holds
// (reservations:hold:phone, 10/min) ran inside the tenant transaction with the batched, per-instance hit(), so two API
// instances admitted about twice the budget. The phone is now normalised before the tenant transaction and the
// budget is the shared guard(). Two app instances on one database (RATE_LIMIT_STORE=postgres), the same number in
// different spellings alternating between them: exactly 10 attempts pass in the window, the 11th is refused on either.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/common/http/rate-limiter';
import { bootTestApp, createTenant, seedMenu, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let a: TestApp;
let b: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
const saved = process.env.RATE_LIMIT_STORE;

beforeAll(async () => {
  process.env.RATE_LIMIT_STORE = 'postgres';
  try {
    a = await bootTestApp();
    b = await bootTestApp();
  } finally {
    if (saved === undefined) delete process.env.RATE_LIMIT_STORE; else process.env.RATE_LIMIT_STORE = saved;
  }
  tenant = await createTenant(a, { country: 'EG' });
  menu = await seedMenu(tenant);
});
afterAll(async () => { await a?.close(); await b?.close(); });

/** One Egyptian mobile number, spelled the ways guests type it (CR-06): all share one budget. */
const spellings = (local: string) => [`0${local}`, `+20${local}`, `0020${local}`, `20${local}`, local];
const number = () => `10${String(randomBytes(4).readUInt32BE() % 1e8).padStart(8, '0')}`;
const key = () => `budget-${randomBytes(6).toString('hex')}`;

describe('per-phone budgets are shared across API instances', () => {
  it('both instances use the shared limiter', () => {
    expect(a.app.get(RateLimiter).store).toBe('postgres');
    expect(b.app.get(RateLimiter).store).toBe('postgres');
  });

  it('web orders: 10 attempts per number per minute across both instances, whatever the spelling', async () => {
    const local = number();
    const forms = spellings(local);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const app = i % 2 ? b : a;
      // A valid order for the first attempt (the budget does not get in the way of real orders), then attempts on an
      // unknown branch: each still spends the number's budget, since the check runs before any restaurant data is read.
      const branchId = i === 0 ? tenant.branchId : '00000000-0000-4000-8000-000000000000';
      const res = await app.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key()).send({
        branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }], payment: 'pay_at_pickup',
        customer: { name: 'Budget', phone: forms[i % forms.length], marketingConsent: false }, expectedTotalMinor: 2500,
      });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(201);
    expect(statuses.slice(1, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // Another number is not affected.
    const other = await b.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key()).send({
      branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }], payment: 'pay_at_pickup',
      customer: { name: 'Other', phone: `0${number()}`, marketingConsent: false }, expectedTotalMinor: 2500,
    });
    expect(other.status).toBe(201);
  });

  it('reservation holds: 10 attempts per number per minute across both instances', async () => {
    const forms = spellings(number());
    const statuses: number[] = [];
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 12; i++) {
      const res = await (i % 2 ? b : a).http.post(`/v1/public/reservations/${tenant.slug}/holds`).send({
        branchId: '00000000-0000-4000-8000-000000000000', partySize: 2, guestName: 'Budget', guestPhone: forms[i % forms.length],
        date, time: '19:00', key: key(),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('a number that is not a phone is refused before anything is counted', async () => {
    const res = await a.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key()).send({
      branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }], payment: 'pay_at_pickup',
      customer: { name: 'X', phone: '12', marketingConsent: false }, expectedTotalMinor: 2500,
    });
    expect([400, 422]).toContain(res.status);
  });
});
