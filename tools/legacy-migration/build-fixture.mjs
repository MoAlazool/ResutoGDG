#!/usr/bin/env node
// Builds the sanitized legacy fixture for The Olive Room from the legacy demo
// seed code, without running the legacy server and without touching legacy/.
//
//   node tools/legacy-migration/build-fixture.mjs [out.json]
//
// 1. Reads the `seed` arrow function from legacy/server.js (createApp) and the
//    legacy schema migrations (migrateFloor, migratePlatform) — read-only.
// 2. Produces the state document exactly as a fresh legacy boot would.
// 3. Sanitizes it: no credential hashes, sessions or idempotency results.
// 4. Adds a small set of clearly-labelled FICTIONAL activity (visits, orders,
//    payments, reservations, requests) so every migration path is exercised.
//    These people and transactions never existed.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = process.argv[2] ?? path.join(here, 'fixtures/olive-room.legacy-state.json');

const serverSrc = readFileSync(path.join(root, 'legacy/server.js'), 'utf8');
const start = serverSrc.indexOf('const seed=()=>');
const end = serverSrc.indexOf('\n if(!storage&&!db.prepare', start);
if (start < 0 || end < 0) throw new Error('Could not locate the legacy seed in legacy/server.js');
const seedSrc = serverSrc.slice(start + 'const seed='.length, end).trim().replace(/;$/, '');
const uid = () => randomBytes(16).toString('hex');
const hash = (x) => createHash('sha256').update(x).digest('hex');
// eslint-disable-next-line no-new-func
const seed = new Function('uid', 'hash', 'managerPassword', 'kitchenPassword', 'hostPassword', `return (${seedSrc});`)(uid, hash, undefined, undefined, undefined);

const { migrateFloor } = await import(pathToFileURL(path.join(root, 'legacy/floor-domain.js')).href);
const { migratePlatform } = await import(pathToFileURL(path.join(root, 'legacy/platform-domain.js')).href);
const s = seed();
migrateFloor(s);
migratePlatform(s);

// --- Sanitize ---------------------------------------------------------------
s.credentials = {};
s.sessions = [];
s.idem = {};
s.audit = [];

// --- Fictional activity (all ids/tokens below are synthetic) ----------------
const at = (iso) => Date.parse(iso);
const line = (id, qty, optionIds = []) => {
  const m = s.menu.find((x) => x.id === id);
  const options = optionIds.map((o) => m.modifiers.find((x) => x.id === o)).map((x) => ({ id: x.id, name: x.name, price: x.price }));
  return { id: m.id, name: m.name, nameAr: m.nameAr, qty, price: m.price + options.reduce((n, o) => n + o.price, 0), station: m.station, options };
};
const order = (o) => ({ notes: '', version: 0, ...o, total: o.lines.reduce((n, l) => n + l.qty * l.price, 0) });
const t1 = s.tables.find((t) => t.id === 't1');
const t4 = s.tables.find((t) => t.id === 't4');
const burgerItem = s.menu.find((m) => m.branchIds.includes('burger') && m.modifiers.length);

// Visit A: closed dine-in table, two orders, paid in two simulated payments.
const vA = { id: 'fx-visit-a', token: 'fxtoken000000000000000000000000a1', pin: '482913', type: 'dine-in', tableId: t1.id, branchId: 'main',
  name: 'Fictional guest — Laila (synthetic)', status: 'closed', locked: false, credit: 0, fee: 0, created: at('2026-09-12T18:05:00Z'), closedAt: at('2026-09-12T19:40:00Z') };
const oA1 = order({ id: 'fx-order-1', number: 1, visitId: vA.id, tableId: t1.id, branchId: 'main', type: 'dine-in', name: vA.name,
  lines: [line('m0', 1), line('m3', 2)], status: 'served', created: at('2026-09-12T18:10:00Z'), fulfilledAt: at('2026-09-12T18:42:00Z') });
const oA2 = order({ id: 'fx-order-2', number: 2, visitId: vA.id, tableId: t1.id, branchId: 'main', type: 'dine-in', name: vA.name,
  lines: [line('m6', 2), line('m7', 2)], status: 'served', created: at('2026-09-12T19:02:00Z'), fulfilledAt: at('2026-09-12T19:15:00Z'), notes: 'Synthetic note: no ice' });
// Reservation with a (simulated) deposit, seated into visit B; the deposit becomes credit.
const rB = { id: 'fx-res-1', token: 'fxrestoken00000000000000000000b01', tableId: t4.id, name: 'Fictional guest — Omar (synthetic)', contact: '+201000000101',
  party: 4, start: at('2026-09-20T17:00:00Z'), end: at('2026-09-20T18:45:00Z'), expires: at('2026-09-18T10:05:00Z'), status: 'completed', deposit: s.settings.deposit };
