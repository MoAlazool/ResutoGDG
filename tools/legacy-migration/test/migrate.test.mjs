// Integration tests for the legacy migration tool against a disposable local
// database:  node --test tools/legacy-migration/test/
// LEGACY_TEST_DATABASE_URL defaults to resuto_test_legacy on the local cluster.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureDatabase } from '../../../scripts/db/ensure-db.mjs';
import { migrate } from '../../../scripts/db/migrate.mjs';
import { legacyName, uuidv5 } from '../lib/ids.mjs';
import { buildPlan } from '../lib/transform.mjs';
import { migrateLegacy, rollbackLegacy } from '../migrate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, '../fixtures/olive-room.legacy-state.json');
const url = process.env.LEGACY_TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_test_legacy';
const fixtureBytes = readFileSync(fixturePath);
const fixture = () => JSON.parse(fixtureBytes.toString('utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const storageDir = mkdtempSync(path.join(tmpdir(), 'legacy-media-'));
/** The legacy public/ folder (storefront photos) and a scratch tenant storage. */
const media = { assetsDir: path.join(here, '../../../legacy/public'), storageDir };

pg.types.setTypeParser(20, (v) => Number(v));
let db;
const q = async (text, params = []) => (await db.query(text, params)).rows;

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  db = new pg.Client({ connectionString: url });
  await db.connect();
});
after(async () => { await db?.end(); });