const vB = { id: 'fx-visit-b', token: 'fxtoken000000000000000000000000b1', pin: '771204', type: 'dine-in', tableId: t4.id, branchId: 'main', reservationId: rB.id,
  name: rB.name, status: 'closed', locked: false, credit: s.settings.deposit, fee: 0, created: at('2026-09-20T17:02:00Z'), closedAt: at('2026-09-20T18:30:00Z') };
const oB1 = order({ id: 'fx-order-3', number: 3, visitId: vB.id, tableId: t4.id, branchId: 'main', type: 'dine-in', name: vB.name,
  lines: [line('m1', 2), line('m4', 1), line('m2', 1)], status: 'served', created: at('2026-09-20T17:10:00Z'), fulfilledAt: at('2026-09-20T17:50:00Z') });
const oB2 = order({ id: 'fx-order-4', number: 4, visitId: vB.id, tableId: t4.id, branchId: 'main', type: 'dine-in', name: vB.name,
  lines: [line('m5', 1)], status: 'cancelled', created: at('2026-09-20T17:20:00Z') });
// Online pickup at the burger brand, paid through Stripe (fictional provider ids).
const vC = { id: 'fx-visit-c', token: 'fxtoken000000000000000000000000c1', type: 'pickup', tableId: null, branchId: 'burger', name: 'Fictional guest — Nour (synthetic)',
  contact: 'nour.synthetic@example.test', address: '', status: 'closed', locked: true, credit: 0, fee: 0, created: at('2026-09-25T12:00:00Z'), closedAt: at('2026-09-25T12:40:00Z') };
const oC1 = order({ id: 'fx-order-5', number: 5, visitId: vC.id, branchId: 'burger', type: 'pickup', name: vC.name,
  lines: [line(burgerItem.id, 2, [burgerItem.modifiers[0].id])], status: 'picked_up', created: at('2026-09-25T12:01:00Z'), fulfilledAt: at('2026-09-25T12:30:00Z') });
// Online delivery still in progress, paid with Paymob (fictional provider ids).
const vD = { id: 'fx-visit-d', token: 'fxtoken000000000000000000000000d1', type: 'delivery', tableId: null, branchId: 'main', name: 'Fictional guest — Karim (synthetic)',
  contact: '+201000000102', address: '12 Synthetic St, Zamalek (fictional)', status: 'open', locked: true, credit: 0, fee: s.settings.deliveryFee, created: at('2026-10-01T13:00:00Z') };
const oD1 = order({ id: 'fx-order-6', number: 6, visitId: vD.id, branchId: 'main', type: 'delivery', name: vD.name,
  lines: [line('m2', 1), line('m5', 1)], status: 'out_for_delivery', created: at('2026-10-01T13:01:00Z') });
// An open table with an unpaid order and an open waiter request.
const vE = { id: 'fx-visit-e', token: 'fxtoken000000000000000000000000e1', pin: '120934', type: 'dine-in', tableId: t1.id, branchId: 'main',
  name: 'Fictional guest — Table 1 (synthetic)', status: 'open', locked: false, credit: 0, fee: 0, created: at('2026-10-05T19:00:00Z') };
const oE1 = order({ id: 'fx-order-7', number: 7, visitId: vE.id, tableId: t1.id, branchId: 'main', type: 'dine-in', name: vE.name,
  lines: [line('m0', 1), line('m7', 1)], status: 'preparing', created: at('2026-10-05T19:05:00Z') });
// Future confirmed reservation (deposit paid, simulated) and an expired hold.
const rF = { id: 'fx-res-2', token: 'fxrestoken00000000000000000000f01', tableId: 't3', name: 'Fictional guest — Hana (synthetic)', contact: 'hana.synthetic@example.test',
  party: 2, start: at('2027-02-14T18:00:00Z'), end: at('2027-02-14T19:45:00Z'), expires: at('2026-10-10T10:05:00Z'), status: 'confirmed', deposit: s.settings.deposit };
const rG = { id: 'fx-res-3', token: 'fxrestoken00000000000000000000g01', tableId: 't2', name: 'Fictional guest — Youssef (synthetic)', contact: '+201000000103',
  party: 3, start: at('2026-10-02T17:00:00Z'), end: at('2026-10-02T18:45:00Z'), expires: at('2026-10-01T09:05:00Z'), status: 'expired', deposit: s.settings.deposit };