describe('legacy migration of the Olive Room fixture', () => {
  let report;

  it('dry run reconciles but writes nothing', async () => {
    const r = await migrateLegacy({ url, document: fixture(), dryRun: true, media });
    assert.equal(r.reconciliation.ok, true);
    assert.equal(r.committed, false);
    assert.deepEqual(await q(`select id from organizations where legacy_id = 'olive-room-demo'`), []);
  });

  it('migrates in one transaction with a clean reconciliation', async () => {
    report = await migrateLegacy({ url, document: fixture(), options: { planId: 'pro', subscriptionStatus: 'active' }, media });
    assert.equal(report.committed, true);
    assert.equal(report.rerun, false);
    assert.equal(report.reconciliation.ok, true, JSON.stringify(report.reconciliation.metrics.filter((m) => !m.match)));
    const byName = Object.fromEntries(report.reconciliation.metrics.map((m) => [m.name, m]));
    const legacy = fixture().state;
    assert.equal(byName.orders.migrated, legacy.orders.length);
    assert.equal(byName.products.migrated, legacy.menu.length);
    assert.equal(byName.bill_payments_minor.migrated, legacy.payments.filter((p) => p.kind === 'bill').reduce((n, p) => n + p.amount, 0));
    assert.equal(byName.deposit_refunds_minor.migrated, legacy.payments.filter((p) => p.kind === 'test-refund').reduce((n, p) => n + p.amount, 0));
    assert.ok(byName.deposit_refunds_minor.migrated > 0);
  });

  it('uses deterministic UUIDv5 ids and records every mapping', async () => {
    const orgId = uuidv5(legacyName('olive-room-demo', 'organization', 'olive-room-demo'));
    assert.equal(report.orgId, orgId);
    const [m0] = await q(`select id, name, name_ar, price_minor, legacy_id from products where org_id = $1 and legacy_id = 'm0'`, [orgId]);
    assert.equal(m0.id, uuidv5(legacyName('olive-room-demo', 'product', 'm0')));
    assert.equal(m0.name_ar, 'بوراتا مع الطماطم');
    assert.equal(m0.price_minor, 14500);
    const [map] = await q(`select new_id from legacy_id_map where org_id = $1 and entity_type = 'product' and legacy_id = 'm0'`, [orgId]);
    assert.equal(map.new_id, m0.id);
    const counts = Object.fromEntries((await q(`select entity_type, count(*)::int as n from legacy_id_map where org_id = $1 group by 1`, [orgId])).map((r) => [r.entity_type, r.n]));
    assert.equal(counts.table, 6);
    assert.equal(counts.order, fixture().state.orders.length);
    assert.equal(counts.venue_qr, 1);
    // Same input → same plan ids.
    const a = buildPlan(fixture()), b = buildPlan(fixture());
    assert.deepEqual(a.idMap, b.idMap);
  });

  it('preserves table QR tokens, floor geometry and payment provider references verbatim', async () => {
    const legacy = fixture().state;
    const tables = await q(`select legacy_id, qr_token, cx, cy, width, shape, label from dining_tables where org_id = $1 order by legacy_id`, [report.orgId]);
    assert.deepEqual(tables.map((t) => [t.legacy_id, t.qr_token]), legacy.tables.map((t) => [t.id, t.qr]).sort());
    const t1 = legacy.tables.find((t) => t.id === 't1');
    const row = tables.find((t) => t.legacy_id === 't1');
    assert.deepEqual([Number(row.cx), Number(row.cy), Number(row.width), row.shape, row.label], [t1.cx, t1.cy, t1.width, t1.shape, t1.label]);
    const [layout] = await q(`select zones, objects, revision from floor_layouts f join branches b on b.id = f.branch_id where f.org_id = $1 and b.code = 'main'`, [report.orgId]);
    assert.deepEqual(layout.zones, legacy.floor.zones);
    assert.deepEqual(layout.objects, legacy.floor.objects);
    const refs = await q(`select provider, provider_payment_id, method, is_test from payments where org_id = $1 and provider_payment_id is not null order by provider`, [report.orgId]);
    assert.deepEqual(refs, [
      { provider: 'paymob', provider_payment_id: 'paymob_txn_fictional_000002', method: 'card', is_test: false },
      { provider: 'stripe', provider_payment_id: 'evt_fictional_000001', method: 'card', is_test: false },
    ]);
    // Legacy visit bearer tokens keep working: only their sha256 is stored.
    const [visit] = await q(`select guest_token_hash, status from visits where org_id = $1 and legacy_id = 'fx-visit-e'`, [report.orgId]);
    assert.equal(visit.guest_token_hash, sha('fxtoken000000000000000000000000e1'));
    assert.equal(visit.status, 'open');
  });

  it('maps order statuses, totals and ledger state', async () => {
    const orders = Object.fromEntries((await q(`select legacy_id, status, fulfillment, channel, number, total_minor, paid_minor, payment_status, delivery_fee_minor
                                                  from orders where org_id = $1`, [report.orgId])).map((o) => [o.legacy_id, o]));
    assert.equal(orders['fx-order-1'].status, 'served');
    assert.equal(orders['fx-order-1'].payment_status, 'paid');
    assert.equal(orders['fx-order-1'].number, '1');
    assert.equal(orders['fx-order-4'].status, 'cancelled');
    assert.equal(orders['fx-order-4'].payment_status, 'unpaid');
    assert.equal(orders['fx-order-5'].status, 'picked_up');
    assert.equal(orders['fx-order-5'].channel, 'web');
    assert.equal(orders['fx-order-6'].status, 'ready');            // out_for_delivery
    assert.equal(orders['fx-order-6'].fulfillment, 'delivery');
    assert.equal(orders['fx-order-6'].delivery_fee_minor, 3500);
    assert.equal(orders['fx-order-6'].payment_status, 'paid');
    assert.equal(orders['fx-order-7'].status, 'preparing');
    assert.equal(orders['fx-order-7'].payment_status, 'unpaid');
    assert.equal(orders['fx-order-3'].payment_status, 'paid');     // deposit credit + cash
    const [credit] = await q(`select method, amount_minor from payments where org_id = $1 and legacy_id = 'credit:fx-visit-b'`, [report.orgId]);
    assert.deepEqual(credit, { method: 'deposit_credit', amount_minor: 20000 });
    const [res] = await q(`select status, deposit_status, deposit_credit_used_minor, seated_visit_id is not null as seated from reservations where org_id = $1 and legacy_id = 'fx-res-1'`, [report.orgId]);
    assert.deepEqual(res, { status: 'completed', deposit_status: 'applied', deposit_credit_used_minor: 20000, seated: true });
    const [refund] = await q(`select r.amount_minor, p.status from refunds r join payments p on p.id = r.payment_id where r.org_id = $1`, [report.orgId]);
    assert.deepEqual(refund, { amount_minor: 10500, status: 'partially_refunded' });
    const [{ n }] = await q(`select count(*)::int as n from order_lines l join orders o on o.id = l.order_id
                               where o.org_id = $1 and l.line_total_minor <> (l.unit_price_minor + l.modifiers_total_minor) * l.quantity`, [report.orgId]);
    assert.equal(n, 0);
    const [burger] = await q(`select l.modifiers, l.unit_price_minor, l.modifiers_total_minor from order_lines l join orders o on o.id = l.order_id where o.legacy_id = 'fx-order-5' and o.org_id = $1`, [report.orgId]);
    assert.equal(burger.modifiers[0].option, 'Extra cheese');
    assert.ok(burger.modifiers[0].optionId);
    assert.equal(burger.modifiers_total_minor, 1500);
  });

  it('is idempotent: a re-run writes nothing new and still reconciles', async () => {
    const before = await q(`select (select count(*) from order_events where org_id = $1)::int as events, (select count(*) from payment_allocations where org_id = $1)::int as alloc,
                                   (select count(*) from audit_logs where org_id = $1)::int as audit`, [report.orgId]);
    const again = await migrateLegacy({ url, document: fixture(), options: { planId: 'pro', subscriptionStatus: 'active' }, media });
    assert.equal(again.rerun, true);
    assert.equal(again.committed, true);
    assert.equal(again.reconciliation.ok, true);
    for (const [table, cp] of Object.entries(again.checkpoints)) assert.equal(cp.inserted, 0, `${table} inserted rows on re-run`);
    const afterRun = await q(`select (select count(*) from order_events where org_id = $1)::int as events, (select count(*) from payment_allocations where org_id = $1)::int as alloc,
                                     (select count(*) from audit_logs where org_id = $1)::int as audit`, [report.orgId]);
    assert.deepEqual(afterRun, before);
  });

  it('fails reconciliation (exit code 1, nothing committed) when legacy totals disagree with their lines', () => {
    const doc = fixture();
    doc._fixture.restaurantId = 'tampered-copy';
    doc._fixture.slug = 'tampered-copy';
    doc.state.orders[0].total += 100;
    // Fresh bearer tokens so the copy does not collide with the tenant migrated above.
    for (const t of doc.state.tables) t.qr = `${t.qr.slice(0, 24)}tampered`;
    for (const x of [...doc.state.visits, ...doc.state.reservations]) x.token = `${x.token}-copy`;
    for (const p of doc.state.payments) if (p.providerId) p.providerId = `${p.providerId}-copy`;
    doc.state.settings.venueQr = `${doc.state.settings.venueQr}copy`;   // a printed venue code belongs to one restaurant
    const dir = mkdtempSync(path.join(tmpdir(), 'resuto-legacy-'));
    const file = path.join(dir, 'tampered.json');
    writeFileSync(file, JSON.stringify(doc));
    const run = spawnSync(process.execPath, [path.join(here, '../migrate.mjs'), '--input', file], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr + run.stdout);
    assert.match(run.stdout, /order_items_minor.*MISMATCH/);
    assert.match(run.stdout, /NOT committed/);
    return q(`select 1 from organizations where legacy_id = 'tampered-copy'`).then((rows) => assert.equal(rows.length, 0));
  });

  it('aborts (exit code 3) when a QR token already belongs to another tenant', () => {
    const doc = fixture();
    doc._fixture.restaurantId = 'qr-clash';
    doc._fixture.slug = 'qr-clash';
    for (const x of [...doc.state.visits, ...doc.state.reservations]) x.token = `${x.token}-clash`;
    doc.state.settings.venueQr = `${doc.state.settings.venueQr}clash`;
    const dir = mkdtempSync(path.join(tmpdir(), 'resuto-legacy-'));
    const file = path.join(dir, 'clash.json');
    writeFileSync(file, JSON.stringify(doc));
    const run = spawnSync(process.execPath, [path.join(here, '../migrate.mjs'), '--input', file], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
    assert.equal(run.status, 3);
    assert.match(run.stderr, /qr_token/);
    return q(`select 1 from organizations where legacy_id = 'qr-clash'`).then((rows) => assert.equal(rows.length, 0));
  });

  it('rolls a migrated tenant back completely and refuses non-migrated organizations', async () => {
    const r = await rollbackLegacy({ url, orgId: report.orgId });
    assert.equal(r.deleted, true);
    assert.deepEqual(await q(`select 1 from organizations where id = $1`, [report.orgId]), []);
    assert.deepEqual(await q(`select 1 from legacy_id_map where org_id = $1`, [report.orgId]), []);
    assert.deepEqual(await q(`select 1 from dining_tables where org_id = $1`, [report.orgId]), []);
    const [native] = await q(`insert into organizations(slug, name) values ('native-tenant-x', 'Native') returning id`);
    await assert.rejects(rollbackLegacy({ url, orgId: native.id }), /not created by the legacy migration/);
    // The source document was never modified.
    assert.equal(sha(readFileSync(fixturePath)), sha(fixtureBytes));
    // And migrating again after rollback works.
    const again = await migrateLegacy({ url, document: fixture(), media });
    assert.equal(again.committed, true);
    assert.equal(again.rerun, false);
  });
});

// CR-13: legacy photos are copied into tenant storage and counted, venue QR tokens are mapped and counted, and
// in-progress legacy work can be imported as closed history. Rehearsed on the Olive Room (table service, storefront
// photos from legacy public/) and Smash & Co (counter service: venue QR, media-store upload, public/ assets, data: URL).
const smashPath = path.join(here, '../fixtures/smash-and-co.legacy-state.json');
const smash = () => JSON.parse(readFileSync(smashPath, 'utf8'));
const smashMedia = { ...media, mediaDir: path.join(here, '../fixtures/media') };

describe('legacy media and venue QR (CR-13)', () => {
  it('rehearses Smash & Co (counter service) with a clean reconciliation including media and the venue QR', async () => {
    const r = await migrateLegacy({ url, document: smash(), options: { planId: 'pro', subscriptionStatus: 'active' }, media: smashMedia });
    const byName = Object.fromEntries(r.reconciliation.metrics.map((m) => [m.name, m]));
    assert.equal(r.committed, true, JSON.stringify(r.reconciliation.metrics.filter((m) => !m.match)) + r.warnings.join('\n'));
    assert.deepEqual([byName.media.legacy, byName.media.migrated], [9, 9]);
    assert.deepEqual([byName.venue_qr_tokens.legacy, byName.venue_qr_tokens.migrated, byName.venue_qr_tokens.match], [1, 1, true]);
    // Every dish has its photo in tenant storage, byte for byte, with the type read from the bytes.
    const rows = await q(`select p.legacy_id, a.path, a.content_type, a.byte_size from products p join media_assets a on a.id = p.image_media_id where p.org_id = $1 order by 1`, [r.orgId]);
    assert.equal(rows.length, 9);
    const b1 = rows.find((x) => x.legacy_id === 'b1');
    assert.equal(sha(readFileSync(path.join(storageDir, 'tenant-media', b1.path))), sha(readFileSync(path.join(here, '../fixtures/media/menu-b1-3f9c2a7d1e4b.webp'))));
    assert.equal(rows.find((x) => x.legacy_id === 'b8').content_type, 'image/png');
    assert.equal(rows.find((x) => x.legacy_id === 'b0').content_type, 'image/webp');
    // The venue token maps to the counter branch (resolved by GET /v1/public/venue/:token, apps/api test venue-qr).
    const [venue] = await q(`select m.new_id, b.code from legacy_id_map m join branches b on b.id = m.new_id where m.org_id = $1 and m.entity_type = 'venue_qr'`, [r.orgId]);
    assert.equal(venue.code, 'main');
    // A re-run copies nothing new and still reconciles.
    const again = await migrateLegacy({ url, document: smash(), options: { planId: 'pro', subscriptionStatus: 'active' }, media: smashMedia });
    assert.equal(again.committed, true);
    assert.equal(again.checkpoints.media.inserted, 0);
  });

  it('copies the Olive Room storefront photos (legacy burger.js) and maps its venue QR to the main branch', async () => {
    const [org] = await q(`select id from organizations where legacy_id = 'olive-room-demo'`);
    const photos = await q(`select p.legacy_id from products p join media_assets a on a.id = p.image_media_id where p.org_id = $1 order by 1`, [org.id]);
    assert.deepEqual(photos.map((x) => x.legacy_id), ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']);
    const [venue] = await q(`select b.code from legacy_id_map m join branches b on b.id = m.new_id where m.org_id = $1 and m.entity_type = 'venue_qr'`, [org.id]);
    assert.equal(venue.code, 'main');
  });

  it('does not commit when a legacy photo cannot be found or stored (media is part of the reconciliation)', async () => {
    const doc = smash();
    doc._fixture.restaurantId = 'smash-missing-media'; doc._fixture.slug = 'smash-missing-media';
    doc.state.settings.venueQr = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const noStore = await migrateLegacy({ url, document: doc, media: { ...smashMedia, mediaDir: null } });
    assert.equal(noStore.committed, false);
    const m = noStore.reconciliation.metrics.find((x) => x.name === 'media');
    assert.deepEqual([m.legacy, m.migrated, m.match], [9, 8, false]);
    assert.ok(noStore.warnings.some((w) => /needs --media-dir/.test(w)));
    const noDestination = await migrateLegacy({ url, document: doc, media: { mediaDir: smashMedia.mediaDir, assetsDir: media.assetsDir } });
    assert.equal(noDestination.committed, false);
    assert.ok(noDestination.warnings.some((w) => /need a destination/.test(w)));
    assert.deepEqual(await q(`select 1 from organizations where legacy_id = 'smash-missing-media'`), []);
  });

  it('refuses a venue QR token that already belongs to another restaurant', async () => {
    const doc = smash();
    doc._fixture.restaurantId = 'smash-venue-clash'; doc._fixture.slug = 'smash-venue-clash';
    await assert.rejects(migrateLegacy({ url, document: doc, media: smashMedia }), /venue QR token already belongs/);
  });

  it('imports stale in-progress legacy work as closed history when asked (demo/rehearsal re-timing)', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    const plan = buildPlan(fixture(), { now, retimeTo: new Date('2026-10-21T11:30:00Z'), closeStaleAfterHours: 6 });
    const orders = plan.rows.orders;
    const active = orders.filter((o) => ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready'].includes(o.status) && o.placed_at < new Date(now - 6 * 3600e3));
    assert.deepEqual(active, []);
    assert.ok(plan.warnings.some((w) => /imported as closed/.test(w)));
    assert.ok(orders.every((o) => o.placed_at <= now));
    // The reconciliation still compares against the untouched legacy document.
    assert.equal(plan.legacy.orders, fixture().state.orders.length);
  });
});