// Reservation whose deposit credit exceeds the bill: the unused credit was returned (legacy "test-refund").
const t6 = s.tables.find((t) => t.id === 't6');
const rH = { id: 'fx-res-4', token: 'fxrestoken00000000000000000000h01', tableId: t6.id, name: 'Fictional guest — Salma (synthetic)', contact: '01000000104',
  party: 2, start: at('2026-09-28T16:00:00Z'), end: at('2026-09-28T17:45:00Z'), expires: at('2026-09-27T09:05:00Z'), status: 'completed', deposit: s.settings.deposit };
const vH = { id: 'fx-visit-h', token: 'fxtoken000000000000000000000000h1', pin: '553017', type: 'dine-in', tableId: t6.id, branchId: 'main', reservationId: rH.id,
  name: rH.name, status: 'closed', locked: false, credit: s.settings.deposit, fee: 0, created: at('2026-09-28T16:01:00Z'), closedAt: at('2026-09-28T17:00:00Z') };
const oH1 = order({ id: 'fx-order-8', number: 8, visitId: vH.id, tableId: t6.id, branchId: 'main', type: 'dine-in', name: vH.name,
  lines: [line('m1', 1)], status: 'served', created: at('2026-09-28T16:05:00Z'), fulfilledAt: at('2026-09-28T16:20:00Z') });

const bA = oA1.total + oA2.total;
s.visits.push(vA, vB, vC, vD, vE, vH);
s.orders.push(oA1, oA2, oB1, oB2, oC1, oD1, oE1, oH1);
s.reservations.push(rB, rF, rG, rH);
const billB = oB1.total; // cancelled order excluded
s.payments.push(
  { id: 'fx-pay-1', visitId: vA.id, kind: 'bill', amount: 20000, at: at('2026-09-12T19:30:00Z') },
  { id: 'fx-pay-2', visitId: vA.id, kind: 'bill', amount: bA - 20000, at: at('2026-09-12T19:35:00Z') },
  { id: 'fx-pay-3', reservationId: rB.id, kind: 'deposit', amount: rB.deposit, at: at('2026-09-18T10:01:00Z') },
  { id: 'fx-pay-4', visitId: vB.id, kind: 'bill', amount: Math.max(0, billB - vB.credit), at: at('2026-09-20T18:20:00Z') },
  { id: 'fx-pay-5', visitId: vC.id, kind: 'bill', amount: oC1.total, provider: 'stripe', providerId: 'evt_fictional_000001', at: at('2026-09-25T12:01:30Z') },
  { id: 'fx-pay-6', visitId: vD.id, kind: 'bill', amount: oD1.total + vD.fee, provider: 'paymob', providerId: 'paymob_txn_fictional_000002', at: at('2026-10-01T13:02:00Z') },
  { id: 'fx-pay-7', reservationId: rF.id, kind: 'deposit', amount: rF.deposit, at: at('2026-10-10T10:01:00Z') },
  { id: 'fx-pay-8', reservationId: rH.id, kind: 'deposit', amount: rH.deposit, at: at('2026-09-27T09:01:00Z') },
  { id: 'fx-pay-9', visitId: vH.id, kind: 'test-refund', amount: vH.credit - oH1.total, at: at('2026-09-28T17:00:00Z') },
);
s.requests.push(
  { id: 'fx-req-1', visitId: vA.id, tableId: t1.id, type: 'bill', status: 'resolved', created: at('2026-09-12T19:20:00Z') },
  { id: 'fx-req-2', visitId: vE.id, tableId: t1.id, type: 'waiter', status: 'open', created: at('2026-10-05T19:10:00Z') },
);
s.audit.push(
  { id: 'fx-audit-1', type: 'Order received', entity: oA1.id, at: oA1.created },
  { id: 'fx-audit-2', type: 'Order received', entity: oA2.id, at: oA2.created },
  { id: 'fx-audit-3', type: 'Visit opened', entity: vA.id, at: vA.created },
);
if (billB - vB.credit < 0) throw new Error('fixture assumes the visit B bill exceeds the deposit credit');
if (s.payments.some((p) => p.amount <= 0)) throw new Error('fixture payments must be positive');

const doc = {
  _fixture: {
    restaurantId: 'olive-room-demo',
    slug: 'the-olive-room',
    description: 'Sanitized legacy state for The Olive Room demo tenant, generated from the legacy seed (legacy/server.js createApp seed + migrateFloor + migratePlatform).',
    sanitized: ['credentials', 'sessions', 'idem', 'audit (seed entries)'],
    synthetic: 'Every visit, order, payment, reservation, request and audit entry whose id starts with "fx-" is FICTIONAL test data. The people named "(synthetic)" do not exist and no money moved.',
    generatedBy: 'tools/legacy-migration/build-fixture.mjs',
  },
  state: s,
};
writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)} (${s.menu.length} menu items, ${s.tables.length} tables, ${s.orders.length} orders, ${s.payments.length} payments)`);
